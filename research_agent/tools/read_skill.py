"""Tool to read a skill SKILL.md file from disk and return its full content.

The agent calls this before performing any skill-specific task (e.g. blog writing).
Skill files live in research_agent/skills/<skill_name>/SKILL.md
"""

from pathlib import Path
from typing import Optional

from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig

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
def read_skill(skill_name: str, agent_id: Optional[str] = None, config: Optional[RunnableConfig] = None) -> str:
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
        config: LangChain runnable configuration (automatically injected).

    Returns:
        The full text of the SKILL.md file, or an error message if not found.
    """
    # Try to load from Supabase skills_library first
    import os
    from datetime import datetime, timezone
    from typing import Optional
    
    configurable = config.get("configurable", {}) if config else {}
    user_id_val = configurable.get("user_id")

    # Tier 2: look up user_id from agent_configs using agent_id (reliable — bound at compile time)
    if not user_id_val and agent_id:
        try:
            from supabase import create_client as _create_client
            _url = os.environ.get("SUPABASE_URL", "").rstrip("/")
            _key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
            if _url and _key:
                _c = _create_client(_url, _key)
                _r = _c.table("agent_configs").select("user_id").eq("id", agent_id).execute()
                if _r.data and len(_r.data) > 0:
                    user_id_val = _r.data[0].get("user_id")
        except Exception:
            pass

    # Tier 3: ContextVar last resort
    if not user_id_val:
        try:
            from research_agent.tools.provider_engine import active_user_id as _active_uid
            user_id_val = _active_uid.get()
        except Exception:
            pass

    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
        if url and key:
            client = create_client(url, key)

            # Fetch the main skill using read_skill_admin RPC
            resp = client.rpc("read_skill_admin", {"p_skill_key": skill_name, "p_user_id": user_id_val}).execute()
            skill_data = resp.data
            
            if skill_data:
                # Check access if agent_id is provided
                if agent_id:
                    attach_all_skills = False
                    is_manually_assigned = False
                    
                    try:
                        bootstrap_resp = client.rpc("get_backend_bootstrap_data").execute()
                        bootstrap = bootstrap_resp.data or {}

                        # Resolve attach_all_skills from bootstrap agent_configs
                        configs = bootstrap.get("agent_configs") or []
                        for cfg in configs:
                          if str(cfg.get("id")) == str(agent_id):
                            attach_all_skills = bool(cfg.get("attach_all_skills", False))
                            break

                        # Resolve manual assignments from bootstrap agent_tool_assignments
                        assignments = bootstrap.get("agent_tool_assignments") or []
                        is_manually_assigned = any(
                          str(a.get("agent_id")) == str(agent_id)
                          and a.get("tool_key") == skill_name
                          and a.get("tool_type") == "skill"
                          and a.get("enabled")
                          for a in assignments
                        )
                    except Exception as e:
                        print(f"[read_skill] Failed to fetch agent configurations via bootstrap RPC: {e}")

                    is_allowed = is_manually_assigned
                    if not is_allowed and attach_all_skills:
                        created_by = skill_data.get("created_by_agent_id")
                        if created_by is None or str(created_by) == str(agent_id):
                            is_allowed = True

                    if not is_allowed:
                        return f"⚠️ Access Denied: Skill '{skill_name}' is not assigned to you in the Settings UI. You can only read skills that are attached to you."

                content = skill_data.get("content", "").strip()
                if content:
                    # Validate frontmatter and compatibility
                    frontmatter, body = parse_frontmatter(content)
                    compatibility_error = check_skill_compatibility(frontmatter, skill_name)
                    if compatibility_error:
                        return compatibility_error

                    # ── Fetch subskills automatically via get_subskills_admin RPC ──
                    sub_resp = client.rpc("get_subskills_admin", {"p_parent_skill_key": skill_name, "p_user_id": user_id_val}).execute()
                    subskills = sub_resp.data or []

                    subskills_text = ""
                    if subskills:
                        subskills_text = "\n\n=== SUBSKILLS ASSOCIATED WITH " + skill_name.upper() + " ===\n"
                        for sub in subskills:
                            sub_key = sub.get("skill_key", "")
                            sub_content = sub.get("content", "").strip()
                            subskills_text += f"\n--- SUBSKILL: {sub_key.upper()} ---\n{sub_content}\n"
                        subskills_text += f"\n=== END OF SUBSKILLS ===\n"

                    print(f"[read_skill] [OK] Loaded skill '{skill_name}' and {len(subskills)} subskills from database ({len(content)} chars)")
                    return (
                        f"=== SKILL: {skill_name.upper()} ===\n\n"
                        f"{content}"
                        f"{subskills_text}\n\n"
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
