"""Honcho Memory Provider Integration — Adapted from Hermes Agent.

Provides cross-session user modeling via Honcho REST API / SDK, including:
- Peer cards (IDENTITY, ATTRIBUTE, RELATIONSHIP, INSTRUCTION)
- Hybrid search over message history
- Dialectic reasoning agent
- Memory context prefetching for system prompts
"""

import os
import json
import logging
import urllib.request
import urllib.error
from typing import Dict, Any, List, Optional, Annotated
from langchain_core.tools import tool, InjectedToolArg
from langchain_core.runnables import RunnableConfig

logger = logging.getLogger(__name__)


def resolve_user_id_from_context(peer: str = "user", config: Optional[Any] = None) -> Optional[str]:
    """Helper to resolve user_id from RunnableConfig, ContextVars, or Peer name."""
    user_id = None
    
    # 1. Try from config dict or object
    if config:
        if isinstance(config, dict):
            cfg = config.get("configurable", {})
            metadata = config.get("metadata", {})
            user_id = cfg.get("user_id") or metadata.get("user_id")
        elif hasattr(config, "configurable"):
            cfg = getattr(config, "configurable", {})
            metadata = getattr(config, "metadata", {})
            if isinstance(cfg, dict):
                user_id = cfg.get("user_id")
            if not user_id and isinstance(metadata, dict):
                user_id = metadata.get("user_id")

    # 2. Try from thread-local ContextVars or last active user
    if not user_id:
        try:
            from research_agent.tools.provider_engine import get_active_user_id, _LAST_ACTIVE_USER_ID
            user_id = get_active_user_id() or _LAST_ACTIVE_USER_ID
        except Exception:
            pass

    # 3. Try parsing from user peer name (e.g. user_c017bdb6_5708_4a8e_ba7d_ebf476485c61)
    if not user_id and peer and peer.startswith("user_"):
        raw_uid = peer[5:]
        parts = raw_uid.split("_")
        if len(parts) == 5:
            user_id = "-".join(parts)

    return user_id


def get_honcho_config(user_id: Optional[str] = None) -> Dict[str, str]:
    """Resolve Honcho URL, workspace, and API key from environment or user agent_settings."""
    url = os.environ.get("HONCHO_API_URL", "").strip()
    workspace = os.environ.get("HONCHO_WORKSPACE", "").strip()
    api_key = os.environ.get("HONCHO_API_KEY", "").strip()

    if not url or not api_key:
        try:
            from research_agent.tools.provider_engine import get_settings
            db_settings = get_settings(user_id)
            if not url and db_settings.get("honcho_api_url"):
                url = str(db_settings["honcho_api_url"]).strip()
            if not workspace and db_settings.get("honcho_workspace"):
                workspace = str(db_settings["honcho_workspace"]).strip()
            if not api_key and db_settings.get("honcho_api_key"):
                api_key = str(db_settings["honcho_api_key"]).strip()
        except Exception:
            pass

    final_url = (url or "https://api.honcho.dev").rstrip("/")
    final_workspace = workspace or "default_workspace"
    return {"base_url": final_url, "workspace": final_workspace, "api_key": api_key}


def is_honcho_configured(user_id: Optional[str] = None) -> bool:
    """Return True if Honcho API key is configured."""
    if not user_id:
        user_id = resolve_user_id_from_context()
    cfg = get_honcho_config(user_id)
    return bool(cfg["api_key"])


def _honcho_request(
    endpoint: str,
    method: str = "GET",
    payload: Optional[Dict[str, Any]] = None,
    auto_init_workspace: bool = True,
    user_id: Optional[str] = None
) -> Dict[str, Any]:
    """Execute REST API call to Honcho backend server (v3 API)."""
    if not user_id:
        user_id = resolve_user_id_from_context()
        
    cfg = get_honcho_config(user_id)
    clean_endpoint = endpoint.lstrip("/")
    if not clean_endpoint.startswith("v3/"):
        clean_endpoint = f"v3/{clean_endpoint}"

    url = f"{cfg['base_url']}/{clean_endpoint}"
    headers = {"Content-Type": "application/json"}
    if cfg["api_key"]:
        headers["Authorization"] = f"Bearer {cfg['api_key']}"

    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    def _do_http_call():
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            if e.code == 404 and auto_init_workspace and "workspaces/" in clean_endpoint:
                # Auto-create workspace if not yet created on Honcho server
                try:
                    ws_url = f"{cfg['base_url']}/v3/workspaces"
                    ws_payload = json.dumps({"name": cfg["workspace"]}).encode("utf-8")
                    ws_req = urllib.request.Request(ws_url, data=ws_payload, headers=headers, method="POST")
                    with urllib.request.urlopen(ws_req, timeout=10):
                        pass
                    # Retry original request after creating workspace
                    return _honcho_request(endpoint, method=method, payload=payload, auto_init_workspace=False, user_id=user_id)
                except Exception as init_err:
                    logger.warning(f"Honcho workspace auto-init error: {init_err}")
            logger.warning(f"Honcho HTTP error {e.code}: {e.reason}")
            return {"error": f"HTTP {e.code}: {e.reason}"}
        except Exception as e:
            logger.warning(f"Honcho connection error: {e}")
            return {"error": str(e)}

    # Offload from asyncio event loop to avoid blocking warning
    import asyncio
    import concurrent.futures
    try:
        loop = asyncio.get_running_loop()
        if loop.is_running():
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
                return ex.submit(_do_http_call).result()
    except RuntimeError:
        pass

    return _do_http_call()


