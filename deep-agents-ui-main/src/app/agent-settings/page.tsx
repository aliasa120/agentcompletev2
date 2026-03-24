"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Zap, Home, Settings, RefreshCw, Play,
    Clock, List, ChevronRight, Activity, AlarmClock, CheckCircle2, XCircle, Timer,
    Search, FileText, ImageIcon, FlaskConical, Loader2
} from "lucide-react";

interface Article { id: string; title: string; description: string; url: string; source_domain: string; status: string; created_at: string; }

const AGENT_SETTING_KEYS = [
    "queue_batch_size", "auto_trigger_enabled", "auto_trigger_interval_minutes", "auto_trigger_last_at",
    "search_provider_primary", "search_provider_secondary", "search_max_retries",
    "extract_provider_primary", "extract_provider_secondary", "extract_max_retries",
    "image_provider_primary", "image_provider_secondary", "image_max_retries",
];

const DEFAULTS: Record<string, string> = {
    queue_batch_size: "2",
    auto_trigger_enabled: "false",
    auto_trigger_interval_minutes: "30",
    auto_trigger_last_at: "",
    last_trigger_at: "",
    // AI Provider defaults
    search_provider_primary: "linkup",
    search_provider_secondary: "parallel",
    search_max_retries: "3",
    extract_provider_primary: "tavily",
    extract_provider_secondary: "exa",
    extract_max_retries: "3",
    image_provider_primary: "kie",
    image_provider_secondary: "gemini_flash",
    image_max_retries: "2",
};

// Provider options for each category
const SEARCH_PROVIDERS = [
    { value: "linkup",   label: "Linkup",      badge: "Standard" },
    { value: "parallel", label: "Parallel AI",  badge: "Agentic" },
];
const EXTRACT_PROVIDERS = [
    { value: "tavily", label: "Tavily",  badge: "Extract" },
    { value: "exa",    label: "Exa AI",  badge: "Contents" },
];
const IMAGE_PROVIDERS = [
    { value: "kie",          label: "KIE AI",            badge: "Image-to-Image" },
    { value: "gemini_flash", label: "Gemini 3.1 Flash",  badge: "Chat Completion" },
];

type TestStatus = "idle" | "testing" | "ok" | "error";
type TestState = { status: TestStatus; latency?: number; error?: string };
type ProviderId = "linkup" | "parallel" | "tavily" | "exa" | "kie" | "gemini_flash";

const INTERVALS = [
    { label: "10 min", value: "10" },
    { label: "30 min", value: "30" },
    { label: "1 hour", value: "60" },
    { label: "2 hours", value: "120" },
    { label: "4 hours", value: "240" },
];
const BATCH_SIZES = ["1", "2", "5", "10", "15", "20"];

