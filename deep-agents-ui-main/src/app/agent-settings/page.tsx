"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Zap, Home, Settings, RefreshCw, Play,
    Clock, List, ChevronRight, Activity, AlarmClock, CheckCircle2, XCircle, Timer,
    Search, FileText, ImageIcon, FlaskConical, Loader2, Bot, Plus, Cpu,
    KeyRound, Shield, ChevronDown, ChevronUp,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────
interface Article { id: string; title: string; description: string; url: string; source_domain: string; status: string; created_at: string; }
interface ProviderMeta { id: string; label: string; badgeColor: string; keySet: boolean; defaultModels: { value: string; label: string; badge: string }[]; }
type TestStatus = "idle" | "testing" | "ok" | "error";
type TestState = { status: TestStatus; latency?: number; error?: string };
type ProviderId = "linkup" | "parallel" | "tavily" | "exa" | "kie" | "gemini_flash";

// ── Supabase setting keys (non-secret only — no API keys!) ─────────────────────
const AGENT_SETTING_KEYS = [
    "queue_batch_size", "auto_trigger_enabled", "auto_trigger_interval_minutes", "auto_trigger_last_at",
    "search_provider_primary", "search_provider_secondary", "search_max_retries",
    "extract_provider_primary", "extract_provider_secondary", "extract_max_retries",
    "image_provider_primary", "image_provider_secondary", "image_max_retries",
    // AI Model selection (provider name + model name — NO API keys)
    "main_agent_provider", "main_agent_model",
    "analyzer_provider", "analyzer_model",
    "feeder_provider", "feeder_model",
    // Subagent model selection
    "research_subagent_provider", "research_subagent_model",
    "content_subagent_provider", "content_subagent_model",
    // Custom model lists per agent (stored as JSON)
    "custom_models",
];

const DEFAULTS: Record<string, string> = {
    queue_batch_size: "2",
    auto_trigger_enabled: "false",
    auto_trigger_interval_minutes: "30",
    auto_trigger_last_at: "",
    last_trigger_at: "",
    search_provider_primary: "linkup",
    search_provider_secondary: "parallel",
    search_max_retries: "3",
    extract_provider_primary: "tavily",
    extract_provider_secondary: "exa",
    extract_max_retries: "3",
    image_provider_primary: "kie",
    image_provider_secondary: "gemini_flash",
    image_max_retries: "2",
    main_agent_provider: "vercel",
    main_agent_model: "xiaomi/mimo-v2.5-pro",
    analyzer_provider: "vercel",
    analyzer_model: "moonshotai/kimi-k2.5",
    feeder_provider: "vercel",
    feeder_model: "minimax/minimax-m2.7",
    // Subagents — default to same model as main agent
    research_subagent_provider: "vercel",
    research_subagent_model: "xiaomi/mimo-v2.5-pro",
    content_subagent_provider: "vercel",
    content_subagent_model: "xiaomi/mimo-v2.5-pro",
    // Custom model lists — stored as JSON, never undefined
    custom_models: "{\"main_agent\":[],\"analyzer\":[],\"feeder\":[],\"research_subagent\":[],\"content_subagent\":[]}",
};

// ── Search / Extract / Image providers ────────────────────────────────────────
const SEARCH_PROVIDERS = [
    { value: "linkup", label: "Linkup", badge: "Standard" },
    { value: "parallel", label: "Parallel AI", badge: "Agentic" },
];
const EXTRACT_PROVIDERS = [
    { value: "tavily", label: "Tavily", badge: "Extract" },
    { value: "exa", label: "Exa AI", badge: "Contents" },
];
const IMAGE_PROVIDERS = [
    { value: "kie", label: "KIE AI", badge: "Image-to-Image" },
    { value: "gemini_flash", label: "Gemini 2.5 Flash", badge: "Chat Completion" },
];

