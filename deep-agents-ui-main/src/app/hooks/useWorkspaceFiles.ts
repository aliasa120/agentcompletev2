"use client";

/**
 * useWorkspaceFiles — lists files the agent created on disk for the active thread.
 *
 * Agent files live in `output/threads/<thread_id>/`. Small text files are also
 * mirrored into LangGraph state (`stream.values.files`) so they can be edited
 * inline; binaries (PDF, PNG, MP4, XLSX…) and large files exist only on disk and
 * are listed here, then streamed on demand from `/api/thread-files/content`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryState } from "nuqs";
import { useChatContext } from "@/providers/ChatProvider";
import type { WorkspaceFile } from "@/app/components/WorkspaceFileDialog";

function normalizePath(p: string): string {
  return String(p || "").replace(/^\/+/, "");
}

/**
 * @param stateFiles LangGraph state `files` map; entries already present there
 *   are excluded so a file never shows up twice.
 */
export function useWorkspaceFiles(stateFiles: Record<string, string>): WorkspaceFile[] {
  const [threadId] = useQueryState("threadId");
  const { isLoading } = useChatContext();
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);

  const stateKeys = useMemo(
    () => new Set(Object.keys(stateFiles).map(normalizePath)),
    [stateFiles]
  );

  const refresh = useCallback(async () => {
    if (!threadId) {
      setWorkspaceFiles([]);
      return;
    }
    try {
      const res = await fetch(
        `/api/thread-files?threadId=${encodeURIComponent(threadId)}`
      );
      if (!res.ok) return;
      const data = await res.json();
      setWorkspaceFiles(Array.isArray(data.files) ? data.files : []);
    } catch {
      /* listing is best-effort; state files still render */
    }
  }, [threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-list when a run finishes, since that is when new files appear.
  useEffect(() => {
    if (isLoading === false) void refresh();
  }, [isLoading, refresh]);

  return useMemo(
    () => workspaceFiles.filter((f) => !stateKeys.has(normalizePath(f.path))),
    [workspaceFiles, stateKeys]
  );
}
