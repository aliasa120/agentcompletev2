"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Plus, Trash2, Save, Loader2, CheckCircle2,
  XCircle, ChevronUp, ChevronDown, Zap, Search, FileText,
  Image as ImageIcon, TestTube, AlertCircle, Sparkles,
  Brain, Key, ChevronRight, X, Images
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ── Types ────────────────────────────────────────────────────────────────────

interface ToolProvider {
  id: string;
  tool_category: string;
  provider_key: string;
  provider_label: string;
  priority_order: number;
  enabled: boolean;
  fallback_on_error: boolean;
}

interface MCPToolOption {
  key: string;
  label: string;
  badge: string;
}

interface DesignAsset {
  id: string;
  asset_key: string;
  label: string;
  file_path: string;
  sort_order: number;
}

// ── Available built-in presets by category ───────────────────────────────────

const BUILTIN_PRESETS: Record<string, { key: string; label: string; badge: string }[]> = {
  search: [
    { key: "linkup",     label: "Linkup Search",  badge: "Standard" },
    { key: "parallel",   label: "Parallel AI",     badge: "Agentic" },
    { key: "tavily",     label: "Tavily Search",   badge: "Web Search" },
    { key: "exa",        label: "Exa AI Search",   badge: "Neural" },
  ],
  extract: [
    { key: "tavily",     label: "Tavily Extract",  badge: "Extract" },
    { key: "exa",        label: "Exa AI Extract",   badge: "Neural" },
    { key: "linkup",     label: "Linkup Extract",   badge: "Standard" },
  ],
  image: [
    { key: "kie",          label: "KIE AI",            badge: "img2img" },
    { key: "gemini_flash", label: "Gemini 2.5 Flash",  badge: "Chat" },
  ],
};

const CATEGORY_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  search: { label: "Search",           icon: <Search className="h-4 w-4" />,    color: "text-blue-500" },
  extract: { label: "Extract",         icon: <FileText className="h-4 w-4" />,  color: "text-emerald-500" },
  image: { label: "Image Generation",  icon: <ImageIcon className="h-4 w-4" />, color: "text-violet-500" },
};

// ── Provider Reference Images Picker ──────────────────────────────────────────

