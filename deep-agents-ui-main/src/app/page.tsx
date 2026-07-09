"use client";

import React, { useState, useEffect, useCallback, Suspense, useRef, useMemo } from "react";
import Link from "next/link";
import { useQueryState } from "nuqs";
import { supabase } from "@/lib/supabase";
import { getConfig, saveConfig, StandaloneConfig } from "@/lib/config";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Assistant } from "@langchain/langgraph-sdk";
import { ClientProvider, useClient } from "@/providers/ClientProvider";
import {
  Settings,
  Zap,
  ChevronDown,
  ChevronRight,
  Check,
  PanelLeft,
  Plus,
  Trash2,
} from "lucide-react";
import { useThreads } from "@/app/hooks/useThreads";
import { Client } from "@langchain/langgraph-sdk";
import { LangGraphRuntimeProvider } from "@/providers/LangGraphRuntimeProvider";
import { Thread } from "@/components/assistant-ui/BaseChat";
import { LangGraphAttachmentAdapter } from "@/lib/attachment-adapter";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import {
  ThreadListRoot,
  ThreadListNew,
  ThreadListItems,
} from "@/components/assistant-ui/thread-list";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface HomePageInnerProps {
  config: StandaloneConfig;
}

function HomePageInner({ config }: HomePageInnerProps) {
  const [userEmail, setUserEmail] = useState<string>("");
  const [userId, setUserId] = useState<string>("");
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(true);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        setUserEmail(data.user.email ?? "User");
        setUserId(data.user.id);
      }
    });
  }, []);

  const client = useClient();
  const [threadId, setThreadId] = useQueryState("threadId");

  const [mutateThreads, setMutateThreads] = useState<(() => void) | null>(null);
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [queueBatchSize, setQueueBatchSize] = useState(2);
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(null);

  // SWR threads — filtered by active workflow so only that workflow's history shows
  const threads = useThreads({
    limit: 30,
    userId: userId || undefined,
    workflowId: activeWorkflowId,
  });

  const threadItems = useMemo(() => threads.data?.flat() ?? [], [threads.data]);

  const threadGroups = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).getTime();
    const DAY_IN_MS = 86_400_000;
    const groups: { label: string; items: typeof threadItems }[] = [
      { label: "Today", items: [] },
      { label: "Yesterday", items: [] },
      { label: "Earlier", items: [] },
    ];
    for (const thread of threadItems) {
      const time = new Date(thread.updatedAt).getTime();
      if (time >= startOfToday) groups[0].items.push(thread);
      else if (time >= startOfToday - DAY_IN_MS) groups[1].items.push(thread);
      else groups[2].items.push(thread);
    }
    return groups.filter((g) => g.items.length > 0);
  }, [threadItems]);

  useEffect(() => {
    setMutateThreads(() => threads.mutate);
  }, [threads.mutate]);

  const [queueArticles, setQueueArticles] = useState<any[]>([]);
  const [queueTotalPending, setQueueTotalPending] = useState(0);
  const [isQueueCollapsed, setIsQueueCollapsed] = useState(true);
  const [isWfDropdownOpen, setIsWfDropdownOpen] = useState(false);

  const fetchQueueForSidebar = useCallback(async () => {
    if (!activeWorkflowId) return;
    try {
      const { data: wf } = await supabase
        .from("workflows")
        .select("batch_size")
        .eq("id", activeWorkflowId)
        .single();
      const size = wf?.batch_size ?? 2;
      setQueueBatchSize(size);

      const { data } = await supabase
        .from("feeder_articles")
        .select("id,title,source_domain,created_at,status")
        .eq("status", "Pending")
        .eq("workflow_id", activeWorkflowId)
        .order("created_at", { ascending: true })
        .limit(size);
      setQueueArticles(data ?? []);

      const { count } = await supabase
        .from("feeder_articles")
        .select("id", { count: "exact", head: true })
        .eq("status", "Pending")
        .eq("workflow_id", activeWorkflowId);
      setQueueTotalPending(count ?? 0);
    } catch (e) {
      console.error("Error fetching queue for sidebar:", e);
    }
  }, [activeWorkflowId]);

  useEffect(() => {
    fetchQueueForSidebar();
  }, [fetchQueueForSidebar]);

  useEffect(() => {
    if (!activeWorkflowId) return;
    const channel = supabase
      .channel("sidebar-queue-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "feeder_articles" },
        () => fetchQueueForSidebar()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeWorkflowId, fetchQueueForSidebar]);

  const handleDeleteThread = useCallback(
    async (threadIdToDelete: string, status: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const apiKey =
        config.langsmithApiKey || process.env.NEXT_PUBLIC_LANGSMITH_API_KEY || "";
      const clientObj = new Client({
        apiUrl: config.deploymentUrl,
        defaultHeaders: apiKey ? { "X-Api-Key": apiKey } : {},
      });
      if (confirm("Are you sure you want to delete this chat thread?")) {
        try {
          if (status === "busy") {
            const runs = await clientObj.runs.list(threadIdToDelete, { limit: 10 });
            for (const run of runs) {
              const s = (run as any).status ?? "";
              if (["pending", "running"].includes(s)) {
                await clientObj.runs.cancel(threadIdToDelete, run.run_id);
              }
            }
          }
          await clientObj.threads.delete(threadIdToDelete);
          if (threadIdToDelete === threadId) await setThreadId(null);
          toast.success("Thread deleted successfully");
          // Optimistically mutate thread list cache so it updates instantly in sidebar
          await threads.mutate(
            (prev: any) => prev?.map((page: any) => page.filter((t: any) => t.id !== threadIdToDelete)),
            { revalidate: true }
          );
        } catch (err: any) {
          console.error("Failed to delete thread:", err);
          toast.error("Failed to delete thread: " + (err?.message ?? "unknown error"));
        }
      }
    },
    [threadId, setThreadId, config, threads]
  );

  // ── Refs for programmatic article batch submission ────────────────────────────
  // streamSubmitRef is populated by LangGraphRuntimeProvider with the real stream.submit
  const streamSubmitRef = useRef<((input: any, options?: any) => void) | null>(null);
  const streamingArticleIdRef = useRef<string | null>(null);
  const pendingArticleRef = useRef<{ message: string; articleId: string } | null>(null);

  const fetchAssistant = useCallback(async () => {
    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        config.assistantId
      );
    if (isUUID) {
      try {
        const data = await client.assistants.get(config.assistantId);
        setAssistant(data);
      } catch {
        setAssistant({
          assistant_id: config.assistantId,
          graph_id: config.assistantId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          config: {},
          metadata: {},
          version: 1,
          name: "Assistant",
          context: {},
        });
      }
    } else {
      try {
        const assistants = await client.assistants.search({
          graphId: config.assistantId,
          limit: 100,
        });
        const defaultAssistant = assistants.find(
          (a) => a.metadata?.["created_by"] === "system"
        );
        if (!defaultAssistant) throw new Error("No default assistant found");
        setAssistant(defaultAssistant);
      } catch {
        setAssistant({
          assistant_id: config.assistantId,
          graph_id: config.assistantId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          config: {},
          metadata: {},
          version: 1,
          name: config.assistantId,
          context: {},
        });
      }
    }
  }, [client, config.assistantId]);

  useEffect(() => {
    fetchAssistant();
  }, [fetchAssistant]);

  // Fetch workflows
  useEffect(() => {
    fetch("/api/workflows")
      .then((res) => res.json())
      .then((data) => {
        const list = data.workflows ?? [];
        setWorkflows(list);
        if (list.length > 0) {
          const defaultWf = list.find((w: any) => w.enabled) || list[0];
          setActiveWorkflowId(defaultWf.id);
        }
      })
      .catch((e) => console.error("Failed to load workflows:", e));
  }, []);

  useEffect(() => {
    if (!activeWorkflowId) return;
    const activeWf = workflows.find((w) => w.id === activeWorkflowId);
    if (activeWf) setQueueBatchSize(activeWf.batch_size ?? 2);
  }, [activeWorkflowId, workflows]);

  // Reset thread on workflow change
  const prevWorkflowIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      activeWorkflowId &&
      prevWorkflowIdRef.current !== null &&
      prevWorkflowIdRef.current !== activeWorkflowId
    ) {
      setThreadId(null);
    }
    prevWorkflowIdRef.current = activeWorkflowId;
  }, [activeWorkflowId, setThreadId]);

  // Submit pending article after threadId clears
  useEffect(() => {
    if (pendingArticleRef.current && !threadId && streamSubmitRef.current) {
      const { message, articleId } = pendingArticleRef.current;
      pendingArticleRef.current = null;
      streamingArticleIdRef.current = articleId;
      const newMessage = { id: uuidv4(), type: "human" as const, content: message };
      streamSubmitRef.current(
        { messages: [newMessage] },
        {
          optimisticValues: (prev: any) => ({
            messages: [...(prev.messages ?? []), newMessage],
          }),
        }
      );
      threads.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, activeWorkflowId]);

  // Stream finish/error → update article status
  const handleStreamFinish = useCallback(async () => {
    const articleId = streamingArticleIdRef.current;
    if (!articleId) return;
    streamingArticleIdRef.current = null;
    await supabase.from("feeder_articles").update({ status: "Done" }).eq("id", articleId);
    threads.mutate();
  }, [threads]);

  const handleStreamError = useCallback(async () => {
    const articleId = streamingArticleIdRef.current;
    if (!articleId) return;
    streamingArticleIdRef.current = null;
    await supabase.from("feeder_articles").update({ status: "Pending" }).eq("id", articleId);
    threads.mutate();
  }, [threads]);

  const stripHtml = (html: string): string =>
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, " ")
      .replace(/&#[0-9]+;/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const handleStartAgent = async () => {
    if (!assistant) { alert("Assistant not loaded yet."); return; }
    if (!activeWorkflowId) { alert("Please select a workflow first."); return; }

    try {
      const { data: pendingArticles, error } = await supabase
        .from("feeder_articles")
        .select("id, title, description")
        .eq("status", "Pending")
        .eq("workflow_id", activeWorkflowId)
        .order("created_at", { ascending: true })
        .limit(queueBatchSize);

      await supabase
        .from("workflows")
        .update({ last_trigger_at: new Date().toISOString() })
        .eq("id", activeWorkflowId);

      if (error) throw error;
      if (!pendingArticles || pendingArticles.length === 0) {
        alert("No pending articles in the queue for the selected workflow.");
        return;
      }

      for (let i = 0; i < pendingArticles.length; i++) {
        const article = pendingArticles[i];
        await supabase
          .from("feeder_articles")
          .update({ status: "Processing" })
          .eq("id", article.id);

        const message = `Title: ${stripHtml(article.title ?? "")}\nDescription: ${stripHtml(article.description ?? "")}`;

        if (i === 0) {
          // Article 1 — LIVE streaming via streamSubmitRef (real stream.submit)
          const submitArticle = () => {
            if (!streamSubmitRef.current) {
              console.warn("[handleStartAgent] streamSubmitRef not ready");
              return;
            }
            streamingArticleIdRef.current = article.id;
            const newMessage = { id: uuidv4(), type: "human" as const, content: message };
            streamSubmitRef.current(
              { messages: [newMessage] },
              {
                optimisticValues: (prev: any) => ({
                  messages: [...(prev.messages ?? []), newMessage],
                }),
              }
            );
          };

          if (!threadId) {
            submitArticle();
          } else {
            pendingArticleRef.current = { message, articleId: article.id };
            await setThreadId(null);
          }
        } else {
          // Articles 2-N — background runs
          const thread = await client.threads.create({
            metadata: {
              workflow_id: activeWorkflowId,
              user_id: userId || undefined,
            },
          });
          const run = await client.runs.create(thread.thread_id, assistant.assistant_id, {
            input: { messages: [{ role: "user", content: message }] },
            config: {
              configurable: {
                workflow_id: activeWorkflowId,
                user_id: userId || undefined,
              },
            },
          });
          pollRunStatus(thread.thread_id, run.run_id, article.id);
        }
      }
      mutateThreads?.();
    } catch (err) {
      console.error("Error starting agent batch:", err);
      alert("Failed to start agent batch processing.");
    }
  };

  const pollRunStatus = async (threadId: string, runId: string, articleId: string) => {
    const MAX_POLLS = 120;
    const POLL_MS = 10_000;
    let polls = 0;
    const tick = async () => {
      try {
        const run = await client.runs.get(threadId, runId);
        const status: string = (run as any).status ?? "";
        if (status === "success") {
          await supabase.from("feeder_articles").update({ status: "Done" }).eq("id", articleId);
          mutateThreads?.();
          return;
        }
        if (["error", "failed", "interrupted", "timeout", "cancelled"].includes(status)) {
          await supabase.from("feeder_articles").update({ status: "Pending" }).eq("id", articleId);
          mutateThreads?.();
          return;
        }
        polls++;
        if (polls < MAX_POLLS) setTimeout(tick, POLL_MS);
        else await supabase.from("feeder_articles").update({ status: "Pending" }).eq("id", articleId);
      } catch {
        await supabase.from("feeder_articles").update({ status: "Pending" }).eq("id", articleId);
      }
    };
    setTimeout(tick, POLL_MS);
  };

  return (
    // LangGraphRuntimeProvider replaces useStreamRuntime.
    // It uses @langchain/langgraph-sdk/react's proven useStream internally,
    // bridged into AssistantRuntimeProvider via useExternalStoreRuntime.
    // The Thread component from BaseChat.tsx works unchanged.
    <LangGraphRuntimeProvider
      assistantId={assistant?.assistant_id || config.assistantId}
      workflowId={activeWorkflowId}
      userId={userId}
      assistantConfig={assistant?.config as any}
      submitRef={streamSubmitRef}
      onStreamFinish={handleStreamFinish}
      onStreamError={handleStreamError}
      onHistoryRevalidate={() => mutateThreads?.()}
      threads={threads}
      threadId={threadId}
      setThreadId={setThreadId}
      handleDeleteThread={handleDeleteThread}
    >
      <div className="bg-background flex h-screen w-full overflow-hidden">
        {/* ── LEFT SIDEBAR ── */}
        <aside
          className={cn(
            "bg-background flex flex-col shrink-0 transition-all duration-200 h-full",
            isSidebarExpanded ? "w-64" : "w-12"
          )}
        >
          {/* Logo */}
          <div
            className={cn(
              "flex items-center shrink-0 h-12 transition-[padding] duration-200",
              isSidebarExpanded ? "px-6" : "px-3.5"
            )}
          >
            <Zap className="h-5 w-5 shrink-0 text-primary" />
            <span
              className={cn(
                "text-foreground/90 ml-2 text-sm font-semibold tracking-tight whitespace-nowrap font-serif transition-opacity duration-200",
                !isSidebarExpanded && "opacity-0 pointer-events-none"
              )}
            >
              Deep Agent UI
            </span>
          </div>

          {/* Thread list */}
          <ThreadListRoot
            className={cn(
              "relative flex-1 overflow-y-auto transition-[padding,width] duration-200 min-h-0",
              isSidebarExpanded ? "w-64 p-3" : "w-12 px-2 pt-1"
            )}
          >
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <ThreadListNew
                    className={cn(
                      "overflow-hidden transition-all duration-200 w-full mb-1",
                      !isSidebarExpanded && "w-8 gap-0 px-2 has-[>svg]:px-2"
                    )}
                    labelClassName={cn(
                      "overflow-hidden transition-all duration-200",
                      !isSidebarExpanded ? "max-w-0 opacity-0" : "max-w-24 opacity-100"
                    )}
                  />
                </TooltipTrigger>
                {!isSidebarExpanded && (
                  <TooltipContent side="right">New Thread</TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>

            <ThreadListItems
              aria-hidden={!isSidebarExpanded}
              inert={!isSidebarExpanded ? true : undefined}
              className={cn(
                "transition-[opacity,transform] duration-150",
                !isSidebarExpanded
                  ? "pointer-events-none opacity-0 delay-50"
                  : "translate-x-0 opacity-100"
              )}
            />
          </ThreadListRoot>

          {/* Bottom: Queue + profile */}
          <div className="flex flex-col shrink-0">
            {isSidebarExpanded ? (
              <div className="px-3 py-2">
                <button
                  onClick={() => setIsQueueCollapsed(!isQueueCollapsed)}
                  className="flex items-center justify-between w-full py-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors uppercase tracking-wider"
                >
                  <span>Queue ({queueTotalPending})</span>
                  {isQueueCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </button>
                {!isQueueCollapsed && (
                  <div className="mt-1 flex flex-col gap-1 max-h-[140px] overflow-y-auto">
                    {queueArticles.length === 0 ? (
                      <div className="text-[11px] text-muted-foreground/50 italic py-1">
                        Queue is empty
                      </div>
                    ) : (
                      <>
                        {queueArticles.map((article, index) => (
                          <div
                            key={article.id}
                            className="p-2 rounded-lg bg-muted/40 flex flex-col gap-0.5 text-[10px]"
                            title={article.title}
                          >
                            <div className="font-medium text-foreground line-clamp-1">
                              {index + 1}. {article.title}
                            </div>
                            <div className="text-[9px] text-muted-foreground/60 flex justify-between">
                              <span>{article.source_domain}</span>
                              <span>
                                {new Date(article.created_at).toLocaleDateString("en-PK", {
                                  timeZone: "Asia/Karachi",
                                })}
                              </span>
                            </div>
                          </div>
                        ))}
                        {queueTotalPending > queueBatchSize && (
                          <div className="text-[10px] text-muted-foreground/50 text-center py-1 mt-0.5">
                            +{queueTotalPending - queueBatchSize} more pending
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex justify-center py-1">
                <button
                  onClick={() => setIsQueueCollapsed(!isQueueCollapsed)}
                  className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  title={`Queue (${queueTotalPending})`}
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              </div>
            )}

            {isSidebarExpanded ? (
              <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                <div className="flex items-center gap-2 overflow-hidden shrink min-w-0">
                  <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center text-foreground font-bold text-xs shrink-0 select-none">
                    {userEmail ? userEmail[0].toUpperCase() : "U"}
                  </div>
                  <span className="text-xs font-medium truncate text-foreground select-text">
                    {userEmail || "User"}
                  </span>
                </div>
                <Link href="/agent-settings" title="Agent Settings">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                    <Settings className="h-4 w-4" />
                  </div>
                </Link>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1 py-2">
                <Link href="/agent-settings" title="Agent Settings">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                    <Settings className="h-4 w-4" />
                  </div>
                </Link>
                <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center text-foreground font-bold text-xs select-none">
                  {userEmail ? userEmail[0].toUpperCase() : "U"}
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* ── MAIN CONTENT ── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <header className="flex h-12 shrink-0 items-center gap-2 px-4">
            <button
              onClick={() => setIsSidebarExpanded(!isSidebarExpanded)}
              className="hidden size-8 md:flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
              title={isSidebarExpanded ? "Hide sidebar" : "Show sidebar"}
            >
              <PanelLeft className="h-4 w-4" />
            </button>

            {threadId && threadItems.find((t) => t.id === threadId)?.title ? (
              <span className="text-sm font-medium text-foreground truncate max-w-[240px]">
                {threadItems.find((t) => t.id === threadId)?.title}
              </span>
            ) : (
              <div className="relative">
                <button
                  onClick={() => setIsWfDropdownOpen(!isWfDropdownOpen)}
                  className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:bg-muted px-2 py-1.5 rounded-md transition-colors cursor-pointer select-none"
                >
                  <span>
                    {workflows.find((w) => w.id === activeWorkflowId)?.name ?? "Select Agent"}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60" />
                </button>
                {isWfDropdownOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setIsWfDropdownOpen(false)}
                    />
                    <div className="absolute top-full left-0 mt-1.5 w-56 rounded-xl border border-border/40 bg-popover/95 backdrop-blur-md text-popover-foreground shadow-lg p-1.5 z-50">
                      {workflows.map((wf) => (
                        <button
                          key={wf.id}
                          onClick={() => {
                            setActiveWorkflowId(wf.id);
                            setIsWfDropdownOpen(false);
                          }}
                          className={cn(
                            "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center justify-between hover:bg-muted",
                            activeWorkflowId === wf.id
                              ? "text-primary font-semibold"
                              : "text-foreground"
                          )}
                        >
                          <span>{wf.name}</span>
                          {activeWorkflowId === wf.id && (
                            <Check className="h-4 w-4 text-primary" />
                          )}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </header>

          {/* Thread — new UI design, now backed by proven @langchain/langgraph-sdk/react */}
          <main className="flex flex-1 flex-col overflow-hidden h-full w-full min-h-0">
            <Thread onStartAgent={handleStartAgent} />
          </main>
        </div>
      </div>
    </LangGraphRuntimeProvider>
  );
}

function HomePageContent() {
  const [config, setConfig] = useState<StandaloneConfig | null>(null);
  const [assistantId, setAssistantId] = useQueryState("assistantId");

  useEffect(() => {
    const savedConfig = getConfig();
    if (savedConfig) {
      setConfig(savedConfig);
      if (!assistantId) setAssistantId(savedConfig.assistantId);
    } else {
      const envUrl = process.env.NEXT_PUBLIC_LANGGRAPH_API_URL;
      const envAssistant = process.env.NEXT_PUBLIC_ASSISTANT_ID;
      const envKey = process.env.NEXT_PUBLIC_LANGSMITH_API_KEY;
      if (envUrl && envAssistant) {
        const autoConfig: StandaloneConfig = {
          deploymentUrl: envUrl,
          assistantId: envAssistant,
          langsmithApiKey: envKey || undefined,
        };
        saveConfig(autoConfig);
        setConfig(autoConfig);
        if (!assistantId) setAssistantId(envAssistant);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (config && !assistantId) setAssistantId(config.assistantId);
  }, [config, assistantId, setAssistantId]);

  const langsmithApiKey =
    config?.langsmithApiKey || process.env.NEXT_PUBLIC_LANGSMITH_API_KEY || "";

  if (!config) {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-6">
        <div className="text-center max-w-md border border-border rounded-2xl bg-card shadow-lg p-8 animate-fade-in">
          <Zap className="h-12 w-12 text-primary mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-foreground">Welcome to Deep Agent UI</h1>
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
            Please configure your LangGraph deployment settings in Agent Settings to get started.
          </p>
          <Link href="/agent-settings">
            <Button className="mt-6 w-full shadow-sm bg-primary text-primary-foreground hover:bg-primary/95">
              Open Agent Settings
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <ClientProvider deploymentUrl={config.deploymentUrl} apiKey={langsmithApiKey}>
      <HomePageInner config={config} />
    </ClientProvider>
  );
}

export default function HomePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center">
          <p className="text-muted-foreground">Loading...</p>
        </div>
      }
    >
      <HomePageContent />
    </Suspense>
  );
}
