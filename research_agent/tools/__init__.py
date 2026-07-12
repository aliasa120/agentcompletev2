"""Export deep research tools."""

from .analyze_images_gemini import analyze_images_gemini
from .fetch_images_brave import fetch_images_brave
from .get_design_guide import get_design_guide
from .save_to_supabase import save_posts_to_supabase
from .think import think_tool
from .view_candidate_images import view_candidate_images

# Unified orchestrator tools (use these in agent.py — not the raw providers below)
from .unified_search import unified_search
from .unified_extract import unified_extract
from .unified_image import create_post_image
from .youtube_transcript import youtube_transcript
from .analyze_attachment import analyze_attachment

# Raw providers kept for backward compatibility (called internally by unified tools)
from .exa_extract import exa_extract
from .linkup_search import linkup_search
from .parallel_search import parallel_search
from .tavily_extract import tavily_extract
from .create_post_image_gemini import create_post_image_gemini

# ── Blog + WordPress tools ──────────────────────────────────────────────
from .read_skill import read_skill
from .embed_blog_images import embed_images_in_blog
from .wordpress_publisher import get_wordpress_categories, publish_to_wordpress

# ── Skills system (Hermes-style self-improvement) ────────────────────────
from .list_skills import list_skills, build_skills_index
from .manage_skill import manage_skill
from .cronjob import cronjob
from .search_conversation_history import search_conversation_history

# ── Dynamic Tool Routing ──────────────────────────────────────────────────
from .dynamic_router import list_tools, load_tools, unload_unused_tools, build_tools_index, call_tool

__all__ = [
    # ── Unified tools (exposed to agent) ─────────────────────────────────────
    "unified_search",
    "unified_extract",
    "create_post_image",
    "youtube_transcript",
    "analyze_attachment",
    # ── Dynamic Tool Routing ─────────────────────────────────────────────────
    "list_tools",
    "load_tools",
    "unload_unused_tools",
    "build_tools_index",
    "call_tool",
    # ── Support tools ─────────────────────────────────────────────────────────
    "think_tool",
    "fetch_images_brave",
    "view_candidate_images",
    "analyze_images_gemini",
    "save_posts_to_supabase",
    "get_design_guide",
    # ── Blog + WordPress tools ─────────────────────────────────────────────────
    "read_skill",
    "embed_images_in_blog",
    "get_wordpress_categories",
    "publish_to_wordpress",
    # ── Skills system ──────────────────────────────────────────────────────────
    "list_skills",
    "manage_skill",
    "cronjob",
    "search_conversation_history",
    "build_skills_index",
    # ── Raw providers (not exposed to agent directly) ─────────────────────────
    "linkup_search",
    "tavily_extract",
    "parallel_search",
    "exa_extract",
    "create_post_image_gemini",
]


