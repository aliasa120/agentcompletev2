"""Core provider engine — retry, fallback, timeout, and error classification.

All unified tools (unified_search, unified_extract, unified_image) use this module
to execute provider functions.

Retry strategy (Round-based flat delay):
  We perform `max_retries` rounds.
  In each round:
    1. Try Primary provider.
    2. If it fails, try Secondary provider.
    3. If BOTH fail in this round, wait `retry_delay_seconds` (default 15s).

  If all rounds are exhausted, return a graceful ProviderResult with failed=True
  (never raises — prevents pipeline crashes).

Default retry counts:
  Search / Extract : 4 rounds (Primary -> Secondary -> wait 15s)
  Image            : 2 rounds (Primary -> Secondary -> wait 15s)

All defaults are overridable via Supabase ``agent_settings`` keys:
  search_max_retries     (int, default 4)
  extract_max_retries    (int, default 4)
  image_max_retries      (int, default 2)
  retry_delay_seconds    (int, default 15)

Per-agent LLM config keys (resolved from Supabase, keys from ENV):
  main_agent_provider         (any key in PROVIDER_REGISTRY, default "vercel")
  main_agent_model            (model name string)
  analyzer_provider           (any key in PROVIDER_REGISTRY, default "vercel")
  analyzer_model              (model name string)
  feeder_provider             (any key in PROVIDER_REGISTRY, default "vercel")
  feeder_model                (model name string)
  research_subagent_provider  (any key in PROVIDER_REGISTRY, defaults to main_agent value)
  research_subagent_model     (model name string)
  content_subagent_provider   (any key in PROVIDER_REGISTRY, defaults to main_agent value)
  content_subagent_model      (model name string)

API KEYS ARE NEVER STORED IN SUPABASE. They live only in .env.
Settings (provider/model selection, retry counts) are cached 60s.

Enterprise pattern:
  To add a new provider → add it to provider_registry.py + add env var → done.
"""

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Optional
from langchain_core.tools import BaseTool

from .provider_registry import (
    get_provider_api_key,
    get_provider_base_url,
    get_provider_config,
    get_all_provider_names,
)

logger = logging.getLogger("provider_engine")

# ── Settings Cache ─────────────────────────────────────────────────────────────

import redis
import json

_CACHE_TTL_SECONDS = 60  # refresh from Supabase every 60 s
_settings_cache: dict[str, str] = {}
_cache_loaded_at: float = 0.0
_redis_client: Optional[Any] = None

def get_redis_client() -> Optional[Any]:
    global _redis_client
    if _redis_client is None:
        redis_url = os.environ.get("REDIS_URL")
        if not redis_url:
            _redis_client = False
            return None
        
        # If running inside Docker and REDIS_URL is local, point to docker service name 'redis'
        if os.path.exists("/.dockerenv"):
            if "127.0.0.1" in redis_url or "localhost" in redis_url:
                redis_url = "redis://redis:6379"

        try:
            _redis_client = redis.Redis.from_url(redis_url, decode_responses=True)
            _redis_client.ping()
            logger.debug(f"[provider_engine] Connected to Redis successfully at {redis_url}")
        except Exception as e:
            logger.warning(f"[provider_engine] Failed to connect to Redis at {redis_url}: {e}")
            _redis_client = False  # Disable Redis to prevent repeating errors
    return _redis_client if _redis_client is not False else None


def _fetch_settings_from_supabase() -> dict[str, str]:
    """Pull agent_settings from Supabase synchronously. Returns {} on failure.

    Only fetches non-secret settings (provider/model selection, retry counts).
    API keys are NEVER stored in Supabase — they come from env only.
    """
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_ANON_KEY", "")
        if not url or not key:
            return {}
        client = create_client(url, key)
        resp = client.table("agent_settings").select("key,value").execute()
        return {row["key"]: row["value"] for row in (resp.data or [])}
    except Exception as e:
        logger.warning(f"[provider_engine] Supabase settings fetch failed: {e}")
        return {}


def run_in_thread(func, *args, **kwargs):
    import threading
    try:
        from blockbuster.blockbuster import blockbuster_skip
        skip_token = blockbuster_skip.set(True)
    except Exception:
        skip_token = None

    try:
        res, err = [], []
        def target():
            try:
                res.append(func(*args, **kwargs))
            except Exception as e:
                err.append(e)
        t = threading.Thread(target=target)
        t.start()
        t.join()
        if err:
            raise err[0]
        return res[0]
    finally:
        if skip_token is not None:
            try:
                blockbuster_skip.reset(skip_token)
            except Exception:
                pass


