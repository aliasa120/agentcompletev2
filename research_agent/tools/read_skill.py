"""Tool to read a skill SKILL.md file from disk and return its full content.

The agent calls this before performing any skill-specific task (e.g. blog writing).
Skill files live in research_agent/skills/<skill_name>/SKILL.md
"""

from pathlib import Path

from langchain_core.tools import tool

# Skills directory is two levels up from tools/ → research_agent/skills/
_SKILLS_ROOT = Path(__file__).resolve().parent.parent / "skills"


@tool(parse_docstring=True)
def read_skill(skill_name: str) -> str:
    """Load a skill instruction file from disk and return its full content.

    Call this at the START of any task that uses a named skill.
    For example, call read_skill("blog_post_writer") before writing a blog post.

    The skill file contains detailed step-by-step instructions, rules, templates,
    and checklists that you MUST follow exactly for that task.

    Args:
        skill_name: The name of the skill directory (e.g. "blog_post_writer").
                    Must match a folder inside research_agent/skills/.

    Returns:
        The full text of the SKILL.md file, or an error message if not found.
    """
    skill_path = _SKILLS_ROOT / skill_name / "SKILL.md"

    if not _SKILLS_ROOT.exists():
        return (
            f"⚠️ Skills directory not found at {_SKILLS_ROOT}. "
            "Check that the research_agent/skills/ folder exists."
        )

    if not skill_path.exists():
        available = [d.name for d in _SKILLS_ROOT.iterdir() if d.is_dir()]
        return (
            f"⚠️ Skill '{skill_name}' not found at {skill_path}. "
            f"Available skills: {available if available else 'none'}"
        )

    try:
        content = skill_path.read_text(encoding="utf-8")
        char_count = len(content)
        print(f"[read_skill] ✅ Loaded skill '{skill_name}' ({char_count} chars)")
        return (
            f"=== SKILL: {skill_name.upper()} ===\n\n"
            f"{content}\n\n"
            f"=== END OF SKILL: {skill_name.upper()} ===\n"
            f"Now follow the skill instructions above exactly."
        )
    except Exception as e:
        return f"❌ Failed to read skill '{skill_name}': {e}"
