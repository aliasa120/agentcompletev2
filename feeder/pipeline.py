"""
Feeder Pipeline - layered article deduplication.

Layer -2: Time filter (drop old articles)
Layer -1: Domain whitelist (keep only trusted sources)
Layer  0: Event clustering (best source per event cluster; uses Google's own
          cluster sibling titles as a free same-story signal)
Cap:      keep at most the workflow's max-articles-per-run
Layer  1: GUID check (Supabase, CHECK-ONLY)
Layer  2: Hash check (SHA-256 of normalized title, Supabase, CHECK-ONLY)
Layer  AI: Feeder Dedup Agent (Pass 1 — LLM STORYLINE dedup, replaces L3/L4/L5),
          chunked at LLM_CHUNK_SIZE articles per call:
          Phase 1 — in-batch storyline dedup (group by developing story)
          Phase 2 — DB + earlier-chunk comparison (drop already-covered stories)
Layer  AI2: Feeder VERIFY Agent (Pass 2 — independent LLM reviewer, its own
          selectable model) re-reviews ALL Pass-1 survivors with DROP-ONLY
          authority: catches misses + cross-chunk leftovers. Can only shrink
          the kept set, so the two passes converge. Toggle: verifier_enabled.

Settings precedence: defaults < feeder_settings (global)
                     < agent_settings (per user) < workflows.feeder_* (per workflow).

DEFERRED STORAGE: Nothing written to DB during any layer check.
Atomic storage block runs ONLY after article passes ALL layers.

RUN HISTORY: every run writes one row to feeder_run_history with per-layer
counts, the full drop log (which layer stopped which article + why), the kept
list, and the agent's storyline clusters — powering the UI run logs.
"""
import calendar
import math
import feedparser
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from dotenv import load_dotenv
load_dotenv()

from feeder.db import supabase_client
from feeder.models import FeederArticle
from feeder.feed_clean import clean_title, extract_cluster_siblings, clean_description
from feeder.layer_minus1_domain import layer_minus1_domain, reset_whitelist_cache
from feeder.layer_0_event_clustering import layer_0_event_clustering
from feeder.layer_1_guid import layer_1_guid
from feeder.layer_2_hash import layer_2_hash
from feeder_agent.agent import run_feeder_dedup_agent
from feeder_agent.verifier import run_feeder_verify_agent

# Max articles sent to the LLM dedup agent per call (keeps prompts well sized)
LLM_CHUNK_SIZE = 40

# Safety caps for the JSONB logs persisted to feeder_run_history
MAX_LOG_ENTRIES = 500
MAX_STORYLINE_ENTRIES = 200


# --- Settings from Supabase -----------------------------------------------
INT_KEYS = ("batch_size", "max_age_minutes", "cluster_threshold", "agent_db_title_limit")


def _clamp(settings: dict) -> dict:
    """Keep every setting inside sane, supported bounds."""
    settings["batch_size"] = max(1, min(500, settings["batch_size"]))          # articles per run
    settings["max_age_minutes"] = max(5, min(43200, settings["max_age_minutes"]))  # 5min..30d
    settings["cluster_threshold"] = max(0, min(100, settings["cluster_threshold"]))
    settings["agent_db_title_limit"] = max(0, min(2000, settings["agent_db_title_limit"]))
    return settings


