"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Plus, Trash2, Save, RotateCcw, Loader2, CheckCircle2,
  XCircle, Bot, Users, ChevronDown, ChevronUp, GripVertical,
  Sparkles, Code2, BookOpen, Puzzle, Wrench, X, ImageIcon, Images, Sliders
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";

// ── Types ────────────────────────────────────────────────────────────────────

interface ToolAssignment {
  tool_type: string;
  tool_key: string;
  tool_label: string;
  enabled: boolean;
  parameter_bindings?: Record<string, { value: any; decide_by_ai: boolean }>;
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
}

interface Skill {
  id: string;
  skill_key: string;
  label: string;
  description: string;
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
  { tool_key: "think_tool",             tool_label: "Think Tool",            category: "Reasoning" },
  { tool_key: "fetch_images_brave",      tool_label: "Brave Image Search",   category: "Images" },
  { tool_key: "view_candidate_images",   tool_label: "View Candidate Images", category: "Images" },
  { tool_key: "create_post_image",       tool_label: "Image Generator",      category: "Images" },
  { tool_key: "read_skill",             tool_label: "Read Skill",            category: "Skills" },
  { tool_key: "list_skills",            tool_label: "List Skills",           category: "Skills" },
  { tool_key: "manage_skill",           tool_label: "Manage Skill",          category: "Skills" },
  { tool_key: "save_posts_to_supabase", tool_label: "Save to Database",      category: "Output" },
  { tool_key: "get_wordpress_categories", tool_label: "WP Categories",       category: "Output" },
  { tool_key: "publish_to_wordpress",   tool_label: "Publish to WordPress",  category: "Output" },
  { tool_key: "list_tools",             tool_label: "List Tools",            category: "Routing" },
  { tool_key: "load_tools",             tool_label: "Load Tools",            category: "Routing" },
  { tool_key: "call_tool",              tool_label: "Call Tool",             category: "Routing" },
];