function ProviderReferenceImagesPicker({ providerSlug }: { providerSlug: string }) {
  const [library, setLibrary] = useState<DesignAsset[]>([]);
  const [attached, setAttached] = useState<DesignAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [libRes, attRes] = await Promise.all([
        fetch("/api/design-assets"),
        fetch(`/api/design-assets/provider?provider_slug=${providerSlug}`),
      ]);
      const libData = await libRes.json();
      const attData = await attRes.json();
      setLibrary(libData.assets ?? []);
      setAttached(attData.assets ?? []);
    } finally {
      setLoading(false);
    }
  }, [providerSlug]);

  useEffect(() => { load(); }, [load]);

  const attach = async (asset: DesignAsset) => {
    if (attached.some(a => a.id === asset.id)) return;
    setBusy(asset.id);
    try {
      await fetch("/api/design-assets/provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider_slug: providerSlug, design_asset_id: asset.id }),
      });
      setAttached(prev => [...prev, asset]);
    } finally { setBusy(null); }
  };

  const detach = async (asset: DesignAsset) => {
    setBusy(asset.id);
    try {
      await fetch("/api/design-assets/provider", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider_slug: providerSlug, design_asset_id: asset.id }),
      });
      setAttached(prev => prev.filter(a => a.id !== asset.id));
    } finally { setBusy(null); }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-xs text-muted-foreground py-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading images…</div>;
  }

  if (library.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-center bg-muted/5 mt-2">
        <ImageIcon className="h-5 w-5 text-muted-foreground/30 mx-auto mb-1.5" />
        <p className="text-[11px] text-muted-foreground font-medium">No reference images in library yet.</p>
        <p className="text-[10px] text-muted-foreground">Go to <strong>Brand Assets</strong> tab to upload images first.</p>
      </div>
    );
  }

  const unattached = library.filter(a => !attached.some(at => at.id === a.id));

  return (
    <div className="space-y-3 pt-2 text-xs border-t border-dashed mt-2">
      {/* Attached images */}
      {attached.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-violet-500" /> Attached Reference Images ({attached.length})
          </p>
          <div className="flex flex-wrap gap-1.5">
            {attached.map(asset => (
              <div key={asset.id}
                className="flex items-center gap-1.5 pl-1.5 pr-1 py-0.5 rounded-full border bg-violet-500/5 border-violet-500/20 text-violet-600 dark:text-violet-400"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/design-assets/image?key=${asset.asset_key}`}
                  alt={asset.label}
                  className="h-4 w-4 rounded-full object-cover border border-violet-500/20"
                  onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
                <span className="text-[11px] font-medium max-w-[100px] truncate">{asset.label}</span>
                <button
                  type="button"
                  onClick={() => detach(asset)}
                  disabled={busy === asset.id}
                  className="p-0.5 rounded-full hover:bg-foreground/10 text-muted-foreground hover:text-foreground"
                >
                  {busy === asset.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <X className="h-2.5 w-2.5" />}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Attach from library */}
      {unattached.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Attach Image Style</p>
          <div className="grid grid-cols-2 gap-1.5">
            {unattached.map(asset => (
              <button
                key={asset.id}
                type="button"
                onClick={() => attach(asset)}
                disabled={busy === asset.id}
                className="flex items-center gap-1.5 p-1.5 rounded-md border border-dashed hover:border-violet-500/40
                  hover:bg-violet-500/5 transition-all text-left group disabled:opacity-50"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/design-assets/image?key=${asset.asset_key}`}
                  alt={asset.label}
                  className="h-4 w-4 rounded-sm object-cover border"
                  onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
                <span className="text-[11px] truncate flex-1 font-medium">{asset.label}</span>
                <span className="text-[10px] text-muted-foreground group-hover:text-violet-500 transition-colors shrink-0">
                  {busy === asset.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Plus className="h-2.5 w-2.5" />}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Provider Item (single row) ───────────────────────────────────────────────

function ProviderItem({
  provider,
  rank,
  total,
  onMove,
  onToggle,
  onToggleFallback,
  onDelete,
  onTest,
  testState,
}: {
  provider: ToolProvider;
  rank: number;
  total: number;
  onMove: (id: string, dir: "up" | "down") => void;
  onToggle: (id: string) => void;
  onToggleFallback: (id: string) => void;
  onDelete: (id: string) => void;
  onTest: (id: string, key: string) => void;
  testState: "idle" | "testing" | "ok" | "error";
}) {
  const [showImages, setShowImages] = useState(false);
  const isImageProvider = provider.tool_category === "image";

  return (
    <div className={`flex flex-col p-3 rounded-lg border transition-all
      ${provider.enabled
        ? "bg-card border-border"
        : "bg-muted/20 border-dashed border-muted-foreground/20 opacity-60"
      }`}>
      <div className="flex items-center gap-2.5">
        {/* Rank badge */}
        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0
          ${rank === 1 ? "bg-primary text-primary-foreground"
            : rank === 2 ? "bg-primary/60 text-primary-foreground"
            : "bg-muted text-muted-foreground"}`}>
          {rank}
        </div>

        {/* Move buttons */}
        <div className="flex flex-col gap-0.5 shrink-0">
          <button onClick={() => onMove(provider.id, "up")} disabled={rank === 1}
            className="h-4 w-4 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">
            <ChevronUp className="h-4 w-4" />
          </button>
          <button onClick={() => onMove(provider.id, "down")} disabled={rank === total}
            className="h-4 w-4 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>

        {/* Provider label */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{provider.provider_label}</p>
          <p className="text-[10px] font-mono text-muted-foreground truncate">{provider.provider_key}</p>
        </div>

        {/* Reference images toggle (only for image providers) */}
        {isImageProvider && (
          <button
            onClick={() => setShowImages(!showImages)}
            title="Style Reference Images"
            className={`h-7 px-2 rounded text-xs flex items-center gap-1 border transition-all
              ${showImages 
                ? "border-violet-400 bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:text-violet-400 font-semibold" 
                : "border-border bg-muted hover:bg-accent text-muted-foreground"}`}
          >
            <Images className="h-3 w-3 text-violet-500" />
            <span>Styles</span>
          </button>
        )}

        {/* Fallback toggle */}
        <div className="flex flex-col items-center gap-0.5">
          <button onClick={() => onToggleFallback(provider.id)}
            title={provider.fallback_on_error ? "Fallback on error: ON" : "Fallback on error: OFF"}
            className={`text-[9px] font-bold px-1.5 py-0.5 rounded border transition-all
              ${provider.fallback_on_error
                ? "border-warning bg-warning-primary text-warning"
                : "border-border bg-muted text-muted-foreground"}`}>
            FALLBACK
          </button>
        </div>

        {/* Test button */}
        <button onClick={() => onTest(provider.id, provider.provider_key)}
          disabled={testState === "testing"}
          className={`h-7 px-2 rounded text-xs flex items-center gap-1 border transition-all
            ${testState === "ok" ? "border-success bg-success-primary text-success"
              : testState === "error" ? "border-destructive/40 bg-destructive/5 text-destructive"
              : testState === "testing" ? "border-primary bg-primary/5 text-primary"
              : "border-border bg-muted hover:bg-accent text-muted-foreground"}`}>
          {testState === "testing" ? <Loader2 className="h-3 w-3 animate-spin" />
            : testState === "ok" ? <CheckCircle2 className="h-3 w-3" />
            : testState === "error" ? <XCircle className="h-3 w-3" />
            : <TestTube className="h-3 w-3" />}
          {testState === "idle" ? "Test" : testState === "testing" ? "..." : testState === "ok" ? "OK" : "Err"}
        </button>

        {/* Enable toggle */}
        <button onClick={() => onToggle(provider.id)}
          className={`relative w-9 h-5 rounded-full transition-colors shrink-0
            ${provider.enabled ? "bg-primary" : "bg-muted-foreground/30"}`}>
          <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform
            ${provider.enabled ? "left-4" : "left-0.5"}`} />
        </button>

        {/* Delete */}
        <button onClick={() => onDelete(provider.id)}
          className="text-muted-foreground hover:text-destructive transition-colors shrink-0">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {isImageProvider && showImages && (
        <ProviderReferenceImagesPicker providerSlug={provider.provider_key} />
      )}
    </div>
  );
}

// ── Provider Category Panel ──────────────────────────────────────────────────

function ProviderCategoryPanel({
  category,
  providers,
  mcpTools,
  onRefresh,
  onDeleteCategory,
}: {
  category: string;
  providers: ToolProvider[];
  mcpTools: MCPToolOption[];
  onRefresh: () => void;
  onDeleteCategory?: (category: string) => void;
}) {
  const [localProviders, setLocalProviders] = useState<ToolProvider[]>(providers);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [testStates, setTestStates] = useState<Record<string, "idle" | "testing" | "ok" | "error">>({});
  const [showAdd, setShowAdd] = useState(false);
  const [selectedNewProvider, setSelectedNewProvider] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [customLabel, setCustomLabel] = useState("");

  useEffect(() => {
    setLocalProviders(providers);
  }, [providers]);

  const meta = CATEGORY_META[category] ?? {
    label: category.charAt(0).toUpperCase() + category.slice(1),
    icon: <Sparkles className="h-4 w-4" />,
    color: "text-amber-500",
  };

  // Combine built-in presets with connected MCP tools
  const builtinOptions = BUILTIN_PRESETS[category] ?? [];
  const options = [...builtinOptions, ...mcpTools];

  const move = (id: string, dir: "up" | "down") => {
    const idx = localProviders.findIndex(p => p.id === id);
    if (idx < 0) return;
    const newProviders = [...localProviders];
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= newProviders.length) return;
    [newProviders[idx], newProviders[swapIdx]] = [newProviders[swapIdx], newProviders[idx]];
    setLocalProviders(newProviders.map((p, i) => ({ ...p, priority_order: i + 1 })));
  };

  const toggle = (id: string) => {
    setLocalProviders(prev => prev.map(p => p.id === id ? { ...p, enabled: !p.enabled } : p));
  };

  const toggleFallback = (id: string) => {
    setLocalProviders(prev => prev.map(p => p.id === id ? { ...p, fallback_on_error: !p.fallback_on_error } : p));
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/tool-providers?id=${id}`, { method: "DELETE" });
    if (res.ok) {
      setLocalProviders(prev => prev.filter(p => p.id !== id).map((p, i) => ({ ...p, priority_order: i + 1 })));
      onRefresh();
    }
  };

  const handleTest = async (id: string, providerKey: string) => {
    setTestStates(prev => ({ ...prev, [id]: "testing" }));
    try {
      const res = await fetch("/api/test-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerKey }),
      });
      const data = await res.json();
      setTestStates(prev => ({ ...prev, [id]: data.success ? "ok" : "error" }));
      setTimeout(() => setTestStates(prev => ({ ...prev, [id]: "idle" })), 8000);
    } catch {
      setTestStates(prev => ({ ...prev, [id]: "error" }));
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch("/api/tool-providers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool_category: category,
          ordered_providers: localProviders.map((p, i) => ({
            id: p.id,
            provider_key: p.provider_key,
            priority_order: i + 1,
            enabled: p.enabled,
            fallback_on_error: p.fallback_on_error,
          })),
        }),
      });
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2500);
      onRefresh();
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async () => {
    const isCustom = selectedNewProvider === "custom_mcp";
    const key = isCustom ? customKey : selectedNewProvider;
    const label = isCustom ? customLabel : (options.find(o => o.key === key)?.label ?? key);
    if (!key) return;

    const res = await fetch("/api/tool-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool_category: category,
        provider_key: key,
        provider_label: label,
        priority_order: localProviders.length + 1,
        enabled: true,
        fallback_on_error: true,
      }),
    });
    const data = await res.json();
    if (data.provider) {
      setLocalProviders(prev => [...prev, data.provider]);
      onRefresh();
    }
    setShowAdd(false);
    setSelectedNewProvider("");
    setCustomKey("");
    setCustomLabel("");
  };

  const isBuiltInCat = ["search", "extract", "image"].includes(category);

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b bg-muted/20">
        <span className={meta.color}>{meta.icon}</span>
        <span className="font-semibold text-sm">{meta.label} Tool Category</span>
        <span className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full ml-1">
          Priority list
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {savedOk && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
          <Button size="sm" onClick={handleSave} disabled={saving} className="h-7 px-2.5 text-xs gap-1">
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            Save Order
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowAdd(!showAdd)} className="h-7 px-2.5 text-xs gap-1">
            <Plus className="h-3 w-3" /> Add Provider
          </Button>
          {!isBuiltInCat && onDeleteCategory && (
            <Button size="sm" variant="ghost" onClick={() => onDeleteCategory(category)} className="h-7 px-2 text-destructive hover:bg-destructive/10">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Provider list */}
      <div className="p-4 space-y-2">
        {localProviders.length === 0 && (
          <div className="text-center py-6 text-sm text-muted-foreground border rounded-lg border-dashed">
            No providers configured for this category. Add a provider below.
          </div>
        )}
        {localProviders.map((p, idx) => (
          <ProviderItem
            key={p.id}
            provider={p}
            rank={idx + 1}
            total={localProviders.length}
            onMove={move}
            onToggle={toggle}
            onToggleFallback={toggleFallback}
            onDelete={handleDelete}
            onTest={handleTest}
            testState={testStates[p.id] ?? "idle"}
          />
        ))}
      </div>

      {/* Add provider form */}
      {showAdd && (
        <div className="border-t p-4 bg-muted/10 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Add Provider / MCP Action</p>
          <div className="flex flex-col sm:flex-row gap-2">
            <select
              value={selectedNewProvider}
              onChange={e => setSelectedNewProvider(e.target.value)}
              className="flex-1 h-8 rounded-md border border-input bg-background px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">Select a tool or preset...</option>
              {options.filter(o => !localProviders.some(p => p.provider_key === o.key) || o.key === "custom_mcp").map(o => (
                <option key={o.key} value={o.key}>
                  {o.label} ({o.badge})
                </option>
              ))}
              <option value="custom_mcp">Custom Key (manual entry) →</option>
            </select>
            {selectedNewProvider === "custom_mcp" && (
              <div className="flex gap-2">
                <Input value={customKey} onChange={e => setCustomKey(e.target.value)}
                  placeholder="e.g. gmail_send_email" className="h-8 text-sm w-36 font-mono" />
                <Input value={customLabel} onChange={e => setCustomLabel(e.target.value)}
                  placeholder="Display name" className="h-8 text-sm w-36" />
              </div>
            )}
            <div className="flex gap-1.5">
              <Button size="sm" onClick={handleAdd}
                disabled={!selectedNewProvider || (selectedNewProvider === "custom_mcp" && !customKey)}
                className="h-8 px-3 text-xs gap-1">
                <Plus className="h-3.5 w-3.5" /> Add
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}
                className="h-8 px-2 text-xs">
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── LLM Provider definitions ─────────────────────────────────────────────────

export const LLM_PROVIDERS = [
  {
    id: "vercel",
    label: "Vercel AI Gateway",
    envKey: "AI_GATEWAY_API_KEY",
    docsUrl: "https://ai-gateway.vercel.sh",
    defaultModels: [
      { value: "xiaomi/mimo-v2.5-pro", label: "MiMo v2.5 Pro", badge: "Recommended" },
      { value: "moonshotai/kimi-k2.5", label: "Kimi K2.5", badge: "Vision" },
      { value: "minimax/minimax-m2.7", label: "MiniMax M2.7", badge: "Fast" },
      { value: "openai/gpt-4o", label: "GPT-4o", badge: "OpenAI" },
      { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", badge: "Google" },
      { value: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", badge: "Anthropic" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    docsUrl: "https://platform.openai.com/api-keys",
    defaultModels: [
      { value: "gpt-4.1", label: "GPT-4.1", badge: "Latest" },
      { value: "gpt-4o", label: "GPT-4o", badge: "Vision" },
      { value: "gpt-4o-mini", label: "GPT-4o Mini", badge: "Fast" },
      { value: "o3", label: "o3", badge: "Reasoning" },
      { value: "o4-mini", label: "o4-mini", badge: "Reasoning" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    docsUrl: "https://console.anthropic.com/settings/keys",
    defaultModels: [
      { value: "claude-opus-4-5", label: "Claude Opus 4.5", badge: "Most Capable" },
      { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", badge: "Balanced" },
      { value: "claude-haiku-3-5", label: "Claude Haiku 3.5", badge: "Fast" },
    ],
  },
  {
    id: "google",
    label: "Google Gemini",
    envKey: "GOOGLE_API_KEY",
    docsUrl: "https://aistudio.google.com/app/apikey",
    defaultModels: [
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", badge: "Latest" },
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", badge: "Fast" },
      { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash", badge: "Stable" },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    docsUrl: "https://openrouter.ai/keys",
    defaultModels: [
      { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", badge: "Google" },
      { value: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick", badge: "Meta" },
      { value: "deepseek/deepseek-r2", label: "DeepSeek R2", badge: "Reasoning" },
      { value: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", badge: "Anthropic" },
      { value: "openai/gpt-4o", label: "GPT-4o", badge: "OpenAI" },
      { value: "mistralai/mistral-large", label: "Mistral Large", badge: "Mistral" },
    ],
  },
  {
    id: "litellm",
    label: "LiteLLM Proxy",
    envKey: "LITELLM_API_KEY",
    docsUrl: "https://github.com/BerriAI/litellm",
    defaultModels: [
      { value: "mimo-v2.5-pro", label: "Mimo v2.5 Pro", badge: "LiteLLM" },
      { value: "openai/gpt-oss-120b", label: "GPT OSS 120B", badge: "LiteLLM" },
    ],
  },
  {
    id: "groq",
    label: "Groq",
    envKey: "GROQ_API_KEY",
    docsUrl: "https://console.groq.com/keys",
    defaultModels: [
      { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", badge: "Fast" },
      { value: "llama-3.1-8b-instant", label: "Llama 3.1 8B", badge: "Ultra Fast" },
      { value: "gemma2-9b-it", label: "Gemma 2 9B", badge: "Google" },
      { value: "deepseek-r1-distill-llama-70b", label: "DeepSeek R1 70B", badge: "Reasoning" },
    ],
  },
  {
    id: "together",
    label: "Together AI",
    envKey: "TOGETHER_API_KEY",
    docsUrl: "https://api.together.xyz",
    defaultModels: [
      { value: "meta-llama/Llama-3.3-70B-Instruct-Turbo", label: "Llama 3.3 70B Turbo", badge: "Fast" },
      { value: "deepseek-ai/DeepSeek-R1", label: "DeepSeek R1", badge: "Reasoning" },
      { value: "Qwen/Qwen2.5-72B-Instruct-Turbo", label: "Qwen 2.5 72B", badge: "Qwen" },
      { value: "mistralai/Mistral-7B-Instruct-v0.3", label: "Mistral 7B", badge: "Efficient" },
    ],
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    envKey: "NVIDIA_API_KEY",
    docsUrl: "https://build.nvidia.com",
    defaultModels: [
      { value: "minimaxai/minimax-m2.7", label: "MiniMax M2.7", badge: "Recommended" },
      { value: "stepfun-ai/step-3.7-flash", label: "Step 3.7 Flash", badge: "Fast" },
      { value: "openai/gpt-oss-120b", label: "GPT OSS 120B", badge: "Large" },
      { value: "deepseek-ai/deepseek-v4-flash", label: "DeepSeek V4 Flash", badge: "Reasoning" },
    ],
  },
  {
    id: "mimo",
    label: "Xiaomi MiMo",
    envKey: "MIMO_API_KEY",
    docsUrl: "https://platform.xiaomimimo.com",
    defaultModels: [
      { value: "mimo-v2.5-pro", label: "MiMo V2.5 Pro", badge: "Flagship" },
      { value: "mimo-v2.5", label: "MiMo V2.5", badge: "Fast" },
    ],
  },
  {
    id: "novita",
    label: "Novita AI",
    envKey: "NOVITA_API_KEY",
    docsUrl: "https://novita.ai",
    defaultModels: [
      { value: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", badge: "Recommended" },
      { value: "deepseek/deepseek-r2", label: "DeepSeek R2", badge: "Reasoning" },
      { value: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick", badge: "Meta" },
      { value: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B", badge: "Fast" },
      { value: "qwen/qwen3-235b-a22b", label: "Qwen3 235B", badge: "Large" },
      { value: "google/gemma-3-27b-it", label: "Gemma 3 27B", badge: "Google" },
    ],
  },
  {
    id: "opencode",
    label: "OpenCode AI",
    envKey: "OPENCODE_API_KEY",
    docsUrl: "https://opencode.ai",
    defaultModels: [
      { value: "minimax-m3-free", label: "MiniMax M3 Free", badge: "MiniMax" },
      { value: "mimo-v2.5-free", label: "MiMo V2.5 Free", badge: "Xiaomi" },
      { value: "north-mini-code-free", label: "North Mini Code Free", badge: "Stealth" },
      { value: "nemotron-3-ultra-free", label: "Nemotron 3 Ultra Free", badge: "NVIDIA" },
      { value: "deepseek-v4-flash-free", label: "DeepSeek V4 Flash Free", badge: "DeepSeek" },
      { value: "qwen3.6-plus", label: "Qwen3.6 Plus Free", badge: "Qwen" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    docsUrl: "https://platform.deepseek.com",
    defaultModels: [
      { value: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", badge: "Fast" },
      { value: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", badge: "Pro" },
    ],
  },
];

type TestResult = { status: "idle" | "testing" | "ok" | "error"; latency?: number; error?: string };

function LLMProvidersPanel() {
  const [activeProviderId, setActiveProviderId] = useState("vercel");
  const [customModelsByProvider, setCustomModelsByProvider] = useState<Record<string, string[]>>({});
  const [newModelInputs, setNewModelInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState<string | null>(null);
  const [envStatus, setEnvStatus] = useState<Record<string, boolean>>({});
  const [selectedModel, setSelectedModel] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  useEffect(() => {
    fetch("/api/test-ai-model")
      .then(r => r.json())
      .then(data => {
        setEnvStatus(data.env_status ?? {});
        setCustomModelsByProvider(data.custom_models ?? {});
      })
      .catch(() => {});
  }, []);

  const allModels = (providerId: string, defaults: { value: string; label: string; badge: string }[]) => {
    const custom = customModelsByProvider[providerId] ?? [];
    return [
      ...defaults,
      ...custom.map(v => ({ value: v, label: v, badge: "Custom" })),
    ];
  };

  const handleTestModel = async (providerId: string) => {
    const activeProvider = LLM_PROVIDERS.find(p => p.id === providerId);
    if (!activeProvider) return;
    const models = allModels(providerId, activeProvider.defaultModels);
    const model = selectedModel[providerId] ?? models[0]?.value;
    if (!model) return;

    setTestResults(prev => ({ ...prev, [providerId]: { status: "testing" } }));
    const start = Date.now();
    try {
      const res = await fetch("/api/test-ai-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, model }),
      });
      const data = await res.json();
      if (data.success) {
        setTestResults(prev => ({ ...prev, [providerId]: { status: "ok", latency: data.latency_ms ?? (Date.now() - start) } }));
      } else {
        setTestResults(prev => ({ ...prev, [providerId]: { status: "error", error: data.error ?? "Failed" } }));
      }
    } catch (e) {
      setTestResults(prev => ({ ...prev, [providerId]: { status: "error", error: e instanceof Error ? e.message : "Error" } }));
    }
    setTimeout(() => setTestResults(prev => ({ ...prev, [providerId]: { status: "idle" } })), 10_000);
  };

  const handleAddModel = (providerId: string) => {
    const val = (newModelInputs[providerId] ?? "").trim();
    if (!val) return;
    setCustomModelsByProvider(prev => ({
      ...prev,
      [providerId]: [...(prev[providerId] ?? []), val],
    }));
    setNewModelInputs(prev => ({ ...prev, [providerId]: "" }));
  };

  const handleRemoveModel = (providerId: string, idx: number) => {
    setCustomModelsByProvider(prev => ({
      ...prev,
      [providerId]: (prev[providerId] ?? []).filter((_, i) => i !== idx),
    }));
  };

  const handleSave = async (providerId: string) => {
    setSaving(providerId);
    try {
      await fetch("/api/test-ai-model", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider_id: providerId,
          custom_models: customModelsByProvider[providerId] ?? [],
        }),
      });
      setSavedOk(providerId);
      setTimeout(() => setSavedOk(null), 2500);
    } finally {
      setSaving(null);
    }
  };

  const activeProvider = LLM_PROVIDERS.find(p => p.id === activeProviderId) || LLM_PROVIDERS[0];
  const customModels = customModelsByProvider[activeProvider.id] ?? [];
  const keySet = envStatus[activeProvider.id] === true;
  const models = allModels(activeProvider.id, activeProvider.defaultModels);
  const selected = selectedModel[activeProvider.id] ?? models[0]?.value ?? "";
  const tr = testResults[activeProvider.id] ?? { status: "idle" };

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b bg-muted/20">
        <Brain className="h-4 w-4 text-primary" />
        <span className="font-semibold text-sm">LLM Providers & Models</span>
        <span className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full ml-1">
          API keys · models · test connection
        </span>
      </div>

      <div className="p-5 space-y-6">
        {/* Row 1: Select Provider & Status */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div className="md:col-span-2 space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">AI Provider</label>
            <select
              value={activeProviderId}
              onChange={e => setActiveProviderId(e.target.value)}
              className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary transition-all font-medium"
            >
              {LLM_PROVIDERS.map(p => {
                const isConnected = envStatus[p.id] === true;
                return (
                  <option key={p.id} value={p.id}>
                    {p.label} ({isConnected ? "Connected" : "Key Not Set"})
                  </option>
                );
              })}
            </select>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block">Status</span>
            <span className={`h-10 px-4 rounded-lg border flex items-center justify-center gap-1.5 shadow-sm font-medium text-xs transition-all w-full
              ${keySet
                ? "bg-success-primary text-success border border-success/30"
                : "bg-destructive/10 text-destructive border border-destructive/20"
              }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${keySet ? "bg-success animate-pulse" : "bg-destructive"}`} />
              {keySet ? "Connected" : "Key Not Set"}
            </span>
          </div>
        </div>

        {/* Info Box */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-lg border bg-muted/20 text-xs">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <Key className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Requires environment variable:</span>
              <code className="text-[11px] font-mono bg-muted-foreground/10 px-1.5 py-0.5 rounded text-foreground font-bold">
                {activeProvider.envKey}
              </code>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Add this key to your server's <code className="font-mono bg-muted px-1 rounded text-[10px]">.env</code> file to enable this provider.
            </p>
          </div>
          <a
            href={activeProvider.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 h-8 px-3.5 rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 flex items-center justify-center gap-1 text-xs font-semibold transition-colors"
          >
            Get Key <ChevronRight className="h-3.5 w-3.5" />
          </a>
        </div>

        {/* Row 2: Select Model & Test */}
        <div className="rounded-lg border bg-card p-4 space-y-4 shadow-inner">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <TestTube className="h-3.5 w-3.5 text-primary" /> Test Connection
          </p>
          <div className="flex flex-col sm:flex-row gap-2.5">
            <select
              value={selected}
              onChange={e => setSelectedModel(prev => ({ ...prev, [activeProvider.id]: e.target.value }))}
              className="flex-1 h-9 rounded-md border border-input bg-background px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary transition-all font-mono"
            >
              {models.map(m => (
                <option key={m.value} value={m.value}>
                  {m.label} ({m.badge})
                </option>
              ))}
            </select>
            <button
              onClick={() => handleTestModel(activeProvider.id)}
              disabled={tr.status === "testing" || !keySet}
              className={`h-9 px-4 rounded-md text-xs font-medium flex items-center justify-center gap-1.5 border transition-all shrink-0
                ${tr.status === "ok"
                  ? "border-success/30 bg-success-primary text-success shadow-sm"
                  : tr.status === "error"
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : tr.status === "testing"
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-border bg-muted hover:bg-accent hover:text-accent-foreground text-foreground"
                } disabled:opacity-50 min-w-[100px]`}
            >
              {tr.status === "testing"
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Testing...</>
                : tr.status === "ok"
                ? <><CheckCircle2 className="h-3.5 w-3.5" /> {tr.latency}ms OK</>
                : tr.status === "error"
                ? <><XCircle className="h-3.5 w-3.5" /> Error</>
                : <><TestTube className="h-3.5 w-3.5" /> Test</>
              }
            </button>
          </div>
          {tr.status === "error" && tr.error && (
            <p className="text-[11px] text-rose-400 bg-rose-500/5 border border-rose-500/20 rounded-md px-3 py-2 font-mono whitespace-pre-wrap">
              {tr.error}
            </p>
          )}
        </div>

        {/* Row 3: Custom Models */}
        <div className="space-y-3 pt-3 border-t">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-primary" /> Custom Models
            </p>
            <div className="flex items-center gap-1.5">
              {savedOk === activeProvider.id && (
                <span className="text-[11px] text-emerald-500 font-semibold flex items-center gap-1 animate-fade-in">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Saved successfully
                </span>
              )}
              <button
                onClick={() => handleSave(activeProvider.id)}
                disabled={saving === activeProvider.id}
                className="flex items-center gap-1 h-7 px-3 rounded bg-primary text-primary-foreground hover:bg-primary/90 text-[11px] font-semibold transition-colors disabled:opacity-50"
              >
                {saving === activeProvider.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Save Changes
              </button>
            </div>
          </div>

          {customModels.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {customModels.map((m, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-card/50 text-xs shadow-sm">
                  <Sparkles className="h-3 w-3 text-primary shrink-0" />
                  <p className="flex-1 text-[11px] font-mono truncate text-foreground">{m}</p>
                  <button
                    onClick={() => handleRemoveModel(activeProvider.id, i)}
                    className="text-muted-foreground hover:text-rose-400 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">No custom models configured. You can add your own models below.</p>
          )}

          <div className="flex gap-2 pt-1">
            <input
              type="text"
              value={newModelInputs[activeProvider.id] ?? ""}
              onChange={e => setNewModelInputs(prev => ({ ...prev, [activeProvider.id]: e.target.value }))}
              onKeyDown={e => e.key === "Enter" && handleAddModel(activeProvider.id)}
              placeholder={`Enter model ID (e.g. ${activeProvider.defaultModels[0]?.value ?? "model-id"})`}
              className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <button
              onClick={() => handleAddModel(activeProvider.id)}
              disabled={!newModelInputs[activeProvider.id]}
              className="h-9 px-4 rounded-md bg-secondary hover:bg-secondary/80 text-secondary-foreground text-xs font-semibold flex items-center gap-1 disabled:opacity-50 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" /> Add Model
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SuperIndexingSettingsPanel({
  globalSettings,
  setGlobalSetting,
  saveGlobalSettings,
  saveStatus,
}: {
  globalSettings: Record<string, string>;
  setGlobalSetting: (k: string, v: string) => void;
  saveGlobalSettings: () => Promise<void>;
  saveStatus: "idle" | "saving" | "saved" | "error";
}) {
  const superEnabled = globalSettings.super_indexing_enabled === "true";
  const normalEnabled = globalSettings.normal_indexing_enabled === "true";

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b bg-muted/20">
        <Brain className="h-4 w-4 text-primary" />
        <span className="font-semibold text-sm">Super Index & Sync Settings</span>
        <span className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full ml-1">
          Control tool indexing and progressive disclosure behavior
        </span>
      </div>

      <div className="p-5 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center justify-between p-3.5 rounded-lg border bg-muted/20">
            <div>
              <p className="text-xs font-semibold">Enable Super Indexing</p>
              <p className="text-[10px] text-muted-foreground">Summarize MCP connections and load tools on-demand via list_tools(mcp_name="...")</p>
            </div>
            <button
              onClick={() => setGlobalSetting("super_indexing_enabled", superEnabled ? "false" : "true")}
              className={`relative w-11 h-6 rounded-full transition-colors ${superEnabled ? "bg-primary" : "bg-muted-foreground/30"}`}
            >
              <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${superEnabled ? "left-6" : "left-1"}`} />
            </button>
          </div>

          <div className="flex items-center justify-between p-3.5 rounded-lg border bg-muted/20">
            <div>
              <p className="text-xs font-semibold">Enable Normal Prompt Indexing</p>
              <p className="text-[10px] text-muted-foreground">Inject compact tool summaries directly into agent system prompt</p>
            </div>
            <button
              onClick={() => setGlobalSetting("normal_indexing_enabled", normalEnabled ? "false" : "true")}
              className={`relative w-11 h-6 rounded-full transition-colors ${normalEnabled ? "bg-primary" : "bg-muted-foreground/30"}`}
            >
              <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${normalEnabled ? "left-6" : "left-1"}`} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-3 border-t">
          <Button
            onClick={saveGlobalSettings}
            disabled={saveStatus === "saving"}
            className="bg-primary text-primary-foreground text-xs font-semibold h-9 px-4 flex items-center gap-1.5"
          >
            {saveStatus === "saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save Indexing Settings
          </Button>
          {saveStatus === "saved" && (
            <span className="text-xs font-semibold text-emerald-500 flex items-center gap-1 animate-pulse">
              <CheckCircle2 className="h-4 w-4" /> Saved successfully!
            </span>
          )}
        </div>
      </div>
    </div>
  );
}



export function ProviderOrderingSection({
  globalSettings,
  setGlobalSetting,
  saveGlobalSettings,
  saveStatus,
}: {
  globalSettings?: Record<string, string>;
  setGlobalSetting?: (k: string, v: string) => void;
  saveGlobalSettings?: () => Promise<void>;
  saveStatus?: "idle" | "saving" | "saved" | "error";
}) {
  const [providers, setProviders] = useState<ToolProvider[]>([]);
  const [mcpTools, setMcpTools] = useState<MCPToolOption[]>([]);
  const [loading, setLoading] = useState(true);

  // New Category Form State
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch all tool providers
      const res = await fetch("/api/tool-providers");
      const data = await res.json();
      setProviders(data.providers ?? []);

      // Fetch MCP connections to extract available tools
      const mcpRes = await fetch("/api/mcp/composio/connections");
      const mcpData = await mcpRes.json();
      const options: MCPToolOption[] = [];
      (mcpData.connections ?? []).forEach((conn: any) => {
        (conn.available_tools ?? []).forEach((t: any) => {
          options.push({
            key: t.tool_key,
            label: t.tool_name ?? t.tool_key,
            badge: conn.label || conn.toolkit_slug || "Connected MCP",
          });
        });
      });
      setMcpTools(options);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Group by category
  const categories = Array.from(new Set([
    "search", "extract", "image",
    ...providers.map(p => p.tool_category)
  ]));

  const handleCreateCategory = async () => {
    const slug = newCategoryName.toLowerCase().replace(/[^a-z0-9_]/g, "_").trim();
    if (!slug) return;
    
    // Create first dummy provider in this category to register it
    await fetch("/api/tool-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool_category: slug,
        provider_key: "placeholder",
        provider_label: "Placeholder Tool",
        priority_order: 1,
        enabled: false,
        fallback_on_error: true,
      }),
    });
    
    setNewCategoryName("");
    setShowNewCategory(false);
    fetchData();
  };

  const handleDeleteCategory = async (categoryToDelete: string) => {
    const toDelete = providers.filter(p => p.tool_category === categoryToDelete);
    for (const p of toDelete) {
      await fetch(`/api/tool-providers?id=${p.id}`, { method: "DELETE" });
    }
    fetchData();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading providers data...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* LLM Providers Panel */}
      <div>
        <h2 className="font-semibold text-base mb-3">AI Providers</h2>
        <LLMProvidersPanel />
      </div>

      {/* Super Indexing Settings */}
      {globalSettings && setGlobalSetting && saveGlobalSettings && saveStatus && (
        <SuperIndexingSettingsPanel
          globalSettings={globalSettings}
          setGlobalSetting={setGlobalSetting}
          saveGlobalSettings={saveGlobalSettings}
          saveStatus={saveStatus}
        />
      )}



      {/* Divider */}
      <div className="relative">
        <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-dashed" /></div>
        <div className="relative flex justify-center">
          <span className="bg-background px-3 text-[11px] text-muted-foreground uppercase tracking-widest font-medium flex items-center gap-1.5">
            <Zap className="h-3 w-3" /> Unified Tool Priority & Fallback
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-sm mb-0.5">Search, Extract & Image Tools</h3>
          <p className="text-xs text-muted-foreground">
            Group multiple tools into unified categories, priority-number them (1, 2, 3), and let the agent fall back automatically.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowNewCategory(!showNewCategory)} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          Create Unified Tool
        </Button>
      </div>

      {/* Create New Category Form */}
      {showNewCategory && (
        <div className="rounded-xl border bg-muted/10 p-4 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Create New Unified Tool Category</p>
          <div className="flex gap-2">
            <Input
              value={newCategoryName}
              onChange={e => setNewCategoryName(e.target.value)}
              placeholder="e.g. gmail_integration, db_query, translation..."
              className="h-8 text-sm flex-1"
            />
            <Button size="sm" onClick={handleCreateCategory} disabled={!newCategoryName} className="h-8 text-xs">
              Create Category
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowNewCategory(false)} className="h-8 text-xs">
              Cancel
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            This creates a new unified tool category. You can then add different MCP tools (or custom keys) under it and rank them.
          </p>
        </div>
      )}

      {/* Info banner */}
      <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-primary/5 border border-primary/20 text-xs">
        <AlertCircle className="h-4 w-4 text-primary shrink-0 mt-0.5" />
        <div>
          <p className="font-medium text-primary mb-0.5">Flexible Priority Fallback System</p>
          <p className="text-muted-foreground">
            Suppose you have 3 same tools (e.g. Gmail Connection A, B, and C). You can create a unified tool category <span className="font-semibold text-foreground">gmail</span>, add all three tools as providers, and number them <span className="font-mono bg-muted px-1 rounded">#1 A → #2 B → #3 C</span>. If A fails, it falls back to B, then C.
          </p>
        </div>
      </div>

      {/* Render panels dynamically */}
      {categories.map(cat => (
        <ProviderCategoryPanel
          key={cat}
          category={cat}
          providers={providers.filter(p => p.tool_category === cat)}
          mcpTools={mcpTools}
          onRefresh={fetchData}
          onDeleteCategory={handleDeleteCategory}
        />
      ))}
    </div>
  );
}