// ── Per-agent config ───────────────────────────────────────────────────────────
const AGENT_CONFIGS = [
    {
        key: "main_agent",
        label: "Main Agent",
        description: "Manager: planning, synthesis, WP, DB",
        icon: <Bot className="h-4 w-4 text-primary" />,
        providerKey: "main_agent_provider",
        modelKey: "main_agent_model",
    },
    {
        key: "analyzer",
        label: "Gemini Analyzer",
        description: "Image scanning & visual analysis",
        icon: <ImageIcon className="h-4 w-4 text-violet-500" />,
        providerKey: "analyzer_provider",
        modelKey: "analyzer_model",
    },
    {
        key: "feeder",
        label: "Feeder Agent",
        description: "Article deduplication",
        icon: <Cpu className="h-4 w-4 text-emerald-500" />,
        providerKey: "feeder_provider",
        modelKey: "feeder_model",
    },
    {
        key: "research_subagent",
        label: "Research Subagent",
        description: "Web search & extraction (Step 4)",
        icon: <Search className="h-4 w-4 text-blue-500" />,
        providerKey: "research_subagent_provider",
        modelKey: "research_subagent_model",
    },
    {
        key: "content_subagent",
        label: "Content Subagent",
        description: "Blog, social posts & images (Steps 6-7)",
        icon: <FileText className="h-4 w-4 text-orange-500" />,
        providerKey: "content_subagent_provider",
        modelKey: "content_subagent_model",
    },
];

const INTERVALS = [
    { label: "10 min", value: "10" },
    { label: "30 min", value: "30" },
    { label: "1 hour", value: "60" },
    { label: "2 hours", value: "120" },
    { label: "4 hours", value: "240" },
];
const BATCH_SIZES = ["1", "2", "5", "10", "15", "20"];

// ── Helper components ──────────────────────────────────────────────────────────
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

function KeyStatusPill({ keySet }: { keySet: boolean }) {
    return keySet ? (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700 border border-green-200">
            <CheckCircle2 className="h-2.5 w-2.5" />KEY SET
        </span>
    ) : (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-500 border border-gray-200">
            <XCircle className="h-2.5 w-2.5" />NOT SET
        </span>
    );
}

