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

from .provider_engine import execute_with_fallback, get_settings, execute_unified_pipeline

logger = logging.getLogger("unified_search")

# ── Provider Adapters (normalized signatures) ──────────────────────────────────

async def _call_linkup(query: str, **_) -> str:
    """Adapter: call Linkup search. Ignores kwargs not relevant to Linkup."""
    from .provider_engine import get_user_api_key
    linkup_key = get_user_api_key("linkup_api_key", "LINKUP_API_KEY")
    if not linkup_key:
        raise RuntimeError("linkup_api_key not set in user settings or LINKUP_API_KEY env.")
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
    from .provider_engine import get_user_api_key
    api_key = get_user_api_key("parallel_api_key", "PARALLEL_API_KEY")
    if not api_key:
        raise RuntimeError("parallel_api_key not set in user settings or PARALLEL_API_KEY env.")

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


async def _call_tavily(query: str, **_) -> str:
    """Adapter: call Tavily search."""
    from .provider_engine import get_user_api_key
    tavily_key = get_user_api_key("tavily_api_key", "TAVILY_API_KEY")
    if not tavily_key:
        raise RuntimeError("tavily_api_key not set in user settings or TAVILY_API_KEY env.")
    try:
        from tavily import TavilyClient
    except ImportError:
        raise RuntimeError("tavily-python not installed. Run: uv add tavily-python")

    loop = asyncio.get_event_loop()
    def _sync():
        client = TavilyClient(api_key=tavily_key)
        resp = client.search(query=query, search_depth="advanced", max_results=5)
        results = resp.get("results", [])
        lines = [f"🔍 Tavily Search — {query}\n"]
        for r in results:
            lines.append(f"**{r.get('title', 'Untitled')}** — {r.get('url', '')}")
            lines.append(r.get('content', ''))
            lines.append("")
        return "\n".join(lines)
    return await loop.run_in_executor(None, _sync)


async def _call_exa(query: str, **_) -> str:
    """Adapter: call Exa search."""
    exa_key = os.environ.get("EXA_API_KEY", "")
    if not exa_key:
        raise RuntimeError("EXA_API_KEY not set.")
    try:
        from exa_py import Exa
    except ImportError:
        raise RuntimeError("exa-py not installed. Run: uv add exa-py")

    loop = asyncio.get_event_loop()
    def _sync():
        client = Exa(api_key=exa_key)
        resp = client.search(query, num_results=5, use_autoprompt=True)
        results = resp.results
        lines = [f"🔍 Exa Search — {query}\n"]
        for r in results:
            lines.append(f"**{r.title or 'Untitled'}** — {r.url}")
            lines.append(getattr(r, "highlights", [r.url])[0] if getattr(r, "highlights", None) else r.url)
            lines.append("")
        return "\n".join(lines)
    return await loop.run_in_executor(None, _sync)


_PROVIDER_MAP = {
    "linkup": _call_linkup,
    "parallel": _call_parallel,
    "tavily": _call_tavily,
    "exa": _call_exa,
}


from langchain_core.runnables import RunnableConfig

@tool(parse_docstring=True)
def unified_search(query: str, config: RunnableConfig = None) -> str:
    """Search the web for current news and information on a given topic.

    Provider selection, priority, retry count, and fallback logic are
    handled automatically based on the numbered settings in Supabase.

    Query writing rules:
    - Short, specific keyword string (4-8 words) — no quotation marks.
    - Include the year (e.g. 2026) for current events.
    - Use proper nouns, official names, acronyms as they appear in news.
    - Good: Pakistan IMF EFF statement Kozack March 2026
    - Bad:  "Find the IMF spokesperson's statement about Pakistan"

    Args:
        query: Keyword-dense search string (4-8 words). No quotes. Include year.
        config: Optional LangChain runnable configuration.

    Returns:
        Sourced answer with inline citations and source URLs from the active provider.
    """
    try:
        from .dynamic_router import get_tool_permission_mode
        perm_mode = get_tool_permission_mode("unified_search")
        if perm_mode == "deny":
            return "Error: Tool 'unified_search' execution is blocked/denied by your security permissions."
    except Exception as perm_err:
        pass

    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

    default_keys = ["linkup", "parallel", "tavily", "exa"]

    return loop.run_until_complete(
        execute_unified_pipeline(
            category="search",
            built_in_map=_PROVIDER_MAP,
            default_provider_keys=default_keys,
            max_retries=4,
            timeout_seconds=30,
            query=query,
            config=config,
        )
    )

