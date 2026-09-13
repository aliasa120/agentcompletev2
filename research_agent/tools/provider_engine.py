# -*- coding: utf-8 -*-
"""Core provider engine -- retry, fallback, timeout, and error classification.

All unified tools (unified_search, unified_extract, unified_image) use this module
to execute provider functions.

Retry strategy (Universal provider ladder — applies to ALL unified tool categories):
  For each provider (chosen by priority order, schema match, or explicit ``provider`` argument):
    1. Execute the provider.
    2. On retryable failure, retry the SAME provider after 3s, 8s, 16s
       (configurable via the ``fallback_retry_delays`` agent_settings key).
    3. FATAL errors (401/403/bad config) skip the ladder immediately.
    4. When the ladder is exhausted, the pipeline does NOT auto-execute the next
       provider. Instead it returns a FALLBACK HANDOFF message to the agent with
       the next provider's key and schema, so the agent re-invokes the SAME tool
       with ``provider='<next_key>'``. Recently-failed providers (5-minute TTL)
       are skipped during implicit provider selection to avoid retry loops.
    5. When every provider has failed, a graceful "all providers failed" message
       is returned (the pipeline never raises — prevents pipeline crashes).

Default retry ladders:
  Search / Extract / Image / Custom : initial attempt + retries at 3s, 8s, 16s

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
  To add a new provider  add it to provider_registry.py + add env var  done.
"""

import asyncio
import inspect
import logging
import os
import time
from dataclasses import dataclass
from enum import Enum
from contextvars import ContextVar
from typing import Optional, Any, Callable
from langchain_core.tools import BaseTool
active_user_id: ContextVar[Optional[str]] = ContextVar("active_user_id", default=None)
active_workflow_id: ContextVar[Optional[str]] = ContextVar("active_workflow_id", default=None)
active_thread_id: ContextVar[Optional[str]] = ContextVar("active_thread_id", default=None)

_LAST_ACTIVE_USER_ID: Optional[str] = None
_LAST_ACTIVE_WORKFLOW_ID: Optional[str] = None
_LAST_ACTIVE_THREAD_ID: Optional[str] = None

def set_active_user_and_workflow(user_id: Optional[str] = None, workflow_id: Optional[str] = None, thread_id: Optional[str] = None):
    global _LAST_ACTIVE_USER_ID, _LAST_ACTIVE_WORKFLOW_ID, _LAST_ACTIVE_THREAD_ID
    if user_id:
        active_user_id.set(user_id)
        _LAST_ACTIVE_USER_ID = str(user_id).strip()
    if workflow_id:
        active_workflow_id.set(workflow_id)
        _LAST_ACTIVE_WORKFLOW_ID = str(workflow_id).strip()
    if thread_id:
        active_thread_id.set(thread_id)
        _LAST_ACTIVE_THREAD_ID = str(thread_id).strip()

def get_active_user_id() -> Optional[str]:
    return active_user_id.get() or _LAST_ACTIVE_USER_ID

def get_active_workflow_id() -> Optional[str]:
    return active_workflow_id.get() or _LAST_ACTIVE_WORKFLOW_ID

def get_active_thread_id() -> Optional[str]:
    return active_thread_id.get() or _LAST_ACTIVE_THREAD_ID

from .provider_registry import (
    get_provider_api_key,
    get_provider_base_url,
    get_provider_config,
    get_all_provider_names,
)

logger = logging.getLogger("provider_engine")

#  Settings Cache 

import redis
import json

_CACHE_TTL_SECONDS = 60  # refresh from Supabase every 60 s
_settings_cache: dict[str, dict[str, str]] = {}
_cache_loaded_at: dict[str, float] = {}
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


def _fetch_settings_from_supabase(user_id: Optional[str] = None) -> dict[str, str]:
    """Pull agent_settings from Supabase synchronously including client API keys.
    Also syncs provider/model from agent_configs table (authoritative for agent card UI).
    """
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
        if not url or not key:
            return {}
        client = create_client(url, key)
        res = {}
        uid = user_id or active_user_id.get() or _LAST_ACTIVE_USER_ID

        if uid:
            try:
                resp = client.table("agent_settings").select("key, value").eq("user_id", str(uid)).execute()
                if resp.data:
                    res = {row["key"]: row["value"] for row in resp.data}
            except Exception:
                pass

        # Fallback: if user_id is missing or user has 0 rows, load settings from the user with most rows
        if not res:
            try:
                resp_latest = (
                    client.table("agent_settings")
                    .select("user_id")
                    .not_.is_("user_id", "null")
                    .order("user_id")          # stable ordering
                    .limit(100)
                    .execute()
                )
                if resp_latest.data:
                    # Pick the user_id that appears most frequently (most settings = main user)
                    from collections import Counter
                    uid_counts = Counter(r.get("user_id") for r in resp_latest.data if r.get("user_id"))
                    latest_uid = uid_counts.most_common(1)[0][0] if uid_counts else None
                    if latest_uid:
                        uid = latest_uid  # remember for agent_configs query below
                        resp2 = client.table("agent_settings").select("key, value").eq("user_id", str(latest_uid)).execute()
                        if resp2.data:
                            res = {row["key"]: row["value"] for row in resp2.data}
                            logger.debug(f"[provider_engine] Settings fallback: loaded {len(res)} rows for most-active user {latest_uid}")
            except Exception as err:
                logger.warning(f"[provider_engine] Settings fallback error: {err}")

        #  Sync agent_configs  agent_settings keys 
        # The UI saves provider/model to agent_configs table.
        # The backend reads {agent}_provider / {agent}_model from agent_settings.
        # Bridge the gap by reading agent_configs and injecting into the settings dict.
        if uid:
            try:
                ac_resp = (
                    client.table("agent_configs")
                    .select("model_key, provider, model")
                    .eq("user_id", str(uid))
                    .eq("enabled", True)
                    .execute()
                )
                if ac_resp.data:
                    for row in ac_resp.data:
                        model_key = row.get("model_key", "")   # e.g. "main_agent"
                        provider  = (row.get("provider") or "").strip()
                        model     = (row.get("model") or "").strip()
                        if model_key and provider and model:
                            # agent_configs is the authoritative source  always overwrite
                            res[f"{model_key}_provider"] = provider
                            res[f"{model_key}_model"]    = model
                    logger.debug(f"[provider_engine] agent_configs synced: {[r['model_key'] for r in ac_resp.data if r.get('model_key')]}")
            except Exception as ac_err:
                logger.warning(f"[provider_engine] agent_configs sync failed: {ac_err}")

        return res
    except Exception as e:
        logger.warning(f"[provider_engine] Supabase settings fetch failed: {e}")
        return {}



