"""Layer 1: GUID Verification — CHECK ONLY.
Per plan spec:
- Check if article.guid already exists in feeder_seen_guids (Supabase)
- If YES -> DROP (no write)
- If NO  -> PASS (storage happens atomically at pipeline end)
"""
from feeder.db import supabase_client


def layer_1_guid(guid: str, workflow_id: str = None) -> tuple[bool, str]:
    """Returns (is_new, context_note). Does NOT write to DB.

    Returns:
        (True, "")             -> NEW, pass to Layer 2
        (False, "GUID exists") -> DUPLICATE, drop
    """
    try:
        query = supabase_client.table("feeder_seen_guids").select("id").eq("guid", guid)
        if workflow_id:
            query = query.eq("workflow_id", workflow_id)
        else:
            query = query.is_("workflow_id", "null")
        result = query.execute()
        if result.data:
            return False, f"GUID already in DB: {guid[:40]}..."
        return True, ""
    except Exception as e:
        print(f"  [L1] GUID DB error: {e}")
        return True, ""   # on error, allow through