def load_settings(user_id: str = None, workflow_id: str = None) -> dict:
    """Resolve feeder settings with layered precedence:

        defaults  <  global feeder_settings  <  per-user agent_settings  <  workflow columns

    So a run is always scopeable per user AND per workflow, while older
    global keys keep working as fallback defaults.
    """
    settings = {
        "batch_size": 100,          # max articles kept per run (Google News RSS tops out ~100/feed)
        "max_age_minutes": 60,      # default: last 60 minutes of news
        "cluster_threshold": 70,
        "agent_db_title_limit": 300,
        "allow_all_domains": False,
        "verifier_enabled": True,   # Pass-2 verifier agent (second LLM review of survivors)
    }

    # 1. Global feeder_settings table (base defaults, kept for backwards compatibility)
    try:
        res = supabase_client.table("feeder_settings").select("key,value").execute()
        for row in (res.data or []):
            k, v = row["key"], row["value"]
            if k in INT_KEYS:
                try:
                    settings[k] = int(float(v))
                except (ValueError, TypeError):
                    pass
            elif k == "allow_all_domains":
                settings["allow_all_domains"] = str(v).lower() in ("true", "1", "yes")
            elif k == "verifier_enabled":
                settings["verifier_enabled"] = str(v).lower() in ("true", "1", "yes")
    except Exception as e:
        print(f"Warning: Could not load global feeder settings: {e}")

    # 2. Per-user overrides from agent_settings (feeder_* prefixed keys)
    if user_id:
        try:
            from research_agent.tools.provider_engine import get_settings as _get_agent_settings
            user_settings = _get_agent_settings(user_id)
            if "feeder_allow_all_domains" in user_settings:
                settings["allow_all_domains"] = str(user_settings["feeder_allow_all_domains"]).lower() in ("true", "1", "yes")
            if "feeder_verifier_enabled" in user_settings:
                settings["verifier_enabled"] = str(user_settings["feeder_verifier_enabled"]).lower() in ("true", "1", "yes")
            for k, setting_key in [
                ("batch_size", "feeder_batch_size"),
                ("max_age_minutes", "feeder_max_age_minutes"),
                ("cluster_threshold", "feeder_cluster_threshold"),
                ("agent_db_title_limit", "feeder_agent_db_title_limit"),
            ]:
                if setting_key in user_settings:
                    try:
                        settings[k] = int(float(user_settings[setting_key]))
                    except (ValueError, TypeError):
                        pass
        except Exception as e:
            print(f"Warning: Could not load user agent_settings for feeder: {e}")

    # 3. Per-workflow overrides (strongest): workflows.feeder_* columns
    if workflow_id:
        try:
            res = supabase_client.table("workflows") \
                .select("feeder_max_age_minutes, feeder_max_articles_per_run, feeder_cluster_threshold") \
                .eq("id", workflow_id).maybe_single().execute()
            wf = res.data or None
            if wf:
                if wf.get("feeder_max_age_minutes") is not None:
                    settings["max_age_minutes"] = int(wf["feeder_max_age_minutes"])
                if wf.get("feeder_max_articles_per_run") is not None:
                    settings["batch_size"] = int(wf["feeder_max_articles_per_run"])
                if wf.get("feeder_cluster_threshold") is not None:
                    settings["cluster_threshold"] = int(wf["feeder_cluster_threshold"])
        except Exception as e:
            print(f"Warning: Could not load per-workflow feeder settings: {e}")

    return _clamp(settings)


# Built-in authority fallback for common news domains (ranked: earlier = more trusted).
# feeder_whitelisted_domains order always wins; this list only fills ranks for domains
# NOT in the whitelist, so "allow_all_domains=true" runs still keep a credible source
# per event cluster instead of whichever domain the feed happened to list first.
BUILTIN_DOMAIN_AUTHORITY = [
    # global wires / majors
    "reuters.com", "apnews.com", "afp.com", "bbc.com", "bbc.co.uk", "aljazeera.com",
    "cnn.com", "nytimes.com", "theguardian.com", "washingtonpost.com", "bloomberg.com",
    # Pakistani majors
    "dawn.com", "thenews.com.pk", "tribune.com.pk", "geo.tv", "arynews.tv",
    "dunyanews.tv", "samaa.tv", "app.com.pk", "radio.gov.pk", "brecorder.com",
    "businessrecorder.com", "nation.com.pk", "dailytimes.com.pk", "pakobserver.net",
    # regional majors
    "arabnews.com", "arabnews.pk", "aa.com.tr", "timesnownews.com", "ndtv.com",
    "hindustantimes.com", "indianexpress.com", "thehindu.com", "aninews.in",
    "channelnewsasia.com", "scmp.com",
    # sports authorities
    "espncricinfo.com", "skysports.com", "icc-cricket.com",
]


