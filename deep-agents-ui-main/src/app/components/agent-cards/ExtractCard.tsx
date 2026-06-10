"use client";

import React from "react";
import { CardShell, LoadingDots, ShimmerLine, ResultBlock } from "./CardShell";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";
import { Link } from "lucide-react";

import { cardAccent } from "@/lib/theme";

function formatUrl(raw: string): { domain: string; path: string } {
  try {
    const u = new URL(raw);
    const path = u.pathname;
    return {
      domain: u.hostname.replace("www.", ""),
      path: path.length > 40 ? path.slice(0, 40) + "…" : path,
    };
  } catch {
    return { domain: raw.slice(0, 35), path: "" };
  }
}

export const ExtractCard = React.memo<{ toolCall: ToolCall }>(
  ({ toolCall }) => {
    const url = String(
      (toolCall.args as Record<string, unknown>).url ?? ""
    );
    const result = toolCall.result ?? "";
    const hasResult = Boolean(result);
    const { phase } = useCardPhase(
      toolCall.status,
      hasResult,
      18,
      url.length
    );
    const { domain, path } = formatUrl(url);

    return (
      <CardShell
        title="📄 Reading article"
        accentColor={cardAccent.extract}
        phase={phase}
        toggleable={false}
      >
        {/* URL chip — uses pure theme classes */}
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-mono text-[11px] max-w-full break-all bg-muted border border-border">
          <Link size={11} className="text-primary shrink-0" />
          <span className="font-semibold text-foreground">{domain}</span>
          {path && (
            <span className="text-muted-foreground">{path}</span>
          )}
        </div>

        {/* Loading */}
        {phase === "loading" && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <LoadingDots />
              <span>Extracting content…</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ animation: "readProgress 2.5s ease-out forwards" }}
              />
            </div>
            <ShimmerLine width="100%" />
            <ShimmerLine width="80%" />
            <ShimmerLine width="60%" />
          </div>
        )}

        {/* Result */}
        {phase === "result" && result && (
          <div
            className="mt-3"
            style={{ animation: "agentFadeIn 0.3s ease both" }}
          >
            <ResultBlock
              result={result}
              previewLength={320}
              label="Extracted Content"
              
            />
          </div>
        )}
      </CardShell>
    );
  }
);

ExtractCard.displayName = "ExtractCard";
