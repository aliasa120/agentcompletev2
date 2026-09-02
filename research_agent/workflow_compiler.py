"""Workflow Compiler and Dynamic Agent Graph Loader.

Responsible for:
1. Resolving workflows, agent configs, and tool assignments from Supabase.
2. Binding runtime scope (user_id, agent_id) to skills and dynamic tools.
3. Compiling LangGraph subgraphs per workflow.
4. Input preprocessing (load_memories), voice reply mirroring (finalize_response),
   and history synchronization (save_chat_history).
"""

import os
import re
import uuid
import base64
import mimetypes
import threading
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any

from dotenv import load_dotenv
load_dotenv()

from langchain_core.messages import SystemMessage, AIMessage, ToolCall, ToolMessage
from langchain_core.tools import tool, StructuredTool
from langchain_core.runnables import RunnableConfig
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.human_in_the_loop import (
    HumanInTheLoopMiddleware,
    InterruptOnConfig,
    ActionRequest,
    ReviewConfig,
    HITLRequest,
    Decision,
)

from langgraph.types import interrupt
from deepagents import create_deep_agent
from research_agent.fs_backend import thread_filesystem_backend


class SafeHumanInTheLoopMiddleware(HumanInTheLoopMiddleware):
    """Resilient Human-In-The-Loop middleware that safely handles batch tool approvals,
    broadcasts single 'approve'/'reject' decisions to all batch calls, and unpacks ID-wrapped payloads.
    """
    def after_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        messages = state.get("messages", []) if isinstance(state, dict) else getattr(state, "messages", [])
        if not messages:
            return None

        last_ai_msg = next((msg for msg in reversed(messages) if isinstance(msg, AIMessage)), None)
        if not last_ai_msg or not getattr(last_ai_msg, "tool_calls", None):
            return None

        action_requests: list[ActionRequest] = []
        review_configs: list[ReviewConfig] = []
        interrupt_indices: list[int] = []

        for idx, tool_call in enumerate(last_ai_msg.tool_calls):
            if (config := self.interrupt_on.get(tool_call["name"])) is not None:
                action_request, review_config = self._create_action_and_config(
                    tool_call, config, state, runtime
                )
                action_requests.append(action_request)
                review_configs.append(review_config)
                interrupt_indices.append(idx)

        if not action_requests:
            return None

        hitl_request = HITLRequest(
            action_requests=action_requests,
            review_configs=review_configs,
        )

        raw_resume = interrupt(hitl_request)

        # Unpack resume data robustly
        decisions: list[dict] = []
        if isinstance(raw_resume, dict):
            if "decisions" in raw_resume:
                decisions = raw_resume["decisions"]
            else:
                for v in raw_resume.values():
                    if isinstance(v, dict) and "decisions" in v:
                        decisions = v["decisions"]
                        break
                if not decisions and "type" in raw_resume:
                    decisions = [raw_resume]
        elif isinstance(raw_resume, list):
            decisions = raw_resume
        elif raw_resume in ("approve", True):
            decisions = [{"type": "approve"}]
        elif raw_resume in ("reject", False):
            decisions = [{"type": "reject"}]

        if not isinstance(decisions, list) or not decisions:
            decisions = [{"type": "approve"}]

        # If user passed 1 decision (e.g. 'approve') for N batch calls, expand to all calls
        if len(decisions) == 1 and len(interrupt_indices) > 1:
            decisions = [decisions[0]] * len(interrupt_indices)
        elif len(decisions) < len(interrupt_indices):
            decisions = list(decisions) + [{"type": "approve"} for _ in range(len(interrupt_indices) - len(decisions))]

        # Process decisions and rebuild tool calls in original order
        revised_tool_calls: list[ToolCall] = []
        artificial_tool_messages: list[ToolMessage] = []
        decision_idx = 0

        for idx, tool_call in enumerate(last_ai_msg.tool_calls):
            if idx in interrupt_indices:
                config = self.interrupt_on[tool_call["name"]]
                decision = decisions[decision_idx] if decision_idx < len(decisions) else {"type": "approve"}
                decision_idx += 1

                revised_tool_call, tool_message = self._process_decision(
                    decision, tool_call, config
                )
                if revised_tool_call is not None:
                    revised_tool_calls.append(revised_tool_call)
                if tool_message:
                    artificial_tool_messages.append(tool_message)
            else:
                revised_tool_calls.append(tool_call)

        last_ai_msg.tool_calls = revised_tool_calls
        return {"messages": [last_ai_msg, *artificial_tool_messages]}

    async def aafter_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        return self.after_model(state, runtime)


class CurrentDateTimeMiddleware(AgentMiddleware):
    """Injects the LIVE current date/time into the system prompt on every model call.

    Without this, the date is frozen at process-start time (``{date}`` is substituted
    once at compile time), so a long-running server would tell the model the wrong day.
    Scheduling tools rely on the model knowing "now", so this is refreshed per call
    and rendered in the user's saved scheduler timezone (``agent_settings.timezone``).
    """

    name = "CurrentDateTimeMiddleware"

    def _resolve_timezone(self) -> Optional[str]:
        try:
            from research_agent.tools.cronjob import _resolve_tz
        except Exception:
            return None
        try:
            from research_agent.tools.provider_engine import get_settings
            tz = _resolve_tz((get_settings() or {}).get("timezone"))
            if tz:
                return tz
        except Exception:
            pass
        return _resolve_tz(os.getenv("HERMES_TIMEZONE", ""))

    def _datetime_block(self) -> str:
        tz_name = self._resolve_timezone()
        now = datetime.now()
        if tz_name:
            try:
                from zoneinfo import ZoneInfo
                now = datetime.now(ZoneInfo(tz_name))
            except Exception:
                now = datetime.now().astimezone()
        else:
            now = now.astimezone()

        label = tz_name or (now.tzname() or "server local time")
        return (
            "\n\n## Current Date & Time (live — refreshed every turn)\n"
            f"- Current date: {now.strftime('%Y-%m-%d')} ({now.strftime('%A')})\n"
            f"- Current time: {now.strftime('%H:%M')} ({now.strftime('%I:%M %p').lstrip('0')})\n"
            f"- Timezone: {label}\n"
            f"- Tomorrow: {(now + timedelta(days=1)).strftime('%Y-%m-%d (%A)')}\n"
            "Use this as the anchor for every relative date/time the user mentions "
            "('today', 'tonight', '3:40pm', 'in 2 hours', 'tomorrow'). When scheduling, "
            "pass the user's wording (e.g. '15:40', 'tomorrow at 9am') straight to the "
            "`cronjob` tool — it resolves against this same current date. NEVER invent a "
            "future date the user did not ask for.\n"
        )

    def wrap_model_call(self, request, handler):
        try:
            block = self._datetime_block()
            existing = request.system_message
            base = existing.content if existing is not None else ""
            request = request.override(system_message=SystemMessage(content=f"{base}{block}"))
        except Exception as e:
            print(f"[workflow_compiler] CurrentDateTimeMiddleware skipped: {e}")
        return handler(request)

    async def awrap_model_call(self, request, handler):
        try:
            block = self._datetime_block()
            existing = request.system_message
            base = existing.content if existing is not None else ""
            request = request.override(system_message=SystemMessage(content=f"{base}{block}"))
        except Exception as e:
            print(f"[workflow_compiler] CurrentDateTimeMiddleware skipped: {e}")
        return await handler(request)


