"""Thread-scoped Filesystem Backend for DeepAgents.

This module provides utilities to map each conversation thread (via thread_id)
to an isolated, physical workspace directory on disk (e.g. output/threads/{thread_id}/).
Directories are created strictly on-demand (only when a file, image, or output is written).
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Optional
from langchain_core.runnables import RunnableConfig
from deepagents.backends import FilesystemBackend

# Root of the workspace
WORKSPACE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUTPUT_ROOT = os.path.join(WORKSPACE_ROOT, "output")
THREADS_ROOT = os.path.join(OUTPUT_ROOT, "threads")

# Text files up to this size are mirrored into LangGraph state so the chat UI's
# FILE SYSTEM panel can open and edit them directly. Larger or binary files are
# served on demand by the thread-files API routes.
STATE_MIRROR_MAX_BYTES = 256 * 1024  # 256 KB
STATE_MIRROR_EXTENSIONS = {
    "md", "markdown", "txt", "csv", "tsv", "json", "yaml", "yml", "toml", "ini",
    "cfg", "conf", "log", "py", "js", "ts", "tsx", "jsx", "html", "htm", "css",
    "scss", "sql", "sh", "bash", "ps1", "bat", "xml", "svg", "env", "gitignore",
    "dockerfile", "makefile", "rst", "tex", "srt", "vtt",
}


def sanitize_thread_id(thread_id: Any) -> str:
    """Sanitize thread_id to be safe for directory names across OSes."""
    if not thread_id:
        return "default"
    raw = str(thread_id).strip()
    safe = re.sub(r'[^a-zA-Z0-9_\-.]', '_', raw)
    return safe or "default"


def get_thread_output_dir(thread_id_or_config: Any = None, create: bool = False) -> str:
    """Get the physical directory path for a thread.

    Args:
        thread_id_or_config: Either a thread_id string, a RunnableConfig dict,
                             or a ToolRuntime object.
        create: If True, creates the directory on disk. If False (default), only
                resolves the path without creating an empty folder.

    Returns:
        Absolute path to the thread's workspace directory.
    """
    thread_id = None

    if isinstance(thread_id_or_config, str):
        thread_id = thread_id_or_config
    elif isinstance(thread_id_or_config, dict):
        configurable = thread_id_or_config.get("configurable") or {}
        thread_id = configurable.get("thread_id")
    elif hasattr(thread_id_or_config, "config") and thread_id_or_config.config:
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
    if create:
        os.makedirs(thread_dir, exist_ok=True)
    return thread_dir


class ThreadFilesystemBackend(FilesystemBackend):
    """FilesystemBackend that dynamically routes file operations (read, write, edit, ls)
    to the active thread's workspace folder (output/threads/{thread_id}/).

    Files written here stay on local disk and are browsable/downloadable through
    the UI's thread-files routes. Cloud storage (Cloudflare R2 / Supabase) is used
    only when a shareable URL is actually needed:

      - the agent calls ``upload_to_storage`` explicitly (e.g. "give me the link"),
      - a social saver needs a public media URL,
      - or the operator opts back into blanket mirroring via agent_settings
        ``storage_auto_upload_files`` / env ``STORAGE_AUTO_UPLOAD_FILES``.

    Small text files are additionally mirrored into LangGraph state (``files``) so
    the chat UI's FILE SYSTEM panel can open and edit them without a round trip.
    """
    def __init__(self, root_dir: str = OUTPUT_ROOT, virtual_mode: bool = True):
        self._custom_root_dir = str(root_dir) if root_dir else OUTPUT_ROOT
        super().__init__(root_dir=root_dir, virtual_mode=virtual_mode)

    @property
    def cwd(self) -> Path:
        if hasattr(self, "_custom_root_dir") and self._custom_root_dir and self._custom_root_dir != OUTPUT_ROOT:
            return Path(self._custom_root_dir)
        target_dir = get_thread_output_dir(create=False)
        return Path(target_dir)

    @cwd.setter
    def cwd(self, value: Any) -> None:
        self._cwd = value

    def _resolve_path(self, key: str) -> Path:
        target_dir = self.cwd

        if self.virtual_mode:
            vpath = key if key.startswith("/") else "/" + key
            if ".." in vpath or vpath.startswith("~"):
                raise ValueError("Path traversal not allowed")
            if vpath.startswith("/tmp/"):
                tmp_dir = target_dir / "tmp"
                return (tmp_dir / vpath[5:]).resolve()
            full = (target_dir / vpath.lstrip("/")).resolve()
            return full

        path = Path(key)
        if path.is_absolute():
            return path
        return (target_dir / path).resolve()

    def _resolve_thread_id(self) -> Optional[str]:
        """Best-effort thread id for the current operation."""
        if getattr(self, "_custom_root_dir", None) and self._custom_root_dir != OUTPUT_ROOT:
            return Path(self._custom_root_dir).name
        try:
            from langchain_core.runnables.config import var_child_runnable_config
            cfg = var_child_runnable_config.get(None)
            if cfg:
                return (cfg.get("configurable") or {}).get("thread_id")
        except Exception:
            pass
        return None

    def _sync_to_storage(self, resolved_path: Path) -> Optional[str]:
        """Mirror a locally created/updated file to unified storage (R2-first).

        Opt-in only: returns None unless ``storage_auto_upload_files`` (or env
        ``STORAGE_AUTO_UPLOAD_FILES``) is enabled. Explicit uploads go through the
        ``upload_to_storage`` tool instead, so routine agent scratch files don't
        consume cloud storage or retention budget.
        """
        if not resolved_path.exists() or not resolved_path.is_file():
            return None
        try:
            from research_agent import storage_service

            if not storage_service.auto_upload_enabled():
                return None

            ext = resolved_path.suffix.lower().lstrip(".")
            if ext in ("png", "jpg", "jpeg", "webp", "gif", "svg"):
                category = "images"
            elif ext in ("mp3", "wav", "ogg", "m4a"):
                category = "audio"
            elif ext in ("mp4", "webm", "mov", "avi", "mkv"):
                category = "video"
            elif ext in ("pdf", "pptx", "ppt", "docx", "doc", "xlsx", "xls", "csv", "md", "txt"):
                category = "documents"
            else:
                category = "workspace"

            url = storage_service.upload_file(
                local_path=str(resolved_path),
                filename=resolved_path.name,
                category=category,
                thread_id=self._resolve_thread_id(),
            )
            return url
        except Exception as e:
            # Dual write is fail-safe; never disrupt local agent execution
            import logging
            logging.getLogger("research_agent.fs_backend").debug(f"Dual-write R2 sync skipped/failed: {e}")
            return None

    def _state_files_update(self, file_path: str, resolved_path: Path) -> Optional[dict]:
        """Content snapshot for LangGraph state so the UI can open the file.

        ``FilesystemBackend`` stores on disk and returns ``files_update=None``,
        which left the chat UI's FILE SYSTEM panel permanently empty. Mirroring
        small text files into state makes them viewable and editable there with no
        extra request. Binary and oversized files are skipped — those are served
        by the thread-files API routes instead.
        """
        try:
            if not resolved_path.is_file():
                return None
            if resolved_path.suffix.lower().lstrip(".") not in STATE_MIRROR_EXTENSIONS:
                return None
            if resolved_path.stat().st_size > STATE_MIRROR_MAX_BYTES:
                return None
            content = resolved_path.read_text(encoding="utf-8", errors="replace")
            key = file_path if file_path.startswith("/") else "/" + file_path
            return {key: content}
        except Exception:
            return None

    def _finalize_write(self, result: Any, file_path: str):
        """Run post-write side effects: optional cloud mirror + state mirror."""
        if getattr(result, "error", None) is not None:
            return result
        try:
            resolved = self._resolve_path(file_path)
            self._sync_to_storage(resolved)
            if getattr(result, "files_update", None) is None:
                files_update = self._state_files_update(file_path, resolved)
                if files_update:
                    try:
                        result = result.model_copy(update={"files_update": files_update})
                    except AttributeError:
                        try:
                            result.files_update = files_update
                        except Exception:
                            pass
        except Exception:
            pass
        return result

    def write(self, file_path: str, content: str):
        return self._finalize_write(super().write(file_path, content), file_path)

    def edit(self, file_path: str, old_string: str, new_string: str, replace_all: bool = False):
        result = super().edit(file_path, old_string, new_string, replace_all=replace_all)
        return self._finalize_write(result, file_path)

    def upload_files(self, files: list[tuple[str, bytes]]):
        responses = super().upload_files(files)
        for idx, (resp, (path, _)) in enumerate(zip(responses, files)):
            updated = self._finalize_write(resp, path)
            try:
                responses[idx] = updated
            except Exception:
                pass
        return responses

    def __call__(self, runtime: Any = None) -> FilesystemBackend:
        thread_dir = get_thread_output_dir(runtime, create=False)
        return ThreadFilesystemBackend(root_dir=thread_dir, virtual_mode=True)


# Export initialized instance that satisfies deepagents 0.7+ backend checks
thread_filesystem_backend = ThreadFilesystemBackend(root_dir=OUTPUT_ROOT, virtual_mode=True)
get_thread_filesystem_backend = thread_filesystem_backend
