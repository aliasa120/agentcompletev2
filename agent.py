"""Research Agent - Standalone script for LangGraph deployment.

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
    # ── Support tools ────────────────────────────────────────────────────────
    think_tool,
    fetch_images_brave,
    view_candidate_images,
    analyze_images_gemini,
    save_posts_to_supabase,
    get_design_guide,
    read_skill,
    get_wordpress_categories,
    publish_to_wordpress,
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

# ── Subagent Definitions ──────────────────────────────────────────────────────
# research-subagent: handles web search + extraction (Step 4)
# content-subagent:  handles blog + social posts + image pipeline (Steps 6-7g)
# Main agent: planning, synthesis, WordPress, DB save — and evaluates subagent output.

research_subagent = {
    "name": "research-subagent",
    "description": (
        "Web research specialist. Use this subagent to search the web and extract article content "
        "for a list of specific research targets. Pass the news title, snippet, and numbered "
        "research targets. It returns a structured Research Report with facts, quotes, and source URLs."
    ),
    "system_prompt": RESEARCH_SUBAGENT_PROMPT,
    "model": research_model,
    # Focused toolset — only what research needs
    "tools": [
        unified_search,
        unified_extract,
        think_tool,
    ],
}

content_subagent = {
    "name": "content-subagent",
    "description": (
        "Content creation specialist. Use this subagent to write the blog post, X/Twitter, "
        "Instagram, and Facebook posts, then run the full image pipeline (fetch, select, analyze, "
        "generate social image). Pass the news title, synthesised research facts, hook, and best "
        "image search query. It reads /news_input.md and /research_synthesis.md from the filesystem "
        "and returns a summary of files written plus image paths."
    ),
    "system_prompt": CONTENT_SUBAGENT_PROMPT,
    "model": content_model,
    # Focused toolset — writing + image pipeline only (no search/WordPress/DB)
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

# ── Create the Agent ────────────────────────────────────────────────────────
agent = create_deep_agent(
    model=model,
    tools=[
        # Main agent keeps all tools for verification, WordPress, and DB save
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
    ],
    subagents=[research_subagent, content_subagent],
    system_prompt=INSTRUCTIONS,
    # No middleware=[...] — deepagents default harness handles:
    #   - SummarizationMiddleware (auto context management)
    #   - FilesystemMiddleware (virtual filesystem for tool output offloading)
    #   - SubAgentMiddleware (general-purpose task subagent + our 2 custom ones)
    name="research-agent",
)
