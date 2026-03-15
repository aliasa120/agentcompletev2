"""Tool that reads design.md from disk and returns its full content.

Used by the agent when analyze_images_gemini fails (Gemini vision API error)
so the agent can still craft a correct THE ECHO editing prompt manually.
"""

from pathlib import Path

from langchain_core.tools import tool

# Absolute path — works regardless of working directory (Docker, local, LangGraph)
_REPO_ROOT = Path(__file__).resolve().parents[2]   # research_agent/tools/ -> repo root
_DESIGN_MD = _REPO_ROOT / "design.md"


@tool(parse_docstring=True)
def get_design_guide() -> str:
    """Read the THE ECHO brand design guide (design.md) and return its full content.

    Call this when analyze_images_gemini fails so you can manually write
    an editing prompt that follows THE ECHO brand style.

    Returns:
        The full text of design.md, or an error message if the file is missing.
    """
    if not _DESIGN_MD.exists():
        return (
            f"⚠️ design.md not found at {_DESIGN_MD}. "
            "Use these brand defaults: Deep Teal #0E4D4A, Mustard Gold #CBA052, White #FFFFFF. "
            "THE ECHO logo in top header bar. Website 'theecho.news.tv' at bottom."
        )
    try:
        content = _DESIGN_MD.read_text(encoding="utf-8")
        print(f"[get_design_guide] ✅ Read design.md ({len(content)} chars)")
        return content
    except Exception as e:
        return f"❌ Failed to read design.md: {e}"
