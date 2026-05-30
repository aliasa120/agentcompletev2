"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Settings, Home, Activity, RefreshCw, Trash2,
    PlusCircle, Rss, Globe, ShieldCheck, X, BarChart3,
    AlertTriangle, Database, Zap, AlarmClock, Clock,
    ChevronRight, Timer, Layers, CheckCircle2, XCircle
} from "lucide-react";

interface FeedSource { id: string; url: string; label: string; is_active: boolean; }
interface WhitelistDomain { id: string; domain: string; note: string; }

// All setting keys the pipeline actually reads — must match these exactly
const FEEDER_SETTING_KEYS = [
    "max_age_minutes",
    "batch_size",
    "cluster_threshold",
    "agent_db_title_limit",
    "feeder_auto_trigger_enabled",
    "feeder_auto_trigger_interval_minutes",
];

const DEFAULTS: Record<string, string> = {
    max_age_minutes: "60",
    batch_size: "30",
    cluster_threshold: "70",
    agent_db_title_limit: "300",
    feeder_auto_trigger_enabled: "false",
    feeder_auto_trigger_interval_minutes: "30",
};

const MAX_AGE_PRESETS = [
    { label: "15 min", value: "15" },
    { label: "30 min", value: "30" },
    { label: "1 hour", value: "60" },
    { label: "2 hours", value: "120" },
    { label: "6 hours", value: "360" },
    { label: "24 hours", value: "1440" },
];

const FEEDER_INTERVALS = [
    { label: "10 min", value: "10" },
    { label: "15 min", value: "15" },
    { label: "30 min", value: "30" },
    { label: "1 hour", value: "60" },
    { label: "2 hours", value: "120" },
    { label: "4 hours", value: "240" },
    { label: "6 hours", value: "360" },
];

