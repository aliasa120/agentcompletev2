"use client";

import React, { useState, useEffect } from "react";
import {
  Plus, Trash2, Save, Loader2, CheckCircle2,
  BookOpen, ChevronDown, ChevronUp, Sparkles, Link2, ShieldAlert, ShieldCheck
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JanCard, CardItem } from "@/components/settings/JanCard";
import { cn } from "@/lib/utils";
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
    <JanCard className={cn(
      "p-0 overflow-hidden transition-all",
      isProvisional && "border-amber-500/40 dark:border-amber-500/30 bg-amber-500/[0.02]"
    )}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-border/40 bg-muted/20">
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
    </JanCard>
  );
}

export function SkillsSection() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newSkillKey, setNewSkillKey] = useState("");
  const [newSkillLabel, setNewSkillLabel] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const fetchSkillsData = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/skills");
      const data = await res.json();
      setSkills(data.skills ?? []);

      const resAgents = await fetch("/api/agents");
      const dataAgents = await resAgents.json();
      setAgents(dataAgents.agents ?? []);
    } catch (e) {
      console.error("Failed to load skills details:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchSkillsData(); }, []);

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
      <Loader2 className="h-5 w-5 animate-spin" /> Loading Skills…
    </div>;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <JanCard
        header={
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary shrink-0">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-medium text-foreground font-studio">Skills Library</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Skills are learned and maintained by your agents during chat (list_skills / read_skill / manage_skill).
              </p>
            </div>
          </div>
        }
      />

      {/* Skills Library */}
      <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-1">
            <h3 className="font-medium text-sm text-foreground">Active & Provisional Skills</h3>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => setShowCreateForm(!showCreateForm)} className="gap-1.5 text-xs">
                <Plus className="h-3.5 w-3.5" /> New Skill
              </Button>
            </div>
          </div>

          {showCreateForm && (
            <JanCard title="New Skill">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <CardItem
                  column
                  title="Skill Key (slug)"
                  description="Machine-friendly identifier used in the DB"
                >
                  <Input value={newSkillKey} onChange={e => setNewSkillKey(e.target.value)}
                    placeholder="blog_post_writer" className="h-8 text-sm font-mono w-full" />
                </CardItem>
                <CardItem
                  column
                  title="Display Label"
                  description="Human-friendly name shown in the library"
                >
                  <Input value={newSkillLabel} onChange={e => setNewSkillLabel(e.target.value)}
                    placeholder="Blog Post Writer" className="h-8 text-sm w-full" />
                </CardItem>
              </div>
              <div className="flex gap-2 mt-4">
                <Button size="sm" onClick={handleCreate} disabled={creating || !newSkillKey || !newSkillLabel} className="gap-1.5 text-xs">
                  {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  Create
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowCreateForm(false)} className="text-xs">
                  Cancel
                </Button>
              </div>
            </JanCard>
          )}

          <div className="space-y-3">
            {skills.map(skill => (
              <SkillCard key={skill.id} skill={skill} onUpdate={handleUpdate} onDelete={handleDelete} onPromote={handlePromote} agents={agents} />
            ))}
          </div>
        </div>
    </div>
  );
}
