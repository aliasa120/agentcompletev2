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

Settings are cached for 60 s to avoid hammering the DB on every tool call.
"""

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Optional

logger = logging.getLogger("provider_engine")

# ── Settings Cache ─────────────────────────────────────────────────────────────

_settings_cache: dict[str, str] = {}
_cache_loaded_at: float = 0.0
_CACHE_TTL_SECONDS = 60  # refresh from Supabase every 60 s


def _fetch_settings_from_supabase() -> dict[str, str]:
    """Pull agent_settings from Supabase synchronously. Returns {} on failure."""
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


def get_settings() -> dict[str, str]:
    """Return provider settings, using in-process cache (refreshes every 60 s)."""
    global _settings_cache, _cache_loaded_at
    now = time.time()
    if now - _cache_loaded_at >= _CACHE_TTL_SECONDS or not _settings_cache:
        fresh = _fetch_settings_from_supabase()
        if fresh:
            _settings_cache = fresh
            _cache_loaded_at = now
            logger.debug("[provider_engine] Settings cache refreshed from Supabase.")
    return _settings_cache


def invalidate_settings_cache():
    """Force next call to get_settings() to re-fetch from Supabase."""
    global _cache_loaded_at
    _cache_loaded_at = 0.0


def get_retry_delay() -> int:
    """Return the configured flat retry delay in seconds (default 15)."""
    settings = get_settings()
    try:
        return int(settings.get("retry_delay_seconds", "15"))
    except (ValueError, TypeError):
        return 15


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
