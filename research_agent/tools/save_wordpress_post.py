"""WordPress Article Saver and Category Manager Tool for AI Agents.

This tool performs a dual role for blog articles:
1. Category Discovery: Fetches live categories from the connected WordPress website in real-time.
2. Article Storage: Saves generated articles, SEO metadata, and category mappings to the database for 1-click live publishing.

Workflow:
- Step 1: Call save_wordpress_post(action="get_categories") to view available live categories on WordPress.
- Step 2: Call save_wordpress_post(title=..., content_md=..., category="...") to save the article with the chosen category.
"""

import json
import os
import re
from typing import Optional, Tuple
import requests
from dotenv import load_dotenv
from langchain_core.tools import tool

load_dotenv()


def _supabase_headers(content_type: str = "application/json") -> dict[str, str]:
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": content_type,
        "Prefer": "return=representation",
    }


def _get_supabase_url() -> str:
    return os.environ.get("SUPABASE_URL", "").rstrip("/") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "").rstrip("/")


def _get_wp_credentials() -> tuple[str, str, str]:
    """Retrieve WP site URL, username, and application password."""
    try:
        from .provider_engine import get_user_api_key
        site_url = get_user_api_key("wp_site_url", "WP_SITE_URL").rstrip("/")
        username = get_user_api_key("wp_username", "WP_USERNAME")
        app_password = get_user_api_key("wp_app_password", "WP_APP_PASSWORD")
        return site_url, username, app_password
    except Exception:
        return (
            os.environ.get("WP_SITE_URL", "").rstrip("/"),
            os.environ.get("WP_USERNAME", ""),
            os.environ.get("WP_APP_PASSWORD", ""),
        )


def _fetch_live_wp_categories() -> tuple[list[dict], str]:
    """Fetch live categories from WordPress REST API."""
    site_url, username, app_password = _get_wp_credentials()
    if not site_url or not username or not app_password:
        return [], "⚠️ WordPress credentials not configured. Please configure them in Post Settings."

    try:
        resp = requests.get(
            f"{site_url}/wp-json/wp/v2/categories",
            auth=(username, app_password),
            params={"per_page": 100},
            timeout=12,
        )
        if not resp.ok:
            return [], f"❌ WordPress API error ({resp.status_code}): {resp.text[:200]}"
        return resp.json(), ""
    except Exception as e:
        return [], f"❌ Failed to fetch live WordPress categories: {str(e)}"


def _resolve_category(category_name_or_id: str) -> Tuple[str, Optional[int]]:
    """Resolve category in real-time against live WordPress REST API.

    1. If numeric ID passed, returns it directly.
    2. Fetches all live categories from WordPress.
    3. If matching category found, returns (name, id).
    4. If not found, dynamically creates the new category on WordPress and returns (name, new_id).
    5. Falls back cleanly to Uncategorized (ID: 1) if creation is not possible.
    """
    if not category_name_or_id or not category_name_or_id.strip():
        category_name_or_id = "Uncategorized"

    category_str = category_name_or_id.strip()

    if category_str.isdigit():
        return f"Category {category_str}", int(category_str)

    site_url, username, app_password = _get_wp_credentials()
    if not site_url or not username or not app_password:
        return category_str, None

    try:
        cats, err = _fetch_live_wp_categories()
        if cats:
            target = category_str.lower()

            # Exact name or slug match
            for c in cats:
                c_name = str(c.get("name", "")).strip().lower()
                c_slug = str(c.get("slug", "")).strip().lower()
                if c_name == target or c_slug == target:
                    return str(c.get("name")), int(c.get("id"))

            # Substring / partial match
            for c in cats:
                c_name = str(c.get("name", "")).strip().lower()
                c_slug = str(c.get("slug", "")).strip().lower()
                if target in c_name or c_name in target or target in c_slug:
                    return str(c.get("name")), int(c.get("id"))

            # Create category on WordPress dynamically if not present
            try:
                create_resp = requests.post(
                    f"{site_url}/wp-json/wp/v2/categories",
                    auth=(username, app_password),
                    json={"name": category_str},
                    timeout=10,
                )
                if create_resp.status_code in (200, 201):
                    new_cat = create_resp.json()
                    new_id = new_cat.get("id")
                    if new_id:
                        print(f"[save_wordpress_post] Created category '{category_str}' on WordPress (ID: {new_id})")
                        return category_str, int(new_id)
            except Exception as create_err:
                print(f"[save_wordpress_post] Note creating category: {create_err}")

            # Fallback to uncategorized if available
            for c in cats:
                if str(c.get("slug", "")).lower() == "uncategorized":
                    return category_str, int(c.get("id"))

    except Exception as e:
        print(f"[save_wordpress_post] Live category lookup note: {e}")

    return category_str, None


def _parse_blog_frontmatter(md: str) -> dict:
    """Parse YAML frontmatter and extract key fields from markdown."""
    result = {
        "title": "",
        "slug": "",
        "meta_description": "",
        "focus_keyword": "",
        "category_hint": "",
        "excerpt": "",
    }
    if md.startswith("---"):
        end = md.find("\n---", 3)
        if end != -1:
            frontmatter = md[3:end].strip()
            for line in frontmatter.split("\n"):
                if ":" in line:
                    key, _, val = line.partition(":")
                    result[key.strip()] = val.strip()
    return result


