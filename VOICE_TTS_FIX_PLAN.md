# Voice & TTS Fix Plan

Three issues were reported with the voice/text-to-speech feature. This document
analyzes each, lists the root cause(s) found in the code, and specifies the fix.

---

## Issue 1 — Wrong TTS provider used (Edge selected in Settings, ElevenLabs generated)

### What happens
The user selects **Edge TTS** in Settings (`Voice & TTS` page), but the agent's
`text_to_speech` tool output says `Audio reply generated with elevenlabs.`

### How the setting flows today
1. Settings UI (`deep-agents-ui-main/src/app/components/settings/VoiceSection.tsx`)
   saves `tts_provider` via `POST /api/agent-settings`.
2. `route.ts` upserts the row into Supabase `agent_settings` scoped to the **auth
   user id** (`user.id`) and re-seeds Redis `agent_settings:{user.id}` (TTL 1h).
3. Backend: `research_agent/tools/text_to_speech.py` → `research_agent/tts.py::get_tts_config(user_id)`
   → `provider_engine.get_settings(user_id)`.

### Root causes found

1. **Unscoped global fallback mixes users' settings (most likely).**
   `_fetch_settings_from_supabase()` in `provider_engine.py` (lines ~138-148):
   when `user_id` is absent **or the user has zero rows**, it fetches the first
   `limit(500)` rows from `agent_settings` **across all users** and merges them.
   If *any* row in the table has `tts_provider = elevenlabs` (e.g. an earlier
   test, another user, or a seeded row), the agent resolves to **elevenlabs** —
   even though the settings page (logged in as `tayyab@gmail.com`) shows Edge.
   This happens whenever the chat run's `user_id` differs from the settings-page
   auth user (local dev, anonymous session, or `user_id` missing from config).

2. **Stale Redis cache (1h TTL).** `get_settings()` returns the cached dict when
   it contains `openrouter_client_api_key`. If the Next.js settings route and the
   LangGraph server point at different Redis instances (host vs docker
   `redis://redis:6379`), the server keeps serving the pre-change dict with
   `tts_provider=elevenlabs` for up to an hour.

3. **Silent save failure in the UI.** The provider `<select>` fires `onSave(v)`
   immediately; if the POST fails (401/network), the dropdown still shows the new
   value and only a small transient error icon appears. The DB keeps the old
   provider, and nothing tells the user the save actually failed.

4. **UI default ≠ backend default.** `VoiceSection.tsx` line 216 defaults the
   displayed provider to `elevenlabs` when nothing is saved; the backend defaults
   to `edge`. This inconsistency can make the page *look* like ElevenLabs is the
   intended provider.

### Fix

- **`provider_engine.py`** ✅ (implemented) — scope the global fallback to rows
  where `user_id` is NULL (a true "global" namespace) instead of merging the
  first 500 rows across all users; prefer per-user rows strictly. Also
  invalidate the global (`agent_settings:all`) cache key on save.
- **`tts.py::get_tts_config`** ✅ (implemented) — log the resolved provider,
  voice, and user scope at INFO level so a mismatch is diagnosable from logs.