from research_agent.chat_model import ResilientChatModel
from research_agent.plugins import enabled_plugins_from_bootstrap, is_tool_allowed
from research_agent.tools.mcp_loader import load_mcp_tools_for_agent
from research_agent.tools.provider_engine import (
    resolve_provider_credentials,
    get_provider_base_url,
    get_provider_api_key,
    get_provider_config,
    get_all_provider_names,
    execute_unified_pipeline,
)
from research_agent.tools import (
    unified_search,
    unified_extract,
    think_tool,
    fetch_images_brave,
    analyze_images_gemini,
    create_post_image,
    save_posts_to_supabase,
    save_wordpress_post,
    save_instagram_post,
    save_facebook_post,
    save_youtube_video,
    save_social_bundle,
    get_design_guide,
    read_skill,
    get_wordpress_categories,
    publish_to_wordpress,
    list_skills,
    manage_skill,
    build_skills_index,
    cronjob,
    search_conversation_history,
    omni_analyzer,
    search_memories,
    add_memory,
    replace_memory,
    remove_memory,
    honcho_profile,
    honcho_search,
    honcho_reasoning,
    honcho_context,
    honcho_conclude,
    youtube_transcript,
    text_to_speech,
    terminal,
    upload_to_storage,
    list_tools,
    load_tools,
    call_tool,
    build_tools_index,
)
from research_agent.commands import resolve_command
from research_agent.learn_prompt import build_learn_prompt
from research_agent import tts as tts_engine

# assistant-ui directive syntax: :type[label]{name=id}
_DIRECTIVE_RE = re.compile(r":([\w-]+)\[([^\]]+)\](?:\{name=([^}]+)\})?")
_VOICE_CHIP_NAMES = {
    "voice", "voice-tts", "voice-on", "voice-off",
    "voice tts", "voice on", "voice off",
}
_VOICE_CHANGED_NOTE = (
    "[System] The user changed the voice-reply mode (/voice tts, /voice on or "
    "/voice off). This is handled automatically by the system — you have NOTHING "
    "to do. Do NOT call text_to_speech and do not treat this as a task; reply "
    "briefly at most."
)


def run_in_thread(func, *args, **kwargs):
    """Run a blocking function in a dedicated thread and return its result."""
    res, err = [], []
    def target():
        try:
            res.append(func(*args, **kwargs))
        except Exception as e:
            err.append(e)
    t = threading.Thread(target=target)
    t.start()
    t.join()
    if err:
        raise err[0]
    return res[0]



def _load_agent_design_assets(client, agent_id: str) -> list[dict]:
    try:
        resp = client.table("agent_design_assets").select("design_assets(*)").eq("agent_id", agent_id).execute()
        assets = []
        for row in (resp.data or []):
            if row.get("design_assets"):
                assets.append(row["design_assets"])
        return assets
    except Exception as e:
        print(f"[workflow_compiler] Error loading reference images for agent {agent_id}: {e}")
        return []


def _get_base64_image(file_path: str) -> tuple[str, str]:
    repo_root = Path(__file__).resolve().parent.parent
    full_path = repo_root / file_path
    if not full_path.exists():
        raise FileNotFoundError(f"Reference image file not found on disk: {full_path}")
    with open(full_path, "rb") as f:
        data = f.read()
    encoded = base64.b64encode(data).decode("utf-8")
    mime_type, _ = mimetypes.guess_type(str(full_path))
    if not mime_type:
        mime_type = "image/png"
    return encoded, mime_type


def _get_agent_system_prompt_with_images(client, agent_id: str, base_prompt: str) -> str:
    assets = _load_agent_design_assets(client, agent_id)
    if not assets:
        return base_prompt

    ref_lines = []
    for idx, asset in enumerate(assets, start=1):
        ref_lines.append(
            f"Reference Image {idx}:\n"
            f"- Key: {asset.get('asset_key', f'ref{idx}')}\n"
            f"- Label: {asset.get('label', '')}\n"
            f"- File Path: {asset.get('file_path', '')}"
        )

    return (
        f"{base_prompt}\n\n"
        "=== ATTACHED BRAND/STYLE REFERENCE IMAGES ===\n"
        "The following brand/style reference images are attached to your configuration:\n\n"
        + "\n\n".join(ref_lines) + "\n\n"
        "Usage Guide:\n"
        "- When creating or editing images, pass these reference images or their keys to `create_post_image`.\n"
        "- If you need to inspect or analyze the visual details/contents of any brand image or attachment, call `omni_analyzer`.\n"
    )


def _bind_agent_id_to_list_skills(list_skills_tool, agent_id: str, user_id: str = ""):
    @tool("list_skills")
    def list_skills_bound(category: Optional[str] = None, config: Optional[RunnableConfig] = None) -> str:
        """List all available skills with their names, descriptions, and categories."""
        if user_id and config is not None and not config.get("configurable", {}).get("user_id"):
            config = {**config, "configurable": {**config.get("configurable", {}), "user_id": user_id}}
        elif user_id and config is None:
            config = {"configurable": {"user_id": user_id}}
        return list_skills_tool.func(category=category, agent_id=agent_id, config=config)
    return list_skills_bound


