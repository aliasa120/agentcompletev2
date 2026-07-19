"""list_skills — Returns a compact index of skills assigned to a specific agent.

Used by the agent to discover what skills exist before tackling a task.
Returns ONLY name + short description (like a library catalog), NOT full content.
The agent then calls read_skill() to load the full content of relevant skills.

Also provides build_skills_index(agent_id) which generates the compact skills block
that gets injected into the system prompt at agent startup — filtered by
agent_tool_assignments (tool_type='skill') so each agent only sees its own skills.
"""

import os
import logging
from typing import Optional

from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig

logger = logging.getLogger("list_skills")

# Cache for the skills index (rebuilt every load_dynamic_agents_by_workflow call)
_cached_skills_index: Optional[str] = None


def _get_supabase_client():
    """Lazy-init a Supabase client."""
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_ANON_KEY must be set")
    return create_client(url, key)


def build_skills_index(agent_id: Optional[str] = None) -> str:
    """Build a compact skills catalog for injection into the system prompt.

    If agent_id is provided, only shows skills that are assigned to that agent
    via agent_tool_assignments (tool_type='skill'). This is the Hermes-style
    per-agent skill filtering.

    If agent_id is None or no skill assignments exist, falls back to showing
    ALL active skills (backward compatible).

    Returns:
        A formatted skills index string, or empty string if no skills exist.
    """
    global _cached_skills_index
    try:
        client = _get_supabase_client()

        # ── Step 1: Check which skills are assigned to this agent ─────────
        attach_all_skills = False
        assigned_skill_keys: Optional[list[str]] = None
        user_id_val = None

        if agent_id:
            try:
                bootstrap_resp = client.rpc("get_backend_bootstrap_data").execute()
                bootstrap = bootstrap_resp.data or {}

                # Resolve attach_all_skills and user_id from bootstrap agent_configs
                configs = bootstrap.get("agent_configs") or []
                for cfg in configs:
                    if str(cfg.get("id")) == str(agent_id):
                        attach_all_skills = bool(cfg.get("attach_all_skills", False))
                        user_id_val = cfg.get("user_id")
                        break

                # Resolve assigned skill keys from bootstrap agent_tool_assignments
                assignments = bootstrap.get("agent_tool_assignments") or []
                assigned_skill_keys = [
                    a["tool_key"] for a in assignments
                    if str(a.get("agent_id")) == str(agent_id)
                    and a.get("tool_type") == "skill"
                    and a.get("enabled")
                ]

                logger.info(
                    f"[build_skills_index] Agent {agent_id[:8]}... has attach_all_skills={attach_all_skills}, "
                    f"assigned skills: {assigned_skill_keys}"
                )
            except Exception as e:
                logger.warning(f"[build_skills_index] Failed to fetch agent config via bootstrap RPC: {e}")

        # Call list_skills_admin RPC to bypass RLS
        resp = client.rpc("list_skills_admin", {"p_user_id": user_id_val}).execute()
        all_active_skills = resp.data or []

        if agent_id:
            skills = []
            for s in all_active_skills:
                s_key = s.get("skill_key")
                created_by = s.get("created_by_agent_id")
                
                is_general_or_self = False
                if attach_all_skills:
                    is_general_or_self = (created_by is None or str(created_by) == str(agent_id))
                
                is_manually_assigned = assigned_skill_keys is not None and s_key in assigned_skill_keys
                
                if is_general_or_self or is_manually_assigned:
                    skills.append(s)
        else:
            skills = all_active_skills
        if not skills:
            return ""

        # Group by category, separating parent and subskills
        parent_skills = [s for s in skills if not s.get("parent_skill_key")]
        subskills = [s for s in skills if s.get("parent_skill_key")]

        by_category: dict[str, list[dict]] = {}
        for s in parent_skills:
            cat = s.get("category", "general") or "general"
            by_category.setdefault(cat, []).append(s)

        # Build compact index
        lines = []
        for category in sorted(by_category.keys()):
            lines.append(f"  {category}:")
            for s in sorted(by_category[category], key=lambda x: x.get("skill_key", "")):
                name = s.get("skill_key", "unknown")
                desc = (s.get("description") or "")[:80]  # Truncate for compactness
                if desc:
                    lines.append(f"    - {name}: {desc}")
                else:
                    lines.append(f"    - {name}")
                
                matching_subs = [sub for sub in subskills if sub.get("parent_skill_key") == name]
                if matching_subs:
                    lines.append(f"      (subskills: {', '.join(sub.get('skill_key') for sub in matching_subs)})")

        index_body = "\n".join(lines)
        filter_note = (
            f"(filtered for this agent — {len(skills)} of "
            if assigned_skill_keys is not None
            else f"(all active — {len(skills)} "
        )

        result = (
            "## Skills (scan before every task)\n"
            "Before replying, scan the skills below. If a skill matches or is partially relevant "
            "to your task, you MUST load it with read_skill(skill_name) and follow its instructions. "
            "Skills contain specialized knowledge, proven workflows, and quality standards that "
            "outperform general-purpose approaches. Load the skill even if you think you already "
            "know how to handle the task.\n"
            "After completing a complex task (5+ tool calls), save your approach as a new skill "
            "using manage_skill(action='create'). If a loaded skill was wrong or incomplete, "
            "fix it with manage_skill(action='update') before finishing.\n\n"
            "<available_skills>\n"
            f"{index_body}\n"
            "</available_skills>\n\n"
            "Only proceed without loading a skill if genuinely none are relevant to the task."
        )

        _cached_skills_index = result
        logger.info(
            f"[build_skills_index] Built index with {len(skills)} skills "
            f"across {len(by_category)} categories "
            f"{'(agent-filtered)' if assigned_skill_keys else '(all active)'}"
        )
        return result

    except Exception as e:
        logger.warning(f"[build_skills_index] Failed to build index: {e}")
        return ""


