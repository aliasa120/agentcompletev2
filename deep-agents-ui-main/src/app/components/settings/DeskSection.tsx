"use client";

/**
 * DeskSection — the user's Desk (Add to Desk).
 *
 * Task cards deposited by agents via the `add_to_desk` tool. Each card shows:
 *   - Task details: title, summary, and the user prompt that initiated it
 *   - Editable argument fields (text/textarea/number/select/readonly)
 *   - Files the agent produced for the task (thread workspace attachments)
 *   - Execute buttons (bound to tool schemas) + Reject Task
 *
 * Execute = one click: the saved tool call runs deterministically (no LLM,
 * no mid-chat approval). Reject = the card and its files are deleted.
 * Live updates arrive over Supabase realtime.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Inbox, Send, Loader2, CheckCircle2, AlertTriangle,
  Clock, FileText, RefreshCw, ChevronDown, ChevronRight, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

interface DeskField {
  name: string;
  label?: string;
  type?: "text" | "textarea" | "number" | "select" | "readonly";
  value?: any;
  required?: boolean;
  options?: string[];
  arg_key?: string;
  help?: string;
}

interface DeskButton {
  id: string;
  label: string;
  kind: "execute" | "cancel";
  style?: string;
  description?: string;
  tool_name?: string;
  tool_type?: string;
  args?: Record<string, any>;
}

interface DeskFile {
  path: string;
  name: string;
  kind?: string;
}

interface DeskTask {
  id: string;
  title: string;
  summary?: string | null;
  user_prompt?: string | null;
  status: "pending" | "executing" | "done" | "failed";
  fields: DeskField[];
  buttons: DeskButton[];
  files: DeskFile[];
  thread_id: string;
  result?: string | null;
  error?: string | null;
  executed_at?: string | null;
  created_at: string;
}

type StatusFilter = "pending" | "executing" | "done" | "failed";

const STATUS_TABS: { id: StatusFilter; label: string }[] = [
  { id: "pending", label: "Waiting" },
  { id: "executing", label: "Running" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" },
];

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  executing: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  done: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  failed: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
        STATUS_STYLES[status] ?? STATUS_STYLES.pending
      )}
    >
      {status === "executing" && <Loader2 size={11} className="animate-spin" />}
      {status === "pending" && <Clock size={11} />}
      {status === "done" && <CheckCircle2 size={11} />}
      {status === "failed" && <AlertTriangle size={11} />}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function fileUrl(threadId: string, path: string, download = false) {
  return `/api/thread-files/content?threadId=${encodeURIComponent(threadId)}&path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
}

function DeskTaskCard({
  task,
  onRefresh,
}: {
  task: DeskTask;
  onRefresh: () => void;
}) {
  const [values, setValues] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [showResult, setShowResult] = useState(false);
  const initialized = useRef(false);

  // Initialize (and re-initialize when the card resets to pending) field values.
  useEffect(() => {
    const next: Record<string, any> = {};
    for (const f of task.fields ?? []) {
      next[f.name] = f.value ?? "";
    }
    setValues(next);
    initialized.current = true;
  }, [task.id, task.status === "pending"]); // eslint-disable-line react-hooks/exhaustive-deps

  const editable = task.status === "pending" || task.status === "failed";
  const executeButtons = (task.buttons ?? []).filter(
    (b) => (b.kind ?? "execute") === "execute" && b.tool_name
  );

  const setField = (name: string, v: any) =>
    setValues((prev) => ({ ...prev, [name]: v }));

  const handleExecute = async (button: DeskButton) => {
    setBusy(button.id);
    try {
      const res = await fetch(`/api/desk/${task.id}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ button_id: button.id, values }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data?.error || "Execution failed to start.");
        return;
      }
      onRefresh();
    } catch (e: any) {
      alert("Execution failed: " + (e?.message ?? "unknown error"));
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async () => {
    if (
      !confirm(
        `Reject "${task.title}"?\n\nThe task card will be deleted along with its files (${(task.files ?? []).length}). This cannot be undone.`
      )
    ) {
      return;
    }
    setBusy("reject");
    try {
      const res = await fetch(`/api/desk/${task.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        alert(data?.error || "Failed to reject task.");
        return;
      }
      onRefresh();
    } catch (e: any) {
      alert("Failed to reject task: " + (e?.message ?? "unknown error"));
    } finally {
      setBusy(null);
    }
  };

  const handleRetry = async () => {
    setBusy("retry");
    try {
      const res = await fetch(`/api/desk/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "pending" }),
      });
      if (res.ok) onRefresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="w-full rounded-xl border border-border bg-background p-4 shadow-sm space-y-4">
      {/* ── Header: title + status ─────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground truncate">
              {task.title}
            </span>
            <StatusBadge status={task.status} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Created {new Date(task.created_at).toLocaleString()}
          </p>
        </div>
      </div>

      {/* ── Task details: how the task was initiated ───────────────────── */}
      {(task.user_prompt || task.summary) && (
        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/30 p-3">
          {task.user_prompt && (
            <div className="space-y-0.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Requested by you
              </p>
              <p className="text-xs italic text-foreground/90 line-clamp-4">
                &ldquo;{task.user_prompt}&rdquo;
              </p>
            </div>
          )}
          {task.summary && (
            <div className="space-y-0.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Agent summary
              </p>
              <p className="text-xs text-foreground/90 whitespace-pre-wrap line-clamp-6">
                {task.summary}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Files produced for this task ───────────────────────────────── */}
      {(task.files ?? []).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {task.files.map((f) => (
            <a
              key={f.path}
              href={fileUrl(task.thread_id, f.path)}
              target="_blank"
              rel="noreferrer"
              title={f.path}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-foreground hover:bg-accent transition-colors"
            >
              <FileText size={13} className="text-muted-foreground shrink-0" />
              <span className="truncate max-w-[180px]">{f.name}</span>
              <a
                href={fileUrl(task.thread_id, f.path, true)}
                onClick={(e) => e.stopPropagation()}
                className="text-[10px] text-muted-foreground hover:text-foreground underline"
              >
                download
              </a>
            </a>
          ))}
        </div>
      )}

      {/* ── Editable arguments ─────────────────────────────────────────── */}
      {(task.fields ?? []).length > 0 && (
        <div className="space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Arguments {editable ? "(editable)" : ""}
          </p>
          {task.fields.map((f) => {
            const fieldId = `desk-${task.id}-${f.name}`;
            const val = values[f.name] ?? "";
            return (
              <div key={f.name} className="space-y-1.5">
                <Label htmlFor={fieldId} className="text-xs font-medium">
                  {f.label || f.name}
                  {f.required && <span className="text-red-500 ml-0.5">*</span>}
                </Label>
                {f.type === "textarea" ? (
                  <Textarea
                    id={fieldId}
                    value={val}
                    rows={Math.min(10, Math.max(3, Math.ceil(String(val).length / 90)))}
                    disabled={!editable}
                    onChange={(e) => setField(f.name, e.target.value)}
                    className="text-xs"
                  />
                ) : f.type === "select" ? (
                  <select
                    id={fieldId}
                    value={val}
                    disabled={!editable}
                    onChange={(e) => setField(f.name, e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {(f.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : f.type === "readonly" ? (
                  <div className="rounded-md border border-border/60 bg-muted/40 p-2 text-xs text-foreground/80 whitespace-pre-wrap max-h-40 overflow-y-auto">
                    {String(val)}
                  </div>
                ) : (
                  <Input
                    id={fieldId}
                    type={f.type === "number" ? "number" : "text"}
                    value={val}
                    disabled={!editable}
                    onChange={(e) => setField(f.name, e.target.value)}
                    className="text-xs h-9"
                  />
                )}
                {f.help && (
                  <p className="text-[10px] text-muted-foreground">{f.help}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Result / error ─────────────────────────────────────────────── */}
      {(task.status === "done" || task.status === "failed") && (
        <div>
          <button
            onClick={() => setShowResult((s) => !s)}
            className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {showResult ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {task.status === "done" ? "Execution result" : "Error details"}
          </button>
          {showResult && (
            <div
              className={cn(
                "mt-2 rounded-md border p-3 text-xs whitespace-pre-wrap max-h-56 overflow-y-auto font-mono",
                task.status === "failed"
                  ? "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300"
                  : "border-border bg-muted/30 text-foreground/90"
              )}
            >
              {task.status === "failed" ? task.error || "Unknown error" : task.result || "(no output)"}
              {task.executed_at && (
                <span className="block mt-2 text-[10px] text-muted-foreground">
                  Executed {new Date(task.executed_at).toLocaleString()}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Buttons: do the task or reject it ──────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/60">
        {task.status === "executing" ? (
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground py-1">
            <Loader2 size={14} className="animate-spin" />
            Executing {executeButtons[0]?.tool_name ? `via ${executeButtons[0].tool_name}` : ""}…
          </span>
        ) : (
          <>
            {executeButtons.map((b) => (
              <Button
                key={b.id}
                size="sm"
                disabled={!editable || busy !== null}
                onClick={() => handleExecute(b)}
                className={cn(
                  "h-9 gap-1.5 text-xs font-semibold",
                  b.style === "primary" || b === executeButtons[0]
                    ? ""
                    : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                )}
              >
                {busy === b.id ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Send size={13} />
                )}
                {b.label}
              </Button>
            ))}

            {task.status === "failed" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={handleRetry}
                className="h-9 gap-1.5 text-xs"
              >
                {busy === "retry" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <RefreshCw size={13} />
                )}
                Reset card
              </Button>
            )}

            {(task.status === "pending" || task.status === "failed") && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={handleReject}
                className="h-9 gap-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
              >
                {busy === "reject" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <XCircle size={13} />
                )}
                Reject Task
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function DeskSection() {
  const [status, setStatus] = useState<StatusFilter>("pending");
  const [tasks, setTasks] = useState<DeskTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch(`/api/desk?status=${status}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Failed to load desk tasks.");
        return;
      }
      setError(null);
      setTasks(data.tasks ?? []);
    } catch (e: any) {
      setError("Failed to load desk tasks: " + (e?.message ?? "unknown"));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    setLoading(true);
    fetchTasks();
  }, [fetchTasks]);

  // Live updates while the agent deposits cards or execution finishes.
  useEffect(() => {
    const channel = supabase
      .channel("desk-tasks-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "desk_tasks" },
        () => fetchTasks()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchTasks]);

  // Fallback polling while something is executing (in case realtime is quiet).
  useEffect(() => {
    if (!tasks.some((t) => t.status === "executing")) return;
    const interval = setInterval(fetchTasks, 5000);
    return () => clearInterval(interval);
  }, [tasks, fetchTasks]);

  const pendingCount = tasks.filter((t) => t.status === "pending").length;

  return (
    <div className="space-y-5">
      {/* ── Section header ─────────────────────────────────────────────── */}
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-primary/10 p-2">
          <Inbox className="h-5 w-5 text-primary" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-foreground">Desk</h2>
          <p className="text-sm text-muted-foreground">
            Tasks your agent prepared and parked here for one-click execution.
            Review the details, edit the arguments, then run the action — or
            reject it (the card and its files are deleted).
          </p>
        </div>
      </div>

      {/* ── Status tabs ────────────────────────────────────────────────── */}
      <div className="flex gap-1.5 flex-wrap">
        {STATUS_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setStatus(t.id)}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
              status === t.id
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/70"
            )}
          >
            {t.label}
          </button>
        ))}
        {status === "pending" && pendingCount > 0 && (
          <span className="inline-flex items-center rounded-full bg-amber-500/10 border border-amber-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
            {pendingCount} waiting
          </span>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-600 dark:text-red-400">
          <AlertTriangle size={14} className="shrink-0" />
          {error}
        </div>
      )}

      {/* ── Task cards ─────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <Inbox className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium text-muted-foreground">
            {status === "pending"
              ? "Your desk is empty"
              : `No ${STATUS_TABS.find((t) => t.id === status)?.label.toLowerCase()} tasks`}
          </p>
          <p className="max-w-md text-xs text-muted-foreground/70">
            {status === "pending"
              ? 'Ask the agent to "add it to my desk" for anything with real-world side effects — emails, publishing, sends. Prepared task cards will appear here.'
              : "Tasks will appear here as their status changes."}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {tasks.map((task) => (
            <DeskTaskCard key={task.id} task={task} onRefresh={fetchTasks} />
          ))}
        </div>
      )}
    </div>
  );
}
