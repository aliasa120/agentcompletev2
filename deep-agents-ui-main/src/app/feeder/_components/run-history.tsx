"use client";

import React, { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { formatPKT } from "./feeder-ui";
import {
    History, ChevronDown, CheckCircle2, XCircle, Filter, Clock, Globe2,
} from "lucide-react";

// ── Types matching feeder_run_history rows ───────────────────────────────────
interface DropEntry { layer: string; title: string; domain: string; reason: string }
interface KeptEntry { title: string; domain: string }
interface Storyline { label: string; kept_id?: number; dropped_ids?: number[] }

interface RunRow {
    id: string;
    ran_at: string;
    finished_at: string | null;
    status: string;
    error: string | null;
    fetched: number;
    final_new: number;
    dropped_total: number;
    layer_stats: Record<string, number> | null;
    drop_log: DropEntry[] | null;
    kept_log: KeptEntry[] | null;
    storylines: Storyline[] | null;
}

// Layer name -> badge color
const LAYER_COLORS: Record<string, string> = {
    Time: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    Domain: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
    Cluster: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
    Cap: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
    "L1-GUID": "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
    "L2-Hash": "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
    Agent: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
    Verifier: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

const LAYER_ORDER = ["Time", "Domain", "Cluster", "Cap", "L1-GUID", "L2-Hash", "Agent", "Verifier"];

// The pipeline funnel steps: label -> layer_stats key
const FUNNEL: Array<[string, string]> = [
    ["Fetched", "fetched"],
    ["Time", "after_time"],
    ["Domain", "after_domain"],
    ["Cluster", "after_cluster"],
    ["GUID+Hash", "after_guid_hash"],
    ["Agent P1", "after_agent"],
    ["Verify P2", "after_verifier"],
    ["Stored", "stored"],
];

export function RunHistoryCard({ workflowId, refreshKey }: { workflowId: string; refreshKey: number }) {
    const [runs, setRuns] = useState<RunRow[]>([]);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        if (!workflowId) return;
        setLoading(true);
        try {
            const { data } = await supabase
                .from("feeder_run_history")
                .select("id,ran_at,finished_at,status,error,fetched,final_new,dropped_total,layer_stats,drop_log,kept_log,storylines")
                .eq("workflow_id", workflowId)
                .order("ran_at", { ascending: false })
                .limit(10);
            setRuns((data as RunRow[]) ?? []);
        } catch (e) {
            console.error("run history load error:", e);
        } finally {
            setLoading(false);
        }
    }, [workflowId]);

    useEffect(() => { load(); }, [load, refreshKey]);

    return (
        <div className="rounded-xl border bg-card shadow-sm">
            <div className="p-4 border-b flex items-center gap-2">
                <History className="h-4 w-4 text-primary" />
                <h2 className="font-semibold">Pipeline Run History</h2>
                <span className="ml-auto text-xs text-muted-foreground">
                    {loading ? "Loading…" : `${runs.length} latest run${runs.length === 1 ? "" : "s"}`}
                </span>
            </div>
            {runs.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground text-sm">
                    No runs logged yet. Run the feeder — every run now records which layer stopped which article, and why.
                </div>
            ) : (
                <div className="divide-y">
                    {runs.map(run => <RunDetails key={run.id} run={run} />)}
                </div>
            )}
        </div>
    );
}

