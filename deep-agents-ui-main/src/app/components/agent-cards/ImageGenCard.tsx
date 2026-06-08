"use client";

import React, { useState } from "react";
import { CardShell, LoadingDots } from "./CardShell";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";

const ACCENT = "#EC4899";

function extractImageUrl(result: string): string | null {
  const m = result.match(/https?:\/\/[^\s"')>]+\.(?:jpg|jpeg|png|gif|webp)[^\s"')>]*/i);
  return m ? m[0] : null;
}

export const ImageGenCard = React.memo<{ toolCall: ToolCall }>(({ toolCall }) => {
  const args = toolCall.args as Record<string, unknown>;
  const prompt = String(args.prompt ?? args.title ?? args.image_prompt ?? "Generating…");
  const trimmedPrompt = prompt.length > 70 ? prompt.slice(0, 70) + "…" : prompt;
  const result = toolCall.result ?? "";
  const hasResult = Boolean(result);
  const { phase } = useCardPhase(toolCall.status, hasResult, 18, 60);
  const previewUrl = hasResult ? extractImageUrl(result) : null;
  const [imgError, setImgError] = useState(false);

  return (
    <CardShell title="🎨 Creating image" accentColor={ACCENT} phase={phase} toggleable={false}>
      {/* Prompt */}
      <div className="text-[12px] italic px-2.5 py-1.5 rounded-md"
        style={{ border: `1px solid ${ACCENT}33`, background: `${ACCENT}08`, color: `${ACCENT}CC` }}>
        {trimmedPrompt}
      </div>

      {/* Loading spinner */}
      {phase === "loading" && (
        <div className="flex flex-col items-center gap-3 mt-4 py-1">
          <div className="rounded-full" style={{
            width: 38, height: 38,
            border: `3px solid transparent`,
            borderTopColor: ACCENT,
            borderRightColor: `${ACCENT}88`,
            animation: "spinnerRotate 0.75s linear infinite",
          }} />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoadingDots color={ACCENT} />
            <span>Generating image…</span>
          </div>
        </div>
      )}

      {/* Result */}
      {phase === "result" && (
        <div className="mt-3 space-y-1.5" style={{ animation: "agentFadeIn 0.3s ease both" }}>
          {previewUrl && !imgError ? (
            <img
              src={previewUrl}
              alt="Generated"
              className="w-full rounded-lg border border-border object-cover"
              style={{ maxHeight: 160 }}
              onError={() => setImgError(true)}
            />
          ) : (
            <pre className="font-mono text-[11px] p-2 rounded border border-border overflow-x-auto"
              style={{ background: "rgba(0,0,0,0.02)" }}>
              {result.slice(0, 200)}
            </pre>
          )}
          <p className="text-[11px] font-semibold" style={{ color: "#10B981" }}>Image created ✓</p>
        </div>
      )}
    </CardShell>
  );
});

ImageGenCard.displayName = "ImageGenCard";
