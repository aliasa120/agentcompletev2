"use client";

import React, { useState } from "react";
import { CardShell, LoadingDots, ShimmerLine, ResultBlock } from "./CardShell";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";

const ACCENT = "#3B82F6";

function formatUrl(raw: string): { domain: string; path: string } {
  try {
    const u = new URL(raw);
    const path = u.pathname;
    return { domain: u.hostname.replace("www.", ""), path: path.length > 40 ? path.slice(0, 40) + "…" : path };
  } catch { return { domain: raw.slice(0, 35), path: "" }; }
}

export const ExtractCard = React.memo<{ toolCall: ToolCall }>(({ toolCall }) => {
  const url = String((toolCall.args as Record<string, unknown>).url ?? "");
  const result = toolCall.result ?? "";
  const hasResult = Boolean(result);
  const { phase } = useCardPhase(toolCall.status, hasResult, 18, url.length);
  const { domain, path } = formatUrl(url);

  return (
    <CardShell title="📄 Reading article" accentColor={ACCENT} phase={phase} toggleable={false}>
      {/* URL chip */}
      <div
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md font-mono text-[12px] max-w-full break-all"
        style={{ border: `1px solid ${ACCENT}33`, background: `${ACCENT}08` }}
      >
        <span className="font-semibold" style={{ color: ACCENT }}>{domain}</span>
        {path && <span className="text-muted-foreground">{path}</span>}
      </div>

      {/* Loading */}
      {phase === "loading" && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoadingDots color={ACCENT} />
            <span>Extracting content…</span>
          </div>
          {/* Animated reading progress bar */}
          <div className="h-1 rounded-full overflow-hidden" style={{ background: "#e5e7eb" }}>
            <div
              className="h-full rounded-full"
              style={{
                background: ACCENT,
                animation: "readProgress 2.5s ease-out forwards",
              }}
            />
          </div>
          <ShimmerLine width="100%" />
          <ShimmerLine width="82%" />
          <ShimmerLine width="65%" />
        </div>
      )}

      {/* Result */}
      {phase === "result" && result && (
        <div className="mt-3" style={{ animation: "agentFadeIn 0.3s ease both" }}>
          <ResultBlock result={result} previewLength={320} label="Extracted Content" accentColor={ACCENT} />
        </div>
      )}
    </CardShell>
  );
});

ExtractCard.displayName = "ExtractCard";
