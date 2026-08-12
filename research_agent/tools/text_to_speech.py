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

    IMPORTANT: This tool is for creating SPECIFIC audio replies when you want to
    generate audio content. It is SEPARATE from the system's automatic voice
    mode (controlled by /voice tts command).

    Voice mode is controlled by the user via slash commands:
      - /voice tts: system automatically speaks every reply
      - /voice on: system speaks replies to voice messages
      - /voice off: text only, no audio

    Use this tool ONLY when:
      1. The user explicitly asks for audio content
      2. You need to create a specific audio message
      3. Voice mode is OFF but you still need audio

    Do NOT use this tool to create automatic voice replies - the system handles
    that via the finalize_response node based on voice_mode.

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
    # NOTE: The system's automatic voice mode is handled by finalize_response()
    # This tool is for explicit audio content creation only
    voice_mode = str(configurable.get("voice_mode") or "voice_only").strip().lower()
    voice_input = bool(configurable.get("voice_input"))
    
    # Only block if voice mode is explicitly OFF
    if voice_mode in ("off", "none"):
        return (
            "⏸ Voice replies are OFF in this chat (voice_mode=off). "
            "Do NOT create audio — answer the user in plain text only."
        )
    # Allow this tool to work in all other modes - it's for explicit audio creation
    # The automatic voice mode handling is done by the system, not this tool

    spoken = tts_engine.prepare_tts_text(text, max_chars=1500)
    if not spoken:
        return "❌ Nothing to speak — the provided text was empty after cleanup."

    try:
        audio, ext, mime, provider = tts_engine.synthesize_speech(
            spoken, platform=platform, user_id=user_id, purpose="tool"
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
