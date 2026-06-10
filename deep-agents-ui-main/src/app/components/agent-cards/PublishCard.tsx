"use client";

import React from "react";
import { CardShell, LoadingDots } from "./CardShell";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";
import { CheckCircle2, ExternalLink } from "lucide-react";

import { cardAccent } from "@/lib/theme";

function extractPostUrl(result: string): string | null {
  const m = result.match(/https?:\/\/[^\s"')>]+/);
  return m ? m[0] : null;
}

export const PublishCard = React.memo<{ toolCall: ToolCall }>(
  ({ toolCall }) => {
    const args = toolCall.args as Record<string, unknown>;
    const title = String(args.title ?? args.post_title ?? "Publishing…");
    const trimmedTitle =
      title.length > 60 ? title.slice(0, 60) + "…" : title;
    const result = toolCall.result ?? "";
    const hasResult = Boolean(result);
    const { phase } = useCardPhase(toolCall.status, hasResult, 18, 40);
    const postUrl = hasResult ? extractPostUrl(result) : null;

    return (
      <CardShell
        title="🚀 Publishing to WordPress"
        accentColor={cardAccent.publish}
        phase={phase}
        toggleable={false}
      >
        {/* Title chip — pure theme */}
        <div className="text-[12px] font-medium px-2.5 py-1.5 rounded-lg bg-muted border border-border text-foreground leading-snug">
          {trimmedTitle}
        </div>

        {/* Loading */}
        {phase === "loading" && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <LoadingDots />
              <span>Uploading to WordPress…</span>
            </div>
            <div className="flex items-end gap-1 h-7">
              {[1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className="flex-1 rounded-t bg-primary/60"
                  style={{
                    height: "100%",
                    transformOrigin: "bottom",
                    animation: `uploadBar 0.8s ${i * 100}ms ease-in-out infinite`,
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Result */}
        {phase === "result" && (
          <div
            className="mt-3 space-y-2"
            style={{ animation: "agentFadeIn 0.3s ease both" }}
          >
            <span className="text-[13px] font-bold flex items-center gap-1.5 text-primary">
              <CheckCircle2 size={14} /> Published
            </span>
            {postUrl ? (
              <a
                href={postUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg no-underline transition-all hover:bg-muted bg-muted/50 border border-border text-foreground hover:text-primary"
              >
                <ExternalLink size={11} />
                View post
              </a>
            ) : (
              result && (
                <pre className="font-mono text-[10.5px] p-2.5 rounded-lg border border-border bg-muted/50 text-foreground overflow-x-auto">
                  {result.slice(0, 200)}
                </pre>
              )
            )}
          </div>
        )}
      </CardShell>
    );
  }
);

PublishCard.displayName = "PublishCard";
