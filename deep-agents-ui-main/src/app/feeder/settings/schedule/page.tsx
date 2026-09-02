"use client";

import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { AlarmClock, Clock, Loader2, PauseCircle, PlayCircle, Info } from "lucide-react";
import { SectionCard, PresetButton, FeederWorkflow, minutesLabel, formatPKT } from "../../_components/feeder-ui";

const INTERVAL_PRESETS = ["10", "15", "30", "60", "120", "240", "360"];
const INTERVAL_LABELS: Record<string, string> = {
    "10": "10 min", "15": "15 min", "30": "30 min", "60": "1 hour",
    "120": "2 hours", "240": "4 hours", "360": "6 hours",
};

function nextRunLabel(wf: FeederWorkflow): string {
    if (!wf.feeder_enabled) return "—";
    const interval = (wf.feeder_interval_minutes || 30) * 60_000;
    const last = wf.feeder_last_trigger_at ? new Date(wf.feeder_last_trigger_at).getTime() : 0;
    const next = last ? last + interval : Date.now();
    const rem = next - Date.now();
    if (rem <= 0) return "due now";
    const m = Math.floor(rem / 60_000);
    if (m < 60) return `in ~${m} min`;
    const h = (m / 60).toFixed(1);
    return `in ~${h} h`;
}

export default function FeederSchedulePage() {
    const [workflows, setWorkflows] = useState<FeederWorkflow[]>([]);
    const [loading, setLoading] = useState(true);
    const [savingId, setSavingId] = useState<string | null>(null);
    const [savedId, setSavedId] = useState<string | null>(null);
    const [customInterval, setCustomInterval] = useState<Record<string, string>>({});

    const load = useCallback(async () => {
        setLoading(true);
        const { data } = await supabase
            .from("workflows")
            .select("id, name, is_active, feeder_enabled, feeder_interval_minutes, feeder_last_trigger_at, feeder_max_age_minutes, feeder_max_articles_per_run, feeder_cluster_threshold")
            .order("name");
        setWorkflows(data ?? []);
        setLoading(false);
    }, []);

    useEffect(() => {
        load();
        // refresh "next run" estimates while the page is open
        const id = setInterval(load, 60_000);
        return () => clearInterval(id);
    }, [load]);

    const saveWorkflow = async (wf: FeederWorkflow, updates: Partial<FeederWorkflow>) => {
        setSavingId(wf.id);
        const body = { ...updates, updated_at: new Date().toISOString() };
        const { error } = await supabase.from("workflows").update(body).eq("id", wf.id);
        if (!error) {
            setWorkflows(prev => prev.map(w => w.id === wf.id ? { ...w, ...updates } : w));
            setSavedId(wf.id);
            setTimeout(() => setSavedId(null), 2500);
        }
        setSavingId(null);
    };

    const toggleEnabled = (wf: FeederWorkflow) =>
        saveWorkflow(wf, { feeder_enabled: !wf.feeder_enabled });

    const setIntervalPreset = (wf: FeederWorkflow, minutes: number) =>
        saveWorkflow(wf, { feeder_interval_minutes: minutes });

    const applyCustomInterval = (wf: FeederWorkflow) => {
        const v = parseInt(customInterval[wf.id] ?? "", 10);
        if (isNaN(v) || v < 1 || v > 10080) { alert("Interval must be 1–10080 minutes (1 week)."); return; }
        saveWorkflow(wf, { feeder_interval_minutes: v });
    };

    return (
        <div className="space-y-6 max-w-4xl mx-auto">
            <div className="rounded-xl border bg-primary/5 p-4 flex items-start gap-3">
                <Info className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                <p className="text-xs text-muted-foreground leading-relaxed">
                    The background scheduler checks <strong className="text-foreground">every minute</strong> and runs the feeder
                    for each workflow whose interval has elapsed. Each workflow runs on its own schedule — changes save automatically.
                </p>
            </div>

            <SectionCard title="Workflow Schedules" icon={AlarmClock} badge={loading ? "Loading…" : `${workflows.length} workflows`}>
                {loading ? (
                    <div className="p-8 flex items-center justify-center text-muted-foreground text-sm gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading schedules…
                    </div>
                ) : workflows.length === 0 ? (
                    <p className="p-6 text-sm text-muted-foreground">No workflows yet. Create one in Agent Settings → Workflows.</p>
                ) : (
                    <div className="divide-y divide-border/50">
                        {workflows.map(wf => {
                            const intervalStr = String(wf.feeder_interval_minutes ?? 30);
                            const isCustom = !INTERVAL_PRESETS.includes(intervalStr);
                            return (
                                <div key={wf.id} className="p-4 sm:p-5 space-y-4">
                                    {/* Row 1: name + toggle */}
                                    <div className="flex flex-wrap items-center gap-3">
                                        <div className="min-w-0 flex-1">
                                            <p className="font-semibold text-sm flex items-center gap-2 flex-wrap">
                                                {wf.name}
                                                {savingId === wf.id && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                                                {savedId === wf.id && <span className="text-[10px] font-bold text-emerald-500 uppercase">Saved</span>}
                                            </p>
                                            <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                                                <Clock className="h-3 w-3" />
                                                Last run: {formatPKT(wf.feeder_last_trigger_at)}
                                                · Next: {nextRunLabel(wf)}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            {wf.feeder_enabled
                                                ? <span className="flex items-center gap-1 text-[10px] font-bold uppercase text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-2 py-0.5"><PlayCircle className="h-3 w-3" />On</span>
                                                : <span className="flex items-center gap-1 text-[10px] font-bold uppercase text-muted-foreground bg-muted border border-border/50 rounded-full px-2 py-0.5"><PauseCircle className="h-3 w-3" />Off</span>}
                                            <Switch checked={wf.feeder_enabled} onCheckedChange={() => toggleEnabled(wf)} />
                                        </div>
                                    </div>

                                    {/* Row 2: interval (only when enabled) */}
                                    {wf.feeder_enabled && (
                                        <div className="pl-0 sm:pl-2 space-y-2">
                                            <p className="text-xs font-semibold text-muted-foreground">
                                                Run every <span className="text-primary">{minutesLabel(wf.feeder_interval_minutes)}</span>
                                            </p>
                                            <div className="flex gap-2 flex-wrap">
                                                {INTERVAL_PRESETS.map(p => (
                                                    <PresetButton key={p} value={p} current={intervalStr} onClick={() => setIntervalPreset(wf, parseInt(p, 10))}>
                                                        {INTERVAL_LABELS[p]}
                                                    </PresetButton>
                                                ))}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Input
                                                    type="number" min={1} max={10080}
                                                    className="h-8 w-24 text-sm"
                                                    placeholder={isCustom ? intervalStr : "Custom"}
                                                    value={customInterval[wf.id] ?? (isCustom ? intervalStr : "")}
                                                    onChange={e => setCustomInterval(prev => ({ ...prev, [wf.id]: e.target.value }))}
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => applyCustomInterval(wf)}
                                                    className="text-xs font-semibold text-primary hover:underline"
                                                >
                                                    Apply custom (min)
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </SectionCard>
        </div>
    );
}
