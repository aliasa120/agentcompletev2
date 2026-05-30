"""Exa AI content extraction tool — fallback for tavily_extract.

Uses Exa's get_contents API with basic text extraction (no highlights or summaries).
Only invoked automatically when tavily_extract fails.
"""

import os
from typing import List
from langchain_core.tools import tool

try:
    from exa_py import Exa as _ExaClient
    _EXA_AVAILABLE = True
except ImportError:
    _EXA_AVAILABLE = False


@tool(parse_docstring=True)
def exa_extract(urls: List[str]) -> str:
    """Extract full article content from URLs using Exa AI (fallback for tavily_extract).

    Uses Exa's get_contents API with basic text extraction.
    Only called automatically when tavily_extract fails; do NOT call this directly
    unless tavily_extract is broken.

    Args:
        urls: List of 1-2 URLs to extract content from. Maximum 2 URLs per call.

    Returns:
        Extracted plain text content for each URL, separated by a divider.
        Failed URLs are reported with an error message.
    """
    if not _EXA_AVAILABLE:
        return "❌ exa-py SDK not installed. Run: uv add exa-py"

    api_key = os.environ.get("EXA_API_KEY", "")
    if not api_key:
        return "❌ EXA_API_KEY not set in environment."

    urls = urls[:2]  # enforce 2-URL cap

    try:
        client = _ExaClient(api_key=api_key)
        result = client.get_contents(
            urls,
            text=True,  # basic text extraction, no highlights or summaries
        )

        sections: list[str] = []
        for r in result.results:
            url = r.url or ""
            content = (r.text or "").strip()
            if content:
                sections.append(f"### Extracted: {url}\n\n{content}")
            else:
                sections.append(f"### Empty: {url}\n\nNo content returned.")

        return "\n\n---\n\n".join(sections) if sections else "No content extracted."

    except Exception as e:
        return f"❌ Exa AI extract error: {e}"
