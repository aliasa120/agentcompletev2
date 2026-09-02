"""Unified Social Media Saver Tools for AI Agents.

These tools allow the AI agent to save structured, platform-accurate posts for:
- Instagram (Reels, Photos, Videos, Carousels)
- Facebook (Text posts, Photo posts, Video/Reel posts)
- YouTube (Videos with titles, descriptions, tags, and custom thumbnails)
- Multi-platform Social Bundles

The stored schemas match the exact parameter requirements for downstream Composio MCP execution.
"""

import json
import os
import threading
from typing import Any, Dict, List, Optional
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


def _current_user_id() -> Optional[str]:
    """Resolve the active user id so saved posts are owned, letting /api/publish
    scope Composio connections and R2 credentials to the right account."""
    try:
        from research_agent import storage_service

        uid = storage_service._resolve_user_id()
        if not uid:
            return None
        import uuid as _uuid

        _uuid.UUID(str(uid))  # social_posts.user_id is a uuid column
        return str(uid)
    except Exception:
        return None


def _with_owner(row: dict) -> dict:
    """Attach user_id to a row when the active user is known."""
    uid = _current_user_id()
    if uid:
        row = {**row, "user_id": uid}
    return row


# â”€â”€ Media URL normalization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
#
# Platforms (and the /api/publish route) need a PUBLIC HTTPS URL for every media
# asset: Instagram and Facebook make Meta fetch the URL directly, and YouTube
# needs bytes that the publisher streams to Composio. Agents used to persist bare
# filenames ("clip.mp4") or Windows paths, which the publisher could not resolve.
#
# ``normalize_media_reference`` guarantees a stored value is always a public URL:
#   1. http(s) URL            â†’ kept as-is (attachments are already on R2)
#   2. local file on disk     â†’ uploaded to unified storage, public URL returned
#   3. registered thread_file â†’ public URL recovered from the registry
#   4. otherwise              â†’ (None, reason) so the caller can fail loudly

_MEDIA_CATEGORIES = {
    "images": ("png", "jpg", "jpeg", "webp", "gif", "svg", "bmp"),
    "audio": ("mp3", "wav", "ogg", "m4a", "aac", "flac"),
    "video": ("mp4", "webm", "mov", "avi", "mkv", "m4v"),
}


