"""manage_skill — Agent tool to create, update, and archive skills in the skills library.

This is the Hermes-style "self-improvement" mechanism. The agent calls this after
completing complex tasks to save its approach as a reusable skill, or to update
an existing skill that had issues.

Actions:
  - create: Save a new skill after learning something new
  - update: Patch an existing skill with corrections/improvements
  - archive: Mark a skill as archived (soft delete)
"""

import os
import json
import logging
from typing import Optional, Literal
from datetime import datetime, timezone

from langchain_core.tools import tool

logger = logging.getLogger("manage_skill")


def _get_supabase_client():
    """Lazy-init a Supabase client."""
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_ANON_KEY must be set")
    return create_client(url, key)


@tool(parse_docstring=True)
def manage_skill(
    action: str,
    skill_key: str,
    label: Optional[str] = None,
    description: Optional[str] = None,
    content: Optional[str] = None,
    category: Optional[str] = "general",
) -> str:
    """Create, update, or archive a skill in the skills library.

    Use this tool after completing complex tasks (5+ tool calls) to save
    your approach as a reusable skill. Also use it to fix/improve existing
    skills that you found to be outdated or incomplete during a task.

    Skill content should be in Markdown with YAML frontmatter:
    ---
    name: skill_name
    description: >-
      One-line summary of what this skill does (max 120 chars).
    category: general
    ---
    # Skill Title
    Step-by-step instructions...

    Args:
        action: One of 'create', 'update', or 'archive'.
        skill_key: Unique identifier for the skill (snake_case, e.g. 'web_research').
        label: Human-readable name (e.g. 'Web Research'). Required for 'create'.
        description: Short description (max 120 chars). Used in the skills index.
                     Required for 'create'.
        content: Full skill content in Markdown with optional YAML frontmatter.
                 Required for 'create', optional for 'update'.
        category: Skill category (e.g. 'research', 'content', 'publishing', 'general').

    Returns:
        Confirmation message with the action taken.
    """
    action = action.lower().strip()
    if action not in ("create", "update", "archive"):
        return f"❌ Invalid action '{action}'. Must be 'create', 'update', or 'archive'."

    try:
        client = _get_supabase_client()
    except Exception as e:
        return f"❌ Cannot connect to database: {e}"

    # ── CREATE ────────────────────────────────────────────────────────────
    if action == "create":
        if not label or not description or not content:
            return "❌ 'create' requires label, description, and content."

        # Check if skill already exists
        existing = client.table("skills_library").select("id").eq("skill_key", skill_key).execute()
        if existing.data:
            return (
                f"⚠️ Skill '{skill_key}' already exists. "
                f"Use action='update' to modify it, or choose a different skill_key."
            )

        row = {
            "skill_key": skill_key,
            "label": label,
            "description": description[:200],  # Truncate to keep index compact
            "content": content,
            "category": category or "general",
            "source": "agent",
            "state": "active",
            "created_by": "agent",
            "use_count": 0,
        }

        resp = client.table("skills_library").insert(row).execute()
        if resp.data:
            logger.info(f"[manage_skill] ✅ Created skill '{skill_key}' in category '{category}'")
            return (
                f"✅ Skill '{skill_key}' created successfully!\n"
                f"  Label: {label}\n"
                f"  Category: {category}\n"
                f"  Description: {description[:100]}...\n"
                f"  Content: {len(content)} characters\n\n"
                f"This skill will appear in the skills index for future conversations."
            )
        return f"❌ Failed to create skill '{skill_key}'."

    # ── UPDATE ────────────────────────────────────────────────────────────
    elif action == "update":
        existing = client.table("skills_library").select("id,content").eq("skill_key", skill_key).execute()
        if not existing.data:
            return f"❌ Skill '{skill_key}' not found. Use action='create' to create it first."

        updates = {"updated_at": datetime.now(timezone.utc).isoformat()}
        if content:
            updates["content"] = content
        if description:
            updates["description"] = description[:200]
        if label:
            updates["label"] = label
        if category:
            updates["category"] = category

        client.table("skills_library").update(updates).eq("skill_key", skill_key).execute()
        logger.info(f"[manage_skill] ✅ Updated skill '{skill_key}'")

        fields_updated = [k for k in updates if k != "updated_at"]
        return (
            f"✅ Skill '{skill_key}' updated successfully!\n"
            f"  Fields updated: {', '.join(fields_updated)}\n\n"
            f"Changes will be reflected in the skills index for future conversations."
        )

    # ── ARCHIVE ───────────────────────────────────────────────────────────
    elif action == "archive":
        existing = client.table("skills_library").select("id").eq("skill_key", skill_key).execute()
        if not existing.data:
            return f"❌ Skill '{skill_key}' not found."

        client.table("skills_library").update({
            "state": "archived",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("skill_key", skill_key).execute()
        logger.info(f"[manage_skill] 📦 Archived skill '{skill_key}'")
        return (
            f"📦 Skill '{skill_key}' archived.\n"
            f"It will no longer appear in the skills index but remains in the database."
        )

    return "❌ Unknown action."
