"use client";

/**
 * ToolApprovalInterruptList — human-in-the-loop approval cards for LangGraph
 * interrupts emitted by the backend (Deep Agents HumanInTheLoop middleware or
 * dynamic tools). Supports single tool calls and batched multiple tool calls
 * (action_requests: [...]), argument editing, always-allow persistence, and denial.
 */

import { useState, useMemo, useEffect, type FC } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AlertCircle, Check, X, Pencil, TerminalSquare, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLangGraphRuntime } from "@/providers/LangGraphRuntimeProvider";

interface ActionRequest {
  name: string;
  args: Record<string, unknown>;
  description?: string;
}

interface BatchPayload {
  actionRequests: ActionRequest[];
  allowedDecisions: string[];
}

function getBatchPayload(interrupt: any): BatchPayload | null {
  const v = interrupt?.value ?? interrupt;
  if (!v || typeof v !== "object") return null;

  const reqs = v.action_requests ?? v.actionRequests ?? [];
  const cfgs = v.review_configs ?? v.reviewConfigs ?? [];

  if (Array.isArray(reqs) && reqs.length > 0) {
    const actionRequests: ActionRequest[] = reqs.map((r: any) => ({
      name: r.name || r.tool_name || "tool",
      args: r.args ?? r.arguments ?? {},
      description: r.description,
    }));

    const cfg = Array.isArray(cfgs) && cfgs.length > 0 ? cfgs[0] : undefined;
    const allowedDecisions = cfg?.allowed_decisions ?? cfg?.allowedDecisions ?? ["approve", "reject", "edit"];

    return { actionRequests, allowedDecisions };
  }

  // Fallback for flat structure
  if (v.name || v.tool_name) {
    return {
      actionRequests: [
        {
          name: v.name || v.tool_name,
          args: v.args ?? v.arguments ?? {},
          description: v.description,
        },
      ],
      allowedDecisions: ["approve", "reject", "edit"],
    };
  }

  return null;
}