@tool(parse_docstring=True)
def list_skills(category: Optional[str] = None, agent_id: Optional[str] = None, config: Optional[RunnableConfig] = None) -> str:
    """List all available skills with their names, descriptions, and categories.

    Use this to discover what specialized knowledge is available before
    starting a task. Returns a compact summary — call read_skill() to load
    the full content of any skill you want to use.

    Args:
        category: Optional filter — only show skills in this category
                  (e.g. 'research', 'content', 'publishing', 'general').
        agent_id: Optional agent ID filter — if provided, only lists skills
                  assigned to this specific agent.
        config: LangChain runnable configuration (automatically injected).
    """
    try:
        client = _get_supabase_client()
        
        configurable = config.get("configurable", {}) if config else {}
        user_id_val = configurable.get("user_id")

        # Fall back to active_user_id ContextVar (set by ResilientChatModel on every LLM invocation)
        if not user_id_val:
            try:
                from research_agent.tools.provider_engine import active_user_id as _active_uid
                user_id_val = _active_uid.get()
            except Exception:
                pass

        # Resolve user_id, attach_all_skills, and assigned_skill_keys from bootstrap RPC (bypasses RLS)
        attach_all_skills = False
        assigned_skill_keys = []

        if agent_id:
            try:
                bootstrap_resp = client.rpc("get_backend_bootstrap_data").execute()
                bootstrap = bootstrap_resp.data or {}

                # Resolve user_id and attach_all_skills from bootstrap agent_configs
                configs = bootstrap.get("agent_configs") or []
                for cfg in configs:
                    if str(cfg.get("id")) == str(agent_id):
                        attach_all_skills = bool(cfg.get("attach_all_skills", False))
                        if not user_id_val:
                            user_id_val = cfg.get("user_id")
                        break

                # Resolve assigned skill keys from bootstrap agent_tool_assignments
                assignments = bootstrap.get("agent_tool_assignments") or []
                assigned_skill_keys = [
                    a["tool_key"] for a in assignments
                    if str(a.get("agent_id")) == str(agent_id)
                    and a.get("tool_type") == "skill"
                    and a.get("enabled")
                ]
            except Exception as e:
                logger.warning(f"[list_skills] Failed to fetch agent configs via bootstrap RPC: {e}")

        # Call list_skills_admin RPC to bypass RLS
        resp = client.rpc("list_skills_admin", {"p_user_id": user_id_val}).execute()
        all_active_skills = resp.data or []

        # Filter by category if provided
        if category:
            all_active_skills = [s for s in all_active_skills if s.get("category") == category]

        if agent_id:
            skills = []
            for s in all_active_skills:
                s_key = s.get("skill_key")
                created_by = s.get("created_by_agent_id")
                
                is_general_or_self = False
                if attach_all_skills:
                    is_general_or_self = (created_by is None or str(created_by) == str(agent_id))
                
                is_manually_assigned = s_key in assigned_skill_keys
                
                if is_general_or_self or is_manually_assigned:
                    skills.append(s)
            
            if not skills:
                if attach_all_skills:
                    return "No skills are available (either general or self-created) for you."
                else:
                    return "No skills are assigned to you in the Settings UI. Please attach skills first."
        else:
            skills = all_active_skills

        if not skills:
            if category:
                return f"No active skills found in category '{category}'."
            return "No skills found in the skills library. You can create one with manage_skill(action='create')."

        # Separate main and subskills
        parent_skills = [s for s in skills if not s.get("parent_skill_key")]
        subskills = [s for s in skills if s.get("parent_skill_key")]

        # Group main skills by category
        by_category: dict[str, list[dict]] = {}
        for s in parent_skills:
            cat = s.get("category", "general") or "general"
            by_category.setdefault(cat, []).append(s)

        # Include orphan subskills (if parent is not visible)
        orphan_subs = [s for s in subskills if not any(p.get("skill_key") == s.get("parent_skill_key") for p in parent_skills)]
        for s in orphan_subs:
            cat = s.get("category", "general") or "general"
            by_category.setdefault(cat, []).append(s)

        lines = [f"📚 Available Skills ({len(skills)} total):\n"]
        for category_name in sorted(by_category.keys()):
            lines.append(f"  [{category_name.upper()}]")
            for s in sorted(by_category[category_name], key=lambda x: x.get("skill_key", "")):
                name = s.get("skill_key", "unknown")
                label = s.get("label", name)
                desc = s.get("description", "")[:100]
                uses = s.get("use_count", 0)
                creator = s.get("created_by", "user")
                
                lines.append(f"    • {name} ({label})")
                if desc:
                    lines.append(f"      {desc}")
                lines.append(f"      Uses: {uses} | Created by: {creator}")
                
                # Render subskills nested under their parent
                matching_subs = [sub for sub in subskills if sub.get("parent_skill_key") == name]
                if matching_subs:
                    lines.append("      ↳ Subskills:")
                    for sub in sorted(matching_subs, key=lambda x: x.get("skill_key", "")):
                        sub_name = sub.get("skill_key", "unknown")
                        sub_label = sub.get("label", sub_name)
                        sub_desc = sub.get("description", "")[:100]
                        lines.append(f"        * {sub_name} ({sub_label})")
                        if sub_desc:
                            lines.append(f"          {sub_desc}")
            lines.append("")

        lines.append(
            "To load a skill's full instructions, call: read_skill(\"skill_key_name\")\n"
            "To create a new skill: manage_skill(action='create', skill_key='...', ...)"
        )

        return "\n".join(lines)

    except Exception as e:
        return f"❌ Error listing skills: {e}"
