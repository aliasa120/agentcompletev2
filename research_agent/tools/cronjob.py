"""cronjob — Unified scheduled background task manager tool.

Exposes a single tool with action: create, list, update, pause, resume, remove, and run.
Persisted natively inside Supabase table `agent_scheduled_tasks`.
"""

import os
import json
import logging
import re
from datetime import datetime, date, timedelta, timezone as dt_timezone
from typing import Optional, List, Dict, Any, Union, Tuple

from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig

logger = logging.getLogger("cronjob")

try:
    from croniter import croniter
    HAS_CRONITER = True
except ImportError:
    HAS_CRONITER = False

USER_TIMEZONE_SETTING_KEY = "timezone"


def _resolve_tz(tz: Optional[str]) -> Optional[str]:
    """Validate and normalize an IANA timezone name. Returns None if invalid/empty."""
    if not tz or not str(tz).strip():
        return None
    tz = str(tz).strip()
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo(tz)
        return tz
    except Exception:
        return None


def get_user_timezone(client, user_id: Optional[str]) -> Optional[str]:
    """Fetch the user's scheduler timezone preference from agent_settings."""
    if not user_id:
        return None
    try:
        resp = (
            client.table("agent_settings")
            .select("value")
            .eq("user_id", str(user_id))
            .eq("key", USER_TIMEZONE_SETTING_KEY)
            .maybe_single()
            .execute()
        )
        if resp.data and resp.data.get("value"):
            return _resolve_tz(resp.data["value"])
    except Exception as e:
        logger.debug(f"[cronjob] Could not fetch user timezone preference: {e}")
    return None


def _get_now(tz: Optional[str] = None) -> datetime:
    """Current time in the given tz; falls back to HERMES_TIMEZONE env then server local."""
    tz_name = _resolve_tz(tz) or os.getenv("HERMES_TIMEZONE", "").strip()
    if tz_name:
        try:
            from zoneinfo import ZoneInfo
            return datetime.now(ZoneInfo(tz_name))
        except Exception:
            pass
    return datetime.now().astimezone()


def _parse_iso(value: str) -> datetime:
    """Parse an ISO timestamp; naive values are assumed UTC."""
    dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=dt_timezone.utc)
    return dt


