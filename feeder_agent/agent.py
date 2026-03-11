"""Feeder Dedup Agent — Core Agent

Replaces L3 (Fuzzy) + L4 (NER) + L5 (Semantic) with an LLM agent that
understands meaning and makes smarter deduplication decisions.

Model: cerebras/gpt-oss-120b via LiteLLM proxy (same setup as main agent)
"""
import os
from typing import Any

from dotenv import load_dotenv
load_dotenv()

from langchain_openai import ChatOpenAI
from feeder_agent.prompts import DEDUP_SYSTEM_PROMPT, DEDUP_USER_TEMPLATE
from feeder_agent.tools import make_submit_tool, parse_tool_call
from feeder.db import supabase_client


# ── Model (cerebras via LiteLLM proxy) ───────────────────────────────────────
def _make_model() -> ChatOpenAI:
    return ChatOpenAI(
        model="cerebras/gpt-oss-120b",
        api_key=os.environ.get("OPENAI_API_KEY", ""),
        base_url=os.environ.get("OPENAI_BASE_URL", "http://47.82.173.134:4000"),
        temperature=0.0,           # deterministic decisions
        max_tokens=4096,
    )


# ── DB helper: fetch recent titles ───────────────────────────────────────────
def _fetch_recent_db_titles(limit: int = 300) -> list[str]:
    """Fetch the most recently stored article titles from feeder_articles."""
    try:
        res = (
            supabase_client.table("feeder_articles")
            .select("title")
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return [r["title"] for r in (res.data or [])]
    except Exception as e:
        print(f"  [FeederAgent] DB fetch error: {e}")
        return []


# ── Format helpers ────────────────────────────────────────────────────────────
def _format_batch(articles: list[Any]) -> str:
    """Format articles as a numbered list for the prompt."""
    lines = []
    for i, art in enumerate(articles, start=1):
        lines.append(f"[{i}] Title: {art.title}")
        lines.append(f"    Source: {art.domain}")
        if art.description:
            snippet = art.description[:120].replace("\n", " ").strip()
            lines.append(f"    Snippet: {snippet}…")
        lines.append("")
    return "\n".join(lines)


def _format_db_titles(titles: list[str]) -> str:
    """Format DB titles as a numbered list."""
    if not titles:
        return "(No recent articles in database)"
    return "\n".join(f"[DB-{i+1}] {t}" for i, t in enumerate(titles))


# ── Main entry point ──────────────────────────────────────────────────────────
def run_feeder_dedup_agent(
    articles: list[Any],
    db_title_limit: int = 300,
) -> tuple[list[Any], list[tuple[Any, str]]]:
    """
    Run the LLM-based deduplication agent on a batch of articles.

    Args:
        articles:         List of FeederArticle objects (already passed L1 + L2)
        db_title_limit:   How many recent DB titles to compare against

    Returns:
        (kept, dropped_with_reasons)
        - kept: list of FeederArticle objects that passed dedup
        - dropped_with_reasons: list of (FeederArticle, reason_string) tuples
    """
    if not articles:
        return [], []

    print(f"\n  [FeederAgent] Starting dedup on {len(articles)} articles...")

    # Fetch DB context
    db_titles = _fetch_recent_db_titles(db_title_limit)
    print(f"  [FeederAgent] Loaded {len(db_titles)} recent DB titles for comparison.")

    # Build prompt
    batch_text = _format_batch(articles)
    db_text = _format_db_titles(db_titles)
    user_msg = DEDUP_USER_TEMPLATE.format(
        n_batch=len(articles),
        batch_text=batch_text,
        n_db=len(db_titles),
        db_text=db_text,
    )

    # Bind tool
    tool_def = make_submit_tool()
    model = _make_model()
    model_with_tool = model.bind_tools([tool_def], tool_choice="submit_dedup_result")

    # Call LLM (single-shot — agent always calls the tool)
    messages = [
        {"role": "system", "content": DEDUP_SYSTEM_PROMPT},
        {"role": "user", "content": user_msg},
    ]

    try:
        response = model_with_tool.invoke(messages)
    except Exception as e:
        print(f"  [FeederAgent] LLM call failed: {e}")
        print(f"  [FeederAgent] Falling back: keeping all {len(articles)} articles.")
        return articles, []

    # Parse tool call
    # LangChain wraps tool_calls in response.tool_calls (list of dicts) or additional_kwargs
    result = None

    # Try LangChain tool_calls attribute first
    if hasattr(response, "tool_calls") and response.tool_calls:
        tc = response.tool_calls[0]
        result = tc.get("args") if isinstance(tc, dict) else getattr(tc, "args", None)

    # Fallback to additional_kwargs
    if result is None and hasattr(response, "additional_kwargs"):
        raw_tcs = response.additional_kwargs.get("tool_calls", [])
        result = parse_tool_call(type("M", (), {"tool_calls": [
            type("TC", (), {"function": type("F", (), {"name": tc["function"]["name"], "arguments": tc["function"]["arguments"]})()})()
            for tc in raw_tcs
        ]})())

    if not result:
        print(f"  [FeederAgent] No tool call in response. Keeping all articles. Response: {response}")
        return articles, []

    # Extract kept/dropped decisions
    kept_ids: list[int] = result.get("kept_ids", [])
    dropped_entries: list[dict] = result.get("dropped", [])
    summary: str = result.get("summary", "")

    print(f"  [FeederAgent] Decision: keep={kept_ids}, drop={[d['id'] for d in dropped_entries]}")
    print(f"  [FeederAgent] Summary: {summary}")

    # Build output
    kept: list[Any] = []
    dropped_with_reasons: list[tuple[Any, str]] = []

    # Map 1-based IDs back to articles
    dropped_map = {d["id"]: d.get("reason", "Agent dedup") for d in dropped_entries}

    for i, art in enumerate(articles, start=1):
        if i in kept_ids:
            kept.append(art)
        else:
            reason = dropped_map.get(i, "Agent dedup: duplicate event")
            dropped_with_reasons.append((art, reason))
            print(f"  [DROP Agent] '{art.title[:70]}'\n             Reason: {reason}")

    # Safety: if kept_ids is empty but dropped is also empty (agent gave no decision)
    # fall back to keeping everything
    if not kept and not dropped_with_reasons:
        print("  [FeederAgent] Warning: empty decision. Keeping all articles.")
        return articles, []

    print(f"  [FeederAgent] Result: {len(kept)} kept, {len(dropped_with_reasons)} dropped.")
    return kept, dropped_with_reasons
