"""Research Agent - Standalone script for LangGraph deployment.

# Forced reload trigger - 2026-06-30 22:28:00
This module creates a single self-researching agent with a unified tool set.
Provider selection (Linkup vs Parallel AI, Tavily vs Exa, KIE vs Gemini Flash)
is managed automatically by the unified tools based on settings in Supabase.

LLM provider/model is resolved from Supabase agent_settings at startup.
API keys are ALWAYS read from environment variables — never from Supabase.
To switch providers: change main_agent_provider in Supabase → touch agent.py.

NOTE: Thread persistence is handled automatically by the LangGraph API platform.
Do NOT add a custom checkpointer here — LangGraph uses POSTGRES_URI from .env.

Context Management (SummarizationMiddleware):
  Enabled via create_deep_agent middleware param. When the conversation thread
  grows long, the agent auto-summarizes and offloads to its virtual filesystem,
  keeping the context window focused and preventing token overflow on long runs.
"""

import os
import time
import asyncio
import random
from datetime import datetime

from langchain_openai import ChatOpenAI
from deepagents import create_deep_agent

from research_agent.prompts import (
    MAIN_AGENT_INSTRUCTIONS,
    RESEARCH_SUBAGENT_PROMPT,
    CONTENT_SUBAGENT_PROMPT,
)
from research_agent.tools import (
    # ── Unified orchestrators (primary tools for the agent) ──────────────────
    unified_search,
    unified_extract,
    create_post_image,
    youtube_transcript,
    # ── Support tools ────────────────────────────────────────────────────────
    think_tool,
    fetch_images_brave,
    view_candidate_images,
    analyze_images_gemini,
    save_posts_to_supabase,
    get_design_guide,
    read_skill,
    list_skills,
    manage_skill,
    get_wordpress_categories,
    publish_to_wordpress,
    # ── Dynamic Tool Routing ─────────────────────────────────────────────────
    list_tools,
    load_tools,
    call_tool,
    build_tools_index,
)
from research_agent.tools.provider_engine import get_llm_config

# Inject today's date into the unified prompt
INSTRUCTIONS = MAIN_AGENT_INSTRUCTIONS.format(date=datetime.now().strftime("%Y-%m-%d"))

# Configure Resilience for LLM API calls
_LLM_MAX_ATTEMPTS = 6          # total attempts before giving up
_LLM_RATE_LIMIT_DELAY = 65.0  # flat wait (s) after a 429 — long enough for NVIDIA NIM to reset
_LLM_BASE_DELAY = 5.0          # base delay for other errors (exponential from here)


