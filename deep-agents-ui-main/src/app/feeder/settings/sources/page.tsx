"use client";

import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Rss, PlusCircle, X, Pencil, Check, Globe, Wand2, AlertTriangle, Loader2
} from "lucide-react";
import { SectionCard, FeederWorkflow } from "../../_components/feeder-ui";

interface FeedSource {
    id: string; url: string; label: string; is_active: boolean; workflow_id?: string | null;
}

const GNEWS_LOCALES = [
    { label: "International (English)", hl: "en-US", gl: "US", ceid: "US:en" },
    { label: "Pakistan (English)", hl: "en-PK", gl: "PK", ceid: "PK:en" },
    { label: "Pakistan (Urdu)", hl: "ur", gl: "PK", ceid: "PK:ur" },
    { label: "United Kingdom", hl: "en-GB", gl: "GB", ceid: "GB:en" },
];

export default function FeederSourcesPage() {
    const [sources, setSources] = useState<FeedSource[]>([]);
    const [workflows, setWorkflows] = useState<FeederWorkflow[]>([]);
    const [loading, setLoading] = useState(false);

    // Add-source form
    const [newUrl, setNewUrl] = useState("");
    const [newLabel, setNewLabel] = useState("");
    const [newWorkflowId, setNewWorkflowId] = useState("");
    const [adding, setAdding] = useState(false);

    // Google News builder
    const [gnTopic, setGnTopic] = useState("");
    const [gnLocale, setGnLocale] = useState(0);

    // Inline edit
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editUrl, setEditUrl] = useState("");
    const [editLabel, setEditLabel] = useState("");

    const loadAll = useCallback(async () => {
        setLoading(true);
        try {
            const [srcsRes, wfsRes] = await Promise.all([
                supabase.from("feeder_sources").select("*").order("created_at"),
                supabase.from("workflows")
                    .select("id, name, is_active, feeder_enabled, feeder_interval_minutes, feeder_last_trigger_at, feeder_max_age_minutes, feeder_max_articles_per_run, feeder_cluster_threshold")
                    .order("name"),
            ]);
            setSources(srcsRes.data ?? []);
            setWorkflows(wfsRes.data ?? []);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadAll(); }, [loadAll]);

    // ── Google News URL builder ─────────────────────────────────────────────
    const builtUrl = gnTopic.trim()
        ? `https://news.google.com/rss/search?q=${encodeURIComponent(gnTopic.trim())}&hl=${GNEWS_LOCALES[gnLocale].hl}&gl=${GNEWS_LOCALES[gnLocale].gl}&ceid=${GNEWS_LOCALES[gnLocale].ceid}`
        : "";

    const useBuiltFeed = () => {
        if (!builtUrl) return;
        setNewUrl(builtUrl);
        if (!newLabel.trim()) setNewLabel(`Google News: ${gnTopic.trim()}`);
    };

    // ── CRUD ────────────────────────────────────────────────────────────────
    const addSource = async () => {
        if (!newUrl.trim()) return;
        setAdding(true);
        try {
            await supabase.from("feeder_sources").insert({
                url: newUrl.trim(),
                label: newLabel.trim() || newUrl.trim(),
                workflow_id: newWorkflowId || null,
            });
            setNewUrl(""); setNewLabel(""); setNewWorkflowId("");
            await loadAll();
        } finally {
            setAdding(false);
        }
    };

    const deleteSource = async (id: string) => {
        if (!confirm("Delete this source and all its articles?")) return;
        const { data: source } = await supabase.from("feeder_sources").select("workflow_id").eq("id", id).maybeSingle();
        const workflowId = source?.workflow_id;

        await supabase.from("feeder_articles").delete().eq("source_id", id);
        await supabase.from("feeder_sources").delete().eq("id", id);

        if (workflowId) {
            const { data: otherSources } = await supabase
                .from("feeder_sources").select("id").eq("workflow_id", workflowId);
            if (!otherSources || otherSources.length === 0) {
                await supabase.from("workflows").update({ feeder_enabled: false }).eq("id", workflowId);
                await supabase.from("feeder_seen_guids").delete().eq("workflow_id", workflowId);
                await supabase.from("feeder_seen_hashes").delete().eq("workflow_id", workflowId);
            }
        }
        loadAll();
    };

    const toggleSource = async (id: string, is_active: boolean) => {
        await supabase.from("feeder_sources").update({ is_active: !is_active }).eq("id", id);
        loadAll();
    };

    const updateSourceWorkflow = async (id: string, workflow_id: string | null) => {
        await supabase.from("feeder_sources").update({ workflow_id }).eq("id", id);
        loadAll();
    };

    const startEditing = (s: FeedSource) => {
        setEditingId(s.id); setEditUrl(s.url); setEditLabel(s.label);
    };

    const saveEdit = async (id: string) => {
        if (!editUrl.trim()) return;
        await supabase.from("feeder_sources")
            .update({ url: editUrl.trim(), label: editLabel.trim() || editUrl.trim() })
            .eq("id", id);
        setEditingId(null);
        loadAll();
    };

    return (
        <div className="space-y-6 max-w-4xl mx-auto">
            {/* Guided Google News builder */}
            <SectionCard title="Quick Add: Google News Feed" icon={Wand2} badge="Guided">
                <div className="p-4 sm:p-5 space-y-3">
                    <p className="text-xs text-muted-foreground">
                        Type any topic, place or person — we build the RSS URL for you. Google News supplies
                        up to ~100 of the freshest articles per query; the pipeline auto-applies your time window.
                    </p>
                    <div className="flex flex-col sm:flex-row gap-2">
                        <Input
                            placeholder='Topic, e.g. "Pakistan cricket" or "AI startups"'
                            value={gnTopic}
                            onChange={e => setGnTopic(e.target.value)}
                            className="h-9 text-sm flex-1"
                        />
                        <select
                            value={gnLocale}
                            onChange={e => setGnLocale(parseInt(e.target.value, 10))}
                            className="h-9 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary sm:w-56"
                        >
                            {GNEWS_LOCALES.map((l, i) => (
                                <option key={l.ceid} value={i}>{l.label}</option>
                            ))}
                        </select>
                    </div>
                    {builtUrl && (
                        <div className="rounded-lg border bg-muted/40 p-3 space-y-2">
                            <p className="text-xs font-mono break-all text-muted-foreground">{builtUrl}</p>
                            <Button size="sm" variant="outline" onClick={useBuiltFeed} className="h-7 text-xs">
                                Use this feed below
                            </Button>
                        </div>
                    )}
                </div>
            </SectionCard>

            {/* Feed Sources */}
            <SectionCard title="Feed Sources (RSS)" icon={Rss} badge={`${sources.length} sources`}>
                <div className="p-4 space-y-2 max-h-[420px] overflow-auto">
                    {sources.length === 0 && (
                        <p className="text-sm text-muted-foreground p-2">
                            No feed sources yet. Use the Google News builder above or paste any RSS URL below.
                        </p>
                    )}
                    {sources.map(s => (
                        <div key={s.id} className="flex items-start sm:items-center gap-2 sm:gap-3 text-sm flex-wrap sm:flex-nowrap">
                            <button
                                onClick={() => toggleSource(s.id, s.is_active)}
                                title={s.is_active ? "Active · click to pause" : "Paused · click to activate"}
                                className="mt-1.5 sm:mt-0"
                            >
                                <div className={`h-2.5 w-2.5 rounded-full transition-colors ${s.is_active ? "bg-primary" : "bg-muted-foreground/30"}`} />
                            </button>

                            {editingId === s.id ? (
                                <div className="flex-1 min-w-0 flex flex-col gap-1.5 p-1">
                                    <Input value={editLabel} onChange={e => setEditLabel(e.target.value)} className="h-8 text-xs bg-background" placeholder="Label" />
                                    <Input value={editUrl} onChange={e => setEditUrl(e.target.value)} className="h-8 text-xs bg-background" placeholder="RSS URL" />
                                </div>
                            ) : (
                                <div className="flex-1 min-w-0">
                                    <p className="font-medium truncate flex items-center gap-2">
                                        {s.label}
                                        {!s.workflow_id && (
                                            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-full px-1.5 py-0.5" title="Sources without a workflow are never fetched by the pipeline">
                                                <AlertTriangle className="h-2.5 w-2.5" />No workflow — not fetched
                                            </span>
                                        )}
                                    </p>
                                    <p className="text-xs text-muted-foreground truncate">{s.url}</p>
                                </div>
                            )}

                            <select
                                value={s.workflow_id || ""}
                                onChange={e => updateSourceWorkflow(s.id, e.target.value || null)}
                                className="text-xs h-7 rounded border bg-background px-1.5 focus:outline-none focus:ring-1 focus:ring-primary w-full sm:w-auto sm:max-w-[140px] order-last sm:order-none"
                            >
                                <option value="">(No Workflow)</option>
                                {workflows.map(w => (
                                    <option key={w.id} value={w.id}>{w.name}</option>
                                ))}
                            </select>

                            {editingId === s.id ? (
                                <div className="flex items-center gap-1 shrink-0">
                                    <Button size="icon" variant="ghost" className="h-6 w-6 text-primary" onClick={() => saveEdit(s.id)} title="Save changes"><Check className="h-3.5 w-3.5" /></Button>
                                    <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" onClick={() => setEditingId(null)} title="Cancel"><X className="h-3.5 w-3.5" /></Button>
                                </div>
                            ) : (
                                <div className="flex items-center gap-1 shrink-0">
                                    <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" onClick={() => startEditing(s)} title="Edit link/label"><Pencil className="h-3 w-3" /></Button>
                                    <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => deleteSource(s.id)} title="Delete source"><X className="h-3 w-3" /></Button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {/* Add form */}
                <div className="p-4 flex flex-col gap-2 border-t">
                    <Input placeholder="RSS URL" value={newUrl} onChange={e => setNewUrl(e.target.value)} className="h-9 text-sm" />
                    <Input placeholder="Label (optional)" value={newLabel} onChange={e => setNewLabel(e.target.value)} className="h-9 text-sm" />
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                        <select
                            value={newWorkflowId}
                            onChange={e => setNewWorkflowId(e.target.value)}
                            className="flex-1 h-9 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                            <option value="">(No Workflow)</option>
                            {workflows.map(w => (
                                <option key={w.id} value={w.id}>{w.name}</option>
                            ))}
                        </select>
                        <Button size="sm" onClick={addSource} disabled={adding || !newUrl.trim()} className="shrink-0">
                            {adding ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <PlusCircle className="mr-2 h-3.5 w-3.5" />}
                            Add Source
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground flex items-start gap-1">
                        <Globe className="h-3 w-3 mt-0.5 shrink-0" />
                        Articles inherit the workflow they belong to — every source should be assigned to a workflow, or it is never fetched.
                    </p>
                </div>
            </SectionCard>
        </div>
    );
}
