"use client";

/**
 * WorkspaceFileDialog — opens a file that lives on disk in the agent's thread
 * workspace (`output/threads/<thread_id>/`).
 *
 * Small text files are mirrored into LangGraph state and open through
 * FileViewDialog (editable). Everything else — PDFs, images, audio, video,
 * spreadsheets, archives, large text — is streamed from
 * `/api/thread-files/content` and rendered here.
 */

import React, { useEffect, useMemo, useState } from "react";
import {
  FileText,
  Download,
  X,
  Loader2,
  FileArchive,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";

export interface WorkspaceFile {
  path: string;
  name: string;
  size: number;
  mimeType: string;
  modifiedAt: string;
  isText: boolean;
  url: string;
}

const MAX_INLINE_TEXT_BYTES = 512 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const WorkspaceFileDialog = React.memo<{
  file: WorkspaceFile;
  onClose: () => void;
}>(({ file, onClose }) => {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kind = useMemo(() => {
    if (file.mimeType.startsWith("image/")) return "image";
    if (file.mimeType.startsWith("audio/")) return "audio";
    if (file.mimeType.startsWith("video/")) return "video";
    if (file.mimeType === "application/pdf") return "pdf";
    if (file.isText) return "text";
    return "binary";
  }, [file.mimeType, file.isText]);

  useEffect(() => {
    if (kind !== "text") return;
    if (file.size > MAX_INLINE_TEXT_BYTES) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(file.url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load file (HTTP ${res.status})`);
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setTextContent(text);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load file");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [file.url, file.size, kind]);

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="flex h-[80vh] max-h-[80vh] min-w-[60vw] flex-col p-6">
        <DialogTitle className="sr-only">{file.name}</DialogTitle>
        <div className="mb-4 flex items-center justify-between gap-3 border-b border-border pb-4">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="text-primary/50 h-5 w-5 shrink-0" />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap text-base font-medium text-primary">
              {file.path}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatSize(file.size)}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <a
              href={`${file.url}&download=1`}
              download={file.name}
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-primary hover:bg-primary/10"
            >
              <Download size={16} />
              Download
            </a>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={file.url}
              alt={file.name}
              className="mx-auto max-h-full max-w-full object-contain"
            />
          )}

          {kind === "audio" && (
            <div className="flex h-full items-center justify-center">
              <audio controls src={file.url} className="w-full max-w-xl">
                Your browser does not support audio playback.
              </audio>
            </div>
          )}

          {kind === "video" && (
            <video
              controls
              preload="metadata"
              src={file.url}
              className="mx-auto max-h-full w-full bg-black"
            >
              Your browser does not support video playback.
            </video>
          )}

          {kind === "pdf" && (
            <iframe
              src={file.url}
              title={file.name}
              className="h-full w-full rounded-md border border-border bg-white"
            />
          )}

          {kind === "text" && (
            <ScrollArea className="bg-surface h-full rounded-md">
              <div className="p-4">
                {file.size > MAX_INLINE_TEXT_BYTES ? (
                  <p className="text-sm text-muted-foreground">
                    File is {formatSize(file.size)} — too large to preview. Use Download.
                  </p>
                ) : loading ? (
                  <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                    <Loader2 size={16} className="animate-spin" />
                    Loading…
                  </div>
                ) : error ? (
                  <p className="text-sm text-destructive">{error}</p>
                ) : (
                  <pre className="whitespace-pre-wrap break-words font-mono text-sm text-foreground">
                    {textContent}
                  </pre>
                )}
              </div>
            </ScrollArea>
          )}

          {kind === "binary" && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <FileArchive className="text-muted-foreground h-10 w-10" />
              <p className="text-sm text-muted-foreground">
                {file.mimeType} — no in-browser preview available.
              </p>
              <a
                href={`${file.url}&download=1`}
                download={file.name}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                <Download size={16} />
                Download {file.name}
              </a>
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end border-t border-border pt-4">
          <Button onClick={onClose} variant="outline" size="sm">
            <X size={16} className="mr-1" />
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
});

WorkspaceFileDialog.displayName = "WorkspaceFileDialog";