def _bind_agent_id_to_read_skill(read_skill_tool, agent_id: str, user_id: str = ""):
    @tool("read_skill")
    def read_skill_bound(skill_name: str, config: Optional[RunnableConfig] = None) -> str:
        """Load a skill instruction file from disk and return its full content."""
        if user_id and config is not None and not config.get("configurable", {}).get("user_id"):
            config = {**config, "configurable": {**config.get("configurable", {}), "user_id": user_id}}
        elif user_id and config is None:
            config = {"configurable": {"user_id": user_id}}
        return read_skill_tool.func(skill_name=skill_name, agent_id=agent_id, config=config)
    return read_skill_bound


def _bind_agent_id_to_manage_skill(manage_skill_tool, agent_id: str, user_id: str = ""):
    @tool("manage_skill")
    def manage_skill_bound(
        action: str,
        skill_key: str,
        label: Optional[str] = None,
        description: Optional[str] = None,
        content: Optional[str] = None,
        category: Optional[str] = "general",
        config: Optional[RunnableConfig] = None,
    ) -> str:
        """Create, update, or archive a skill in the skills library."""
        if user_id and config is not None and not config.get("configurable", {}).get("user_id"):
            config = {**config, "configurable": {**config.get("configurable", {}), "user_id": user_id}}
        elif user_id and config is None:
            config = {"configurable": {"user_id": user_id}}
        return manage_skill_tool.func(
            action=action,
            skill_key=skill_key,
            label=label,
            description=description,
            content=content,
            category=category,
            agent_id=agent_id,
            config=config,
        )
    return manage_skill_bound


def _bind_agent_id_to_list_tools(list_tools_tool, agent_id: str):
    @tool("list_tools")
    def list_tools_bound(query: Optional[str] = None, mcp_name: Optional[str] = None, config: Optional[RunnableConfig] = None) -> str:
        """Perform a search or discovery to find tools."""
        return list_tools_tool.func(query=query, mcp_name=mcp_name, agent_id=agent_id, config=config)
    return list_tools_bound


def _bind_agent_id_to_load_tools(load_tools_tool, agent_id: str, user_id: str = ""):
    @tool("load_tools")
    def load_tools_bound(tool_names: List[str], config: Optional[RunnableConfig] = None) -> str:
        """Load the complete JSON schemas for the specified tool names."""
        if user_id and config is not None and not config.get("configurable", {}).get("user_id"):
            config = {**config, "configurable": {**config.get("configurable", {}), "user_id": user_id}}
        elif user_id and config is None:
            config = {"configurable": {"user_id": user_id}}
        return load_tools_tool.func(tool_names=tool_names, agent_id=agent_id, config=config)
    return load_tools_bound


def _bind_agent_id_to_call_tool(call_tool_tool, agent_id: str, user_id: str = ""):
    @tool("call_tool")
    def call_tool_bound(tool_name: str, arguments: Dict[str, Any], config: Optional[RunnableConfig] = None) -> str:
        """Execute a dynamically loaded tool with the specified arguments."""
        if user_id and config is not None and not config.get("configurable", {}).get("user_id"):
            config = {**config, "configurable": {**config.get("configurable", {}), "user_id": user_id}}
        elif user_id and config is None:
            config = {"configurable": {"user_id": user_id}}
        return call_tool_tool.func(tool_name=tool_name, arguments=arguments, agent_id=agent_id, config=config)
    return call_tool_bound


