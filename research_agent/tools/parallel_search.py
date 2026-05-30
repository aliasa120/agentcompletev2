"""Parallel AI search tool — fallback for linkup_search.

Uses the Parallel AI Search API (parallel-web SDK) with agentic mode,
optimised for multi-step agent workflows with token-efficient excerpts.
"""

import os
from langchain_core.tools import tool

try:
    from parallel import Parallel as _ParallelClient
    _PARALLEL_AVAILABLE = True
except ImportError:
    _PARALLEL_AVAILABLE = False


@tool(parse_docstring=True)
def parallel_search(query: str) -> str:
    """Search the web using Parallel AI (fallback for linkup_search).

    Uses Parallel AI agentic mode — returns concise, token-efficient excerpts
    optimised for multi-step agent workflows. Only called automatically when
    linkup_search fails; do NOT call this directly unless linkup_search is broken.

    Query writing rules (same as linkup_search):
    - Write as a short, specific keyword string (4-8 words). NO quotes around query.
    - Include the year (e.g. 2026) and/or month for recency on current events.
    - Use proper nouns, acronyms, and official names exactly as they appear in news.
    - Good: Pakistan IMF EFF statement Kozack February 2026
    - Bad:  "Find the IMF spokesperson's statement about Pakistan's Extended Fund Facility"

    Args:
        query: Keyword-dense search string (4-8 words). No quotes. Include year for recency.

    Returns:
        Sourced answer with inline citations and source URLs from Parallel AI.
    """
    if not _PARALLEL_AVAILABLE:
        return "❌ parallel-web SDK not installed. Run: uv add parallel-web"

    api_key = os.environ.get("PARALLEL_API_KEY", "")
    if not api_key:
        return "❌ PARALLEL_API_KEY not set in environment."

    try:
        client = _ParallelClient(api_key=api_key)
        result = client.beta.search(
            objective=query,
            search_queries=[query],
            mode="agentic",
            excerpts={"max_chars_per_result": 8000},
        )

        lines = [f"🔍 Parallel AI Search Results for: {query}\n"]
        for r in result.results:
            lines.append(f"**{r.title}** — {r.url}")
            for excerpt in r.excerpts:
                lines.append(excerpt[:1000])
            lines.append("")

        return "\n".join(lines) if len(lines) > 1 else "No results found."
    except Exception as e:
        return f"❌ Parallel AI search error: {e}"
