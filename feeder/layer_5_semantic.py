"""Layer 5: Semantic Similarity (Pinecone Vector Embeddings) — CHECK ONLY.

Per plan spec:
- Convert article title + description to embedding
- Phase 1 (in-batch): Compare against embeddings already accepted in this batch run
- Phase 2 (Pinecone): Query vector store for nearest neighbors
- If similarity >= threshold -> DROP (semantic duplicate)
- If passes -> return (True, embedding_vector) — do NOT store yet
  Storage happens atomically in pipeline after ALL layers pass.

Threshold: 70% cosine similarity (configurable via feeder_settings)
"""
import os
from feeder.models import FeederArticle, LayerResult

_pc = None
_index = None


def _get_pinecone():
    global _pc, _index
    if _pc is None:
        from pinecone import Pinecone
        api_key = os.environ.get("PINECONE_API_KEY", "")
        index_name = os.environ.get("PINECONE_INDEX_NAME", "ai-news-feeder")
        if not api_key:
            raise ValueError("PINECONE_API_KEY not set")
        _pc = Pinecone(api_key=api_key)
        _index = _pc.Index(index_name)
    return _pc, _index


def _embed(text: str, model: str = "multilingual-e5-large") -> list[float]:
    """Generate embedding via Pinecone integrated inference."""
    pc, _ = _get_pinecone()
    result = pc.inference.embed(
        model=model,
        inputs=[text],
        parameters={"input_type": "passage", "truncate": "END"}
    )
    return result[0].values


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def layer_5_semantic(
    article: FeederArticle,
    batch_embeddings: list[tuple[str, list[float]]],  # [(title, embedding), ...]
    threshold: float = 0.70,
    pinecone_top_k: int = 5,
    pinecone_model: str = "multilingual-e5-large",
) -> tuple[bool, str, list[float] | None]:
    """Layer 5: Three-phase semantic similarity check. Does NOT write to Pinecone.

    Args:
        article:           Article to check
        batch_embeddings:  List of (title, embedding) tuples for articles already
                           accepted in this batch run (in-batch check phase)
        threshold:         Cosine similarity cutoff (from feeder_settings, default 0.70)
        pinecone_top_k:    Nearest neighbors to query in Pinecone
        pinecone_model:    Embedding model name

    Returns:
        (passed, drop_reason, embedding_vector)
        - passed=True  → unique, embedding_vector returned for storage by pipeline
        - passed=False → semantic duplicate, embedding_vector=None
    """
    text = f"{article.title} {article.description}"

    try:
        embedding = _embed(text, model=pinecone_model)
    except Exception as e:
        print(f"  [L5] Embedding error for '{article.title[:60]}': {e}")
        # On embedding error, allow through without semantic check
        return True, "", None

    # ----- Phase 1: In-batch semantic similarity check ----------------------
    for batch_title, batch_emb in batch_embeddings:
        score = _cosine_similarity(embedding, batch_emb)
        if score >= threshold:
            print(f"  [L5 DROP in-batch] '{article.title[:60]}' score={score:.3f} >= {threshold} "
                  f"matched batch: '{batch_title[:60]}'")
            return False, f"Semantic duplicate (in-batch, score={score:.2f})", None

    # ----- Phase 2: Pinecone vector store check -----------------------------
    try:
        _, index = _get_pinecone()
        results = index.query(vector=embedding, top_k=pinecone_top_k, include_metadata=True)
        for match in results.matches:
            if match.score >= threshold:
                matched_title = (match.metadata or {}).get("title", "?")
                print(f"  [L5 DROP Pinecone] '{article.title[:60]}' score={match.score:.3f} >= {threshold} "
                      f"matched: '{matched_title[:60]}'")
                return False, f"Semantic duplicate (Pinecone, score={match.score:.2f})", None
    except Exception as e:
        print(f"  [L5] Pinecone query error for '{article.title[:60]}': {e}")
        # On Pinecone error, allow through (don't silently drop)

    # ----- Phase 3: Passes — return embedding for pipeline to store ---------
    return True, "", embedding
