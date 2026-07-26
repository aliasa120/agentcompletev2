"use client";

import { useCallback, useEffect } from "react";
import { useStream } from "@langchain/langgraph-sdk/react";
import {
  type Message,
  type Assistant,
  type Checkpoint,
} from "@langchain/langgraph-sdk";
import { v4 as uuidv4 } from "uuid";
import type { UseStreamThread } from "@langchain/langgraph-sdk/react";
import type { TodoItem } from "@/app/types/types";
import { useClient } from "@/providers/ClientProvider";
import { useQueryState } from "nuqs";

export type StateType = {
  messages: Message[];
  todos: TodoItem[];
  files: Record<string, string>;
  email?: {
    id?: string;
    subject?: string;
    page_content?: string;
  };
  ui?: any;
};

export function useChat({
  activeAssistant,
  onHistoryRevalidate,
  thread,
  onFinishCallback,
  onErrorCallback,
  workflowId,
  userId,
}: {
  activeAssistant: Assistant | null;
  onHistoryRevalidate?: () => void;
  thread?: UseStreamThread<StateType>;
  /** Called when the stream finishes successfully */
  onFinishCallback?: () => void;
  /** Called when the stream errors */
  onErrorCallback?: () => void;
  workflowId: string | null;
  userId?: string;
}) {
  const [threadId, setThreadId] = useQueryState("threadId");
  const client = useClient();

  const stream = useStream<StateType>({
    assistantId: activeAssistant?.assistant_id || "",
    client: client ?? undefined,
    // IMPORTANT: reconnectOnMount: false — setting this to true causes the SDK to
    // store the run ID in sessionStorage. On next render it tries to "rejoin" that
    // old run. If the run was cancelled/interrupted the frontend gets stuck on
    // "Agent is thinking..." forever (works in fresh browsers but broken in existing ones).
    reconnectOnMount: false,
    // onDisconnect: "cancel" — removed; not in current SDK type definition.
    // reconnectOnMount: false already prevents stale run reconnection.
    threadId: threadId ?? null,
    onThreadId: setThreadId,
    // Note: "x-auth-scheme": "langsmith" removed — causes 403 in local dev
    // as it triggers online LangSmith key validation. Auth is handled via X-Api-Key in ClientProvider.
    // Enable fetching state history when switching to existing threads
    fetchStateHistory: true,
    // Revalidate thread list when stream finishes, errors, or creates new thread
    onFinish: () => {
      onHistoryRevalidate?.();
      onFinishCallback?.();
    },
    onError: () => {
      onHistoryRevalidate?.();
      onErrorCallback?.();
    },
    onCreated: (thread: any) => {
      if (thread?.thread_id && workflowId) {
        client.threads.update(thread.thread_id, {
          metadata: {
            workflow_id: workflowId,
            user_id: userId || undefined,
          }
        }).catch(err => {
          console.error("[useChat] Failed to set workflow_id/user_id on new thread:", err);
        });
      }
      onHistoryRevalidate?.();
    },
    // experimental_thread was renamed to thread in SDK v1.9.9
    thread: thread,
  });

  // Automatically check for and rejoin active runs on this thread
  useEffect(() => {
    if (!threadId || !client) return;

    let isSubscribed = true;
    let pollInterval: NodeJS.Timeout | null = null;
    let isRejoining = false;

    const checkAndJoinActiveRun = async () => {
      if (stream.isLoading || stream.isThreadLoading || isRejoining) return;

      try {
        const runs = await client.runs.list(threadId, { limit: 5 });
        if (!isSubscribed) return;

        const activeRun = runs.find(
          (r) => r.status === "running" || r.status === "pending"
        );

        if (activeRun) {
          console.log(`[useChat] Found active run ${activeRun.run_id} on thread ${threadId}, rejoining...`);
          isRejoining = true;
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
          await stream.joinStream(activeRun.run_id, undefined, {
            streamMode: ["values", "messages-tuple", "updates", "tasks", "tools", "custom"]
          });
        }
      } catch (err) {
        console.error("[useChat] Error checking or rejoining active run:", err);
      } finally {
        isRejoining = false;
      }
    };

    checkAndJoinActiveRun();
    pollInterval = setInterval(checkAndJoinActiveRun, 4000);

    return () => {
      isSubscribed = false;
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [threadId, client, stream.isLoading, stream.isThreadLoading]);

  const sendMessage = useCallback(
    (content: string | any[]) => {
      const newMessage: Message = { id: uuidv4(), type: "human", content: content as any };
      stream.submit(
        { messages: [newMessage] },
        {
          optimisticValues: (prev) => ({
            messages: [...(prev.messages ?? []), newMessage],
          }),
          // "messages-tuple" enables token-by-token streaming as the model generates
          streamMode: ["values", "messages-tuple", "updates", "tasks", "tools", "custom"],
          config: {
            ...(activeAssistant?.config ?? {}),
            recursion_limit: 200,
            configurable: {
              ...(activeAssistant?.config?.configurable ?? {}),
              workflow_id: workflowId,
              user_id: userId || undefined,
            },
          },
          streamSubgraphs: true,  // enable live subagent streaming
        }
      );
      // Update thread list immediately when sending a message
      onHistoryRevalidate?.();
    },
    [stream, activeAssistant?.config, onHistoryRevalidate, workflowId, userId]
  );

  const runSingleStep = useCallback(
    (
      messages: Message[],
      checkpoint?: Checkpoint,
      isRerunningSubagent?: boolean,
      optimisticMessages?: Message[]
    ) => {
      const runConfig = {
        ...(activeAssistant?.config ?? {}),
        configurable: {
          ...(activeAssistant?.config?.configurable ?? {}),
          workflow_id: workflowId,
          user_id: userId || undefined,
        },
      };
      if (checkpoint) {
        stream.submit(undefined, {
          ...(optimisticMessages
            ? { optimisticValues: { messages: optimisticMessages } }
            : {}),
          config: runConfig,
          checkpoint: checkpoint,
          streamMode: ["values", "messages-tuple", "updates", "tasks", "tools", "custom"],
          streamSubgraphs: true,
          ...(isRerunningSubagent ? { interruptAfter: ["tools"] } : {}),
        });
      } else {
        stream.submit(
          { messages },
          { config: runConfig, streamMode: ["values", "messages-tuple", "updates", "tasks", "tools", "custom"], streamSubgraphs: true }
        );
      }
    },
    [stream, activeAssistant?.config, workflowId, userId]
  );

  const setFiles = useCallback(
    async (files: Record<string, string>) => {
      if (!threadId) return;
      // TODO: missing a way how to revalidate the internal state
      // I think we do want to have the ability to externally manage the state
      await client.threads.updateState(threadId, { values: { files } });
    },
    [client, threadId]
  );

  const continueStream = useCallback(
    (hasTaskToolCall?: boolean) => {
      stream.submit(undefined, {
        config: {
          ...(activeAssistant?.config || {}),
          recursion_limit: 200,
          configurable: {
            ...(activeAssistant?.config?.configurable ?? {}),
            workflow_id: workflowId,
            user_id: userId || undefined,
          },
        },
        streamMode: ["values", "messages-tuple", "updates", "tasks", "tools", "custom"],
        streamSubgraphs: true,
        ...(hasTaskToolCall ? { interruptAfter: ["tools"] } : {}),
      });
      // Update thread list when continuing stream
      onHistoryRevalidate?.();
    },
    [stream, activeAssistant?.config, onHistoryRevalidate, workflowId, userId]
  );

  const markCurrentThreadAsResolved = useCallback(() => {
    stream.submit(null, { command: { goto: "__end__", update: null } });
    // Update thread list when marking thread as resolved
    onHistoryRevalidate?.();
  }, [stream, onHistoryRevalidate]);

  const resumeInterrupt = useCallback(
    (value: any) => {
      stream.submit(null, { command: { resume: value } });
      // Update thread list when resuming from interrupt
      onHistoryRevalidate?.();
    },
    [stream, onHistoryRevalidate]
  );

  const stopStream = useCallback(() => {
    stream.stop();
  }, [stream]);

  return {
    stream,
    todos: stream.values.todos ?? [],
    files: stream.values.files ?? {},
    email: stream.values.email,
    ui: stream.values.ui,
    setFiles,
    messages: stream.messages,
    isLoading: stream.isLoading,
    isThreadLoading: stream.isThreadLoading,
    interrupt: stream.interrupt,
    getMessagesMetadata: stream.getMessagesMetadata,
    sendMessage,
    runSingleStep,
    continueStream,
    stopStream,
    markCurrentThreadAsResolved,
    resumeInterrupt,
  };
}
