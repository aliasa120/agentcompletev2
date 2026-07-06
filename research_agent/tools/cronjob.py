"""cronjob — Unified scheduled background task manager tool.

Exposes a single tool with action: create, list, update, pause, resume, remove, and run.
Persisted natively inside Supabase table `agent_scheduled_tasks`.
"""

import os
import json
import logging
import re
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any

from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig

logger = logging.getLogger("cronjob")

try:
    from croniter import croniter
    HAS_CRONITER = True
except ImportError:
    HAS_CRONITER = False


def _get_supabase_client():
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_ANON_KEY must be set")
    return create_client(url, key)


def _get_now() -> datetime:
    tz_env = os.getenv("HERMES_TIMEZONE", "").strip()
    if tz_env:
        try:
            from zoneinfo import ZoneInfo
            return datetime.now(ZoneInfo(tz_env))
        except Exception:
            pass
    return datetime.now().astimezone()


def parse_duration(s: str) -> int:
    s = s.strip().lower()
    match = re.match(r'^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$', s)
    if not match:
        raise ValueError(f"Invalid duration: '{s}'. Use format like '30m', '2h', or '1d'")
    value = int(match.group(1))
    unit = match.group(2)[0]  # First char: m, h, or d
    multipliers = {'m': 1, 'h': 60, 'd': 1440}
    return value * multipliers[unit]


def parse_schedule(schedule: str) -> Dict[str, Any]:
    schedule = schedule.strip()
    original = schedule
    schedule_lower = schedule.lower()
    
    # "every X" pattern → interval
    if schedule_lower.startswith("every "):
        duration_str = schedule[6:].strip()
        minutes = parse_duration(duration_str)
        return {
            "kind": "interval",
            "minutes": minutes,
            "display": f"every {minutes}m"
        }
    
    # Check for cron expression
    parts = schedule.split()
    if len(parts) >= 5 and all(re.match(r'^[\d\*\-,/]+$', p) for p in parts[:5]):
        if not HAS_CRONITER:
            raise ValueError("Cron expressions require 'croniter' package.")
        try:
            croniter(schedule)
        except Exception as e:
            raise ValueError(f"Invalid cron expression '{schedule}': {e}")
        return {
            "kind": "cron",
            "expr": schedule,
            "display": schedule
        }
    
    # ISO timestamp
    if 'T' in schedule or re.match(r'^\d{4}-\d{2}-\d{2}', schedule):
        try:
            dt = datetime.fromisoformat(schedule.replace('Z', '+00:00'))
            if dt.tzinfo is None:
                tz_env = os.getenv("HERMES_TIMEZONE", "").strip()
                if tz_env:
                    try:
                        from zoneinfo import ZoneInfo
                        dt = dt.replace(tzinfo=ZoneInfo(tz_env))
                    except Exception:
                        dt = dt.astimezone()
                else:
                    dt = dt.astimezone()
            return {
                "kind": "once",
                "run_at": dt.isoformat(),
                "display": f"once at {dt.strftime('%Y-%m-%d %H:%M')}"
            }
        except ValueError as e:
            raise ValueError(f"Invalid timestamp '{schedule}': {e}")
            
    # Duration like "30m", "2h", "1d" → one-shot
    try:
        minutes = parse_duration(schedule)
        run_at = _get_now() + timedelta(minutes=minutes)
        return {
            "kind": "once",
            "run_at": run_at.isoformat(),
            "display": f"once in {original}"
        }
    except ValueError:
        pass
        
    raise ValueError(
        f"Invalid schedule '{original}'. Use:\n"
        f"  - Duration: '30m', '2h', '1d' (one-shot)\n"
        f"  - Interval: 'every 30m', 'every 2h' (recurring)\n"
        f"  - Cron: '0 9 * * *' (cron expression)\n"
        f"  - Timestamp: '2026-02-03T14:00:00' (one-shot at time)"
    )


