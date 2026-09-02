"""Feeder Dedup VERIFIER — the second, independent agent (Pass 2).

Runs AFTER the Pass-1 storyline dedup agent (feeder_agent.agent).
It re-reviews ONLY the survivors Pass 1 decided to keep, with strictly
DROP-ONLY authority:

  - catches duplicates Pass 1 missed (different model + fresh eyes)
  - catches cross-chunk duplicates (it sees the whole kept list at once)
  - re-checks every survivor against recent DB titles

It can never rescue or re-add — so the two passes CONVERGE (the kept set only
shrinks) instead of oscillating between two disagreeing agents.

Model: provider/model resolved from Supabase agent_settings under the
`feeder_verifier_*` keys (independently selectable from the Pass-1 model).

Safety contract: FAIL-OPEN like Pass 1 — LLM errors, empty/corrupt decisions
and unmentioned IDs all default to APPROVED (kept).
"""
from typing import Any

from dotenv import load_dotenv
load_dotenv()

from feeder_agent.prompts import (
    VERIFY_SYSTEM_PROMPT,
    VERIFY_USER_TEMPLATE,
    DEDUP_EARLIER_SECTION,
)
from feeder_agent.tools import make_verify_tool, parse_tool_call
from feeder_agent.agent import (
    _make_model,
    _fetch_recent_db_rows,
    _format_batch,
    _format_db_rows,
)

VERIFY_AGENT_KEY = "feeder_verifier"


def _format_storylines(storylines: list, id_map: dict[int, Any] | None = None) -> str:
    """Compact view of Pass-1's clusters for the verifier's context."""
    if not storylines:
        return "(Pass 1 reported no storyline clusters)"
    lines = []
    for i, s in enumerate(storylines, start=1):
        if isinstance(s, dict):
            label = s.get("label", "?")
            kept_id = s.get("kept_id")
            dropped_ids = s.get("dropped_ids") or []
            lines.append(f"- '{label}': kept survivor {kept_id}, dropped {dropped_ids}")
        else:
            lines.append(f"- {s}")
    return "\n".join(lines)


def run_feeder_verify_agent(
    survivors: list[Any],
    storylines: list | None = None,
    db_title_limit: int = 300,
    workflow_id: str = None,
    extra_context_titles: list[str] | None = None,
) -> tuple[list[Any], list[tuple[Any, str]], dict]:
    """Pass 2: verify Pass-1 survivors with an independent LLM (drop-only).

    Args:
        survivors:             articles kept by Pass 1 (FULL final list, all chunks)
        storylines:            Pass-1's reported storyline clusters (context)
        db_title_limit:        how many recent DB titles to compare against
        workflow_id:           workflow scoping for DB context
        extra_context_titles:  additional same-run context (unused normally)

    Returns:
        (kept, dropped_with_reasons, report)
        report: {strategy, summary, dropped_ids, notes} — for feeder_run_history
    """
    report: dict = {
        "strategy": "llm_verify",
        "summary": "",
        "dropped_ids": [],
        "notes": [],
    }
    n = len(survivors)
    if n == 0:
        return [], [], report
    if n == 1:
        report["notes"].append("single survivor — nothing to verify")
        return survivors, [], report

    print(f"\n  [FeederVerifier] Verifying {n} survivors from Pass 1...")

    db_rows = _fetch_recent_db_rows(db_title_limit, workflow_id)
    batch_text = _format_batch(survivors)
    db_text = _format_db_rows(db_rows)
    storylines_text = _format_storylines(storylines or [])
    earlier_section = ""
    if extra_context_titles:
        earlier_text = "\n".join(f"[E-{i+1}] {t}" for i, t in enumerate(extra_context_titles))
        earlier_section = DEDUP_EARLIER_SECTION.format(
            n_earlier=len(extra_context_titles), earlier_text=earlier_text
        )

    user_msg = VERIFY_USER_TEMPLATE.format(
        n_kept=n,
        batch_text=batch_text,
        storylines_text=storylines_text,
        n_db=len(db_rows),
        db_text=db_text,
        earlier_section=earlier_section,
    )

    model = _make_model(VERIFY_AGENT_KEY)
    model_with_tool = model.bind_tools([make_verify_tool()], tool_choice="submit_verify_result")
    messages = [
        {"role": "system", "content": VERIFY_SYSTEM_PROMPT},
        {"role": "user", "content": user_msg},
    ]

    try:
        response = model_with_tool.invoke(messages)
    except Exception as e:
        print(f"  [FeederVerifier] LLM call failed: {e}")
        print(f"  [FeederVerifier] Fail-open: approving all {n} survivors.")
        report["strategy"] = "llm_error_failopen"
        report["notes"].append(f"LLM call failed: {e}")
        return survivors, [], report

    # Parse tool call (same shape as pass 1)
    result = None
    if hasattr(response, "tool_calls") and response.tool_calls:
        tc = response.tool_calls[0]
        result = tc.get("args") if isinstance(tc, dict) else getattr(tc, "args", None)
    if result is None and hasattr(response, "additional_kwargs"):
        raw_tcs = response.additional_kwargs.get("tool_calls", [])
        result = parse_tool_call(type("M", (), {"tool_calls": [
            type("TC", (), {"function": type("F", (), {"name": tc["function"]["name"], "arguments": tc["function"]["arguments"]})()})()
            for tc in raw_tcs
        ]})())

    if not result:
        print(f"  [FeederVerifier] No tool call in response. Approving all {n} survivors (fail-open).")
        report["strategy"] = "llm_no_toolcall_failopen"
        report["notes"].append("Model produced no submit_verify_result call")
        return survivors, [], report

    # Extract drops — verifier ONLY drops; anything not listed stays
    dropped_entries: list[Any] = result.get("dropped", []) or []
    summary: str = result.get("summary", "") or ""

    drop_set: set[int] = set()
    dropped_map: dict[int, str] = {}
    for d in dropped_entries:
        if isinstance(d, dict):
            try:
                did = int(d.get("id"))
            except (TypeError, ValueError):
                continue
            drop_set.add(did)
            dropped_map[did] = str(d.get("reason") or "Verifier: duplicate")
        elif isinstance(d, (int, str)):
            try:
                did = int(d)
            except ValueError:
                continue
            drop_set.add(did)
            dropped_map.setdefault(did, "Verifier: duplicate")

    valid = set(range(1, n + 1))
    invalid = sorted(d for d in drop_set if d not in valid)
    if invalid:
        report["notes"].append(f"Ignored out-of-range verifier IDs: {invalid}")
        print(f"  [FeederVerifier] Warning: ignoring out-of-range IDs {invalid}")
        drop_set &= valid

    report["summary"] = summary
    report["dropped_ids"] = sorted(drop_set)
    print(f"  [FeederVerifier] Verdict: approve {n - len(drop_set)}, drop {len(drop_set)} — {summary}")

    kept: list[Any] = []
    dropped_with_reasons: list[tuple[Any, str]] = []
    for i, art in enumerate(survivors, start=1):
        if i in drop_set:
            reason = dropped_map.get(i, "Verifier: duplicate missed by pass 1")
            dropped_with_reasons.append((art, reason))
            print(f"  [DROP Verifier] '{art.title[:70]}'\n             Reason: {reason}")
        else:
            kept.append(art)

    return kept, dropped_with_reasons, report
