"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Plus, Trash2, Save, Loader2, CheckCircle2,
  ListTodo, Play, Settings2, ShieldCheck, HelpCircle,
  Link, Unlink, RefreshCw
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

export function WorkflowsSection() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  // New Workflow Form
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newInterval, setNewInterval] = useState(30);
  const [newBatchSize, setNewBatchSize] = useState(2);

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
    if (newInterval < 1) {
      alert("Interval must be at least 1 minute.");
      return;
    }
    if (newBatchSize < 1) {
      alert("Batch size must be at least 1.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          description: newDescription,
          interval_minutes: newInterval,
          batch_size: newBatchSize,
          enabled: true
        })
      });
      if (res.ok) {
        setNewName("");
        setNewDescription("");
        setNewInterval(30);
        setNewBatchSize(2);
        setShowCreateForm(false);
        fetchData();
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



  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Settings2 className="h-5 w-5 text-primary" /> Workflows Settings
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Configure isolated workflow pipelines, each with its own Main Agent, Subagents, and Cron schedule.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreateForm(!showCreateForm)} className="gap-1.5">
          <Plus className="h-4 w-4" /> Create Workflow
        </Button>
      </div>

      {showCreateForm && (
        <div className="rounded-xl border bg-muted/10 p-5 space-y-4 shadow-inner">
          <h3 className="text-sm font-semibold">New Workflow Pipeline</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-semibold text-muted-foreground mb-1 block">Workflow Name</label>
              <Input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Finance Agent System"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground mb-1 block">Description</label>
              <Input
                value={newDescription}
                onChange={e => setNewDescription(e.target.value)}
                placeholder="Brief description of this workflow's role"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground mb-1 block">Scrape/Trigger Interval</label>
              {(() => {
                const presets = [15, 30, 60, 120, 240];
                const isCustom = !presets.includes(newInterval);
                return (
                  <div className="space-y-1.5">
                    <select
                      value={isCustom ? "custom" : newInterval}
                      onChange={e => {
                        const val = e.target.value;
                        if (val === "custom") {
                          setNewInterval(5);
                        } else {
                          setNewInterval(Number(val));
                        }
                      }}
                      className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      <option value={15}>Every 15 minutes</option>
                      <option value={30}>Every 30 minutes</option>
                      <option value={60}>Every 1 hour</option>
                      <option value={120}>Every 2 hours</option>
                      <option value={240}>Every 4 hours</option>
                      <option value="custom">Custom...</option>
                    </select>
                    {isCustom && (
                      <div className="flex items-center gap-1.5 mt-1">
                        <Input
                          type="number"
                          min={1}
                          value={newInterval}
                          onChange={e => setNewInterval(Number(e.target.value))}
                          className="h-9 text-sm font-semibold w-24"
                        />
                        <span className="text-xs text-muted-foreground font-semibold">minutes</span>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground mb-1 block">Batch Size (Pending Articles)</label>
              <Input
                type="number"
                min={1}
                max={10}
                value={newBatchSize}
                onChange={e => setNewBatchSize(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleCreateWorkflow} disabled={creating || !newName.trim()} className="gap-1.5">
              {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowCreateForm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6">
        {workflows.map(wf => {
          const wfAgents = agents.filter(a => {
            const wfs = (a.workflow_agent_assignments ?? []).map((w: any) => w.workflow_id);
            if (a.workflow_id && !wfs.includes(a.workflow_id)) wfs.push(a.workflow_id);
            return wfs.includes(wf.id);
          });
          const availableAgents = agents.filter(a => {
            const wfs = (a.workflow_agent_assignments ?? []).map((w: any) => w.workflow_id);
            if (a.workflow_id && !wfs.includes(a.workflow_id)) wfs.push(a.workflow_id);
            return !wfs.includes(wf.id);
          });
          const hasMain = wfAgents.some(a => a.agent_type === "main");
          const isSaving = savingId === wf.id;

          return (
            <div key={wf.id} className="rounded-xl border bg-card shadow-sm overflow-hidden flex flex-col">
              {/* Header */}
              <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 border-b bg-muted/10">
                <div className="flex-1 min-w-0">
                  <DelayedInput
                    value={wf.name}
                    onChange={val => handleUpdateWorkflow(wf.id, { name: val })}
                    className="h-8 text-base font-semibold bg-transparent border-0 p-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:bg-background/20 rounded px-1.5"
                  />
                  <DelayedInput
                    value={wf.description}
                    onChange={val => handleUpdateWorkflow(wf.id, { description: val })}
                    placeholder="No description set"
                    className="h-6 text-xs text-muted-foreground bg-transparent border-0 p-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:bg-background/20 rounded px-1.5 mt-0.5"
                  />
                </div>
                <div className="flex items-center gap-3">
                  {isSaving && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                  <div className="flex items-center gap-2 border rounded-full px-2.5 py-1 bg-background/50 text-xs">
                    <span className="font-semibold text-muted-foreground">Agent Scheduler:</span>
                    <button
                      onClick={() => handleUpdateWorkflow(wf.id, { enabled: !wf.enabled })}
                      className={`relative inline-flex w-9 h-5 items-center rounded-full transition-colors ${wf.enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
                    >
                      <span className={`inline-block w-4 h-4 bg-white rounded-full shadow transform transition-transform ${wf.enabled ? "translate-x-[18px]" : "translate-x-[2px]"}`} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2 border rounded-full px-2.5 py-1 bg-background/50 text-xs">
                    <span className="font-semibold text-muted-foreground">Feeder Scheduler:</span>
                    <button
                      onClick={() => handleUpdateWorkflow(wf.id, { feeder_enabled: !wf.feeder_enabled })}
                      className={`relative inline-flex w-9 h-5 items-center rounded-full transition-colors ${wf.feeder_enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
                    >
                      <span className={`inline-block w-4 h-4 bg-white rounded-full shadow transform transition-transform ${wf.feeder_enabled ? "translate-x-[18px]" : "translate-x-[2px]"}`} />
                    </button>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDeleteWorkflow(wf.id)}
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Settings Row */}
              <div className="px-6 py-4 border-b grid grid-cols-1 md:grid-cols-4 gap-4 bg-muted/5">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground mb-1 block">Agent Interval</label>
                  {(() => {
                    const presets = [15, 30, 60, 120, 240];
                    const isCustom = !presets.includes(wf.interval_minutes);
                    return (
                      <div className="space-y-1">
                        <select
                          value={isCustom ? "custom" : wf.interval_minutes}
                          onChange={e => {
                            const val = e.target.value;
                            if (val === "custom") {
                              handleUpdateWorkflow(wf.id, { interval_minutes: 5 });
                            } else {
                              handleUpdateWorkflow(wf.id, { interval_minutes: Number(val) });
                            }
                          }}
                          className="w-full h-8 rounded-md border bg-background px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                          <option value={15}>Every 15 minutes</option>
                          <option value={30}>Every 30 minutes</option>
                          <option value={60}>Every 1 hour</option>
                          <option value={120}>Every 2 hours</option>
                          <option value={240}>Every 4 hours</option>
                          <option value="custom">Custom...</option>
                        </select>
                        {isCustom && (
                          <div className="flex items-center gap-1.5 mt-1">
                            <DelayedNumberInput
                              min={1}
                              value={wf.interval_minutes}
                              onChange={val => handleUpdateWorkflow(wf.id, { interval_minutes: val })}
                              className="h-8 text-xs font-semibold w-20"
                            />
                            <span className="text-[10px] text-muted-foreground font-semibold">minutes</span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground mb-1 block">Feeder Interval</label>
                  {(() => {
                    const presets = [10, 15, 30, 60, 120, 240];
                    const isCustom = !presets.includes(wf.feeder_interval_minutes ?? 30);
                    return (
                      <div className="space-y-1">
                        <select
                          value={isCustom ? "custom" : (wf.feeder_interval_minutes ?? 30)}
                          onChange={e => {
                            const val = e.target.value;
                            if (val === "custom") {
                              handleUpdateWorkflow(wf.id, { feeder_interval_minutes: 5 });
                            } else {
                              handleUpdateWorkflow(wf.id, { feeder_interval_minutes: Number(val) });
                            }
                          }}
                          className="w-full h-8 rounded-md border bg-background px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                          <option value={10}>Every 10 minutes</option>
                          <option value={15}>Every 15 minutes</option>
                          <option value={30}>Every 30 minutes</option>
                          <option value={60}>Every 1 hour</option>
                          <option value={120}>Every 2 hours</option>
                          <option value={240}>Every 4 hours</option>
                          <option value="custom">Custom...</option>
                        </select>
                        {isCustom && (
                          <div className="flex items-center gap-1.5 mt-1">
                            <DelayedNumberInput
                              min={1}
                              value={wf.feeder_interval_minutes ?? 30}
                              onChange={val => handleUpdateWorkflow(wf.id, { feeder_interval_minutes: val })}
                              className="h-8 text-xs font-semibold w-20"
                            />
                            <span className="text-[10px] text-muted-foreground font-semibold">minutes</span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground mb-1 block">Batch Size (Articles)</label>
                  <DelayedNumberInput
                    min={1}
                    value={wf.batch_size}
                    onChange={val => handleUpdateWorkflow(wf.id, { batch_size: val })}
                    className="h-8 text-xs font-semibold"
                  />
                </div>
                <div className="flex flex-col justify-center gap-0.5">
                  <span className="text-xs font-semibold text-muted-foreground block">Last Run Status</span>
                  <span className="text-[10px] font-mono block leading-none">
                    <strong>Agent:</strong> {wf.last_trigger_at ? new Date(wf.last_trigger_at).toLocaleString() : "Never"}
                  </span>
                  <span className="text-[10px] font-mono block leading-none mt-1">
                    <strong>Feeder:</strong> {wf.feeder_last_trigger_at ? new Date(wf.feeder_last_trigger_at).toLocaleString() : "Never"}
                  </span>
                </div>
              </div>

              {/* Agent Association */}
              <div className="p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Associated Agents</h4>
                  {!hasMain && (
                    <span className="text-[10px] text-destructive bg-destructive/5 border border-destructive/20 rounded-full px-2 py-0.5 font-medium flex items-center gap-1">
                      ⚠️ No Main Agent Assigned (Workflow will not run)
                    </span>
                  )}
                </div>

                {wfAgents.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No agents associated. Assign agents below.</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {wfAgents.map(agent => (
                      <div key={agent.id} className="flex items-center justify-between border rounded-lg p-2.5 bg-background shadow-sm">
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${agent.agent_type === "main" ? "bg-primary/10 text-primary border border-primary/20" : "bg-muted text-muted-foreground"}`}>
                            {agent.agent_type === "main" ? "Main" : "Subagent"}
                          </span>
                          <span className="text-xs font-medium">{agent.name}</span>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleAssignAgent(agent.id, wf.id, "unlink")}
                          className="h-7 px-2 text-[10px] text-muted-foreground hover:text-destructive flex items-center gap-1"
                        >
                          <Unlink className="h-3 w-3" /> Unlink
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Available unassigned agents */}
                {availableAgents.length > 0 && (
                  <div className="border-t pt-4">
                    <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-2">
                      Assign Unlinked Agents
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {availableAgents.map(agent => (
                        <button
                          key={agent.id}
                          onClick={() => handleAssignAgent(agent.id, wf.id, "link")}
                          className="flex items-center gap-1.5 border hover:border-primary hover:bg-primary/5 rounded-full px-3 py-1 text-xs font-medium transition-all"
                        >
                          <Link className="h-3 w-3 text-muted-foreground" />
                          <span>{agent.name}</span>
                          <span className="text-[9px] text-muted-foreground">({agent.agent_type})</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {workflows.length === 0 && (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <ListTodo className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground mb-1">No workflows yet</p>
          <p className="text-xs text-muted-foreground mb-4">Create your first workflow to orchestrate a pipeline.</p>
          <Button size="sm" onClick={() => setShowCreateForm(true)} className="gap-1.5 text-xs">
            <Plus className="h-3.5 w-3.5" /> Create Workflow
          </Button>
        </div>
      )}
    </div>
  );
}
