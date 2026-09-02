"""Unified Storage Service — single source of truth for all file storage.

Architecture (portable deployment model):
    - **Cloudflare R2** is the primary, portable file layer. Files stored here
      survive deployment moves (web VPS → PC build) because public R2 links are
      embedded in chat history and the ``thread_files`` registry lives in Supabase.
    - **Supabase DB (thread_files table)** is the portable registry. Any machine
      with the user's Supabase credentials can resolve files by thread/filename.
    - **Supabase Storage** remains as an automatic fallback when R2 is not
      configured (full backward compatibility).
    - **Local disk** (output/threads/<id>/) is an ephemeral workspace/cache.

Credential resolution (per-user SaaS pattern, same as every other provider):
    agent_settings keys (via UI ENV Keys section) → env var fallbacks:
      r2_account_id        → R2_ACCOUNT_ID
      r2_access_key_id     → R2_ACCESS_KEY_ID
      r2_secret_access_key → R2_SECRET_ACCESS_KEY
      r2_bucket_name       → R2_BUCKET_NAME
      r2_public_base_url   → R2_PUBLIC_BASE_URL   (r2.dev URL or custom domain)

Retention policy:
    agent_settings key ``storage_retention_days`` (default "30", "0" = forever).
    Snapshotted into ``thread_files.expires_at`` at upload time; enforced daily
    by ``cleanup_expired_files()`` from cron_scheduler.

Upload policy:
    Cloud storage is used for files that need a shareable URL — user attachments,
    generated media, social-post media, and explicit ``upload_to_storage`` calls.
    Mirroring EVERY agent-created file is opt-in via agent_settings
    ``storage_auto_upload_files`` / env ``STORAGE_AUTO_UPLOAD_FILES``
    (see ``auto_upload_enabled``). Agent scratch files stay in the thread
    workspace and are served by the UI's thread-files routes.
"""

from __future__ import annotations

import datetime
import logging
import mimetypes
import os
import re
import threading
import uuid
from typing import Any, Optional

from research_agent.fs_backend import sanitize_thread_id

logger = logging.getLogger("storage_service")

# ── Constants ──────────────────────────────────────────────────────────────────

R2_SETTING_KEYS = {
    "account_id": ("r2_account_id", "R2_ACCOUNT_ID"),
    "access_key_id": ("r2_access_key_id", "R2_ACCESS_KEY_ID"),
    "secret_access_key": ("r2_secret_access_key", "R2_SECRET_ACCESS_KEY"),
    "bucket_name": ("r2_bucket_name", "R2_BUCKET_NAME"),
    "public_base_url": ("r2_public_base_url", "R2_PUBLIC_BASE_URL"),
}

DEFAULT_RETENTION_DAYS = 30
SUPABASE_FALLBACK_BUCKET = "uploads"

# Blanket mirroring of every agent-created file is opt-in (see auto_upload_enabled).
AUTO_UPLOAD_SETTING_KEY = "storage_auto_upload_files"
AUTO_UPLOAD_ENV_KEY = "STORAGE_AUTO_UPLOAD_FILES"