function StatCard({ label, value, icon: Icon, color = "text-primary", sub }: {
    label: string; value: number | string; icon: React.ElementType; color?: string; sub?: string;
}) {
    return (
        <div className="rounded-xl border bg-card shadow-sm p-4 flex items-center gap-4">
            <div className={`rounded-lg p-2.5 bg-muted ${color}`}><Icon className="h-5 w-5" /></div>
            <div>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-2xl font-bold">{value}</p>
                {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
            </div>
        </div>
    );
}

function PresetButton({ value, current, onClick, children }: {
    value: string; current: string; onClick: () => void; children: React.ReactNode
}) {
    const active = current === value;
    return (
        <button
            onClick={onClick}
            className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all
                ${active
                    ? "border-primary bg-primary text-primary-foreground shadow-sm"
                    : "border-border bg-muted hover:bg-accent"}`}
        >{children}</button>
    );
}

export default function FeederSettingsPage() {
    const [sources, setSources] = useState<FeedSource[]>([]);
    const [newUrl, setNewUrl] = useState("");
    const [newLabel, setNewLabel] = useState("");
    const [domains, setDomains] = useState<WhitelistDomain[]>([]);
    const [newDomain, setNewDomain] = useState("");
    const [newDomainNote, setNewDomainNote] = useState("");

    // Settings state — starts with defaults, overwritten by DB on load
    const [settings, setSettings] = useState<Record<string, string>>(DEFAULTS);
    const [dbSettings, setDbSettings] = useState<Record<string, string>>(DEFAULTS); // last saved snapshot
    const [isDirty, setIsDirty] = useState(false);

    const [stats, setStats] = useState({ guids: 0, hashes: 0, articles: 0, pending: 0, done: 0 });
    const [articlesByStatus, setArticlesByStatus] = useState<{ status: string; count: number }[]>([]);
    const [loading, setLoading] = useState(false);
    const [dangerConfirm, setDangerConfirm] = useState(false);
    const [nukeBusy, setNukeBusy] = useState(false);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [pktTime, setPktTime] = useState("");
    const [nextTriggerIn, setNextTriggerIn] = useState<string | null>(null);

    // Live PKT clock
    useEffect(() => {
        const tick = () => setPktTime(new Date().toLocaleString("en-PK", {
            timeZone: "Asia/Karachi", hour12: false,
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
        }));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, []);

    // Auto-trigger countdown — shows exact PKT target time + time remaining
    useEffect(() => {
        const enabled = settings.feeder_auto_trigger_enabled === "true";
        const lastRun = settings.feeder_last_trigger_at;
        if (!enabled || !lastRun) { setNextTriggerIn(null); return; }
        const intervalMs = parseInt(settings.feeder_auto_trigger_interval_minutes || "30", 10) * 60_000;
        const targetTime = new Date(lastRun).getTime() + intervalMs;
        // Format the fixed target time in PKT once
        const targetPKT = new Date(targetTime).toLocaleString("en-PK", {
            timeZone: "Asia/Karachi", hour12: false,
            hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
        const tick = () => {
            const rem = targetTime - Date.now();
            if (rem <= 0) { setNextTriggerIn(`${targetPKT} PKT (due now)`); return; }
            const m = Math.floor(rem / 60_000);
            const s = Math.floor((rem % 60_000) / 1000);
            setNextTriggerIn(`${targetPKT} PKT (in ${m}m ${s}s)`);
        };
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [settings.feeder_auto_trigger_enabled, settings.feeder_last_trigger_at, settings.feeder_auto_trigger_interval_minutes]);

    const loadAll = useCallback(async () => {
        setLoading(true);
        try {
            const [srcsRes, domsRes, settRes, guidRes, hashRes, artRes] = await Promise.all([
                supabase.from("feeder_sources").select("*").order("created_at"),
                supabase.from("feeder_whitelisted_domains").select("*").order("domain"),
                supabase.from("feeder_settings").select("key,value"),
                supabase.from("feeder_seen_guids").select("id", { count: "exact", head: true }),
                supabase.from("feeder_seen_hashes").select("id", { count: "exact", head: true }),
                supabase.from("feeder_articles").select("status"),
            ]);

            setSources(srcsRes.data ?? []);
            setDomains(domsRes.data ?? []);

            // Build settings map — start with defaults, overlay DB values
            const loaded: Record<string, string> = { ...DEFAULTS };
            for (const row of settRes.data ?? []) {
                loaded[row.key] = row.value ?? DEFAULTS[row.key] ?? "";
            }
            setSettings(loaded);
            setDbSettings(loaded);
            setIsDirty(false);

            const statusCounts: Record<string, number> = {};
            for (const a of artRes.data ?? []) statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
            setArticlesByStatus(Object.entries(statusCounts).map(([status, count]) => ({ status, count })));

            setStats({
                guids: guidRes.count ?? 0,
                hashes: hashRes.count ?? 0,
                articles: artRes.data?.length ?? 0,
                pending: statusCounts["Pending"] ?? 0,
                done: statusCounts["Done"] ?? 0,
            });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadAll(); }, [loadAll]);

    // Track dirty state whenever settings change
    useEffect(() => {
        const dirty = FEEDER_SETTING_KEYS.some(k => settings[k] !== dbSettings[k]);
        setIsDirty(dirty);
    }, [settings, dbSettings]);

    const setSetting = (key: string, value: string) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    };

    // Save ALL pipeline-relevant settings atomically
    const saveSettings = async () => {
        setSaveStatus('saving');
        try {
            const rows = FEEDER_SETTING_KEYS.map(key => ({
                key,
                value: settings[key] ?? DEFAULTS[key],
                updated_at: new Date().toISOString(),
            }));
            const { error } = await supabase
                .from("feeder_settings")
                .upsert(rows, { onConflict: "key" });

            if (error) {
                console.error("Save error:", error);
                setSaveStatus('error');
            } else {
                setSaveStatus('saved');
                setDbSettings({ ...settings });
                setIsDirty(false);
            }
        } catch (e) {
            console.error("Save exception:", e);
            setSaveStatus('error');
        } finally {
            setTimeout(() => setSaveStatus('idle'), 3000);
        }
    };

    // Toggle auto-trigger: save immediately; when enabling, record NOW as schedule start
    const toggleAutoTrigger = async () => {
        const next = settings.feeder_auto_trigger_enabled === "true" ? "false" : "true";
        const now = new Date().toISOString();
        setSetting("feeder_auto_trigger_enabled", next);
        const rows: { key: string; value: string; updated_at: string }[] = [
            { key: "feeder_auto_trigger_enabled", value: next, updated_at: now },
        ];
        if (next === "true") {
            // Start countdown from NOW so the UI always shows a meaningful next-trigger time
            rows.push({ key: "feeder_last_trigger_at", value: now, updated_at: now });
            setSetting("feeder_last_trigger_at", now);
            setDbSettings(prev => ({ ...prev, feeder_last_trigger_at: now }));
        }
        await supabase.from("feeder_settings").upsert(rows, { onConflict: "key" });
        setDbSettings(prev => ({ ...prev, feeder_auto_trigger_enabled: next }));
    };

    const addSource = async () => {
        if (!newUrl.trim()) return;
        await supabase.from("feeder_sources").insert({ url: newUrl.trim(), label: newLabel.trim() || newUrl.trim() });
        setNewUrl(""); setNewLabel(""); loadAll();
    };
    const deleteSource = async (id: string) => { await supabase.from("feeder_sources").delete().eq("id", id); loadAll(); };
    const toggleSource = async (id: string, is_active: boolean) => { await supabase.from("feeder_sources").update({ is_active: !is_active }).eq("id", id); loadAll(); };

    const addDomain = async () => {
        if (!newDomain.trim()) return;
        const domain = newDomain.trim().toLowerCase().replace(/^www\./, "");
        await supabase.from("feeder_whitelisted_domains").insert({ domain, note: newDomainNote.trim() });
        setNewDomain(""); setNewDomainNote(""); loadAll();
    };
    const deleteDomain = async (id: string) => { await supabase.from("feeder_whitelisted_domains").delete().eq("id", id); loadAll(); };

    const clearTable = async (table: string, label: string) => {
        if (!confirm(`Clear all records from "${label}"?`)) return;
        await supabase.from(table).delete().neq("id", "00000000-0000-0000-0000-000000000000");
        loadAll();
    };

    const nukeAll = async () => {
        setNukeBusy(true);
        try {
            await Promise.all([
                supabase.from("feeder_seen_guids").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
                supabase.from("feeder_seen_hashes").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
                supabase.from("feeder_articles").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
                supabase.from("feeder_run_history").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
            ]);
        } finally {
            setNukeBusy(false);
            setDangerConfirm(false);
            loadAll();
        }
    };

    const autoEnabled = settings.feeder_auto_trigger_enabled === "true";

    return (
        <div className="flex h-screen flex-col bg-background overflow-hidden">
            <header className="flex h-16 shrink-0 items-center justify-between border-b px-6">
                <div className="flex items-center gap-3">
                    <Settings className="h-5 w-5 text-primary" />
                    <h1 className="text-xl font-semibold">Feeder Settings</h1>
                    <span className="text-xs text-muted-foreground ml-4 font-mono">{pktTime} PKT</span>
                    {isDirty && (
                        <span className="ml-2 text-xs text-orange-500 font-medium px-2 py-0.5 rounded-full bg-orange-50 border border-orange-200">
                            Unsaved changes
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={loadAll} disabled={loading}>
                        <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh
                    </Button>
                    <Link href="/feeder"><Button variant="outline" size="sm"><Activity className="mr-2 h-4 w-4" />Dashboard</Button></Link>
                    <Link href="/agent-settings"><Button variant="outline" size="sm"><Zap className="mr-2 h-4 w-4" />Agent Settings</Button></Link>
                    <Link href="/"><Button variant="outline" size="sm"><Home className="mr-2 h-4 w-4" />Agent</Button></Link>
                </div>
            </header>

            <main className="flex-1 overflow-auto p-6 space-y-6">
                {/* Stats */}
                <section>
                    <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
                        <BarChart3 className="h-4 w-4" />Database Statistics
                    </h2>
                    <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
                        <StatCard label="Seen GUIDs" value={stats.guids} icon={Database} color="text-blue-500" sub="Layer 1" />
                        <StatCard label="Seen Hashes" value={stats.hashes} icon={ShieldCheck} color="text-green-500" sub="Layer 2" />
                        <StatCard label="Articles Total" value={stats.articles} icon={Activity} color="text-purple-500" sub="All statuses" />
                        <StatCard label="Pending" value={stats.pending} icon={Timer} color="text-yellow-500" sub="In queue" />
                        <StatCard label="Done" value={stats.done} icon={Activity} color="text-emerald-500" sub="Processed" />
                    </div>
                    {articlesByStatus.length > 0 && (
                        <div className="mt-3 flex gap-2 flex-wrap">
                            {articlesByStatus.map(s => (
                                <div key={s.status} className="rounded-lg border bg-card px-3 py-1.5 text-sm">
                                    <span className="font-medium">{s.status}:</span>{" "}
                                    <span className="text-muted-foreground">{s.count}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </section>

                <div className="grid gap-6 lg:grid-cols-2">
                    {/* —— Pipeline Settings —— */}
                    <section className="rounded-xl border bg-card shadow-sm">
                        <div className="p-4 border-b flex items-center gap-2">
                            <Layers className="h-4 w-4 text-primary" />
                            <h2 className="font-semibold">Pipeline Settings</h2>
                            <span className="ml-auto text-xs text-muted-foreground">Saved to DB on click</span>
                        </div>
                        <div className="p-5 space-y-6">

                            {/* News Time Window */}
                            <div>
                                <div className="flex items-center justify-between mb-1">
                                    <label className="text-sm font-medium">News Time Window</label>
                                    <span className="text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">
                                        {settings.max_age_minutes} min
                                    </span>
                                </div>
                                <p className="text-xs text-muted-foreground mb-2">
                                    Drop articles older than N minutes. Also injected into Google News RSS as <code className="text-xs bg-muted px-1 rounded">when:</code>.
                                </p>
                                <div className="flex gap-2 flex-wrap mb-2">
                                    {MAX_AGE_PRESETS.map(p => (
                                        <PresetButton key={p.value} value={p.value} current={settings.max_age_minutes} onClick={() => setSetting("max_age_minutes", p.value)}>
                                            {p.label}
                                        </PresetButton>
                                    ))}
                                </div>
                                <div className="flex items-center gap-2">
                                    <Input
                                        type="number" min={5}
                                        className="h-8 w-24 text-sm"
                                        value={settings.max_age_minutes}
                                        onChange={e => setSetting("max_age_minutes", e.target.value)}
                                    />
                                    <span className="text-xs text-muted-foreground">minutes (custom)</span>
                                </div>
                            </div>

                            {/* Batch Size */}
                            <div>
                                <div className="flex items-center justify-between mb-1">
                                    <label className="text-sm font-medium">Batch Size</label>
                                    <span className="text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">
                                        {settings.batch_size} articles
                                    </span>
                                </div>
                                <p className="text-xs text-muted-foreground mb-2">Max articles processed per pipeline run</p>
                                <div className="flex gap-2 flex-wrap mb-2">
                                    {["10", "20", "30", "50", "100"].map(n => (
                                        <PresetButton key={n} value={n} current={settings.batch_size} onClick={() => setSetting("batch_size", n)}>
                                            {n}
                                        </PresetButton>
                                    ))}
                                </div>
                                <div className="flex items-center gap-2">
                                    <Input
                                        type="number" min={1}
                                        className="h-8 w-24 text-sm"
                                        value={settings.batch_size}
                                        onChange={e => setSetting("batch_size", e.target.value)}
                                    />
                                    <span className="text-xs text-muted-foreground">articles (custom)</span>
                                </div>
                            </div>

                            {/* Cluster Threshold */}
                            <div>
                                <div className="flex items-center justify-between mb-1">
                                    <label className="text-sm font-medium">Event Cluster Threshold</label>
                                    <span className="text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">
                                        {settings.cluster_threshold}
                                    </span>
                                </div>
                                <p className="text-xs text-muted-foreground mb-2">Layer 0: same-event grouping similarity (0–100)</p>
                                <div className="flex gap-2 flex-wrap mb-2">
                                    {["50", "60", "70", "80", "90"].map(n => (
                                        <PresetButton key={n} value={n} current={settings.cluster_threshold} onClick={() => setSetting("cluster_threshold", n)}>
                                            {n}
                                        </PresetButton>
                                    ))}
                                </div>
                                <div className="flex items-center gap-2">
                                    <Input
                                        type="number" min={0} max={100}
                                        className="h-8 w-24 text-sm"
                                        value={settings.cluster_threshold}
                                        onChange={e => setSetting("cluster_threshold", e.target.value)}
                                    />
                                    <span className="text-xs text-muted-foreground">score (custom)</span>
                                </div>
                            </div>

                            <div className="p-3 rounded-lg bg-muted/50 border text-sm text-muted-foreground">
                                <p className="font-medium text-foreground mb-2 flex items-center gap-1.5">
                                    <Layers className="h-3.5 w-3.5" />Active Pipeline Layers
                                </p>
                                <ul className="space-y-1 text-xs">
                                    <li><ChevronRight className="inline h-3 w-3 mr-1" /><strong>Layer -2</strong> — Time filter (drop articles older than {settings.max_age_minutes}min)</li>
                                    <li><ChevronRight className="inline h-3 w-3 mr-1" /><strong>Layer -1</strong> — Domain whitelist</li>
                                    <li><ChevronRight className="inline h-3 w-3 mr-1" /><strong>Layer 0</strong> — Event clustering (≥{settings.cluster_threshold} score)</li>
                                    <li><ChevronRight className="inline h-3 w-3 mr-1" /><strong>Layer 1</strong> — GUID dedup</li>
                                    <li><ChevronRight className="inline h-3 w-3 mr-1" /><strong>Layer 2</strong> — Hash dedup</li>
                                    <li><ChevronRight className="inline h-3 w-3 mr-1" /><strong>AI Agent</strong> — LLM semantic dedup (final)</li>
                                </ul>
                            </div>

                            {/* Save button */}
                            <div className="flex items-center gap-3">
                                <Button onClick={saveSettings} disabled={saveStatus === 'saving' || !isDirty} className="flex-1">
                                    {saveStatus === 'saving' ? 'Saving…' : isDirty ? 'Save Settings' : 'No Changes'}
                                </Button>
                                {saveStatus === 'saved' && (
                                    <span className="flex items-center gap-1 text-sm text-green-600 font-medium">
                                        <CheckCircle2 className="h-4 w-4" />Saved
                                    </span>
                                )}
                                {saveStatus === 'error' && (
                                    <span className="flex items-center gap-1 text-sm text-red-600 font-medium">
                                        <XCircle className="h-4 w-4" />Error
                                    </span>
                                )}
                            </div>
                        </div>
                    </section>

                    {/* —— Auto-Trigger Schedule —— */}
                    <section className="rounded-xl border bg-card shadow-sm">
                        <div className="p-4 border-b flex items-center gap-2">
                            <AlarmClock className="h-4 w-4 text-primary" />
                            <h2 className="font-semibold">Feeder Auto-Run Schedule</h2>
                        </div>
                        <div className="p-5 space-y-5">

                            {/* Toggle — saves immediately */}
                            <div className="flex items-center justify-between p-4 rounded-lg border bg-muted/30">
                                <div>
                                    <p className="text-sm font-medium">Auto-Run</p>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                        {autoEnabled ? "Feeder runs automatically on schedule" : "Only runs when triggered manually"}
                                    </p>
                                </div>
                                <button
                                    onClick={toggleAutoTrigger}
                                    className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors
                                        ${autoEnabled ? "bg-primary" : "bg-muted-foreground/30"}`}
                                >
                                    <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform
                                        ${autoEnabled ? "translate-x-6" : "translate-x-1"}`} />
                                </button>
                            </div>

                            {/* Interval */}
                            <div className={autoEnabled ? "" : "opacity-50 pointer-events-none"}>
                                <div className="flex items-center justify-between mb-1">
                                    <label className="text-sm font-medium">Run Interval</label>
                                    <span className="text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">
                                        every {settings.feeder_auto_trigger_interval_minutes}min
                                    </span>
                                </div>
                                <p className="text-xs text-muted-foreground mb-2">Pipeline runs automatically every N hours</p>
                                <div className="flex gap-2 flex-wrap mb-2">
                                    {FEEDER_INTERVALS.map(iv => (
                                        <PresetButton key={iv.value} value={iv.value} current={settings.feeder_auto_trigger_interval_minutes} onClick={() => setSetting("feeder_auto_trigger_interval_minutes", iv.value)}>
                                            {iv.label}
                                        </PresetButton>
                                    ))}
                                </div>
                                <div className="flex items-center gap-2">
                                    <Input
                                        type="number" min={1} step={1}
                                        className="h-8 w-24 text-sm"
                                        value={settings.feeder_auto_trigger_interval_minutes}
                                        onChange={e => setSetting("feeder_auto_trigger_interval_minutes", e.target.value)}
                                    />
                                    <span className="text-xs text-muted-foreground">minutes (custom)</span>
                                </div>
                            </div>

                            {/* Clock & countdown */}
                            <div className="rounded-lg border bg-muted/40 p-3 flex items-center gap-3">
                                <Clock className="h-4 w-4 text-primary shrink-0" />
                                <div>
                                    <p className="text-xs text-muted-foreground">Pakistan Time (PKT, UTC+5)</p>
                                    <p className="text-sm font-mono font-bold">{pktTime}</p>
                                </div>
                            </div>

                            {autoEnabled && nextTriggerIn && (
                                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm flex items-center gap-2">
                                    <Timer className="h-4 w-4 text-primary shrink-0" />
                                    <span className="text-muted-foreground">Next auto-run in:</span>
                                    <span className="font-bold text-primary">{nextTriggerIn}</span>
                                </div>
                            )}

                            {settings.feeder_last_trigger_at && (
                                <p className="text-xs text-muted-foreground">
                                    Last run:{" "}
                                    {new Date(settings.feeder_last_trigger_at).toLocaleString("en-PK", {
                                        timeZone: "Asia/Karachi", hour12: false,
                                        year: "numeric", month: "2-digit", day: "2-digit",
                                        hour: "2-digit", minute: "2-digit"
                                    })} PKT
                                </p>
                            )}

                            <div className="p-3 rounded-lg bg-muted/50 border text-xs text-muted-foreground space-y-1">
                                <p className="font-medium text-foreground">How it works</p>
                                <p><ChevronRight className="inline h-3 w-3 mr-1" />Toggle saves instantly — no Save button needed</p>
                                <p><ChevronRight className="inline h-3 w-3 mr-1" />Interval changes take effect within ~60 seconds on the server</p>
                                <p><ChevronRight className="inline h-3 w-3 mr-1" />Manual trigger still available on the Feeder Dashboard</p>
                            </div>

                            <div className="flex items-center gap-3">
                                <Button onClick={saveSettings} disabled={saveStatus === 'saving' || !isDirty} variant="outline" className="flex-1">
                                    {saveStatus === 'saving' ? 'Saving…' : isDirty ? 'Save Interval' : 'No Changes'}
                                </Button>
                                {saveStatus === 'saved' && <span className="flex items-center gap-1 text-sm text-green-600 font-medium"><CheckCircle2 className="h-4 w-4" />Saved</span>}
                            </div>
                        </div>
                    </section>
                </div>

                {/* —— Sources & Domains —— */}
                <div className="grid gap-6 lg:grid-cols-2">
                    <section className="rounded-xl border bg-card shadow-sm">
                        <div className="p-4 border-b flex items-center gap-2">
                            <Rss className="h-4 w-4 text-primary" />
                            <h2 className="font-semibold">Feed Sources (RSS)</h2>
                            <span className="ml-auto text-xs text-muted-foreground">{sources.length} sources</span>
                        </div>
                        <div className="p-4 space-y-2 max-h-64 overflow-auto">
                            {sources.length === 0 && <p className="text-sm text-muted-foreground">No feed sources added yet.</p>}
                            {sources.map(s => (
                                <div key={s.id} className="flex items-center gap-2 text-sm">
                                    <button onClick={() => toggleSource(s.id, s.is_active)} title={s.is_active ? "Active · click to pause" : "Paused · click to activate"}>
                                        <div className={`h-2.5 w-2.5 rounded-full transition-colors ${s.is_active ? "bg-green-500" : "bg-muted-foreground/30"}`} />
                                    </button>
                                    <div className="flex-1 min-w-0">
                                        <p className="font-medium truncate">{s.label}</p>
                                        <p className="text-xs text-muted-foreground truncate">{s.url}</p>
                                    </div>
                                    <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive shrink-0" onClick={() => deleteSource(s.id)}>
                                        <X className="h-3 w-3" />
                                    </Button>
                                </div>
                            ))}
                        </div>
                        <div className="p-4 pt-0 flex flex-col gap-2 border-t">
                            <Input placeholder="RSS URL" value={newUrl} onChange={e => setNewUrl(e.target.value)} className="h-8 text-sm" />
                            <Input placeholder="Label (optional)" value={newLabel} onChange={e => setNewLabel(e.target.value)} className="h-8 text-sm" />
                            <Button size="sm" onClick={addSource}><PlusCircle className="mr-2 h-3.5 w-3.5" />Add Source</Button>
                        </div>
                    </section>

                    <section className="rounded-xl border bg-card shadow-sm">
                        <div className="p-4 border-b flex items-center gap-2">
                            <Globe className="h-4 w-4 text-primary" />
                            <h2 className="font-semibold">Whitelisted Domains</h2>
                            <span className="ml-auto text-xs text-muted-foreground">{domains.length} domains · Empty = allow all</span>
                        </div>
                        <div className="p-4 space-y-2 max-h-64 overflow-auto">
                            {domains.length === 0 && <p className="text-sm text-muted-foreground">No domains — all sources pass Layer -1.</p>}
                            {domains.map(d => (
                                <div key={d.id} className="flex items-center gap-2 text-sm">
                                    <ShieldCheck className="h-3.5 w-3.5 text-green-500 shrink-0" />
                                    <div className="flex-1">
                                        <p className="font-medium">{d.domain}</p>
                                        {d.note && <p className="text-xs text-muted-foreground">{d.note}</p>}
                                    </div>
                                    <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => deleteDomain(d.id)}>
                                        <X className="h-3 w-3" />
                                    </Button>
                                </div>
                            ))}
                        </div>
                        <div className="p-4 pt-0 flex flex-col gap-2 border-t">
                            <Input placeholder="e.g. dawn.com" value={newDomain} onChange={e => setNewDomain(e.target.value)} className="h-8 text-sm" />
                            <Input placeholder="Note (optional)" value={newDomainNote} onChange={e => setNewDomainNote(e.target.value)} className="h-8 text-sm" />
                            <Button size="sm" onClick={addDomain}><PlusCircle className="mr-2 h-3.5 w-3.5" />Add Domain</Button>
                        </div>
                    </section>
                </div>

                {/* Clear tables */}
                <section className="rounded-xl border bg-card shadow-sm">
                    <div className="p-4 border-b flex items-center gap-2">
                        <Trash2 className="h-4 w-4 text-muted-foreground" /><h2 className="font-semibold">Clear Individual Tables</h2>
                    </div>
                    <div className="p-4 flex gap-2 flex-wrap">
                        {[
                            { table: "feeder_seen_guids", label: "Clear GUIDs (L1)" },
                            { table: "feeder_seen_hashes", label: "Clear Hashes (L2)" },
                            { table: "feeder_articles", label: "Clear Articles" },
                            { table: "feeder_run_history", label: "Clear Run History" },
                        ].map(({ table, label }) => (
                            <Button key={table} variant="outline" size="sm" onClick={() => clearTable(table, label)}>
                                <Trash2 className="mr-1.5 h-3 w-3" />{label}
                            </Button>
                        ))}
                    </div>
                </section>

                {/* DANGER ZONE */}
                <section className="rounded-xl border-2 border-destructive/40 bg-destructive/5 shadow-sm">
                    <div className="p-4 border-b border-destructive/20 flex items-center gap-2">
                        <AlertTriangle className="h-5 w-5 text-destructive" />
                        <h2 className="font-semibold text-destructive">Danger Zone</h2>
                    </div>
                    <div className="p-6 flex flex-col items-start gap-4">
                        <div>
                            <p className="font-medium">Delete ALL Feeder Data</p>
                            <p className="text-sm text-muted-foreground mt-1">
                                Permanently deletes all articles, GUIDs, hashes, and run history. Feed sources, whitelist domains, and settings are kept.
                            </p>
                        </div>
                        {!dangerConfirm ? (
                            <Button variant="destructive" onClick={() => setDangerConfirm(true)}>
                                <AlertTriangle className="mr-2 h-4 w-4" />Delete All Feeder Data
                            </Button>
                        ) : (
                            <div className="flex items-center gap-3 p-3 rounded-lg border border-destructive bg-destructive/10 w-full">
                                <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
                                <p className="text-sm font-medium flex-1">Are you absolutely sure? This cannot be undone.</p>
                                <Button variant="destructive" size="sm" onClick={nukeAll} disabled={nukeBusy}>
                                    {nukeBusy ? "Deleting…" : "Yes, Delete Everything"}
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => setDangerConfirm(false)}>Cancel</Button>
                            </div>
                        )}
                    </div>
                </section>
            </main>
        </div>
    );
}