@tool
def save_wordpress_post(
    action: str = "save",
    title: str = "",
    content_md: str = "",
    category: str = "",
    slug: str = "",
    excerpt: str = "",
    focus_keyword: str = "",
    meta_description: str = "",
    image_1_url: str = "",
    image_2_url: str = "",
    status: str = "draft",
    wp_post_url: str = "",
    wp_post_id: str = "",
) -> str:
    """WordPress Article Saver and Live Category Manager.

    Use this tool for:
    1. action='get_categories': Fetches live categories from your WordPress site so you can choose the best category.
    2. action='save': Saves your generated blog post, SEO metadata, and matched category to the database for 1-click live publishing.

    Args:
        action: Either 'get_categories' (to list live WordPress categories) or 'save' (to save the article).
        title: The headline of the article.
        content_md: Full markdown body of the article.
        category: WordPress category name or slug (e.g. 'health', 'economy', 'politics', 'fashion', or a new category).
        slug: URL slug for the article.
        excerpt: Brief 1-2 sentence article summary.
        focus_keyword: Primary SEO target keyword.
        meta_description: SEO meta description (up to 160 characters).
        image_1_url: Hero featured image URL.
        image_2_url: Secondary in-article image URL.
        status: Publish status: 'draft' or 'publish'.
        wp_post_url: Live WordPress URL if already published.
        wp_post_id: WordPress post ID if already published.
    """
    # 1. Action: Fetch Live Categories
    if action == "get_categories" or (not title and not content_md and not category):
        cats, err = _fetch_live_wp_categories()
        if err:
            return err
        if not cats:
            return "No categories found on WordPress site."

        lines = [
            "Live WordPress Categories from your website:\n",
            f"{'ID':<6} {'Name':<20} {'Slug':<20} {'Posts':<8}",
            "-" * 56,
        ]
        slug_list = []
        for cat in cats:
            slug_list.append(cat.get("slug", ""))
            lines.append(
                f"{cat.get('id'):<6} {cat.get('name', ''):<20} {cat.get('slug', ''):<20} {cat.get('count', 0):<8}"
            )

        lines.append(f"\nAvailable Categories: {', '.join(slug_list)}")
        lines.append("\n-> Next Step: Call save_wordpress_post(action='save', title='...', content_md='...', category='<category_name_or_id>') to save your article.")
        return "\n".join(lines)

    # 2. Action: Save Article
    supabase_url = _get_supabase_url()
    if not supabase_url:
        return "[Error] SUPABASE_URL not configured — article kept in memory."

    if not title and content_md:
        front = _parse_blog_frontmatter(content_md)
        title = front.get("title", "Untitled Article")
        category = category or front.get("category_hint", "")
        slug = slug or front.get("slug", "")
        excerpt = excerpt or front.get("excerpt", "")
        focus_keyword = focus_keyword or front.get("focus_keyword", "")
        meta_description = meta_description or front.get("meta_description", "")

    if not title:
        title = "Article Draft"

    # Real-time category resolution against live WordPress site
    resolved_cat_name, resolved_cat_id = _resolve_category(category)

    row = {
        "title": title,
        "slug": slug or re.sub(r"[^\w\s-]", "", title.lower()).replace(" ", "-"),
        "content_md": content_md,
        "excerpt": excerpt or (meta_description[:300] if meta_description else content_md[:200]),
        "category_hint": resolved_cat_name,
        "focus_keyword": focus_keyword,
        "meta_description": meta_description,
        "image_1_url": image_1_url or None,
        "image_2_url": image_2_url or None,
        "has_image_1": bool(image_1_url),
        "has_image_2": bool(image_2_url),
        "wp_status": status,
        "wp_post_url": wp_post_url or None,
        "wp_post_id": int(wp_post_id) if str(wp_post_id).isdigit() else None,
    }

    try:
        resp = requests.post(
            f"{supabase_url}/rest/v1/blog_posts",
            headers=_supabase_headers(),
            json=row,
            timeout=15,
        )
        if not resp.ok:
            return f"[Error] Failed to save WordPress article: {resp.status_code} {resp.text[:200]}"

        result = resp.json()
        row_id = result[0].get("id", "?") if result else "?"
        cat_info = f"{resolved_cat_name}" + (f" (WP ID: {resolved_cat_id})" if resolved_cat_id else "")
        return f"[Success] WordPress Article '{title}' saved to database (ID: {row_id}, Category: {cat_info}). Ready for 1-click publishing!"
    except Exception as e:
        return f"[Error] saving WordPress article: {str(e)}"


# Backward-compatible alias for existing skills / agents
@tool
def save_posts_to_supabase(
    social_posts_markdown: str = "",
    wp_post_url: str = "",
    wp_post_id: str = "",
    wp_edit_url: str = "",
    wp_status: str = "draft",
) -> str:
    """Save generated WordPress blog post to the database."""
    blog_file = "blog_post.md"
    if os.path.exists(blog_file):
        try:
            with open(blog_file, "r", encoding="utf-8") as f:
                blog_md = f.read()
            front = _parse_blog_frontmatter(blog_md)
            return save_wordpress_post.invoke({
                "action": "save",
                "title": front.get("title", "Generated Blog Post"),
                "content_md": blog_md,
                "category": front.get("category_hint", ""),
                "slug": front.get("slug", ""),
                "excerpt": front.get("excerpt", ""),
                "focus_keyword": front.get("focus_keyword", ""),
                "meta_description": front.get("meta_description", ""),
                "wp_post_url": wp_post_url,
                "wp_post_id": str(wp_post_id),
                "status": wp_status,
            })
        except Exception as e:
            return f"⚠️ Error reading blog_post.md: {e}"

    if social_posts_markdown:
        return save_wordpress_post.invoke({
            "action": "save",
            "title": "Article Draft",
            "content_md": social_posts_markdown,
            "wp_post_url": wp_post_url,
            "wp_post_id": str(wp_post_id),
            "status": wp_status,
        })

    return "✅ Saved."
