"""search_conversation_history — Hermes-style 3-Strategy Smart Search Tool.

Searches through workflow-scoped and user-scoped conversation history and memory files
using 3 parallel strategies (Full-Text, Semantic, Entity Probe) combined via RRF ranking.
"""

import logging
from typing import Optional
from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig
from research_agent.memory.smart_search import smart_search_memories
from research_agent.memory.builtin_provider import _resolve_scope

logger = logging.getLogger("search_conversation_history")


@tool(parse_docstring=True)
def search_conversation_history(
    query: str,
    config: Optional[RunnableConfig] = None
) -> str:
    """Search through past conversation history messages, user profile, and memory files using 3-strategy smart search (Full-Text + Semantic + Entity Probe).

    Use this tool when you need to recall details, context, facts, decisions, or user preferences
    from previous messages, sessions, or stored memory files.

    Args:
        query: The search query, keywords, topic, or question to look for.
        config: LangChain runnable configuration (automatically injected).
    """
    try:
        user_id, workflow_id = _resolve_scope(config)
        return smart_search_memories(
            query=query,
            user_id=user_id,
            workflow_id=workflow_id,
            limit=12
        )
    except Exception as e:
        logger.error(f"Error in search_conversation_history: {e}")
        return f"❌ Error searching conversation history: {e}"


# Alias for backward compatibility / agent tool lookup
search_memories = search_conversation_history

