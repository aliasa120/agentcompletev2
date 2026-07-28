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
from langchain_core.runnables import RunnableConfig

logger = logging.getLogger("manage_skill")


def _get_supabase_client():
    """Lazy-init a Supabase client."""
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
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
    agent_id: Optional[str] = None,
    parent_skill_key: Optional[str] = None,
    trust_state: Optional[str] = None,
    origin: Optional[str] = None,
    config: Optional[RunnableConfig] = None,
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
        agent_id: Optional agent ID (bound internally).
        parent_skill_key: Optional parent skill slug for hierarchical nesting.
        trust_state: Optional trust state ('provisional' or 'trusted').
        origin: Optional skill origin ('captured', 'derived', 'fix', 'user').

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

    configurable = config.get("configurable", {}) if config else {}
    user_id_val = configurable.get("user_id")

    # Tier 2: look up user_id from the agent_configs table using agent_id
    # (agent_id is reliably bound at graph compile time — this is the most robust path)
    if not user_id_val and agent_id:
        try:
            resp = client.table("agent_configs").select("user_id").eq("id", agent_id).execute()
            if resp.data and len(resp.data) > 0:
                user_id_val = resp.data[0].get("user_id")
                logger.debug(f"[manage_skill] Resolved user_id={user_id_val} from agent_id={agent_id}")
        except Exception as e:
            logger.warning(f"[manage_skill] Failed to resolve user_id from agent_id: {e}")

    # Tier 3: ContextVar last resort (unreliable across asyncio task boundaries, but worth trying)
    if not user_id_val:
        try:
            from research_agent.tools.provider_engine import active_user_id
            user_id_val = active_user_id.get()
        except Exception:
            pass

    if not user_id_val:
        return "❌ Action requires an active user context (user_id not found in config)."

    # We will call the manage_skill_admin RPC function
    params = {
        "p_action": action,
        "p_skill_key": skill_key,
        "p_user_id": user_id_val,
        "p_label": label,
        "p_description": description,
        "p_content": content,
        "p_category": category,
        "p_agent_id": agent_id,
        "p_parent_skill_key": parent_skill_key,
        "p_trust_state": trust_state,
        "p_origin": origin
    }


    try:
        resp = client.rpc("manage_skill_admin", params).execute()
        result = resp.data
        if not result or not result.get("success"):
            error_msg = result.get("error", "Unknown database error") if result else "No database response"
            return f"❌ Failed to {action} skill '{skill_key}': {error_msg}"
        
        # Trigger hot-reload by touching agent.py so the new skill list recompiles into system prompt immediately.
        # To prevent interrupting/cancelling the CURRENT active run on the live server, we perform this touch in a delayed background thread.
        try:
            repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            agent_py_path = os.path.join(repo_root, "agent.py")
            if os.path.exists(agent_py_path):
                import threading
                import time

                def delayed_touch():
                    time.sleep(10)  # Wait 10 seconds for the current run to finish generating and streaming the response
                    try:
                        os.utime(agent_py_path, None)
                        logger.info(f"[manage_skill] Asynchronously touched agent.py to trigger hot-reload for action '{action}' on skill '{skill_key}'.")
                    except Exception as err:
                        logger.warning(f"[manage_skill] Delayed touch of agent.py failed: {err}")

                threading.Thread(target=delayed_touch, daemon=True).start()
                logger.info(f"[manage_skill] Scheduled delayed hot-reload touch of agent.py in 10 seconds.")
        except Exception as touch_err:
            logger.warning(f"[manage_skill] Failed to schedule touch of agent.py for hot-reload: {touch_err}")

        data = result.get("data", {})
        if action == "create":
            logger.info(f"[manage_skill] ✅ Created skill '{skill_key}' in category '{category}' for user {user_id_val}")
            return (
                f"✅ Skill '{skill_key}' created successfully!\n"
                f"  Label: {data.get('label')}\n"
                f"  Category: {data.get('category')}\n"
                f"  Parent Skill: {data.get('parent_skill_key') or 'None'}\n"
                f"  Description: {data.get('description', '')[:100]}...\n"
                f"  Content: {len(data.get('content', ''))} characters\n\n"
                f"This skill will appear in the skills index for future conversations."
            )
        elif action == "update":
            logger.info(f"[manage_skill] ✅ Updated skill '{skill_key}' for user {user_id_val}")
            return (
                f"✅ Skill '{skill_key}' updated successfully!\n\n"
                f"Changes will be reflected in the skills index for future conversations."
            )
        elif action == "archive":
            logger.info(f"[manage_skill] 📦 Archived skill '{skill_key}' for user {user_id_val}")
            return (
                f"📦 Skill '{skill_key}' archived.\n"
                f"It will no longer appear in the skills index but remains in the database."
            )
    except Exception as e:
        logger.error(f"[manage_skill] Exception running manage_skill_admin RPC: {e}", exc_info=True)
        return f"❌ Database error: {e}"

    return "❌ Unknown action."
