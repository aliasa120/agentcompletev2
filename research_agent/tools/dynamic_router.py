"""Advanced Dynamic Tool Indexing, Loading, and Routing (Three-Mode Approach).

This module provides tools and helper functions to dynamically catalog,
search, load, and execute tools under three distinct delivery modes:
1. Primary (Fully bound at startup)
2. Normal Index (Prompt-injected catalog like skills, loaded on demand)
3. Vector Index (Pinecone search, loaded on demand)
"""

import os
import tempfile
import json
import logging
import re
from typing import List, Dict, Any, Optional
from langchain_core.tools import tool, BaseTool
from langchain_core.utils.function_calling import convert_to_openai_tool

# Configure logging
logger = logging.getLogger("dynamic_router")

from research_agent.plugins import (
    enabled_plugins_from_bootstrap,
    is_tool_allowed,
)

# Import all core tools to build the Master Registry
from research_agent.tools.unified_search import unified_search
from research_agent.tools.unified_extract import unified_extract
from research_agent.tools.unified_image import create_post_image
from research_agent.tools.youtube_transcript import youtube_transcript
from research_agent.tools.think import think_tool
from research_agent.tools.fetch_images_brave import fetch_images_brave
from research_agent.tools.analyze_images_gemini import analyze_images_gemini
from research_agent.tools.save_wordpress_post import save_wordpress_post, save_posts_to_supabase
from research_agent.tools.social_saver_tools import (
    save_instagram_post,
    save_facebook_post,
    save_youtube_video,
    save_linkedin_post,
    save_twitter_post,
    save_social_bundle,
)
from research_agent.tools.get_design_guide import get_design_guide
from research_agent.tools.read_skill import read_skill
from research_agent.tools.list_skills import list_skills
from research_agent.tools.manage_skill import manage_skill
from research_agent.tools.wordpress_publisher import get_wordpress_categories, publish_to_wordpress
from research_agent.tools.analyze_attachment import omni_analyzer
from research_agent.memory.builtin_provider import (
    add_memory,
    replace_memory,
    remove_memory,
)
from research_agent.tools.search_conversation_history import search_conversation_history
from research_agent.memory.honcho_provider import (
    honcho_profile,
    honcho_search,
    honcho_reasoning,
    honcho_context,
    honcho_conclude,
)
from research_agent.tools.text_to_speech import text_to_speech
from research_agent.tools.terminal_tool import terminal
from research_agent.tools.upload_to_storage import upload_to_storage

# Registry mapping tool names to actual tool objects
TOOL_OBJECTS: Dict[str, BaseTool] = {
    "unified_search": unified_search,
    "unified_extract": unified_extract,
    "create_post_image": create_post_image,
    "youtube_transcript": youtube_transcript,
    "think_tool": think_tool,
    "fetch_images_brave": fetch_images_brave,
    "analyze_images_gemini": analyze_images_gemini,
    "save_wordpress_post": save_wordpress_post,
    "save_posts_to_supabase": save_posts_to_supabase,
    "save_instagram_post": save_instagram_post,
    "save_facebook_post": save_facebook_post,
    "save_youtube_video": save_youtube_video,
    "save_linkedin_post": save_linkedin_post,
    "save_twitter_post": save_twitter_post,
    "save_social_bundle": save_social_bundle,
    "get_design_guide": get_design_guide,
    "read_skill": read_skill,
    "list_skills": list_skills,
    "manage_skill": manage_skill,
    "get_wordpress_categories": get_wordpress_categories,
    "publish_to_wordpress": publish_to_wordpress,
    # Hermes-style 3-Layer Memory tools
    "add_memory": add_memory,
    "replace_memory": replace_memory,
    "remove_memory": remove_memory,
    "search_conversation_history": search_conversation_history,
    "honcho_profile": honcho_profile,
    "honcho_search": honcho_search,
    "honcho_reasoning": honcho_reasoning,
    "honcho_context": honcho_context,
    "honcho_conclude": honcho_conclude,
    "omni_analyzer": omni_analyzer,
    # Backward-compat alias for pre-rename tool_key rows
    "analyze_attachment": omni_analyzer,
    "text_to_speech": text_to_speech,
    "terminal": terminal,
    "upload_to_storage": upload_to_storage,
}

