"""Hermes-style 3-Layer Memory Module for Research Agent."""

from .builtin_provider import (
    add_memory,
    replace_memory,
    remove_memory,
    read_user_md,
    read_memory_md,
    write_user_md,
    write_memory_md,
)
from .smart_search import smart_search_memories
from .memory_manager import MemoryManager, get_memory_manager

__all__ = [
    "add_memory",
    "replace_memory",
    "remove_memory",
    "read_user_md",
    "read_memory_md",
    "write_user_md",
    "write_memory_md",
    "smart_search_memories",
    "MemoryManager",
    "get_memory_manager",
]
