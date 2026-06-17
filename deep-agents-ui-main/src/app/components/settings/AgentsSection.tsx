"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Plus, Trash2, Save, RotateCcw, Loader2, CheckCircle2,
  XCircle, Bot, Users, ChevronDown, ChevronUp, GripVertical,
  Sparkles, Code2, BookOpen, Puzzle, Wrench, X, ImageIcon, Images
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ── Types ────────────────────────────────────────────────────────────────────

interface ToolAssignment {
  tool_type: string;
  tool_key: string;
  tool_label: string;
  enabled: boolean;
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
];

const TOOL_CATEGORIES = ["Search", "Reasoning", "Images", "Skills", "Output"];

interface ToolSetting {
  id: string;
  connection_id: string;
  tool_key: string;
  tool_name: string;
  enabled: boolean;
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

// ── Tool Assignment Panel ────────────────────────────────────────────────────

function ToolAssignmentPanel({
  assigned,
  onChange,
  skills,
  mcpConnections,
  toolSettings,
}: {
  assigned: ToolAssignment[];
  onChange: (tools: ToolAssignment[]) => void;
  skills: Skill[];
  mcpConnections: MCPConnection[];
  toolSettings: ToolSetting[];
}) {
  const [selectedSource, setSelectedSource] = useState<string>("");

  const removeTool = (toolKey: string) => {
    onChange(assigned.filter(t => t.tool_key !== toolKey));
  };

  return (
    <div className="space-y-4">
      {/* Attached Tools Tags */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5">
          <Wrench className="h-3 w-3 text-primary" /> Attached Tools & Skills ({assigned.length})
        </p>

        {assigned.length === 0 ? (
          <div className="text-center py-5 border border-dashed rounded-lg bg-muted/5 text-muted-foreground text-xs">
            No tools attached to this agent. Select a source below to add tools.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 p-2 max-h-48 overflow-y-auto border rounded-lg bg-muted/5">
            {assigned.map(t => {
              let bg = "bg-primary/5 hover:bg-primary/10 border-primary/20 text-primary";
              let Icon = Wrench;
              if (t.tool_type === "skill") {
                bg = "bg-emerald-500/5 hover:bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400";
                Icon = BookOpen;
              } else if (t.tool_type === "mcp") {
                bg = "bg-violet-500/5 hover:bg-violet-500/10 border-violet-500/20 text-violet-600 dark:text-violet-400";
                Icon = Puzzle;
              }
              return (
                <span
                  key={t.tool_key}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-medium transition-all ${bg}`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate max-w-[180px]">{t.tool_label}</span>
                  <button
                    type="button"
                    onClick={() => removeTool(t.tool_key)}
                    className="ml-1 p-0.5 rounded-full hover:bg-foreground/10 text-muted-foreground hover:text-foreground transition-colors"
                    title="Detach tool"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Selectors for adding tools */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t">
        <div className="space-y-1.5">
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block">
            Select Tool Source
          </label>
          <select
            value={selectedSource}
            onChange={e => setSelectedSource(e.target.value)}
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

        <div className="space-y-1.5">
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block">
            Select Tool to Add
          </label>
          <select
            value=""
            disabled={!selectedSource}
            onChange={e => {
              const val = e.target.value;
              if (!val) return;
              const [toolKey, toolLabel, toolType] = JSON.parse(val);
              // Avoid duplicates
              if (!assigned.some(x => x.tool_key === toolKey)) {
                onChange([...assigned, { tool_type: toolType, tool_key: toolKey, tool_label: toolLabel, enabled: true }]);
              }
              setSelectedSource("");
            }}
            className="w-full h-9 rounded-lg border border-input bg-background px-3 text-xs focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
          >
            <option value="">
              {!selectedSource ? "Choose source first..." : "-- Select Tool --"}
            </option>

            {selectedSource === "builtin" &&
              BUILTIN_TOOLS
                .filter(t => !assigned.some(a => a.tool_key === t.tool_key))
                .map(t => (
                  <option key={t.tool_key} value={JSON.stringify([t.tool_key, t.tool_label, "builtin"])}>
                    {t.tool_label} ({t.category})
                  </option>
                ))
            }

            {selectedSource === "skill" &&
              skills
                .filter(s => !assigned.some(a => a.tool_key === s.skill_key))
                .map(s => (
                  <option key={s.skill_key} value={JSON.stringify([s.skill_key, s.label, "skill"])}>
                    {s.label}
                  </option>
                ))
            }

            {selectedSource?.startsWith("mcp:") && (() => {
              const connId = selectedSource.split(":")[1];
              const conn = mcpConnections.find(c => c.id === connId);
              if (!conn) return null;
              const enabledMcpTools = conn.available_tools?.filter(t => {
                const setting = toolSettings.find(s => s.connection_id === conn.id && s.tool_key === t.tool_key);
                return !setting || setting.enabled;
              }) ?? [];
              return enabledMcpTools
                .filter(t => !assigned.some(a => a.tool_key === t.tool_key))
                .map(t => (
                  <option key={t.tool_key} value={JSON.stringify([t.tool_key, t.tool_name ?? t.tool_key, "mcp"])}>
                    {t.tool_name ?? t.tool_key}
                  </option>
                ));
            })()}
          </select>
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
}: {
  agent: AgentConfig;
  skills: Skill[];
  mcpConnections: MCPConnection[];
  toolSettings: ToolSetting[];
  providerMetas: any[];
  workflows: { id: string; name: string }[];
  onSave: (id: string, data: Partial<AgentConfig> & { tool_keys: ToolAssignment[] }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt);
  const [provider, setProvider] = useState(agent.provider || "vercel");
  const [model, setModel] = useState(agent.model || "xiaomi/mimo-v2.5-pro");
  const [workflowId, setWorkflowId] = useState(agent.workflow_id || "");
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
    workflowId !== (agent.workflow_id || "") ||
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
        workflow_id: workflowId || null,
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
    setWorkflowId(agent.workflow_id || "");
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
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Workflow Association</label>
            <select
              value={workflowId}
              onChange={e => setWorkflowId(e.target.value)}
              className="w-full h-8 rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">(Unassigned / Global)</option>
              {workflows.map(wf => (
                <option key={wf.id} value={wf.id}>{wf.name}</option>
              ))}
            </select>
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

  const handleSave = async (id: string, data: Partial<AgentConfig> & { tool_keys: ToolAssignment[] }) => {
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
          />
        ))}
      </div>
    </div>
  );
}
