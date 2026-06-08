"use client";

import React, { useMemo, useState, useCallback } from "react";
import { SubAgentIndicator } from "@/app/components/SubAgentIndicator";
import { AgentEventCard } from "@/app/components/agent-cards/AgentEventCard";
import { MarkdownContent } from "@/app/components/MarkdownContent";
import type {
  SubAgent,
  ToolCall,
  ActionRequest,
  ReviewConfig,
} from "@/app/types/types";
import { Message } from "@langchain/langgraph-sdk";
import {
  extractSubAgentContent,
  extractStringFromMessageContent,
} from "@/app/utils/utils";
import { cn } from "@/lib/utils";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

interface ChatMessageProps {
  message: Message;
  toolCalls: ToolCall[];
  isLoading?: boolean;
  actionRequestsMap?: Map<string, ActionRequest>;
  reviewConfigsMap?: Map<string, ReviewConfig>;
  ui?: any[];
  stream?: any;  // useStream return value — exposes getSubagentsByMessage()
  onResumeInterrupt?: (value: any) => void;
  graphId?: string;
}

// ── Status badge shown in the subagent card header ───────────────────────────
function SubagentStatusBadge({ status }: { status: string }) {
  if (status === "running") {
    return (
      <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-blue-500">
        <Loader2 size={10} className="animate-spin" />
        Running
      </span>
    );
  }
  if (status === "complete") {
    return (
      <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-green-600">
        <CheckCircle2 size={10} />
        Done
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-red-500">
        <XCircle size={10} />
        Error
      </span>
    );
  }
  // pending
  return (
    <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      <Loader2 size={10} className="animate-spin opacity-50" />
      Starting…
    </span>
  );
}

// ── Live streaming card — shown while subagent is active ─────────────────────
function LiveSubagentCard({
  subagentStream,
  staticSubAgent,
}: {
  subagentStream: any | null;   // SubagentStreamInterface from useStream
  staticSubAgent: SubAgent;
}) {
  // Live messages from the subagent stream (token-by-token)
  const liveMessages: Message[] = subagentStream?.messages ?? [];
  const status: string = subagentStream?.status ?? (staticSubAgent.output ? "complete" : "pending");

  // Filter to only AI messages with content (skip tool messages for readability)
  const aiMessages = liveMessages.filter(
    (m: Message) => m.type === "ai" && extractStringFromMessageContent(m)?.trim()
  );

  // Tool calls being made by the subagent
  const subagentToolCalls: ToolCall[] = liveMessages
    .filter((m: Message) => m.type === "ai")
    .flatMap((m: Message) => {
      const calls: any[] = (m as any).tool_calls ?? (m as any).additional_kwargs?.tool_calls ?? [];
      return calls
        .filter((tc: any) => tc.name && tc.name !== "task")
        .map((tc: any) => ({
          id: tc.id ?? `tc-${Math.random()}`,
          name: tc.function?.name ?? tc.name ?? "unknown",
          args: tc.function?.arguments ?? tc.args ?? {},
          status: "pending" as const,
        }));
    });

  // Pair tool results from liveMessages
  const toolResultMap = new Map<string, string>();
  liveMessages
    .filter((m: Message) => m.type === "tool")
    .forEach((m: Message) => {
      const toolMsg = m as any;
      if (toolMsg.tool_call_id) {
        toolResultMap.set(toolMsg.tool_call_id, extractStringFromMessageContent(m) ?? "");
      }
    });
  const resolvedToolCalls: ToolCall[] = subagentToolCalls.map((tc) => ({
    ...tc,
    status: toolResultMap.has(tc.id) ? ("completed" as const) : tc.status,
    result: toolResultMap.get(tc.id),
  }));

  const hasLiveContent = aiMessages.length > 0 || resolvedToolCalls.length > 0;

  return (
    <div className="bg-surface border-border-light rounded-md border p-4">
      {/* Header with name + live status badge */}
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-primary/70 text-xs font-semibold uppercase tracking-wider">
          {staticSubAgent.subAgentName}
        </h4>
        <SubagentStatusBadge status={status} />
      </div>

      {/* INPUT section — always shown */}
      <div className="mb-4">
        <h4 className="text-primary/70 mb-2 text-xs font-semibold uppercase tracking-wider">
          Input
        </h4>
        <MarkdownContent content={extractSubAgentContent(staticSubAgent.input)} />
      </div>

      {/* LIVE STREAM section — shown while running or after completion */}
      {hasLiveContent && (
        <div className="border-t border-border pt-3">
          <h4 className="text-primary/70 mb-2 text-xs font-semibold uppercase tracking-wider">
            {status === "complete" ? "Output" : "Streaming…"}
          </h4>

          {/* Tool calls the subagent is making */}
          {resolvedToolCalls.map((tc) => (
            <div
              key={tc.id}
              className="mb-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-xs"
            >
              <span className="font-mono font-semibold text-blue-500">{tc.name}</span>
              {tc.status === "completed" && tc.result && (
                <p className="mt-1 line-clamp-2 text-muted-foreground">{tc.result.slice(0, 120)}{tc.result.length > 120 ? "…" : ""}</p>
              )}
              {tc.status !== "completed" && (
                <Loader2 size={10} className="ml-2 inline animate-spin text-muted-foreground" />
              )}
            </div>
          ))}

          {/* AI text tokens streaming in */}
          {aiMessages.map((m: Message, i: number) => (
            <div key={m.id ?? i} className="text-sm leading-relaxed text-primary">
              <MarkdownContent content={extractStringFromMessageContent(m) ?? ""} />
            </div>
          ))}

          {/* Animated dots while still running and no content yet */}
          {status === "running" && !hasLiveContent && (
            <span className="inline-flex gap-1">
              <span className="animate-bounce [animation-delay:0ms] w-1 h-1 rounded-full bg-blue-400" />
              <span className="animate-bounce [animation-delay:150ms] w-1 h-1 rounded-full bg-blue-400" />
              <span className="animate-bounce [animation-delay:300ms] w-1 h-1 rounded-full bg-blue-400" />
            </span>
          )}
        </div>
      )}

      {/* Fallback: static Output from tool result (when stream not available) */}
      {!hasLiveContent && staticSubAgent.output && (
        <>
          <h4 className="text-primary/70 mb-2 text-xs font-semibold uppercase tracking-wider">
            Output
          </h4>
          <MarkdownContent content={extractSubAgentContent(staticSubAgent.output)} />
        </>
      )}

      {/* Spinner while pending and no content yet */}
      {status === "pending" && !hasLiveContent && !staticSubAgent.output && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          Waiting to start…
        </div>
      )}
    </div>
  );
}

