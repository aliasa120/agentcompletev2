"""Feeder Dedup Agent — Core Agent

Replaces L3 (Fuzzy) + L4 (NER) + L5 (Semantic) with an LLM agent that
understands meaning and makes smarter deduplication decisions.

Decision unit = DEVELOPING STORYLINE (see prompts.py): reactions, condolences,
inquiries and fallout of the same incident are ONE storyline, one survivor.

Model: provider/model resolved from Supabase agent_settings at runtime.

Safety contract: FAIL-OPEN everywhere. LLM errors, empty/corrupt decisions and
IDs the model forgot to mention all default to KEEP — the agent can only ever
cause extra articles, never lost ones.
"""
import os
from typing import Any

from dotenv import load_dotenv
load_dotenv()

from langchain_openai import ChatOpenAI
from feeder_agent.prompts import (
    DEDUP_SYSTEM_PROMPT,
    DEDUP_USER_TEMPLATE,
    DEDUP_EARLIER_SECTION,
    DEDUP_NO_SUSPECTS,
)
from feeder_agent.tools import make_submit_tool, parse_tool_call
from feeder.db import supabase_client
from feeder.layer_0_event_clustering import _pair_score
from research_agent.tools.provider_engine import get_llm_config

# Pairs at/above this similarity score (but below Layer 0's auto-drop threshold)
# are handed to the agent as "suspected duplicates" to confirm/reject.
SUSPECT_SCORE_MIN = 55
SUSPECT_PAIRS_MAX = 20


# ── Model (provider/model resolved from Supabase agent_settings at runtime) ──────────────
def _make_model(agent: str = "feeder") -> ChatOpenAI:
    base_url, api_key, model = get_llm_config(agent)
    print(f"  [FeederAgent:{agent}] Using model={model} via {base_url[:40]}...")
    return ChatOpenAI(
        model=model,
        api_key=api_key,
        base_url=base_url,
        temperature=0.0,           # deterministic decisions
        max_tokens=4096,
    )


