"use client";

import React from "react";
import { CardShell, ResultBlock, QueryChip } from "./CardShell";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";
import { FileText } from "lucide-react";

import { cardAccent } from "@/lib/theme";

export const FileReadCard = React.memo<{ toolCall: ToolCall }>(
  ({ toolCall }) => {
    const args = toolCall.args as Record<string, unknown>;
    const path = String(args.path ?? args.file_path ?? "unknown file");
    const result = toolCall.result ?? "";
    const hasResult = Boolean(result);

    const { phase } = useCardPhase(
      toolCall.status,
      hasResult,
      12,
      path.length
    );

    return (
      <CardShell
        title="📖 Reading file"
        accentColor={cardAccent.fileRead}
        phase={phase}
        toggleable={hasResult}
      >
        <div className="flex flex-col gap-2.5">
          <QueryChip>
            <div className="flex items-center gap-1.5 font-mono text-[11px] text-foreground">
              <FileText size={12} className="text-primary shrink-0" />
              <span className="truncate max-w-[260px] text-muted-foreground">{path}</span>
            </div>
          </QueryChip>

          {phase === "loading" && (
            <div className="flex flex-col gap-2 mt-2">
              <div className="h-1.5 w-full rounded-full overflow-hidden bg-muted relative">
                <div
                  className="h-full rounded-full absolute left-0 top-0 bg-primary"
                  style={{
                    animation: "readProgress 2s ease-in-out infinite",
                    width: "40%",
                  }}
                />
              </div>
              <span className="text-[11px] text-muted-foreground italic flex items-center gap-1.5">
                Analyzing file structure…
              </span>
            </div>
          )}

          {phase === "result" && result && (
            <div
              className="mt-1"
              style={{ animation: "agentFadeIn 0.3s ease both" }}
            >
              <ResultBlock
                result={result}
                label="File Contents"
                
                previewLength={350}
              />
            </div>
          )}
        </div>
      </CardShell>
    );
  }
);

FileReadCard.displayName = "FileReadCard";
