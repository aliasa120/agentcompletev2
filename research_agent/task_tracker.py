"""Centralized in-flight task tracker & cancellation coordinator.

Manages active asyncio tasks and LangGraph run IDs across all platform gateways
(Telegram, Discord, Slack, Web API) to enable real-time out-of-band `/stop` cancellation.
"""

import asyncio
import logging
from typing import Optional, Any, Dict

logger = logging.getLogger("task_tracker")


class TaskTracker:
    """Thread-safe registry for active streaming runs per chat/thread."""

    _active_runs: Dict[str, Dict[str, Any]] = {}
    _lock = asyncio.Lock()

    @classmethod
    async def register_run(
        cls,
        key: str,
        task: asyncio.Task,
        run_id: Optional[str] = None,
        client: Optional[Any] = None,
        thread_id: Optional[str] = None,
    ) -> None:
        """Register an active run against a key (e.g. chat_id or thread_id)."""
        async with cls._lock:
            cls._active_runs[str(key)] = {
                "task": task,
                "run_id": run_id,
                "client": client,
                "thread_id": thread_id,
            }
            logger.debug(f"[TaskTracker] Registered active run for key: {key}")

    @classmethod
    async def set_run_id(cls, key: str, run_id: str) -> None:
        """Attach a resolved run_id to an existing active run."""
        async with cls._lock:
            if str(key) in cls._active_runs:
                cls._active_runs[str(key)]["run_id"] = run_id

    @classmethod
    async def unregister_run(cls, key: str) -> None:
        """Remove a run when completed or aborted."""
        async with cls._lock:
            cls._active_runs.pop(str(key), None)
            logger.debug(f"[TaskTracker] Unregistered run for key: {key}")

    @classmethod
    def is_running(cls, key: str) -> bool:
        """Check if a run is currently registered and active."""
        entry = cls._active_runs.get(str(key))
        if not entry:
            return False
        task = entry.get("task")
        return task is not None and not task.done()

    @classmethod
    async def cancel_run(cls, key: str) -> bool:
        """Cancel an in-flight run immediately."""
        async with cls._lock:
            entry = cls._active_runs.pop(str(key), None)

        if not entry:
            logger.info(f"[TaskTracker] No active run found to cancel for key: {key}")
            return False

        task = entry.get("task")
        run_id = entry.get("run_id")
        client = entry.get("client")
        thread_id = entry.get("thread_id")

        cancelled = False

        # 1. Cancel on LangGraph server if client and run_id available
        if client and thread_id and run_id:
            try:
                logger.info(f"[TaskTracker] Requesting LangGraph cancel for thread={thread_id}, run={run_id}")
                if asyncio.iscoroutinefunction(client.runs.cancel):
                    await client.runs.cancel(thread_id, run_id)
                else:
                    client.runs.cancel(thread_id, run_id)
                cancelled = True
            except Exception as e:
                logger.warning(f"[TaskTracker] LangGraph run cancel call failed: {e}")

        # 2. Cancel local asyncio task
        if task and not task.done():
            task.cancel()
            cancelled = True
            logger.info(f"[TaskTracker] Cancelled local asyncio task for key: {key}")

        return cancelled