# Rich tool metadata including descriptions, keywords (synonyms), and example triggers
TOOLS_METADATA: Dict[str, Dict[str, Any]] = {
    "omni_analyzer": {
        "short_description": "Universal file analysis tool — analyze any file via URL, attachment, or data.",
        "keywords": ["analyze file", "inspect file", "analyze image", "analyze audio", "analyze video", "analyze pdf", "analyze document", "analyze url", "omni analyzer", "file analysis", "inspect brand assets", "analyze multiple files"],
        "example_triggers": [
            "What's in this image?",
            "Summarize this video",
            "Transcribe this audio",
            "Extract text from this PDF",
            "Analyze the file at this URL"
        ]
    },
    "youtube_transcript": {
        "short_description": "Extract full transcript from public YouTube videos as structured Markdown.",
        "keywords": ["youtube", "transcript", "youtube transcript", "video transcript", "video subtitles", "video text", "extract subtitles"],
        "example_triggers": [
            "Get the transcript of this YouTube video.",
            "Extract subtitles from this YouTube link.",
            "Read what is said in this video ID dQw4w9WgXcQ."
        ]
    },
    "unified_search": {
        "short_description": "Search the web for news, facts, and general information about a topic.",
        "keywords": ["search", "web search", "google", "brave", "tavily", "linkup", "find facts", "lookup"],
        "example_triggers": [
            "Search for the latest news on Pakistan economy.",
            "Find information about the prime minister's statement.",
            "Search the web to verify these numbers."
        ]
    },
    "unified_extract": {
        "short_description": "Extract full main content from specific URLs.",
        "keywords": ["extract", "scrape", "read url", "url text", "page content", "download article"],
        "example_triggers": [
            "Extract the article content from this Dawn link.",
            "Scrape the text of this news page.",
            "Read what is on this URL."
        ]
    },
    "create_post_image": {
        "short_description": "Generate a visual post image with overlays in THE ECHO brand style.",
        "keywords": ["generate image", "create image", "post image", "visual overlay", "brand design", "draw picture"],
        "example_triggers": [
            "Create a social media post image for this story.",
            "Generate the image banner in brand style.",
            "Make a visual image with text overlay."
        ]
    },
    "think_tool": {
        "short_description": "Strategic pause for reflection, analyzing findings, and planning next steps.",
        "keywords": ["think", "reflect", "strategic plan", "decision", "gap assessment", "reason"],
        "example_triggers": [
            "I need to evaluate my search results.",
            "Let me think about what information is missing.",
            "Reflect on our current findings."
        ]
    },
    "fetch_images_brave": {
        "short_description": "Search Brave for raw images and candidate news photo URLs.",
        "keywords": ["find images", "search photos", "brave images", "image urls", "lookup pictures"],
        "example_triggers": [
            "Find candidate images for the article.",
            "Search Brave for photos of Imran Khan.",
            "Get image URLs for this news topic."
        ]
    },
    "analyze_images_gemini": {
        "short_description": "Use Gemini Vision to analyze candidate images against brand guide and output an editing prompt.",
        "keywords": ["analyze image", "image prompt creator", "gemini vision", "check brand style", "design analysis"],
        "example_triggers": [
            "Analyze these candidate images with Gemini.",
            "Create an editing prompt for the social image using vision.",
            "Assess style compliance of the selected photo."
        ]
    },
    "save_wordpress_post": {
        "short_description": "Save a generated WordPress blog post with title, category, and markdown content to database.",
        "keywords": ["save wordpress post", "save blog post", "store article", "draft wordpress", "save article to db"],
        "example_triggers": [
            "Save this blog post to database.",
            "Save the article draft for WordPress.",
            "Store the written post in the database."
        ]
    },
    "save_posts_to_supabase": {
        "short_description": "Save final blog and social posts to the database.",
        "keywords": ["save posts", "save database", "supabase save", "store articles", "commit post"],
        "example_triggers": [
            "Save the finalized social posts to Supabase.",
            "Store the written posts in the database.",
            "Save this post to the DB."
        ]
    },
    "save_instagram_post": {
        "short_description": "Save an Instagram post, reel, or carousel with caption and media URL.",
        "keywords": ["save instagram", "save insta", "save reel", "post to instagram", "instagram reel saver"],
        "example_triggers": [
            "Save this Instagram reel to database.",
            "Save the Instagram post draft.",
            "Create and save an Insta reel."
        ]
    },
    "save_facebook_post": {
        "short_description": "Save a Facebook page post, photo, or video reel.",
        "keywords": ["save facebook", "save fb", "facebook post saver", "fb reel", "facebook photo"],
        "example_triggers": [
            "Save this Facebook post to database.",
            "Save the FB video reel.",
            "Save post for my Facebook page."
        ]
    },
    "save_youtube_video": {
        "short_description": "Save a YouTube video or Shorts upload draft with title, tags, and custom thumbnail.",
        "keywords": ["save youtube", "save yt", "youtube shorts", "upload youtube draft", "youtube video saver"],
        "example_triggers": [
            "Save this YouTube video draft.",
            "Save YouTube Shorts with thumbnail.",
            "Save video draft to YouTube posts."
        ]
    },
    "save_linkedin_post": {
        "short_description": "Save a LinkedIn post, thought leadership commentary, photo, video, or article share.",
        "keywords": ["save linkedin", "linkedin post", "linkedin article", "save linkedin video", "linkedin commentary", "post to linkedin"],
        "example_triggers": [
            "Save this LinkedIn post with hashtags.",
            "Save this video with caption on LinkedIn.",
            "Save this article share to LinkedIn."
        ]
    },
    "save_twitter_post": {
        "short_description": "Save an X (Twitter) post or tweet with optional photo/video attachment from R2.",
        "keywords": ["save twitter", "save x", "tweet saver", "post to x", "save tweet", "twitter video", "x post"],
        "example_triggers": [
            "Save this tweet to X.",
            "Save this video with caption on X.",
            "Save this photo post to Twitter."
        ]
    },
    "save_social_bundle": {
        "short_description": "Save a multi-platform social media campaign across Instagram, Facebook, YouTube, X, and LinkedIn.",
        "keywords": ["save social bundle", "multi platform post", "campaign save", "save all social posts"],
        "example_triggers": [
            "Save this cross-platform social campaign.",
            "Save posts for Instagram, Facebook, YouTube, X, and LinkedIn.",
            "Save the social bundle to database."
        ]
    },
    "get_design_guide": {
        "short_description": "Read the THE ECHO brand design guide (design.md) containing layout and color specs.",
        "keywords": ["design guide", "brand rules", "color palette", "logo specs", "style guidelines"],
        "example_triggers": [
            "Get the brand style specifications.",
            "Read the design.md file for color codes.",
            "What are the brand guide colors and layout?"
        ]
    },
    "read_skill": {
        "short_description": "Load a skill instruction file from disk and return its full content.",
        "keywords": ["read skill", "load skill", "skill instructions", "blog post writer guide", "runbook"],
        "example_triggers": [
            "Read instructions for blog post writer.",
            "Load the seo optimizer skill file.",
            "Get skill runbook content."
        ]
    },
    "list_skills": {
        "short_description": "List all available skills with their names, descriptions, and categories.",
        "keywords": ["list skills", "discover skills", "available skills", "skills catalog", "find skill"],
        "example_triggers": [
            "List the available skills in the library.",
            "What skills do I have access to?",
            "Search for a skill."
        ]
    },
    "manage_skill": {
        "short_description": "Create, update, delete or track usage of skills in the library.",
        "keywords": ["manage skill", "create skill", "update skill", "edit skill", "save skill"],
        "example_triggers": [
            "Create a new skill for this task.",
            "Update the blog post writer skill with new rules.",
            "Delete an obsolete skill."
        ]
    },
    "get_wordpress_categories": {
        "short_description": "Retrieve categories and tags from the WordPress site.",
        "keywords": ["wordpress categories", "wp tags", "wp categories", "fetch wp sections"],
        "example_triggers": [
            "Get available categories on WordPress.",
            "Fetch the WP category list.",
            "What categories exist on our website?"
        ]
    },
    "publish_to_wordpress": {
        "short_description": "Publish a finalized blog post to WordPress as a draft or live article.",
        "keywords": ["publish wordpress", "wp post", "upload blog", "publish draft", "wordpress upload"],
        "example_triggers": [
            "Publish this blog post to WordPress.",
            "Upload the draft post to WP.",
            "Send the article to the WordPress site."
        ]
    },
    "search_memories": {
        "short_description": "Search for relevant past memories (such as user preferences, past choices, or installed tools) semantically.",
        "keywords": ["search memory", "find fact", "query memories", "recall", "get preference", "who am i", "my settings"],
        "example_triggers": [
            "Search memories for the user's favorite drink.",
            "Find past facts about this user.",
            "Recall user preferences."
        ]
    },
    "text_to_speech": {
        "short_description": "Convert text to speech audio file link (ElevenLabs / Edge / OpenAI TTS).",
        "keywords": ["text to speech", "tts", "voice reply", "speak text", "audio answer", "audio message", "read aloud"],
        "example_triggers": [
            "Say this in voice audio.",
            "Convert my summary to speech audio.",
            "Read this aloud to me as audio."
        ]
    },
    "terminal": {
        "short_description": "Execute OS terminal shell commands with smart human-in-the-loop approval.",
        "keywords": ["terminal", "shell command", "run command", "os command", "cmd", "exec", "powershell"],
        "example_triggers": [
            "Run git status in terminal.",
            "Execute shell command ls -la.",
            "Check disk space via command line."
        ]
    },
    "upload_to_storage": {
        "short_description": "Upload a local file to cloud storage (Cloudflare R2 / Supabase) and return a public shareable link.",
        "keywords": [
            "upload", "upload file", "upload to storage", "storage link", "share link",
            "public url", "download link", "shareable link", "get link", "give me link",
            "r2", "cloudflare r2", "cloud storage", "host file", "publish file",
        ],
        "example_triggers": [
            "Make this PDF and give me its link.",
            "Upload the chart image and share the URL.",
            "I need a download link for the report.",
            "Upload this video to storage so I can post it."
        ]
    }
}

