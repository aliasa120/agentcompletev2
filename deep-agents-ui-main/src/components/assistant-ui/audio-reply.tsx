"use client";

/**
 * AudioReplyList — renders an inline audio player for TTS replies.
 *
 * Strictly per-message. Each assistant message owns its audio under its own
 * messageId. No "__latest__" spillover — so if "how are you" (msg A) finishes
 * TTS after "kya haal hai" (msg B) has already completed, A's player stays
 * under A and B's player stays under B.
 *
 * Data sources:
 *  1. message.metadata.custom.audioReplies — converter-injected when the
 *     AUDIO_URL marker was in the streamed content (tools + non-web mirror).
 *  2. audioRepliesMap[messageId] — async web mirror via POST /api/tts plus
 *     any late polled markers (exact messageId only).
 */

import { useAuiState } from "@assistant-ui/react";
import { useLangGraphRuntime } from "@/providers/LangGraphRuntimeProvider";
import { Volume2Icon, Loader2 } from "lucide-react";
import { useMemo, type FC } from "react";

type AudioReply = { url: string; voice: boolean; provider?: string };

const PROVIDER_LABELS: Record<string, string> = {
  mimo: "Xiaomi MiMo-V2.5-TTS",
  elevenlabs: "ElevenLabs",
  openai: "OpenAI TTS",
  edge: "Edge TTS",
};

const EMPTY_AUDIOS: AudioReply[] = [];

const AudioPlayerCards: FC<{ audios: AudioReply[]; loading?: boolean }> = ({ audios, loading }) => {
  if (loading && audios.length === 0) {
    return (
      <div className="mt-2 flex flex-col gap-2 px-2">
        <div className="border-border/60 bg-muted/30 flex items-center gap-2 rounded-xl border p-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin shrink-0" />
          <span>Generating voice…</span>
        </div>
      </div>
    );
  }
  if (!audios || audios.length === 0) return null;

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
  const converterAudios = useAuiState(
    (s) =>
      ((s.message as any)?.metadata?.custom?.audioReplies ?? EMPTY_AUDIOS) as AudioReply[],
  );

  const messageId = useAuiState((s) => (s.message as any)?.id as string | undefined);
  const { audioRepliesMap, ttsPendingSet } = useLangGraphRuntime();

  const bypassAudios = useMemo(() => {
    if (!messageId) return EMPTY_AUDIOS;
    return audioRepliesMap.get(messageId) ?? EMPTY_AUDIOS;
  }, [audioRepliesMap, messageId]);

  const isPending = useMemo(() => {
    if (!messageId) return false;
    return ttsPendingSet.has(messageId);
  }, [ttsPendingSet, messageId]);

  const audios = useMemo<AudioReply[]>(
    () => (converterAudios.length > 0 ? converterAudios : bypassAudios),
    [converterAudios, bypassAudios],
  );

  if (audios.length === 0 && !isPending) return null;
  return <AudioPlayerCards audios={audios} loading={isPending && audios.length === 0} />;
};
