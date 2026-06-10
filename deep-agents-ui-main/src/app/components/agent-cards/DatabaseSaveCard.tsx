"use client";

import React from "react";
import { CardShell, LoadingDots } from "./CardShell";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";
import { CheckCircle2, Database } from "lucide-react";

import { cardAccent } from "@/lib/theme";

export const DatabaseSaveCard = React.memo<{ toolCall: ToolCall }>(
  ({ toolCall }) => {
    const result = toolCall.result ?? "";
    const hasResult = Boolean(result);
    const { phase } = useCardPhase(toolCall.status, hasResult, 18, 20);

    return (
      <CardShell
        title="💾 Saving to database"
        accentColor={cardAccent.dbSave}
        phase={phase}
        toggleable={false}
      >
        {phase !== "result" && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <LoadingDots />
            <span>Writing to Supabase…</span>
          </div>
        )}
        {phase === "result" && (
          <div
            className="space-y-2"
            style={{ animation: "agentFadeIn 0.3s ease both" }}
          >
            <span className="text-[13px] font-bold flex items-center gap-1.5 text-foreground">
              <Database size={13} className="text-primary" />
              Saved
              <CheckCircle2 size={13} className="text-primary" />
            </span>
            {result && (
              <pre className="font-mono text-[10.5px] p-2.5 rounded-lg border border-border mt-1 bg-muted/50 text-foreground overflow-x-auto">
                {result.slice(0, 150)}
              </pre>
            )}
          </div>
        )}
      </CardShell>
    );
  }
);

DatabaseSaveCard.displayName = "DatabaseSaveCard";
