"""Linkup search tool — with automatic Parallel AI fallback.

Tries Linkup first. If Linkup fails (bad API key, network error, quota), falls
back to Parallel AI search transparently and marks the result accordingly.
"""

import os
from datetime import date, timedelta

from langchain_core.tools import InjectedToolArg, tool
from typing_extensions import Annotated

# Lazy import so a missing key doesn't crash at import time
def _get_linkup_client():
    from linkup import LinkupClient
    return LinkupClient(api_key=os.environ.get("LINKUP_API_KEY", ""))


@tool(parse_docstring=True)
def linkup_search(
    query: str,
    depth: Annotated[str, InjectedToolArg] = "standard",
) -> str:
    """Search the web for current news and information on a given topic.

    Attempts Linkup agentic search first. If Linkup fails for any reason
    (invalid key, quota exceeded, network error), automatically falls back
    to Parallel AI search agentic mode — completely transparent to the caller.

    Query writing rules (CRITICAL):
    - Write as a short, specific keyword string (4-8 words). NO quotes around query.
    - Include the year (e.g. 2026) and/or month for recency on current events.
    - Use proper nouns, acronyms, and official names exactly as they appear in news.
    - Good: Pakistan IMF EFF statement Kozack February 2026
    - Bad:  "Find the IMF spokesperson's statement about Pakistan's Extended Fund Facility"

    Args:
        query: Keyword-dense search string (4-8 words). No quotes. Include year for recency.
        depth: Search depth - 'standard' (fast, single pass) or 'deep' (thorough). Default: standard.

    Returns:
        Sourced answer with inline citations and source URLs.
    """
    # ── Attempt 1: Linkup ───────────────────────────────────────────────────
    linkup_key = os.environ.get("LINKUP_API_KEY", "")
    if linkup_key:
        try:
            client = _get_linkup_client()
            response = client.search(
                query=query,
                depth=depth,
                output_type="sourcedAnswer",
                include_images=True,
                include_inline_citations=False,
            )
            return str(response)
        except Exception as e:
            print(f"[linkup_search] Linkup failed ({e}), falling back to Parallel AI search...")
    else:
        print("[linkup_search] LINKUP_API_KEY not set, falling back to Parallel AI search...")

    # ── Attempt 2: Parallel AI fallback ────────────────────────────────────
    parallel_key = os.environ.get("PARALLEL_API_KEY", "")
    if not parallel_key:
        return (
            "❌ Both Linkup and Parallel AI are unavailable. "
            "Set LINKUP_API_KEY or PARALLEL_API_KEY in your environment."
        )

    try:
        from parallel import Parallel as _ParallelClient
    except ImportError:
        return (
            "❌ Linkup failed and parallel-web SDK is not installed. "
            "Run: uv add parallel-web"
        )

    try:
        pclient = _ParallelClient(api_key=parallel_key)
        result = pclient.beta.search(
            objective=query,
            search_queries=[query],
            mode="agentic",
            excerpts={"max_chars_per_result": 8000},
        )

        lines = [f"⚡ [Parallel AI fallback] Search results for: {query}\n"]
        for r in result.results:
            lines.append(f"**{r.title}** — {r.url}")
            for excerpt in r.excerpts:
                lines.append(excerpt[:1000])
            lines.append("")

        return "\n".join(lines) if len(lines) > 1 else "No results found via Parallel AI."
    except Exception as e:
        return f"❌ Both Linkup and Parallel AI failed. Last error: {e}"
