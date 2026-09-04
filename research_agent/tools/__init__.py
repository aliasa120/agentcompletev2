"""Export deep research tools."""

from .analyze_images_gemini import analyze_images_gemini
from .fetch_images_brave import fetch_images_brave
from .get_design_guide import get_design_guide
from .save_wordpress_post import save_wordpress_post, save_posts_to_supabase
from .social_saver_tools import (
    save_instagram_post,
    save_facebook_post,
    save_youtube_video,
    save_linkedin_post,
    save_twitter_post,
    save_social_bundle,
)
from .think import think_tool

# Unified orchestrator tools (use these in agent.py — not the raw providers below)
from .unified_search import unified_search
from .unified_extract import unified_extract
from .unified_image import create_post_image
from .youtube_transcript import youtube_transcript
from .analyze_attachment import omni_analyzer

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

# ── Hermes-style 3-Layer Memory Tools ────────────────────────────────────
from research_agent.memory.builtin_provider import add_memory, replace_memory, remove_memory
from research_agent.memory.honcho_provider import (
    honcho_profile,
    honcho_search,
    honcho_reasoning,
    honcho_context,
    honcho_conclude,
)
from .search_conversation_history import search_conversation_history, search_memories

# ── Dynamic Tool Routing ──────────────────────────────────────────────────
from .dynamic_router import list_tools, load_tools, unload_unused_tools, build_tools_index, call_tool

# ── Voice & OS access ──────────────────────────────────────────────────────
from .text_to_speech import text_to_speech
from .terminal_tool import terminal

# ── Unified storage ────────────────────────────────────────────────────────
from .upload_to_storage import upload_to_storage

__all__ = [
    # ── Unified tools (exposed to agent) ─────────────────────────────────────
    "unified_search",
    "unified_extract",
    "create_post_image",
    "youtube_transcript",
    "omni_analyzer",
    # ── Memory tools ─────────────────────────────────────────────────────────
    "add_memory",
    "replace_memory",
    "remove_memory",
    "search_conversation_history",
    "search_memories",
    "honcho_profile",
    "honcho_search",
    "honcho_reasoning",
    "honcho_context",
    "honcho_conclude",
    # ── Dynamic Tool Routing ─────────────────────────────────────────────────
    "list_tools",
    "load_tools",
    "unload_unused_tools",
    "build_tools_index",
    "call_tool",
    # ── Support tools ─────────────────────────────────────────────────────────
    "think_tool",
    "fetch_images_brave",
    "analyze_images_gemini",
    "save_wordpress_post",
    "save_posts_to_supabase",
    "save_instagram_post",
    "save_facebook_post",
    "save_youtube_video",
    "save_linkedin_post",
    "save_twitter_post",
    "save_social_bundle",
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
    "build_skills_index",
    # ── Raw providers (not exposed to agent directly) ─────────────────────────
    "linkup_search",
    "tavily_extract",
    "parallel_search",
    "exa_extract",
    "create_post_image_gemini",
    # ── Voice & OS access ──────────────────────────────────────────────────────
    "text_to_speech",
    "terminal",
    # ── Unified storage ────────────────────────────────────────────────────────
    "upload_to_storage",
]
