"use client";

import React, { useState } from "react";
import {
  ChevronDown, ChevronUp, Terminal,
  AlertCircle, Loader2, CircleCheckBigIcon, StopCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolCall, ActionRequest, ReviewConfig } from "@/app/types/types";
import { cn } from "@/lib/utils";
import { LoadExternalComponent } from "@langchain/langgraph-sdk/react-ui";
import { ToolApprovalInterrupt } from "@/app/components/ToolApprovalInterrupt";

const TOOL_LABELS: Record<string, { label: string; accent: string }> = {
  get_design_guide:        { label: "📐 Loading design guide",    accent: "#8B5CF6" },
  read_skill:              { label: "📚 Reading skill",           accent: "#06B6D4" },
  get_wordpress_categories:{ label: "📂 Fetching WP categories",  accent: "#F97316" },
};

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":   return <CircleCheckBigIcon size={14} className="text-green-500" />;
    case "error":       return <AlertCircle size={14} className="text-destructive" />;
    case "pending":     return <Loader2 size={14} className="animate-spin text-muted-foreground" />;
    case "interrupted": return <StopCircle size={14} className="text-orange-500" />;
    default:            return <Terminal size={14} className="text-muted-foreground" />;
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
  ({ toolCall, uiComponent, stream, graphId, actionRequest, reviewConfig, onResume, isLoading }) => {
    const { name, args, result, status } = toolCall;
    const hasContent = Boolean(result) || Object.keys(args ?? {}).length > 0;
    const [isExpanded, setIsExpanded] = useState(() => !!uiComponent || !!actionRequest);
    const [expandedArgs, setExpandedArgs] = useState<Record<string, boolean>>({});

    const toolInfo = TOOL_LABELS[name];
    const displayName = toolInfo?.label ?? name;
    const accent = toolInfo?.accent ?? "#6B7280";

    const primaryArgValue = (() => {
      const entries = Object.entries(args ?? {});
      if (!entries.length) return null;
      const [, v] = entries[0];
      const str = typeof v === "string" ? v : JSON.stringify(v);
      return str.length > 60 ? str.slice(0, 60) + "…" : str;
    })();

    return (
      <div
        className="w-full rounded-xl overflow-hidden mb-2"
        style={{
          border: `1.5px solid ${accent}44`,
          background: `${accent}06`,
          animation: "cardSlideIn 0.28s cubic-bezier(0.16,1,0.3,1) both",
        }}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsExpanded((p) => !p)}
          disabled={!hasContent}
          className="flex w-full items-center justify-between gap-2 border-none px-3 py-2.5 text-left shadow-none outline-none focus-visible:ring-0 rounded-none"
          style={{ background: `${accent}08`, borderBottom: isExpanded ? `1px solid ${accent}22` : undefined }}
        >
          <div className="flex items-center gap-2">
            <StatusIcon status={status} />
            <span className="text-[13px] font-semibold tracking-tight text-foreground">{displayName}</span>
            {primaryArgValue && status !== "completed" && (
              <span className="text-xs text-muted-foreground truncate max-w-[180px]">— {primaryArgValue}</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {status === "pending" && <Loader2 size={11} className="animate-spin text-muted-foreground" />}
            {status === "completed" && <CircleCheckBigIcon size={11} className="text-green-500" />}
            {hasContent && (
              isExpanded
                ? <ChevronUp size={13} className="text-muted-foreground shrink-0" />
                : <ChevronDown size={13} className="text-muted-foreground shrink-0" />
            )}
          </div>
        </Button>

        {isExpanded && hasContent && (
          <div className="px-3 pb-3">
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
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Arguments</p>
                    <div className="space-y-1.5">
                      {Object.entries(args).map(([key, value]) => (
                        <div key={key} className="rounded border border-border overflow-hidden">
                          <button
                            onClick={() => setExpandedArgs((p) => ({ ...p, [key]: !p[key] }))}
                            className="flex w-full items-center justify-between p-2 text-left text-xs font-medium transition-colors hover:bg-muted/50 bg-muted/30"
                          >
                            <span className="font-mono">{key}</span>
                            {expandedArgs[key] ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                          </button>
                          {expandedArgs[key] && (
                            <div className="border-t border-border p-2 bg-muted/10">
                              <pre className="m-0 font-mono text-xs whitespace-pre-wrap break-all leading-relaxed text-foreground">
                                {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
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
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Result</p>
                    <pre className="m-0 font-mono text-xs whitespace-pre-wrap break-all rounded border border-border p-2 leading-relaxed text-foreground"
                      style={{ background: "rgba(0,0,0,0.02)" }}>
                      {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
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
