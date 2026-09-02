"use client";

/**
 * EnvKeysSection — Per-user API credential management.
 *
 * Replaces the old single-tenant .env file approach with a full SaaS-style
 * UI where each user enters their own API keys. Keys are stored per-user in
 * Supabase agent_settings and resolved at runtime by the backend via
 * get_user_api_key() which checks agent_settings before env vars.
 *
 * Storage: POST /api/agent-settings  { rows: [{key, value}] }
 * Retrieval: GET /api/agent-settings
 */

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  KeyRound, Eye, EyeOff, CheckCircle2, Loader2, AlertCircle,
  ExternalLink, Cpu, Search, Database, Globe, Bot, Zap,
  ChevronDown, ChevronRight, RefreshCw, Shield, HardDrive,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JanCard, CardItem } from "@/components/settings/JanCard";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────────

type SaveState = "idle" | "saving" | "saved" | "error";
type TestState = "idle" | "testing" | "ok" | "error";

interface KeyField {
  key: string;           // agent_settings key name
  label: string;
  placeholder: string;
  helpUrl?: string;
  type?: "password" | "text" | "url";
  testable?: boolean;
  testKey?: string;      // provider id for /api/test-provider
  options?: { value: string; label: string }[];  // render as <select>, saves on change
}

interface KeyGroup {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  iconClass: string;
  fields: KeyField[];
  defaultExpanded?: boolean;
}

// ── Key Groups ─────────────────────────────────────────────────────────────────