export const ChatMessage = React.memo<ChatMessageProps>(
  ({
    message,
    toolCalls,
    isLoading,
    actionRequestsMap,
    reviewConfigsMap,
    ui,
    stream,
    onResumeInterrupt,
    graphId,
  }) => {
    const isUser = message.type === "human";
    const messageContent = extractStringFromMessageContent(message);
    const hasContent = messageContent && messageContent.trim() !== "";
    const hasToolCalls = toolCalls.length > 0;
    const subAgents = useMemo(() => {
      return toolCalls
        .filter((toolCall: ToolCall) => {
          return (
            toolCall.name === "task" &&
            toolCall.args["subagent_type"] &&
            toolCall.args["subagent_type"] !== "" &&
            toolCall.args["subagent_type"] !== null
          );
        })
        .map((toolCall: ToolCall) => {
          const subagentType = (toolCall.args as Record<string, unknown>)[
            "subagent_type"
          ] as string;
          return {
            id: toolCall.id,
            name: toolCall.name,
            subAgentName: subagentType,
            input: toolCall.args,
            output: toolCall.result ? { result: toolCall.result } : undefined,
            status: toolCall.status,
          } as SubAgent;
        });
    }, [toolCalls]);

    const [expandedSubAgents, setExpandedSubAgents] = useState<
      Record<string, boolean>
    >({});
    const isSubAgentExpanded = useCallback(
      (id: string) => expandedSubAgents[id] ?? true,
      [expandedSubAgents]
    );
    const toggleSubAgent = useCallback((id: string) => {
      setExpandedSubAgents((prev) => ({
        ...prev,
        [id]: prev[id] === undefined ? false : !prev[id],
      }));
    }, []);

    return (
      <div
        className={cn(
          "flex w-full max-w-full overflow-x-hidden",
          isUser && "flex-row-reverse"
        )}
      >
        <div
          className={cn(
            "min-w-0 max-w-full",
            isUser ? "max-w-[70%]" : "w-full"
          )}
        >
          {hasContent && (
            <div className={cn("relative flex items-end gap-0")}>
              <div
                className={cn(
                  "mt-4 overflow-hidden break-words text-sm font-normal leading-[150%]",
                  isUser
                    ? "rounded-xl rounded-br-none border border-border px-3 py-2 text-foreground"
                    : "text-primary"
                )}
                style={
                  isUser
                    ? { backgroundColor: "var(--color-user-message-bg)" }
                    : undefined
                }
              >
                {isUser ? (
                  <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {messageContent}
                  </p>
                ) : hasContent ? (
                  <MarkdownContent content={messageContent} />
                ) : null}
              </div>
            </div>
          )}
          {hasToolCalls && (
            <div className="mt-4 flex w-full flex-col">
              {toolCalls.map((toolCall: ToolCall) => {
                if (toolCall.name === "task") return null;
                const toolCallGenUiComponent = ui?.find(
                  (u) => u.metadata?.tool_call_id === toolCall.id
                );
                const actionRequest = actionRequestsMap?.get(toolCall.name);
                const reviewConfig = reviewConfigsMap?.get(toolCall.name);
                return (
                  <AgentEventCard
                    key={toolCall.id}
                    toolCall={toolCall}
                    uiComponent={toolCallGenUiComponent}
                    stream={stream}
                    graphId={graphId}
                    actionRequest={actionRequest}
                    reviewConfig={reviewConfig}
                    onResume={onResumeInterrupt}
                    isLoading={isLoading}
                  />
                );
              })}
            </div>
          )}
          {!isUser && subAgents.length > 0 && (
            <div className="flex w-fit max-w-full flex-col gap-4">
              {subAgents.map((subAgent) => {
                // Get the live subagent stream keyed by tool call ID
                // stream.getSubagentsByMessage returns subagents spawned by this message
                const subagentStream: any | null =
                  stream?.getSubagentsByMessage?.(message.id!)
                    ?.find((s: any) => s.id === subAgent.id) ?? null;

                return (
                  <div
                    key={subAgent.id}
                    className="flex w-full flex-col gap-2"
                  >
                    <div className="flex items-end gap-2">
                      <div className="w-[calc(100%-100px)]">
                        <SubAgentIndicator
                          subAgent={subAgent}
                          onClick={() => toggleSubAgent(subAgent.id)}
                          isExpanded={isSubAgentExpanded(subAgent.id)}
                        />
                      </div>
                    </div>
                    {isSubAgentExpanded(subAgent.id) && (
                      <div className="w-full max-w-full">
                        <LiveSubagentCard
                          subagentStream={subagentStream}
                          staticSubAgent={subAgent}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }
);

ChatMessage.displayName = "ChatMessage";
