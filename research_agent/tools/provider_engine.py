"""Core provider engine — retry, fallback, timeout, and error classification.

All unified tools (unified_search, unified_extract, unified_image) use this module
to execute provider functions with exponential backoff, structured error classification,
per-request timeouts, and fallback to a secondary provider if the primary exhausts all retries.

Settings are read from Supabase `agent_settings` and cached for 60 seconds to avoid
hammering the DB on every agent tool call.
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
_CACHE_TTL_SECONDS = 60  # refresh from Supabase every 60s


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
    """Return provider settings, using in-process cache (refreshes every 60s)."""
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


# ── Error Classification ───────────────────────────────────────────────────────

class ErrorType(Enum):
    RETRYABLE = "retryable"  # 429, 500, 502, 503, timeout — worth retrying
    FATAL = "fatal"          # 401, 403, 404, bad config — skip to fallback immediately


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


# ── Core Execution Engine ──────────────────────────────────────────────────────

async def execute_with_fallback(
    primary_fn: Callable,
    secondary_fn: Optional[Callable],
    primary_name: str,
    secondary_name: str,
    max_retries: int,
    timeout_seconds: int = 30,
    **kwargs,
) -> ProviderResult:
    """Run primary_fn with retry+backoff. Fall back to secondary_fn if needed.

    Retry strategy (exponential backoff):
      Attempt 1 → fail → wait 1s
      Attempt 2 → fail → wait 2s
      Attempt 3 → fail → move to secondary

    Fatal errors (401, 403) skip immediately to the secondary without waiting.

    Args:
        primary_fn: Async callable for the primary provider.
        secondary_fn: Async callable for the fallback provider, or None if no fallback.
        primary_name: Human-readable name (for logs).
        secondary_name: Human-readable name of fallback (for logs).
        max_retries: Number of attempts for each provider.
        timeout_seconds: Per-attempt timeout. Raises asyncio.TimeoutError if exceeded.
        **kwargs: Arguments passed to the provider functions.

    Returns:
        ProviderResult with the data, provider name, total attempts, and fallback flag.
    """
    total_attempts = 0

    # ── Primary attempts ─────────────────────────────────────────────────────
    for attempt in range(1, max_retries + 1):
        total_attempts += 1
        try:
            logger.info(f"[{primary_name}] Attempt {attempt}/{max_retries} (timeout={timeout_seconds}s)")
            result = await asyncio.wait_for(
                primary_fn(**kwargs),
                timeout=timeout_seconds,
            )
            logger.info(f"[{primary_name}] ✅ Success on attempt {attempt}")
            return ProviderResult(
                data=result,
                provider_used=primary_name,
                attempts_total=total_attempts,
                fallback_used=False,
            )
        except asyncio.TimeoutError:
            logger.warning(f"[{primary_name}] ⏱ Attempt {attempt} timed out after {timeout_seconds}s")
        except Exception as e:
            error_type = classify_error(e)
            if error_type == ErrorType.FATAL:
                logger.error(f"[{primary_name}] ⛔ Fatal error on attempt {attempt}: {e} — skipping to fallback")
                break  # No point retrying a bad API key
            logger.warning(f"[{primary_name}] ⚠️ Attempt {attempt} failed: {e}")

        if attempt < max_retries:
            wait = 2 ** (attempt - 1)  # 1s, 2s, 4s …
            logger.info(f"[{primary_name}] Waiting {wait}s before next attempt…")
            await asyncio.sleep(wait)

    # ── Fallback attempts ────────────────────────────────────────────────────
    if secondary_fn is None:
        raise RuntimeError(
            f"❌ Provider [{primary_name}] exhausted {max_retries} attempts. "
            "No fallback configured."
        )

    logger.warning(f"[{primary_name}] Exhausted. Falling back to [{secondary_name}]")

    for attempt in range(1, max_retries + 1):
        total_attempts += 1
        try:
            logger.info(f"[{secondary_name}] Fallback attempt {attempt}/{max_retries} (timeout={timeout_seconds}s)")
            result = await asyncio.wait_for(
                secondary_fn(**kwargs),
                timeout=timeout_seconds,
            )
            logger.info(f"[{secondary_name}] ✅ Fallback success on attempt {attempt}")
            return ProviderResult(
                data=result,
                provider_used=secondary_name,
                attempts_total=total_attempts,
                fallback_used=True,
            )
        except asyncio.TimeoutError:
            logger.warning(f"[{secondary_name}] ⏱ Fallback attempt {attempt} timed out")
        except Exception as e:
            error_type = classify_error(e)
            if error_type == ErrorType.FATAL:
                logger.error(f"[{secondary_name}] ⛔ Fatal fallback error: {e}")
                break
            logger.warning(f"[{secondary_name}] ⚠️ Fallback attempt {attempt} failed: {e}")

        if attempt < max_retries:
            wait = 2 ** (attempt - 1)
            logger.info(f"[{secondary_name}] Waiting {wait}s before next attempt…")
            await asyncio.sleep(wait)

    raise RuntimeError(
        f"❌ All providers failed after {total_attempts} total attempts. "
        f"[{primary_name}] × {max_retries}, [{secondary_name}] × {max_retries}. "
        "Check API keys and service availability."
    )