def load_dynamic_agents_by_workflow() -> dict:
    """Fetch configurations from Supabase and compile workflow subgraphs."""
    try:
        from supabase import create_client, ClientOptions
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
        if not url or not key:
            print("[workflow_compiler] Supabase URL/Key missing. Using static fallback.", flush=True)
            return {}

        print("[workflow_compiler] Connecting to Supabase...", flush=True)
        opts = ClientOptions(postgrest_client_timeout=300, storage_client_timeout=300)
        client = create_client(url, key, options=opts)

        try:
            from research_agent.tools.dynamic_router import sync_pinecone_vector_index
            sync_pinecone_vector_index(client)
        except Exception as e:
            print(f"[workflow_compiler] Pinecone sync failed: {e}", flush=True)

        try:
            print("[workflow_compiler] Fetching get_backend_bootstrap_data...", flush=True)
            bootstrap_resp = client.rpc("get_backend_bootstrap_data").execute()
            bootstrap = bootstrap_resp.data or {}
            print(f"[workflow_compiler] Bootstrap fetched ({len(bootstrap.get('workflows', []))} workflows).", flush=True)
        except Exception as e:
            print(f"[workflow_compiler] Failed to fetch bootstrap data: {e}", flush=True)
            return {}

        workflows = bootstrap.get("workflows") or []
        if not workflows:
            print("[workflow_compiler] No workflows found in bootstrap.", flush=True)
            return {}

        configs = bootstrap.get("agent_configs") or []
        assignments = bootstrap.get("agent_tool_assignments") or []
        mappings = bootstrap.get("workflow_agent_assignments") or []

        db_settings = {row["key"]: row["value"] for row in (bootstrap.get("agent_settings") or [])}
        super_enabled = db_settings.get("super_indexing_enabled", "true").lower() == "true"
        normal_enabled = db_settings.get("normal_indexing_enabled", "true").lower() == "true"

        builtin_loading_modes_str = db_settings.get("builtin_tools_loading_modes", "{}")
        try:
            import json
            builtin_loading_modes = json.loads(builtin_loading_modes_str)
        except Exception:
            builtin_loading_modes = {}

        mcp_tool_modes = {row["tool_key"]: row["loading_mode"] for row in (bootstrap.get("mcp_tool_settings") or [])}

        enabled_plugins = enabled_plugins_from_bootstrap(bootstrap)

        tool_lookup = {
            "unified_search": unified_search,
            "unified_extract": unified_extract,
            "think_tool": think_tool,
            "fetch_images_brave": fetch_images_brave,
            "analyze_images_gemini": analyze_images_gemini,
            "create_post_image": create_post_image,
            "save_posts_to_supabase": save_posts_to_supabase,
            "save_wordpress_post": save_wordpress_post,
            "save_instagram_post": save_instagram_post,
            "save_facebook_post": save_facebook_post,
            "save_youtube_video": save_youtube_video,
            "save_social_bundle": save_social_bundle,
            "get_design_guide": get_design_guide,
            "read_skill": read_skill,
            "get_wordpress_categories": get_wordpress_categories,
            "publish_to_wordpress": publish_to_wordpress,
            "list_skills": list_skills,
            "manage_skill": manage_skill,
            "list_tools": list_tools,
            "load_tools": load_tools,
            "call_tool": call_tool,
            "youtube_transcript": youtube_transcript,
            "cronjob": cronjob,
            "text_to_speech": text_to_speech,
            "terminal": terminal,
            "upload_to_storage": upload_to_storage,
            "search_conversation_history": search_conversation_history,
            "omni_analyzer": omni_analyzer,
            "analyze_attachment": omni_analyzer,
            "search_memories": search_memories,
            "add_memory": add_memory,
            "replace_memory": replace_memory,
            "remove_memory": remove_memory,
            "honcho_profile": honcho_profile,
            "honcho_search": honcho_search,
            "honcho_reasoning": honcho_reasoning,
            "honcho_context": honcho_context,
            "honcho_conclude": honcho_conclude,
        }

        tool_assignments_by_agent = {}
        for a in assignments:
            agent_id = a.get("agent_id")
            if agent_id not in tool_assignments_by_agent:
                tool_assignments_by_agent[agent_id] = []
            tool_assignments_by_agent[agent_id].append(a)

        def make_dynamic_unified_tool(t_key: str):
            category = t_key.replace("unified_", "")

            async def _run_dynamic_tool(query: str = "", urls: list[str] = [], config: RunnableConfig = None, **kwargs) -> str:
                return await execute_unified_pipeline(
                    category=category,
                    built_in_map={},
                    default_provider_keys=[],
                    max_retries=3,
                    query=query,
                    urls=urls,
                    config=config,
                    **kwargs
                )

            return StructuredTool.from_function(
                coroutine=_run_dynamic_tool,
                name=t_key,
                description=f"Unified tool for '{category}'. Calls connected providers in priority order.",
            )

        workflows_compiled = {}

        for wf in workflows:
            wf_id = wf["id"]
            print(f"[workflow_compiler] Processing workflow '{wf.get('name')}' ({wf_id})...")
            main_configs = []
            for c in configs:
                if c.get("agent_type") == "main":
                    is_mapped = any(str(m["agent_id"]) == str(c["id"]) and str(m["workflow_id"]) == str(wf_id) for m in mappings) if mappings else False
                    is_direct = str(c.get("workflow_id")) == str(wf_id)
                    if is_mapped or is_direct:
                        main_configs.append(c)

            if not main_configs:
                print(f"[workflow_compiler] No main agent configs found for workflow '{wf.get('name')}'. Skipping.")
                continue

            local_subs = []
            for c in configs:
                if c.get("agent_type") == "subagent":
                    is_mapped = any(str(m["agent_id"]) == str(c["id"]) and str(m["workflow_id"]) == str(wf_id) for m in mappings) if mappings else False
                    is_direct = str(c.get("workflow_id")) == str(wf_id)
                    if is_mapped or is_direct:
                        local_subs.append(c)

            main_cfg = main_configs[0]
            main_id = main_cfg["id"]
            user_id = main_cfg.get("user_id") or wf.get("user_id")
            base_main_prompt = main_cfg.get("system_prompt", "").replace("{date}", datetime.now().strftime("%Y-%m-%d"))

            try:
                skills_index = build_skills_index(agent_id=main_id)
                if skills_index:
                    base_main_prompt = base_main_prompt + "\n\n" + skills_index
            except Exception as e:
                print(f"[workflow_compiler] Failed to build skills index: {e}")

            try:
                tools_index = build_tools_index(agent_id=main_id)
                if tools_index:
                    base_main_prompt = base_main_prompt + "\n\n" + tools_index
            except Exception as e:
                print(f"[workflow_compiler] Failed to build tools index: {e}")

            WORKSPACE_PATH_DIRECTIVE = (
                "\n\n## Workspace, Tool Calling, and Conversation Rules:\n"
                "- All tools (`write_file`, `read_file`, `edit_file`, `terminal`, `call_tool`) run inside your current conversation thread workspace directory.\n"
                "- When creating files, ALWAYS call `write_file(file_path=\"filename.ext\", content=\"...\")` with the full content string (never leave arguments empty).\n"
                "- When executing scripts or commands, ALWAYS call `terminal(command=\"...\")` with the command string.\n"
                "- ALWAYS use simple relative paths.\n"
                "- DO NOT hardcode `/tmp/` or absolute paths in your Python code or terminal commands.\n"
                "\n## Tool Call Completion, Result Presentation, and Multi-Turn Rules:\n"
                "1. Whenever you execute a tool (like `call_tool`, creating a Google Doc, writing a file, etc.) and the tool returns data (such as a link or URL), you MUST ALWAYS write a final helpful message to the user summarizing the result, sharing any generated links/URLs, and confirming completion.\n"
                "2. When a tool action has ALREADY been executed and completed in previous messages in this conversation (e.g. document already created), NEVER call the tool again for the same target unless the user explicitly requests changes or a new document.\n"
                "3. If the user sends 'continue', 'proceed', or a follow-up, do NOT re-execute already completed actions; reference the existing result and ask what they would like to do next or proceed to subsequent steps.\n"
            )

            main_prompt = _get_agent_system_prompt_with_images(client, main_id, base_main_prompt) + WORKSPACE_PATH_DIRECTIVE

            main_provider = (main_cfg.get("provider") or "openrouter").strip().lower()
            main_model_name = main_cfg.get("model") or "google/gemini-2.5-flash"

            main_base_url, main_api_key, main_model_name = resolve_provider_credentials(
                main_provider, main_model_name, settings=db_settings, user_id=user_id
            )

            main_model = ResilientChatModel(
                agent_type="main_agent",
                agent_config_id=main_id,
                model=main_model_name,
                api_key=main_api_key,
                base_url=main_base_url,
                temperature=0.45,
                streaming=True,
            )

            main_tools = []
            main_interrupt_on = {}
            bindings_by_tool = {a.get("tool_key"): a.get("parameter_bindings") for a in tool_assignments_by_agent.get(main_id, []) if a.get("parameter_bindings")}
            permissions_by_tool = {a.get("tool_key"): a.get("permission_mode") for a in tool_assignments_by_agent.get(main_id, []) if a.get("permission_mode")}
            from research_agent.tools.dynamic_router import bind_tool_parameters

            try:
                builtin_perm_modes = json.loads(db_settings.get("builtin_tools_permission_modes") or "{}") if isinstance(db_settings.get("builtin_tools_permission_modes"), str) else (db_settings.get("builtin_tools_permission_modes") or {})
                builtin_param_bindings = json.loads(db_settings.get("builtin_tools_parameter_bindings") or "{}") if isinstance(db_settings.get("builtin_tools_parameter_bindings"), str) else (db_settings.get("builtin_tools_parameter_bindings") or {})
            except Exception:
                builtin_perm_modes = {}
                builtin_param_bindings = {}

            try:
                mcp_perm_modes = json.loads(db_settings.get("mcp_tools_permission_modes") or "{}") if isinstance(db_settings.get("mcp_tools_permission_modes"), str) else (db_settings.get("mcp_tools_permission_modes") or {})
                mcp_param_bindings = json.loads(db_settings.get("mcp_tools_parameter_bindings") or "{}") if isinstance(db_settings.get("mcp_tools_parameter_bindings"), str) else (db_settings.get("mcp_tools_parameter_bindings") or {})
            except Exception:
                mcp_perm_modes = {}
                mcp_param_bindings = {}

            for a in tool_assignments_by_agent.get(main_id, []):
                t_type = a.get("tool_type")
                t_key = a.get("tool_key")
                if t_type == "builtin" and not is_tool_allowed(t_key, enabled_plugins):
                    continue
                loading_mode = a.get("loading_mode")
                if not loading_mode:
                    loading_mode = builtin_loading_modes.get(t_key, "primary") if t_type == "builtin" else mcp_tool_modes.get(t_key, "primary")

                if t_key in ["list_tools", "load_tools", "call_tool"]:
                    loading_mode = "primary"
                if loading_mode == "vector":
                    loading_mode = "super"
                if loading_mode == "super" and not super_enabled:
                    loading_mode = "primary"
                if loading_mode == "normal" and not normal_enabled:
                    loading_mode = "primary"

                if loading_mode != "primary":
                    continue

                perm_mode = (
                    permissions_by_tool.get(t_key)
                    or builtin_perm_modes.get(t_key)
                    or mcp_perm_modes.get(t_key)
                    or "always_allow"
                )
                if perm_mode == "deny":
                    continue

                if t_type == "builtin" and t_key in tool_lookup:
                    tool_func = tool_lookup[t_key]
                    main_user_id = main_cfg.get("user_id", "")
                    if t_key == "list_skills":
                        tool_func = _bind_agent_id_to_list_skills(list_skills, main_id, user_id=main_user_id)
                    elif t_key == "read_skill":
                        tool_func = _bind_agent_id_to_read_skill(read_skill, main_id, user_id=main_user_id)
                    elif t_key == "manage_skill":
                        tool_func = _bind_agent_id_to_manage_skill(manage_skill, main_id, user_id=main_user_id)
                    elif t_key == "list_tools":
                        tool_func = _bind_agent_id_to_list_tools(list_tools, main_id)
                    elif t_key == "load_tools":
                        tool_func = _bind_agent_id_to_load_tools(load_tools, main_id, user_id=main_user_id)
                    elif t_key == "call_tool":
                        tool_func = _bind_agent_id_to_call_tool(call_tool, main_id, user_id=main_user_id)

                    bindings = (
                        bindings_by_tool.get(t_key)
                        or builtin_param_bindings.get(t_key)
                        or {}
                    )
                    if bindings:
                        tool_func = bind_tool_parameters(tool_func, bindings)

                    tool_name = getattr(tool_func, "name", t_key)
                    if perm_mode == "ask":
                        main_interrupt_on[tool_name] = True
                    main_tools.append(tool_func)
                elif t_key.startswith("unified_"):
                    tool_func = make_dynamic_unified_tool(t_key)
                    bindings = (
                        bindings_by_tool.get(t_key)
                        or builtin_param_bindings.get(t_key)
                        or {}
                    )
                    if bindings:
                        tool_func = bind_tool_parameters(tool_func, bindings)

                    tool_name = getattr(tool_func, "name", t_key)
                    if perm_mode == "ask":
                        main_interrupt_on[tool_name] = True
                    main_tools.append(tool_func)

            main_mcp = load_mcp_tools_for_agent(main_id)
            for t in main_mcp:
                perm_mode = (
                    permissions_by_tool.get(t.name)
                    or mcp_perm_modes.get(t.name)
                    or "always_allow"
                )
                if perm_mode == "deny":
                    continue
                bindings = (
                    bindings_by_tool.get(t.name)
                    or mcp_param_bindings.get(t.name)
                    or {}
                )
                wrapped_t = bind_tool_parameters(t, bindings) if bindings else t
                if perm_mode == "ask":
                    main_interrupt_on[t.name] = True
                main_tools.append(wrapped_t)

            subagents = []
            for sub in local_subs:
                sub_id = sub["id"]
                base_sub_prompt = sub.get("system_prompt", "")
                try:
                    skills_index = build_skills_index(agent_id=sub_id)
                    if skills_index:
                        base_sub_prompt = base_sub_prompt + "\n\n" + skills_index
                except Exception:
                    pass

                try:
                    tools_index = build_tools_index(agent_id=sub_id)
                    if tools_index:
                        base_sub_prompt = base_sub_prompt + "\n\n" + tools_index
                except Exception:
                    pass

                sub_prompt = _get_agent_system_prompt_with_images(client, sub_id, base_sub_prompt)
                sub_provider = (sub.get("provider") or "openrouter").strip().lower()
                sub_model_name = sub.get("model") or "google/gemini-2.5-flash"

                sub_base_url, sub_api_key, sub_model_name = resolve_provider_credentials(
                    sub_provider, sub_model_name, settings=db_settings, user_id=user_id
                )

                sub_agent_type = "research_subagent" if "research" in sub["name"].lower() else "content_subagent"
                sub_model = ResilientChatModel(
                    agent_type=sub_agent_type,
                    agent_config_id=sub_id,
                    model=sub_model_name,
                    api_key=sub_api_key,
                    base_url=sub_base_url,
                    temperature=0.3 if "research" in sub["name"].lower() else 0.55,
                    streaming=True,
                )

                sub_tools = []
                sub_interrupt_on = {}
                sub_bindings_by_tool = {a.get("tool_key"): a.get("parameter_bindings") for a in tool_assignments_by_agent.get(sub_id, []) if a.get("parameter_bindings")}
                sub_permissions_by_tool = {a.get("tool_key"): a.get("permission_mode") for a in tool_assignments_by_agent.get(sub_id, []) if a.get("permission_mode")}

                for a in tool_assignments_by_agent.get(sub_id, []):
                    t_type = a.get("tool_type")
                    t_key = a.get("tool_key")
                    if t_type == "builtin" and not is_tool_allowed(t_key, enabled_plugins):
                        continue
                    loading_mode = a.get("loading_mode")
                    if not loading_mode:
                        loading_mode = builtin_loading_modes.get(t_key, "primary") if t_type == "builtin" else mcp_tool_modes.get(t_key, "primary")

                    if t_key in ["list_tools", "load_tools", "call_tool"]:
                        loading_mode = "primary"
                    if loading_mode == "vector":
                        loading_mode = "super"
                    if loading_mode == "super" and not super_enabled:
                        loading_mode = "primary"
                    if loading_mode == "normal" and not normal_enabled:
                        loading_mode = "primary"

                    if loading_mode != "primary":
                        continue

                    perm_mode = (
                        sub_permissions_by_tool.get(t_key)
                        or builtin_perm_modes.get(t_key)
                        or mcp_perm_modes.get(t_key)
                        or "always_allow"
                    )
                    if perm_mode == "deny":
                        continue

                    if t_type == "builtin" and t_key in tool_lookup:
                        tool_func = tool_lookup[t_key]
                        sub_user_id = sub.get("user_id", "")
                        if t_key == "list_skills":
                            tool_func = _bind_agent_id_to_list_skills(list_skills, sub_id, user_id=sub_user_id)
                        elif t_key == "read_skill":
                            tool_func = _bind_agent_id_to_read_skill(read_skill, sub_id, user_id=sub_user_id)
                        elif t_key == "manage_skill":
                            tool_func = _bind_agent_id_to_manage_skill(manage_skill, sub_id, user_id=sub_user_id)
                        elif t_key == "list_tools":
                            tool_func = _bind_agent_id_to_list_tools(list_tools, sub_id)
                        elif t_key == "load_tools":
                            tool_func = _bind_agent_id_to_load_tools(load_tools, sub_id, user_id=sub_user_id)
                        elif t_key == "call_tool":
                            tool_func = _bind_agent_id_to_call_tool(call_tool, sub_id, user_id=sub_user_id)

                        bindings = (
                            sub_bindings_by_tool.get(t_key)
                            or builtin_param_bindings.get(t_key)
                            or {}
                        )
                        if bindings:
                            tool_func = bind_tool_parameters(tool_func, bindings)

                        tool_name = getattr(tool_func, "name", t_key)
                        if perm_mode == "ask":
                            sub_interrupt_on[tool_name] = True
                        sub_tools.append(tool_func)

                sub_mcp = load_mcp_tools_for_agent(sub_id)
                for t in sub_mcp:
                    perm_mode = (
                        sub_permissions_by_tool.get(t.name)
                        or mcp_perm_modes.get(t.name)
                        or "always_allow"
                    )
                    if perm_mode == "deny":
                        continue
                    bindings = (
                        sub_bindings_by_tool.get(t.name)
                        or mcp_param_bindings.get(t.name)
                        or {}
                    )
                    wrapped_t = bind_tool_parameters(t, bindings) if bindings else t
                    if perm_mode == "ask":
                        sub_interrupt_on[t.name] = True
                    sub_tools.append(wrapped_t)

                sub_mw = [CurrentDateTimeMiddleware()]
                if sub_interrupt_on:
                    sub_mw.append(SafeHumanInTheLoopMiddleware(interrupt_on=sub_interrupt_on))
                subagents.append({
                    "name": sub["name"],
                    "description": sub.get("description") or "",
                    "system_prompt": sub_prompt,
                    "model": sub_model,
                    "tools": sub_tools,
                    "middleware": sub_mw,
                })

            for sa in subagents:
                sa["tools"] = [t for t in sa["tools"] if getattr(t, "name", "") not in ("analyze_images_gemini", "get_design_guide")]
            main_tools = [t for t in main_tools if getattr(t, "name", "") not in ("analyze_images_gemini", "get_design_guide")]

            main_mw = [CurrentDateTimeMiddleware()]
            if main_interrupt_on:
                main_mw.append(SafeHumanInTheLoopMiddleware(interrupt_on=main_interrupt_on))
            compiled_agent = create_deep_agent(
                model=main_model,
                tools=main_tools,
                middleware=main_mw,
                subagents=subagents,
                system_prompt=main_prompt,
                name=wf["name"].lower().replace(" ", "-"),
                backend=thread_filesystem_backend,
                interrupt_on=None,
            )
            workflows_compiled[str(wf_id)] = compiled_agent
            workflows_compiled[wf["name"]] = compiled_agent


        return workflows_compiled
    except Exception as e:
        print(f"[workflow_compiler] Error loading dynamic workflows: {e}")
        return {}