def prefetch_honcho_context(
    peer_name: str = "user",
    query: str = "",
    user_id: Optional[str] = None,
    thread_id: Optional[str] = None,
) -> str:
    """Auto-prefetching disabled — returns empty string. Context is managed via USER.md/MEMORY.md and manual Honcho tools."""
    return ""



# ── Peer ID resolution helper ───────────────────────────────────────────────

def _resolve_peer_id(peer: str, user_id: Optional[str]) -> str:
    """Resolve the actual Honcho peer name from peer hint + user_id.

    When the agent calls honcho_* with peer='user' (the default), it means
    'this session's user'. The real Honcho peer name is user_{user_id_clean},
    matching exactly what honcho_sync.py uses when writing turns.
    """
    if user_id and peer in ("user", "", None):
        clean_uid = str(user_id).strip().lower().replace("-", "_").replace(" ", "_")
        return f"user_{clean_uid}"
    return peer or "user"


# ── LangChain Honcho Tools ────────────────────────────────────────────────

@tool(parse_docstring=True)
def honcho_profile(
    peer: str = "user",
    card: Optional[List[str]] = None,
    config: Annotated[Optional[RunnableConfig], InjectedToolArg] = None
) -> str:
    """Read or write a peer's CARD — a short list of standing identity markers (IDENTITY, ATTRIBUTE, RELATIONSHIP, INSTRUCTION).

    Args:
        peer: Target peer name (defaults to 'user').
        card: Optional list of new fact strings to overwrite the card. Omit to read current card.
        config: LangChain runnable configuration (automatically injected).
    """
    user_id = resolve_user_id_from_context(peer, config)
    resolved_peer = _resolve_peer_id(peer, user_id)
    cfg = get_honcho_config(user_id)
    if card is not None:
        # Write card
        res = _honcho_request(
            f"workspaces/{cfg['workspace']}/peers/{resolved_peer}/card",
            method="PUT",
            payload={"peer_card": card},
            user_id=user_id
        )
        return f"Successfully updated Honcho Peer Card for '{resolved_peer}': {res}"
    else:
        # Read card
        res = _honcho_request(f"workspaces/{cfg['workspace']}/peers/{resolved_peer}/card", user_id=user_id)
        if isinstance(res, dict) and "error" in res:
            return f"Honcho Peer Card read error: {res['error']}"
        if isinstance(res, list):
            facts = res
        elif isinstance(res, dict):
            facts = res.get("peer_card", []) or res.get("card", [])
        else:
            facts = []
        if not facts:
            return f"Peer Card for '{resolved_peer}' is empty or still accumulating."
        return f"Honcho Peer Card for '{resolved_peer}':\n" + "\n".join(f"- {f}" for f in facts)


@tool(parse_docstring=True)
def honcho_search(
    query: str,
    peer: str = "all",
    max_tokens: int = 800,
    config: Annotated[Optional[RunnableConfig], InjectedToolArg] = None
) -> str:
    """Hybrid (semantic + keyword) search over all message history across all past sessions in the workspace.

    Args:
        query: What to look for — a topic, keyword, or natural language query.
        peer: Optional peer name filter (defaults to 'all' for global workspace search across all participants).
        max_tokens: Token budget for returned excerpts (default 800).
    """
    user_id = resolve_user_id_from_context(peer, config)
    cfg = get_honcho_config(user_id)
    payload: Dict[str, Any] = {"query": query, "max_tokens": max_tokens}
    
    # Only filter by peer if a specific non-default peer filter is requested
    if peer and peer.lower() not in ("all", "user", ""):
        resolved_peer = _resolve_peer_id(peer, user_id)
        payload["peer"] = resolved_peer

    res = _honcho_request(
        f"workspaces/{cfg['workspace']}/search",
        method="POST",
        payload=payload,
        user_id=user_id
    )
    if isinstance(res, dict) and "error" in res:
        return f"Honcho search error: {res['error']}"
    
    if isinstance(res, list):
        results = res
    elif isinstance(res, dict):
        results = res.get("results", []) or res.get("data", []) or []
    else:
        results = []

    if not results:
        return f"No Honcho message history matched query '{query}' in workspace '{cfg['workspace']}'."
    
    lines = [f"Honcho Global Search Results for '{query}':"]
    for idx, item in enumerate(results, 1):
        if isinstance(item, dict):
            peer_id = item.get("peer_id", "unknown")
            content = item.get("content") or item.get("text") or item.get("representation") or str(item)
            lines.append(f"--- Excerpt #{idx} (speaker={peer_id}) ---\n{content}\n")
        else:
            lines.append(f"--- Excerpt #{idx} ---\n{str(item)}\n")
        
    return "\n".join(lines)


