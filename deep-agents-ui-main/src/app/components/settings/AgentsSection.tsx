"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Plus, Trash2, Save, RotateCcw, Loader2, CheckCircle2,
  XCircle, Bot, Users, ChevronDown, ChevronUp, GripVertical,
  Sparkles, Code2, BookOpen, Puzzle, Wrench, X, ImageIcon, Images, Sliders,
  ToggleLeft, ToggleRight
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import { AnimatePresence, motion } from "framer-motion";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from "@/components/shared/dropdown-menu";
import { JanCard, CardItem } from "@/components/settings/JanCard";
import { usePlugins, disabledPluginToolKeys } from "@/lib/plugins";

// ── Types ────────────────────────────────────────────────────────────────────

interface ToolAssignment {
  tool_type: string;
  tool_key: string;
  tool_label: string;
  enabled: boolean;
  parameter_bindings?: Record<string, { value: any; decide_by_ai: boolean }>;
  isAutoAttached?: boolean;
}

interface AgentConfig {
  id: string;
  name: string;
  agent_type: string;
  description: string;
  system_prompt: string;
  model_key: string;
  provider?: string;
  model?: string;
  workflow_id?: string | null;
  workflow_agent_assignments?: { workflow_id: string }[];
  enabled: boolean;
  sort_order: number;
  is_builtin: boolean;
  agent_tool_assignments: ToolAssignment[];
  attach_all_skills?: boolean;
  avatar_url?: string | null;
}

interface Skill {
  id: string;
  skill_key: string;
  label: string;
  description: string;
  created_by_agent_id?: string | null;
}

interface MCPConnection {
  id: string;
  label: string;
  toolkit_slug: string;
  connection_type: string;
  status: string;
  available_tools: { tool_key: string; tool_name: string }[];
}

// ── Built-in tools catalog ───────────────────────────────────────────────────

const BUILTIN_TOOLS = [
  { tool_key: "unified_search",          tool_label: "Web Search",           category: "Search" },
  { tool_key: "unified_extract",         tool_label: "URL Extractor",        category: "Search" },
  { tool_key: "youtube_transcript",      tool_label: "YouTube Transcript",    category: "Search" },
  { tool_key: "search_conversation_history", tool_label: "Smart Search History", category: "Memory" },
  { tool_key: "add_memory",               tool_label: "Add Memory (USER/MEMORY.md)", category: "Memory" },
  { tool_key: "replace_memory",           tool_label: "Replace Memory",       category: "Memory" },
  { tool_key: "remove_memory",            tool_label: "Remove Memory",        category: "Memory" },
  { tool_key: "honcho_profile",           tool_label: "Honcho Profile",       category: "Memory" },
  { tool_key: "honcho_search",            tool_label: "Honcho Search",        category: "Memory" },
  { tool_key: "honcho_reasoning",         tool_label: "Honcho Reasoning",     category: "Memory" },
  { tool_key: "honcho_context",           tool_label: "Honcho Context",       category: "Memory" },
  { tool_key: "honcho_conclude",          tool_label: "Honcho Conclude",      category: "Memory" },
  { tool_key: "think_tool",             tool_label: "Think Tool",            category: "Reasoning" },
  { tool_key: "fetch_images_brave",      tool_label: "Brave Image Search",   category: "Images" },
  { tool_key: "create_post_image",       tool_label: "Image Generator",      category: "Images" },
  { tool_key: "read_skill",             tool_label: "Read Skill",            category: "Skills" },
  { tool_key: "list_skills",            tool_label: "List Skills",           category: "Skills" },
  { tool_key: "manage_skill",           tool_label: "Manage Skill",          category: "Skills" },
  { tool_key: "save_wordpress_post",    tool_label: "Save WordPress Article", category: "Plugin: Posts" },
  { tool_key: "save_youtube_video",     tool_label: "Save YouTube Video",   category: "Plugin: Posts" },
  { tool_key: "save_instagram_post",    tool_label: "Save Instagram Reel/Post", category: "Plugin: Posts" },
  { tool_key: "save_facebook_post",     tool_label: "Save Facebook Post",   category: "Plugin: Posts" },
  { tool_key: "save_social_bundle",     tool_label: "Save Social Bundle",   category: "Plugin: Posts" },
  { tool_key: "get_wordpress_categories", tool_label: "WP Categories",       category: "Plugin: Posts" },
  { tool_key: "publish_to_wordpress",   tool_label: "Publish to WordPress",  category: "Plugin: Posts" },
  { tool_key: "list_tools",             tool_label: "List Tools",            category: "Routing" },
  { tool_key: "load_tools",             tool_label: "Load Tools",            category: "Routing" },
  { tool_key: "call_tool",              tool_label: "Call Tool",             category: "Routing" },
  { tool_key: "cronjob",                tool_label: "Cron Scheduler",        category: "Routing" },
  { tool_key: "omni_analyzer",         tool_label: "Omni Analyzer",        category: "Routing" },
  { tool_key: "text_to_speech",         tool_label: "Text to Speech (Voice)", category: "Voice" },
  { tool_key: "terminal",               tool_label: "Terminal", category: "Terminal" },
];

const TOOL_CATEGORIES = ["Search", "Memory", "Reasoning", "Images", "Skills", "Plugin: Posts", "Routing", "Voice", "Terminal"];

interface ToolSetting {
  id: string;
  connection_id: string;
  tool_key: string;
  tool_name: string;
  enabled: boolean;
  loading_mode?: string;
}

interface DesignAsset {
  id: string;
  asset_key: string;
  label: string;
  file_path: string;
  sort_order: number;
}

// ── Reference Images Picker ──────────────────────────────────────────────────