# Fallback tools grouped by category if semantic search yields no results
FALLBACK_CATEGORIES: Dict[str, List[str]] = {
    "search": ["unified_search", "fetch_images_brave"],
    "extract": ["unified_extract", "youtube_transcript"],
    "content": ["create_post_image", "analyze_images_gemini", "get_design_guide"],
    "skills": ["read_skill", "list_skills", "manage_skill"],
    "storage": ["upload_to_storage"],
    "publishing": [
        "get_wordpress_categories",
        "publish_to_wordpress",
        "save_wordpress_post",
        "save_posts_to_supabase",
        "save_instagram_post",
        "save_facebook_post",
        "save_youtube_video",
        "save_linkedin_post",
        "save_twitter_post",
        "save_social_bundle",
        "upload_to_storage",
    ],
    "reasoning": ["think_tool"]
}


def sync_pinecone_vector_index(client) -> None:
    """Deprecate Pinecone sync. Vector indexing is replaced by Super Indexing."""
    pass


def generate_tool_metadata(tool_name: str, raw_description: str) -> Dict[str, Any]:
    """Generate tool metadata (short description, keywords, and triggers) using a pure-Python parser."""
    logger.info(f"Generating enriched metadata for tool '{tool_name}' via pure-Python...")
    try:
        # 1. Truncate description: Take the first sentence/line, cap at 200 chars
        first_sentence = raw_description.split(".")[0].split("\n")[0].strip()
        if len(first_sentence) > 200:
            short_desc = first_sentence[:197] + "..."
        else:
            short_desc = first_sentence if first_sentence else tool_name.replace("_", " ")

        # 2. Extract keywords from tool name and description
        # Split name (e.g. "GMAIL_SEND_EMAIL" -> ["gmail", "send", "email"])
        words = [w.lower() for w in tool_name.split("_") if w]
        
        # Filter out stop words from the description
        desc_words = [w.strip(".,;:?!()\"'").lower() for w in raw_description.split()]
        stop_words = {"the", "a", "an", "and", "or", "but", "to", "for", "in", "on", "at", "with", "this", "that", "it", "is", "are", "was", "use", "tool"}
        important_desc_words = [w for w in desc_words if len(w) > 3 and w not in stop_words]
        
        # Collect up to 6 unique keywords
        seen = set()
        keywords = []
        for w in words + important_desc_words:
            if w not in seen and len(seen) < 6:
                seen.add(w)
                keywords.append(w)
                
        # 3. Create generic example triggers
        clean_name = tool_name.replace("_", " ").lower()
        example_triggers = [
            f"run {clean_name}",
            f"use the {clean_name} tool",
            f"execute {clean_name}"
        ]
        
        return {
            "short_description": short_desc,
            "keywords": keywords,
            "example_triggers": example_triggers
        }
    except Exception as e:
        logger.warning(f"Failed to generate pure-Python metadata for '{tool_name}': {e}. Using fallback values.")
        short_desc = raw_description
        if len(short_desc) > 200:
            short_desc = short_desc[:197] + "..."
        return {
            "short_description": short_desc,
            "keywords": [tool_name.replace("_", " ")],
            "example_triggers": [f"run {tool_name}"]
        }


def _enabled_plugins_from_db() -> set:
    """Fetch the enabled plugin set from Supabase (all enabled on failure)."""
    from research_agent.plugins import enabled_plugins_from_db
    return enabled_plugins_from_db()


def get_allowed_routing_tools(agent_id: str) -> Dict[str, set[str]]:
    """Retrieve the set of tool keys assigned to this agent grouped by resolved loading mode ('normal' or 'super')."""
    result = {"normal": set(), "super": set()}
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
        if not url or not key:
            return result
        client = create_client(url, key)

        # Call get_backend_bootstrap_data RPC to bypass RLS
        bootstrap_resp = client.rpc("get_backend_bootstrap_data").execute()
        bootstrap = bootstrap_resp.data or {}

        # Filter assignments for this agent
        all_assignments = bootstrap.get("agent_tool_assignments") or []
        assignments = [a for a in all_assignments if a.get("agent_id") == agent_id and a.get("enabled") == True]
        if not assignments:
            return result

        # Resolve user_id from agent_configs
        all_configs = bootstrap.get("agent_configs") or []
        agent_cfg = next((c for c in all_configs if c.get("id") == agent_id), None)
        user_id = agent_cfg.get("user_id") if agent_cfg else None

        # Filter settings by user_id
        all_settings = bootstrap.get("agent_settings") or []
        db_settings = {}
        for row in all_settings:
            row_uid = row.get("user_id")
            if user_id:
                if row_uid == user_id or not row_uid:
                    db_settings[row["key"]] = row["value"]
            else:
                if not row_uid:
                    db_settings[row["key"]] = row["value"]

        super_enabled = db_settings.get("super_indexing_enabled", "true").lower() == "true"
        normal_enabled = db_settings.get("normal_indexing_enabled", "true").lower() == "true"

        # Parse built-in tools loading modes
        builtin_loading_modes_str = db_settings.get("builtin_tools_loading_modes", "{}")
        try:
            builtin_loading_modes = json.loads(builtin_loading_modes_str)
        except Exception:
            builtin_loading_modes = {}

        # Fetch global MCP tool settings
        all_mcp_settings = bootstrap.get("mcp_tool_settings") or []
        mcp_tool_modes = {row["tool_key"]: row["loading_mode"] for row in all_mcp_settings}

        enabled_plugins = enabled_plugins_from_bootstrap(bootstrap)

        for a in assignments:
            t_key = a.get("tool_key")
            t_type = a.get("tool_type")

            if t_type == "builtin" and not is_tool_allowed(t_key, enabled_plugins):
                continue

            # Resolve global loading mode
            mode = a.get("loading_mode")
            if not mode:
                if t_type == "builtin":
                    mode = builtin_loading_modes.get(t_key, "primary")
                else:  # mcp
                    mode = mcp_tool_modes.get(t_key, "primary")

            if t_key in ["list_tools", "load_tools", "call_tool"]:
                mode = "primary"

            # Map legacy vector to super
            if mode == "vector":
                mode = "super"

            # Apply override if disabled
            if mode == "super" and not super_enabled:
                mode = "primary"
            if mode == "normal" and not normal_enabled:
                mode = "primary"

            if mode in result:
                result[mode].add(t_key)

        return result
    except Exception as e:
        logger.warning(f"Failed to resolve allowed routing tools: {e}")
        return result


