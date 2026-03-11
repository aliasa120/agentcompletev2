"""Save generated social posts to Supabase.

Uses Supabase REST API directly (no extra Python package needed).
Accepts the social_posts.md content as a string parameter (the agent passes it directly),
uploads the image to Supabase Storage, then inserts a row into social_posts.
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
def save_posts_to_supabase(social_posts_markdown: str) -> str:
    """Save the generated social posts to Supabase for display in the web UI.

    Accepts the full content of social_posts.md as a string, uploads the
    post image to Supabase Storage (if available), then inserts a row into
    the social_posts table.

    Call this as the FINAL step after writing the social posts.
    Pass the COMPLETE text of the social_posts.md file you just created.

    Args:
        social_posts_markdown: The complete markdown content of social_posts.md,
            including all platform sections (X/Twitter, Instagram, Facebook),
            the Sources section, and any Images section.

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

    # ── Image path: markdown Images section OR fallback to latest_image_path.txt ──
    img_path = parsed["image_path"]
    if not img_path and _LATEST_IMAGE_FILE.exists():
        try:
            fallback = _LATEST_IMAGE_FILE.read_text(encoding="utf-8").strip()
            if fallback and Path(fallback).exists():
                img_path = fallback
                print(f"[save_to_supabase] Using fallback image from latest_image_path.txt: {img_path}")
        except Exception as e:
            print(f"[save_to_supabase] Could not read latest_image_path.txt: {e}")

    # Upload image (optional — run in thread so SSL hangs can't block the DB insert)
    image_url = None
    _result_box: list = []  # mutable box so the thread can pass back the URL

    def _upload_in_thread():
        try:
            _result_box.append(_upload_image(supabase_url, img_path))
        except BaseException as e:
            print(f"[save_to_supabase] ⚠️ Image upload failed in thread: {e}")
            _result_box.append(None)

    t = threading.Thread(target=_upload_in_thread, daemon=True)
    t.start()
    t.join(timeout=20)  # give upload at most 20 s; abandon if SSL hangs
    if t.is_alive():
        print("[save_to_supabase] ⚠️ Image upload timed out (20 s) — skipping.")
    else:
        image_url = _result_box[0] if _result_box else None

    # Insert row
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
    if resp.ok:
        result = resp.json()
        row_id = result[0].get("id", "?") if result else "?"
        print(f"[save_to_supabase] ✅ Row inserted: {row_id}")
        return (
            f"✅ Posts saved to Supabase (id={row_id}). "
            f"Image: {'uploaded' if image_url else 'not available'}. "
            "The web UI will now show this post on the /posts page."
        )
    else:
        print(f"[save_to_supabase] ❌ Insert failed ({resp.status_code}): {resp.text[:400]}")
        return (
            f"❌ Supabase insert failed ({resp.status_code}): {resp.text[:200]}. "
            "Posts are still available in memory."
        )
