"""Feeder Dedup Agent

Replaces L3 (Fuzzy), L4 (NER) and L5 (Semantic) with an LLM-based agent
that understands meaning, not just string similarity.

Two-phase deduplication:
  Phase 1 — In-batch: Given the current batch articles, group by event/topic.
             Keep only ONE per event cluster (prefer detailed + higher-domain source).
  Phase 2 — DB comparison: Given the last N DB titles, drop any batch articles
             that are already covered in the DB.

Model: cerebras/gpt-oss-120b via existing LiteLLM proxy
"""
