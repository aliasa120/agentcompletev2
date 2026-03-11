"""Research Agent - Standalone script for LangGraph deployment.

This module creates a single self-searching research agent that performs both
orchestration (gap analysis, file I/O, synthesis, post writing) and web research
(linkup_search, think_tool) without delegating to any sub-agent.

NOTE: Thread persistence is handled automatically by the LangGraph API platform.
Do NOT add a custom checkpointer here — LangGraph uses POSTGRES_URI from .env.
"""

import os
from datetime import datetime

from langchain_openai import ChatOpenAI
from deepagents import create_deep_agent

from research_agent.prompts import MAIN_AGENT_INSTRUCTIONS
from research_agent.tools import (
    create_post_image_gemini,
    fetch_images_brave,
    linkup_search,
    tavily_extract,
    think_tool,
    view_candidate_images,
    analyze_images_gemini,
)
from research_agent.tools.save_to_supabase import save_posts_to_supabase

# Inject today's date into the unified prompt
INSTRUCTIONS = MAIN_AGENT_INSTRUCTIONS.format(date=datetime.now().strftime("%Y-%m-%d"))

# Model: configured via environment variables
model = ChatOpenAI(
    model="minimax/minimax-m2.5",
    api_key=os.environ.get("OPENAI_API_KEY"),
    base_url=os.environ.get("OPENAI_BASE_URL", "http://47.82.173.134:4000"),
    temperature=0.45,
)

# Create the single agent — no subagents list
# Persistence is handled by LangGraph API via POSTGRES_URI in .env
agent = create_deep_agent(
    model=model,
    tools=[
        linkup_search,
        think_tool,
        tavily_extract,
        fetch_images_brave,
        view_candidate_images,
        analyze_images_gemini,
        create_post_image_gemini,
        save_posts_to_supabase,
    ],
    system_prompt=INSTRUCTIONS,
)
