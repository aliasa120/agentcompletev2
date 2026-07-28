"""Evidence Builder — constructs standard EvidencePacket from completed turn context."""

import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("skills_engine.evidence_builder")


def build_evidence_packet(
    task_id: str,
    user_id: Optional[str],
    workflow_id: Optional[str],
    agent_id: Optional[str] = None,
    task_description: str = "",
    execution_status: str = "completed",
    iterations: int = 1,
    conversation_log: List[Dict[str, Any]] = None,
    tool_timeline: List[Dict[str, Any]] = None,
    selected_skill_ids: Optional[List[str]] = None,
    skill_contents: Optional[Dict[str, str]] = None,
    error_traces: Optional[List[Dict[str, Any]]] = None,
    fallback_sequences: Optional[List[Dict[str, Any]]] = None,
    skill_read_sequence: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Construct a clean, serializable EvidencePacket dictionary.
    
    Enhanced with learning signals:
      - error_traces: Tool failures and their error messages
      - fallback_sequences: When tool A failed, agent used tool B instead
      - skill_read_sequence: Which skills were read and in what order
      - task_complexity_score: derived from unique tools + iterations
    """
    conversation_log = conversation_log or []
    tool_timeline = tool_timeline or []
    
    # Process conversation log for compact representation
    processed_log = []
    for msg in conversation_log:
        role = msg.get("role") or msg.get("type") or "unknown"
        content = msg.get("content") or ""
        
        # Truncate overly long tool outputs
        if role in ["tool_result", "tool", "function"] and len(str(content)) > 2000:
            content = str(content)[:2000] + "... [truncated]"
            
        processed_log.append({
            "role": role,
            "name": msg.get("name"),
            "content": content,
            "tool_call_id": msg.get("tool_call_id"),
            "error": msg.get("error")
        })

    used_tool_keys = list({t.get("tool") for t in tool_timeline if t.get("tool")})
    task_complexity = len(used_tool_keys) + iterations

    return {
        "task_id": task_id,
        "user_id": str(user_id) if user_id else "anonymous",
        "workflow_id": str(workflow_id) if workflow_id else "default",
        "agent_id": str(agent_id) if agent_id else None,
        "task_description": task_description,
        "execution_status": execution_status,
        "iterations": iterations,
        "selected_skill_ids": selected_skill_ids or [],
        "skill_contents": skill_contents or {},
        "conversation_log": processed_log,
        "tool_timeline": tool_timeline,
        "used_tool_keys": used_tool_keys,
        "error_traces": error_traces or [],
        "fallback_sequences": fallback_sequences or [],
        "skill_read_sequence": skill_read_sequence or [],
        "task_complexity_score": task_complexity,
    }