_MIME_MAP = {
    "pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg",
    "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
    "svg": "image/svg+xml", "mp3": "audio/mpeg", "wav": "audio/wav",
    "ogg": "audio/ogg", "m4a": "audio/mp4", "mp4": "video/mp4",
    "webm": "video/webm", "mov": "video/quicktime", "txt": "text/plain",
    "md": "text/markdown", "csv": "text/csv", "json": "application/json",
    "html": "text/html", "py": "text/x-python", "js": "text/javascript",
    "ts": "text/typescript", "zip": "application/zip",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

# Cached boto3 clients keyed by (account_id, access_key_id)
_r2_clients: dict[tuple[str, str], Any] = {}
_r2_clients_lock = threading.Lock()


# ── Credential & config resolution ─────────────────────────────────────────────

_fallback_uid_cache: Optional[str] = None


def _fallback_user_id() -> Optional[str]:
    """Most-active ``agent_settings`` user — mirrors provider_engine's settings
    fallback so standalone processes (cron, scripts) still attribute files to
    the primary user instead of dropping registration."""
    global _fallback_uid_cache
    if _fallback_uid_cache:
        return _fallback_uid_cache
    try:
        client = _get_supabase_admin()
        if not client:
            return None
        resp = client.table("agent_settings").select("user_id").not_.is_("user_id", "null").limit(100).execute()
        if resp.data:
            from collections import Counter
            counts = Counter(r.get("user_id") for r in resp.data if r.get("user_id"))
            uid = counts.most_common(1)[0][0] if counts else None
            if uid:
                _fallback_uid_cache = str(uid)
                return _fallback_uid_cache
    except Exception:
        pass
    return None


def _resolve_user_id(user_id: Optional[str] = None) -> Optional[str]:
    """Resolve the effective user id: explicit → active ContextVar → most-active user fallback."""
    if user_id:
        return str(user_id)
    try:
        from research_agent.tools.provider_engine import active_user_id, _LAST_ACTIVE_USER_ID
        uid = active_user_id.get(None) or _LAST_ACTIVE_USER_ID
        if uid:
            return str(uid)
    except Exception:
        pass
    return _fallback_user_id()


def _resolve_thread_id(thread_id: Optional[str] = None) -> Optional[str]:
    """Resolve the effective thread id: explicit → active ContextVar (set at run start).

    This keeps R2 keys thread-wise (``{category}/{date}/{thread_id}/…``) for every
    tool without each call site having to thread the id through manually.
    """
    if thread_id:
        return str(thread_id)
    try:
        from research_agent.tools.provider_engine import get_active_thread_id
        tid = get_active_thread_id()
        if tid:
            return str(tid)
    except Exception:
        pass
    return None


def _get_setting(settings: dict, setting_key: str, env_key: str) -> str:
    """Per-user setting first, then environment fallback (same as get_user_api_key)."""
    val = (settings.get(setting_key) or "").strip()
    if val:
        return val
    return os.environ.get(env_key, "").strip()


def get_r2_config(user_id: Optional[str] = None) -> Optional[dict[str, str]]:
    """Return the user's R2 config dict, or None if R2 is not fully configured.

    Required: account_id, access_key_id, secret_access_key, bucket_name.
    Optional: public_base_url (r2.dev public URL or custom domain). Without it,
    uploaded files are registered but no stable public URL can be produced.
    """
    try:
        from research_agent.tools.provider_engine import get_settings, _fetch_settings_from_supabase
        uid = _resolve_user_id(user_id)
        settings = get_settings(uid) or {}
        if not settings:
            settings = _fetch_settings_from_supabase(uid) or {}
    except Exception as e:
        logger.warning(f"[storage] settings lookup failed, using env only: {e}")
        settings = {}

    cfg = {field: _get_setting(settings, s_key, e_key) for field, (s_key, e_key) in R2_SETTING_KEYS.items()}

    missing = [f for f in ("account_id", "access_key_id", "secret_access_key", "bucket_name") if not cfg[f]]
    if missing:
        logger.debug(f"[storage] R2 not configured (missing: {', '.join(missing)})")
        return None
    return cfg


def is_r2_enabled(user_id: Optional[str] = None) -> bool:
    """True when the user has complete R2 credentials configured."""
    return get_r2_config(user_id) is not None


def get_retention_days(user_id: Optional[str] = None) -> int:
    """User's file retention period in days. 0 = keep forever. Default 30."""
    try:
        from research_agent.tools.provider_engine import get_settings
        settings = get_settings(_resolve_user_id(user_id)) or {}
        raw = (settings.get("storage_retention_days") or os.environ.get("STORAGE_RETENTION_DAYS") or "").strip()
        if not raw:
            return DEFAULT_RETENTION_DAYS
        days = int(raw)
        return max(days, 0)
    except (ValueError, TypeError):
        return DEFAULT_RETENTION_DAYS


def auto_upload_enabled(user_id: Optional[str] = None) -> bool:
    """Whether EVERY file the agent creates is mirrored to cloud storage.

    Default is **off**. Agent-created files live in the thread workspace
    (``output/threads/<id>/``) and are browsable/downloadable through the UI's
    thread-files routes; only explicit uploads (the ``upload_to_storage`` tool,
    user attachments, and media referenced by a social post) consume cloud
    storage and count against retention.

    Turn it back on with agent_settings ``storage_auto_upload_files = "true"``
    or env ``STORAGE_AUTO_UPLOAD_FILES=true`` to restore the old dual-write
    behaviour.
    """
    try:
        from research_agent.tools.provider_engine import get_settings
        settings = get_settings(_resolve_user_id(user_id)) or {}
        raw = (settings.get(AUTO_UPLOAD_SETTING_KEY) or "").strip()
    except Exception:
        raw = ""
    if not raw:
        raw = os.environ.get(AUTO_UPLOAD_ENV_KEY, "").strip()
    return raw.lower() in ("1", "true", "yes", "on")


# ── R2 client ──────────────────────────────────────────────────────────────────

def _get_r2_client(cfg: dict[str, str]):
    """Return a cached boto3 S3 client bound to the user's R2 account."""
    cache_key = (cfg["account_id"], cfg["access_key_id"])
    with _r2_clients_lock:
        client = _r2_clients.get(cache_key)
        if client is not None:
            return client
        import boto3
        from botocore.config import Config
        client = boto3.client(
            "s3",
            endpoint_url=f"https://{cfg['account_id']}.r2.cloudflarestorage.com",
            aws_access_key_id=cfg["access_key_id"],
            aws_secret_access_key=cfg["secret_access_key"],
            region_name="auto",
            config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
        )
        _r2_clients[cache_key] = client
        return client


def _guess_mime(filename: str, fallback: str = "") -> str:
    if fallback and fallback != "application/octet-stream":
        return fallback
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if ext in _MIME_MAP:
        return _MIME_MAP[ext]
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"


def _build_storage_key(category: str, filename: str, thread_id: Optional[str]) -> str:
    """Canonical object key layout: {category}/{date}/{thread}/{uuid8}_{filename}."""
    today = datetime.date.today().isoformat()
    safe_tid = sanitize_thread_id(thread_id) if thread_id else "general"
    safe_name = re.sub(r"[^a-zA-Z0-9_\-.]", "_", os.path.basename(filename))[:120] or "file"
    return f"{category}/{today}/{safe_tid}/{uuid.uuid4().hex[:8]}_{safe_name}"


# ── Supabase registry (thread_files) ───────────────────────────────────────────

def _get_supabase_admin():
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        return None
    return create_client(url, key)


def register_file(
    *,
    user_id: Optional[str],
    thread_id: Optional[str],
    filename: str,
    storage_backend: str,
    storage_key: str,
    public_url: Optional[str],
    size_bytes: Optional[int] = None,
    mime_type: Optional[str] = None,
    category: str = "general",
) -> None:
    """Register a stored file in the portable ``thread_files`` registry (best-effort)."""
    uid = _resolve_user_id(user_id)
    if not uid:
        logger.debug("[storage] no user_id — skipping thread_files registration")
        return
    try:
        import uuid as _uuid
        _uuid.UUID(str(uid))  # registry requires a real auth user uuid
    except (ValueError, AttributeError):
        logger.debug(f"[storage] non-uuid user_id '{uid}' — skipping registration")
        return
    try:
        days = get_retention_days(uid)
        expires_at = (
            (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=days)).isoformat()
            if days > 0 else None
        )
        client = _get_supabase_admin()
        if not client:
            return
        client.table("thread_files").upsert(
            {
                "user_id": str(uid),
                "thread_id": str(thread_id) if thread_id else None,
                "filename": os.path.basename(filename),
                "storage_backend": storage_backend,
                "storage_key": storage_key,
                "public_url": public_url,
                "size_bytes": size_bytes,
                "mime_type": mime_type,
                "category": category,
                "expires_at": expires_at,
            },
            on_conflict="storage_backend,storage_key",
        ).execute()
    except Exception as e:
        logger.warning(f"[storage] thread_files registration failed (non-fatal): {e}")


