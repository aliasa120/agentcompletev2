"""SkillTrustManager — manages PROVISIONAL ➔ TRUSTED promotion system."""

import logging
import os
from typing import Any, Dict, List, Optional

logger = logging.getLogger("skills_engine.skill_trust")


def _get_supabase_client():
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        return None
    return create_client(url, key)


class SkillTrustManager:
    """Tracks real-world test outcomes for PROVISIONAL skills and promotes them to TRUSTED."""

    def __init__(self, user_id: Optional[str] = None):
        self.user_id = user_id

    async def record_provisional_outcome(
        self,
        skill_key: str,          # ← skill_key name (e.g. "web_research"), NOT uuid
        outcome: str,
        trust_promotion_count: int = 2
    ) -> bool:
        """Record real-world test execution outcome for a provisional skill.

        The orchestrator passes skill_key strings (captured from read_skill() calls),
        so we look up by skill_key, not skill_id.

        Returns True if skill was promoted to TRUSTED.
        """
        sb = _get_supabase_client()
        if not sb:
            return False

        try:
            # 1. Fetch current skill state by skill_key
            query = sb.table("skills_library").select("*").eq("skill_key", skill_key).eq("trust_state", "provisional")
            if self.user_id:
                query = query.eq("user_id", self.user_id)
            res = query.execute()

            if not res.data or len(res.data) == 0:
                # Not a provisional skill — might be trusted already, or doesn't exist. Either way, skip.
                logger.debug(f"[SkillTrustManager] No provisional skill found for key='{skill_key}' — skipping")
                return False

            skill = res.data[0]
            row_id = skill.get("id")  # UUID primary key
            current_uses = skill.get("use_count", 0) + 1
            is_success = (outcome in ["completed", "success"])

            # 2. Update use count & last used timestamp
            sb.table("skills_library").update({
                "use_count": current_uses,
                "last_used_at": "now()"
            }).eq("id", row_id).execute()

            logger.info(f"[SkillTrustManager] Provisional '{skill_key}' use_count now {current_uses}/{trust_promotion_count}")

            # 3. Check for promotion criteria (e.g. 2 successful runs)
            if is_success and current_uses >= trust_promotion_count:
                await self.promote_to_trusted(row_id, parent_skill_id=skill.get("parent_skill_id"))
                return True
            elif not is_success:
                logger.warning(f"[SkillTrustManager] Provisional skill '{skill_key}' failed test run {current_uses}")

        except Exception as e:
            logger.error(f"[SkillTrustManager] Failed to record provisional outcome for '{skill_key}': {e}")

        return False

    async def promote_to_trusted(self, row_id: str, parent_skill_id: Optional[str] = None) -> bool:
        """Promote a PROVISIONAL skill to TRUSTED and activate it. Uses UUID row id."""
        sb = _get_supabase_client()
        if not sb:
            return False

        try:
            # 1. Activate new skill & mark TRUSTED
            sb.table("skills_library").update({
                "trust_state": "trusted",
                "is_active": True
            }).eq("id", row_id).execute()

            logger.info(f"[SkillTrustManager] Promoted PROVISIONAL skill (id={row_id}) to TRUSTED and LIVE!")

            # 2. Deactivate old parent version if present
            if parent_skill_id:
                sb.table("skills_library").update({
                    "is_active": False
                }).eq("skill_id", parent_skill_id).execute()
                logger.info(f"[SkillTrustManager] Deactivated parent skill '{parent_skill_id}' in favor of updated version")

            return True

        except Exception as e:
            logger.error(f"[SkillTrustManager] Failed to promote skill id={row_id}: {e}")
            return False