def load_domain_priority() -> dict[str, int]:
    """Trust ranks {domain: rank} — lower rank = more trusted = kept cluster winner.

    Ranks come from feeder_whitelisted_domains first (insertion order = admin's
    trust order), then BUILTIN_DOMAIN_AUTHORITY for domains not whitelisted.
    Anything else ranks last (99_999) in layer_0_event_clustering.
    """
    ranks: dict[str, int] = {}
    try:
        res = supabase_client.table("feeder_whitelisted_domains") \
            .select("domain").order("created_at", desc=False).execute()
        ranks = {row["domain"].lower(): idx for idx, row in enumerate(res.data or [])}
    except Exception as e:
        print(f"Warning: Could not load domain priority: {e}")
    for dom in BUILTIN_DOMAIN_AUTHORITY:
        ranks.setdefault(dom, len(ranks))
    return ranks


def load_feed_sources(workflow_id: str = None) -> list[dict]:
    try:
        query = supabase_client.table("feeder_sources") \
            .select("id, url, workflow_id, workflows!inner(is_active)") \
            .eq("is_active", True) \
            .eq("workflows.is_active", True)
        if workflow_id:
            query = query.eq("workflow_id", workflow_id)
        res = query.execute()
        sources = res.data or []
        return [{"id": s["id"], "url": s["url"], "workflow_id": s["workflow_id"]} for s in sources]
    except Exception as e:
        print(f"Warning: Could not load feed sources: {e}")
        return []


def fetch_rss_feed(url: str, max_age_minutes: int = 0) -> list[FeederArticle]:
    """Fetch articles from an RSS feed URL.

    For Google News RSS URLs, automatically appends when:Nh to get only recent articles.
    max_age_minutes > 0 will inject `when:Nh` into google news queries for better freshness.

    Every entry is cleaned at the door (feeder.feed_clean):
      - title: trailing " - <Source>" suffix stripped (cross-outlet hash/cluster
        matching works on the headline itself, not the outlet's decoration)
      - description: Google summaries contain only the repeated title + redirect
        URLs, no article text -> stored as "" instead of polluting DB/prompts
      - sibling_titles: other headlines Google clustered with this one
    """
    # Inject freshness filter into Google News RSS URLs.
    # IMPORTANT: Google News only supports when:Nh (hour-based). when:Xm returns 0 results.
    # Strategy: ask Google for a wider window (at least 1h, max 24h) and let Layer -2
    # do the precise minute-level time cut in Python.
    if max_age_minutes > 0 and "news.google.com/rss" in url:
        # Round up to nearest hour, clamp between 1h and 720h (30 days)
        when_hours = max(1, min(720, math.ceil(max_age_minutes / 60)))
        when_val = f"{when_hours}h"

        from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
        parsed = urlparse(url)
        params = parse_qs(parsed.query, keep_blank_values=True)
        q_parts = params.get("q", [""])[0].split()
        # Remove any existing when: filters
        q_parts = [p for p in q_parts if not p.startswith("when:")]
        q_parts.append(f"when:{when_val}")
        params["q"] = [" ".join(q_parts)]
        new_query = urlencode(params, doseq=True)
        url = urlunparse(parsed._replace(query=new_query))
        print(f"  [Feed] Google News time filter: when:{when_val} applied (Python Layer-2 will cut precisely to {max_age_minutes}min)")


    feed = feedparser.parse(url)
    articles = []
    for entry in feed.entries:
        link = getattr(entry, "link", "")
        source = getattr(entry, "source", None)
        source_title = ""
        if isinstance(source, dict):
            source_title = source.get("title") or ""
            if source.get("href"):
                raw_domain = urlparse(source["href"]).netloc
            else:
                raw_domain = urlparse(link).netloc
        else:
            raw_domain = urlparse(link).netloc
        domain = raw_domain.lower().removeprefix("www.")

        pub_date = None
        if hasattr(entry, "published_parsed") and entry.published_parsed:
            try:
                pub_date = datetime.fromtimestamp(
                    calendar.timegm(entry.published_parsed), tz=timezone.utc
                )
            except Exception:
                pass

        raw_title = getattr(entry, "title", "") or ""
        summary_html = getattr(entry, "summary", "") or ""

        articles.append(FeederArticle(
            title=clean_title(raw_title, source_title),
            link=link,
            description=clean_description(summary_html),
            guid=getattr(entry, "id", link),
            published_parsed=pub_date,
            domain=domain,
            sibling_titles=extract_cluster_siblings(summary_html, own_title=raw_title),
        ))
    return articles


