"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { Volume2Icon } from "lucide-react";

/**
 * Extract the first AUDIO_URL:<url> marker from a tool result string.
 * Returns null when the result has no audio marker.
 */
function extractAudioUrl(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const m = text.match(/AUDIO_URL:(\S+)/);
  return m ? m[1] : null;
}

/**
 * Strip AUDIO_URL: / AUDIO_VOICE: marker lines from displayed text so the raw
 * link no longer shows as plain text (the audio player replaces it).
 */
function stripAudioMarkers(text: unknown): string {
  if (typeof text !== "string") return "";
  return text
    .split("\n")
    .map((line) =>
      line.replace(/AUDIO_URL:\S+/g, "").replace(/AUDIO_VOICE:(true|false)/g, ""),
    )
    .filter((line) => line.trim() !== "")
    .join("\n")
    .trim();
}

export const ToolFallback: ToolCallMessagePartComponent = ({ toolName, argsText, result }) => {
  const resultText = typeof result === "string" ? result : JSON.stringify(result ?? "");
  const audioUrl = extractAudioUrl(resultText);
  const cleanArgs = stripAudioMarkers(argsText);
  const cleanResult = stripAudioMarkers(resultText);

  return (
    <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
      <div className="font-medium">{toolName}</div>
      {audioUrl && (
        <div className="border-border/60 bg-muted/30 mt-2 flex items-center gap-2 rounded-xl border px-3 py-2">
          <Volume2Icon className="text-primary size-4 shrink-0" />
          <audio controls preload="none" src={audioUrl} className="h-9 w-full max-w-md">
            Your browser does not support audio playback.
          </audio>
        </div>
      )}
      {cleanArgs ? <pre className="mt-2 overflow-auto text-xs">{cleanArgs}</pre> : null}
      {cleanResult ? <pre className="mt-2 overflow-auto text-xs">{JSON.stringify(cleanResult, null, 2)}</pre> : null}
    </div>
  );
};