def _to_utc_iso(dt: datetime) -> str:
    """Convert a datetime to a UTC ISO string (Z suffix) — canonical storage format."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=dt_timezone.utc)
    dt_utc = dt.astimezone(dt_timezone.utc)
    return dt_utc.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def now_utc_iso() -> str:
    return _to_utc_iso(datetime.now(dt_timezone.utc))


def format_in_tz(iso_value: str, tz: Optional[str] = None) -> str:
    """Render an ISO timestamp as a human-friendly local time string in the given tz."""
    try:
        dt = _parse_iso(iso_value)
        tz_name = _resolve_tz(tz)
        if tz_name:
            from zoneinfo import ZoneInfo
            dt = dt.astimezone(ZoneInfo(tz_name))
        return dt.strftime("%Y-%m-%d %H:%M (%Z)")
    except Exception:
        return str(iso_value)


def _get_supabase_client():
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    key = service_key or os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY must be set")
    if not service_key:
        logger.warning("[cronjob] SUPABASE_SERVICE_ROLE_KEY is missing from environment. Falling back to SUPABASE_ANON_KEY, which may fail due to Row-Level Security (RLS) policies.")
    return create_client(url, key)


def parse_duration(s: str) -> int:
    s = s.strip().lower()
    match = re.match(r'^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$', s)
    if not match:
        raise ValueError(f"Invalid duration: '{s}'. Use format like '30m', '2h', or '1d'")
    value = int(match.group(1))
    unit = match.group(2)[0]  # First char: m, h, or d
    multipliers = {'m': 1, 'h': 60, 'd': 1440}
    return value * multipliers[unit]


# ── Natural-language date/time resolution ────────────────────────────────────
_WEEKDAYS = {
    "monday": 0, "mon": 0,
    "tuesday": 1, "tue": 1, "tues": 1,
    "wednesday": 2, "wed": 2,
    "thursday": 3, "thu": 3, "thur": 3, "thurs": 3,
    "friday": 4, "fri": 4,
    "saturday": 5, "sat": 5,
    "sunday": 6, "sun": 6,
}

# "14:55" | "2:55 PM" | "2pm" | "9 am" | "14:55:30"
_CLOCK_RE = re.compile(
    r'^(?P<hour>\d{1,2})'
    r'(?::(?P<minute>\d{2}))?'
    r'(?::(?P<second>\d{2}))?'
    r'\s*(?P<ampm>am|pm|a\.m\.|p\.m\.)?$'
)


def _parse_clock(text: str) -> Optional[Tuple[int, int, int]]:
    """Parse a wall-clock time like '14:55', '2:55 PM', '3.40pm', '9am' → (h, m, s)."""
    t = text.strip().lower()
    t = re.sub(r'\ba\.m\.?', 'am', t)
    t = re.sub(r'\bp\.m\.?', 'pm', t)
    # Dot/dash used as an hour:minute separator ("3.40pm", "3-40")
    t = re.sub(r'(?<=\d)[.\-](?=\d)', ':', t)
    t = re.sub(r'\s+', '', t)
    t = re.sub(r'(am|pm)$', r' \1', t).strip()
    m = _CLOCK_RE.match(t)
    if not m:
        return None
    hour = int(m.group("hour"))
    minute = int(m.group("minute") or 0)
    second = int(m.group("second") or 0)
    ampm = m.group("ampm")
    if ampm:
        ampm = ampm[0]  # 'a' or 'p'
        if hour < 1 or hour > 12:
            return None
        if ampm == "p" and hour != 12:
            hour += 12
        elif ampm == "a" and hour == 12:
            hour = 0
    else:
        # Bare number with no minutes and no am/pm (e.g. "5") is ambiguous → reject
        if m.group("minute") is None:
            return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59 and 0 <= second <= 59):
        return None
    return hour, minute, second


def _parse_natural_datetime(text: str, tz: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Resolve a natural-language date/time phrase against the CURRENT date in ``tz``.

    Supported forms (case-insensitive, optional leading 'at'/'on'):
      - Time only, anchored to TODAY:  '14:55', '2:55 PM', 'at 9:00', 'today at 2:55 PM'
      - Tomorrow:                      'tomorrow', 'tomorrow at 9am', 'tomorrow 09:30'
      - Tonight / this evening:        'tonight', 'tonight at 8pm'
      - Weekday:                       'monday at 9am', 'next friday 18:00'
      - Relative:                      'in 30 minutes', 'in 2 hours', 'in 1 day'

    Returns ``{"dt": datetime, "anchor": str, "rolled_over": bool}`` or None when the
    phrase is not a recognisable natural date/time.
    """
    raw = str(text).strip()
    s = raw.lower().strip()
    if not s:
        return None

    now = _get_now(tz)
    tzinfo = now.tzinfo

    # "in 30 minutes" / "in 2h" → relative offset from NOW
    rel = re.match(r'^in\s+(.+)$', s)
    if rel:
        try:
            minutes = parse_duration(rel.group(1).strip())
        except ValueError:
            return None
        return {"dt": now + timedelta(minutes=minutes), "anchor": "relative", "rolled_over": False}

    s = re.sub(r'^(on|at)\s+', '', s)

    day_offset = 0
    anchor = "today"
    target_weekday: Optional[int] = None
    evening_bias = False

    day_words = [
        (r'^today\b', 0, "today"),
        (r'^tonight\b', 0, "today"),
        (r'^this\s+evening\b', 0, "today"),
        (r'^this\s+morning\b', 0, "today"),
        (r'^this\s+afternoon\b', 0, "today"),
        (r'^tomorrow\b', 1, "tomorrow"),
        (r'^tmr\b', 1, "tomorrow"),
        (r'^tmrw\b', 1, "tomorrow"),
        (r'^day\s+after\s+tomorrow\b', 2, "day after tomorrow"),
    ]
    for pattern, offset, label in day_words:
        if re.match(pattern, s):
            if "evening" in pattern or "tonight" in pattern:
                evening_bias = True
            day_offset = offset
            anchor = label
            s = re.sub(pattern, '', s, count=1).strip()
            break
    else:
        wd = re.match(r'^(?:next\s+|this\s+|coming\s+)?([a-z]+)\b', s)
        if wd and wd.group(1) in _WEEKDAYS:
            target_weekday = _WEEKDAYS[wd.group(1)]
            forced_next = bool(re.match(r'^next\s+', s))
            anchor = wd.group(1)
            s = re.sub(r'^(?:next\s+|this\s+|coming\s+)?[a-z]+\b', '', s, count=1).strip()
            delta = (target_weekday - now.weekday()) % 7
            if delta == 0 and forced_next:
                delta = 7
            day_offset = delta

    s = re.sub(r'^(at|@|around|by)\s+', '', s).strip()
    s = re.sub(r'\s*(today|tonight)$', '', s).strip()

    if not s:
        # Day word with no time (e.g. "tomorrow") → default 09:00, or 20:00 for "tonight"
        hour, minute, second = (20, 0, 0) if evening_bias else (9, 0, 0)
        if anchor == "today" and not evening_bias:
            return None  # bare "today" with no time is not schedulable
    else:
        clock = _parse_clock(s)
        if not clock:
            return None
        hour, minute, second = clock
        if evening_bias and hour < 12 and not re.search(r'(am|a\.m\.)', raw.lower()):
            hour += 12

    target = (now + timedelta(days=day_offset)).replace(
        hour=hour, minute=minute, second=second, microsecond=0
    )

    rolled_over = False
    if day_offset == 0 and target_weekday is None and target < now - timedelta(seconds=60):
        # The requested wall-clock time has already passed today → roll to the same
        # time tomorrow, since a past one-shot would never fire.
        target = target + timedelta(days=1)
        rolled_over = True
        anchor = "tomorrow (requested time already passed today)"

    if tzinfo is not None and target.tzinfo is None:
        target = target.replace(tzinfo=tzinfo)

    return {"dt": target, "anchor": anchor, "rolled_over": rolled_over}


