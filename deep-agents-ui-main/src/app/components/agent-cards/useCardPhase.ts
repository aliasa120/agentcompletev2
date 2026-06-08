"use client";

import { useState, useEffect, useRef } from "react";

/**
 * Card phase state machine.
 *
 * Phases:
 *   "querying"  → The card just appeared; we animate the input arg
 *   "loading"   → Input animation done, waiting for the tool result
 *   "result"    → Result has arrived; display trimmed result with expand option
 *
 * Transitions:
 *   mount          → "querying"
 *   typingDone     → "loading"       (signal via setTypingDone)
 *   result arrives → "result"
 */

export type CardPhase = "querying" | "loading" | "result";

export function useCardPhase(
  toolStatus: "pending" | "completed" | "error" | "interrupted",
  hasResult: boolean,
  typingSpeedMs: number = 18,
  textLength: number = 0
): {
  phase: CardPhase;
  signalTypingDone: () => void;
} {
  const [phase, setPhase] = useState<CardPhase>("querying");
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const signalledRef = useRef(false);

  // Auto-advance from querying → loading after estimated typing duration
  // This covers cases where the parent doesn't call signalTypingDone directly
  useEffect(() => {
    if (phase !== "querying") return;
    const estimatedDuration = Math.max(600, textLength * typingSpeedMs);
    typingTimerRef.current = setTimeout(() => {
      setPhase((prev) => (prev === "querying" ? "loading" : prev));
    }, estimatedDuration + 100); // small buffer after typing finishes

    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Jump to result phase whenever result arrives
  useEffect(() => {
    if ((toolStatus === "completed" || hasResult) && phase !== "result") {
      setPhase("result");
    }
  }, [toolStatus, hasResult, phase]);

  const signalTypingDone = () => {
    if (signalledRef.current) return;
    signalledRef.current = true;
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    setPhase((prev) => (prev === "querying" ? "loading" : prev));
  };

  return { phase, signalTypingDone };
}
