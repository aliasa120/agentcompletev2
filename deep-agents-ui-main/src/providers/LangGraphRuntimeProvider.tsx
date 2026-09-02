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
import {
  readVoiceMode,
  writeVoiceMode,
  migratePendingMode,
  type VoiceMode,
} from "@/lib/voice-mode";

// ── Audio replies extracted from late-polled server state (bypasses converter cache) ──
export type AudioReplyEntry = { url: string; voice: boolean; provider?: string };
export type AudioRepliesMap = Map<string, AudioReplyEntry[]>;

/** Extract AUDIO_URL/VOICE/PROVIDER markers from a raw message content string or array. */
function extractAudioFromContent(content: any): AudioReplyEntry[] {
  const audios: AudioReplyEntry[] = [];
  const seenUrls = new Set<string>();
  let isVoice = false;
  let provider: string | undefined;

  const scanLine = (line: string) => {
    const trimmed = line.trim();
    const vm = trimmed.match(/AUDIO_VOICE:(true|false)/);
    if (vm) isVoice = vm[1] === "true";
    const pm = trimmed.match(/AUDIO_PROVIDER:(\S+)/);
    if (pm) provider = pm[1];
    const um = trimmed.match(/AUDIO_URL:(\S+)/);
    if (um) {
      const url = um[1];
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        audios.push({ url, voice: isVoice, provider });
      }
    }
  };

  if (typeof content === "string") {
    content.split("\n").forEach(scanLine);
  } else if (Array.isArray(content)) {
    content.forEach((part: any) => {
      if (part?.type === "text" && typeof part.text === "string") {
        part.text.split("\n").forEach(scanLine);
      }
    });
  }
  return audios;
}

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
  /**
   * Audio replies extracted directly from the server-polled state AFTER the
   * run finishes. Keyed by message ID. Used by AudioReplyList as a fallback
   * when the message converter's cache didn't re-process the updated message.
   */
  audioRepliesMap: AudioRepliesMap;
  /** Message IDs currently undergoing async TTS synthesis (web mirror). */
  ttsPendingSet: Set<string>;
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
  const [voiceModeState, setVoiceModeState] = useState<VoiceMode>(() =>
    readVoiceMode(threadId ?? null),
  );
  // `voiceModeState` is the single source of truth. The old expression
  // `threadId ? voiceModeState : (readVoiceMode(null) ?? voiceModeState)` was
  // wrong: readVoiceMode(null) ALWAYS returns "voice_only" (never null), so a
  // fresh chat was locked to "voice_only" and a mode set by /voice-tts BEFORE
  // the thread existed (the first message) was clobbered back to voice_only.
  const voiceMode = voiceModeState;
  useEffect(() => {
    // When a thread is created, migrate a voice mode chosen BEFORE the thread
    // existed (sessionStorage slot) onto the thread's localStorage key so it is
    // not lost on the first message (e.g. /voice-tts typed as the first message
    // of a brand-new chat). Without this the mode silently reset to voice_only.
    if (threadId) {
      const pending = migratePendingMode(threadId);
      if (pending) {
        setVoiceModeState(pending);
        return;
      }
    }
    setVoiceModeState(readVoiceMode(threadId ?? null));
  }, [threadId]);
  const setVoiceMode = useCallback(
    (mode: VoiceMode) => {
      writeVoiceMode(threadId ?? null, mode);
      setVoiceModeState(mode);
      // Update the ref SYNCHRONOUSLY so a message sent in the same tick as the
      // slash command (before React re-renders) already carries the new mode.
      voiceModeRef.current = mode;
    },
    [threadId],
  );
  const voiceModeRef = useRef<VoiceMode>("voice_only");
  voiceModeRef.current = voiceMode;

  // Always-current thread id for the async TTS trigger. triggerAsyncTts is
  // captured by onFinish at submit time (when threadId is still null on the
  // first message), so reading `threadId` from the closure bails out early
  // with "no threadId" and the first /voice-tts reply never gets audio.
  const threadIdRef = useRef<string | null>(threadId ?? null);
  threadIdRef.current = threadId ?? null;
  // Keep the attachment adapter's thread context in sync so R2 uploads land
  // in thread-wise folders (null only for a brand-new chat's first attachment).
  attachmentAdapter.threadId = threadId ?? null;

  // In-memory cache of threadId -> messages array for instant 0ms switching
  const threadMessagesCacheRef = useRef<Map<string, any[]>>(new Map());

  // Track the threadId actively streaming to strictly prevent cross-thread message leakage
  const streamingThreadIdRef = useRef<string | null>(null);

  // Sync threadMessagesCacheRef with preloaded messages from the threads list query
  useEffect(() => {
    const list = (threads?.data?.flat() ?? []) as any[];
    for (const t of list) {
      if (t?.id && Array.isArray(t?.messages) && t.messages.length > 0) {
        const existing = threadMessagesCacheRef.current.get(t.id);
        if (!existing || existing.length <= t.messages.length) {
          threadMessagesCacheRef.current.set(t.id, t.messages);
        }
      }
    }
  }, [threads?.data]);

  // ── Post-run authoritative re-sync + async web TTS ──────────────────────────
  // Web does NOT block the run on TTS: finalize_response skips synthesis and
  // returns immediately. After streaming ends we decide per-assistant-message
  // whether it needs audio (voice_mode + voice_input) and synthesize in the
  // background via POST /api/tts, anchoring each result strictly to its
  // messageId so "how are you" audio never lands under "kya haal hai".
  const [syncedThreadData, setSyncedThreadData] = useState<{
    threadId: string | null;
    messages: any[];
  }>({ threadId: null, messages: [] });
  const [persistedInterrupts, setPersistedInterrupts] = useState<any[]>([]);

  // Cancel handle for the active poll loop (cleared on unmount / new thread).
  const pollCancelRef = useRef<(() => void) | null>(null);

  // Audio entries keyed by messageId (or thread+message external key when IDs
  // drift). No "__latest__" — every player is strictly per-message.
  const [audioRepliesMap, setAudioRepliesMap] = useState<AudioRepliesMap>(new Map());

  // Prevent duplicate POST /api/tts for the same messageId in this session.
  const ttsDoneRef = useRef<Set<string>>(new Set());
  const ttsInflightRef = useRef<Set<string>>(new Set());
  const [ttsPendingSet, setTtsPendingSet] = useState<Set<string>>(new Set());
  // Per-human voice flag for the async path (exact pairing, durable across rapid messages)
  const humanVoiceMapRef = useRef<Map<string, boolean>>(new Map());

  const hasAudioMarker = useCallback((msgs: any[]): boolean => {
    return msgs.some((m: any) => {
      const c = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
      return c.includes("AUDIO_URL:") || c.includes("FILE_URL:");
    });
  }, []);

  function getMessageText(raw: any): string {
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw)) {
      const parts: string[] = [];
      for (const p of raw) {
        if (!p) continue;
        if (typeof p.text === "string") parts.push(p.text);
        else if (typeof p.label === "string") parts.push(p.label);
        else if (typeof p.content === "string") parts.push(p.content);
        else if (p.type === "directive" && typeof p.id === "string") parts.push(p.id);
      }
      if (parts.length > 0) return parts.join("\n");
      try { return JSON.stringify(raw); } catch { return ""; }
    }
    if (raw && typeof raw === "object") {
      try { return JSON.stringify(raw); } catch { return String(raw); }
    }
    return "";
  }

  const audioRepliesMapRef = useRef(audioRepliesMap);
  useEffect(() => { audioRepliesMapRef.current = audioRepliesMap; }, [audioRepliesMap]);

  const triggerAsyncTts = useCallback(async (
    targetMessageId: string,
    rawContent: any,
    /** Extra message IDs (e.g. turn-root IDs from intermediate tool-call AI messages)
     *  that should also receive this audio entry so the player shows regardless of
     *  how assistant-ui groups messages into a single AssistantMessage. */
    extraIds?: string[],
  ) => {
    const currentThreadId = threadIdRef.current;
    if (!currentThreadId) {
      console.warn(`[tts] skip ${targetMessageId}: no threadId`);
      return;
    }
    if (ttsDoneRef.current.has(targetMessageId) || ttsInflightRef.current.has(targetMessageId)) {
      console.log(`[tts] skip ${targetMessageId}: already done/inflight`);
      return;
    }
    const existing = audioRepliesMapRef.current.get(targetMessageId);
    if (existing && existing.length > 0) { ttsDoneRef.current.add(targetMessageId); return; }

    const text = getMessageText(rawContent).trim();
    if (!text || text.includes("AUDIO_URL:")) {
      console.log(`[tts] skip ${targetMessageId}: empty or has marker`);
      ttsDoneRef.current.add(targetMessageId);
      return;
    }

    console.log(`[tts] ▶ start ${targetMessageId} len=${text.length} mode=${voiceModeRef.current}`);
    ttsInflightRef.current.add(targetMessageId);
    setTtsPendingSet(prev => { const n = new Set(prev); n.add(targetMessageId); return n; });
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text.slice(0, 3000),
          messageId: targetMessageId,
          threadId: currentThreadId,
          platform: "web",
          purpose: "mirror",
          maxChars: 3000,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.url) {
        console.error(`[tts] ❌ synthesis failed for ${targetMessageId}:`, data, `status=${res.status}`);
        // allow retry next time
        return;
      }
      console.log(`[tts] ✅ success ${targetMessageId} provider=${data.provider} url=${String(data.url).slice(0,60)}`);
      const entry: AudioReplyEntry = { url: data.url, voice: false, provider: data.provider };
      setAudioRepliesMap(prev => {
        if (prev.get(targetMessageId)?.some(a => a.url === entry.url)) return prev;
        const next = new Map(prev);
        next.set(targetMessageId, [entry]);
        // Also store under turn-root / intermediate AI message IDs so the
        // audio player shows even when assistant-ui collapses the whole
        // tool-call chain into a single AssistantMessage keyed by the first ID.
        if (extraIds) {
          for (const xId of extraIds) {
            if (xId && xId !== targetMessageId && !next.get(xId)?.some(a => a.url === entry.url)) {
              next.set(xId, [entry]);
            }
          }
        }
        return next;
      });
      ttsDoneRef.current.add(targetMessageId);
      if (extraIds) extraIds.forEach(xId => { if (xId) ttsDoneRef.current.add(xId); });
    } catch (e) {
      console.error(`[tts] ❌ request error for ${targetMessageId}:`, e);
    } finally {
      ttsInflightRef.current.delete(targetMessageId);
      setTtsPendingSet(prev => { const n = new Set(prev); n.delete(targetMessageId); return n; });
    }
  }, []);

  function shouldTriggerTts(assistantIdx: number, allMessages: any[]): boolean {
    if (voiceModeRef.current === "off") {
      console.log(`[tts] skip: voiceMode off for idx ${assistantIdx}`);
      return false;
    }
    // Find the most recent human before this assistant message
    let lastHuman: any = null;
    for (let i = assistantIdx - 1; i >= 0; i--) {
      const m = allMessages[i];
      const role = m?.role || m?.type;
      if (role === "human" || role === "user") { lastHuman = m; break; }
    }
    const humanText = getMessageText(lastHuman?.content ?? "").toLowerCase();
    const isVoiceCmd = humanText.includes("/voice-tts") || humanText.includes("/voice-on") || humanText.includes("voice-tts") || humanText.includes("voice-on");
    if (voiceModeRef.current === "all") {
      console.log(`[tts] eligible: mode=all idx=${assistantIdx} human="${humanText.slice(0,40)}"`);
      return true;
    }
    if (isVoiceCmd) {
      console.log(`[tts] eligible: voice cmd idx=${assistantIdx}`);
      return true;
    }
    let wasVoiceInput = false;
    if (lastHuman?.id && humanVoiceMapRef.current.has(lastHuman.id)) {
      wasVoiceInput = humanVoiceMapRef.current.get(lastHuman.id) === true;
    } else {
      if ((lastHuman as any)?.voice_input) wasVoiceInput = true;
      const c = lastHuman?.content;
      if (Array.isArray(c)) {
        for (const b of c) if (b?.type === "audio" || b?.type === "input_audio") { wasVoiceInput = true; break; }
      }
      if ((lastHuman as any)?.additional_kwargs?.metadata?.voice_input) wasVoiceInput = true;
    }
    console.log(`[tts] check idx=${assistantIdx} mode=${voiceModeRef.current} wasVoice=${wasVoiceInput} human="${humanText.slice(0,40)}"`);
    return wasVoiceInput;
  }

  /**
   * Fetch thread messages and interrupts with dual-tier fallback:
   * 1. Try client.threads.getState(threadId) for active checkpoints/tasks.
   * 2. If messages are empty (idle/completed checkpoints in dev server), fall back
   *    to client.threads.get(threadId) which contains the authoritative values.messages.
   */
  const fetchThreadMessagesAndInterrupts = useCallback(
    async (targetThreadId: string): Promise<{ msgs: any[]; interrupts: any[] }> => {
      if (!client || !targetThreadId) return { msgs: [], interrupts: [] };
      let stateMsgs: any[] = [];
      let threadMsgs: any[] = [];
      let interrupts: any[] = [];

      try {
        const state: any = await client.threads.getState(targetThreadId);
        if (state?.values?.messages && Array.isArray(state.values.messages) && state.values.messages.length > 0) {
          stateMsgs = state.values.messages;
        }
        if (Array.isArray(state?.interrupts) && state.interrupts.length > 0) {
          interrupts.push(...state.interrupts);
        }
        if (Array.isArray(state?.tasks)) {
          for (const task of state.tasks) {
            if (Array.isArray(task?.interrupts) && task.interrupts.length > 0) {
              interrupts.push(...task.interrupts);
            }
          }
        }
      } catch (err) {
        console.warn(`[LangGraphRuntime] getState failed for ${targetThreadId}:`, err);
      }

      try {
        const threadData: any = await client.threads.get(targetThreadId);
        if (threadData?.values?.messages && Array.isArray(threadData.values.messages) && threadData.values.messages.length > 0) {
          threadMsgs = threadData.values.messages;
        }
        if (Array.isArray(threadData?.interrupts) && threadData.interrupts.length > 0) {
          interrupts.push(...threadData.interrupts);
        }
      } catch (err) {
        console.warn(`[LangGraphRuntime] threads.get failed for ${targetThreadId}:`, err);
      }

      // Pick whichever source has more messages (stateMsgs for active runs, threadMsgs for completed/idle threads)
      let msgs = stateMsgs.length >= threadMsgs.length ? stateMsgs : threadMsgs;

      // Fallback: If both returned empty, check the memory cache
      if (msgs.length === 0) {
        const cached = threadMessagesCacheRef.current.get(targetThreadId);
        if (cached && cached.length > 0) {
          msgs = cached;
        }
      }

      // Update cache
      if (msgs.length > 0) {
        threadMessagesCacheRef.current.set(targetThreadId, msgs);
      }

      return { msgs, interrupts };
    },
    [client],
  );

  /**
   * Poll or fetch the server thread state.
   */
  const syncFromServer = useCallback(async (opts?: { poll?: boolean; targetThreadId?: string }) => {
    const currentTargetId = opts?.targetThreadId ?? threadIdRef.current;
    if (!currentTargetId || !client) return;
    const shouldPoll = opts?.poll ?? false;
    const POLL_INTERVAL_MS = 3000;
    const POLL_MAX_MS = 60_000;

    pollCancelRef.current?.();
    let cancelled = false;
    pollCancelRef.current = () => { cancelled = true; };

    const deadline = Date.now() + POLL_MAX_MS;
    let attempt = 0;

    const tick = async () => {
      if (cancelled || currentTargetId !== threadIdRef.current) return;
      attempt++;
      try {
        const { msgs, interrupts } = await fetchThreadMessagesAndInterrupts(currentTargetId);
        if (cancelled || currentTargetId !== threadIdRef.current) return;

        if (Array.isArray(interrupts) && interrupts.length > 0) {
          setPersistedInterrupts(interrupts);
        } else {
          setPersistedInterrupts([]);
        }

        // Commit synced messages strictly for the target thread ID
        setSyncedThreadData({ threadId: currentTargetId, messages: msgs });

        if (Array.isArray(msgs) && msgs.length > 0 && hasAudioMarker(msgs)) {
          setAudioRepliesMap(prev => {
            const next = new Map(prev);
            let changed = false;
            for (const m of msgs) {
              if (!m?.id) continue;
              const entries = extractAudioFromContent(m.content);
              if (entries.length > 0) {
                const existing = next.get(m.id);
                if (!existing || existing.length !== entries.length || existing[0]?.url !== entries[0]?.url) {
                  next.set(m.id, entries);
                  changed = true;
                  ttsDoneRef.current.add(m.id);
                }
              }
            }
            return changed ? next : prev;
          });
          return;
        }

        if (shouldPoll && Date.now() < deadline && !cancelled && currentTargetId === threadIdRef.current) {
          setTimeout(tick, POLL_INTERVAL_MS);
        }
      } catch (err) {
        console.warn(`[LangGraphRuntime] sync attempt ${attempt} failed:`, err);
        if (shouldPoll && Date.now() < deadline && !cancelled && currentTargetId === threadIdRef.current) {
          setTimeout(tick, POLL_INTERVAL_MS);
        }
      }
    };

    // Execute immediately without artificial setTimeout delay
    void tick();
  }, [client, fetchThreadMessagesAndInterrupts, hasAudioMarker]);

  useEffect(() => {
    pollCancelRef.current?.();
    pollCancelRef.current = null;
    setPersistedInterrupts([]);
    setAudioRepliesMap(new Map());
    ttsDoneRef.current.clear();
    ttsInflightRef.current.clear();
    setTtsPendingSet(new Set());
    humanVoiceMapRef.current.clear();
    setResumedInterrupts(false);
    setActedInterruptIds(new Set());

    if (threadId) {
      // INSTANT HYDRATION: If we have preloaded/cached messages for this thread, use them immediately!
      const cachedMsgs = threadMessagesCacheRef.current.get(threadId) || [];
      setSyncedThreadData({ threadId, messages: cachedMsgs });
      void syncFromServer({ poll: false, targetThreadId: threadId });
    } else {
      setSyncedThreadData({ threadId: null, messages: [] });
    }
  }, [threadId, syncFromServer]);

  // Cleanup on unmount.
  useEffect(() => () => { pollCancelRef.current?.(); }, []);

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
      streamingThreadIdRef.current = null;
      onHistoryRevalidate?.();
      onStreamFinish?.();
      void syncFromServer({ poll: true });
      setTimeout(() => { void processCompletedMessagesForTts(); }, 400);
    },
    onError: (_err: any) => {
      streamingThreadIdRef.current = null;
      onStreamFinish?.();
      void syncFromServer({ poll: true });
      setTimeout(() => { void processCompletedMessagesForTts(); }, 400);
    },
    onCreated: (run: any) => {
      if (run?.thread_id) {
        streamingThreadIdRef.current = run.thread_id;
      }
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

  // Scan finished assistant messages and trigger async TTS for those that need it.
  // NOTE: read the authoritative SERVER state via client.threads.getState() —
  // `stream.messages` is cleared to [] after the run finishes, so the old scan
  // saw msgs=0 and never fired the async TTS.
  const processCompletedMessagesForTts = useCallback(async () => {
    const currentThreadId = threadIdRef.current;
    if (!currentThreadId || !client) {
      console.warn(`[tts] processCompletedMessagesForTts: no threadId/client`);
      return;
    }

    const scan = (msgs: any[]): void => {
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const role = m?.role || m?.type;
        if (!(role === "assistant" || role === "ai")) continue;
        const id = m?.id;
        if (!id) {
          console.log(`[tts] skip idx ${i}: no id`);
          continue;
        }
        // Skip intermediate AI steps. An AI message that issued tool calls only
        // carries the pre-tool "thinking" preamble; the real answer arrives in a
        // later AI message with no tool_calls. Synthesize ONLY that final answer.
        const toolCalls = m?.tool_calls;
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          console.log(`[tts] skip ${id}: has ${toolCalls.length} tool call(s) — intermediate step`);
          ttsDoneRef.current.add(id);
          continue;
        }
        const rawContent = m?.content;
        const contentStr = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? "");
        console.log(`[tts] candidate idx=${i} id=${id} hasUrl=${contentStr.includes("AUDIO_URL:")} preview=${contentStr.slice(0,80)}`);
        if (contentStr.includes("AUDIO_URL:")) { ttsDoneRef.current.add(id); continue; }
        if (ttsDoneRef.current.has(id) || ttsInflightRef.current.has(id)) {
          console.log(`[tts] skip ${id}: already done/inflight`);
          continue;
        }
        if (audioRepliesMapRef.current.has(id)) { ttsDoneRef.current.add(id); continue; }
        let eligible = false;
        try { eligible = shouldTriggerTts(i, msgs); } catch (e) { console.warn(`[tts] shouldTrigger error`, e); eligible = false; }
        console.log(`[tts] eligible=${eligible} for ${id}`);
        if (!eligible) { ttsDoneRef.current.add(id); continue; }
        // Hard guard: if text is directive-only (e.g. ":command[/voice-tts]"), don't synthesize empty.
        const txt = getMessageText(rawContent).trim();
        if (!txt || txt === ":command[/voice-tts]" || txt.startsWith(":command")) {
          console.log(`[tts] skip ${id}: directive-only text="${txt.slice(0,60)}"`);
          ttsDoneRef.current.add(id);
          continue;
        }

        // ── Collect intermediate AI message IDs from this tool-call turn ──────
        // assistant-ui may group the entire tool-call chain (intermediate AI +
        // tool results + final AI) into ONE AssistantMessage keyed by the FIRST
        // AI message's id. We store the audio under all those IDs so the player
        // appears regardless of which id `s.message.id` returns in AudioReplyList.
        const turnRootIds: string[] = [];
        for (let j = i - 1; j >= 0; j--) {
          const prev = msgs[j];
          const prevRole = prev?.role || prev?.type;
          // Don't cross human-message boundaries (different conversation turns)
          if (prevRole === "human" || prevRole === "user") break;
          // Skip tool-result messages — they sit between AI steps
          if (prevRole === "tool") continue;
          if (prevRole === "assistant" || prevRole === "ai") {
            const prevToolCalls = prev?.tool_calls;
            if (Array.isArray(prevToolCalls) && prevToolCalls.length > 0 && prev?.id) {
              turnRootIds.push(prev.id);
              // Keep walking back to find even earlier AI steps in a multi-round chain
              continue;
            }
          }
          break;
        }
        if (turnRootIds.length > 0) {
          console.log(`[tts] turn-root ids for ${id}:`, turnRootIds);
        }

        void triggerAsyncTts(id, rawContent, turnRootIds.length > 0 ? turnRootIds : undefined);
      }
    };

    // The run has finished, but the checkpoint can take a beat to be readable;
    // retry briefly so the final assistant message is present when we scan.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        let msgs: any[] = [];
        try {
          const state: any = await client.threads.getState(currentThreadId);
          msgs = state?.values?.messages ?? [];
        } catch (e) {}
        if (msgs.length === 0) {
          try {
            const threadData: any = await client.threads.get(currentThreadId);
            msgs = threadData?.values?.messages ?? [];
          } catch (e) {}
        }
        console.log(`[tts] processCompletedMessagesForTts attempt=${attempt} msgs=${msgs.length}`);
        const hasAssistant = msgs.some(
          (m: any) => (m?.role || m?.type) === "assistant" || (m?.role || m?.type) === "ai",
        );
        if (hasAssistant) {
          scan(msgs);
          return;
        }
      } catch (e) {
        console.warn(`[tts] getState/get attempt ${attempt} failed:`, e);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1200));
    }
    console.warn(`[tts] processCompletedMessagesForTts: no assistant message found after retries`);
  }, [triggerAsyncTts, client]);

  // Belt & suspenders: whenever loading flips true → false through ANY path
  // (onFinish, onError, abort, disconnect), kick off polling AND async TTS.
  const prevLoadingRef = useRef(stream.isLoading);
  useEffect(() => {
    const was = prevLoadingRef.current;
    const now = stream.isLoading;
    prevLoadingRef.current = now;
    if (was && !now) {
      console.log(`[tts] stream finished (isLoading false->true transition), triggering TTS scan`);
      void syncFromServer({ poll: true });
      // Delay slightly so stream.messages has settled to final values
      setTimeout(() => { void processCompletedMessagesForTts(); }, 400);
    }
  }, [stream.isLoading, syncFromServer, processCompletedMessagesForTts]);

  const [resumedInterrupts, setResumedInterrupts] = useState<boolean>(false);
  const [actedInterruptIds, setActedInterruptIds] = useState<Set<string>>(new Set());

  const getInterruptKey = (intr: any): string => {
    if (!intr) return "";
    const id = intr.id ?? intr.interrupt_id;
    if (id) return String(id);
    const val = intr.value ?? intr;
    const req = val?.action_requests?.[0] ?? val?.action_request ?? val;
    return `${req?.name || "tool"}-${JSON.stringify(req?.args || {})}`;
  };

  // ── Active Interrupts (Live Stream or Restored from Server Checkpoint) ─────
  const streamInterrupts: any[] | undefined = (stream as any).interrupts;
  const streamInterrupt: any = (stream as any).interrupt;
  const activeInterrupts: any[] = useMemo(() => {
    // If a resume was just submitted or stream is currently running/loading, hide old interrupts immediately
    if (resumedInterrupts || stream.isLoading) {
      return [];
    }
    const raw: any[] = [];
    if (Array.isArray(streamInterrupts) && streamInterrupts.length > 0) {
      raw.push(...streamInterrupts.filter((i) => i != null));
    } else if (streamInterrupt) {
      raw.push(streamInterrupt);
    } else if (Array.isArray(persistedInterrupts)) {
      raw.push(...persistedInterrupts.filter((i) => i != null));
    }

    return raw.filter((intr) => {
      const key = getInterruptKey(intr);
      return key ? !actedInterruptIds.has(key) : true;
    });
  }, [streamInterrupts, streamInterrupt, persistedInterrupts, resumedInterrupts, actedInterruptIds, stream.isLoading]);

  // Reset resumedInterrupts flag when loading finishes so future interrupts can display
  useEffect(() => {
    if (!stream.isLoading) {
      setResumedInterrupts(false);
    }
  }, [stream.isLoading]);

  // When live interrupts arrive, immediately sync thread state
  useEffect(() => {
    if (activeInterrupts.length > 0) {
      void syncFromServer({ poll: false });
    }
  }, [activeInterrupts.length, syncFromServer]);

  const resumeInterrupt = useCallback(
    (payload: any, interruptId?: string) => {
      const pending: any[] = (stream as any).interrupts ?? persistedInterrupts;
      const isDecisionPayload = payload && typeof payload === "object" && (Array.isArray(payload.decisions) || "decisions" in payload);
      const resume =
        !isDecisionPayload && interruptId && pending.length > 1 ? { [interruptId]: payload } : payload;


      // Mark all current active interrupts as acted upon permanently so they never reappear
      setActedInterruptIds((prev) => {
        const next = new Set(prev);
        for (const intr of pending) {
          const key = getInterruptKey(intr);
          if (key) next.add(key);
        }
        if (interruptId) next.add(interruptId);
        return next;
      });

      // Optimistically clear interrupts and mark resumed so UI hides the card instantly
      setResumedInterrupts(true);
      setPersistedInterrupts([]);

      return stream.submit(null, {
        command: { resume },
        streamSubgraphs: true,
        streamMode: ["values", "messages-tuple", "updates", "tasks", "custom"],
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
    [stream, activeInterrupts, workflowId, userId, assistantConfig],
  );

  const newThread = useCallback(() => {
    void setThreadId(null);
  }, [setThreadId]);

  // ── Expose stream.submit via ref for programmatic sends ───────────────────────
  useEffect(() => {
    submitRef.current = (input: any, options?: any) => {
      streamingThreadIdRef.current = threadId ?? null;
      return stream.submit(input, {
        streamSubgraphs: true,
        streamMode: ["values", "messages", "updates", "custom"],
        ...options,
        onError: (_err: any, _run: any) => {
          streamingThreadIdRef.current = null;
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
  }, [submitRef, stream.submit, workflowId, userId, assistantConfig, onStreamError, onHistoryRevalidate, threadId]);

  // ── Watch for stream errors ────────────────────────────────────────────────────
  const prevErrorRef = useRef<unknown>(undefined);
  useEffect(() => {
    if (stream.error && stream.error !== prevErrorRef.current) {
      prevErrorRef.current = stream.error;
      streamingThreadIdRef.current = null;
      onStreamError?.();
      onHistoryRevalidate?.();
      // Run may have completed server-side even though the stream errored
      // (connection dropped during the long TTS phase); pull the markers from
      // the persisted state.
      void syncFromServer();
    }
  }, [stream.error, onStreamError, onHistoryRevalidate, syncFromServer]);


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
          streamingThreadIdRef.current = threadId;
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
          await stream.joinStream(activeRun.run_id, undefined, {
            streamMode: ["values", "messages-tuple", "updates", "tasks", "custom"],
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

  // ── Authoritative Thread Message Resolution ──────────────────────────────────
  // Uses syncedThreadData as the single source of truth when idle, and stream.messages
  // ONLY when actively streaming a run FOR THIS SPECIFIC THREAD.
  // This completely prevents cross-thread message accumulation and blank flashes.
  const mergedStreamMessages = useMemo(() => {
    const isCurrentThreadSynced = syncedThreadData.threadId === (threadId ?? null);
    const syncedMsgs = isCurrentThreadSynced && Array.isArray(syncedThreadData.messages)
      ? syncedThreadData.messages.filter(Boolean)
      : [];

    // If actively streaming a run specifically for the current thread, display live stream messages
    const isStreamingCurrentThread = stream.isLoading && (
      streamingThreadIdRef.current === (threadId ?? null) ||
      (!streamingThreadIdRef.current && !threadId)
    );

    if (isStreamingCurrentThread) {
      const streamMsgs = Array.isArray(stream.messages) ? stream.messages.filter(Boolean) : [];
      if (streamMsgs.length > 0) {
        if (threadId) {
          threadMessagesCacheRef.current.set(threadId, streamMsgs);
        }
        return streamMsgs;
      }
      return syncedMsgs;
    }

    // When idle, syncedThreadData is the single authoritative source of truth for this thread
    if (isCurrentThreadSynced && syncedMsgs.length > 0) {
      return syncedMsgs;
    }

    // Fallback: Check in-memory cache if syncedThreadData is still settling
    if (threadId) {
      const cached = threadMessagesCacheRef.current.get(threadId);
      if (Array.isArray(cached) && cached.length > 0) {
        return cached;
      }
    }

    return syncedMsgs;
  }, [stream.isLoading, stream.messages, syncedThreadData, threadId]);

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

        // Extract AUDIO_URL/AUDIO_VOICE and FILE_URL markers (text_to_speech
        // tool / voice mirror / terminal tool) into message metadata so the UI
        // can render audio players and downloadable file cards, and strip the
        // marker lines from all visible text (assistant messages & tool results).
        if (converted) {
          const audios: { url: string; voice: boolean; provider?: string }[] = [];
          const files: { url: string; name: string }[] = [];
          let isVoice = false;
          let audioProvider: string | undefined = undefined;

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
              const provMatch = trimmed.match(/AUDIO_PROVIDER:(\S+)/);
              if (provMatch) {
                audioProvider = provMatch[1];
                if (/^AUDIO_PROVIDER:\S+\s*$/.test(trimmed)) continue;
              }
              const urlMatch = trimmed.match(/AUDIO_URL:(\S+)/);
              if (urlMatch) {
                audios.push({ url: urlMatch[1], voice: isVoice, provider: audioProvider });
                if (/^AUDIO_URL:\S+\s*$/.test(trimmed)) continue;
              }
              const fileMatch = trimmed.match(/FILE_URL:(\S+)/);
              if (fileMatch) {
                const url = fileMatch[1];
                const name = decodeURIComponent(url.split("/").pop() ?? "file");
                files.push({ url, name });
                if (/^FILE_URL:\S+\s*$/.test(trimmed)) continue;
              }
              const cleanLine = line
                .replace(/AUDIO_VOICE:(true|false)/g, "")
                .replace(/AUDIO_PROVIDER:\S+/g, "")
                .replace(/AUDIO_URL:\S+/g, "")
                .replace(/FILE_URL:\S+/g, "")
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

          if (audios.length > 0 || files.length > 0) {
            converted.metadata = {
              ...(converted.metadata ?? {}),
              custom: {
                ...(converted.metadata?.custom ?? {}),
                audioReplies: [
                  ...(converted.metadata?.custom?.audioReplies ?? []),
                  ...audios,
                ],
                files: [...(converted.metadata?.custom?.files ?? []), ...files],
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
    messages: mergedStreamMessages,
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

      const isVoiceInput = parts.some((p: any) => p.type === "audio" || p.type === "input_audio");
      const newHumanId = uuidv4();
      humanVoiceMapRef.current.set(newHumanId, isVoiceInput);

      const newMessage = {
        id: newHumanId,
        type: "human" as const,
        content,
        additional_kwargs: {
          metadata: {
            ...(quote ? { quote } : {}),
            ...(attachmentsMeta ? { attachments: attachmentsMeta } : {}),
            ...(isVoiceInput ? { voice_input: true } : {}),
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

      // If thread has active interrupts and user sends text in chat instead of clicking popup
      if (activeInterrupts.length > 0) {
        const textOnly = typeof content === "string" ? content.trim().toLowerCase() : "";
        const isAffirmative = ["allow", "always allow", "approve", "yes", "continue", "proceed", "y", "ok", "go ahead", "run"].includes(textOnly);
        const isDeny = ["deny", "no", "cancel", "stop", "reject", "block", "dont", "don't"].includes(textOnly);

        if (isAffirmative) {
          console.log("[LangGraphRuntime] Translating affirmative chat input to interrupt approve decision");
          await resumeInterrupt({ decisions: [{ type: "approve" }] });
          return;
        } else if (isDeny) {
          console.log("[LangGraphRuntime] Translating negative chat input to interrupt reject decision");
          await resumeInterrupt({ decisions: [{ type: "reject", message: typeof content === "string" ? content : "User denied via chat" }] });
          return;
        } else {
          console.log("[LangGraphRuntime] Resuming interrupt with custom user response/feedback");
          await resumeInterrupt({
            decisions: [{
              type: "reject",
              message: typeof content === "string" ? content : JSON.stringify(content),
            }]
          });
          return;
        }
      }

      streamingThreadIdRef.current = threadId ?? null;
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
              voice_input: isVoiceInput,
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

      streamingThreadIdRef.current = threadId ?? null;
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

      streamingThreadIdRef.current = threadId ?? null;
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
      streamingThreadIdRef.current = null;
      const pending: any[] = (stream as any).interrupts ?? persistedInterrupts;
      setActedInterruptIds((prev) => {
        const next = new Set(prev);
        for (const intr of pending) {
          const key = getInterruptKey(intr);
          if (key) next.add(key);
        }
        return next;
      });
      setPersistedInterrupts([]);
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

  const contextValue = useMemo(() => ({
    isLoading: stream.isLoading,
    isThreadLoading: stream.isThreadLoading,
    submitRef,
    interrupts: activeInterrupts,
    resumeInterrupt,
    voiceMode,
    setVoiceMode,
    newThread,
    threadId: threadId ?? null,
    workflowId: workflowId ?? null,
    audioRepliesMap,
    ttsPendingSet,
  }), [stream.isLoading, stream.isThreadLoading, submitRef, activeInterrupts, resumeInterrupt, voiceMode, setVoiceMode, newThread, threadId, workflowId, audioRepliesMap, ttsPendingSet]);

  return (
    <LangGraphRuntimeContext.Provider value={contextValue}>
      <AssistantRuntimeProvider runtime={runtime}>
        {children}
      </AssistantRuntimeProvider>
    </LangGraphRuntimeContext.Provider>
  );
}
