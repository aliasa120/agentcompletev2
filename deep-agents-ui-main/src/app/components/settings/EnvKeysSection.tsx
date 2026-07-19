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
import {
  KeyRound, Eye, EyeOff, CheckCircle2, Loader2, AlertCircle,
  ExternalLink, Cpu, Search, Database, Globe, Bot, Zap,
  ChevronDown, ChevronRight, RefreshCw, Shield,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    label: "AI Providers",
    description: "LLM keys for agents, subagents, feeder, omni analyzer",
    icon: <Cpu className="h-4 w-4" />,
    iconClass: "text-violet-500",
    defaultExpanded: true,
    fields: [
      { key: "openrouter_client_api_key", label: "OpenRouter API Key",  placeholder: "sk-or-v1-...",   helpUrl: "https://openrouter.ai/keys",                    testable: true,  testKey: "openrouter" },
      { key: "gemini_client_api_key",     label: "Gemini API Key",      placeholder: "AIzaSy...",       helpUrl: "https://aistudio.google.com/app/apikey",        testable: true,  testKey: "gemini" },
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
    label: "Memory & Vector Store (Pinecone)",
    description: "Pinecone vector DB for per-user semantic memory",
    icon: <Database className="h-4 w-4" />,
    iconClass: "text-emerald-500",
    defaultExpanded: false,
    fields: [
      { key: "pinecone_api_key",    label: "Pinecone API Key",    placeholder: "pcsk_...",  helpUrl: "https://app.pinecone.io/",                    testable: false },
      { key: "pinecone_index_name", label: "Pinecone Index Name", placeholder: "memories",  helpUrl: undefined, type: "text",                        testable: false },
      { key: "cohere_api_key",      label: "Cohere API Key",      placeholder: "...",       helpUrl: "https://dashboard.cohere.com/api-keys",       testable: false },
    ],
  },
  {
    id: "wordpress",
    label: "WordPress Publisher",
    description: "Credentials for automatic article publishing to WordPress",
    icon: <Globe className="h-4 w-4" />,
    iconClass: "text-sky-500",
    defaultExpanded: false,
    fields: [
      { key: "wp_site_url",     label: "WP Site URL",     placeholder: "https://yoursite.com", type: "url",  testable: false },
      { key: "wp_username",     label: "WP Username",     placeholder: "admin",                type: "text", testable: false },
      { key: "wp_app_password", label: "WP App Password", placeholder: "xxxx xxxx xxxx xxxx",               testable: false },
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
  {
    id: "social",
    label: "Social Media",
    description: "Facebook, Instagram, and Twitter/X credentials for auto-publishing",
    icon: <Zap className="h-4 w-4" />,
    iconClass: "text-pink-500",
    defaultExpanded: false,
    fields: [
      { key: "social_fb_token",         label: "Facebook Page Token",  placeholder: "EAAZA...",                            testable: false },
      { key: "social_fb_page_id",       label: "Facebook Page ID",     placeholder: "1002976...",    type: "text",         testable: false },
      { key: "social_ig_account_id",    label: "Instagram Account ID", placeholder: "17841...",      type: "text",         testable: false },
      { key: "social_twitter_api_key",  label: "Twitter API Key",      placeholder: "new1_be...",    type: "text",         testable: false },
      { key: "social_twitter_username", label: "Twitter Username",     placeholder: "@username",     type: "text",         testable: false },
      { key: "social_twitter_email",    label: "Twitter Email",        placeholder: "you@email.com", type: "text",         testable: false },
      { key: "social_twitter_password", label: "Twitter Password",     placeholder: "...",                                 testable: false },
      { key: "social_twitter_totp",     label: "Twitter TOTP Secret",  placeholder: "6EVMDLB...",                          testable: false },
      { key: "social_twitter_proxy",    label: "Twitter Proxy URL",    placeholder: "http://user:pass@host:port", type: "text", testable: false },
    ],
  },
];

const ALL_KEYS = KEY_GROUPS.flatMap(g => g.fields.map(f => f.key));

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
    <div className="flex flex-col gap-1.5 py-3 border-b border-border/50 last:border-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <label className="text-xs font-semibold text-foreground">{field.label}</label>
          {field.helpUrl && (
            <a href={field.helpUrl} target="_blank" rel="noopener noreferrer"
               className="text-muted-foreground hover:text-primary transition-colors">
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] font-medium">
          {testState === "ok" && <span className="text-emerald-500 flex items-center gap-0.5"><CheckCircle2 className="h-3 w-3" />{testMsg}</span>}
          {testState === "error" && <span className="text-rose-400 flex items-center gap-0.5"><AlertCircle className="h-3 w-3" />{testMsg}</span>}
          {saveState === "saved" && <span className="text-emerald-500 flex items-center gap-0.5"><CheckCircle2 className="h-3 w-3" />Saved</span>}
          {saveState === "error" && <span className="text-rose-400 flex items-center gap-0.5"><AlertCircle className="h-3 w-3" />Save failed</span>}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
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
        <Button onClick={handleSave} disabled={saveState === "saving" || !isDirty}
          size="sm" variant={isDirty ? "default" : "outline"} className="h-8 px-3 text-xs font-semibold shrink-0">
          {saveState === "saving" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
        </Button>
        {field.testable && (
          <Button onClick={handleTest} disabled={testState === "testing" || !localValue}
            size="sm" variant="outline" className="h-8 px-3 text-xs font-semibold shrink-0">
            {testState === "testing" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
          </Button>
        )}
      </div>
    </div>
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
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      <button onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/30 transition-colors">
        <span className={cn("shrink-0", group.iconClass)}>{group.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">{group.label}</p>
            <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded-full",
              filledCount === group.fields.length
                ? "bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600"
                : filledCount > 0
                ? "bg-amber-100 dark:bg-amber-950/40 text-amber-600"
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

      {expanded && (
        <div className="px-4 pb-2 border-t border-border/50">
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
    </div>
  );
}

// ── Main EnvKeysSection ────────────────────────────────────────────────────────

export function EnvKeysSection() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [bulkSaveState, setBulkSaveState] = useState<SaveState>("idle");

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

  const totalFilled = ALL_KEYS.filter(k => values[k]?.trim()).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading your API credentials…</span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Shield className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-bold">ENV Keys — Your API Credentials</h2>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">
            Enter your own API keys below. Keys are stored securely per-user and used automatically
            by all agents, tools, feeder pipeline, and memory operations. Each user account is fully isolated.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={cn("text-xs font-bold px-2.5 py-1.5 rounded-full",
            totalFilled >= ALL_KEYS.length * 0.7
              ? "bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600"
              : totalFilled > 0
              ? "bg-amber-100 dark:bg-amber-950/40 text-amber-600"
              : "bg-muted text-muted-foreground")}>
            {totalFilled}/{ALL_KEYS.length} configured
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
        {KEY_GROUPS.map(group => (
          <KeyGroupCard
            key={group.id}
            group={group}
            values={values}
            onSaveKey={handleSaveKey}
            onTestKey={handleTestKey}
          />
        ))}
      </div>

      {/* Save all footer */}
      <div className="flex items-center justify-between pt-2 border-t flex-wrap gap-2">
        <p className="text-xs text-muted-foreground">
          Click <strong>Save</strong> next to each key individually, or use Save All.
        </p>
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
      </div>
    </div>
  );
}
