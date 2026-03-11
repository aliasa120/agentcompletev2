"""Feeder Dedup Agent — Tools

The agent calls exactly ONE tool: submit_dedup_result
That's its only output channel — structured, typed, parseable.
"""
import json
from typing import Any


def make_submit_tool() -> dict:
    """Returns the OpenAI-style tool definition for submit_dedup_result."""
    return {
        "type": "function",
        "function": {
            "name": "submit_dedup_result",
            "description": (
                "Submit the final deduplication decision. "
                "Call this once after completing both Phase 1 and Phase 2."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "kept_ids": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "List of article IDs (1-based index from batch) to KEEP and pass to the pipeline.",
                    },
                    "dropped": {
                        "type": "array",
                        "description": "Articles being dropped with reasons.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "integer", "description": "1-based article ID"},
                                "reason": {"type": "string", "description": "Why this article is being dropped"},
                            },
                            "required": ["id", "reason"],
                        },
                    },
                    "summary": {
                        "type": "string",
                        "description": "1-2 sentence summary of the deduplication decisions made.",
                    },
                },
                "required": ["kept_ids", "dropped", "summary"],
            },
        }
    }


def parse_tool_call(response_message: Any) -> dict | None:
    """
    Extract the tool call arguments from a response message.
    Returns parsed dict or None if no tool call found.
    """
    tool_calls = getattr(response_message, "tool_calls", None)
    if not tool_calls:
        return None

    for tc in tool_calls:
        if tc.function.name == "submit_dedup_result":
            try:
                return json.loads(tc.function.arguments)
            except json.JSONDecodeError as e:
                print(f"  [FeederAgent] JSON parse error: {e}")
                return None

    return None
