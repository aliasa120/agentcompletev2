"""Layer 4: NER Fingerprinting — CHECK ONLY.
Per plan spec:
- Extract entities (PERSON, ORG, GPE, EVENT, NORP, LOC, FAC, DATE) from title + description
- MD5 fingerprint of sorted entity set
- Phase 1: In-batch check (fingerprints accepted so far in this run)
- Phase 2: DB check (feeder_seen_fingerprints)
- If duplicate -> DROP (no write)
- If unique -> PASS (storage atomically at pipeline end)
"""
import hashlib
from feeder.db import supabase_client

_nlp = None


def _get_nlp():
    global _nlp
    if _nlp is None:
        try:
            import spacy
            _nlp = spacy.load("en_core_web_sm")
        except Exception as e:
            print(f"  [L4] spaCy load failed: {e}")
            _nlp = False
    return _nlp if _nlp is not False else None


def _extract_entities(title: str, description: str) -> frozenset[str]:
    nlp = _get_nlp()
    if nlp is None:
        return frozenset()
    try:
        doc = nlp(f"{title} {description}")
        return frozenset(
            ent.text.lower().strip()
            for ent in doc.ents
            if ent.label_ in ("PERSON", "ORG", "GPE", "EVENT", "NORP", "LOC", "FAC", "DATE")
        )
    except Exception:
        return frozenset()


def _make_fingerprint(entities: frozenset[str]) -> str:
    if not entities:
        return ""
    key = "|".join(sorted(entities))
    return hashlib.md5(key.encode()).hexdigest()


def layer_4_ner(
    title: str,
    description: str,
    batch_fingerprints_seen: set[str],
) -> tuple[bool, str, str]:
    """Layer 4: NER fingerprint check only. Returns (is_new, fingerprint, context_note).

    Returns:
        (True, fp, "")                   -> PASS (unique NER)
        (False, fp, "matched: ...note") -> DROP (NER duplicate)
    """
    entities = _extract_entities(title, description)
    fingerprint = _make_fingerprint(entities)

    if not fingerprint:
        return True, "", ""   # No entities = can't compare, allow through

    # Phase 1: In-batch check
    if fingerprint in batch_fingerprints_seen:
        return False, fingerprint, f"NER duplicate in batch (fp={fingerprint[:12]})"

    # Phase 2: DB check
    try:
        result = supabase_client.table("feeder_seen_fingerprints") \
            .select("id,title") \
            .eq("fingerprint", fingerprint) \
            .limit(1) \
            .execute()
        if result.data:
            orig_title = result.data[0].get("title", "?")
            return False, fingerprint, f"NER duplicate of DB article: '{orig_title[:60]}'"
    except Exception as e:
        print(f"  [L4] DB error: {e}")

    return True, fingerprint, ""
