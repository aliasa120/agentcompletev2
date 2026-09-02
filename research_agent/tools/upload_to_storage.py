"""upload_to_storage — explicit, on-demand file upload to unified storage.

This is the tool the agent calls when the USER asks for a shareable link
("make me a PDF and give me its link", "upload this to storage", "share that
image with me"). It is the deliberate counterpart to the old behaviour where
*every* file the agent touched was mirrored to R2 automatically — that blanket
mirror is now opt-in (``storage_auto_upload_files``), and this tool is the
explicit path.

Credentials resolve exactly like every other provider in the system
(``storage_service.get_r2_config``): per-user ``agent_settings`` keys first,
then environment variables:

    r2_account_id        → R2_ACCOUNT_ID
    r2_access_key_id     → R2_ACCESS_KEY_ID
    r2_secret_access_key → R2_SECRET_ACCESS_KEY
    r2_bucket_name       → R2_BUCKET_NAME
    r2_public_base_url   → R2_PUBLIC_BASE_URL

When R2 is not configured the Supabase ``uploads`` bucket is used automatically,
so the tool always returns a usable link if any storage backend is available.

The result embeds a ``FILE_URL:<url>`` marker, which the chat UI converts into a
download/preview card (image, audio and video render inline).
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

logger = logging.getLogger("research_agent.upload_to_storage")

# Same marker the terminal tool uses; the UI runtime strips it into file cards.
FILE_URL_MARKER = "FILE_URL:"

# Hard ceiling for a single explicit upload (generous — this is user-requested).
MAX_UPLOAD_BYTES = 200 * 1024 * 1024  # 200 MB

_EXT_CATEGORIES = {
    "images": ("png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "ico", "tiff"),
    "audio": ("mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"),
    "video": ("mp4", "webm", "mov", "avi", "mkv", "m4v"),
    "documents": (
        "pdf", "pptx", "ppt", "docx", "doc", "xlsx", "xls", "csv",
        "md", "txt", "rtf", "odt", "epub", "json", "html",
    ),
}


def classify_category(filename: str) -> str:
    """Map a filename extension to a storage category (matches fs_backend/terminal)."""
    ext = os.path.splitext(filename)[1].lower().lstrip(".")
    for category, exts in _EXT_CATEGORIES.items():
        if ext in exts:
            return category
    return "workspace"


def _human_size(num_bytes: int) -> str:
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{num_bytes} B"


def resolve_local_file(file_path: str, config: Optional[RunnableConfig] = None) -> Optional[str]:
    """Resolve a possibly-relative agent path to a real file on disk.

    Agents work with simple relative paths inside their thread workspace
    (``output/threads/<thread_id>/``), so try that first, then the raw path,
    then the process cwd, then the basename inside the thread dir.
    """
    from research_agent.fs_backend import get_thread_output_dir

    raw = (file_path or "").strip().strip('"').strip("'")
    if not raw:
        return None

    # Virtual paths ("/report.pdf") are thread-workspace-relative, not absolute.
    virtual = raw.lstrip("/\\") if raw.startswith("/") else raw

    candidates = []
    try:
        thread_dir = get_thread_output_dir(config, create=False)
        candidates += [
            os.path.join(thread_dir, virtual),
            os.path.join(thread_dir, os.path.basename(virtual)),
        ]
    except Exception:
        pass
    candidates += [raw, os.path.join(os.getcwd(), virtual)]

    for cand in candidates:
        try:
            if cand and os.path.isfile(cand):
                return os.path.abspath(cand)
        except OSError:
            continue
    return None


@tool
def upload_to_storage(
    file_path: str,
    category: str = "",
    config: RunnableConfig = None,
) -> str:
    """Upload a local file to cloud storage and return a public shareable link.

    Use this whenever the user asks for a LINK, URL, or shareable/downloadable
    copy of a file, or asks you to upload something. Typical triggers:
      - "make this PDF and give me its link"
      - "upload that image and share the URL"
      - "I need a download link for the report"

    Also use it to obtain a public URL for media BEFORE saving a social media
    post: `save_instagram_post`, `save_facebook_post` and `save_youtube_video`
    require a public HTTPS URL, never a local filename.

    Files created by `write_file` or `terminal` stay on local disk only, so call
    this tool to publish one. Files the USER attached are already uploaded — reuse
    the URL shown in the conversation instead of calling this tool for them.

    Args:
        file_path: Path of the local file, normally the simple relative name you
            used when creating it (e.g. "report.pdf", "chart.png").
        category: Optional storage folder override
            ('documents', 'images', 'audio', 'video', 'workspace').
            Leave empty to classify automatically from the file extension.

    Returns:
        A confirmation containing the public URL, or an explicit error message.
    """
    from research_agent import storage_service

    if not (file_path or "").strip():
        return "[Error] upload_to_storage requires a file_path (e.g. 'report.pdf')."

    resolved = resolve_local_file(file_path, config)
    if not resolved:
        return (
            f"[Error] File not found: '{file_path}'. It must exist in your thread "
            f"workspace. Create it first with `write_file` or `terminal`, then "
            f"verify with `ls`."
        )

    try:
        size = os.path.getsize(resolved)
    except OSError as e:
        return f"[Error] Cannot read '{file_path}': {e}"

    if size == 0:
        return f"[Error] '{os.path.basename(resolved)}' is empty (0 bytes) — nothing to upload."
    if size > MAX_UPLOAD_BYTES:
        return (
            f"[Error] '{os.path.basename(resolved)}' is {_human_size(size)}, over the "
            f"{_human_size(MAX_UPLOAD_BYTES)} upload limit."
        )

    filename = os.path.basename(resolved)
    final_category = (category or "").strip().lower() or classify_category(filename)

    thread_id = None
    if config and isinstance(config, dict):
        thread_id = (config.get("configurable") or {}).get("thread_id")

    try:
        url = storage_service.upload_file(
            local_path=resolved,
            filename=filename,
            category=final_category,
            thread_id=thread_id,
        )
    except Exception as e:
        logger.error(f"[upload_to_storage] upload failed for {resolved}: {e}")
        return f"[Error] Upload of '{filename}' failed: {e}"

    if not url:
        return (
            f"[Error] Upload of '{filename}' failed: no storage backend is configured. "
            f"Ask the user to set their Cloudflare R2 credentials (or Supabase) in "
            f"Settings → ENV Keys."
        )

    logger.info(f"[upload_to_storage] {filename} → {url}")
    return (
        f"[Success] Uploaded '{filename}' ({_human_size(size)}) to storage.\n"
        f"Public link: {url}\n"
        f"{FILE_URL_MARKER}{url}\n"
        f"Share this link with the user in your reply."
    )
