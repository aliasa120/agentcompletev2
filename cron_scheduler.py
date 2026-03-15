"""
cron_scheduler.py — Single source of truth for all auto-triggers.

Runs as a dedicated process (python cron_scheduler.py) alongside:
  - feeder_server.py  (port 8080, HTTP-only, no scheduler)
  - langgraph dev     (port 2024)

On every 60-second tick it reads Supabase settings and fires
the feeder and/or agent if their interval has elapsed.

Environment variables (same .env as the rest of the project):
  SUPABASE_URL           / NEXT_PUBLIC_SUPABASE_URL
  SUPABASE_ANON_KEY      / NEXT_PUBLIC_SUPABASE_ANON_KEY
  FEEDER_SERVER_URL      (default: http://localhost:8080)
  LANGGRAPH_URL          / NEXT_PUBLIC_API_URL (default: http://localhost:2024)
"""

import os
import re
import time
import json
import logging
import requests
from datetime import datetime, timezone
from dotenv import load_dotenv

# ── Publish failure tracker ──────────────────────────────────────────────────
# Tracks consecutive failures per (post_id, platform) in memory.
# After _MAX_PUBLISH_ATTEMPTS failures, the platform is marked "failed" in DB.
_publish_failures: dict = {}   # {post_id: {platform: int}}
_MAX_PUBLISH_ATTEMPTS = 3

# ── Load env ────────────────────────────────────────────────────────────────
load_dotenv()           # root .env
load_dotenv("deep-agents-ui-main/.env.local", override=False)   # frontend .env

SUPABASE_URL = (
    os.getenv("SUPABASE_URL")
    or os.getenv("NEXT_PUBLIC_SUPABASE_URL", "")
)
SUPABASE_KEY = (
    os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    or os.getenv("SUPABASE_ANON_KEY")
    or os.getenv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "")
)
FEEDER_URL   = os.getenv("FEEDER_SERVER_URL", "http://localhost:8080")
LG_URL       = os.getenv("LANGGRAPH_URL") or os.getenv("NEXT_PUBLIC_API_URL", "http://localhost:2024")

TICK_SECONDS = 60   # how often we check

# ── Logging ─────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [Cron] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("cron")


# ── Supabase helpers ─────────────────────────────────────────────────────────
def _sb_headers() -> dict:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_get(table: str, params: str = "") -> list:
    """Simple Supabase REST GET."""
    url = f"{SUPABASE_URL}/rest/v1/{table}?{params}"
    r = requests.get(url, headers=_sb_headers(), timeout=10)
    r.raise_for_status()
    return r.json()