def get_settings() -> dict[str, str]:
    """Return provider settings. Checks local Redis cache first.
    If Redis is down or cache misses, falls back to Supabase and seeds Redis.
    """
    global _settings_cache, _cache_loaded_at
    
    r_client = get_redis_client()
    if r_client:
        try:
            cached = r_client.get("agent_settings:all")
            if cached:
                try:
                    data = json.loads(cached)
                    if isinstance(data, dict):
                        return data
                except Exception:
                    pass
            
            fresh = run_in_thread(_fetch_settings_from_supabase)
            if fresh:
                try:
                    r_client.setex("agent_settings:all", 3600, json.dumps(fresh))
                except Exception as e:
                    logger.warning(f"[provider_engine] Failed to write settings to Redis: {e}")
                return fresh
        except Exception as e:
            logger.warning(f"[provider_engine] Redis operation failed: {e}")

    now = time.time()
    if now - _cache_loaded_at >= 10 or not _settings_cache:
        fresh = run_in_thread(_fetch_settings_from_supabase)
        if fresh:
            _settings_cache = fresh
            _cache_loaded_at = now
            logger.debug("[provider_engine] Settings cache refreshed from Supabase (fallback).")
    return _settings_cache


def invalidate_settings_cache() -> None:
    """Force next call to get_settings() to re-fetch from Supabase and update Redis."""
    global _cache_loaded_at
    _cache_loaded_at = 0.0
    r_client = get_redis_client()
    if r_client:
        try:
            r_client.delete("agent_settings:all")
            logger.debug("[provider_engine] Redis settings cache invalidated.")
        except Exception as e:
            logger.warning(f"[provider_engine] Failed to delete settings cache in Redis: {e}")



def get_retry_delay() -> int:
    """Return the configured flat retry delay in seconds (default 15)."""
    settings = get_settings()
    try:
        return int(settings.get("retry_delay_seconds", "15"))
    except (ValueError, TypeError):
        return 15


# ── Agent defaults ─────────────────────────────────────────────────────────────

_AGENT_DEFAULTS: dict[str, dict[str, str]] = {
    "main_agent": {
        "provider": "openrouter",
        "model": "google/gemini-2.5-flash",
    },
    "analyzer": {
        "provider": "openrouter",
        "model": "google/gemini-2.5-flash",
    },
    "feeder": {
        "provider": "openrouter",
        "model": "google/gemini-2.5-flash",
    },
    # Subagents: default to same model as main_agent — configurable in UI
    "research_subagent": {
        "provider": "openrouter",
        "model": "google/gemini-2.5-flash",
    },
    "content_subagent": {
        "provider": "openrouter",
        "model": "google/gemini-2.5-flash",
    },
    # Vector indexing: default to OpenRouter/Gemini 2.5 Flash
    "vector_indexing": {
        "provider": "openrouter",
        "model": "google/gemini-2.5-flash",
    },
    # Mem0 extraction settings
    "mem0_extraction": {
        "provider": "openrouter",
        "model": "google/gemini-2.5-flash",
    },
}


# ── Per-Agent LLM Config ───────────────────────────────────────────────────────

def get_llm_config(agent: str) -> tuple[str, str, str]:
    """Return (base_url, api_key, model) for the given agent.

    Resolution order:
      1. Provider name → from Supabase agent_settings (e.g. "main_agent_provider")
      2. Model name    → from Supabase agent_settings (e.g. "main_agent_model")
      3. base_url      → from PROVIDER_REGISTRY (via env var for dynamic providers)
      4. api_key       → ALWAYS from environment variables (never Supabase)

    Falls back to hardcoded _AGENT_DEFAULTS if Supabase has nothing configured.

    Args:
        agent: One of "main_agent", "analyzer", "feeder",
               "research_subagent", "content_subagent"

    Returns:
        (base_url, api_key, model) ready to pass to ChatOpenAI / httpx
    """
    settings = get_settings()
    defaults = _AGENT_DEFAULTS.get(agent, _AGENT_DEFAULTS["main_agent"])

    provider = settings.get(f"{agent}_provider", defaults["provider"]).strip().lower()
    model = settings.get(f"{agent}_model", defaults["model"]).strip()

    # Fallback unregistered providers to openrouter direct
    actual_provider = provider
    if actual_provider not in get_all_provider_names():
        actual_provider = "openrouter"

    base_url = get_provider_base_url(actual_provider)
    cfg = get_provider_config(actual_provider)
    needs_v1 = cfg and "base_url_env" in cfg
    if needs_v1 and not base_url.endswith("/v1"):
        base_url = base_url + "/v1"

    if actual_provider == "openrouter":
        api_key = settings.get("openrouter_client_api_key", "").strip()
        if not api_key:
            api_key = get_provider_api_key("openrouter")
    else:
        api_key = get_provider_api_key(actual_provider)

    if not model:
        model = defaults["model"]

    if actual_provider == "openrouter" and model.startswith("openrouter/"):
        model = model[len("openrouter/"):]

    if not api_key:
        logger.warning(
            f"[provider_engine] ⚠️ No API key found for provider '{actual_provider}' "
            f"(env var: {get_provider_config(actual_provider).get('env_key', '?')}). "
            f"Set it in your .env file."
        )

    logger.debug(
        f"[provider_engine] LLM config for '{agent}': provider={provider}, "
        f"model={model}, base_url={base_url[:40]}..."
    )
    return base_url, api_key, model


