"use client";

import React, { useEffect, useState } from "react";
import { CardShell, LoadingDots, ShimmerLine, TypewriterText, QueryChip, ResultBlock } from "./CardShell";
import { useTypingAnimation } from "./useTypingAnimation";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";

const ACCENT = "#2F6868";

function extractSources(result: string): string[] {
  const urlRegex = /https?:\/\/[^\s)>\]"]+/g;
  const matches = result.match(urlRegex) ?? [];
  return [...new Set(matches)].slice(0, 5);
}

function getDomain(url: string): string {
  try { return new URL(url).hostname.replace("www.", ""); }
  catch { return url.slice(0, 28); }
}

export const SearchCard = React.memo<{ toolCall: ToolCall }>(({ toolCall }) => {
  const query = String((toolCall.args as Record<string, unknown>).query ?? "");
  const result = toolCall.result ?? "";
  const hasResult = Boolean(result);

  const { phase, signalTypingDone } = useCardPhase(toolCall.status, hasResult, 18, query.length);
  const { displayText, isDone } = useTypingAnimation(query, 18, phase === "querying");

  useEffect(() => { if (isDone) signalTypingDone(); }, [isDone, signalTypingDone]);

  const sources = hasResult ? extractSources(result) : [];

  return (
    <CardShell title="🔍 Searching the web" accentColor={ACCENT} phase={phase} toggleable={false}>
      {/* Query chip */}
      <QueryChip accentColor={ACCENT}>
        <TypewriterText
          text={phase === "querying" ? displayText : query}
          isDone={phase !== "querying" || isDone}
          accentColor={ACCENT}
        />
      </QueryChip>

      {/* Loading */}
      {phase === "loading" && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoadingDots color={ACCENT} />
            <span>Searching the web…</span>
          </div>
          <ShimmerLine width="90%" />
          <ShimmerLine width="75%" />
          <ShimmerLine width="55%" />
        </div>
      )}

      {/* Result */}
      {phase === "result" && result && (
        <div className="mt-3 space-y-2" style={{ animation: "agentFadeIn 0.3s ease both" }}>
          <ResultBlock result={result} previewLength={280} label="Result" accentColor={ACCENT} />
          {sources.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider self-center mr-1">Sources:</span>
              {sources.map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10.5px] font-medium px-2 py-0.5 rounded-full no-underline transition-colors hover:opacity-80"
                  style={{
                    border: `1px solid ${ACCENT}44`,
                    background: `${ACCENT}0D`,
                    color: ACCENT,
                  }}
                >
                  {getDomain(url)}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </CardShell>
  );
});

SearchCard.displayName = "SearchCard";
