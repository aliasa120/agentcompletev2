"""WordPress REST API integration tools.

Provides two tools:
  1. get_wordpress_categories() — fetch available categories with their IDs
  2. publish_to_wordpress()     — create/publish a post with featured image support

Authentication: WordPress Application Password (Basic Auth over HTTPS).
Required env vars: WP_SITE_URL, WP_USERNAME, WP_APP_PASSWORD
Optional env var:  WP_POST_STATUS (default: "draft")
"""

import os
import re
import time
from pathlib import Path

import requests
from langchain_core.tools import tool


# ── Helpers ───────────────────────────────────────────────────────────────────

def _wp_auth() -> tuple[str, str]:
    """Return (username, app_password) from environment."""
    return (
        os.environ.get("WP_USERNAME", ""),
        os.environ.get("WP_APP_PASSWORD", ""),
    )


def _wp_base() -> str:
    """Return the WP REST API base URL."""
    site = os.environ.get("WP_SITE_URL", "").rstrip("/")
    return f"{site}/wp-json/wp/v2"


def _title_to_slug(title: str) -> str:
    """Convert a post title to a URL-friendly slug."""
    slug = title.lower()
    slug = re.sub(r"[^\w\s-]", "", slug)       # remove non-word chars
    slug = re.sub(r"[\s_]+", "-", slug)          # spaces → hyphens
    slug = re.sub(r"-+", "-", slug).strip("-")   # collapse multiple hyphens
    words = slug.split("-")[:7]                  # max 7 words
    return "-".join(words)


def _md_to_html(md: str) -> str:
    """Convert Markdown to WordPress-compatible HTML.

    Handles: headings, bold, italics, paragraphs, lists, blockquotes,
    links, images, horizontal rules, and inline code.
    Uses the 'markdown' package if available, falls back to manual conversion.
    """
    try:
        import markdown as md_lib  # type: ignore
        html = md_lib.markdown(
            md,
            extensions=["extra", "toc"],
            extension_configs={
                "toc": {"anchorlink": False}
            },
        )
        return html
    except ImportError:
        pass

    # ── Manual fallback conversion ────────────────────────────────────────────
    lines = md.split("\n")
    html_lines = []
    in_list = False
    in_blockquote = False

    for line in lines:
        stripped = line.strip()

        # Headings
        if stripped.startswith("### "):
            if in_list: html_lines.append("</ul>"); in_list = False
            html_lines.append(f"<h3>{stripped[4:]}</h3>")
        elif stripped.startswith("## "):
            if in_list: html_lines.append("</ul>"); in_list = False
            html_lines.append(f"<h2>{stripped[3:]}</h2>")
        elif stripped.startswith("# "):
            if in_list: html_lines.append("</ul>"); in_list = False
            html_lines.append(f"<h1>{stripped[2:]}</h1>")

        # Horizontal rule
        elif stripped in ("---", "***", "___"):
            html_lines.append("<hr>")

        # Blockquote
        elif stripped.startswith("> "):
            if in_list: html_lines.append("</ul>"); in_list = False
            content = _inline_md(stripped[2:])
            html_lines.append(f"<blockquote><p>{content}</p></blockquote>")

        # Unordered list
        elif stripped.startswith("- ") or stripped.startswith("* "):
            if not in_list:
                html_lines.append("<ul>")
                in_list = True
            content = _inline_md(stripped[2:])
            html_lines.append(f"<li>{content}</li>")

        # Image placeholder markers — skip (already embedded as img tags)
        elif stripped.startswith("<!-- BLOG_IMAGE"):
            html_lines.append(stripped)  # keep as HTML comment, WP ignores it

        # Image in markdown: ![alt](url)
        elif stripped.startswith("!["):
            if in_list: html_lines.append("</ul>"); in_list = False
            m = re.match(r"!\[([^\]]*)\]\(([^)]+)\)", stripped)
            if m:
                alt, src = m.group(1), m.group(2)
                html_lines.append(
                    f'<figure class="wp-block-image size-large" style="max-width:700px;width:100%;margin:1.5em auto;">'
                    f'<img src="{src}" alt="{alt}" style="max-width:100%;height:auto;display:block;" />'
                    f'<figcaption style="text-align:center;font-size:0.85em;color:#666;">{alt}</figcaption>'
                    f"</figure>"
                )

        # Empty line → close list or paragraph break
        elif stripped == "":
            if in_list:
                html_lines.append("</ul>")
                in_list = False
            html_lines.append("")

        # Normal paragraph
        else:
            if in_list: html_lines.append("</ul>"); in_list = False
            content = _inline_md(stripped)
            if content:
                html_lines.append(f"<p>{content}</p>")

    if in_list:
        html_lines.append("</ul>")

    return "\n".join(html_lines)


