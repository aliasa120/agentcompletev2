"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Plus, Trash2, Save, Edit3, Upload, Loader2, CheckCircle2,
  BookOpen, XCircle, ChevronDown, ChevronUp
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Skill {
  id: string;
  skill_key: string;
  label: string;
  description: string;
  content: string;
  source: string;
  created_at: string;
  created_by_agent_id?: string | null;
}

function SkillCard({
  skill,
  onUpdate,
  onDelete,
  agents,
}: {
  skill: Skill;
  onUpdate: (id: string, data: Partial<Skill>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  agents: any[];
}) {
  const [label, setLabel] = useState(skill.label);
  const [description, setDescription] = useState(skill.description);
  const [content, setContent] = useState(skill.content);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
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

  // Determine Creator
  const creatorAgent = skill.created_by_agent_id
    ? agents.find(a => a.id === skill.created_by_agent_id)?.name || "Agent"
    : skill.source === "builtin"
    ? "System"
    : "User";

  // Determine Attached Agents
  const attachedAgents = agents.filter(agent => {
    const isAutoAttached =
      agent.attach_all_skills &&
      (skill.created_by_agent_id === null ||
        skill.created_by_agent_id === undefined ||
        skill.created_by_agent_id === agent.id);
    const isManuallyAssigned = agent.agent_tool_assignments?.some(
      (tool: any) => tool.tool_type === "skill" && tool.tool_key === skill.skill_key && tool.enabled
    );
    return isAutoAttached || isManuallyAssigned;
  }).map(a => a.name);

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b bg-muted/20">
        <BookOpen className="h-4 w-4 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <Input
            value={label}
            onChange={e => setLabel(e.target.value)}
            className="h-7 text-sm font-semibold bg-transparent border-0 p-0 focus-visible:ring-0"
            placeholder="Skill name..."
          />
          <div className="flex flex-wrap items-center gap-2 mt-0.5">
            <span className="text-[10px] text-muted-foreground">
              Created by: <span className="font-semibold text-foreground">{creatorAgent}</span>
            </span>
            <span className="text-muted-foreground/30">•</span>
            <span className="text-[10px] text-muted-foreground">
              Attached to:{" "}
              {attachedAgents.length === 0 ? (
                <span className="italic">none</span>
              ) : (
                <span className="font-semibold text-primary">{attachedAgents.join(", ")}</span>
              )}
            </span>
          </div>
        </div>
        {skill.source === "builtin" && (
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 shrink-0">
            Built-in
          </span>
        )}
        <div className="flex items-center gap-1.5">
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
        <div className="p-5 space-y-4">
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
              rows={16}
              placeholder="# Skill: Your Skill Name&#10;&#10;## Instructions&#10;..."
              className="w-full rounded-lg border border-input bg-muted/20 px-3 py-2.5 text-xs font-mono
                leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-primary/50 min-h-[200px]"
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function SkillsSection() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [newSkillKey, setNewSkillKey] = useState("");
  const [newSkillLabel, setNewSkillLabel] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const fetchSkills = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/skills");
      const data = await res.json();
      setSkills(data.skills ?? []);

      const resAgents = await fetch("/api/agents");
      const dataAgents = await resAgents.json();
      setAgents(dataAgents.agents ?? []);
    } catch (e) {
      console.error("Failed to load skills and agents details:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchSkills(); }, []);

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
          content: `# Skill: ${newSkillLabel}\n\n## Instructions\n\nDescribe your skill instructions here...\n`,
          source: "user",
        }),
      });
      setNewSkillKey("");
      setNewSkillLabel("");
      setShowCreateForm(false);
      fetchSkills();
    } finally {
      setCreating(false);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    const nameWithoutExt = file.name.replace(/\.md$/i, "");
    await fetch("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skill_key: nameWithoutExt.toLowerCase().replace(/[\s-]+/g, "_"),
        label: nameWithoutExt.replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
        description: "Uploaded from file",
        content,
        source: "user",
      }),
    });
    fetchSkills();
    e.target.value = "";
  };

  const handleUpdate = async (id: string, data: Partial<Skill>) => {
    await fetch(`/api/skills/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    await fetchSkills();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/skills/${id}`, { method: "DELETE" });
    setSkills(prev => prev.filter(s => s.id !== id));
  };

  if (loading) {
    return <div className="flex items-center gap-2 py-12 text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" /> Loading skills…
    </div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Skills Library</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Instruction sets that agents load via <code className="text-xs bg-muted px-1 rounded">read_skill()</code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input type="file" ref={fileInputRef} accept=".md" className="hidden" onChange={handleUpload} />
          <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} className="gap-1.5 text-xs">
            <Upload className="h-3.5 w-3.5" /> Upload .md
          </Button>
          <Button size="sm" onClick={() => setShowCreateForm(!showCreateForm)} className="gap-1.5 text-xs">
            <Plus className="h-3.5 w-3.5" /> New Skill
          </Button>
        </div>
      </div>

      {/* Create form */}
      {showCreateForm && (
        <div className="rounded-xl border bg-muted/10 p-4 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Create New Skill</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Skill Key (slug)</label>
              <Input value={newSkillKey} onChange={e => setNewSkillKey(e.target.value)}
                placeholder="my_skill_name" className="h-8 text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Display Label</label>
              <Input value={newSkillLabel} onChange={e => setNewSkillLabel(e.target.value)}
                placeholder="My Skill Name" className="h-8 text-sm" />
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleCreate} disabled={creating || !newSkillKey || !newSkillLabel} className="gap-1.5 text-xs">
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowCreateForm(false)} className="text-xs">
              <XCircle className="h-3.5 w-3.5 mr-1" /> Cancel
            </Button>
          </div>
        </div>
      )}

      {skills.length === 0 && !showCreateForm && (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <BookOpen className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground mb-1">No skills yet</p>
          <p className="text-xs text-muted-foreground mb-4">Create a skill or upload an existing SKILL.md file</p>
          <div className="flex gap-2 justify-center">
            <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} className="gap-1.5 text-xs">
              <Upload className="h-3.5 w-3.5" /> Upload .md
            </Button>
            <Button size="sm" onClick={() => setShowCreateForm(true)} className="gap-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" /> New Skill
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {skills.map(skill => (
          <SkillCard key={skill.id} skill={skill} onUpdate={handleUpdate} onDelete={handleDelete} agents={agents} />
        ))}
      </div>

      {skills.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2">
          <Edit3 className="h-3.5 w-3.5" />
          Click a skill to expand and edit its SKILL.md content. Changes sync instantly to all agents.
        </div>
      )}
    </div>
  );
}
