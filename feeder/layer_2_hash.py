"""Layer 2: Hash Verification — CHECK ONLY.
Per plan spec:
- Hash = SHA-256(title + description + url)
- Check if hash exists in feeder_seen_hashes
- If YES -> DROP (no write)
- If NO  -> PASS (storage atomically at pipeline end)
"""
import hashlib
from feeder.db import supabase_client


def compute_hash(title: str, description: str, url: str = "") -> str:
    raw = f"{title.strip().lower()}{description.strip().lower()}{url.strip().lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()


def layer_2_hash(title: str, description: str, url: str = "") -> tuple[bool, str, str]:
    """Layer 2: Hash check only. Returns (is_new, hash, context_note).

    Returns:
        (True, hash, "")            -> NEW
        (False, hash, "Hash in DB") -> DUPLICATE
    """
    h = compute_hash(title, description, url)
    try:
        result = supabase_client.table("feeder_seen_hashes") \
            .select("id").eq("hash", h).execute()
        if result.data:
            return False, h, f"Hash already in DB (exact content duplicate)"
        return True, h, ""
    except Exception as e:
        print(f"  [L2] Hash DB error: {e}")
        return True, h, ""   # on error, allow through