def lookup_thread_file(
    filename: str,
    thread_id: Optional[str] = None,
    user_id: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Find a registered file by name — the portable manifest lookup.

    Searches the current thread first, then falls back to the user's most recent
    file with that name. Enables the PC-build scenario: file not on local disk,
    but its R2 link is recoverable from Supabase.
    """
    uid = _resolve_user_id(user_id)
    if not uid:
        return None
    try:
        client = _get_supabase_admin()
        if not client:
            return None
        base = os.path.basename(filename.strip())
        q = (
            client.table("thread_files")
            .select("filename, storage_backend, storage_key, public_url, mime_type, thread_id")
            .eq("user_id", str(uid))
            .ilike("filename", base)
            .order("created_at", desc=True)
            .limit(1)
        )
        if thread_id:
            res = q.eq("thread_id", str(thread_id)).execute()
            if res.data:
                return res.data[0]
            # fall through to user-wide search without thread filter
            res2 = (
                client.table("thread_files")
                .select("filename, storage_backend, storage_key, public_url, mime_type, thread_id")
                .eq("user_id", str(uid))
                .ilike("filename", base)
                .order("created_at", desc=True)
                .limit(1)
                .execute()
            )
            return res2.data[0] if res2.data else None
        res = q.execute()
        return res.data[0] if res.data else None
    except Exception as e:
        logger.warning(f"[storage] thread_files lookup failed: {e}")
        return None


# ── Upload (R2-first, Supabase fallback) ───────────────────────────────────────

def upload_file(
    *,
    filename: str,
    category: str,
    local_path: Optional[str] = None,
    data: Optional[bytes] = None,
    mime_type: str = "",
    thread_id: Optional[str] = None,
    user_id: Optional[str] = None,
) -> Optional[str]:
    """Store a file in the unified storage layer and return its public URL.

    Exactly one of ``local_path`` / ``data`` must be provided. R2 is tried first
    (when configured); on any failure the legacy Supabase ``uploads`` bucket is
    used so behaviour never regresses. Every successful upload is registered in
    the ``thread_files`` table with the user's retention policy applied.
    """
    if local_path is None and data is None:
        raise ValueError("upload_file requires local_path or data")
    if local_path and not os.path.isfile(local_path):
        logger.warning(f"[storage] file does not exist: {local_path}")
        return None

    mime = _guess_mime(filename, mime_type)
    uid = _resolve_user_id(user_id)
    thread_id = _resolve_thread_id(thread_id)

    # ── 1) R2 (primary, portable) ──
    cfg = get_r2_config(uid)
    if cfg:
        key = _build_storage_key(category, filename, thread_id)
        try:
            body = open(local_path, "rb") if local_path else data
            try:
                _get_r2_client(cfg).put_object(
                    Bucket=cfg["bucket_name"], Key=key, Body=body, ContentType=mime
                )
            finally:
                if local_path and body:
                    body.close()
            public_url = (
                f"{cfg['public_base_url'].rstrip('/')}/{key}" if cfg.get("public_base_url") else None
            )
            size = os.path.getsize(local_path) if local_path else (len(data) if data else None)
            register_file(
                user_id=uid, thread_id=thread_id, filename=filename,
                storage_backend="r2", storage_key=key, public_url=public_url,
                size_bytes=size, mime_type=mime, category=category,
            )
            if public_url:
                logger.info(f"[storage] uploaded to R2: {public_url}")
                return public_url
            # No public base URL configured — fall through to Supabase so callers
            # still get a shareable link (chat history depends on stable URLs).
            logger.warning("[storage] r2_public_base_url not set — falling back to Supabase for public URL")
        except Exception as e:
            logger.error(f"[storage] R2 upload failed, falling back to Supabase: {e}")

    # ── 2) Supabase Storage (fallback / legacy) ──
    try:
        client = _get_supabase_admin()
        if not client:
            return None
        today = datetime.date.today().isoformat()
        safe_tid = sanitize_thread_id(thread_id) if thread_id else "general"
        safe_name = re.sub(r"[^a-zA-Z0-9_\-.]", "_", os.path.basename(filename))[:120] or "file"
        sb_path = f"{category}/{today}/{safe_tid}/{uuid.uuid4().hex[:8]}_{safe_name}"
        payload = open(local_path, "rb").read() if local_path else data
        client.storage.from_(SUPABASE_FALLBACK_BUCKET).upload(
            path=sb_path, file=payload, file_options={"content-type": mime}
        )
        supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        public_url = f"{supabase_url}/storage/v1/object/public/{SUPABASE_FALLBACK_BUCKET}/{sb_path}"
        size = os.path.getsize(local_path) if local_path else (len(data) if data else None)
        register_file(
            user_id=uid, thread_id=thread_id, filename=filename,
            storage_backend="supabase", storage_key=sb_path, public_url=public_url,
            size_bytes=size, mime_type=mime, category=category,
        )
        logger.info(f"[storage] uploaded to Supabase (fallback): {public_url}")
        return public_url
    except Exception as e:
        logger.error(f"[storage] Supabase fallback upload failed: {e}")
        return None


# ── Resolution (omni / tool consumption) ───────────────────────────────────────

def resolve_file_source(
    source: str,
    thread_id: Optional[str] = None,
    user_id: Optional[str] = None,
) -> tuple[Optional[str], str]:
    """Resolve any file reference to a readable location.

    Returns ``(location, filename)`` where location is an http(s) URL, data URI,
    or an existing local filesystem path — or ``(None, filename)`` if unresolvable.

    Resolution order:
      1. http(s) URL / data URI → returned as-is
      2. Existing local path (absolute, cwd-relative, or inside the thread workspace)
      3. Basename inside the thread workspace (output/threads/<id>/)
      4. thread_files registry → public R2/Supabase URL (portable cross-machine path)
    """
    from research_agent.fs_backend import get_thread_output_dir

    s = (source or "").strip()
    filename = os.path.basename(s.split("?")[0]) or s
    thread_id = _resolve_thread_id(thread_id)

    if s.startswith(("http://", "https://", "data:")):
        return s, filename

    # Local candidates: as-given, cwd, thread workspace (full rel path + basename)
    candidates = [s, os.path.join(os.getcwd(), s)]
    try:
        thread_dir = get_thread_output_dir(thread_id or {"configurable": {}}, create=False)
        candidates += [
            os.path.join(thread_dir, s),
            os.path.join(thread_dir, os.path.basename(s)),
        ]
    except Exception:
        pass

    for cand in candidates:
        try:
            if os.path.isfile(cand):
                return os.path.abspath(cand), os.path.basename(cand)
        except OSError:
            continue

    # Portable manifest: the file may live on another machine — use its cloud URL
    row = lookup_thread_file(filename, thread_id=thread_id, user_id=user_id)
    if row and row.get("public_url"):
        logger.info(f"[storage] resolved '{filename}' via thread_files registry → {row['public_url']}")
        return row["public_url"], row.get("filename") or filename

    return None, filename


# ── Storage URL detection ──────────────────────────────────────────────────────

def is_storage_url(url: str, user_id: Optional[str] = None) -> bool:
    """True if the URL points at a system-managed storage object (R2 public base
    URL or the legacy Supabase ``uploads`` bucket). Used to decide whether an
    attachment part can be safely replaced with a lightweight placeholder in
    persisted state (the canonical link already lives in chat history/registry).
    """
    if not url or not url.startswith(("http://", "https://")):
        return False
    if "supabase.co/storage/v1/object/public/" in url:
        return True
    if ".r2.dev/" in url:
        return True
    try:
        cfg = get_r2_config(user_id)
        base = (cfg or {}).get("public_base_url", "").rstrip("/")
        if base and url.startswith(base + "/"):
            return True
    except Exception:
        pass
    env_base = os.environ.get("R2_PUBLIC_BASE_URL", "").rstrip("/")
    return bool(env_base) and url.startswith(env_base + "/")


# ── Retention enforcement ──────────────────────────────────────────────────────

def cleanup_expired_files(batch_size: int = 500) -> dict[str, Any]:
    """Delete all expired files from their storage backend + remove registry rows.

    Called daily from cron_scheduler. Per-user R2 credentials are resolved from
    each file owner's settings so multi-user deployments clean up correctly.
    Returns ``{"deleted": N, "errors": [...]}``.
    """
    client = _get_supabase_admin()
    if not client:
        return {"deleted": 0, "errors": ["Supabase not configured"]}

    deleted = 0
    errors: list[str] = []
    try:
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        res = (
            client.table("thread_files")
            .select("id, user_id, storage_backend, storage_key")
            .not_.is_("expires_at", "null")
            .lt("expires_at", now)
            .limit(batch_size)
            .execute()
        )
        rows = res.data or []
    except Exception as e:
        return {"deleted": 0, "errors": [f"failed to query expired files: {e}"]}

    for row in rows:
        row_id, backend, key = row["id"], row["storage_backend"], row["storage_key"]
        try:
            if backend == "r2":
                cfg = get_r2_config(row.get("user_id"))
                if cfg:
                    _get_r2_client(cfg).delete_object(Bucket=cfg["bucket_name"], Key=key)
                else:
                    errors.append(f"no R2 creds for user {row.get('user_id')} — kept {key}")
                    continue
            elif backend == "supabase":
                client.storage.from_(SUPABASE_FALLBACK_BUCKET).remove([key])
            client.table("thread_files").delete().eq("id", row_id).execute()
            deleted += 1
        except Exception as e:
            errors.append(f"{backend}:{key}: {e}")
            logger.error(f"[storage.cleanup] failed to delete {backend}:{key}: {e}")

    if deleted:
        logger.info(f"[storage.cleanup] deleted {deleted} expired files")
    return {"deleted": deleted, "errors": errors}