# Hardcoded manifests for popular MCP connections (one-sentence overview of capabilities)
MCP_MANIFESTS: Dict[str, str] = {
    "googledocs": "Use this to read, create, format, and insert content into Google Docs documents.",
    "gmail": "Use this to compose, send, receive, search, and manage emails.",
    "googlesheets": "Use this to create spreadsheets, add/edit worksheets, update rows, and manage Google Sheets data.",
    "googletasks": "Use this to create task lists, add tasks, update task status, and manage Google Tasks.",
    "microsoftexcel": "Use this to create workbooks, manage worksheets, add rows, find rows, and update spreadsheet data in Microsoft Excel.",
    "excel": "Use this to create workbooks, manage worksheets, add rows, find rows, and update spreadsheet data in Microsoft Excel.",
    "googleforms": "Use this to interact with Google Forms, retrieve form info, and make API requests.",
    "wordpress": "Use this to retrieve categories, create, publish, and manage blog posts on WordPress.",
    "hubspot": "Use this to search, create, update, and manage CRM contacts, companies, and deals.",
    "github": "Use this to manage repositories, create issues, view pull requests, and review code.",
    "slack": "Use this to send messages, read channels, and manage communications on Slack.",
    "linear": "Use this to track issues, update tasks, and manage project workflows in Linear.",
    "database": "Use this to query tables, run SQL commands, and modify relational database contents.",
}

def build_tools_index(agent_id: str) -> str:
    """Build a compact tools catalog (index catalog like skills) for injection into the system prompt.

    Aggregates Normal-indexed tools into <available_tools>, and summarizes Super-indexed
    MCP connections into <super_index_mcps> with active tool counts and manifests.
    """
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
        if not url or not key:
            return ""
        client = create_client(url, key)

        # Call get_backend_bootstrap_data RPC to bypass RLS
        bootstrap_resp = client.rpc("get_backend_bootstrap_data").execute()
        bootstrap = bootstrap_resp.data or {}

        allowed = get_allowed_routing_tools(agent_id)
        normal_keys = allowed.get("normal", set())
        super_keys = allowed.get("super", set())

        if not normal_keys and not super_keys:
            return ""

        # Get assigned tools for this agent
        all_assignments = bootstrap.get("agent_tool_assignments") or []
        assignments = [a for a in all_assignments if a.get("agent_id") == agent_id and a.get("enabled") == True]

        prompt_sections = []

        # ── 1. Compile Normal Index Prompt Block ──
        if normal_keys:
            builtin_keys = {a["tool_key"] for a in assignments if a["tool_type"] == "builtin" and a["tool_key"] in normal_keys}
            mcp_keys = {a["tool_key"] for a in assignments if a["tool_type"] == "mcp" and a["tool_key"] in normal_keys}

            tool_descriptions = {}

            # Resolve built-in tool descriptions
            for key_name in builtin_keys:
                meta = TOOLS_METADATA.get(key_name)
                if meta:
                    tool_descriptions[key_name] = meta["short_description"]
                elif key_name in TOOL_OBJECTS:
                    tool_descriptions[key_name] = TOOL_OBJECTS[key_name].description.split("\n")[0][:120]

            # Resolve MCP tool descriptions from connections metadata
            if mcp_keys:
                try:
                    active_conns = bootstrap.get("mcp_connections") or []
                    for conn in active_conns:
                        available = conn.get("available_tools") or []
                        for t in available:
                            if isinstance(t, dict):
                                t_key = t.get("tool_key")
                                if t_key in mcp_keys:
                                    desc = t.get("description") or t.get("tool_name", t_key)
                                    tool_descriptions[t_key] = desc.split("\n")[0][:120]
                except Exception as e:
                    logger.warning(f"Error resolving MCP descriptions: {e}")

            # Group and build compact catalog
            lines = []
            for name in sorted(tool_descriptions.keys()):
                desc = tool_descriptions[name]
                lines.append(f"    - {name}: {desc}")

            if lines:
                index_body = "\n".join(lines)
                prompt_sections.append(
                    "## Available Tools Catalog (load before use)\n"
                    "Before using any tool listed below, you MUST call load_tools(tool_names=['tool_name']) "
                    "first to inspect its parameters, then call it using call_tool(tool_name='tool_name', arguments={...}).\n\n"
                    "<available_tools>\n"
                    f"{index_body}\n"
                    "</available_tools>"
                )

        # ── 2. Compile Super Index Prompt Block ──
        if super_keys:
            active_conns = bootstrap.get("mcp_connections") or []

            mcp_super_counts = {}
            for conn in active_conns:
                slug = conn.get("toolkit_slug") or conn.get("label") or "mcp"
                label = conn.get("label") or slug
                available = conn.get("available_tools") or []
                
                conn_super_tools = []
                for t in available:
                    t_key = None
                    if isinstance(t, dict):
                        t_key = t.get("tool_key")
                    elif isinstance(t, str):
                        t_key = t
                    
                    if t_key and t_key in super_keys:
                        conn_super_tools.append(t_key)
                
                if conn_super_tools:
                    mcp_super_counts[slug] = {
                        "label": label,
                        "count": len(conn_super_tools)
                    }

            super_lines = []
            for slug, info in sorted(mcp_super_counts.items()):
                label = info["label"]
                count = info["count"]
                
                # Retrieve manifest
                clean_slug = re.sub(r'[^a-zA-Z0-9]', '', slug.lower())
                clean_label = re.sub(r'[^a-zA-Z0-9]', '', label.lower())
                manifest = MCP_MANIFESTS.get(clean_slug) or MCP_MANIFESTS.get(clean_label)
                if not manifest:
                    for k, v in MCP_MANIFESTS.items():
                        if k in clean_slug or k in clean_label:
                            manifest = v
                            break
                if not manifest:
                    manifest = f"Access tools for {label} integration."

                super_lines.append(f"  - {slug} ({count} tools active): {manifest}")

            if super_lines:
                super_body = "\n".join(super_lines)
                prompt_sections.append(
                    "## Connected MCP Servers (Super Index)\n"
                    "You also have access to the following Model Context Protocol (MCP) servers. Do NOT call their tools directly. "
                    "If you need to use them, you MUST first search/list their tools using list_tools(mcp_name=\"<mcp_name>\") "
                    "to discover available tools and their short descriptions, then load the specific tool schema using load_tools(tool_names=[\"<tool_name>\"]), "
                    "and finally execute it using call_tool(tool_name=\"<tool_name>\", arguments={...}).\n\n"
                    "<super_index_mcps>\n"
                    f"{super_body}\n"
                    "</super_index_mcps>"
                )

        return "\n\n".join(prompt_sections)
    except Exception as e:
        logger.warning(f"Failed to build tools index: {e}")
        return ""


