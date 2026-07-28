"""Semantic Deduplication Gate — prevents library bloat by checking similarity against existing skills."""

import re
import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("skills_engine.dedup_gate")


class SemanticDedupGate:
    """Calculates similarity between proposed skill and existing skills.
    
    If similarity > threshold (e.g. 0.85), halts duplicate skill creation
    and converts CAPTURED into a DERIVED/FIX update on the existing skill.
    """

    def __init__(self, threshold_percent: int = 85):
        self.threshold = threshold_percent / 100.0

    def check_duplicate(
        self,
        proposed_name: str,
        proposed_direction: str,
        existing_skills: List[Dict[str, Any]],
    ) -> Tuple[bool, Optional[Dict[str, Any]], float]:
        """Check if proposed skill matches any existing active skill.

        Returns:
            (is_duplicate, matching_skill_dict, max_similarity_score)
        """
        if not existing_skills:
            return False, None, 0.0

        p_tokens = self._tokenize(f"{proposed_name} {proposed_direction}")
        if not p_tokens:
            return False, None, 0.0

        best_match = None
        max_score = 0.0

        for skill in existing_skills:
            name = skill.get("skill_key") or skill.get("name") or ""
            desc = skill.get("description") or ""
            content = skill.get("content") or ""
            
            # 1. Name & stem similarity check
            clean_p_name = self._slugify(proposed_name)
            clean_s_name = self._slugify(name)
            
            stem_p = clean_p_name.rstrip("s").rstrip("er").rstrip("or").rstrip("ing")
            stem_s = clean_s_name.rstrip("s").rstrip("er").rstrip("or").rstrip("ing")

            if clean_p_name == clean_s_name or clean_p_name in clean_s_name or clean_s_name in clean_p_name or stem_p == stem_s:
                logger.info(f"[SemanticDedupGate] Match found: '{proposed_name}' matches existing skill '{name}'")
                return True, skill, 1.0


            # 2. Jaccard & overlap similarity over tokenized text
            s_tokens = self._tokenize(f"{name} {desc} {content[:500]}")
            if not s_tokens:
                continue

            intersection = p_tokens.intersection(s_tokens)
            union = p_tokens.union(s_tokens)
            jaccard = len(intersection) / len(union) if union else 0.0
            
            # Direction overlap ratio
            overlap_ratio = len(intersection) / len(p_tokens) if p_tokens else 0.0
            combined_score = max(jaccard * 1.5, overlap_ratio)

            if combined_score > max_score:
                max_score = combined_score
                best_match = skill

        if max_score >= self.threshold and best_match:
            logger.info(
                f"[DedupGate] Blocked duplicate '{proposed_name}'. Matches existing '{best_match.get('skill_key')}' (similarity: {max_score:.2f})"
            )
            return True, best_match, max_score

        return False, None, max_score

    @staticmethod
    def _tokenize(text: str) -> set[str]:
        words = re.findall(r"\w+", text.lower())
        stopwords = {
            "a", "an", "the", "and", "or", "in", "on", "at", "to", "for", "with",
            "by", "of", "is", "are", "was", "were", "be", "been", "being", "this",
            "that", "these", "those", "how", "what", "which", "use", "make", "create"
        }
        return {w for w in words if len(w) > 2 and w not in stopwords}

    @staticmethod
    def _slugify(text: str) -> str:
        return re.sub(r"[^a-z0-9]", "", text.lower().strip())