def _media_category(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower().lstrip(".")
    for category, exts in _MEDIA_CATEGORIES.items():
        if ext in exts:
            return category
    return "uploads"


def _looks_like_image(url: str) -> bool:
    """True when a URL clearly points at a still image (used to reject bad video refs)."""
    path = (url or "").split("?")[0].lower()
    return path.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"))


def normalize_media_reference(reference: str, field_name: str = "media_url") -> tuple[Optional[str], str]:
    """Resolve a media reference to a public URL.

    Returns ``(public_url, error_message)``. ``public_url`` is None when the
    reference cannot be resolved, and ``error_message`` explains what to do.
    Empty input resolves to ``("", "")`` because several media fields are optional.
    """
    ref = (reference or "").strip()
    if not ref:
        return "", ""

    if ref.startswith(("http://", "https://")):
        return ref, ""

    if ref.startswith("data:"):
        return None, (
            f"[Error] {field_name} is an inline data URI. Upload the file first with "
            f"`upload_to_storage(file_path=...)` and pass the returned public URL."
        )

    try:
        from research_agent import storage_service

        location, filename = storage_service.resolve_file_source(ref)

        # resolve_file_source returns the registry's public URL when the file is
        # not on this machine â€” already exactly what we need.
        if location and location.startswith(("http://", "https://")):
            return location, ""

        if location and os.path.isfile(location):
            url = storage_service.upload_file(
                local_path=location,
                filename=filename,
                category=_media_category(filename),
            )
            if url:
                try:
                    print(f"[social_saver] uploaded local media '{ref}' -> {url}")
                except Exception:
                    pass  # console encoding must never fail a successful upload
                return url, ""
            return None, (
                f"[Error] {field_name} '{ref}' exists locally but could not be uploaded to "
                f"storage (no storage backend configured). Ask the user to set Cloudflare R2 "
                f"credentials in Settings â†’ ENV Keys."
            )
    except Exception as e:
        return None, f"[Error] Failed to resolve {field_name} '{ref}': {e}"

    return None, (
        f"[Error] {field_name} '{ref}' is not a public URL and no such file exists. "
        f"Social platforms require a public HTTPS URL. Use the storage URL shown for the "
        f"user's attachment, or create the file and call "
        f"`upload_to_storage(file_path='{os.path.basename(ref)}')` to get one."
    )


def _normalize_media_fields(fields: dict[str, str]) -> tuple[dict[str, str], Optional[str]]:
    """Normalize several media references at once.

    Returns ``(resolved, error)``; ``error`` is the first failure encountered.
    """
    resolved: dict[str, str] = {}
    for name, value in fields.items():
        url, err = normalize_media_reference(value, field_name=name)
        if err:
            return resolved, err
        resolved[name] = url or ""
    return resolved, None


def _internal_api_headers() -> dict[str, str]:
    """Headers for calling the Next.js API as a trusted server-to-server caller.

    /api/publish requires either a browser session or this internal token; the
    agent has no cookies, so it presents the token instead.
    """
    token = (
        os.environ.get("INTERNAL_API_TOKEN")
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or ""
    ).strip()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["x-internal-token"] = token
    return headers


def _trigger_auto_publish_if_enabled(post_id: str, platforms: List[str]):
    """If social_auto_publish is enabled in settings, immediately publish via /api/publish."""
    def _worker():
        try:
            supabase_url = _get_supabase_url()
            if not supabase_url:
                return
            res = requests.get(
                f"{supabase_url}/rest/v1/agent_settings?key=eq.social_auto_publish&select=value",
                headers=_supabase_headers(),
                timeout=5
            )
            if res.ok and res.json():
                auto_pub = res.json()[0].get("value", "").lower() == "true"
                if auto_pub:
                    next_url = os.environ.get("NEXT_PUBLIC_APP_URL") or os.environ.get("NEXT_APP_URL", "http://localhost:3000")
                    print(f"[social_saver] Auto-publishing post {post_id} to {platforms} via {next_url}/api/publish...")
                    pub_res = requests.post(
                        f"{next_url}/api/publish",
                        json={"post_id": post_id, "platforms": platforms},
                        headers=_internal_api_headers(),
                        timeout=120
                    )
                    print(f"[social_saver] Auto-publish result for {post_id}: {pub_res.status_code}")
        except Exception as e:
            print(f"[social_saver] Auto-publish background worker error: {e}")

    threading.Thread(target=_worker, daemon=True).start()


@tool
def save_instagram_post(
    caption: str,
    media_url: str,
    media_type: str = "reel",
    cover_url: str = "",
    carousel_urls: Optional[List[str]] = None,
) -> str:
    """Save an Instagram post or reel to the database for user review and publishing.

    Args:
        caption: The caption text for the Instagram post including hashtags.
        media_url: PUBLIC HTTPS URL of the photo or video (e.g. the storage URL of
            the user's attachment). A local filename is accepted only if the file
            exists in the workspace â€” it is then uploaded to storage automatically.
        media_type: Content type: 'reel' (short vertical video), 'photo', 'video', or 'carousel'.
        cover_url: Optional cover image URL for reels and videos.
        carousel_urls: Optional list of additional image/video URLs for carousels.
    """
    supabase_url = _get_supabase_url()
    if not supabase_url:
        return "[Error] SUPABASE_URL not configured â€” post kept in memory."

    # Instagram requires Meta to fetch the media over public HTTPS.
    resolved, err = _normalize_media_fields({"media_url": media_url, "cover_url": cover_url})
    if err:
        return err
    media_url = resolved["media_url"]
    cover_url = resolved["cover_url"]
    if not media_url:
        return "[Error] save_instagram_post requires media_url (a public HTTPS image or video URL)."

    carousel_list = []
    for idx, item in enumerate(carousel_urls or []):
        item_url, item_err = normalize_media_reference(item, field_name=f"carousel_urls[{idx}]")
        if item_err:
            return item_err
        if item_url:
            carousel_list.append(item_url)

    row = {
        "title": caption[:60] + "..." if len(caption) > 60 else caption,
        "instagram": caption,
        "image_url": cover_url or media_url,
        "has_image": bool(cover_url or media_url),
        "instagram_data": {
            "caption": caption,
            "media_type": media_type,
            "media_url": media_url,
            "cover_url": cover_url,
            "carousel_urls": carousel_list,
        },
        "published_to": {"instagram": False},
    }

    try:
        resp = requests.post(
            f"{supabase_url}/rest/v1/social_posts",
            headers=_supabase_headers(),
            json=_with_owner(row),
            timeout=15,
        )
        if not resp.ok:
            return f"[Error] Failed to save Instagram post: {resp.status_code} {resp.text[:200]}"

        post_data = resp.json()
        post_id = post_data[0]["id"] if post_data else "?"

        # Insert into specialized social_instagram_posts table
        ig_row = {
            "post_id": post_id,
            "caption": caption,
            "media_type": media_type,
            "media_url": media_url,
            "cover_url": cover_url,
            "carousel_urls": carousel_list,
            "status": "draft",
        }
        requests.post(
            f"{supabase_url}/rest/v1/social_instagram_posts",
            headers=_supabase_headers(),
            json=_with_owner(ig_row),
            timeout=10,
        )

        _trigger_auto_publish_if_enabled(post_id, ["instagram"])

        return f"[Success] Instagram {media_type.capitalize()} saved to Posts console (ID: {post_id}). Ready for 1-click publishing!"
    except Exception as e:
        return f"[Error] saving Instagram post: {str(e)}"


@tool
def save_facebook_post(
    message: str,
    media_type: str = "text",
    media_url: str = "",
    title: str = "",
    link: str = "",
) -> str:
    """Save a Facebook page post, photo post, or video reel to the database.

    Args:
        message: The text/caption for the Facebook post.
        media_type: Post format: 'text', 'photo', or 'video'.
        media_url: PUBLIC HTTPS URL of the image or video (e.g. the storage URL of
            the user's attachment). A local filename is accepted only if the file
            exists in the workspace â€” it is then uploaded to storage automatically.
        title: Title of the video or post.
        link: Optional external web link.
    """
    supabase_url = _get_supabase_url()
    if not supabase_url:
        return "[Error] SUPABASE_URL not configured â€” post kept in memory."

    # Facebook fetches photo/video media from a public URL (Graph url / file_url).
    resolved, err = _normalize_media_fields({"media_url": media_url})
    if err:
        return err
    media_url = resolved["media_url"]
    if media_type in ("photo", "video") and not media_url:
        return f"[Error] media_type='{media_type}' requires media_url (a public HTTPS URL)."

    row = {
        "title": title or (message[:60] + "..." if len(message) > 60 else message),
        "facebook": message,
        "image_url": media_url or None,
        "has_image": bool(media_url),
        "facebook_data": {
            "message": message,
            "media_type": media_type,
            "media_url": media_url,
            "title": title,
            "link": link,
        },
        "published_to": {"facebook": False},
    }

    try:
        resp = requests.post(
            f"{supabase_url}/rest/v1/social_posts",
            headers=_supabase_headers(),
            json=_with_owner(row),
            timeout=15,
        )
        if not resp.ok:
            return f"[Error] Failed to save Facebook post: {resp.status_code} {resp.text[:200]}"

        post_data = resp.json()
        post_id = post_data[0]["id"] if post_data else "?"

        # Insert into specialized social_facebook_posts table
        fb_row = {
            "post_id": post_id,
            "message": message,
            "title": title,
            "media_type": media_type,
            "media_url": media_url,
            "link": link,
            "status": "draft",
        }
        requests.post(
            f"{supabase_url}/rest/v1/social_facebook_posts",
            headers=_supabase_headers(),
            json=_with_owner(fb_row),
            timeout=10,
        )

        _trigger_auto_publish_if_enabled(post_id, ["facebook"])

        return f"[Success] Facebook {media_type.capitalize()} post saved to Posts console (ID: {post_id}). Ready for publishing!"
    except Exception as e:
        return f"[Error] saving Facebook post: {str(e)}"


@tool
def save_youtube_video(
    title: str,
    description: str,
    video_url: str,
    thumbnail_url: str = "",
    tags: Optional[List[str]] = None,
    category_id: str = "22",
    privacy_status: str = "public",
) -> str:
    """Save a YouTube video or Shorts upload draft with metadata, tags, and custom thumbnail.

    Args:
        title: The video title (max 100 characters, include #Shorts if it's a short-form vertical video).
        description: Full description text including links, timestamps, and hashtags.
        video_url: PUBLIC HTTPS URL of the video file (e.g. the storage URL of the
            user's attachment). A local filename is accepted only if the file exists
            in the workspace â€” it is then uploaded to storage automatically.
        thumbnail_url: Optional custom thumbnail image URL (16:9).
        tags: List of keyword search tags to optimize SEO discoverability.
        category_id: YouTube category ID (default '22' for People & Blogs).
        privacy_status: Upload privacy: 'public', 'unlisted', or 'private'.
    """
    supabase_url = _get_supabase_url()
    if not supabase_url:
        return "[Error] SUPABASE_URL not configured â€” video draft kept in memory."

    # The publisher downloads video_url and streams the bytes to Composio, so it
    # must be fetchable â€” a bare filename cannot be resolved at publish time.
    resolved, err = _normalize_media_fields(
        {"video_url": video_url, "thumbnail_url": thumbnail_url}
    )
    if err:
        return err
    video_url = resolved["video_url"]
    thumbnail_url = resolved["thumbnail_url"]
    if not video_url:
        return "[Error] save_youtube_video requires video_url (a public HTTPS video URL)."
    if _looks_like_image(video_url):
        return (
            f"[Error] video_url '{video_url}' looks like an image, not a video. "
            f"YouTube needs an actual video file (.mp4/.mov/.webm)."
        )

    tags_list = tags or []
    row = {
        "title": title,
        "youtube": f"{title}\n\n{description}",
        "image_url": thumbnail_url,
        "has_image": bool(thumbnail_url),
        "youtube_data": {
            "title": title,
            "description": description,
            "video_url": video_url,
            "thumbnail_url": thumbnail_url,
            "tags": tags_list,
            "category_id": category_id,
            "privacy_status": privacy_status,
        },
        "published_to": {"youtube": False},
    }

    try:
        resp = requests.post(
            f"{supabase_url}/rest/v1/social_posts",
            headers=_supabase_headers(),
            json=_with_owner(row),
            timeout=15,
        )
        if not resp.ok:
            return f"[Error] Failed to save YouTube video draft: {resp.status_code} {resp.text[:200]}"

        post_data = resp.json()
        post_id = post_data[0]["id"] if post_data else "?"

        # Insert into specialized social_youtube_posts table
        yt_row = {
            "post_id": post_id,
            "title": title,
            "description": description,
            "video_url": video_url,
            "thumbnail_url": thumbnail_url,
            "tags": tags_list,
            "category_id": category_id,
            "privacy_status": privacy_status,
            "status": "draft",
        }
        requests.post(
            f"{supabase_url}/rest/v1/social_youtube_posts",
            headers=_supabase_headers(),
            json=_with_owner(yt_row),
            timeout=10,
        )

        _trigger_auto_publish_if_enabled(post_id, ["youtube"])

        return f"[Success] YouTube Video draft '{title}' saved to Posts console (ID: {post_id}). Ready for upload & publishing!"
    except Exception as e:
        return f"[Error] saving YouTube draft: {str(e)}"


@tool
def save_social_bundle(
    title: str,
    instagram: Optional[Dict[str, Any]] = None,
    facebook: Optional[Dict[str, Any]] = None,
    youtube: Optional[Dict[str, Any]] = None,
    twitter: Optional[str] = None,
) -> str:
    """Save a multi-platform social media campaign bundle across Instagram, Facebook, YouTube, and X in one call.

    All media fields must be PUBLIC HTTPS URLs (e.g. the storage URLs of the user's
    attachments). Local filenames are accepted only if the file exists in the
    workspace â€” it is then uploaded to storage automatically.

    Args:
        title: Main campaign or post title.
        instagram: Dict with Instagram fields: {'caption': str, 'media_url': str, 'media_type': 'reel'|'photo'|'video', 'cover_url': str}.
        facebook: Dict with Facebook fields: {'message': str, 'media_type': 'text'|'photo'|'video', 'media_url': str, 'title': str}.
        youtube: Dict with YouTube fields: {'title': str, 'description': str, 'video_url': str, 'thumbnail_url': str, 'tags': list}.
        twitter: Tweet text (max 280 chars) for X / Twitter.
    """
    supabase_url = _get_supabase_url()
    if not supabase_url:
        return "[Error] SUPABASE_URL not configured â€” bundle kept in memory."

    # Normalize every per-platform media reference to a public URL before saving,
    # so 1-click publish never sees an unresolvable filename.
    instagram = dict(instagram) if instagram else None
    facebook = dict(facebook) if facebook else None
    youtube = dict(youtube) if youtube else None

    for payload, field_names, label in (
        (instagram, ("media_url", "cover_url"), "instagram"),
        (facebook, ("media_url",), "facebook"),
        (youtube, ("video_url", "thumbnail_url"), "youtube"),
    ):
        if not payload:
            continue
        for field in field_names:
            url, err = normalize_media_reference(payload.get(field, ""), field_name=f"{label}.{field}")
            if err:
                return err
            payload[field] = url or ""

    if instagram and not instagram.get("media_url"):
        return "[Error] instagram.media_url is required (a public HTTPS image or video URL)."
    if facebook and facebook.get("media_type") in ("photo", "video") and not facebook.get("media_url"):
        return f"[Error] facebook.media_url is required for media_type='{facebook.get('media_type')}'."
    if youtube:
        if not youtube.get("video_url"):
            return "[Error] youtube.video_url is required (a public HTTPS video URL)."
        if _looks_like_image(youtube["video_url"]):
            return (
                f"[Error] youtube.video_url '{youtube['video_url']}' looks like an image, "
                f"not a video. YouTube needs an actual video file."
            )

    cover_image = None
    if instagram and instagram.get("cover_url"):
        cover_image = instagram["cover_url"]
    elif youtube and youtube.get("thumbnail_url"):
        cover_image = youtube["thumbnail_url"]
    elif instagram and instagram.get("media_url") and instagram.get("media_type") == "photo":
        cover_image = instagram["media_url"]
    elif facebook and facebook.get("media_url") and facebook.get("media_type") == "photo":
        cover_image = facebook["media_url"]

    row = {
        "title": title,
        "twitter": twitter or "",
        "instagram": instagram.get("caption", "") if instagram else "",
        "facebook": facebook.get("message", "") if facebook else "",
        "youtube": f"{youtube.get('title', '')}\n\n{youtube.get('description', '')}" if youtube else "",
        "instagram_data": instagram,
        "facebook_data": facebook,
        "youtube_data": youtube,
        "image_url": cover_image,
        "has_image": bool(cover_image),
        "published_to": {
            "instagram": False if instagram else None,
            "facebook": False if facebook else None,
            "youtube": False if youtube else None,
            "twitter": False if twitter else None,
        },
    }

    try:
        resp = requests.post(
            f"{supabase_url}/rest/v1/social_posts",
            headers=_supabase_headers(),
            json=_with_owner(row),
            timeout=15,
        )
        if not resp.ok:
            return f"[Error] Failed to save social bundle: {resp.status_code} {resp.text[:200]}"

        post_data = resp.json()
        post_id = post_data[0]["id"] if post_data else "?"

        if instagram:
            requests.post(
                f"{supabase_url}/rest/v1/social_instagram_posts",
                headers=_supabase_headers(),
                json=_with_owner({
                    "post_id": post_id,
                    "caption": instagram.get("caption", ""),
                    "media_type": instagram.get("media_type", "reel"),
                    "media_url": instagram.get("media_url", ""),
                    "cover_url": instagram.get("cover_url", ""),
                    "carousel_urls": instagram.get("carousel_urls", []),
                    "status": "draft",
                }),
                timeout=10,
            )

        if facebook:
            requests.post(
                f"{supabase_url}/rest/v1/social_facebook_posts",
                headers=_supabase_headers(),
                json=_with_owner({
                    "post_id": post_id,
                    "message": facebook.get("message", ""),
                    "title": facebook.get("title", ""),
                    "media_type": facebook.get("media_type", "text"),
                    "media_url": facebook.get("media_url", ""),
                    "link": facebook.get("link", ""),
                    "status": "draft",
                }),
                timeout=10,
            )

        if youtube:
            requests.post(
                f"{supabase_url}/rest/v1/social_youtube_posts",
                headers=_supabase_headers(),
                json=_with_owner({
                    "post_id": post_id,
                    "title": youtube.get("title", ""),
                    "description": youtube.get("description", ""),
                    "video_url": youtube.get("video_url", ""),
                    "thumbnail_url": youtube.get("thumbnail_url", ""),
                    "tags": youtube.get("tags", []),
                    "category_id": youtube.get("category_id", "22"),
                    "privacy_status": youtube.get("privacy_status", "public"),
                    "status": "draft",
                }),
                timeout=10,
            )

        channels = []
        if instagram: channels.append("Instagram")
        if facebook: channels.append("Facebook")
        if youtube: channels.append("YouTube")
        if twitter: channels.append("X/Twitter")

        _trigger_auto_publish_if_enabled(post_id, [c.lower().replace("x/twitter", "twitter") for c in channels])

        return f"[Success] Social Campaign Bundle '{title}' saved for [{', '.join(channels)}] (ID: {post_id}). Ready in Posts console!"
    except Exception as e:
        return f"[Error] saving social bundle: {str(e)}"
