"use client";

/**
 * ToolApprovalInterruptList — human-in-the-loop approval cards for LangGraph
 * interrupts emitted by the backend (the `ask_permission` tool; payload shape
 * matches LangChain's HumanInTheLoop middleware:
 * { action_requests: [...], review_configs: [...] }).
 *
 * Reads pending interrupts from LangGraphRuntimeContext and resumes the run
 * via stream.submit(null, { command: { resume } }).
 */

import { useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AlertCircle, Check, X, Pencil, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLangGraphRuntime } from "@/providers/LangGraphRuntimeProvider";

interface ActionRequest {
  name: string;
  args: Record<string, unknown>;
  description?: string;
}

interface ReviewConfig {
  actionName?: string;
  allowedDecisions?: string[];
}

function getPayload(interrupt: any): { actionRequest: ActionRequest; reviewConfig: ReviewConfig } | null {
  const v = interrupt?.value ?? interrupt;
  if (!v || typeof v !== "object") return null;
  const reqs = v.action_requests ?? v.actionRequests ?? [];
  const cfgs = v.review_configs ?? v.reviewConfigs ?? [];
  const req = Array.isArray(reqs) ? reqs[0] : undefined;
  if (!req) return null;
  const cfg = Array.isArray(cfgs) ? cfgs[0] : undefined;
  return {
    actionRequest: {
      name: req.name,
      args: req.args ?? req.arguments ?? {},
      description: req.description,
    },
    reviewConfig: {
      actionName: cfg?.action_name ?? cfg?.actionName,
      allowedDecisions: cfg?.allowed_decisions ?? cfg?.allowedDecisions,
    },
  };
}

const ApprovalCard: FC<{
  interrupt: any;
  onResume: (value: any) => void;
  isLoading?: boolean;
}> = ({ interrupt, onResume, isLoading }) => {
  const [rejectionMessage, setRejectionMessage] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editedArgs, setEditedArgs] = useState<Record<string, unknown>>({});
  const [showRejectionInput, setShowRejectionInput] = useState(false);

  const payload = getPayload(interrupt);
  if (!payload) return null;
  const { actionRequest, reviewConfig } = payload;

  const allowedDecisions = reviewConfig.allowedDecisions ?? ["approve", "reject", "edit"];
  const isTerminal = actionRequest.name === "terminal";

  const handleApprove = () => onResume({ decisions: [{ type: "approve" }] });

  const handleReject = () => {
    if (showRejectionInput) {
      onResume({ decisions: [{ type: "reject", message: rejectionMessage.trim() }] });
    } else {
      setShowRejectionInput(true);
    }
  };

  const handleEditSave = () => {
    onResume({
      decisions: [
        {
          type: "edit",
          edited_action: { name: actionRequest.name, args: editedArgs },
        },
      ],
    });
  };

  const startEditing = () => {
    setIsEditing(true);
    setEditedArgs(JSON.parse(JSON.stringify(actionRequest.args)));
    setShowRejectionInput(false);
  };

  const updateEditedArg = (key: string, value: string) => {
    try {
      const parsedValue =
        value.trim().startsWith("{") || value.trim().startsWith("[")
          ? JSON.parse(value)
          : value;
      setEditedArgs((prev) => ({ ...prev, [key]: parsedValue }));
    } catch {
      setEditedArgs((prev) => ({ ...prev, [key]: value }));
    }
  };

  return (
    <div className="w-full rounded-xl border border-yellow-500/40 bg-yellow-500/5 p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2 text-foreground">
        <AlertCircle size={16} className="text-yellow-600 dark:text-yellow-400" />
        <span className="text-xs font-semibold uppercase tracking-wider">
          Approval required
        </span>
      </div>

      {actionRequest.description && (
        <p className="mb-3 text-sm text-muted-foreground">{actionRequest.description}</p>
      )}

      <div className="mb-4 rounded-md border border-border bg-background p-3">
        <div className="mb-2 flex items-center gap-1.5">
          {isTerminal && <TerminalSquare size={13} className="text-muted-foreground" />}
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {actionRequest.name}
          </span>
        </div>

        {isEditing ? (
          <div className="mt-2 space-y-3">
            {Object.entries(actionRequest.args).map(([key, value]) => (
              <div key={key}>
                <label className="mb-1 block text-xs font-medium text-foreground">{key}</label>
                <Textarea
                  value={
                    editedArgs[key] !== undefined
                      ? typeof editedArgs[key] === "string"
                        ? (editedArgs[key] as string)
                        : JSON.stringify(editedArgs[key], null, 2)
                      : typeof value === "string"
                        ? value
                        : JSON.stringify(value, null, 2)
                  }
                  onChange={(e) => updateEditedArg(key, e.target.value)}
                  className="font-mono text-xs"
                  rows={typeof value === "string" && value.length < 100 ? 2 : 4}
                  disabled={isLoading}
                />
              </div>
            ))}
          </div>
        ) : (
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-muted/40 p-2 font-mono text-xs text-foreground">
            {isTerminal && typeof actionRequest.args?.command === "string"
              ? (actionRequest.args.command as string)
              : JSON.stringify(actionRequest.args, null, 2)}
          </pre>
        )}
      </div>

      {showRejectionInput && !isEditing && (
        <div className="mb-4">
          <label className="mb-2 block text-xs font-medium text-foreground">
            Rejection message (optional — the agent will see this)
          </label>
          <Textarea
            value={rejectionMessage}
            onChange={(e) => setRejectionMessage(e.target.value)}
            placeholder="Explain why you're rejecting this command…"
            className="text-sm"
            rows={2}
            disabled={isLoading}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {isEditing ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setIsEditing(false)} disabled={isLoading}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleEditSave}
              disabled={isLoading}
              className="bg-green-600 text-white hover:bg-green-700 dark:bg-green-600 dark:hover:bg-green-700"
            >
              <Check size={14} />
              {isLoading ? "Saving…" : "Save & approve"}
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
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleReject} disabled={isLoading}>
              {isLoading ? "Rejecting…" : "Confirm reject"}
            </Button>
          </>
        ) : (
          <>
            {allowedDecisions.includes("reject") && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleReject}
                disabled={isLoading}
                className="text-destructive hover:bg-destructive/10"
              >
                <X size={14} />
                Reject
              </Button>
            )}
            {allowedDecisions.includes("edit") && (
              <Button variant="outline" size="sm" onClick={startEditing} disabled={isLoading}>
                <Pencil size={14} />
                Edit
              </Button>
            )}
            {allowedDecisions.includes("approve") && (
              <Button
                size="sm"
                onClick={handleApprove}
                disabled={isLoading}
                className={cn(
                  "bg-green-600 text-white hover:bg-green-700",
                  "dark:bg-green-600 dark:hover:bg-green-700",
                )}
              >
                <Check size={14} />
                {isLoading ? "Approving…" : "Approve"}
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

  const actionable = interrupts.filter((intr) => getPayload(intr) !== null);
  if (actionable.length === 0) return null;

  return (
    <div className="mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-3 px-2">
      {actionable.map((intr, i) => {
        const id = intr?.id ?? intr?.interrupt_id ?? `interrupt-${i}`;
        return (
          <ApprovalCard
            key={id}
            interrupt={intr}
            isLoading={isLoading}
            onResume={(value) => resumeInterrupt(value, intr?.id ?? intr?.interrupt_id)}
          />
        );
      })}
    </div>
  );
};