def _inline_md(text: str) -> str:
    """Apply inline Markdown: bold, italic, code, links."""
    # Bold
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    # Italic
    text = re.sub(r"\*(.+?)\*", r"<em>\1</em>", text)
    # Inline code
    text = re.sub(r"`(.+?)`", r"<code>\1</code>", text)
    # Links [text](url)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    return text


def _strip_frontmatter(md: str) -> tuple[dict, str]:
    """Strip YAML frontmatter from markdown, return (meta_dict, body_md)."""
    meta: dict = {}
    if not md.startswith("---"):
        return meta, md

    end = md.find("\n---", 3)
    if end == -1:
        return meta, md

    frontmatter_block = md[3:end].strip()
    body = md[end + 4:].strip()

    for line in frontmatter_block.split("\n"):
        if ":" in line:
            key, _, val = line.partition(":")
            meta[key.strip()] = val.strip()

    return meta, body


def _upload_media(
    image_path: str,
    title: str,
    alt_text: str = "",
) -> int | None:
    """Upload a local image to WordPress Media Library.

    Returns the media ID (integer) on success, or None on failure.
    """
    img = Path(image_path)
    if not img.exists():
        print(f"[wp_publisher] ⚠️  Image not found: {image_path}")
        return None

    filename = img.name
    content_type = "image/jpeg" if filename.lower().endswith((".jpg", ".jpeg")) else "image/png"

    headers = {
        "Content-Disposition": f"attachment; filename={filename}",
        "Content-Type": content_type,
    }

    try:
        with open(img, "rb") as f:
            resp = requests.post(
                f"{_wp_base()}/media",
                auth=_wp_auth(),
                headers=headers,
                data=f,
                timeout=60,
            )

        if resp.status_code in (200, 201):
            media_id = resp.json().get("id")
            media_url = resp.json().get("source_url", "")
            print(f"[wp_publisher] ✅ Media uploaded: id={media_id} url={media_url}")

            # Set alt text if provided
            if alt_text and media_id:
                requests.post(
                    f"{_wp_base()}/media/{media_id}",
                    auth=_wp_auth(),
                    json={"alt_text": alt_text},
                    timeout=15,
                )

            return media_id
        else:
            print(f"[wp_publisher] ❌ Media upload failed ({resp.status_code}): {resp.text[:300]}")
            return None

    except Exception as e:
        print(f"[wp_publisher] ❌ Media upload exception: {e}")
        return None


# ── Tools ─────────────────────────────────────────────────────────────────────

@tool(parse_docstring=True)
def get_wordpress_categories() -> str:
    """Fetch all categories from WordPress and return them with their IDs.

    Call this BEFORE publish_to_wordpress to find the correct category ID
    for the blog post. Returns a numbered list of categories with their IDs,
    names, slugs, and post count so you can pick the most relevant one.

    Returns:
        Formatted list of WordPress categories with IDs, or an error message.
    """
    site_url = os.environ.get("WP_SITE_URL", "").rstrip("/")
    if not site_url:
        return "⚠️ WP_SITE_URL not set in environment. Cannot fetch categories."

    username, app_password = _wp_auth()
    if not username or not app_password:
        return "⚠️ WP_USERNAME or WP_APP_PASSWORD not set. Cannot authenticate."

    try:
        resp = requests.get(
            f"{_wp_base()}/categories",
            auth=(username, app_password),
            params={"per_page": 100, "orderby": "count", "order": "desc"},
            timeout=15,
        )
        resp.raise_for_status()
        categories = resp.json()

        if not categories:
            return "⚠️ No categories found in WordPress."

        lines = [
            "WordPress Categories (use the ID when calling publish_to_wordpress):\n",
            f"{'ID':<6} {'Name':<20} {'Slug':<20} {'Posts':<8}",
            "─" * 56,
        ]
        for cat in categories:
            lines.append(
                f"{cat['id']:<6} {cat['name']:<20} {cat['slug']:<20} {cat.get('count', 0):<8}"
            )

        lines.append(
            "\n📌 Match the news topic to the most relevant category ID above."
        )
        lines.append(
            "Available slugs: pakistan, sports, business, latest-news, uncategorized"
        )
        return "\n".join(lines)

    except requests.HTTPError as e:
        return f"❌ WordPress API error ({e.response.status_code}): {e.response.text[:300]}"
    except Exception as e:
        return f"❌ Failed to fetch categories: {e}"


