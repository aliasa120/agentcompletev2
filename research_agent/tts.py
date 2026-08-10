"""
Text-to-Speech engine — user-selectable provider registry.

Providers (Hermes-style registry, easily extensible):
  - ``elevenlabs``  : best quality, multilingual (eleven_multilingual_v2), native Opus
  - ``edge``        : free, no API key (Microsoft Edge TTS), MP3 output
  - ``openai``      : OpenAI gpt-4o-mini-tts, native Opus

Settings are resolved per-user from Supabase ``agent_settings`` (with env-var
fallbacks) via ``provider_engine.get_user_api_key`` / ``get_settings``:

  tts_provider        = elevenlabs | edge | openai   (default: edge)
  tts_voice_id        = provider voice id / name
  tts_model_id        = provider model id (elevenlabs: eleven_multilingual_v2)
  elevenlabs_api_key  = ElevenLabs key   (env fallback: ELEVENLABS_API_KEY)
  edge_tts_voice      = Edge voice name  (env fallback: EDGE_TTS_VOICE)
  openai tts          = uses OPENAI_API_KEY
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from typing import Optional, Tuple

logger = logging.getLogger("research_agent.tts")

TTS_PROVIDERS = ("elevenlabs", "edge", "openai")

DEFAULT_ELEVENLABS_VOICE_ID = "pNInz6obpgDQGcFmaJgB"  # "Adam"
DEFAULT_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2"
DEFAULT_EDGE_VOICE = "en-US-AriaNeural"
DEFAULT_OPENAI_TTS_MODEL = "gpt-4o-mini-tts"
DEFAULT_OPENAI_TTS_VOICE = "alloy"

# Hard caps per provider (chars) — long answers are truncated before synthesis.
PROVIDER_MAX_TEXT_LENGTH = {
    "elevenlabs": 10000,
    "edge": 5000,
    "openai": 4000,
}


# ── Settings resolution ─────────────────────────────────────────────────────────

def get_tts_config(user_id: Optional[str] = None) -> dict:
    """Resolve the active TTS configuration (per-user agent_settings + env fallback)."""
    from research_agent.tools.provider_engine import get_settings

    settings = get_settings(user_id)
    provider = (settings.get("tts_provider") or os.environ.get("TTS_PROVIDER") or "edge").strip().lower()
    if provider not in TTS_PROVIDERS:
        logger.warning(f"[tts] Unknown tts_provider '{provider}', falling back to 'edge'")
        provider = "edge"

    cfg = {
        "provider": provider,
        "voice_id": (settings.get("tts_voice_id") or os.environ.get("TTS_VOICE_ID") or "").strip(),
        "model_id": (settings.get("tts_model_id") or os.environ.get("TTS_MODEL_ID") or "").strip(),
        "edge_voice": (settings.get("edge_tts_voice") or os.environ.get("EDGE_TTS_VOICE") or DEFAULT_EDGE_VOICE).strip(),
    }
    logger.info(
        f"[tts] Resolved TTS config for user={user_id}: provider={provider}, "
        f"voice={cfg['voice_id']}, model={cfg['model_id'] or '(default)'}, "
        f"settings_keys={[k for k in ('tts_provider', 'tts_voice_id', 'edge_tts_voice') if k in settings]}"
    )
    if not cfg["voice_id"]:
        cfg["voice_id"] = {
            "elevenlabs": DEFAULT_ELEVENLABS_VOICE_ID,
            "edge": cfg["edge_voice"],
            "openai": DEFAULT_OPENAI_TTS_VOICE,
        }[provider]
    if not cfg["model_id"]:
        cfg["model_id"] = {
            "elevenlabs": DEFAULT_ELEVENLABS_MODEL_ID,
            "edge": "",
            "openai": DEFAULT_OPENAI_TTS_MODEL,
        }[provider]
    return cfg


# ── Text preparation ────────────────────────────────────────────────────────────

_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_MD_TOKEN_RE = re.compile(r"[*_`#>~|]+")
_CODE_BLOCK_RE = re.compile(r"```.*?```", re.DOTALL)
_URL_RE = re.compile(r"https?://\S+")
_WS_RE = re.compile(r"\s+")


def prepare_tts_text(text: str, max_chars: int = 1500) -> str:
    """Strip markdown/code/links so the spoken reply sounds natural."""
    if not text:
        return ""
    text = _CODE_BLOCK_RE.sub(" (code omitted) ", text)
    text = _MD_LINK_RE.sub(r"\1", text)
    text = _URL_RE.sub("", text)
    # drop table rows
    lines = [ln for ln in text.splitlines() if not ln.strip().startswith("|")]
    text = " ".join(lines)
    text = _MD_TOKEN_RE.sub("", text)
    text = _WS_RE.sub(" ", text).strip()
    if len(text) > max_chars:
        text = text[: max_chars - 1].rsplit(" ", 1)[0] + "…"
    return text


# ── Provider synthesis ──────────────────────────────────────────────────────────

def _synthesize_elevenlabs(text: str, cfg: dict, fmt: str, user_id: Optional[str]) -> bytes:
    from research_agent.tools.provider_engine import get_user_api_key

    api_key = get_user_api_key("elevenlabs_api_key", "ELEVENLABS_API_KEY", user_id=user_id)
    if not api_key:
        raise RuntimeError("ElevenLabs API key not configured (agent_settings: elevenlabs_api_key)")

    from elevenlabs.client import ElevenLabs

    client = ElevenLabs(api_key=api_key)
    output_format = "opus_48000_64" if fmt == "ogg" else "mp3_44100_128"
    audio_iter = client.text_to_speech.convert(
        text=text,
        voice_id=cfg["voice_id"],
        model_id=cfg["model_id"],
        output_format=output_format,
    )
    return b"".join(chunk for chunk in audio_iter if chunk)


async def _synthesize_edge_async(text: str, cfg: dict, out_path: str) -> None:
    import edge_tts

    communicate = edge_tts.Communicate(text, voice=cfg["edge_voice"])
    await communicate.save(out_path)


def _run_coro_blocking(coro):
    """Run a coroutine from sync code, safe even inside a running event loop."""
    import threading

    box: dict = {}
    def _runner():
        try:
            box["result"] = asyncio.run(coro)
        except Exception as e:  # noqa: BLE001
            box["error"] = e

    t = threading.Thread(target=_runner, daemon=True)
    t.start()
    t.join(timeout=180)
    if "error" in box:
        raise box["error"]
    return box.get("result")


def _synthesize_edge(text: str, cfg: dict, fmt: str) -> bytes:
    """Edge TTS emits MP3. For ogg we convert with ffmpeg if available."""
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        mp3_path = tmp.name
    try:
        _run_coro_blocking(_synthesize_edge_async(text, cfg, mp3_path))
        with open(mp3_path, "rb") as f:
            mp3_bytes = f.read()
        if fmt != "ogg":
            return mp3_bytes
        converted = _convert_mp3_to_opus(mp3_path)
        return converted if converted is not None else mp3_bytes
    finally:
        try:
            os.unlink(mp3_path)
        except OSError:
            pass


def _synthesize_openai(text: str, cfg: dict, fmt: str, user_id: Optional[str]) -> bytes:
    from research_agent.tools.provider_engine import get_user_api_key

    api_key = get_user_api_key("openai_api_key", "OPENAI_API_KEY", user_id=user_id)
    if not api_key:
        raise RuntimeError("OpenAI API key not configured (agent_settings: openai_api_key)")

    from openai import OpenAI

    client = OpenAI(api_key=api_key)
    response = client.audio.speech.create(
        model=cfg["model_id"],
        voice=cfg["voice_id"],
        input=text,
        response_format="opus" if fmt == "ogg" else "mp3",
    )
    return response.content


def _convert_mp3_to_opus(mp3_path: str) -> Optional[bytes]:
    """Convert MP3 -> OGG Opus via ffmpeg (Telegram voice bubbles). None if ffmpeg missing."""
    if not shutil.which("ffmpeg"):
        logger.warning("[tts] ffmpeg not found; delivering MP3 instead of OGG voice bubble")
        return None
    ogg_path = mp3_path + ".ogg"
    try:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", mp3_path,
             "-acodec", "libopus", "-ac", "1", "-b:a", "64k", "-vbr", "off", ogg_path, "-y"],
            check=True, capture_output=True, timeout=120,
        )
        with open(ogg_path, "rb") as f:
            return f.read()
    except Exception as e:
        logger.warning(f"[tts] ffmpeg opus conversion failed: {e}")
        return None
    finally:
        try:
            os.unlink(ogg_path)
        except OSError:
            pass


def synthesize_speech(
    text: str,
    *,
    platform: str = "web",
    user_id: Optional[str] = None,
) -> Tuple[bytes, str, str, str]:
    """Synthesize speech -> (audio_bytes, ext, mime, provider).

    ``fmt`` is ogg only for Telegram (voice bubbles); everything else gets mp3.
    """
    cfg = get_tts_config(user_id)
    provider = cfg["provider"]
    fmt = "ogg" if platform == "telegram" else "mp3"

    max_len = PROVIDER_MAX_TEXT_LENGTH.get(provider, 5000)
    if len(text) > max_len:
        text = text[: max_len - 1].rsplit(" ", 1)[0] + "…"
    text = text.strip()
    if not text:
        raise ValueError("Nothing to synthesize: empty text")

    def _cfg_for(p: str) -> dict:
        """Config to use for provider p (defaults when p is a fallback)."""
        if p == provider:
            return cfg
        base = dict(cfg)
        base["voice_id"] = {
            "elevenlabs": DEFAULT_ELEVENLABS_VOICE_ID,
            "edge": base["edge_voice"],
            "openai": DEFAULT_OPENAI_TTS_VOICE,
        }[p]
        base["model_id"] = {
            "elevenlabs": DEFAULT_ELEVENLABS_MODEL_ID,
            "edge": "",
            "openai": DEFAULT_OPENAI_TTS_MODEL,
        }[p]
        return base

    last_err: Optional[Exception] = None
    # chosen provider first, then edge as the free fallback
    providers_to_try = [provider] + ([] if provider == "edge" else ["edge"])
    for p in providers_to_try:
        try:
            p_cfg = _cfg_for(p)
            if p == "elevenlabs":
                data = _synthesize_elevenlabs(text, p_cfg, fmt, user_id)
            elif p == "openai":
                data = _synthesize_openai(text, p_cfg, fmt, user_id)
            else:
                data = _synthesize_edge(text, p_cfg, fmt)
            ext = "ogg" if (fmt == "ogg" and (p != "edge" or data[:4] == b"OggS")) else "mp3"
            mime = "audio/ogg" if ext == "ogg" else "audio/mpeg"
            return data, ext, mime, p
        except Exception as e:
            logger.warning(f"[tts] provider '{p}' failed: {e}")
            last_err = e
    raise RuntimeError(f"All TTS providers failed. Last error: {last_err}")


# ── Storage ──────────────────────────────────────────────────────────────────────

def upload_audio(audio: bytes, ext: str, mime: str) -> str:
    """Upload audio to the public Supabase 'uploads' bucket; return the public URL.

    Files are stored under ``tts/YYYY-MM-DD/`` so a daily cleanup cron can
    delete entire day-folders older than 30 days via ``cleanup_old_audio()``.
    """
    import datetime
    from supabase import create_client

    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
    if not supabase_url or not key:
        raise RuntimeError("Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)")

    client = create_client(supabase_url, key)
    today = datetime.date.today().isoformat()          # e.g. "2026-08-10"
    filename = f"tts/{today}/{uuid.uuid4()}.{ext}"    # tts/2026-08-10/<uuid>.mp3
    client.storage.from_("uploads").upload(
        path=filename,
        file=audio,
        file_options={"content-type": mime},
    )
    return f"{supabase_url}/storage/v1/object/public/uploads/{filename}"


def cleanup_old_audio(max_age_days: int = 30) -> dict:
    """Delete TTS audio files older than *max_age_days* from Supabase storage.

    Safe to call from a daily cron. Lists all objects under the ``tts/`` prefix,
    finds day-folders older than the cutoff, and deletes their files in batches.
    Returns a summary dict: ``{"deleted": N, "errors": [...]}``.  
    """
    import datetime
    from supabase import create_client

    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
    if not supabase_url or not key:
        return {"deleted": 0, "errors": ["Supabase not configured"]}

    client = create_client(supabase_url, key)
    cutoff = datetime.date.today() - datetime.timedelta(days=max_age_days)
    deleted = 0
    errors: list[str] = []

    try:
        # List top-level objects in tts/ prefix (Supabase returns "folders" as objects)
        items = client.storage.from_("uploads").list("tts") or []
        for item in items:
            name = item.get("name", "")
            # day-folder looks like "2026-08-01"
            try:
                day = datetime.date.fromisoformat(name)
            except ValueError:
                continue
            if day <= cutoff:
                # List files inside this day-folder and delete them
                try:
                    day_files = client.storage.from_("uploads").list(f"tts/{name}") or []
                    paths = [f"tts/{name}/{f['name']}" for f in day_files if f.get("name")]
                    if paths:
                        result = client.storage.from_("uploads").remove(paths)
                        deleted += len(paths)
                        logger.info(f"[tts.cleanup] Deleted {len(paths)} files from tts/{name}/")
                except Exception as e:
                    err = f"Failed to delete tts/{name}: {e}"
                    logger.error(f"[tts.cleanup] {err}")
                    errors.append(err)
    except Exception as e:
        err = f"Failed to list tts/ prefix: {e}"
        logger.error(f"[tts.cleanup] {err}")
        errors.append(err)

    return {"deleted": deleted, "errors": errors}


AUDIO_URL_MARKER = "AUDIO_URL:"
VOICE_MARKER_PREFIX = "AUDIO_VOICE:"  # "true" when the file is a Telegram-style voice bubble


def synthesize_reply_audio(
    text: str,
    *,
    platform: str = "web",
    user_id: Optional[str] = None,
    max_chars: int = 1500,
) -> Optional[str]:
    """Full pipeline: prepare text -> synthesize -> upload -> marker string (or None on failure)."""
    spoken = prepare_tts_text(text, max_chars=max_chars)
    if not spoken:
        return None
    try:
        audio, ext, mime, provider = synthesize_speech(spoken, platform=platform, user_id=user_id)
        url = upload_audio(audio, ext, mime)
        voice_bubble = "true" if (platform == "telegram" and ext == "ogg") else "false"
        logger.info(f"[tts] reply audio synthesized via {provider} ({len(audio)} bytes, {ext})")
        return f"\n\n{VOICE_MARKER_PREFIX}{voice_bubble}\n{AUDIO_URL_MARKER}{url}"
    except Exception as e:
        logger.error(f"[tts] synthesize_reply_audio failed: {e}")
        return None


def extract_audio_markers(text: str):
    """Extract (voice_flag, url) markers from a reply. Returns (url, is_voice, cleaned_text)."""
    if not text:
        return None, False, text
    url = None
    is_voice = False
    m = re.search(rf"^{re.escape(AUDIO_URL_MARKER)}(\S+)\s*$", text, re.MULTILINE)
    if m:
        url = m.group(1).strip()
    v = re.search(rf"^{re.escape(VOICE_MARKER_PREFIX)}(true|false)\s*$", text, re.MULTILINE)
    if v:
        is_voice = v.group(1) == "true"
    cleaned = re.sub(rf"^\s*{re.escape(VOICE_MARKER_PREFIX)}(?:true|false)\s*$", "", text, flags=re.MULTILINE)
    cleaned = re.sub(rf"^\s*{re.escape(AUDIO_URL_MARKER)}\S+\s*$", "", cleaned, flags=re.MULTILINE).strip()
    return url, is_voice, cleaned
