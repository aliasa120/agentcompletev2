"use client";

import React, { useState } from "react";
import { CardShell, LoadingDots, ShimmerLine, ResultBlock } from "./CardShell";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";

import { cardAccent } from "@/lib/theme";

export const GeminiVisionCard = React.memo<{ toolCall: ToolCall }>(
  ({ toolCall }) => {
    const args = toolCall.args as Record<string, unknown>;
    const imageUrl = String(args.image_url ?? args.url ?? "");
    const result = toolCall.result ?? "";
    const hasResult = Boolean(result);
    const { phase } = useCardPhase(toolCall.status, hasResult, 18, 30);
    const [imgError, setImgError] = useState(false);

    return (
      <CardShell
        title="🤖 Gemini Vision"
        accentColor={cardAccent.geminiVision}
        phase={phase}
        toggleable={false}
      >
        {imageUrl && !imgError && (
          <img
            src={imageUrl}
            alt="Analyzing"
            className="w-full rounded-lg border border-border object-cover mb-3"
            style={{ maxHeight: 140 }}
            onError={() => setImgError(true)}
          />
        )}
        {imageUrl && imgError && (
          <div className="font-mono text-[10.5px] px-2.5 py-1.5 rounded-lg mb-3 truncate bg-muted border border-border text-muted-foreground">
            {imageUrl.slice(0, 55)}…
          </div>
        )}

        {phase === "loading" && (
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <LoadingDots />
              <span>Analyzing image…</span>
            </div>
            <div className="flex items-end gap-0.5 h-7">
              {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                <div
                  key={i}
                  className="flex-1 rounded-sm bg-muted"
                  style={{
                    height: "100%",
                    transformOrigin: "bottom",
                    animation: `scanBar 0.9s ${i * 100}ms ease-in-out infinite`,
                  }}
                />
              ))}
            </div>
            <ShimmerLine width="80%" />
          </div>
        )}

        {phase === "result" && result && (
          <div style={{ animation: "agentFadeIn 0.3s ease both" }}>
            <ResultBlock
              result={result}
              previewLength={220}
              label="Analysis"
              
            />
          </div>
        )}
      </CardShell>
    );
  }
);

GeminiVisionCard.displayName = "GeminiVisionCard";
