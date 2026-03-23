"""Unified Search tool — agents call this instead of linkup_search or parallel_search directly.

Reads primary/secondary/max_retries settings from Supabase agent_settings (cached 60s).
Routes to the correct provider with exponential backoff, error classification, and
timeout enforcement. The agent only calls this one tool; fallback is invisible to it.

Provider function signatures are NORMALIZED internally so **kwargs are never
passed raw to providers that don't accept them (Gap 1 fix).
"""

import asyncio
import logging
import os
from typing import List

import httpx
from langchain_core.tools import tool

from .provider_engine import execute_with_fallback, get_settings

logger = logging.getLogger("unified_search")

# ── Provider Adapters (normalized signatures) ──────────────────────────────────

async def _call_linkup(query: str, **_) -> str:
    """Adapter: call Linkup search. Ignores kwargs not relevant to Linkup."""
    linkup_key = os.environ.get("LINKUP_API_KEY", "")
    if not linkup_key:
        raise RuntimeError("LINKUP_API_KEY not set.")
    try:
        from linkup import LinkupClient
    except ImportError:
        raise RuntimeError("linkup SDK not installed. Run: uv add linkup-sdk")

    loop = asyncio.get_event_loop()
    def _sync():
        client = LinkupClient(api_key=linkup_key)
        return str(client.search(
            query=query,
            depth="standard",
            output_type="sourcedAnswer",
            include_images=True,
        ))
    return await loop.run_in_executor(None, _sync)


async def _call_parallel(query: str, **_) -> str:
    """Adapter: call Parallel AI search via HTTP. Uses x-api-key header + /v1beta/search."""
    api_key = os.environ.get("PARALLEL_API_KEY", "")
    if not api_key:
        raise RuntimeError("PARALLEL_API_KEY not set.")

    payload = {
        "objective": query,
        "search_queries": [query],
        "mode": "agentic",   # token-efficient for multi-step agent loops
        "excerpts": {"max_chars_per_result": 8000},
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://api.parallel.ai/v1beta/search",
            headers={
                "Content-Type": "application/json",
                "x-api-key": api_key,         # Parallel AI uses x-api-key, NOT Bearer
            },
            json=payload,
        )

    if resp.status_code == 401:
        raise RuntimeError("401 Unauthorized — invalid PARALLEL_API_KEY.")
    if resp.status_code == 403:
        raise RuntimeError("403 Forbidden — check Parallel AI account permissions.")
    if not resp.is_success:
        raise RuntimeError(f"Parallel AI HTTP {resp.status_code}: {resp.text[:300]}")

    data = resp.json()
    results = data.get("results", [])
    if not results:
        return "No results found via Parallel AI."

    lines = [f"🔍 Parallel AI (agentic) — {query}\n"]
    for r in results:
        lines.append(f"**{r.get('title', 'Untitled')}** — {r.get('url', '')}")
        for excerpt in r.get("excerpts", []):
            lines.append(excerpt[:1000])
        lines.append("")

    return "\n".join(lines)


_PROVIDER_MAP = {
    "linkup": ("Linkup", _call_linkup),
    "parallel": ("Parallel AI", _call_parallel),
}

_DEFAULTS = {
    "search_provider_primary": "linkup",
    "search_provider_secondary": "parallel",
    "search_max_retries": "3",
}


# ── LangGraph Tool ─────────────────────────────────────────────────────────────

@tool(parse_docstring=True)
def unified_search(query: str) -> str:
    """Search the web for current news and information on a given topic.

    Provider selection (Linkup ↔ Parallel AI), retry count, and fallback logic are
    all handled automatically based on settings in Supabase. The agent does NOT need
    to know which provider is being used.

    Query writing rules:
    - Short, specific keyword string (4-8 words) — no quotation marks.
    - Include the year (e.g. 2026) for current events.
    - Use proper nouns, official names, acronyms as they appear in news.
    - Good: Pakistan IMF EFF statement Kozack March 2026
    - Bad:  "Find the IMF spokesperson's statement about Pakistan"

    Args:
        query: Keyword-dense search string (4-8 words). No quotes. Include year.

    Returns:
        Sourced answer with inline citations and source URLs from the active provider.
    """
    settings = get_settings()
    primary_key = settings.get("search_provider_primary", _DEFAULTS["search_provider_primary"])
    secondary_key = settings.get("search_provider_secondary", _DEFAULTS["search_provider_secondary"])
    max_retries = int(settings.get("search_max_retries", _DEFAULTS["search_max_retries"]))

    primary_name, primary_fn = _PROVIDER_MAP.get(primary_key, _PROVIDER_MAP["linkup"])
    secondary_entry = _PROVIDER_MAP.get(secondary_key)
    secondary_name = secondary_entry[0] if secondary_entry else "none"
    secondary_fn = secondary_entry[1] if secondary_entry else None

    logger.info(f"[unified_search] Primary={primary_name}, Fallback={secondary_name}, Retries={max_retries}")

    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

    result = loop.run_until_complete(
        execute_with_fallback(
            primary_fn=primary_fn,
            secondary_fn=secondary_fn,
            primary_name=primary_name,
            secondary_name=secondary_name,
            max_retries=max_retries,
            timeout_seconds=30,
            query=query,
        )
    )

    prefix = ""
    if result.fallback_used:
        prefix = f"⚡ [Fallback: {result.provider_used} used after primary failed]\n\n"

    return f"{prefix}{result.data}"
