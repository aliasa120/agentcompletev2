"""Layer -1: Domain Whitelisting.
Keeps only articles from trusted whitelisted domains.
If whitelist is EMPTY in DB → ALL sources pass (no filtering).
"""
from feeder.db import supabase_client

_whitelist_cache: dict[str | None, set[str]] | None = None


def _load_whitelists() -> dict[str | None, set[str]]:
    """Load all whitelisted domains from Supabase and group by workflow_id. Cached per pipeline run."""
    global _whitelist_cache
    if _whitelist_cache is not None:
        return _whitelist_cache
    
    _whitelist_cache = {}
    try:
        res = supabase_client.table("feeder_whitelisted_domains").select("domain, workflow_id").execute()
        for r in (res.data or []):
            dom = r["domain"].lower()
            wf = r.get("workflow_id")
            if wf not in _whitelist_cache:
                _whitelist_cache[wf] = set()
            _whitelist_cache[wf].add(dom)
    except Exception as e:
        print(f"Layer -1 whitelist load error: {e}")
    return _whitelist_cache


def reset_whitelist_cache():
    """Call this at the start of each pipeline run to force fresh DB load."""
    global _whitelist_cache
    _whitelist_cache = None


def layer_minus1_domain(article_domain: str, workflow_id: str = None) -> bool:
    """Returns True if article domain is whitelisted for the given workflow_id 
    (or if the whitelist for this workflow is empty).
    
    Args:
        article_domain: e.g. 'dawn.com', 'geo.tv'
        workflow_id: ID of the workflow the article belongs to
    """
    whitelists = _load_whitelists()
    
    # Whitelisted domains for this workflow + global domains (workflow_id IS NULL)
    wf_whitelist = whitelists.get(workflow_id, set())
    global_whitelist = whitelists.get(None, set())
    
    # Combined whitelist for this workflow run
    combined_whitelist = wf_whitelist.union(global_whitelist)

    # If the combined whitelist is empty, it means there are no whitelisted domains
    # configured for this workflow or globally. In this case, all domains pass.
    if not combined_whitelist:
        return True

    domain = article_domain.lower().removeprefix("www.")
    return domain in combined_whitelist
