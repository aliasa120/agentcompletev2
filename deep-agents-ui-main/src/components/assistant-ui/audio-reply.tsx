"use client";

/**
 * AudioReplyList — renders an inline audio player for TTS replies.
 *
 * Three data sources (checked in priority order):
 *
 *  1. message.metadata.custom.audioReplies — injected by useExternalMessageConverter
 *     when the AUDIO_URL marker was present in the stream at conversion time.
 *     Works for short/fast TTS where the marker arrives before the stream ends.
 *
 *  2. audioRepliesMap[messageId] — keyed by the exact message ID from the server
 *     poll. Works when the stream ID and server ID happen to match.
 *
 *  3. audioRepliesMap["__latest__"] — the LangGraph stream assigns a different ID
 *     to the same AI message than the persisted state does (lc_run--... vs UUID).
 *     So the exact lookup by messageId fails. As a fallback, the last assistant
 *     message in the thread checks "__latest__" which always holds the most recent
 *     audio collected from the server poll.
 */

import { useAuiState } from "@assistant-ui/react";
import { useLangGraphRuntime } from "@/providers/LangGraphRuntimeProvider";
import { Volume2Icon } from "lucide-react";
import { useMemo, type FC } from "react";

type AudioReply = { url: string; voice: boolean; provider?: string };

const PROVIDER_LABELS: Record<string, string> = {
  mimo: "Xiaomi MiMo-V2.5-TTS",
  elevenlabs: "ElevenLabs",
  openai: "OpenAI TTS",
  edge: "Edge TTS",
};

const EMPTY_AUDIOS: AudioReply[] = [];

/** Renders the actual audio player cards. */
const AudioPlayerCards: FC<{ audios: AudioReply[] }> = ({ audios }) => {
  if (!audios || audios.length === 0) return null;

  // De-duplicate by URL (prevent showing the same audio multiple times)
  const seen = new Set<string>();
  const unique = audios.filter(a => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  return (
    <div className="mt-2 flex flex-col gap-2 px-2">
      {unique.map((a, i) => {
        const providerName = (a.provider && PROVIDER_LABELS[a.provider]) || "Speech Audio";
        return (
          <div
            key={`${a.url}-${i}`}
            className="border-border/60 bg-muted/30 flex flex-col gap-1.5 rounded-xl border p-3"
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
              <Volume2Icon className="text-primary size-3.5 shrink-0" />
              <span>{providerName}</span>
            </div>
            <audio controls preload="none" src={a.url} className="h-9 w-full max-w-md">
              Your browser does not support audio playback.
            </audio>
          </div>
        );
      })}
    </div>
  );
};

export const AudioReplyList: FC = () => {
  // ── Source 1: converter-injected audio (fast-path, short responses) ──────────
  const converterAudios = useAuiState(
    (s) =>
      ((s.message as any)?.metadata?.custom?.audioReplies ?? EMPTY_AUDIOS) as AudioReply[],
  );

  // ── Source 2 & 3: bypass map lookup ─────────────────────────────────────────
  const messageId = useAuiState((s) => (s.message as any)?.id as string | undefined);

  // Check if this is the LAST assistant message in the thread.
  // Used to decide whether to show __latest__ audio (which is thread-level, not
  // message-level, because LangGraph stream IDs ≠ persisted state IDs).
  const isLastAssistant = useAuiState((s) => {
    const msgs: any[] = (s.thread as any)?.messages ?? [];
    // Find the last message with role "assistant"
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "assistant") {
        return msgs[i]?.id === (s.message as any)?.id;
      }
    }
    return false;
  });

  const { audioRepliesMap } = useLangGraphRuntime();

  const bypassAudios = useMemo(() => {
    if (!messageId) return EMPTY_AUDIOS;
    // Try exact message ID lookup first (works when IDs match)
    const exact = audioRepliesMap.get(messageId);
    if (exact && exact.length > 0) return exact;
    // Fall back to __latest__ for the last assistant message in the thread.
    // This handles the LangGraph ID mismatch: stream delivers lc_run--<x>
    // but server state persists the same message as <UUID>.
    if (isLastAssistant) {
      const latest = audioRepliesMap.get("__latest__");
      if (latest && latest.length > 0) return latest;
    }
    return EMPTY_AUDIOS;
  }, [audioRepliesMap, messageId, isLastAssistant]);

  // Prefer converter audios (already stripped/cleaned); fall back to polled data.
  const audios = useMemo<AudioReply[]>(
    () => (converterAudios.length > 0 ? converterAudios : bypassAudios),
    [converterAudios, bypassAudios],
  );

  if (process.env.NODE_ENV === "development") {
    if (converterAudios.length > 0 || bypassAudios.length > 0 || audioRepliesMap.size > 0) {
      console.log(
        `[AudioReplyList] msgId=${messageId} isLast=${isLastAssistant} ` +
        `converter=${converterAudios.length} bypass=${bypassAudios.length} ` +
        `mapSize=${audioRepliesMap.size} final=${audios.length}`
      );
    }
  }

  return <AudioPlayerCards audios={audios} />;
};
