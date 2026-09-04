"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Loader2, Zap, Package, ChevronDown, ChevronRight,
  Shield, ShieldAlert, ShieldCheck, Sliders, Check, X,
  HelpCircle, Settings2
} from "lucide-react";
import { JanCard } from "@/components/settings/JanCard";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { usePlugins, disabledPluginToolKeys } from "@/lib/plugins";

const BUILTIN_TOOLS = [
  { key: "create_post_image", label: "Image Generator", desc: "Create & edit styled post images with AI (KIE AI / Grok Imagine)" },
  { key: "unified_search", label: "Web Search", desc: "Real-time search across Linkup, Parallel AI, Tavily, Exa" },
  { key: "unified_extract", label: "URL Extractor", desc: "Full-page clean content and markdown extractor" },
  { key: "terminal", label: "Terminal", desc: "Execute OS shell commands with full server workspace access" },
  { key: "upload_to_storage", label: "Upload to Storage", desc: "Upload a local file to Cloudflare R2 / Supabase and return a public shareable link" },
  { key: "omni_analyzer", label: "Omni Analyzer", desc: "Analyze ANY file (PDF, PPT, DOCX, XLSX, audio, video) or URL" },
  { key: "youtube_transcript", label: "YouTube Transcript", desc: "Get video transcripts without keys via youtube-transcript.ai" },
  { key: "text_to_speech", label: "Text to Speech (Voice)", desc: "Convert text to spoken audio via ElevenLabs, Edge, or OpenAI" },
  { key: "think_tool", label: "Think Tool", desc: "Internal reasoning scratchpad for deep thinking" },
  { key: "search_conversation_history", label: "Smart Search History", desc: "3-Strategy (Full-text + Semantic + Entity Probe) search over history" },
  { key: "add_memory", label: "Add Memory", desc: "Save new fact to USER.md or MEMORY.md" },
  { key: "replace_memory", label: "Replace Memory", desc: "Update existing memory fact or user preference" },
  { key: "remove_memory", label: "Remove Memory", desc: "Delete invalidated memory fact" },
  { key: "read_skill", label: "Read Skill", desc: "Load SKILL.md instructions" },
  { key: "list_skills", label: "List Skills", desc: "Discover active agent skills" },
  { key: "manage_skill", label: "Manage Skill", desc: "Create and update skills" },
  { key: "save_wordpress_post", label: "Save WordPress Article", desc: "Saves blog articles with category, SEO metadata, and images to Supabase", pluginBadge: "Posts Plugin" },
  { key: "save_youtube_video", label: "Save YouTube Video", desc: "Saves YouTube video drafts with SEO tags and custom thumbnail", pluginBadge: "Posts Plugin" },
  { key: "save_instagram_post", label: "Save Instagram Reel/Post", desc: "Saves Instagram Reels, photos, videos, & carousels to Posts console", pluginBadge: "Posts Plugin" },
  { key: "save_facebook_post", label: "Save Facebook Post", desc: "Saves Facebook Page posts, photos, and video reels", pluginBadge: "Posts Plugin" },
  { key: "save_linkedin_post", label: "Save LinkedIn Post", desc: "Saves LinkedIn posts, video reels, and article shares", pluginBadge: "Posts Plugin" },
  { key: "save_twitter_post", label: "Save X (Twitter) Post", desc: "Saves X posts and threads with R2 media attachments", pluginBadge: "Posts Plugin" },
  { key: "save_social_bundle", label: "Save Social Bundle", desc: "Saves multi-platform campaign across all social channels", pluginBadge: "Posts Plugin" },
  { key: "get_wordpress_categories", label: "WP Categories", desc: "Fetch WordPress categories", pluginBadge: "Posts Plugin" },
  { key: "publish_to_wordpress", label: "WordPress Publish", desc: "WP REST API publisher", pluginBadge: "Posts Plugin" },
  { key: "cronjob", label: "Cron Scheduler", desc: "Manage scheduled tasks and background ticks" },
  { key: "list_tools", label: "List Tools", desc: "Discover tools via semantic search" },
  { key: "load_tools", label: "Load Tools", desc: "Load parameters and schemas on demand" },
  { key: "call_tool", label: "Call Tool", desc: "Execute dynamically routed tools" },
  { key: "fetch_images_brave", label: "Brave Image Search", desc: "OG image fetcher" },
  { key: "honcho_search", label: "Honcho Search", desc: "Hybrid search over Honcho cloud message history" },
  { key: "honcho_reasoning", label: "Honcho Reasoning", desc: "Dialectic LLM agent for multi-hop synthesis" },
];

