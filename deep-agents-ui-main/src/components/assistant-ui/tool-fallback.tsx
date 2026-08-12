"use client";

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { DownloadIcon, FileIcon, FileTextIcon, Volume2Icon } from "lucide-react";

/**
 * Extract the first AUDIO_URL:<url> marker from a tool result string.
 * Returns null when the result has no audio marker.
 */
function extractAudioUrl(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const m = text.match(/AUDIO_URL:(\S+)/);
  return m ? m[1] : null;
}

type FileEntry = { url: string; name: string };

/** Extract FILE_URL:<url> markers from a tool result string. */
function extractFileUrls(text: unknown): FileEntry[] {
  if (typeof text !== "string") return [];
  const files: FileEntry[] = [];
  for (const m of text.matchAll(/FILE_URL:(\S+)/g)) {
    const url = m[1];
    files.push({ url, name: decodeURIComponent(url.split("/").pop() ?? "file") });
  }
  return files;
}

/**
 * Strip AUDIO_URL: / AUDIO_VOICE: / FILE_URL: marker lines from displayed text
 * so the raw links no longer show as plain text (players/cards replace them).
 */
function stripAudioMarkers(text: unknown): string {
  if (typeof text !== "string") return "";
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/AUDIO_URL:\S+/g, "")
        .replace(/AUDIO_VOICE:(true|false)/g, "")
        .replace(/FILE_URL:\S+/g, ""),
    )
    .filter((line) => line.trim() !== "")
    .join("\n")
    .trim();
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const PDF_EXT = /\.pdf$/i;

function FileCard({ url, name }: FileEntry) {
  const isImage = IMAGE_EXT.test(name);
  const Icon = PDF_EXT.test(name) ? FileTextIcon : FileIcon;
  return (
    <div className="border-border/60 bg-muted/30 mt-2 flex flex-col gap-2 overflow-hidden rounded-xl border">
      {isImage && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={name} className="max-h-64 w-full object-contain bg-card" />
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className="text-primary size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{name}</span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          download
          className="text-primary flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold hover:bg-primary/10"
        >
          <DownloadIcon className="size-3.5" />
          Download
        </a>
      </div>
    </div>
  );
}

export const ToolFallback: ToolCallMessagePartComponent = ({ toolName, argsText, result }) => {
  const resultText = typeof result === "string" ? result : JSON.stringify(result ?? "");
  const audioUrl = extractAudioUrl(resultText);
  const files = extractFileUrls(resultText);
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
      {files.map((f, i) => (
        <FileCard key={`${f.url}-${i}`} url={f.url} name={f.name} />
      ))}
      {cleanArgs ? <pre className="mt-2 overflow-auto text-xs">{cleanArgs}</pre> : null}
      {cleanResult ? <pre className="mt-2 overflow-auto text-xs">{JSON.stringify(cleanResult, null, 2)}</pre> : null}
    </div>
  );
};
