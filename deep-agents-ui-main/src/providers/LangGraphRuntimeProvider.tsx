"use client";

/**
 * LangGraphRuntimeProvider
 *
 * Bridges @langchain/langgraph-sdk/react's useStream (proven, feature-rich)
 * into AssistantRuntimeProvider so the new UI's Thread component works unchanged.
 *
 * Key features restored from the old working UI:
 *  - reconnectOnMount: false (prevents stuck "thinking")
 *  - fetchStateHistory: true  (loads history when switching threads)
 *  - checkAndJoinActiveRun polling (rejoins live runs on refresh/switch)
 *  - onCreated → tags new threads with workflow_id/user_id
 *  - onFinish / onError callbacks for article status updates
 *  - stream.submit() per-message config (workflow_id, user_id, streamSubgraphs)
 *  - streamSubmitRef exposed for programmatic sends (handleStartAgent)
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useMemo,
  type ReactNode,
} from "react";
import { useStream } from "@langchain/langgraph-sdk/react";
import { type Message } from "@langchain/langgraph-sdk";
import { v4 as uuidv4 } from "uuid";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  useExternalMessageConverter,
} from "@assistant-ui/react";
import { convertLangChainBaseMessage } from "@assistant-ui/react-langchain";
import { useClient } from "@/providers/ClientProvider";
import { useQueryState } from "nuqs";
import { LangGraphAttachmentAdapter } from "@/lib/attachment-adapter";
import { readVoiceMode, writeVoiceMode, type VoiceMode } from "@/lib/voice-mode";

// TTS markers appended by the backend (finalize_response node / text_to_speech tool)
const AUDIO_URL_RE = /^AUDIO_URL:(\S+)\s*$/;
const AUDIO_VOICE_RE = /^AUDIO_VOICE:(true|false)\s*$/;

// ── Context: expose stream + helpers to children ───────────────────────────────
interface LangGraphRuntimeContextValue {
  isLoading: boolean;
  isThreadLoading: boolean;
  submitRef: React.MutableRefObject<((input: any, options?: any) => void) | null>;
  /** Pending human-in-the-loop interrupt(s) (terminal approval etc.), if any. */
  interrupts: any[];
  /** Resume the run with a decision payload, e.g. {decisions:[{type:"approve"}]} */
  resumeInterrupt: (payload: any, interruptId?: string) => void;
  /** Per-thread voice reply preference (finalize_response voice mirror). */
  voiceMode: VoiceMode;
  setVoiceMode: (mode: VoiceMode) => void;
  /** Start a fresh thread (used by the /new slash command). */
  newThread: () => void;
  threadId: string | null;
  workflowId: string | null;
}

const LangGraphRuntimeContext = createContext<LangGraphRuntimeContextValue | undefined>(undefined);

export function useLangGraphRuntime() {
  const ctx = useContext(LangGraphRuntimeContext);
  if (!ctx) throw new Error("useLangGraphRuntime must be used inside LangGraphRuntimeProvider");
  return ctx;
}

// ── State type ─────────────────────────────────────────────────────────────────
export type StateType = {
  messages: Message[];
  [key: string]: any;
};

// ── Provider props ─────────────────────────────────────────────────────────────
interface LangGraphRuntimeProviderProps {
  children: ReactNode;
  assistantId: string;
  workflowId: string | null;
  userId?: string;
  assistantConfig?: Record<string, any>;
  /** Populated with stream.submit so page.tsx can fire programmatic runs */
  submitRef: React.MutableRefObject<((input: any, options?: any) => void) | null>;
  onStreamFinish?: () => void;
  onStreamError?: () => void;
  onHistoryRevalidate?: () => void;
  threads: any;
  threadId: string | null;
  setThreadId: (id: string | null) => Promise<any> | void;
  handleDeleteThread: (id: string, status: string, e: any) => Promise<any> | void;
}

const attachmentAdapter = new LangGraphAttachmentAdapter();

