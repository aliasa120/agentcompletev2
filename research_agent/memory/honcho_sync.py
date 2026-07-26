"""Honcho Turn Sync — Writes completed agent turns to Honcho.

This is the WRITE PATH — the missing piece that feeds conversations into
Honcho's memory pipeline. Without this, Honcho has no new data to reason about.

Flow per agent turn:
  1. User sends message → agent responds
  2. sync_turn_to_honcho() called with user_msg + agent_reply
  3. Honcho stores both messages in the session
  4. Background: Deriver extracts conclusions every ~1000 tokens
  5. Background: Dreamer consolidates and updates peer card (after 50+ new conclusions)

SDK API used (honcho-ai v2.2.0):
  session = h.session(thread_id)
  session.add_peers([user_peer, agent_peer])
  session.add_messages([
      user_peer.message(user_text),
      agent_peer.message(agent_text),
  ])
"""

import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Honcho agent peer ID — the "assistant" participant.
# observe_me=False tells Honcho not to reason about the agent's messages as a person.
AGENT_PEER_ID = "assistant"


def sync_turn_to_honcho(
    user_message: str,
    agent_response: str,
    thread_id: str,
    user_id: Optional[str] = None,
    workflow_id: Optional[str] = None,
) -> bool:
    """Write one completed turn (user msg + agent reply) to Honcho.

    Args:
        user_message:   The raw user message (before memory injection).
        agent_response: The agent's full reply for this turn.
        thread_id:      LangGraph thread_id (used as Honcho session ID).
        user_id:        User UUID. Resolved from ContextVars if not given.
        workflow_id:    Workflow ID (optional, used for peer name prefix).

    Returns:
        True if sync succeeded, False otherwise (never raises).
    """
    if not user_message or not agent_response:
        return False

    try:
        from research_agent.memory.honcho_provider import (
            is_honcho_configured,
            get_honcho_config,
            resolve_user_id_from_context,
        )

        if not user_id:
            user_id = resolve_user_id_from_context()
        if not is_honcho_configured(user_id):
            return False

        cfg = get_honcho_config(user_id)
        if not cfg["api_key"]:
            return False

        # Build the peer ID the same way as prefetch_honcho_context does
        clean_uid = str(user_id).strip().lower().replace("-", "_").replace(" ", "_")
        user_peer_id = f"user_{clean_uid}"

        def _do_sync():
            from honcho import Honcho as _HonchoSDK
            sdk_kwargs: dict = {
                "workspace_id": cfg["workspace"],
                "api_key": cfg["api_key"],
            }
            if cfg["base_url"] and cfg["base_url"] not in ("", "https://api.honcho.dev"):
                sdk_kwargs["base_url"] = cfg["base_url"]

            h = _HonchoSDK(**sdk_kwargs)

            # Get or create the user peer
            user_peer = h.peer(user_peer_id)

            # Get or create the agent peer (observe_me=False = don't reason over bot messages)
            from honcho.client import PeerConfig
            agent_peer = h.peer(
                AGENT_PEER_ID,
                configuration=PeerConfig(observe_me=False),
            )

            # Get or create the session (one session per LangGraph thread)
            session = h.session(
                thread_id,
                peers=[user_peer, agent_peer],
            )

            # Write both messages atomically in one request
            session.add_messages([
                user_peer.message(user_message),
                agent_peer.message(agent_response),
            ])
            return True

        # Offload to thread — blockbuster-safe and avoids blocking the event loop
        import concurrent.futures, asyncio
        try:
            _loop = asyncio.get_running_loop()
            if _loop.is_running():
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as _ex:
                    result = _ex.submit(_do_sync).result(timeout=10)
                    print(f"[Honcho Sync SDK] ✅ Turn synced for user={user_peer_id[:20]}, thread={thread_id[:12]}")
                    return result
        except RuntimeError:
            pass

        result = _do_sync()
        print(f"[Honcho Sync SDK] ✅ Turn synced for user={user_peer_id[:20]}, thread={thread_id[:12]}")
        return result

    except Exception as e:
        # Fall back to REST on any SDK exception
        logger.debug(f"[Honcho Sync] SDK sync exception ({e}), falling back to REST")
        return _sync_turn_rest(user_message, agent_response, thread_id, user_id)


def _sync_turn_rest(
    user_message: str,
    agent_response: str,
    thread_id: str,
    user_id: Optional[str] = None,
) -> bool:
    """REST fallback for sync_turn_to_honcho when honcho-ai SDK not installed."""
    try:
        from research_agent.memory.honcho_provider import (
            _honcho_request,
            get_honcho_config,
            resolve_user_id_from_context,
        )
        if not user_id:
            user_id = resolve_user_id_from_context()
        cfg = get_honcho_config(user_id)
        if not cfg["api_key"]:
            return False

        clean_uid = str(user_id).strip().lower().replace("-", "_").replace(" ", "_")
        user_peer_id = f"user_{clean_uid}"
        ws = cfg["workspace"]

        # Ensure session exists (use 'name' key for REST v3 API)
        _honcho_request(
            f"workspaces/{ws}/sessions",
            method="POST",
            payload={"name": thread_id},
            user_id=user_id,
        )


        # Write messages
        res = _honcho_request(
            f"workspaces/{ws}/sessions/{thread_id}/messages",
            method="POST",
            payload={
                "messages": [
                    {"content": user_message, "peer_id": user_peer_id},
                    {"content": agent_response, "peer_id": AGENT_PEER_ID},
                ]
            },
            user_id=user_id,
        )
        if "error" not in res:
            print(f"[Honcho Sync REST] ✅ Turn synced for thread={thread_id[:12]}")
            return True
        return False
    except Exception as e:
        logger.warning(f"[Honcho Sync REST] Failed: {e}")
        return False
