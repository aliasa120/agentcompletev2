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
                "List all duplicate articles in `dropped` with reasons naming the kept article."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "dropped": {
                        "type": "array",
                        "description": "List of duplicate articles to drop (must name what they duplicate).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "integer", "description": "1-based article ID from the current batch to drop"},
                                "reason": {"type": "string", "description": "Why dropped — e.g. 'Same PIMS fire storyline as #2' or 'Already in DB'"},
                            },
                            "required": ["id", "reason"],
                        },
                    },
                    "storylines": {
                        "type": "array",
                        "description": "Storyline clusters found across the batch.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string", "description": "Short storyline name, e.g. 'PIMS hospital fire'"},
                                "kept_id": {"type": "integer", "description": "Batch ID kept as this storyline's main article"},
                                "dropped_ids": {
                                    "type": "array",
                                    "items": {"type": "integer"},
                                    "description": "Batch IDs dropped as duplicate members of this storyline",
                                },
                            },
                            "required": ["label", "kept_id", "dropped_ids"],
                        },
                    },
                    "summary": {
                        "type": "string",
                        "description": "1-2 sentence summary of deduplication decisions.",
                    },
                },
                "required": ["dropped", "summary"],
            },
        }
    }


def make_verify_tool() -> dict:
    """Returns the OpenAI-style tool definition for the Pass-2 verifier's
    submit_verify_result call. Verifier authority is DROP-ONLY."""
    return {
        "type": "function",
        "function": {
            "name": "submit_verify_result",
            "description": (
                "Submit the verification decision. List ONLY the survivor IDs that "
                "must still be dropped (duplicates missed by pass 1). Everything "
                "not listed is approved automatically."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "dropped": {
                        "type": "array",
                        "description": "Survivor IDs to drop after all (duplicates pass 1 missed).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "integer", "description": "1-based survivor ID"},
                                "reason": {"type": "string", "description": "What it duplicates (survivor ID or DB title)"},
                            },
                            "required": ["id", "reason"],
                        },
                    },
                    "summary": {
                        "type": "string",
                        "description": "1-2 sentence summary of the verification.",
                    },
                },
                "required": ["dropped", "summary"],
            },
        },
    }


def parse_tool_call(response_message: Any) -> dict | None:
    """
    Extract the tool call arguments from a response message.
    Returns parsed dict or None if no tool call found.
    """
    tool_calls = getattr(response_message, "tool_calls", None)
    if not tool_calls:
        return None

    ACCEPTED = {"submit_dedup_result", "submit_verify_result"}
    for tc in tool_calls:
        if tc.function.name in ACCEPTED:
            try:
                return json.loads(tc.function.arguments)
            except json.JSONDecodeError as e:
                print(f"  [FeederAgent] JSON parse error: {e}")
                return None

    return None