def _humanize_command_chips(text: str) -> str:
    out, last = [], 0
    for m in _DIRECTIVE_RE.finditer(text):
        out.append(text[last : m.start()])
        if m.group(1) == "command":
            out.append("/" + m.group(2).lstrip("/"))
        else:
            out.append(m.group(0))
        last = m.end()
    out.append(text[last:])
    return "".join(out)


def _message_text(msg) -> str:
    content = getattr(msg, "content", "") if not isinstance(msg, dict) else msg.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, str):
                parts.append(b)
            elif isinstance(b, dict) and b.get("type") == "text":
                parts.append(b.get("text", ""))
        return "".join(parts)
    return ""


def _set_message_text(msg, text: str) -> None:
    content = getattr(msg, "content", "") if not isinstance(msg, dict) else msg.get("content", "")
    if isinstance(content, list):
        new_blocks = []
        text_written = False
        for b in content:
            if isinstance(b, str):
                if not text_written:
                    new_blocks.append(text)
                    text_written = True
            elif isinstance(b, dict) and b.get("type") == "text":
                if not text_written:
                    new_blocks.append({**b, "text": text})
                    text_written = True
            else:
                new_blocks.append(b)
        if not text_written:
            new_blocks.insert(0, {"type": "text", "text": text})
        msg.content = new_blocks
    else:
        if isinstance(msg, dict):
            msg["content"] = text
        else:
            msg.content = text


