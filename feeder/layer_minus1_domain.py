"""Layer -1: Domain Whitelisting.
Keeps only articles from trusted whitelisted domains.
If whitelist is EMPTY in DB → ALL sources pass (no filtering).
"""
from feeder.db import supabase_client

_whitelist_cache: set[str] | None = None


def _load_whitelist() -> set[str]:
    """Load whitelisted domains from Supabase. Cached per pipeline run."""
    global _whitelist_cache
    if _whitelist_cache is not None:
        return _whitelist_cache
    try:
        res = supabase_client.table("feeder_whitelisted_domains").select("domain").execute()
        _whitelist_cache = {r["domain"].lower() for r in (res.data or [])}
    except Exception as e:
        print(f"Layer -1 whitelist load error: {e}")
        _whitelist_cache = set()
    return _whitelist_cache


def reset_whitelist_cache():
    """Call this at the start of each pipeline run to force fresh DB load."""
    global _whitelist_cache
    _whitelist_cache = None


def layer_minus1_domain(article_domain: str) -> bool:
    """Returns True if article domain is whitelisted (or whitelist is empty).
    
    Args:
        article_domain: e.g. 'dawn.com', 'geo.tv'
    """
    whitelist = _load_whitelist()

    # Empty whitelist = no filter, ALL pass
    if not whitelist:
        return True

    domain = article_domain.lower().removeprefix("www.")
    return domain in whitelist