@tool(parse_docstring=True)
def list_tools(
    query: Optional[str] = None,
    mcp_name: Optional[str] = None,
    agent_id: Optional[str] = None,
    config: Optional[Any] = None,
) -> str:
    """Perform tool discovery.

    If mcp_name is provided, retrieves all active tools for that specific MCP connection
    assigned to the agent.
    If query is provided, performs a local lexical keyword search on normal-indexed tools.

    Args:
        query: Natural language query describing what task you need to perform (optional).
        mcp_name: The name of the MCP connection (e.g., 'googledocs', 'gmail') to list its tools (optional).
    """
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
        client = None
        if url and key:
            client = create_client(url, key)

        # Call get_backend_bootstrap_data RPC to bypass RLS
        bootstrap = {}
        if client:
            try:
                bootstrap_resp = client.rpc("get_backend_bootstrap_data").execute()
                bootstrap = bootstrap_resp.data or {}
            except Exception as e:
                logger.warning(f"Failed to fetch bootstrap data in list_tools: {e}")

        # 1. Handle MCP Connection discovery if mcp_name is provided
        if mcp_name and client:
            # Retrieve assigned tools for the agent to filter
            assigned_keys = None
            if agent_id:
                all_assignments = bootstrap.get("agent_tool_assignments") or []
                assigned_keys = {a["tool_key"] for a in all_assignments if a.get("agent_id") == agent_id and a.get("enabled") == True}

            # Retrieve active MCP connections from bootstrap
            active_conns = bootstrap.get("mcp_connections") or []

            # Find the one matching mcp_name (fuzzy/normalized match)
            target_conn = None
            mcp_name_clean = re.sub(r'[^a-zA-Z0-9]', '', mcp_name.lower())
            for conn in active_conns:
                slug = re.sub(r'[^a-zA-Z0-9]', '', (conn.get("toolkit_slug") or "").lower())
                label = re.sub(r'[^a-zA-Z0-9]', '', (conn.get("label") or "").lower())
                if (mcp_name_clean and (mcp_name_clean == slug or mcp_name_clean == label or mcp_name_clean in slug or mcp_name_clean in label or (slug and slug in mcp_name_clean) or (label and label in mcp_name_clean))):
                    target_conn = conn
                    break

            if not target_conn:
                return json.dumps({
                    "message": f"No active MCP connection found matching name '{mcp_name}'."
                }, indent=2)

            available = target_conn.get("available_tools") or []
            results = []
            for t in available:
                if isinstance(t, dict):
                    t_key = t.get("tool_key") or t.get("tool_name") or t.get("name")
                    desc = t.get("description") or t.get("short_description") or t_key
                else:
                    t_key = t
                    desc = t

                if t_key:
                    if assigned_keys is None or t_key in assigned_keys:
                        short_desc = desc.split("\n")[0][:120]
                        results.append({
                            "tool_name": t_key,
                            "short_description": short_desc
                        })

            return json.dumps(results, indent=2)

        # 2. Otherwise run lexical keyword matching on all assigned tools (normal & super)
        if not query:
            return json.dumps({
                "message": "Please provide either a 'query' for search, or an 'mcp_name' to list MCP tools."
            }, indent=2)

        # Resolve allowed tools (both normal and super indexed)
        allowed_tools = None
        if agent_id:
            allowed = get_allowed_routing_tools(agent_id)
            allowed_tools = allowed.get("normal", set()).union(allowed.get("super", set()))
        else:
            enabled_plugins = _enabled_plugins_from_db()
            allowed_tools = {k for k in TOOL_OBJECTS if is_tool_allowed(k, enabled_plugins)}

        mcp_tools = []
        if client:
            try:
                active_conns = bootstrap.get("mcp_connections") or []
                for conn in active_conns:
                    available = conn.get("available_tools") or []
                    for t in available:
                        if isinstance(t, dict):
                            mcp_tools.append(t)
                            if not agent_id:
                                t_key = t.get("tool_key")
                                if t_key:
                                    allowed_tools.add(t_key)
            except Exception as e:
                logger.warning(f"Error fetching MCP tools for lexical search: {e}")

        lexical_scores = {}
        query_words = [w.lower() for w in re.split(r'\W+', query) if len(w) >= 2]

        for t_name in allowed_tools:
            score = 0.0
            t_words = [w.lower() for w in t_name.split("_") if w]
            t_desc = ""
            t_keywords = []

            # Resolve description and keywords
            if t_name in TOOLS_METADATA:
                meta = TOOLS_METADATA[t_name]
                t_desc = meta.get("short_description", "").lower()
                t_keywords = [k.lower() for k in meta.get("keywords", [])]
            else:
                mcp_match = next((t for t in mcp_tools if t.get("tool_key") == t_name or t.get("tool_name") == t_name), None)
                if mcp_match:
                    t_desc = (mcp_match.get("description") or "").lower()
                    t_keywords = [w.lower() for w in (mcp_match.get("tool_name") or "").split("_") if w]

            # Score matching
            for qw in query_words:
                if qw == t_name.lower():
                    score += 50.0  # Exact name match
                elif qw in t_words:
                    score += 25.0  # Token match in name
                elif any(qw in tw or tw in qw for tw in t_words):
                    score += 12.0  # Substring match with name tokens

            for kw in t_keywords:
                for qw in query_words:
                    if qw == kw:
                        score += 15.0
                    elif qw in kw or kw in qw:
                        score += 6.0

            for qw in query_words:
                if qw in t_desc:
                    score += 5.0

            if score > 0.0:
                lexical_scores[t_name] = score

        combined = []
        for t_name in allowed_tools:
            l_score = lexical_scores.get(t_name, 0.0)
            norm_lex = min(l_score / 50.0, 1.0)

            if norm_lex > 0.15:
                desc = ""
                if t_name in TOOLS_METADATA:
                    desc = TOOLS_METADATA[t_name].get("short_description", "")
                else:
                    mcp_match = next((t for t in mcp_tools if t.get("tool_key") == t_name or t.get("tool_name") == t_name), None)
                    if mcp_match:
                        desc = mcp_match.get("description") or t_name
                    else:
                        desc = t_name.replace("_", " ")

                if len(desc) > 120:
                    desc = desc[:117] + "..."

                combined.append({
                    "tool_name": t_name,
                    "short_description": desc,
                    "score": norm_lex
                })

        combined.sort(key=lambda x: x["score"], reverse=True)

        if not combined:
            logger.info(f"No lexical matches found for query '{query}'. Returning fallback category list.")
            filtered_fallbacks = {}
            for cat, tools in FALLBACK_CATEGORIES.items():
                filtered_tools = [t for t in tools if t in allowed_tools]
                if filtered_tools:
                    filtered_fallbacks[cat] = filtered_tools
            return json.dumps({
                "message": "No matching tools found for your query. Here is the fallback category catalog.",
                "fallback_categories": filtered_fallbacks
            }, indent=2)

        results = [{"tool_name": item["tool_name"], "short_description": item["short_description"]} for item in combined[:5]]
        logger.info(f"Successfully retrieved {len(results)} matching tools for query '{query}'")
        return json.dumps(results, indent=2)

    except Exception as e:
        logger.error(f"Error executing list_tools: {e}", exc_info=True)
        return json.dumps({
            "error": f"Failed to perform tool search: {e}",
            "message": "Returning fallback category catalog due to error.",
            "fallback_categories": FALLBACK_CATEGORIES
        }, indent=2)