# ── Error Classification ───────────────────────────────────────────────────────

class ErrorType(Enum):
    RETRYABLE = "retryable"  # 429, 500, 502, 503, timeout — worth retrying
    FATAL = "fatal"          # 401, 403, bad config — skip to fallback immediately


def classify_error(exception: Exception) -> ErrorType:
    """Determine if an error is worth retrying or should trigger immediate fallback."""
    msg = str(exception).lower()

    # Auth / config errors: no amount of retrying will help
    fatal_signals = ["401", "403", "invalid api key", "unauthorized", "forbidden",
                     "api key not set", "not installed"]
    if any(sig in msg for sig in fatal_signals):
        return ErrorType.FATAL

    # Everything else: network blip, rate limit, server error — retry
    return ErrorType.RETRYABLE


# ── Result Container ───────────────────────────────────────────────────────────

@dataclass
class ProviderResult:
    data: Any
    provider_used: str
    attempts_total: int
    fallback_used: bool
    failed: bool = False          # True when all providers exhausted


# ── Core Execution Engine ──────────────────────────────────────────────────────

async def execute_with_fallback(
    primary_fn: Callable,
    secondary_fn: Optional[Callable],
    primary_name: str,
    secondary_name: str,
    max_retries: int,
    timeout_seconds: int = 30,
    retry_delay_seconds: int | None = None,  # None → read from settings
    **kwargs,
) -> ProviderResult:
    """Run with round-based retries (Primary -> Secondary -> Wait 15s).

    IMPORTANT: This function NEVER raises. On total failure it returns a
    ProviderResult with failed=True and a descriptive error message in .data,
    so the calling tool can pass it to the agent gracefully.
    """
    if retry_delay_seconds is None:
        retry_delay_seconds = get_retry_delay()

    total_attempts = 0
    errors: list[str] = []

    for round_ in range(1, max_retries + 1):
        # ── 1. Primary Attempt ─────────────────────────────────────────────
        total_attempts += 1
        primary_fatal = False
        try:
            logger.info(f"[{primary_name}] Round {round_}/{max_retries} (timeout={timeout_seconds}s)")
            result = await asyncio.wait_for(primary_fn(**kwargs), timeout=timeout_seconds)
            logger.info(f"[{primary_name}] ✅ Success on round {round_}")
            return ProviderResult(
                data=result,
                provider_used=primary_name,
                attempts_total=total_attempts,
                fallback_used=False,
                failed=False,
            )
        except asyncio.TimeoutError:
            msg = f"Round {round_} timed out after {timeout_seconds}s"
            logger.warning(f"[{primary_name}] ⏱ {msg}")
            errors.append(f"{primary_name}: {msg}")
        except Exception as e:
            error_type = classify_error(e)
            if error_type == ErrorType.FATAL:
                logger.error(f"[{primary_name}] ⛔ Fatal config error on round {round_}: {e}")
                errors.append(f"{primary_name} fatal: {e}")
                primary_fatal = True
            else:
                msg = f"Round {round_} failed: {e}"
                logger.warning(f"[{primary_name}] ⚠️ {msg}")
                errors.append(f"{primary_name}: {msg}")

        # ── 2. Secondary Attempt ───────────────────────────────────────────
        secondary_fatal = False
        if secondary_fn is not None:
            total_attempts += 1
            try:
                logger.info(f"[{secondary_name}] Fallback round {round_}/{max_retries} (timeout={timeout_seconds}s)")
                result = await asyncio.wait_for(secondary_fn(**kwargs), timeout=timeout_seconds)
                logger.info(f"[{secondary_name}] ✅ Fallback success on round {round_}")
                return ProviderResult(
                    data=result,
                    provider_used=secondary_name,
                    attempts_total=total_attempts,
                    fallback_used=True,
                    failed=False,
                )
            except asyncio.TimeoutError:
                msg = f"Fallback round {round_} timed out after {timeout_seconds}s"
                logger.warning(f"[{secondary_name}] ⏱ {msg}")
                errors.append(f"{secondary_name}: {msg}")
            except Exception as e:
                error_type = classify_error(e)
                if error_type == ErrorType.FATAL:
                    logger.error(f"[{secondary_name}] ⛔ Fatal config error on round {round_}: {e}")
                    errors.append(f"{secondary_name} fatal: {e}")
                    secondary_fatal = True
                else:
                    msg = f"Fallback round {round_} failed: {e}"
                    logger.warning(f"[{secondary_name}] ⚠️ {msg}")
                    errors.append(f"{secondary_name}: {msg}")

            if primary_fatal and secondary_fatal:
                logger.error("[provider_engine] Both primary and secondary returned FATAL errors. Aborting early.")
                break
        else:
            if primary_fatal:
                logger.error("[provider_engine] Primary returned FATAL error. No fallback configured. Aborting early.")
                break

        # ── 3. Delay Before Next Round ─────────────────────────────────────
        if round_ < max_retries:
            logger.info(f"Both providers failed this round. Waiting {retry_delay_seconds}s before round {round_ + 1}...")
            await asyncio.sleep(retry_delay_seconds)

    # ── All rounds exhausted — return graceful error (never raise) ─────────
    summary = "; ".join(errors[-4:])  # last 4 errors for brevity
    error_msg = (
        f"⚠️ All API attempts failed after {max_retries} full rounds. "
        f"Last errors: {summary}. "
        "Please continue with the information you have already gathered or mark it Not Found. "
        "Skip this tool call and move to the next step."
    )
    logger.error(f"[provider_engine] {error_msg}")
    return ProviderResult(
        data=error_msg,
        provider_used=f"{primary_name}+{secondary_name}",
        attempts_total=total_attempts,
        fallback_used=True if secondary_fn else False,
        failed=True,
    )


