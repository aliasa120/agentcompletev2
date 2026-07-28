"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Plus, Trash2, Save, Edit3, Upload, Loader2, CheckCircle2,
  BookOpen, XCircle, ChevronDown, ChevronUp, Sparkles, Sliders,
  Cpu, FileCode, Check, ShieldCheck, ShieldAlert, Activity, ArrowUpRight, RefreshCw, Layers, RotateCcw, Link2
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

interface Skill {
  id: string;
  skill_key: string;
  skill_id?: string;
  label: string;
  description: string;
  content: string;
  source: string;
  trust_state?: "trusted" | "provisional";
  is_active?: boolean;
  origin?: "imported" | "fixed" | "derived" | "captured";
  generation?: number;
  use_count?: number;
  parent_skill_key?: string | null;
  created_at: string;
  created_by_agent_id?: string | null;
  attached_agent_ids?: string[];
}


interface EvolutionSettings {
  analysis_provider: string;
  analysis_model: string;
  evolution_provider: string;
  evolution_model: string;
  dedup_threshold_percent: number;
  trust_promotion_count: number;
  skip_pure_chat: boolean;
  max_evolutions_per_day: number;
  analysis_prompt_override?: string | null;
  fix_prompt_override?: string | null;
  derived_prompt_override?: string | null;
  captured_prompt_override?: string | null;
}

interface ProviderMeta {
  id: string;
  label: string;
  defaultModels: { value: string; label: string; badge?: string }[];
}

const OPENSPACE_DEFAULT_PROMPTS = {
  analysis: `You are an expert analyst evaluating an autonomous agent's task execution.
Your job is to assess how the agent used its skills and tools, trace the reasoning and outcome of each iteration, and surface actionable insights.

## Task Context
**Task**: {task_description}
**Agent self-reported status**: {execution_status}
**Iterations used**: {iterations}
**Available tools**: {tool_list}

{skill_section}

## Full Existing Skills Library
{existing_skills_summary}

## Tool Execution Timeline
{traj_summary}

## Agent Conversation Log
{conversation_log}

## Analysis Instructions

### 1. Task completion assessment
Did the agent genuinely fulfill the user's request? (task_completed = true/false)

### 2. Skill assessment
For each selected or dynamically retrieved skill (IDs: {selected_skill_ids_json}), produce one skill_judgments entry.

### 3. Evolution suggestions
CRITICAL MANDATORY RULES FOR EVOLUTION SUGGESTIONS:
1. NO RE-CAPTURING OF EXISTING SKILLS: Check the Full Existing Skills Library section above. If an existing skill (such as blog_post_writer, web_research, social_media_writer, wordpress_publishing, etc.) ALREADY COVERS this task domain (even if the agent did not explicitly call read_skill during this turn), YOU MUST RETURN AN EMPTY evolution_suggestions ARRAY [].
2. DO NOT SUGGEST NEW SKILLS WHEN DOMAIN SKILLS EXIST: If a skill for writing blog posts, researching, or posting on WordPress exists, DO NOT suggest captured or derived skills for blog posts, research, or WordPress!
3. WHEN TO SUGGEST:
   - Suggest fix ONLY when an existing skill gave bad instructions that caused a tool or task failure.
   - Suggest captured ONLY when the agent solved a completely novel, unprecedented task for which NO skill exists in the library.

Return JSON:
{
  "task_completed": true,
  "execution_note": "2-3 sentence overview.",
  "tool_issues": ["backend:tool_name — symptom"],
  "skill_judgments": [
    {
      "skill_id": "exact_skill_id",
      "skill_applied": true,
      "note": "Description of usage."
    }
  ],
  "evolution_suggestions": [
    {
      "type": "fix | derived | captured",
      "target_skills": ["exact_skill_id"],
      "category": "workflow | tool_guide | reference",
      "direction": "1-2 sentences describing what to fix, derive, or capture."
    }
  ]
}`,

  fix: `You are a skill editor. Your job is to fix an existing skill that has been identified as broken, outdated, or incomplete.

## Current Skill Content
{current_content}

## What needs fixing
{direction}

## Execution failure context
{failure_context}

## Available Tool Definitions
{tool_definitions}

## Instructions
1. Analyze the root cause (wrong parameters, outdated API, missing error handling).
2. Use exact tool parameter names from tool definitions above when writing command steps.
3. Fix the affected instructions.
4. Output the complete updated SKILL.md document starting with YAML frontmatter (---).`,

  derived: `You are a skill editor. Your job is to derive a specialized version of an existing skill.

## Parent Skill Content
{parent_content}

## Enhancement direction
{direction}

## Execution insights
{execution_insights}

## Available Tool Definitions
{tool_definitions}

## Instructions
1. Create a specialized skill tailored to this specific workflow type.
2. Give the new skill a different, concise lowercase hyphenated name (e.g., technical-blog-writer).
3. Use exact tool parameter names from tool definitions above.
4. Output the complete SKILL.md starting with YAML frontmatter (---).`,

  captured: `You are a skill author. Your job is to capture a brand new reusable skill from a successful task execution that was completed without any skill guidance.

## Pattern to capture
{direction}

## Category
{category}

## Execution context
{execution_highlights}

## Available Tool Definitions
{tool_definitions}

## Instructions
1. Author a clear, modular SKILL.md starting with YAML frontmatter (---).
2. Include YAML headers (name, description, category).
3. Provide step-by-step instructions with tool invocation examples using exact parameter names from tool definitions.`
};

