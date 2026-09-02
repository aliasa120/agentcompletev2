"""Layer 2: Hash Verification — CHECK ONLY.
Per plan spec:
- Hash = SHA-256(normalized title)
- Check if hash exists in feeder_seen_hashes
- If YES -> DROP (no write)
- If NO  -> PASS (storage atomically at pipeline end)

Normalization (feeder.feed_clean.normalize_for_hash) is deliberate:
lowercased, punctuation stripped, whitespace collapsed, and the RSS source
suffix (" - Dawn") already removed at fetch time. Two outlets publishing the
same wire headline now produce the SAME hash — exact-title duplicates are
caught cross-source instead of only catching re-deliveries of the same item.
(GUID layer still guards exact re-delivery of one feed item.)
"""
import hashlib
from feeder.db import supabase_client
from feeder.feed_clean import normalize_for_hash


def compute_hash(title: str, description: str = "", url: str = "") -> str:
    """Content hash. description/url kept in the signature for call-site
    compatibility but intentionally NOT hashed: they differ per outlet/feed,
    which is exactly what used to let identical headlines slip through."""
    return hashlib.sha256(normalize_for_hash(title).encode()).hexdigest()


def layer_2_hash(title: str, description: str, url: str = "", workflow_id: str = None) -> tuple[bool, str, str]:
    """Layer 2: Hash check only. Returns (is_new, hash, context_note).

    Returns:
        (True, hash, "")            -> NEW
        (False, hash, "Hash in DB") -> DUPLICATE
    """
    h = compute_hash(title, description, url)
    try:
        query = supabase_client.table("feeder_seen_hashes").select("id").eq("hash", h)
        if workflow_id:
            query = query.eq("workflow_id", workflow_id)
        else:
            query = query.is_("workflow_id", "null")
        result = query.execute()
        if result.data:
            return False, h, f"Hash already in DB (same normalized headline seen before)"
        return True, h, ""
    except Exception as e:
        print(f"  [L2] Hash DB error: {e}")
        return True, h, ""   # on error, allow through
