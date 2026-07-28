"""Skills Engine — OpenSpace-inspired intelligence and evolution system for agent skills.

Provides post-chat analysis, semantic deduplication, AI-driven skill evolution,
tool schema verification, and provisional-to-trusted promotion.
"""

from .evidence_builder import build_evidence_packet
from .execution_analyzer import ExecutionAnalyzer
from .dedup_gate import SemanticDedupGate
from .tool_inspector import get_tool_definition, get_all_tool_definitions
from .skill_evolver import SkillEvolver
from .skill_trust import SkillTrustManager

__all__ = [
    "build_evidence_packet",
    "ExecutionAnalyzer",
    "SemanticDedupGate",
    "get_tool_definition",
    "get_all_tool_definitions",
    "SkillEvolver",
    "SkillTrustManager",
]
