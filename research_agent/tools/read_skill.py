"""Tool to read a skill SKILL.md file from disk and return its full content.

The agent calls this before performing any skill-specific task (e.g. blog writing).
Skill files live in research_agent/skills/<skill_name>/SKILL.md
"""

from pathlib import Path

from langchain_core.tools import tool

# Skills directory is two levels up from tools/ → research_agent/skills/
_SKILLS_ROOT = Path(__file__).resolve().parent.parent / "skills"


@tool(parse_docstring=True)
def read_skill(skill_name: str, agent_id: Optional[str] = None) -> str:
    """Load a skill instruction file from disk and return its full content.

    Call this at the START of any task that uses a named skill.
    For example, call read_skill("blog_post_writer") before writing a blog post.

    The skill file contains detailed step-by-step instructions, rules, templates,
    and checklists that you MUST follow exactly for that task.

    Args:
        skill_name: The name of the skill directory (e.g. "blog_post_writer").
                    Must match a folder inside research_agent/skills/.
        agent_id: Optional agent ID filter — if provided, only allows reading
                  skills assigned to this specific agent.

    Returns:
        The full text of the SKILL.md file, or an error message if not found.
    """
    # Try to load from Supabase skills_library first
    import os
    from datetime import datetime, timezone
    from typing import Optional
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_ANON_KEY", "")
        if url and key:
            client = create_client(url, key)

            # Check if assigned to this agent
            if agent_id:
                resp = client.table("agent_tool_assignments") \
                    .select("id") \
                    .eq("agent_id", agent_id) \
                    .eq("tool_key", skill_name) \
                    .eq("tool_type", "skill") \
                    .eq("enabled", True) \
                    .execute()
                if not resp.data or len(resp.data) == 0:
                    return f"⚠️ Access Denied: Skill '{skill_name}' is not assigned to you in the Settings UI. You can only read skills that are attached to you."

            resp = client.table("skills_library").select("content, use_count").eq("skill_key", skill_name).eq("state", "active").execute()
            if resp.data and len(resp.data) > 0:
                content = resp.data[0].get("content", "").strip()
                if content:
                    # Track usage — increment use_count and update last_used_at
                    try:
                        current_count = resp.data[0].get("use_count", 0) or 0
                        client.table("skills_library").update({
                            "use_count": current_count + 1,
                            "last_used_at": datetime.now(timezone.utc).isoformat(),
                        }).eq("skill_key", skill_name).execute()
                    except Exception:
                        pass  # Don't fail the skill load if tracking fails

                    print(f"[read_skill] ✅ Loaded skill '{skill_name}' from database ({len(content)} chars)")
                    return (
                        f"=== SKILL: {skill_name.upper()} ===\n\n"
                        f"{content}\n\n"
                        f"=== END OF SKILL: {skill_name.upper()} ===\n"
                        f"Now follow the skill instructions above exactly.\n"
                        f"If you find any issues with this skill, fix it using "
                        f"manage_skill(action='update', skill_key='{skill_name}', ...)."
                    )
    except Exception as e:
        print(f"[read_skill] Supabase load failed: {e}. Falling back to filesystem...")


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
