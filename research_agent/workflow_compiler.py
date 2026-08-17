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
from datetime import datetime
from typing import Optional, List, Dict, Any

from langchain_core.messages import SystemMessage
from langchain_core.tools import tool, StructuredTool
from langchain_core.runnables import RunnableConfig
from deepagents import create_deep_agent
from research_agent.fs_backend import thread_filesystem_backend

from research_agent.chat_model import ResilientChatModel
from research_agent.tools.mcp_loader import load_mcp_tools_for_agent
from research_agent.tools.provider_engine import (
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
    view_candidate_images,
    analyze_images_gemini,
    create_post_image,
    save_posts_to_supabase,
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
    ask_permission,
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


def _get_agent_system_prompt_with_images(client, agent_id: str, base_prompt: str) -> SystemMessage | str:
    assets = _load_agent_design_assets(client, agent_id)
    if not assets:
        return base_prompt

    content_blocks = [{"type": "text", "text": base_prompt}]
    content_blocks.append({
        "type": "text",
        "text": "\n\n=== ATTACHED BRAND/STYLE REFERENCE IMAGES ===\nYou can refer to these images directly by their Key or Label in your instructions (e.g. \"Reference Image 1\" or by their Key/Label)."
    })

    for idx, asset in enumerate(assets, start=1):
        try:
            img_base64, mime_type = _get_base64_image(asset["file_path"])
            content_blocks.append({
                "type": "text",
                "text": f"\nReference Image {idx}:\n- Key: {asset['asset_key']}\n- Label: {asset['label']}\n- File Path: {asset['file_path']}"
            })
            content_blocks.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:{mime_type};base64,{img_base64}"
                }
            })
        except Exception as e:
            print(f"[workflow_compiler] Error loading reference image {asset['file_path']}: {e}")

    return SystemMessage(content=content_blocks)


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

        tool_lookup = {
            "unified_search": unified_search,
            "unified_extract": unified_extract,
            "think_tool": think_tool,
            "fetch_images_brave": fetch_images_brave,
            "view_candidate_images": view_candidate_images,
            "analyze_images_gemini": analyze_images_gemini,
            "create_post_image": create_post_image,
            "save_posts_to_supabase": save_posts_to_supabase,
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
            "ask_permission": ask_permission,
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
                "\n\n## Workspace and Path Rules:\n"
                "- All tools (`write_file`, `read_file`, `edit_file`, `terminal`) run inside your current conversation thread workspace directory.\n"
                "- ALWAYS use simple relative paths (e.g. `write_file(\"make_charts.py\", ...)` or `write_file(\"data.json\", ...)`).\n"
                "- In Python code: ALWAYS save charts, images, PDFs, and data using relative filenames in the current directory (e.g. `plt.savefig(\"chart1.png\")`, `SimpleDocTemplate(\"report.pdf\")`).\n"
                "- DO NOT hardcode `/tmp/` or absolute paths in your Python code or terminal commands.\n"
                "- Run scripts directly via `terminal(\"python make_charts.py\")`.\n"
            )

            main_prompt = _get_agent_system_prompt_with_images(client, main_id, base_main_prompt) + WORKSPACE_PATH_DIRECTIVE

            main_provider = (main_cfg.get("provider") or "openrouter").strip().lower()
            main_model_name = main_cfg.get("model") or "google/gemini-2.5-flash"

            actual_main_provider = main_provider if main_provider in get_all_provider_names() else "openrouter"
            main_base_url = get_provider_base_url(actual_main_provider)
            cfg = get_provider_config(actual_main_provider)
            if cfg and "base_url_env" in cfg and not main_base_url.endswith("/v1"):
                main_base_url = main_base_url + "/v1"

            if actual_main_provider == "openrouter":
                main_api_key = db_settings.get("openrouter_client_api_key", "").strip() or get_provider_api_key("openrouter")
            else:
                main_api_key = get_provider_api_key(actual_main_provider)

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
            bindings_by_tool = {a.get("tool_key"): a.get("parameter_bindings") or {} for a in tool_assignments_by_agent.get(main_id, [])}
            from research_agent.tools.dynamic_router import bind_tool_parameters

            for a in tool_assignments_by_agent.get(main_id, []):
                t_type = a.get("tool_type")
                t_key = a.get("tool_key")
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

                    bindings = bindings_by_tool.get(t_key) or {}
                    if bindings:
                        tool_func = bind_tool_parameters(tool_func, bindings)
                    main_tools.append(tool_func)
                elif t_key.startswith("unified_"):
                    tool_func = make_dynamic_unified_tool(t_key)
                    bindings = bindings_by_tool.get(t_key) or {}
                    if bindings:
                        tool_func = bind_tool_parameters(tool_func, bindings)
                    main_tools.append(tool_func)

            main_mcp = load_mcp_tools_for_agent(main_id)
            for t in main_mcp:
                bindings = bindings_by_tool.get(t.name) or {}
                main_tools.append(bind_tool_parameters(t, bindings) if bindings else t)

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
                actual_sub_provider = sub_provider if sub_provider in get_all_provider_names() else "openrouter"

                sub_base_url = get_provider_base_url(actual_sub_provider)
                sub_cfg = get_provider_config(actual_sub_provider)
                if sub_cfg and "base_url_env" in sub_cfg and not sub_base_url.endswith("/v1"):
                    sub_base_url = sub_base_url + "/v1"

                if actual_sub_provider == "openrouter":
                    sub_api_key = db_settings.get("openrouter_client_api_key", "").strip() or get_provider_api_key("openrouter")
                else:
                    sub_api_key = get_provider_api_key(actual_sub_provider)

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
                sub_bindings_by_tool = {a.get("tool_key"): a.get("parameter_bindings") or {} for a in tool_assignments_by_agent.get(sub_id, [])}

                for a in tool_assignments_by_agent.get(sub_id, []):
                    t_type = a.get("tool_type")
                    t_key = a.get("tool_key")
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

                        bindings = sub_bindings_by_tool.get(t_key) or {}
                        if bindings:
                            tool_func = bind_tool_parameters(tool_func, bindings)
                        sub_tools.append(tool_func)

                sub_mcp = load_mcp_tools_for_agent(sub_id)
                for t in sub_mcp:
                    bindings = sub_bindings_by_tool.get(t.name) or {}
                    sub_tools.append(bind_tool_parameters(t, bindings) if bindings else t)

                subagents.append({
                    "name": sub["name"],
                    "description": sub.get("description") or "",
                    "system_prompt": sub_prompt,
                    "model": sub_model,
                    "tools": sub_tools,
                })

            for sa in subagents:
                sa["tools"] = [t for t in sa["tools"] if getattr(t, "name", "") not in ("analyze_images_gemini", "get_design_guide")]
            main_tools = [t for t in main_tools if getattr(t, "name", "") not in ("analyze_images_gemini", "get_design_guide")]

            compiled_agent = create_deep_agent(
                model=main_model,
                tools=main_tools,
                subagents=subagents,
                system_prompt=main_prompt,
                name=wf["name"].lower().replace(" ", "-"),
                backend=thread_filesystem_backend,
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
                        elif part.get("type") in ["audio", "video", "file"]:
                            url = part.get("audio") or part.get("video") or part.get("data") or ""
                            if "supabase.co/storage/v1/object/public/uploads" in url or url.startswith("data:"):
                                filename = part.get("filename") or "attached_file"
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
