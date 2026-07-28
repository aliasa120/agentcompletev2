"""Tool Inspector — provides read-only tool schema definitions for the Skill Evolver."""

import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("skills_engine.tool_inspector")


def _get_active_agent_tools() -> List[Any]:
    """Collect all tools currently registered in research_agent."""
    tools = []
    try:
        from research_agent.tools.provider_engine import get_all_registered_tools
        tools = get_all_registered_tools()
    except Exception as e:
        logger.debug(f"Could not load tools from provider_engine: {e}")

    if not tools:
        try:
            from research_agent.tools import (
                read_skill, list_skills, manage_skill,
                unified_search, unified_extract, unified_image,
                save_to_supabase, youtube_transcript, wordpress_publisher
            )
            tools = [
                read_skill.read_skill,
                list_skills.list_skills,
                manage_skill.manage_skill,
                unified_search.unified_search,
                unified_extract.unified_extract,
                unified_image.unified_image,
                save_to_supabase.save_to_supabase,
                youtube_transcript.youtube_transcript,
                wordpress_publisher.wordpress_publisher,
            ]
        except Exception as e:
            logger.debug(f"Fallback direct import of tools failed: {e}")

    return tools


def get_tool_definition(tool_name: str) -> Optional[Dict[str, Any]]:
    """Return the exact schema definition for a specific tool by name."""
    tools = _get_active_agent_tools()
    for t in tools:
        name = getattr(t, "name", str(t))
        if name.lower() == tool_name.lower():
            return _format_tool_schema(t)
    return None


def get_all_tool_definitions(limit_tools: Optional[List[str]] = None) -> str:
    """Return formatted JSON definitions of all registered tools or specified subset."""
    tools = _get_active_agent_tools()
    formatted = []
    
    for t in tools:
        name = getattr(t, "name", str(t))
        if limit_tools and name.lower() not in [lt.lower() for lt in limit_tools]:
            continue
        formatted.append(_format_tool_schema(t))
        
    return json.dumps(formatted, indent=2)


def _format_tool_schema(t: Any) -> Dict[str, Any]:
    """Extract clean JSON schema from a LangChain or function tool."""
    name = getattr(t, "name", str(t))
    desc = getattr(t, "description", "")
    
    args_schema = {}
    if hasattr(t, "args_schema") and t.args_schema:
        try:
            args_schema = t.args_schema.schema()
        except Exception:
            args_schema = {}
    elif hasattr(t, "args") and isinstance(t.args, dict):
        args_schema = t.args
        
    return {
        "name": name,
        "description": desc,
        "parameters": args_schema.get("properties", args_schema),
        "required": args_schema.get("required", [])
    }


def get_skills_engine_tools(user_id: Optional[str] = None, agent_id: Optional[str] = None) -> List[Any]:
    """Return list_skills, read_skill, and manage_skill tools for Skills Engine AI agents."""
    try:
        from research_agent.tools.list_skills import list_skills
        from research_agent.tools.read_skill import read_skill
        from research_agent.tools.manage_skill import manage_skill
        return [list_skills, read_skill, manage_skill]
    except Exception as e:
        logger.error(f"[tool_inspector] Failed to import skills engine tools: {e}")
        return []


