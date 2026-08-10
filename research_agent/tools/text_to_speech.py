"""Text-to-speech tool — converts a reply into an audio file.

Returns an AUDIO_URL marker that chat platforms (Telegram voice bubble, Slack
file, Discord attachment, web player) turn into a native audio message.
Provider is user-selectable via agent_settings key ``tts_provider``
(elevenlabs | edge | openai); elevenlabs defaults to eleven_multilingual_v2.
"""

from typing import Optional

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from research_agent import tts as tts_engine


@tool(parse_docstring=True)
def text_to_speech(text: str, config: Optional[RunnableConfig] = None) -> str:
    """Convert text into a spoken audio message.

    Call this ONLY when an audio reply is actually allowed by the current voice
    mode (voice_mode from config):
      - voice_only (default): only when this turn came from a VOICE message
        (voice_input=true). For plain text messages reply in text only — do NOT
        call this tool.
      - all / tts: every reply gets an audio version, so calling is allowed.
      - off: never call this tool.

    Pass a short, spoken-friendly version of your answer (no markdown, no code
    blocks, no links, no tables) as `text`.

    The provider and voice are chosen by the user in Settings (tts_provider:
    elevenlabs | edge | openai), not by you.

    Args:
        text: Spoken-friendly answer text (max ~1500 chars, plain sentences).
        config: LangChain runnable configuration (automatically injected).

    Returns:
        A confirmation with an AUDIO_URL marker; the platform delivers it as a
        native voice/audio message. Do not repeat the marker in your reply text.
    """
    configurable = (config or {}).get("configurable", {}) if config else {}
    user_id = configurable.get("user_id")
    platform = (configurable.get("platform") or "web") or "web"

    # ── Voice-mode gating ─────────────────────────────────────────────────────
    voice_mode = str(configurable.get("voice_mode") or "voice_only").strip().lower()
    voice_input = bool(configurable.get("voice_input"))
    if voice_mode in ("off", "", "none", "false"):
        return (
            "⏸ Voice replies are OFF in this chat (voice_mode=off). "
            "Do NOT create audio — answer the user in plain text only."
        )
    if voice_mode in ("on", "voice_only") and not voice_input:
        return (
            "🎙 Voice replies are in voice-to-voice mode (voice_mode=voice_only): "
            "audio is only generated when the user sends a VOICE message, and this "
            "turn was a text message. Do NOT create audio — answer in plain text "
            "only. The user can switch to /voice-tts (every reply gets audio) or "
            "/voice-off (text only) to change this."
        )

    spoken = tts_engine.prepare_tts_text(text, max_chars=1500)
    if not spoken:
        return "❌ Nothing to speak — the provided text was empty after cleanup."

    try:
        audio, ext, mime, provider = tts_engine.synthesize_speech(
            spoken, platform=platform, user_id=user_id
        )
        url = tts_engine.upload_audio(audio, ext, mime)
        voice_bubble = "true" if (platform == "telegram" and ext == "ogg") else "false"
        return (
            f"✅ Audio reply generated with {provider}.\n"
            f"{tts_engine.VOICE_MARKER_PREFIX}{voice_bubble}\n"
            f"{tts_engine.AUDIO_URL_MARKER}{url}\n"
            "The platform will deliver this as a native audio message to the user. "
            "Keep your text reply brief."
        )
    except Exception as e:
        return (
            f"❌ Text-to-speech failed: {e}. "
            "Check the tts_provider / elevenlabs_api_key entries in the ENV Keys settings, "
            "then answer the user in plain text instead."
        )
