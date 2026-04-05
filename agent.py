"""Research Agent - Standalone script for LangGraph deployment.

This module creates a single self-researching agent with a unified tool set.
Provider selection (Linkup vs Parallel AI, Tavily vs Exa, KIE vs Gemini Flash)
is managed automatically by the unified tools based on settings in Supabase.

NOTE: Thread persistence is handled automatically by the LangGraph API platform.
Do NOT add a custom checkpointer here — LangGraph uses POSTGRES_URI from .env.
"""

import os
import time
import asyncio
import random
from datetime import datetime

from langchain_openai import ChatOpenAI
from deepagents import create_deep_agent

from research_agent.prompts import MAIN_AGENT_INSTRUCTIONS
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

# Inject today's date into the unified prompt
INSTRUCTIONS = MAIN_AGENT_INSTRUCTIONS.format(date=datetime.now().strftime("%Y-%m-%d"))

# Configure Resilience for LLM API calls
_LLM_MAX_ATTEMPTS = 6          # total attempts before giving up
_LLM_RATE_LIMIT_DELAY = 65.0  # flat wait (s) after a 429 — long enough for NVIDIA NIM to reset
_LLM_BASE_DELAY = 5.0          # base delay for other errors (exponential from here)

class ResilientChatModel(ChatOpenAI):
    """Wraps ChatOpenAI with rate-limit-aware retries tuned for NVIDIA NIM.
    
    Retry strategy:
    - 429 Rate Limit  → flat 65 s wait, then retry (up to max attempts)
    - Other errors    → exponential backoff: 5 s, 10 s, 20 s, 40 s, 60 s
    - 401/403/bad key → fatal, raise immediately (no retry)
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
        """Detect NVIDIA NIM / LiteLLM 429 rate-limit errors."""
        msg = str(e).lower()
        return "429" in msg or "rate limit" in msg or "too many requests" in msg or "rate_limit" in msg

    def _get_backoff_delay(self, attempt: int) -> float:
        """Exponential backoff with jitter for non-rate-limit errors."""
        base_delay = _LLM_BASE_DELAY * (2 ** (attempt - 1))
        jitter = random.uniform(0.0, 0.2 * base_delay)  # 0-20% jitter
        return min(base_delay + jitter, 60.0)

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
                          f"Waiting {_LLM_RATE_LIMIT_DELAY:.0f}s for NVIDIA NIM reset...")
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
                          f"Waiting {_LLM_RATE_LIMIT_DELAY:.0f}s for NVIDIA NIM reset...")
                    time.sleep(_LLM_RATE_LIMIT_DELAY)
                else:
                    delay = self._get_backoff_delay(attempt)
                    print(f"[LLM] ⚠️  Attempt {attempt}/{_LLM_MAX_ATTEMPTS} failed: {e}. "
                          f"Retrying in {delay:.1f}s...")
                    time.sleep(delay)

# Model: configured via environment variables
model = ResilientChatModel(
    model="qwen/qwen3.5-122b-a10b",
    api_key=os.environ.get("OPENAI_API_KEY"),
    base_url=os.environ.get("OPENAI_BASE_URL", "http://47.82.173.134:4000"),
    temperature=0.45,
)

# Create the single agent
agent = create_deep_agent(
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
        get_wordpress_categories,
        publish_to_wordpress,
    ],
    system_prompt=INSTRUCTIONS,
)
