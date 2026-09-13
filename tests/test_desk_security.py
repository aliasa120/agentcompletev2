import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from research_agent.tools import desk
from research_agent.tools import dynamic_router


class TestDeskValidation(unittest.TestCase):
    def test_duplicate_field_mapping_is_rejected(self):
        buttons = [{"id": "send", "label": "Send", "kind": "execute", "tool_name": "demo", "args": {}}]
        fields = [
            {"name": "first", "arg_key": "recipient", "type": "text"},
            {"name": "second", "arg_key": "recipient", "type": "text"},
        ]
        result = desk._validate_execute_buttons(buttons, "user-1", fields)
        self.assertFalse(result["ok"])
        self.assertIn("unique", result["error"])

    def test_select_without_options_is_rejected(self):
        buttons = [{"id": "send", "label": "Send", "kind": "execute", "tool_name": "demo", "args": {}}]
        fields = [{"name": "channel", "type": "select"}]
        result = desk._validate_execute_buttons(buttons, "user-1", fields)
        self.assertFalse(result["ok"])
        self.assertIn("requires options", result["error"])

    def test_privileged_client_does_not_fall_back_to_anon_key(self):
        with patch.dict(os.environ, {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_ANON_KEY": "anon"}, clear=True):
            with self.assertRaises(RuntimeError):
                desk._get_supabase_client()


class TestDeskExecutionOutcome(unittest.TestCase):
    @patch("research_agent.tools.dynamic_router._execute_tool")
    def test_structured_error_is_failure(self, execute):
        execute.return_value = '{"error":"provider failed"}'
        result = dynamic_router.execute_tool_for_desk("demo", {}, "agent-1", config={})
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "tool_error")

    @patch("research_agent.tools.dynamic_router._execute_tool")
    def test_structured_success_false_is_failure(self, execute):
        execute.return_value = '{"success":false,"message":"denied"}'
        result = dynamic_router.execute_tool_for_desk("demo", {}, "agent-1", config={})
        self.assertFalse(result["ok"])

    @patch("research_agent.tools.dynamic_router._execute_tool")
    def test_plain_output_is_success(self, execute):
        execute.return_value = "completed"
        result = dynamic_router.execute_tool_for_desk("demo", {}, "agent-1", config={})
        self.assertTrue(result["ok"])
        self.assertEqual(result["output"], "completed")


class TestDeskStatusTransition(unittest.TestCase):
    @patch("research_agent.tools.desk._get_supabase_client")
    def test_transition_is_scoped_by_user_and_execution(self, get_client):
        response = MagicMock(data=[{"id": "task-1"}])
        execute = MagicMock(return_value=response)
        rpc = MagicMock()
        rpc.execute = execute
        client = MagicMock()
        client.rpc.return_value = rpc
        get_client.return_value = client

        ok = desk.update_desk_task_status(
            task_id="task-1",
            user_id="user-1",
            execution_id="execution-1",
            expected_status="executing",
            status="done",
            result="ok",
        )

        self.assertTrue(ok)
        client.rpc.assert_called_once_with("transition_desk_task_execution", {
            "p_task_id": "task-1",
            "p_user_id": "user-1",
            "p_execution_id": "execution-1",
            "p_expected_status": "executing",
            "p_status": "done",
            "p_result": "ok",
            "p_error": None,
            "p_executed_at": None,
            "p_run_id": None,
        })

    def test_missing_scope_blocks_transition(self):
        self.assertFalse(desk.update_desk_task_status("task-1", "", "execution-1", "executing", "done"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