def load_memories(state, config: RunnableConfig):
    """Preprocess inbound input before workflow routing."""
    configurable = config.get("configurable", {}) if config else {}
    user_id = configurable.get("user_id")
    workflow_id = configurable.get("workflow_id")
    thread_id = configurable.get("thread_id")

    if user_id or workflow_id or thread_id:
        from research_agent.tools.provider_engine import set_active_user_and_workflow
        set_active_user_and_workflow(user_id=user_id, workflow_id=workflow_id, thread_id=thread_id)

    messages = state.get("messages", [])
    last_human = None
    for msg in reversed(messages):
        msg_type = getattr(msg, "type", None) or (msg.get("role") if isinstance(msg, dict) else None)
        if msg_type in ("human", "user"):
            last_human = msg
            break
    if last_human is None:
        return state

    text = _message_text(last_human)
    if not text.strip():
        return state

    try:
        parsed_cmd = resolve_command(text)
    except Exception as e:
        parsed_cmd = None

    if parsed_cmd is not None:
        cmd, args = parsed_cmd
        if cmd.name == "learn":
            prompt = build_learn_prompt(args)
            _set_message_text(last_human, f"{text}\n\n[System] {prompt}")
        elif cmd.name == "voice":
            _set_message_text(last_human, f"{text}\n\n{_VOICE_CHANGED_NOTE}")
        return state

    try:
        chip_cmds = [
            ((m.group(3) or m.group(2)).strip().lstrip("/").lower(), m)
            for m in _DIRECTIVE_RE.finditer(text)
            if m.group(1) == "command"
        ]
        if chip_cmds:
            humanized = _humanize_command_chips(text).strip()
            handled = False
            for name, m in chip_cmds:
                if name in ("learn",):
                    prompt = build_learn_prompt(humanized)
                    _set_message_text(last_human, f"{humanized}\n\n[System] {prompt}")
                    handled = True
                elif name in _VOICE_CHIP_NAMES:
                    if not handled:
                        _set_message_text(last_human, f"{humanized}\n\n{_VOICE_CHANGED_NOTE}")
                        handled = True
            if not handled:
                _set_message_text(last_human, humanized)
    except Exception as e:
        print(f"[workflow_compiler] command chip parse error: {e}")

    try:
        skills, tools = [], []
        for m in _DIRECTIVE_RE.finditer(text):
            ttype, label, name = m.group(1), m.group(2), (m.group(3) or m.group(2))
            if ttype == "skill":
                skills.append(name.strip())
            elif ttype == "tool":
                tools.append(name.strip())
        if skills or tools:
            cleaned = _DIRECTIVE_RE.sub("", text).strip()
            note_lines = []
            if skills:
                note_lines.append(
                    "The user explicitly attached these skills to this message: "
                    + ", ".join(skills)
                    + ". Immediately call read_skill(skill_name) for EACH of them and follow their instructions exactly."
                )
            if tools:
                note_lines.append(
                    "The user explicitly requested these tools for this task: "
                    + ", ".join(tools)
                    + ". Prefer them whenever they fit the task."
                )
            note = "\n\n[System] " + "\n".join(note_lines)
            _set_message_text(last_human, (cleaned + note) if cleaned else note.lstrip())
    except Exception as e:
        print(f"[workflow_compiler] mention directive parse error: {e}")

    return state