const ApprovalCard: FC<{
  interrupt: any;
  onResume: (value: any) => void;
  isLoading?: boolean;
}> = ({ interrupt, onResume, isLoading }) => {
  const [rejectionMessage, setRejectionMessage] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editedArgsMap, setEditedArgsMap] = useState<Record<number, Record<string, unknown>>>({});
  const [showRejectionInput, setShowRejectionInput] = useState(false);
  const [savingAlwaysAllow, setSavingAlwaysAllow] = useState(false);

  const payload = getBatchPayload(interrupt);
  if (!payload || payload.actionRequests.length === 0) return null;

  const { actionRequests, allowedDecisions } = payload;
  const isBatch = actionRequests.length > 1;

  const handleApproveAll = () => {
    onResume({
      decisions: actionRequests.map(() => ({ type: "approve" })),
    });
  };

  const handleRejectAll = () => {
    if (showRejectionInput) {
      const msg = rejectionMessage.trim() || "User rejected tool execution.";
      onResume({
        decisions: actionRequests.map(() => ({ type: "reject", message: msg })),
      });
    } else {
      setShowRejectionInput(true);
    }
  };

  const handleEditSave = () => {
    const decisions = actionRequests.map((req, idx) => {
      const edits = editedArgsMap[idx];
      if (edits) {
        return {
          type: "edit",
          edited_action: { name: req.name, args: edits },
        };
      }
      return { type: "approve" };
    });
    onResume({ decisions });
  };

  const startEditing = () => {
    setIsEditing(true);
    const initialMap: Record<number, Record<string, unknown>> = {};
    actionRequests.forEach((req, idx) => {
      initialMap[idx] = JSON.parse(JSON.stringify(req.args || {}));
    });
    setEditedArgsMap(initialMap);
    setShowRejectionInput(false);
  };

  const updateEditedArg = (reqIdx: number, key: string, value: string) => {
    try {
      const parsedValue =
        value.trim().startsWith("{") || value.trim().startsWith("[")
          ? JSON.parse(value)
          : value;
      setEditedArgsMap((prev) => ({
        ...prev,
        [reqIdx]: { ...(prev[reqIdx] || {}), [key]: parsedValue },
      }));
    } catch {
      setEditedArgsMap((prev) => ({
        ...prev,
        [reqIdx]: { ...(prev[reqIdx] || {}), [key]: value },
      }));
    }
  };

  const handleAlwaysAllow = async (toolName: string) => {
    setSavingAlwaysAllow(true);
    try {
      await fetch("/api/tools/permissions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool_key: toolName,
          permission_mode: "always_allow",
        }),
      });
    } catch (e) {
      console.warn("Failed to persist always_allow:", e);
    } finally {
      setSavingAlwaysAllow(false);
      handleApproveAll();
    }
  };

  return (
    <div className="w-full rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 shadow-sm space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-foreground">
          {isBatch ? (
            <Layers size={17} className="text-amber-600 dark:text-amber-400" />
          ) : (
            <AlertCircle size={17} className="text-amber-600 dark:text-amber-400" />
          )}
          <span className="text-xs font-semibold uppercase tracking-wider">
            {isBatch
              ? `Batch Tool Execution Permission Required (${actionRequests.length} calls)`
              : "Tool Execution Permission Required"}
          </span>
        </div>
        {!isBatch && (
          <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
            {actionRequests[0].name}
          </span>
        )}
      </div>

      {/* Tool Requests List */}
      <div className="space-y-2.5">
        {actionRequests.map((req, idx) => {
          const isTerminal = req.name === "terminal";
          const currentArgs = isEditing ? editedArgsMap[idx] || req.args : req.args;

          return (
            <div
              key={idx}
              className="rounded-md border border-border bg-background p-3 space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  {isTerminal ? (
                    <TerminalSquare size={13} className="text-muted-foreground" />
                  ) : (
                    <span className="text-xs font-bold font-mono text-primary">
                      {isBatch ? `#${idx + 1} ${req.name}` : req.name}
                    </span>
                  )}
                  {req.description && (
                    <span className="text-[11px] text-muted-foreground ml-2 truncate max-w-[300px]">
                      {req.description}
                    </span>
                  )}
                </div>
              </div>

              {/* Arguments (Display or Edit mode) */}
              {isEditing ? (
                <div className="space-y-2 pt-1">
                  {Object.entries(req.args || {}).map(([key, value]) => (
                    <div key={key}>
                      <label className="mb-1 block text-[11px] font-medium text-foreground font-mono">
                        {key}
                      </label>
                      <Textarea
                        value={
                          currentArgs[key] !== undefined
                            ? typeof currentArgs[key] === "string"
                              ? (currentArgs[key] as string)
                              : JSON.stringify(currentArgs[key], null, 2)
                            : typeof value === "string"
                              ? value
                              : JSON.stringify(value, null, 2)
                        }
                        onChange={(e) => updateEditedArg(idx, key, e.target.value)}
                        className="font-mono text-xs"
                        rows={typeof value === "string" && value.length < 80 ? 2 : 3}
                        disabled={isLoading || savingAlwaysAllow}
                      />
                    </div>
                  ))}
                  {(!req.args || Object.keys(req.args).length === 0) && (
                    <p className="text-[11px] text-muted-foreground italic">No arguments</p>
                  )}
                </div>
              ) : (
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-muted/40 p-2 font-mono text-xs text-foreground">
                  {isTerminal && typeof req.args?.command === "string"
                    ? (req.args.command as string)
                    : JSON.stringify(req.args, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>

      {/* Denial Reason Input */}
      {showRejectionInput && !isEditing && (
        <div className="space-y-1">
          <label className="block text-xs font-medium text-foreground">
            Denial reason (optional — feedback returned to the agent)
          </label>
          <Textarea
            value={rejectionMessage}
            onChange={(e) => setRejectionMessage(e.target.value)}
            placeholder="Explain why you're denying this action…"
            className="text-xs"
            rows={2}
            disabled={isLoading || savingAlwaysAllow}
          />
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {isEditing ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsEditing(false)}
              disabled={isLoading || savingAlwaysAllow}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleEditSave}
              disabled={isLoading || savingAlwaysAllow}
              className="bg-green-600 text-white hover:bg-green-700 dark:bg-green-600 dark:hover:bg-green-700"
            >
              <Check size={14} className="mr-1" />
              {isLoading ? "Saving…" : isBatch ? "Save & Allow All" : "Save & Allow"}
            </Button>
          </>
        ) : showRejectionInput ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowRejectionInput(false);
                setRejectionMessage("");
              }}
              disabled={isLoading || savingAlwaysAllow}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleRejectAll}
              disabled={isLoading || savingAlwaysAllow}
            >
              {isLoading ? "Denying…" : isBatch ? "Confirm Deny All" : "Confirm Deny"}
            </Button>
          </>
        ) : (
          <>
            {allowedDecisions.includes("approve") && (
              <Button
                size="sm"
                onClick={handleApproveAll}
                disabled={isLoading || savingAlwaysAllow}
                className={cn(
                  "bg-green-600 text-white hover:bg-green-700",
                  "dark:bg-green-600 dark:hover:bg-green-700 font-medium text-xs",
                )}
              >
                <Check size={14} className="mr-1" />
                {isLoading ? "Allowing…" : isBatch ? `Allow All (${actionRequests.length})` : "Allow"}
              </Button>
            )}

            {!isBatch && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => handleAlwaysAllow(actionRequests[0].name)}
                disabled={isLoading || savingAlwaysAllow}
                className="bg-primary/10 text-primary hover:bg-primary/20 border border-primary/30 font-medium text-xs"
                title="Automatically allow all future calls to this tool without prompting again"
              >
                <Check size={13} className="mr-1 text-primary" />
                {savingAlwaysAllow ? "Saving…" : "Always Allow for this tool"}
              </Button>
            )}

            {allowedDecisions.includes("reject") && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRejectAll}
                disabled={isLoading || savingAlwaysAllow}
                className="text-destructive hover:bg-destructive/10 border-destructive/30 text-xs"
              >
                <X size={14} className="mr-1" />
                {isBatch ? "Deny All" : "Deny"}
              </Button>
            )}

            {allowedDecisions.includes("edit") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={startEditing}
                disabled={isLoading || savingAlwaysAllow}
                className="text-muted-foreground text-xs"
              >
                <Pencil size={13} className="mr-1" />
                Edit Arguments
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export const ToolApprovalInterruptList: FC = () => {
  const { interrupts, resumeInterrupt, isLoading } = useLangGraphRuntime();
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  // Clear dismissed IDs when all interrupts are resolved
  useEffect(() => {
    if (!interrupts || interrupts.length === 0 || !isLoading) {
      setDismissedIds(new Set());
    }
  }, [interrupts, isLoading]);

  const actionable = useMemo(() => {
    const seen = new Set<string>();
    const list: { intr: any; id: string }[] = [];
    for (const intr of interrupts || []) {
      const payload = getBatchPayload(intr);
      if (payload !== null) {
        const id =
          intr?.id ??
          intr?.interrupt_id ??
          `${payload.actionRequests.map((r) => r.name).join("-")}-${JSON.stringify(payload.actionRequests.map((r) => r.args))}`;
        if (!seen.has(id) && !dismissedIds.has(id)) {
          seen.add(id);
          list.push({ intr, id });
        }
      }
    }
    return list;
  }, [interrupts, dismissedIds]);

  // Immediately disappear when stream is actively executing (resumed) or no actionable interrupts
  if (isLoading || actionable.length === 0) return null;

  return (
    <div className="mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-3 px-2">
      {actionable.map(({ intr, id }, i) => (
        <ApprovalCard
          key={`${id}-${i}`}
          interrupt={intr}
          isLoading={isLoading}
          onResume={(value) => {
            setDismissedIds((prev) => new Set(prev).add(id));
            resumeInterrupt(value, intr?.id ?? intr?.interrupt_id);
          }}
        />
      ))}
    </div>
  );
};