# ── Numbered Provider Pipeline ──────────────────────────────────────────────

_providers_cache: dict[str, list[dict]] = {}
_providers_cache_loaded_at: float = 0.0

def _fetch_ordered_providers_from_supabase() -> list[dict]:
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_ANON_KEY", "")
        if url and key:
            client = create_client(url, key)
            resp = client.table("tool_provider_configs").select("*").execute()
            return resp.data or []
    except Exception as e:
        logger.warning(f"[provider_engine] Supabase tool provider configs fetch failed: {e}")
    return []

def get_ordered_providers(category: str) -> list[dict]:
    """Fetch enabled providers for a tool category, sorted by priority_order."""
    global _providers_cache, _providers_cache_loaded_at
    now = time.time()
    if now - _providers_cache_loaded_at >= _CACHE_TTL_SECONDS or not _providers_cache:
        data = run_in_thread(_fetch_ordered_providers_from_supabase)
        if data:
            grouped = {}
            for row in data:
                cat = row.get("tool_category")
                if cat not in grouped:
                    grouped[cat] = []
                grouped[cat].append(row)
            for cat in grouped:
                grouped[cat].sort(key=lambda x: x.get("priority_order", 999))
            _providers_cache = grouped
            _providers_cache_loaded_at = now
            logger.debug("[provider_engine] Tool provider configs cache refreshed.")

    rows = _providers_cache.get(category, [])
    return [row for row in rows if row.get("enabled", True)]


def _fetch_active_mcp_connections() -> list[dict]:
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_ANON_KEY", "")
        if url and key:
            client = create_client(url, key)
            resp = client.table("mcp_connections").select("*").eq("status", "active").execute()
            return resp.data or []
    except Exception:
        pass
    return []

