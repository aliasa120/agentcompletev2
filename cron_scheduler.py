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
import threading
from datetime import datetime, timezone
from dotenv import load_dotenv
from typing import Optional, List, Dict, Any

def fire_in_background(func, *args, **kwargs):
    """Run a function in a background thread."""
    t = threading.Thread(target=func, args=args, kwargs=kwargs, daemon=True)
    t.start()
    return t


# ── Publish failure tracker ──────────────────────────────────────────────────
# Tracks consecutive failures per (post_id, platform) in memory.
# After _MAX_PUBLISH_ATTEMPTS failures, the platform is marked "failed" in DB.
_publish_failures: dict = {}   # {post_id: {platform: int}}
_MAX_PUBLISH_ATTEMPTS = 3

# Tracks posts currently being published (prevents double-posting on overlapping ticks)
_publishing_now: set = set()  # {post_id}

# Maximum posts to publish per cron tick (to avoid Twitter rate limits)
_MAX_POSTS_PER_TICK = 5
# Delay (seconds) between posts when Twitter is one of the platforms
_TWITTER_POST_DELAY_SECONDS = 15

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


def _internal_api_headers() -> dict:
    """Headers for calling the Next.js API as a trusted server-to-server caller.

    /api/publish requires a browser session or this internal token; cron has no
    cookies, so it presents the token instead.
    """
    token = (
        os.getenv("INTERNAL_API_TOKEN")
        or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        or ""
    ).strip()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["x-internal-token"] = token
    return headers


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ── Storage retention (daily) ─────────────────────────────────────────────────
_last_storage_cleanup_date: str | None = None


def check_storage_retention():
    """Delete expired files from R2/Supabase + thread_files rows (runs once per day).

    Retention is per-user via the agent_settings key ``storage_retention_days``
    (default 30, 0 = forever), snapshotted into thread_files.expires_at at upload time.
    """
    global _last_storage_cleanup_date
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if _last_storage_cleanup_date == today:
        return
    _last_storage_cleanup_date = today
    try:
        from research_agent import storage_service
        result = storage_service.cleanup_expired_files()
        log.info(f"🧹 Storage retention cleanup: deleted={result.get('deleted', 0)} errors={len(result.get('errors', []))}")
        for err in result.get("errors", [])[:5]:
            log.warning(f"  storage cleanup error: {err}")
    except Exception as e:
        log.error(f"Storage retention cleanup failed: {e}")


def _elapsed_since(iso_str: str) -> float:
    """Seconds elapsed since the given ISO timestamp."""
    if not iso_str:
        return float("inf")
    try:
        ts = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - ts).total_seconds()
    except Exception:
        return float("inf")