class ResilientChatModel(ChatOpenAI):
    """Wraps ChatOpenAI with rate-limit-aware retries tuned for enterprise LLM APIs.

    Retry strategy:
    - 429 Rate Limit  → flat 65 s wait, then retry (up to max attempts)
    - Other errors    → exponential backoff: 5 s, 10 s, 20 s, 40 s, 60 s
    - 401/403/bad key → fatal, raise immediately (no retry)

    Supports all OpenAI-compatible providers: OpenAI, Anthropic, OpenRouter,
    Vercel AI Gateway, LiteLLM, Groq, Together AI.
    """

    max_retries: int = 0  # Disable built-in tenacity retries — we handle it ourselves

    def _filter_messages_by_capability(self, messages: list) -> list:
        """Filter message content blocks based on the model's capabilities to avoid API errors."""
        raw_model = getattr(self, "model_name", None) or getattr(self, "model", "unknown-model")
        model_name = str(raw_model).lower()

        # Determine capabilities based on model name
        supports_video = False
        supports_audio = False
        supports_image = False
        supports_pdf = False

        # mimo-v2.5 supports video, audio, image
        if "mimo-v2.5" in model_name:
            if "pro" not in model_name and "tts" not in model_name:
                supports_video = True
                supports_audio = True
                supports_image = True
            else:
                # mimo-v2.5-pro / mimo-v2.5-tts are text or specific output only
                pass
        # gemini or xiaomi/mimo omni models or vercel AI endpoints that might proxy to gemini/kimi
        elif any(kw in model_name for kw in ["gemini", "flash", "pro", "kimi"]):
            supports_image = True
            supports_audio = True
            supports_video = True
            supports_pdf = True
        elif "gpt-4o" in model_name:
            supports_image = True
            supports_audio = True
        elif "claude" in model_name:
            supports_image = True
            supports_pdf = True
        elif any(kw in model_name for kw in ["pixtral", "vision", "vl", "llava"]):
            supports_image = True
        else:
            # Fallback/default: assume typical modern omni/vision models support images
            supports_image = True

        cleaned_messages = []
        for msg in messages:
            if not hasattr(msg, "content"):
                cleaned_messages.append(msg)
                continue

            if isinstance(msg.content, list):
                new_content = []
                for block in msg.content:
                    if isinstance(block, str):
                        new_content.append(block)
                        continue

                    if not isinstance(block, dict):
                        new_content.append(block)
                        continue

                    block_type = block.get("type")
                    if block_type == "text":
                        new_content.append(block)
                    elif block_type == "image_url":
                        url = block.get("image_url", {}).get("url", "")
                        
                        is_pdf = url.startswith("data:application/pdf")
                        is_audio = url.startswith("data:audio/")
                        is_video = url.startswith("data:video/")
                        is_image = url.startswith("data:image/") or not url.startswith("data:")

                        if is_image and supports_image:
                            new_content.append(block)
                        elif is_pdf:
                            if "claude" in model_name:
                                # Convert to Claude document block format
                                base64_data = url.split(",")[1] if "," in url else url
                                new_content.append({
                                    "type": "document",
                                    "source": {
                                        "type": "base64",
                                        "media_type": "application/pdf",
                                        "data": base64_data
                                    }
                                })
                            elif supports_pdf:
                                new_content.append(block)
                            else:
                                new_content.append({
                                    "type": "text",
                                    "text": f"\n[Attachment omitted: PDF Document is not supported by {model_name}]"
                                })
                        elif is_audio:
                            # If model expects input_audio (mimo or gpt-4o), keep that block and drop this image_url duplicate
                            if "mimo" in model_name or "gpt-4o" in model_name:
                                pass
                            elif supports_audio:
                                new_content.append(block)
                            else:
                                new_content.append({
                                    "type": "text",
                                    "text": f"\n[Attachment omitted: Audio File is not supported by {model_name}]"
                                })
                        elif is_video:
                            # If model expects video_url (mimo), keep that block and drop this image_url duplicate
                            if "mimo" in model_name:
                                pass
                            elif supports_video:
                                new_content.append(block)
                            else:
                                new_content.append({
                                    "type": "text",
                                    "text": f"\n[Attachment omitted: Video File is not supported by {model_name}]"
                                })
                        else:
                            new_content.append(block)

                    elif block_type == "input_audio":
                        if supports_audio:
                            new_content.append(block)
                        else:
                            new_content.append({
                                    "type": "text",
                                    "text": f"\n[Attachment omitted: Audio File is not supported by {model_name}]"
                                })
                    elif block_type == "video_url":
                        if supports_video:
                            new_content.append(block)
                        else:
                            new_content.append({
                                    "type": "text",
                                    "text": f"\n[Attachment omitted: Video File is not supported by {model_name}]"
                                })
                    else:
                        new_content.append(block)

                if not new_content:
                    new_content = [""]

                # If all blocks are text/strings, simplify to a single string
                if all(isinstance(c, str) or (isinstance(c, dict) and c.get("type") == "text") for c in new_content):
                    simplified_text = []
                    for c in new_content:
                        if isinstance(c, str):
                            simplified_text.append(c)
                        else:
                            simplified_text.append(c.get("text", ""))
                    msg.content = "".join(simplified_text)
                else:
                    msg.content = new_content

            cleaned_messages.append(msg)
        return cleaned_messages

    def _filter_input(self, input_val):
        if isinstance(input_val, list):
            return self._filter_messages_by_capability(input_val)
        elif hasattr(input_val, "to_messages"):
            messages = input_val.to_messages()
            return self._filter_messages_by_capability(messages)
        return input_val

    def _is_fatal_error(self, e: Exception) -> bool:
        """Client-side config errors that will never succeed on retry."""
        error_msg = str(e).lower()
        # 401/403 are fatal — but 429 is NOT fatal even though it's a 4xx!
        if any(code in error_msg for code in ["401", "403", "unauthorized", "forbidden", "invalid api key"]):
            return True
        return False

    def _is_rate_limit(self, e: Exception) -> bool:
        """Detect 429 rate-limit errors across all providers."""
        msg = str(e).lower()
        return "429" in msg or "rate limit" in msg or "too many requests" in msg or "rate_limit" in msg

    def _get_backoff_delay(self, attempt: int) -> float:
        """Exponential backoff with jitter for non-rate-limit errors."""
        base_delay = _LLM_BASE_DELAY * (2 ** (attempt - 1))
        jitter = random.uniform(0.0, 0.2 * base_delay)  # 0-20% jitter
        return min(base_delay + jitter, 60.0)

    async def astream(self, *args, **kwargs):
        """Stream tokens with retry logic — required for real-time token streaming in the frontend.

        Without this override, ChatOpenAI.astream() is called directly with NO retry logic,
        and token-by-token streaming is silently lost when the upstream raises errors.

        Guard: if streaming already started (tokens sent), do NOT retry — that would
        send duplicate content to the frontend. Only retry before first token.
        """
        args_list = list(args)
        if len(args_list) > 0:
            args_list[0] = self._filter_input(args_list[0])
        args = tuple(args_list)

        for attempt in range(1, _LLM_MAX_ATTEMPTS + 1):
            stream_started = False
            try:
                async for chunk in super().astream(*args, **kwargs):
                    stream_started = True
                    yield chunk
                return  # success — stop retrying
            except Exception as e:
                if stream_started:
                    # Mid-stream failure — cannot restart without sending duplicates.
                    print(f"[LLM] ⚠️ Stream failed AFTER first token on attempt {attempt}. "
                          f"Not retrying to avoid duplicate content. Error: {e}")
                    raise

                if self._is_fatal_error(e):
                    print(f"[LLM] ⛔ Fatal error on stream attempt {attempt}/{_LLM_MAX_ATTEMPTS}: {e}")
                    raise

                if attempt == _LLM_MAX_ATTEMPTS:
                    print(f"[LLM] ❌ All {_LLM_MAX_ATTEMPTS} async stream attempts exhausted. Last error: {e}")
                    raise

                if self._is_rate_limit(e):
                    print(f"[LLM] ⏳ Rate limit (429) on stream attempt {attempt}/{_LLM_MAX_ATTEMPTS}. "
                          f"Waiting {_LLM_RATE_LIMIT_DELAY:.0f}s...")
                    await asyncio.sleep(_LLM_RATE_LIMIT_DELAY)
                else:
                    delay = self._get_backoff_delay(attempt)
                    print(f"[LLM] ⚠️  Stream attempt {attempt}/{_LLM_MAX_ATTEMPTS} failed: {e}. "
                          f"Retrying in {delay:.1f}s...")
                    await asyncio.sleep(delay)

    async def ainvoke(self, *args, **kwargs):
        args_list = list(args)
        if len(args_list) > 0:
            args_list[0] = self._filter_input(args_list[0])
        args = tuple(args_list)

        for attempt in range(1, _LLM_MAX_ATTEMPTS + 1):
            try:
                return await super().ainvoke(*args, **kwargs)
            except Exception as e:
                if self._is_fatal_error(e):
                    print(f"[LLM] ⛔ Fatal error on attempt {attempt}/{_LLM_MAX_ATTEMPTS}: {e}")
                    raise

                if attempt == _LLM_MAX_ATTEMPTS:
                    print(f"[LLM] ❌ All {_LLM_MAX_ATTEMPTS} async attempts exhausted. Last error: {e}")
                    raise

                if self._is_rate_limit(e):
                    print(f"[LLM] ⏳ Rate limit (429) on attempt {attempt}/{_LLM_MAX_ATTEMPTS}. "
                          f"Waiting {_LLM_RATE_LIMIT_DELAY:.0f}s for provider reset...")
                    await asyncio.sleep(_LLM_RATE_LIMIT_DELAY)
                else:
                    delay = self._get_backoff_delay(attempt)
                    print(f"[LLM] ⚠️  Attempt {attempt}/{_LLM_MAX_ATTEMPTS} failed: {e}. "
                          f"Retrying in {delay:.1f}s...")
                    await asyncio.sleep(delay)

    def invoke(self, *args, **kwargs):
        args_list = list(args)
        if len(args_list) > 0:
            args_list[0] = self._filter_input(args_list[0])
        args = tuple(args_list)

        for attempt in range(1, _LLM_MAX_ATTEMPTS + 1):
            try:
                return super().invoke(*args, **kwargs)
            except Exception as e:
                if self._is_fatal_error(e):
                    print(f"[LLM] ⛔ Fatal error on attempt {attempt}/{_LLM_MAX_ATTEMPTS}: {e}")
                    raise

                if attempt == _LLM_MAX_ATTEMPTS:
                    print(f"[LLM] ❌ All {_LLM_MAX_ATTEMPTS} sync attempts exhausted. Last error: {e}")
                    raise

                if self._is_rate_limit(e):
                    print(f"[LLM] ⏳ Rate limit (429) on attempt {attempt}/{_LLM_MAX_ATTEMPTS}. "
                    f"Waiting {_LLM_RATE_LIMIT_DELAY:.0f}s for provider reset...")
                    time.sleep(_LLM_RATE_LIMIT_DELAY)
                else:
                    delay = self._get_backoff_delay(attempt)
                    print(f"[LLM] ⚠️  Attempt {attempt}/{_LLM_MAX_ATTEMPTS} failed: {e}. "
                          f"Retrying in {delay:.1f}s...")
                    time.sleep(delay)