# --- Verbose drop logger ---------------------------------------------------
def _log_drop(layer: str, article_title: str, reason: str):
    """Print a consistent drop log line visible in the pipeline output."""
    print(f"  [DROP {layer}] '{article_title[:70]}'"
          f"\n             Reason: {reason}")


# --- Run history persistence ------------------------------------------------
def _write_run_history(
    workflow_id: str | None,
    started_at: datetime,
    status: str,
    stats: dict,
    drop_log: list[dict],
    kept_log: list[dict],
    storylines: list,
    error: str = "",
):
    """Persist one run-history row. Never raises — logging must not break the pipeline."""
    try:
        row = {
            "workflow_id": workflow_id,
            "ran_at": started_at.isoformat(),
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "status": status,
            # legacy counter columns (kept populated for backward compatibility)
            "fetched": stats.get("fetched", 0),
            "passed_l1_4": stats.get("after_guid_hash", 0),
            "passed_l5": stats.get("after_verifier", stats.get("after_agent", 0)),
            "final_new": stats.get("stored", 0),
            "dropped_total": stats.get("total_dropped", 0),
            # rich per-layer visibility
            "layer_stats": stats,
            "drop_log": drop_log[:MAX_LOG_ENTRIES],
            "kept_log": kept_log[:MAX_LOG_ENTRIES],
            "storylines": storylines[:MAX_STORYLINE_ENTRIES],
        }
        if error:
            row["error"] = str(error)[:4000]
        supabase_client.table("feeder_run_history").insert(row).execute()
        print(f"[RunHistory] Run logged to feeder_run_history (status={status}).")
    except Exception as e:
        print(f"[RunHistory] WARNING: could not write run history: {e}")


# --- Main Pipeline ---------------------------------------------------------
def run_feeder_pipeline(workflow_id: str = None, user_id: str = None) -> tuple[list["FeederArticle"], list[tuple["FeederArticle", str]]]:
    """Run the full feeder deduplication pipeline.

    Args:
        workflow_id: Scope the run to a specific workflow.
        user_id: The authenticated user's UUID. When provided, per-user API keys
                 and feeder settings from agent_settings are used instead of global env.
    """
    # Inject user_id into ContextVar so all tool calls use per-user keys
    _token = None
    if user_id:
        try:
            from research_agent.tools.provider_engine import active_user_id
            _token = active_user_id.set(user_id)
        except Exception:
            pass

    try:
        return _run_feeder_pipeline_inner(workflow_id=workflow_id, user_id=user_id)
    finally:
        if _token is not None:
            try:
                from research_agent.tools.provider_engine import active_user_id
                active_user_id.reset(_token)
            except Exception:
                pass