@tool(parse_docstring=True)
def honcho_reasoning(
    query: str,
    reasoning_level: str = "low",
    peer: str = "user",
    config: Annotated[Optional[RunnableConfig], InjectedToolArg] = None
) -> str:
    """Ask Honcho's Dialectic Agent a question about a peer to get back a synthesized, reasoned answer.

    Args:
        query: A natural language question about the peer.
        reasoning_level: Depth of reasoning ('minimal', 'low', 'medium', 'high', 'max'). Defaults to 'low'.
        peer: Target peer name (defaults to 'user').
    """
    user_id = resolve_user_id_from_context(peer, config)
    resolved_peer = _resolve_peer_id(peer, user_id)
    cfg = get_honcho_config(user_id)
    if not cfg["api_key"]:
        return "Honcho not configured — set HONCHO_API_KEY."
    try:
        from honcho import Honcho as _HonchoSDK
        sdk_kwargs: dict = {"workspace_id": cfg["workspace"], "api_key": cfg["api_key"]}
        if cfg["base_url"] and cfg["base_url"] not in ("", "https://api.honcho.dev"):
            sdk_kwargs["base_url"] = cfg["base_url"]
        h = _HonchoSDK(**sdk_kwargs)
        user_peer = h.peer(resolved_peer)
        # Pass user_peer (Peer object instance) as target so Honcho queries the peer's specific memory
        answer = user_peer.chat(query, target=user_peer, reasoning_level=reasoning_level)
        return f"Honcho Dialectic Synthesis for '{resolved_peer}' (level='{reasoning_level}'):\n\n{answer}"
    except Exception as e:
        return f"Honcho reasoning error: {e}"


@tool(parse_docstring=True)
def honcho_context(
    peer: str = "user",
    tokens: int = 2000,
    search_query: Optional[str] = None,
    search_top_k: Optional[int] = None,
    search_max_distance: Optional[float] = None,
    config: Annotated[Optional[RunnableConfig], InjectedToolArg] = None
) -> str:
    """Retrieve Honcho's standing context for the current session — peer representation, conclusions, and recent turns.

    Args:
        peer: Target peer name (defaults to 'user').
        tokens: Max tokens to include in context (default 2000).
        search_query: Optional search query string to fetch semantically relevant conclusions.
        search_top_k: Optional top K number of semantically relevant conclusions to return (1-100).
        search_max_distance: Optional semantic threshold / max distance (0.0 to 1.0) for search results.
    """
    user_id = resolve_user_id_from_context(peer, config)
    resolved_peer = _resolve_peer_id(peer, user_id)
    cfg = get_honcho_config(user_id)
    if not cfg["api_key"]:
        return "Honcho not configured — set HONCHO_API_KEY."
    # Get thread_id from config to scope context to the current session
    thread_id = None
    if config:
        if isinstance(config, dict):
            thread_id = config.get("configurable", {}).get("thread_id")
        elif hasattr(config, "configurable"):
            thread_id = getattr(config.configurable, "thread_id", None)
    try:
        from honcho import Honcho as _HonchoSDK
        sdk_kwargs: dict = {"workspace_id": cfg["workspace"], "api_key": cfg["api_key"]}
        if cfg["base_url"] and cfg["base_url"] not in ("", "https://api.honcho.dev"):
            sdk_kwargs["base_url"] = cfg["base_url"]
        h = _HonchoSDK(**sdk_kwargs)
        # session.context(peer_target=peer) is the correct SDK path per Honcho docs
        session_id = thread_id or f"default_session_{resolved_peer}"
        session = h.session(session_id)

        ctx_kwargs: dict = {"peer_target": resolved_peer}
        if tokens:
            ctx_kwargs["tokens"] = tokens
        if search_query:
            ctx_kwargs["search_query"] = search_query
        if search_top_k is not None:
            ctx_kwargs["search_top_k"] = search_top_k
        if search_max_distance is not None:
            ctx_kwargs["search_max_distance"] = search_max_distance

        ctx = session.context(**ctx_kwargs)
        parts = []
        if hasattr(ctx, "peer_representation") and ctx.peer_representation:
            parts.append(f"Peer Representation:\n{ctx.peer_representation}")
        if hasattr(ctx, "peer_card") and ctx.peer_card:
            card_lines = "\n".join(f"  - {c}" for c in ctx.peer_card)
            parts.append(f"Peer Card:\n{card_lines}")
        if hasattr(ctx, "summary") and ctx.summary:
            parts.append(f"Session Summary:\n{ctx.summary}")
        if not parts:
            return f"Honcho context for '{resolved_peer}': No representation built yet — need more conversation history."
        return f"Honcho Context for '{resolved_peer}':\n\n" + "\n\n".join(parts)
    except Exception as e:
        return f"Honcho context error: {e}"


