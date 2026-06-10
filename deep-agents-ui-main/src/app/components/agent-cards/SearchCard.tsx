"use client";

import React, { useEffect } from "react";
import {
  CardShell,
  LoadingDots,
  ShimmerLine,
  TypewriterText,
  QueryChip,
  ResultBlock,
} from "./CardShell";
import { useTypingAnimation } from "./useTypingAnimation";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";
import { Globe } from "lucide-react";

import { cardAccent } from "@/lib/theme";

function extractSources(result: string): string[] {
  const urlRegex = /https?:\/\/[^\s)>\]"]+/g;
  const matches = result.match(urlRegex) ?? [];
  return [...new Set(matches)].slice(0, 5);
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url.slice(0, 28);
  }
}

export const SearchCard = React.memo<{ toolCall: ToolCall }>(({ toolCall }) => {
  const query = String(
    (toolCall.args as Record<string, unknown>).query ?? ""
  );
  const result = toolCall.result ?? "";
  const hasResult = Boolean(result);

  const { phase, signalTypingDone } = useCardPhase(
    toolCall.status,
    hasResult,
    18,
    query.length
  );
  const { displayText, isDone } = useTypingAnimation(
    query,
    18,
    phase === "querying"
  );

  useEffect(() => {
    if (isDone) signalTypingDone();
  }, [isDone, signalTypingDone]);

  const sources = hasResult ? extractSources(result) : [];

  return (
    <CardShell
      title="🔍 Searching the web"
      accentColor={cardAccent.search}
      phase={phase}
      toggleable={false}
    >
      {/* Query chip */}
      <QueryChip>
        <Globe size={11} className="text-primary shrink-0" />
        <TypewriterText
          text={phase === "querying" ? displayText : query}
          isDone={phase !== "querying" || isDone}

        />
      </QueryChip>

      {/* Loading */}
      {phase === "loading" && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <LoadingDots />
            <span>Fetching results…</span>
          </div>
          <ShimmerLine width="90%" />
          <ShimmerLine width="72%" />
          <ShimmerLine width="55%" />
        </div>
      )}

      {/* Result */}
      {phase === "result" && result && (
        <div
          className="mt-3 space-y-2.5"
          style={{ animation: "agentFadeIn 0.3s ease both" }}
        >
          <ResultBlock
            result={result}
            previewLength={280}
            label="Result"

          />
          {sources.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-0.5">
              <span className="text-[9.5px] text-muted-foreground uppercase tracking-widest self-center mr-1 font-semibold">
                Sources
              </span>
              {sources.map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] font-semibold px-2 py-0.5 rounded-full no-underline transition-opacity hover:opacity-75 bg-muted border border-border text-muted-foreground hover:text-foreground"
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
