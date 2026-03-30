"""Research Agent - Standalone script for LangGraph deployment.

This module creates a single self-researching agent with a unified tool set.
Provider selection (Linkup vs Parallel AI, Tavily vs Exa, KIE vs Gemini Flash)
is managed automatically by the unified tools based on settings in Supabase.

NOTE: Thread persistence is handled automatically by the LangGraph API platform.
Do NOT add a custom checkpointer here — LangGraph uses POSTGRES_URI from .env.
"""

import os
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

# Model: configured via environment variables
model = ChatOpenAI(
    model="MiniMax-M2.7",
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
