"""Mem0 Memory Agent Tools."""
import os
import logging
from typing import Dict, Any, Optional, List
from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig
from research_agent.tools.mem0_provider import get_mem0_client

logger = logging.getLogger(__name__)

def _get_mem_client():
    client = get_mem0_client()
    if client is None:
        raise ValueError("Mem0 client is not initialized. Ensure memories are enabled in settings and PINECONE_API_KEY is configured.")
    return client

@tool(parse_docstring=True)
def add_memory(
    text: str,
    user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    run_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> str:
    """Save text or conversation history to the long-term memory for a user/agent/run.

    Args:
        text: The text string or conversation content to remember (e.g. 'User likes dark mode and coffee')
        user_id: Optional identifier for the user
        agent_id: Optional identifier for the agent/workflow
        run_id: Optional identifier for the specific run
        metadata: Optional dictionary of key-value metadata to associate with the memory
    """
    try:
        client = _get_mem_client()
        res = client.add(
            text,
            user_id=user_id,
            agent_id=agent_id,
            run_id=run_id,
            metadata=metadata
        )
        return f"Successfully added memory. Result: {res}"
    except Exception as e:
        logger.error(f"Error in add_memory: {e}")
        return f"Error adding memory: {e}"

@tool(parse_docstring=True)
def search_memories(
    query: str,
    config: RunnableConfig,
    limit: int = 10
) -> str:
    """Search for relevant past memories (such as user preferences, past choices, or installed tools) semantically.
    
    This tool should be used when the user asks questions about their identity, preferences, or the current system setup (e.g. 'who am i', 'what are my preferences', 'what tools do I have').

    Args:
        query: The semantic search query (e.g. 'What is the user's favorite drink?')
        config: LangChain runnable configuration (automatically injected).
        limit: Maximum number of memories to return (defaults to 10).
    """
    try:
        client = _get_mem_client()
        configurable = config.get("configurable", {})
        workflow_id = configurable.get("workflow_id")
        user_id = configurable.get("user_id")
        
        # Construct the scope ID matching the agent's scope (strict tenant isolation)
        raw_scope = f"{user_id}_{workflow_id}" if user_id else str(workflow_id)
        scope_id = raw_scope.lower().replace("_", "-")
        
        # Get threshold setting
        from research_agent.tools.provider_engine import get_settings
        settings = get_settings()
        try:
            threshold_val = float(settings.get("mem0_rerank_threshold", "0.50"))
        except ValueError:
            threshold_val = 0.50

        print(f"[mem0_tools] Searching Mem0 memories for query '{query}' in scope {scope_id}...")
        results = client.search(
            query,
            filters={"user_id": scope_id},
            top_k=20, # Fetch broad set for reranking
            threshold=0.1,
            rerank=True
        )
        
        if isinstance(results, dict):
            results = results.get("results", [])
            
        memories = []
        if results:
            for r in results:
                if isinstance(r, dict) and r.get("memory"):
                    msg_text = r.get("memory")
                    score = r.get("rerank_score") if r.get("rerank_score") is not None else r.get("score", 1.0)
                    if score < threshold_val:
                        continue
                    memories.append(msg_text)
                    
        if memories:
            memories = memories[:limit]
            formatted_memories = "\n".join(f"- {m}" for m in memories)
            return f"Found relevant memories:\n{formatted_memories}"
        else:
            return "No relevant memories found."
    except Exception as e:
        logger.error(f"Error in search_memories: {e}")
        return f"Error searching memories: {e}"

@tool(parse_docstring=True)
def get_memories(
    user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    run_id: Optional[str] = None,
    limit: int = 20
) -> str:
    """List and retrieve memories with structured filters and limit.

    Args:
        user_id: Optional user identifier to list memories for
        agent_id: Optional agent/workflow identifier to list memories for
        run_id: Optional run identifier to list memories for
        limit: Maximum number of memories to return (defaults to 20)
    """
    try:
        client = _get_mem_client()
        filters = {}
        if user_id:
            filters["user_id"] = user_id
        if agent_id:
            filters["agent_id"] = agent_id
        if run_id:
            filters["run_id"] = run_id

        res = client.get_all(filters=filters if filters else None, top_k=limit)
        return f"Retrieved memories: {res}"
    except Exception as e:
        logger.error(f"Error in get_memories: {e}")
        return f"Error retrieving memories: {e}"

@tool(parse_docstring=True)
def get_memory(memory_id: str) -> str:
    """Retrieve details of a single memory by its unique memory ID.

    Args:
        memory_id: The unique UUID of the memory to fetch
    """
    try:
        client = _get_mem_client()
        res = client.get(memory_id)
        return f"Memory detail: {res}"
    except Exception as e:
        logger.error(f"Error in get_memory: {e}")
        return f"Error fetching memory {memory_id}: {e}"

@tool(parse_docstring=True)
def update_memory(
    memory_id: str,
    text: str,
    metadata: Optional[Dict[str, Any]] = None
) -> str:
    """Overwrite an existing memory's text and metadata.

    Args:
        memory_id: The unique UUID of the memory to update
        text: The new text content of the memory
        metadata: Optional new key-value metadata dictionary
    """
    try:
        client = _get_mem_client()
        res = client.update(memory_id, text, metadata=metadata)
        return f"Successfully updated memory {memory_id}. Result: {res}"
    except Exception as e:
        logger.error(f"Error in update_memory: {e}")
        return f"Error updating memory {memory_id}: {e}"

@tool(parse_docstring=True)
def delete_memory(memory_id: str) -> str:
    """Delete a single memory by its unique memory ID.

    Args:
        memory_id: The unique UUID of the memory to delete
    """
    try:
        client = _get_mem_client()
        client.delete(memory_id)
        return f"Successfully deleted memory {memory_id}."
    except Exception as e:
        logger.error(f"Error in delete_memory: {e}")
        return f"Error deleting memory {memory_id}: {e}"

@tool(parse_docstring=True)
def delete_all_memories(
    user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    run_id: Optional[str] = None
) -> str:
    """Bulk delete all memories matching the specified user, agent, or run filters.

    Args:
        user_id: Optional user identifier to delete all memories for
        agent_id: Optional agent/workflow identifier to delete all memories for
        run_id: Optional run identifier to delete all memories for
    """
    try:
        client = _get_mem_client()
        client.delete_all(user_id=user_id, agent_id=agent_id, run_id=run_id)
        return f"Successfully deleted all memories in scope (user_id={user_id}, agent_id={agent_id}, run_id={run_id})."
    except Exception as e:
        logger.error(f"Error in delete_all_memories: {e}")
        return f"Error deleting memories: {e}"

@tool(parse_docstring=True)
def delete_entities(entity_type: str, entity_id: str) -> str:
    """Delete all memories associated with a specific entity (user, agent, or run).

    Args:
        entity_type: The type of entity to delete. Allowed values: 'user', 'agent', 'run'
        entity_id: The unique ID of the entity to delete
    """
    type_lower = entity_type.strip().lower()
    if type_lower not in ["user", "agent", "run"]:
        return f"Error: Invalid entity_type '{entity_type}'. Must be 'user', 'agent', or 'run'."
    
    try:
        client = _get_mem_client()
        if type_lower == "user":
            client.delete_all(user_id=entity_id)
        elif type_lower == "agent":
            client.delete_all(agent_id=entity_id)
        elif type_lower == "run":
            client.delete_all(run_id=entity_id)
        return f"Successfully deleted entity {entity_id} and all its associated memories."
    except Exception as e:
        logger.error(f"Error in delete_entities: {e}")
        return f"Error deleting entity: {e}"

@tool(parse_docstring=True)
def list_entities(limit: int = 100) -> str:
    """Enumerate unique user, agent, and run entities stored in the long-term memory.

    Args:
        limit: Max number of memories to scan for unique entities (defaults to 100)
    """
    try:
        client = _get_mem_client()
        memories = client.get_all(top_k=limit)
        
        users = set()
        agents = set()
        runs = set()
        
        # Check standard results formatting or unwrap if needed
        mem_list = memories
        if isinstance(memories, dict) and "results" in memories:
            mem_list = memories["results"]
            
        for m in mem_list:
            if not isinstance(m, dict):
                continue
            # Check user_id, agent_id, run_id from either top-level or metadata
            uid = m.get("user_id") or m.get("metadata", {}).get("user_id")
            aid = m.get("agent_id") or m.get("metadata", {}).get("agent_id")
            rid = m.get("run_id") or m.get("metadata", {}).get("run_id")
            if uid: users.add(uid)
            if aid: agents.add(aid)
            if rid: runs.add(rid)
            
        result = {
            "users": list(users),
            "agents": list(agents),
            "runs": list(runs)
        }
        return f"Entities stored in memory: {result}"
    except Exception as e:
        logger.error(f"Error in list_entities: {e}")
        return f"Error listing entities: {e}"

@tool(parse_docstring=True)
def list_events(memory_id: Optional[str] = None) -> str:
    """List history of memory modifications and operations events.

    Args:
        memory_id: Optional memory UUID to fetch events history for
    """
    try:
        client = _get_mem_client()
        if memory_id:
            res = client.history(memory_id)
            return f"Events history for memory {memory_id}: {res}"
        else:
            # Enumerate memories and fetch history for each
            memories = client.get_all(top_k=20)
            mem_list = memories
            if isinstance(memories, dict) and "results" in memories:
                mem_list = memories["results"]
            
            history_summary = {}
            for m in mem_list:
                if not isinstance(m, dict):
                    continue
                mid = m.get("id")
                if mid:
                    try:
                        history_summary[mid] = client.history(mid)
                    except Exception:
                        pass
            return f"Modification history for recent memories: {history_summary}"
    except Exception as e:
        logger.error(f"Error in list_events: {e}")
        return f"Error listing events: {e}"

@tool(parse_docstring=True)
def get_event_status(event_id: str) -> str:
    """Check the status of an asynchronous memory operation by its event ID.

    Args:
        event_id: The unique ID of the event to check
    """
    # Since we are using Mem0 Open Source version (all database/vector operations are synchronous),
    # any invoked event is guaranteed to be completed instantly.
    return f"Event {event_id} status: COMPLETED (Synchronous execution successful)"

# Helper mapping tool names to actual tool objects
MEM0_TOOLS_MAP = {
    "add_memory": add_memory,
    "search_memories": search_memories,
    "get_memories": get_memories,
    "get_memory": get_memory,
    "update_memory": update_memory,
    "delete_memory": delete_memory,
    "delete_all_memories": delete_all_memories,
    "delete_entities": delete_entities,
    "list_entities": list_entities,
    "list_events": list_events,
    "get_event_status": get_event_status
}

def get_memory_tool_by_name(name: str):
    return MEM0_TOOLS_MAP.get(name)