def save_setting_to_supabase(key: str, value: str, user_id: Optional[str] = None) -> bool:
    """Save/upsert a key-value setting into Supabase agent_settings table."""
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key_str = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
        uid = user_id or active_user_id.get()
        if not url or not key_str or not uid:
            return False
        import uuid
        try:
            uuid.UUID(str(uid))
        except ValueError:
            return False

        def _do_upsert():
            client = create_client(url, key_str)
            client.table("agent_settings").upsert(
                {"user_id": str(uid), "key": key, "value": value},
                on_conflict="user_id,key"
            ).execute()

        run_in_thread(_do_upsert)
        invalidate_settings_cache(uid)
        return True
    except Exception as e:
        logger.warning(f"[provider_engine] Failed to save setting '{key}' to Supabase: {e}")
        return False


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
                from blockbuster.blockbuster import blockbuster_skip
                blockbuster_skip.reset(skip_token)
            except Exception:
                pass


def get_settings(user_id: Optional[str] = None) -> dict[str, str]:
    """Return provider settings. Checks local Redis cache first.
    If Redis is down or cache misses, falls back to Supabase and seeds Redis.
    """
    global _settings_cache, _cache_loaded_at
    
    uid = user_id or active_user_id.get()
    uid_str = str(uid) if uid else "all"
    redis_key = f"agent_settings:{uid_str}"
    
    r_client = get_redis_client()
    if r_client:
        try:
            cached = r_client.get(redis_key)
            if cached:
                try:
                    data = json.loads(cached)
                    # Accept cache if it is a non-empty dict (not gated on any single provider key)
                    if isinstance(data, dict) and data:
                        return data
                except Exception:
                    pass

            fresh = run_in_thread(_fetch_settings_from_supabase, uid)
            if fresh:
                try:
                    r_client.setex(redis_key, 3600, json.dumps(fresh))
                except Exception as e:
                    logger.warning(f"[provider_engine] Failed to write settings to Redis: {e}")
                return fresh
        except Exception as e:
            logger.warning(f"[provider_engine] Redis operation failed: {e}")

 
    now = time.time()
    loaded_at = _cache_loaded_at.get(uid_str, 0.0)
    if now - loaded_at >= 10 or uid_str not in _settings_cache:
        fresh = run_in_thread(_fetch_settings_from_supabase, uid)
        if fresh:
            _settings_cache[uid_str] = fresh
            _cache_loaded_at[uid_str] = now
            logger.debug(f"[provider_engine] Settings cache refreshed from Supabase (fallback) for user {uid_str}.")
    return _settings_cache.get(uid_str, {})


def invalidate_settings_cache(user_id: Optional[str] = None) -> None:
    """Force next call to get_settings() to re-fetch from Supabase and update Redis."""
    global _cache_loaded_at
    uid_str = str(user_id) if user_id else "all"
    _cache_loaded_at[uid_str] = 0.0
    _cache_loaded_at["all"] = 0.0
    r_client = get_redis_client()
    if r_client:
        try:
            r_client.delete(f"agent_settings:{uid_str}")
            r_client.delete("agent_settings:all")
            logger.debug(f"[provider_engine] Redis settings cache invalidated for user {uid_str} and all.")
        except Exception as e:
            logger.warning(f"[provider_engine] Failed to delete settings cache in Redis for {uid_str}: {e}")


def get_user_api_key(
    settings_key: str,
    env_fallback: str = "",
    user_id: Optional[str] = None,
) -> str:
    """Fetch an API key from user's agent_settings, falling back to process env vars if empty.

    This enables per-user key injection, with fallback to environment variables
    for local deployment compatibility.

    Args:
      settings_key:  The key name in agent_settings table (e.g. 'tavily_api_key').
      env_fallback:  The environment variable to fall back to (e.g. 'TAVILY_API_KEY').
      user_id:       Optional explicit user ID; uses active_user_id ContextVar if None.

    Returns:
      The resolved API key string.
    """
    uid = user_id or active_user_id.get()
    settings = get_settings(uid)
    val = settings.get(settings_key, "").strip()
    if not val and env_fallback:
        val = os.environ.get(env_fallback, "").strip()
    return val



