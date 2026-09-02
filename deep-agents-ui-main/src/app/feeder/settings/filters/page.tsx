"use client";

import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
    Filter, Globe, ShieldCheck, X, PlusCircle, Layers, ChevronRight,
    Loader2, Save
} from "lucide-react";
import { SectionCard, PresetButton, SaveStatus, FeederWorkflow } from "../../_components/feeder-ui";

interface WhitelistDomain { id: string; domain: string; note: string; workflow_id?: string | null; }

const MAX_AGE_PRESETS = ["15", "30", "60", "120", "360", "1440"];
const MAX_AGE_LABELS: Record<string, string> = {
    "15": "15 min", "30": "30 min", "60": "1 hour", "120": "2 hours", "360": "6 hours", "1440": "24 hours",
};
const ARTICLE_PRESETS = ["25", "50", "100", "250"];
const CLUSTER_PRESETS = ["50", "60", "70", "80", "90"];
const AI_LIMIT_PRESETS = ["100", "300", "500", "1000"];

export default function FeederFiltersPage() {
    const [workflows, setWorkflows] = useState<FeederWorkflow[]>([]);
    const [selectedWorkflowId, setSelectedWorkflowId] = useState("");

    // Per-workflow filter fields
    const [maxAge, setMaxAge] = useState("60");
    const [maxArticles, setMaxArticles] = useState("100");
    const [clusterThreshold, setClusterThreshold] = useState("70");
    const [snapshot, setSnapshot] = useState<{ a: string; b: string; c: string }>({ a: "60", b: "100", c: "70" });
    const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

    // Global advanced: AI comparison limit
    const [aiDbLimit, setAiDbLimit] = useState("300");
    const [aiDbLimitSaved, setAiDbLimitSaved] = useState("300");
    const [aiSaveStatus, setAiSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

    // Domains
    const [domains, setDomains] = useState<WhitelistDomain[]>([]);
    const [allowAllDomains, setAllowAllDomains] = useState(false);
    const [newDomain, setNewDomain] = useState("");
    const [newDomainNote, setNewDomainNote] = useState("");
    const [newDomainWorkflowId, setNewDomainWorkflowId] = useState("");

    const loadAll = useCallback(async () => {
        const [wfsRes, domsRes, aiRes, allowAllRes] = await Promise.all([
            supabase.from("workflows")
                .select("id, name, is_active, feeder_enabled, feeder_interval_minutes, feeder_last_trigger_at, feeder_max_age_minutes, feeder_max_articles_per_run, feeder_cluster_threshold")
                .order("name"),
            supabase.from("feeder_whitelisted_domains").select("*").order("domain"),
            supabase.from("feeder_settings").select("value").eq("key", "agent_db_title_limit").maybeSingle(),
            supabase.from("feeder_settings").select("value").eq("key", "allow_all_domains").maybeSingle(),
        ]);
        const wfs: FeederWorkflow[] = wfsRes.data ?? [];
        setWorkflows(wfs);
        setDomains(domsRes.data ?? []);
        if (allowAllRes.data?.value) {
            setAllowAllDomains(allowAllRes.data.value.toLowerCase() === "true");
        }
        if (aiRes.data?.value) {
            setAiDbLimit(aiRes.data.value);
            setAiDbLimitSaved(aiRes.data.value);
        }

        // Sync form to selected workflow
        const wf = wfs.find(w => w.id === selectedWorkflowId) ?? wfs[0];
        if (wf) {
            if (!selectedWorkflowId) setSelectedWorkflowId(wf.id);
            const a = String(wf.feeder_max_age_minutes ?? 60);
            const b = String(wf.feeder_max_articles_per_run ?? 100);
            const c = String(wf.feeder_cluster_threshold ?? 70);
            setMaxAge(a); setMaxArticles(b); setClusterThreshold(c);
            setSnapshot({ a, b, c });
        }
    }, [selectedWorkflowId]);

    useEffect(() => { loadAll(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const onChangeWorkflow = (id: string) => {
        const wf = workflows.find(w => w.id === id);
        setSelectedWorkflowId(id);
        if (wf) {
            const a = String(wf.feeder_max_age_minutes ?? 60);
            const b = String(wf.feeder_max_articles_per_run ?? 100);
            const c = String(wf.feeder_cluster_threshold ?? 70);
            setMaxAge(a); setMaxArticles(b); setClusterThreshold(c);
            setSnapshot({ a, b, c });
        }
    };

    const dirty = maxAge !== snapshot.a || maxArticles !== snapshot.b || clusterThreshold !== snapshot.c;

    const saveWorkflowFilters = async () => {
        if (!selectedWorkflowId) return;
        const age = parseInt(maxAge, 10);
        const arts = parseInt(maxArticles, 10);
        const cluster = parseInt(clusterThreshold, 10);
        if (isNaN(age) || age < 5) { alert("Time window must be at least 5 minutes."); return; }
        if (isNaN(arts) || arts < 1 || arts > 500) { alert("Articles per run must be between 1 and 500."); return; }
        if (isNaN(cluster) || cluster < 0 || cluster > 100) { alert("Cluster threshold must be between 0 and 100."); return; }

        setSaveStatus("saving");
        const { error } = await supabase.from("workflows").update({
            feeder_max_age_minutes: age,
            feeder_max_articles_per_run: arts,
            feeder_cluster_threshold: cluster,
            updated_at: new Date().toISOString(),
        }).eq("id", selectedWorkflowId);

        if (error) {
            console.error("Save error:", error);
            setSaveStatus("error");
        } else {
            setSaveStatus("saved");
            setSnapshot({ a: String(age), b: String(arts), c: String(cluster) });
        }
        setTimeout(() => setSaveStatus("idle"), 3000);
    };

    const saveAiLimit = async () => {
        const v = parseInt(aiDbLimit, 10);
        if (isNaN(v) || v < 0 || v > 2000) { alert("AI comparison limit must be between 0 and 2000."); return; }
        setAiSaveStatus("saving");
        const { error } = await supabase.from("feeder_settings").upsert(
            { key: "agent_db_title_limit", value: String(v), updated_at: new Date().toISOString() },
            { onConflict: "key" }
        );
        if (error) { setAiSaveStatus("error"); } else { setAiSaveStatus("saved"); setAiDbLimitSaved(String(v)); }
        setTimeout(() => setAiSaveStatus("idle"), 3000);
    };

    // ── Domains ─────────────────────────────────────────────────────────────
    const addDomain = async () => {
        if (!newDomain.trim()) return;
        const dom = newDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
        const { data, error } = await supabase.from("feeder_whitelisted_domains").insert({
            domain: dom,
            note: newDomainNote.trim() || undefined,
            workflow_id: newDomainWorkflowId || null,
        }).select().single();
        if (error) { alert(`Failed to add: ${error.message}`); return; }
        setDomains(prev => [...prev, data]);
        setNewDomain(""); setNewDomainNote("");
    };

    const handleToggleAllowAllDomains = async (checked: boolean) => {
        setAllowAllDomains(checked);
        await Promise.all([
            supabase.from("feeder_settings").upsert({
                key: "allow_all_domains",
                value: String(checked),
                updated_at: new Date().toISOString(),
            }, { onConflict: "key" }),
            fetch("/api/agent-settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    settings: { feeder_allow_all_domains: String(checked) },
                }),
            }),
        ]);
        loadAll();
    };

    const deleteDomain = async (id: string) => {
        await supabase.from("feeder_whitelisted_domains").delete().eq("id", id);
        loadAll();
    };
    const updateDomainWorkflow = async (id: string, workflow_id: string | null) => {
        await supabase.from("feeder_whitelisted_domains").update({ workflow_id }).eq("id", id);
        loadAll();
    };

    const selectedWf = workflows.find(w => w.id === selectedWorkflowId);

    return (
        <div className="space-y-6 max-w-4xl mx-auto">
            {/* Per-workflow filters */}
            <SectionCard
                title="Fetch & Filter Limits"
                icon={Filter}
                badge={
                    <select
                        value={selectedWorkflowId}
                        onChange={e => onChangeWorkflow(e.target.value)}
                        className="h-8 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary font-semibold max-w-[150px]"
                    >
                        {workflows.map(w => (
                            <option key={w.id} value={w.id}>{w.name}</option>
                        ))}
                    </select>
                }
            >
                <div className="p-4 sm:p-5 space-y-6">
                    <div className="rounded-lg border bg-primary/5 p-3 text-xs text-muted-foreground">
                        These limits apply <strong className="text-foreground">per workflow</strong> —
                        <strong className="text-foreground"> {selectedWf?.name ?? "…"} </strong>
                        uses its own values every time its feeder runs.
                    </div>

                    {/* Time window */}
                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <label className="text-sm font-medium">News Time Window</label>
                            <span className="text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">{maxAge} min</span>
                        </div>
                        <p className="text-xs text-muted-foreground mb-2">
                            Drop articles older than N minutes. For Google News feeds this is also sent as a
                            <code className="text-xs bg-muted px-1 rounded"> when:</code> query for a fresher fetch.
                        </p>
                        <div className="flex gap-2 flex-wrap mb-2">
                            {MAX_AGE_PRESETS.map(p => (
                                <PresetButton key={p} value={p} current={maxAge} onClick={() => setMaxAge(p)}>
                                    {MAX_AGE_LABELS[p]}
                                </PresetButton>
                            ))}
                        </div>
                        <div className="flex items-center gap-2">
                            <Input type="number" min={5} className="h-8 w-24 text-sm" value={maxAge} onChange={e => setMaxAge(e.target.value)} />
                            <span className="text-xs text-muted-foreground">minutes (custom)</span>
                        </div>
                    </div>

                    {/* Max articles per run */}
                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <label className="text-sm font-medium">Max Articles per Run</label>
                            <span className="text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">{maxArticles} articles</span>
                        </div>
                        <p className="text-xs text-muted-foreground mb-2">
                            Each feed is fetched in full (Google News gives up to ~100 articles per query). This caps how many
                            unique articles one run keeps after clustering. Higher values = longer runs; the AI dedup
                            automatically processes articles in chunks of 40.
                        </p>
                        <div className="flex gap-2 flex-wrap mb-2">
                            {ARTICLE_PRESETS.map(n => (
                                <PresetButton key={n} value={n} current={maxArticles} onClick={() => setMaxArticles(n)}>{n}</PresetButton>
                            ))}
                        </div>
                        <div className="flex items-center gap-2">
                            <Input type="number" min={1} max={500} className="h-8 w-24 text-sm" value={maxArticles} onChange={e => setMaxArticles(e.target.value)} />
                            <span className="text-xs text-muted-foreground">articles (custom, up to 500)</span>
                        </div>
                    </div>

                    {/* Cluster threshold */}
                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <label className="text-sm font-medium">Event Cluster Threshold</label>
                            <span className="text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">{clusterThreshold}</span>
                        </div>
                        <p className="text-xs text-muted-foreground mb-2">
                            Same-event grouping similarity (0–100). Higher = stricter dedup, lower = more cross-source variants kept.
                        </p>
                        <div className="flex gap-2 flex-wrap mb-2">
                            {CLUSTER_PRESETS.map(n => (
                                <PresetButton key={n} value={n} current={clusterThreshold} onClick={() => setClusterThreshold(n)}>{n}</PresetButton>
                            ))}
                        </div>
                        <div className="flex items-center gap-2">
                            <Input type="number" min={0} max={100} className="h-8 w-24 text-sm" value={clusterThreshold} onChange={e => setClusterThreshold(e.target.value)} />
                            <span className="text-xs text-muted-foreground">score (custom)</span>
                        </div>
                    </div>

                    {/* Pipeline layers explainer */}
                    <div className="p-3 rounded-lg bg-muted/50 border text-sm text-muted-foreground">
                        <p className="font-medium text-foreground mb-2 flex items-center gap-1.5">
                            <Layers className="h-3.5 w-3.5" />How a run filters articles
                        </p>
                        <ul className="space-y-1 text-xs">
                            <li><ChevronRight className="inline h-3 w-3 mr-1" /><strong>Time filter</strong> — drop articles older than the window above</li>
                            <li><ChevronRight className="inline h-3 w-3 mr-1" /><strong>Domain whitelist</strong> — keep only trusted sources (below)</li>
                            <li><ChevronRight className="inline h-3 w-3 mr-1" /><strong>Event clustering</strong> — one article per news event</li>
                            <li><ChevronRight className="inline h-3 w-3 mr-1" /><strong>GUID + hash dedup</strong> — never re-deliver seen articles</li>
                            <li><ChevronRight className="inline h-3 w-3 mr-1" /><strong>AI dedup</strong> — the AI model from Settings → AI Model makes the final call</li>
                        </ul>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                        <Button onClick={saveWorkflowFilters} disabled={saveStatus === "saving" || !dirty} className="flex-1 sm:flex-none min-w-[200px]">
                            {saveStatus === "saving"
                                ? <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />Saving…</>
                                : <><Save className="mr-2 h-3.5 w-3.5" />{dirty ? "Save Limits" : "No Changes"}</>}
                        </Button>
                        <SaveStatus status={saveStatus} dirty={dirty} />
                    </div>
                </div>
            </SectionCard>

            {/* Whitelisted domains */}
            <SectionCard title="Whitelisted Domains" icon={Globe} badge={allowAllDomains ? "Bypassed · All domains allowed" : `${domains.length} domains · Empty = allow all`}>
                {/* Allow all domains master toggle */}
                <div className="p-4 border-b bg-muted/20 flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-foreground">Allow All Domains</span>
                            {allowAllDomains ? (
                                <span className="text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded-full font-semibold border border-emerald-500/20">
                                    Bypassing Whitelist
                                </span>
                            ) : (
                                <span className="text-[10px] bg-muted text-muted-foreground px-2 py-0.5 rounded-full font-semibold border border-border/50">
                                    Whitelist Filtering Active
                                </span>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            When enabled, articles from any RSS feed domain pass directly to clustering without being dropped.
                        </p>
                    </div>
                    <Switch checked={allowAllDomains} onCheckedChange={handleToggleAllowAllDomains} />
                </div>

                <div className="p-4 space-y-2 max-h-64 overflow-auto">
                    {domains.length === 0 && <p className="text-sm text-muted-foreground">No domains — every source passes the whitelist.</p>}
                    {domains.map(d => (
                        <div key={d.id} className="flex items-center gap-2 text-sm flex-wrap sm:flex-nowrap">
                            <ShieldCheck className="h-3.5 w-3.5 text-primary shrink-0" />
                            <div className="flex-1 min-w-0">
                                <p className="font-medium">{d.domain}</p>
                                {d.note && <p className="text-xs text-muted-foreground">{d.note}</p>}
                            </div>
                            <select
                                value={d.workflow_id || ""}
                                onChange={e => updateDomainWorkflow(d.id, e.target.value || null)}
                                className="text-xs h-7 rounded border bg-background px-1.5 focus:outline-none focus:ring-1 focus:ring-primary max-w-[140px]"
                            >
                                <option value="">(Global)</option>
                                {workflows.map(w => (
                                    <option key={w.id} value={w.id}>{w.name}</option>
                                ))}
                            </select>
                            <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive shrink-0" onClick={() => deleteDomain(d.id)}>
                                <X className="h-3 w-3" />
                            </Button>
                        </div>
                    ))}
                </div>
                <div className="p-4 flex flex-col gap-2 border-t">
                    <div className="flex flex-col sm:flex-row gap-2">
                        <Input placeholder="e.g. dawn.com" value={newDomain} onChange={e => setNewDomain(e.target.value)} className="h-9 text-sm flex-1" />
                        <Input placeholder="Note (optional)" value={newDomainNote} onChange={e => setNewDomainNote(e.target.value)} className="h-9 text-sm flex-1" />
                    </div>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                        <select
                            value={newDomainWorkflowId}
                            onChange={e => setNewDomainWorkflowId(e.target.value)}
                            className="flex-1 h-9 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                            <option value="">(Global / All Workflows)</option>
                            {workflows.map(w => (
                                <option key={w.id} value={w.id}>{w.name}</option>
                            ))}
                        </select>
                        <Button size="sm" onClick={addDomain} className="shrink-0"><PlusCircle className="mr-2 h-3.5 w-3.5" />Add Domain</Button>
                    </div>
                </div>
            </SectionCard>

            {/* Advanced: AI comparison limit */}
            <SectionCard title="Advanced: AI Comparison Limit" icon={Layers} badge="Global default">
                <div className="p-4 sm:p-5 space-y-3">
                    <p className="text-xs text-muted-foreground">
                        How many of your most recent stored titles the AI dedup compares new articles against.
                        Applies to all workflows unless overridden.
                    </p>
                    <div className="flex gap-2 flex-wrap">
                        {AI_LIMIT_PRESETS.map(n => (
                            <PresetButton key={n} value={n} current={aiDbLimit} onClick={() => setAiDbLimit(n)}>{n}</PresetButton>
                        ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Input type="number" min={0} max={2000} className="h-8 w-24 text-sm" value={aiDbLimit} onChange={e => setAiDbLimit(e.target.value)} />
                        <span className="text-xs text-muted-foreground">recent titles</span>
                        <Button size="sm" variant="outline" onClick={saveAiLimit} disabled={aiSaveStatus === "saving" || aiDbLimit === aiDbLimitSaved} className="ml-auto">
                            {aiSaveStatus === "saving" ? "Saving…" : "Save"}
                        </Button>
                        <SaveStatus status={aiSaveStatus} dirty={aiDbLimit !== aiDbLimitSaved} />
                    </div>
                </div>
            </SectionCard>
        </div>
    );
}
