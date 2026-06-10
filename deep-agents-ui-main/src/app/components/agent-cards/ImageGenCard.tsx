"use client";

import React, { useState } from "react";
import { CardShell, LoadingDots } from "./CardShell";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";
import { CheckCircle2, Sparkles } from "lucide-react";

import { cardAccent, spinnerStyle } from "@/lib/theme";

function extractImageUrl(result: string): string | null {
  const m = result.match(
    /https?:\/\/[^\s"')>]+\.(?:jpg|jpeg|png|gif|webp)[^\s"')>]*/i
  );
  return m ? m[0] : null;
}

export const ImageGenCard = React.memo<{ toolCall: ToolCall }>(
  ({ toolCall }) => {
    const args = toolCall.args as Record<string, unknown>;
    const prompt = String(
      args.prompt ?? args.title ?? args.image_prompt ?? "Generating…"
    );
    const trimmedPrompt =
      prompt.length > 70 ? prompt.slice(0, 70) + "…" : prompt;
    const result = toolCall.result ?? "";
    const hasResult = Boolean(result);
    const { phase } = useCardPhase(toolCall.status, hasResult, 18, 60);
    const previewUrl = hasResult ? extractImageUrl(result) : null;
    const [imgError, setImgError] = useState(false);

    return (
      <CardShell
        title="🎨 Creating image"
        accentColor={cardAccent.imageGen}
        phase={phase}
        toggleable={false}
      >
        {/* Prompt chip — pure theme classes */}
        <div className="flex items-start gap-1.5 text-[11.5px] italic px-2.5 py-1.5 rounded-lg bg-muted border border-border text-foreground">
          <Sparkles size={11} className="text-primary mt-0.5 shrink-0" />
          <span className="text-muted-foreground">{trimmedPrompt}</span>
        </div>

        {/* Spinner */}
        {phase === "loading" && (
          <div className="flex flex-col items-center gap-3 mt-4 py-2">
            <div
              className="rounded-full border-2 border-muted"
              style={spinnerStyle(36)}
            />
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <LoadingDots />
              <span>Generating image…</span>
            </div>
          </div>
        )}

        {/* Result */}
        {phase === "result" && (
          <div
            className="mt-3 space-y-2"
            style={{ animation: "agentFadeIn 0.3s ease both" }}
          >
            {previewUrl && !imgError ? (
              <img
                src={previewUrl}
                alt="Generated"
                className="w-full rounded-xl border border-border object-cover"
                style={{ maxHeight: 160 }}
                onError={() => setImgError(true)}
              />
            ) : (
              <pre className="font-mono text-[10.5px] p-2.5 rounded-lg border border-border overflow-x-auto bg-muted/50 text-foreground">
                {result.slice(0, 200)}
              </pre>
            )}
            <p className="text-[11px] font-semibold text-primary flex items-center gap-1.5">
              <CheckCircle2 size={12} /> Image created
            </p>
          </div>
        )}
      </CardShell>
    );
  }
);

ImageGenCard.displayName = "ImageGenCard";
