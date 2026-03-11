"""Tavily Extract tool — reads full content from chosen URLs, with Exa AI fallback.

Tries Tavily first. If Tavily fails (bad API key, quota, network error), falls
back to Exa AI get_contents automatically.
"""

import os
from typing import List

from langchain_core.tools import tool


@tool(parse_docstring=True)
def tavily_extract(urls: List[str], query: str = "") -> str:
    """Extract full article content from up to 2 credible URLs.

    Attempts Tavily extract first. If Tavily fails for any reason (invalid key,
    quota exceeded, network error), automatically falls back to Exa AI get_contents
    with basic text extraction — completely transparent to the caller.

    Use this tool AFTER a linkup_search when the search snippets are too short to
    fully answer one or more research targets.  Read the actual article and get
    richer, longer context that the snippet could not provide.

    When to use:
    - A search result snippet strongly hints the page has the answer, but the
      snippet is cut off and you need the complete quote, date, or detail.
    - One or more research targets are Partially Complete after think_tool analysis.
    - You have already identified 1-2 credible URLs (Dawn, Geo, Al Jazeera,
      Reuters, BBC, etc.) whose snippets are already on-topic.

    When NOT to use:
    - All targets are already Complete after the search + think_tool step.
    - You are guessing — only send URLs whose snippets already show relevance.
    - You already read 2 URLs in this research round (max 2 URLs per round).

    Args:
        urls: List of 1-2 URLs to extract.  Pick only credible news outlets whose
              snippets already show on-topic content.  Maximum 2 URLs per call.
        query: Optional keyword string matching your current search query.  When
               provided, Tavily reranks the extracted content chunks so the most
               relevant passages appear first.  Use the same keyword string you
               used for linkup_search.

    Returns:
        Extracted markdown content for each URL, separated by a divider.
        Failed URLs are reported with an error message.
    """
    urls = urls[:2]  # enforce 2-URL cap

    # ── Attempt 1: Tavily ────────────────────────────────────────────────────
    tavily_key = os.environ.get("TAVILY_API_KEY", "")
    if tavily_key:
        try:
            from tavily import TavilyClient
            client = TavilyClient(api_key=tavily_key)

            params: dict = {
                "urls": urls,
                "extract_depth": "basic",
                "format": "markdown",
            }
            if query:
                params["query"] = query
                params["chunks_per_source"] = 5

            response = client.extract(**params)

            sections: list[str] = []
            for result in response.get("results", []):
                url = result.get("url", "")
                content = result.get("raw_content", "").strip()
                sections.append(f"### Extracted: {url}\n\n{content}")

            for failure in response.get("failed_results", []):
                url = failure.get("url", "")
                error = failure.get("error", "unknown error")
                sections.append(f"### Failed: {url}\n\nError: {error}")

            if sections:
                return "\n\n---\n\n".join(sections)
            # fall through if empty
        except Exception as e:
            print(f"[tavily_extract] Tavily failed ({e}), falling back to Exa AI extract...")
    else:
        print("[tavily_extract] TAVILY_API_KEY not set, falling back to Exa AI extract...")

    # ── Attempt 2: Exa AI fallback ───────────────────────────────────────────
    exa_key = os.environ.get("EXA_API_KEY", "")
    if not exa_key:
        return (
            "❌ Both Tavily and Exa AI are unavailable. "
            "Set TAVILY_API_KEY or EXA_API_KEY in your environment."
        )

    try:
        from exa_py import Exa as _ExaClient
    except ImportError:
        return (
            "❌ Tavily failed and exa-py SDK is not installed. "
            "Run: uv add exa-py"
        )

    try:
        eclient = _ExaClient(api_key=exa_key)
        result = eclient.get_contents(
            urls,
            text=True,  # basic text extraction, no highlights/summaries
        )

        sections = []
        for r in result.results:
            url = r.url or ""
            content = (r.text or "").strip()
            if content:
                sections.append(f"### [Exa fallback] Extracted: {url}\n\n{content}")
            else:
                sections.append(f"### [Exa fallback] Empty: {url}\n\nNo content returned.")

        return "\n\n---\n\n".join(sections) if sections else "No content extracted via Exa AI."
    except Exception as e:
        return f"❌ Both Tavily and Exa AI extract failed. Last error: {e}"