export function BuiltinToolsPanel({ onReloadAgent }: { onReloadAgent?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const { plugins } = usePlugins();
  // Tools owned by a disabled plugin are hidden from the panel entirely.
  const visibleTools = useMemo(() => {
    const blocked = disabledPluginToolKeys(plugins);
    return BUILTIN_TOOLS.filter((t) => !blocked.has(t.key));
  }, [plugins]);
  const [builtinModes, setBuiltinModes] = useState<Record<string, string>>({});
  const [builtinPermissions, setBuiltinPermissions] = useState<Record<string, string>>({});
  const [builtinBindings, setBuiltinBindings] = useState<Record<string, any>>({});
  const [expandedToolKey, setExpandedToolKey] = useState<string | null>(null);
  const [schemasCache, setSchemasCache] = useState<Record<string, any>>({});
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const loadPermissionsAndSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/tools/permissions");
      if (!res.ok) return;
      const data = await res.json();
      if (data.builtin_modes) setBuiltinModes(data.builtin_modes);
      if (data.builtin_permissions) setBuiltinPermissions(data.builtin_permissions);
      if (data.builtin_bindings) setBuiltinBindings(data.builtin_bindings);
    } catch (e) {
      console.error("Failed to load tool permissions:", e);
    }
  }, []);

  useEffect(() => {
    loadPermissionsAndSettings();
  }, [loadPermissionsAndSettings]);

  const handlePermissionChange = async (toolKey: string, nextPerm: string) => {
    setSavingKey(toolKey);
    const updated = { ...builtinPermissions, [toolKey]: nextPerm };
    setBuiltinPermissions(updated);
    try {
      await fetch("/api/tools/permissions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool_key: toolKey,
          tool_type: "builtin",
          permission_mode: nextPerm,
        }),
      });
      if (onReloadAgent) onReloadAgent();
    } catch (e) {
      console.error("Failed to update tool permission:", e);
    } finally {
      setSavingKey(null);
    }
  };

  const handleIndexingModeChange = async (toolKey: string, nextMode: string) => {
    setSavingKey(toolKey);
    const updated = { ...builtinModes, [toolKey]: nextMode };
    setBuiltinModes(updated);
    try {
      await fetch("/api/tools/permissions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool_key: toolKey,
          tool_type: "builtin",
          loading_mode: nextMode,
        }),
      });
      if (onReloadAgent) onReloadAgent();
    } catch (e) {
      console.error("Failed to update tool indexing mode:", e);
    } finally {
      setSavingKey(null);
    }
  };

  const handleToggleSchema = async (toolKey: string) => {
    if (expandedToolKey === toolKey) {
      setExpandedToolKey(null);
      return;
    }
    setExpandedToolKey(toolKey);
    if (!schemasCache[toolKey]) {
      setLoadingSchema(true);
      try {
        const res = await fetch(`/api/tools/schemas?tool_key=${toolKey}`);
        const data = await res.json();
        if (data.schema) {
          setSchemasCache((prev) => ({ ...prev, [toolKey]: data.schema }));
        }
      } catch (e) {
        console.error("Failed to fetch tool schema:", e);
      } finally {
        setLoadingSchema(false);
      }
    }
  };

  const handleBindingChange = async (toolKey: string, paramName: string, binding: { value: any; decide_by_ai: boolean } | null) => {
    const currentToolBindings = { ...(builtinBindings[toolKey] || {}) };
    if (binding === null) {
      delete currentToolBindings[paramName];
    } else {
      currentToolBindings[paramName] = binding;
    }

    const nextAllBindings = {
      ...builtinBindings,
      [toolKey]: Object.keys(currentToolBindings).length > 0 ? currentToolBindings : undefined,
    };
    if (!nextAllBindings[toolKey]) delete nextAllBindings[toolKey];
    setBuiltinBindings(nextAllBindings);

    try {
      await fetch("/api/tools/permissions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool_key: toolKey,
          tool_type: "builtin",
          parameter_bindings: currentToolBindings,
        }),
      });
      if (onReloadAgent) onReloadAgent();
    } catch (e) {
      console.error("Failed to save parameter binding:", e);
    }
  };

  return (
    <JanCard className="p-0 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/20 transition-colors cursor-pointer"
      >
        <div className="shrink-0 w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
          <Package className="h-4 w-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">Built-in Tools & Permissions</p>
            <span className="text-[10px] bg-primary/10 text-primary px-2 py-0.2 rounded-full font-medium">
              System-Enforced HITL
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Core agent tools · {visibleTools.length} tools · Granular permissions, indexing modes & fixed parameters
          </p>
        </div>
        {expanded
          ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
          : <ChevronRight className="h-4 w-4 text-muted-foreground" />
        }
      </button>

      {expanded && (
        <div className="border-t bg-muted/10 p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {visibleTools.map((tool) => {
              const currentMode = builtinModes[tool.key] || "primary";
              const currentPerm = builtinPermissions[tool.key] || "always_allow";
              const currentBindings = builtinBindings[tool.key] || {};
              const hasCustomBindings = Object.keys(currentBindings).length > 0;
              const isSchemaOpen = expandedToolKey === tool.key;
              const schema = schemasCache[tool.key];

              return (
                <div
                  key={tool.key}
                  className={`flex flex-col rounded-lg border transition-all ${
                    currentPerm === "deny"
                      ? "bg-muted/20 border-border/40 opacity-70"
                      : currentPerm === "ask"
                      ? "bg-card border-amber-500/30 shadow-xs"
                      : "bg-card border-border shadow-xs"
                  }`}
                >
                  <div className="p-3.5 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Zap className="h-4 w-4 text-primary shrink-0" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="text-xs font-semibold truncate">{tool.label}</p>
                            {tool.pluginBadge && (
                              <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-pink-500/10 text-pink-600 dark:text-pink-400 font-semibold border border-pink-500/20 shrink-0">
                                {tool.pluginBadge}
                              </span>
                            )}
                            {hasCustomBindings && (
                              <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 font-semibold uppercase shrink-0 border border-violet-500/20">
                                Parameters Locked
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] font-mono text-muted-foreground truncate">{tool.key}</p>
                        </div>
                      </div>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleToggleSchema(tool.key)}
                        className={`h-7 px-2 text-[11px] gap-1 shrink-0 ${
                          isSchemaOpen ? "bg-primary/10 text-primary" : "text-muted-foreground"
                        }`}
                        title="Customize parameter schema & lock values"
                      >
                        <Sliders className="h-3 w-3" />
                        <span>Schema</span>
                      </Button>
                    </div>

                    <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
                      {tool.desc}
                    </p>

                    <div className="grid grid-cols-2 gap-2 pt-2 border-t border-dashed border-border/50">
                      {/* Permission Selector */}
                      <div className="flex flex-col gap-1">
                        <span className="text-[9px] text-muted-foreground font-semibold uppercase flex items-center gap-1">
                          {currentPerm === "ask" ? (
                            <ShieldAlert className="h-3 w-3 text-amber-500" />
                          ) : currentPerm === "deny" ? (
                            <X className="h-3 w-3 text-destructive" />
                          ) : (
                            <ShieldCheck className="h-3 w-3 text-green-500" />
                          )}
                          Permission
                        </span>
                        <select
                          value={currentPerm}
                          onChange={(e) => handlePermissionChange(tool.key, e.target.value)}
                          className={`h-7 text-xs rounded-md border bg-background px-2 focus:outline-none focus:ring-1 focus:ring-primary font-medium cursor-pointer ${
                            currentPerm === "ask"
                              ? "border-amber-500 text-amber-600 dark:text-amber-400 font-semibold"
                              : currentPerm === "deny"
                              ? "border-destructive text-destructive"
                              : "border-input text-foreground"
                          }`}
                        >
                          <option value="always_allow">Always Allow</option>
                          <option value="ask">Ask Before Running</option>
                          <option value="deny">Deny / Block</option>
                        </select>
                      </div>

                      {/* Indexing Mode Selector */}
                      <div className="flex flex-col gap-1">
                        <span className="text-[9px] text-muted-foreground font-semibold uppercase">
                          Indexing Mode
                        </span>
                        <select
                          value={currentMode}
                          onChange={(e) => handleIndexingModeChange(tool.key, e.target.value)}
                          className="h-7 text-xs rounded-md border border-input bg-background px-2 focus:outline-none focus:ring-1 focus:ring-primary font-medium cursor-pointer"
                        >
                          <option value="primary">Primary</option>
                          <option value="normal">Normal</option>
                          <option value="super">Super</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Expandable Parameter Schema Editor */}
                  {isSchemaOpen && (
                    <div className="border-t bg-muted/30 p-3 text-xs space-y-3 rounded-b-lg">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 font-semibold text-primary">
                          <Sliders className="h-3.5 w-3.5" />
                          <span>Parameter Schema & Lock Controls</span>
                        </div>
                        <span className="text-[10px] text-muted-foreground italic">
                          Locked parameters are hidden from the AI & injected automatically
                        </span>
                      </div>

                      {loadingSchema && !schema ? (
                        <div className="flex items-center gap-2 py-3 text-muted-foreground text-xs">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Loading tool schema...
                        </div>
                      ) : !schema?.parameters?.properties || Object.keys(schema.parameters.properties).length === 0 ? (
                        <p className="text-[11px] text-muted-foreground italic py-1">
                          This tool has no configurable parameters.
                        </p>
                      ) : (
                        <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
                          {Object.entries(schema.parameters.properties).map(([paramName, paramSchema]: [string, any]) => {
                            const isRequired = (schema.parameters.required || []).includes(paramName);
                            const binding = currentBindings[paramName];
                            const decideByAi = binding ? binding.decide_by_ai : true;
                            const val = binding ? binding.value : (paramSchema.default !== undefined ? paramSchema.default : "");

                            return (
                              <div key={paramName} className="p-2.5 rounded-md border border-border/60 bg-background/80 space-y-1.5">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-mono font-bold text-foreground text-[11px]">{paramName}</span>
                                    {isRequired && <span className="text-red-500 text-[10px] font-bold">*</span>}
                                    <span className="text-[9px] text-muted-foreground font-mono">
                                      ({paramSchema.type || "string"})
                                    </span>
                                  </div>

                                  <select
                                    value={decideByAi ? "ai" : "fixed"}
                                    onChange={(e) => {
                                      if (e.target.value === "ai") {
                                        handleBindingChange(tool.key, paramName, null);
                                      } else {
                                        handleBindingChange(tool.key, paramName, { value: val, decide_by_ai: false });
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
                                  <p className="text-[10px] text-muted-foreground leading-tight">
                                    {paramSchema.description}
                                  </p>
                                )}

                                {!decideByAi && (
                                  <div className="pt-1">
                                    {paramSchema.enum ? (
                                      <select
                                        value={val}
                                        onChange={(e) => handleBindingChange(tool.key, paramName, { value: e.target.value, decide_by_ai: false })}
                                        className="w-full h-7 text-xs rounded border border-input bg-background px-2 focus:ring-1 focus:ring-primary"
                                      >
                                        <option value="">-- Select fixed value --</option>
                                        {paramSchema.enum.map((opt: string) => (
                                          <option key={opt} value={opt}>{opt}</option>
                                        ))}
                                      </select>
                                    ) : paramSchema.type === "boolean" ? (
                                      <label className="flex items-center gap-2 cursor-pointer select-none">
                                        <input
                                          type="checkbox"
                                          checked={!!val}
                                          onChange={(e) => handleBindingChange(tool.key, paramName, { value: e.target.checked, decide_by_ai: false })}
                                          className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer"
                                        />
                                        <span className="text-xs font-medium">True</span>
                                      </label>
                                    ) : paramSchema.type === "integer" || paramSchema.type === "number" ? (
                                      <Input
                                        type="number"
                                        value={val}
                                        onChange={(e) => handleBindingChange(tool.key, paramName, { value: Number(e.target.value), decide_by_ai: false })}
                                        className="h-7 text-xs"
                                        placeholder="Enter fixed number..."
                                      />
                                    ) : (
                                      <Input
                                        type="text"
                                        value={val}
                                        onChange={(e) => handleBindingChange(tool.key, paramName, { value: e.target.value, decide_by_ai: false })}
                                        className="h-7 text-xs"
                                        placeholder="Enter fixed string value..."
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
                </div>
              );
            })}
          </div>
        </div>
      )}
    </JanCard>
  );
}