// ── Main Page ──────────────────────────────────────────────────────────────────
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

    // Provider registry from /api/provider-status
    const [providerRegistry, setProviderRegistry] = useState<ProviderMeta[]>([]);
    const [providersLoading, setProvidersLoading] = useState(true);

    // Per-agent custom model input
    const [customModelInputs, setCustomModelInputs] = useState<Record<string, string>>({});
    // Global custom models keyed by PROVIDER id (not agent key)
    // e.g. { vercel: [{value,label,badge},...], novita: [...] }
    const [extraModels, setExtraModels] = useState<Record<string, { value: string; label: string; badge: string }[]>>({});
    const [modelTestStates, setModelTestStates] = useState<Record<string, TestState>>({});
    const [testStates, setTestStates] = useState<Record<string, TestState>>({});
    const [reloadStatus, setReloadStatus] = useState<"idle" | "reloading" | "done" | "error">("idle");
    const [reloadMsg, setReloadMsg] = useState("");

    // Collapsible "add custom model" per agent card
    const [showCustomInput, setShowCustomInput] = useState<Record<string, boolean>>({});;

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

    // Fetch provider registry (key status + model lists)
    const loadProviderRegistry = useCallback(async () => {
        setProvidersLoading(true);
        try {
            const resp = await fetch("/api/provider-status");
            const data = await resp.json();
            setProviderRegistry(data.providers ?? []);
        } catch {
            console.error("Failed to load provider registry");
        } finally {
            setProvidersLoading(false);
        }
    }, []);

    // Dirty tracking
    useEffect(() => {
        const dirty = AGENT_SETTING_KEYS
            .filter(k => k !== "auto_trigger_last_at" && k !== "last_trigger_at")
            .some(k => settings[k] !== dbSettings[k]);
        setIsDirty(dirty);
    }, [settings, dbSettings]);

    // Auto-trigger countdown
    useEffect(() => {
        const enabled = settings.auto_trigger_enabled === "true";
        const lastAt = settings.auto_trigger_last_at;
        if (!enabled || !lastAt) { setNextTriggerIn(null); setNextTriggerAt(null); return; }
        const intervalMs = parseInt(settings.auto_trigger_interval_minutes || "30", 10) * 60_000;
        const targetTime = new Date(lastAt).getTime() + intervalMs;
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

            // Load persisted custom models from Supabase (now keyed by provider)
            const rawCustomModels = loaded["custom_models"];
            if (rawCustomModels) {
                try {
                    const parsed = JSON.parse(rawCustomModels) as Record<string, { value: string; label: string; badge: string }[]>;
                    setExtraModels(parsed);
                } catch {
                    console.warn("Failed to parse custom_models from Supabase");
                }
            }
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadAll(); loadProviderRegistry(); }, [loadAll, loadProviderRegistry]);

    const setSetting = (key: string, value: string) => setSettings(p => ({ ...p, [key]: value }));

    // ── Test search/extract/image provider ─────────────────────────────────────
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
        } catch {
            setTestStates(prev => ({ ...prev, [provider]: { status: "error", error: "Network error" } }));
        }
        setTimeout(() => setTestStates(prev => ({ ...prev, [provider]: { status: "idle" } })), 8000);
    };

    // ── Test AI model (env-key resolved server-side) ───────────────────────────
    const testAiModel = async (agentKey: string) => {
        const provider = settings[`${agentKey}_provider`] || "vercel";
        const model = settings[`${agentKey}_model`] || "";
        const testKey = `${agentKey}_model`;
        setModelTestStates(prev => ({ ...prev, [testKey]: { status: "testing" } }));
        try {
            const resp = await fetch("/api/test-ai-model", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // No apiKey sent — server resolves from env
                body: JSON.stringify({ provider, model }),
            });
            const data = await resp.json();
            if (data.success) {
                setModelTestStates(prev => ({ ...prev, [testKey]: { status: "ok", latency: data.latency_ms } }));
            } else {
                setModelTestStates(prev => ({ ...prev, [testKey]: { status: "error", error: data.error } }));
            }
        } catch {
            setModelTestStates(prev => ({ ...prev, [testKey]: { status: "error", error: "Network error" } }));
        }
        setTimeout(() => setModelTestStates(prev => ({ ...prev, [testKey]: { status: "idle" } })), 25000);
    };

    // ── Test custom model ──────────────────────────────────────────────────────
    const testCustomModel = async (agentKey: string) => {
        const providerId = settings[`${agentKey}_provider`] || "vercel";
        const customModel = customModelInputs[providerId]?.trim();
        if (!customModel) return;
        const testKey = `${agentKey}_custom`;
        setModelTestStates(prev => ({ ...prev, [testKey]: { status: "testing" } }));
        try {
            const resp = await fetch("/api/test-ai-model", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ provider: providerId, model: customModel }),
            });
            const data = await resp.json();
            if (data.success) {
                setModelTestStates(prev => ({ ...prev, [testKey]: { status: "ok", latency: data.latency_ms } }));
            } else {
                setModelTestStates(prev => ({ ...prev, [testKey]: { status: "error", error: data.error } }));
            }
        } catch {
            setModelTestStates(prev => ({ ...prev, [testKey]: { status: "error", error: "Network error" } }));
        }
        setTimeout(() => setModelTestStates(prev => ({ ...prev, [testKey]: { status: "idle" } })), 25000);
    };

    const addCustomModel = async (agentKey: string) => {
        const providerId = settings[`${agentKey}_provider`] || "vercel";
        const customModel = customModelInputs[providerId]?.trim();
        if (!customModel) return;
        const label = customModel.split("/").pop() ?? customModel;
        const newModel = { value: customModel, label, badge: "Custom" };

        const updatedModels = {
            ...extraModels,
            [providerId]: [
                ...(extraModels[providerId] || []).filter(m => m.value !== customModel),
                newModel,
            ],
        };

        setExtraModels(updatedModels);
        setSetting(`${agentKey}_model`, customModel);
        setCustomModelInputs(prev => ({ ...prev, [providerId]: "" }));

        // Persist the full per-provider custom models map to Supabase immediately
        await supabase.from("agent_settings").upsert(
            { key: "custom_models", value: JSON.stringify(updatedModels), updated_at: new Date().toISOString() },
            { onConflict: "key" }
        );
    };

    // ── Save settings ──────────────────────────────────────────────────────────
    const saveSettings = async () => {
        setSaveStatus("saving");
        const keysToSave = [
            "queue_batch_size", "auto_trigger_enabled", "auto_trigger_interval_minutes",
            "search_provider_primary", "search_provider_secondary", "search_max_retries",
            "extract_provider_primary", "extract_provider_secondary", "extract_max_retries",
            "image_provider_primary", "image_provider_secondary", "image_max_retries",
            "main_agent_provider", "main_agent_model",
            "analyzer_provider", "analyzer_model",
            "feeder_provider", "feeder_model",
            "research_subagent_provider", "research_subagent_model",
            "content_subagent_provider", "content_subagent_model",
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

    const reloadAgent = async () => {
        setReloadStatus("reloading");
        setReloadMsg("Triggering langgraph reload...");
        try {
            const resp = await fetch("/api/reload-agent", { method: "POST" });
            const data = await resp.json();
            if (data.success) {
                setReloadStatus("done");
                setReloadMsg(`✓ Reloaded: ${data.touched.join(", ")}. Agents will use new config in ~5s.`);
            } else {
                setReloadStatus("error");
                setReloadMsg(data.message || "Reload failed.");
            }
        } catch {
            setReloadStatus("error");
            setReloadMsg("Could not reach /api/reload-agent.");
        }
        setTimeout(() => { setReloadStatus("idle"); setReloadMsg(""); }, 8000);
    };

    const saveAndReload = async () => {
        await saveSettings();
        await reloadAgent();
    };

    const toggleAutoTrigger = async () => {
        const next = settings.auto_trigger_enabled === "true" ? "false" : "true";
        const now = new Date().toISOString();
        setSetting("auto_trigger_enabled", next);
        const upserts: { key: string; value: string; updated_at: string }[] = [
            { key: "auto_trigger_enabled", value: next, updated_at: now },
        ];
        if (next === "true") {
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

    const getProviderMeta = (id: string): ProviderMeta | undefined =>
        providerRegistry.find(p => p.id === id);

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
                                        <button key={n} onClick={() => setSetting("queue_batch_size", n)}
                                            className={`w-12 h-10 rounded-lg border text-sm font-semibold transition-all
                                                ${settings.queue_batch_size === n
                                                    ? "border-primary bg-primary text-primary-foreground shadow"
                                                    : "border-border bg-muted hover:bg-accent"}`}
                                        >{n}</button>
                                    ))}
                                    <Input type="number" min={1} max={30} className="h-10 w-20 text-sm"
                                        value={settings.queue_batch_size}
                                        onChange={e => setSetting("queue_batch_size", e.target.value)} />
                                </div>
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

                    <section className="rounded-xl border bg-card shadow-sm">
                        <div className="p-4 border-b flex items-center gap-2">
                            <AlarmClock className="h-4 w-4 text-primary" />
                            <h2 className="font-semibold">Auto-Trigger Schedule</h2>
                        </div>
                        <div className="p-5 space-y-4">
                            <div className="flex items-center justify-between p-4 rounded-lg border bg-muted/30">
                                <div>
                                    <p className="text-sm font-medium">Auto-Trigger</p>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                        {autoEnabled ? "Agent runs automatically on schedule" : "Only runs when fired manually"}
                                    </p>
                                </div>
                                <button onClick={toggleAutoTrigger}
                                    className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${autoEnabled ? "bg-primary" : "bg-muted-foreground/30"}`}>
                                    <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${autoEnabled ? "translate-x-6" : "translate-x-1"}`} />
                                </button>
                            </div>
                            <div className={autoEnabled ? "" : "opacity-50 pointer-events-none"}>
                                <div className="flex items-center justify-between mb-1">
                                    <label className="text-sm font-medium">Trigger Interval</label>
                                    <span className="text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">every {settings.auto_trigger_interval_minutes}min</span>
                                </div>
                                <div className="flex gap-2 flex-wrap mb-2">
                                    {INTERVALS.map(iv => (
                                        <button key={iv.value} onClick={() => setSetting("auto_trigger_interval_minutes", iv.value)}
                                            className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all
                                                ${settings.auto_trigger_interval_minutes === iv.value
                                                    ? "border-primary bg-primary text-primary-foreground"
                                                    : "border-border bg-muted hover:bg-accent"}`}
                                        >{iv.label}</button>
                                    ))}
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
                        </div>
                    </section>
                </div>

                <section className="rounded-xl border bg-card shadow-sm overflow-hidden">
                    <div className="p-4 border-b flex items-center gap-2 bg-gradient-to-r from-primary/5 to-violet-500/5">
                        <Cpu className="h-4 w-4 text-primary" />
                        <h2 className="font-semibold">AI Model Config</h2>
                        <span className="ml-auto text-xs text-muted-foreground">Provider & model per agent — keys from .env only</span>
                        <Button size="sm" variant="outline" className="ml-2 h-7 text-xs" onClick={loadProviderRegistry} disabled={providersLoading}>
                            <RefreshCw className={`h-3 w-3 mr-1 ${providersLoading ? "animate-spin" : ""}`} />Refresh Keys
                        </Button>
                    </div>

                    <div className="p-5 space-y-6">
                        <div className="rounded-lg border bg-muted/20 p-4">
                            <div className="flex items-center gap-2 mb-3">
                                <Shield className="h-4 w-4 text-primary" />
                                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Provider Key Status</p>
                                <p className="text-xs text-muted-foreground ml-auto">Keys in .env · Never stored in DB</p>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
                                {providersLoading ? (
                                    <div className="col-span-full flex items-center gap-2 text-xs text-muted-foreground">
                                        <Loader2 className="h-3 w-3 animate-spin" />Loading providers…
                                    </div>
                                ) : (
                                    providerRegistry.map(p => (
                                        <div key={p.id} className="flex flex-col gap-1 p-2 rounded-lg border bg-background">
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs font-semibold truncate">{p.label}</span>
                                            </div>
                                            <KeyStatusPill keySet={p.keySet} />
                                        </div>
                                    ))
                                )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1">
                                <KeyRound className="h-3 w-3" />
                                To add a key: set it in <code className="bg-muted px-1 rounded">.env</code> → restart <code className="bg-muted px-1 rounded">langgraph dev</code>
                            </p>
                        </div>

                        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                            {AGENT_CONFIGS.map(agent => {
                                const currentProvider = settings[agent.providerKey] || "vercel";
                                const currentModel = settings[agent.modelKey] || "";
                                const provMeta = getProviderMeta(currentProvider);
                                const providerCustomModels = extraModels[currentProvider] || [];
                                const availableModels = [
                                    ...(provMeta?.defaultModels ?? []),
                                    ...providerCustomModels,
                                ];
                                const testKey = `${agent.key}_model`;
                                const customTestKey = `${agent.key}_custom`;
                                const ts: TestState = modelTestStates[testKey] ?? { status: "idle" };
                                const customTs: TestState = modelTestStates[customTestKey] ?? { status: "idle" };
                                const providerInputKey = currentProvider;
                                const customInput = customModelInputs[providerInputKey] || "";
                                const expanded = showCustomInput[agent.key] ?? false;

                                return (
                                    <div key={agent.key} className="rounded-lg border bg-muted/10 p-4 space-y-3 flex flex-col">
                                        <div className="flex items-center gap-2">
                                            {agent.icon}
                                            <div>
                                                <p className="text-sm font-semibold">{agent.label}</p>
                                                <p className="text-xs text-muted-foreground">{agent.description}</p>
                                            </div>
                                        </div>

                                        <div>
                                            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Provider</label>
                                            {providersLoading ? (
                                                <div className="h-9 rounded-md bg-muted animate-pulse" />
                                            ) : (
                                                <select
                                                    value={currentProvider}
                                                    onChange={e => {
                                                        const newProvider = e.target.value;
                                                        setSetting(agent.providerKey, newProvider);
                                                        const pMeta = getProviderMeta(newProvider);
                                                        const firstModel = pMeta?.defaultModels[0]?.value ?? "";
                                                        setSetting(agent.modelKey, firstModel);
                                                    }}
                                                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                                >
                                                    {providerRegistry.map(p => (
                                                        <option key={p.id} value={p.id}>
                                                            {p.label}{p.keySet ? " ✓" : " (no key)"}
                                                        </option>
                                                    ))}
                                                </select>
                                            )}
                                            {provMeta && !provMeta.keySet && (
                                                <p className="text-[10px] text-orange-500 mt-1 flex items-center gap-1">
                                                    <XCircle className="h-2.5 w-2.5" />
                                                    No key — add {currentProvider.toUpperCase()}_API_KEY to .env
                                                </p>
                                            )}
                                        </div>

                                        <div>
                                            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Model</label>
                                            <select
                                                value={currentModel}
                                                onChange={e => setSetting(agent.modelKey, e.target.value)}
                                                className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
                                            >
                                                {availableModels.map(m => (
                                                    <option key={m.value} value={m.value}>
                                                        {m.label} ({m.badge})
                                                    </option>
                                                ))}
                                            </select>
                                        </div>

                                        <button
                                            onClick={() => testAiModel(agent.key)}
                                            disabled={ts.status === "testing" || !currentModel}
                                            className={`w-full flex items-center justify-center gap-1.5 h-7 rounded-md border text-xs font-medium transition-all ${
                                                ts.status === "ok"      ? "border-green-400 bg-green-50 text-green-700"
                                                : ts.status === "error" ? "border-red-400 bg-red-50 text-red-700"
                                                : ts.status === "testing" ? "border-primary bg-primary/5 text-primary"
                                                : "border-border bg-muted hover:bg-accent text-muted-foreground"
                                            }`}
                                        >
                                            {ts.status === "testing" && <Loader2 className="h-3 w-3 animate-spin" />}
                                            {ts.status === "ok"      && <CheckCircle2 className="h-3 w-3" />}
                                            {ts.status === "error"   && <XCircle className="h-3 w-3" />}
                                            {ts.status === "idle"    && <FlaskConical className="h-3 w-3" />}
                                            {ts.status === "testing" ? "Testing…"
                                             : ts.status === "ok"    ? `${ts.latency}ms ✓`
                                             : ts.status === "error" ? (ts.error?.substring(0, 28) ?? "Error")
                                             : "Test Model"}
                                        </button>

                                        <button
                                            onClick={() => setShowCustomInput(p => ({ ...p, [agent.key]: !expanded }))}
                                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                                        >
                                            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                                            Add custom model
                                            <span className="ml-auto text-[10px] text-muted-foreground/60">global for {currentProvider}</span>
                                        </button>

                                        {expanded && (
                                            <div className="pt-1 border-t space-y-1">
                                                <p className="text-[10px] text-muted-foreground">
                                                    Models added here apply globally to ALL agents using <span className="font-semibold text-foreground">{provMeta?.label ?? currentProvider}</span>.
                                                </p>
                                                <div className="flex gap-1">
                                                    <Input
                                                        type="text"
                                                        placeholder="paste model name…"
                                                        value={customInput}
                                                        onChange={e => setCustomModelInputs(prev => ({ ...prev, [providerInputKey]: e.target.value }))}
                                                        className="h-7 text-xs flex-1 font-mono"
                                                        onKeyDown={e => { if (e.key === "Enter") testCustomModel(agent.key); }}
                                                    />
                                                    <button
                                                        onClick={() => testCustomModel(agent.key)}
                                                        disabled={!customInput || customTs.status === "testing"}
                                                        className={`h-7 px-2 rounded-md border text-xs font-medium transition-all ${
                                                            customTs.status === "ok" ? "border-green-400 bg-green-50 text-green-700"
                                                            : customTs.status === "error" ? "border-red-400 bg-red-50 text-red-700"
                                                            : "border-border bg-muted hover:bg-accent text-muted-foreground"
                                                        }`}
                                                    >
                                                        {customTs.status === "testing" ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
                                                    </button>
                                                    <button
                                                        onClick={() => addCustomModel(agent.key)}
                                                        disabled={!customInput}
                                                        title={`Add to ${provMeta?.label ?? currentProvider} globally`}
                                                        className="h-7 px-2 rounded-md border border-primary/40 bg-primary/10 hover:bg-primary/20 text-primary text-xs transition-all"
                                                    >
                                                        <Plus className="h-3 w-3" />
                                                    </button>
                                                </div>
                                                {customTs.status === "ok" && (
                                                    <p className="text-xs text-green-600 flex items-center gap-1">
                                                        <CheckCircle2 className="h-3 w-3" />{customTs.latency}ms — works! Click + to add globally.
                                                    </p>
                                                )}
                                                {customTs.status === "error" && (
                                                    <p className="text-xs text-red-500 truncate">{customTs.error}</p>
                                                )}
                                                {providerCustomModels.length > 0 && (
                                                    <div className="mt-1 space-y-0.5">
                                                        <p className="text-[10px] text-muted-foreground font-medium">Saved for {provMeta?.label ?? currentProvider}:</p>
                                                        {providerCustomModels.map(m => (
                                                            <div key={m.value} className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
                                                                <span className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0" />
                                                                <span className="truncate">{m.value}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        <div className={`mt-auto pt-2 flex items-center gap-1.5 text-xs rounded-md px-2 py-1 border ${
                                            provMeta?.keySet
                                                ? "bg-green-50 text-green-700 border-green-200"
                                                : "bg-muted text-muted-foreground border-border"
                                        }`}>
                                            <span className={`w-1.5 h-1.5 rounded-full bg-gradient-to-br ${provMeta?.badgeColor ?? "from-gray-400 to-gray-500"}`} />
                                            <span className="font-mono truncate">{currentModel || "— not set —"}</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Reload status banner */}
                        {reloadMsg && (
                            <div className={`text-xs rounded-md px-3 py-2 flex items-center gap-2 ${
                                reloadStatus === "done"    ? "bg-green-50 text-green-700 border border-green-200"
                                : reloadStatus === "error" ? "bg-red-50 text-red-600 border border-red-200"
                                : "bg-blue-50 text-blue-700 border border-blue-200"
                            }`}>
                                {reloadStatus === "reloading" && <Loader2 className="h-3 w-3 animate-spin" />}
                                {reloadMsg}
                            </div>
                        )}

                        <div className="flex items-center gap-3 pt-2 border-t">
                            <Button onClick={saveSettings} disabled={saveStatus === "saving" || !isDirty} variant="outline" className="flex-1">
                                {saveStatus === "saving" ? "Saving…" : isDirty ? "Save Config" : "No Changes"}
                            </Button>
                            <Button
                                onClick={saveAndReload}
                                disabled={saveStatus === "saving" || reloadStatus === "reloading"}
                                className="flex-1 bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-700 hover:to-blue-700 text-white"
                            >
                                {reloadStatus === "reloading" ? (
                                    <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Applying…</>
                                ) : (
                                    <><Zap className="h-3.5 w-3.5 mr-1.5" />Save & Apply to Agents</>
                                )}
                            </Button>
                            {saveStatus === "saved" && <span className="flex items-center gap-1 text-sm text-green-600 font-medium"><CheckCircle2 className="h-4 w-4" />Saved</span>}
                            {saveStatus === "error"  && <span className="flex items-center gap-1 text-sm text-red-600 font-medium"><XCircle className="h-4 w-4" />Error</span>}
                        </div>
                    </div>
                </section>

                {/* AI Providers & Fallback */}
                <section className="rounded-xl border bg-card shadow-sm">
                    <div className="p-4 border-b flex items-center gap-2">
                        <Zap className="h-4 w-4 text-primary" />
                        <h2 className="font-semibold">Search & Extract Providers</h2>
                        <span className="ml-auto text-xs text-muted-foreground">Settings cached 60s in backend</span>
                    </div>
                    <div className="p-5 space-y-6">
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

                {/* Queue Preview */}
                <section className="rounded-xl border bg-card shadow-sm">
                    <div className="p-4 border-b flex items-center gap-2">
                        <Activity className="h-4 w-4 text-primary" />
                        <h2 className="font-semibold">Current Queue</h2>
                        <span className="ml-auto text-xs text-muted-foreground">Next {batchSize} pending articles (FIFO)</span>
                        <Button onClick={resetStuckArticles} size="sm" variant="outline"
                            className="ml-2 border-yellow-500 text-yellow-600 hover:bg-yellow-50" title="Revert all Processing articles back to Pending">
                            Reset Stuck
                        </Button>
                        <Button onClick={fireAgent} size="sm" className="ml-2" disabled={queue.length === 0}>
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
                                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold shrink-0">{i + 1}</div>
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

// ── ProviderRow sub-component ─────────────────────────────────────────────────

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
