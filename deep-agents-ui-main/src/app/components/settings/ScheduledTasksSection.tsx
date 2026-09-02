"use client";

import React, { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { JanCard, CardItem } from "@/components/settings/JanCard";
import { toast } from "sonner";
import {
  AlarmClock, Play, Pause, Trash2, Eye, Plus, Calendar, RefreshCw,
  Layers, CheckCircle2, XCircle, Loader2, Sparkles, Terminal, X,
  ExternalLink, ChevronRight, HelpCircle, Globe
} from "lucide-react";

interface ScheduledTask {
  id: string;
  name: string;
  prompt: string | null;
  skills: string[];
  model: string | null;
  provider: string | null;
  base_url: string | null;
  script: string | null;
  no_agent: boolean;
  context_from: string[];
  schedule: any;
  schedule_display: string;
  repeat_times: number | null;
  repeat_completed: number;
  enabled: boolean;
  state: string;
  paused_at: string | null;
  deliver: string;
  workdir: string | null;
  timezone: string | null;
  mount_chat: string | null;
  context_summary: string | null;
  last_run_at: string | null;
  last_run_logs: string | null;
  last_status: string | null;
  last_error: string | null;
  next_run_at: string | null;
  created_at: string;
}

interface Skill {
  skill_key: string;
  label: string;
}

interface Workflow {
  id: string;
  name: string;
}

const COMMON_TIMEZONES = [
  "UTC",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Riyadh",
  "Asia/Tehran",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Pacific/Auckland",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Europe/Istanbul",
  "Africa/Cairo",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "America/Sao_Paulo",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Mexico_City",
];

const BROWSER_TIMEZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
})();

const ALL_TIMEZONES = Array.from(new Set([BROWSER_TIMEZONE, ...COMMON_TIMEZONES].filter(Boolean))).sort();