# ── DB helper: fetch recent titles (with source + date for better matching) ──
def _fetch_recent_db_rows(limit: int = 300, workflow_id: str = None) -> list[dict]:
    """Fetch the most recently stored articles (title/domain/date) from feeder_articles."""
    try:
        query = supabase_client.table("feeder_articles").select("title,source_domain,published_at,created_at")
        if workflow_id:
            query = query.eq("workflow_id", workflow_id)
        else:
            query = query.is_("workflow_id", "null")

        res = (
            query
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return res.data or []
    except Exception as e:
        print(f"  [FeederAgent] DB fetch error: {e}")
        return []


# ── Format helpers ────────────────────────────────────────────────────────────
def _looks_like_html(text: str) -> bool:
    return "<" in (text or "") and ">" in (text or "")


def _format_batch(articles: list[Any]) -> str:
    """Format articles as a numbered list for the prompt.

    Snippets are only shown when the description is REAL text. Google News RSS
    summaries are HTML whose first 120 chars are base64 redirect URLs — showing
    that as a "snippet" actively misleads the model, so it is skipped.
    Sibling cluster titles (parsed from Google's own clustering) ARE shown —
    they are near-certain same-story evidence.
    """
    lines = []
    for i, art in enumerate(articles, start=1):
        lines.append(f"[{i}] Title: {art.title}")
        lines.append(f"    Source: {art.domain}")
        if getattr(art, "sibling_titles", None):
            sibs = " | ".join(s[:110] for s in art.sibling_titles[:4])
            lines.append(f"    Also in Google's cluster: {sibs}")
        if art.published_parsed is not None:
            try:
                lines.append(f"    Published: {art.published_parsed.strftime('%d %b %H:%M UTC')}")
            except Exception:
                pass
        desc = (getattr(art, "description", "") or "").strip()
        if desc and not _looks_like_html(desc):
            snippet = desc[:220].replace("\n", " ").strip()
            if snippet:
                lines.append(f"    Snippet: {snippet}")
        lines.append("")
    return "\n".join(lines)


def _format_db_rows(rows: list[dict]) -> str:
    """Format DB rows as a numbered list with source + date context."""
    if not rows:
        return "(No recent articles in database)"
    out = []
    for i, r in enumerate(rows):
        date_bit = (r.get("published_at") or r.get("created_at") or "")[:16].replace("T", " ")
        dom_bit = r.get("source_domain") or "?"
        out.append(f"[DB-{i+1}] ({dom_bit}, {date_bit}) {r.get('title', '')}")
    return "\n".join(out)


# ── Suspected duplicate pairs (deterministic scaffolding for the LLM) ────────
def _find_suspect_pairs(articles: list[Any]) -> list[tuple[int, int, int, str]]:
    """All in-batch pairs with Layer-0 similarity >= SUSPECT_SCORE_MIN.

    Article indices are 1-based to match the prompt. Layer 0 already removed all
    pairs >= cluster_threshold before the agent runs, so everything here is in
    the "close call" band where an LLM judge adds real value.
    """
    suspects: list[tuple[int, int, int, str]] = []
    for i in range(len(articles)):
        for j in range(i + 1, len(articles)):
            score, kind = _pair_score(articles[i], articles[j])
            if score >= SUSPECT_SCORE_MIN:
                suspects.append((i + 1, j + 1, score, kind))
    suspects.sort(key=lambda s: -s[2])
    return suspects[:SUSPECT_PAIRS_MAX]


def _format_suspects(suspects: list[tuple[int, int, int, str]], articles: list[Any]) -> str:
    if not suspects:
        return ""
    lines = [
        "═══════════════════════════════════════════════════",
        f"SUSPECTED DUPLICATE CANDIDATES ({len(suspects)} pairs)",
        "═══════════════════════════════════════════════════",
    ]
    for i, j, score, kind in suspects:
        via = "Google cluster" if kind == "sibling-cluster" else f"{score}% title similarity"
        lines.append(
            f"≈ [{i}] \"{articles[i-1].title[:65]}\"  +  [{j}] \"{articles[j-1].title[:65]}\"  ({via})"
        )
    lines.append("")
    return "\n".join(lines)


# ── Main entry point ──────────────────────────────────────────────────────────
def run_feeder_dedup_agent(
    articles: list[Any],
    db_title_limit: int = 300,
    workflow_id: str = None,
    extra_context_titles: list[str] | None = None,
) -> tuple[list[Any], list[tuple[Any, str]], dict]:
    """
    Run the LLM-based deduplication agent on a batch of articles.

    Output contract is DROP-ONLY (same as the verifier): the model lists only
    which articles to drop; everything else is kept automatically. This is what
    made the verifier reliable — heavy contracts (full kept list + mandatory ID
    coverage + storyline enumeration) let weaker models take a valid-looking
    'keep everything' shortcut without actually doing Phase 1.

    Args:
        articles:              List of FeederArticle objects (already passed L1 + L2)
        db_title_limit:        How many recent DB titles to compare against
        workflow_id:           workflow ID to scope verification context
        extra_context_titles:  Titles KEPT earlier this run (previous chunks) so
                               cross-chunk duplicates are still caught.

    Returns:
        (kept, dropped_with_reasons, report)
        - kept: list of FeederArticle objects that passed dedup
        - dropped_with_reasons: list of (FeederArticle, reason_string) tuples
        - report: dict {strategy, summary, storylines, kept_ids, dropped_ids,
                        suspects, notes} — persisted to feeder_run_history
    """
    report: dict = {
        "strategy": "llm_storyline_droponly",
        "summary": "",
        "storylines": [],
        "kept_ids": [],
        "dropped_ids": [],
        "suspects": [],
        "notes": [],
    }
    if not articles:
        return [], [], report

    n = len(articles)
    print(f"\n  [FeederAgent] Starting dedup on {n} articles...")

    # Deterministic suspect pairs (confirmed/rejected by the LLM, not auto-dropped)
    suspects = _find_suspect_pairs(articles)
    report["suspects"] = [
        {"a": i, "b": j, "score": s, "via": k} for i, j, s, k in suspects
    ]
    if suspects:
        print(f"  [FeederAgent] {len(suspects)} suspected duplicate pair(s) from similarity scan for the agent to judge.")

    # Fetch DB context
    db_rows = _fetch_recent_db_rows(db_title_limit, workflow_id)
    print(f"  [FeederAgent] Loaded {len(db_rows)} recent DB titles for comparison.")

    # Build prompt
    batch_text = _format_batch(articles)
    db_text = _format_db_rows(db_rows)
    earlier_section = ""
    if extra_context_titles:
        earlier_text = "\n".join(f"[E-{i+1}] {t}" for i, t in enumerate(extra_context_titles))
        earlier_section = DEDUP_EARLIER_SECTION.format(
            n_earlier=len(extra_context_titles), earlier_text=earlier_text
        )
    user_msg = DEDUP_USER_TEMPLATE.format(
        n_batch=n,
        batch_text=batch_text,
        n_suspects=len(suspects),
        suspects_text=_format_suspects(suspects, articles),
        n_db=len(db_rows),
        db_text=db_text,
        earlier_section=earlier_section,
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
        print(f"  [FeederAgent] Falling back (fail-open): keeping all {n} articles.")
        report["strategy"] = "llm_error_failopen"
        report["notes"].append(f"LLM call failed: {e}")
        return articles, [], report

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
        print(f"  [FeederAgent] No tool call in response. Keeping all articles (fail-open).")
        report["strategy"] = "llm_no_toolcall_failopen"
        report["notes"].append("Model produced no submit_dedup_result call")
        return articles, [], report

    # Extract decisions — DROP-ONLY contract: only `dropped` carries meaning;
    # every article not explicitly dropped is KEPT automatically (fail-open).
    dropped_entries: list[Any] = result.get("dropped", []) or []
    summary: str = result.get("summary", "") or ""
    storylines: list[Any] = result.get("storylines", []) or []

    # Make parsing robust against variations in model tool-calling responses
    dropped_ids: list[int] = []
    dropped_map: dict[int, str] = {}
    for d in dropped_entries:
        if isinstance(d, dict):
            did = d.get("id")
            if did is None:
                continue
            try:
                did = int(did)
            except (TypeError, ValueError):
                continue
            dropped_ids.append(did)
            dropped_map[did] = str(d.get("reason") or "Agent dedup")
        elif isinstance(d, (int, str)):
            try:
                did = int(d)
                dropped_ids.append(did)
                dropped_map.setdefault(did, "Agent dedup")
            except ValueError:
                pass

    # ── Validation (fail-open) ────────────────────────────────────────────────
    valid = set(range(1, n + 1))
    drop_set = {d for d in dropped_ids if d in valid}
    kept_set = valid - drop_set

    invalid = sorted(x for x in dropped_ids if x not in valid)
    if invalid:
        report["notes"].append(f"Ignored out-of-range IDs from model: {invalid}")
        print(f"  [FeederAgent] Warning: ignoring out-of-range IDs {invalid}")

    # Harvest any duplicate IDs reported inside storyline clusters
    storyline_dropped: set[int] = set()
    storyline_kept: set[int] = set()
    for s in storylines:
        if isinstance(s, dict):
            kid = s.get("kept_id")
            lbl = s.get("label") or "Same storyline"
            if isinstance(kid, int):
                storyline_kept.add(kid)
            for d in (s.get("dropped_ids") or []):
                try:
                    did = int(d)
                    if did in valid and did != kid:
                        storyline_dropped.add(did)
                        if did not in dropped_map:
                            dropped_map[did] = f"Same storyline: {lbl} (kept #{kid})"
                except (TypeError, ValueError):
                    pass

    # Merge storyline drops into drop_set
    extra_from_storylines = (storyline_dropped & valid) - drop_set - storyline_kept
    if extra_from_storylines:
        print(f"  [FeederAgent] Included {len(extra_from_storylines)} duplicate(s) from storyline clusters: {sorted(extra_from_storylines)}")
        drop_set.update(extra_from_storylines)

    kept_set = valid - drop_set

    report.update({
        "summary": summary,
        "storylines": storylines,
        "kept_ids": sorted(kept_set),
        "dropped_ids": sorted(drop_set),
    })

    print(f"  [FeederAgent] Decision: drop={sorted(drop_set)} (keep {n - len(drop_set)} of {n})")
    print(f"  [FeederAgent] Summary: {summary}")
    if storylines:
        print(f"  [FeederAgent] Storylines found: {len(storylines)}")

    # Build output
    kept: list[Any] = []
    dropped_with_reasons: list[tuple[Any, str]] = []

    for i, art in enumerate(articles, start=1):
        if i in drop_set:                                   # explicit drop only
            reason = dropped_map.get(i, "Agent dedup: duplicate storyline")
            dropped_with_reasons.append((art, reason))
            print(f"  [DROP Agent] '{art.title[:70]}'\n             Reason: {reason}")
        else:                                               # everything else -> keep (fail-open)
            kept.append(art)

    print(f"  [FeederAgent] Result: {len(kept)} kept, {len(dropped_with_reasons)} dropped.")
    return kept, dropped_with_reasons, report
