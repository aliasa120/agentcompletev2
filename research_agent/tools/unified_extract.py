"""Unified Extract tool — agents call this instead of tavily_extract or exa_extract.

Reads primary/secondary/max_retries settings from Supabase agent_settings (cached 60s).
Wraps provider calls in normalized adapters so signature differences are invisible
to execute_with_fallback (**kwargs are never passed raw to providers — Gap 1 fix).
"""

import asyncio
import logging
import os
from typing import List

from langchain_core.tools import tool

from .provider_engine import execute_with_fallback, get_settings

logger = logging.getLogger("unified_extract")

# ── Provider Adapters (normalized signatures) ──────────────────────────────────

async def _call_tavily(urls: List[str], query: str = "", **_) -> str:
    """Adapter: call Tavily extract. Ignores kwargs not relevant to Tavily."""
    tavily_key = os.environ.get("TAVILY_API_KEY", "")
    if not tavily_key:
        raise RuntimeError("TAVILY_API_KEY not set.")
    try:
        from tavily import TavilyClient
    except ImportError:
        raise RuntimeError("tavily-python not installed. Run: uv add tavily-python")

    loop = asyncio.get_event_loop()
    def _sync():
        client = TavilyClient(api_key=tavily_key)
        params: dict = {"urls": urls[:2], "extract_depth": "basic", "format": "markdown"}
        if query:
            params["query"] = query
            params["chunks_per_source"] = 5
        response = client.extract(**params)

        sections = []
        for r in response.get("results", []):
            content = r.get("raw_content", "").strip()
            sections.append(f"### Extracted: {r.get('url', '')}\n\n{content}")
        for f in response.get("failed_results", []):
            sections.append(f"### Failed: {f.get('url', '')}\n\nError: {f.get('error', 'unknown')}")
        return "\n\n---\n\n".join(sections) if sections else "No content extracted."
    return await loop.run_in_executor(None, _sync)


async def _call_exa(urls: List[str], query: str = "", **_) -> str:
    """Adapter: call Exa AI extract. Ignores kwargs not relevant to Exa."""
    exa_key = os.environ.get("EXA_API_KEY", "")
    if not exa_key:
        raise RuntimeError("EXA_API_KEY not set.")
    try:
        from exa_py import Exa as _ExaClient
    except ImportError:
        raise RuntimeError("exa-py not installed. Run: uv add exa-py")

    loop = asyncio.get_event_loop()
    def _sync():
        client = _ExaClient(api_key=exa_key)
        result = client.get_contents(urls[:2], text=True)
        sections = []
        for r in result.results:
            content = (r.text or "").strip()
            if content:
                sections.append(f"### Extracted: {r.url}\n\n{content}")
            else:
                sections.append(f"### Empty: {r.url}\n\nNo content returned.")
        return "\n\n---\n\n".join(sections) if sections else "No content extracted."
    return await loop.run_in_executor(None, _sync)


_PROVIDER_MAP = {
    "tavily": ("Tavily", _call_tavily),
    "exa": ("Exa AI", _call_exa),
}

_DEFAULTS = {
    "extract_provider_primary": "tavily",
    "extract_provider_secondary": "exa",
    "extract_max_retries": "3",
}


# ── LangGraph Tool ─────────────────────────────────────────────────────────────

@tool(parse_docstring=True)
def unified_extract(urls: List[str], query: str = "") -> str:
    """Extract full article content from URLs.

    Provider selection (Tavily ↔ Exa AI), retry count, and fallback logic are all
    handled automatically based on settings in Supabase. The agent does NOT need to
    know which provider is active.

    When to use:
    - A search snippet hints at the answer but is too short.
    - One or more research targets are Partially Complete after search + think_tool.
    - You have 1-2 credible URLs whose snippets are already on-topic.

    When NOT to use:
    - All research targets are already Complete.
    - You already read 2 URLs in this round (max 2 per round).

    Args:
        urls: List of 1-2 credible news URLs to extract. Max 2 URLs per call.
        query: Optional keyword string — helps Tavily rerank chunks by relevance.

    Returns:
        Full extracted markdown content for each URL, separated by dividers.
    """
    urls = urls[:2]
    settings = get_settings()
    primary_key = settings.get("extract_provider_primary", _DEFAULTS["extract_provider_primary"])
    secondary_key = settings.get("extract_provider_secondary", _DEFAULTS["extract_provider_secondary"])
    max_retries = int(settings.get("extract_max_retries", _DEFAULTS["extract_max_retries"]))

    primary_name, primary_fn = _PROVIDER_MAP.get(primary_key, _PROVIDER_MAP["tavily"])
    secondary_entry = _PROVIDER_MAP.get(secondary_key)
    secondary_name = secondary_entry[0] if secondary_entry else "none"
    secondary_fn = secondary_entry[1] if secondary_entry else None

    logger.info(f"[unified_extract] Primary={primary_name}, Fallback={secondary_name}, Retries={max_retries}")

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
            urls=urls,
            query=query,
        )
    )

    prefix = ""
    if result.fallback_used:
        prefix = f"⚡ [Fallback: {result.provider_used} used after primary failed]\n\n"

    return f"{prefix}{result.data}"