def get_tool_permission_mode(tool_name: str, agent_id: Optional[str] = None, user_id: Optional[str] = None) -> str:
    """Retrieve the permission mode ('always_allow', 'ask', 'deny') for a tool from Supabase/cache."""
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
        if not url or not key:
            return "always_allow"
        client = create_client(url, key)

        # 1. Check mcp_tool_settings table directly for this tool_key
        try:
            mcp_res = client.table("mcp_tool_settings").select("permission_mode").eq("tool_key", tool_name).execute()
            if mcp_res.data and len(mcp_res.data) > 0:
                p_mode = mcp_res.data[0].get("permission_mode")
                if p_mode:
                    return p_mode
        except Exception:
            pass

        # 2. Check bootstrap / agent_settings
        bootstrap_resp = client.rpc("get_backend_bootstrap_data").execute()
        bootstrap = bootstrap_resp.data or {}
        all_settings = bootstrap.get("agent_settings") or []
        for row in all_settings:
            k = row.get("key")
            v = row.get("value")
            if k in ("mcp_tools_permission_modes", "builtin_tools_permission_modes") and v:
                try:
                    parsed = json.loads(v) if isinstance(v, str) else v
                    if tool_name in parsed:
                        return parsed[tool_name]
                except Exception:
                    pass
        return "always_allow"
    except Exception as e:
        logger.warning(f"Failed to get tool permission mode for '{tool_name}': {e}")
        return "always_allow"


def get_tool_bindings(agent_id: Optional[str], tool_name: str) -> Dict[str, Any]:
    """Retrieve parameter bindings for a tool from agent_tool_assignments, mcp_tool_settings, or agent_settings."""
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
        if not url or not key:
            return {}
        client = create_client(url, key)

        # 1. Check mcp_tool_settings
        try:
            mcp_res = client.table("mcp_tool_settings").select("parameter_bindings").eq("tool_key", tool_name).execute()
            if mcp_res.data and len(mcp_res.data) > 0:
                bindings = mcp_res.data[0].get("parameter_bindings")
                if bindings:
                    return json.loads(bindings) if isinstance(bindings, str) else bindings
        except Exception:
            pass

        # 2. Check agent_settings
        bootstrap_resp = client.rpc("get_backend_bootstrap_data").execute()
        bootstrap = bootstrap_resp.data or {}
        all_settings = bootstrap.get("agent_settings") or []
        for row in all_settings:
            k = row.get("key")
            v = row.get("value")
            if k in ("builtin_tools_parameter_bindings", "mcp_tools_parameter_bindings") and v:
                try:
                    parsed = json.loads(v) if isinstance(v, str) else v
                    if tool_name in parsed:
                        return parsed[tool_name]
                except Exception:
                    pass
        return {}
    except Exception as e:
        logger.warning(f"Failed to get tool bindings for '{tool_name}': {e}")
        return {}


@tool(parse_docstring=True)
def load_tools(
    tool_names: List[str],
    agent_id: Optional[str] = None,
    config: Optional[Any] = None,
) -> str:
    """Load the complete JSON schemas for the specified tool names.

    Fetches full schemas (parameters, types, required fields) from the master registry.
    Returns these schemas so they can be injected directly into the active prompt or context.

    Args:
        tool_names: List of tool names to load (e.g. ['think_tool', 'unified_search'])
    """
    schemas = {}
    user_id = None
    if config:
        configurable = config.configurable if hasattr(config, "configurable") else config.get("configurable", {})
        user_id = configurable.get("user_id")

    not_found = []

    allowed_tools = None
    if agent_id:
        allowed = get_allowed_routing_tools(agent_id)
        allowed_tools = allowed.get("normal", set()).union(allowed.get("super", set()))

    if allowed_tools is None:
        plugin_enabled = _enabled_plugins_from_db()

    for name in tool_names:
        name = name.strip()

        # Security/Access check: if agent_id is passed, the tool MUST be in the allowed list
        if allowed_tools is not None and name not in allowed_tools:
            not_found.append(name)
            continue

        # Plugin gate: tools owned by a disabled plugin are unavailable
        if allowed_tools is None and not is_tool_allowed(name, plugin_enabled):
            not_found.append(name)
            continue

        tool_obj = TOOL_OBJECTS.get(name)
        if not tool_obj:
            try:
                from research_agent.tools.provider_engine import load_mcp_tool_by_key
                from research_agent.tools.mcp_loader import run_sync
                mcp_tools = run_sync(load_mcp_tool_by_key(name, user_id))
                if mcp_tools:
                    tool_obj = mcp_tools[0]
            except Exception as e:
                logger.warning(f"Failed to load dynamic MCP tool '{name}': {e}")

        if tool_obj:
            bindings = get_tool_bindings(agent_id, name)
            if bindings:
                tool_obj = bind_tool_parameters(tool_obj, bindings)
            try:
                schema_dict = convert_to_openai_tool(tool_obj)
                schemas[name] = schema_dict
            except Exception as e:
                logger.warning(f"Failed to auto-convert tool '{name}': {e}. Creating fallback schema.")
                schemas[name] = {
                    "type": "function",
                    "function": {
                        "name": tool_obj.name,
                        "description": tool_obj.description,
                        "parameters": {
                            "type": "object",
                            "properties": tool_obj.args,
                            "required": list(tool_obj.args.keys())
                        }
                    }
                }
        else:
            not_found.append(name)

    result: Dict[str, Any] = {
        "loaded_schemas": schemas
    }
    if not_found:
        result["warnings"] = f"Tools not found in registry: {not_found}"

    logger.info(f"Loaded {len(schemas)} schemas. Unresolved: {len(not_found)}")
    return json.dumps(result, indent=2)