def describe_now(tz: Optional[str] = None) -> Dict[str, str]:
    """Return the current date/time context used to anchor relative schedules."""
    now = _get_now(tz)
    return {
        "current_datetime": now.strftime("%Y-%m-%d %H:%M:%S"),
        "current_date": now.strftime("%Y-%m-%d"),
        "current_time": now.strftime("%H:%M"),
        "weekday": now.strftime("%A"),
        "timezone": _resolve_tz(tz) or (now.tzname() or "server local"),
    }


def parse_schedule(schedule: str, tz: Optional[str] = None) -> Dict[str, Any]:
    """Parse a schedule rule into a structured dict.

    ``tz`` (IANA name) is used to interpret wall-clock times: naive ISO timestamps
    and natural-language phrases are resolved against the CURRENT date in this
    timezone. Falls back to HERMES_TIMEZONE then server local.
    """
    resolved_tz = _resolve_tz(tz)
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
        display = schedule
        if resolved_tz:
            display = f"{schedule} ({resolved_tz})"
        return {
            "kind": "cron",
            "expr": schedule,
            "tz": resolved_tz,
            "display": display
        }

    # ISO timestamp (explicit date supplied by the user)
    if 'T' in schedule or re.match(r'^\d{4}-\d{2}-\d{2}', schedule):
        try:
            dt = datetime.fromisoformat(schedule.replace('Z', '+00:00'))
            if dt.tzinfo is None:
                # Naive timestamp → interpret in the resolved timezone
                tz_name = resolved_tz or os.getenv("HERMES_TIMEZONE", "").strip()
                if tz_name:
                    try:
                        from zoneinfo import ZoneInfo
                        dt = dt.replace(tzinfo=ZoneInfo(tz_name))
                    except Exception:
                        dt = dt.astimezone()
                else:
                    dt = dt.astimezone()
            return {
                "kind": "once",
                "run_at": dt.isoformat(),
                "tz": resolved_tz,
                "display": f"once at {dt.strftime('%Y-%m-%d %H:%M')}"
            }
        except ValueError as e:
            raise ValueError(f"Invalid timestamp '{schedule}': {e}")

    # Duration like "30m", "2h", "1d" → one-shot relative to now
    try:
        minutes = parse_duration(schedule)
        run_at = _get_now(resolved_tz) + timedelta(minutes=minutes)
        return {
            "kind": "once",
            "run_at": run_at.isoformat(),
            "tz": resolved_tz,
            "display": f"once in {original}"
        }
    except ValueError:
        pass

    # Natural language anchored to the CURRENT date: "14:55", "2:55 PM",
    # "today at 2:55 PM", "tomorrow 9am", "friday at 18:00", "in 30 minutes"
    natural = _parse_natural_datetime(original, tz=resolved_tz)
    if natural:
        dt = natural["dt"]
        result = {
            "kind": "once",
            "run_at": dt.isoformat(),
            "tz": resolved_tz,
            "display": f"once at {dt.strftime('%Y-%m-%d %H:%M')}",
            "resolved_from": original,
            "anchor": natural["anchor"],
        }
        if natural["rolled_over"]:
            result["rolled_to_next_day"] = True
        return result

    now_ctx = describe_now(resolved_tz)
    raise ValueError(
        f"Invalid schedule '{original}'. Current date/time is "
        f"{now_ctx['current_datetime']} ({now_ctx['weekday']}, {now_ctx['timezone']}). Use:\n"
        f"  - Time today: '14:55', '2:55 PM', 'today at 2:55 PM' (anchored to the current date)\n"
        f"  - Tomorrow: 'tomorrow at 9:00 AM'\n"
        f"  - Weekday: 'friday at 18:00'\n"
        f"  - Duration: '30m', '2h', '1d', 'in 45 minutes' (one-shot)\n"
        f"  - Interval: 'every 30m', 'every 2h' (recurring)\n"
        f"  - Cron: '0 9 * * *' (evaluated in the user's timezone)\n"
        f"  - Explicit timestamp: '2026-02-03T14:00:00' (only when the user names a date)"
    )