export function LangGraphRuntimeProvider({
  children,
  assistantId,
  workflowId,
  userId,
  assistantConfig,
  submitRef,
  onStreamFinish,
  onStreamError,
  onHistoryRevalidate,
  threads,
  threadId,
  setThreadId,
  handleDeleteThread,
}: LangGraphRuntimeProviderProps) {
  const client = useClient();

  // ── Voice reply mode (per thread, localStorage-backed) ──────────────────────
  const [voiceMode, setVoiceModeState] = useState<VoiceMode>("voice_only");
  useEffect(() => {
    setVoiceModeState(readVoiceMode(threadId ?? null));
  }, [threadId]);
  const setVoiceMode = useCallback(
    (mode: VoiceMode) => {
      writeVoiceMode(threadId ?? null, mode);
      setVoiceModeState(mode);
    },
    [threadId],
  );
  const voiceModeRef = useRef<VoiceMode>("voice_only");
  voiceModeRef.current = voiceMode;

  // ── useStream from @langchain/langgraph-sdk/react (the proven old hook) ───────
  const stream = useStream<StateType>({
    assistantId: assistantId || "",
    client: client ?? undefined,
    // CRITICAL: reconnectOnMount: false prevents "stuck thinking" on refresh
    reconnectOnMount: false,
    threadId: threadId ?? null,
    onThreadId: setThreadId,
    // fetchStateHistory loads full message history when switching threads
    fetchStateHistory: true,
    onFinish: (_state, run) => {
      onHistoryRevalidate?.();
      onStreamFinish?.();
    },
    onCreated: (run: any) => {
      // Tag new threads with workflow_id / user_id metadata
      if (run?.thread_id && workflowId && client) {
        client.threads.update(run.thread_id, {
          metadata: {
            workflow_id: workflowId,
            user_id: userId || undefined,
          },
        }).catch((err: any) => {
          console.warn("[LangGraphRuntimeProvider] Failed to tag thread metadata:", err);
        });
      }
      onHistoryRevalidate?.();
    },
  });

  // ── Human-in-the-loop interrupt resume (terminal command approval) ──────────
  const resumeInterrupt = useCallback(
    (payload: any, interruptId?: string) => {
      const pending: any[] = (stream as any).interrupts ?? [];
      // Multiple pending interrupts at one checkpoint need an id-keyed resume map
      const resume =
        interruptId && pending.length > 1 ? { [interruptId]: payload } : payload;
      return stream.submit(null, {
        command: { resume },
        streamSubgraphs: true,
        streamMode: ["values", "messages-tuple", "updates", "tasks", "tools", "custom"],
        metadata: {
          workflow_id: workflowId,
          user_id: userId || undefined,
        },
        config: {
          ...(assistantConfig ?? {}),
          recursion_limit: 200,
          configurable: {
            ...(assistantConfig?.configurable ?? {}),
            platform: "web",
            voice_mode: voiceModeRef.current,
            workflow_id: workflowId,
            user_id: userId || undefined,
          },
        },
      });
    },
    [stream, workflowId, userId, assistantConfig],
  );

  const newThread = useCallback(() => {
    void setThreadId(null);
  }, [setThreadId]);

  // ── Expose stream.submit via ref for programmatic sends ───────────────────────
  useEffect(() => {
    submitRef.current = (input: any, options?: any) => {
      return stream.submit(input, {
        streamSubgraphs: true,
        streamMode: ["values", "messages", "updates", "custom"],
        ...options,
        onError: (_err: any, _run: any) => {
          onStreamError?.();
          onHistoryRevalidate?.();
        },
        metadata: {
          workflow_id: workflowId,
          user_id: userId || undefined,
        },
        config: {
          ...(assistantConfig ?? {}),
          recursion_limit: 200,
          ...(options?.config ?? {}),
          configurable: {
            ...(assistantConfig?.configurable ?? {}),
            platform: "web",
            voice_mode: voiceModeRef.current,
            workflow_id: workflowId,
            user_id: userId || undefined,
            ...(options?.config?.configurable ?? {}),
          },
        },
      });
    };
  }, [submitRef, stream.submit, workflowId, userId, assistantConfig, onStreamError, onHistoryRevalidate]);

  // ── Watch for stream errors ────────────────────────────────────────────────────
  const prevErrorRef = useRef<unknown>(undefined);
  useEffect(() => {
    if (stream.error && stream.error !== prevErrorRef.current) {
      prevErrorRef.current = stream.error;
      onStreamError?.();
      onHistoryRevalidate?.();
    }
  }, [stream.error, onStreamError, onHistoryRevalidate]);


  // ── Rejoin active runs on thread switch / refresh ─────────────────────────────
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

        const activeRun = (runs as any[]).find(
          (r: any) => r.status === "running" || r.status === "pending"
        );

        if (activeRun) {
          console.log(`[LangGraphRuntime] Found active run ${activeRun.run_id}, rejoining...`);
          isRejoining = true;
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
          await stream.joinStream(activeRun.run_id, undefined, {
            streamMode: ["values", "messages-tuple", "updates", "tasks", "tools", "custom"],
          });
        }
      } catch (err) {
        console.error("[LangGraphRuntime] Error rejoining active run:", err);
      } finally {
        isRejoining = false;
      }
    };

    checkAndJoinActiveRun();
    pollInterval = setInterval(checkAndJoinActiveRun, 4000);

    return () => {
      isSubscribed = false;
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [threadId, client, stream.isLoading, stream.isThreadLoading]);

  // ── Convert stream.messages → assistant-ui format ─────────────────────────────
  const threadMessages = useExternalMessageConverter({
    callback: (message: any, metadata: any) => {
      try {
        // Normalize content: must be string or array for the library internals.
        // null ?? "" returns null (null is not undefined), so use explicit check.
        let rawContent = message.content;
        if (rawContent === null || rawContent === undefined) {
          rawContent = "";
        }

        let safeContent: string | any[];
        if (Array.isArray(rawContent)) {
          safeContent = rawContent.map((part: any) => {
            if (!part) return null;
            // reasoning parts without a summary array crash contentToParts line 35.
            // Provide an empty summary array to prevent this.
            if (part.type === "reasoning" && !Array.isArray(part.summary)) {
              return {
                ...part,
                text: part.text || part.thinking || "",
                summary: [],
              };
            }
            return part;
          }).filter(Boolean);
        } else if (typeof rawContent === "string") {
          safeContent = rawContent;
        } else {
          // Fallback for any other unexpected type (number, object, etc.)
          safeContent = String(rawContent);
        }

        const safeMessage = {
          ...message,
          content: safeContent,
        };

        const converted = convertLangChainBaseMessage(safeMessage, metadata) as any;

        // Inject reasoning_content as a 'reasoning' block at the beginning of assistant message
        if (converted && converted.role === "assistant") {
          const reasoningContent = message.additional_kwargs?.reasoning_content;
          if (reasoningContent) {
            const contentParts = typeof converted.content === "string"
              ? [{ type: "text" as const, text: converted.content }]
              : [...(converted.content || [])];

            if (!contentParts.some((p: any) => p.type === "reasoning")) {
              contentParts.unshift({
                type: "reasoning" as const,
                text: reasoningContent,
                summary: [],
              });
              converted.content = contentParts;
            } else {
              // Update existing reasoning part
              converted.content = contentParts.map((p: any) => {
                if (p.type === "reasoning") {
                  return { ...p, text: reasoningContent };
                }
                return p;
              });
            }
          }
        }

        // Ensure converted content is always a valid array or string
        if (converted && converted.role !== "tool") {
          if (!Array.isArray(converted.content) && typeof converted.content !== "string") {
            converted.content = converted.content ?? "";
          }
        }

        // Extract AUDIO_URL/AUDIO_VOICE markers (text_to_speech tool / voice mirror)
        // into message metadata so the UI can render an audio player, and strip
        // the marker lines from all visible text (assistant messages & tool call results).
        if (converted) {
          const audios: { url: string; voice: boolean }[] = [];
          let isVoice = false;

          const cleanText = (text: string): string => {
            if (!text || typeof text !== "string") return text;
            const lines = text.split("\n");
            const kept: string[] = [];
            for (const line of lines) {
              const trimmed = line.trim();
              const voiceMatch = trimmed.match(/AUDIO_VOICE:(true|false)/);
              if (voiceMatch) {
                isVoice = voiceMatch[1] === "true";
                if (/^AUDIO_VOICE:(true|false)\s*$/.test(trimmed)) continue;
              }
              const urlMatch = trimmed.match(/AUDIO_URL:(\S+)/);
              if (urlMatch) {
                audios.push({ url: urlMatch[1], voice: isVoice });
                if (/^AUDIO_URL:\S+\s*$/.test(trimmed)) continue;
              }
              const cleanLine = line
                .replace(/AUDIO_VOICE:(true|false)/g, "")
                .replace(/AUDIO_URL:\S+/g, "")
                .trim();
              if (cleanLine || line === "") {
                kept.push(cleanLine);
              }
            }
            return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
          };

          if (typeof converted.content === "string") {
            converted.content = cleanText(converted.content);
          } else if (Array.isArray(converted.content)) {
            converted.content = converted.content.map((part: any) => {
              if (part?.type === "text" && typeof part.text === "string") {
                return { ...part, text: cleanText(part.text) };
              }
              if (part?.type === "tool-call") {
                const cleanedResult = typeof part.result === "string"
                  ? cleanText(part.result)
                  : part.result;
                const cleanedOutput = typeof part.output === "string"
                  ? cleanText(part.output)
                  : part.output;
                return {
                  ...part,
                  ...(part.result ? { result: cleanedResult } : {}),
                  ...(part.output ? { output: cleanedOutput } : {}),
                };
              }
              return part;
            });
          }

          if (audios.length > 0) {
            converted.metadata = {
              ...(converted.metadata ?? {}),
              custom: {
                ...(converted.metadata?.custom ?? {}),
                audioReplies: [
                  ...(converted.metadata?.custom?.audioReplies ?? []),
                  ...audios,
                ],
              },
            };
          }
        }

        if (converted?.role === "user") {
          // Filter out duplicate rendering of non-image file attachments in content
          if (Array.isArray(converted.content)) {
            converted.content = converted.content.filter((part: any) => {
              if (part.type === "image") {
                const url = part.image || "";
                if (url.startsWith("data:") && !url.startsWith("data:image/")) {
                  return false; // strip audio/video/pdf from the content block
                }
              }
              if (part.type === "image_url") {
                const url = part.image_url?.url || "";
                if (url.startsWith("data:") && !url.startsWith("data:image/")) {
                  return false; // strip audio/video/pdf from the content block
                }
              }
              return true;
            });
          }

          const msgMeta = (message as any).additional_kwargs?.metadata;
          if (msgMeta?.attachments) {
            return {
              ...converted,
              attachments: msgMeta.attachments,
            };
          }
        }
        return converted;
      } catch (err) {
        console.error("Error converting message:", err, "Original message:", message);
        return {
          role: "assistant",
          id: message?.id || `error-${Date.now()}`,
          content: [{ type: "text", text: "" }],
        };
      }
    },
    messages: Array.isArray(stream.messages)
      ? stream.messages.filter(Boolean).map((m: any) => ({
          ...m,
          // Ensure content is never null — null ?? "" returns null, so use || fallback
          content: m.content != null ? m.content : "",
        }))
      : [],
    isRunning: stream.isLoading,
  });

  // ── Build AssistantRuntime from external store ─────────────────────────────────
  const runtime = useExternalStoreRuntime({
    isRunning: stream.isLoading,
    messages: threadMessages,
    onNew: async (msg) => {
      // Extract text content from the assistant-ui AppendMessage
      const parts = [...msg.content, ...(msg.attachments?.flatMap((a: any) => a.content) ?? [])];
      let content: string | any[];
      const textParts = parts.filter((p: any) => p.type === "text");
      const hasNonText = parts.some((p: any) => p.type === "image" || p.type === "image_url" || p.type === "file" || p.type === "audio" || p.type === "video");

      if (!hasNonText && textParts.length === 1) {
        content = textParts[0].text;
      } else {
        content = parts.map((p: any) => {
          if (p.type === "text") return { type: "text" as const, text: p.text };
          if (p.type === "image") return { type: "image_url" as const, image_url: { url: p.image } };
          if (p.type === "image_url") return { type: "image_url" as const, image_url: p.image_url };
          if (p.type === "audio") return { type: "audio" as const, audio: p.audio, filename: p.filename, mimeType: p.mimeType };
          if (p.type === "video") return { type: "video" as const, video: p.video, filename: p.filename, mimeType: p.mimeType };
          if (p.type === "input_audio") return null;
          if (p.type === "file") {
            if (p.mimeType === "application/pdf" || p.filename?.endsWith(".pdf")) {
              return {
                type: "image_url" as const,
                image_url: { url: p.data }
              };
            }
            try {
              const base64Str = p.data.split(",")[1];
              const isTextFile = p.mimeType.startsWith("text/") || 
                p.filename?.endsWith(".txt") || 
                p.filename?.endsWith(".md") || 
                p.filename?.endsWith(".json") || 
                p.filename?.endsWith(".js") || 
                p.filename?.endsWith(".ts") || 
                p.filename?.endsWith(".tsx");

              if (isTextFile) {
                const binString = atob(base64Str);
                const bytes = Uint8Array.from(binString, (c) => c.charCodeAt(0));
                const text = new TextDecoder().decode(bytes);
                return {
                  type: "text" as const,
                  text: `\n\n[Attached text file: ${p.filename}]\n${text}`
                };
              }
            } catch (err) {
              console.warn("Failed to decode file attachment text content:", err);
            }
            return {
              type: "file" as const,
              file: {
                file_data: p.data
              }
            };
          }
          return null;
        }).filter(Boolean);
      }

      const quote = (msg as any).metadata?.custom?.quote;
      const attachmentsMeta = msg.attachments?.map((att: any) => ({
        id: att.id,
        name: att.name,
        type: att.type,
        contentType: att.contentType || att.file?.type,
        content: [],  // required by fromThreadMessageLike; att.content.map() crashes if missing
        status: { type: "complete" },
      }));

      const newMessage = {
        id: uuidv4(),
        type: "human" as const,
        content,
        additional_kwargs: {
          metadata: {
            ...(quote ? { quote } : {}),
            ...(attachmentsMeta ? { attachments: attachmentsMeta } : {}),
          }
        }
      };

      let optimisticContent: string | any[];
      if (!hasNonText && textParts.length === 1) {
        optimisticContent = textParts[0].text;
      } else {
        const cleanContent = parts.map((p: any) => {
          if (p.type === "text") return { type: "text" as const, text: p.text };
          if (p.type === "image") return { type: "image_url" as const, image_url: { url: p.image } };
          if (p.type === "image_url") {
            const url = p.image_url?.url || "";
            if (url.startsWith("data:image/") || !url.startsWith("data:")) {
              return { type: "image_url" as const, image_url: p.image_url };
            }
          }
          return null;
        }).filter(Boolean);

        optimisticContent = cleanContent.length === 1 && cleanContent[0]?.type === "text"
          ? cleanContent[0].text
          : cleanContent;
      }

      const optimisticMessage = {
        ...newMessage,
        content: optimisticContent,
      };

      await stream.submit(
        { messages: [newMessage] },
        {
          optimisticValues: (prev: any) => ({
            ...prev,
            messages: [...(prev.messages ?? []), optimisticMessage],
          }),
          streamSubgraphs: true,
          metadata: {
            workflow_id: workflowId,
            user_id: userId || undefined,
          },
          config: {
            ...(assistantConfig ?? {}),
            recursion_limit: 200,
            configurable: {
              ...(assistantConfig?.configurable ?? {}),
              platform: "web",
              voice_mode: voiceModeRef.current,
              voice_input: parts.some((p: any) => p.type === "audio" || p.type === "input_audio"),
              workflow_id: workflowId,
              user_id: userId || undefined,
            },
          },
        }
      );
    },
    onEdit: async (msg) => {
      const parentId = msg.parentId;
      let parentCheckpoint = undefined;
      if (parentId && stream.history) {
        for (const state of stream.history) {
          const msgs = (state.values as any)?.messages || [];
          if (msgs.length > 0 && msgs[msgs.length - 1].id === parentId) {
            parentCheckpoint = state.checkpoint;
            break;
          }
        }
      }

      if (!parentCheckpoint && parentId && stream.history) {
        for (const state of stream.history) {
          const msgs = (state.values as any)?.messages || [];
          if (msgs.some((m: any) => m.id === parentId)) {
            parentCheckpoint = state.checkpoint;
            break;
          }
        }
      }

      // Extract text content from the assistant-ui AppendMessage
      const parts = [...msg.content, ...(msg.attachments?.flatMap((a: any) => a.content) ?? [])];
      let content: string | any[];
      const textParts = parts.filter((p: any) => p.type === "text");
      const hasNonText = parts.some((p: any) => p.type === "image" || p.type === "image_url" || p.type === "file" || p.type === "audio" || p.type === "video");

      if (!hasNonText && textParts.length === 1) {
        content = textParts[0].text;
      } else {
        content = parts.map((p: any) => {
          if (p.type === "text") return { type: "text" as const, text: p.text };
          if (p.type === "image") return { type: "image_url" as const, image_url: { url: p.image } };
          if (p.type === "image_url") return { type: "image_url" as const, image_url: p.image_url };
          if (p.type === "audio") return { type: "audio" as const, audio: p.audio, filename: p.filename, mimeType: p.mimeType };
          if (p.type === "video") return { type: "video" as const, video: p.video, filename: p.filename, mimeType: p.mimeType };
          if (p.type === "input_audio") return null;
          if (p.type === "file") {
            try {
              const base64Str = p.data.split(",")[1];
              const isTextFile = p.mimeType.startsWith("text/") || 
                p.filename?.endsWith(".txt") || 
                p.filename?.endsWith(".md") || 
                p.filename?.endsWith(".json") || 
                p.filename?.endsWith(".js") || 
                p.filename?.endsWith(".ts") || 
                p.filename?.endsWith(".tsx");

              if (isTextFile) {
                const binString = atob(base64Str);
                const bytes = Uint8Array.from(binString, (c) => c.charCodeAt(0));
                const text = new TextDecoder().decode(bytes);
                return {
                  type: "text" as const,
                  text: `\n\n[Attached text file: ${p.filename}]\n${text}`
                };
              }
            } catch (err) {
              console.warn("Failed to decode file attachment text content:", err);
            }
            return {
              type: "file" as const,
              file: {
                file_data: p.data
              }
            };
          }
          return null;
        }).filter(Boolean);
      }

      const quote = (msg as any).metadata?.custom?.quote;
      const attachmentsMeta = msg.attachments?.map((att: any) => ({
        id: att.id,
        name: att.name,
        type: att.type,
        contentType: att.contentType || att.file?.type,
        content: [],  // required by fromThreadMessageLike; att.content.map() crashes if missing
        status: { type: "complete" },
      }));

      const newMessage = {
        id: uuidv4(),
        type: "human" as const,
        content,
        additional_kwargs: {
          metadata: {
            ...(quote ? { quote } : {}),
            ...(attachmentsMeta ? { attachments: attachmentsMeta } : {}),
          }
        }
      };

      let optimisticContent: string | any[];
      if (!hasNonText && textParts.length === 1) {
        optimisticContent = textParts[0].text;
      } else {
        const cleanContent = parts.map((p: any) => {
          if (p.type === "text") return { type: "text" as const, text: p.text };
          if (p.type === "image") return { type: "image_url" as const, image_url: { url: p.image } };
          if (p.type === "image_url") {
            const url = p.image_url?.url || "";
            if (url.startsWith("data:image/") || !url.startsWith("data:")) {
              return { type: "image_url" as const, image_url: p.image_url };
            }
          }
          return null;
        }).filter(Boolean);

        optimisticContent = cleanContent.length === 1 && cleanContent[0]?.type === "text"
          ? cleanContent[0].text
          : cleanContent;
      }

      const optimisticMessage = {
        ...newMessage,
        content: optimisticContent,
      };

      await stream.submit(
        { messages: [newMessage] },
        {
          checkpoint: parentCheckpoint,
          optimisticValues: (prev: any) => {
            const filteredMsgs = (prev?.messages ?? []).filter((m: any) => {
              const idx = (prev?.messages ?? []).findIndex((x: any) => x.id === parentId);
              return idx !== -1 ? (prev?.messages ?? []).slice(0, idx + 1) : true;
            });
            return {
              ...prev,
              messages: [...filteredMsgs, optimisticMessage],
            };
          },
          streamSubgraphs: true,
          metadata: {
            workflow_id: workflowId,
            user_id: userId || undefined,
          },
          config: {
            ...(assistantConfig ?? {}),
            recursion_limit: 200,
            configurable: {
              ...(assistantConfig?.configurable ?? {}),
              platform: "web",
              voice_mode: voiceModeRef.current,
              workflow_id: workflowId,
              user_id: userId || undefined,
            },
          },
        }
      );
    },
    onReload: async (parentId) => {
      let parentCheckpoint = undefined;
      if (parentId && stream.history) {
        for (const state of stream.history) {
          const msgs = (state.values as any)?.messages || [];
          if (msgs.length > 0 && msgs[msgs.length - 1].id === parentId) {
            parentCheckpoint = state.checkpoint;
            break;
          }
        }
      }

      if (!parentCheckpoint && parentId && stream.history) {
        for (const state of stream.history) {
          const msgs = (state.values as any)?.messages || [];
          if (msgs.some((m: any) => m.id === parentId)) {
            parentCheckpoint = state.checkpoint;
            break;
          }
        }
      }

      await stream.submit(
        null,
        {
          checkpoint: parentCheckpoint,
          streamSubgraphs: true,
          metadata: {
            workflow_id: workflowId,
            user_id: userId || undefined,
          },
          config: {
            ...(assistantConfig ?? {}),
            recursion_limit: 200,
            configurable: {
              ...(assistantConfig?.configurable ?? {}),
              platform: "web",
              voice_mode: voiceModeRef.current,
              workflow_id: workflowId,
              user_id: userId || undefined,
            },
          },
        }
      );
    },
    onCancel: async () => {
      await stream.stop();
    },
    adapters: {
      attachments: attachmentAdapter,
      threadList: {
        threadId: threadId ?? undefined,
        threads: (threads?.data?.flat() ?? []).map((t: any) => ({
          id: t.id,
          title: t.title,
          status: "normal",
          lastMessageAt: t.updatedAt,
        })),
        onSwitchToNewThread: async () => {
          await setThreadId(null);
        },
        onSwitchToThread: async (id: string) => {
          await setThreadId(id);
        },
        onDelete: async (id: string) => {
          const threadItem = (threads?.data?.flat() ?? []).find((t: any) => t.id === id);
          const status = threadItem?.status || "idle";
          const mockEvent = { stopPropagation: () => {} } as any;
          await handleDeleteThread(id, status, mockEvent);
        },
      },
    },
  });

  const streamInterrupts: any[] | undefined = (stream as any).interrupts;
  const streamInterrupt: any = (stream as any).interrupt;
  const interrupts: any[] = useMemo(() => {
    if (Array.isArray(streamInterrupts)) return streamInterrupts.filter((i) => i != null);
    return streamInterrupt ? [streamInterrupt] : [];
  }, [streamInterrupts, streamInterrupt]);

  const contextValue = useMemo(() => ({
    isLoading: stream.isLoading,
    isThreadLoading: stream.isThreadLoading,
    submitRef,
    interrupts,
    resumeInterrupt,
    voiceMode,
    setVoiceMode,
    newThread,
    threadId: threadId ?? null,
    workflowId: workflowId ?? null,
  }), [stream.isLoading, stream.isThreadLoading, submitRef, interrupts, resumeInterrupt, voiceMode, setVoiceMode, newThread, threadId, workflowId]);

  return (
    <LangGraphRuntimeContext.Provider value={contextValue}>
      <AssistantRuntimeProvider runtime={runtime}>
        {children}
      </AssistantRuntimeProvider>
    </LangGraphRuntimeContext.Provider>
  );
}
