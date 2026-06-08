"use client";

import { useState, useEffect, useRef } from "react";

/**
 * Typewriter animation hook.
 * Returns `displayText` that grows one character at a time until it matches `fullText`.
 *
 * Supports streaming content (growing fullText) without resetting the typing position.
 * Dynamically speeds up typing if it falls far behind the stream or when the tool completes.
 *
 * @param fullText    - The complete string to animate
 * @param speed       - Milliseconds between each character (default: 12ms)
 * @param active      - Only animates when true
 * @param isCompleted - When true, forces typing to finish almost instantly
 */
export function useTypingAnimation(
  fullText: string,
  speed: number = 12,
  active: boolean = true,
  isCompleted: boolean = false
): { displayText: string; isDone: boolean } {
  const [displayText, setDisplayText] = useState("");
  const indexRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!active || !fullText) {
      setDisplayText("");
      indexRef.current = 0;
      return;
    }

    // Check if the new fullText starts with the text we've already typed.
    // If it does (common in streaming), we don't reset indexRef.current or displayText.
    // If it doesn't (text has been reset or replaced), we reset to 0.
    const currentTyped = indexRef.current > 0 ? fullText.slice(0, indexRef.current) : "";
    if (!fullText.startsWith(currentTyped)) {
      setDisplayText("");
      indexRef.current = 0;
    }

    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    intervalRef.current = setInterval(() => {
      const currentLength = indexRef.current;
      const targetLength = fullText.length;

      if (currentLength < targetLength) {
        const remaining = targetLength - currentLength;
        let charsToType = 1;

        if (isCompleted) {
          // If the tool has finished running, catch up immediately (large chunks)
          charsToType = Math.max(8, Math.ceil(remaining / 4));
        } else if (remaining > 100) {
          // Extremely far behind stream
          charsToType = 12;
        } else if (remaining > 50) {
          charsToType = 6;
        } else if (remaining > 20) {
          charsToType = 3;
        } else if (remaining > 8) {
          charsToType = 2;
        }

        const nextIndex = Math.min(currentLength + charsToType, targetLength);
        indexRef.current = nextIndex;
        setDisplayText(fullText.slice(0, nextIndex));
      } else {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      }
    }, speed);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fullText, speed, active, isCompleted]);

  return {
    displayText,
    isDone: displayText.length >= fullText.length && fullText.length > 0,
  };
}