function ReferenceImagesPicker({ agentId }: { agentId: string }) {
  const [library, setLibrary] = useState<DesignAsset[]>([]);
  const [attached, setAttached] = useState<DesignAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [libRes, attRes] = await Promise.all([
        fetch("/api/design-assets"),
        fetch(`/api/design-assets/agent?agent_id=${agentId}`),
      ]);
      const libData = await libRes.json();
      const attData = await attRes.json();
      setLibrary(libData.assets ?? []);
      setAttached(attData.assets ?? []);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { load(); }, [load]);

  const attach = async (asset: DesignAsset) => {
    if (attached.some(a => a.id === asset.id)) return;
    setBusy(asset.id);
    try {
      await fetch("/api/design-assets/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, design_asset_id: asset.id }),
      });
      setAttached(prev => [...prev, asset]);
    } finally { setBusy(null); }
  };

  const detach = async (asset: DesignAsset) => {
    setBusy(asset.id);
    try {
      await fetch("/api/design-assets/agent", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, design_asset_id: asset.id }),
      });
      setAttached(prev => prev.filter(a => a.id !== asset.id));
    } finally { setBusy(null); }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-xs text-muted-foreground py-3"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading images…</div>;
  }

  if (library.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-5 text-center">
        <ImageIcon className="h-6 w-6 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">No reference images in library yet.</p>
        <p className="text-xs text-muted-foreground">Go to <strong>Brand Assets</strong> tab to upload images first.</p>
      </div>
    );
  }

  const unattached = library.filter(a => !attached.some(at => at.id === a.id));

  return (
    <div className="space-y-3">
      {/* Attached images */}
      {attached.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <Images className="h-3 w-3 text-violet-500" /> Attached ({attached.length})
          </p>
          <div className="flex flex-wrap gap-2">
            {attached.map(asset => (
              <div key={asset.id}
                className="flex items-center gap-2 pl-2 pr-1 py-1 rounded-full border bg-violet-500/5 border-violet-500/20 text-violet-600 dark:text-violet-400"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/design-assets/image?key=${asset.asset_key}`}
                  alt={asset.label}
                  className="h-5 w-5 rounded-full object-cover border border-violet-500/20"
                  onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
                <span className="text-xs font-medium max-w-[120px] truncate">{asset.label}</span>
                <button
                  type="button"
                  onClick={() => detach(asset)}
                  disabled={busy === asset.id}
                  className="p-0.5 rounded-full hover:bg-foreground/10 text-muted-foreground hover:text-foreground"
                >
                  {busy === asset.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Attach from library */}
      {unattached.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Add from Library</p>
          <div className="grid grid-cols-2 gap-2">
            {unattached.map(asset => (
              <button
                key={asset.id}
                type="button"
                onClick={() => attach(asset)}
                disabled={busy === asset.id}
                className="flex items-center gap-2 p-2 rounded-lg border border-dashed hover:border-violet-500/40
                  hover:bg-violet-500/5 transition-all text-left group disabled:opacity-50"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/design-assets/image?key=${asset.asset_key}`}
                  alt={asset.label}
                  className="h-8 w-8 rounded object-cover border flex-shrink-0"
                  onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{asset.label}</p>
                  <p className="text-[10px] text-muted-foreground">Click to attach</p>
                </div>
                {busy === asset.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              </button>
            ))}
          </div>
        </div>
      )}

      {attached.length === 0 && unattached.length === 0 && (
        <p className="text-xs text-muted-foreground">All library images are attached.</p>
      )}
    </div>
  );
}