@tool(parse_docstring=True)
def call_tool(
    tool_name: str,
    arguments: Dict[str, Any],
    agent_id: Optional[str] = None,
    config: Optional[Any] = None,
) -> str:
    """Execute a dynamically loaded tool with the specified arguments.

    Use this tool to execute any tool from the <available_tools> index or found via list_tools
    after you have loaded its schema via load_tools. Do NOT call dynamic tools directly;
    you must route them through this call_tool function.

    Args:
        tool_name: The name of the tool to execute (e.g. 'publish_to_wordpress')
        arguments: A dictionary of arguments to pass to the tool (e.g. {'blog_post_markdown': '...', 'category_id': 1})
    """
    from langchain_core.runnables import RunnableConfig
    tool_name = tool_name.strip()
    user_id = None
    if config:
        configurable = config.configurable if hasattr(config, "configurable") else config.get("configurable", {})
        user_id = configurable.get("user_id")
    
    # Security/Access check: if agent_id is passed, the tool MUST be in the allowed list
    if agent_id:
        allowed = get_allowed_routing_tools(agent_id)
        allowed_tools = allowed.get("normal", set()).union(allowed.get("super", set()))
        if tool_name not in allowed_tools:
            return f"Error: Tool '{tool_name}' is not assigned to this agent or is disabled."
    else:
        # Plugin gate: tools owned by a disabled plugin are unavailable
        if tool_name in TOOL_OBJECTS and not is_tool_allowed(tool_name, _enabled_plugins_from_db()):
            return f"Error: Tool '{tool_name}' belongs to a disabled plugin and cannot be executed."

    # Permission check: verify if tool is denied or requires human confirmation
    perm_mode = get_tool_permission_mode(tool_name, agent_id=agent_id, user_id=user_id)
    if perm_mode == "deny":
        return f"Error: Tool '{tool_name}' execution is blocked/denied by your security permissions."

    if perm_mode == "ask":
        from langgraph.types import interrupt
        from langgraph.errors import GraphInterrupt
        interrupt_payload = {
            "action_requests": [{
                "name": tool_name,
                "args": arguments,
                "description": f"Tool '{tool_name}' requires explicit human approval before running."
            }],
            "review_configs": [{
                "action_name": tool_name,
                "allowed_decisions": ["approve", "reject", "edit"]
            }]
        }
        try:
            resume_data = interrupt(interrupt_payload)
        except GraphInterrupt:
            # MUST re-raise GraphInterrupt so LangGraph halts execution and prompts the user in the UI!
            raise
        except Exception as int_err:
            logger.warning(f"Failed to raise interrupt for tool '{tool_name}': {int_err}")
            resume_data = None

        if isinstance(resume_data, dict):
            decisions = resume_data.get("decisions") or []
            if decisions:
                decision = decisions[0]
                d_type = decision.get("type")
                if d_type == "reject":
                    msg = decision.get("message") or "User denied tool execution."
                    return f"Execution of tool '{tool_name}' was denied by user: {msg}"
                elif d_type == "edit":
                    if "edited_action" in decision and isinstance(decision["edited_action"], dict) and "args" in decision["edited_action"]:
                        arguments = decision["edited_action"]["args"]
                    elif "args" in decision:
                        arguments = decision["args"]
                    elif "edited_args" in decision:
                        arguments = decision["edited_args"]

    # Fetch bindings and merge arguments
    bindings = get_tool_bindings(agent_id, tool_name)
    if bindings:
        bound_params = {}
        for param_name, param_cfg in bindings.items():
            if isinstance(param_cfg, dict) and not param_cfg.get("decide_by_ai", True):
                bound_params[param_name] = param_cfg.get("value")
        if bound_params:
            arguments = {**arguments, **bound_params}

    logger.info(f"Executing dynamic tool '{tool_name}' with arguments: {arguments}")
    
    # 1. Built-in lookup
    tool_obj = TOOL_OBJECTS.get(tool_name)
    if tool_obj:
        try:
            res = tool_obj.invoke(arguments, config=config)
            return str(res)
        except Exception as e:
            logger.error(f"Error executing built-in tool '{tool_name}': {e}")
            return f"Error executing tool '{tool_name}': {e}"
            
    # 2. MCP lookup
    try:
        from research_agent.tools.provider_engine import load_mcp_tool_by_key
        from research_agent.tools.mcp_loader import run_sync

        mcp_tools = run_sync(load_mcp_tool_by_key(tool_name, user_id))
        if mcp_tools:
            mcp_tool_obj = mcp_tools[0]
            # MCP StructuredTools from langchain_mcp_adapters are async-only.
            # Each invocation re-opens the stdio subprocess (shutil.which → os.access),
            # so we must bypass blockbuster by setting blockbuster_skip=True in the
            # worker thread before running the event loop.
            def _invoke_mcp_tool():
                try:
                    from blockbuster.blockbuster import blockbuster_skip
                    skip_token = blockbuster_skip.set(True)
                except Exception:
                    skip_token = None

                import asyncio
                new_loop = asyncio.new_event_loop()
                try:
                    return new_loop.run_until_complete(mcp_tool_obj.ainvoke(arguments))
                finally:
                    new_loop.close()
                    if skip_token is not None:
                        try:
                            blockbuster_skip.reset(skip_token)
                        except Exception:
                            pass

            import threading as _threading
            result_holder = []
            err_holder = []
            def _run():
                try:
                    result_holder.append(_invoke_mcp_tool())
                except Exception as exc:
                    err_holder.append(exc)
            t = _threading.Thread(target=_run)
            t.start()
            try:
                from blockbuster.blockbuster import blockbuster_skip
                skip_token = blockbuster_skip.set(True)
            except Exception:
                skip_token = None

            try:
                t.join()
            finally:
                if skip_token is not None:
                    try:
                        blockbuster_skip.reset(skip_token)
                    except Exception:
                        pass

            if err_holder:
                raise err_holder[0]
            return str(result_holder[0])
        else:
            return f"Error: Tool '{tool_name}' is not loaded or could not be found."
    except Exception as e:
        logger.error(f"Error executing MCP tool '{tool_name}': {e}")
        return f"Error executing tool '{tool_name}': {e}"