def _sb_upsert(table: str, rows: list) -> None:
    """Simple Supabase REST UPSERT (on_conflict=key)."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    headers = {**_sb_headers(), "Prefer": "resolution=merge-duplicates"}
    r = requests.post(url, headers=headers, json=rows, timeout=10)
    r.raise_for_status()


def _sb_patch(table: str, params: str, body: dict) -> None:
    """Simple Supabase REST PATCH."""
    url = f"{SUPABASE_URL}/rest/v1/{table}?{params}"
    r = requests.patch(url, headers=_sb_headers(), json=body, timeout=10)
    r.raise_for_status()


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _elapsed_since(iso_str: str) -> float:
    """Seconds elapsed since the given ISO timestamp."""
    if not iso_str:
        return float("inf")
    try:
        ts = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - ts).total_seconds()
    except Exception:
        return float("inf")


def _strip_html(text: str) -> str:
    """Remove HTML tags and decode common entities — matches page.tsx stripHtml."""
    if not text:
        return ""
    # Remove tags
    clean = re.sub(r"<[^>]+>", "", text)
    # Decode common HTML entities
    clean = clean.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    clean = clean.replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " ")
    return clean.strip()


# ── Retry helper ─────────────────────────────────────────────────────────────
def _retry(fn, max_attempts: int = 3, wait_seconds: int = 10, label: str = ""):
    """Call fn() up to max_attempts times, waiting wait_seconds between attempts.
    Returns the result on success, or raises the last exception.
    """
    last_exc: Exception = RuntimeError("_retry: no attempts made")
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except Exception as exc:
            last_exc = exc
            if attempt < max_attempts:
                log.warning(f"{'[' + label + '] ' if label else ''}Attempt {attempt}/{max_attempts} failed: {exc} — retrying in {wait_seconds}s...")
                time.sleep(wait_seconds)
            else:
                log.error(f"{'[' + label + '] ' if label else ''}All {max_attempts} attempts failed: {exc}")
    raise last_exc


# ── Feeder trigger ───────────────────────────────────────────────────────────
def check_feeder() -> None:
    try:
        rows = _sb_get("feeder_settings", "key=in.(feeder_auto_trigger_enabled,feeder_auto_trigger_interval_minutes,feeder_last_trigger_at)")
        smap = {r["key"]: r["value"] for r in rows}

        enabled = smap.get("feeder_auto_trigger_enabled", "false").lower() == "true"
        if not enabled:
            return

        interval_min = float(smap.get("feeder_auto_trigger_interval_minutes", "30") or "30")
        interval_sec = interval_min * 60
        last_at = smap.get("feeder_last_trigger_at", "") or ""
        elapsed = _elapsed_since(last_at)

        if elapsed >= interval_sec:
            run_time = now_iso()
            log.info(f"⏰ FEEDER trigger due (elapsed={elapsed/60:.1f}min, interval={interval_min}min) — firing...")
            # Save timestamp FIRST to prevent double-fire
            _sb_upsert("feeder_settings", [{"key": "feeder_last_trigger_at", "value": run_time, "updated_at": run_time}])
            # CON-6: Retry feeder HTTP call up to 3 times with 10s waits
            try:
                def _call_feeder():
                    resp = requests.post(f"{FEEDER_URL}/run", json={}, timeout=310)
                    resp.raise_for_status()
                    return resp
                resp = _retry(_call_feeder, max_attempts=3, wait_seconds=10, label="Feeder")
                log.info("✅ Feeder pipeline completed successfully.")
            except Exception as e:
                log.error(f"❌ Feeder HTTP call failed after 3 attempts: {e}")
        else:
            remaining = interval_sec - elapsed
            log.info(f"Feeder: next run in {remaining/60:.1f}min (interval={interval_min}min)")

    except Exception as e:
        log.error(f"check_feeder error: {e}")


# ── LangGraph helpers ────────────────────────────────────────────────────────
def _lg_list_assistants() -> list:
    r = requests.post(
        f"{LG_URL}/assistants/search",
        headers={"Content-Type": "application/json"},
        json={"limit": 10, "offset": 0},
        timeout=10,
    )
    r.raise_for_status()
    return r.json()


def _lg_create_thread() -> str:
    r = requests.post(f"{LG_URL}/threads", headers={"Content-Type": "application/json"}, json={}, timeout=10)
    r.raise_for_status()
    return r.json()["thread_id"]


def _lg_create_run(thread_id: str, assistant_id: str, content: str) -> None:
    payload = {
        "assistant_id": assistant_id,
        "input": {"messages": [{"role": "human", "content": content}]},
    }
    r = requests.post(
        f"{LG_URL}/threads/{thread_id}/runs",
        headers={"Content-Type": "application/json"},
        json=payload,
        timeout=15,
    )
    r.raise_for_status()


# ── Agent trigger ────────────────────────────────────────────────────────────
def check_agent() -> None:
    try:
        rows = _sb_get(
            "agent_settings",
            "key=in.(auto_trigger_enabled,auto_trigger_interval_minutes,auto_trigger_last_at,queue_batch_size)"
        )
        smap = {r["key"]: r["value"] for r in rows}

        enabled = smap.get("auto_trigger_enabled", "false").lower() == "true"
        if not enabled:
            return

        interval_min = float(smap.get("auto_trigger_interval_minutes", "30") or "30")
        interval_sec = interval_min * 60
        last_at = smap.get("auto_trigger_last_at", "") or ""
        elapsed = _elapsed_since(last_at)
        batch_size = int(smap.get("queue_batch_size", "2") or "2")

        if elapsed >= interval_sec:
            # Check for pending articles
            pending = _sb_get(
                "feeder_articles",
                f"status=eq.Pending&order=created_at.asc&limit={batch_size}&select=id,title,description,url"
            )
            if not pending:
                log.info("Agent: trigger due but queue empty — skipping.")
                return

            run_time = now_iso()
            log.info(f"⏰ AGENT trigger due (elapsed={elapsed/60:.1f}min, interval={interval_min}min) — firing {len(pending)} articles...")

            # Save timestamp FIRST to prevent double-fire
            _sb_upsert("agent_settings", [{"key": "auto_trigger_last_at", "value": run_time, "updated_at": run_time}])

            # Mark articles as Processing
            ids = [a["id"] for a in pending]
            ids_filter = "(" + ",".join(f'"{i}"' for i in ids) + ")"
            _sb_patch("feeder_articles", f"id=in.{ids_filter}", {"status": "Processing"})

            # Discover assistant_id from LangGraph
            assistant_id = "research"   # fallback
            try:
                assistants = _lg_list_assistants()
                if assistants:
                    assistant_id = assistants[0]["assistant_id"]
                    log.info(f"Using assistant: {assistant_id}")
            except Exception as e:
                log.warning(f"Could not fetch assistants — using fallback 'research': {e}")

            # Create one LangGraph run per article (Retry 1: 3 attempts, 10s wait)
            for article in pending:
                try:
                    clean_title = _strip_html(article.get('title', ''))
                    clean_desc  = _strip_html(article.get('description', ''))
                    content = f"Title: {clean_title}\nDescription: {clean_desc}"

                    def _create_run_for_article():
                        tid = _lg_create_thread()
                        _lg_create_run(tid, assistant_id, content)
                        return tid

                    thread_id = _retry(_create_run_for_article, max_attempts=3, wait_seconds=10, label=f"Agent:{clean_title[:40]}")
                    log.info(f"  ✅ Created run for article: {clean_title[:60]}")
                except Exception as e:
                    # Revert article to Pending so it can be retried on next cron tick
                    try:
                        _sb_patch("feeder_articles", f"id=eq.{article['id']}", {"status": "Pending"})
                    except Exception:
                        pass
                    log.error(f"  ❌ Failed to create run for article {article['id']} after 3 attempts: {e}")

        else:
            remaining = interval_sec - elapsed
            log.info(f"Agent:  next run in {remaining/60:.1f}min (interval={interval_min}min)")

    except Exception as e:
        log.error(f"check_agent error: {e}")


# ── Server-side auto-publish ────────────────────────────────────────────────
def check_auto_publish() -> None:
    """Check for unpublished social posts and publish them via Next.js /api/publish.

    Reads agent_settings from Supabase:
      - social_auto_publish        ("true"/"false")
      - auto_publish_since         (ISO timestamp — only posts created AFTER this are candidates)
      - social_fb_enabled          ("true"/"false")
      - social_ig_enabled          ("true"/"false")
      - social_twitter_enabled     ("true"/"false")

    For each pending post:
      - Only publishes to platforms that are enabled AND not already marked successful.
      - Never retries a platform that previously succeeded (published_to.<platform> == true).
      - Never attempts a platform not enabled in settings.
    """
    NEXT_URL = (
        os.getenv("NEXT_PUBLIC_APP_URL")
        or os.getenv("NEXT_APP_URL", "http://localhost:3000")
    )

    try:
        # Read social publish settings
        rows = _sb_get(
            "agent_settings",
            "key=in.(social_auto_publish,auto_publish_since,social_fb_enabled,social_ig_enabled,social_twitter_enabled)"
        )
        smap = {r["key"]: r["value"] for r in rows}

        auto_publish = smap.get("social_auto_publish", "false").lower() == "true"
        if not auto_publish:
            return

        since_str    = smap.get("auto_publish_since", "") or ""
        fb_enabled   = smap.get("social_fb_enabled", "false").lower() == "true"
        ig_enabled   = smap.get("social_ig_enabled", "false").lower() == "true"
        tw_enabled   = smap.get("social_twitter_enabled", "false").lower() == "true"

        # Build list of enabled platforms
        enabled_platforms = []
        if fb_enabled:  enabled_platforms.append("facebook")
        if ig_enabled:  enabled_platforms.append("instagram")
        if tw_enabled:  enabled_platforms.append("twitter")

        if not enabled_platforms:
            return  # Nothing to post to

        # Fetch all social posts created after auto_publish_since
        posts_params = "order=created_at.asc"
        if since_str:
            posts_params += f"&created_at=gte.{since_str}"

        all_posts = _sb_get("social_posts", posts_params)
        if not all_posts:
            return

        publish_candidates = []
        for post in all_posts:
            published_to = post.get("published_to") or {}
            if isinstance(published_to, str):
                try:
                    published_to = json.loads(published_to)
                except Exception:
                    published_to = {}

            # Skip: already succeeded (True) OR permanently failed ("failed" string)
            pending_platforms = [
                p for p in enabled_platforms
                if published_to.get(p) is not True
                and published_to.get(p) != "failed"
            ]
            if pending_platforms:
                publish_candidates.append((post, pending_platforms))

        if not publish_candidates:
            return  # All posts already published to all enabled platforms

        log.info(f"📣 Auto-publish: {len(publish_candidates)} post(s) with pending platforms.")

        for post, platforms in publish_candidates:
            post_id = post.get("id", "?")
            published_to = post.get("published_to") or {}
            if isinstance(published_to, str):
                try:
                    published_to = json.loads(published_to)
                except Exception:
                    published_to = {}

            # Send ALL pending platforms in ONE batch request
            try:
                payload = {
                    "post_id": post_id,
                    "platforms": platforms,
                }
                resp = requests.post(
                    f"{NEXT_URL}/api/publish",
                    json=payload,
                    headers={"Content-Type": "application/json"},
                    timeout=120,
                )
                if resp.ok:
                    data = resp.json()
                    results = data.get("results", {})
                    for platform, result in results.items():
                        if result.get("success"):
                            log.info(f"  ✅ Published post {post_id} → {platform}")
                            # Reset failure count on success
                            _publish_failures.get(post_id, {}).pop(platform, None)
                        else:
                            err_msg = result.get("error", "unknown error")
                            # Increment failure counter
                            if post_id not in _publish_failures:
                                _publish_failures[post_id] = {}
                            fail_count = _publish_failures[post_id].get(platform, 0) + 1
                            _publish_failures[post_id][platform] = fail_count

                            if fail_count >= _MAX_PUBLISH_ATTEMPTS:
                                log.error(
                                    f"  🚫 post {post_id} → {platform}: "
                                    f"{_MAX_PUBLISH_ATTEMPTS} attempts all failed — marking as FAILED permanently."
                                    f" Last error: {err_msg}"
                                )
                                # Write "failed" marker to Supabase so cron never retries
                                try:
                                    merged = {**published_to, platform: "failed"}
                                    _sb_patch("social_posts", f"id=eq.{post_id}", {"published_to": merged})
                                    # Update local copy so the next platform in same loop is accurate
                                    published_to = merged
                                except Exception as db_err:
                                    log.error(f"  Could not write failed marker to DB: {db_err}")
                            else:
                                log.warning(
                                    f"  ❌ post {post_id} → {platform} "
                                    f"(attempt {fail_count}/{_MAX_PUBLISH_ATTEMPTS}): {err_msg}"
                                )
                else:
                    err = resp.json().get("error", resp.text[:200]) if resp.content else f"HTTP {resp.status_code}"
                    log.warning(f"  ❌ Publish request failed for post {post_id}: {err}")
            except Exception as e:
                log.error(f"  ❌ Exception publishing post {post_id}: {e}")

    except Exception as e:
        log.error(f"check_auto_publish error: {e}")


# ── Main loop ────────────────────────────────────────────────────────────────
def main():
    log.info("=" * 60)
    log.info("Cron Scheduler started.")
    log.info(f"  Feeder URL:    {FEEDER_URL}")
    log.info(f"  LangGraph URL: {LG_URL}")
    log.info(f"  Supabase URL:  {SUPABASE_URL[:40]}...")
    log.info(f"  Tick interval: {TICK_SECONDS}s")
    log.info("=" * 60)

    while True:
        log.info("--- tick ---")
        check_feeder()
        check_agent()
        check_auto_publish()
        time.sleep(TICK_SECONDS)


if __name__ == "__main__":
    main()