export function ScheduledTasksSection() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [activeLogTask, setActiveLogTask] = useState<ScheduledTask | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formSchedule, setFormSchedule] = useState("every 30m");
  const [formNoAgent, setFormNoAgent] = useState(false);
  const [formPrompt, setFormPrompt] = useState("");
  const [formScript, setFormScript] = useState("");
  const [formContextFrom, setFormContextFrom] = useState<string[]>([]);
  const [formSkills, setFormSkills] = useState<string[]>([]);
  const [formWorkflowId, setFormWorkflowId] = useState("");
  const [formRepeatTimes, setFormRepeatTimes] = useState("");
  const [formModel, setFormModel] = useState("");
  const [formProvider, setFormProvider] = useState("");
  const [formWorkdir, setFormWorkdir] = useState("");
  const [formDeliver, setFormDeliver] = useState("local");
  const [formTimezone, setFormTimezone] = useState("");
  const [formContextSummary, setFormContextSummary] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Scheduler preferences (per-user, stored in agent_settings)
  const [userId, setUserId] = useState<string | null>(null);
  const [userTimezone, setUserTimezone] = useState<string>("");
  const [userTimeFormat, setUserTimeFormat] = useState<string>("locale");
  const [savingPrefs, setSavingPrefs] = useState(false);

  const fetchPrefs = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) setUserId(user.id);
      const { data } = await supabase
        .from("agent_settings")
        .select("key,value")
        .in("key", ["timezone", "time_format"]);
      const map: Record<string, string> = {};
      for (const row of data ?? []) map[row.key] = row.value ?? "";
      setUserTimezone(map["timezone"] || "");
      setUserTimeFormat(map["time_format"] || "locale");
    } catch (err) {
      console.error("Failed to load scheduler preferences:", err);
    }
  };

  const savePrefs = async (timezone: string, timeFormat: string) => {
    if (!userId) {
      toast.error("Not signed in — could not save preferences");
      return;
    }
    setSavingPrefs(true);
    try {
      const { error } = await supabase
        .from("agent_settings")
        .upsert([
          { user_id: userId, key: "timezone", value: timezone },
          { user_id: userId, key: "time_format", value: timeFormat },
        ]);
      if (error) throw error;
      setUserTimezone(timezone);
      setUserTimeFormat(timeFormat);
      toast.success("Scheduler preferences saved");
    } catch (err: any) {
      toast.error(`Failed to save preferences: ${err.message}`);
    } finally {
      setSavingPrefs(false);
    }
  };

  // Format an ISO timestamp in the user's preferred timezone + time format
  const fmtDateTime = (iso: string | null): string => {
    if (!iso) return "Never";
    try {
      const opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
      if (userTimezone) opts.timeZone = userTimezone;
      if (userTimeFormat === "12h") opts.hour12 = true;
      if (userTimeFormat === "24h") opts.hour12 = false;
      return new Intl.DateTimeFormat("en-US", opts).format(new Date(iso));
    } catch {
      return new Date(iso).toLocaleString();
    }
  };

  const fetchTasks = async () => {
    try {
      const res = await fetch("/api/scheduled-tasks");
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch (err: any) {
      console.error(err);
      toast.error(`Failed to load tasks: ${err.message}`);
    }
  };

  const fetchSkills = async () => {
    try {
      const { data, error } = await supabase
        .from("skills_library")
        .select("skill_key, label")
        .order("label", { ascending: true });
      if (error) throw error;
      setSkills(data || []);
    } catch (err: any) {
      console.error("Failed to load skills:", err);
    }
  };

  const fetchWorkflows = async () => {
    try {
      const { data, error } = await supabase
        .from("workflows")
        .select("id, name")
        .order("name", { ascending: true });
      if (error) throw error;
      setWorkflows(data || []);
    } catch (err: any) {
      console.error("Failed to load workflows:", err);
    }
  };

  useEffect(() => {
    Promise.all([fetchTasks(), fetchSkills(), fetchWorkflows(), fetchPrefs()]).finally(() => setLoading(false));
  }, []);

  // Real-time task status updates subscription
  useEffect(() => {
    const channel = supabase
      .channel("scheduled-tasks-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_scheduled_tasks" },
        () => {
          fetchTasks();
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleToggleEnable = async (task: ScheduledTask) => {
    const originalValue = task.enabled;
    const targetState = originalValue ? "paused" : "scheduled";
    
    // Optimistic UI update
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, enabled: !originalValue, state: targetState } : t));

    try {
      const res = await fetch(`/api/scheduled-tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !originalValue, state: targetState }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(originalValue ? `Paused task: ${task.name}` : `Resumed task: ${task.name}`);
    } catch (err: any) {
      // Revert
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, enabled: originalValue, state: task.state } : t));
      toast.error(`Failed to update task: ${err.message}`);
    }
  };

  const handleTriggerNow = async (task: ScheduledTask) => {
    try {
      const res = await fetch(`/api/scheduled-tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger_now: true }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(`Triggered task execution: ${task.name}`);
      fetchTasks();
    } catch (err: any) {
      toast.error(`Failed to trigger task: ${err.message}`);
    }
  };

  const handleDeleteTask = async (task: ScheduledTask) => {
    if (!confirm(`Are you sure you want to delete scheduled task "${task.name}"?`)) return;

    // Optimistic delete
    setTasks(prev => prev.filter(t => t.id !== task.id));

    try {
      const res = await fetch(`/api/scheduled-tasks/${task.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(`Deleted task: ${task.name}`);
    } catch (err: any) {
      fetchTasks(); // Reload
      toast.error(`Failed to delete task: ${err.message}`);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formSchedule) {
      toast.error("Schedule is required");
      return;
    }
    if (!formNoAgent && !formPrompt) {
      toast.error("Prompt is required for Agent tasks");
      return;
    }
    if (formNoAgent && !formScript) {
      toast.error("Script path is required for Watchdog scripts");
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        name: formName || undefined,
        schedule: formSchedule,
        no_agent: formNoAgent,
        prompt: formNoAgent ? null : formPrompt,
        script: formNoAgent ? formScript : null,
        context_from: formContextFrom.length > 0 ? formContextFrom : undefined,
        skills: formSkills.length > 0 ? formSkills : undefined,
        repeat_times: formRepeatTimes ? parseInt(formRepeatTimes, 10) : null,
        model: formModel || undefined,
        provider: formProvider || undefined,
        workdir: formWorkdir || undefined,
        deliver: formDeliver || "local",
        timezone: formTimezone || undefined,
        context_summary: formContextSummary || undefined,
        origin: formWorkflowId ? { workflow_id: formWorkflowId } : undefined,
      };

      const res = await fetch("/api/scheduled-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create task");
      }

      toast.success("Scheduled task created successfully");
      setIsCreateOpen(false);
      
      // Reset form
      setFormName("");
      setFormSchedule("every 30m");
      setFormNoAgent(false);
      setFormPrompt("");
      setFormScript("");
      setFormContextFrom([]);
      setFormSkills([]);
      setFormWorkflowId("");
      setFormRepeatTimes("");
      setFormModel("");
      setFormProvider("");
      setFormWorkdir("");
      setFormDeliver("local");
      setFormTimezone("");
      setFormContextSummary("");

      fetchTasks();
    } catch (err: any) {
      toast.error(`Create failed: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const getStatusBadge = (task: ScheduledTask) => {
    if (!task.enabled) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground border border-border">
          <Pause className="h-3 w-3" /> Paused
        </span>
      );
    }

    switch (task.state) {
      case "running":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/25">
            <Loader2 className="h-3 w-3 animate-spin" /> Running
          </span>
        );
      case "completed":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-500/10 text-purple-400 border border-purple-500/25">
            <CheckCircle2 className="h-3 w-3" /> Completed
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/25">
            <Calendar className="h-3 w-3" /> Scheduled
          </span>
        );
    }
  };

  const getResultBadge = (task: ScheduledTask) => {
    if (!task.last_run_at) return <span className="text-muted-foreground">—</span>;
    if (task.last_status === "success") {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/10">
          Success
        </span>
      );
    }
    if (task.last_status === "failed") {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/10 text-red-400 border border-red-500/10">
          Failed
        </span>
      );
    }
    return <span className="text-muted-foreground text-xs">{task.last_status || "unknown"}</span>;
  };

  const getTaskNameById = (id: string) => {
    const target = tasks.find(t => t.id === id);
    return target ? target.name : id.substring(0, 8);
  };

  return (
    <div className="space-y-6">
      {/* Header card */}
      <JanCard>
        <CardItem
          align="start"
          className="flex-col sm:flex-row gap-3"
          title={
            <span className="flex items-center gap-2">
              <AlarmClock className="h-5 w-5 text-primary" />
              Scheduled Tasks
            </span>
          }
          description="Manage scheduled background agents and scripts (Hermes Unified Scheduler replicated natively)."
          actions={
            <Button onClick={() => setIsCreateOpen(true)} className="gap-1.5 text-xs h-9">
              <Plus className="h-4 w-4" /> Create Scheduled Task
            </Button>
          }
        />
      </JanCard>

      {/* Scheduler preferences: timezone + time format */}
      <JanCard>
        <CardItem
          align="start"
          className="flex-col sm:flex-row gap-3"
          title={
            <span className="flex items-center gap-2">
              <Globe className="h-5 w-5 text-primary" />
              Scheduler Preferences
            </span>
          }
          description="When you tell the agent e.g. 'schedule this for 9pm', cron times are interpreted in your timezone. Set your native timezone below — the agent and scheduler handle the rest."
          actions={
            <Button
              size="sm"
              variant="outline"
              className="h-9 text-xs gap-1.5"
              disabled={savingPrefs}
              onClick={() => savePrefs(userTimezone, userTimeFormat)}
            >
              {savingPrefs && <Loader2 className="h-3 w-3 animate-spin" />}
              Save Preferences
            </Button>
          }
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 px-4 pb-4">
          <div className="space-y-1.5">
            <Label htmlFor="pref-timezone" className="text-xs font-semibold">Your Timezone</Label>
            <select
              id="pref-timezone"
              value={userTimezone}
              onChange={e => setUserTimezone(e.target.value)}
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Browser default ({BROWSER_TIMEZONE || "auto"}{userTimezone ? "" : " — active"})</option>
              {ALL_TIMEZONES.map(tz => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
            <p className="text-[10px] text-muted-foreground">
              {userTimezone
                ? `Active: ${userTimezone} — cron rules like '0 21 * * *' fire at 9pm in this zone.`
                : `Active: ${BROWSER_TIMEZONE || "browser locale"} (auto-detected) — set an explicit zone for server-side accuracy.`}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pref-timeformat" className="text-xs font-semibold">Time Format</Label>
            <select
              id="pref-timeformat"
              value={userTimeFormat}
              onChange={e => setUserTimeFormat(e.target.value)}
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="locale">Browser locale default</option>
              <option value="12h">12-hour (9:00 PM)</option>
              <option value="24h">24-hour (21:00)</option>
            </select>
            <p className="text-[10px] text-muted-foreground">Display only — affects how run times are shown in the task list.</p>
          </div>
        </div>
      </JanCard>

      {/* Task table / grid */}
      <JanCard className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-12 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="text-sm">Loading scheduler state...</span>
          </div>
        ) : tasks.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground flex flex-col items-center justify-center gap-2">
            <AlarmClock className="h-8 w-8 text-muted-foreground/45" />
            <p className="text-sm font-medium">No scheduled tasks yet</p>
            <p className="text-xs">Click the create button to schedule your first background task.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs font-semibold text-muted-foreground uppercase">
                <tr>
                  <th className="px-5 py-3.5">Name</th>
                  <th className="px-5 py-3.5">Schedule</th>
                  <th className="px-5 py-3.5">Type</th>
                  <th className="px-5 py-3.5">State</th>
                  <th className="px-5 py-3.5">Last Run</th>
                  <th className="px-5 py-3.5">Next Run</th>
                  <th className="px-5 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {tasks.map(task => (
                  <tr key={task.id} className="hover:bg-muted/15 transition-colors group">
                    <td className="px-5 py-4 min-w-[200px]">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-semibold text-foreground">{task.name}</span>
                        {(task.context_from && task.context_from.length > 0) && (
                          <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-1">
                            <Layers className="h-3 w-3" />
                            <span>Depends on:</span>
                            <div className="flex gap-1 flex-wrap">
                              {task.context_from.map(cid => (
                                <span key={cid} className="bg-muted px-1.5 py-0.2 rounded font-medium" title={cid}>
                                  {getTaskNameById(cid)}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {task.mount_chat && (
                          <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-1" title={`Mounted chat thread: ${task.mount_chat}`}>
                            <Globe className="h-3 w-3" />
                            <span>Chat context mounted</span>
                          </div>
                        )}
                        {task.context_summary && (
                          <div className="text-[10px] text-muted-foreground mt-1 truncate max-w-[220px]" title={task.context_summary}>
                            {task.context_summary}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-4 whitespace-nowrap">
                      <span className="font-medium text-xs font-mono">{task.schedule_display}</span>
                      {task.timezone && (
                        <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1" title="Task timezone">
                          <Globe className="h-3 w-3" /> {task.timezone}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-4 whitespace-nowrap">
                      {task.no_agent ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/10">
                          <Terminal className="h-3 w-3" /> Watchdog
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-violet-500/10 text-violet-400 border border-violet-500/10">
                          <Sparkles className="h-3 w-3" /> Agent
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4 whitespace-nowrap">
                      {getStatusBadge(task)}
                    </td>
                    <td className="px-5 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {getResultBadge(task)}
                        {task.last_run_at && (
                          <span className="text-xs text-muted-foreground">
                            {fmtDateTime(task.last_run_at)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-4 whitespace-nowrap text-xs text-muted-foreground">
                      {fmtDateTime(task.next_run_at)}
                    </td>
                    <td className="px-5 py-4 whitespace-nowrap text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {task.last_run_logs && (
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setActiveLogTask(task)}
                            className="h-8 w-8 hover:bg-muted-foreground/10 text-muted-foreground hover:text-foreground"
                            title="View logs / response"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleTriggerNow(task)}
                          disabled={!task.enabled || task.state === "running"}
                          className="h-8 w-8 hover:bg-muted-foreground/10 text-muted-foreground hover:text-foreground disabled:opacity-40"
                          title="Run now"
                        >
                          <Play className="h-4 w-4" />
                        </Button>
                        <Switch
                          checked={task.enabled}
                          onCheckedChange={() => handleToggleEnable(task)}
                          className="scale-90"
                          title={task.enabled ? "Pause" : "Resume"}
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleDeleteTask(task)}
                          className="h-8 w-8 hover:bg-destructive/15 text-muted-foreground hover:text-destructive"
                          title="Delete scheduled task"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </JanCard>

      {/* Modal: View log / response */}
      {activeLogTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="relative w-full max-w-2xl bg-card border rounded-xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden animate-in zoom-in-95 duration-200">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <div>
                <h3 className="font-semibold text-sm">{activeLogTask.name} — Logs</h3>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Last ran: {fmtDateTime(activeLogTask.last_run_at)}
                </p>
              </div>
              <button
                onClick={() => setActiveLogTask(null)}
                className="h-8 w-8 rounded-lg hover:bg-muted/80 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* Content */}
            <div className="flex-1 overflow-auto p-5 font-mono text-xs bg-muted/40 leading-relaxed scrollbar-pretty select-text">
              {activeLogTask.last_error && (
                <div className="mb-4 p-3 border border-red-500/20 bg-red-500/5 rounded-lg text-red-400">
                  <p className="font-bold flex items-center gap-1.5">
                    <XCircle className="h-4 w-4" /> Error Description:
                  </p>
                  <p className="mt-1">{activeLogTask.last_error}</p>
                </div>
              )}
              <div className="whitespace-pre-wrap rounded-lg border bg-background/50 p-4 border-border overflow-auto max-h-[50vh]">
                {activeLogTask.last_run_logs || "No logs available."}
              </div>
            </div>
            {/* Footer */}
            <div className="flex justify-end gap-2 px-5 py-3 border-t bg-muted/20 shrink-0">
              <Button size="sm" variant="outline" onClick={() => setActiveLogTask(null)} className="h-8 text-xs font-semibold">
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Sidepanel/Modal: Create scheduled task */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="relative w-full max-w-lg bg-card border rounded-xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden animate-in zoom-in-95 duration-200">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <div className="flex items-center gap-2">
                <AlarmClock className="h-4 w-4 text-primary" />
                <h3 className="font-semibold text-sm">Create Background Task</h3>
              </div>
              <button
                onClick={() => setIsCreateOpen(false)}
                className="h-8 w-8 rounded-lg hover:bg-muted/80 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* Form */}
            <form onSubmit={handleCreateSubmit} className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* Name */}
              <div className="space-y-1.5">
                <Label htmlFor="task-name" className="text-xs font-semibold">Task Name</Label>
                <Input
                  id="task-name"
                  placeholder="e.g. Weather Poem Watcher (optional)"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>

              {/* Schedule */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="task-schedule" className="text-xs font-semibold">Schedule Rule</Label>
                  <span className="text-[10px] text-muted-foreground flex items-center gap-0.5" title="Time today: '15:40' or '3:40 PM' (anchored to today's date) · Tomorrow: 'tomorrow at 9am' · Weekday: 'friday at 18:00' · Duration: '30m' (once in 30 min) · Interval: 'every 2h' (recurring) · Cron: '0 21 * * *' · Explicit date: '2026-07-06T21:00:00'">
                    <HelpCircle className="h-3 w-3" /> Formats
                  </span>
                </div>
                <Input
                  id="task-schedule"
                  placeholder="e.g. 15:40 (today), tomorrow at 9am, every 30m, 0 21 * * *"
                  value={formSchedule}
                  onChange={e => setFormSchedule(e.target.value)}
                  className="h-9 text-xs font-mono"
                  required
                />
              </div>

              {/* Timezone override */}
              <div className="space-y-1.5">
                <Label htmlFor="task-timezone" className="text-xs font-semibold">Timezone (optional)</Label>
                <select
                  id="task-timezone"
                  value={formTimezone}
                  onChange={e => setFormTimezone(e.target.value)}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="">
                    {userTimezone
                      ? `My saved timezone (${userTimezone})`
                      : `Browser default (${BROWSER_TIMEZONE || "auto"})`}
                  </option>
                  {ALL_TIMEZONES.map(tz => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
                <p className="text-[10px] text-muted-foreground">Cron and timestamp schedules are evaluated in this timezone.</p>
              </div>

              {/* Workflow selection */}
              {workflows.length > 0 && !formNoAgent && (
                <div className="space-y-1.5">
                  <Label htmlFor="task-workflow" className="text-xs font-semibold">Execute under Workflow Agent</Label>
                  <select
                    id="task-workflow"
                    value={formWorkflowId}
                    onChange={e => setFormWorkflowId(e.target.value)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="">Default Workflow (Fallback)</option>
                    {workflows.map(wf => (
                      <option key={wf.id} value={wf.id}>{wf.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Type toggle */}
              <div className="flex items-center justify-between p-3 rounded-lg border border-border/40 bg-muted/20">
                <div className="space-y-0.5">
                  <Label className="text-xs font-semibold">Script Watchdog Mode</Label>
                  <p className="text-[10px] text-muted-foreground leading-tight">Run a local script instead of compiling an LLM agent.</p>
                </div>
                <Switch
                  checked={formNoAgent}
                  onCheckedChange={setFormNoAgent}
                />
              </div>

              {/* Prompt (conditional) */}
              {!formNoAgent ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="task-prompt" className="text-xs font-semibold">Agent Instruction Prompt</Label>
                    <Textarea
                      id="task-prompt"
                      placeholder="Provide specific instruction for the agent background run. Write blog post, check stats, etc..."
                      value={formPrompt}
                      onChange={e => setFormPrompt(e.target.value)}
                      rows={4}
                      className="text-xs"
                      required={!formNoAgent}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="task-summary" className="text-xs font-semibold">Task Background (optional)</Label>
                    <Textarea
                      id="task-summary"
                      placeholder="Why does this task exist? Goals, context, preferences — injected into every run so the agent understands intent."
                      value={formContextSummary}
                      onChange={e => setFormContextSummary(e.target.value)}
                      rows={2}
                      className="text-xs"
                    />
                  </div>
                </>
              ) : (
                /* Script path (conditional) */
                <div className="space-y-1.5">
                  <Label htmlFor="task-script" className="text-xs font-semibold">Watchdog Script Path</Label>
                  <Input
                    id="task-script"
                    placeholder="e.g. scripts/check_disk.py"
                    value={formScript}
                    onChange={e => setFormScript(e.target.value)}
                    className="h-9 text-xs font-mono"
                    required={formNoAgent}
                  />
                </div>
              )}

              {/* Context Chain (context_from) */}
              {tasks.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Depends on (Upstream Context Chain)</Label>
                  <p className="text-[10px] text-muted-foreground -mt-1 leading-tight">Injects logs from the selected task run into this task's context window.</p>
                  <div className="grid grid-cols-2 gap-2 border rounded-lg p-2 max-h-32 overflow-y-auto">
                    {tasks.map(t => (
                      <label key={t.id} className="flex items-center gap-2 p-1 hover:bg-muted/30 rounded text-xs select-none cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formContextFrom.includes(t.id)}
                          onChange={e => {
                            if (e.target.checked) {
                              setFormContextFrom(prev => [...prev, t.id]);
                            } else {
                              setFormContextFrom(prev => prev.filter(id => id !== t.id));
                            }
                          }}
                          className="rounded border-border scale-90"
                        />
                        <span className="truncate font-medium">{t.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Skills selection */}
              {skills.length > 0 && !formNoAgent && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Load Skills</Label>
                  <div className="grid grid-cols-2 gap-2 border rounded-lg p-2 max-h-32 overflow-y-auto">
                    {skills.map(s => (
                      <label key={s.skill_key} className="flex items-center gap-2 p-1 hover:bg-muted/30 rounded text-xs select-none cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formSkills.includes(s.skill_key)}
                          onChange={e => {
                            if (e.target.checked) {
                              setFormSkills(prev => [...prev, s.skill_key]);
                            } else {
                              setFormSkills(prev => prev.filter(sk => sk !== s.skill_key));
                            }
                          }}
                          className="rounded border-border scale-90"
                        />
                        <span className="truncate font-medium">{s.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Advanced collapsable section */}
              <details className="group border rounded-lg overflow-hidden">
                <summary className="flex items-center justify-between p-3 bg-muted/20 text-xs font-semibold cursor-pointer select-none">
                  <span>Advanced Parameters</span>
                  <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90 text-muted-foreground" />
                </summary>
                <div className="p-4 space-y-3 border-t group-open:block hidden bg-card">
                  {/* Repeat times */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="task-repeat" className="text-[10px] font-semibold uppercase">Repeat Times</Label>
                      <Input
                        id="task-repeat"
                        type="number"
                        placeholder="Infinite (null)"
                        value={formRepeatTimes}
                        onChange={e => setFormRepeatTimes(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    {/* Deliver target */}
                    <div className="space-y-1.5">
                      <Label htmlFor="task-deliver" className="text-[10px] font-semibold uppercase">Output Delivery</Label>
                      <select
                        id="task-deliver"
                        value={formDeliver}
                        onChange={e => setFormDeliver(e.target.value)}
                        className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="local">Local Logs</option>
                        <option value="origin">Origin Chat Thread</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {/* Model override */}
                    <div className="space-y-1.5">
                      <Label htmlFor="task-model" className="text-[10px] font-semibold uppercase">Model Override</Label>
                      <Input
                        id="task-model"
                        placeholder="e.g. mimo-v2.5"
                        value={formModel}
                        onChange={e => setFormModel(e.target.value)}
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                    {/* Provider override */}
                    <div className="space-y-1.5">
                      <Label htmlFor="task-provider" className="text-[10px] font-semibold uppercase">Provider Override</Label>
                      <Input
                        id="task-provider"
                        placeholder="e.g. openrouter"
                        value={formProvider}
                        onChange={e => setFormProvider(e.target.value)}
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                  </div>

                  {/* Workdir */}
                  <div className="space-y-1.5">
                    <Label htmlFor="task-workdir" className="text-[10px] font-semibold uppercase">Working Directory</Label>
                    <Input
                      id="task-workdir"
                      placeholder="e.g. c:/Users/kashif/workspace"
                      value={formWorkdir}
                      onChange={e => setFormWorkdir(e.target.value)}
                      className="h-8 text-xs font-mono"
                    />
                  </div>
                </div>
              </details>
            </form>
            {/* Footer */}
            <div className="flex justify-end gap-2 px-5 py-3 border-t bg-muted/20 shrink-0">
              <Button size="sm" variant="outline" onClick={() => setIsCreateOpen(false)} className="h-8 text-xs font-semibold">
                Cancel
              </Button>
              <Button size="sm" type="button" onClick={handleCreateSubmit} disabled={submitting} className="h-8 text-xs font-semibold gap-1.5">
                {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
                {submitting ? "Scheduling..." : "Create Task"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