# ── Model Resolution ───────────────────────────────────────────────────────────
# Resolved from Supabase agent_settings (provider/model) + env vars (API key).
# Falls back to AGENT_DEFAULTS in provider_engine if not configured.
# streaming=True is REQUIRED for token-by-token streaming in the frontend.

_main_base_url, _main_api_key, _main_model = get_llm_config("main_agent")
print(f"[agent] Main agent model={_main_model} via {_main_base_url[:40]}...")

# DEBUG: show first/last 6 chars of resolved API key to diagnose auth issues
_key_preview = (
    f"{_main_api_key[:6]}...{_main_api_key[-6:]}"
    if len(_main_api_key) > 12
    else f"(empty or too short: len={len(_main_api_key)})"
)
print(f"[agent] Resolved API key: {_key_preview}")

model = ResilientChatModel(
    model=_main_model,
    api_key=_main_api_key,
    base_url=_main_base_url,
    temperature=0.45,
    streaming=True,  # enables token-by-token streaming via astream()
)

# ── Subagent Models ────────────────────────────────────────────────────────────
# Each subagent can use a different provider/model — configured in Supabase
# agent_settings (research_subagent_provider / research_subagent_model, etc.).
# Falls back to main_agent config if not separately configured.

_research_base_url, _research_api_key, _research_model = get_llm_config("research_subagent")
print(f"[agent] Research subagent model={_research_model} via {_research_base_url[:40]}...")

research_model = ResilientChatModel(
    model=_research_model,
    api_key=_research_api_key,
    base_url=_research_base_url,
    temperature=0.3,   # lower temp for factual web research
    streaming=True,
)

_content_base_url, _content_api_key, _content_model = get_llm_config("content_subagent")
print(f"[agent] Content subagent model={_content_model} via {_content_base_url[:40]}...")

content_model = ResilientChatModel(
    model=_content_model,
    api_key=_content_api_key,
    base_url=_content_base_url,
    temperature=0.55,  # slightly higher temp for creative writing
    streaming=True,
)

# ── Context Management (Built-in) ────────────────────────────────────────────────────────
# deepagents includes SummarizationMiddleware in its default harness profile.
# When a conversation thread grows long, the agent automatically:
#   - Summarizes the conversation (SESSION INTENT / SUMMARY / ARTIFACTS / NEXT STEPS)
#   - Offloads heavy tool outputs to the virtual filesystem
#   - Keeps the LLM context focused for long-horizon research tasks
#
# NOTE: DO NOT pass SummarizationMiddleware manually in middleware=[...].
# The default harness already includes it. Adding another copy raises:
#   AssertionError: Please remove duplicate middleware instances.
# The built-in behavior is controlled by HarnessProfiles registered for the
# specific model provider. No custom configuration needed for standard usage.

# ── Dynamic Agent Resolution ────────────────----------------------------------
# Fetches configurations, tools, prompts, and MCP tool wrappers from Supabase.
# Falls back gracefully to the hardcoded defaults if Supabase is offline.

from research_agent.tools.mcp_loader import load_mcp_tools_for_agent
from langchain.agents import AgentState
from langgraph.graph import StateGraph, START, END

from langchain_core.messages import SystemMessage
import base64
import mimetypes
from pathlib import Path

def _load_agent_design_assets(client, agent_id: str) -> list[dict]:
    try:
        resp = client.table("agent_design_assets").select("design_assets(*)").eq("agent_id", agent_id).execute()
        assets = []
        for row in (resp.data or []):
            if row.get("design_assets"):
                assets.append(row["design_assets"])
        return assets
    except Exception as e:
        print(f"[agent] Error loading reference images for agent {agent_id}: {e}")
        return []

