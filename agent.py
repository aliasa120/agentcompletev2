"""Research Agent — Master LangGraph Entrypoint.

This module initializes the multi-workflow StateGraph, routes incoming requests
to their assigned workflow agents (dynamically compiled from Supabase), and falls
back gracefully to a static research agent if Supabase is offline.
"""

import os
import sys
import tempfile
import traceback
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

# Force UTF-8 on stdout/stderr for Windows compatibility
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from langchain.agents import AgentState
from langgraph.graph import StateGraph, START, END
from deepagents import create_deep_agent
from research_agent.fs_backend import thread_filesystem_backend

from research_agent.chat_model import ResilientChatModel
from research_agent.workflow_compiler import (
    load_dynamic_agents_by_workflow,
    load_memories,
    finalize_response,
    save_chat_history,
    run_in_thread,
    CurrentDateTimeMiddleware,
)
from research_agent.prompts import (
    MAIN_AGENT_INSTRUCTIONS,
    RESEARCH_SUBAGENT_PROMPT,
    CONTENT_SUBAGENT_PROMPT,
)
from research_agent.tools import (
    unified_search,
    unified_extract,
    create_post_image,
    youtube_transcript,
    omni_analyzer,
    think_tool,
    fetch_images_brave,
    analyze_images_gemini,
    save_posts_to_supabase,
    save_wordpress_post,
    save_instagram_post,
    save_facebook_post,
    save_youtube_video,
    save_tiktok_post,
    save_pinterest_post,
    save_social_bundle,
    get_design_guide,
    read_skill,
    list_skills,
    manage_skill,
    get_wordpress_categories,
    publish_to_wordpress,
    search_conversation_history,
    text_to_speech,
    terminal,
    upload_to_storage,
    add_to_desk,
)
from research_agent.plugins import enabled_plugins_from_db, is_tool_allowed
from research_agent.tools.provider_engine import get_llm_config

# Inject today's date into the default prompt
INSTRUCTIONS = MAIN_AGENT_INSTRUCTIONS.replace("{date}", datetime.now().strftime("%Y-%m-%d"))

# ── Dynamic Workflow Compilation ───────────────────────────────────────────────
_LOG_PATH = os.path.join(tempfile.gettempdir(), "agent_load.log")
compiled_workflows = {}

try:
    compiled_workflows = run_in_thread(load_dynamic_agents_by_workflow)
    _log_lines = [
        f"\n--- Load at {datetime.now().isoformat()} ---\n",
        f"Compiled workflows keys: {list(compiled_workflows.keys())}\n",
    ]
    for k, v in compiled_workflows.items():
        try:
            tools_list = list(v.nodes['tools'].bound.tools_by_name.keys())
        except Exception:
            tools_list = "no tools"
        _log_lines.append(f"Workflow '{k}' tools: {tools_list}\n")
    if not compiled_workflows:
        _log_lines.append("compiled_workflows is empty!\n")
    with open(_LOG_PATH, "a", encoding="utf-8") as f:
        f.writelines(_log_lines)
    print(f"[agent] Loaded {len(compiled_workflows)} workflow(s). Log: {_LOG_PATH}", flush=True)
except Exception as e:
    with open(_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"\n--- Load Error at {datetime.now().isoformat()} ---\n")
        f.write(traceback.format_exc())
    print(f"[agent] ERROR loading workflows: {e}", flush=True)
    compiled_workflows = {}


def route_workflow(state, config):
    """Route input to the appropriate compiled workflow agent by workflow_id."""
    workflow_id = config.get("configurable", {}).get("workflow_id") if config else None
    node_key = str(workflow_id) if workflow_id else None

    # 1. Direct match
    if node_key and node_key in compiled_workflows:
        return node_key

    # 2. Match by UUID key
    active_uuids = [k for k in compiled_workflows.keys() if "-" in k]
    if active_uuids:
        return active_uuids[0]

    # 3. Fallback to first active key
    active_keys = list(compiled_workflows.keys())
    if active_keys:
        return active_keys[0]

    raise ValueError(f"No active compiled workflows found. Available: {list(compiled_workflows.keys())}")


# ── Add to Desk: deterministic one-click execution ────────────────────────────
# A Desk card's Execute button triggers a background run on the origin thread
# whose single user message is "[DESK_EXECUTE] {json}". The master graph routes
# that run straight to the desk_execute node — NO model call, no re-planning:
# the saved tool schema + (user-edited) arguments are executed exactly as-is.
DESK_EXECUTE_MARKER = "[DESK_EXECUTE]"


