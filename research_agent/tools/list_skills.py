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

logger = logging.getLogger("list_skills")

# Cache for the skills index (rebuilt every load_dynamic_agents_by_workflow call)
_cached_skills_index: Optional[str] = None


def _get_supabase_client():
    """Lazy-init a Supabase client."""
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY", "")
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
        assigned_skill_keys: Optional[list[str]] = None

        if agent_id:
            try:
                resp = client.table("agent_tool_assignments") \
                    .select("tool_key") \
                    .eq("agent_id", agent_id) \
                    .eq("tool_type", "skill") \
                    .eq("enabled", True) \
                    .execute()

                if resp.data and len(resp.data) > 0:
                    assigned_skill_keys = [r["tool_key"] for r in resp.data]
                    logger.info(
                        f"[build_skills_index] Agent {agent_id[:8]}... has "
                        f"{len(assigned_skill_keys)} assigned skills: {assigned_skill_keys}"
                    )
            except Exception as e:
                logger.warning(f"[build_skills_index] Failed to check skill assignments: {e}")

        # ── Step 2: Load skill metadata ───────────────────────────────────
        if assigned_skill_keys is not None and len(assigned_skill_keys) > 0:
            # Only load skills that are assigned to this agent
            resp = client.table("skills_library") \
                .select("skill_key, label, description, category") \
                .eq("state", "active") \
                .in_("skill_key", assigned_skill_keys) \
                .order("category") \
                .execute()
        else:
            # Fallback: load ALL active skills (no per-agent filtering)
            resp = client.table("skills_library") \
                .select("skill_key, label, description, category") \
                .eq("state", "active") \
                .order("category") \
                .execute()

        skills = resp.data or []
        if not skills:
            return ""

        # Group by category
        by_category: dict[str, list[dict]] = {}
        for s in skills:
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
def list_skills(category: Optional[str] = None) -> str:
    """List all available skills with their names, descriptions, and categories.

    Use this to discover what specialized knowledge is available before
    starting a task. Returns a compact summary — call read_skill() to load
    the full content of any skill you want to use.

    Args:
        category: Optional filter — only show skills in this category
                  (e.g. 'research', 'content', 'publishing', 'general').

    Returns:
        A formatted list of available skills with key, label, description,
        and category for each. Or a message if no skills are found.
    """
    try:
        client = _get_supabase_client()
        query = client.table("skills_library") \
            .select("skill_key, label, description, category, use_count, state, created_by") \
            .eq("state", "active")

        if category:
            query = query.eq("category", category)

        resp = query.order("category").execute()
        skills = resp.data or []

        if not skills:
            if category:
                return f"No active skills found in category '{category}'."
            return "No skills found in the skills library. You can create one with manage_skill(action='create')."

        # Group by category for display
        by_category: dict[str, list[dict]] = {}
        for s in skills:
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
            lines.append("")

        lines.append(
            "To load a skill's full instructions, call: read_skill(\"skill_key_name\")\n"
            "To create a new skill: manage_skill(action='create', skill_key='...', ...)"
        )

        return "\n".join(lines)

    except Exception as e:
        return f"❌ Error listing skills: {e}"