async def load_mcp_tool_by_key(tool_key: str) -> list[BaseTool]:
    """Find and load a specific MCP tool by its key from active connections.

    Strategy:
    1. Check the DB cache (available_tools column) for each active connection.
    2. If not found in cache, fall back to live discovery: probe every active
       manual HTTP connection directly, find the tool, then backfill the DB cache.
    This makes the system self-healing — tools work even if available_tools is empty.
    """
    # Intercept internal virtual Mem0 MCP tools
    if tool_key in [
        "add_memory", "search_memories", "get_memories", "get_memory",
        "update_memory", "delete_memory", "delete_all_memories",
        "delete_entities", "list_entities", "list_events", "get_event_status"
    ]:
        from research_agent.tools.mem0_tools import get_memory_tool_by_name
        tool_obj = get_memory_tool_by_name(tool_key)
        if tool_obj:
            return [tool_obj]

    connections = run_in_thread(_fetch_active_mcp_connections)

    # ── Stage 1: DB-cache lookup (fast path) ──────────────────────────────────
    for conn in connections:
        available = conn.get("available_tools") or []
        for t in available:
            match = False
            if isinstance(t, dict) and t.get("tool_key") == tool_key:
                match = True
            elif isinstance(t, str) and t == tool_key:
                match = True

            if match:
                if conn.get("connection_type") == "manual":
                    from research_agent.tools.mcp_loader import load_manual_mcp_tool
                    return await load_manual_mcp_tool(conn.get("mcp_url"), tool_key)
                else:
                    composio_api_key = os.environ.get("COMPOSIO_API_KEY", "")
                    if composio_api_key:
                        try:
                            from composio import Composio
                            from composio_langchain import LangchainProvider
                            composio = Composio(api_key=composio_api_key, provider=LangchainProvider())
                            return await asyncio.to_thread(composio.tools.get, user_id="default", tools=[tool_key])
                        except Exception as e:
                            logger.error(f"Failed to load Composio tool '{tool_key}': {e}", exc_info=True)
                            try:
                                with open("agent_load.log", "a", encoding="utf-8") as f:
                                    import traceback
                                    f.write(f"\n--- Composio Load Error for '{tool_key}' ---\n{traceback.format_exc()}\n")
                            except Exception:
                                pass
                    else:
                        try:
                            with open("agent_load.log", "a", encoding="utf-8") as f:
                                f.write(
                                    f"\n[load_mcp_tool_by_key] WARNING: COMPOSIO_API_KEY missing! "
                                    f"Env keys: {[k for k in os.environ.keys() if 'COMPOSIO' in k]}\n"
                                )
                        except Exception:
                            pass

    # ── Stage 2: Live-discovery fallback (self-healing) ───────────────────────
    # No cached entry matched. Probe every active manual HTTP connection live.
    logger.info(
        f"[load_mcp_tool_by_key] '{tool_key}' not in DB cache. "
        "Attempting live discovery across manual HTTP connections..."
    )
    for conn in connections:
        if conn.get("connection_type") != "manual":
            continue
        mcp_url_raw = conn.get("mcp_url", "")

        # Resolve the URL to probe
        url_to_probe = ""
        custom_headers: dict = {}
        if mcp_url_raw.strip().startswith("{"):
            try:
                import json as _json
                parsed = _json.loads(mcp_url_raw)
                url_to_probe = parsed.get("url", "")
                custom_headers = parsed.get("headers") or {}
            except Exception:
                pass
        elif mcp_url_raw.startswith("http://") or mcp_url_raw.startswith("https://"):
            url_to_probe = mcp_url_raw

        if not (url_to_probe.startswith("http://") or url_to_probe.startswith("https://")):
            continue  # skip stdio / unknown connections

        try:
            from research_agent.tools.mcp_loader import load_manual_mcp_tool
            result = await load_manual_mcp_tool(mcp_url_raw, tool_key)
            if result:
                logger.info(
                    f"[load_mcp_tool_by_key] Live discovery SUCCESS: found '{tool_key}' "
                    f"on '{conn.get('label', conn.get('id', '?'))}'. Backfilling DB cache..."
                )
                # Backfill available_tools in DB so the next call is instant
                try:
                    import httpx
                    import json as _json
                    base_url = url_to_probe.split("#")[0]
                    post_headers = {
                        "Content-Type": "application/json",
                        "Accept": "application/json, text/event-stream",
                        **custom_headers,
                    }
                    async with httpx.AsyncClient(timeout=8.0) as hx:
                        probe = await hx.post(
                            base_url,
                            headers=post_headers,
                            json={"jsonrpc": "2.0", "method": "tools/list", "params": {}, "id": 1},
                        )
                        if probe.status_code == 200:
                            raw_tools = []
                            text = probe.text
                            # Try plain JSON first
                            try:
                                probe_data = _json.loads(text)
                                raw_tools = probe_data.get("result", {}).get("tools", [])
                            except Exception:
                                pass
                            # Fall back to SSE-encoded JSON
                            if not raw_tools:
                                for line in text.split("\n"):
                                    if line.startswith("data:"):
                                        payload = line[5:].strip()
                                        if not payload:
                                            continue
                                        try:
                                            probe_data = _json.loads(payload)
                                            raw_tools = probe_data.get("result", {}).get("tools", [])
                                            if raw_tools:
                                                break
                                        except Exception:
                                            pass
                            backfill = [
                                {
                                    "tool_key": t.get("name"),
                                    "tool_name": t.get("title") or t.get("name"),
                                    "description": t.get("description", ""),
                                }
                                for t in raw_tools
                                if t.get("name")
                            ]
                            if backfill:
                                sb_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
                                sb_key = os.environ.get("SUPABASE_ANON_KEY", "")
                                if sb_url and sb_key:
                                    from supabase import create_client as _sc
                                    db = _sc(sb_url, sb_key)
                                    db.table("mcp_connections").update(
                                        {"available_tools": backfill}
                                    ).eq("id", conn.get("id")).execute()
                                    logger.info(
                                        f"[load_mcp_tool_by_key] Backfilled {len(backfill)} tools "
                                        f"for '{conn.get('label', '?')}'"
                                    )
                except Exception as backfill_err:
                    logger.warning(
                        f"[load_mcp_tool_by_key] Backfill failed (non-critical): {backfill_err}"
                    )
                return result
        except Exception as live_err:
            logger.debug(
                f"[load_mcp_tool_by_key] Live probe failed for "
                f"'{conn.get('label', '?')}': {live_err}"
            )

    return []


