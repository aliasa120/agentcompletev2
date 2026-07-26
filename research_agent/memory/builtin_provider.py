"""Built-in Memory Provider — Local Markdown Storage (USER.md & MEMORY.md).

Manages workflow-scoped and user-scoped markdown files with full lifecycle
operations: add, replace, and remove.
"""

import os
import re
import logging
from pathlib import Path
from typing import Optional, Dict, Any
from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig

logger = logging.getLogger(__name__)

# Base memory directory inside workspace
DEFAULT_MEMORY_BASE_DIR = Path("data/memories")

# Hermes-style character budget limits
USER_CHAR_LIMIT = 1375   # ~300 tokens max for USER.md
MEMORY_CHAR_LIMIT = 2200 # ~500 tokens max for MEMORY.md


def get_char_limit(target: str, user_id: Optional[str] = None) -> int:
    """Return character budget limit for given target file, reading DB overrides if available."""
    is_user_file = target.upper().strip() == "USER.MD"
    default_limit = USER_CHAR_LIMIT if is_user_file else MEMORY_CHAR_LIMIT

    if user_id:
        try:
            from research_agent.tools.provider_engine import get_settings
            db_settings = get_settings(user_id)
            key = "memory_user_char_limit" if is_user_file else "memory_file_char_limit"
            if db_settings.get(key):
                val = int(db_settings[key])
                return max(500, min(val, 50000))
        except Exception:
            pass

    return default_limit


def _resolve_scope(
    config: Any = None,
    user_id: Optional[str] = None,
    workflow_id: Optional[str] = None
) -> tuple[str, str]:
    """Extract user_id and workflow_id from RunnableConfig, dict, ContextVars, or explicit parameters."""
    from research_agent.tools.provider_engine import get_active_user_id, get_active_workflow_id

    cfg = {}
    metadata = {}
    if isinstance(config, dict):
        cfg = config.get("configurable", {})
        metadata = config.get("metadata", {})
        if not cfg and not metadata:
            cfg = config
    elif hasattr(config, "configurable"):
        c = getattr(config, "configurable")
        if isinstance(c, dict):
            cfg = c
        m = getattr(config, "metadata", {})
        if isinstance(m, dict):
            metadata = m
    elif hasattr(config, "get"):
        cfg = config.get("configurable", {})
        metadata = config.get("metadata", {})

    final_user = (
        user_id
        or cfg.get("user_id")
        or metadata.get("user_id")
        or get_active_user_id()
        or "default_user"
    )
    final_wf = (
        workflow_id
        or cfg.get("workflow_id")
        or metadata.get("workflow_id")
        or get_active_workflow_id()
        or "default_workflow"
    )

    final_user_id = str(final_user).strip().lower().replace(" ", "_")
    final_workflow_id = str(final_wf).strip().lower().replace(" ", "_")
    return final_user_id, final_workflow_id


def get_memory_dir(user_id: str, workflow_id: str) -> Path:
    """Get path to scoped memory directory."""
    path = DEFAULT_MEMORY_BASE_DIR / user_id / workflow_id
    try:
        path.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        logger.error(f"Failed to create memory directory {path}: {e}")
    return path


def read_user_md(user_id: str, workflow_id: str) -> str:
    """Read USER.md for given user_id and workflow_id."""
    path = get_memory_dir(user_id, workflow_id) / "USER.md"
    if not path.exists():
        # Default template
        default_content = (
            f"# User Profile ({user_id})\n"
            f"Workflow Scope: {workflow_id}\n\n"
            "## Preferences\n"
            "- None recorded yet.\n\n"
            "## Standing Instructions\n"
            "- None recorded yet.\n"
        )
        path.write_text(default_content, encoding="utf-8")
        return default_content
    return path.read_text(encoding="utf-8")


def write_user_md(user_id: str, workflow_id: str, content: str) -> None:
    """Write USER.md for given user_id and workflow_id."""
    path = get_memory_dir(user_id, workflow_id) / "USER.md"
    path.write_text(content, encoding="utf-8")


def read_memory_md(user_id: str, workflow_id: str) -> str:
    """Read MEMORY.md for given user_id and workflow_id."""
    path = get_memory_dir(user_id, workflow_id) / "MEMORY.md"
    if not path.exists():
        default_content = (
            f"# Persistent Memories ({workflow_id})\n"
            f"User: {user_id}\n\n"
            "## General Facts\n"
            "- Initialized memory store.\n"
        )
        path.write_text(default_content, encoding="utf-8")
        return default_content
    return path.read_text(encoding="utf-8")


def write_memory_md(user_id: str, workflow_id: str, content: str) -> None:
    """Write MEMORY.md for given user_id and workflow_id."""
    path = get_memory_dir(user_id, workflow_id) / "MEMORY.md"
    path.write_text(content, encoding="utf-8")


# ── LangChain Lifecycle Tools ─────────────────────────────────────────────

