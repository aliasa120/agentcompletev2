import os
from dotenv import load_dotenv
load_dotenv()

# Also try loading from frontend env
load_dotenv("deep-agents-ui-main/.env.local")

from agent import agent

print("=== COMPILED GRAPH INFO ===")
print("Interrupt before:", getattr(agent, "interrupt_before", None))
print("Interrupt after:", getattr(agent, "interrupt_after", None))
print("Nodes in Pregel:", list(agent.nodes.keys()) if hasattr(agent, "nodes") else "No nodes property")
