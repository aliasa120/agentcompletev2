"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { signOut } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Zap, Home, Play, List, Activity, AlarmClock, CheckCircle2, XCircle,
  Search, FileText, ImageIcon, FlaskConical, Loader2, Bot, Cpu,
  KeyRound, ChevronDown, ChevronUp, LogOut, User, Database, Settings
} from "lucide-react";
import { getConfig, saveConfig } from "@/lib/config";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { cn } from "@/lib/utils";
import { SettingsSidebar, type SettingsSection } from "@/app/components/settings/SettingsSidebar";
import { ToolsSection } from "@/app/components/settings/ToolsSection";
import { AgentsSection } from "@/app/components/settings/AgentsSection";
import { SkillsSection } from "@/app/components/settings/SkillsSection";
import { DesignAssetsSection } from "@/app/components/settings/DesignAssetsSection";
import { ProviderOrderingSection } from "@/app/components/settings/ProviderOrderingSection";
import { WorkflowsSection } from "@/app/components/settings/WorkflowsSection";

// ── Types ──────────────────────────────────────────────────────────────────────
interface Article { id: string; title: string; description: string; url: string; source_domain: string; status: string; created_at: string; }
interface ProviderMeta { id: string; label: string; badgeColor: string; keySet: boolean; defaultModels: { value: string; label: string; badge: string }[]; }
type TestStatus = "idle" | "testing" | "ok" | "error";
type TestState = { status: TestStatus; latency?: number; error?: string };
type ProviderId = string;

// ── Settings keys ──────────────────────────────────────────────────────────────
const AGENT_SETTING_KEYS = [
  "queue_batch_size", "auto_trigger_enabled", "auto_trigger_interval_minutes",
  "search_provider_primary", "search_provider_secondary", "search_max_retries",
  "extract_provider_primary", "extract_provider_secondary", "extract_max_retries",
  "image_provider_primary", "image_provider_secondary", "image_max_retries",
  "main_agent_provider", "main_agent_model",
  "analyzer_provider", "analyzer_model",
  "feeder_provider", "feeder_model",
  "research_subagent_provider", "research_subagent_model",
  "content_subagent_provider", "content_subagent_model",
  "custom_models",
  "vector_indexing_provider", "vector_indexing_model",
  "super_indexing_enabled", "normal_indexing_enabled",
];

const DEFAULTS: Record<string, string> = {
  queue_batch_size: "2",
  auto_trigger_enabled: "false",
  auto_trigger_interval_minutes: "30",
  search_provider_primary: "linkup", search_provider_secondary: "parallel", search_max_retries: "3",
  extract_provider_primary: "tavily", extract_provider_secondary: "exa", extract_max_retries: "3",
  image_provider_primary: "kie", image_provider_secondary: "gemini_flash", image_max_retries: "2",
  main_agent_provider: "vercel", main_agent_model: "xiaomi/mimo-v2.5-pro",
  analyzer_provider: "vercel", analyzer_model: "moonshotai/kimi-k2.5",
  feeder_provider: "vercel", feeder_model: "minimax/minimax-m2.7",
  research_subagent_provider: "vercel", research_subagent_model: "xiaomi/mimo-v2.5-pro",
  content_subagent_provider: "vercel", content_subagent_model: "xiaomi/mimo-v2.5-pro",
  custom_models: "{\"main_agent\":[],\"analyzer\":[],\"feeder\":[],\"research_subagent\":[],\"content_subagent\":[]}",
  vector_indexing_provider: "vercel",
  vector_indexing_model: "google/gemini-2.5-flash",
  super_indexing_enabled: "true",
  normal_indexing_enabled: "true",
};

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