def unload_unused_tools(active_schemas: Dict[str, Any], tools_to_keep: List[str], max_limit: int = 15) -> Dict[str, Any]:
    """Automatically unload schemas from the active context schemas dictionary.

    Removes any tool schemas that are not in tools_to_keep, and enforces a maximum
    threshold of loaded tool schemas (defaults to 15).

    Args:
        active_schemas: Dictionary of {tool_name: schema_dict} currently loaded.
        tools_to_keep: List of tool names that are required for the current task.
        max_limit: Maximum allowed loaded tools in active schemas.

    Returns:
        Modified dictionary of active schemas.
    """
    # Keep only the requested tools
    updated_schemas = {name: schema for name, schema in active_schemas.items() if name in tools_to_keep}

    # If the active tools exceed the threshold, keep only the first max_limit elements
    if len(updated_schemas) > max_limit:
        logger.info(f"Unload threshold reached ({len(updated_schemas)} > {max_limit}). Trimming active schemas.")
        keys_to_keep = list(updated_schemas.keys())[:max_limit]
        updated_schemas = {name: updated_schemas[name] for name in keys_to_keep}

    return updated_schemas


def _get_pinecone_index():
    """Helper to initialize and return the Pinecone 'tools' index."""
    import os
    from pinecone import Pinecone
    api_key = os.environ.get("PINECONE_API_KEY")
    if not api_key:
        raise ValueError("PINECONE_API_KEY not found in environment.")
    pc = Pinecone(api_key=api_key)
    return pc.Index("tools")


def get_embedding_sync(text: str, input_type: str = "passage") -> list[float]:
    """Helper to synchronously embed text using multilingual-e5-large."""
    import os
    from langchain_pinecone import PineconeEmbeddings
    api_key = os.environ.get("PINECONE_API_KEY")
    if not api_key:
        raise ValueError("PINECONE_API_KEY not found in environment.")
    embeddings = PineconeEmbeddings(
        model="multilingual-e5-large",
        pinecone_api_key=api_key
    )
    return embeddings.embed_query(text)


def bind_tool_parameters(tool: Any, bindings: Dict[str, Any]) -> Any:
    """Wrap a tool with custom parameter bindings, modifying its schema and injecting fixed values."""
    if not bindings:
        return tool

    # Extract parameters configured by the user to NOT be decided by AI
    # bindings format: {"param_name": {"value": val, "decide_by_ai": False}}
    bound_params = {}
    for param_name, param_cfg in bindings.items():
        if isinstance(param_cfg, dict) and not param_cfg.get("decide_by_ai", True):
            bound_params[param_name] = param_cfg.get("value")

    if not bound_params:
        return tool

    logger.info(f"Wrapping tool '{tool.name}' with bound parameters: {list(bound_params.keys())}")

    # Define wrapped execution functions
    def _run(*args, **kwargs):
        merged = {**kwargs, **bound_params}
        return tool.invoke(merged)

    async def _arun(*args, **kwargs):
        merged = {**kwargs, **bound_params}
        return await tool.ainvoke(merged)

    # Build new args_schema
    from pydantic import create_model
    from pydantic.fields import FieldInfo
    
    new_args_schema = None
    if getattr(tool, "args_schema", None) is not None:
        fields = {}
        for field_name, field_info in tool.args_schema.model_fields.items():
            if field_name not in bound_params:
                fields[field_name] = (field_info.annotation, field_info)
        new_args_schema = create_model(
            tool.args_schema.__name__,
            **fields
        )
    else:
        # Build schema from tool.args properties if no args_schema is present
        type_mapping = {
            "string": str,
            "integer": int,
            "number": float,
            "boolean": bool,
            "array": list,
            "object": dict
        }
        fields = {}
        for param_name, param_schema in tool.args.items():
            if param_name not in bound_params:
                js_type = param_schema.get("type", "string")
                py_type = type_mapping.get(js_type, Any)
                desc = param_schema.get("description", "")
                
                if "default" in param_schema:
                    field_info = FieldInfo(default=param_schema["default"], description=desc)
                else:
                    field_info = FieldInfo(default=None, description=desc)
                    
                fields[param_name] = (py_type, field_info)
        new_args_schema = create_model(
            f"{tool.name}Args",
            **fields
        )

    # Create the wrapped StructuredTool
    from langchain_core.tools import StructuredTool
    wrapped = StructuredTool(
        name=tool.name,
        description=tool.description,
        func=_run,
        coroutine=_arun,
        args_schema=new_args_schema
    )
    return wrapped


def get_tool_bindings(agent_id: str, tool_name: str) -> Dict[str, Any]:
    """Fetch tool parameter bindings from Supabase."""
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
        if not url or not key:
            return {}
        client = create_client(url, key)
        resp = client.table("agent_tool_assignments") \
            .select("parameter_bindings") \
            .eq("agent_id", agent_id) \
            .eq("tool_key", tool_name) \
            .eq("enabled", True) \
            .execute()
        rows = resp.data or []
        if rows:
            return rows[0].get("parameter_bindings") or {}
    except Exception as e:
        logger.warning(f"Error fetching tool bindings: {e}")
    return {}


def get_tool_json_schema(tool_or_key: Any) -> Dict[str, Any]:
    """Extract a clean, standard JSON Schema representation of a tool's parameters and metadata."""
    tool_obj = TOOL_OBJECTS.get(tool_or_key) if isinstance(tool_or_key, str) else tool_or_key
    if not tool_obj:
        return {"name": str(tool_or_key), "description": "", "parameters": {"type": "object", "properties": {}, "required": []}}
    
    try:
        openai_dict = convert_to_openai_tool(tool_obj)
        func = openai_dict.get("function", {})
        return {
            "name": func.get("name", getattr(tool_obj, "name", "")),
            "description": func.get("description", getattr(tool_obj, "description", "")),
            "parameters": func.get("parameters", {"type": "object", "properties": {}, "required": []})
        }
    except Exception as e:
        logger.warning(f"Error converting tool schema for {tool_obj}: {e}")
        return {
            "name": getattr(tool_obj, "name", str(tool_or_key)),
            "description": getattr(tool_obj, "description", ""),
            "parameters": {"type": "object", "properties": {}, "required": []}
        }


def get_all_tool_schemas() -> Dict[str, Any]:
    """Return a mapping of all registered built-in tools to their JSON schemas."""
    schemas = {}
    for key, tool_obj in TOOL_OBJECTS.items():
        schemas[key] = get_tool_json_schema(tool_obj)
    return schemas


