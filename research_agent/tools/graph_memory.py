import os
import json
import logging
import re
from typing import Dict, Any, List, Optional
from langchain_openai import ChatOpenAI

logger = logging.getLogger(__name__)

_neo4j_driver = None

def get_neo4j_driver():
    """Lazy initialize and return the Neo4j driver connection pool."""
    global _neo4j_driver
    if _neo4j_driver is not None:
        return _neo4j_driver

    # Check if graph memory is enabled
    enabled = os.environ.get("GRAPH_MEMORY_ENABLED", "false").lower() == "true"
    if not enabled:
        return None

    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687").strip()
    username = os.environ.get("NEO4J_USERNAME", "neo4j").strip()
    password = os.environ.get("NEO4J_PASSWORD", "password").strip()

    try:
        from neo4j import GraphDatabase
        _neo4j_driver = GraphDatabase.driver(uri, auth=(username, password))
        logger.info(f"Successfully connected to Neo4j graph database at {uri}")
        return _neo4j_driver
    except Exception as e:
        logger.error(f"Failed to initialize Neo4j driver: {e}")
        return None

def extract_entities_and_relationships(text: str) -> List[Dict[str, Any]]:
    """Extract semantic entities and relationships from turn text using the configured LLM."""
    try:
        from .provider_engine import get_settings
        settings = get_settings()
    except Exception:
        settings = {}

    from .provider_registry import get_provider_api_key, get_provider_base_url
    provider = settings.get("mem0_extraction_provider", "novita")
    model = settings.get("mem0_extraction_model", "deepseek/deepseek-v4-flash")
    api_key = get_provider_api_key(provider)
    base_url = get_provider_base_url(provider)

    if not api_key:
        logger.warning("No LLM API key resolved for graph memory entity extraction.")
        return []

    llm = ChatOpenAI(
        model=model,
        api_key=api_key,
        base_url=base_url,
        temperature=0.0
    )

    prompt = f"""Extract all key entities and their relationships from the given conversation text.
Return the results strictly as a JSON list of objects, where each object has:
- "source": name of the source entity (e.g. "User", "Python", "Dark Mode")
- "source_type": type of the source entity (e.g. "Person", "Language", "Preference")
- "relation": the relationship name (e.g. "PREFERS", "WORKS_WITH", "LOVES")
- "target": name of the target entity
- "target_type": type of the target entity

Example:
User prefers dark mode and uses Python for programming.
JSON:
[
  {{"source": "User", "source_type": "Person", "relation": "PREFERS", "target": "Dark Mode", "target_type": "Preference"}},
  {{"source": "User", "source_type": "Person", "relation": "USES", "target": "Python", "target_type": "Language"}}
]

Respond ONLY with the raw JSON list, no markdown formatting, no backticks, no comments.
Conversation text:
{text}
"""
    try:
        resp = llm.invoke(prompt)
        content = resp.content.strip()
        # Clean markdown formatting if present
        if content.startswith("```"):
            lines = content.split("\n")
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines[-1].startswith("```"):
                lines = lines[:-1]
            content = "\n".join(lines).strip()

        data = json.loads(content)
        if isinstance(data, list):
            return data
        return []
    except Exception as e:
        logger.error(f"Error extracting entities/relationships: {e}")
        return []

def add_graph_memory(text: str, user_id: str, workflow_id: str):
    """Extract entities & relationships and upsert them to Neo4j under user+workflow scope."""
    driver = get_neo4j_driver()
    if driver is None:
        return

    # Fast client-side filter to ignore small greetings and small talk to save API costs
    cleaned = text.strip().lower()
    if len(cleaned) < 12:
        return
    
    greetings = {"hi", "hello", "hey", "howdy", "hola", "sup", "yo", "thanks", "thank you", "ok", "okay", "yes", "no"}
    # Clean prefixes like "user: hi", "assistant: ok"
    for prefix in ["user:", "assistant:"]:
        if cleaned.startswith(prefix):
            cleaned = cleaned[len(prefix):].strip()
    if cleaned in greetings or len(cleaned) < 5:
        return

    triples = extract_entities_and_relationships(text)
    if not triples:
        return

    logger.info(f"Extracted {len(triples)} relationship triples for Neo4j. Merging...")
    
    try:
        with driver.session() as session:
            for t in triples:
                source = t.get("source", "").strip()
                source_type = t.get("source_type", "Concept").strip()
                relation = t.get("relation", "RELATED_TO").strip()
                target = t.get("target", "").strip()
                target_type = t.get("target_type", "Concept").strip()

                if not source or not target or not relation:
                    continue

                # Sanitize relation type for Cypher syntax safety
                relation_sanitized = re.sub(r'[^A-Z0-9_]', '', relation.upper())
                if not relation_sanitized:
                    relation_sanitized = "RELATED_TO"

                # Cypher query to merge nodes and link them
                query = f"""
                MERGE (s:Entity {{name: $source, workflow_id: $workflow_id}})
                SET s.type = $source_type, s.user_id = $user_id, s.updated_at = timestamp()
                MERGE (t:Entity {{name: $target, workflow_id: $workflow_id}})
                SET t.type = $target_type, t.user_id = $user_id, t.updated_at = timestamp()
                WITH s, t
                MERGE (s)-[r:{relation_sanitized}]->(t)
                SET r.user_id = $user_id, r.workflow_id = $workflow_id, r.updated_at = timestamp()
                RETURN r
                """
                session.run(
                    query,
                    source=source,
                    source_type=source_type,
                    target=target,
                    target_type=target_type,
                    user_id=user_id,
                    workflow_id=workflow_id
                )
        logger.info("Successfully merged relationship triples in Neo4j.")
    except Exception as e:
        logger.error(f"Error saving to Neo4j: {e}")

def delete_graph_memories(workflow_id: str, user_id: Optional[str] = None):
    """Delete nodes and edges belonging to a specific workflow (and optionally user)."""
    driver = get_neo4j_driver()
    if driver is None:
        return

    try:
        with driver.session() as session:
            if user_id:
                query = """
                MATCH (n {workflow_id: $workflow_id, user_id: $user_id})
                DETACH DELETE n
                """
                session.run(query, workflow_id=workflow_id, user_id=user_id)
            else:
                query = """
                MATCH (n {workflow_id: $workflow_id})
                DETACH DELETE n
                """
                session.run(query, workflow_id=workflow_id)
        logger.info(f"Successfully cleared Neo4j memory for workflow {workflow_id}")
    except Exception as e:
        logger.error(f"Error deleting Neo4j memory: {e}")
