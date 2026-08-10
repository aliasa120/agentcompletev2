"use client";

/**
 * AudioReplyList — renders an inline audio player for TTS replies.
 *
 * The backend (text_to_speech tool or the finalize_response voice mirror)
 * appends AUDIO_URL markers to the assistant message; the runtime converter
 * strips them into message.metadata.custom.audioReplies, rendered here.
 */

import { useAuiState } from "@assistant-ui/react";
import { Volume2Icon } from "lucide-react";
import type { FC } from "react";

type AudioReply = { url: string; voice: boolean };

// Stable reference — a selector that returns a fresh [] each call triggers
// "getSnapshot should be cached" infinite loops in useSyncExternalStore.
const EMPTY_AUDIOS: AudioReply[] = [];

export const AudioReplyList: FC = () => {
  const audios = useAuiState(
    (s) =>
      ((s.message as any)?.metadata?.custom?.audioReplies ?? EMPTY_AUDIOS) as AudioReply[],
  );

  if (!audios || audios.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-2 px-2">
      {audios.map((a, i) => (
        <div
          key={`${a.url}-${i}`}
          className="border-border/60 bg-muted/30 flex items-center gap-2 rounded-xl border px-3 py-2"
        >
          <Volume2Icon className="text-primary size-4 shrink-0" />
          <audio controls preload="none" src={a.url} className="h-9 w-full max-w-md">
            Your browser does not support audio playback.
          </audio>
        </div>
      ))}
    </div>
  );
};
