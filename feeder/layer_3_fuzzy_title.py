"""Layer 3: Fuzzy Title Matching — CHECK ONLY.
Per plan spec:
- Threshold: user-configurable (default 65%) using token_set_ratio
- Phase 1: Check IN-BATCH first (against titles accepted in this run)
- Phase 2: Check against DB recent articles (feeder_articles, limit=fuzzy_db_limit)
- If duplicate found -> DROP (no write)
- If unique  -> PASS

WHY token_set_ratio (not token_sort_ratio):
  token_sort_ratio sorts all words alphabetically before comparing, which causes
  false-positives when two completely different Pakistan headlines share "Pakistan"
  as the dominant word (e.g. "Pakistan regrets escalation" scores ~60% vs
  "Rebalancing Pakistan's economy" with token_SORT but ~25% with token_SET).
  token_set_ratio is better for headline deduplication: it only rewards the
  intersection of word sets, so articles need genuinely overlapping vocabulary.

Returns (passed: bool, matched_title: str)
"""
import re
from feeder.db import supabase_client


def _normalize(title: str) -> str:
    # Remove source suffix like "- Dawn", "- The Express Tribune" etc.
    title = re.sub(r"\s*[-|]\s*(Dawn|The Express Tribune|Geo TV|Business Recorder|Pakistan Today|France 24|Al Jazeera|Reuters|BBC|CNN|DW|AFP).*$", "", title, flags=re.IGNORECASE)
    return re.sub(r"[^a-zA-Z0-9\s]", "", title.lower()).strip()


def _fuzzy_match(t1: str, t2: str) -> int:
    try:
        from fuzzywuzzy import fuzz
        # token_set_ratio: compares intersection vs remainder separately
        # much less prone to false-positives from shared country/topic words
        return fuzz.token_set_ratio(_normalize(t1), _normalize(t2))
    except ImportError:
        return 0


def layer_3_fuzzy_title(
    article_title: str,
    batch_titles_seen: list[str],
    threshold: int = 65,      # raised from 50% -> 65% to reduce false positives
    fuzzy_db_limit: int = 500,
) -> tuple[bool, str]:
    """Layer 3: Returns (is_new, matched_title_or_empty).

    Args:
        article_title:       Title of current article
        batch_titles_seen:   Titles accepted so far in this batch run
        threshold:           Similarity % threshold (from feeder_settings)
        fuzzy_db_limit:      Max recent DB titles to compare against

    Returns:
        (True, "")              -> PASS (unique)
        (False, matched_title)  -> DROP (fuzzy duplicate of matched_title)
    """
    # Phase 1: In-batch check
    for seen_title in batch_titles_seen:
        score = _fuzzy_match(article_title, seen_title)
        if score >= threshold:
            return False, seen_title  # in-batch duplicate

    # Phase 2: DB check (only recent articles)
    try:
        res = supabase_client.table("feeder_articles") \
            .select("title") \
            .order("created_at", desc=True) \
            .limit(fuzzy_db_limit).execute()
        db_titles = [r["title"] for r in (res.data or [])]
    except Exception as e:
        print(f"  [L3] DB error: {e}")
        db_titles = []

    for db_title in db_titles:
        score = _fuzzy_match(article_title, db_title)
        if score >= threshold:
            return False, db_title  # DB duplicate

    return True, ""