def _plugin_enabled(plugin_key: str) -> bool:
    """Return True if a plugin is enabled (any user override wins, else catalog default).

    Mirrors the semantics in research_agent/plugins.py: agents and schedules are
    compiled globally, so a plugin counts as enabled when any user enabled it,
    or — when no user has expressed a preference — when its default is enabled.
    On lookup failure the plugin is assumed enabled to preserve current behaviour.
    """
    try:
        plugin_rows = _sb_get("plugins", f"plugin_key=eq.{plugin_key}")
        if not plugin_rows:
            return True
        plugin = plugin_rows[0]
        override_rows = _sb_get("user_plugin_settings", f"plugin_key=eq.{plugin_key}")
        if any(r.get("enabled") for r in override_rows):
            return True
        if override_rows:
            return False
        return bool(plugin.get("default_enabled", True))
    except Exception as e:
        log.warning(f"Plugin check for '{plugin_key}' failed ({e}); assuming enabled.")
        return True


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
        if not _plugin_enabled("feeder"):
            log.info("Feeder plugin disabled; skipping feeder trigger.")
            return

        # Get all workflows
        workflows = _sb_get("workflows")
        if not workflows:
            log.info("Feeder: No workflows found.")
            return

        for wf in workflows:
            wf_id = wf["id"]
            wf_name = wf["name"]

            # Check if workflow itself is active
            is_active = str(wf.get("is_active", "true")).lower() == "true"
            if not is_active:
                continue

            # Workflow-specific feeder auto-trigger
            # Default to True if not explicitly set to False
            feeder_enabled = str(wf.get("feeder_enabled", "true")).lower() == "true"
            if not feeder_enabled:
                log.info(f"Feeder [{wf_name}]: Auto-run disabled.")
                continue

            interval_min = float(wf.get("feeder_interval_minutes") if wf.get("feeder_interval_minutes") is not None else 30)
            interval_sec = interval_min * 60
            last_at = wf.get("feeder_last_trigger_at") or ""
            elapsed = _elapsed_since(last_at)

            if elapsed >= interval_sec:
                run_time = now_iso()
                log.info(f"⏰ FEEDER [{wf_name}] trigger due (elapsed={elapsed/60:.1f}min, interval={interval_min}min) — firing...")

                # Save timestamp FIRST to prevent double-fire
                _sb_patch("workflows", f"id=eq.{wf_id}", {"feeder_last_trigger_at": run_time, "updated_at": run_time})

                def run_feeder_async(w_id, w_name):
                    try:
                        def _call_feeder():
                            resp = requests.post(f"{FEEDER_URL}/run", json={"workflow_id": w_id}, timeout=310)
                            resp.raise_for_status()
                            return resp
                        resp = _retry(_call_feeder, max_attempts=3, wait_seconds=10, label=f"Feeder:{w_name}")
                        log.info(f"✅ Feeder pipeline for [{w_name}] completed successfully.")
                    except Exception as e:
                        log.error(f"❌ Feeder HTTP call failed for [{w_name}] after 3 attempts: {e}")

                fire_in_background(run_feeder_async, wf_id, wf_name)
            else:
                remaining = interval_sec - elapsed
                log.info(f"Feeder [{wf_name}]: next run in {remaining/60:.1f}min (interval={interval_min}min)")

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


def _lg_create_thread(workflow_id: str = None, scheduled_task_id: str = None, scheduled_task_name: str = None) -> str:
    payload = {}
    metadata = {}
    if workflow_id:
        metadata["workflow_id"] = workflow_id
    if scheduled_task_id:
        metadata["scheduled_task_id"] = scheduled_task_id
    if scheduled_task_name:
        metadata["scheduled_task_name"] = scheduled_task_name
    if metadata:
        payload["metadata"] = metadata
    r = requests.post(f"{LG_URL}/threads", headers={"Content-Type": "application/json"}, json=payload, timeout=10)
    r.raise_for_status()
    return r.json()["thread_id"]


