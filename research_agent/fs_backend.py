"""Thread-scoped Filesystem Backend for DeepAgents.

This module provides utilities to map each conversation thread (via thread_id)
to an isolated, physical workspace directory on disk (e.g. output/threads/{thread_id}/).
This ensures that built-in tools (write_file, read_file, edit_file, ls) and the
OS shell terminal tool operate in the exact same physical folder.
"""

from __future__ import annotations

import os
import re
from typing import Any, Optional
from langchain_core.runnables import RunnableConfig
from deepagents.backends import FilesystemBackend

# Root of the workspace
WORKSPACE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUTPUT_ROOT = os.path.join(WORKSPACE_ROOT, "output")
THREADS_ROOT = os.path.join(OUTPUT_ROOT, "threads")


def sanitize_thread_id(thread_id: Any) -> str:
    """Sanitize thread_id to be safe for directory names across OSes."""
    if not thread_id:
        return "default"
    # Convert to string and replace characters unsafe in folder names
    raw = str(thread_id).strip()
    safe = re.sub(r'[^a-zA-Z0-9_\-.]', '_', raw)
    return safe or "default"


from pathlib import Path

def get_thread_output_dir(thread_id_or_config: Any = None) -> str:
    """Get or create the absolute physical directory path for a thread.

    Args:
        thread_id_or_config: Either a thread_id string, a RunnableConfig dict,
                             or a ToolRuntime object.

    Returns:
        Absolute path to the thread's workspace directory.
    """
    thread_id = None

    if isinstance(thread_id_or_config, str):
        thread_id = thread_id_or_config
    elif isinstance(thread_id_or_config, dict):
        # RunnableConfig dict
        configurable = thread_id_or_config.get("configurable") or {}
        thread_id = configurable.get("thread_id")
    elif hasattr(thread_id_or_config, "config") and thread_id_or_config.config:
        # ToolRuntime or object with .config attribute
        configurable = thread_id_or_config.config.get("configurable") or {}
        thread_id = configurable.get("thread_id")

    # If not provided, inspect current RunnableConfig from LangGraph context
    if not thread_id:
        try:
            from langchain_core.runnables.config import var_child_runnable_config
            cfg = var_child_runnable_config.get(None)
            if cfg:
                thread_id = (cfg.get("configurable") or {}).get("thread_id")
        except Exception:
            pass

    safe_id = sanitize_thread_id(thread_id or "default")
    thread_dir = os.path.abspath(os.path.join(THREADS_ROOT, safe_id))
    os.makedirs(thread_dir, exist_ok=True)
    return thread_dir


class ThreadFilesystemBackend(FilesystemBackend):
    """FilesystemBackend that dynamically routes file operations (read, write, edit, ls)
    to the active thread's workspace folder (output/threads/{thread_id}/).
    """
    def __init__(self, root_dir: str = OUTPUT_ROOT, virtual_mode: bool = True):
        super().__init__(root_dir=root_dir, virtual_mode=virtual_mode)

    @property
    def cwd(self) -> Path:
        target_dir = get_thread_output_dir()
        return Path(target_dir)

    @cwd.setter
    def cwd(self, value: Any) -> None:
        self._cwd = value

    def _resolve_path(self, key: str) -> Path:
        target_dir = Path(get_thread_output_dir())
        if self.virtual_mode:
            vpath = key if key.startswith("/") else "/" + key
            if ".." in vpath or vpath.startswith("~"):
                raise ValueError("Path traversal not allowed")
            if vpath.startswith("/tmp/"):
                tmp_dir = target_dir / "tmp"
                tmp_dir.mkdir(parents=True, exist_ok=True)
                return (tmp_dir / vpath[5:]).resolve()
            full = (target_dir / vpath.lstrip("/")).resolve()
            return full

        path = Path(key)
        if path.is_absolute():
            return path
        return (target_dir / path).resolve()

    def __call__(self, runtime: Any = None) -> FilesystemBackend:
        thread_dir = get_thread_output_dir(runtime)
        return FilesystemBackend(root_dir=thread_dir, virtual_mode=True)


# Export initialized instance that satisfies deepagents 0.7+ backend checks
thread_filesystem_backend = ThreadFilesystemBackend(root_dir=OUTPUT_ROOT, virtual_mode=True)
get_thread_filesystem_backend = thread_filesystem_backend
