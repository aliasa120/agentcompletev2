import os
from dotenv import load_dotenv
load_dotenv()
load_dotenv("deep-agents-ui-main/.env.local")

from agent import compiled_workflows

print("=== NESTED WORKFLOW AGENTS INFO ===")
for wf_key, wf_agent in compiled_workflows.items():
    print(f"\nWorkflow key: {wf_key} | Type: {type(wf_agent)}")
    if hasattr(wf_agent, "interrupt_before"):
        print(f"  Interrupt before: {wf_agent.interrupt_before}")
    if hasattr(wf_agent, "interrupt_after"):
        print(f"  Interrupt after: {wf_agent.interrupt_after}")
    if hasattr(wf_agent, "nodes"):
        print(f"  Nodes: {list(wf_agent.nodes.keys())}")
        for n_name, n_val in wf_agent.nodes.items():
            if hasattr(n_val, "get_graph"):
                try:
                    sg = n_val.get_graph()
                    print(f"    Node {n_name} subgraph nodes: {[sn.name for sn in sg.nodes.values()]}")
                except Exception:
                    pass
