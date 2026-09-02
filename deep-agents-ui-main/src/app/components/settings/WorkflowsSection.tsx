"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Plus, Trash2, Save, Loader2, CheckCircle2,
  ListTodo, Play, Settings2, ShieldCheck, HelpCircle,
  Link as LinkIcon, Unlink, RefreshCw, RotateCcw, Sparkles
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { JanCard, CardItem } from "@/components/settings/JanCard";
import { AnimatePresence, motion } from "framer-motion";
import { BiSearch } from "react-icons/bi";

interface Workflow {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  interval_minutes: number;
  batch_size: number;
  last_trigger_at: string | null;
  feeder_enabled: boolean;
  feeder_interval_minutes: number;
  feeder_last_trigger_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface Agent {
  id: string;
  name: string;
  agent_type: string;
  workflow_id: string | null;
  workflow_agent_assignments?: { workflow_id: string }[];
}

interface DelayedInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  value: string;
  onChange: (val: string) => void;
}

function DelayedInput({ value, onChange, ...props }: DelayedInputProps) {
  const [localVal, setLocalVal] = useState(value);

  useEffect(() => {
    setLocalVal(value);
  }, [value]);

  const commit = () => {
    if (localVal !== value) {
      onChange(localVal);
    }
  };

  return (
    <Input
      {...props}
      value={localVal}
      onChange={e => setLocalVal(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
    />
  );
}

interface DelayedNumberInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
  value: number;
  min?: number;
  max?: number;
  onChange: (val: number) => void;
}

function DelayedNumberInput({ value, onChange, min, max, ...props }: DelayedNumberInputProps) {
  const [localVal, setLocalVal] = useState(String(value));

  useEffect(() => {
    setLocalVal(String(value));
  }, [value]);

  const commit = () => {
    let num = parseInt(localVal, 10);
    if (isNaN(num)) {
      setLocalVal(String(value));
      return;
    }
    if (min !== undefined && num < min) num = min;
    if (max !== undefined && num > max) num = max;
    
    setLocalVal(String(num));
    if (num !== value) {
      onChange(num);
    }
  };

  return (
    <Input
      {...props}
      type="number"
      min={min}
      max={max}
      value={localVal}
      onChange={e => setLocalVal(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function WorkflowsSection({ feederPluginEnabled = true }: { feederPluginEnabled?: boolean }) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);

  // Search and sort states
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("name"); // "name", "active", "newest"

  // New Workflow Form
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [wfRes, agentRes] = await Promise.all([
        fetch("/api/workflows"),
        fetch("/api/agents")
      ]);
      const wfData = await wfRes.json();
      const agentData = await agentRes.json();
      setWorkflows(wfData.workflows ?? []);
      setAgents(agentData.agents ?? []);
    } catch (e) {
      console.error("Failed to load workflow data", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCreateWorkflow = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          description: newDescription,
          interval_minutes: 60,
          batch_size: 2,
          enabled: false,
          is_active: true
        })
      });
      if (res.ok) {
        const data = await res.json();
        setNewName("");
        setNewDescription("");
        setShowCreateForm(false);
        await fetchData();
        if (data.workflow?.id) {
          setSelectedWorkflowId(data.workflow.id);
        }
      }
    } catch (e) {
      console.error("Error creating workflow", e);
    } finally {
      setCreating(false);
    }
  };

  const handleUpdateWorkflow = async (id: string, updates: Partial<Workflow>) => {
    setSavingId(id);
    try {
      const res = await fetch(`/api/workflows/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates)
      });
      if (res.ok) {
        setWorkflows(prev => prev.map(w => w.id === id ? { ...w, ...updates } : w));
      }
    } catch (e) {
      console.error("Error updating workflow", e);
    } finally {
      setSavingId(null);
    }
  };

  const handleDeleteWorkflow = async (id: string) => {
    if (!confirm("Are you sure you want to delete this workflow? Linked agents will be unassigned.")) return;
    try {
      const res = await fetch(`/api/workflows/${id}`, {
        method: "DELETE"
      });
      if (res.ok) {
        setWorkflows(prev => prev.filter(w => w.id !== id));
        setAgents(prev => prev.map(a => a.workflow_id === id ? { ...a, workflow_id: null } : a));
      }
    } catch (e) {
      console.error("Error deleting workflow", e);
    }
  };

  const handleAssignAgent = async (agentId: string, targetWorkflowId: string, action: "link" | "unlink") => {
    try {
      const agent = agents.find(a => a.id === agentId);
      if (!agent) return;

      const currentWfs = (agent.workflow_agent_assignments ?? [])
        .map((w: any) => w.workflow_id)
        .filter(Boolean);

      if (agent.workflow_id && !currentWfs.includes(agent.workflow_id)) {
        currentWfs.push(agent.workflow_id);
      }

      let nextWfs: string[];
      if (action === "link") {
        nextWfs = currentWfs.includes(targetWorkflowId) ? currentWfs : [...currentWfs, targetWorkflowId];
      } else {
        nextWfs = currentWfs.filter(id => id !== targetWorkflowId);
      }

      const res = await fetch(`/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_ids: nextWfs })
      });

      if (res.ok) {
        setAgents(prev => prev.map(a => {
          if (a.id === agentId) {
            return {
              ...a,
              workflow_id: nextWfs.length > 0 ? nextWfs[0] : null,
              workflow_agent_assignments: nextWfs.map(wId => ({ workflow_id: wId }))
            };
          }
          return a;
        }));
      }
    } catch (e) {
      console.error("Error assigning agent", e);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading workflows…
      </div>
    );
  }



  const selectedWorkflow = workflows.find(w => w.id === selectedWorkflowId);

  if (selectedWorkflowId !== null && selectedWorkflow) {
    return (
      <WorkflowEditor
        workflow={selectedWorkflow}
        agents={agents}
        onClose={() => setSelectedWorkflowId(null)}
        onUpdate={handleUpdateWorkflow}
        onDelete={handleDeleteWorkflow}
        onAssignAgent={handleAssignAgent}
        feederPluginEnabled={feederPluginEnabled}
      />
    );
  }

  // Filtered and sorted workflows
  const filteredWorkflows = workflows
    .filter(w => 
      w.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
      w.description.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .sort((a, b) => {
      if (sortBy === "name") {
        return a.name.localeCompare(b.name);
      }
      if (sortBy === "active") {
        return (b.is_active ? 1 : 0) - (a.is_active ? 1 : 0);
      }
      if (sortBy === "newest") {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      return 0;
    });

  return (
    <div className="space-y-6">
      {/* 2-Row Structured Header Layout */}
      <div className="flex flex-col gap-1.5 border-b border-border pb-4">
        <h1 className="text-xl font-bold md:text-2xl flex items-center gap-2 text-foreground leading-none">
          <Settings2 className="h-5 w-5 text-primary" /> Workflows
        </h1>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Configure isolated workflow pipelines, each with its own Main Agent, Subagents, and Cron schedule.
        </p>
      </div>

      {/* Toolbar row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
        <div className="flex items-center gap-3 flex-1 w-full sm:max-w-md">
          {/* Search box */}
          <div className="relative flex-1">
            <BiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 size-4" />
            <Input
              placeholder="Search workflows..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 h-9 text-xs bg-background w-full"
            />
          </div>
          {/* Sort dropdown */}
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="h-9 px-3 rounded-lg border border-input bg-background text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all hover:bg-muted/10 font-semibold"
          >
            <option value="name">Sort by: Name</option>
            <option value="active">Sort by: Active First</option>
            <option value="newest">Sort by: Newest</option>
          </select>
        </div>
        {/* Create button */}
        <Button size="sm" onClick={() => setShowCreateForm(!showCreateForm)} className="gap-1.5 h-9 rounded-lg px-4 text-xs font-semibold self-stretch sm:self-auto justify-center">
          <Plus className="h-4 w-4" /> Create Workflow
        </Button>
      </div>

      {showCreateForm && (
        <div className="animate-in fade-in slide-in-from-top-2 duration-200">
          <JanCard title="New Workflow Pipeline">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
              <CardItem column className="mt-0" title="Workflow Name">
                <Input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="e.g. Finance Agent System"
                  className="h-9 text-xs bg-background w-full"
                />
              </CardItem>
              <CardItem column className="mt-0" title="Description">
                <Input
                  value={newDescription}
                  onChange={e => setNewDescription(e.target.value)}
                  placeholder="Brief description of this workflow's role"
                  className="h-9 text-xs bg-background w-full"
                />
              </CardItem>
            </div>
            <div className="flex gap-2 mt-4">
              <Button size="sm" onClick={handleCreateWorkflow} disabled={creating || !newName.trim()} className="gap-1.5 h-8 text-xs font-semibold">
                {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Create
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowCreateForm(false)} className="h-8 text-xs">
                Cancel
              </Button>
            </div>
          </JanCard>
        </div>
      )}

      {/* Grid List rendering for workflows */}
      <div className="grid auto-cols-fr grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {filteredWorkflows.map((wf) => {
          const wfAgents = agents.filter(a => {
            const wfs = (a.workflow_agent_assignments ?? []).map((w: any) => w.workflow_id);
            if (a.workflow_id && !wfs.includes(a.workflow_id)) wfs.push(a.workflow_id);
            return wfs.includes(wf.id);
          });
          const hasMain = wfAgents.some(a => a.agent_type === "main");

          return (
            <JanCard key={wf.id} className="hover:shadow-md transition-all duration-300 flex flex-col justify-between relative group">
              <div className="flex flex-col text-left">
                
                {/* Header Row */}
                <div className="flex items-start justify-between mb-4">
                  {/* Icon Square */}
                  <div className="size-14 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary flex-shrink-0 group-hover:bg-primary/20 transition-colors">
                    <Settings2 className="size-7" />
                  </div>
                  
                  {/* Quick Active switch */}
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground border rounded-full px-2 py-0.5 bg-muted/20">
                    <span>Active</span>
                    <Switch
                      checked={wf.is_active}
                      onCheckedChange={checked => handleUpdateWorkflow(wf.id, { is_active: checked })}
                    />
                  </div>
                </div>

                {/* Metadata details */}
                <div className="mb-3">
                  <h6 className="text-base font-bold leading-snug text-foreground group-hover:text-primary transition-colors truncate">
                    {wf.name}
                  </h6>
                  
                  {/* Meta stats */}
                  <div className="flex items-center text-xs text-muted-foreground flex-wrap gap-1 mt-1.5 font-mono">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-sans font-semibold ${
                      hasMain 
                        ? "bg-primary/5 text-primary border border-primary/25" 
                        : "bg-destructive/5 text-destructive border border-destructive/25"
                    }`}>
                      {wfAgents.length} Agents Connected {!hasMain && "⚠️"}
                    </span>
                  </div>
                </div>

                {/* Description */}
                <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed mb-4 min-h-[3rem] font-sans">
                  {wf.description || "No description set. Click configure to add metadata, schedules, and connect agents to this pipeline."}
                </p>
              </div>

              {/* Action configure button */}
              <Button
                onClick={() => setSelectedWorkflowId(wf.id)}
                variant="secondary"
                size="sm"
                className="w-full text-xs font-semibold rounded-lg mt-auto"
              >
                Configure Workflow
              </Button>
            </JanCard>
          );
        })}
      </div>

      {filteredWorkflows.length === 0 && (
        <div className="rounded-xl border border-dashed bg-muted/20 p-12 text-center">
          <ListTodo className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm font-semibold text-muted-foreground mb-1">No workflows found</p>
          <p className="text-xs text-muted-foreground mb-4">
            {searchQuery 
              ? "Try adjusting your search filters to find existing workflows."
              : "Create your first workflow to orchestrate a data processing pipeline."
            }
          </p>
          {!searchQuery && (
            <Button size="sm" onClick={() => setShowCreateForm(true)} className="gap-1.5 text-xs font-semibold">
              <Plus className="h-3.5 w-3.5" /> Create Workflow
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Dedicated Workflow Editor Component ──────────────────────────────────────
interface WorkflowEditorProps {
  workflow: Workflow;
  agents: Agent[];
  onClose: () => void;
  onUpdate: (id: string, updates: Partial<Workflow>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onAssignAgent: (agentId: string, workflowId: string, action: "link" | "unlink") => Promise<void>;
  feederPluginEnabled?: boolean;
}

function WorkflowEditor({
  workflow,
  agents,
  onClose,
  onUpdate,
  onDelete,
  onAssignAgent,
  feederPluginEnabled = true,
}: WorkflowEditorProps) {
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description);
  const [isActive, setIsActive] = useState(workflow.is_active);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setName(workflow.name);
    setDescription(workflow.description);
    setIsActive(workflow.is_active);
  }, [workflow]);

  const isDirty =
    name !== workflow.name ||
    description !== workflow.description ||
    isActive !== workflow.is_active;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onUpdate(workflow.id, {
        name,
        description,
        is_active: isActive,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setName(workflow.name);
    setDescription(workflow.description);
    setIsActive(workflow.is_active);
  };

  const handleDelete = async () => {
    if (confirm("Are you sure you want to delete this workflow? Linked agents will be unassigned.")) {
      setDeleting(true);
      try {
        await onDelete(workflow.id);
        onClose();
      } finally {
        setDeleting(false);
      }
    }
  };

  const wfAgents = agents.filter(a => {
    const wfs = (a.workflow_agent_assignments ?? []).map((w: any) => w.workflow_id);
    if (a.workflow_id && !wfs.includes(a.workflow_id)) wfs.push(a.workflow_id);
    return wfs.includes(workflow.id);
  });

  const availableAgents = agents.filter(a => {
    const wfs = (a.workflow_agent_assignments ?? []).map((w: any) => w.workflow_id);
    if (a.workflow_id && !wfs.includes(a.workflow_id)) wfs.push(a.workflow_id);
    return !wfs.includes(workflow.id);
  });

  const hasMain = wfAgents.some(a => a.agent_type === "main");

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12 animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* Header action bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-5">
        <div>
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground font-semibold transition-colors w-fit mb-1"
          >
            &larr; Back to Workflows
          </button>
          <h1 className="text-xl font-bold text-foreground sm:text-2xl">{name || "Unnamed Workflow"}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure scraping intervals, processing batch sizes, and connect agents to this pipeline.
          </p>
        </div>

        <div className="flex items-center gap-2">
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
            variant="ghost"
            onClick={handleDelete}
            disabled={deleting}
            className="h-9 px-3 text-xs gap-1.5 rounded-lg hover:bg-destructive/10 hover:text-destructive"
          >
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      {/* Main settings grid */}
      <div className="space-y-6">
        
        {/* Card 1: Core Configuration */}
        <JanCard title="Workflow Definition">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
            <CardItem column className="mt-0" title="Workflow Name">
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Enter workflow name..."
                className="h-9 text-xs bg-background w-full"
              />
            </CardItem>
            <CardItem
              className="mt-0"
              title="Workflow Pipeline Active"
              description="Main active state for this workflow"
              actions={<Switch checked={isActive} onCheckedChange={setIsActive} />}
            />
          </div>

          <CardItem column title="Description">
            <Input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Enter description..."
              className="h-9 text-xs bg-background w-full"
            />
          </CardItem>
        </JanCard>

        {/* Card 2: Associated Agents & Linkers */}
        <JanCard
          title="Connected Agents"
          header={!hasMain ? (
            <div className="-mt-2 mb-4">
              <span className="text-[10px] text-destructive bg-destructive/5 border border-destructive/20 rounded-full px-2 py-0.5 font-semibold inline-flex items-center gap-1">
                ⚠️ No Main Agent Assigned (Pipeline will not run)
              </span>
            </div>
          ) : undefined}
        >
          {/* Linked agents */}
          <div className="space-y-3">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              Linked to this workflow ({wfAgents.length})
            </span>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {wfAgents.map(agent => (
                <div key={agent.id} className="flex items-center justify-between border rounded-lg p-2.5 bg-muted/10">
                  <div>
                    <span className="font-semibold block text-xs text-foreground leading-none">{agent.name}</span>
                    <span className={`text-[9px] uppercase font-semibold mt-1.5 inline-block border px-1.5 py-0.5 rounded leading-none ${
                      agent.agent_type === "main" 
                        ? "bg-primary/10 text-primary border-primary/20" 
                        : "bg-muted text-muted-foreground border-border"
                    }`}>
                      {agent.agent_type}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onAssignAgent(agent.id, workflow.id, "unlink")}
                    className="h-7 px-2 text-[10px] text-destructive hover:bg-destructive/10"
                  >
                    <Unlink className="h-3 w-3 mr-1" /> Unlink
                  </Button>
                </div>
              ))}
              {wfAgents.length === 0 && (
                <p className="text-xs text-muted-foreground italic col-span-2 py-2">No agents linked to this workflow.</p>
              )}
            </div>
          </div>

          {/* Unlinked agents */}
          <div className="space-y-3 border-t pt-4">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              Assign Available Agents ({availableAgents.length})
            </span>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-48 overflow-y-auto">
              {availableAgents.map(agent => (
                <div key={agent.id} className="flex items-center justify-between border rounded-lg p-2.5 bg-background">
                  <div>
                    <span className="font-semibold block text-xs text-foreground leading-none">{agent.name}</span>
                    <span className="text-[9px] text-muted-foreground uppercase font-semibold mt-1.5 inline-block bg-muted/65 px-1.5 py-0.5 rounded leading-none">
                      {agent.agent_type}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onAssignAgent(agent.id, workflow.id, "link")}
                    className="h-7 px-2.5 text-[10px] gap-1"
                  >
                    <LinkIcon className="h-3 w-3" /> Link
                  </Button>
                </div>
              ))}
              {availableAgents.length === 0 && (
                <p className="text-xs text-muted-foreground italic col-span-2 py-2">All agents are linked to this workflow.</p>
              )}
            </div>
          </div>
        </JanCard>

        {/* Plugin Shortcuts Card */}
        <div className="rounded-xl border border-border bg-card p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-sm">
          <div className="space-y-0.5">
            <p className="text-xs font-semibold text-foreground">Plugin Automations & Schedules</p>
            <p className="text-xs text-muted-foreground">
              Configure Feeder RSS scraping schedules in <strong>Feeder Plugin</strong>, and Agent post generation schedules & batch size in <strong>Posts Plugin</strong>.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Link href="/agent-settings?tab=plugins-feeder">
              <Button variant="outline" size="sm" className="h-8 text-xs font-semibold">
                Feeder Schedule →
              </Button>
            </Link>
            <Link href="/agent-settings?tab=plugins-posts">
              <Button variant="outline" size="sm" className="h-8 text-xs font-semibold">
                Posts Schedule →
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
