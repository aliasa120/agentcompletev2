"use client";

/**
 * FileReplyList — renders downloadable file cards for files the agent created.
 *
 * The backend (terminal tool, and any tool that creates files) appends
 * FILE_URL:<url> markers to its result; the runtime converter strips them into
 * message.metadata.custom.files, rendered here as download/preview cards.
 */

import { useAuiState } from "@assistant-ui/react";
import { DownloadIcon, FileTextIcon, FileIcon, ImageIcon } from "lucide-react";
import type { FC } from "react";

type FileEntry = { url: string; name: string };

// Stable reference — a selector that returns a fresh [] each call triggers
// "getSnapshot should be cached" infinite loops in useSyncExternalStore.
const EMPTY_FILES: FileEntry[] = [];

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const PDF_EXT = /\.pdf$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi)$/i;

function fileIcon(name: string) {
  if (IMAGE_EXT.test(name)) return ImageIcon;
  if (PDF_EXT.test(name)) return FileTextIcon;
  return FileIcon;
}

export const FileReplyList: FC = () => {
  const files = useAuiState(
    (s) =>
      ((s.message as any)?.metadata?.custom?.files ?? EMPTY_FILES) as FileEntry[],
  );

  if (!files || files.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-2 px-2">
      {files.map((f, i) => {
        const isImage = IMAGE_EXT.test(f.name);
        const isAudio = AUDIO_EXT.test(f.name);
        const isVideo = VIDEO_EXT.test(f.name);
        const Icon = fileIcon(f.name);
        return (
          <div
            key={`${f.url}-${i}`}
            className="border-border/60 bg-muted/30 flex flex-col gap-2 overflow-hidden rounded-xl border"
          >
            {isImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={f.url}
                alt={f.name}
                className="max-h-64 w-full object-contain bg-card"
              />
            )}
            {isAudio && (
              <audio controls preload="none" src={f.url} className="h-9 w-full px-3 pt-2">
                Your browser does not support audio playback.
              </audio>
            )}
            {isVideo && (
              <video controls preload="metadata" src={f.url} className="max-h-64 w-full bg-black">
                Your browser does not support video playback.
              </video>
            )}
            <div className="flex items-center gap-2 px-3 py-2">
              <Icon className="text-primary size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {f.name}
              </span>
              <a
                href={f.url}
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
      })}
    </div>
  );
};