def compute_next_run(schedule: Dict[str, Any], last_run_at: Optional[str] = None) -> Optional[str]:
    now = _get_now()
    kind = schedule.get("kind")
    
    if kind == "once":
        if last_run_at:
            return None
        run_at = schedule.get("run_at")
        if not run_at:
            return None
        run_at_dt = datetime.fromisoformat(run_at)
        if run_at_dt.tzinfo is None:
            run_at_dt = run_at_dt.astimezone()
        
        # Eligible to run if in the future, or in past but within grace window (e.g. 5 minutes)
        if run_at_dt >= now - timedelta(seconds=300):
            return run_at
        return None
        
    elif kind == "interval":
        minutes = schedule["minutes"]
        if last_run_at:
            last = datetime.fromisoformat(last_run_at)
            if last.tzinfo is None:
                last = last.astimezone()
            next_run = last + timedelta(minutes=minutes)
        else:
            next_run = now + timedelta(minutes=minutes)
        return next_run.isoformat()
        
    elif kind == "cron":
        if not HAS_CRONITER:
            return None
        base_time = now
        if last_run_at:
            base_time = datetime.fromisoformat(last_run_at)
            if base_time.tzinfo is None:
                base_time = base_time.astimezone()
        cron = croniter(schedule["expr"], base_time)
        next_run = cron.get_next(datetime)
        return next_run.isoformat()
        
    return None


