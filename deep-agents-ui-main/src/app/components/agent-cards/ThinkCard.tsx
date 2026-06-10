"use client";

import React, { useEffect } from "react";
import { CardShell, TypewriterText } from "./CardShell";
import { useTypingAnimation } from "./useTypingAnimation";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";
import { CheckCircle2 } from "lucide-react";

import { cardAccent } from "@/lib/theme";

export const ThinkCard = React.memo<{ toolCall: ToolCall }>(({ toolCall }) => {
  const reflection = String(
    (toolCall.args as Record<string, unknown>).reflection ?? ""
  );
  const hasResult = Boolean(toolCall.result);

  const isCompleted = toolCall.status !== "pending";
  const { phase, signalTypingDone } = useCardPhase(
    toolCall.status,
    hasResult,
    12,
    reflection.length
  );
  const { displayText, isDone } = useTypingAnimation(
    reflection,
    12,
    true,
    isCompleted
  );

  useEffect(() => {
    if (isDone) signalTypingDone();
  }, [isDone, signalTypingDone]);

  return (
    <CardShell
      title="🧠 Thinking…"
      accentColor={cardAccent.think}
      phase={phase}
      toggleable={false}
      isPulsing={!isDone}
    >
      {/* Thought block — left border accent only, bg uses theme token */}
      <div
        className="px-3 py-2.5 rounded-r-lg max-h-56 overflow-y-auto bg-muted/40 border-l-2 border-muted-foreground/30"
      >
        <TypewriterText
          text={displayText}
          isDone={isDone}
          accentColor={cardAccent.think}
          className="font-sans text-[12px] leading-relaxed whitespace-pre-wrap break-words text-foreground"
        />
      </div>

      {isDone && (
        <div
          className="mt-2 text-[11px] font-semibold text-primary flex items-center gap-1.5"
          style={{ animation: "agentFadeIn 0.3s ease both" }}
        >
          <CheckCircle2 size={12} /> Thought recorded
        </div>
      )}
    </CardShell>
  );
});

ThinkCard.displayName = "ThinkCard";
