"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Plus, Trash2, Save, Loader2, CheckCircle2,
  XCircle, ChevronUp, ChevronDown, Zap, Search, FileText,
  Image as ImageIcon, TestTube, AlertCircle, Sparkles,
  Brain, Key, ChevronRight, X, Images, Route, Sliders
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JanCard, CardItem } from "@/components/settings/JanCard";
import { KNOWN_PLUGIN_TOOLS } from "@/lib/plugins";

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
    { key: "kie",          label: "KIE AI",              badge: "img2img" },
    { key: "grok_imagine", label: "Grok Imagine Image", badge: "xAI / Vercel" },
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
  const [showCategorySchema, setShowCategorySchema] = useState(false);
  const [categorySchema, setCategorySchema] = useState<any>(null);
  const [loadingCategorySchema, setLoadingCategorySchema] = useState(false);
  const [categoryBindings, setCategoryBindings] = useState<Record<string, any>>({});

  const activeToolKey = category === "image" ? "create_post_image" : category === "search" ? "unified_search" : category === "extract" ? "unified_extract" : category;
  const topProvider = localProviders.find(p => p.enabled);

  const loadCategorySchemaAndBindings = async () => {
    setLoadingCategorySchema(true);
    try {
      const [sRes, pRes] = await Promise.all([
        fetch(`/api/tools/schemas?tool_key=${activeToolKey}`),
        fetch("/api/tools/permissions"),
      ]);
      const sData = await sRes.json();
      const pData = await pRes.json();
      if (sData.schema) setCategorySchema(sData.schema);
      if (pData.builtin_bindings?.[activeToolKey]) setCategoryBindings(pData.builtin_bindings[activeToolKey]);
    } catch (e) {
      console.warn("Failed to load category schema:", e);
    } finally {
      setLoadingCategorySchema(false);
    }
  };

  const handleCategoryBindingChange = async (paramName: string, binding: { value: any; decide_by_ai: boolean } | null) => {
    const nextBindings = { ...categoryBindings };
    if (binding === null) {
      delete nextBindings[paramName];
    } else {
      nextBindings[paramName] = binding;
    }
    setCategoryBindings(nextBindings);

    try {
      await fetch("/api/tools/permissions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool_key: activeToolKey,
          tool_type: "builtin",
          parameter_bindings: nextBindings,
        }),
      });
    } catch (e) {
      console.error("Failed to save category binding:", e);
    }
  };

  return (
    <JanCard
      className="p-0 overflow-hidden"
      header={
        /* Header */
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/40 bg-muted/20 flex-wrap">
        <span className={meta.color}>{meta.icon}</span>
        <span className="font-semibold text-sm">{meta.label} Tool Category</span>
        <span className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full ml-1">
          Priority list
        </span>
        {topProvider && (
          <span className="text-[10px] bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded-full font-semibold">
            #1 Active: {topProvider.provider_label}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {savedOk && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}

          {isBuiltInCat && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const next = !showCategorySchema;
                setShowCategorySchema(next);
                if (next) loadCategorySchemaAndBindings();
              }}
              className={`h-7 px-2.5 text-xs gap-1 ${showCategorySchema ? "bg-primary/10 text-primary border-primary/30" : ""}`}
              title="Lock parameters on priority #1 provider schema"
            >
              <Sliders className="h-3 w-3" /> Priority Schema
            </Button>
          )}

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
      }
    >
      {/* Priority Schema Drawer */}
      {showCategorySchema && (
        <div className="border-b bg-muted/30 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sliders className="h-4 w-4 text-primary" />
              <p className="text-xs font-semibold text-foreground">
                Priority #1 Provider Schema Customization ({topProvider?.provider_label || meta.label})
              </p>
            </div>
            <span className="text-[10px] text-muted-foreground italic">
              Values set here are locked & injected automatically into {activeToolKey}
            </span>
          </div>

          {loadingCategorySchema ? (
            <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading schema...
            </div>
          ) : !categorySchema?.parameters?.properties ? (
            <p className="text-xs text-muted-foreground italic">No configurable parameters found.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-1">
              {Object.entries(categorySchema.parameters.properties).map(([paramName, paramSchema]: [string, any]) => {
                const binding = categoryBindings[paramName];
                const decideByAi = binding ? binding.decide_by_ai : true;
                const val = binding ? binding.value : (paramSchema.default !== undefined ? paramSchema.default : "");

                return (
                  <div key={paramName} className="p-2.5 rounded-md border bg-background space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-bold text-foreground">{paramName}</span>
                      <select
                        value={decideByAi ? "ai" : "fixed"}
                        onChange={(e) => {
                          if (e.target.value === "ai") {
                            handleCategoryBindingChange(paramName, null);
                          } else {
                            handleCategoryBindingChange(paramName, { value: val, decide_by_ai: false });
                          }
                        }}
                        className={`h-5 text-[10px] rounded border px-1.5 font-medium cursor-pointer ${
                          !decideByAi ? "bg-primary/10 border-primary text-primary font-bold" : "bg-background border-input text-muted-foreground"
                        }`}
                      >
                        <option value="ai">Decide by AI</option>
                        <option value="fixed">Fixed Value (Locked)</option>
                      </select>
                    </div>

                    {paramSchema.description && (
                      <p className="text-[10px] text-muted-foreground leading-tight">{paramSchema.description}</p>
                    )}

                    {!decideByAi && (
                      <div className="pt-1">
                        {paramSchema.enum ? (
                          <select
                            value={val}
                            onChange={(e) => handleCategoryBindingChange(paramName, { value: e.target.value, decide_by_ai: false })}
                            className="w-full h-7 text-xs rounded border border-input bg-background px-2"
                          >
                            <option value="">-- Select option --</option>
                            {paramSchema.enum.map((opt: string) => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                        ) : paramSchema.type === "boolean" ? (
                          <label className="flex items-center gap-2 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={!!val}
                              onChange={(e) => handleCategoryBindingChange(paramName, { value: e.target.checked, decide_by_ai: false })}
                              className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5"
                            />
                            <span className="text-xs font-medium">True</span>
                          </label>
                        ) : (
                          <Input
                            type="text"
                            value={val}
                            onChange={(e) => handleCategoryBindingChange(paramName, { value: e.target.value, decide_by_ai: false })}
                            className="h-7 text-xs"
                            placeholder="Enter locked value..."
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

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
    </JanCard>
  );
}

// ── Built-in Tools Registry for Fallbacks ───────────────────────────────────
const ALL_BUILTIN_TOOLS = [
  { key: "think_tool", label: "Think Tool", badge: "Built-in" },
  { key: "fetch_images_brave", label: "Brave Image Search", badge: "Built-in" },
  { key: "create_post_image", label: "Image Generator", badge: "Built-in" },
  { key: "save_wordpress_post", label: "Save WP Article", badge: "Built-in" },
  { key: "save_youtube_video", label: "Save YouTube Video", badge: "Built-in" },
  { key: "save_instagram_post", label: "Save Instagram Post/Reel", badge: "Built-in" },
  { key: "save_facebook_post", label: "Save Facebook Post", badge: "Built-in" },
  { key: "save_social_bundle", label: "Save Social Bundle", badge: "Built-in" },
  { key: "get_wordpress_categories", label: "WP Categories", badge: "Built-in" },
  { key: "publish_to_wordpress", label: "WordPress Publish", badge: "Built-in" },
  { key: "youtube_transcript", label: "YouTube Transcript", badge: "Built-in" },
  { key: "search_conversation_history", label: "Search History", badge: "Built-in" },
  { key: "add_memory", label: "Add Memory", badge: "Built-in" },
  { key: "replace_memory", label: "Replace Memory", badge: "Built-in" },
  { key: "remove_memory", label: "Remove Memory", badge: "Built-in" },
  { key: "honcho_profile", label: "Honcho Profile", badge: "Built-in" },
  { key: "honcho_search", label: "Honcho Search", badge: "Built-in" },
  { key: "honcho_reasoning", label: "Honcho Reasoning", badge: "Built-in" },
  { key: "honcho_context", label: "Honcho Context", badge: "Built-in" },
  { key: "honcho_conclude", label: "Honcho Conclude", badge: "Built-in" },
  { key: "list_tools", label: "List Tools", badge: "Built-in" },
  { key: "load_tools", label: "Load Tools", badge: "Built-in" },
  { key: "call_tool", label: "Call Tool", badge: "Built-in" },
  { key: "cronjob", label: "Cron Scheduler", badge: "Built-in" },
  { key: "omni_analyzer", label: "Omni Analyzer", badge: "Built-in" },
];

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

      const options: MCPToolOption[] = [];

      // 1. Fetch Composio connections
      try {
        const mcpRes = await fetch("/api/mcp/composio/connections");
        const mcpData = await mcpRes.json();
        (mcpData.connections ?? []).forEach((conn: any) => {
          (conn.available_tools ?? []).forEach((t: any) => {
            options.push({
              key: t.tool_key,
              label: t.tool_name ?? t.tool_key,
              badge: conn.label || conn.toolkit_slug || "Composio",
            });
          });
        });
      } catch (err) {
        console.error("Failed to fetch Composio tools:", err);
      }

      // 2. Fetch Manual MCP connections
      try {
        const manualRes = await fetch("/api/mcp/manual?sync=false");
        const manualData = await manualRes.json();
        (manualData.connections ?? []).forEach((conn: any) => {
          (conn.available_tools ?? []).forEach((t: any) => {
            options.push({
              key: t.tool_key,
              label: t.tool_name ?? t.tool_key,
              badge: conn.label || conn.name || "Manual MCP",
            });
          });
        });
      } catch (err) {
        console.error("Failed to fetch Manual MCP tools:", err);
      }

      // 3. Add all other built-in tools (skip tools owned by disabled plugins)
      try {
        const pluginRes = await fetch("/api/plugins");
        const pluginData = await pluginRes.json();
        const blocked = new Set<string>();
        (pluginData.plugins ?? []).forEach((p: any) => {
          if (!p.enabled) {
            const keys: string[] = p.tool_keys?.length ? p.tool_keys : (KNOWN_PLUGIN_TOOLS[p.plugin_key] ?? []);
            keys.forEach((k: string) => blocked.add(k));
          }
        });
        ALL_BUILTIN_TOOLS.forEach(t => {
          if (!blocked.has(t.key)) options.push(t);
        });
      } catch {
        ALL_BUILTIN_TOOLS.forEach(t => {
          options.push(t);
        });
      }

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
      <div>
        <h1 className="text-xl font-bold font-studio flex items-center gap-2">
          <Route className="h-5 w-5 text-primary" />
          Fallback System & Tool Priority
        </h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Group tools into unified fallback categories (Search, Extract, Image generation, Custom tools), set priority order (1, 2, 3), and let the agent fall back automatically.
        </p>
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
        <div className="rounded-xl border border-border/40 bg-muted/10 p-4 space-y-3">
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