def _get_base64_image(file_path: str) -> tuple[str, str]:
    repo_root = Path(__file__).resolve().parent
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
    content_blocks.append({"type": "text", "text": "\n\n=== ATTACHED BRAND/STYLE REFERENCE IMAGES ===\nYou can refer to these images directly by their Key or Label in your instructions (e.g. \"Reference Image 1\" or by their Key/Label)."})
    
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
            print(f"[agent] Error loading reference image {asset['file_path']}: {e}")
    
    return SystemMessage(content=content_blocks)

def _bind_agent_id_to_list_skills(list_skills_tool, agent_id: str):
    from langchain_core.tools import tool
    from typing import Optional
    
    @tool("list_skills")
    def list_skills_bound(category: Optional[str] = None) -> str:
        """List all available skills with their names, descriptions, and categories.

        Use this to discover what specialized knowledge is available to you before
        starting a task. Returns a compact summary — call read_skill() to load
        the full content of any skill you want to use.

        Args:
            category: Optional filter — only show skills in this category
                      (e.g. 'research', 'content', 'publishing', 'general').
        """
        return list_skills_tool.func(category=category, agent_id=agent_id)
    return list_skills_bound


def _bind_agent_id_to_read_skill(read_skill_tool, agent_id: str):
    from langchain_core.tools import tool
    
    @tool("read_skill")
    def read_skill_bound(skill_name: str) -> str:
        """Load a skill instruction file from disk and return its full content.

        Call this at the START of any task that uses a named skill.
        For example, call read_skill("blog_post_writer") before writing a blog post.

        The skill file contains detailed step-by-step instructions, rules, templates,
        and checklists that you MUST follow exactly for that task.

        Args:
            skill_name: The name of the skill directory (e.g. "blog_post_writer").
                        Must match a folder inside research_agent/skills/.
        """
        return read_skill_tool.func(skill_name=skill_name, agent_id=agent_id)
    return read_skill_bound


def _bind_agent_id_to_list_tools(list_tools_tool, agent_id: str):
    from langchain_core.tools import tool
    from typing import Optional
    
    @tool("list_tools")
    def list_tools_bound(query: Optional[str] = None, mcp_name: Optional[str] = None) -> str:
        """Perform a search or discovery to find tools.

        If mcp_name is provided, retrieves all active tools for that specific MCP connection
        assigned to the agent.
        If query is provided, performs a local lexical keyword search on normal-indexed tools.

        Args:
            query: Natural language query describing what task you need to perform (optional).
            mcp_name: The name of the MCP connection (e.g., 'googledocs', 'gmail') to list its tools (optional).
        """
        return list_tools_tool.func(query=query, mcp_name=mcp_name, agent_id=agent_id)
    return list_tools_bound


def _bind_agent_id_to_load_tools(load_tools_tool, agent_id: str):
    from langchain_core.tools import tool
    from typing import List
    
    @tool("load_tools")
    def load_tools_bound(tool_names: List[str]) -> str:
        """Load the complete JSON schemas for the specified tool names.

        Fetches full schemas (parameters, types, required fields) from the master registry.
        Returns these schemas so they can be injected directly into the active prompt or context.

        Args:
            tool_names: List of tool names to load (e.g. ['think_tool', 'unified_search'])
        """
        return load_tools_tool.func(tool_names=tool_names, agent_id=agent_id)
    return load_tools_bound


def _bind_agent_id_to_call_tool(call_tool_tool, agent_id: str):
    from langchain_core.tools import tool
    from typing import Dict, Any
    
    @tool("call_tool")
    def call_tool_bound(tool_name: str, arguments: Dict[str, Any]) -> str:
        """Execute a dynamically loaded tool with the specified arguments.

        Use this tool to execute any tool from the <available_tools> index or found via list_tools
        after you have loaded its schema via load_tools. Do NOT call dynamic tools directly;
        you must route them through this call_tool function.

        Args:
            tool_name: The name of the tool to execute (e.g. 'publish_to_wordpress')
            arguments: A dictionary of arguments to pass to the tool (e.g. {'blog_post_markdown': '...', 'category_id': 1})
        """
        return call_tool_tool.func(tool_name=tool_name, arguments=arguments, agent_id=agent_id)
    return call_tool_bound

# Global registry of compiled workflow agents
compiled_workflows = {}
default_workflow_id = None

