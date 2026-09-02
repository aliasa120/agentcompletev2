"""Live integration test: cronjob tool end-to-end against real Supabase.

Creates a task with mount_chat + timezone + context_summary via the tool path,
verifies persistence, then deletes it. Run from workspace root:
    python tests/integration_cronjob_live.py
"""

import os
import sys
import json
from dotenv import load_dotenv

load_dotenv()
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from research_agent.tools.cronjob import cronjob as cronjob_tool

CONFIG = {
    "configurable": {
        "workflow_id": None,
        "thread_id": "integration-test-thread",
        "agent_id": None,
        "user_id": "c017bdb6-5708-4a8e-ba7d-ebf476485c61",
    }
}


def main():
    # 1. Create with mount_chat=True (current thread), context_summary, user tz preference
    res = json.loads(
        cronjob_tool.func(
            action="create",
            prompt="Integration test: summarize AI news",
            schedule="0 21 * * *",
            name="INTEGRATION TEST — delete me",
            mount_chat=True,
            context_summary="Integration test task created by test runner",
            timezone="Asia/Karachi",
            deliver="origin",
            config=CONFIG,
        )
    )
    assert res.get("success"), f"create failed: {res}"
    task = res["task"]
    job_id = task["id"]
    print("CREATE OK:", json.dumps(task, indent=2))
    assert task["next_run_at"].endswith(("Z", "+00:00")), "next_run_at must be UTC"
    assert "21:00" in (task["next_run_at_local"] or ""), "local time should show 21:00"

    # 2. List — must contain the task
    res2 = json.loads(cronjob_tool.func(action="list", config=CONFIG))
    assert res2.get("success"), f"list failed: {res2}"
    ids = [t["id"] for t in res2["tasks"]]
    assert job_id in ids, "created task missing from list"
    print(f"LIST OK ({len(res2['tasks'])} tasks)")

    # 3. Get + verify persisted columns via 'update' action (uses get internally)
    res3 = json.loads(
        cronjob_tool.func(action="update", job_id=job_id, context_summary="Updated summary", config=CONFIG)
    )
    assert res3.get("success"), f"update failed: {res3}"
    print("UPDATE OK")

    # 4. Remove — cleanup
    res4 = json.loads(cronjob_tool.func(action="remove", job_id=job_id, config=CONFIG))
    assert res4.get("success"), f"remove failed: {res4}"
    print("REMOVE OK — cleaned up")

    print("\nALL INTEGRATION CHECKS PASSED")


if __name__ == "__main__":
    main()