@tool(parse_docstring=True)
def cronjob(
    action: str,
    job_id: Optional[str] = None,
    prompt: Optional[str] = None,
    schedule: Optional[str] = None,
    name: Optional[str] = None,
    repeat: Optional[int] = None,
    deliver: Optional[str] = "local",
    skills: Optional[List[str]] = None,
    model: Optional[str] = None,
    provider: Optional[str] = None,
    base_url: Optional[str] = None,
    script: Optional[str] = None,
    no_agent: Optional[bool] = False,
    context_from: Optional[List[str]] = None,
    enabled_toolsets: Optional[List[str]] = None,
    workdir: Optional[str] = None,
    config: Optional[RunnableConfig] = None,
) -> str:
    """Manage scheduled background tasks for agents (unified scheduling system).

    Allows you to create, view, pause, resume, run, and delete background tasks.
    Tasks are persisted in the database and executed by a background scheduler daemon.

    Important rules:
      - Always run action='list' first before updating/pausing/deleting, to retrieve the correct job_id.
      - Tasks run in isolated sessions with no active chat context. Prompts must be self-contained.
      - If B depends on A, schedule A first to get its ID, then schedule B with context_from=[A's ID].

    Args:
        action: The operation to execute: 'create', 'list', 'update', 'pause', 'resume', 'remove', 'run'.
        job_id: The unique ID of the target job (required for update, pause, resume, remove, run).
        prompt: The task instruction prompt (required for create when no_agent=False).
        schedule: The scheduling rule (required for create). Examples: '30m' (in 30 mins), 'every 2h', '0 9 * * *' (daily at 9am), or ISO timestamp.
        name: A human-friendly name/title for the task.
        repeat: Optional number of times to run. Omit or 0/negative for infinite.
        deliver: Where to send final outputs: 'local' (only logs, default), 'origin' (back to creation chat), or a platform:chat_id string.
        skills: List of skill names to load before running.
        model: Per-job LLM model override (e.g. 'google/gemini-2.5-flash').
        provider: Per-job LLM provider override (e.g. 'vercel', 'ninerouter').
        base_url: Custom API endpoint URL override.
        script: Path to Python/Bash script for data retrieval or watchdog checks.
        no_agent: If True, execute the script directly and skip LLM agent execution entirely.
        context_from: List of upstream job IDs whose outputs will be injected as context.
        enabled_toolsets: Allowed toolsets (e.g. ['web', 'file']) to prevent context bloat.
        workdir: Subprocess directory where the terminal/file tools should run from.
        config: LangChain runnable configuration (automatically injected).
    """
    client = _get_supabase_client()
    action = action.strip().lower()

    try:
        if action == "create":
            if not schedule:
                return json.dumps({"success": False, "error": "Missing required parameter 'schedule' for create action."})
            
            if not no_agent and not prompt:
                return json.dumps({"success": False, "error": "Parameter 'prompt' is required unless no_agent=True."})
            
            if no_agent and not script:
                return json.dumps({"success": False, "error": "Parameter 'script' is required when no_agent=True."})

            parsed_schedule = parse_schedule(schedule)
            next_run_at = compute_next_run(parsed_schedule)

            # Resolve config from context variables if it is missing (due to tool parameter stripping)
            if not config:
                try:
                    from langgraph.config import get_config
                    config = get_config()
                    logger.info(f"[cronjob] ContextVar fallback: retrieved config from langgraph.config: {config}")
                except Exception as e:
                    logger.debug(f"[cronjob] ContextVar langgraph.config lookup failed: {e}")

            if not config:
                try:
                    from langchain_core.runnables.config import var_child_runnable_config
                    config = var_child_runnable_config.get()
                    logger.info(f"[cronjob] ContextVar fallback: retrieved config from var_child_runnable_config: {config}")
                except Exception as e:
                    logger.debug(f"[cronjob] ContextVar var_child_runnable_config lookup failed: {e}")

            workflow_id = None
            thread_id = None
            logger.info(f"[cronjob] Final resolved config: {config}")
            if config:
                configurable = config.get("configurable", {})
                logger.info(f"[cronjob] Configurable fields: {configurable}")
                workflow_id = configurable.get("workflow_id")
                thread_id = configurable.get("thread_id")

            if thread_id and not workflow_id:
                try:
                    sess_resp = client.table("sessions").select("workflow_id").eq("id", thread_id).execute()
                    if sess_resp.data and sess_resp.data[0].get("workflow_id"):
                        workflow_id = sess_resp.data[0].get("workflow_id")
                        logger.info(f"[cronjob] Resolved workflow_id '{workflow_id}' from sessions table for thread '{thread_id}'")
                except Exception as e:
                    logger.warning(f"[cronjob] Failed to resolve workflow_id from sessions table: {e}")

            # Resolve delivery target
            delivery_target = deliver or "local"
            if delivery_target == "origin" and thread_id:
                delivery_target = f"thread:{thread_id}"

            if not name:
                if prompt:
                    name = prompt[:45] + "..." if len(prompt) > 45 else prompt
                elif script:
                    name = os.path.basename(script)
                else:
                    name = "Cron Task"

            task_row = {
                "name": name,
                "prompt": prompt,
                "skills": skills or [],
                "model": model,
                "provider": provider,
                "base_url": base_url,
                "script": script,
                "no_agent": bool(no_agent),
                "context_from": context_from or [],
                "schedule": parsed_schedule,
                "schedule_display": parsed_schedule.get("display", schedule),
                "repeat_times": repeat if repeat and repeat > 0 else None,
                "enabled": True,
                "state": "scheduled",
                "deliver": delivery_target,
                "enabled_toolsets": enabled_toolsets or [],
                "workdir": workdir,
                "next_run_at": next_run_at,
                "origin": {"workflow_id": str(workflow_id)} if workflow_id else {},
            }

            resp = client.table("agent_scheduled_tasks").insert(task_row).execute()
            if not resp.data:
                return json.dumps({"success": False, "error": "Failed to insert task in database."})
            
            new_task = resp.data[0]
            return json.dumps({
                "success": True,
                "message": f"Successfully created scheduled task '{new_task['name']}'",
                "task": {
                    "id": new_task["id"],
                    "name": new_task["name"],
                    "schedule": new_task["schedule_display"],
                    "next_run_at": new_task["next_run_at"]
                }
            }, indent=2)

        elif action == "list":
            resp = client.table("agent_scheduled_tasks").select("id, name, schedule_display, enabled, state, next_run_at, last_run_at, last_status").order("created_at", desc=True).execute()
            tasks = resp.data or []
            return json.dumps({"success": True, "tasks": tasks}, indent=2)

        elif action in ["update", "pause", "resume", "remove", "run"]:
            if not job_id:
                return json.dumps({"success": False, "error": f"Parameter 'job_id' is required for action '{action}'."})

            # Check if task exists
            task_resp = client.table("agent_scheduled_tasks").select("*").eq("id", job_id).execute()
            if not task_resp.data:
                return json.dumps({"success": False, "error": f"Task with ID '{job_id}' not found."})
            
            task = task_resp.data[0]

            if action == "remove":
                client.table("agent_scheduled_tasks").delete().eq("id", job_id).execute()
                return json.dumps({"success": True, "message": f"Task '{task['name']}' successfully removed."})

            elif action == "pause":
                updates = {
                    "enabled": False,
                    "state": "paused",
                    "paused_at": _get_now().isoformat(),
                }
                upd_resp = client.table("agent_scheduled_tasks").update(updates).eq("id", job_id).execute()
                return json.dumps({"success": True, "message": f"Task '{task['name']}' paused.", "task": upd_resp.data[0]}, indent=2)

            elif action == "resume":
                updates = {
                    "enabled": True,
                    "state": "scheduled",
                    "paused_at": None,
                    "next_run_at": compute_next_run(task["schedule"])
                }
                upd_resp = client.table("agent_scheduled_tasks").update(updates).eq("id", job_id).execute()
                return json.dumps({"success": True, "message": f"Task '{task['name']}' resumed.", "task": upd_resp.data[0]}, indent=2)

            elif action == "run":
                # Set next_run_at to now to trigger immediately
                updates = {
                    "next_run_at": _get_now().isoformat(),
                    "state": "scheduled",
                    "enabled": True
                }
                upd_resp = client.table("agent_scheduled_tasks").update(updates).eq("id", job_id).execute()
                return json.dumps({"success": True, "message": f"Task '{task['name']}' triggered for immediate execution."}, indent=2)

            elif action == "update":
                updates = {}
                if prompt is not None:
                    updates["prompt"] = prompt
                if name is not None:
                    updates["name"] = name
                if repeat is not None:
                    updates["repeat_times"] = repeat if repeat > 0 else None
                if deliver is not None:
                    updates["deliver"] = deliver
                if skills is not None:
                    updates["skills"] = skills
                if model is not None:
                    updates["model"] = model
                if provider is not None:
                    updates["provider"] = provider
                if base_url is not None:
                    updates["base_url"] = base_url
                if script is not None:
                    updates["script"] = script
                if no_agent is not None:
                    updates["no_agent"] = bool(no_agent)
                if context_from is not None:
                    updates["context_from"] = context_from
                if enabled_toolsets is not None:
                    updates["enabled_toolsets"] = enabled_toolsets
                if workdir is not None:
                    updates["workdir"] = workdir
                
                if schedule is not None:
                    parsed_schedule = parse_schedule(schedule)
                    updates["schedule"] = parsed_schedule
                    updates["schedule_display"] = parsed_schedule.get("display", schedule)
                    if task.get("state") != "paused":
                        updates["next_run_at"] = compute_next_run(parsed_schedule)
                
                if not updates:
                    return json.dumps({"success": False, "error": "No update fields provided."})

                upd_resp = client.table("agent_scheduled_tasks").update(updates).eq("id", job_id).execute()
                return json.dumps({"success": True, "message": f"Task '{task['name']}' updated.", "task": upd_resp.data[0]}, indent=2)

        return json.dumps({"success": False, "error": f"Unknown action '{action}'."})

    except Exception as e:
        logger.error(f"Error in cronjob tool: {e}", exc_info=True)
        return json.dumps({"success": False, "error": str(e)})