const TOOL_CATEGORIES = ["Search", "Reasoning", "Images", "Skills", "Output", "Routing"];

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
}: {
  assigned: ToolAssignment[];
  onChange: (tools: ToolAssignment[]) => void;
  skills: Skill[];
  mcpConnections: MCPConnection[];
  toolSettings: ToolSetting[];
  builtinModes: Record<string, string>;
}) {
  const [selectedSource, setSelectedSource] = useState<string>("");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [newToolKeys, setNewToolKeys] = useState<string[]>([]);

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

  // Get available tools to add from selected source
  const getAvailableTools = () => {
    if (selectedSource === "builtin") {
      return BUILTIN_TOOLS
        .filter(t => !assigned.some(a => a.tool_key === t.tool_key))
        .map(t => ({ key: t.tool_key, label: t.tool_label, type: "builtin" }));
    }
    if (selectedSource === "skill") {
      return skills
        .filter(s => !assigned.some(a => a.tool_key === s.skill_key))
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
        .filter(t => !assigned.some(a => a.tool_key === t.tool_key))
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
              <Wrench className="h-3 w-3 text-primary" /> Attached Tools & Skills ({assigned.length})
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

        {assigned.length === 0 ? (
          <div className="text-center py-6 border border-dashed rounded-lg bg-muted/5 text-muted-foreground text-xs italic">
            No tools attached to this agent. Select a source below to add tools.
          </div>
        ) : (
          <div className="border rounded-lg bg-card/50 overflow-hidden">
            <div className="max-h-[350px] overflow-y-auto divide-y">
              {assigned.map(t => {
                const isSelected = selectedKeys.includes(t.tool_key);
                const hasBindings = t.parameter_bindings && Object.keys(t.parameter_bindings).length > 0;
                return (
                  <div key={t.tool_key} className="flex flex-col">
                    <div
                      className={`flex items-center justify-between p-2 hover:bg-muted/30 transition-colors ${
                        isSelected ? "bg-primary/5" : ""
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedKeys(prev => [...prev, t.tool_key]);
                            } else {
                              setSelectedKeys(prev => prev.filter(k => k !== t.tool_key));
                            }
                          }}
                          className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer"
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
                          onClick={() => handleToggleExpand(t.tool_key)}
                          className={`p-1 rounded-full hover:bg-foreground/10 transition-colors ${
                            expandedToolKey === t.tool_key ? "text-primary bg-primary/10" : "text-muted-foreground"
                          }`}
                          title="Configure parameter bindings"
                        >
                          <Sliders className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeTool(t.tool_key)}
                          className="p-1 rounded-full hover:bg-foreground/10 text-muted-foreground hover:text-foreground transition-colors mr-1"
                          title="Detach tool"
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
}) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt);
  const [provider, setProvider] = useState(agent.provider || "vercel");
  const [model, setModel] = useState(agent.model || "xiaomi/mimo-v2.5-pro");
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

  const isDirty =
    name !== agent.name ||
    description !== agent.description ||
    systemPrompt !== agent.system_prompt ||
    provider !== (agent.provider || "vercel") ||
    model !== (agent.model || "xiaomi/mimo-v2.5-pro") ||
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

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b bg-muted/20">
        <GripVertical className="h-4 w-4 text-muted-foreground/40 cursor-grab" />
        <div className="flex-1 min-w-0">
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            className="h-8 text-sm font-semibold bg-transparent border-0 p-0 focus-visible:ring-0 focus-visible:ring-offset-0"
            placeholder="Agent name..."
          />
        </div>
        {agent.is_builtin && (
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
            Built-in
          </span>
        )}
        <div className="flex items-center gap-1.5 ml-auto">
          {savedOk && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
          <Button
            size="sm"
            variant="ghost"
            onClick={handleReset}
            disabled={!isDirty}
            className="h-7 px-2 text-xs"
          >
            <RotateCcw className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !isDirty}
            className="h-7 px-3 text-xs gap-1.5"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            Save
          </Button>
          <Button
            size="sm"
            variant={confirmDelete ? "destructive" : "ghost"}
            onClick={handleDelete}
            disabled={deleting}
            className="h-7 px-2 text-xs"
          >
            {deleting
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : confirmDelete
                ? <span>Confirm</span>
                : <Trash2 className="h-3 w-3" />
            }
          </Button>
        </div>
      </div>

      <div className="p-5 space-y-4">
        {/* Description & Workflow */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Description</label>
            <Input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Brief description of this agent's role..."
              className="h-8 text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Workflow Associations</label>
            <div className="flex flex-wrap gap-2 border rounded-md p-2 bg-background min-h-8">
              {workflows.map(wf => {
                const isChecked = workflowIds.includes(wf.id);
                return (
                  <label key={wf.id} className="flex items-center gap-1.5 text-xs font-medium cursor-pointer bg-muted/40 px-2 py-0.5 rounded hover:bg-muted/70 transition-colors select-none">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {
                        if (isChecked) {
                          setWorkflowIds(prev => prev.filter(id => id !== wf.id));
                        } else {
                          setWorkflowIds(prev => [...prev, wf.id]);
                        }
                      }}
                      className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer"
                    />
                    <span>{wf.name}</span>
                  </label>
                );
              })}
              {workflows.length === 0 && <span className="text-xs text-muted-foreground italic">No workflows created yet</span>}
            </div>
          </div>
        </div>

        {/* Model Selection */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-b py-3.5 bg-muted/5 rounded-lg px-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">LLM Provider</label>
            <select
              value={provider}
              onChange={e => {
                const newProv = e.target.value;
                setProvider(newProv);
                const meta = providerMetas.find(p => p.id === newProv);
                if (meta && meta.defaultModels && meta.defaultModels.length > 0) {
                  setModel(meta.defaultModels[0].value);
                }
              }}
              className="w-full h-8 rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
            >
              {providerMetas.map(p => (
                <option key={p.id} value={p.id}>
                  {p.label} {!p.keySet ? "⚠️ no key" : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">LLM Model</label>
            <div className="space-y-1.5">
              <Input
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder="Model name (e.g. gpt-4o)..."
                className="h-8 text-xs font-mono"
              />
              {(() => {
                const meta = providerMetas.find(p => p.id === provider);
                if (meta && meta.defaultModels && meta.defaultModels.length > 0) {
                  return (
                    <div className="flex flex-wrap gap-1">
                      {meta.defaultModels.map((m: any) => (
                        <button
                          key={m.value}
                          type="button"
                          onClick={() => setModel(m.value)}
                          className={`text-[9px] px-1.5 py-0.5 rounded border transition-all
                            ${model === m.value
                              ? "bg-primary text-primary-foreground border-primary"
                              : "border-border bg-muted hover:bg-accent text-muted-foreground"
                            }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  );
                }
                return null;
              })()}
            </div>
          </div>
        </div>

        {/* System Prompt */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-primary" />
              System Prompt
            </label>
            <span className="text-[10px] font-mono text-muted-foreground">
              {systemPrompt.length.toLocaleString()} chars
            </span>
          </div>
          <textarea
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            placeholder="Enter the system prompt for this agent..."
            rows={12}
            className="w-full rounded-lg border border-input bg-muted/20 px-3 py-2.5 text-xs font-mono
              leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-primary/50
              focus:border-primary transition-all min-h-[200px]"
          />
        </div>

        {/* Tool Assignment */}
        <div>
          <button
            onClick={() => setShowTools(!showTools)}
            className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors w-full"
          >
            {showTools ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            <span>Attached Tools & Skills</span>
            <span className="ml-auto font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded text-[10px]">
              {tools.length} selected
            </span>
          </button>
          {showTools && (
            <div className="mt-3 p-4 rounded-lg border bg-muted/10">
              <ToolAssignmentPanel
                assigned={tools}
                onChange={setTools}
                skills={skills}
                mcpConnections={mcpConnections}
                toolSettings={toolSettings}
                builtinModes={builtinModes}
              />
            </div>
          )}
        </div>

        {/* Reference Images */}
        <div>
          <button
            onClick={() => setShowImages(!showImages)}
            className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors w-full"
          >
            {showImages ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            <Images className="h-3.5 w-3.5 text-violet-500" />
            <span>Reference Images</span>
            <span className="text-[10px] text-muted-foreground ml-1">(VL model sees them directly — no separate tool needed)</span>
          </button>
          {showImages && (
            <div className="mt-3 p-4 rounded-lg border bg-muted/10">
              <ReferenceImagesPicker agentId={agent.id} />
            </div>
          )}
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

  useEffect(() => {
    async function loadBuiltinModes() {
      try {
        let { data, error } = await supabase
          .from("agent_settings")
          .select("value")
          .eq("key", "builtin_tools_loading_modes")
          .single();
        if (error) {
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
              console.error("Error loading built-in tool modes after retry in AgentsSection:", error);
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
        setAgents(prev => [...prev, { ...data.agent, agent_tool_assignments: [] }]);
      }
    } finally {
      setCreating(false);
    }
  };

  const Icon = agentType === "main" ? Bot : Users;
  const label = agentType === "main" ? "Main Agents" : "Subagents";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading {label.toLowerCase()}…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          <h2 className="font-semibold">{label}</h2>
          <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
            {agents.length}
          </span>
        </div>
        <Button size="sm" onClick={handleCreate} disabled={creating} className="gap-1.5">
          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Add {agentType === "main" ? "Agent" : "Subagent"}
        </Button>
      </div>

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

      <div className="space-y-4">
        {agents.map(agent => (
          <AgentEditorCard
            key={agent.id}
            agent={agent}
            skills={skills}
            mcpConnections={mcpConnections}
            toolSettings={toolSettings}
            providerMetas={providerMetas}
            workflows={workflows}
            onSave={handleSave}
            onDelete={handleDelete}
            builtinModes={builtinModes}
          />
        ))}
      </div>
    </div>
  );
}
