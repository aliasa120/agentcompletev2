"use client";

import React, { useEffect, useState } from "react";
import { CardShell, LoadingDots, QueryChip, TypewriterText } from "./CardShell";
import { useTypingAnimation } from "./useTypingAnimation";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";
import { Image as ImageIcon } from "lucide-react";

import { cardAccent } from "@/lib/theme";

function extractImageUrls(result: string): string[] {
  const urlRegex =
    /https?:\/\/[^\s"')>]+\.(?:jpg|jpeg|png|gif|webp)[^\s"')>]*/gi;
  const matches = result.match(urlRegex) ?? [];
  return [...new Set(matches)].slice(0, 4);
}

export const ImageSearchCard = React.memo<{
  toolCall: ToolCall;
  variant?: "fetch" | "score";
}>(({ toolCall, variant = "fetch" }) => {
  const isFetch = variant === "fetch";
  const args = toolCall.args as Record<string, unknown>;
  const query = String(args.query ?? args.image_urls ?? "Searching…");
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

  const imageUrls = hasResult ? extractImageUrls(result) : [];
  const [imgErrors, setImgErrors] = useState<Record<number, boolean>>({});

  return (
    <CardShell
      title={isFetch ? "🖼️ Finding images" : "👁️ Scoring images"}
      accentColor={cardAccent.imageSearch}
      phase={phase}
      toggleable={false}
    >
      <QueryChip>
        <ImageIcon size={11} className="text-primary shrink-0" />
        <TypewriterText
          text={phase === "querying" ? displayText : query}
          isDone={phase !== "querying" || isDone}
          accentColor={cardAccent.imageSearch}
        />
      </QueryChip>

      {phase === "loading" && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <LoadingDots color={cardAccent.imageSearch} />
            <span>{isFetch ? "Searching images…" : "Scoring candidates…"}</span>
          </div>
          {/* Shimmer grid — pure Tailwind */}
          <div className="grid grid-cols-4 gap-1.5 mt-1">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="rounded-lg bg-muted"
                style={{
                  height: 58,
                  backgroundImage:
                    "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.3) 50%, transparent 100%)",
                  backgroundSize: "200% 100%",
                  animation: `shimmerSweep 1.4s ${i * 0.15}s ease-in-out infinite`,
                }}
              />
            ))}
          </div>
        </div>
      )}

      {phase === "result" && (
        <div
          className="mt-3"
          style={{ animation: "agentFadeIn 0.3s ease both" }}
        >
          {imageUrls.length > 0 ? (
            <div className="grid grid-cols-4 gap-1.5">
              {imageUrls.map((url, i) =>
                imgErrors[i] ? null : (
                  <img
                    key={url}
                    src={url}
                    alt={`Image ${i + 1}`}
                    className="w-full rounded-lg border border-border object-cover"
                    style={{ height: 58 }}
                    onError={() =>
                      setImgErrors((p) => ({ ...p, [i]: true }))
                    }
                  />
                )
              )}
            </div>
          ) : (
            <p className="text-[11px] font-semibold text-primary">
              {isFetch ? "Images fetched ✓" : "Images scored ✓"}
            </p>
          )}
        </div>
      )}
    </CardShell>
  );
});

ImageSearchCard.displayName = "ImageSearchCard";
