"""ExecutionAnalyzer — post-chat analysis pass using LLM judgment."""

import json
import logging
import os
from typing import Any, Dict, List, Optional

from research_agent.skills_engine.evolution_prompts import DEFAULT_EXECUTION_ANALYSIS_TEMPLATE
from research_agent.tools.provider_engine import get_llm

logger = logging.getLogger("skills_engine.execution_analyzer")


def _get_supabase_client():
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        return None
    return create_client(url, key)


class ExecutionAnalyzer:
    """Runs LLM judgment pass over an EvidencePacket to determine quality and evolution suggestions."""

    def __init__(self, user_id: Optional[str] = None):
        self.user_id = user_id
        self.settings = self._load_user_settings(user_id)

    def _load_user_settings(self, user_id: Optional[str]) -> Dict[str, Any]:
        default_settings = {
            "analysis_provider": "openrouter",
            "analysis_model": "xiaomi/mimo-v2.5-pro",
            "evolution_provider": "openrouter",
            "evolution_model": "xiaomi/mimo-v2.5-pro",
            "skip_pure_chat": True,
            "analysis_prompt_override": None,
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
                    "analysis_provider": user_cfg.get("analysis_provider") or default_settings["analysis_provider"],
                    "analysis_model": user_cfg.get("analysis_model") or default_settings["analysis_model"],
                    "evolution_provider": user_cfg.get("evolution_provider") or default_settings["evolution_provider"],
                    "evolution_model": user_cfg.get("evolution_model") or default_settings["evolution_model"],
                    "skip_pure_chat": bool(user_cfg.get("skip_pure_chat", True)),
                    "analysis_prompt_override": user_cfg.get("analysis_prompt_override"),
                })
        except Exception as e:
            logger.debug(f"Failed to fetch user evolution settings for {user_id}: {e}")

        return default_settings

    async def analyze_packet(self, packet: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Run analysis on an EvidencePacket. Returns structured judgment dictionary or None."""
        
        # 1. Skip check: pure Q&A turns with no tool calls and no skill used
        if self.settings.get("skip_pure_chat"):
            tools_used = packet.get("used_tool_keys") or []
            skills_used = packet.get("selected_skill_ids") or []
            status = packet.get("execution_status")
            if not tools_used and not skills_used and status == "completed":
                logger.info(f"[ExecutionAnalyzer] Skipping pure chat turn {packet.get('task_id')}")
                return None

        # 2. Build analysis prompt
        prompt_template = self.settings.get("analysis_prompt_override") or DEFAULT_EXECUTION_ANALYSIS_TEMPLATE
        
        skills_formatted = ""
        skill_contents = packet.get("skill_contents") or {}
        if skill_contents:
            skills_formatted = "## Selected Skills Content\n" + "\n---\n".join([
                f"### Skill ID: {sid}\n{content}" for sid, content in skill_contents.items()
            ])
            
        traj_summary = json.dumps(packet.get("tool_timeline") or [], indent=2)
        conv_log = json.dumps(packet.get("conversation_log") or [], indent=2)
        error_traces = json.dumps(packet.get("error_traces") or [], indent=2)
        fallback_sequences = json.dumps(packet.get("fallback_sequences") or [], indent=2)

        prompt = prompt_template.format(
            task_description=packet.get("task_description", ""),
            execution_status=packet.get("execution_status", "completed"),
            iterations=packet.get("iterations", 1),
            task_complexity_score=packet.get("task_complexity_score", 1),
            tool_list=", ".join(packet.get("used_tool_keys") or ["none"]),
            skill_section=skills_formatted,
            error_traces=error_traces,
            fallback_sequences=fallback_sequences,
            traj_summary=traj_summary,
            conversation_log=conv_log,
            selected_skill_ids_json=json.dumps(packet.get("selected_skill_ids") or [])
        )

        # 3. Call Analysis LLM model with tool-calling loop (list_skills, read_skill)
        provider_name = self.settings.get("analysis_provider", "openrouter")
        model_name = self.settings.get("analysis_model", "google/gemini-2.0-flash")
        user_id_val = packet.get("user_id") or self.user_id
        agent_id_val = packet.get("agent_id") or packet.get("workflow_id")
        logger.info(f"[ExecutionAnalyzer] Running analysis for task {packet.get('task_id')} using provider '{provider_name}' model '{model_name}' user_id '{user_id_val}' agent_id '{agent_id_val}'")

        try:
            from research_agent.skills_engine.tool_inspector import get_skills_engine_tools
            from langchain_core.messages import HumanMessage, ToolMessage

            tools = get_skills_engine_tools(user_id=user_id_val, agent_id=agent_id_val)
            # Analyzer only gets list_skills and read_skill
            analyzer_tools = [t for t in tools if getattr(t, "name", "") in ("list_skills", "read_skill")]
            tool_map = {getattr(t, "name", ""): t for t in analyzer_tools}
            config = {"configurable": {"user_id": user_id_val, "agent_id": agent_id_val}}

            llm = get_llm(provider_name=provider_name, model_name=model_name, user_id=user_id_val)
            
            if analyzer_tools and hasattr(llm, "bind_tools"):
                llm_with_tools = llm.bind_tools(analyzer_tools)
                messages = [HumanMessage(content=prompt)]

                # ReAct loop (max 3 tool calls)
                for loop_idx in range(3):
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
                                logger.info(f"[ExecutionAnalyzer] Tool call: {t_name}({t_args})")
                                tool_output = await tool_map[t_name].ainvoke(t_args, config=config)
                            except Exception as t_err:
                                tool_output = f"Tool execution error: {t_err}"
                            messages.append(ToolMessage(
                                content=str(tool_output),
                                tool_call_id=tool_call.get("id", f"call_{loop_idx}_{t_name}")
                            ))
                content = response.content
                if isinstance(content, list):
                    content = "".join([c.get("text", "") if isinstance(c, dict) else str(c) for c in content])
                else:
                    content = str(content)
                content = content.strip()

                if not content:
                    logger.info("[ExecutionAnalyzer] Content empty after tool loop, requesting final JSON verdict from LLM...")
                    final_resp = await llm.ainvoke(messages, config=config)
                    content = final_resp.content
                    if isinstance(content, list):
                        content = "".join([c.get("text", "") if isinstance(c, dict) else str(c) for c in content])
                    else:
                        content = str(content)
                    content = content.strip()
            else:
                response = await llm.ainvoke(prompt)
                content = getattr(response, "content", str(response)).strip()

            judgment = _parse_llm_json(content)


            # Save analysis result to Supabase
            await self._persist_analysis(packet, judgment, f"{provider_name}/{model_name}")
            return judgment

        except Exception as e:
            logger.error(f"[ExecutionAnalyzer] Error analyzing packet {packet.get('task_id')}: {e} (raw content: {repr(content[:200]) if 'content' in locals() else 'N/A'})")
            return None

    async def _persist_analysis(self, packet: Dict[str, Any], judgment: Dict[str, Any], model_name: str) -> None:
        sb = _get_supabase_client()
        if not sb:
            return

        row = {
            "user_id": packet.get("user_id"),
            "workflow_id": packet.get("workflow_id"),
            "task_id": packet.get("task_id"),
            "task_description": packet.get("task_description"),
            "task_completed": bool(judgment.get("task_completed", True)),
            "execution_note": judgment.get("execution_note", ""),
            "tool_issues": judgment.get("tool_issues") or [],
            "skill_judgments": judgment.get("skill_judgments") or [],
            "evolution_suggestions": judgment.get("evolution_suggestions") or [],
            "analysis_model": model_name,
        }

        try:
            sb.table("skill_execution_analyses").upsert(row, on_conflict="task_id").execute()
            logger.info(f"[ExecutionAnalyzer] Persisted analysis verdict for task {packet.get('task_id')}")
        except Exception as e:
            logger.warning(f"[ExecutionAnalyzer] Failed to persist analysis to Supabase: {e}")


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



def _parse_llm_json(content: str) -> Dict[str, Any]:

    content = content.strip()
    if "```" in content:
        parts = content.split("```")
        for p in parts:
            p_clean = p.strip()
            if p_clean.startswith("json"):
                p_clean = p_clean[4:].strip()
            if p_clean.startswith("{") and p_clean.endswith("}"):
                try:
                    return json.loads(p_clean)
                except Exception:
                    pass

    try:
        return json.loads(content)
    except Exception:
        pass

    import re
    match = re.search(r"\{.*\}", content, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except Exception:
            pass

    raise ValueError(f"Could not parse valid JSON from LLM response content: '{content[:300]}...'")