def finalize_response(state, config: RunnableConfig):
    """Voice-reply mirroring (Hermes style)."""
    configurable = config.get("configurable", {})
    voice_mode = str(configurable.get("voice_mode") or "voice_only").strip().lower()
    if voice_mode in ("off", "", "none", "false"):
        return state

    messages = state.get("messages", [])
    if not messages:
        return state

    def _is_human(m):
        if isinstance(m, dict):
            return m.get("type") == "human" or m.get("role") in ("human", "user")
        return getattr(m, "type", None) in ("human", "user")

    def _is_ai(m):
        if isinstance(m, dict):
            return m.get("type") == "ai" or m.get("role") in ("ai", "assistant")
        return getattr(m, "type", None) in ("ai", "assistant")

    last_human = None
    last_ai = None
    for msg in reversed(messages):
        if _is_human(msg) and last_human is None:
            last_human = msg
        elif _is_ai(msg) and last_ai is None:
            text = _message_text(msg).strip()
            tool_calls = getattr(msg, "tool_calls", None) or (isinstance(msg, dict) and msg.get("tool_calls"))
            if text and not tool_calls:
                last_ai = msg
            elif last_ai is None and text:
                last_ai = msg

        if last_human is not None and last_ai is not None:
            break

    if last_ai is None:
        return state

    human_text = _message_text(last_human).lower() if last_human else ""
    is_voice_cmd = any(cmd in human_text for cmd in ["/voice-tts", "/voice-on", "/voice tts", "/voice on", "voice-tts", "voice-on"])

    if voice_mode in ("off", "none", "false") and not is_voice_cmd:
        return state

    final_text = _message_text(last_ai)
    if not final_text.strip() or tts_engine.AUDIO_URL_MARKER in final_text:
        return state

    was_voice_input = bool(configurable.get("voice_input"))
    if last_human is not None and isinstance(getattr(last_human, "content", None), list):
        for b in last_human.content:
            if isinstance(b, dict) and b.get("type") in ("audio", "input_audio"):
                was_voice_input = True
                break

    should_speak = (voice_mode in ("all", "tts", "on")) or was_voice_input or is_voice_cmd
    if not should_speak:
        return state

    platform = str(configurable.get("platform") or "web").strip().lower()
    if platform == "web":
        return state

    try:
        marker = tts_engine.synthesize_reply_audio(
            final_text,
            platform=platform,
            user_id=configurable.get("user_id"),
            thread_id=configurable.get("thread_id"),
            purpose="mirror",
            max_chars=3000,
        )
    except Exception as e:
        print(f"[workflow_compiler] finalize_response voice synthesis failed: {e}")
        marker = None

    if not marker:
        return state

    if isinstance(last_ai.content, list):
        last_ai.content = list(last_ai.content) + [{"type": "text", "text": marker}]
    else:
        last_ai.content = (last_ai.content or "") + marker
    return state