// ── Status Badge ───────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, string> = {
    pending: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400",
    processing: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400",
    done: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400",
    error: "bg-destructive/5 text-destructive border-destructive/20",
  };
  return (
    <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${cfg[status] ?? "bg-muted text-muted-foreground border-border"}`}>
      {status}
    </span>
  );
}

// ── ProviderRow ────────────────────────────────────────────────────────────────
type ProviderOption = { value: string; label: string; badge: string };

function ProviderSelector({ role, settingKey, providers, settings, setSetting, testStates, onTest }: {
  role: string; settingKey: string; providers: ProviderOption[];
  settings: Record<string, string>; setSetting: (k: string, v: string) => void;
  testStates: Record<string, TestState>; onTest: (p: ProviderId) => void;
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
      <button onClick={() => onTest(currentValue)} disabled={ts.status === "testing"}
        className={`w-full flex items-center justify-center gap-1.5 h-8 rounded-md border text-xs font-medium transition-all
          ${ts.status === "ok" ? "border-emerald-400 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400"
          : ts.status === "error" ? "border-destructive/40 bg-destructive/5 text-destructive"
          : ts.status === "testing" ? "border-primary bg-primary/5 text-primary"
          : "border-border bg-muted hover:bg-accent text-muted-foreground"}`}>
        {ts.status === "testing" && <Loader2 className="h-3 w-3 animate-spin" />}
        {ts.status === "ok" && <CheckCircle2 className="h-3 w-3" />}
        {ts.status === "error" && <XCircle className="h-3 w-3" />}
        {ts.status === "idle" && <FlaskConical className="h-3 w-3" />}
        {ts.status === "testing" ? "Testing..." : ts.status === "ok" ? `${ts.latency}ms OK` : ts.status === "error" ? (ts.error?.substring(0, 28) ?? "Error") : "Test API"}
      </button>
    </div>
  );
}

function ProviderRow({ icon, label, description, providers, primaryKey, secondaryKey, retriesKey, settings, setSetting, testStates, onTest }: {
  icon: React.ReactNode; label: string; description: string; providers: ProviderOption[];
  primaryKey: string; secondaryKey: string; retriesKey: string;
  settings: Record<string, string>; setSetting: (k: string, v: string) => void;
  testStates: Record<string, TestState>; onTest: (p: ProviderId) => void;
}) {
  const hasSameProviders = settings[primaryKey] === settings[secondaryKey];
  return (
    <div className="space-y-3 p-4 rounded-lg border bg-muted/20">
      <div className="flex items-center gap-2">
        {icon}<span className="font-semibold text-sm">{label}</span>
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
        <label className="text-xs text-muted-foreground shrink-0">Max retries:</label>
        <div className="flex gap-1">
          {["1","2","3","4","5"].map(n => (
            <button key={n} onClick={() => setSetting(retriesKey, n)}
              className={`w-8 h-7 rounded border text-xs font-semibold transition-all
                ${settings[retriesKey] === n ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted hover:bg-accent"}`}>
              {n}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main Settings Page ────────────────────────────────────────────────────────

export default function AgentSettingsPage() {
  const [section, setSection] = useState<SettingsSection>("workflows");
  const [settings, setSettings] = useState<Record<string, string>>(DEFAULTS);
  const [initialSettings, setInitialSettings] = useState<Record<string, string>>(DEFAULTS);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [isDirty, setIsDirty] = useState(false);
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});
  const [reloadMsg, setReloadMsg] = useState("");
  const [reloadStatus, setReloadStatus] = useState<"idle" | "reloading" | "done" | "error">("idle");
  const [queue, setQueue] = useState<Article[]>([]);
  const [allArticles, setAllArticles] = useState<Article[]>([]);
  const [batchSize, setBatchSizeState] = useState(2);
  const [skills, setSkills] = useState<{ id: string; skill_key: string; label: string; description: string }[]>([]);
  const [mcpConnections, setMcpConnections] = useState<{ id: string; label: string; toolkit_slug: string; connection_type: string; status: string; available_tools: { tool_key: string; tool_name: string }[] }[]>([]);
  const [toolSettings, setToolSettings] = useState<{ id: string; connection_id: string; tool_key: string; tool_name: string; enabled: boolean }[]>([]);
  const [userEmail, setUserEmail] = useState<string>("");
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(true);

  // ── Configuration settings logic ──
  const [configUrl, setConfigUrl] = useState("");
  const [configAssistantId, setConfigAssistantId] = useState("");
  const [configApiKey, setConfigApiKey] = useState("");
  const [configSaveStatus, setConfigSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    if (section === "configuration") {
      const savedConfig = getConfig();
      if (savedConfig) {
        setConfigUrl(savedConfig.deploymentUrl);
        setConfigAssistantId(savedConfig.assistantId);
        setConfigApiKey(savedConfig.langsmithApiKey || "");
      }
    }
  }, [section]);

  const saveConfiguration = () => {
    if (!configUrl || !configAssistantId) {
      alert("Please fill in all required fields");
      return;
    }
    setConfigSaveStatus("saving");
    try {
      saveConfig({
        deploymentUrl: configUrl,
        assistantId: configAssistantId,
        langsmithApiKey: configApiKey || undefined,
      });
      setConfigSaveStatus("saved");
      setTimeout(() => setConfigSaveStatus("idle"), 3000);
    } catch {
      setConfigSaveStatus("error");
    }
  };

  // ── Feeder Dashboard logic ──
  const [feederStats, setFeederStats] = useState({ pending: 0, processing: 0, done: 0, total: 0 });
  const [feederPendingArticles, setFeederPendingArticles] = useState<any[]>([]);
  const [feederIsFetching, setFeederIsFetching] = useState(false);
  const [feederPipelineLog, setFeederPipelineLog] = useState<string>("");

  const loadFeederData = useCallback(async () => {
    try {
      const [pendRes, procRes, doneRes, artRes] = await Promise.all([
        supabase.from("feeder_articles").select("id", { count: "exact", head: true }).eq("status", "Pending"),
        supabase.from("feeder_articles").select("id", { count: "exact", head: true }).eq("status", "Processing"),
        supabase.from("feeder_articles").select("id", { count: "exact", head: true }).eq("status", "Done"),
        supabase.from("feeder_articles").select("id", { count: "exact", head: true }),
      ]);
      setFeederStats({
        pending: pendRes.count ?? 0,
        processing: procRes.count ?? 0,
        done: doneRes.count ?? 0,
        total: artRes.count ?? 0,
      });

      const { data } = await supabase
        .from("feeder_articles")
        .select("id,title,source_domain,published_at,created_at,url")
        .eq("status", "Pending")
        .order("created_at", { ascending: true })
        .limit(50);
      setFeederPendingArticles(data ?? []);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const triggerFeederPipeline = async () => {
    setFeederIsFetching(true);
    setFeederPipelineLog("Running pipeline…");
    try {
      const res = await fetch("/api/feeder/run", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setFeederPipelineLog(data.log || "Pipeline ran successfully.");
      } else {
        setFeederPipelineLog("Error: " + data.error);
      }
    } catch (e: any) {
      setFeederPipelineLog("Error: " + e.message);
    } finally {
      setFeederIsFetching(false);
      loadFeederData();
    }
  };

  const clearFeederPending = async () => {
    if (!confirm("Delete all Pending articles?")) return;
    await supabase.from("feeder_articles").delete().eq("status", "Pending");
    loadFeederData();
  };

  useEffect(() => {
    if (section === "feeder") {
      loadFeederData();
    }
  }, [section, loadFeederData]);

  const ConfigurationSection = () => (
    <div className="space-y-5">
      <h2 className="font-semibold text-lg">API Configuration</h2>
      <section className="rounded-xl border bg-card shadow-sm p-6 space-y-4">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Configure your LangGraph deployment settings. These settings are saved in your browser's local storage.
        </p>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="configUrl" className="text-xs font-semibold">Deployment URL</Label>
            <Input
              id="configUrl"
              placeholder="https://<deployment-url>"
              value={configUrl}
              onChange={(e) => setConfigUrl(e.target.value)}
              className="h-10 text-sm"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="configAssistantId" className="text-xs font-semibold">Assistant ID</Label>
            <Input
              id="configAssistantId"
              placeholder="<assistant-id>"
              value={configAssistantId}
              onChange={(e) => setConfigAssistantId(e.target.value)}
              className="h-10 text-sm"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="configApiKey" className="text-xs font-semibold">
              LangSmith API Key <span className="text-muted-foreground font-normal">(Optional)</span>
            </Label>
            <Input
              id="configApiKey"
              type="password"
              placeholder="lsv2_pt_..."
              value={configApiKey}
              onChange={(e) => setConfigApiKey(e.target.value)}
              className="h-10 text-sm"
            />
          </div>
        </div>
        <div className="flex items-center gap-3 pt-4 border-t">
          <Button onClick={saveConfiguration} disabled={configSaveStatus === "saving"} className="bg-primary text-primary-foreground">
            {configSaveStatus === "saving" ? "Saving..." : "Save Configuration"}
          </Button>
          {configSaveStatus === "saved" && <span className="text-xs font-semibold text-emerald-500 animate-pulse">Saved successfully!</span>}
        </div>
      </section>
    </div>
  );

  const FeederDashboardSection = () => {
    const formatPKT = (iso: string | null): string => {
      if (!iso) return "—";
      const d = new Date(iso);
      return d.toLocaleString("en-PK", {
        timeZone: "Asia/Karachi",
        month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
        hour12: false,
      });
    };

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-lg">Feeder Dashboard</h2>
          <div className="flex gap-2">
            <Link href="/feeder">
              <Button variant="outline" size="sm" className="text-xs flex items-center gap-1.5 hover:bg-accent/40 transition-colors">
                <Database className="h-3.5 w-3.5" />
                Go to Feeder Page
              </Button>
            </Link>
            <Button
              onClick={triggerFeederPipeline}
              disabled={feederIsFetching}
              size="sm"
              className="bg-primary text-primary-foreground text-xs"
            >
              {feederIsFetching ? "Running..." : "Run Feeder"}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={clearFeederPending}
              disabled={feederIsFetching}
              className="text-xs"
            >
              Clear Pending
            </Button>
            <Button variant="outline" size="sm" onClick={loadFeederData} className="text-xs">
              Refresh
            </Button>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
          {[
            { label: "Pending", value: feederStats.pending, color: "text-amber-500", bg: "bg-amber-50 dark:bg-amber-950/20", sub: "In queue" },
            { label: "Processing", value: feederStats.processing, color: "text-primary", bg: "bg-primary/10", sub: "With agent" },
            { label: "Done", value: feederStats.done, color: "text-emerald-600", bg: "bg-emerald-50 dark:bg-emerald-950/20", sub: "Completed" },
            { label: "Total", value: feederStats.total, color: "text-muted-foreground", bg: "bg-muted", sub: "All articles" },
          ].map(({ label, value, color, bg, sub }) => (
            <div key={label} className="rounded-xl border border-border bg-card p-4 flex flex-col gap-1 shadow-sm">
              <span className="text-xs text-muted-foreground font-semibold">{label}</span>
              <span className={`text-2xl font-bold ${color}`}>{value}</span>
              <span className="text-[10px] text-muted-foreground">{sub}</span>
            </div>
          ))}
        </div>

        {/* Pipeline log */}
        {feederPipelineLog && (
          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
              Last Pipeline Output
            </p>
            <pre className="text-xs whitespace-pre-wrap text-foreground font-mono max-h-48 overflow-auto bg-muted/20 p-3 rounded-lg border">
              {feederPipelineLog}
            </pre>
          </div>
        )}

        {/* Pending articles list */}
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="p-4 border-b bg-muted/10 flex items-center justify-between">
            <span className="font-semibold text-sm">Pending Articles</span>
            <span className="text-xs text-muted-foreground">{feederStats.pending} ready · FIFO order</span>
          </div>
          <div className="divide-y max-h-[380px] overflow-auto">
            {feederPendingArticles.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm">
                No pending articles. Run the feeder pipeline to fetch new ones.
              </div>
            ) : (
              feederPendingArticles.map((art, i) => (
                <div key={art.id} className="flex items-start gap-3 p-3 hover:bg-muted/40 transition-colors">
                  <span className="text-xs text-muted-foreground w-5 shrink-0 mt-0.5">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <a
                      href={art.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-foreground hover:text-primary hover:underline line-clamp-2 transition-colors"
                    >
                      {art.title}
                    </a>
                    <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground">
                      <span>{art.source_domain}</span>
                      <span>·</span>
                      <span>{formatPKT(art.published_at || art.created_at)}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    );
  };

  // Load session
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUserEmail(data.user.email ?? "");
    });
  }, []);

  // Load settings
  const loadSettings = useCallback(async () => {
    try {
      let { data, error } = await supabase.from("agent_settings").select("key,value");
      if (error) {
        if (error.code === "PGRST303" || error.message?.includes("JWT expired")) {
          console.warn("JWT expired. Cleaning session and retrying loadSettings...");
          await supabase.auth.signOut().catch(() => {});
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.includes("-auth-token")) {
              localStorage.removeItem(key);
            }
          }
          const retry = await supabase.from("agent_settings").select("key,value");
          data = retry.data;
          if (retry.error) {
            console.error("Error loading settings after retry:", retry.error);
          }
        } else {
          console.error("Error loading settings:", error);
        }
      }
      if (data?.length) {
        const m: Record<string, string> = { ...DEFAULTS };
        for (const { key, value } of data) m[key] = value;
        setSettings(m);
        setInitialSettings(m);
      }
    } catch { /* use defaults */ }
  }, []);

  // Load queue
  const loadQueue = useCallback(async () => {
    let { data, error } = await supabase.from("feeder_articles").select("*").eq("status", "Pending")
      .order("created_at", { ascending: true });
    if (error) {
      if (error.code === "PGRST303" || error.message?.includes("JWT expired")) {
        console.warn("JWT expired. Cleaning session and retrying loadQueue...");
        await supabase.auth.signOut().catch(() => {});
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.includes("-auth-token")) {
            localStorage.removeItem(key);
          }
        }
        const retry = await supabase.from("feeder_articles").select("*").eq("status", "Pending")
          .order("created_at", { ascending: true });
        data = retry.data;
        if (retry.error) {
          console.error("Error loading queue after retry:", retry.error);
        }
      } else {
        console.error("Error loading queue:", error);
      }
    }
    setQueue(data ?? []);

    let { data: all, error: errorAll } = await supabase.from("feeder_articles").select("*")
      .order("created_at", { ascending: false }).limit(30);
    if (errorAll) {
      if (errorAll.code === "PGRST303" || errorAll.message?.includes("JWT expired")) {
        const retryAll = await supabase.from("feeder_articles").select("*")
          .order("created_at", { ascending: false }).limit(30);
        all = retryAll.data;
      }
    }
    setAllArticles(all ?? []);
  }, []);

  // Load skills and MCP connections for agents section
  const loadSkillsAndMCP = useCallback(async () => {
    try {
      const [skillsRes, composioRes, manualRes, toolSettingsRes] = await Promise.all([
        fetch("/api/skills"),
        fetch("/api/mcp/composio/connections"),
        fetch("/api/mcp/manual"),
        fetch("/api/mcp/tool-settings"),
      ]);
      const skillsData = await skillsRes.json();
      const composioData = await composioRes.json();
      const manualData = await manualRes.json();
      const toolSettingsData = await toolSettingsRes.json();

      setSkills(skillsData.skills ?? []);
      const merged = [
        ...(composioData.connections ?? []),
        ...(manualData.connections ?? []),
      ];
      setMcpConnections(merged);
      setToolSettings(toolSettingsData.settings ?? []);
    } catch { /* skip */ }
  }, []);

  useEffect(() => {
    loadSettings();
    loadQueue();
    loadSkillsAndMCP();
  }, [loadSettings, loadQueue, loadSkillsAndMCP]);

  useEffect(() => {
    setIsDirty(JSON.stringify(settings) !== JSON.stringify(initialSettings));
  }, [settings, initialSettings]);

  useEffect(() => {
    setBatchSizeState(parseInt(settings.queue_batch_size ?? "2", 10));
  }, [settings.queue_batch_size]);

  const setSetting = (k: string, v: string) => {
    setSettings(prev => ({ ...prev, [k]: v }));
  };

  const saveSettings = async () => {
    const interval = parseInt(settings.auto_trigger_interval_minutes || "", 10);
    if (settings.auto_trigger_enabled === "true" && (isNaN(interval) || interval < 1)) {
      alert("Auto-trigger interval must be a valid number of minutes (at least 1).");
      return;
    }
    setSaveStatus("saving");
    try {
      const rows = AGENT_SETTING_KEYS.map(key => ({ key, value: settings[key] ?? "" }));
      let { error } = await supabase.from("agent_settings").upsert(rows, { onConflict: "key" });
      if (error) {
        if (error.code === "PGRST303" || error.message?.includes("JWT expired")) {
          console.warn("JWT expired. Cleaning session and retrying saveSettings...");
          await supabase.auth.signOut().catch(() => {});
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.includes("-auth-token")) {
              localStorage.removeItem(key);
            }
          }
          const retry = await supabase.from("agent_settings").upsert(rows, { onConflict: "key" });
          error = retry.error;
          if (error) {
            console.error("Error saving settings after retry:", error);
          }
        } else {
          console.error("Error saving settings:", error);
        }
      }
      if (error) {
        setSaveStatus("error");
      } else {
        setInitialSettings({ ...settings });
        setIsDirty(false);
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 3000);
      }
    } catch {
      setSaveStatus("error");
    }
  };

  const testProvider = async (providerId: ProviderId) => {
    setTestStates(prev => ({ ...prev, [providerId]: { status: "testing" } }));
    const start = Date.now();
    try {
      const res = await fetch("/api/test-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId }),
      });
      const data = await res.json();
      if (data.success) {
        setTestStates(prev => ({ ...prev, [providerId]: { status: "ok", latency: data.latency_ms ?? (Date.now() - start) } }));
      } else {
        setTestStates(prev => ({ ...prev, [providerId]: { status: "error", error: data.error } }));
      }
    } catch (e: unknown) {
      setTestStates(prev => ({ ...prev, [providerId]: { status: "error", error: e instanceof Error ? e.message : "Error" } }));
    }
  };

  const saveAndReload = async () => {
    await saveSettings();
    setReloadStatus("reloading");
    setReloadMsg("Applying settings to agents…");
    try {
      const res = await fetch("/api/reload-agent", { method: "POST" });
      const data = await res.json();
      setReloadMsg(data.message ?? "Agents reloaded.");
      setReloadStatus("done");
    } catch {
      setReloadMsg("Reload failed.");
      setReloadStatus("error");
    }
  };

  const resetStuckArticles = async () => {
    await supabase.from("feeder_articles").update({ status: "Pending" }).eq("status", "Processing");
    loadQueue();
  };

  const fireAgent = async () => {
    const toProcess = queue.slice(0, batchSize);
    for (const art of toProcess) {
      await supabase.from("feeder_articles").update({ status: "Processing" }).eq("id", art.id);
    }
    const res = await fetch("/api/social-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ articles: toProcess }),
    });
    if (!res.ok) {
      console.error("Fire agent failed");
      return;
    }
    loadQueue();
  };



  // ── Queue section (from old page) ────────────────────────────────────────────
  const QueueSection = () => (
    <div className="space-y-5">
      <h2 className="font-semibold">Queue & Schedule</h2>

      {/* Queue Config */}
      <section className="rounded-xl border bg-card shadow-sm">
        <div className="p-4 border-b flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h3 className="font-semibold text-sm">Queue Configuration</h3>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-2 block">Batch Size</label>
            <div className="flex gap-1.5">
              {["1","2","3","4","5","6"].map(n => (
                <button key={n} onClick={() => setSetting("queue_batch_size", n)}
                  className={`flex-1 h-9 rounded-lg border text-sm font-semibold transition-all
                    ${settings.queue_batch_size === n ? "bg-primary text-primary-foreground border-primary shadow-sm shadow-primary/20" : "bg-muted border-border hover:bg-accent"}`}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-4 p-3 rounded-lg border bg-muted/20">
            <AlarmClock className="h-4 w-4 text-primary shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium">Auto-trigger</p>
              <p className="text-xs text-muted-foreground">Run agent automatically on schedule</p>
            </div>
            <button onClick={() => setSetting("auto_trigger_enabled", settings.auto_trigger_enabled === "true" ? "false" : "true")}
              className={`relative w-11 h-6 rounded-full transition-colors ${settings.auto_trigger_enabled === "true" ? "bg-primary" : "bg-muted-foreground/30"}`}>
              <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${settings.auto_trigger_enabled === "true" ? "left-6" : "left-1"}`} />
            </button>
          </div>
          {settings.auto_trigger_enabled === "true" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-2 block">Interval (minutes)</label>
              {(() => {
                const presets = ["15", "30", "60", "120", "240"];
                const isCustom = !presets.includes(settings.auto_trigger_interval_minutes);
                return (
                  <div className="space-y-1.5">
                    <select
                      value={isCustom ? "custom" : settings.auto_trigger_interval_minutes}
                      onChange={e => {
                        const val = e.target.value;
                        if (val === "custom") {
                          setSetting("auto_trigger_interval_minutes", "5");
                        } else {
                          setSetting("auto_trigger_interval_minutes", val);
                        }
                      }}
                      className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      <option value="15">Every 15 minutes</option>
                      <option value="30">Every 30 minutes</option>
                      <option value="60">Every 1 hour</option>
                      <option value="120">Every 2 hours</option>
                      <option value="240">Every 4 hours</option>
                      <option value="custom">Custom...</option>
                    </select>
                    {isCustom && (
                      <div className="flex items-center gap-1.5 mt-1">
                        <Input
                          type="number"
                          min={1}
                          value={settings.auto_trigger_interval_minutes}
                          onChange={e => setSetting("auto_trigger_interval_minutes", e.target.value)}
                          className="h-9 text-sm font-semibold w-24"
                        />
                        <span className="text-xs text-muted-foreground font-semibold">minutes</span>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
          <div className="flex gap-3 pt-2 border-t">
            <Button onClick={saveSettings} disabled={saveStatus === "saving" || !isDirty} variant="outline" className="flex-1">
              {saveStatus === "saving" ? "Saving…" : isDirty ? "Save" : "No Changes"}
            </Button>
            {saveStatus === "saved" && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
          </div>
        </div>
      </section>

      {/* Queue Preview */}
      <section className="rounded-xl border bg-card shadow-sm">
        <div className="p-4 border-b flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h3 className="font-semibold text-sm">Current Queue</h3>
          <span className="ml-auto text-xs text-muted-foreground">Next {batchSize} pending articles</span>
          <Button onClick={resetStuckArticles} size="sm" variant="outline" className="ml-2">Reset Stuck</Button>
          <Button onClick={fireAgent} size="sm" className="ml-2" disabled={queue.length === 0}>
            <Play className="mr-2 h-3.5 w-3.5" />
            Start Agent ({Math.min(queue.length, batchSize)})
          </Button>
        </div>
        <div className="divide-y">
          {queue.length === 0 && (
            <div className="p-6 text-center text-muted-foreground text-sm">No pending articles. Run the feeder to populate the queue.</div>
          )}
          {queue.slice(0, batchSize).map((art, i) => (
            <div key={art.id} className="p-4 flex items-start gap-3">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold shrink-0">{i + 1}</div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">{art.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{art.description}</p>
                <p className="text-xs text-muted-foreground mt-1">{art.source_domain} · {new Date(art.created_at).toLocaleString()}</p>
              </div>
              <StatusBadge status={art.status} />
            </div>
          ))}
        </div>
      </section>

      {/* Recent Articles */}
      <section className="rounded-xl border bg-card shadow-sm">
        <div className="p-4 border-b flex items-center gap-2">
          <List className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-sm">Recent Articles</h3>
          <span className="ml-auto text-xs text-muted-foreground">Last 30</span>
        </div>
        <div className="divide-y max-h-80 overflow-auto">
          {allArticles.length === 0 && <div className="p-6 text-center text-muted-foreground text-sm">No articles yet.</div>}
          {allArticles.map(art => (
            <div key={art.id} className="p-3 flex items-center gap-3">
              <StatusBadge status={art.status} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{art.title}</p>
                <p className="text-xs text-muted-foreground">{art.source_domain} · {new Date(art.created_at).toLocaleString()}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );

  const renderSection = () => {
    switch (section) {
      case "workflows": return <WorkflowsSection />;
      case "tools":     return <ToolsSection initialTab="tools" />;
      case "tools-composio": return <ToolsSection initialTab="composio" />;
      case "tools-manual": return <ToolsSection initialTab="manual" />;
      case "tools-zapier": return <ToolsSection initialTab="zapier" />;
      case "providers": return (
        <ProviderOrderingSection
          globalSettings={settings}
          setGlobalSetting={setSetting}
          saveGlobalSettings={saveSettings}
          saveStatus={saveStatus}
        />
      );
      case "agents":    return <AgentsSection agentType="main" skills={skills} mcpConnections={mcpConnections} toolSettings={toolSettings} />;
      case "subagents": return <AgentsSection agentType="subagent" skills={skills} mcpConnections={mcpConnections} toolSettings={toolSettings} />;
      case "skills":    return <SkillsSection />;
      case "design-assets": return <DesignAssetsSection />;
      case "queue":     return <QueueSection />;
      case "configuration": return <ConfigurationSection />;
      case "feeder": return <FeederDashboardSection />;
      default:          return null;
    }
  };

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="flex h-14 items-center gap-3 px-4">
          <Zap className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm">Agent Settings</span>
          <div className="ml-auto flex items-center gap-2">
            {userEmail && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <User className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{userEmail}</span>
              </div>
            )}
            <ThemeToggle />
            <Link href="/">
              <Button variant="ghost" size="sm" className="gap-1.5 text-xs">
                <Home className="h-3.5 w-3.5" /> Home
              </Button>
            </Link>
            <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground"
              onClick={async () => { await signOut(); window.location.href = "/login"; }}>
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </Button>
          </div>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden h-[calc(100vh-3.5rem)]">
        <SettingsSidebar
          active={section}
          onChange={setSection}
          isExpanded={isSidebarExpanded}
          onToggleExpanded={() => setIsSidebarExpanded(!isSidebarExpanded)}
        />
        <main className="flex-1 overflow-y-auto p-6">
          <div className={cn("mx-auto", section.startsWith("tools") ? "w-full max-w-none" : "max-w-4xl")}>
            {renderSection()}
          </div>
        </main>
      </div>
    </div>
  );
}
