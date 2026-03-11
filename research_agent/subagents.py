"""Research Subagents.

This module provides definitions for subagents used by the main orchestrator agent.
"""

from datetime import datetime

from research_agent.prompts import RESEARCHER_INSTRUCTIONS
from research_agent.tools import linkup_search, think_tool

# Get current date
current_date = datetime.now().strftime("%Y-%m-%d")

# Create research sub-agent
research_sub_agent = {
    "name": "research-agent",
    "description": "Delegate ALL research targets to this sub-agent in a single call. Provide numbered list of 3-6 targets. Sub-agent will research all targets sequentially using up to 3 searches total and return findings for each target.",
    "system_prompt": RESEARCHER_INSTRUCTIONS.format(date=current_date),
    "tools": [linkup_search, think_tool],
}