def get_retry_delay() -> int:
    """Return the configured flat retry delay in seconds (default 15)."""
    settings = get_settings()
    try:
        return int(settings.get("retry_delay_seconds", "15"))
    except (ValueError, TypeError):
        return 15


#  Universal Fallback Ladder (same-provider retries) 

_DEFAULT_RETRY_LADDER = [3, 8, 16]

def get_retry_ladder() -> list[int]:
    """Return the same-provider retry wait seconds (default: 3s, 8s, 16s).

    Overridable via the ``fallback_retry_delays`` agent_settings key,
    e.g. "3,8,16" (default), "2,5", or "5" for a single retry.
    """
    try:
        settings = get_settings() or {}
    except Exception:
        settings = {}
    raw = str(settings.get("fallback_retry_delays", "3,8,16") or "3,8,16")
    delays: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            delays.append(max(0, int(float(part))))
        except (ValueError, TypeError):
            continue
    return delays if delays else list(_DEFAULT_RETRY_LADDER)


async def _pipeline_sleep(seconds: float) -> None:
    """Indirection for retry sleeps so tests can patch it without touching asyncio."""
    if seconds and seconds > 0:
        await asyncio.sleep(seconds)


#  Provider failure cache (short-lived, per process) 

_PROVIDER_FAILURE_TTL_SECONDS = 300  # recently-failed providers get deprioritized 5 min
_provider_failure_cache: dict[tuple[str, str], float] = {}

def _mark_provider_failed(category: str, provider_key: str) -> None:
    _provider_failure_cache[(str(category), str(provider_key))] = time.time()

def _clear_provider_failure(category: str, provider_key: str) -> None:
    _provider_failure_cache.pop((str(category), str(provider_key)), None)

def _provider_recently_failed(category: str, provider_key: str) -> bool:
    ts = _provider_failure_cache.get((str(category), str(provider_key)))
    return bool(ts) and (time.time() - ts) < _PROVIDER_FAILURE_TTL_SECONDS

def clear_provider_failures(category: Optional[str] = None) -> None:
    """Reset the recently-failed provider cache (tests / manual reset)."""
    if category is None:
        _provider_failure_cache.clear()
    else:
        for key in [k for k in _provider_failure_cache if k[0] == str(category)]:
            _provider_failure_cache.pop(key, None)


#  Agent defaults 

_AGENT_DEFAULTS = {
    "main_agent":        {"provider": "openrouter", "model": "google/gemini-2.5-flash"},
    "analyzer":          {"provider": "openrouter", "model": "google/gemini-2.5-flash"},
    "feeder":            {"provider": "openrouter", "model": "google/gemini-2.5-flash"},
    "feeder_verifier":   {"provider": "openrouter", "model": "google/gemini-2.5-flash"},
    "research_subagent": {"provider": "openrouter", "model": "google/gemini-2.5-flash"},
    "content_subagent":  {"provider": "openrouter", "model": "google/gemini-2.5-flash"},
}


def resolve_provider_credentials(
    provider: str,
    model: str,
    settings: Optional[dict[str, str]] = None,
    user_id: Optional[str] = None
) -> tuple[str, str, str]:
    """Resolve (base_url, api_key, model) for ANY provider (built-in or custom)."""
    if settings is None:
        settings = get_settings(user_id)

    provider_clean = (provider or "openrouter").strip().lower()
    model_clean = (model or "google/gemini-2.5-flash").strip()

    # 1. Check custom_ai_providers (e.g. meta, custom hermes, etc.)
    if provider_clean not in get_all_provider_names():
        custom_raw = settings.get("custom_ai_providers")
        if custom_raw:
            try:
                custom_list = json.loads(custom_raw) if isinstance(custom_raw, str) else custom_raw
                for cp in custom_list:
                    if cp.get("id") == provider_clean or cp.get("label", "").lower() == provider_clean:
                        base_url = cp.get("base_url", "").rstrip("/")
                        api_key = cp.get("api_key", "").strip()
                        return base_url, api_key, model_clean
            except Exception as cp_err:
                logger.warning(f"[provider_engine] Failed to parse custom_ai_providers: {cp_err}")
        provider_clean = "openrouter"

    # 2. Built-in provider resolution
    base_url = get_provider_base_url(provider_clean)
    cfg = get_provider_config(provider_clean)
    needs_v1 = cfg and "base_url_env" in cfg
    if needs_v1 and not base_url.endswith("/v1"):
        base_url = base_url + "/v1"

    agent_settings_key = cfg.get("agent_settings_key", "") if cfg else ""
    env_key = cfg.get("env_key", "") if cfg else ""
    if agent_settings_key:
        api_key = get_user_api_key(agent_settings_key, env_fallback=env_key, user_id=user_id)
    elif env_key:
        api_key = os.environ.get(env_key, "").strip()
    else:
        api_key = ""

    if provider_clean == "openrouter" and model_clean.startswith("openrouter/"):
        model_clean = model_clean[len("openrouter/"):]

    return base_url, api_key, model_clean


