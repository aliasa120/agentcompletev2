"""Layer 0: Event Clustering.
Per plan spec:
- Groups articles covering the same event using fuzzy title similarity
- Ranks sources by trust/authority (order domains were added to whitelist = trust rank)
- Selects the best article (highest-trust source) per event cluster
- Drops remaining duplicate event coverage from same cluster

Sits BETWEEN Layer -1 (domain whitelist) and Layer 1 (GUID check).
Operates on the FULL batch that passed Layer -1 before the batch size cap.

Matching signals (any one >= threshold clusters two articles):
1. fuzzy title vs title (token_sort_ratio on normalized text)
2. title vs the OTHER article's Google News cluster sibling titles
   (Google pre-clusters identical stories; parsed at fetch time)
"""
import re
from feeder.models import FeederArticle


def _normalize(title: str) -> str:
    # Keep spaces! (bug fix: r"\\s" in the old char-class matched a literal
    # backslash + 's', so whitespace was REMOVED and every title became one
    # giant word — token_sort_ratio then degenerated to char-ratio and almost
    # nothing ever reached the cluster threshold)
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", (title or "").lower())).strip()


def _fuzzy_score(t1: str, t2: str) -> int:
    """Fuzzy title similarity score (0-100) using token_sort_ratio."""
    try:
        from fuzzywuzzy import fuzz
        return fuzz.token_sort_ratio(_normalize(t1), _normalize(t2))
    except ImportError:
        return 0


def _pair_score(rep: FeederArticle, other: FeederArticle) -> tuple[int, str]:
    """Best similarity between two articles across all matching signals.

    Returns (score, match_kind). match_kind tells the log WHY the pair matched.
    """
    best = _fuzzy_score(rep.title, other.title)
    kind = "titles"

    # Google News sibling-cluster cross-checks (very strong same-story signal,
    # keep them slightly cheaper to trigger via the same threshold).
    rep_titles = [rep.title] + (rep.sibling_titles or [])
    other_titles = [other.title] + (other.sibling_titles or [])
    for st in rep_titles[1:]:
        s = _fuzzy_score(st, other.title)
        if s > best:
            best, kind = s, "sibling-cluster"
    for st in other_titles[1:]:
        s = _fuzzy_score(st, rep.title)
        if s > best:
            best, kind = s, "sibling-cluster"
    # sibling vs sibling (both clustered versions of the same Google editorial set)
    for s1 in rep_titles[1:]:
        for s2 in other_titles[1:]:
            s = _fuzzy_score(s1, s2)
            if s > best:
                best, kind = s, "sibling-cluster"
    return best, kind


def layer_0_event_clustering(
    articles: list[FeederArticle],
    domain_priority: dict[str, int],
    cluster_threshold: int = 70,
) -> tuple[list[FeederArticle], list[tuple[FeederArticle, str]]]:
    """Layer 0: Event clustering — keep one article per event cluster.

    Algorithm:
    1. Sort all articles by domain trust rank (lower priority index = higher trust).
       Trust rank is determined by the order domains were added to feeder_whitelisted_domains
       (earlier = higher trust). Unknown domains rank last.
    2. Greedy scan (highest-trust first):
       - Each unclaimed article becomes the cluster *representative* (kept).
       - All subsequent articles with similarity >= cluster_threshold
         (title match OR Google sibling-cluster match) are absorbed (dropped).
    3. Returns (kept, dropped_with_reason).

    Args:
        articles:          Articles that passed Layer -1 (domain whitelist).
        domain_priority:   {domain: int} from Supabase — lower int = higher trust.
                           Pipeline loads this from feeder_whitelisted_domains ordered
                           by created_at ASC (first added = most trusted).
        cluster_threshold: Fuzzy similarity % to group as same event. Default 70.
                           Stored in feeder_settings as 'cluster_threshold'.

    Returns:
        (kept, dropped_with_reason)
        kept:  List of representative articles — one per unique event cluster.
        dropped: List of (article, reason) for every article absorbed into a cluster.
    """
    if not articles:
        return [], []

    def _trust_rank(art: FeederArticle) -> int:
        """Lower number = checked first = kept over lower-trust sources."""
        return domain_priority.get(art.domain, 99_999)

    # Sort highest-trust source first; on equal trust prefer the MORE INFORMATIVE
    # (longer) headline as cluster representative instead of raw fetch order.
    sorted_arts = sorted(articles, key=lambda a: (_trust_rank(a), -len(a.title)))

    kept: list[FeederArticle] = []
    dropped: list[tuple[FeederArticle, str]] = []
    absorbed: set[int] = set()   # indices in sorted_arts that were clustered away

    for i, rep in enumerate(sorted_arts):
        if i in absorbed:
            continue
        # rep is the best-source article for this event cluster
        kept.append(rep)

        for j in range(i + 1, len(sorted_arts)):
            if j in absorbed:
                continue
            other = sorted_arts[j]
            score, kind = _pair_score(rep, other)
            if score >= cluster_threshold:
                absorbed.add(j)
                dropped.append((
                    other,
                    f"Same event as '{rep.title[:70]}' "
                    f"(similarity={score}% via {kind}, kept {rep.domain})"
                ))

    return kept, dropped