def load_dynamic_agents_by_workflow():
    global default_workflow_id
    import os
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_ANON_KEY", "")
        if not url or not key:
            print("[agent] Supabase URL/Key missing. Using static fallback.")
            return {}

        client = create_client(url, key)

        # ── Sync Pinecone vector index on reload ────────────────────────
        try:
            from research_agent.tools.dynamic_router import sync_pinecone_vector_index
            print("[agent] Synchronizing Pinecone vector index...")
            sync_pinecone_vector_index(client)
            print("[agent] Pinecone synchronization complete.")
        except Exception as e:
            print(f"[agent] [WARNING] Pinecone synchronization failed: {e}")

        # 1. Fetch all active workflows (scheduler status is checked by cron_scheduler.py)
        workflows_resp = client.table("workflows").select("*").eq("is_active", True).execute()
        workflows = workflows_resp.data or []
        if not workflows:
            print("[agent] No workflows found in database.")
            return {}

        # Find default workflow id if any
        for wf in workflows:
            if wf.get("name") == "Default Workflow":
                default_workflow_id = wf["id"]
                break
        if not default_workflow_id and workflows:
            default_workflow_id = workflows[0]["id"]

        # 2. Fetch enabled agent configurations
        resp = client.table("agent_configs").select("*").eq("enabled", True).order("sort_order").execute()
        configs = resp.data or []

        # 3. Load tool assignments
        assign_resp = client.table("agent_tool_assignments").select("*").eq("enabled", True).execute()
        assignments = assign_resp.data or []

        # 3.5 Load workflow-agent assignments (many-to-many)
        try:
            mappings_resp = client.table("workflow_agent_assignments").select("*").execute()
            mappings = mappings_resp.data or []
        except Exception as e:
            print(f"[agent] [WARNING] Failed to fetch workflow_agent_assignments (using legacy workflow_id fallback): {e}")
            mappings = []

        # Fetch agent settings from Supabase
        try:
            settings_resp = client.table("agent_settings").select("key,value").execute()
            db_settings = {row["key"]: row["value"] for row in (settings_resp.data or [])}
        except Exception as e:
            print(f"[agent] Failed to fetch agent settings: {e}")
            db_settings = {}

        super_enabled = db_settings.get("super_indexing_enabled", "true").lower() == "true"
        normal_enabled = db_settings.get("normal_indexing_enabled", "true").lower() == "true"

        # Parse built-in tools loading modes
        builtin_loading_modes_str = db_settings.get("builtin_tools_loading_modes", "{}")
        try:
            import json
            builtin_loading_modes = json.loads(builtin_loading_modes_str)
        except Exception:
            builtin_loading_modes = {}

        # Fetch global MCP tool settings
        try:
            mcp_settings_resp = client.table("mcp_tool_settings").select("tool_key, loading_mode").execute()
            mcp_tool_modes = {row["tool_key"]: row["loading_mode"] for row in (mcp_settings_resp.data or [])}
        except Exception as e:
            print(f"[agent] Failed to fetch mcp_tool_settings: {e}")
            mcp_tool_modes = {}

        # Tool lookup for built-in tools
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
        )

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
        }

        tool_assignments_by_agent = {}
        for a in assignments:
            agent_id = a.get("agent_id")
            if agent_id not in tool_assignments_by_agent:
                tool_assignments_by_agent[agent_id] = []
            tool_assignments_by_agent[agent_id].append(a)

        def make_dynamic_unified_tool(t_key: str):
            from langchain_core.tools import StructuredTool
            from research_agent.tools.provider_engine import execute_unified_pipeline
            category = t_key.replace("unified_", "")

            async def _run_dynamic_tool(query: str = "", urls: list[str] = [], **kwargs) -> str:
                return await execute_unified_pipeline(
                    category=category,
                    built_in_map={},
                    default_provider_keys=[],
                    max_retries=3,
                    query=query,
                    urls=urls,
                    **kwargs
                )

            return StructuredTool.from_function(
                coroutine=_run_dynamic_tool,
                name=t_key,
                description=f"Unified tool for '{category}'. Calls connected providers in priority order.",
            )

        workflows_compiled = {}

        # Compile each workflow
        for wf in workflows:
            wf_id = wf["id"]
            # 1. Resolve Main Agents for this workflow
            main_configs = []
            for c in configs:
                if c.get("agent_type") == "main":
                    is_mapped = any(str(m["agent_id"]) == str(c["id"]) and str(m["workflow_id"]) == str(wf_id) for m in mappings) if mappings else False
                    is_direct = str(c.get("workflow_id")) == str(wf_id)
                    if is_mapped or is_direct:
                        main_configs.append(c)

            if not main_configs:
                print(f"[agent] Workflow '{wf['name']}' has no Main Agent. Skipping.")
                continue

            # 2. Resolve subagents explicitly assigned to this workflow
            local_subs = []
            for c in configs:
                if c.get("agent_type") == "subagent":
                    is_mapped = any(str(m["agent_id"]) == str(c["id"]) and str(m["workflow_id"]) == str(wf_id) for m in mappings) if mappings else False
                    is_direct = str(c.get("workflow_id")) == str(wf_id)
                    if is_mapped or is_direct:
                        local_subs.append(c)

            sub_configs = local_subs

            main_cfg = main_configs[0]
            main_id = main_cfg["id"]
            base_main_prompt = main_cfg.get("system_prompt", "").replace("{date}", datetime.now().strftime("%Y-%m-%d"))

            # ── Inject compact skills index into system prompt ────────────
            # Hermes-style: only name + 80-char description per skill (~100-200 tokens total)
            # Full skill content is loaded on-demand via read_skill()
            # Skills are filtered by agent_tool_assignments (tool_type='skill')
            # so each agent only sees skills assigned to it in the Settings UI
            try:
                skills_index = build_skills_index(agent_id=main_id)
                if skills_index:
                    base_main_prompt = base_main_prompt + "\n\n" + skills_index
                    print(f"[agent] [OK] Skills index injected into system prompt (agent: {main_id[:8]}...)")
            except Exception as e:
                print(f"[agent] [WARNING] Failed to build skills index: {e}")

            try:
                tools_index = build_tools_index(agent_id=main_id)
                if tools_index:
                    base_main_prompt = base_main_prompt + "\n\n" + tools_index
                    print(f"[agent] [OK] Tools index injected into system prompt (agent: {main_id[:8]}...)")
            except Exception as e:
                print(f"[agent] [WARNING] Failed to build tools index: {e}")

            main_prompt = _get_agent_system_prompt_with_images(client, main_id, base_main_prompt)

            # Resolve Main Agent provider and model dynamically
            main_provider = main_cfg.get("provider") or "vercel"
            main_model_name = main_cfg.get("model") or "xiaomi/mimo-v2.5-pro"

            from research_agent.tools.provider_engine import get_provider_base_url, get_provider_api_key, get_provider_config
            main_base_url = get_provider_base_url(main_provider)

            cfg = get_provider_config(main_provider)
            needs_v1 = cfg and "base_url_env" in cfg
            if needs_v1 and not main_base_url.endswith("/v1"):
                main_base_url = main_base_url + "/v1"

            main_api_key = get_provider_api_key(main_provider)

            main_model = ResilientChatModel(
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
                
                # Resolve global loading mode
                if t_type == "builtin":
                    loading_mode = builtin_loading_modes.get(t_key, "primary")
                else:  # mcp
                    loading_mode = mcp_tool_modes.get(t_key, "primary")

                if t_key in ["list_tools", "load_tools", "call_tool"]:
                    loading_mode = "primary"
                
                # Map legacy vector to super
                if loading_mode == "vector":
                    loading_mode = "super"

                # Apply override if disabled
                if loading_mode == "super" and not super_enabled:
                    loading_mode = "primary"
                if loading_mode == "normal" and not normal_enabled:
                    loading_mode = "primary"
                
                if loading_mode != "primary":
                    continue

                if t_type == "builtin":
                    if t_key in tool_lookup:
                        tool_func = tool_lookup[t_key]
                        if t_key == "list_skills":
                            tool_func = _bind_agent_id_to_list_skills(list_skills, main_id)
                        elif t_key == "read_skill":
                            tool_func = _bind_agent_id_to_read_skill(read_skill, main_id)
                        elif t_key == "list_tools":
                            tool_func = _bind_agent_id_to_list_tools(list_tools, main_id)
                        elif t_key == "load_tools":
                            tool_func = _bind_agent_id_to_load_tools(load_tools, main_id)
                        elif t_key == "call_tool":
                            tool_func = _bind_agent_id_to_call_tool(call_tool, main_id)
                        
                        # Apply bindings
                        bindings = bindings_by_tool.get(t_key) or {}
                        if bindings:
                            tool_func = bind_tool_parameters(tool_func, bindings)
                        main_tools.append(tool_func)
                    elif t_key.startswith("unified_"):
                        tool_func = make_dynamic_unified_tool(t_key)
                        # Apply bindings
                        bindings = bindings_by_tool.get(t_key) or {}
                        if bindings:
                            tool_func = bind_tool_parameters(tool_func, bindings)
                        main_tools.append(tool_func)

            # Load MCP tools
            main_mcp = load_mcp_tools_for_agent(main_id)
            wrapped_main_mcp = []
            for t in main_mcp:
                bindings = bindings_by_tool.get(t.name) or {}
                if bindings:
                    wrapped_main_mcp.append(bind_tool_parameters(t, bindings))
                else:
                    wrapped_main_mcp.append(t)
            main_tools.extend(wrapped_main_mcp)

            # Build Subagents
            subagents = []
            for sub in sub_configs:
                sub_id = sub["id"]
                base_sub_prompt = sub.get("system_prompt", "")

                # ── Inject compact skills index into system prompt for subagents ──
                try:
                    skills_index = build_skills_index(agent_id=sub_id)
                    if skills_index:
                        base_sub_prompt = base_sub_prompt + "\n\n" + skills_index
                        print(f"[agent] [OK] Skills index injected into subagent system prompt (agent: {sub_id[:8]}...)")
                except Exception as e:
                    print(f"[agent] [WARNING] Failed to build subagent skills index: {e}")

                try:
                    tools_index = build_tools_index(agent_id=sub_id)
                    if tools_index:
                        base_sub_prompt = base_sub_prompt + "\n\n" + tools_index
                        print(f"[agent] [OK] Tools index injected into subagent system prompt (agent: {sub_id[:8]}...)")
                except Exception as e:
                    print(f"[agent] [WARNING] Failed to build subagent tools index: {e}")

                sub_prompt = _get_agent_system_prompt_with_images(client, sub_id, base_sub_prompt)
                
                sub_provider = sub.get("provider") or "vercel"
                sub_model_name = sub.get("model") or "xiaomi/mimo-v2.5-pro"

                sub_base_url = get_provider_base_url(sub_provider)

                sub_cfg = get_provider_config(sub_provider)
                sub_needs_v1 = sub_cfg and "base_url_env" in sub_cfg
                if sub_needs_v1 and not sub_base_url.endswith("/v1"):
                    sub_base_url = sub_base_url + "/v1"

                sub_api_key = get_provider_api_key(sub_provider)

                sub_model = ResilientChatModel(
                    model=sub_model_name,
                    api_key=sub_api_key,
                    base_url=sub_base_url,
                    temperature=0.3 if "research" in sub["name"].lower() else 0.55,
                    streaming=True,
                )

                sub_tools = []
                sub_bindings_by_tool = {a.get("tool_key"): a.get("parameter_bindings") or {} for a in tool_assignments_by_agent.get(sub_id, [])}
                from research_agent.tools.dynamic_router import bind_tool_parameters

                for a in tool_assignments_by_agent.get(sub_id, []):
                    t_type = a.get("tool_type")
                    t_key = a.get("tool_key")
                    
                    # Resolve global loading mode
                    if t_type == "builtin":
                        loading_mode = builtin_loading_modes.get(t_key, "primary")
                    else:  # mcp
                        loading_mode = mcp_tool_modes.get(t_key, "primary")

                    if t_key in ["list_tools", "load_tools", "call_tool"]:
                        loading_mode = "primary"
                    
                    # Map legacy vector to super
                    if loading_mode == "vector":
                        loading_mode = "super"

                    # Apply override if disabled
                    if loading_mode == "super" and not super_enabled:
                        loading_mode = "primary"
                    if loading_mode == "normal" and not normal_enabled:
                        loading_mode = "primary"
                    
                    if loading_mode != "primary":
                        continue

                    if t_type == "builtin":
                        if t_key in tool_lookup:
                            tool_func = tool_lookup[t_key]
                            if t_key == "list_skills":
                                tool_func = _bind_agent_id_to_list_skills(list_skills, sub_id)
                            elif t_key == "read_skill":
                                tool_func = _bind_agent_id_to_read_skill(read_skill, sub_id)
                            elif t_key == "list_tools":
                                tool_func = _bind_agent_id_to_list_tools(list_tools, sub_id)
                            elif t_key == "load_tools":
                                tool_func = _bind_agent_id_to_load_tools(load_tools, sub_id)
                            elif t_key == "call_tool":
                                tool_func = _bind_agent_id_to_call_tool(call_tool, sub_id)
                            
                            # Apply bindings
                            bindings = sub_bindings_by_tool.get(t_key) or {}
                            if bindings:
                                tool_func = bind_tool_parameters(tool_func, bindings)
                            sub_tools.append(tool_func)
                        elif t_key.startswith("unified_"):
                            tool_func = make_dynamic_unified_tool(t_key)
                            # Apply bindings
                            bindings = sub_bindings_by_tool.get(t_key) or {}
                            if bindings:
                                tool_func = bind_tool_parameters(tool_func, bindings)
                            sub_tools.append(tool_func)

                # Load MCP tools
                sub_mcp = load_mcp_tools_for_agent(sub_id)
                wrapped_sub_mcp = []
                for t in sub_mcp:
                    bindings = sub_bindings_by_tool.get(t.name) or {}
                    if bindings:
                        wrapped_sub_mcp.append(bind_tool_parameters(t, bindings))
                    else:
                        wrapped_sub_mcp.append(t)
                sub_tools.extend(wrapped_sub_mcp)

                subagents.append({
                    "name": sub["name"],
                    "description": sub.get("description") or "",
                    "system_prompt": sub_prompt,
                    "model": sub_model,
                    "tools": sub_tools,
                })

            # Clean up tools
            for sa in subagents:
                sa["tools"] = [t for t in sa["tools"] if getattr(t, "name", "") not in ("analyze_images_gemini", "get_design_guide")]
            main_tools = [t for t in main_tools if getattr(t, "name", "") not in ("analyze_images_gemini", "get_design_guide")]

            print(f"[agent] Compiling workflow '{wf['name']}' with {len(subagents)} subagents...")
            compiled_agent = create_deep_agent(
                model=main_model,
                tools=main_tools,
                subagents=subagents,
                system_prompt=main_prompt,
                name=wf["name"].lower().replace(" ", "-"),
            )
            workflows_compiled[str(wf_id)] = compiled_agent
            workflows_compiled[wf["name"]] = compiled_agent

        return workflows_compiled

    except Exception as e:
        print(f"[agent] Error loading dynamic workflows: {e}")
        return {}


def run_in_thread(func, *args, **kwargs):
    import threading
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


# Load the configuration
import traceback
import tempfile
import os as _os

_LOG_PATH = _os.path.join(tempfile.gettempdir(), "agent_load.log")

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
    print(f"[agent] Loaded {len(compiled_workflows)} workflow(s). Log: {_LOG_PATH}")
except Exception as e:
    with open(_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"\n--- Load Error at {datetime.now().isoformat()} ---\n")
        f.write(traceback.format_exc())
    print(f"[agent] ERROR loading workflows: {e}")
    compiled_workflows = {}


def route_workflow(state, config):
    workflow_id = config.get("configurable", {}).get("workflow_id")
    node_key = str(workflow_id) if workflow_id else None

    # 1. Check if the requested workflow_id is directly compiled
    if node_key and node_key in compiled_workflows:
        return node_key

    # 2. Fallback: Find the first compiled workflow UUID (contains hyphens)
    active_uuids = [k for k in compiled_workflows.keys() if "-" in k]
    if active_uuids:
        fallback_key = active_uuids[0]
        print(f"[agent] [WARNING] Requested workflow '{workflow_id}' is not compiled. Falling back to: '{fallback_key}'")
        return fallback_key

    # 3. Ultimate fallback
    active_keys = list(compiled_workflows.keys())
    if active_keys:
        fallback_key = active_keys[0]
        print(f"[agent] [WARNING] Requested workflow '{workflow_id}' is not compiled. Falling back to: '{fallback_key}'")
        return fallback_key

    raise ValueError(f"No active compiled workflows found. Available: {list(compiled_workflows.keys())}")


from langchain_core.runnables import RunnableConfig


def load_memories(state, config: RunnableConfig):
    """Disable automatic memory loading; the agent retrieves memories on-demand via search_memories tool."""
    return state


def save_chat_history(state, config: RunnableConfig):
    """Save the chat history (sessions & messages) to Supabase, and write the latest turn to Mem0."""
    configurable = config.get("configurable", {})
    workflow_id = configurable.get("workflow_id")
    thread_id = configurable.get("thread_id")
    user_id = configurable.get("user_id")
    
    if not workflow_id or not thread_id:
        print(f"[agent] save_chat_history: workflow_id ({workflow_id}) or thread_id ({thread_id}) missing.")
        return state

    messages = state.get("messages", [])
    if not messages:
        return state

    # 1. Sync thread history to Supabase (sessions and messages tables)
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_ANON_KEY", "")
        if url and key:
            client = create_client(url, key)
            
            # Map thread_id to a stable session UUID
            import uuid
            try:
                session_uuid = str(uuid.UUID(thread_id))
            except ValueError:
                session_uuid = str(uuid.uuid5(uuid.NAMESPACE_DNS, thread_id))

            # Upsert the session
            # Extract first user message for title
            title = "New Chat"
            for msg in messages:
                if msg.type == "human" and msg.content:
                    msg_content = msg.content
                    if not isinstance(msg_content, str):
                        parts = []
                        for b in msg_content:
                            if isinstance(b, str):
                                parts.append(b)
                            elif isinstance(b, dict) and b.get("type") == "text":
                                parts.append(b.get("text", ""))
                        msg_content = "".join(parts)
                    title = msg_content[:50] + ("..." if len(msg_content) > 50 else "")
                    break

            client.table("sessions").upsert({
                "id": session_uuid,
                "workflow_id": workflow_id,
                "title": title
            }, on_conflict="id").execute()

            # Delete existing messages and write fresh history to maintain order and structure
            client.table("messages").delete().eq("session_id", session_uuid).execute()

            rows_to_insert = []
            for msg in messages:
                role = "user"
                if msg.type == "ai":
                    role = "assistant"
                elif msg.type == "system":
                    role = "system"
                elif msg.type == "tool":
                    role = "tool"
                
                content = ""
                if isinstance(msg.content, str):
                    content = msg.content
                elif isinstance(msg.content, list):
                    parts = []
                    for block in msg.content:
                        if isinstance(block, str):
                            parts.append(block)
                        elif isinstance(block, dict) and block.get("type") == "text":
                            parts.append(block.get("text", ""))
                    content = "".join(parts)
                
                tool_calls = []
                if hasattr(msg, "tool_calls") and msg.tool_calls:
                    tool_calls = msg.tool_calls

                # Format tool calls to be JSON serializable
                serializable_tool_calls = []
                for tc in tool_calls:
                    serializable_tool_calls.append({
                        "name": tc.get("name"),
                        "args": tc.get("args"),
                        "id": tc.get("id")
                    })

                rows_to_insert.append({
                    "session_id": session_uuid,
                    "role": role,
                    "content": content,
                    "tool_calls": serializable_tool_calls
                })

            if rows_to_insert:
                client.table("messages").insert(rows_to_insert).execute()
                print(f"[agent] Synchronized {len(rows_to_insert)} messages to Supabase for session {session_uuid}")

    except Exception as e:
        print(f"[agent] Error syncing chat history to Supabase: {e}")

    # 2. Write turn to Mem0 memory if enabled
    try:
        from research_agent.tools.mem0_provider import get_mem0_client
        mem0 = get_mem0_client()
        if mem0 is not None:
            last_user_msg = None
            last_ai_msg = None
            for msg in reversed(messages):
                if msg.type == "human" and last_user_msg is None:
                    last_user_msg = msg
                elif msg.type == "ai" and last_ai_msg is None:
                    last_ai_msg = msg
                if last_user_msg is not None and last_ai_msg is not None:
                    break

            if last_user_msg and last_ai_msg:
                user_text = last_user_msg.content
                if not isinstance(user_text, str):
                    parts = []
                    for b in user_text:
                        if isinstance(b, str):
                            parts.append(b)
                        elif isinstance(b, dict) and b.get("type") == "text":
                            parts.append(b.get("text", ""))
                    user_text = "".join(parts)

                ai_text = last_ai_msg.content
                if not isinstance(ai_text, str):
                    parts = []
                    for b in ai_text:
                        if isinstance(b, str):
                            parts.append(b)
                        elif isinstance(b, dict) and b.get("type") == "text":
                            parts.append(b.get("text", ""))
                    ai_text = "".join(parts)

                # Sanitize scope_id: Pinecone requires lowercase alphanumeric + hyphens only
                raw_scope = f"{user_id}_{workflow_id}" if user_id else str(workflow_id)
                scope_id = raw_scope.lower().replace("_", "-")
                
                mem0_data = [
                    {"role": "user", "content": user_text},
                    {"role": "assistant", "content": ai_text}
                ]
                print(f"[agent] Adding turn to Mem0 for scope {scope_id}...")
                mem0.add(mem0_data, user_id=scope_id)
                print(f"[agent] Successfully added turn to Mem0.")
    except Exception as e:
        print(f"[agent] Error writing to Mem0: {e}")

    return state


# Define the master StateGraph
builder = StateGraph(AgentState)

if compiled_workflows:
    # Add load_memories and save_chat_history nodes
    builder.add_node("load_memories", load_memories)
    builder.add_node("save_chat_history", save_chat_history)

    # Add each workflow graph as a node
    for wf_key, wf_agent in compiled_workflows.items():
        builder.add_node(wf_key, wf_agent)
        builder.add_edge(wf_key, "save_chat_history")

    # Save chat history edge to END
    builder.add_edge("save_chat_history", END)

    # Start goes to load_memories
    builder.add_edge(START, "load_memories")

    # Add conditional edge from load_memories to workflow agents
    builder.add_conditional_edges(
        "load_memories",
        route_workflow,
        {wf_key: wf_key for wf_key in compiled_workflows.keys()}
    )
    
    agent = builder.compile()
else:
    # Fallback to static configuration if Supabase is offline or empty
    print("[agent] WARNING: No compiled workflows found. Falling back to static configuration.")
    
    research_subagent = {
        "name": "research-subagent",
        "description": "Web research specialist.",
        "system_prompt": RESEARCH_SUBAGENT_PROMPT,
        "model": research_model,
        "tools": [
            unified_search,
            unified_extract,
            think_tool,
        ],
    }

    content_subagent = {
        "name": "content-subagent",
        "description": "Content creation specialist.",
        "system_prompt": CONTENT_SUBAGENT_PROMPT,
        "model": content_model,
        "tools": [
            read_skill,
            fetch_images_brave,
            view_candidate_images,
            analyze_images_gemini,
            create_post_image,
            get_design_guide,
            think_tool,
        ],
    }

    fallback_agent = create_deep_agent(
        model=model,
        tools=[
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
            list_skills,
            manage_skill,
            get_wordpress_categories,
            publish_to_wordpress,
            youtube_transcript,
        ],
        subagents=[research_subagent, content_subagent],
        system_prompt=INSTRUCTIONS,
        name="research-agent",
    )
    
    builder.add_node("static_fallback", fallback_agent)
    builder.add_edge("static_fallback", END)
    
    def route_fallback(state, config):
        return "static_fallback"
        
    builder.add_conditional_edges(START, route_fallback, {"static_fallback": "static_fallback"})  # triggered reload for Composio update 2
    agent = builder.compile()