def save_chat_history(state, config: RunnableConfig):
    """Save the chat history to Supabase and trigger Honcho cloud sync."""
    configurable = config.get("configurable", {})
    workflow_id = configurable.get("workflow_id")
    thread_id = configurable.get("thread_id")
    user_id = configurable.get("user_id")

    if not workflow_id or not thread_id:
        return state

    messages = state.get("messages", [])
    if not messages:
        return state

    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
        if url and key:
            client = create_client(url, key)
            try:
                session_uuid = str(uuid.UUID(thread_id))
            except ValueError:
                session_uuid = str(uuid.uuid5(uuid.NAMESPACE_DNS, thread_id))

            title = "New Chat"
            for msg in messages:
                msg_type = getattr(msg, "type", None) or (msg.get("role") if isinstance(msg, dict) else None)
                if msg_type in ("human", "user") and getattr(msg, "content", None):
                    msg_content = _message_text(msg)
                    title = msg_content[:50] + ("..." if len(msg_content) > 50 else "")
                    break

            rows_to_insert = []
            for msg in messages:
                role = "user"
                m_type = getattr(msg, "type", None) or (msg.get("role") if isinstance(msg, dict) else None)
                if m_type in ("ai", "assistant"):
                    role = "assistant"
                elif m_type == "system":
                    role = "system"
                elif m_type == "tool":
                    role = "tool"

                content = _message_text(msg)
                tool_calls = getattr(msg, "tool_calls", None) or (isinstance(msg, dict) and msg.get("tool_calls")) or []

                serializable_tool_calls = []
                for tc in tool_calls:
                    serializable_tool_calls.append({
                        "name": tc.get("name"),
                        "args": tc.get("args"),
                        "id": tc.get("id")
                    })

                rows_to_insert.append({
                    "role": role,
                    "content": content,
                    "tool_calls": serializable_tool_calls
                })

            params = {
                "p_session_id": session_uuid,
                "p_workflow_id": workflow_id,
                "p_title": title,
                "p_messages": rows_to_insert
            }
            if user_id:
                params["p_user_id"] = str(user_id)

            client.rpc("sync_chat_history_admin", params).execute()
    except Exception as e:
        print(f"[workflow_compiler] Error syncing chat history: {e}")

    try:
        last_user_msg = None
        last_ai_msg = None
        for msg in reversed(messages):
            m_type = getattr(msg, "type", None) or (msg.get("role") if isinstance(msg, dict) else None)
            if m_type in ("human", "user") and last_user_msg is None:
                last_user_msg = msg
            elif m_type in ("ai", "assistant") and last_ai_msg is None:
                last_ai_msg = msg
            if last_user_msg is not None and last_ai_msg is not None:
                break

        if last_user_msg and last_ai_msg:
            user_text = _message_text(last_user_msg)
            ai_text = _message_text(last_ai_msg)

            def run_honcho_bg_sync(u_text: str, a_text: str, uid_val: str, wf_val: str, tid_val: str):
                try:
                    from research_agent.memory.honcho_sync import sync_turn_to_honcho
                    sync_turn_to_honcho(
                        user_message=u_text[:25000],
                        agent_response=a_text[:25000],
                        thread_id=tid_val,
                        user_id=uid_val,
                        workflow_id=wf_val,
                    )
                except Exception as bg_err:
                    print(f"[workflow_compiler] Honcho sync warning: {bg_err}")

            h_thread = threading.Thread(
                target=run_honcho_bg_sync,
                args=(user_text, ai_text, user_id, workflow_id, thread_id)
            )
            h_thread.daemon = True
            h_thread.start()
    except Exception as e:
        print(f"[workflow_compiler] Error in Honcho trigger: {e}")

    try:
        for msg in messages:
            if hasattr(msg, "content") and isinstance(msg.content, list):
                new_content = []
                for part in msg.content:
                    if isinstance(part, dict):
                        if part.get("type") == "image_url":
                            img_url_data = part.get("image_url", {})
                            url = img_url_data.get("url", "") if isinstance(img_url_data, dict) else ""
                            if url.startswith("data:") and len(url) > 1000:
                                mime = url.split(";")[0].replace("data:", "") if ";" in url else "image/png"
                                part = {"type": "image_url", "image_url": {"url": f"data:{mime};placeholder"}}
                        elif part.get("type") in ["audio", "video", "file", "document"]:
                            url = part.get("audio") or part.get("video") or part.get("data") or part.get("url") or ""
                            # Only placeholder giant raw inline base64 data: URIs (> 1000 chars) to prevent checkpoint bloat.
                            # NEVER delete or strip HTTP/HTTPS storage URLs (Cloudflare R2 / Supabase)!
                            if url.startswith("data:") and len(url) > 1000:
                                filename = part.get("filename") or "attached_file"
                                mime = part.get("mimeType") or "application/octet-stream"
                                if part.get("type") == "file":
                                    part = {"type": "file", "data": f"data:{mime};placeholder", "filename": filename, "mimeType": mime}
                                else:
                                    part = {"type": "text", "text": f"\n\n[Attachment: {filename}]\n"}
                        elif part.get("type") == "input_audio":

                            part = {
                                "type": "input_audio",
                                "input_audio": {
                                    "data": "placeholder",
                                    "format": part.get("input_audio", {}).get("format") if isinstance(part.get("input_audio"), dict) else "mp3"
                                }
                            }
                    new_content.append(part)
                msg.content = new_content
    except Exception as e:
        print(f"[workflow_compiler] Error cleaning messages base64: {e}")

    return state