const KEY_GROUPS: KeyGroup[] = [
  {
    id: "ai-providers",
    label: "AI / LLM Providers",
    description: "API keys for OpenRouter, Gemini, Grok, Vercel AI Gateway, Together, Cerebras, Groq, DeepSeek, Mistral, Fireworks, and Ollama",
    icon: <Cpu className="h-4 w-4" />,
    iconClass: "text-violet-500",
    defaultExpanded: true,
    fields: [
      { key: "openrouter_client_api_key", label: "OpenRouter API Key",  placeholder: "sk-or-v1-...",              helpUrl: "https://openrouter.ai/keys",                    testable: true,  testKey: "openrouter" },
      { key: "ai_gateway_api_key",        label: "Vercel AI Gateway Key", placeholder: "vck_... or API Key",        helpUrl: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys", testable: true,  testKey: "vercel" },
      { key: "gemini_client_api_key",     label: "Gemini Direct API Key", placeholder: "AIzaSy...",               helpUrl: "https://aistudio.google.com/app/apikey",        testable: true,  testKey: "gemini" },
      { key: "grok_client_api_key",       label: "xAI (Grok) API Key",   placeholder: "xai-...",                   helpUrl: "https://console.x.ai/",                         testable: true,  testKey: "grok" },
      { key: "together_client_api_key",   label: "Together AI API Key", placeholder: "tgp_...",                   helpUrl: "https://api.together.xyz/settings/api-keys",    testable: true,  testKey: "together" },
      { key: "cerebras_client_api_key",   label: "Cerebras API Key",    placeholder: "csk-...",                   helpUrl: "https://cloud.cerebras.ai/",                    testable: true,  testKey: "cerebras" },
      { key: "groq_client_api_key",       label: "Groq API Key",        placeholder: "gsk_...",                   helpUrl: "https://console.groq.com/keys",                 testable: true,  testKey: "groq" },
      { key: "deepseek_client_api_key",   label: "DeepSeek API Key",    placeholder: "sk-...",                    helpUrl: "https://platform.deepseek.com/api_keys",        testable: true,  testKey: "deepseek" },
      { key: "mistral_client_api_key",    label: "Mistral AI API Key",  placeholder: "...",                       helpUrl: "https://console.mistral.ai/api-keys/",          testable: true,  testKey: "mistral" },
      { key: "fireworks_client_api_key",  label: "Fireworks AI API Key",placeholder: "fw_...",                    helpUrl: "https://fireworks.ai/account/api-keys",         testable: true,  testKey: "fireworks" },
      { key: "ollama_base_url",           label: "Ollama Base URL",     placeholder: "http://localhost:11434/v1", helpUrl: "https://ollama.com/", type: "url",             testable: true,  testKey: "ollama" },
      { key: "ollama_client_api_key",     label: "Ollama API Key",      placeholder: "optional for local",       helpUrl: undefined, type: "password",                     testable: false },
    ],
  },
  {
    id: "search-extract",
    label: "Search & Extract Providers",
    description: "Web search and content extraction API keys",
    icon: <Search className="h-4 w-4" />,
    iconClass: "text-blue-500",
    defaultExpanded: true,
    fields: [
      { key: "tavily_api_key",   label: "Tavily API Key",    placeholder: "tvly-...",  helpUrl: "https://app.tavily.com/",                       testable: true,  testKey: "tavily" },
      { key: "linkup_api_key",   label: "Linkup API Key",    placeholder: "41e588...", helpUrl: "https://app.linkup.so/",                        testable: true,  testKey: "linkup" },
      { key: "exa_api_key",      label: "Exa AI API Key",    placeholder: "dca1c7...", helpUrl: "https://dashboard.exa.ai/api-keys",             testable: true,  testKey: "exa" },
      { key: "brave_api_key",    label: "Brave Search Key",  placeholder: "BSA4...",   helpUrl: "https://api.search.brave.com/app/keys",         testable: true,  testKey: "brave" },
      { key: "parallel_api_key", label: "Parallel AI Key",   placeholder: "wMkJP...",  helpUrl: "https://www.parallel.ai/",                      testable: false },
      { key: "kie_api_key",      label: "KIE AI Key",        placeholder: "80b1a...",  helpUrl: "https://kie.ai/",                               testable: false },
    ],
  },
  {
    id: "memory",
    label: "Honcho Cloud & Memory Provider",
    description: "Honcho & Together AI provider credentials for cross-session memory prefetch deduplication & user modeling",
    icon: <Database className="h-4 w-4" />,
    iconClass: "text-emerald-500",
    defaultExpanded: true,
    fields: [
      { key: "honcho_api_key",    label: "Honcho API Key",       placeholder: "hch-v3-...",                helpUrl: "https://app.honcho.dev",     testable: false },
      { key: "honcho_api_url",    label: "Honcho API Base URL",  placeholder: "https://api.honcho.dev",   helpUrl: undefined, type: "url",      testable: false },
      { key: "honcho_workspace",  label: "Honcho Workspace",     placeholder: "default_workspace",       helpUrl: undefined, type: "text", testable: false },
      { key: "together_api_key",  label: "Together AI API Key",  placeholder: "tgp_...",                   helpUrl: "https://api.together.xyz/settings/api-keys", testable: false },
    ],
  },
  {
    id: "storage-r2",
    label: "File Storage (Cloudflare R2)",
    description: "Unified portable file storage. Attachments, generated media, and files you explicitly upload go to your R2 bucket and follow you across deployments. Falls back to Supabase Storage when not configured.",
    icon: <HardDrive className="h-4 w-4" />,
    iconClass: "text-orange-500",
    defaultExpanded: true,
    fields: [
      { key: "r2_account_id",        label: "R2 Account ID",        placeholder: "Cloudflare dashboard → R2 → Account ID", helpUrl: "https://dash.cloudflare.com/?to=/:account/r2", type: "text", testable: false },
      { key: "r2_access_key_id",     label: "R2 Access Key ID",     placeholder: "R2 API token → Access Key ID",           helpUrl: "https://developers.cloudflare.com/r2/api/tokens/", testable: false },
      { key: "r2_secret_access_key", label: "R2 Secret Access Key", placeholder: "R2 API token → Secret Access Key",       helpUrl: "https://developers.cloudflare.com/r2/api/tokens/", testable: false },
      { key: "r2_bucket_name",       label: "R2 Bucket Name",       placeholder: "my-agent-files",                         helpUrl: "https://developers.cloudflare.com/r2/buckets/", type: "text", testable: false },
      { key: "r2_public_base_url",   label: "R2 Public Base URL",   placeholder: "https://pub-xxx.r2.dev or custom domain", helpUrl: "https://developers.cloudflare.com/r2/buckets/public-buckets/", type: "url", testable: false },
      {
        key: "storage_retention_days", label: "File Retention Period", placeholder: "30", testable: false,
        options: [
          { value: "3",  label: "3 days" },
          { value: "7",  label: "7 days" },
          { value: "14", label: "14 days" },
          { value: "30", label: "30 days (default)" },
          { value: "60", label: "60 days" },
          { value: "90", label: "90 days" },
          { value: "0",  label: "Keep forever" },
        ],
      },
      {
        key: "storage_auto_upload_files", label: "Auto-upload every agent file", placeholder: "false", testable: false,
        options: [
          { value: "false", label: "Off — keep agent files in the workspace (default)" },
          { value: "true",  label: "On — mirror every created file to storage" },
        ],
      },
    ],
  },
  {
    id: "platform",
    label: "MCP Platforms & Tracing",
    description: "Credentials for Composio, Smithery, Zapier, and LangSmith tracing",
    icon: <Bot className="h-4 w-4" />,
    iconClass: "text-amber-500",
    defaultExpanded: false,
    fields: [
      { key: "composio_api_key",   label: "Composio API Key",   placeholder: "ak_drGs...",   helpUrl: "https://app.composio.dev/",        testable: false },
      { key: "smithery_api_key",   label: "Smithery API Key",   placeholder: "05ada...",    helpUrl: "https://smithery.ai/settings",     testable: false },
      { key: "zapier_mcp_secret",  label: "Zapier MCP Secret",  placeholder: "mlX5sN...",    helpUrl: "https://mcp.zapier.com/",          testable: false },
      { key: "langsmith_api_key",  label: "LangSmith API Key",  placeholder: "lsv2_pt_...", helpUrl: "https://smith.langchain.com/",     testable: false, type: "text" },
    ],
  },
];



// ── KeyRow ─────────────────────────────────────────────────────────────────────

function KeyRow({
  field,
  currentValue,
  onSave,
  onTest,
}: {
  field: KeyField;
  currentValue: string;
  onSave: (key: string, value: string) => Promise<void>;
  onTest?: (testKey: string) => Promise<void>;
}) {
  const [localValue, setLocalValue] = useState(currentValue);
  const [showValue, setShowValue] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [testState, setTestState] = useState<TestState>("idle");
  const [testMsg, setTestMsg] = useState("");
  const isDirty = localValue !== currentValue;
  const isPassword = (field.type ?? "password") === "password";

  useEffect(() => { setLocalValue(currentValue); }, [currentValue]);

  const handleSave = async () => {
    setSaveState("saving");
    try {
      await onSave(field.key, localValue);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2500);
    } catch {
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 3000);
    }
  };

  const handleTest = async () => {
    if (!onTest || !field.testKey) return;
    setTestState("testing");
    setTestMsg("");
    try {
      await onTest(field.testKey);
      setTestState("ok");
      setTestMsg("Connected ✓");
      setTimeout(() => { setTestState("idle"); setTestMsg(""); }, 4000);
    } catch (e: any) {
      setTestState("error");
      setTestMsg(e.message || "Failed");
      setTimeout(() => { setTestState("idle"); setTestMsg(""); }, 5000);
    }
  };

  return (
    <CardItem
      column
      title={
        <span className="flex items-center gap-1.5 text-sm">
          {field.label}
          {field.helpUrl && (
            <a href={field.helpUrl} target="_blank" rel="noopener noreferrer"
               className="text-muted-foreground hover:text-primary transition-colors">
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </span>
      }
      description={
        (testState !== "idle" || saveState !== "idle") ? (
          <span className="flex items-center gap-2 text-[11px] font-medium">
            {testState === "ok" && <span className="text-emerald-500 flex items-center gap-0.5"><CheckCircle2 className="h-3 w-3" />{testMsg}</span>}
            {testState === "error" && <span className="text-rose-400 flex items-center gap-0.5"><AlertCircle className="h-3 w-3" />{testMsg}</span>}
            {saveState === "saved" && <span className="text-emerald-500 flex items-center gap-0.5"><CheckCircle2 className="h-3 w-3" />Saved</span>}
            {saveState === "error" && <span className="text-rose-400 flex items-center gap-0.5"><AlertCircle className="h-3 w-3" />Save failed</span>}
          </span>
        ) : undefined
      }
    >
      <div className="flex items-center gap-2">
        {field.options ? (
          <select
            value={localValue || field.options[0]?.value || ""}
            onChange={async (e) => {
              const v = e.target.value;
              setLocalValue(v);
              setSaveState("saving");
              try {
                await onSave(field.key, v);
                setSaveState("saved");
                setTimeout(() => setSaveState("idle"), 2500);
              } catch {
                setSaveState("error");
                setTimeout(() => setSaveState("idle"), 3000);
              }
            }}
            className="h-8 flex-1 min-w-0 rounded-md border border-input bg-background px-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {!field.options.some(o => o.value === localValue) && localValue && (
              <option value={localValue}>{localValue}</option>
            )}
            {field.options.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        ) : (
        <div className="relative flex-1 min-w-0">
          <Input
            type={showValue || field.type === "text" || field.type === "url" ? "text" : "password"}
            placeholder={field.placeholder}
            value={localValue}
            onChange={e => setLocalValue(e.target.value)}
            onKeyDown={e => e.key === "Enter" && isDirty && handleSave()}
            className="h-8 text-xs font-mono pr-8"
            autoComplete="off"
          />
          {isPassword && localValue && (
            <button type="button" onClick={() => setShowValue(v => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
              {showValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
        )}
        {!field.options && (
        <Button onClick={handleSave} disabled={saveState === "saving" || !isDirty}
          size="sm" variant={isDirty ? "default" : "outline"} className="h-8 px-3 text-xs font-semibold shrink-0">
          {saveState === "saving" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
        </Button>
        )}
        {field.testable && (
          <Button onClick={handleTest} disabled={testState === "testing" || !localValue}
            size="sm" variant="outline" className="h-8 px-3 text-xs font-semibold shrink-0">
            {testState === "testing" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
          </Button>
        )}
      </div>
    </CardItem>
  );
}

// ── KeyGroupCard ───────────────────────────────────────────────────────────────

function KeyGroupCard({
  group,
  values,
  onSaveKey,
  onTestKey,
}: {
  group: KeyGroup;
  values: Record<string, string>;
  onSaveKey: (key: string, value: string) => Promise<void>;
  onTestKey: (testKey: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(group.defaultExpanded ?? false);
  const filledCount = group.fields.filter(f => values[f.key]?.trim()).length;

  return (
    <JanCard
      className="p-0 overflow-hidden"
      header={
        <button onClick={() => setExpanded(e => !e)}
          className="w-full flex items-center gap-3 p-4 md:p-5 text-left hover:bg-muted/30 transition-colors">
          <span className={cn("shrink-0", group.iconClass)}>{group.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-foreground font-studio">{group.label}</p>
              <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded-full",
                filledCount === group.fields.length
                  ? "bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400"
                  : filledCount > 0
                  ? "bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400"
                  : "bg-muted text-muted-foreground")}>
                {filledCount}/{group.fields.length}
              </span>
            </div>
            <p className="text-xs text-muted-foreground truncate">{group.description}</p>
          </div>
          {expanded
            ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
        </button>
      }
    >
      {expanded && (
        <div className="px-4 pb-4 md:px-5 border-t border-border/40">
          {group.fields.map(field => (
            <KeyRow
              key={field.key}
              field={field}
              currentValue={values[field.key] ?? ""}
              onSave={onSaveKey}
              onTest={field.testable ? onTestKey : undefined}
            />
          ))}
        </div>
      )}
    </JanCard>
  );
}

// ── Main EnvKeysSection ────────────────────────────────────────────────────────

export function EnvKeysSection({ hiddenGroupIds = [] }: { hiddenGroupIds?: string[] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [bulkSaveState, setBulkSaveState] = useState<SaveState>("idle");

  const visibleGroups = KEY_GROUPS.filter(g => !hiddenGroupIds.includes(g.id));
  const visibleKeys = visibleGroups.flatMap(g => g.fields.map(f => f.key));

  const loadKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/agent-settings");
      const data = await res.json();
      const map: Record<string, string> = {};
      for (const { key, value } of (data.settings ?? [])) map[key] = value ?? "";
      setValues(map);
    } catch (e) {
      console.error("[EnvKeysSection] Failed to load keys:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadKeys(); }, [loadKeys]);

  const handleSaveKey = useCallback(async (key: string, value: string) => {
    setValues(prev => ({ ...prev, [key]: value }));
    const res = await fetch("/api/agent-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: [{ key, value }] }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Failed to save key");
    }
  }, []);

  const handleTestKey = useCallback(async (testKey: string) => {
    const res = await fetch("/api/test-provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: testKey }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || "Provider test failed");
  }, []);

  const handleSaveAll = async () => {
    setBulkSaveState("saving");
    try {
      const rows = Object.entries(values).map(([key, value]) => ({ key, value }));
      const res = await fetch("/api/agent-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      if (!res.ok) throw new Error("Save failed");
      setBulkSaveState("saved");
      setTimeout(() => setBulkSaveState("idle"), 3000);
    } catch {
      setBulkSaveState("error");
      setTimeout(() => setBulkSaveState("idle"), 3000);
    }
  };

  const totalFilled = visibleKeys.filter(k => values[k]?.trim()).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading your API credentials…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap px-1">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Shield className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-bold font-studio text-foreground">ENV Keys — Your API Credentials</h2>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">
            Enter your own API keys below. Keys are stored securely per-user and used automatically
            by all agents, tools, feeder pipeline, and memory operations. Each user account is fully isolated.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={cn("text-xs font-bold px-2.5 py-1.5 rounded-full",
            totalFilled >= visibleKeys.length * 0.7
              ? "bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400"
              : totalFilled > 0
              ? "bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400"
              : "bg-muted text-muted-foreground")}>
            {totalFilled}/{visibleKeys.length} configured
          </span>
          <Button variant="outline" size="sm" onClick={loadKeys} className="h-8 px-3 text-xs gap-1.5">
            <RefreshCw className="h-3 w-3" />Refresh
          </Button>
        </div>
      </div>

      {/* Info banner */}
      <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 flex items-start gap-3">
        <KeyRound className="h-4 w-4 text-primary shrink-0 mt-0.5" />
        <p className="text-xs text-foreground/80 leading-relaxed">
          <strong>How it works:</strong> Each API key is saved to your account only. When you run agents,
          searches, the feeder pipeline, or memory operations, the system uses your keys — not shared
          server keys. You control your own API costs. Supabase credentials are platform-managed and
          cannot be changed here.
        </p>
      </div>

      {/* Groups */}
      <div className="space-y-3">
        {visibleGroups.map(group => (
          <KeyGroupCard
            key={group.id}
            group={group}
            values={values}
            onSaveKey={handleSaveKey}
            onTestKey={handleTestKey}
          />
        ))}
      </div>

      {/* Posts Plugin Integration Callout */}
      <div className="rounded-xl border border-border bg-card p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10 text-primary">
            <Globe className="h-4 w-4" />
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground">WordPress & Social Media Channels</p>
            <p className="text-xs text-muted-foreground">WordPress, Facebook, Instagram, and Twitter/X keys are managed inside the Posts Plugin.</p>
          </div>
        </div>
        <Link href="/agent-settings?tab=plugins-posts">
          <Button variant="outline" size="sm" className="h-8 text-xs font-semibold shrink-0 gap-1.5">
            Configure in Posts Plugin →
          </Button>
        </Link>
      </div>

      {/* Save all footer */}
      <JanCard>
        <CardItem
          title="Persist all credentials"
          description="Click Save next to each key individually, or write everything at once."
          actions={
            <div className="flex items-center gap-2">
              {bulkSaveState === "saved" && (
                <span className="text-xs text-emerald-500 font-semibold flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" />All saved!
                </span>
              )}
              {bulkSaveState === "error" && (
                <span className="text-xs text-rose-400 font-semibold flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" />Save failed
                </span>
              )}
              <Button onClick={handleSaveAll} disabled={bulkSaveState === "saving"} className="h-9 px-6 font-semibold text-xs">
                {bulkSaveState === "saving"
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />Saving all keys…</>
                  : "Save All Keys"}
              </Button>
            </div>
          }
        />
      </JanCard>
    </div>
  );
}