def get_llm_config(agent: str, user_id: Optional[str] = None) -> tuple[str, str, str]:
    """Return (base_url, api_key, model) for the given agent.

    Resolution order:
      1. Provider name -> from Supabase agent_settings / agent_configs
      2. Model name    -> from Supabase agent_settings / agent_configs
      3. base_url & api_key resolved via resolve_provider_credentials
    """
    settings = get_settings(user_id)
    defaults = _AGENT_DEFAULTS.get(agent, _AGENT_DEFAULTS["main_agent"])

    provider = (settings.get(f"{agent}_provider") or defaults["provider"]).strip().lower()
    model = (settings.get(f"{agent}_model") or defaults["model"]).strip()

    base_url, api_key, model = resolve_provider_credentials(provider, model, settings=settings, user_id=user_id)

    if not api_key:
        logger.warning(
            f"[provider_engine]  No API key found in user settings for provider '{provider}'."
        )

    logger.debug(
        f"[provider_engine] LLM config for '{agent}': provider={provider}, "
        f"model={model}, base_url={base_url[:40]}..."
    )
    return base_url, api_key, model


#  Error Classification 

class ErrorType(Enum):
    RETRYABLE = "retryable"  # 429, 500, 502, 503, timeout  worth retrying
    FATAL = "fatal"          # 401, 403, bad config  skip to fallback immediately


def classify_error(exception: Exception) -> ErrorType:
    """Determine if an error is worth retrying or should trigger immediate fallback."""
    msg = str(exception).lower()

    # Auth / config errors: no amount of retrying will help
    fatal_signals = ["401", "403", "invalid api key", "unauthorized", "forbidden",
                     "api key not set", "not installed"]
    if any(sig in msg for sig in fatal_signals):
        return ErrorType.FATAL

    # Everything else: network blip, rate limit, server error  retry
    return ErrorType.RETRYABLE


#  Result Container 

@dataclass
class ProviderResult:
    data: Any
    provider_used: str
    attempts_total: int
    fallback_used: bool
    failed: bool = False          # True when all providers exhausted


@dataclass
class UnifiedOutcome:
    """Structured result of the universal unified-tool fallback pipeline."""
    ok: bool
    result: Any = None                  # raw provider result on success
    provider_used: str = ""             # provider key that ran (or failed)
    attempts_total: int = 0
    handoff: bool = False               # True -> message offers the next provider
    next_provider: str = ""             # provider key offered for the next call
    message: str = ""                   # tool-result message when not ok


#  Core Execution Engine 