def compute_next_run(
    schedule: Dict[str, Any],
    last_run_at: Optional[str] = None,
    tz: Optional[str] = None,
) -> Optional[str]:
    """Compute the next run time and return it as a UTC ISO string (Z suffix).

    Timezone precedence: explicit ``tz`` param > schedule's embedded tz >
    HERMES_TIMEZONE env > server local. Cron expressions are evaluated in the
    wall-clock of that timezone, then converted to UTC for storage/comparison.
    """
    tz_name = _resolve_tz(tz) or _resolve_tz(schedule.get("tz") if isinstance(schedule, dict) else None)
    now = _get_now(tz_name)
    kind = schedule.get("kind")

    if kind == "once":
        if last_run_at:
            return None
        run_at = schedule.get("run_at")
        if not run_at:
            return None
        run_at_dt = _parse_iso(run_at)

        # Eligible to run if in the future, or in past but within grace window (e.g. 5 minutes)
        if run_at_dt >= now - timedelta(seconds=300):
            return _to_utc_iso(run_at_dt)
        return None

    elif kind == "interval":
        minutes = schedule["minutes"]
        if last_run_at:
            last = _parse_iso(last_run_at)
            next_run = last + timedelta(minutes=minutes)
        else:
            next_run = now + timedelta(minutes=minutes)
        return _to_utc_iso(next_run)

    elif kind == "cron":
        if not HAS_CRONITER:
            return None
        base_time = now
        if last_run_at:
            base_time = _parse_iso(last_run_at)
            if tz_name:
                try:
                    from zoneinfo import ZoneInfo
                    base_time = base_time.astimezone(ZoneInfo(tz_name))
                except Exception:
                    pass
        cron = croniter(schedule["expr"], base_time)
        next_run = cron.get_next(datetime)
        return _to_utc_iso(next_run)

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
    timezone: Optional[str] = None,
    mount_chat: Optional[Union[bool, str]] = None,
    context_summary: Optional[str] = None,
    config: Optional[RunnableConfig] = None,
) -> str:
    """Manage scheduled background tasks for agents (unified scheduling system).

    Allows you to create, view, pause, resume, run, and delete background tasks.
    Tasks are persisted in the database and executed by a background scheduler daemon.

    Date resolution (IMPORTANT):
      - The tool ALWAYS anchors relative schedules to the CURRENT date in the user's
        timezone. If the user gives only a time ("3:40pm", "15:40", "at 9:00"), it is
        scheduled for TODAY at that time — you do NOT need to compute or pass a date.
      - NEVER invent a future date. Only pass a full ISO timestamp when the user
        explicitly names a date ("on September 1st" → '2026-09-01T10:00:00').
      - Accepted natural phrases: '15:40', '3:40 PM', 'today at 3:40 PM', 'tonight',
        'tomorrow at 9am', 'friday at 18:00', 'next monday 9am', 'in 30 minutes'.
      - If the requested time already passed today, it automatically rolls to the same
        time tomorrow (a past one-shot would never fire) and the response says so.
      - The 'create' response includes 'current_datetime' so you can confirm to the
        user which date the task actually landed on.

    Timezone behavior:
      - Cron expressions and timestamps are evaluated in the USER's timezone by default
        (their saved scheduler preference), so '0 21 * * *' means 9pm at the user's location.
        When the user says e.g. "9pm", just convert to 24h and pass '0 21 * * *' — do NOT
        do timezone math yourself.
      - Only pass the 'timezone' parameter when the user explicitly asks for a
        different timezone for this specific task.

    Important rules:
      - Always run action='list' first before updating/pausing/deleting, to retrieve the correct job_id.
      - Tasks run in isolated sessions. Use mount_chat=True to attach the current chat
        conversation, and context_summary to explain WHY the task was created — otherwise
        prompts must be self-contained.
      - If B depends on A, schedule A first to get its ID, then schedule B with context_from=[A's ID].

    Args:
        action: The operation to execute: 'create', 'list', 'update', 'pause', 'resume', 'remove', 'run'.
        job_id: The unique ID of the target job (required for update, pause, resume, remove, run).
        prompt: The task instruction prompt (required for create when no_agent=False).
        schedule: The scheduling rule (required for create). Time-only values are anchored to TODAY. Examples: '15:40' or '3:40 PM' (today at that time), 'tomorrow at 9am', 'friday at 18:00', '30m'/'in 30 minutes' (relative), 'every 2h' (interval), '0 21 * * *' (daily 9pm user time), '2026-09-01T10:00:00' (only when the user names an explicit date).
        name: A human-friendly name/title for the task.
        repeat: Optional number of times to run. Omit or 0/negative for infinite.
        deliver: Where to send final outputs: 'local' (only logs, default), 'origin' (back to creation chat), or a platform:chat_id string.
        skills: List of skill names to load before running.
        model: Per-job LLM model override (e.g. 'google/gemini-2.5-flash').
        provider: Per-job LLM provider override (e.g. 'openrouter', 'gemini').
        base_url: Custom API endpoint URL override.
        script: Path to Python/Bash script for data retrieval or watchdog checks.
        no_agent: If True, execute the script directly and skip LLM agent execution entirely.
        context_from: List of upstream job IDs whose outputs will be injected as context.
        enabled_toolsets: Allowed toolsets (e.g. ['web', 'file']) to prevent context bloat.
        workdir: Subprocess directory where the terminal/file tools should run from.
        timezone: IANA timezone override for this task (e.g. 'Asia/Karachi', 'America/New_York'). Defaults to the user's saved scheduler timezone.
        mount_chat: Attach chat context so the task knows why it exists. True mounts the CURRENT chat thread's recent history; or pass a specific thread id string. Optional — use when the task depends on this conversation.
        context_summary: Short background summary of WHY the user wants this task (goals, preferences, origin). Injected on every run. Recommended when mount_chat is not used.
        config: LangChain runnable configuration (automatically injected).
    """
    client = _get_supabase_client()
    action = action.strip().lower()

    try:
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
        agent_id = None
        user_id_val = None

        logger.info(f"[cronjob] Final resolved config: {config}")
        if config:
            configurable = config.get("configurable", {})
            logger.info(f"[cronjob] Configurable fields: {configurable}")
            workflow_id = configurable.get("workflow_id")
            thread_id = configurable.get("thread_id")
            agent_id = configurable.get("agent_id")
            user_id_val = configurable.get("user_id")

        if thread_id and not workflow_id:
            try:
                sess_resp = client.table("sessions").select("workflow_id").eq("id", thread_id).execute()
                if sess_resp.data and sess_resp.data[0].get("workflow_id"):
                    workflow_id = sess_resp.data[0].get("workflow_id")
                    logger.info(f"[cronjob] Resolved workflow_id '{workflow_id}' from sessions table for thread '{thread_id}'")
            except Exception as e:
                logger.warning(f"[cronjob] Failed to resolve workflow_id from sessions table: {e}")

        # Tier 2: look up user_id from the agent_configs table using agent_id
        if not user_id_val and agent_id:
            try:
                resp = client.table("agent_configs").select("user_id").eq("id", agent_id).execute()
                if resp.data and len(resp.data) > 0:
                    user_id_val = resp.data[0].get("user_id")
                    logger.info(f"[cronjob] Resolved user_id '{user_id_val}' from agent_id '{agent_id}'")
            except Exception as e:
                logger.warning(f"[cronjob] Failed to resolve user_id from agent_id: {e}")

        # Tier 3: look up user_id from the workflows table using workflow_id
        if not user_id_val and workflow_id:
            try:
                resp = client.table("workflows").select("user_id").eq("id", workflow_id).execute()
                if resp.data and len(resp.data) > 0:
                    user_id_val = resp.data[0].get("user_id")
                    logger.info(f"[cronjob] Resolved user_id '{user_id_val}' from workflow_id '{workflow_id}'")
            except Exception as e:
                logger.warning(f"[cronjob] Failed to resolve user_id from workflow_id: {e}")

        # Tier 4: ContextVar last resort
        if not user_id_val:
            try:
                from research_agent.tools.provider_engine import active_user_id
                user_id_val = active_user_id.get()
                if user_id_val:
                    logger.info(f"[cronjob] Resolved user_id '{user_id_val}' from active_user_id ContextVar")
            except Exception:
                pass

        if action == "create":
            if not schedule:
                return json.dumps({"success": False, "error": "Missing required parameter 'schedule' for create action."})

            if not no_agent and not prompt:
                return json.dumps({"success": False, "error": "Parameter 'prompt' is required unless no_agent=True."})

            if no_agent and not script:
                return json.dumps({"success": False, "error": "Parameter 'script' is required when no_agent=True."})

            # Timezone resolution: explicit param > user's saved preference > HERMES_TIMEZONE env
            user_tz = get_user_timezone(client, user_id_val)
            effective_tz = _resolve_tz(timezone) or user_tz
            if timezone and not _resolve_tz(timezone):
                return json.dumps({"success": False, "error": f"Invalid timezone '{timezone}'. Use an IANA name like 'Asia/Karachi' or 'America/New_York'."})

            parsed_schedule = parse_schedule(schedule, tz=effective_tz)
            next_run_at = compute_next_run(parsed_schedule, tz=effective_tz)

            now_ctx = describe_now(effective_tz)
            if parsed_schedule.get("kind") == "once" and not next_run_at:
                return json.dumps({
                    "success": False,
                    "error": (
                        f"Schedule '{schedule}' resolves to "
                        f"{format_in_tz(parsed_schedule['run_at'], effective_tz)}, which is in the past "
                        f"(current time is {now_ctx['current_datetime']} {now_ctx['timezone']}). "
                        f"A one-shot task in the past would never run — ask the user for a future time "
                        f"or pass an explicit future date."
                    ),
                    "current_datetime": now_ctx["current_datetime"],
                    "timezone": now_ctx["timezone"],
                })

            # Resolve mount_chat → concrete thread id
            mount_thread_id = None
            if mount_chat is True:
                mount_thread_id = thread_id
                if not mount_thread_id:
                    return json.dumps({"success": False, "error": "mount_chat=True but no current chat thread is available in this session."})
            elif isinstance(mount_chat, str) and mount_chat.strip():
                mount_thread_id = mount_chat.strip()
                if mount_thread_id.lower().startswith("thread:"):
                    mount_thread_id = mount_thread_id[7:]

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

            origin = {}
            if workflow_id:
                origin["workflow_id"] = workflow_id
            if thread_id:
                origin["thread_id"] = thread_id
            if agent_id:
                origin["agent_id"] = agent_id

            resp = client.rpc("manage_scheduled_tasks_admin", {
                "p_action": "create",
                "p_user_id": user_id_val,
                "p_name": name,
                "p_prompt": prompt,
                "p_skills": skills or [],
                "p_model": model,
                "p_provider": provider,
                "p_base_url": base_url,
                "p_script": script,
                "p_no_agent": bool(no_agent),
                "p_context_from": context_from or [],
                "p_schedule": parsed_schedule,
                "p_schedule_display": parsed_schedule.get("display", schedule),
                "p_repeat_times": repeat if repeat and repeat > 0 else None,
                "p_enabled": True,
                "p_state": "scheduled",
                "p_deliver": delivery_target,
                "p_enabled_toolsets": enabled_toolsets or [],
                "p_workdir": workdir,
                "p_next_run_at": next_run_at,
                "p_timezone": effective_tz,
                "p_mount_chat": mount_thread_id,
                "p_context_summary": context_summary,
                "p_origin": origin
            }).execute()

            if not resp.data or not resp.data.get("success"):
                error_msg = resp.data.get("error") if resp.data else "No database response"
                return json.dumps({"success": False, "error": f"Failed to insert task in database: {error_msg}"})

            new_task = resp.data.get("data")
            next_run_local = format_in_tz(new_task["next_run_at"], effective_tz) if new_task.get("next_run_at") else None
            result = {
                "success": True,
                "message": f"Successfully created scheduled task '{new_task['name']}'",
                "current_datetime": now_ctx["current_datetime"],
                "task": {
                    "id": new_task["id"],
                    "name": new_task["name"],
                    "schedule": new_task["schedule_display"],
                    "schedule_input": schedule,
                    "resolved_anchor": parsed_schedule.get("anchor") or "explicit",
                    "timezone": new_task.get("timezone") or effective_tz,
                    "next_run_at": new_task["next_run_at"],
                    "next_run_at_local": next_run_local
                }
            }
            if parsed_schedule.get("rolled_to_next_day"):
                result["note"] = (
                    f"'{schedule}' had already passed today ({now_ctx['current_date']}), "
                    f"so the task was scheduled for the same time tomorrow. "
                    f"Tell the user which date it will run on."
                )
            return json.dumps(result, indent=2)


        elif action == "list":
            resp = client.rpc("manage_scheduled_tasks_admin", {
                "p_action": "list",
                "p_user_id": user_id_val
            }).execute()
            if not resp.data or not resp.data.get("success"):
                error_msg = resp.data.get("error") if resp.data else "No database response"
                return json.dumps({"success": False, "error": f"Failed to list tasks: {error_msg}"})

            tasks = resp.data.get("data") or []
            list_tz = get_user_timezone(client, user_id_val)
            for t in tasks:
                if isinstance(t, dict) and t.get("next_run_at"):
                    t["next_run_at_local"] = format_in_tz(t["next_run_at"], t.get("timezone") or list_tz)
            now_ctx = describe_now(list_tz)
            return json.dumps({
                "success": True,
                "current_datetime": now_ctx["current_datetime"],
                "timezone": now_ctx["timezone"],
                "tasks": tasks,
            }, indent=2)


        elif action in ["update", "pause", "resume", "remove", "run"]:
            if not job_id:
                return json.dumps({"success": False, "error": f"Parameter 'job_id' is required for action '{action}'."})

            # Check if task exists
            task_resp = client.rpc("manage_scheduled_tasks_admin", {
                "p_action": "get",
                "p_user_id": user_id_val,
                "p_job_id": job_id
            }).execute()
            if not task_resp.data or not task_resp.data.get("success"):
                return json.dumps({"success": False, "error": f"Task with ID '{job_id}' not found or access denied."})
            
            task = task_resp.data.get("data")
            user_tz = get_user_timezone(client, user_id_val)
            task_tz = task.get("timezone") or user_tz

            if action == "remove":
                resp = client.rpc("manage_scheduled_tasks_admin", {
                    "p_action": "delete",
                    "p_user_id": user_id_val,
                    "p_job_id": job_id
                }).execute()
                if not resp.data or not resp.data.get("success"):
                    error_msg = resp.data.get("error") if resp.data else "No database response"
                    return json.dumps({"success": False, "error": f"Failed to remove task: {error_msg}"})
                return json.dumps({"success": True, "message": f"Task '{task['name']}' successfully removed."})

            elif action == "pause":
                updates = {
                    "enabled": False,
                    "state": "paused",
                    "paused_at": now_utc_iso(),
                }
                resp = client.rpc("manage_scheduled_tasks_admin", {
                    "p_action": "update",
                    "p_user_id": user_id_val,
                    "p_job_id": job_id,
                    "p_updates": updates
                }).execute()
                if not resp.data or not resp.data.get("success"):
                    error_msg = resp.data.get("error") if resp.data else "No database response"
                    return json.dumps({"success": False, "error": f"Failed to pause task: {error_msg}"})
                
                return json.dumps({"success": True, "message": f"Task '{task['name']}' paused.", "task": resp.data.get("data")}, indent=2)

            elif action == "resume":
                updates = {
                    "enabled": True,
                    "state": "scheduled",
                    "paused_at": None,
                    "next_run_at": compute_next_run(task["schedule"], tz=task_tz)
                }
                resp = client.rpc("manage_scheduled_tasks_admin", {
                    "p_action": "update",
                    "p_user_id": user_id_val,
                    "p_job_id": job_id,
                    "p_updates": updates
                }).execute()
                if not resp.data or not resp.data.get("success"):
                    error_msg = resp.data.get("error") if resp.data else "No database response"
                    return json.dumps({"success": False, "error": f"Failed to resume task: {error_msg}"})
                
                return json.dumps({"success": True, "message": f"Task '{task['name']}' resumed.", "task": resp.data.get("data")}, indent=2)

            elif action == "run":
                # Set next_run_at to now (UTC) to trigger immediately
                updates = {
                    "next_run_at": now_utc_iso(),
                    "state": "scheduled",
                    "enabled": True
                }
                resp = client.rpc("manage_scheduled_tasks_admin", {
                    "p_action": "update",
                    "p_user_id": user_id_val,
                    "p_job_id": job_id,
                    "p_updates": updates
                }).execute()
                if not resp.data or not resp.data.get("success"):
                    error_msg = resp.data.get("error") if resp.data else "No database response"
                    return json.dumps({"success": False, "error": f"Failed to run task: {error_msg}"})
                
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
                if context_summary is not None:
                    updates["context_summary"] = context_summary
                if timezone is not None:
                    if timezone and not _resolve_tz(timezone):
                        return json.dumps({"success": False, "error": f"Invalid timezone '{timezone}'. Use an IANA name like 'Asia/Karachi' or 'America/New_York'."})
                    updates["timezone"] = _resolve_tz(timezone) or None

                if mount_chat is not None:
                    if mount_chat is True:
                        if not thread_id:
                            return json.dumps({"success": False, "error": "mount_chat=True but no current chat thread is available in this session."})
                        updates["mount_chat"] = thread_id
                    elif mount_chat is False:
                        updates["mount_chat"] = None
                    elif isinstance(mount_chat, str) and mount_chat.strip():
                        mid = mount_chat.strip()
                        if mid.lower().startswith("thread:"):
                            mid = mid[7:]
                        updates["mount_chat"] = mid

                effective_tz = _resolve_tz(updates.get("timezone")) or task_tz

                if schedule is not None:
                    parsed_schedule = parse_schedule(schedule, tz=effective_tz)
                    updates["schedule"] = parsed_schedule
                    updates["schedule_display"] = parsed_schedule.get("display", schedule)
                    if task.get("state") != "paused":
                        new_next = compute_next_run(parsed_schedule, tz=effective_tz)
                        if parsed_schedule.get("kind") == "once" and not new_next:
                            now_ctx = describe_now(effective_tz)
                            return json.dumps({
                                "success": False,
                                "error": (
                                    f"Schedule '{schedule}' resolves to a past time "
                                    f"(current time is {now_ctx['current_datetime']} {now_ctx['timezone']}). "
                                    f"Provide a future time."
                                ),
                                "current_datetime": now_ctx["current_datetime"],
                            })
                        updates["next_run_at"] = new_next

                elif "timezone" in updates and updates["timezone"] != task.get("timezone") and task.get("state") != "paused":
                    # Timezone change on a cron task shifts the wall-clock schedule → recompute
                    updates["next_run_at"] = compute_next_run(task["schedule"], tz=effective_tz)
                
                if not updates:
                    return json.dumps({"success": False, "error": "No update fields provided."})

                resp = client.rpc("manage_scheduled_tasks_admin", {
                    "p_action": "update",
                    "p_user_id": user_id_val,
                    "p_job_id": job_id,
                    "p_updates": updates
                }).execute()
                if not resp.data or not resp.data.get("success"):
                    error_msg = resp.data.get("error") if resp.data else "No database response"
                    return json.dumps({"success": False, "error": f"Failed to update task: {error_msg}"})
                
                return json.dumps({"success": True, "message": f"Task '{task['name']}' updated.", "task": resp.data.get("data")}, indent=2)

        return json.dumps({"success": False, "error": f"Unknown action '{action}'."})

    except Exception as e:
        logger.error(f"Error in cronjob tool: {e}", exc_info=True)
        err_msg = str(e)
        if "row-level security" in err_msg.lower() and not os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
            err_msg += "\n\n💡 TIP: This Row-Level Security (RLS) policy violation occurs because the SUPABASE_SERVICE_ROLE_KEY is missing from your .env file. Please retrieve the service_role key from your Supabase Dashboard (Settings -> API) and add it to your local .env file as: SUPABASE_SERVICE_ROLE_KEY=your_service_role_key"
        return json.dumps({"success": False, "error": err_msg})
