"use client";

import React, { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { tw, cssVar, cardBorderStyle } from "@/lib/theme";
import type { CardPhase } from "./useCardPhase";

interface CardShellProps {
  title: string;
  accentColor?: string; // optional — defaults to theme primary via cardBorderStyle()
  phase: CardPhase;
  isExpanded?: boolean;
  onToggle?: () => void;
  toggleable?: boolean;
  children: React.ReactNode;
  className?: string;
  isPulsing?: boolean;
}

// ── All badge styles come from the centralized theme ──────────────────────────
// To change badge colors: edit tw.badge in src/lib/theme.ts
const PHASE_BADGE: Record<CardPhase, { label: string; className: string }> = {
  querying: { label: "Querying…", className: tw.badge.querying },
  loading:  { label: "Waiting…",  className: tw.badge.loading  },
  result:   { label: "Done ✓",   className: tw.badge.done     },
};

export const CardShell = React.memo<CardShellProps>(
  ({
    title,
    accentColor,
    phase,
    isExpanded = true,
    onToggle,
    toggleable = true,
    children,
    className,
    isPulsing,
  }) => {
    const badge = PHASE_BADGE[phase];

    return (
      <div
        className={cn(
          "w-full rounded-xl overflow-hidden mb-2 border border-border bg-card",
          isPulsing && "ring-2 ring-primary/20",
          className
        )}
        style={cardBorderStyle(accentColor ?? cssVar.primary)}
      >
        {/* Header */}
        <div
          className={cn(
            "flex items-center justify-between px-3.5 py-2.5 border-b border-border bg-muted/40",
            toggleable && "cursor-pointer hover:bg-muted/60 transition-colors"
          )}
          onClick={toggleable ? onToggle : undefined}
        >
          <span className="text-[13px] font-semibold tracking-tight text-foreground font-sans">
            {title}
          </span>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full leading-none",
                badge.className
              )}
            >
              {badge.label}
            </span>
            {toggleable &&
              (isExpanded ? (
                <ChevronUp size={13} className="text-muted-foreground shrink-0" />
              ) : (
                <ChevronDown size={13} className="text-muted-foreground shrink-0" />
              ))}
          </div>
        </div>

        {/* Body */}
        {isExpanded && <div className="px-3.5 py-3">{children}</div>}
      </div>
    );
  }
);

CardShell.displayName = "CardShell";

/* ── Shared sub-components ────────────────────────────────────────────────── */

export function LoadingDots({ color }: { color?: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="animate-bounce rounded-full inline-block"
          style={{
            width: 4,
            height: 4,
            backgroundColor: color ?? cssVar.primary,
            animationDelay: `${delay}ms`,
          }}
        />
      ))}
    </span>
  );
}

export function ShimmerLine({
  width = "100%",
  height = 9,
}: {
  width?: string;
  height?: number;
}) {
  return (
    <div
      className="rounded-md bg-muted"
      style={{
        width,
        height,
        marginBottom: 5,
        backgroundImage:
          "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.3) 50%, transparent 100%)",
        backgroundSize: "200% 100%",
        animation: "shimmerSweep 1.4s ease-in-out infinite",
      }}
    />
  );
}

export function TypewriterText({
  text,
  isDone,
  accentColor,
  className,
}: {
  text: string;
  isDone: boolean;
  accentColor?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "font-mono text-[11.5px] text-foreground whitespace-pre-wrap break-all leading-relaxed",
        className
      )}
    >
      {text}
      {!isDone && (
        <span
          className="text-primary"
          style={{
            color: accentColor ?? cssVar.primary,
            animation: "cursorBlink 0.9s step-end infinite",
            marginLeft: 1,
          }}
          aria-hidden="true"
        >
          |
        </span>
      )}
    </span>
  );
}

export function QueryChip({
  children,
}: {
  children: React.ReactNode;
  accentColor?: string; // kept for API compat but ignored — uses theme
}) {
  return (
    <div className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg font-mono text-[11.5px] max-w-full break-all bg-muted border border-border text-foreground">
      {children}
    </div>
  );
}

export function ResultBlock({
  result,
  previewLength = 280,
  label = "Result",
}: {
  result: string;
  previewLength?: number;
  label?: string;
  accentColor?: string; // kept for API compat but ignored — uses theme
}) {
  const [expanded, setExpanded] = useState(false);
  const isLong = result.length > previewLength;
  const displayed =
    expanded || !isLong ? result : result.slice(0, previewLength) + "…";

  return (
    <div className="rounded-lg overflow-hidden border border-border">
      <div className="text-[9.5px] font-bold uppercase tracking-widest px-3 py-1.5 text-muted-foreground border-b border-border bg-muted/50">
        {label}
      </div>
      <pre className="m-0 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-words overflow-x-auto bg-card">
        {displayed}
      </pre>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((p) => !p)}
          className="w-full py-1.5 text-[10.5px] font-semibold border-t border-border transition-colors hover:bg-muted/60 text-primary bg-muted/30"
        >
          {expanded ? "▲ Show less" : "▼ Show full result"}
        </button>
      )}
    </div>
  );
}
