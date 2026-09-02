"use client";

import React from "react";

// ── Shared types ─────────────────────────────────────────────────────────────
export interface FeederWorkflow {
    id: string;
    name: string;
    is_active: boolean;
    feeder_enabled: boolean;
    feeder_interval_minutes: number;
    feeder_last_trigger_at: string | null;
    feeder_max_age_minutes: number | null;
    feeder_max_articles_per_run: number | null;
    feeder_cluster_threshold: number | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
export function formatPKT(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString("en-PK", {
        timeZone: "Asia/Karachi",
        month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
        hour12: false,
    });
}

export function minutesLabel(mins: number | null | undefined): string {
    const m = mins ?? 0;
    if (m < 60) return `${m} min`;
    const h = m / 60;
    return `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? "" : "s"}`;
}

// ── Small building blocks ────────────────────────────────────────────────────
export function StatCard({ label, value, icon: Icon, color = "text-primary", sub }: {
    label: string; value: number | string; icon: React.ElementType; color?: string; sub?: string;
}) {
    return (
        <div className="rounded-xl border bg-card shadow-sm p-3 sm:p-4 flex items-center gap-3 sm:gap-4">
            <div className={`rounded-lg p-2 sm:p-2.5 bg-muted ${color}`}><Icon className="h-4 w-4 sm:h-5 sm:w-5" /></div>
            <div className="min-w-0">
                <p className="text-xs text-muted-foreground truncate">{label}</p>
                <p className="text-xl sm:text-2xl font-bold">{value}</p>
                {sub && <p className="text-xs text-muted-foreground mt-0.5 truncate">{sub}</p>}
            </div>
        </div>
    );
}

export function PresetButton({ value, current, onClick, children }: {
    value: string; current: string; onClick: () => void; children: React.ReactNode
}) {
    const active = current === value;
    return (
        <button
            type="button"
            onClick={onClick}
            className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all
                ${active
                    ? "border-primary bg-primary text-primary-foreground shadow-sm"
                    : "border-border bg-muted hover:bg-accent"}`}
        >{children}</button>
    );
}

export function SectionCard({ title, icon: Icon, badge, children }: {
    title: string; icon: React.ElementType; badge?: React.ReactNode; children: React.ReactNode;
}) {
    return (
        <section className="rounded-xl border bg-card shadow-sm">
            <div className="p-4 border-b flex items-center gap-2">
                <Icon className="h-4 w-4 text-primary" />
                <h2 className="font-semibold">{title}</h2>
                {badge && <span className="ml-auto text-xs text-muted-foreground">{badge}</span>}
            </div>
            {children}
        </section>
    );
}

export function SaveStatus({ status, dirty }: { status: "idle" | "saving" | "saved" | "error"; dirty: boolean }) {
    if (status === "saved") {
        return <span className="text-xs font-semibold text-emerald-500">Saved</span>;
    }
    if (status === "error") {
        return <span className="text-xs font-semibold text-destructive">Save failed</span>;
    }
    if (dirty) {
        return <span className="text-xs text-orange-500 font-medium">Unsaved changes</span>;
    }
    return null;
}
