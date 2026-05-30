"""Save generated social posts to Supabase.

Uses Supabase REST API directly (no extra Python package needed).
Accepts the social_posts.md content as a string parameter (the agent passes it directly),
uploads the image to Supabase Storage, then inserts a row into social_posts.
Also reads blog_post.md (if present) and saves a linked row to blog_posts.
"""

import json
import os
import re
import threading
from pathlib import Path

import requests
from langchain_core.tools import tool

_OUTPUT_DIR = Path("output")
_LATEST_IMAGE_FILE = _OUTPUT_DIR / "latest_image_path.txt"  # written by create_post_image_gemini
_BLOG_POST_FILE    = Path("blog_post.md")


def _supabase_headers(content_type: str = "application/json") -> dict[str, str]:
    key = os.environ.get("SUPABASE_ANON_KEY", "")
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": content_type,
        "Prefer": "return=minimal",
    }


def _parse_posts(md: str) -> dict:
    """Parse social_posts.md into structured fields."""

    def section(pattern: str, *stops: str) -> str:
        stops_re = "|".join(re.escape(s) for s in stops)
        m = re.search(
            rf"##\s+(?:{pattern})\s*\n([\s\S]*?)(?=##\s+(?:{stops_re})|$)", md, re.I
        )
        return m.group(1).strip() if m else ""

    title_m = re.search(r"^#\s+(.+)$", md, re.M)
    title = title_m.group(1).strip() if title_m else ""

    twitter = section(
        r"X \(Twitter\)|Twitter", "Instagram", "Facebook", "Sources", "Images"
    ).strip()
    instagram = section("Instagram", "Facebook", "Sources", "Images").strip()
    facebook = section("Facebook", "Sources", "Images").strip()

    sources_text = section("Sources", "Images", "STOP")
    sources = [
        ln.strip() for ln in sources_text.splitlines() if ln.strip().startswith("[")
    ]
    
    images_text = section("Images", "STOP")
    image_path = None
    for ln in images_text.splitlines():
        ln = ln.strip()
        if ln.startswith("- ") or ln.startswith("* "):
            possible_path = ln[2:].strip()
            if possible_path:
                image_path = possible_path
                break

    return {
        "title": title,
        "twitter": twitter,
        "instagram": instagram,
        "facebook": facebook,
        "sources": sources,
        "image_path": image_path,
    }


def _parse_blog_post(md: str) -> dict:
    """Parse blog_post.md frontmatter and extract key fields."""
    result = {
        "title": "",
        "slug": "",
        "meta_description": "",
        "focus_keyword": "",
        "category_hint": "",
        "excerpt": "",
        "content_md": md,
        "wp_post_url": None,
        "wp_post_id": None,
        "wp_edit_url": None,
        "wp_status": "draft",
        "image_1_url": None,
        "image_2_url": None,
    }

    # Parse YAML frontmatter
    if md.startswith("---"):
        end = md.find("\n---", 3)
        if end != -1:
            frontmatter = md[3:end].strip()
            for line in frontmatter.split("\n"):
                if ":" in line:
                    key, _, val = line.partition(":")
                    result[key.strip()] = val.strip()

    # Extract excerpt from meta_description if not set explicitly
    if not result.get("excerpt"):
        result["excerpt"] = result.get("meta_description", "")[:300]

    # Extract image source URLs from <!-- source_url: ... --> comments
    source_urls = re.findall(r"<!-- source_url: (https?://[^\s>]+) -->", md)
    if len(source_urls) >= 1:
        result["image_1_url"] = source_urls[0]
    if len(source_urls) >= 2:
        result["image_2_url"] = source_urls[1]

    return result