@tool(parse_docstring=True)
def honcho_conclude(
    conclusion: Optional[str] = None,
    delete_id: Optional[str] = None,
    list_conclusions: bool = False,
    query: Optional[str] = None,
    limit: int = 15,
    peer: str = "user",
    config: Annotated[Optional[RunnableConfig], InjectedToolArg] = None
) -> str:
    """Write, delete, or list persistent conclusions about a peer in Honcho memory.

    Args:
        conclusion: Fact statement to persist. Pass when creating a conclusion.
        delete_id: Conclusion ID to delete for PII removal. Pass when deleting.
        list_conclusions: Set to True to list stored conclusions.
        query: Optional keyword or search filter when listing conclusions.
        limit: Max number of conclusions to return (default 15).
        peer: Target peer name (defaults to 'user').
    """
    user_id = resolve_user_id_from_context(peer, config)
    cfg = get_honcho_config(user_id)
    if conclusion:
        res = _honcho_request(
            f"workspaces/{cfg['workspace']}/conclusions",
            method="POST",
            payload={
                "conclusions": [
                    {
                        "content": conclusion,
                        "observer_id": peer,
                        "observed_id": peer,
                    }
                ]
            },
            user_id=user_id
        )
        return f"Successfully recorded Honcho conclusion: {json.dumps(res)}"
    elif delete_id:
        res = _honcho_request(
            f"workspaces/{cfg['workspace']}/conclusions/{delete_id}",
            method="DELETE",
            user_id=user_id
        )
        return f"Successfully deleted Honcho conclusion '{delete_id}': {res}"
    else:
        res = _honcho_request(
            f"workspaces/{cfg['workspace']}/conclusions/list",
            method="POST",
            payload={},
            user_id=user_id
        )
        if isinstance(res, dict) and "error" in res:
            return f"Honcho conclusions list error: {res['error']}"

        items = res.get("items", []) if isinstance(res, dict) else (res if isinstance(res, list) else [])
        if not items:
            return f"No Honcho stored conclusions found in workspace '{cfg['workspace']}'."

        filtered = items
        if query:
            q_lower = query.lower().strip()
            # 1. Exact substring match first
            exact_matches = [
                it for it in items
                if q_lower in str(it.get("content", "")).lower() or q_lower in str(it.get("id", "")).lower()
            ]
            if exact_matches:
                filtered = exact_matches
            else:
                # 2. Smart keyword relevance ranking (filtering out stop words)
                stop_words = {"who", "is", "the", "a", "an", "of", "to", "in", "for", "and", "or", "what", "tell", "me", "about"}
                words = [w for w in q_lower.split() if w not in stop_words and len(w) > 1]
                if not words:
                    words = q_lower.split()
                scored = []
                for it in items:
                    text = str(it.get("content", "")).lower()
                    score = sum(1 for w in words if w in text)
                    if score > 0:
                        scored.append((score, it))
                scored.sort(key=lambda x: x[0], reverse=True)
                filtered = [it for score, it in scored] if scored else items

        # Cap output to specified limit (default 15)
        truncated = filtered[:limit]
        filter_str = f" matching query '{query}'" if query else ""
        lines = [f"Honcho Stored Conclusions (Showing top {len(truncated)} of {len(filtered)} conclusions{filter_str}):"]
        for idx, it in enumerate(truncated, 1):
            cid = it.get("id", "unknown")
            cnt = it.get("content", "")
            lines.append(f"{idx}. [ID: {cid}] {cnt}")

        return "\n".join(lines)