def _run_feeder_pipeline_inner(workflow_id: str = None, user_id: str = None) -> tuple[list["FeederArticle"], list[tuple["FeederArticle", str]]]:
    started_at = datetime.now(timezone.utc)
    settings = load_settings(user_id, workflow_id)
    batch_size      = settings["batch_size"]
    max_age_minutes = settings["max_age_minutes"]   # always use minutes, no legacy override
    cluster_thr     = settings["cluster_threshold"]
    agent_db_limit  = settings["agent_db_title_limit"]

    effective_max_minutes = max_age_minutes

    print(f"\n[Pipeline] Time filter: last {effective_max_minutes} minutes ({effective_max_minutes/60:.1f}h)")
    if workflow_id:
        print(f"[Pipeline] Running for Workflow ID: {workflow_id}")

    domain_priority = load_domain_priority()
    feed_sources    = load_feed_sources(workflow_id)
    reset_whitelist_cache()

    # ── Run-long observability state ─────────────────────────────────────────
    # drop_log: JSONB rows {layer, title, domain, reason} for EVERY drop at EVERY layer
    # dropped:  return value (article, "[Layer] reason") — kept for API compatibility
    dropped: list[tuple[FeederArticle, str]] = []
    drop_log: list[dict] = []
    kept_log: list[dict] = []
    storylines: list[dict] = []
    stats: dict = {"window_minutes": effective_max_minutes, "feeds": len(feed_sources)}

    def _record_drop(layer_label: str, art: FeederArticle, reason: str, echo: bool = True):
        if echo:
            _log_drop(layer_label, art.title, reason)
        drop_log.append({"layer": layer_label, "title": art.title, "domain": art.domain, "reason": reason})
        dropped.append((art, f"[{layer_label}] {reason}"))

    try:
        # -- Fetch --
        raw: list[FeederArticle] = []
        for src in feed_sources:
            url = src["url"]
            wf_id = src.get("workflow_id")
            src_id = src.get("id")
            fetched = fetch_rss_feed(url, max_age_minutes=effective_max_minutes)
            with_sibs = sum(1 for a in fetched if a.sibling_titles)
            print(f"  [Feed] {urlparse(url).netloc}: {len(fetched)} entries"
                  f" ({with_sibs} carrying Google cluster siblings)")
            for art in fetched:
                art.workflow_id = wf_id
                art.source_id = src_id
            raw.extend(fetched)
        stats["fetched"] = len(raw)
        print(f"Fetched {len(raw)} raw articles from {len(feed_sources)} feed(s).")

        # -- Layer -2: Time filter (minutes-aware) --
        print(f"\n=== Layer -2: Time filter (<= {effective_max_minutes} min) ===")
        threshold_dt = datetime.now(timezone.utc) - timedelta(minutes=effective_max_minutes)
        after_time = [a for a in raw if a.published_parsed is None or a.published_parsed >= threshold_dt]
        for a in raw:
            if a not in after_time:
                mins_old = int((datetime.now(timezone.utc) - a.published_parsed).total_seconds() / 60)
                _record_drop("Time", a, f"Too old ({mins_old}min old, limit={effective_max_minutes}min)")
        stats["after_time"] = len(after_time)
        print(f"-> {len(after_time)} passed, {len(raw)-len(after_time)} dropped by time filter.")

        # -- Layer -1: Domain whitelist --
        allow_all_domains = bool(settings.get("allow_all_domains", False))
        if allow_all_domains:
            print(f"\n=== Layer -1: Domain whitelist — BYPASSED (allow_all_domains=true) ===")
        else:
            print(f"\n=== Layer -1: Domain whitelist ===")
        after_domain = [a for a in after_time if layer_minus1_domain(a.domain, a.workflow_id, allow_all=allow_all_domains)]
        for a in after_time:
            if a not in after_domain:
                _record_drop("Domain", a, f"Domain '{a.domain}' not in whitelist")
        stats["after_domain"] = len(after_domain)
        print(f"-> {len(after_domain)} passed, {len(after_time)-len(after_domain)} dropped.")

        # -- Layer 0: Event clustering --
        print(f"\n=== Layer 0: Event clustering (fuzzy titles + Google cluster siblings, threshold {cluster_thr}%) ===")
        after_cluster, cluster_dropped = layer_0_event_clustering(
            after_domain, domain_priority, cluster_threshold=cluster_thr
        )
        for a, r in cluster_dropped:
            _record_drop("Cluster", a, r)
        stats["after_cluster"] = len(after_cluster)
        print(f"-> {len(after_cluster)} passed, {len(cluster_dropped)} same-event removed.")

        # Batch cap
        batch = after_cluster[:batch_size]
        if len(after_cluster) > batch_size:
            for a in after_cluster[batch_size:]:
                _record_drop("Cap", a, f"Over batch cap of {batch_size} articles per run", echo=False)
            stats.setdefault("dropped_over_cap", len(after_cluster) - batch_size)
        print(f"-> Processing batch of {len(batch)} through Layers 1-2 then Feeder Dedup Agent.")

        # -- Layers 1-2: GUID + Hash check (deterministic, CHECK-ONLY) --
        print(f"\n=== Layers 1-2: GUID / normalized-title Hash ===")
        passed: list[FeederArticle] = []

        for art in batch:
            # L1 - GUID
            is_new, note = layer_1_guid(art.guid, art.workflow_id)
            if not is_new:
                _record_drop("L1-GUID", art, note)
                continue

            # L2 - Hash
            is_new, h, note = layer_2_hash(art.title, art.description, art.link, art.workflow_id)
            art.hash = h
            if not is_new:
                _record_drop("L2-Hash", art, note)
                continue

            passed.append(art)

        stats["after_guid_hash"] = len(passed)
        print(f"-> {len(passed)} passed, {len(batch)-len(passed)} dropped (exact re-delivery / same normalized headline).")

        # -- Feeder Dedup Agent: replaces L3 (Fuzzy) + L4 (NER) + L5 (Semantic) --
        # Chunked at 40 articles per LLM call so large runs (100+ articles) stay
        # well inside the model context window. Kept titles from chunk N are fed
        # into chunk N+1's context so cross-chunk duplicates are still caught.
        print(f"\n=== Feeder Dedup Agent: storyline dedup ({len(passed)} articles, chunks of {LLM_CHUNK_SIZE}) ===")
        final: list[FeederArticle] = []
        run_kept_titles: list[str] = []
        for start in range(0, len(passed), LLM_CHUNK_SIZE):
            chunk = passed[start:start + LLM_CHUNK_SIZE]
            if len(passed) > LLM_CHUNK_SIZE:
                print(f"-> Dedup chunk {start // LLM_CHUNK_SIZE + 1}: {len(chunk)} articles"
                      f" (context: {len(run_kept_titles)} kept earlier this run)")
            kept, agent_dropped, report = run_feeder_dedup_agent(
                chunk,
                db_title_limit=agent_db_limit,
                workflow_id=workflow_id,
                extra_context_titles=run_kept_titles,
            )
            final.extend(kept)
            run_kept_titles.extend(a.title for a in kept)
            storylines.extend(report.get("storylines") or [])
            for a, r in agent_dropped:
                # agent already printed its drop lines; record without double-printing
                _record_drop("Agent", a, r, echo=False)

        stats["after_agent"] = len(final)
        print(f"-> {len(final)} passed Agent dedup.")

        # -- Pass 2: Verifier Agent (independent reviewer, DROP-ONLY authority) --
        # Reviews the FULL survivor list at once: catches pass-1 misses AND
        # cross-chunk leftovers. Own selectable model (feeder_verifier_* settings).
        if settings.get("verifier_enabled", True) and len(final) > 1:
            print(f"\n=== Feeder Verifier Agent: pass-2 review of {len(final)} survivors ===")
            v_kept, v_dropped, v_report = run_feeder_verify_agent(
                final,
                storylines=storylines,
                db_title_limit=agent_db_limit,
                workflow_id=workflow_id,
            )
            for a, r in v_dropped:
                # verifier already printed its drop lines; record without double-printing
                _record_drop("Verifier", a, r, echo=False)
            stats["verifier"] = {
                "enabled": True,
                "reviewed": len(final),
                "dropped": len(v_dropped),
                "summary": v_report.get("summary", ""),
                "notes": v_report.get("notes", []),
            }
            final = v_kept
            stats["after_verifier"] = len(final)
            print(f"-> {len(final)} survived verification ({len(v_dropped)} extra duplicates caught by verifier).")
        else:
            stats["verifier"] = {"enabled": False}
            stats["after_verifier"] = len(final)
            if not settings.get("verifier_enabled", True):
                print(f"\n=== Feeder Verifier Agent: DISABLED (verifier_enabled=false) ===")

        # ====================================================================
        # ATOMIC STORAGE: ALL layers passed -> store everything now
        # ====================================================================
        if final:
            print(f"\nStoring {len(final)} articles atomically...")
            for art in final:
                target_wf_id = art.workflow_id or workflow_id
                try:
                    supabase_client.table("feeder_seen_guids").insert({"guid": art.guid, "workflow_id": target_wf_id}).execute()
                except Exception as e:
                    print(f"  [store] GUID error: {e}")
                try:
                    supabase_client.table("feeder_seen_hashes").insert({"hash": art.hash, "workflow_id": target_wf_id}).execute()
                except Exception as e:
                    print(f"  [store] Hash error: {e}")
                try:
                    row = {
                        "guid": art.guid,
                        "hash": art.hash,
                        "title": art.title,
                        "description": art.description,
                        "url": art.link,
                        "source_domain": art.domain,
                        "status": "Pending",
                    }
                    if target_wf_id:
                        row["workflow_id"] = target_wf_id
                    if art.source_id:
                        row["source_id"] = art.source_id
                    if art.published_parsed is not None:
                        row["published_at"] = art.published_parsed.isoformat()
                    supabase_client.table("feeder_articles").upsert(row, on_conflict="guid").execute()
                    kept_log.append({"title": art.title, "domain": art.domain})
                    print(f"  [stored] '{art.title[:80]}'")
                except Exception as e:
                    print(f"  [store] Article error: {e}")

        stats["stored"] = len(final)
        stats["total_dropped"] = len(dropped)

        # ====================================================================
        # FINAL SUMMARY: Full drop report
        # ====================================================================
        print(f"\n{'='*60}")
        print(f"PIPELINE SUMMARY")
        print(f"{'='*60}")
        print(f"  Fetched:        {len(raw)}")
        print(f"  After Time:     {len(after_time)}")
        print(f"  After Domain:   {len(after_domain)}")
        print(f"  After Cluster:  {len(after_cluster)}")
        print(f"  After GUID/Hash:{len(passed)}")
        print(f"  After Agent P1: {stats.get('after_agent', len(final))}")
        print(f"  After Verify P2:{stats.get('after_verifier', len(final))}"
              f"{'  [disabled]' if not stats.get('verifier', {}).get('enabled') else ''}")
        print(f"  STORED/Final:   {len(final)}")
        print(f"  Total Dropped:  {len(dropped)}")
        print(f"{'='*60}")
        print(f"[ok] {len(final)} new unique articles stored as Pending!")

        _write_run_history(
            workflow_id=workflow_id,
            started_at=started_at,
            status="success",
            stats=stats,
            drop_log=drop_log,
            kept_log=kept_log,
            storylines=storylines,
        )

        return final, dropped

    except Exception as e:
        stats["total_dropped"] = len(dropped)
        print(f"\n[Pipeline] RUN FAILED: {e}")
        _write_run_history(
            workflow_id=workflow_id,
            started_at=started_at,
            status="failed",
            stats=stats,
            drop_log=drop_log,
            kept_log=kept_log,
            storylines=storylines,
            error=str(e),
        )
        raise


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--workflow-id", type=str, help="Workflow ID to run the feeder for")
    parser.add_argument("--user-id", type=str, help="User ID for per-user API keys and settings")
    args = parser.parse_args()
    run_feeder_pipeline(workflow_id=args.workflow_id, user_id=args.user_id)
