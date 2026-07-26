"""Central MemoryManager — Orchestrates Local Markdown Memory & Honcho Provider.

Single integration point for prompt assembly, prefetching, and tool exposure.
Matches Hermes Agent's MemoryManager architecture.
"""

import logging
from typing import List, Dict, Any, Optional
from langchain_core.tools import BaseTool

from research_agent.memory.builtin_provider import (
    read_user_md,
    read_memory_md,
    add_memory,
    replace_memory,
    remove_memory,
    USER_CHAR_LIMIT,
    MEMORY_CHAR_LIMIT,
)
from research_agent.memory.smart_search import smart_search_memories
from research_agent.memory.honcho_provider import (
    is_honcho_configured,
    honcho_profile,
    honcho_search,
    honcho_reasoning,
    honcho_context,
    honcho_conclude,
)

logger = logging.getLogger(__name__)


class MemoryManager:
    """Orchestrates built-in local files (USER.md/MEMORY.md) plus optional Honcho Cloud provider tools."""

    def __init__(self) -> None:
        self._honcho_enabled = is_honcho_configured()

    def is_honcho_active(self) -> bool:
        """Check if Honcho provider is configured and active."""
        return is_honcho_configured()

    def build_system_prompt_context(
        self,
        user_id: str,
        workflow_id: str,
        user_message: str = "",
        thread_id: str = "",
    ) -> str:
        """Build injected memory context block for the system prompt.

        Includes ONLY:
        1. USER.md profile & preferences (capped at USER_CHAR_LIMIT)
        2. MEMORY.md persistent facts (capped at MEMORY_CHAR_LIMIT)

        No automatic Honcho prefetching is performed. Honcho memory tools remain
        available for manual retrieval if needed by the agent.
        """
        user_id_clean = str(user_id or "default_user").strip().lower().replace(" ", "_")
        workflow_id_clean = str(workflow_id or "default_workflow").strip().lower().replace(" ", "_")

        user_content = read_user_md(user_id_clean, workflow_id_clean)
        if len(user_content) > USER_CHAR_LIMIT:
            user_content = user_content[:USER_CHAR_LIMIT] + f"\n\n[USER.md truncated at {USER_CHAR_LIMIT} chars budget limit]"

        memory_content = read_memory_md(user_id_clean, workflow_id_clean)
        if len(memory_content) > MEMORY_CHAR_LIMIT:
            memory_content = memory_content[:MEMORY_CHAR_LIMIT] + f"\n\n[MEMORY.md truncated at {MEMORY_CHAR_LIMIT} chars budget limit]"

        blocks = []
        blocks.append(f"<!-- USER PROFILE (USER.md) -->\n{user_content}")
        blocks.append(f"<!-- PERSISTENT MEMORIES (MEMORY.md) -->\n{memory_content}")

        joined_content = "\n\n".join(blocks)

        print(f"[MemoryManager] Memory Breakdown: USER.md={len(user_content)}c | MEMORY.md={len(memory_content)}c | Total Injected={len(joined_content)}c")

        return (
            "<memory-context>\n"
            "[System note: The following is recalled memory context, "
            "NOT new user input. Treat as authoritative reference data — "
            "this is the agent's persistent memory and should inform all responses.]\n\n"
            f"{joined_content}\n"
            "</memory-context>"
        )

    def get_all_memory_tools(self) -> List[BaseTool]:
        """Return list of active memory tools exposed to agent."""
        tools = [
            add_memory,
            replace_memory,
            remove_memory,
        ]

        # Register Honcho tools if active
        if self.is_honcho_active():
            tools.extend([
                honcho_profile,
                honcho_search,
                honcho_reasoning,
                honcho_context,
                honcho_conclude,
            ])

        return tools


_memory_manager_instance: Optional[MemoryManager] = None


def get_memory_manager() -> MemoryManager:
    """Get singleton MemoryManager instance."""
    global _memory_manager_instance
    if _memory_manager_instance is None:
        _memory_manager_instance = MemoryManager()
    return _memory_manager_instance
