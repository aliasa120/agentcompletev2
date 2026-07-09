"""search_conversation_history — Tool to search past conversation history using full-text search.
"""

import os
import logging
from typing import Optional
from langchain_core.tools import tool

logger = logging.getLogger("search_conversation_history")


def _get_supabase_client():
    """Lazy-init a Supabase client."""
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_ANON_KEY must be set")
    return create_client(url, key)


@tool(parse_docstring=True)
def search_conversation_history(query: str) -> str:
    """Search through all past conversation history messages using full-text search.

    Use this tool when you need to recall details, context, facts, or decisions
    from previous messages, sessions, or threads.

    Args:
        query: The search query, keywords, or phrases to look for.
    """
    try:
        client = _get_supabase_client()
        
        # Perform text search on content column
        resp = client.table("messages") \
            .select("session_id, role, content, created_at") \
            .limit(20) \
            .text_search("content", query, options={"config": "english", "type": "plain"}) \
            .execute()
            
        data = resp.data or []
        if not data:
            return f"No messages matching '{query}' were found in the conversation history."
            
        lines = [f"🔍 Search results for '{query}' ({len(data)} matches):"]
        for idx, row in enumerate(data, 1):
            sess_id = row.get("session_id")
            role = row.get("role", "unknown").upper()
            content = row.get("content", "").strip()
            created_at = row.get("created_at") or "unknown"
            
            # Truncate content to keep prompt size reasonable
            if len(content) > 500:
                content_preview = content[:500] + "... (truncated)"
            else:
                content_preview = content
                
            lines.append(
                f"--- Result #{idx} ---\n"
                f"Session ID: {sess_id}\n"
                f"Role: {role}\n"
                f"Date: {created_at}\n"
                f"Content:\n{content_preview}\n"
            )
            
        return "\n".join(lines)
        
    except Exception as e:
        return f"❌ Error searching conversation history: {e}"
