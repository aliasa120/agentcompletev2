"""Skills Engine Orchestrator — post-chat entry point.

Called after every completed agent turn in the background:
1. Builds EvidencePacket
2. Runs ExecutionAnalyzer (AI Analysis pass)
3. Runs SemanticDedupGate check
4. Runs SkillEvolver (AI Evolution pass with tool schema verification)
5. Handles Provisional-to-Trusted promotion
"""

import asyncio
import logging
import uuid
from typing import Any, Dict, List, Optional

from research_agent.skills_engine.evidence_builder import build_evidence_packet
from research_agent.skills_engine.execution_analyzer import ExecutionAnalyzer
from research_agent.skills_engine.skill_evolver import SkillEvolver
from research_agent.skills_engine.skill_trust import SkillTrustManager

logger = logging.getLogger("skills_engine.orchestrator")


async def process_completed_turn_skills(
    task_id: Optional[str],
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
) -> Optional[Dict[str, Any]]:
    """Main post-chat background handler for skills intelligence."""
    
    if not task_id:
        task_id = f"task_{uuid.uuid4().hex[:12]}"

    conversation_log = conversation_log or []
    tool_timeline = tool_timeline or []

    try:
        # 1. Build Evidence Packet
        packet = build_evidence_packet(
            task_id=task_id,
            user_id=user_id,
            workflow_id=workflow_id,
            agent_id=agent_id or workflow_id,
            task_description=task_description,
            execution_status=execution_status,
            iterations=iterations,
            conversation_log=conversation_log,
            tool_timeline=tool_timeline,
            selected_skill_ids=selected_skill_ids,
            skill_contents=skill_contents,
            error_traces=error_traces,
            fallback_sequences=fallback_sequences,
            skill_read_sequence=skill_read_sequence,
        )

        # 2. Check & record provisional skill test outcome (for Trust Promotion)
        trust_manager = SkillTrustManager(user_id=user_id)
        for sid in (selected_skill_ids or []):
            promoted = await trust_manager.record_provisional_outcome(sid, outcome=execution_status)
            if promoted:
                logger.info(f"🎉 Skill '{sid}' promoted to TRUSTED after successful test run!")

        # 3. Execution Analyzer (AI Analysis pass with tool calling)
        analyzer = ExecutionAnalyzer(user_id=user_id)
        judgment = await analyzer.analyze_packet(packet)
        if not judgment:
            logger.info(f"[SkillsEngine] Analysis skipped or returned empty for task {task_id}")
            return None

        suggestions = judgment.get("evolution_suggestions") or []
        if not suggestions:
            logger.info(f"[SkillsEngine] Analysis finished for task {task_id}: no evolution needed.")
            return {"judgment": judgment, "evolved_skills": []}

        # 4. Skill Evolver (AI Evolution pass with Dedup Gate & Tool Inspection)
        evolver = SkillEvolver(user_id=user_id)
        evolved_skills = await evolver.evolve_suggestions(
            suggestions=suggestions,
            packet=packet,
            workflow_id=workflow_id or agent_id
        )

        logger.info(f"✨ [SkillsEngine] Completed evolution for task {task_id}: {len(evolved_skills)} provisional skill(s) generated.")
        return {
            "judgment": judgment,
            "evolved_skills": evolved_skills
        }

    except Exception as e:
        logger.error(f"[SkillsEngine] Background turn skills processing failed for task {task_id}: {e}")
        return None