@tool(parse_docstring=True)
def add_memory(
    fact: str,
    category: str = "General",
    target: str = "MEMORY.md",
    config: Optional[RunnableConfig] = None
) -> str:
    """Add a new fact or user preference to long-term persistent memory.

    Use this when you learn a new durable fact, preference, decision, or rule.

    Args:
        fact: The specific fact, preference, or instruction to save (e.g. 'User prefers concise bullet points')
        category: Category header under which to store the fact (e.g. 'Preferences', 'Project Decisions', 'Style Guide')
        target: Target file ('MEMORY.md' for facts/learnings, 'USER.md' for user profile/preferences). Defaults to 'MEMORY.md'.
        config: LangChain runnable configuration (automatically injected).
    """
    try:
        final_user_id, final_workflow_id = _resolve_scope(config)
        is_user_file = target.upper() == "USER.MD"
        
        current_content = read_user_md(final_user_id, final_workflow_id) if is_user_file else read_memory_md(final_user_id, final_workflow_id)
        
        # Check for category header or add it
        category_header = f"## {category}"
        new_entry = f"- {fact.strip()}"
        
        if category_header in current_content:
            # Append under existing category header
            parts = current_content.split(category_header)
            updated_content = parts[0] + category_header + f"\n{new_entry}" + parts[1]
        else:
            # Append category header and entry at the end
            updated_content = current_content.rstrip() + f"\n\n{category_header}\n{new_entry}\n"
            
        # Character budget limit check (Hermes memory enforcement)
        limit = get_char_limit(target, final_user_id)
        if len(updated_content) > limit:
            return (
                f"⚠️ Memory budget limit exceeded for {target} ({len(updated_content)} / {limit} chars). "
                f"Please use replace_memory or remove_memory to consolidate space before adding new memories."
            )

        if is_user_file:
            write_user_md(final_user_id, final_workflow_id, updated_content)
        else:
            write_memory_md(final_user_id, final_workflow_id, updated_content)
            
        return f"Successfully added memory to {target} (scope: user='{final_user_id}', workflow='{final_workflow_id}'): '{fact}' [{len(updated_content)}/{limit} chars]"
    except Exception as e:
        logger.error(f"Error in add_memory: {e}")
        return f"Error adding memory: {e}"


@tool(parse_docstring=True)
def replace_memory(
    old_fact: str,
    new_fact: str,
    target: str = "MEMORY.md",
    config: Optional[RunnableConfig] = None
) -> str:
    """Replace an existing outdated or modified memory fact with a new updated statement.

    Use this tool when a user preference or project fact changes (e.g. replacing 'User lives in Karachi' with 'User lives in Lahore').

    Args:
        old_fact: The substring, exact phrase, or old fact to replace.
        new_fact: The updated fact to put in its place.
        target: Target file ('MEMORY.md' or 'USER.md'). Defaults to 'MEMORY.md'.
        config: LangChain runnable configuration (automatically injected).
    """
    try:
        final_user_id, final_workflow_id = _resolve_scope(config)
        is_user_file = target.upper() == "USER.MD"
        current_content = read_user_md(final_user_id, final_workflow_id) if is_user_file else read_memory_md(final_user_id, final_workflow_id)

        # Look for exact or fuzzy match
        if old_fact.strip() in current_content:
            updated_content = current_content.replace(old_fact.strip(), new_fact.strip())
        else:
            # Try line-by-line regex search
            lines = current_content.splitlines()
            replaced = False
            new_lines = []
            pattern = re.escape(old_fact.strip())
            for line in lines:
                if re.search(pattern, line, re.IGNORECASE):
                    # Keep list formatting if present
                    prefix = "- " if line.strip().startswith("- ") else ""
                    new_lines.append(f"{prefix}{new_fact.strip()}")
                    replaced = True
                else:
                    new_lines.append(line)
            if not replaced:
                # If old_fact wasn't found, append new_fact
                new_lines.append(f"- {new_fact.strip()}")
            updated_content = "\n".join(new_lines)

        if is_user_file:
            write_user_md(final_user_id, final_workflow_id, updated_content)
        else:
            write_memory_md(final_user_id, final_workflow_id, updated_content)

        return f"Successfully replaced memory in {target} (scope: user='{final_user_id}', workflow='{final_workflow_id}'): '{old_fact}' -> '{new_fact}'"
    except Exception as e:
        logger.error(f"Error in replace_memory: {e}")
        return f"Error replacing memory: {e}"


@tool(parse_docstring=True)
def remove_memory(
    fact: str,
    target: str = "MEMORY.md",
    config: Optional[RunnableConfig] = None
) -> str:
    """Remove a fact or preference from persistent memory.

    Use this when a memory is invalidated, explicitly revoked, or incorrect.

    Args:
        fact: The substring or exact statement to remove.
        target: Target file ('MEMORY.md' or 'USER.md'). Defaults to 'MEMORY.md'.
        config: LangChain runnable configuration (automatically injected).
    """
    try:
        final_user_id, final_workflow_id = _resolve_scope(config)
        is_user_file = target.upper() == "USER.MD"
        current_content = read_user_md(final_user_id, final_workflow_id) if is_user_file else read_memory_md(final_user_id, final_workflow_id)

        lines = current_content.splitlines()
        pattern = re.escape(fact.strip())
        new_lines = [line for line in lines if not re.search(pattern, line, re.IGNORECASE)]

        updated_content = "\n".join(new_lines)

        if is_user_file:
            write_user_md(final_user_id, final_workflow_id, updated_content)
        else:
            write_memory_md(final_user_id, final_workflow_id, updated_content)

        return f"Successfully removed memory from {target} (scope: user='{final_user_id}', workflow='{final_workflow_id}'): '{fact}'"
    except Exception as e:
        logger.error(f"Error in remove_memory: {e}")
        return f"Error removing memory: {e}"