def _lg_create_run(thread_id: str, assistant_id: str, content: str, workflow_id: str = None) -> dict:
    payload = {
        "assistant_id": assistant_id,
        "input": {"messages": [{"role": "human", "content": content}]},
        "config": {
            "configurable": {
                "workflow_id": workflow_id
            }
        }
    }
    r = requests.post(
        f"{LG_URL}/threads/{thread_id}/runs",
        headers={"Content-Type": "application/json"},
        json=payload,
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def _lg_get_run(thread_id: str, run_id: str) -> dict:
    r = requests.get(
        f"{LG_URL}/threads/{thread_id}/runs/{run_id}",
        headers={"Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _lg_get_messages(thread_id: str) -> list:
    r = requests.get(
        f"{LG_URL}/threads/{thread_id}/state",
        headers={"Content-Type": "application/json"},
        timeout=10,
    )
    r.raise_for_status()
    state = r.json()
    return state.get("values", {}).get("messages", [])


def get_final_assistant_message(thread_id: str) -> str:
    try:
        msgs = _lg_get_messages(thread_id)
        assistant_msgs = []
        for m in msgs:
            role = m.get("role") or m.get("type")
            if role in ["assistant", "ai"]:
                content = m.get("content")
                if isinstance(content, list):
                    text_parts = []
                    for part in content:
                        if isinstance(part, dict) and part.get("type") == "text":
                            text_parts.append(part.get("text", ""))
                        elif isinstance(part, str):
                            text_parts.append(part)
                    content = "\n".join(text_parts)
                if content:
                    assistant_msgs.append((m.get("created_at") or "", content))
        if assistant_msgs:
            try:
                assistant_msgs.sort(key=lambda x: x[0])
            except Exception:
                pass
            return assistant_msgs[-1][1]
    except Exception as e:
        log.warning(f"Could not parse messages for thread {thread_id}: {e}")
    return ""


def _resolve_tz_name(tz: Optional[str]) -> Optional[str]:
    """Validate an IANA timezone name; returns None if invalid/empty."""
    if not tz or not str(tz).strip():
        return None
    tz = str(tz).strip()
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo(tz)
        return tz
    except Exception:
        return None


def _get_user_timezone(user_id: Optional[str]) -> Optional[str]:
    """Fetch the user's scheduler timezone preference (agent_settings key 'timezone')."""
    if not user_id:
        return None
    try:
        rows = _sb_get("agent_settings", f"user_id=eq.{user_id}&key=eq.timezone&select=value")
        if rows and rows[0].get("value"):
            return _resolve_tz_name(rows[0]["value"])
    except Exception as e:
        log.debug(f"Could not fetch timezone preference for user {user_id}: {e}")
    return None


def _build_datetime_context_block(tz: Optional[str] = None) -> str:
    """Render the current date/time so a background agent session knows 'now'.

    Scheduled runs start in a fresh session with no user present, so without this the
    agent has no reliable anchor for phrases like "today" inside its own prompt.
    """
    tz_name = _resolve_tz_name(tz)
    now = datetime.now(timezone.utc)
    if tz_name:
        try:
            from zoneinfo import ZoneInfo
            now = now.astimezone(ZoneInfo(tz_name))
        except Exception:
            now = now.astimezone()
    else:
        now = now.astimezone()
    label = tz_name or (now.tzname() or "server local time")
    return (
        "### Current Date & Time\n"
        f"- Now: {now.strftime('%Y-%m-%d %H:%M')} ({now.strftime('%A')}, {label})\n"
        "This is a scheduled background run. Treat the date above as \"today\" for any "
        "relative wording in the prompt below.\n"
    )


def _build_chat_context_block(
    thread_id: str,
    max_messages: int = 20,
    max_total_chars: int = 8000,
    max_msg_chars: int = 1200,
) -> str:
    """Render the recent conversation of a chat thread as a context block.

    Used for scheduled tasks created with mount_chat so the agent understands
    WHY the task exists and what the user originally asked for.
    """
    try:
        msgs = _lg_get_messages(thread_id)
    except Exception as e:
        log.warning(f"Could not fetch chat context from thread {thread_id}: {e}")
        return ""

    lines = []
    total = 0
    for m in msgs:
        role = m.get("role") or m.get("type")
        if role not in ("human", "user", "assistant", "ai"):
            continue
        content = m.get("content")
        if isinstance(content, list):
            parts = []
            for p in content:
                if isinstance(p, dict) and p.get("type") == "text":
                    parts.append(p.get("text", ""))
                elif isinstance(p, str):
                    parts.append(p)
            content = "\n".join(parts)
        if not content or not str(content).strip():
            continue
        content = str(content).strip()
        if len(content) > max_msg_chars:
            content = content[:max_msg_chars] + "…[truncated]"
        who = "user" if role in ("human", "user") else "assistant"
        lines.append(f"[{who}]: {content}")

    if not lines:
        return ""

    lines = lines[-max_messages:]
    rendered = "\n".join(lines)
    if len(rendered) > max_total_chars:
        rendered = rendered[-max_total_chars:]

    return (
        f"### Original Chat Context (thread {thread_id})\n"
        f"This task was created from the conversation below — it explains WHY the task exists "
        f"and what the user wants:\n\n{rendered}\n"
    )


def _resolve_assistant_id() -> str:
    """Resolve the default assistant id for background runs (fallback: 'research')."""
    try:
        assistants = _lg_list_assistants()
        if assistants:
            return assistants[0]["assistant_id"]
    except Exception as e:
        log.warning(f"Could not fetch assistants — using fallback 'research': {e}")
    return "research"


def _deliver_to_thread(thread_id: str, task_name: str, output: str, workflow_id: Optional[str] = None) -> bool:
    """Deliver a scheduled task's output back into a chat thread (deliver='thread:<id>')."""
    try:
        output_snippet = output if len(output) <= 4000 else output[:4000] + "…[truncated]"
        content = (
            f"[Scheduled Task Delivery]\n"
            f'The scheduled task "{task_name}" just finished running. Its output is below.\n'
            f"Briefly inform the user of the result in a natural, conversational way.\n\n"
            f"<task_output>\n{output_snippet}\n</task_output>"
        )
        run = _lg_create_run(thread_id, _resolve_assistant_id(), content, workflow_id)
        run_id = run.get("run_id") or run.get("id")
        if not run_id:
            raise KeyError(f"No run_id in delivery run response: {run}")

        start_time = time.time()
        timeout = 600  # 10 min max for the delivery run
        while time.time() - start_time < timeout:
            try:
                run_data = _lg_get_run(thread_id, run_id)
                status = run_data.get("status")
            except Exception as poll_err:
                log.warning(f"  [Delivery Poll] {poll_err}. Retrying in 5s...")
                time.sleep(5)
                continue
            if status not in ("pending", "running", "queued"):
                if status == "success":
                    log.info(f"📤 Delivered output of '{task_name}' to thread {thread_id}")
                    return True
                log.warning(f"  Delivery run for '{task_name}' ended with status: {status}")
                return False
            time.sleep(5)
        log.warning(f"  Delivery run for '{task_name}' timed out after 10 minutes.")
        try:
            requests.post(f"{LG_URL}/threads/{thread_id}/runs/{run_id}/cancel", timeout=5)
        except Exception:
            pass
        return False
    except Exception as e:
        log.warning(f"  Failed to deliver output of '{task_name}' to thread {thread_id}: {e}")
        return False


def run_script_job(script_path: str, workdir: Optional[str] = None) -> tuple[str, str]:
    import subprocess
    import sys
    try:
        ext = os.path.splitext(script_path)[1].lower()
        if ext == ".py":
            cmd = [sys.executable, script_path]
        elif ext == ".sh":
            cmd = ["bash", script_path]
        elif ext == ".bat" or ext == ".cmd":
            cmd = [script_path]
        else:
            cmd = [script_path]
            
        cwd = workdir if workdir and os.path.exists(workdir) else None
        
        result = subprocess.run(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=600,
            shell=True if os.name == 'nt' else False
        )
        status = "success" if result.returncode == 0 else "failed"
        return status, result.stdout
    except subprocess.TimeoutExpired as te:
        return "failed", f"Execution timed out after 10 minutes.\nStdout/Stderr:\n{te.stdout}"
    except Exception as e:
        return "failed", f"Failed to execute script: {str(e)}"


# ── Agent trigger ────────────────────────────────────────────────────────────
def check_agent() -> None:
    try:
        # Get all workflows
        workflows = _sb_get("workflows")
        if not workflows:
            log.info("Agent: No workflows found.")
            return

        for wf in workflows:
            wf_id = wf["id"]
            wf_name = wf["name"]
            # Check if workflow itself is active
            is_active = str(wf.get("is_active", "true")).lower() == "true"
            if not is_active:
                continue

            enabled = str(wf.get("enabled", "true")).lower() == "true"
            if not enabled:
                continue

            interval_min = float(wf.get("interval_minutes", 30) or 30)
            interval_sec = interval_min * 60
            last_at = wf.get("last_trigger_at") or ""
            elapsed = _elapsed_since(last_at)
            batch_size = int(wf.get("batch_size", 2) or 2)

            if elapsed >= interval_sec:
                # Check if this workflow has any feeder sources connected
                has_feeder_sources = False
                try:
                    sources = _sb_get("feeder_sources", f"workflow_id=eq.{wf_id}")
                    has_feeder_sources = len(sources) > 0
                except Exception as e:
                    log.warning(f"Could not check feeder sources for [{wf_name}]: {e}")
                    has_feeder_sources = True

                if has_feeder_sources:
                    # Query articles assigned to this workflow (must filter workflow_id)
                    pending = _sb_get(
                        "feeder_articles",
                        f"status=eq.Pending&workflow_id=eq.{wf_id}&order=created_at.asc&limit={batch_size}&select=id,title,description,url"
                    )
                    if not pending:
                        # Log message and check next workflow
                        log.info(f"Agent [{wf_name}]: trigger due but queue empty — skipping.")
                        continue

                    run_time = now_iso()
                    log.info(f"⏰ AGENT [{wf_name}] trigger due (elapsed={elapsed/60:.1f}min, interval={interval_min}min) — firing {len(pending)} articles...")

                    # Save timestamp FIRST to prevent double-fire
                    _sb_patch("workflows", f"id=eq.{wf_id}", {"last_trigger_at": run_time, "updated_at": run_time})

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

                    # Create one LangGraph run per article
                    for article in pending:
                        try:
                            clean_title = _strip_html(article.get('title', ''))
                            clean_desc  = _strip_html(article.get('description', ''))
                            content = f"Title: {clean_title}\nDescription: {clean_desc}"

                            def _create_run_for_article():
                                tid = _lg_create_thread(wf_id)
                                _lg_create_run(tid, assistant_id, content, wf_id)
                                return tid

                            thread_id = _retry(_create_run_for_article, max_attempts=3, wait_seconds=10, label=f"Agent:{wf_name}:{clean_title[:30]}")
                            log.info(f"  ✅ Created run for article in [{wf_name}]: {clean_title[:60]}")
                        except Exception as e:
                            # Revert article to Pending so it can be retried on next cron tick
                            try:
                                _sb_patch("feeder_articles", f"id=eq.{article['id']}", {"status": "Pending"})
                            except Exception:
                                pass
                            log.error(f"  ❌ Failed to create run for article {article['id']} in [{wf_name}] after 3 attempts: {e}")
                else:
                    # Standalone self-triggered workflow (no feeder sources connected)
                    run_time = now_iso()
                    log.info(f"⏰ AGENT [{wf_name}] trigger due (elapsed={elapsed/60:.1f}min, interval={interval_min}min) — firing standalone scheduler run...")

                    # Save timestamp FIRST to prevent double-fire
                    _sb_patch("workflows", f"id=eq.{wf_id}", {"last_trigger_at": run_time, "updated_at": run_time})

                    # Discover assistant_id from LangGraph
                    assistant_id = "research"   # fallback
                    try:
                        assistants = _lg_list_assistants()
                        if assistants:
                            assistant_id = assistants[0]["assistant_id"]
                            log.info(f"Using assistant: {assistant_id}")
                    except Exception as e:
                        log.warning(f"Could not fetch assistants — using fallback 'research': {e}")

                    try:
                        content = "Run scheduled workflow tasks."
                        def _create_standalone_run():
                            tid = _lg_create_thread(wf_id)
                            _lg_create_run(tid, assistant_id, content, wf_id)
                            return tid

                        thread_id = _retry(_create_standalone_run, max_attempts=3, wait_seconds=10, label=f"Agent:{wf_name}:Standalone")
                        log.info(f"  ✅ Created standalone run for [{wf_name}]")
                    except Exception as e:
                        log.error(f"  ❌ Failed to create standalone run for [{wf_name}] after 3 attempts: {e}")
            else:
                remaining = interval_sec - elapsed
                log.info(f"Agent [{wf_name}]:  next run in {remaining/60:.1f}min (interval={interval_min}min)")

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
        if not _plugin_enabled("posts"):
            log.info("Posts plugin disabled; skipping auto-publish.")
            return

        # Read social publish settings
        rows = _sb_get(
            "agent_settings",
            "key=in.(social_auto_publish,auto_publish_since,social_fb_enabled,social_ig_enabled,social_youtube_enabled,social_yt_enabled,social_twitter_enabled)"
            "&select=key,value,user_id"
        )
        smap = {r["key"]: r["value"] for r in rows}

        auto_publish = smap.get("social_auto_publish", "false").lower() == "true"
        if not auto_publish:
            return

        since_str    = smap.get("auto_publish_since", "") or ""

        # Bound the sweep. Without auto_publish_since, the first tick after
        # enabling auto-publish would treat the ENTIRE social_posts history as
        # publishable and re-post old drafts. Stamp "now" and start from here.
        # agent_settings is keyed (user_id, key), so the marker is written for
        # whichever user turned auto-publish on.
        if not since_str:
            since_str = datetime.now(timezone.utc).isoformat()
            owner_id = next(
                (
                    r.get("user_id")
                    for r in rows
                    if r.get("key") == "social_auto_publish"
                    and (r.get("value") or "").strip().lower() == "true"
                    and r.get("user_id")
                ),
                None,
            )
            if owner_id:
                try:
                    _sb_upsert(
                        "agent_settings",
                        [{"user_id": owner_id, "key": "auto_publish_since", "value": since_str}],
                    )
                    log.info(f"Auto-publish: no auto_publish_since marker — stamped {since_str}; older posts are skipped.")
                except Exception as stamp_err:
                    log.warning(f"Could not persist auto_publish_since ({stamp_err}); using in-memory cutoff for this tick.")
            else:
                log.warning("Auto-publish: could not determine the owner of social_auto_publish; using in-memory cutoff for this tick.")

        # Platform-enabled defaults must match the Posts UI (posts/page.tsx and
        # posts/settings/page.tsx), which shows Facebook/Instagram/YouTube ON and
        # X/Twitter OFF when a key was never saved. Previously cron required an
        # explicit "true", so the console and the scheduler disagreed about which
        # platforms were live.
        def _flag(key: str, default: bool, *aliases: str) -> bool:
            for k in (key, *aliases):
                raw = (smap.get(k) or "").strip().lower()
                if raw:
                    return raw == "true"
            return default

        fb_enabled   = _flag("social_fb_enabled", True)
        ig_enabled   = _flag("social_ig_enabled", True)
        yt_enabled   = _flag("social_youtube_enabled", True, "social_yt_enabled")
        tw_enabled   = _flag("social_twitter_enabled", False)

        # Build list of enabled platforms
        enabled_platforms = []
        if fb_enabled:  enabled_platforms.append("facebook")
        if ig_enabled:  enabled_platforms.append("instagram")
        if yt_enabled:  enabled_platforms.append("youtube")
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

            # Skip: already succeeded (True/"true") OR permanently failed ("failed") OR currently being published
            def _is_published(val) -> bool:
                return val is True or val == "true" or val == True  # noqa: E712

            pending_platforms = [
                p for p in enabled_platforms
                if not _is_published(published_to.get(p))
                and published_to.get(p) != "failed"
            ]
            if pending_platforms and post.get("id") not in _publishing_now:
                publish_candidates.append((post, pending_platforms))

        if not publish_candidates:
            return  # All posts already published to all enabled platforms

        log.info(f"📣 Auto-publish: {len(publish_candidates)} post(s) with pending platforms.")

        # Cap per-tick to avoid hitting Twitter rate limits when many posts are queued
        batch = publish_candidates[:_MAX_POSTS_PER_TICK]
        if len(publish_candidates) > _MAX_POSTS_PER_TICK:
            log.info(f"   (capping to {_MAX_POSTS_PER_TICK} per tick; {len(publish_candidates) - _MAX_POSTS_PER_TICK} deferred to next tick)")

        for idx, (post, platforms) in enumerate(batch):
            post_id = post.get("id", "?")
            _publishing_now.add(post_id)  # Guard against concurrent tick double-publish
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
                    headers=_internal_api_headers(),
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
            finally:
                _publishing_now.discard(post_id)  # Always release the guard

            # Throttle between posts when Twitter is included to avoid rate-limiting
            if "twitter" in platforms and idx < len(batch) - 1:
                log.info(f"   ⏳ Waiting {_TWITTER_POST_DELAY_SECONDS}s before next post (Twitter rate-limit buffer)...")
                time.sleep(_TWITTER_POST_DELAY_SECONDS)

    except Exception as e:
        log.error(f"check_auto_publish error: {e}")


# ── Scheduled Tasks trigger ──────────────────────────────────────────────────
def check_scheduled_tasks() -> None:
    try:
        now_str = now_iso()
        # Query where enabled=true, state is not 'running', and next_run_at <= now
        params = f"enabled=eq.true&state=neq.running&next_run_at=lte.{now_str}"
        due_tasks = _sb_get("agent_scheduled_tasks", params)
        if not due_tasks:
            return

        log.info(f"⏰ Scheduled Tasks: {len(due_tasks)} task(s) due.")

        for task in due_tasks:
            job_id = task["id"]
            task_name = task["name"]
            
            # Immediately lock the task by setting state to 'running'
            try:
                run_time = now_iso()
                _sb_patch("agent_scheduled_tasks", f"id=eq.{job_id}", {
                    "state": "running",
                    "last_run_at": run_time,
                    "updated_at": run_time
                })
            except Exception as e:
                log.error(f"Failed to lock job {task_name} ({job_id}): {e}")
                continue

            # Execute the task asynchronously
            fire_in_background(_execute_scheduled_task, task)

    except Exception as e:
        log.error(f"check_scheduled_tasks error: {e}")


def _execute_scheduled_task(task: dict) -> None:
    job_id = task["id"]
    task_name = task["name"]
    no_agent = task.get("no_agent", False)

    log.info(f"🚀 Executing scheduled task: {task_name} (ID: {job_id})")

    # Resolve task timezone: task override > user preference > HERMES_TIMEZONE env (inside compute_next_run)
    task_tz = _resolve_tz_name(task.get("timezone"))
    if not task_tz:
        task_tz = _get_user_timezone(task.get("user_id"))

    # Resolve context blocks
    context_blocks = []

    # 0) Live date/time anchor so the isolated session knows what "today" means
    context_blocks.append(_build_datetime_context_block(task_tz))

    # 1) Agent-written background summary (WHY the task exists)
    context_summary = task.get("context_summary")
    if context_summary and str(context_summary).strip():
        context_blocks.append(f"### Task Background\n{str(context_summary).strip()}\n")

    # 2) Mounted chat conversation (the chat where the task was created)
    mount_thread = task.get("mount_chat")
    if mount_thread:
        chat_block = _build_chat_context_block(mount_thread)
        if chat_block:
            context_blocks.append(chat_block)
        else:
            log.warning(f"  No chat context could be loaded for mounted thread {mount_thread}")

    # 3) Upstream task outputs (context_from dependency chain)
    context_from = task.get("context_from") or []
    if isinstance(context_from, str):
        try:
            context_from = json.loads(context_from)
        except Exception:
            context_from = []

    if context_from:
        for upstream_id in context_from:
            try:
                upstream = _sb_get("agent_scheduled_tasks", f"id=eq.{upstream_id}")
                if upstream:
                    u_task = upstream[0]
                    u_name = u_task.get("name", "Unknown")
                    u_logs = u_task.get("last_run_logs") or "No logs/output available."
                    context_blocks.append(
                        f"### Upstream Context from Task '{u_name}' (ID: {upstream_id})\n"
                        f"{u_logs}\n"
                    )
            except Exception as e:
                log.warning(f"Failed to fetch context from upstream job {upstream_id}: {e}")

    # Build prompt
    prompt = task.get("prompt") or ""
    if context_blocks:
        prompt = "\n\n".join(context_blocks) + "\n\nPrompt:\n" + prompt

    status = "failed"
    logs = ""
    error_msg = None

    try:
        if no_agent:
            # Script-only task
            script_path = task.get("script")
            if not script_path:
                status = "failed"
                logs = "Error: no_agent=True but no script path provided."
            else:
                workdir = task.get("workdir")
                status, logs = run_script_job(script_path, workdir)
        else:
            # Agent LangGraph task
            assistant_id = _resolve_assistant_id()

            wf_id = task.get("origin", {}).get("workflow_id") if isinstance(task.get("origin"), dict) else None
            thread_id = _lg_create_thread(wf_id, scheduled_task_id=job_id, scheduled_task_name=task_name)
            
            run = _lg_create_run(thread_id, assistant_id, prompt, wf_id)
            run_id = run.get("run_id") or run.get("id")
            if not run_id:
                raise KeyError(f"Could not find run_id in LangGraph run response: {run}")
            
            log.info(f"  LangGraph run created: thread={thread_id}, run={run_id}. Polling completion...")
            
            start_time = time.time()
            timeout = 1800
            completed = False
            
            while time.time() - start_time < timeout:
                try:
                    run_data = _lg_get_run(thread_id, run_id)
                    run_status = run_data.get("status")
                except Exception as poll_err:
                    log.warning(f"  [Poll Warning] Temporary timeout or connection issue checking run status: {poll_err}. Retrying in 5s...")
                    time.sleep(5)
                    continue
                
                if run_status not in ["pending", "running", "queued"]:
                    completed = True
                    if run_status == "success":
                        status = "success"
                    else:
                        status = "failed"
                        error_msg = f"LangGraph run status: {run_status}"
                    break
                
                time.sleep(5)
                
            if not completed:
                status = "failed"
                error_msg = "LangGraph run timed out after 30 minutes."
                try:
                    requests.post(f"{LG_URL}/threads/{thread_id}/runs/{run_id}/cancel", timeout=5)
                except Exception:
                    pass
            else:
                logs = get_final_assistant_message(thread_id)
                if not logs:
                    logs = f"LangGraph run completed with status '{status}' but no assistant response was found."

    except Exception as e:
        status = "failed"
        error_msg = str(e)
        logs = f"Exception occurred during execution:\n{str(e)}"
        log.error(f"Error executing scheduled task {task_name}: {e}", exc_info=True)

    # Post-execution updates
    try:
        now_time = now_iso()
        repeat_times = task.get("repeat_times")
        repeat_completed = task.get("repeat_completed") or 0
        enabled = task.get("enabled", True)
        state = "scheduled"
        
        if status == "success":
            repeat_completed += 1
            if repeat_times and repeat_completed >= repeat_times:
                enabled = False
                state = "completed"
                
        # Calculate next run (in the task's timezone, stored as UTC)
        schedule_dict = task.get("schedule")
        if isinstance(schedule_dict, str):
            try:
                schedule_dict = json.loads(schedule_dict)
            except Exception:
                schedule_dict = {}

        next_run_at = None
        if enabled and state == "scheduled":
            from research_agent.tools.cronjob import compute_next_run
            next_run_at = compute_next_run(schedule_dict, last_run_at=now_time, tz=task_tz)
            if not next_run_at:
                enabled = False
                state = "completed"

        updates = {
            "state": state,
            "enabled": enabled,
            "repeat_completed": repeat_completed,
            "last_status": status,
            "last_run_logs": logs,
            "last_error": error_msg,
            "next_run_at": next_run_at,
            "updated_at": now_time
        }
        _sb_patch("agent_scheduled_tasks", f"id=eq.{job_id}", updates)
        log.info(f"✅ Scheduled task completed: {task_name} (Status: {status}, Next Run: {next_run_at})")
    except Exception as e:
        log.error(f"Failed to update task post-run status for {task_name}: {e}")

    # Deliver output back to the origin chat (deliver='thread:<id>' / 'origin')
    deliver = (task.get("deliver") or "local").strip()
    if deliver.startswith("thread:") and status == "success" and logs:
        origin = task.get("origin") if isinstance(task.get("origin"), dict) else {}
        _deliver_to_thread(
            deliver.split(":", 1)[1].strip(),
            task_name,
            logs,
            workflow_id=origin.get("workflow_id"),
        )


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
        fire_in_background(check_feeder)
        fire_in_background(check_agent)
        fire_in_background(check_scheduled_tasks)
        fire_in_background(check_auto_publish)
        fire_in_background(check_storage_retention)
        time.sleep(TICK_SECONDS)


if __name__ == "__main__":
    main()

