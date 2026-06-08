"use client";

import React from "react";
import { CardShell, LoadingDots } from "./CardShell";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";

const ACCENT = "#10B981";

function extractPostUrl(result: string): string | null {
  const m = result.match(/https?:\/\/[^\s"')>]+/);
  return m ? m[0] : null;
}

export const PublishCard = React.memo<{ toolCall: ToolCall }>(({ toolCall }) => {
  const args = toolCall.args as Record<string, unknown>;
  const title = String(args.title ?? args.post_title ?? "Publishing…");
  const trimmedTitle = title.length > 60 ? title.slice(0, 60) + "…" : title;
  const result = toolCall.result ?? "";
  const hasResult = Boolean(result);
  const { phase } = useCardPhase(toolCall.status, hasResult, 18, 40);
  const postUrl = hasResult ? extractPostUrl(result) : null;

  return (
    <CardShell title="🚀 Publishing to WordPress" accentColor={ACCENT} phase={phase} toggleable={false}>
      <div className="text-[12px] font-medium px-2.5 py-1.5 rounded-md"
        style={{ border: `1px solid ${ACCENT}33`, background: `${ACCENT}08`, color: `${ACCENT}CC` }}>
        {trimmedTitle}
      </div>

      {phase === "loading" && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoadingDots color={ACCENT} />
            <span>Uploading to WordPress…</span>
          </div>
          {/* Upload bars */}
          <div className="flex items-end gap-1 h-8">
            {[1,2,3,4,5].map((i) => (
              <div key={i} className="flex-1 rounded-t" style={{
                height: "100%",
                background: ACCENT,
                transformOrigin: "bottom",
                animation: `uploadBar 0.8s ${i * 100}ms ease-in-out infinite`,
              }} />
            ))}
          </div>
        </div>
      )}

      {phase === "result" && (
        <div className="mt-3 space-y-2" style={{ animation: "agentFadeIn 0.3s ease both" }}>
          <span className="text-[13px] font-bold" style={{ color: ACCENT }}>Published ✓</span>
          {postUrl && (
            <a
              href={postUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-[11.5px] font-semibold px-3 py-1.5 rounded-lg no-underline w-fit transition-opacity hover:opacity-80"
              style={{ border: `1px solid ${ACCENT}44`, background: `${ACCENT}10`, color: ACCENT }}
            >
              View post →
            </a>
          )}
          {!postUrl && result && (
            <pre className="font-mono text-[11px] p-2 rounded border border-border"
              style={{ background: "rgba(0,0,0,0.02)" }}>
              {result.slice(0, 200)}
            </pre>
          )}
        </div>
      )}
    </CardShell>
  );
});

PublishCard.displayName = "PublishCard";