def _upload_image(supabase_url: str, img_path_str: str | None) -> str | None:
    """Upload the specified image to Supabase Storage."""
    if not img_path_str:
        print("[save_to_supabase] No image path provided — skipping image upload.")
        return None

    image_path = Path(img_path_str)
    if not image_path.exists():
        print(f"[save_to_supabase] Image file not found: {image_path}")
        return None

    img_bytes = image_path.read_bytes()
    filename = image_path.name  # unique slug-timestamp.jpg e.g. imran-khan-20260224-184532.jpg
    upload_url = f"{supabase_url}/storage/v1/object/post-images/{filename}"

    headers = _supabase_headers("image/jpeg")
    headers.pop("Prefer", None)
    headers["x-upsert"] = "true"

    resp = requests.post(upload_url, headers=headers, data=img_bytes, timeout=(10, 30))
    if resp.ok:
        public_url = f"{supabase_url}/storage/v1/object/public/post-images/{filename}"
        print(f"[save_to_supabase] ✅ Image uploaded: {public_url}")
        return public_url
    else:
        print(f"[save_to_supabase] ⚠️ Image upload failed ({resp.status_code}): {resp.text[:200]}")
        return None


@tool(parse_docstring=True)
def save_posts_to_supabase(
    social_posts_markdown: str,
    wp_post_url: str = "",
    wp_post_id: str = "",
    wp_edit_url: str = "",
    wp_status: str = "draft",
) -> str:
    """Save the generated social posts and blog post to Supabase.

    Accepts the full content of social_posts.md as a string, uploads the
    post image to Supabase Storage (if available), inserts a row into
    social_posts, and also reads blog_post.md to insert a linked row
    into blog_posts.

    Call this as the FINAL step after writing the social posts and blog post.
    Pass the COMPLETE text of the social_posts.md file you just created.
    If you successfully published to WordPress, pass the WordPress metadata
    as arguments too.

    Args:
        social_posts_markdown: The complete markdown content of social_posts.md,
            including all platform sections (X/Twitter, Instagram, Facebook).
        wp_post_url: The live URL of the published WordPress post (if any).
        wp_post_id: The integer ID of the WordPress post (if any).
        wp_edit_url: The admin edit URL of the WordPress post (if any).
        wp_status: The publish status of the WordPress post ('publish' or 'draft').

    Returns:
        Confirmation message with the Supabase row ID, or an error description.
    """
    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    if not supabase_url:
        return "⚠️ SUPABASE_URL not set — skipping Supabase save."

    if not social_posts_markdown or not social_posts_markdown.strip():
        return "⚠️ social_posts_markdown is empty — nothing to save."

    markdown = social_posts_markdown.strip()
    parsed = _parse_posts(markdown)

    print(f"[save_to_supabase] Parsed title: {parsed['title']!r}")
    print(f"[save_to_supabase] Twitter chars: {len(parsed['twitter'])}")
    print(f"[save_to_supabase] Instagram chars: {len(parsed['instagram'])}")
    print(f"[save_to_supabase] Facebook chars: {len(parsed['facebook'])}")

    # ── Image path resolution (same as before) ────────────────────────────────
    img_path = None

    # 1. Trust the machine-written file first
    if _LATEST_IMAGE_FILE.exists():
        try:
            machine_path = _LATEST_IMAGE_FILE.read_text(encoding="utf-8").strip()
            if machine_path and Path(machine_path).exists():
                img_path = machine_path
                print(f"[save_to_supabase] Using image from latest_image_path.txt: {img_path}")
            else:
                print(f"[save_to_supabase] latest_image_path.txt path not found on disk: {machine_path!r}")
        except Exception as e:
            print(f"[save_to_supabase] Could not read latest_image_path.txt: {e}")

    # 2. Fall back to agent-written markdown Images section
    if not img_path:
        img_path = parsed["image_path"]
        if img_path:
            print(f"[save_to_supabase] Falling back to markdown Images path: {img_path}")
            if not Path(img_path).exists():
                print(f"[save_to_supabase] ⚠️ Markdown image path also not found on disk — skipping upload.")
                img_path = None

    # Upload image (optional — run in thread so SSL hangs can't block the DB insert)
    image_url = None
    _result_box: list = []

    def _upload_in_thread():
        try:
            _result_box.append(_upload_image(supabase_url, img_path))
        except BaseException as e:
            print(f"[save_to_supabase] ⚠️ Image upload failed in thread: {e}")
            _result_box.append(None)

    t = threading.Thread(target=_upload_in_thread, daemon=True)
    t.start()
    t.join(timeout=20)
    if t.is_alive():
        print("[save_to_supabase] ⚠️ Image upload timed out (20 s) — skipping.")
    else:
        image_url = _result_box[0] if _result_box else None

    # ── Insert social_posts row ───────────────────────────────────────────────
    row = {
        "title": parsed["title"],
        "twitter": parsed["twitter"],
        "instagram": parsed["instagram"],
        "facebook": parsed["facebook"],
        "sources": parsed["sources"],
        "has_image": image_url is not None,
        "image_url": image_url,
        "raw_markdown": markdown,
    }

    insert_url = f"{supabase_url}/rest/v1/social_posts"
    headers = _supabase_headers()
    headers["Prefer"] = "return=representation"

    resp = requests.post(insert_url, headers=headers, json=row, timeout=15)
    if not resp.ok:
        print(f"[save_to_supabase] ❌ social_posts insert failed ({resp.status_code}): {resp.text[:400]}")
        return (
            f"❌ Supabase insert failed ({resp.status_code}): {resp.text[:200]}. "
            "Posts are still available in memory."
        )

    result = resp.json()
    social_row_id = result[0].get("id", "?") if result else "?"
    print(f"[save_to_supabase] ✅ social_posts row inserted: {social_row_id}")

    # ── Insert blog_posts row (optional — don't fail hard if missing) ─────────
    blog_row_id = None
    if _BLOG_POST_FILE.exists():
        try:
            blog_md = _BLOG_POST_FILE.read_text(encoding="utf-8").strip()
            blog_data = _parse_blog_post(blog_md)

            blog_row = {
                "social_post_id":  social_row_id if social_row_id != "?" else None,
                "title":           blog_data.get("title", ""),
                "slug":            blog_data.get("slug", ""),
                "content_md":      blog_md,
                "excerpt":         blog_data.get("excerpt", ""),
                "focus_keyword":   blog_data.get("focus_keyword", ""),
                "meta_description": blog_data.get("meta_description", ""),
                "category_hint":   blog_data.get("category_hint", ""),
                "wp_post_url":     wp_post_url or blog_data.get("wp_post_url"),
                "wp_post_id":      int(wp_post_id) if str(wp_post_id).isdigit() else blog_data.get("wp_post_id"),
                "wp_edit_url":     wp_edit_url or blog_data.get("wp_edit_url"),
                "wp_status":       wp_status if wp_post_url else blog_data.get("wp_status", "draft"),
                "has_image_1":     blog_data.get("image_1_url") is not None,
                "has_image_2":     blog_data.get("image_2_url") is not None,
                "image_1_url":     blog_data.get("image_1_url"),
                "image_2_url":     blog_data.get("image_2_url"),
            }

            blog_headers = _supabase_headers()
            blog_headers["Prefer"] = "return=representation"
            blog_resp = requests.post(
                f"{supabase_url}/rest/v1/blog_posts",
                headers=blog_headers,
                json=blog_row,
                timeout=15,
            )
            if blog_resp.ok:
                blog_result = blog_resp.json()
                blog_row_id = blog_result[0].get("id", "?") if blog_result else "?"
                print(f"[save_to_supabase] ✅ blog_posts row inserted: {blog_row_id}")
            else:
                print(
                    f"[save_to_supabase] ⚠️ blog_posts insert failed "
                    f"({blog_resp.status_code}): {blog_resp.text[:200]}"
                )
        except Exception as e:
            print(f"[save_to_supabase] ⚠️ blog_posts save error (non-fatal): {e}")
    else:
        print("[save_to_supabase] blog_post.md not found — skipping blog_posts row.")

    return (
        f"✅ Posts saved to Supabase.\n"
        f"  social_posts id: {social_row_id}\n"
        f"  blog_posts id:   {blog_row_id or 'not saved (blog_post.md missing or error)'}\n"
        f"  Image: {'uploaded → ' + (image_url or '') if image_url else 'not available'}.\n"
        "The web UI will now show this post on the /posts page."
    )

