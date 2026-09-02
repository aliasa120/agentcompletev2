"""Tests for Cron Scheduler enhancements: user timezone handling + chat context mounting.

Covers:
  1. Timezone-aware schedule parsing / next-run computation (cronjob.py)
  2. Tool-level creation with mount_chat / context_summary / timezone / origin (cronjob.py tool)
  3. Daemon execution: chat context block building, context mounting, deliver-to-thread (cron_scheduler.py)
"""

import os
import sys
import json
import unittest
from unittest.mock import patch, MagicMock, call

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from research_agent.tools.cronjob import (
    parse_schedule,
    compute_next_run,
    describe_now,
    _get_now,
    _parse_clock,
    _parse_natural_datetime,
    _resolve_tz,
    _to_utc_iso,
    format_in_tz,
    get_user_timezone,
    cronjob as cronjob_tool,
)
import cron_scheduler


# ─────────────────────────────────────────────────────────────────────────────
# 0. Current-date anchoring (natural language schedules)
# ─────────────────────────────────────────────────────────────────────────────
class TestCurrentDateAnchoring(unittest.TestCase):
    TZ = "Asia/Karachi"

    def test_parse_clock_formats(self):
        self.assertEqual(_parse_clock("14:55"), (14, 55, 0))
        self.assertEqual(_parse_clock("2:55 PM"), (14, 55, 0))
        self.assertEqual(_parse_clock("2:55pm"), (14, 55, 0))
        self.assertEqual(_parse_clock("2:55 p.m."), (14, 55, 0))
        self.assertEqual(_parse_clock("3.40pm"), (15, 40, 0))
        self.assertEqual(_parse_clock("9am"), (9, 0, 0))
        self.assertEqual(_parse_clock("12:00 AM"), (0, 0, 0))
        self.assertEqual(_parse_clock("12:00 PM"), (12, 0, 0))
        self.assertEqual(_parse_clock("23:59:30"), (23, 59, 30))
        # Ambiguous / invalid
        self.assertIsNone(_parse_clock("5"))
        self.assertIsNone(_parse_clock("banana"))
        self.assertIsNone(_parse_clock("25:00"))

    def test_time_only_anchors_to_today(self):
        now = _get_now(self.TZ)
        # Pick a time later today so no rollover happens
        later = (now.hour + 2) % 24
        if later < now.hour:            # would wrap past midnight
            self.skipTest("Too close to midnight for a deterministic same-day assertion")
        parsed = parse_schedule(f"{later:02d}:30", tz=self.TZ)
        self.assertEqual(parsed["kind"], "once")
        self.assertEqual(parsed["anchor"], "today")
        self.assertTrue(parsed["run_at"].startswith(now.strftime("%Y-%m-%d")))
        self.assertNotIn("rolled_to_next_day", parsed)

    def test_today_prefix_equals_time_only(self):
        now = _get_now(self.TZ)
        later = (now.hour + 2) % 24
        if later < now.hour:
            self.skipTest("Too close to midnight for a deterministic same-day assertion")
        a = parse_schedule(f"{later:02d}:30", tz=self.TZ)
        b = parse_schedule(f"today at {later:02d}:30", tz=self.TZ)
        self.assertEqual(a["run_at"], b["run_at"])

    def test_past_time_today_rolls_to_tomorrow(self):
        now = _get_now(self.TZ)
        # 00:01 is in the past for virtually the whole day
        if now.hour == 0 and now.minute < 5:
            self.skipTest("Runs just after midnight; 00:01 is not in the past yet")
        parsed = parse_schedule("00:01", tz=self.TZ)
        self.assertTrue(parsed.get("rolled_to_next_day"))
        tomorrow = (now + __import__("datetime").timedelta(days=1)).strftime("%Y-%m-%d")
        self.assertTrue(parsed["run_at"].startswith(tomorrow))

    def test_tomorrow_phrases(self):
        now = _get_now(self.TZ)
        tomorrow = (now + __import__("datetime").timedelta(days=1)).strftime("%Y-%m-%d")
        for phrase in ("tomorrow at 9am", "tomorrow 09:00", "tomorrow at 9:00 AM"):
            parsed = parse_schedule(phrase, tz=self.TZ)
            self.assertEqual(parsed["kind"], "once", phrase)
            self.assertTrue(parsed["run_at"].startswith(tomorrow), f"{phrase} -> {parsed['run_at']}")
            self.assertIn("T09:00:00", parsed["run_at"], phrase)

    def test_tomorrow_without_time_defaults_to_9am(self):
        parsed = parse_schedule("tomorrow", tz=self.TZ)
        self.assertIn("T09:00:00", parsed["run_at"])

    def test_tonight_defaults_to_evening(self):
        parsed = parse_schedule("tonight", tz=self.TZ)
        self.assertIn("T20:00:00", parsed["run_at"])

    def test_relative_in_phrases(self):
        parsed = parse_schedule("in 30 minutes", tz=self.TZ)
        self.assertEqual(parsed["kind"], "once")
        self.assertEqual(parsed["anchor"], "relative")
        nxt = compute_next_run(parsed, tz=self.TZ)
        self.assertIsNotNone(nxt)

    def test_weekday_phrase_resolves_forward(self):
        parsed = parse_schedule("friday at 18:00", tz=self.TZ)
        self.assertEqual(parsed["kind"], "once")
        dt = __import__("datetime").datetime.fromisoformat(parsed["run_at"])
        self.assertEqual(dt.weekday(), 4)
        self.assertEqual((dt.hour, dt.minute), (18, 0))
        self.assertGreaterEqual(dt.date(), _get_now(self.TZ).date())

    def test_explicit_iso_date_still_honored(self):
        parsed = parse_schedule("2027-03-05T14:55:00", tz=self.TZ)
        self.assertEqual(parsed["kind"], "once")
        self.assertNotIn("anchor", parsed)
        self.assertTrue(parsed["run_at"].startswith("2027-03-05"))

    def test_cron_and_interval_unaffected(self):
        self.assertEqual(parse_schedule("0 9 * * *", tz=self.TZ)["kind"], "cron")
        self.assertEqual(parse_schedule("every 2h", tz=self.TZ)["kind"], "interval")
        self.assertEqual(parse_schedule("30m", tz=self.TZ)["kind"], "once")

    def test_garbage_error_includes_current_datetime(self):
        with self.assertRaises(ValueError) as ctx:
            parse_schedule("sometime soonish", tz=self.TZ)
        msg = str(ctx.exception)
        self.assertIn("Current date/time is", msg)
        self.assertIn(_get_now(self.TZ).strftime("%Y-%m-%d"), msg)

    def test_describe_now_shape(self):
        ctx = describe_now(self.TZ)
        self.assertEqual(ctx["timezone"], self.TZ)
        self.assertRegex(ctx["current_date"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertRegex(ctx["current_time"], r"^\d{2}:\d{2}$")

    def test_natural_parser_returns_none_for_non_datetime(self):
        self.assertIsNone(_parse_natural_datetime("write a blog post", tz=self.TZ))
        self.assertIsNone(_parse_natural_datetime("today", tz=self.TZ))



# ─────────────────────────────────────────────────────────────────────────────
# 1. Timezone-aware schedule logic
# ─────────────────────────────────────────────────────────────────────────────
class TestTimezoneScheduleLogic(unittest.TestCase):
    def test_resolve_tz_valid_and_invalid(self):
        self.assertEqual(_resolve_tz("Asia/Karachi"), "Asia/Karachi")
        self.assertEqual(_resolve_tz("  America/New_York  "), "America/New_York")
        self.assertIsNone(_resolve_tz("Not/AZone"))
        self.assertIsNone(_resolve_tz(""))
        self.assertIsNone(_resolve_tz(None))

    def test_to_utc_iso_converts_offsets(self):
        from datetime import datetime, timezone as dt_tz
        # 21:00 Karachi (UTC+5) == 16:00 UTC
        dt = datetime(2026, 8, 29, 21, 0, 0, tzinfo=dt_tz(dt_tz.utc.utcoffset(None) + __import__("datetime").timedelta(hours=5)))
        # simpler explicit construction:
        from zoneinfo import ZoneInfo
        dt = datetime(2026, 8, 29, 21, 0, 0, tzinfo=ZoneInfo("Asia/Karachi"))
        self.assertEqual(_to_utc_iso(dt), "2026-08-29T16:00:00.000Z")

    def test_cron_evaluated_in_user_timezone(self):
        # '0 21 * * *' in Karachi (UTC+5, no DST) must land at 16:00 UTC
        parsed = parse_schedule("0 21 * * *", tz="Asia/Karachi")
        self.assertEqual(parsed["kind"], "cron")
        self.assertEqual(parsed["tz"], "Asia/Karachi")
        self.assertIn("Asia/Karachi", parsed["display"])

        nxt = compute_next_run(parsed, tz="Asia/Karachi")
        self.assertIsNotNone(nxt)
        self.assertTrue(nxt.endswith("Z"), f"next_run_at must be UTC Z-format, got {nxt}")
        self.assertIn("T16:00:00.000Z", nxt, f"9pm Karachi should be 16:00 UTC, got {nxt}")

    def test_cron_with_last_run_in_timezone(self):
        parsed = parse_schedule("0 21 * * *", tz="Asia/Karachi")
        # Base: 2026-08-29 10:00 UTC → next 21:00 Karachi is same day 16:00 UTC
        nxt = compute_next_run(parsed, last_run_at="2026-08-29T10:00:00.000Z", tz="Asia/Karachi")
        self.assertEqual(nxt, "2026-08-29T16:00:00.000Z")

    def test_cron_across_day_boundary(self):
        # Base late in the day UTC → next 9am New York (EDT = UTC-4) is 13:00 UTC
        parsed = parse_schedule("0 9 * * *", tz="America/New_York")
        nxt = compute_next_run(parsed, last_run_at="2026-08-29T20:00:00.000Z", tz="America/New_York")
        self.assertEqual(nxt, "2026-08-30T13:00:00.000Z")

    def test_naive_iso_timestamp_interpreted_in_timezone(self):
        parsed = parse_schedule("2026-08-30T21:00:00", tz="America/New_York")
        self.assertEqual(parsed["kind"], "once")
        # EDT is UTC-4 → 21:00 local == 2026-08-31T01:00:00Z
        nxt = compute_next_run(parsed, tz="America/New_York")
        self.assertEqual(nxt, "2026-08-31T01:00:00.000Z")

    def test_explicit_offset_timestamp_preserved(self):
        parsed = parse_schedule("2026-08-30T21:00:00+05:00", tz="America/New_York")
        # Explicit offset wins over tz param: 21:00+05:00 == 16:00 UTC
        nxt = compute_next_run(parsed, tz="America/New_York")
        self.assertEqual(nxt, "2026-08-30T16:00:00.000Z")

    def test_interval_is_timezone_independent_but_utc_formatted(self):
        parsed = parse_schedule("every 30m")
        self.assertEqual(parsed["kind"], "interval")
        nxt = compute_next_run(parsed, tz="Asia/Karachi")
        self.assertIsNotNone(nxt)
        self.assertTrue(nxt.endswith("Z"))
        # last_run + interval
        nxt2 = compute_next_run(parsed, last_run_at="2026-08-29T10:00:00.000Z", tz="Asia/Karachi")
        self.assertEqual(nxt2, "2026-08-29T10:30:00.000Z")

    def test_once_past_grace_window_returns_none(self):
        parsed = parse_schedule("2020-01-01T00:00:00", tz="UTC")
        self.assertIsNone(compute_next_run(parsed, tz="UTC"))

    def test_backward_compat_no_tz(self):
        # Old callers (no tz) must still work
        parsed = parse_schedule("every 2h")
        nxt = compute_next_run(parsed)
        self.assertIsNotNone(nxt)
        self.assertTrue(nxt.endswith("Z"))

    def test_format_in_tz(self):
        out = format_in_tz("2026-08-29T16:00:00.000Z", "Asia/Karachi")
        self.assertIn("21:00", out)
        self.assertIn("PKT", out)

    def test_schedule_tz_embedded_in_dict_used_when_no_explicit_tz(self):
        parsed = parse_schedule("0 21 * * *", tz="Asia/Karachi")
        # No explicit tz → fall back to schedule's embedded tz
        nxt = compute_next_run(parsed, last_run_at="2026-08-29T10:00:00.000Z")
        self.assertEqual(nxt, "2026-08-29T16:00:00.000Z")


# ─────────────────────────────────────────────────────────────────────────────
# 2. Tool-level creation (mount_chat, context_summary, timezone, origin)
# ─────────────────────────────────────────────────────────────────────────────
TASK_ROW = {
    "id": "job-1",
    "name": "Nightly report",
    "schedule_display": "0 21 * * * (Asia/Karachi)",
    "next_run_at": "2026-08-29T16:00:00.000Z",
    "timezone": "Asia/Karachi",
}


def make_mock_client(user_tz=None, task_row=TASK_ROW):
    client = MagicMock()
    settings_resp = MagicMock()
    settings_resp.data = {"value": user_tz} if user_tz else None
    settings_chain = (
        client.table.return_value.select.return_value.eq.return_value.eq.return_value.maybe_single.return_value
    )
    settings_chain.execute.return_value = settings_resp

    rpc_resp = MagicMock()
    rpc_resp.data = {"success": True, "data": task_row}
    client.rpc.return_value.execute.return_value = rpc_resp
    return client


class TestCronjobToolCreate(unittest.TestCase):
    CONFIG = {
        "configurable": {
            "workflow_id": "wf-123",
            "thread_id": "th-456",
            "agent_id": "ag-789",
            "user_id": "user-abc",
        }
    }

    def _create(self, client, **kwargs):
        params = dict(
            action="create",
            prompt="Write the nightly report",
            schedule="0 21 * * *",
            config=self.CONFIG,
        )
        params.update(kwargs)
        return json.loads(cronjob_tool.func(**params))

    @patch("research_agent.tools.cronjob._get_supabase_client")
    def test_create_mounts_current_chat_and_origin(self, mock_get_client):
        client = make_mock_client(user_tz="Asia/Karachi")
        mock_get_client.return_value = client

        res = self._create(
            client,
            mount_chat=True,
            context_summary="User wants a nightly report of their blog stats",
        )
        self.assertTrue(res["success"], res)

        rpc_args = client.rpc.call_args[0][1]
        self.assertEqual(rpc_args["p_mount_chat"], "th-456")
        self.assertEqual(rpc_args["p_context_summary"], "User wants a nightly report of their blog stats")
        self.assertEqual(
            rpc_args["p_origin"],
            {"workflow_id": "wf-123", "thread_id": "th-456", "agent_id": "ag-789"},
        )
        # User's saved timezone becomes the task timezone
        self.assertEqual(rpc_args["p_timezone"], "Asia/Karachi")
        # Agent-friendly local time in the response
        self.assertIn("21:00", res["task"]["next_run_at_local"])

    @patch("research_agent.tools.cronjob._get_supabase_client")
    def test_create_with_explicit_timezone_override(self, mock_get_client):
        client = make_mock_client(user_tz="Asia/Karachi")
        mock_get_client.return_value = client

        res = self._create(client, timezone="America/New_York")
        self.assertTrue(res["success"], res)
        rpc_args = client.rpc.call_args[0][1]
        self.assertEqual(rpc_args["p_timezone"], "America/New_York")

    @patch("research_agent.tools.cronjob._get_supabase_client")
    def test_create_invalid_timezone_rejected(self, mock_get_client):
        client = make_mock_client()
        mock_get_client.return_value = client
        res = self._create(client, timezone="Mars/Olympus")
        self.assertFalse(res["success"])
        self.assertIn("Invalid timezone", res["error"])

    @patch("research_agent.tools.cronjob._get_supabase_client")
    def test_create_mount_chat_true_without_thread_errors(self, mock_get_client):
        client = make_mock_client()
        mock_get_client.return_value = client
        cfg = {"configurable": {"workflow_id": "wf-123", "user_id": "user-abc"}}
        res = json.loads(
            cronjob_tool.func(
                action="create",
                prompt="Do the thing",
                schedule="30m",
                mount_chat=True,
                config=cfg,
            )
        )
        self.assertFalse(res["success"])
        self.assertIn("mount_chat", res["error"])

    @patch("research_agent.tools.cronjob._get_supabase_client")
    def test_create_with_specific_thread_id_string(self, mock_get_client):
        client = make_mock_client()
        mock_get_client.return_value = client
        res = self._create(client, mount_chat="thread:custom-thread-99")
        self.assertTrue(res["success"], res)
        rpc_args = client.rpc.call_args[0][1]
        self.assertEqual(rpc_args["p_mount_chat"], "custom-thread-99")

    @patch("research_agent.tools.cronjob._get_supabase_client")
    def test_create_no_user_tz_falls_back_to_none(self, mock_get_client):
        client = make_mock_client(user_tz=None)
        mock_get_client.return_value = client
        res = self._create(client)
        self.assertTrue(res["success"], res)
        rpc_args = client.rpc.call_args[0][1]
        self.assertIsNone(rpc_args["p_timezone"])

    @patch("research_agent.tools.cronjob._get_supabase_client")
    def test_create_time_only_uses_current_date(self, mock_get_client):
        client = make_mock_client(user_tz="Asia/Karachi")
        mock_get_client.return_value = client

        now = _get_now("Asia/Karachi")
        later = (now.hour + 2) % 24
        if later < now.hour:
            self.skipTest("Too close to midnight for a deterministic same-day assertion")

        res = self._create(client, schedule=f"{later:02d}:40")
        self.assertTrue(res["success"], res)
        rpc_args = client.rpc.call_args[0][1]
        sched = rpc_args["p_schedule"]
        self.assertEqual(sched["kind"], "once")
        self.assertEqual(sched["anchor"], "today")
        self.assertTrue(sched["run_at"].startswith(now.strftime("%Y-%m-%d")))
        # Response exposes the anchor date so the agent can confirm it to the user
        self.assertIn("current_datetime", res)
        self.assertEqual(res["task"]["schedule_input"], f"{later:02d}:40")
        self.assertEqual(res["task"]["resolved_anchor"], "today")

    @patch("research_agent.tools.cronjob._get_supabase_client")
    def test_create_past_time_rolls_over_with_note(self, mock_get_client):
        client = make_mock_client(user_tz="Asia/Karachi")
        mock_get_client.return_value = client
        now = _get_now("Asia/Karachi")
        if now.hour == 0 and now.minute < 5:
            self.skipTest("Runs just after midnight; 00:01 is not in the past yet")

        res = self._create(client, schedule="00:01")
        self.assertTrue(res["success"], res)
        self.assertIn("note", res)
        self.assertIn("already passed today", res["note"])

    @patch("research_agent.tools.cronjob._get_supabase_client")
    def test_create_past_explicit_date_rejected(self, mock_get_client):
        client = make_mock_client(user_tz="Asia/Karachi")
        mock_get_client.return_value = client
        res = self._create(client, schedule="2020-01-01T10:00:00")
        self.assertFalse(res["success"])
        self.assertIn("in the past", res["error"])
        self.assertIn("current_datetime", res)

    @patch("research_agent.tools.cronjob._get_supabase_client")
    def test_list_includes_current_datetime_and_local_times(self, mock_get_client):
        client = make_mock_client(user_tz="Asia/Karachi")
        mock_get_client.return_value = client
        rpc_resp = MagicMock()
        rpc_resp.data = {"success": True, "data": [dict(TASK_ROW)]}
        client.rpc.return_value.execute.return_value = rpc_resp

        res = json.loads(cronjob_tool.func(action="list", config=self.CONFIG))
        self.assertTrue(res["success"], res)
        self.assertIn("current_datetime", res)
        self.assertIn("21:00", res["tasks"][0]["next_run_at_local"])



class TestGetUserTimezone(unittest.TestCase):
    def test_returns_valid_setting(self):
        client = make_mock_client(user_tz="Asia/Karachi")
        self.assertEqual(get_user_timezone(client, "u1"), "Asia/Karachi")

    def test_invalid_setting_returns_none(self):
        client = make_mock_client(user_tz="Bogus/Zone")
        self.assertIsNone(get_user_timezone(client, "u1"))

    def test_missing_user_returns_none(self):
        client = make_mock_client()
        self.assertIsNone(get_user_timezone(client, None))


# ─────────────────────────────────────────────────────────────────────────────
# 3. Daemon: chat context mounting, tz-aware next run, deliver
# ─────────────────────────────────────────────────────────────────────────────
def _chat_messages():
    return [
        {"type": "human", "content": "Please schedule my nightly blog report for 9pm", "created_at": "1"},
        {"type": "ai", "content": "Sure — I'll create a scheduled task for that.", "created_at": "2"},
        {"type": "tool", "content": "irrelevant", "created_at": "3"},
        {"type": "human", "content": [{"type": "text", "text": "Also include traffic stats"}], "created_at": "4"},
        {"type": "ai", "content": "Done — nightly report scheduled.", "created_at": "5"},
    ]


class TestDaemonDateTimeContext(unittest.TestCase):
    def test_block_contains_current_date_in_timezone(self):
        block = cron_scheduler._build_datetime_context_block("Asia/Karachi")
        self.assertIn("Current Date & Time", block)
        self.assertIn("Asia/Karachi", block)
        self.assertIn(_get_now("Asia/Karachi").strftime("%Y-%m-%d"), block)

    def test_block_works_without_timezone(self):
        block = cron_scheduler._build_datetime_context_block(None)
        self.assertIn("Current Date & Time", block)


class TestBuildChatContextBlock(unittest.TestCase):
    @patch("cron_scheduler._lg_get_messages")
    def test_renders_user_and_assistant_lines(self, mock_msgs):
        mock_msgs.return_value = _chat_messages()
        block = cron_scheduler._build_chat_context_block("th-1")
        self.assertIn("Original Chat Context", block)
        self.assertIn("[user]: Please schedule my nightly blog report for 9pm", block)
        self.assertIn("[assistant]: Sure — I'll create a scheduled task for that.", block)
        self.assertIn("[user]: Also include traffic stats", block)
        # tool messages excluded
        self.assertNotIn("irrelevant", block)

    @patch("cron_scheduler._lg_get_messages")
    def test_truncates_long_messages(self, mock_msgs):
        mock_msgs.return_value = [
            {"type": "human", "content": "x" * 5000, "created_at": "1"},
        ]
        block = cron_scheduler._build_chat_context_block("th-1", max_msg_chars=100)
        self.assertIn("…[truncated]", block)
        self.assertLessEqual(len(block), 1000)

    @patch("cron_scheduler._lg_get_messages", side_effect=Exception("boom"))
    def test_fetch_failure_returns_empty(self, mock_msgs):
        self.assertEqual(cron_scheduler._build_chat_context_block("th-1"), "")


class TestExecuteScheduledTask(unittest.TestCase):
    def setUp(self):
        self.task = {
            "id": "job-1",
            "name": "Nightly report",
            "user_id": "user-abc",
            "prompt": "Write the nightly blog report",
            "no_agent": False,
            "timezone": None,          # falls back to user preference
            "mount_chat": "th-origin",
            "context_summary": "User asked for a nightly blog stats report at 9pm their time.",
            "context_from": [],
            "schedule": {"kind": "interval", "minutes": 30},
            "repeat_times": None,
            "repeat_completed": 0,
            "enabled": True,
            "state": "scheduled",
            "deliver": "thread:th-origin",
            "origin": {"workflow_id": "wf-9"},
            "last_run_logs": None,
        }

        # Patches
        self.sb_get = patch("cron_scheduler._sb_get")
        self.sb_patch = patch("cron_scheduler._sb_patch")
        self.list_asst = patch("cron_scheduler._lg_list_assistants", return_value=[{"assistant_id": "asst-1"}])
        self.create_thread = patch("cron_scheduler._lg_create_thread", return_value="th-run-1")
        self.create_run = patch("cron_scheduler._lg_create_run", return_value={"run_id": "run-1"})
        self.get_run = patch("cron_scheduler._lg_get_run", return_value={"status": "success"})
        self.get_msgs = patch("cron_scheduler._lg_get_messages", side_effect=lambda tid: _chat_messages())

        self.mock_sb_get = self.sb_get.start()
        self.mock_sb_patch = self.sb_patch.start()
        self.list_asst.start()
        self.mock_create_thread = self.create_thread.start()
        self.mock_create_run = self.create_run.start()
        self.get_run.start()
        self.mock_get_msgs = self.get_msgs.start()

        # agent_settings lookup → user timezone Asia/Karachi
        self.mock_sb_get.side_effect = lambda table, params="": (
            [{"value": "Asia/Karachi"}] if table == "agent_settings" else []
        )

        self.addCleanup(patch.stopall)

    def test_prompt_contains_mounted_context(self):
        cron_scheduler._execute_scheduled_task(dict(self.task))

        # First run is the task run; verify assembled prompt
        first_call = self.mock_create_run.call_args_list[0]
        content = first_call.args[2]
        self.assertIn("### Task Background", content)
        self.assertIn("nightly blog stats report", content)
        self.assertIn("### Original Chat Context", content)
        self.assertIn("Please schedule my nightly blog report for 9pm", content)
        self.assertIn("Prompt:\nWrite the nightly blog report", content)
        # Thread metadata tagged with scheduled task info
        self.mock_create_thread.assert_called_once_with("wf-9", scheduled_task_id="job-1", scheduled_task_name="Nightly report")

    def test_next_run_computed_with_user_timezone_utc_stored(self):
        cron_scheduler._execute_scheduled_task(dict(self.task))

        patch_calls = self.mock_sb_patch.call_args_list
        self.assertTrue(patch_calls)
        table, params, body = patch_calls[0].args
        self.assertEqual(table, "agent_scheduled_tasks")
        self.assertIn("state", body)
        self.assertEqual(body["state"], "scheduled")
        # Interval schedule: next_run = last_run + 30m, in UTC Z format
        self.assertIsNotNone(body["next_run_at"])
        self.assertTrue(str(body["next_run_at"]).endswith("Z"))
        self.assertEqual(body["last_status"], "success")

    def test_deliver_sends_output_to_origin_thread(self):
        cron_scheduler._execute_scheduled_task(dict(self.task))

        # Two runs: 1) task execution  2) delivery back to origin thread
        self.assertEqual(self.mock_create_run.call_count, 2)
        delivery_call = self.mock_create_run.call_args_list[1]
        self.assertEqual(delivery_call.args[0], "th-origin")
        delivery_content = delivery_call.args[2]
        self.assertIn("[Scheduled Task Delivery]", delivery_content)
        self.assertIn("Nightly report", delivery_content)
        self.assertIn("Done — nightly report scheduled.", delivery_content)

    def test_no_deliver_for_local(self):
        task = dict(self.task)
        task["deliver"] = "local"
        cron_scheduler._execute_scheduled_task(task)
        self.assertEqual(self.mock_create_run.call_count, 1)

    def test_cron_next_run_uses_task_timezone(self):
        task = dict(self.task)
        task["schedule"] = {"kind": "cron", "expr": "0 21 * * *"}
        task["timezone"] = "Asia/Karachi"
        task["deliver"] = "local"
        cron_scheduler._execute_scheduled_task(task)

        _, _, body = self.mock_sb_patch.call_args_list[0].args
        # 9pm Karachi == 16:00 UTC
        self.assertIn("T16:00:00.000Z", body["next_run_at"])

    def test_no_mount_chat_no_context_block(self):
        task = dict(self.task)
        task["mount_chat"] = None
        task["context_summary"] = None
        task["deliver"] = "local"
        cron_scheduler._execute_scheduled_task(task)

        content = self.mock_create_run.call_args_list[0].args[2]
        self.assertNotIn("Original Chat Context", content)
        self.assertNotIn("Task Background", content)
        self.assertIn("Write the nightly blog report", content)
        # Date anchor is always present, even with no other context
        self.assertIn("Current Date & Time", content)

    def test_prompt_always_carries_current_date(self):
        task = dict(self.task)
        task["deliver"] = "local"
        cron_scheduler._execute_scheduled_task(task)
        content = self.mock_create_run.call_args_list[0].args[2]
        self.assertIn("Current Date & Time", content)
        self.assertIn(_get_now("Asia/Karachi").strftime("%Y-%m-%d"), content)


    def test_upstream_context_still_injected(self):
        task = dict(self.task)
        task["context_from"] = ["job-upstream"]
        task["deliver"] = "local"

        upstream_row = [{
            "id": "job-upstream",
            "name": "Data fetch",
            "last_run_logs": "Fetched 42 articles",
        }]

        def sb_get_side(table, params=""):
            if table == "agent_scheduled_tasks":
                return upstream_row
            if table == "agent_settings":
                return [{"value": "Asia/Karachi"}]
            return []

        self.mock_sb_get.side_effect = sb_get_side
        cron_scheduler._execute_scheduled_task(task)

        content = self.mock_create_run.call_args_list[0].args[2]
        self.assertIn("### Upstream Context from Task 'Data fetch'", content)
        self.assertIn("Fetched 42 articles", content)


class TestGetUserTimezoneDaemon(unittest.TestCase):
    @patch("cron_scheduler._sb_get")
    def test_fetches_preference(self, mock_get):
        mock_get.return_value = [{"value": "Europe/Berlin"}]
        self.assertEqual(cron_scheduler._get_user_timezone("u1"), "Europe/Berlin")
        mock_get.assert_called_once_with("agent_settings", "user_id=eq.u1&key=eq.timezone&select=value")

    @patch("cron_scheduler._sb_get", side_effect=Exception("db down"))
    def test_failure_returns_none(self, mock_get):
        self.assertIsNone(cron_scheduler._get_user_timezone("u1"))


class TestResolveTzDaemon(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(cron_scheduler._resolve_tz_name("Asia/Tokyo"), "Asia/Tokyo")

    def test_invalid(self):
        self.assertIsNone(cron_scheduler._resolve_tz_name("nope"))
        self.assertIsNone(cron_scheduler._resolve_tz_name(None))


if __name__ == "__main__":
    unittest.main(verbosity=2)
