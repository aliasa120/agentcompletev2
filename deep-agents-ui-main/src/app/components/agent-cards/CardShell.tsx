"use client";

import React, { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CardPhase } from "./useCardPhase";

interface CardShellProps {
  title: string;
  accentColor: string;
  phase: CardPhase;
  isExpanded?: boolean;
  onToggle?: () => void;
  toggleable?: boolean;
  children: React.ReactNode;
  className?: string;
  isPulsing?: boolean;
}

const PHASE_BADGE: Record<CardPhase, { label: string; bg: string; color: string; border: string }> = {
  querying: { label: "Querying…", bg: "rgba(47,104,104,0.10)", color: "#2F6868", border: "rgba(47,104,104,0.35)" },
  loading:  { label: "Waiting…",  bg: "rgba(245,158,11,0.10)",  color: "#D97706", border: "rgba(245,158,11,0.40)" },
  result:   { label: "Done ✓",    bg: "rgba(16,185,129,0.10)",  color: "#059669", border: "rgba(16,185,129,0.40)" },
};

export const CardShell = React.memo<CardShellProps>(
  ({ title, accentColor, phase, isExpanded = true, onToggle, toggleable = true, children, className, isPulsing }) => {
    const badge = PHASE_BADGE[phase];

    return (
      <div
        className={cn("w-full rounded-xl overflow-hidden mb-2", className)}
        style={{
          border: `1.5px solid ${accentColor}44`,
          background: `${accentColor}08`,
          animation: "cardSlideIn 0.28s cubic-bezier(0.16,1,0.3,1) both",
          boxShadow: isPulsing ? `0 0 0 3px ${accentColor}22` : undefined,
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-3 py-2.5 cursor-default"
          style={{
            borderBottom: `1px solid ${accentColor}22`,
            background: `${accentColor}10`,
            cursor: toggleable ? "pointer" : "default",
          }}
          onClick={toggleable ? onToggle : undefined}
        >
          <span className="text-[13px] font-semibold tracking-tight text-foreground">{title}</span>
          <div className="flex items-center gap-2">
            <span
              className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
              style={{ background: badge.bg, color: badge.color, border: `1px solid ${badge.border}` }}
            >
              {badge.label}
            </span>
            {toggleable && (
              isExpanded
                ? <ChevronUp size={13} className="text-muted-foreground shrink-0" />
                : <ChevronDown size={13} className="text-muted-foreground shrink-0" />
            )}
          </div>
        </div>

        {/* Body */}
        {isExpanded && (
          <div className="px-3 py-3">{children}</div>
        )}
      </div>
    );
  }
);

CardShell.displayName = "CardShell";

/* ── Shared sub-components ────────────────────────────────────────────────── */

export function LoadingDots({ color = "#2F6868" }: { color?: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="animate-bounce rounded-full inline-block"
          style={{ width: 5, height: 5, backgroundColor: color, animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

export function ShimmerLine({ width = "100%", height = 10 }: { width?: string; height?: number }) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 4,
        marginBottom: 5,
        background: "linear-gradient(90deg, #e5e7eb 0%, #f3f4f6 50%, #e5e7eb 100%)",
        backgroundSize: "200% 100%",
        animation: "shimmerSweep 1.4s ease-in-out infinite",
      }}
    />
  );
}

export function TypewriterText({ text, isDone, accentColor = "#2F6868", className }: {
  text: string;
  isDone: boolean;
  accentColor?: string;
  className?: string;
}) {
  return (
    <span
      className={cn("font-mono text-[12px] text-foreground whitespace-pre-wrap break-all leading-relaxed", className)}
    >
      {text}
      {!isDone && (
        <span
          style={{ color: accentColor, animation: "cursorBlink 0.9s step-end infinite", marginLeft: 1 }}
          aria-hidden="true"
        >
          |
        </span>
      )}
    </span>
  );
}

export function QueryChip({ children, accentColor = "#2F6868" }: { children: React.ReactNode; accentColor?: string }) {
  return (
    <div
      className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md font-mono text-[12px] max-w-full break-all"
      style={{
        border: `1px solid ${accentColor}33`,
        background: `${accentColor}08`,
        color: "inherit",
      }}
    >
      {children}
    </div>
  );
}

export function ResultBlock({
  result,
  previewLength = 280,
  label = "Result",
  accentColor = "#2F6868",
}: {
  result: string;
  previewLength?: number;
  label?: string;
  accentColor?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLong = result.length > previewLength;
  const displayed = expanded || !isLong ? result : result.slice(0, previewLength) + "…";

  return (
    <div className="rounded-lg overflow-hidden border border-border">
      <div
        className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1.5 text-muted-foreground border-b border-border"
        style={{ background: "rgba(0,0,0,0.03)" }}
      >
        {label}
      </div>
      <pre className="m-0 p-2.5 font-mono text-[11.5px] leading-relaxed text-foreground whitespace-pre-wrap break-words overflow-x-auto"
        style={{ background: "rgba(0,0,0,0.02)" }}>
        {displayed}
      </pre>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((p) => !p)}
          className="w-full py-1.5 text-[11px] font-semibold border-t border-border transition-colors hover:bg-muted/40"
          style={{ color: accentColor, background: `${accentColor}06` }}
        >
          {expanded ? "▲ Show less" : "▼ Show full result"}
        </button>
      )}
    </div>
  );
}