async def execute_unified_pipeline(
    category: str,
    built_in_map: dict,
    default_provider_keys: list[str],
    max_retries: int,
    timeout_seconds: int = 30,
    **kwargs,
) -> str:
    """Execute the prioritized list of providers for a tool category.

    Tries each enabled provider in order of priority_order.
    Falls back to the next provider on failure.
    Supports both built-in adapters and MCP tools.
    """
    providers = get_ordered_providers(category)
    if not providers:
        providers = [
            {"provider_key": k, "fallback_on_error": True, "enabled": True}
            for k in default_provider_keys
        ]

    errors = []
    for idx, prov in enumerate(providers):
        key = prov.get("provider_key")
        fallback_on_error = prov.get("fallback_on_error", True)

        logger.info(f"[pipeline] Trying provider {idx+1}/{len(providers)}: {key} (fallback={fallback_on_error})")

        fn = None
        is_mcp = False

        if key in built_in_map:
            fn = built_in_map[key]
        else:
            is_mcp = True

        try:
            if not is_mcp:
                result = await asyncio.wait_for(fn(**kwargs), timeout=timeout_seconds)
                logger.info(f"[pipeline] ✅ Provider '{key}' succeeded!")
                prefix = ""
                if idx > 0:
                    prefix = f"⚡ [Fallback: {key} used after previous providers failed]\n\n"
                return f"{prefix}{result}"
            else:
                tools = await load_mcp_tool_by_key(key)
                if not tools:
                    raise RuntimeError(f"MCP tool '{key}' not found or connection offline")

                tool = tools[0]
                tool_args = {}
                if "query" in kwargs and kwargs["query"]:
                    tool_args["query"] = kwargs["query"]
                if "urls" in kwargs and kwargs["urls"]:
                    tool_args["urls"] = kwargs["urls"]
                    if "url" not in tool_args:
                        tool_args["url"] = kwargs["urls"][0]

                result = await asyncio.wait_for(tool.ainvoke(tool_args), timeout=timeout_seconds)
                res_str = str(result)
                logger.info(f"[pipeline] ✅ MCP Provider '{key}' succeeded!")
                prefix = ""
                if idx > 0:
                    prefix = f"⚡ [Fallback MCP: {key} used after previous providers failed]\n\n"
                return f"{prefix}{res_str}"

        except Exception as e:
            msg = f"Provider '{key}' failed: {e}"
            logger.warning(f"[pipeline] ⚠️ {msg}")
            errors.append(msg)
            if not fallback_on_error:
                logger.error(f"[pipeline] Fallback disabled for '{key}'. Aborting.")
                break

    summary = "; ".join(errors)
    return (
        f"⚠️ All tool providers failed. "
        f"Errors: {summary}. "
        "Please proceed with the information you have or skip this step."
    )

