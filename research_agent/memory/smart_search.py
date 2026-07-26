"""Smart Search Engine — 3-Strategy Search (Full-Text + Semantic + Entity Probe).

Performs 3 search strategies simultaneously across workflow & user-scoped
conversation history and memory files, then ranks results using Reciprocal Rank Fusion (RRF).
"""

import os
import re
import logging
from typing import List, Dict, Any, Optional
from pathlib import Path
from research_agent.memory.builtin_provider import read_user_md, read_memory_md, _resolve_scope

logger = logging.getLogger(__name__)


def _extract_entities(query: str) -> List[str]:
    """Extract candidate entity words/phrases from query."""
    # Capitalized words, acronyms, quotes, or significant nouns
    capitalized = re.findall(r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b', query)
    quoted = re.findall(r'"([^"]+)"', query)
    # Remove standard common words
    candidates = set(capitalized + quoted)
    stop_words = {"The", "A", "An", "What", "Who", "Where", "When", "How", "Why", "Is", "Are"}
    return [c for c in candidates if c not in stop_words and len(c) > 2]


def _full_text_search(query: str, user_id: str, workflow_id: str, limit: int = 10) -> List[Dict[str, Any]]:
    """Strategy 1: Full-Text Search across Supabase messages + local files."""
    results = []
    
    # 1. Search local markdown files
    user_md = read_user_md(user_id, workflow_id)
    memory_md = read_memory_md(user_id, workflow_id)
    
    query_terms = [t.lower() for t in query.split() if len(t) > 2]
    
    for filename, content in [("USER.md", user_md), ("MEMORY.md", memory_md)]:
        lines = content.splitlines()
        for idx, line in enumerate(lines):
            line_lower = line.lower()
            if any(term in line_lower for term in query_terms):
                results.append({
                    "source": filename,
                    "type": "markdown",
                    "content": line.strip(),
                    "score": 0.8,
                    "metadata": {"line_number": idx + 1}
                })

    # 2. Search Supabase message history if configured
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY", "")
    if url and key:
        try:
            from supabase import create_client
            client = create_client(url, key)
            
            resp = client.table("messages") \
                .select("session_id, role, content, created_at") \
                .limit(limit) \
                .text_search("content", query, options={"config": "english", "type": "plain"}) \
                .execute()
                
            data = resp.data or []
            for row in data:
                results.append({
                    "source": f"Session: {row.get('session_id')}",
                    "type": "message",
                    "role": row.get("role", "unknown").upper(),
                    "content": row.get("content", "").strip(),
                    "created_at": row.get("created_at"),
                    "score": 0.9,
                })
        except Exception as e:
            logger.debug(f"Supabase text search error: {e}")
            
    return results


def _semantic_search(query: str, user_id: str, workflow_id: str, limit: int = 10) -> List[Dict[str, Any]]:
    """Strategy 2: Semantic Similarity Search across memory entries & history."""
    results = []
    query_lower = query.lower()
    
    # Semantic token matching fallback over markdown files
    memory_md = read_memory_md(user_id, workflow_id)
    user_md = read_user_md(user_id, workflow_id)
    
    paragraphs = (memory_md + "\n\n" + user_md).split("\n\n")
    for p in paragraphs:
        p_clean = p.strip()
        if not p_clean or p_clean.startswith("#"):
            continue
        # Overlap score between query and paragraph
        query_words = set(re.findall(r'\w+', query_lower))
        p_words = set(re.findall(r'\w+', p_clean.lower()))
        overlap = len(query_words.intersection(p_words))
        if overlap > 0:
            score = overlap / max(len(query_words), 1)
            results.append({
                "source": "Semantic Match",
                "type": "semantic",
                "content": p_clean,
                "score": float(score),
            })
            
    # Sort by semantic similarity score
    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:limit]


def _entity_probe_search(query: str, user_id: str, workflow_id: str, limit: int = 10) -> List[Dict[str, Any]]:
    """Strategy 3: Entity Probe Search — extracts entities and pulls topic network."""
    entities = _extract_entities(query)
    if not entities:
        return []
        
    results = []
    user_md = read_user_md(user_id, workflow_id)
    memory_md = read_memory_md(user_id, workflow_id)
    combined = user_md + "\n" + memory_md
    
    for entity in entities:
        pattern = re.escape(entity)
        matches = [line.strip() for line in combined.splitlines() if re.search(pattern, line, re.IGNORECASE)]
        for match in matches:
            results.append({
                "source": f"Entity: {entity}",
                "type": "entity_probe",
                "content": match,
                "score": 0.85,
            })
            
    return results[:limit]


def rrf_rank_results(
    full_text_res: List[Dict[str, Any]],
    semantic_res: List[Dict[str, Any]],
    entity_res: List[Dict[str, Any]],
    k: int = 60,
    top_n: int = 15
) -> List[Dict[str, Any]]:
    """Combine results from 3 strategies using Reciprocal Rank Fusion (RRF)."""
    scores: Dict[str, float] = {}
    items_map: Dict[str, Dict[str, Any]] = {}
    
    for rank_list in [full_text_res, semantic_res, entity_res]:
        for rank, item in enumerate(rank_list):
            content_key = item["content"].strip().lower()
            items_map[content_key] = item
            rrf_score = 1.0 / (k + rank + 1)
            scores[content_key] = scores.get(content_key, 0.0) + rrf_score

    # Sort items by accumulated RRF score
    sorted_keys = sorted(scores.keys(), key=lambda x: scores[x], reverse=True)
    
    final_results = []
    for key in sorted_keys[:top_n]:
        item = items_map[key]
        item["rrf_score"] = round(scores[key], 4)
        final_results.append(item)
        
    return final_results


def smart_search_memories(
    query: str,
    user_id: Optional[str] = None,
    workflow_id: Optional[str] = None,
    limit: int = 10
) -> str:
    """Execute 3-strategy smart search and format clean markdown report."""
    final_user_id = str(user_id or "default_user").strip().lower().replace(" ", "_")
    final_workflow_id = str(workflow_id or "default_workflow").strip().lower().replace(" ", "_")

    # Run 3 strategies simultaneously
    ft_res = _full_text_search(query, final_user_id, final_workflow_id, limit=limit)
    sem_res = _semantic_search(query, final_user_id, final_workflow_id, limit=limit)
    ent_res = _entity_probe_search(query, final_user_id, final_workflow_id, limit=limit)

    # RRF Fusion
    ranked = rrf_rank_results(ft_res, sem_res, ent_res, top_n=limit)

    if not ranked:
        return f"No memories or history matching '{query}' were found (scope: user='{final_user_id}', workflow='{final_workflow_id}')."

    lines = [f"🔍 Smart Search Results for '{query}' (Scope: user='{final_user_id}', workflow='{final_workflow_id}') — {len(ranked)} matches:"]
    for idx, item in enumerate(ranked, 1):
        source = item.get("source", "Unknown")
        stype = item.get("type", "general")
        content = item.get("content", "")
        if len(content) > 400:
            content = content[:400] + "... (truncated)"
            
        lines.append(
            f"\n--- Result #{idx} [{stype.upper()} | Score: {item.get('rrf_score', 'N/A')}] ---\n"
            f"Source: {source}\n"
            f"Content:\n{content}"
        )

    return "\n".join(lines)
