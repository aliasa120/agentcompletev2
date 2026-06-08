"use client";

import React from "react";
import { CardShell, ResultBlock, QueryChip } from "./CardShell";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";
import { FileText } from "lucide-react";

const ACCENT = "#0D9488"; // Teal for reading files

export const FileReadCard = React.memo<{ toolCall: ToolCall }>(({ toolCall }) => {
  const args = toolCall.args as Record<string, unknown>;
  const path = String(args.path ?? args.file_path ?? "unknown file");
  const result = toolCall.result ?? "";
  const hasResult = Boolean(result);

  const { phase } = useCardPhase(toolCall.status, hasResult, 12, path.length);

  return (
    <CardShell
      title="📖 Reading file"
      accentColor={ACCENT}
      phase={phase}
      toggleable={hasResult}
    >
      <div className="flex flex-col gap-2.5">
        <QueryChip accentColor={ACCENT}>
          <div className="flex items-center gap-1.5 font-mono text-[11.5px] text-foreground">
            <FileText size={13} style={{ color: ACCENT }} />
            <span className="truncate max-w-[280px]">{path}</span>
          </div>
        </QueryChip>

        {phase === "loading" && (
          <div className="flex flex-col gap-2 mt-2">
            <div className="h-1 w-full rounded-full overflow-hidden relative" style={{ background: `${ACCENT}15` }}>
              <div 
                className="h-full rounded-full absolute left-0 top-0" 
                style={{
                  background: ACCENT,
                  animation: "readProgress 2s ease-in-out infinite",
                  width: "40%",
                }} 
              />
            </div>
            <span className="text-[11px] text-muted-foreground italic flex items-center gap-1.5">
              Analyzing file structure...
            </span>
          </div>
        )}

        {phase === "result" && result && (
          <div className="mt-1" style={{ animation: "agentFadeIn 0.3s ease both" }}>
            <ResultBlock
              result={result}
              label="File Contents"
              accentColor={ACCENT}
              previewLength={350}
            />
          </div>
        )}
      </div>
    </CardShell>
  );
});

FileReadCard.displayName = "FileReadCard";