@tool(parse_docstring=True)
def publish_to_wordpress(
    blog_post_markdown: str,
    category_id: int,
    featured_image_path: str = "",
) -> str:
    """Publish the blog post to WordPress and return the post URL.

    Converts the blog_post.md content to HTML, uploads the featured image
    to WordPress Media Library (if provided), then creates the post.

    The post status (draft/publish) is read from the WP_POST_STATUS environment
    variable (defaults to 'draft' for safety).

    Args:
        blog_post_markdown: The complete content of blog_post.md including
            the YAML frontmatter block (---) at the top. The tool reads the
            title, slug, meta_description, and excerpt from the frontmatter.
        category_id: The integer ID of the WordPress category to assign.
            Get this from get_wordpress_categories() first.
        featured_image_path: Optional absolute or relative path to the image
            file to upload as the post's featured image (thumbnail)
            (e.g., "output/candidate_images/image_1.jpg").
            Leave empty to skip featured image.

    Returns:
        JSON-like result string with post_id, post_url, edit_url, and status.
        Or an error message if publishing failed.
    """
    site_url = os.environ.get("WP_SITE_URL", "").rstrip("/")
    if not site_url:
        return "⚠️ WP_SITE_URL not set in environment. Cannot publish."

    username, app_password = _wp_auth()
    if not username or not app_password:
        return "⚠️ WP_USERNAME or WP_APP_PASSWORD not set. Cannot authenticate."

    if not blog_post_markdown or not blog_post_markdown.strip():
        return "⚠️ blog_post_markdown is empty. Nothing to publish."

    # ── Parse frontmatter ─────────────────────────────────────────────────────
    meta, body_md = _strip_frontmatter(blog_post_markdown.strip())

    title     = meta.get("title", "Untitled Post")
    slug      = meta.get("slug", "") or _title_to_slug(title)
    meta_desc = meta.get("meta_description", "")
    excerpt   = meta_desc or title  # WP excerpt shown in listings

    print(f"[wp_publisher] Title: {title!r}")
    print(f"[wp_publisher] Slug:  {slug!r}")
    print(f"[wp_publisher] Category ID: {category_id}")

    # ── Convert markdown body to HTML ─────────────────────────────────────────
    html_content = _md_to_html(body_md)

    # ── Upload featured image (optional) ─────────────────────────────────────
    featured_media_id = None
    if featured_image_path and featured_image_path.strip():
        print(f"[wp_publisher] Uploading featured image: {featured_image_path}")
        featured_media_id = _upload_media(
            image_path=featured_image_path.strip(),
            title=title,
            alt_text=title,
        )
        if not featured_media_id:
            print("[wp_publisher] ⚠️  Featured image upload failed — continuing without it.")

    # ── Build post payload ─────────────────────────────────────────────────────
    post_status = os.environ.get("WP_POST_STATUS", "draft")
    payload: dict = {
        "title":      title,
        "content":    html_content,
        "excerpt":    excerpt,
        "slug":       slug,
        "status":     post_status,
        "categories": [category_id],
    }

    if featured_media_id:
        payload["featured_media"] = featured_media_id

    # ── Create the post ───────────────────────────────────────────────────────
    try:
        resp = requests.post(
            f"{_wp_base()}/posts",
            auth=(username, app_password),
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=30,
        )

        if resp.status_code in (200, 201):
            data = resp.json()
            post_id   = data.get("id")
            post_url  = data.get("link", "")
            edit_url  = f"{site_url}/wp-admin/post.php?post={post_id}&action=edit"
            status    = data.get("status", post_status)

            print(f"[wp_publisher] ✅ Post created: id={post_id} url={post_url} status={status}")

            # Small retry if post URL is empty (WP sometimes needs a moment)
            if not post_url and post_id:
                time.sleep(2)
                check = requests.get(
                    f"{_wp_base()}/posts/{post_id}",
                    auth=(username, app_password),
                    timeout=10,
                )
                if check.ok:
                    post_url = check.json().get("link", "")

            return (
                f"✅ Blog post published to WordPress!\n"
                f"  post_id:   {post_id}\n"
                f"  post_url:  {post_url}\n"
                f"  edit_url:  {edit_url}\n"
                f"  status:    {status}\n"
                f"  category:  {category_id}\n"
                f"  featured:  {'yes (id=' + str(featured_media_id) + ')' if featured_media_id else 'none'}\n"
                f"\n"
                f"IMPORTANT: Use post_url above to append "
                f"'Read more: {post_url}' to the Facebook section of social_posts.md."
            )
        else:
            err = resp.text[:400]
            print(f"[wp_publisher] ❌ Post creation failed ({resp.status_code}): {err}")
            return (
                f"❌ WordPress post creation failed (HTTP {resp.status_code}):\n{err}\n"
                "Common fixes:\n"
                "  - Check WP_USERNAME and WP_APP_PASSWORD are correct\n"
                "  - Ensure REST API is enabled (not blocked by security plugin)\n"
                "  - Verify the category_id exists in WordPress\n"
                "  - Check WP_SITE_URL uses HTTPS"
            )

    except requests.Timeout:
        return (
            "❌ WordPress request timed out (30s). "
            "Check your WP_SITE_URL is reachable from the server."
        )
    except Exception as e:
        return f"❌ Unexpected error publishing to WordPress: {e}"