- **`VoiceSection.tsx`** ✅ (implemented) —
  - Default the displayed provider to `edge` (match backend default).
  - Show a prominent error banner when a save fails (don't silently swallow it).
  - Still recommended: a **"Test voice"** button that calls a backend endpoint
    and displays the **provider actually used**.
- **`agent-settings/route.ts`** — after save, also delete the Redis
  `agent_settings:all` (global) key so unscoped runs pick up the new value
  immediately.
- **Verify** — reproduce by running the chat while logged out or with a second
  user; confirm the audio tool now uses `edge` and logs show the user scope.

---

## Issue 2 — Audio URL shows as a plain link in the tool-call result instead of a player

### What happens
After `text_to_speech` runs, the tool-call result box displays the raw text:
`Audio reply generated with elevenlabs. AUDIO_VOICE:false AUDIO_URL:https://…`.
The user expects an inline **audio player** at that spot.

### How it's rendered today
- Backend appends machine-readable markers: `AUDIO_VOICE:true|false` and
  `AUDIO_URL:<url>` (`tts.py`, `text_to_speech.py`).
- `LangGraphRuntimeProvider.tsx` (`cleanText`, lines ~359-397) strips the marker
  lines from tool results / assistant text and collects them into
  `message.metadata.custom.audioReplies`.
- `audio-reply.tsx` (`AudioReplyList`) renders `<audio controls>` players **below
  the whole assistant message** — not inside the tool-call card.
- `tool-fallback.tsx` (`ToolFallback`) renders `result` as raw JSON, so the
  confirmation text still shows the URL as text when the markers aren't fully
  stripped, and no player appears in the tool result.

### Fix (the "intelligent" fix)

1. **Render a player inside the tool-call result.** ✅ (implemented in
   `tool-fallback.tsx`): detect `AUDIO_URL:<url>` in the tool result and render
   an inline `<audio controls preload="none">` player card **in place of the
   URL text**, and strip `AUDIO_URL:` / `AUDIO_VOICE:` from the displayed JSON
   while keeping the friendly confirmation line.
2. **Keep** `AudioReplyList` for assistant messages (voice-mirror case where the
   markers live in the final assistant text, not a tool result).
3. **Optional backend polish** — `text_to_speech.py` could return the marker on
   its own final line (already true) and keep the human confirmation short; the
   UI does the rest.

---

## Issue 3 — Voice mode not respected: text message produced audio (text + audio both)

### What the user wants
Three modes, switchable by slash command, **default = voice-to-voice**:
- **Voice-to-voice (default)** — voice note in → voice reply; text in → **text
  reply only**.
- **Always Speak (`/voice-tts`)** — every reply (text or voice) also gets audio.
- **Off (`/voice-off`)** — text only.

### What happens today
Confirmed reproduction: in a **fresh chat** (default mode `voice_only`), the user
sent a text message (e.g. `convert this into audio`) and the **first response**
came back with audio (tool call `text_to_speech` + text). Subsequent text
messages in the same chat replied in text only — because on those turns the model
simply didn't call the tool. So the behavior is driven by the tool, not by the
mode: the automatic mirror (`finalize_response` in `agent.py`) already respects
`voice_only` (speaks only when `voice_input=true`), but the **`text_to_speech`
tool is not mode-aware** — whenever the LLM decides to call it, it synthesizes
regardless of mode, and the system prompt (`prompts.py` line 655) even
encourages calling it on explicit request.

Root cause: **the tool ignores `voice_mode` / `voice_input`.**

### Fix

1. **Make the tool mode-aware** ✅ (implemented in
   `research_agent/tools/text_to_speech.py`): read `configurable.voice_mode` and
   `configurable.voice_input`:
   - `off` → refuse: "Voice replies are off — replying in text."
   - `voice_only` (default) → synthesize **only when `voice_input` is true**;
     otherwise return a polite refusal telling the LLM to reply in text (and the
     user that they can switch with `/voice-tts`). This fixes the "first response
     of a fresh chat got audio" report: text input in the default mode can no
     longer produce audio, no matter how it's phrased.
   - `all` / `tts` → always allowed.
2. **Keep the mirror as the single auto-audio path** — `finalize_response` stays
   as-is (already correct for all three modes).
3. **Update the system prompt** ✅ (`prompts.py` item 10) — the LLM is now told
   audio is governed by `voice_mode` + `voice_input`, NOT by phrasing, so it
   stops calling `text_to_speech` for text input in the default mode.
4. **UI polish** (`BaseChat.tsx` + `voice-mode.ts`):
   - Show the **current mode** to the user (small badge in the composer or a
     status line), so the default voice-to-voice behavior is discoverable.
   - `/voice-on`, `/voice-tts`, `/voice-off` already set the mode; make each
     toast state the current mode clearly.
5. **Docs** — update the "How Voice Replies Work" card in `VoiceSection.tsx` to
   describe the three modes + explicit-request behavior consistently with the
   actual implementation.

---

## Verification checklist

- [ ] Select Edge in Settings → chat "convert this into audio" → tool output says
      `generated with edge` (and a player shows in the tool result).
- [ ] Text message in default mode → **no** audio call at all (tool refuses /
      agent replies in text only).
- [ ] Voice note (audio attachment) in default mode → audio reply with player.
- [ ] `/voice-tts` → text messages also get audio.
- [ ] `/voice-off` → nothing is synthesized, text only.
- [ ] Provider change is reflected immediately (Redis global key invalidated);
      restart or wait 1h is not required.
