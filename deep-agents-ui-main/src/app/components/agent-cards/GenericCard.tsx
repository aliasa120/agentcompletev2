"use client";

import React, { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Terminal,
  AlertCircle,
  Loader2,
  CircleCheckBigIcon,
  StopCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolCall, ActionRequest, ReviewConfig } from "@/app/types/types";
import { cn } from "@/lib/utils";
import { LoadExternalComponent } from "@langchain/langgraph-sdk/react-ui";
import { ToolApprovalInterrupt } from "@/app/components/ToolApprovalInterrupt";

import { cssVar } from "@/lib/theme";

const TOOL_LABELS: Record<string, { label: string; accent: string }> = {
  get_design_guide: { label: "📐 Loading design guide", accent: cssVar.primary },
  read_skill: { label: "📚 Reading skill", accent: cssVar.primary },
  get_wordpress_categories: {
    label: "📂 Fetching WP categories",
    accent: cssVar.primary,
  },
};

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <CircleCheckBigIcon size={14} className="text-primary" />;
    case "error":
      return <AlertCircle size={14} className="text-destructive" />;
    case "pending":
      return (
        <Loader2 size={14} className="animate-spin text-muted-foreground" />
      );
    case "interrupted":
      return <StopCircle size={14} className="text-amber-500" />;
    default:
      return <Terminal size={14} className="text-muted-foreground" />;
  }
}

interface GenericCardProps {
  toolCall: ToolCall;
  uiComponent?: any;
  stream?: any;
  graphId?: string;
  actionRequest?: ActionRequest;
  reviewConfig?: ReviewConfig;
  onResume?: (value: any) => void;
  isLoading?: boolean;
}

export const GenericCard = React.memo<GenericCardProps>(
  ({
    toolCall,
    uiComponent,
    stream,
    graphId,
    actionRequest,
    reviewConfig,
    onResume,
    isLoading,
  }) => {
    const { name, args, result, status } = toolCall;
    const hasContent =
      Boolean(result) || Object.keys(args ?? {}).length > 0;
    const [isExpanded, setIsExpanded] = useState(
      () => !!uiComponent || !!actionRequest
    );
    const [expandedArgs, setExpandedArgs] = useState<
      Record<string, boolean>
    >({});

    const toolInfo = TOOL_LABELS[name];
    const displayName = toolInfo?.label ?? name;
    const accent = toolInfo?.accent ?? cssVar.mutedForeground;

    const primaryArgValue = (() => {
      const entries = Object.entries(args ?? {});
      if (!entries.length) return null;
      const [, v] = entries[0];
      const str = typeof v === "string" ? v : JSON.stringify(v);
      return str.length > 60 ? str.slice(0, 60) + "…" : str;
    })();

    return (
      <div
        className="w-full rounded-xl overflow-hidden mb-2 border border-border bg-card"
        style={{
          animation: "cardSlideIn 0.28s cubic-bezier(0.16,1,0.3,1) both",
          borderLeftColor: accent,
          borderLeftWidth: "3px",
          boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
        }}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsExpanded((p) => !p)}
          disabled={!hasContent}
          className="flex w-full items-center justify-between gap-2 border-none px-3.5 py-2.5 text-left shadow-none outline-none focus-visible:ring-0 rounded-none bg-muted/40 hover:bg-muted/60 transition-colors"
          style={{
            borderBottom: isExpanded ? "1px solid var(--border)" : undefined,
          }}
        >
          <div className="flex items-center gap-2">
            <StatusIcon status={status} />
            <span className="text-[13px] font-semibold tracking-tight text-foreground">
              {displayName}
            </span>
            {primaryArgValue && status !== "completed" && (
              <span className="text-[11px] text-muted-foreground truncate max-w-[180px]">
                — {primaryArgValue}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {status === "pending" && (
              <Loader2 size={11} className="animate-spin text-muted-foreground" />
            )}
            {status === "completed" && (
              <CircleCheckBigIcon size={11} className="text-primary" />
            )}
            {hasContent &&
              (isExpanded ? (
                <ChevronUp size={13} className="text-muted-foreground shrink-0" />
              ) : (
                <ChevronDown
                  size={13}
                  className="text-muted-foreground shrink-0"
                />
              ))}
          </div>
        </Button>

        {isExpanded && hasContent && (
          <div className="px-3.5 pb-3.5">
            {uiComponent && stream && graphId ? (
              <div className="mt-3">
                <LoadExternalComponent
                  key={uiComponent.id}
                  stream={stream}
                  message={uiComponent}
                  namespace={graphId}
                  meta={{ status, args, result: result ?? "No Result Yet" }}
                />
              </div>
            ) : actionRequest && onResume ? (
              <div className="mt-3">
                <ToolApprovalInterrupt
                  actionRequest={actionRequest}
                  reviewConfig={reviewConfig}
                  onResume={onResume}
                  isLoading={isLoading}
                />
              </div>
            ) : (
              <>
                {Object.keys(args ?? {}).length > 0 && (
                  <div className="mt-3">
                    <p className="text-[9.5px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">
                      Arguments
                    </p>
                    <div className="space-y-1.5">
                      {Object.entries(args).map(([key, value]) => (
                        <div
                          key={key}
                          className="rounded-lg border border-border overflow-hidden"
                        >
                          <button
                            onClick={() =>
                              setExpandedArgs((p) => ({
                                ...p,
                                [key]: !p[key],
                              }))
                            }
                            className="flex w-full items-center justify-between p-2 text-left text-xs font-medium transition-colors hover:bg-muted/60 bg-muted/30"
                          >
                            <span className="font-mono text-foreground">
                              {key}
                            </span>
                            {expandedArgs[key] ? (
                              <ChevronUp size={11} className="text-muted-foreground" />
                            ) : (
                              <ChevronDown size={11} className="text-muted-foreground" />
                            )}
                          </button>
                          {expandedArgs[key] && (
                            <div className="border-t border-border p-2 bg-card">
                              <pre className="m-0 font-mono text-xs whitespace-pre-wrap break-all leading-relaxed text-foreground">
                                {typeof value === "string"
                                  ? value
                                  : JSON.stringify(value, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {result && (
                  <div className="mt-3">
                    <p className="text-[9.5px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">
                      Result
                    </p>
                    <pre className="m-0 font-mono text-xs whitespace-pre-wrap break-all rounded-lg border border-border p-2.5 leading-relaxed text-foreground bg-muted/30">
                      {typeof result === "string"
                        ? result
                        : JSON.stringify(result, null, 2)}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  }
);

GenericCard.displayName = "GenericCard";
