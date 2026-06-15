import sys
from agent import agent

print("=== MASTER GRAPH NODES ===")
print(agent.nodes.keys())

for name, node in agent.nodes.items():
    print(f"\nNode: {name} | Type: {type(node)}")
    # If the node is a compiled graph, inspect its structure
    if hasattr(node, 'get_graph'):
        try:
            subgraph = node.get_graph()
            print(f"  Subgraph nodes: {[n.name for n in subgraph.nodes.values()]}")
        except Exception as e:
            print(f"  Could not get subgraph nodes: {e}")
            
    # Check if the node is a Pregel instance (compiled LangGraph)
    if hasattr(node, 'builder'):
        print(f"  Interrupt before: {node.builder.interrupt_before}")
        print(f"  Interrupt after: {node.builder.interrupt_after}")
        
print("\n=== MASTER GRAPH INTERRUPTS ===")
if hasattr(agent, 'builder'):
    print(f"Master Interrupt before: {agent.builder.interrupt_before}")
    print(f"Master Interrupt after: {agent.builder.interrupt_after}")
else:
    # Pregel properties
    print(f"Master config spec: {getattr(agent, 'config_specs', None)}")
