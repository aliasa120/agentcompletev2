"""Tool to read a skill SKILL.md file from disk and return its full content.

The agent calls this before performing any skill-specific task (e.g. blog writing).
Skill files live in research_agent/skills/<skill_name>/SKILL.md
"""

from pathlib import Path
from typing import Optional

from langchain_core.tools import tool

# Skills directory is two levels up from tools/ → research_agent/skills/
_SKILLS_ROOT = Path(__file__).resolve().parent.parent / "skills"


# Helper functions for YAML frontmatter parsing and compatibility checks
def parse_frontmatter(content: str) -> tuple[dict, str]:
    """Parse YAML frontmatter from markdown content."""
    import re
    import yaml
    frontmatter = {}
    body = content
    if not content.startswith("---"):
        return frontmatter, body
    
    # Try finding the closing ---
    end_match = re.search(r"\r?\n---\r?\n", content[3:])
    if not end_match:
        return frontmatter, body
        
    yaml_content = content[3 : end_match.start() + 3]
    body = content[end_match.end() + 3 :]
    
    try:
        parsed = yaml.safe_load(yaml_content)
        if isinstance(parsed, dict):
            frontmatter = parsed
    except Exception:
        # Fallback to key-value splitting if yaml parser fails
        for line in yaml_content.strip().split("\n"):
            if ":" in line:
                key, val = line.split(":", 1)
                frontmatter[key.strip()] = val.strip().strip("'\"")
    return frontmatter, body

def check_skill_compatibility(frontmatter: dict, skill_name: str) -> Optional[str]:
    """Check if the skill is compatible with the current platform and has all required env vars."""
    import sys
    import os
    
    # 1. Platform Check
    platforms = frontmatter.get("platforms")
    if platforms:
        if isinstance(platforms, str):
            platforms = [platforms]
        
        platform_map = {
            "macos": "darwin",
            "linux": "linux",
            "windows": "win32"
        }
        current_platform = sys.platform
        matched = False
        for p in platforms:
            norm = str(p).lower().strip()
            mapped = platform_map.get(norm, norm)
            if current_platform.startswith(mapped):
                matched = True
                break
        if not matched:
            return (
                f"⚠️ Platform Incompatible: The skill '{skill_name}' is only compatible with "
                f"platforms: {platforms}. Current platform is '{sys.platform}'."
            )

    # 2. Required Env Vars Check
    required_vars = []
    
    # Parse standard required_environment_variables
    req_raw = frontmatter.get("required_environment_variables") or []
    if isinstance(req_raw, str):
        req_raw = [req_raw]
    elif isinstance(req_raw, dict):
        req_raw = [req_raw]
        
    for item in req_raw:
        if isinstance(item, str):
            required_vars.append(item.strip())
        elif isinstance(item, dict):
            name = item.get("name") or item.get("env_var")
            if name:
                required_vars.append(str(name).strip())

    # Parse legacy prerequisites.env_vars
    prereqs = frontmatter.get("prerequisites")
    if isinstance(prereqs, dict):
        env_vars = prereqs.get("env_vars") or []
        if isinstance(env_vars, str):
            env_vars = [env_vars]
        for v in env_vars:
            required_vars.append(str(v).strip())

    # De-duplicate required vars
    required_vars = list(set(required_vars))
    
    # Check if any required env vars are missing
    missing_vars = []
    for var in required_vars:
        if not os.environ.get(var):
            missing_vars.append(var)
            
    if missing_vars:
        missing_str = ", ".join(missing_vars)
        return (
            f"⚠️ Setup Needed: The skill '{skill_name}' requires the following environment "
            f"variables which are currently missing: {missing_str}. Please configure them."
        )
        
    return None


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
                # 1. Fetch attach_all_skills toggle for this agent
                attach_all_skills = False
                try:
                    agent_resp = client.table("agent_configs") \
                        .select("attach_all_skills") \
                        .eq("id", agent_id) \
                        .execute()
                    if agent_resp.data and len(agent_resp.data) > 0:
                        attach_all_skills = bool(agent_resp.data[0].get("attach_all_skills", False))
                except Exception as e:
                    print(f"[read_skill] Failed to fetch agent config: {e}")

                # 2. Check manual assignment
                is_manually_assigned = False
                try:
                    assign_resp = client.table("agent_tool_assignments") \
                        .select("id") \
                        .eq("agent_id", agent_id) \
                        .eq("tool_key", skill_name) \
                        .eq("tool_type", "skill") \
                        .eq("enabled", True) \
                        .execute()
                    is_manually_assigned = bool(assign_resp.data and len(assign_resp.data) > 0)
                except Exception as e:
                    print(f"[read_skill] Failed to check manual assignment: {e}")

                # 3. If not manually assigned, check if we can auto-attach
                is_allowed = is_manually_assigned
                if not is_allowed and attach_all_skills:
                    try:
                        skill_meta = client.table("skills_library") \
                            .select("created_by_agent_id") \
                            .eq("skill_key", skill_name) \
                            .eq("state", "active") \
                            .execute()
                        if skill_meta.data and len(skill_meta.data) > 0:
                            created_by = skill_meta.data[0].get("created_by_agent_id")
                            if created_by is None or str(created_by) == str(agent_id):
                                is_allowed = True
                    except Exception as e:
                        print(f"[read_skill] Failed to check skill creator: {e}")

                if not is_allowed:
                    return f"⚠️ Access Denied: Skill '{skill_name}' is not assigned to you in the Settings UI. You can only read skills that are attached to you."

            resp = client.table("skills_library").select("content, use_count").eq("skill_key", skill_name).eq("state", "active").execute()
            if resp.data and len(resp.data) > 0:
                content = resp.data[0].get("content", "").strip()
                if content:
                    # Validate frontmatter and compatibility
                    frontmatter, body = parse_frontmatter(content)
                    compatibility_error = check_skill_compatibility(frontmatter, skill_name)
                    if compatibility_error:
                        return compatibility_error

                    # Track usage — increment use_count and update last_used_at
                    try:
                        current_count = resp.data[0].get("use_count", 0) or 0
                        client.table("skills_library").update({
                            "use_count": current_count + 1,
                            "last_used_at": datetime.now(timezone.utc).isoformat(),
                        }).eq("skill_key", skill_name).execute()
                    except Exception:
                        pass  # Don't fail the skill load if tracking fails

                    print(f"[read_skill] [OK] Loaded skill '{skill_name}' from database ({len(content)} chars)")
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
        
        # Validate frontmatter and compatibility
        frontmatter, body = parse_frontmatter(content)
        compatibility_error = check_skill_compatibility(frontmatter, skill_name)
        if compatibility_error:
            return compatibility_error

        print(f"[read_skill] [OK] Loaded skill '{skill_name}' ({char_count} chars)")
        return (
            f"=== SKILL: {skill_name.upper()} ===\n\n"
            f"{content}\n\n"
            f"=== END OF SKILL: {skill_name.upper()} ===\n"
            f"Now follow the skill instructions above exactly."
        )
    except Exception as e:
        return f"❌ Failed to read skill '{skill_name}': {e}"
