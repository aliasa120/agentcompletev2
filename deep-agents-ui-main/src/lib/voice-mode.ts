/**
 * Per-thread voice-reply mode ("off" | "voice_only" | "all"), persisted in
 * localStorage per thread. Passed to the LangGraph run as
 * config.configurable.voice_mode; the graph's finalize_response node mirrors
 * voice replies accordingly.
 *
 * IMPORTANT: a NEW chat (threadId == null) ALWAYS starts in the default
 * "voice_only" mode. A mode chosen with a slash command BEFORE the thread
 * exists (e.g. /voice-tts typed as the first message) is kept in sessionStorage
 * ("voicemode:new") and migrated onto the thread's key once the thread is
 * created — so it never leaks into future new chats.
 */

export type VoiceMode = "off" | "voice_only" | "all";

const KEY_PREFIX = "voicemode:";
const NEW_SLOT = KEY_PREFIX + "new"; // sessionStorage: mode chosen before a thread existed

function key(threadId: string): string {
  return KEY_PREFIX + threadId;
}

export function readVoiceMode(threadId: string | null): VoiceMode {
  if (typeof window === "undefined") return "voice_only";
  if (!threadId) return "voice_only"; // fresh chat always defaults to voice-to-voice
  const raw = window.localStorage.getItem(key(threadId));
  return raw === "off" || raw === "voice_only" || raw === "all" ? raw : "voice_only";
}

export function writeVoiceMode(threadId: string | null, mode: VoiceMode): void {
  if (typeof window === "undefined") return;
  if (threadId) {
    window.localStorage.setItem(key(threadId), mode);
  } else {
    // Session-scoped: only survives this tab/session, never a future new chat.
    window.sessionStorage.setItem(NEW_SLOT, mode);
  }
}

/** Mode explicitly chosen while threadId was null (slash command as first message). */
export function readPendingNewMode(): VoiceMode | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(NEW_SLOT);
  return raw === "off" || raw === "voice_only" || raw === "all" ? raw : null;
}

/** Clear the pre-thread slot (used when a new chat starts fresh). */
export function clearPendingNewMode(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(NEW_SLOT);
}

/**
 * Migrate a pre-thread voice mode onto a just-created thread's key.
 * Returns the migrated mode, or null when there was nothing pending.
 */
export function migratePendingMode(threadId: string): VoiceMode | null {
  if (typeof window === "undefined") return null;
  const pending = readPendingNewMode();
  if (!pending) return null;
  window.localStorage.setItem(key(threadId), pending);
  clearPendingNewMode();
  return pending;
}

export const VOICE_MODE_LABELS: Record<VoiceMode, string> = {
  off: "off — the agent will reply in text only",
  voice_only: "on — the agent will speak replies to your voice messages",
  all: "tts — the agent will speak every reply",
};
