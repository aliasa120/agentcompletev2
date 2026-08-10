"""
Ask Permission tool — human-in-the-loop permission gate.

Calls `langgraph.types.interrupt` to present an approval dialog to the user
in UI / Telegram / Slack / Email before executing critical or sensitive actions.
"""

from typing import Optional
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from langgraph.types import interrupt


@tool(parse_docstring=True)
def ask_permission(action: str, reason: str, config: Optional[RunnableConfig] = None) -> str:
    """Ask the user for explicit permission before performing a critical, destructive, or high-impact operation.

    Call this tool when you need human confirmation before deleting data, sending emails,
    executing system commands, or modifying critical configurations.

    Args:
        action: Clear title of the action requiring approval (e.g. "Drop users table", "Deploy to prod").
        reason: Detailed justification for why this action is needed and potential risks.
        config: LangChain runnable config (automatically injected).

    Returns:
        Status indicating whether the user approved or rejected the request.
    """
    decision = interrupt({
        "action_requests": [{
            "name": "ask_permission",
            "args": {"action": action, "reason": reason},
            "description": f"Permission Request: {action}\nReason: {reason}",
        }],
        "review_configs": [{
            "action_name": "ask_permission",
            "allowed_decisions": ["approve", "reject"],
        }],
    })

    decisions = (decision or {}).get("decisions") or [{}]
    first = decisions[0] or {}
    dtype = first.get("type")

    if dtype == "approve":
        return f"✅ Permission GRANTED by user for action: '{action}'. You may now proceed."
    else:
        # The UI approval cards resume with {"type": "reject", "message": ...};
        # accept "message" first, then legacy "feedback".
        feedback = first.get("message") or first.get("feedback") or "User rejected the permission request."
        return f"❌ Permission DENIED by user for action: '{action}'. Feedback: {feedback}"