def _message_text(msg) -> str:
    """Extract plain text from a message (str or content-block list)."""
    content = getattr(msg, "content", None)
    if content is None and isinstance(msg, dict):
        content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return ""


def _message_type(msg) -> str:
    m_type = getattr(msg, "type", None)
    if m_type is None and isinstance(msg, dict):
        m_type = msg.get("type") or msg.get("role")
    return str(m_type or "")


def _is_desk_execute_run(state) -> bool:
    """True when the run's last message is a [DESK_EXECUTE] directive."""
    messages = (state or {}).get("messages", [])
    if not messages:
        return False
    last = messages[-1]
    if _message_type(last) not in ("human", "user"):
        return False
    return _message_text(last).strip().startswith(DESK_EXECUTE_MARKER)


def desk_execute(state, config):
    """Execute a Desk task card's tool call deterministically (no LLM involved).

    The user already approved this exact call by clicking the card's Execute
    button, so the mid-chat 'ask' permission interrupt is skipped (skip_ask=True)
    — 'deny' permissions still block. Updates the desk_tasks row and leaves a
    clean audit-trail message in the origin thread.
    """
    import json as _json
    from datetime import datetime, timezone as _tz
    from langchain_core.messages import AIMessage, RemoveMessage
    from research_agent.tools.desk import _get_supabase_client, update_desk_task_status
    from research_agent.tools.dynamic_router import execute_tool_for_desk

    messages = state.get("messages", [])
    marker_msg = messages[-1] if messages else None
    raw = _message_text(marker_msg)
    payload = {}
    try:
        payload = _json.loads(raw.strip()[len(DESK_EXECUTE_MARKER):].strip())
    except Exception as e:
        error_text = f"[desk_execute] Could not parse [DESK_EXECUTE] payload: {e}"
        print(error_text, flush=True)
        return {"messages": [AIMessage(content=f"⚠️ {error_text}")]}

    task_id = str(payload.get("task_id") or "")
    execution_id = str(payload.get("execution_id") or "")
    configurable = config.get("configurable", {}) if config else {}
    user_id = str(configurable.get("user_id") or "")
    if not task_id or not execution_id or not user_id:
        error_text = "[desk_execute] Missing claimed task, execution, or user identity."
        return {"messages": [AIMessage(content=error_text)]}

    client = _get_supabase_client()
    claimed = (
        client.table("desk_tasks")
        .select("title,execution_payload")
        .eq("id", task_id)
        .eq("user_id", user_id)
        .eq("status", "executing")
        .eq("execution_id", execution_id)
        .maybe_single()
        .execute()
    )
    if not claimed.data or not isinstance(claimed.data.get("execution_payload"), dict):
        return {"messages": [AIMessage(content="Desk execution claim is missing, stale, or invalid.")]}

    task = claimed.data
    execution = task["execution_payload"]
    title = str(task.get("title") or "Desk task")
    tool_name = str(execution.get("tool_name") or "")
    arguments = execution.get("arguments")
    agent_id = str(execution.get("agent_id") or "")
    if not tool_name or not agent_id or not isinstance(arguments, dict):
        outcome = {"ok": False, "code": "invalid_claim", "error": "Stored Desk execution payload is invalid."}
    else:
        outcome = execute_tool_for_desk(tool_name, arguments, agent_id, config=config)

    executed_at = datetime.now(_tz.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    result = str(outcome.get("output") if outcome.get("ok") else outcome.get("error") or "Desk execution failed.")
    update_desk_task_status(
        task_id=task_id,
        user_id=user_id,
        execution_id=execution_id,
        expected_status="executing",
        status="done" if outcome.get("ok") else "failed",
        result=result if outcome.get("ok") else None,
        error=None if outcome.get("ok") else result,
        executed_at=executed_at,
    )

    icon = "✅" if outcome.get("ok") else "⚠️"
    summary = (
        f"{icon} Desk task \"{title}\" executed via `{tool_name}`.\n\n"
        f"**Result:** {result[:2000]}"
    )

    new_messages = []
    marker_id = getattr(marker_msg, "id", None)
    if marker_id:
        new_messages.append(RemoveMessage(id=marker_id))
    new_messages.append(AIMessage(content=summary))
    return {"messages": new_messages}


# ── Master StateGraph Assembly ─────────────────────────────────────────────────
builder = StateGraph(AgentState)

if compiled_workflows:
    builder.add_node("load_memories", load_memories)
    builder.add_node("finalize_response", finalize_response)
    builder.add_node("save_chat_history", save_chat_history)
    builder.add_node("desk_execute", desk_execute)

    for wf_key, wf_agent in compiled_workflows.items():
        builder.add_node(wf_key, wf_agent)
        builder.add_edge(wf_key, "finalize_response")

    builder.add_edge("finalize_response", "save_chat_history")
    builder.add_edge("save_chat_history", END)
    builder.add_edge("desk_execute", "save_chat_history")

    def route_entry(state, config):
        """Desk task execution runs bypass the LLM pipeline entirely."""
        return "desk_execute" if _is_desk_execute_run(state) else "load_memories"

    builder.add_conditional_edges(
        START,
        route_entry,
        {
            "desk_execute": "desk_execute",
            "load_memories": "load_memories",
            **{wf_key: wf_key for wf_key in compiled_workflows.keys()},
        }
    )

    builder.add_conditional_edges(
        "load_memories",
        route_workflow,
        {wf_key: wf_key for wf_key in compiled_workflows.keys()}
    )
    agent = builder.compile()

else:
    print("[agent] WARNING: No compiled workflows found. Falling back to static configuration.")

    _main_base_url, _main_api_key, _main_model = get_llm_config("main_agent")
    _research_base_url, _research_api_key, _research_model = get_llm_config("research_subagent")
    _content_base_url, _content_api_key, _content_model = get_llm_config("content_subagent")

    model = ResilientChatModel(
        agent_type="main_agent",
        model=_main_model,
        api_key=_main_api_key,
        base_url=_main_base_url,
        temperature=0.45,
        streaming=True,
    )
    research_model = ResilientChatModel(
        agent_type="research_subagent",
        model=_research_model,
        api_key=_research_api_key,
        base_url=_research_base_url,
        temperature=0.3,
        streaming=True,
    )
    content_model = ResilientChatModel(
        agent_type="content_subagent",
        model=_content_model,
        api_key=_content_api_key,
        base_url=_content_base_url,
        temperature=0.55,
        streaming=True,
    )

    research_subagent = {
        "name": "research-subagent",
        "description": "Web research specialist.",
        "system_prompt": RESEARCH_SUBAGENT_PROMPT,
        "model": research_model,
        "tools": [unified_search, unified_extract, think_tool],
    }

    content_subagent = {
        "name": "content-subagent",
        "description": "Content creation specialist.",
        "system_prompt": CONTENT_SUBAGENT_PROMPT,
        "model": content_model,
        "tools": [
            read_skill,
            fetch_images_brave,
            analyze_images_gemini,
            create_post_image,
            get_design_guide,
            think_tool,
        ],
    }

    _fallback_tool_candidates = [
        unified_search,
        unified_extract,
        think_tool,
        fetch_images_brave,
        analyze_images_gemini,
        create_post_image,
        save_posts_to_supabase,
        get_design_guide,
        read_skill,
        list_skills,
        manage_skill,
        get_wordpress_categories,
        publish_to_wordpress,
        youtube_transcript,
        search_conversation_history,
        omni_analyzer,
        text_to_speech,
        terminal,
        upload_to_storage,
        add_to_desk,
    ]
    _enabled_plugins = enabled_plugins_from_db()
    fallback_tools = [
        t for t in _fallback_tool_candidates
        if is_tool_allowed(getattr(t, "name", ""), _enabled_plugins)
    ]

    fallback_agent = create_deep_agent(
        model=model,
        tools=fallback_tools,
        subagents=[research_subagent, content_subagent],
        system_prompt=INSTRUCTIONS,
        middleware=[CurrentDateTimeMiddleware()],
        name="research-agent",
        backend=thread_filesystem_backend,
    )

    builder.add_node("static_fallback", fallback_agent)
    builder.add_node("desk_execute", desk_execute)
    builder.add_edge("static_fallback", END)
    builder.add_edge("desk_execute", END)

    def route_fallback(state, config):
        return "desk_execute" if _is_desk_execute_run(state) else "static_fallback"

    builder.add_conditional_edges(
        START,
        route_fallback,
        {"static_fallback": "static_fallback", "desk_execute": "desk_execute"}
    )
    agent = builder.compile()