async def execute_with_fallback(
    primary_fn: Callable,
    secondary_fn: Optional[Callable],
    primary_name: str,
    secondary_name: str,
    max_retries: int,
    timeout_seconds: int = 30,
    retry_delay_seconds: Optional[int] = None,  # None -> read from settings
    **kwargs,
) -> ProviderResult:
    """Run with round-based retries (Primary -> Secondary -> Wait).

    IMPORTANT: This function NEVER raises. On total failure it returns a
    ProviderResult with failed=True and a descriptive error message in .data,
    so the calling tool can pass it to the agent gracefully.
    """
    if retry_delay_seconds is None:
        retry_delay_seconds = get_retry_delay()

    total_attempts = 0
    errors: list[str] = []

    for round_ in range(1, max_retries + 1):
        #  1. Primary Attempt 
        total_attempts += 1
        primary_fatal = False
        try:
            logger.info(f"[{primary_name}] Round {round_}/{max_retries} (timeout={timeout_seconds}s)")
            result = await asyncio.wait_for(primary_fn(**kwargs), timeout=timeout_seconds)
            logger.info(f"[{primary_name}]  Success on round {round_}")
            return ProviderResult(
                data=result,
                provider_used=primary_name,
                attempts_total=total_attempts,
                fallback_used=False,
                failed=False,
            )
        except asyncio.TimeoutError:
            msg = f"Round {round_} timed out after {timeout_seconds}s"
            logger.warning(f"[{primary_name}]  {msg}")
            errors.append(f"{primary_name}: {msg}")
        except Exception as e:
            error_type = classify_error(e)
            if error_type == ErrorType.FATAL:
                logger.error(f"[{primary_name}]  Fatal config error on round {round_}: {e}")
                errors.append(f"{primary_name} fatal: {e}")
                primary_fatal = True
            else:
                msg = f"Round {round_} failed: {e}"
                logger.warning(f"[{primary_name}]  {msg}")
                errors.append(f"{primary_name}: {msg}")

        #  2. Secondary Attempt 
        secondary_fatal = False
        if secondary_fn is not None:
            total_attempts += 1
            try:
                logger.info(f"[{secondary_name}] Fallback round {round_}/{max_retries} (timeout={timeout_seconds}s)")
                result = await asyncio.wait_for(secondary_fn(**kwargs), timeout=timeout_seconds)
                logger.info(f"[{secondary_name}]  Fallback success on round {round_}")
                return ProviderResult(
                    data=result,
                    provider_used=secondary_name,
                    attempts_total=total_attempts,
                    fallback_used=True,
                    failed=False,
                )
            except asyncio.TimeoutError:
                msg = f"Fallback round {round_} timed out after {timeout_seconds}s"
                logger.warning(f"[{secondary_name}]  {msg}")
                errors.append(f"{secondary_name}: {msg}")
            except Exception as e:
                error_type = classify_error(e)
                if error_type == ErrorType.FATAL:
                    logger.error(f"[{secondary_name}]  Fatal config error on round {round_}: {e}")
                    errors.append(f"{secondary_name} fatal: {e}")
                    secondary_fatal = True
                else:
                    msg = f"Fallback round {round_} failed: {e}"
                    logger.warning(f"[{secondary_name}]  {msg}")
                    errors.append(f"{secondary_name}: {msg}")

            if primary_fatal and secondary_fatal:
                logger.error("[provider_engine] Both primary and secondary returned FATAL errors. Aborting early.")
                break
        else:
            if primary_fatal:
                logger.error("[provider_engine] Primary returned FATAL error. No fallback configured. Aborting early.")
                break

        #  3. Delay Before Next Round 
        if round_ < max_retries:
            logger.info(f"Both providers failed this round. Waiting {retry_delay_seconds}s before round {round_ + 1}...")
            await asyncio.sleep(retry_delay_seconds)

    #  All rounds exhausted  return graceful error (never raise) 
    summary = "; ".join(errors[-4:])  # last 4 errors for brevity
    error_msg = (
        f" All API attempts failed after {max_retries} full rounds. "
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


#  Numbered Provider Pipeline 

_providers_cache: dict[str, list[dict]] = {}
_providers_cache_loaded_at: float = 0.0

def _fetch_ordered_providers_from_supabase() -> list[dict]:
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
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


def _get_user_composio_api_key(user_id: Optional[str] = None) -> Optional[str]:
    """Fetch the Composio API key for the current user.

    Uses the shared get_settings() path which:
      - Resolves user_id from the active_user_id ContextVar if not explicitly provided
      - Checks Redis cache first (fast path)
      - Falls back to Supabase only on cache miss
    """
    try:
        # get_settings() already reads active_user_id ContextVar internally
        settings = get_settings(user_id)
        api_key = settings.get("composio_api_key")
        if api_key:
            return api_key
    except Exception as e:
        logger.error(f"Error fetching user Composio API key: {e}")
    return None

def _fetch_active_mcp_connections(user_id: Optional[str] = None) -> list[dict]:
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
        if url and key:
            client = create_client(url, key)
            resp = client.rpc("get_backend_bootstrap_data").execute()
            bootstrap = resp.data or {}
            all_conns = bootstrap.get("mcp_connections") or []
            active_conns = [c for c in all_conns if c.get("status") == "active"]
            if user_id:
                active_conns = [c for c in active_conns if c.get("user_id") == user_id]
            return active_conns
    except Exception as e:
        logger.error(f"Error fetching active MCP connections: {e}")
    return []

async def load_mcp_tool_by_key(tool_key: str, user_id: Optional[str] = None) -> list[BaseTool]:
    """Find and load a specific MCP tool by its key from active connections.

    Strategy:
    1. Check the DB cache (available_tools column) for each active connection.
    2. If not found in cache, fall back to live discovery: probe every active
       manual HTTP connection directly, find the tool, then backfill the DB cache.
    This makes the system self-healing  tools work even if available_tools is empty.
    """
    # Intercept memory tools (add_memory, replace_memory, remove_memory, honcho_*, search_conversation_history)
    from research_agent.tools.dynamic_router import TOOL_OBJECTS
    if tool_key in TOOL_OBJECTS:
        return [TOOL_OBJECTS[tool_key]]

    connections = run_in_thread(lambda: _fetch_active_mcp_connections(user_id))

    # Resolve user_id from ContextVar if not explicitly provided
    if not user_id:
        user_id = active_user_id.get()

    #  Stage 1: DB-cache lookup (fast path) 
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
                    return await load_manual_mcp_tool(conn.get("mcp_url"), tool_key, metadata=t if isinstance(t, dict) else None)
                else:
                    # Resolve Composio API key: explicit user_id  ContextVar  env fallback
                    composio_api_key = _get_user_composio_api_key(user_id)
                    if not composio_api_key:
                        composio_api_key = os.environ.get("COMPOSIO_API_KEY", "")
                    if composio_api_key:
                        try:
                            try:
                                from blockbuster.blockbuster import blockbuster_skip
                                skip_token = blockbuster_skip.set(True)
                            except Exception:
                                skip_token = None

                            try:
                                from composio import Composio
                                from composio_langchain import LangchainProvider
                                composio = Composio(api_key=composio_api_key, provider=LangchainProvider())
                                composio_user_id = user_id or "default"
                                return await asyncio.to_thread(composio.tools.get, user_id=composio_user_id, tools=[tool_key])
                            finally:
                                if skip_token is not None:
                                    try:
                                        blockbuster_skip.reset(skip_token)
                                    except Exception:
                                        pass
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

    #  Stage 2: Live-discovery fallback (self-healing) 
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
                                sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
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


def _kwargs_match_schema(tool_obj: Any, input_kwargs: dict) -> bool:
    """Best-effort check that input kwargs satisfy a tool's required fields."""
    try:
        args = getattr(tool_obj, "args", {})
        if not args:
            return True
        schema = getattr(tool_obj, "args_schema", None)
        required_fields: list = []
        if schema and hasattr(schema, "schema"):
            required_fields = schema.schema().get("required", [])
        elif schema and hasattr(schema, "__fields__"):
            required_fields = [k for k, v in schema.__fields__.items() if getattr(v, "required", False)]
        for field in required_fields:
            if field not in input_kwargs and field != "config":
                return False
        return True
    except Exception:
        return True


def _normalize_provider_row(row: dict) -> dict:
    """Normalize a provider config row (unified_tool_configs JSON or DB row)."""
    key = row.get("provider_key") or row.get("provider") or row.get("tool_key") or row.get("key") or ""
    label = row.get("label") or row.get("provider_name") or row.get("name") or row.get("tool_name") or key
    return {
        "provider_key": str(key),
        "label": str(label),
        "priority_order": row.get("priority_order", 999),
        "enabled": row.get("enabled", True),
        "fallback_on_error": row.get("fallback_on_error", True),
    }


def _schema_from_signature(fn: Callable) -> str:
    """Build a compact JSON schema description from a callable's signature."""
    try:
        sig = inspect.signature(fn)
        fields: dict = {}
        for name, p in sig.parameters.items():
            if p.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
                continue
            if name == "config":
                continue
            ann = p.annotation
            if ann is inspect.Parameter.empty:
                ann = "string"
            elif isinstance(ann, type):
                ann = ann.__name__
            else:
                ann = str(ann)
            field: dict = {"type": ann}
            if p.default is not inspect.Parameter.empty and p.default is not None:
                field["default"] = str(p.default)
            fields[name] = field
        return json.dumps(fields, ensure_ascii=False, default=str)
    except Exception:
        return '{"query": "string"}'


def _describe_provider_schema(key: str, tool_obj: Any, built_in_map: dict) -> str:
    """Best-effort schema description used in FALLBACK HANDOFF messages."""
    if tool_obj is not None:
        try:
            args = tool_obj.args
            if isinstance(args, dict) and args:
                return json.dumps(args, ensure_ascii=False, default=str)
        except Exception:
            pass
    fn = built_in_map.get(key)
    if fn is not None:
        return _schema_from_signature(fn)
    if key in ("linkup", "parallel", "tavily", "exa"):
        return '{"query": "string"}'
    if key in ("tavily_extract", "exa_extract", "linkup_extract"):
        return '{"urls": ["string"], "query": "string (optional)"}'
    return '{"query": "string"}'


async def _invoke_provider_once(
    fn: Any, mode: str, kwargs: dict, config: Any, timeout_seconds: int,
):
    """Execute ONE attempt against a provider. Raises on failure."""
    if mode == "preset":
        return await asyncio.wait_for(fn(**kwargs), timeout=timeout_seconds)
    if mode == "builtin":
        tool_args: dict = {}
        try:
            for param_name in getattr(fn, "args", {}):
                if param_name in kwargs:
                    tool_args[param_name] = kwargs[param_name]
                elif param_name == "config":
                    tool_args["config"] = config
        except Exception:
            pass
        if not tool_args:
            tool_args = dict(kwargs)
        return await asyncio.wait_for(fn.ainvoke(tool_args), timeout=timeout_seconds)
    # mode == "mcp"
    tool_args = {}
    if kwargs.get("query"):
        tool_args["query"] = kwargs["query"]
    if kwargs.get("urls"):
        tool_args["urls"] = kwargs["urls"]
        tool_args.setdefault("url", kwargs["urls"][0])
    try:
        for param_name in getattr(fn, "args", {}):
            if param_name in kwargs and param_name not in tool_args:
                tool_args[param_name] = kwargs[param_name]
    except Exception:
        pass
    return await asyncio.wait_for(fn.ainvoke(tool_args), timeout=timeout_seconds)


async def execute_unified_pipeline_outcome(
    category: str,
    built_in_map: dict,
    default_provider_keys: list[str],
    max_retries: int,
    timeout_seconds: int = 30,
    **kwargs,
) -> UnifiedOutcome:
    """Universal fallback pipeline shared by ALL unified tool categories.

    Behavior:
      1. Select the provider: explicit ``provider`` hint > schema match > priority #1.
         Recently-failed providers (5-minute TTL) are skipped during implicit selection.
      2. Execute it. On retryable failure, retry the SAME provider with the ladder
         delays (default 3s / 8s / 16s). FATAL errors (401/403/...) skip the ladder.
      3. If the ladder is exhausted, DO NOT auto-call the next provider. Return a
         FALLBACK HANDOFF message showing the agent the next provider's key and
         schema so it re-invokes this tool with ``provider='<next_key>'``.
      4. When no provider is left, return a graceful "all providers failed" message.
    """
    config = kwargs.pop("config", None)
    provider_hint = ""
    for hint_key in ("provider", "provider_key", "preferred_provider"):
        val = kwargs.pop(hint_key, "")
        if val and not provider_hint:
            provider_hint = str(val).strip()

    # Extract user_id from config
    user_id = None
    if config:
        if isinstance(config, dict):
            user_id = (config.get("configurable") or {}).get("user_id")
        else:
            user_id = getattr(config, "get", lambda *a: None)("configurable", {}).get("user_id")
    if user_id:
        active_user_id.set(user_id)

    # 1. Resolve provider list (user unified_tool_configs > tool_provider_configs > defaults)
    providers: list[dict] = []
    uid = user_id or active_user_id.get()
    settings = get_settings(uid)
    configs_str = (settings.get("unified_tool_configs", "") or "").strip()
    if configs_str:
        try:
            all_configs = json.loads(configs_str)
            if isinstance(all_configs, list):
                providers = [
                    _normalize_provider_row(p)
                    for p in all_configs
                    if p.get("tool_category") == category and p.get("enabled", True)
                ]
                providers.sort(key=lambda x: x.get("priority_order", 999))
        except Exception as e:
            logger.error(f"[pipeline] Failed to parse unified_tool_configs JSON: {e}")

    if not providers:
        providers = [_normalize_provider_row(p) for p in get_ordered_providers(category)]

    if not providers:
        providers = [_normalize_provider_row({"provider_key": k}) for k in default_provider_keys]

    if not providers:
        return UnifiedOutcome(
            ok=False,
            message=f"❌ No providers configured for unified tool category '{category}'.",
        )

    # 2. Resolve tool objects for keys outside built_in_map (MCP / built-in tools)
    resolved_tools: list = []
    for prov in providers:
        key = prov["provider_key"]
        tool_obj = None
        if key not in built_in_map:
            try:
                mcp_list = await load_mcp_tool_by_key(key)
            except Exception:
                mcp_list = []
            if mcp_list:
                tool_obj = mcp_list[0]
            else:
                import research_agent.tools as ratools
                if hasattr(ratools, key):
                    tool_obj = getattr(ratools, key)
        resolved_tools.append(tool_obj)

    # 3. Pick the starting provider
    start_idx = -1
    if provider_hint:
        hint_l = provider_hint.lower()
        for idx, prov in enumerate(providers):
            if prov["provider_key"].lower() == hint_l or prov["label"].lower() == hint_l:
                start_idx = idx
                break
        if start_idx == -1:
            return UnifiedOutcome(
                ok=False,
                message=(
                    f"❌ Provider '{provider_hint}' is not configured for unified tool "
                    f"category '{category}'. Configured providers: "
                    f"{[p['provider_key'] for p in providers]}."
                ),
            )
    else:
        # Implicit selection: first schema match, skipping recently-failed providers.
        for idx, (prov, tool_obj) in enumerate(zip(providers, resolved_tools)):
            if _provider_recently_failed(category, prov["provider_key"]):
                continue
            if tool_obj is not None:
                if _kwargs_match_schema(tool_obj, kwargs):
                    start_idx = idx
                    break
            else:
                # Statically built-in presets (e.g. tavily, linkup) accept the
                # standard search/extract kwargs (query/urls).
                if "query" in kwargs or "urls" in kwargs:
                    start_idx = idx
                    break
        if start_idx == -1:
            # Everything recently failed or nothing matched: start from priority #1.
            start_idx = 0

    prov = providers[start_idx]
    key = prov["provider_key"]
    label = prov["label"]
    fallback_on_error = prov.get("fallback_on_error", True)

    logger.info(f"[pipeline] Executing provider {start_idx + 1}/{len(providers)}: {key}")

    # 4. Resolve the executor for this provider
    fn = None
    mode = ""
    if key in built_in_map:
        fn = built_in_map[key]
        mode = "preset"
    else:
        tool_obj = resolved_tools[start_idx]
        if tool_obj is not None:
            fn = tool_obj
            import research_agent.tools as ratools
            mode = "builtin" if hasattr(ratools, key) else "mcp"
        else:
            fn = None

    # 5. Same-provider retry ladder (initial attempt + 3s/8s/16s retries)
    delays = get_retry_ladder()
    attempts = 0
    last_error = "tool not found or connection offline"
    if fn is None:
        logger.error(f"[pipeline] Tool '{key}' not found or connection offline")
    else:
        for delay in [0] + delays:
            if delay:
                logger.info(f"[{key}] Waiting {delay}s before retry...")
                await _pipeline_sleep(delay)
            attempts += 1
            try:
                logger.info(f"[{key}] Attempt {attempts}/{len(delays) + 1} (timeout={timeout_seconds}s)")
                result = await _invoke_provider_once(fn, mode, kwargs, config, timeout_seconds)
                logger.info(f"[{key}] ✅ Success on attempt {attempts}")
                _clear_provider_failure(category, key)
                return UnifiedOutcome(
                    ok=True,
                    result=result,
                    provider_used=key,
                    attempts_total=attempts,
                )
            except Exception as e:
                last_error = str(e)
                if classify_error(e) == ErrorType.FATAL:
                    logger.error(f"[{key}] ❌ Fatal error (no retry): {e}")
                    break
                logger.warning(f"[{key}] ❌ Attempt {attempts} failed: {e}")

    _mark_provider_failed(category, key)

    # 6. Handoff to the next provider (schema shown to the agent — NOT auto-executed)
    if fallback_on_error and (start_idx + 1 < len(providers)):
        next_prov = providers[start_idx + 1]
        next_key = next_prov["provider_key"]
        next_label = next_prov["label"]
        next_schema = _describe_provider_schema(
            next_key, resolved_tools[start_idx + 1], built_in_map
        )
        delay_txt = "/".join(f"{d}s" for d in delays) if delays else "none"
        message = (
            f"⚠️ FALLBACK HANDOFF — unified tool category '{category}': provider "
            f"'{key}' ({label}) FAILED after {attempts} attempt(s) "
            f"(same-provider retry waits: {delay_txt}). Last error: {last_error}\n"
            f"Next fallback provider: '{next_key}' ({next_label}, priority #{start_idx + 2}). "
            f"Do NOT retry '{key}' this turn. Re-invoke this SAME tool now with "
            f"provider='{next_key}' and arguments matching that provider's schema:\n"
            f"    {next_key} schema: {next_schema}"
        )
        logger.warning(f"[pipeline] {message}")
        return UnifiedOutcome(
            ok=False,
            provider_used=key,
            attempts_total=attempts,
            handoff=True,
            next_provider=next_key,
            message=message,
        )

    message = (
        f"❌ Provider '{key}' ({label}) failed for unified tool category '{category}' "
        f"after {attempts} attempt(s) and no further fallback is available. "
        f"Last error: {last_error}. Providers already tried: "
        f"{[p['provider_key'] for p in providers[:start_idx + 1]]}. "
        "Please continue with the information you have already gathered or mark it Not Found. "
        "Skip this tool call and move to the next step."
    )
    logger.error(f"[pipeline] {message}")
    return UnifiedOutcome(
        ok=False,
        provider_used=key,
        attempts_total=attempts,
        message=message,
    )


async def execute_unified_pipeline(
    category: str,
    built_in_map: dict,
    default_provider_keys: list[str],
    max_retries: int,
    timeout_seconds: int = 30,
    **kwargs,
) -> str:
    """Backward-compatible string wrapper around execute_unified_pipeline_outcome.

    NOTE: ``max_retries`` is legacy — the old round-based Primary->Secondary loop
    was replaced by the universal same-provider retry ladder (see get_retry_ladder).
    It is accepted for signature compatibility but unused.
    """
    outcome = await execute_unified_pipeline_outcome(
        category=category,
        built_in_map=built_in_map,
        default_provider_keys=default_provider_keys,
        max_retries=max_retries,
        timeout_seconds=timeout_seconds,
        **kwargs,
    )
    if outcome.ok:
        return str(outcome.result)
    return outcome.message


def get_llm(provider_name: Optional[str] = None, model_name: Optional[str] = None, user_id: Optional[str] = None):
    """Instantiate a Chat model for the given provider_name, model_name, and user_id context."""
    from dotenv import load_dotenv; load_dotenv()
    from langchain_openai import ChatOpenAI
    from research_agent.tools.provider_registry import get_provider_base_url, get_provider_api_key, get_provider_config
    
    if not provider_name:
        provider_name = "openrouter"
    if not model_name:
        model_name = "xiaomi/mimo-v2.5-pro"

    provider_clean = provider_name.strip().lower()
    
    # 1. Fetch API Key directly from Supabase agent_settings table to bypass any stale Redis caches
    api_key = ""
    target_key = "openrouter_client_api_key" if provider_clean == "openrouter" else f"{provider_clean}_client_api_key"
    try:
        from supabase import create_client
        sb_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
        if sb_url and sb_key:
            client = create_client(sb_url, sb_key)
            if user_id:
                r1 = client.table("agent_settings").select("value").eq("user_id", str(user_id)).eq("key", target_key).execute()
                if r1.data and r1.data[0].get("value"):
                    api_key = r1.data[0]["value"].strip()
            if not api_key:
                r2 = client.table("agent_settings").select("value").eq("key", target_key).limit(1).execute()
                if r2.data and r2.data[0].get("value"):
                    api_key = r2.data[0]["value"].strip()
    except Exception as e:
        logger.warning(f"[get_llm] Supabase direct query error: {e}")

    # Fallback to env vars
    if not api_key:
        api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("GEMINI_API_KEY") or os.environ.get("OPENAI_API_KEY") or "placeholder"

    # 2. Resolve Base URL
    base_url = get_provider_base_url(provider_clean)
    cfg = get_provider_config(provider_clean)
    if cfg and "base_url_env" in cfg and not base_url.endswith("/v1"):
        base_url = base_url + "/v1"

    clean_model = model_name
    if provider_clean == "openrouter" and clean_model.startswith("openrouter/"):
        clean_model = clean_model[len("openrouter/"):]

    headers = {
        "HTTP-Referer": "https://github.com/agentcomplete",
        "X-Title": "Agent Complete",
    }
    if api_key and api_key != "placeholder":
        headers["Authorization"] = f"Bearer {api_key}"

    logger.info(f"[get_llm] Instantiating ChatOpenAI: provider={provider_clean}, model={clean_model}, base_url={base_url}")

    return ChatOpenAI(
        model=clean_model,
        api_key=api_key,
        openai_api_key=api_key,
        base_url=base_url,
        openai_api_base=base_url,
        default_headers=headers,
        temperature=0.2,
    )