function SkillCard({
  skill,
  onUpdate,
  onDelete,
  onPromote,
  agents,
}: {
  skill: Skill;
  onUpdate: (id: string, data: Partial<Skill>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onPromote: (skillId: string) => Promise<void>;
  agents: any[];
}) {
  const [label, setLabel] = useState(skill.label || skill.skill_key);
  const [description, setDescription] = useState(skill.description || "");
  const [content, setContent] = useState(skill.content || "");
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isDirty =
    label !== skill.label ||
    description !== skill.description ||
    content !== skill.content;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onUpdate(skill.id, { label, description, content });
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2500);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    await onDelete(skill.id);
  };

  const handlePromote = async () => {
    if (!skill.skill_id) return;
    setPromoting(true);
    try {
      await onPromote(skill.skill_id);
      toast.success(`Promoted '${skill.label}' to TRUSTED`);
    } catch (e: any) {
      toast.error(e.message || "Failed to promote skill");
    } finally {
      setPromoting(false);
    }
  };

  const isProvisional = skill.trust_state === "provisional";

  // 1. Creator Workflow
  const creatorAgent = skill.created_by_agent_id
    ? agents.find((a: any) => a.id === skill.created_by_agent_id)
    : null;


  // 2. Attached Workflows
  const attachedIds = skill.attached_agent_ids || [];
  const attachedAgents = agents.filter((a: any) => attachedIds.includes(a.id));

  return (
    <div className={`rounded-xl border bg-card shadow-sm overflow-hidden transition-all ${isProvisional ? "border-amber-500/40 dark:border-amber-500/30 bg-amber-500/[0.02]" : ""}`}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b bg-muted/20">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <BookOpen className={`h-4 w-4 shrink-0 ${isProvisional ? "text-amber-500" : "text-primary"}`} />
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={label}
                onChange={e => setLabel(e.target.value)}
                className="h-7 text-sm font-semibold bg-transparent border-0 p-0 focus-visible:ring-0 max-w-[240px]"
                placeholder="Skill name..."
              />
              {/* Trust Badge */}
              {isProvisional ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                  <ShieldAlert className="h-3 w-3" /> Provisional ({skill.use_count || 0}/2)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  <ShieldCheck className="h-3 w-3" /> Trusted
                </span>
              )}

              {/* Origin Badge */}
              {skill.origin && (
                <span className="text-[10px] uppercase font-mono font-bold px-1.5 py-0.5 rounded bg-muted text-muted-foreground border">
                  {skill.origin}
                </span>
              )}

              {/* Creator Stamp Badge */}
              {creatorAgent ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-700 dark:text-purple-300 border border-purple-500/30">
                  <Sparkles className="h-3 w-3 text-purple-500" /> Created by: {creatorAgent.name}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground border">
                  System
                </span>
              )}

              {/* Attached Workflows Badges */}
              {attachedAgents.map((ag: any) => (
                <span key={`ag-attached-${skill.id}-${ag.id}`} className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30">
                  <Link2 className="h-3 w-3 text-sky-500" /> Attached: {ag.name}
                </span>
              ))}
            </div>
            <p className="text-xs text-muted-foreground truncate mt-0.5">{description || "No description set"}</p>
          </div>
        </div>



        {/* Action Controls */}
        <div className="flex items-center gap-1.5 self-end sm:self-center shrink-0">
          {isProvisional && (
            <Button
              size="sm"
              variant="outline"
              onClick={handlePromote}
              disabled={promoting}
              className="h-7 px-2.5 text-xs gap-1 border-amber-500/30 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
            >
              {promoting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              Force Promote
            </Button>
          )}

          {savedOk && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
          <Button size="sm" onClick={handleSave} disabled={saving || !isDirty} className="h-7 px-2.5 text-xs gap-1">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3 w-3" />}
            Save
          </Button>
          <Button size="sm" variant={confirmDelete ? "destructive" : "ghost"}
            onClick={handleDelete} disabled={deleting} className="h-7 px-2 text-xs">
            {deleting ? <Loader2 className="h-3 w-3 animate-spin" />
              : confirmDelete ? "Confirm" : <Trash2 className="h-3 w-3" />}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)} className="h-7 px-2">
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="p-4 sm:p-5 space-y-4 bg-background">
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">Description</label>
            <Input value={description} onChange={e => setDescription(e.target.value)}
              placeholder="What does this skill do?" className="h-8 text-sm" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs text-muted-foreground">SKILL.md Content</label>
              <span className="text-[10px] font-mono text-muted-foreground">{content.length.toLocaleString()} chars</span>
            </div>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              rows={14}
              placeholder="# Skill: Your Skill Name&#10;&#10;## Instructions&#10;..."
              className="w-full rounded-lg border border-input bg-background text-foreground px-3 py-2.5 text-xs font-mono
                leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-primary/50 min-h-[200px]"
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function SkillsSection() {
  const [activeTab, setActiveTab] = useState<"library" | "settings" | "prompts" | "telemetry">("library");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [telemetryLogs, setTelemetryLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [newSkillKey, setNewSkillKey] = useState("");
  const [newSkillLabel, setNewSkillLabel] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Evolution Settings State
  const [settings, setSettings] = useState<EvolutionSettings>({
    analysis_provider: "openrouter",
    analysis_model: "google/gemini-2.0-flash",
    evolution_provider: "openrouter",
    evolution_model: "google/gemini-2.5-flash",
    dedup_threshold_percent: 85,
    trust_promotion_count: 2,
    skip_pure_chat: true,
    max_evolutions_per_day: 5,
    analysis_prompt_override: OPENSPACE_DEFAULT_PROMPTS.analysis,
    fix_prompt_override: OPENSPACE_DEFAULT_PROMPTS.fix,
    derived_prompt_override: OPENSPACE_DEFAULT_PROMPTS.derived,
    captured_prompt_override: OPENSPACE_DEFAULT_PROMPTS.captured,
  });
  const [savingSettings, setSavingSettings] = useState(false);

  const fetchSkillsData = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/skills");
      const data = await res.json();
      setSkills(data.skills ?? []);

      const resAgents = await fetch("/api/agents");
      const dataAgents = await resAgents.json();
      setAgents(dataAgents.agents ?? []);

      const resProv = await fetch("/api/provider-status");
      const dataProv = await resProv.json();
      setProviders(dataProv.providers ?? []);

      const resSettings = await fetch("/api/skills/evolution-settings");
      const dataSettings = await resSettings.json();
      if (dataSettings.settings) {
        const s = dataSettings.settings;
        setSettings({
          ...s,
          analysis_prompt_override: s.analysis_prompt_override || OPENSPACE_DEFAULT_PROMPTS.analysis,
          fix_prompt_override: s.fix_prompt_override || OPENSPACE_DEFAULT_PROMPTS.fix,
          derived_prompt_override: s.derived_prompt_override || OPENSPACE_DEFAULT_PROMPTS.derived,
          captured_prompt_override: s.captured_prompt_override || OPENSPACE_DEFAULT_PROMPTS.captured,
        });
      }
      const resTel = await fetch("/api/skills/telemetry");
      const dataTel = await resTel.json();
      setTelemetryLogs(dataTel.analyses ?? []);
    } catch (e) {
      console.error("Failed to load skills details:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchSkillsData(); }, []);

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const res = await fetch("/api/skills/evolution-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error("Failed to save evolution settings");
      toast.success("Saved Evolution Settings & Prompts!");
    } catch (e: any) {
      toast.error(e.message || "Failed to save settings");
    } finally {
      setSavingSettings(false);
    }
  };

  const handleCreate = async () => {
    if (!newSkillKey || !newSkillLabel) return;
    setCreating(true);
    try {
      await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skill_key: newSkillKey.toLowerCase().replace(/\s+/g, "_"),
          label: newSkillLabel,
          description: "",
          content: `---\nname: ${newSkillKey}\ndescription: ${newSkillLabel}\n---\n\n# ${newSkillLabel}\n\n## Instructions\n...`,
          source: "user",
        }),
      });
      setNewSkillKey("");
      setNewSkillLabel("");
      setShowCreateForm(false);
      fetchSkillsData();
    } finally {
      setCreating(false);
    }
  };

  const handleUpdate = async (id: string, data: Partial<Skill>) => {
    await fetch(`/api/skills/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    await fetchSkillsData();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/skills/${id}`, { method: "DELETE" });
    setSkills(prev => prev.filter(s => s.id !== id));
  };

  const handlePromote = async (skillId: string) => {
    await fetch("/api/skills/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_id: skillId }),
    });
    await fetchSkillsData();
  };

  if (loading) {
    return <div className="flex items-center gap-2 py-12 text-muted-foreground text-sm justify-center">
      <Loader2 className="h-5 w-5 animate-spin" /> Loading Skills Intelligence Engine…
    </div>;
  }

  // Get models for selected analysis provider
  const analysisProvObj = providers.find(p => p.id === settings.analysis_provider) || providers[0];
  const analysisModels = analysisProvObj?.defaultModels || [];

  // Get models for selected evolution provider
  const evolutionProvObj = providers.find(p => p.id === settings.evolution_provider) || providers[0];
  const evolutionModels = evolutionProvObj?.defaultModels || [];

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card to-background p-6 shadow-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary shrink-0">
              <Sparkles className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold tracking-tight">Skills Intelligence & Evolution Engine</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                OpenSpace-inspired AI Skill Evolution • Post-Chat Execution Analyzer • Semantic Deduplication Gate
              </p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex flex-wrap items-center gap-1 p-1 bg-muted/40 rounded-lg border text-xs">
            <button
              onClick={() => setActiveTab("library")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors ${activeTab === "library" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              <BookOpen className="h-3.5 w-3.5" /> Library ({skills.length})
            </button>
            <button
              onClick={() => setActiveTab("settings")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors ${activeTab === "settings" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              <Sliders className="h-3.5 w-3.5" /> Model & Settings
            </button>
            <button
              onClick={() => setActiveTab("prompts")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors ${activeTab === "prompts" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              <FileCode className="h-3.5 w-3.5" /> Prompts
            </button>
            <button
              onClick={() => setActiveTab("telemetry")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors ${activeTab === "telemetry" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              <Activity className="h-3.5 w-3.5" /> History ({telemetryLogs.length})
            </button>
          </div>
        </div>
      </div>

      {/* Tab 1: Skills Library */}
      {activeTab === "library" && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h3 className="font-semibold text-sm">Active & Provisional Skills</h3>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => setShowCreateForm(!showCreateForm)} className="gap-1.5 text-xs">
                <Plus className="h-3.5 w-3.5" /> New Skill
              </Button>
            </div>
          </div>

          {showCreateForm && (
            <div className="rounded-xl border bg-muted/10 p-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Skill Key (slug)</label>
                  <Input value={newSkillKey} onChange={e => setNewSkillKey(e.target.value)}
                    placeholder="blog_post_writer" className="h-8 text-sm font-mono" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Display Label</label>
                  <Input value={newSkillLabel} onChange={e => setNewSkillLabel(e.target.value)}
                    placeholder="Blog Post Writer" className="h-8 text-sm" />
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleCreate} disabled={creating || !newSkillKey || !newSkillLabel} className="gap-1.5 text-xs">
                  {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  Create
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowCreateForm(false)} className="text-xs">
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-3">
            {skills.map(skill => (
              <SkillCard key={skill.id} skill={skill} onUpdate={handleUpdate} onDelete={handleDelete} onPromote={handlePromote} agents={agents} />
            ))}
          </div>
        </div>
      )}

      {/* Tab 2: Model & Evolution Settings */}
      {activeTab === "settings" && (
        <div className="space-y-6 rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between border-b pb-3">
            <div>
              <h3 className="font-semibold text-sm">Dynamic AI Provider & Model Configuration</h3>
              <p className="text-xs text-muted-foreground">Select AI providers and models dynamically for post-chat analysis & skill evolution</p>
            </div>
            <Button size="sm" onClick={handleSaveSettings} disabled={savingSettings} className="gap-1.5 text-xs">
              {savingSettings ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save Settings
            </Button>
          </div>

          {/* Section 1: Execution Analysis AI */}
          <div className="p-4 rounded-xl border bg-muted/10 space-y-4">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-primary" />
              <h4 className="font-semibold text-xs uppercase tracking-wide">1. Execution Analysis AI Model</h4>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Analysis Provider Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground">Analysis AI Provider</label>
                <select
                  value={settings.analysis_provider}
                  onChange={e => {
                    const newProv = e.target.value;
                    const provObj = providers.find(p => p.id === newProv);
                    const firstModel = provObj?.defaultModels?.[0]?.value || "";
                    setSettings({ ...settings, analysis_provider: newProv, analysis_model: firstModel });
                  }}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {providers.map(p => (
                    <option key={`ans-prov-${p.id}`} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">Connected AI Provider for reading chat logs.</p>
              </div>

              {/* Analysis Model Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground">Analysis AI Model</label>
                <select
                  value={settings.analysis_model}
                  onChange={e => setSettings({ ...settings, analysis_model: e.target.value })}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {analysisModels.map(m => (
                    <option key={`ans-mod-${m.value}`} value={m.value}>
                      {m.label} ({m.value})
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">Fast model used for post-chat analysis pass.</p>
              </div>
            </div>
          </div>

          {/* Section 2: Skill Evolution AI */}
          <div className="p-4 rounded-xl border bg-muted/10 space-y-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-violet-500" />
              <h4 className="font-semibold text-xs uppercase tracking-wide">2. Skill Evolution AI Model</h4>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Evolution Provider Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground">Evolution AI Provider</label>
                <select
                  value={settings.evolution_provider}
                  onChange={e => {
                    const newProv = e.target.value;
                    const provObj = providers.find(p => p.id === newProv);
                    const firstModel = provObj?.defaultModels?.[0]?.value || "";
                    setSettings({ ...settings, evolution_provider: newProv, evolution_model: firstModel });
                  }}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {providers.map(p => (
                    <option key={`evo-prov-${p.id}`} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">Connected AI Provider for writing/fixing skills.</p>
              </div>

              {/* Evolution Model Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground">Evolution AI Model</label>
                <select
                  value={settings.evolution_model}
                  onChange={e => setSettings({ ...settings, evolution_model: e.target.value })}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {evolutionModels.map(m => (
                    <option key={`evo-mod-${m.value}`} value={m.value}>
                      {m.label} ({m.value})
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">Smarter model used for generating SKILL.md documents.</p>
              </div>
            </div>
          </div>

          {/* Section 3: Threshold Controls */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground">Semantic Deduplication Threshold (%)</label>
              <Input
                type="number"
                value={settings.dedup_threshold_percent}
                onChange={e => setSettings({ ...settings, dedup_threshold_percent: parseInt(e.target.value, 10) || 85 })}
                className="h-9 text-xs font-mono"
              />
              <p className="text-[11px] text-muted-foreground">Blocks duplicate skills if similarity is above this % (default: 85%).</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground">Trust Promotion Test Count</label>
              <Input
                type="number"
                value={settings.trust_promotion_count}
                onChange={e => setSettings({ ...settings, trust_promotion_count: parseInt(e.target.value, 10) || 2 })}
                className="h-9 text-xs font-mono"
              />
              <p className="text-[11px] text-muted-foreground">Successful test runs required to promote PROVISIONAL ➔ TRUSTED (default: 2).</p>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Prompts Editor */}
      {activeTab === "prompts" && (
        <div className="space-y-6 rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between border-b pb-3">
            <div>
              <h3 className="font-semibold text-sm">OpenSpace Evolution Prompts & Instructions Editor</h3>
              <p className="text-xs text-muted-foreground">View, customize, or tweak prompts used by Analysis & Evolution AI models</p>
            </div>
            <Button size="sm" onClick={handleSaveSettings} disabled={savingSettings} className="gap-1.5 text-xs">
              {savingSettings ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save Prompts
            </Button>
          </div>

          <div className="space-y-6">
            {/* Prompt 1 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold flex items-center gap-1.5">
                  <Cpu className="h-3.5 w-3.5 text-primary" /> Execution Analysis Prompt (Reads Chat Logs)
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSettings({ ...settings, analysis_prompt_override: OPENSPACE_DEFAULT_PROMPTS.analysis })}
                  className="h-6 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                >
                  <RotateCcw className="h-3 w-3" /> Reset Default
                </Button>
              </div>
              <textarea
                value={settings.analysis_prompt_override || OPENSPACE_DEFAULT_PROMPTS.analysis}
                onChange={e => setSettings({ ...settings, analysis_prompt_override: e.target.value })}
                rows={10}
                className="w-full rounded-lg border border-input bg-background p-3 text-xs font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            {/* Prompt 2 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-amber-500" /> FIX Evolution Prompt (Repairs Broken Skills)
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSettings({ ...settings, fix_prompt_override: OPENSPACE_DEFAULT_PROMPTS.fix })}
                  className="h-6 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                >
                  <RotateCcw className="h-3 w-3" /> Reset Default
                </Button>
              </div>
              <textarea
                value={settings.fix_prompt_override || OPENSPACE_DEFAULT_PROMPTS.fix}
                onChange={e => setSettings({ ...settings, fix_prompt_override: e.target.value })}
                rows={10}
                className="w-full rounded-lg border border-input bg-background p-3 text-xs font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            {/* Prompt 3 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold flex items-center gap-1.5">
                  <Layers className="h-3.5 w-3.5 text-indigo-500" /> DERIVED Evolution Prompt (Specializes Skills)
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSettings({ ...settings, derived_prompt_override: OPENSPACE_DEFAULT_PROMPTS.derived })}
                  className="h-6 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                >
                  <RotateCcw className="h-3 w-3" /> Reset Default
                </Button>
              </div>
              <textarea
                value={settings.derived_prompt_override || OPENSPACE_DEFAULT_PROMPTS.derived}
                onChange={e => setSettings({ ...settings, derived_prompt_override: e.target.value })}
                rows={10}
                className="w-full rounded-lg border border-input bg-background p-3 text-xs font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            {/* Prompt 4 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold flex items-center gap-1.5">
                  <Plus className="h-3.5 w-3.5 text-emerald-500" /> CAPTURED Evolution Prompt (New Skill From Scratch)
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSettings({ ...settings, captured_prompt_override: OPENSPACE_DEFAULT_PROMPTS.captured })}
                  className="h-6 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                >
                  <RotateCcw className="h-3 w-3" /> Reset Default
                </Button>
              </div>
              <textarea
                value={settings.captured_prompt_override || OPENSPACE_DEFAULT_PROMPTS.captured}
                onChange={e => setSettings({ ...settings, captured_prompt_override: e.target.value })}
                rows={10}
                className="w-full rounded-lg border border-input bg-background p-3 text-xs font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
        </div>
      )}

      {/* Tab 4: Telemetry History */}
      {activeTab === "telemetry" && (
        <div className="space-y-4">
          <h3 className="font-semibold text-sm">Post-Chat Execution Verdicts History</h3>
          {telemetryLogs.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-xs text-muted-foreground">
              No chat execution analysis records logged yet. Run a chat task to see history.
            </div>
          ) : (
            <div className="space-y-3">
              {telemetryLogs.map((log) => (
                <div key={log.id} className="rounded-xl border bg-card p-4 text-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-muted-foreground">{log.task_id}</span>
                    <span className={`px-2 py-0.5 rounded font-bold ${log.task_completed ? "bg-emerald-500/10 text-emerald-600" : "bg-rose-500/10 text-rose-600"}`}>
                      {log.task_completed ? "COMPLETED" : "FAILED / INCOMPLETE"}
                    </span>
                  </div>
                  <p className="font-semibold text-foreground">{log.task_description}</p>
                  <p className="text-muted-foreground">{log.execution_note}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
