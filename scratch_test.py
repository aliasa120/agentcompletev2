import os
import logging
from dotenv import load_dotenv
load_dotenv()

# Setup logging to stdout so we can see all warnings/infos
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mcp_loader")

from research_agent.tools.mcp_loader import load_mcp_tools_for_agent

agent_id = "b6fe95ce-5ffb-487f-8493-3d87fe5c1118"
print(f"Loading tools for agent {agent_id}...")
tools = load_mcp_tools_for_agent(agent_id)
print(f"Loaded {len(tools)} tools:")
for t in tools:
    print(f" - {t.name}")