function StatusBadge({ status }: { status: string }) {
    const color: Record<string, string> = {
        Pending: "bg-yellow-100 text-yellow-800",
        Processing: "bg-blue-100 text-blue-800",
        Done: "bg-green-100 text-green-800",
        Error: "bg-red-100 text-red-800",
    };
    return (
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 ${color[status] ?? "bg-muted text-muted-foreground"}`}>
            {status}
        </span>
    );
}

export default function AgentSettingsPage() {
    const [settings, setSettings] = useState<Record<string, string>>(DEFAULTS);
    const [dbSettings, setDbSettings] = useState<Record<string, string>>(DEFAULTS);
    const [isDirty, setIsDirty] = useState(false);
    const [queue, setQueue] = useState<Article[]>([]);
    const [allArticles, setAllArticles] = useState<Article[]>([]);
    const [loading, setLoading] = useState(false);
    const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
    const [nextTriggerIn, setNextTriggerIn] = useState<string | null>(null);
    const [nextTriggerAt, setNextTriggerAt] = useState<string | null>(null);
    const [pktTime, setPktTime] = useState("");

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

    // Dirty tracking — exclude auto_trigger_last_at and last_trigger_at (runtime, not user-editable)
    useEffect(() => {
        const dirty = AGENT_SETTING_KEYS
            .filter(k => k !== "auto_trigger_last_at" && k !== "last_trigger_at")
            .some(k => settings[k] !== dbSettings[k]);
        setIsDirty(dirty);
    }, [settings, dbSettings]);

    // Auto-trigger countdown — uses auto_trigger_last_at (set when toggle was turned ON or auto-trigger fired)
    // This is separate from last_trigger_at which is written by manual runs
    useEffect(() => {
        const enabled = settings.auto_trigger_enabled === "true";
        const lastAt = settings.auto_trigger_last_at;
        if (!enabled || !lastAt) { setNextTriggerIn(null); setNextTriggerAt(null); return; }
        const intervalMs = parseInt(settings.auto_trigger_interval_minutes || "30", 10) * 60_000;
        const targetTime = new Date(lastAt).getTime() + intervalMs;
        // Format the fixed target time in PKT once
        setNextTriggerAt(new Date(targetTime).toLocaleString("en-PK", {
            timeZone: "Asia/Karachi", hour12: false,
            hour: "2-digit", minute: "2-digit", second: "2-digit",
        }));
        const tick = () => {
            const rem = targetTime - Date.now();
            if (rem <= 0) { setNextTriggerIn("due now"); return; }
            const m = Math.floor(rem / 60_000);
            const s = Math.floor((rem % 60_000) / 1000);
            setNextTriggerIn(`in ${m}m ${s}s`);
        };
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [settings.auto_trigger_enabled, settings.auto_trigger_last_at, settings.auto_trigger_interval_minutes]);

    const batchSize = parseInt(settings.queue_batch_size || "2", 10);

    const loadAll = useCallback(async () => {
        setLoading(true);
        try {
            const [settRes, pendRes, artRes] = await Promise.all([
                supabase.from("agent_settings").select("key,value"),
                supabase.from("feeder_articles").select("*").eq("status", "Pending").order("created_at", { ascending: true }),
                supabase.from("feeder_articles").select("id,title,description,url,source_domain,status,created_at").order("created_at", { ascending: false }).limit(30),
            ]);
            const loaded: Record<string, string> = { ...DEFAULTS };
            for (const row of settRes.data ?? []) {
                if (row.value !== null) loaded[row.key] = row.value;
            }
            setSettings(loaded);
            setDbSettings(loaded);
            setIsDirty(false);
            setQueue(pendRes.data ?? []);
            setAllArticles(artRes.data ?? []);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadAll(); }, [loadAll]);

    const setSetting = (key: string, value: string) => setSettings(p => ({ ...p, [key]: value }));

    const [testStates, setTestStates] = useState<Record<string, TestState>>({});

    const testProvider = async (provider: ProviderId) => {
        setTestStates(prev => ({ ...prev, [provider]: { status: "testing" } }));
        try {
            const resp = await fetch("/api/test-provider", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ provider }),
            });
            const data = await resp.json();
            if (resp.status === 429) {
                setTestStates(prev => ({ ...prev, [provider]: { status: "error", error: data.error } }));
            } else if (data.success) {
                setTestStates(prev => ({ ...prev, [provider]: { status: "ok", latency: data.latency_ms } }));
            } else {
                setTestStates(prev => ({ ...prev, [provider]: { status: "error", error: data.error } }));
            }
        } catch (e) {
            setTestStates(prev => ({ ...prev, [provider]: { status: "error", error: "Network error" } }));
        }
        setTimeout(() => setTestStates(prev => ({ ...prev, [provider]: { status: "idle" } })), 8000);
    };

    const saveSettings = async () => {
        setSaveStatus("saving");
        const keysToSave = [
            "queue_batch_size", "auto_trigger_enabled", "auto_trigger_interval_minutes",
            "search_provider_primary", "search_provider_secondary", "search_max_retries",
            "extract_provider_primary", "extract_provider_secondary", "extract_max_retries",
            "image_provider_primary", "image_provider_secondary", "image_max_retries",
        ];
        try {
            const rows = keysToSave.map(key => ({
                key,
                value: settings[key] ?? DEFAULTS[key],
                updated_at: new Date().toISOString(),
            }));
            const { error } = await supabase.from("agent_settings").upsert(rows, { onConflict: "key" });
            if (error) {
                console.error("Save error:", error);
                setSaveStatus("error");
            } else {
                setSaveStatus("saved");
                setDbSettings(prev => ({ ...prev, ...Object.fromEntries(keysToSave.map(k => [k, settings[k]])) }));
                setIsDirty(false);
            }
        } catch (e) {
            console.error("Save exception:", e);
            setSaveStatus("error");
        } finally {
            setTimeout(() => setSaveStatus("idle"), 3000);
        }
    };

    // Toggle saves immediately; when enabling, record NOW as start of schedule
    const toggleAutoTrigger = async () => {
        const next = settings.auto_trigger_enabled === "true" ? "false" : "true";
        const now = new Date().toISOString();
        setSetting("auto_trigger_enabled", next);
        const upserts: { key: string; value: string; updated_at: string }[] = [
            { key: "auto_trigger_enabled", value: next, updated_at: now },
        ];
        if (next === "true") {
            // Start schedule from NOW so countdown is always fresh from toggle-on moment
            upserts.push({ key: "auto_trigger_last_at", value: now, updated_at: now });
            setSetting("auto_trigger_last_at", now);
            setDbSettings(prev => ({ ...prev, auto_trigger_last_at: now }));
        }
        await supabase.from("agent_settings").upsert(upserts, { onConflict: "key" });
        setDbSettings(prev => ({ ...prev, auto_trigger_enabled: next }));
    };

    const resetStuckArticles = async () => {
        const { error } = await supabase.from("feeder_articles").update({ status: "Pending" }).eq("status", "Processing");
        if (!error) { alert("All Processing articles reverted to Pending."); loadAll(); }
        else alert("Reset failed: " + error.message);
    };

    const fireAgent = async () => {
        const articles = queue.slice(0, batchSize);
        if (articles.length === 0) { alert("No pending articles in queue."); return; }
        // Manual trigger: update last_trigger_at (for display) but NOT auto_trigger_last_at (that's the auto-schedule clock)
        await supabase.from("agent_settings").upsert(
            { key: "last_trigger_at", value: new Date().toISOString(), updated_at: new Date().toISOString() },
            { onConflict: "key" }
        );
        const ids = articles.map(a => a.id);
        await supabase.from("feeder_articles").update({ status: "Processing" }).in("id", ids);
        const encoded = encodeURIComponent(JSON.stringify(articles));
        window.location.href = `/?queue=${encoded}`;
    };

    const autoEnabled = settings.auto_trigger_enabled === "true";

    return (
        <div className="flex h-screen flex-col bg-background overflow-hidden">
            <header className="flex h-16 shrink-0 items-center justify-between border-b px-6">
                <div className="flex items-center gap-3">
                    <Zap className="h-5 w-5 text-primary" />
                    <h1 className="text-xl font-semibold">Agent Settings</h1>
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
                    <Link href="/feeder/settings"><Button variant="outline" size="sm"><Settings className="mr-2 h-4 w-4" />Feeder Settings</Button></Link>
                    <Link href="/"><Button variant="outline" size="sm"><Home className="mr-2 h-4 w-4" />Agent</Button></Link>
                </div>
            </header>

            <main className="flex-1 overflow-auto p-6 space-y-6">
                <div className="grid gap-6 lg:grid-cols-2">
                    {/* Queue Config */}
                    <section className="rounded-xl border bg-card shadow-sm">
                        <div className="p-4 border-b flex items-center gap-2">
                            <List className="h-4 w-4 text-primary" />
                            <h2 className="font-semibold">Queue Configuration</h2>
                            <span className="ml-auto text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">{batchSize} articles/batch</span>
                        </div>
                        <div className="p-5 space-y-4">
                            <div>
                                <label className="text-sm font-medium">Batch Size</label>
                                <p className="text-xs text-muted-foreground mb-2">Articles sent per trigger. Each runs in its own thread (FIFO).</p>
                                <div className="flex gap-2 flex-wrap mb-2">
                                    {BATCH_SIZES.map(n => (
                                        <button
                                            key={n}
                                            onClick={() => setSetting("queue_batch_size", n)}
                                            className={`w-12 h-10 rounded-lg border text-sm font-semibold transition-all
                                                ${settings.queue_batch_size === n
                                                    ? "border-primary bg-primary text-primary-foreground shadow"
                                                    : "border-border bg-muted hover:bg-accent"}`}
                                        >{n}</button>
                                    ))}
                                    <Input
                                        type="number" min={1} max={30}
                                        className="h-10 w-20 text-sm"
                                        value={settings.queue_batch_size}
                                        onChange={e => setSetting("queue_batch_size", e.target.value)}
                                    />
                                </div>
                            </div>

                            <div className="p-3 rounded-lg bg-muted/50 border text-xs text-muted-foreground">
                                <p className="font-medium text-foreground mb-1">How the Queue Works</p>
                                <ul className="space-y-1">
                                    <li><ChevronRight className="inline h-3 w-3 mr-1" />Fetches <strong>{batchSize}</strong> oldest Pending articles (FIFO)</li>
                                    <li><ChevronRight className="inline h-3 w-3 mr-1" />Each article → one separate agent thread</li>
                                    <li><ChevronRight className="inline h-3 w-3 mr-1" />When batch completes → next batch ready on next trigger</li>
                                </ul>
                            </div>

                            <div className="flex items-center gap-3">
                                <Button onClick={saveSettings} disabled={saveStatus === "saving" || !isDirty} className="flex-1">
                                    {saveStatus === "saving" ? "Saving…" : isDirty ? "Save Settings" : "No Changes"}
                                </Button>
                                {saveStatus === "saved" && <span className="flex items-center gap-1 text-sm text-green-600 font-medium"><CheckCircle2 className="h-4 w-4" />Saved</span>}
                                {saveStatus === "error" && <span className="flex items-center gap-1 text-sm text-red-600 font-medium"><XCircle className="h-4 w-4" />Error</span>}
                            </div>
                        </div>
                    </section>

                    {/* Auto Trigger */}
                    <section className="rounded-xl border bg-card shadow-sm">
                        <div className="p-4 border-b flex items-center gap-2">
                            <AlarmClock className="h-4 w-4 text-primary" />
                            <h2 className="font-semibold">Auto-Trigger Schedule</h2>
                        </div>
                        <div className="p-5 space-y-4">
                            {/* Toggle — saves immediately */}
                            <div className="flex items-center justify-between p-4 rounded-lg border bg-muted/30">
                                <div>
                                    <p className="text-sm font-medium">Auto-Trigger</p>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                        {autoEnabled ? "Agent runs automatically on schedule" : "Only runs when fired manually"}
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

                            <div className={autoEnabled ? "" : "opacity-50 pointer-events-none"}>
                                <div className="flex items-center justify-between mb-1">
                                    <label className="text-sm font-medium">Trigger Interval</label>
                                    <span className="text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">
                                        every {settings.auto_trigger_interval_minutes}min
                                    </span>
                                </div>
                                <p className="text-xs text-muted-foreground mb-2">Agent runs automatically every N minutes</p>
                                <div className="flex gap-2 flex-wrap mb-2">
                                    {INTERVALS.map(iv => (
                                        <button
                                            key={iv.value}
                                            onClick={() => setSetting("auto_trigger_interval_minutes", iv.value)}
                                            className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all
                                                ${settings.auto_trigger_interval_minutes === iv.value
                                                    ? "border-primary bg-primary text-primary-foreground"
                                                    : "border-border bg-muted hover:bg-accent"}`}
                                        >{iv.label}</button>
                                    ))}
                                </div>
                                <div className="flex items-center gap-2">
                                    <Input
                                        type="number" min={1}
                                        className="h-8 w-24 text-sm"
                                        value={settings.auto_trigger_interval_minutes}
                                        onChange={e => setSetting("auto_trigger_interval_minutes", e.target.value)}
                                    />
                                    <span className="text-xs text-muted-foreground">minutes (custom)</span>
                                </div>
                            </div>

                            <div className="rounded-lg border bg-muted/40 p-3 flex items-center gap-3">
                                <Clock className="h-4 w-4 text-primary" />
                                <div>
                                    <p className="text-xs text-muted-foreground">Pakistan Time (PKT, UTC+5)</p>
                                    <p className="text-sm font-mono font-bold">{pktTime}</p>
                                </div>
                            </div>

                            {autoEnabled && nextTriggerAt && (
                                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 flex items-center gap-2 text-sm">
                                    <Timer className="h-4 w-4 text-primary shrink-0" />
                                    <div>
                                        <p className="text-muted-foreground text-xs">Next trigger at</p>
                                        <p className="font-bold text-primary">{nextTriggerAt} PKT
                                            {nextTriggerIn && <span className="font-normal text-muted-foreground ml-2 text-xs">({nextTriggerIn})</span>}
                                        </p>
                                    </div>
                                </div>
                            )}

                            {settings.last_trigger_at && (
                                <p className="text-xs text-muted-foreground">
                                    Last triggered:{" "}
                                    {new Date(settings.last_trigger_at).toLocaleString("en-PK", {
                                        timeZone: "Asia/Karachi", hour12: false,
                                        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
                                    })} PKT
                                </p>
                            )}

                            <div className="flex items-center gap-3">
                                <Button onClick={saveSettings} disabled={saveStatus === "saving" || !isDirty} variant="outline" className="flex-1">
                                    {saveStatus === "saving" ? "Saving…" : isDirty ? "Save Interval" : "No Changes"}
                                </Button>
                                {saveStatus === "saved" && <span className="flex items-center gap-1 text-sm text-green-600 font-medium"><CheckCircle2 className="h-4 w-4" />Saved</span>}
                            </div>
                        </div>
                    </section>
                </div>

                {/* AI Providers & Fallback Configuration */}
                <section className="rounded-xl border bg-card shadow-sm">
                    <div className="p-4 border-b flex items-center gap-2">
                        <Zap className="h-4 w-4 text-primary" />
                        <h2 className="font-semibold">AI Providers &amp; Fallback</h2>
                        <span className="ml-auto text-xs text-muted-foreground">Settings cached 60s in backend</span>
                    </div>
                    <div className="p-5 space-y-6">

                        {/* Search Providers */}
                        <ProviderRow
                            icon={<Search className="h-4 w-4 text-primary" />}
                            label="Search"
                            description="Primary provider for web search. Fallback triggers after max retries."
                            providers={SEARCH_PROVIDERS}
                            primaryKey="search_provider_primary"
                            secondaryKey="search_provider_secondary"
                            retriesKey="search_max_retries"
                            settings={settings}
                            setSetting={setSetting}
                            testStates={testStates}
                            onTest={testProvider}
                        />

                        {/* Extract Providers */}
                        <ProviderRow
                            icon={<FileText className="h-4 w-4 text-primary" />}
                            label="Extract"
                            description="Primary provider for URL content extraction."
                            providers={EXTRACT_PROVIDERS}
                            primaryKey="extract_provider_primary"
                            secondaryKey="extract_provider_secondary"
                            retriesKey="extract_max_retries"
                            settings={settings}
                            setSetting={setSetting}
                            testStates={testStates}
                            onTest={testProvider}
                        />

                        {/* Image Providers */}
                        <ProviderRow
                            icon={<ImageIcon className="h-4 w-4 text-primary" />}
                            label="Image Generation"
                            description="KIE AI uses image-to-image editing. Gemini 2.5 Flash uses chat completions."
                            providers={IMAGE_PROVIDERS}
                            primaryKey="image_provider_primary"
                            secondaryKey="image_provider_secondary"
                            retriesKey="image_max_retries"
                            settings={settings}
                            setSetting={setSetting}
                            testStates={testStates}
                            onTest={testProvider}
                        />

                        <div className="flex items-center gap-3 pt-2 border-t">
                            <Button onClick={saveSettings} disabled={saveStatus === "saving" || !isDirty} className="flex-1">
                                {saveStatus === "saving" ? "Saving…" : isDirty ? "Save Provider Settings" : "No Changes"}
                            </Button>
                            {saveStatus === "saved" && <span className="flex items-center gap-1 text-sm text-green-600 font-medium"><CheckCircle2 className="h-4 w-4" />Saved</span>}
                            {saveStatus === "error" && <span className="flex items-center gap-1 text-sm text-red-600 font-medium"><XCircle className="h-4 w-4" />Error</span>}
                        </div>
                    </div>
                </section>

                {/* Queue Preview + Manual Trigger */}
                <section className="rounded-xl border bg-card shadow-sm">
                    <div className="p-4 border-b flex items-center gap-2">
                        <Activity className="h-4 w-4 text-primary" />
                        <h2 className="font-semibold">Current Queue</h2>
                        <span className="ml-auto text-xs text-muted-foreground">Next {batchSize} pending articles (FIFO)</span>
                        <Button
                            onClick={resetStuckArticles}
                            size="sm" variant="outline"
                            className="ml-2 border-yellow-500 text-yellow-600 hover:bg-yellow-50"
                            title="Revert all Processing articles back to Pending"
                        >
                            Reset Stuck
                        </Button>
                        <Button
                            onClick={fireAgent}
                            size="sm" className="ml-2"
                            disabled={queue.length === 0}
                        >
                            <Play className="mr-2 h-3.5 w-3.5" />
                            Start Agent ({Math.min(queue.length, batchSize)} articles)
                        </Button>
                    </div>
                    <div className="divide-y">
                        {queue.length === 0 && (
                            <div className="p-6 text-center text-muted-foreground text-sm">
                                No pending articles. Run the feeder to populate the queue.
                            </div>
                        )}
                        {queue.slice(0, batchSize).map((art, i) => (
                            <div key={art.id} className="p-4 flex items-start gap-3">
                                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold shrink-0">
                                    {i + 1}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="font-medium text-sm truncate">{art.title}</p>
                                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{art.description}</p>
                                    <div className="flex items-center gap-2 mt-1">
                                        <span className="text-xs text-muted-foreground">{art.source_domain}</span>
                                        <span className="text-xs text-muted-foreground">·</span>
                                        <span className="text-xs text-muted-foreground">
                                            {new Date(art.created_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} PKT
                                        </span>
                                    </div>
                                </div>
                                <StatusBadge status={art.status} />
                                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                            </div>
                        ))}
                    </div>
                </section>

                {/* Recent Articles */}
                <section className="rounded-xl border bg-card shadow-sm">
                    <div className="p-4 border-b flex items-center gap-2">
                        <List className="h-4 w-4 text-muted-foreground" />
                        <h2 className="font-semibold">Recent Articles</h2>
                        <span className="ml-auto text-xs text-muted-foreground">Last 30 articles (all statuses)</span>
                    </div>
                    <div className="divide-y max-h-96 overflow-auto">
                        {allArticles.length === 0 && <div className="p-6 text-center text-muted-foreground text-sm">No articles yet.</div>}
                        {allArticles.map(art => (
                            <div key={art.id} className="p-3 flex items-center gap-3">
                                <StatusBadge status={art.status} />
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium truncate">{art.title}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {art.source_domain} · {new Date(art.created_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} PKT
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            </main>
        </div>
    );
}

// -- ProviderRow sub-component -------------------------------------------------

type ProviderOption = { value: string; label: string; badge: string };

function ProviderRow({
    icon, label, description, providers,
    primaryKey, secondaryKey, retriesKey,
    settings, setSetting, testStates, onTest,
}: {
    icon: React.ReactNode;
    label: string;
    description: string;
    providers: ProviderOption[];
    primaryKey: string;
    secondaryKey: string;
    retriesKey: string;
    settings: Record<string, string>;
    setSetting: (k: string, v: string) => void;
    testStates: Record<string, TestState>;
    onTest: (p: ProviderId) => void;
}) {
    const hasSameProviders = settings[primaryKey] === settings[secondaryKey];
    return (
        <div className="space-y-3 p-4 rounded-lg border bg-muted/20">
            <div className="flex items-center gap-2">
                {icon}
                <span className="font-semibold text-sm">{label}</span>
                <span className="text-xs text-muted-foreground ml-1">{description}</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
                <ProviderSelector role="Primary" settingKey={primaryKey} providers={providers} settings={settings} setSetting={setSetting} testStates={testStates} onTest={onTest} />
                <ProviderSelector role="Fallback" settingKey={secondaryKey} providers={providers} settings={settings} setSetting={setSetting} testStates={testStates} onTest={onTest} />
            </div>
            {hasSameProviders && (
                <p className="text-xs text-orange-500 flex items-center gap-1">
                    <XCircle className="h-3 w-3" />Primary and Fallback must be different providers.
                </p>
            )}
            <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground shrink-0">Max retries per provider:</label>
                <div className="flex gap-1">
                    {["1","2","3","4","5"].map(n => (
                        <button key={n} onClick={() => setSetting(retriesKey, n)}
                            className={`w-8 h-7 rounded border text-xs font-semibold transition-all ${settings[retriesKey] === n ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted hover:bg-accent"}`}
                        >{n}</button>
                    ))}
                </div>
            </div>
        </div>
    );
}

function ProviderSelector({
    role, settingKey, providers, settings, setSetting, testStates, onTest,
}: {
    role: string;
    settingKey: string;
    providers: ProviderOption[];
    settings: Record<string, string>;
    setSetting: (k: string, v: string) => void;
    testStates: Record<string, TestState>;
    onTest: (p: ProviderId) => void;
}) {
    const currentValue = settings[settingKey];
    const ts: TestState = testStates[currentValue] ?? { status: "idle" };
    return (
        <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">{role}</label>
            <select value={currentValue} onChange={e => setSetting(settingKey, e.target.value)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary">
                {providers.map(p => <option key={p.value} value={p.value}>{p.label} ({p.badge})</option>)}
            </select>
            <button onClick={() => onTest(currentValue as ProviderId)} disabled={ts.status === "testing"}
                className={`w-full flex items-center justify-center gap-1.5 h-8 rounded-md border text-xs font-medium transition-all ${ts.status === "ok" ? "border-green-400 bg-green-50 text-green-700" : ts.status === "error" ? "border-red-400 bg-red-50 text-red-700" : ts.status === "testing" ? "border-primary bg-primary/5 text-primary" : "border-border bg-muted hover:bg-accent text-muted-foreground"}`}>
                {ts.status === "testing" && <Loader2 className="h-3 w-3 animate-spin" />}
                {ts.status === "ok"      && <CheckCircle2 className="h-3 w-3" />}
                {ts.status === "error"   && <XCircle className="h-3 w-3" />}
                {ts.status === "idle"    && <FlaskConical className="h-3 w-3" />}
                {ts.status === "testing" ? "Testing..." : ts.status === "ok" ? `${ts.latency}ms OK` : ts.status === "error" ? (ts.error?.substring(0, 28) ?? "Error") : "Test API"}
            </button>
        </div>
    );
}
