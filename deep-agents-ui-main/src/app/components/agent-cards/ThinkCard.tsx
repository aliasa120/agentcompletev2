"use client";

import React, { useEffect } from "react";
import { CardShell, TypewriterText } from "./CardShell";
import { useTypingAnimation } from "./useTypingAnimation";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";

const ACCENT = "#8B5CF6";

export const ThinkCard = React.memo<{ toolCall: ToolCall }>(({ toolCall }) => {
  const reflection = String((toolCall.args as Record<string, unknown>).reflection ?? "");
  const hasResult = Boolean(toolCall.result);

  const isCompleted = toolCall.status !== "pending";
  const { phase, signalTypingDone } = useCardPhase(toolCall.status, hasResult, 12, reflection.length);
  const { displayText, isDone } = useTypingAnimation(reflection, 12, true, isCompleted);

  useEffect(() => { if (isDone) signalTypingDone(); }, [isDone, signalTypingDone]);

  return (
    <CardShell
      title="🧠 Thinking…"
      accentColor={ACCENT}
      phase={phase}
      toggleable={false}
      isPulsing={!isDone}
    >
      {/* Streaming thought text */}
      <div
        className="p-2.5 rounded-r-lg max-h-56 overflow-y-auto"
        style={{
          borderLeft: `3px solid ${ACCENT}`,
          background: `${ACCENT}08`,
          borderRadius: "0 6px 6px 0",
        }}
      >
        <TypewriterText
          text={displayText}
          isDone={isDone}
          accentColor={ACCENT}
          className="font-sans text-[12.5px] leading-relaxed whitespace-pre-wrap break-words"
        />
      </div>

      {isDone && (
        <div
          className="mt-2 text-[11px] font-medium flex items-center gap-1"
          style={{ color: ACCENT, animation: "agentFadeIn 0.3s ease both" }}
        >
          ✓ Thought recorded
        </div>
      )}
    </CardShell>
  );
});

ThinkCard.displayName = "ThinkCard";