function RunDetails({ run }: { run: RunRow }) {
    const drops = run.drop_log ?? [];
    const keeps = run.kept_log ?? [];
    const lines = run.storylines ?? [];

    // Group drops by layer, preserving pipeline order
    const byLayer = new Map<string, DropEntry[]>();
    for (const d of drops) {
        const arr = byLayer.get(d.layer) ?? [];
        arr.push(d);
        byLayer.set(d.layer, arr);
    }
    const layers = LAYER_ORDER.filter(l => byLayer.has(l))
        .concat([...byLayer.keys()].filter(k => !LAYER_ORDER.includes(k)));

    return (
        <details className="group">
            <summary className="cursor-pointer p-3 sm:p-4 hover:bg-muted/40 transition-colors list-none">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                    <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180 shrink-0" />
                    <span className="font-semibold text-foreground">{formatPKT(run.ran_at)}</span>
                    {run.status === "success" ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 font-semibold">
                            <CheckCircle2 className="h-3.5 w-3.5" /> success
                        </span>
                    ) : (
                        <span className="inline-flex items-center gap-1 text-destructive font-semibold">
                            <XCircle className="h-3.5 w-3.5" /> {run.status}
                        </span>
                    )}
                    <span className="text-muted-foreground">
                        <CheckCircle2 className="inline h-3 w-3 mr-1" />{run.final_new} stored
                    </span>
                    <span className="text-muted-foreground">
                        <Filter className="inline h-3 w-3 mr-1" />{run.dropped_total} dropped
                    </span>
                    {/* funnel */}
                    <span className="ml-auto hidden md:flex items-center gap-1 text-[11px] text-muted-foreground flex-wrap justify-end">
                        {FUNNEL.map(([label, key], i) => (
                            <span key={key} className="flex items-center gap-1">
                                {i > 0 && <span>→</span>}
                                <span className={key === "stored" ? "font-semibold text-foreground" : ""}>
                                    {label} {run.layer_stats?.[key] ?? "—"}
                                </span>
                            </span>
                        ))}
                    </span>
                </div>
                {run.error && (
                    <div className="mt-1.5 pl-7 text-xs text-destructive line-clamp-2">{run.error}</div>
                )}
            </summary>

            <div className="border-t px-3 sm:px-4 pb-4 pt-3 space-y-4">
                {/* Storylines discovered by the agent */}
                {lines.length > 0 && (
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1.5">
                            Agent storylines ({lines.length})
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                            {lines.slice(0, 20).map((s, i) => (
                                <span key={i} className="text-[11px] rounded-full border px-2 py-0.5 bg-muted/50">
                                    {s.label}
                                    {s.dropped_ids && s.dropped_ids.length > 0 && (
                                        <span className="text-muted-foreground"> (−{s.dropped_ids.length})</span>
                                    )}
                                </span>
                            ))}
                            {lines.length > 20 && (
                                <span className="text-[11px] text-muted-foreground py-0.5">+{lines.length - 20} more</span>
                            )}
                        </div>
                    </div>
                )}

                {/* Kept articles */}
                {keeps.length > 0 && (
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-widest text-emerald-600 mb-1.5">
                            Kept &amp; stored ({keeps.length})
                        </p>
                        <ul className="space-y-1 max-h-40 overflow-auto pr-1">
                            {keeps.map((k, i) => (
                                <li key={i} className="text-xs flex items-start gap-1.5">
                                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
                                    <span className="min-w-0">
                                        <span className="line-clamp-1">{k.title}</span>
                                        <span className="text-muted-foreground text-[11px]">{k.domain}</span>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {/* Drops grouped by layer */}
                {layers.map(layer => (
                    <div key={layer}>
                        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-2">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] ${LAYER_COLORS[layer] ?? "bg-muted"}`}>
                                {layer}
                            </span>
                            {byLayer.get(layer)!.length} stopped
                        </p>
                        <ul className="space-y-1.5 max-h-56 overflow-auto pr-1">
                            {byLayer.get(layer)!.map((d, i) => (
                                <li key={i} className="text-xs flex items-start gap-1.5">
                                    <XCircle className="h-3.5 w-3.5 text-rose-400 shrink-0 mt-0.5" />
                                    <span className="min-w-0">
                                        <span className="line-clamp-1">{d.title}</span>
                                        <span className="text-muted-foreground text-[11px] block">
                                            <Globe2 className="inline h-3 w-3 mr-0.5" />{d.domain} — {d.reason}
                                        </span>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}

                {drops.length === 0 && keeps.length === 0 && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5" /> No article-level decisions recorded for this run.
                    </p>
                )}
            </div>
        </details>
    );
}