function ToolAssignmentPanel({
  assigned,
  onChange,
  skills,
  mcpConnections,
  toolSettings,
  builtinModes,
  attachAllSkills,
  agentId,
}: {
  assigned: ToolAssignment[];
  onChange: (tools: ToolAssignment[]) => void;
  skills: Skill[];
  mcpConnections: MCPConnection[];
  toolSettings: ToolSetting[];
  builtinModes: Record<string, string>;
  attachAllSkills: boolean;
  agentId: string;
}) {
  const [selectedSource, setSelectedSource] = useState<string>("");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [newToolKeys, setNewToolKeys] = useState<string[]>([]);

  // Tools owned by a disabled plugin are hidden from the picker and the
  // displayed list.
  const { plugins } = usePlugins();
  const blockedPluginTools = React.useMemo(
    () => disabledPluginToolKeys(plugins),
    [plugins]
  );

  // Expanded tool bindings settings states
  const [expandedToolKey, setExpandedToolKey] = useState<string | null>(null);
  const [schemasCache, setSchemasCache] = useState<Record<string, any>>({});
  const [fetchingSchema, setFetchingSchema] = useState<boolean>(false);

  const handleToggleExpand = async (toolKey: string) => {
    if (expandedToolKey === toolKey) {
      setExpandedToolKey(null);
      return;
    }
    
    setExpandedToolKey(toolKey);
    
    if (!schemasCache[toolKey]) {
      setFetchingSchema(true);
      try {
        const res = await fetch("/api/tools/schema", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool_names: [toolKey] }),
        });
        const data = await res.json();
        if (data.schemas && data.schemas[toolKey]) {
          setSchemasCache(prev => ({ ...prev, [toolKey]: data.schemas[toolKey] }));
        }
      } catch (err) {
        console.error("Failed to load schema for", toolKey, err);
      } finally {
        setFetchingSchema(false);
      }
    }
  };

  const handleBindingChange = (toolKey: string, paramName: string, binding: { value: any; decide_by_ai: boolean } | null) => {
    const updated = assigned.map(tool => {
      if (tool.tool_key === toolKey) {
        const bindings = { ...(tool.parameter_bindings || {}) };
        if (binding === null) {
          delete bindings[paramName];
        } else {
          bindings[paramName] = binding;
        }
        return { ...tool, parameter_bindings: bindings };
      }
      return tool;
    });
    onChange(updated);
  };

  const getToolLoadingMode = (toolKey: string, toolType: string) => {
    if (toolType === "skill") {
      return "normal";
    }
    if (toolType === "builtin") {
      return builtinModes[toolKey] || "primary";
    }
    if (toolType === "mcp") {
      const setting = toolSettings.find(s => s.tool_key === toolKey);
      return setting?.loading_mode || "primary";
    }
    return "primary";
  };

  const renderLoadingModeBadge = (toolKey: string, toolType: string) => {
    const mode = getToolLoadingMode(toolKey, toolType);
    if (mode === "super" || mode === "vector") {
      return (
        <span className="text-[9px] px-1.5 py-0.5 rounded-full border font-semibold uppercase bg-violet-500/10 border-violet-500/20 text-violet-600 dark:text-violet-400 shrink-0">
          Super Index
        </span>
      );
    }
    if (mode === "normal") {
      return (
        <span className="text-[9px] px-1.5 py-0.5 rounded-full border font-semibold uppercase bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400 shrink-0">
          Normal Index
        </span>
      );
    }
    return (
      <span className="text-[9px] px-1.5 py-0.5 rounded-full border font-semibold uppercase bg-primary/10 border-primary/20 text-primary shrink-0">
        Primary
      </span>
    );
  };

  const removeTool = (toolKey: string) => {
    onChange(assigned.filter(t => t.tool_key !== toolKey));
    setSelectedKeys(prev => prev.filter(k => k !== toolKey));
    if (expandedToolKey === toolKey) setExpandedToolKey(null);
  };

  const bulkDetach = () => {
    onChange(assigned.filter(t => !selectedKeys.includes(t.tool_key)));
    setSelectedKeys([]);
    setExpandedToolKey(null);
  };

  // Compute Auto-Attached Skills
  const autoSkills: ToolAssignment[] = attachAllSkills
    ? skills
        .filter(s => (s.created_by_agent_id === null || s.created_by_agent_id === undefined || s.created_by_agent_id === agentId))
        .map(s => ({
          tool_type: "skill",
          tool_key: s.skill_key,
          tool_label: s.label,
          enabled: true,
          isAutoAttached: true,
        }))
    : [];

  // Filter out any auto-attached skills that are already manually assigned to avoid duplicates
  const filteredAutoSkills = autoSkills.filter(
    as => !assigned.some(a => a.tool_key === as.tool_key)
  );

  const displayedTools = [...assigned, ...filteredAutoSkills].filter(
    t => !(t.tool_type === "builtin" && blockedPluginTools.has(t.tool_key))
  );

  // Get available tools to add from selected source
  const getAvailableTools = () => {
    if (selectedSource === "builtin") {
      return BUILTIN_TOOLS
        .filter(t => !blockedPluginTools.has(t.tool_key))
        .filter(t => !displayedTools.some(a => a.tool_key === t.tool_key))
        .map(t => ({ key: t.tool_key, label: t.tool_label, type: "builtin" }));
    }
    if (selectedSource === "skill") {
      return skills
        .filter(s => !displayedTools.some(a => a.tool_key === s.skill_key))
        .map(s => ({ key: s.skill_key, label: s.label, type: "skill" }));
    }
    if (selectedSource?.startsWith("mcp:")) {
      const connId = selectedSource.split(":")[1];
      const conn = mcpConnections.find(c => c.id === connId);
      if (!conn) return [];
      const enabledMcpTools = conn.available_tools?.filter(t => {
        const setting = toolSettings.find(s => s.connection_id === conn.id && s.tool_key === t.tool_key);
        return !setting || setting.enabled;
      }) ?? [];
      return enabledMcpTools
        .filter(t => !displayedTools.some(a => a.tool_key === t.tool_key))
        .map(t => ({ key: t.tool_key, label: t.tool_name ?? t.tool_key, type: "mcp" }));
    }
    return [];
  };

  const available = getAvailableTools();

  const handleAttachSelected = () => {
    const newAssignments = available
      .filter(t => newToolKeys.includes(t.key))
      .map(t => ({
        tool_type: t.type,
        tool_key: t.key,
        tool_label: t.label,
        enabled: true,
        parameter_bindings: {},
      }));

    onChange([...assigned, ...newAssignments]);
    setNewToolKeys([]);
    setSelectedSource("");
  };

  return (
    <div className="space-y-4">
      {/* Attached Tools Toolbar & List */}
      <div className="space-y-2">
        <div className="flex items-center justify-between border-b pb-2">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={assigned.length > 0 && selectedKeys.length === assigned.length}
              onChange={(e) => {
                if (e.target.checked) {
                  setSelectedKeys(assigned.map(t => t.tool_key));
                } else {
                  setSelectedKeys([]);
                }
              }}
              className="rounded border-input text-primary focus:ring-primary h-4 w-4 cursor-pointer"
            />
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
              <Wrench className="h-3 w-3 text-primary" /> Attached Tools & Skills ({displayedTools.length})
            </span>
          </div>

          {selectedKeys.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={bulkDetach}
              className="h-7 px-2.5 text-xs text-destructive hover:bg-destructive/10 gap-1"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Detach Selected ({selectedKeys.length})
            </Button>
          )}
        </div>

        {displayedTools.length === 0 ? (
          <div className="text-center py-6 border border-dashed rounded-lg bg-muted/5 text-muted-foreground text-xs italic">
            No tools attached to this agent. Select a source below to add tools.
          </div>
        ) : (
          <div className="border rounded-lg bg-card/50 overflow-hidden">
            <div className="max-h-[350px] overflow-y-auto divide-y">
              {displayedTools.map(t => {
                const isSelected = selectedKeys.includes(t.tool_key);
                const hasBindings = t.parameter_bindings && Object.keys(t.parameter_bindings).length > 0;
                const isAuto = !!t.isAutoAttached;
                return (
                  <div key={t.tool_key} className="flex flex-col">
                    <div
                      className={`flex items-center justify-between p-2 hover:bg-muted/30 transition-colors ${
                        isSelected ? "bg-primary/5" : ""
                      } ${isAuto ? "opacity-90 bg-muted/10" : ""}`}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={isAuto}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedKeys(prev => [...prev, t.tool_key]);
                            } else {
                              setSelectedKeys(prev => prev.filter(k => k !== t.tool_key));
                            }
                          }}
                          className={`rounded border-input text-primary focus:ring-primary h-3.5 w-3.5 ${isAuto ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-xs text-foreground truncate max-w-[240px]">
                              {t.tool_label}
                            </span>
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-full border font-semibold uppercase shrink-0 ${
                              t.tool_type === "skill"
                                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                                : t.tool_type === "mcp"
                                ? "bg-violet-500/10 border-violet-500/20 text-violet-600 dark:text-violet-400"
                                : "bg-primary/10 border-primary/20 text-primary"
                            }`}>
                              {t.tool_type}
                            </span>
                            {isAuto && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full border font-semibold uppercase bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400 shrink-0">
                                Auto
                              </span>
                            )}
                            {renderLoadingModeBadge(t.tool_key, t.tool_type)}
                            {hasBindings && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full border font-semibold uppercase bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400 shrink-0">
                                Customized
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground font-mono truncate">{t.tool_key}</p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={isAuto}
                          onClick={() => handleToggleExpand(t.tool_key)}
                          className={`p-1 rounded-full hover:bg-foreground/10 transition-colors ${
                            expandedToolKey === t.tool_key ? "text-primary bg-primary/10" : "text-muted-foreground"
                          } ${isAuto ? "opacity-50 cursor-not-allowed" : ""}`}
                          title={isAuto ? "Auto-attached skill cannot be customized here" : "Configure parameter bindings"}
                        >
                          <Sliders className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={isAuto}
                          onClick={() => removeTool(t.tool_key)}
                          className={`p-1 rounded-full hover:bg-foreground/10 text-muted-foreground hover:text-foreground transition-colors mr-1 ${isAuto ? "opacity-50 cursor-not-allowed" : ""}`}
                          title={isAuto ? "Auto-attached skill cannot be detached" : "Detach tool"}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {expandedToolKey === t.tool_key && (
                      <div className="px-10 py-3 bg-muted/20 border-t text-xs space-y-3">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-primary mb-2">
                          <Sliders className="h-3.5 w-3.5" />
                          <span>Tool Parameters Config</span>
                        </div>
                        {fetchingSchema && !schemasCache[t.tool_key] ? (
                          <div className="flex items-center gap-2 text-muted-foreground text-xs py-1">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Loading parameters schema...
                          </div>
                        ) : (() => {
                          const schema = schemasCache[t.tool_key];
                          const properties = schema?.function?.parameters?.properties;
                          const required = schema?.function?.parameters?.required || [];
                          
                          if (!properties || Object.keys(properties).length === 0) {
                            return <p className="text-[11px] text-muted-foreground italic">No configurable parameters for this tool.</p>;
                          }
                          
                          return (
                            <div className="space-y-3 max-w-xl">
                              {Object.entries(properties).map(([paramName, paramSchema]: [string, any]) => {
                                const isRequired = required.includes(paramName);
                                const binding = t.parameter_bindings?.[paramName];
                                const decideByAi = binding ? binding.decide_by_ai : true;
                                const val = binding ? binding.value : (paramSchema.default !== undefined ? paramSchema.default : "");

                                return (
                                  <div key={paramName} className="space-y-1.5 border-t border-muted/50 pt-2.5 first:border-t-0 first:pt-0">
                                    <div className="flex items-center justify-between">
                                      <div>
                                        <span className="text-xs font-semibold font-mono text-foreground">{paramName}</span>
                                        {isRequired && <span className="text-red-500 text-[10px] ml-1 font-bold">*</span>}
                                        <span className="text-[10px] text-muted-foreground ml-1.5 font-mono">({paramSchema.type || "string"})</span>
                                      </div>
                                      <select
                                        value={decideByAi ? "ai" : "fixed"}
                                        onChange={(e) => {
                                          if (e.target.value === "ai") {
                                            handleBindingChange(t.tool_key, paramName, null);
                                          } else {
                                            handleBindingChange(t.tool_key, paramName, { value: val, decide_by_ai: false });
                                          }
                                        }}
                                        className="h-6 rounded border bg-background px-2 text-[10px] focus:outline-none focus:ring-1 focus:ring-primary"
                                      >
                                        <option value="ai">Decide by AI</option>
                                        <option value="fixed">Fixed Value</option>
                                      </select>
                                    </div>
                                    {paramSchema.description && (
                                      <p className="text-[10px] text-muted-foreground leading-relaxed italic">{paramSchema.description}</p>
                                    )}
                                    {!decideByAi && (
                                      <div className="mt-1">
                                        {paramSchema.enum ? (
                                          <select
                                            value={val}
                                            onChange={(e) => handleBindingChange(t.tool_key, paramName, { value: e.target.value, decide_by_ai: false })}
                                            className="w-full h-8 rounded border bg-background px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                                          >
                                            <option value="">-- Select option --</option>
                                            {paramSchema.enum.map((opt: string) => (
                                              <option key={opt} value={opt}>{opt}</option>
                                            ))}
                                          </select>
                                        ) : paramSchema.type === "boolean" ? (
                                          <label className="flex items-center gap-2 cursor-pointer select-none py-1">
                                            <input
                                              type="checkbox"
                                              checked={!!val}
                                              onChange={(e) => handleBindingChange(t.tool_key, paramName, { value: e.target.checked, decide_by_ai: false })}
                                              className="rounded border-input text-primary focus:ring-primary h-4 w-4 cursor-pointer"
                                            />
                                            <span className="text-xs font-medium">True</span>
                                          </label>
                                        ) : paramSchema.type === "integer" || paramSchema.type === "number" ? (
                                          <Input
                                            type="number"
                                            value={val}
                                            onChange={(e) => handleBindingChange(t.tool_key, paramName, { value: Number(e.target.value), decide_by_ai: false })}
                                            className="h-8 text-xs bg-background"
                                            placeholder={`Enter ${paramName} value...`}
                                          />
                                        ) : (
                                          <Input
                                            type="text"
                                            value={val}
                                            onChange={(e) => handleBindingChange(t.tool_key, paramName, { value: e.target.value, decide_by_ai: false })}
                                            className="h-8 text-xs bg-background"
                                            placeholder={`Enter ${paramName} value...`}
                                          />
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Selectors for adding tools */}
      <div className="pt-4 border-t space-y-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Plus className="h-3.5 w-3.5 text-primary" /> Attach New Tools
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="sm:col-span-1 space-y-1.5">
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block">
              Choose Source
            </label>
            <select
              value={selectedSource}
              onChange={e => {
                setSelectedSource(e.target.value);
                setNewToolKeys([]);
              }}
              className="w-full h-9 rounded-lg border border-input bg-background px-3 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">-- Choose Source --</option>
              <option value="builtin">Built-in Tools</option>
              {skills.length > 0 && <option value="skill">Skills Library</option>}
              {mcpConnections.map(conn => {
                const enabledMcpTools = conn.available_tools?.filter(t => {
                  const setting = toolSettings.find(s => s.connection_id === conn.id && s.tool_key === t.tool_key);
                  return !setting || setting.enabled;
                }) ?? [];
                if (enabledMcpTools.length === 0) return null;
                return (
                  <option key={conn.id} value={`mcp:${conn.id}`}>
                    {conn.label} ({conn.connection_type === "composio" ? "Composio" : "Manual"})
                  </option>
                );
              })}
            </select>
          </div>

          {selectedSource && (
            <div className="sm:col-span-2 space-y-2 border rounded-lg p-3 bg-muted/10">
              <div className="flex items-center justify-between border-b pb-1.5">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={available.length > 0 && newToolKeys.length === available.length}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setNewToolKeys(available.map(t => t.key));
                      } else {
                        setNewToolKeys([]);
                      }
                    }}
                    className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer"
                  />
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Select Tools to Attach
                  </span>
                </div>

                <Button
                  size="sm"
                  disabled={newToolKeys.length === 0}
                  onClick={handleAttachSelected}
                  className="h-7 px-3 text-xs gap-1"
                >
                  <Plus className="h-3 w-3" /> Attach Selected ({newToolKeys.length})
                </Button>
              </div>

              <div className="max-h-40 overflow-y-auto divide-y text-xs">
                {available.length === 0 ? (
                  <p className="text-center py-4 text-muted-foreground italic text-[11px]">All tools in this source are already attached.</p>
                ) : (
                  available.map(t => {
                    const isChecked = newToolKeys.includes(t.key);
                    return (
                      <label
                        key={t.key}
                        className="flex items-center gap-2.5 py-1.5 px-1 hover:bg-muted/30 rounded cursor-pointer transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setNewToolKeys(prev => [...prev, t.key]);
                            } else {
                              setNewToolKeys(prev => prev.filter(k => k !== t.key));
                            }
                          }}
                          className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer"
                        />
                        <div className="min-w-0 flex-1 flex items-center justify-between gap-2 pr-1">
                          <div>
                            <span className="font-semibold block text-[11px] text-foreground leading-none">{t.label}</span>
                            <span className="text-[9px] text-muted-foreground font-mono">{t.key}</span>
                          </div>
                          <div className="shrink-0">
                            {renderLoadingModeBadge(t.key, t.type)}
                          </div>
                        </div>
                      </label>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Agent Editor Card ────────────────────────────────────────────────────────

function AgentEditorCard({
  agent,
  skills,
  mcpConnections,
  toolSettings,
  providerMetas,
  workflows,
  onSave,
  onDelete,
  builtinModes,
  onClose,
}: {
  agent: AgentConfig;
  skills: Skill[];
  mcpConnections: MCPConnection[];
  toolSettings: ToolSetting[];
  providerMetas: any[];
  workflows: { id: string; name: string }[];
  onSave: (id: string, data: Partial<AgentConfig> & { tool_keys: ToolAssignment[]; workflow_ids?: string[] }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  builtinModes: Record<string, string>;
  onClose: () => void;
}) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt);
  const [provider, setProvider] = useState(agent.provider || "vercel");
  const [model, setModel] = useState(agent.model || "xiaomi/mimo-v2.5-pro");
  const [attachAllSkills, setAttachAllSkills] = useState(agent.attach_all_skills ?? false);
  const [avatarUrl, setAvatarUrl] = useState(agent.avatar_url || "");
  const initialWorkflowIds = React.useMemo(() => {
    const list = (agent.workflow_agent_assignments ?? []).map((w: any) => w.workflow_id).filter(Boolean);
    if (agent.workflow_id && !list.includes(agent.workflow_id)) {
      list.push(agent.workflow_id);
    }
    return list;
  }, [agent.workflow_agent_assignments, agent.workflow_id]);

  const [workflowIds, setWorkflowIds] = useState<string[]>(initialWorkflowIds);
  const [tools, setTools] = useState<ToolAssignment[]>(agent.agent_tool_assignments ?? []);
  const [showTools, setShowTools] = useState(false);
  const [showImages, setShowImages] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadingModels = false;
  const updatedProviderMetas = providerMetas;

  // Auto-correct provider & model selections if they are not in the loaded list
  useEffect(() => {
    if (updatedProviderMetas.length > 0) {
      const hasProvider = updatedProviderMetas.some(p => p.id === provider);
      if (!hasProvider) {
        const firstProv = updatedProviderMetas[0].id;
        setProvider(firstProv);
        if (updatedProviderMetas[0].defaultModels && updatedProviderMetas[0].defaultModels.length > 0) {
          setModel(updatedProviderMetas[0].defaultModels[0].value);
        }
      } else {
        const currentMeta = updatedProviderMetas.find(p => p.id === provider);
        if (currentMeta && currentMeta.defaultModels && currentMeta.defaultModels.length > 0) {
          const hasModel = currentMeta.defaultModels.some((m: any) => m.value === model);
          if (!hasModel) {
            setModel(currentMeta.defaultModels[0].value);
          }
        }
      }
    }
  }, [provider, updatedProviderMetas, model]);

  const isDirty =
    name !== agent.name ||
    description !== agent.description ||
    systemPrompt !== agent.system_prompt ||
    provider !== (agent.provider || "vercel") ||
    model !== (agent.model || "xiaomi/mimo-v2.5-pro") ||
    attachAllSkills !== (agent.attach_all_skills ?? false) ||
    avatarUrl !== (agent.avatar_url || "") ||
    JSON.stringify([...workflowIds].sort()) !== JSON.stringify([...initialWorkflowIds].sort()) ||
    JSON.stringify(tools.map(t => t.tool_key).sort()) !==
    JSON.stringify((agent.agent_tool_assignments ?? []).map(t => t.tool_key).sort());

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(agent.id, {
        name,
        description,
        system_prompt: systemPrompt,
        provider,
        model,
        workflow_ids: workflowIds,
        tool_keys: tools,
        attach_all_skills: attachAllSkills,
        avatar_url: avatarUrl || null,
      });
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setName(agent.name);
    setDescription(agent.description);
    setSystemPrompt(agent.system_prompt);
    setProvider(agent.provider || "vercel");
    setModel(agent.model || "xiaomi/mimo-v2.5-pro");
    setAttachAllSkills(agent.attach_all_skills ?? false);
    setAvatarUrl(agent.avatar_url || "");
    setWorkflowIds(initialWorkflowIds);
    setTools(agent.agent_tool_assignments ?? []);
  };

  const handleDelete = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    try {
      await onDelete(agent.id);
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const selectedWorkflows = workflows.filter(wf => workflowIds.includes(wf.id));

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12 animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* Back Button & Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-5">
        <div className="flex items-center gap-4">
          <div className="size-16 rounded-full border-2 border-primary/20 bg-muted/30 p-0.5 flex items-center justify-center flex-shrink-0">
            {avatarUrl ? (
              <img src={avatarUrl} alt={name} className="size-full rounded-full object-cover" />
            ) : (
              <div className="size-full rounded-full bg-primary/5 flex items-center justify-center font-bold text-lg text-primary tracking-wide">
                {name ? name.split(" ").map(n => n[0]).join("").substring(0, 2).toUpperCase() : "AG"}
              </div>
            )}
          </div>
          <div>
            <button
              onClick={onClose}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground font-semibold transition-colors w-fit mb-1"
            >
              &larr; Back to {agent.agent_type === "main" ? "Main Agents" : "Subagents"}
            </button>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-foreground sm:text-2xl">{name || "Unnamed Agent"}</h1>
              {agent.is_builtin && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                  Built-in
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 self-end sm:self-auto">
          {savedOk && (
            <span className="text-xs text-emerald-500 font-medium flex items-center gap-1 mr-2">
              <CheckCircle2 className="h-4 w-4" /> Saved
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={handleReset}
            disabled={!isDirty}
            className="h-9 px-3.5 text-xs gap-1.5 rounded-lg"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !isDirty}
            className="h-9 px-4.5 text-xs gap-1.5 font-semibold rounded-lg"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save Changes
          </Button>
          <Button
            size="sm"
            variant={confirmDelete ? "destructive" : "ghost"}
            onClick={handleDelete}
            disabled={deleting}
            className="h-9 px-3 text-xs gap-1.5 rounded-lg"
          >
            {deleting
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : confirmDelete
                ? <span>Confirm</span>
                : <Trash2 className="h-3.5 w-3.5" />
            }
          </Button>
        </div>
      </div>

      {/* Main Settings Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left Column - Core Settings */}
        <div className="lg:col-span-2 space-y-6">
          
          {/* Card 1: Identity & Scope */}
          <JanCard title="Identity & Scope">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
              <CardItem column className="mt-0" title="Agent Name">
                <Input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Enter agent name..."
                  className="h-9 text-xs bg-background w-full"
                />
              </CardItem>

              {/* Workflow associations dropdown instead of checkboxes! */}
              <CardItem column className="mt-0" title="Workflow Associations" description="Pipelines this agent participates in">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-3 py-1.5 text-left text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all hover:bg-muted/10">
                      {selectedWorkflows.length === 0 ? (
                        <span className="text-muted-foreground">Select workflows...</span>
                      ) : (
                        selectedWorkflows.map(wf => (
                          <span
                            key={wf.id}
                            className="inline-flex items-center gap-1 bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded text-[11px] font-medium"
                          >
                            {wf.name}
                            <span
                              onClick={(e) => {
                                e.stopPropagation();
                                setWorkflowIds(prev => prev.filter(id => id !== wf.id));
                              }}
                              className="hover:text-destructive cursor-pointer text-[10px] font-bold ml-0.5"
                            >
                              ×
                            </span>
                          </span>
                        ))
                      )}
                      <span className="ml-auto text-muted-foreground/60 text-[10px]">▼</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-[300px] max-h-[250px] overflow-y-auto" align="start">
                    {workflows.map(wf => {
                      const isChecked = workflowIds.includes(wf.id);
                      return (
                        <DropdownMenuCheckboxItem
                          key={wf.id}
                          checked={isChecked}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setWorkflowIds(prev => [...prev, wf.id]);
                            } else {
                              setWorkflowIds(prev => prev.filter(id => id !== wf.id));
                            }
                          }}
                        >
                          {wf.name}
                        </DropdownMenuCheckboxItem>
                      );
                    })}
                    {workflows.length === 0 && (
                      <div className="p-2 text-xs text-muted-foreground italic text-center">
                        No workflows available
                      </div>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardItem>
            </div>

            <CardItem column title="Description">
              <Input
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Enter agent description/role..."
                className="h-9 text-xs bg-background w-full"
              />
            </CardItem>
          </JanCard>

          {/* Card 2: Persona & Instructions (System Prompt) */}
          <JanCard
            title={
              "Persona & Instructions"
            }
            header={
              <div className="flex items-center justify-between -mt-2 mb-4">
                <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-primary" /> System prompt
                </span>
                <span className="text-[10px] font-mono text-muted-foreground">
                  {systemPrompt.length.toLocaleString()} chars
                </span>
              </div>
            }
          >
            <textarea
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              placeholder="Define the behavior, constraints, and expertise guidelines for this agent..."
              rows={16}
              className="w-full rounded-lg border border-input bg-background text-foreground px-3.5 py-3 text-xs font-mono
                leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-primary/50
                focus:border-primary transition-all min-h-[320px]"
            />
          </JanCard>

          {/* Card 3: Attached Tools & Skills (Fully Visible) */}
          <JanCard title="Capabilities (Tools & Skills)">
            <ToolAssignmentPanel
              assigned={tools}
              onChange={setTools}
              skills={skills}
              mcpConnections={mcpConnections}
              toolSettings={toolSettings}
              builtinModes={builtinModes}
              attachAllSkills={attachAllSkills}
              agentId={agent.id}
            />
          </JanCard>
        </div>

        {/* Right Column - Model Parameters & Assets */}
        <div className="space-y-6">
          
          {/* Card 4: Model Parameters */}
          <JanCard title="LLM Configuration">
            <CardItem column className="mt-0" title="LLM Provider">
              <select
                value={provider}
                onChange={e => {
                  const newProv = e.target.value;
                  setProvider(newProv);
                  const meta = updatedProviderMetas.find(p => p.id === newProv);
                  if (meta && meta.defaultModels && meta.defaultModels.length > 0) {
                    setModel(meta.defaultModels[0].value);
                  }
                }}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
                disabled={updatedProviderMetas.length === 0}
              >
                {updatedProviderMetas.length === 0 ? (
                  <option value="">No gateway providers configured</option>
                ) : (
                  updatedProviderMetas.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.label} {!p.keySet ? "⚠️ no key" : ""}
                    </option>
                  ))
                )}
              </select>
            </CardItem>

            <CardItem column title="LLM Model">
              <select
                value={model}
                onChange={e => setModel(e.target.value)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-2 focus:ring-primary font-mono"
                disabled={loadingModels || updatedProviderMetas.find(p => p.id === provider)?.defaultModels?.length === 0}
              >
                {(() => {
                  const meta = updatedProviderMetas.find(p => p.id === provider);
                  const modelsList = meta?.defaultModels || [];
                  if (modelsList.length === 0) {
                    return <option value="">No models available</option>;
                  }
                  return modelsList.map((m: any) => (
                    <option key={m.value} value={m.value}>
                      {m.label} ({m.value})
                    </option>
                  ));
                })()}
              </select>
            </CardItem>

            <CardItem
              title="Auto-Attach Skills"
              description="Attach General & Self Skills"
              actions={
                <button
                  type="button"
                  onClick={() => setAttachAllSkills(!attachAllSkills)}
                  className="text-primary hover:opacity-85 focus:outline-none"
                >
                  {attachAllSkills ? <ToggleRight className="h-6 w-6 text-primary" /> : <ToggleLeft className="h-6 w-6 text-muted-foreground" />}
                </button>
              }
            />
          </JanCard>

          {/* Card 5: Picture & Presets */}
          <JanCard title="Avatar Profile">
            <div className="space-y-4">
              <div className="flex justify-center">
                <div className="size-24 rounded-full border border-primary/20 bg-muted/30 p-1 flex items-center justify-center overflow-hidden">
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="Avatar Preview" className="size-full rounded-full object-cover" />
                  ) : (
                    <Bot className="size-12 text-muted-foreground" />
                  )}
                </div>
              </div>

              <CardItem column title="Avatar Image URL" description="Paste a custom image URL or pick a preset below">
                <div className="flex gap-2">
                  <Input
                    value={avatarUrl}
                    onChange={e => setAvatarUrl(e.target.value)}
                    placeholder="Paste custom image URL..."
                    className="h-8 text-xs bg-background flex-1"
                  />
                  {avatarUrl && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setAvatarUrl("")}
                      className="h-8 px-2 text-xs text-muted-foreground hover:bg-muted"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </CardItem>

              <div className="space-y-2 border-t border-border/40 pt-3">
                <span className="text-[10px] text-muted-foreground uppercase font-semibold block">Choose Preset:</span>
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    { name: "Bot 1", url: "https://api.dicebear.com/7.x/bottts/svg?seed=robot1" },
                    { name: "Bot 2", url: "https://api.dicebear.com/7.x/bottts/svg?seed=robot2" },
                    { name: "Coder", url: "https://api.dicebear.com/7.x/bottts/svg?seed=coder" },
                    { name: "Analyst", url: "https://api.dicebear.com/7.x/identicon/svg?seed=analyst" },
                    { name: "Agent 1", url: "https://api.dicebear.com/7.x/avataaars/svg?seed=Felix" },
                    { name: "Agent 2", url: "https://api.dicebear.com/7.x/avataaars/svg?seed=Aneka" }
                  ].map(preset => (
                    <button
                      key={preset.name}
                      type="button"
                      onClick={() => setAvatarUrl(preset.url)}
                      className={`text-[10px] py-1.5 rounded border transition-colors truncate ${
                        avatarUrl === preset.url
                          ? "bg-primary text-primary-foreground border-primary font-semibold"
                          : "bg-background hover:bg-muted text-muted-foreground border-border"
                      }`}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </JanCard>

          {/* Card 6: Reference Assets */}
          <JanCard title="Reference Images">
            <ReferenceImagesPicker agentId={agent.id} />
          </JanCard>
        </div>
      </div>
    </div>
  );
}

// ── Main Agent/Subagent Section ──────────────────────────────────────────────

interface AgentsSectionProps {
  agentType: "main" | "subagent";
  skills: Skill[];
  mcpConnections: MCPConnection[];
  toolSettings: ToolSetting[];
}

export function AgentsSection({ agentType, skills, mcpConnections, toolSettings }: AgentsSectionProps) {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [providerMetas, setProviderMetas] = useState<any[]>([]);
  const [workflows, setWorkflows] = useState<{ id: string; name: string }[]>([]);
  const [builtinModes, setBuiltinModes] = useState<Record<string, string>>({});
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const Icon = agentType === "main" ? Bot : Users;
  const label = agentType === "main" ? "Main Agents" : "Subagents";

  const handleDelete = async (id: string) => {
    await fetch(`/api/agents/${id}`, { method: "DELETE" });
    setAgents(prev => prev.filter(a => a.id !== id));
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: agentType === "main" ? "New Main Agent" : "New Subagent",
          agent_type: agentType,
          description: "",
          system_prompt: "",
          model_key: agentType === "main" ? "main_agent" : "research_subagent",
          sort_order: 99,
        }),
      });
      const data = await res.json();
      if (data.agent) {
        const newAgent = { ...data.agent, agent_tool_assignments: [] };
        setAgents(prev => [...prev, newAgent]);
        setSelectedAgentId(newAgent.id); // Auto-open configuration page!
      }
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    async function loadBuiltinModes() {
      try {
        let { data, error } = await supabase
          .from("agent_settings")
          .select("value")
          .eq("key", "builtin_tools_loading_modes")
          .single();
        if (error) {
          if (error.code === "PGRST116") {
            // Row not found in fresh/truncated database — expected
            setBuiltinModes({});
            return;
          }
          if (error.code === "PGRST303" || error.message?.includes("JWT expired")) {
            console.warn("JWT expired. Cleaning session and retrying loadBuiltinModes in AgentsSection...");
            await supabase.auth.signOut().catch(() => {});
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (key && key.includes("-auth-token")) {
                localStorage.removeItem(key);
              }
            }
            const retry = await supabase
              .from("agent_settings")
              .select("value")
              .eq("key", "builtin_tools_loading_modes")
              .single();
            data = retry.data;
            error = retry.error;
            if (error) {
              if (error.code !== "PGRST116") {
                console.error("Error loading built-in tool modes after retry in AgentsSection:", error);
              } else {
                setBuiltinModes({});
              }
            }
          } else {
            console.error("Error loading built-in tool modes in AgentsSection:", error);
          }
        }
        if (data?.value) {
          setBuiltinModes(JSON.parse(data.value));
        }
      } catch (e) {
        console.error("Failed to load built-in tool modes in AgentsSection:", e);
      }
    }
    loadBuiltinModes();
  }, []);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/agents");
      const data = await res.json();
      setAgents((data.agents ?? []).filter((a: AgentConfig) => a.agent_type === agentType));
    } finally {
      setLoading(false);
    }
  }, [agentType]);

  const fetchProviderMetas = useCallback(async () => {
    try {
      const res = await fetch("/api/provider-status");
      const data = await res.json();
      setProviderMetas(data.providers ?? []);
    } catch (err) {
      console.error("Failed to load provider status", err);
    }
  }, []);

  const fetchWorkflows = useCallback(async () => {
    try {
      const res = await fetch("/api/workflows");
      const data = await res.json();
      setWorkflows(data.workflows ?? []);
    } catch (err) {
      console.error("Failed to load workflows", err);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
    fetchProviderMetas();
    fetchWorkflows();
  }, [fetchAgents, fetchProviderMetas, fetchWorkflows]);

  const handleSave = async (id: string, data: Partial<AgentConfig> & { tool_keys: ToolAssignment[]; workflow_ids?: string[] }) => {
    await fetch(`/api/agents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    await fetchAgents();
  };

  const selectedAgent = agents.find(a => a.id === selectedAgentId);

  if (selectedAgentId !== null && selectedAgent) {
    return (
      <AgentEditorCard
        agent={selectedAgent}
        skills={skills}
        mcpConnections={mcpConnections}
        toolSettings={toolSettings}
        providerMetas={providerMetas}
        workflows={workflows}
        onSave={async (id, data) => {
          await handleSave(id, data);
          setSelectedAgentId(null);
        }}
        onDelete={async (id) => {
          await handleDelete(id);
          setSelectedAgentId(null);
        }}
        builtinModes={builtinModes}
        onClose={() => setSelectedAgentId(null)}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Section Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          <h2 className="font-semibold text-lg">{label}</h2>
          <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
            {agents.length}
          </span>
        </div>
        <Button size="sm" onClick={handleCreate} disabled={creating} className="gap-1.5">
          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Add {agentType === "main" ? "Agent" : "Subagent"}
        </Button>
      </div>

      {/* Empty State */}
      {agents.length === 0 && (
        <div className="rounded-xl border border-dashed bg-muted/20 p-12 text-center">
          <Icon className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground font-medium">No {label.toLowerCase()} yet</p>
          <p className="text-xs text-muted-foreground mt-1 mb-4">
            {agentType === "main"
              ? "Create a main agent to orchestrate your pipeline"
              : "Add subagents for specialized tasks (research, content, etc.)"
            }
          </p>
          <Button size="sm" onClick={handleCreate} disabled={creating} variant="outline">
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Create your first {agentType === "main" ? "agent" : "subagent"}
          </Button>
        </div>
      )}

      {/* Circular Profile Grid Layout */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => {
          const initials = agent.name
            ? agent.name
                .split(" ")
                .map((n) => n[0])
                .join("")
                .substring(0, 2)
                .toUpperCase()
            : "AG";

          return (
            <JanCard
              key={agent.id}
              className="hover:shadow-md transition-all duration-300 flex flex-col items-center text-center relative group"
            >
              {/* Quick Delete Option */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Are you sure you want to delete ${agent.name}?`)) {
                    handleDelete(agent.id);
                  }
                }}
                className="absolute top-4 right-4 p-1.5 rounded-full hover:bg-destructive/10 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                title="Delete Agent"
              >
                <Trash2 className="h-4 w-4" />
              </button>

              {/* Circle Avatar Frame */}
              <div className="mb-5 flex size-24 items-center justify-center rounded-full border-2 border-primary/20 bg-muted/30 p-1 group-hover:border-primary/60 transition-colors">
                {agent.avatar_url ? (
                  <img
                    src={agent.avatar_url}
                    alt={agent.name}
                    className="size-full rounded-full object-cover"
                  />
                ) : (
                  <div className="size-full rounded-full bg-primary/5 flex items-center justify-center font-bold text-xl text-primary tracking-wide">
                    {initials}
                  </div>
                )}
              </div>

              {/* Agent Details */}
              <div className="mb-4 flex-1">
                <h5 className="font-semibold text-lg text-foreground truncate max-w-full px-2">
                  {agent.name}
                </h5>
                <h6 className="text-xs text-muted-foreground font-mono mt-0.5">
                  {agent.provider ? `${agent.provider} / ${agent.model}` : agent.model_key}
                </h6>
                <p className="text-xs text-muted-foreground mt-3 line-clamp-3 min-h-[3rem] px-2 leading-relaxed font-sans">
                  {agent.description || "No description provided. Click Configure to customize this agent's instructions, model, and tools."}
                </p>
              </div>

              {/* Action Button */}
              <div className="w-full flex gap-2 pt-2">
                <Button
                  onClick={() => setSelectedAgentId(agent.id)}
                  variant="secondary"
                  size="sm"
                  className="w-full text-xs font-semibold rounded-lg"
                >
                  Configure
                </Button>
              </div>
            </JanCard>
          );
        })}
      </div>
    </div>
  );
}
