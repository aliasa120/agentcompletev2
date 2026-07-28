"""SkillEvolver — generates updated or new skills (FIX, DERIVED, CAPTURED) using Evolution AI Model."""

import json
import logging
import os
import uuid
from typing import Any, Dict, List, Optional

from research_agent.skills_engine.evolution_prompts import (
    DEFAULT_EVOLUTION_FIX_TEMPLATE,
    DEFAULT_EVOLUTION_DERIVED_TEMPLATE,
    DEFAULT_EVOLUTION_CAPTURED_TEMPLATE,
)
from research_agent.skills_engine.tool_inspector import get_all_tool_definitions
from research_agent.skills_engine.dedup_gate import SemanticDedupGate
from research_agent.tools.provider_engine import get_llm

logger = logging.getLogger("skills_engine.skill_evolver")


def _get_supabase_client():
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        return None
    return create_client(url, key)


class SkillEvolver:
    """Generates improved or new SKILL.md packages and saves them as PROVISIONAL skills."""

    def __init__(self, user_id: Optional[str] = None):
        self.user_id = user_id
        self.settings = self._load_user_settings(user_id)
        self.dedup_gate = SemanticDedupGate(
            threshold_percent=self.settings.get("dedup_threshold_percent", 85)
        )

    def _load_user_settings(self, user_id: Optional[str]) -> Dict[str, Any]:
        default_settings = {
            "evolution_provider": "openrouter",
            "evolution_model": "google/gemini-2.5-flash",
            "dedup_threshold_percent": 85,
            "fix_prompt_override": None,
            "derived_prompt_override": None,
            "captured_prompt_override": None,
        }
        if not user_id:
            return default_settings

        sb = _get_supabase_client()
        if not sb:
            return default_settings

        try:
            res = sb.table("skill_evolution_settings").select("*").eq("user_id", user_id).execute()
            if res.data and len(res.data) > 0:
                user_cfg = res.data[0]
                default_settings.update({
                    "evolution_provider": user_cfg.get("evolution_provider") or default_settings["evolution_provider"],
                    "evolution_model": user_cfg.get("evolution_model") or default_settings["evolution_model"],
                    "dedup_threshold_percent": user_cfg.get("dedup_threshold_percent", 85),
                    "fix_prompt_override": user_cfg.get("fix_prompt_override"),
                    "derived_prompt_override": user_cfg.get("derived_prompt_override"),
                    "captured_prompt_override": user_cfg.get("captured_prompt_override"),
                })
        except Exception as e:
            logger.debug(f"Failed to fetch evolution settings for {user_id}: {e}")

        return default_settings


    async def evolve_suggestions(
        self,
        suggestions: List[Dict[str, Any]],
        packet: Dict[str, Any],
        workflow_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Process evolution suggestions from Analysis verdict and create provisional skills."""
        if not suggestions:
            return []

        evolved_skills = []
        user_id_val = packet.get("user_id") or self.user_id
        active_skills = self._fetch_active_skills(user_id_val, workflow_id)

        for sugg in suggestions:
            evo_type = str(sugg.get("type", "")).lower()
            target_skills = sugg.get("target_skills") or []
            direction = sugg.get("direction", "")

            # ── Deduplication Gate Check for CAPTURED suggestions ──────────
            if evo_type == "captured":
                proposed_name = (target_skills[0] if target_skills else direction[:40]).strip().replace(" ", "-").lower()
                is_dup, matching_skill, score = self.dedup_gate.check_duplicate(
                    proposed_name, direction, active_skills
                )
                if is_dup and matching_skill:
                    logger.info(f"[SkillEvolver] CAPTURED suggestion matched existing skill '{matching_skill.get('skill_key')}' ({score:.2f}). Converting to DERIVED/FIX update.")
                    evo_type = "derived"
                    target_skills = [matching_skill.get("skill_id") or matching_skill.get("skill_key")]


            try:
                res = await self._run_evolution(evo_type, target_skills, direction, packet, workflow_id, user_id_val)
                if res:
                    evolved_skills.append(res)
            except Exception as e:
                logger.error(f"[SkillEvolver] Failed to evolve suggestion {evo_type}: {e}")

        return evolved_skills

    async def _run_evolution(
        self,
        evo_type: str,
        target_skills: List[str],
        direction: str,
        packet: Dict[str, Any],
        workflow_id: Optional[str],
        user_id: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        tool_defs = get_all_tool_definitions()
        provider_name = self.settings.get("evolution_provider", "openrouter")
        model_name = self.settings.get("evolution_model", "google/gemini-2.5-flash")
        llm = get_llm(provider_name=provider_name, model_name=model_name, user_id=user_id)

        target_skill_key = target_skills[0] if target_skills else "target_skill"

        if evo_type == "fix":
            template = self.settings.get("fix_prompt_override") or DEFAULT_EVOLUTION_FIX_TEMPLATE
            prompt = template.format(
                target_skill_key=target_skill_key,
                direction=direction,
                failure_context=json.dumps(packet.get("conversation_log", []), indent=2),
                tool_definitions=tool_defs
            )
        elif evo_type == "derived":
            template = self.settings.get("derived_prompt_override") or DEFAULT_EVOLUTION_DERIVED_TEMPLATE
            prompt = template.format(
                parent_skill_key=target_skill_key,
                direction=direction,
                execution_insights=json.dumps(packet.get("conversation_log", []), indent=2),
                tool_definitions=tool_defs
            )
        else: # captured
            template = self.settings.get("captured_prompt_override") or DEFAULT_EVOLUTION_CAPTURED_TEMPLATE
            prompt = template.format(
                direction=direction,
                category=packet.get("category", "workflow"),
                execution_highlights=json.dumps(packet.get("conversation_log", []), indent=2),
                tool_definitions=tool_defs
            )

        logger.info(f"[SkillEvolver] Running {evo_type.upper()} evolution using model {model_name} for workflow_id '{workflow_id}'")

        from research_agent.skills_engine.tool_inspector import get_skills_engine_tools
        from langchain_core.messages import HumanMessage, ToolMessage

        tools = get_skills_engine_tools(user_id=user_id, agent_id=workflow_id)
        tool_map = {getattr(t, "name", ""): t for t in tools}
        config = {"configurable": {"user_id": user_id, "agent_id": workflow_id}}

        manage_skill_called = False
        managed_result = None

        if tools and hasattr(llm, "bind_tools"):
            llm_with_tools = llm.bind_tools(tools)
            messages = [HumanMessage(content=prompt)]

            # ReAct Loop (max 5 iterations for evolution)
            for loop_idx in range(5):
                response = await llm_with_tools.ainvoke(messages, config=config)
                messages.append(response)

                tool_calls = getattr(response, "tool_calls", None)
                if not tool_calls:
                    c_text = response.content if isinstance(response.content, str) else str(response.content)
                    if "<tool_call>" in c_text or "<function=" in c_text:
                        tool_calls = _extract_text_tool_calls(c_text)

                if not tool_calls:
                    break


                for tool_call in tool_calls:
                    t_name = tool_call.get("name")
                    raw_args = tool_call.get("args") or {}
                    t_args = {}
                    if isinstance(raw_args, dict):
                        for k, v in raw_args.items():
                            if str(v).strip().lower() not in ("none", "null", "", "undefined"):
                                t_args[k] = v

                    if t_name in tool_map:
                        try:
                            logger.info(f"[SkillEvolver] Tool call: {t_name}({t_args})")
                            if t_name == "manage_skill":
                                manage_skill_called = True
                                if "trust_state" not in t_args:
                                    t_args["trust_state"] = "provisional"
                                if "origin" not in t_args:
                                    t_args["origin"] = evo_type
                                if "agent_id" not in t_args:
                                    t_args["agent_id"] = workflow_id

                            tool_output = await tool_map[t_name].ainvoke(t_args, config=config)
                            managed_result = tool_output
                        except Exception as t_err:
                            tool_output = f"Tool execution error: {t_err}"
                        messages.append(ToolMessage(
                            content=str(tool_output),
                            tool_call_id=tool_call.get("id", f"call_{loop_idx}_{t_name}")
                        ))


            new_content = response.content
            if isinstance(new_content, list):
                new_content = "".join([c.get("text", "") if isinstance(c, dict) else str(c) for c in new_content])
            else:
                new_content = str(new_content)
            new_content = new_content.strip()

            if not new_content and not manage_skill_called:
                logger.info("[SkillEvolver] Content empty after tool loop, requesting final SKILL.md document from LLM...")
                final_resp = await llm.ainvoke(messages, config=config)
                new_content = final_resp.content
                if isinstance(new_content, list):
                    new_content = "".join([c.get("text", "") if isinstance(c, dict) else str(c) for c in new_content])
                else:
                    new_content = str(new_content)
                new_content = new_content.strip()
        else:
            response = await llm.ainvoke(prompt)
            new_content = getattr(response, "content", str(response)).strip()


        # If manage_skill was executed, return confirmation
        if manage_skill_called and managed_result:
            logger.info(f"[SkillEvolver] manage_skill tool executed successfully during evolution: {managed_result[:100]}")
            return {"status": "success", "result": managed_result}

        # Fallback: if LLM returned markdown without calling manage_skill tool, parse and save directly
        if new_content.startswith("```"):
            parts = new_content.split("```")
            new_content = parts[1] if len(parts) > 1 else new_content
            if new_content.startswith("markdown") or new_content.startswith("yaml"):
                new_content = new_content.split("\n", 1)[1]
        new_content = new_content.strip()

        skill_key = self._extract_skill_key_from_content(new_content, direction)
        gen = 0
        new_skill_id = f"{skill_key}__v{gen}_{uuid.uuid4().hex[:8]}"

        created_skill = await self._save_provisional_skill(
            skill_key=skill_key,
            skill_id=new_skill_id,
            content=new_content,
            origin=evo_type,
            parent_skill_id=target_skill_key if evo_type != "captured" else None,
            generation=gen,
            user_id=user_id,
            workflow_id=workflow_id
        )

        return created_skill

    def _extract_skill_key_from_content(self, content: str, default_dir: str) -> str:
        """Parse `name:` field from SKILL.md YAML frontmatter."""
        import re
        if content.startswith("---"):
            match = re.search(r"\nname:\s*([^\n]+)", content)
            if match:
                clean = re.sub(r"[^a-z0-9_-]", "", match.group(1).strip().lower())
                if clean:
                    return clean
        clean_fallback = re.sub(r"[^a-z0-9_-]", "_", default_dir[:30].strip().lower())
        return clean_fallback or "evolved_skill"

    def _fetch_active_skills(self, user_id: Optional[str], workflow_id: Optional[str]) -> List[Dict[str, Any]]:
        sb = _get_supabase_client()
        if not sb:
            return []
        try:
            res = sb.table("skills_library").select("*").neq("state", "archived").execute()
            return res.data or []
        except Exception:
            return []

    async def _save_provisional_skill(
        self,
        skill_key: str,
        skill_id: str,
        content: str,
        origin: str,
        parent_skill_id: Optional[str],
        generation: int,
        user_id: Optional[str],
        workflow_id: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        sb = _get_supabase_client()
        if not sb:
            return None

        # Extract label and description from frontmatter or default from skill_key
        import re
        label = skill_key.replace("-", " ").replace("_", " ").title()
        description = f"Evolved skill ({origin}) for {label}"
        
        label_match = re.search(r"\nname:\s*([^\n]+)", content)
        if label_match:
            label = label_match.group(1).strip()

        desc_match = re.search(r"\ndescription:\s*([^\n]+)", content)
        if desc_match:
            description = desc_match.group(1).strip()

        row = {
            "skill_key": skill_key,
            "skill_id": skill_id,
            "label": label,
            "description": description,
            "content": content,
            "origin": origin,
            "parent_skill_id": parent_skill_id,
            "generation": generation,
            "trust_state": "provisional",  # In probation!
            "is_active": True,             # Active for creator workflow!
            "use_count": 0,
            "user_id": user_id,
            "created_by_agent_id": workflow_id, # Stamped with workflow_id
        }

        try:
            res = sb.table("skills_library").insert(row).execute()
            logger.info(f"[SkillEvolver] Saved PROVISIONAL skill '{skill_key}' (ID: {skill_id}) to Supabase with created_by_agent_id='{workflow_id}'")

            return res.data[0] if res.data else row
        except Exception as e:
            logger.error(f"[SkillEvolver] Error saving provisional skill to Supabase: {e}")
            return None


def _extract_text_tool_calls(content: str) -> list:
    import re, json
    calls = []
    fn_blocks = re.findall(r"<function=([a-zA-Z0-9_]+)>(.*?)</function>", content, re.DOTALL)
    for fn_name, block in fn_blocks:
        args = {}
        block = block.strip()
        params = re.findall(r"<parameter=([a-zA-Z0-9_]+)>(.*?)</parameter>", block, re.DOTALL)
        if params:
            for p_key, p_val in params:
                args[p_key] = p_val.strip()
        elif block:
            try:
                args = json.loads(block)
            except Exception:
                pass
        calls.append({"name": fn_name, "args": args})

    if calls:
        return calls

    tc_matches = re.findall(r"<tool_call>(.*?)</tool_call>", content, re.DOTALL)
    for tc in tc_matches:
        try:
            data = json.loads(tc.strip())
            if isinstance(data, dict) and "name" in data:
                calls.append({"name": data["name"], "args": data.get("args", {})})
        except Exception:
            pass
    return calls

