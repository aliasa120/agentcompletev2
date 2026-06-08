"use client";

import React from "react";
import { CardShell, LoadingDots } from "./CardShell";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";

const ACCENT = "#0EA5E9";

export const DatabaseSaveCard = React.memo<{ toolCall: ToolCall }>(({ toolCall }) => {
  const result = toolCall.result ?? "";
  const hasResult = Boolean(result);
  const { phase } = useCardPhase(toolCall.status, hasResult, 18, 20);

  return (
    <CardShell title="💾 Saving to database" accentColor={ACCENT} phase={phase} toggleable={false}>
      {phase !== "result" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoadingDots color={ACCENT} />
          <span>Writing to Supabase…</span>
        </div>
      )}
      {phase === "result" && (
        <div className="space-y-1.5" style={{ animation: "agentFadeIn 0.3s ease both" }}>
          <span className="text-[13px] font-bold" style={{ color: ACCENT }}>Saved ✓</span>
          {result && (
            <pre className="font-mono text-[11px] p-2 rounded border border-border mt-1"
              style={{ background: "rgba(0,0,0,0.02)" }}>
              {result.slice(0, 150)}
            </pre>
          )}
        </div>
      )}
    </CardShell>
  );
});

DatabaseSaveCard.displayName = "DatabaseSaveCard";
