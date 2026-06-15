"use client";

import React, { useState, useEffect, useCallback, Suspense, useRef, useMemo } from "react";
import Link from "next/link";
import { useQueryState } from "nuqs";
import { supabase } from "@/lib/supabase";
import { v4 as uuidv4 } from "uuid";
import { getConfig, saveConfig, StandaloneConfig } from "@/lib/config";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Assistant } from "@langchain/langgraph-sdk";
import { ClientProvider, useClient } from "@/providers/ClientProvider";
import { Settings, MessagesSquare, SquarePen, LayoutGrid, ListOrdered, Play, Database, Zap, Menu, Trash2, ChevronDown, ChevronRight, RefreshCcw, Check } from "lucide-react";
import { useThreads } from "@/app/hooks/useThreads";
import { Client } from "@langchain/langgraph-sdk";
import { ChatProvider } from "@/providers/ChatProvider";
import { ChatInterface } from "@/app/components/ChatInterface";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { toast } from "sonner";

interface HomePageInnerProps {
  config: StandaloneConfig;
}

function HomePageInner({
  config,
}: HomePageInnerProps) {
  const [userEmail, setUserEmail] = useState<string>("");
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(true);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        setUserEmail(data.user.email ?? "User");
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

  // SWR threads query
  const threads = useThreads({
    workflowId: activeWorkflowId,
    limit: 30,
  });

  const threadItems = useMemo(() => {
    return threads.data?.flat() ?? [];
  }, [threads.data]);

  const interruptCount = useMemo(() => {
    return threadItems.filter((t) => t.status === "interrupted").length;
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
        () => {
          fetchQueueForSidebar();
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeWorkflowId, fetchQueueForSidebar]);

  const handleDeleteThread = useCallback(
    async (threadIdToDelete: string, status: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const apiKey = config.langsmithApiKey || process.env.NEXT_PUBLIC_LANGSMITH_API_KEY || "";
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
          if (threadIdToDelete === threadId) {
            await setThreadId(null);
          }
          toast.success("Thread deleted successfully");
          threads.mutate();
        } catch (err: any) {
          console.error("Failed to delete thread:", err);
          toast.error("Failed to delete thread: " + (err?.message ?? "unknown error"));
        }
      }
    },
    [threadId, setThreadId, config, threads]
  );


  // Ref to stream.submit — populated by ChatProvider once the hook is ready
  const streamSubmitRef = useRef<((input: any, options?: any) => void) | null>(null);
  // Track which article is currently being streamed (for status updates)
  const streamingArticleIdRef = useRef<string | null>(null);
  // Pending article for stream.submit — set in handleStartAgent, consumed by useEffect after threadId clears
  const pendingArticleRef = useRef<{ message: string; articleId: string } | null>(null);

  const fetchAssistant = useCallback(async () => {
    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        config.assistantId
      );

    if (isUUID) {
      // We should try to fetch the assistant directly with this UUID
      try {
        const data = await client.assistants.get(config.assistantId);
        setAssistant(data);
      } catch (error) {
        console.error("Failed to fetch assistant:", error);
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
        // We should try to list out the assistants for this graph, and then use the default one.
        // TODO: Paginate this search, but 100 should be enough for graph name
        const assistants = await client.assistants.search({
          graphId: config.assistantId,
          limit: 100,
        });
        const defaultAssistant = assistants.find(
          (assistant) => assistant.metadata?.["created_by"] === "system"
        );
        if (defaultAssistant === undefined) {
          throw new Error("No default assistant found");
        }
        setAssistant(defaultAssistant);
      } catch (error) {
        console.error(
          "Failed to find default assistant from graph_id: try setting the assistant_id directly:",
          error
        );
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

  // Fetch workflows and default to the first one
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

  // Update batch size when active workflow changes
  useEffect(() => {
    if (!activeWorkflowId) return;
    const activeWf = workflows.find((w) => w.id === activeWorkflowId);
    if (activeWf) {
      setQueueBatchSize(activeWf.batch_size ?? 2);
    }
  }, [activeWorkflowId, workflows]);

  // Reset threadId when active workflow changes (excluding initial load)
  const prevWorkflowIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeWorkflowId && prevWorkflowIdRef.current !== null && prevWorkflowIdRef.current !== activeWorkflowId) {
      setThreadId(null);
    }
    prevWorkflowIdRef.current = activeWorkflowId;
  }, [activeWorkflowId, setThreadId]);

  // NOTE: Auto-trigger is handled server-side by /api/cron (pinged every 60s by CronHeartbeat in layout.tsx)


  // ── Effect: submit article 1 after threadId clears ──
  // When handleStartAgent sets pendingArticleRef and clears threadId,
  // useStream reinitializes with no thread → submit() creates a fresh thread.
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
          config: {
            ...(assistant?.config ?? {}),
            recursion_limit: 200,
            configurable: {
              workflow_id: activeWorkflowId,
            },
          },
          streamSubgraphs: true,
        }
      );
      mutateThreads?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, activeWorkflowId]);

  // When stream.submit() finishes for article 1 → mark as Done
  const handleStreamFinish = useCallback(async () => {
    const articleId = streamingArticleIdRef.current;
    if (!articleId) return;
    streamingArticleIdRef.current = null;
    await supabase.from("feeder_articles").update({ status: "Done" }).eq("id", articleId);
    mutateThreads?.();
  }, [mutateThreads]);

  // When stream.submit() errors for article 1 → revert to Pending for retry
  const handleStreamError = useCallback(async () => {
    const articleId = streamingArticleIdRef.current;
    if (!articleId) return;
    streamingArticleIdRef.current = null;
    await supabase.from("feeder_articles").update({ status: "Pending" }).eq("id", articleId);
    mutateThreads?.();
  }, [mutateThreads]);

  // Strips all HTML tags and decodes basic HTML entities from a string
  const stripHtml = (html: string): string => {
    return html
      .replace(/<[^>]*>/g, " ")            // remove all tags
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, " ")
      .replace(/&#[0-9]+;/g, "")           // remove numeric entities
      .replace(/\s+/g, " ")                // collapse whitespace
      .trim();
  };

  const handleStartAgent = async () => {
    if (!assistant) {
      alert("Assistant not loaded yet.");
      return;
    }
    if (!activeWorkflowId) {
      alert("Please select a workflow first.");
      return;
    }

    try {
      // FIFO: fetch oldest Pending articles up to batch size, filtered by workflow_id
      const { data: pendingArticles, error } = await supabase
        .from("feeder_articles")
        .select("id, title, description")
        .eq("status", "Pending")
        .eq("workflow_id", activeWorkflowId)
        .order("created_at", { ascending: true })
        .limit(queueBatchSize);

      // Stamp trigger timestamp on the workflow
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

        // Mark as Processing before firing
        await supabase
          .from("feeder_articles")
          .update({ status: "Processing" })
          .eq("id", article.id);

        const cleanTitle = stripHtml(article.title ?? "");
        const cleanDescription = stripHtml(article.description ?? "");
        const message = `Title: ${cleanTitle}\nDescription: ${cleanDescription}`;

        if (i === 0) {
          // ── Article 1: LIVE streaming via stream.submit() ──
          const submitArticle = () => {
            if (!streamSubmitRef.current) return;
            streamingArticleIdRef.current = article.id;
            const newMessage = { id: uuidv4(), type: "human" as const, content: message };
            streamSubmitRef.current(
              { messages: [newMessage] },
              {
                optimisticValues: (prev: any) => ({
                  messages: [...(prev.messages ?? []), newMessage],
                }),
                config: {
                  ...(assistant.config ?? {}),
                  recursion_limit: 200,
                  configurable: {
                    workflow_id: activeWorkflowId,
                  },
                },
                streamSubgraphs: true,
              }
            );
          };

          if (!threadId) {
            // threadId is already null → useStream has no thread → submit immediately
            submitArticle();
          } else {
            // threadId exists → need to clear it first so useStream creates a fresh thread
            pendingArticleRef.current = { message, articleId: article.id };
            await setThreadId(null);
            // useEffect([threadId]) will fire on re-render and call stream.submit()
          }
          // Article 1 status handled by handleStreamFinish / handleStreamError callbacks
        } else {
          // ── Articles 2-N: background parallel runs ──
          // These run silently. Click their thread in ThreadList to view progress.
          const thread = await client.threads.create({
            metadata: {
              workflow_id: activeWorkflowId,
            },
          });
          const run = await client.runs.create(thread.thread_id, assistant.assistant_id, {
            input: {
              messages: [{ role: "user", content: message }],
            },
            config: {
              configurable: {
                workflow_id: activeWorkflowId,
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


  /**
   * Polls a LangGraph run until it finishes, then updates feeder_articles:
   *   success   → status = 'Done'
   *   error/interrupted/timeout → status = 'Pending'  (back in queue for retry)
   */
  const pollRunStatus = async (threadId: string, runId: string, articleId: string) => {
    const MAX_POLLS = 120;   // 120 × 10s = 20 minutes max
    const POLL_MS = 10_000; // check every 10 seconds
    let polls = 0;

    const tick = async () => {
      try {
        const run = await client.runs.get(threadId, runId);
        const status: string = (run as any).status ?? "";

        if (status === "success") {
          // Agent finished successfully → mark Done
          await supabase
            .from("feeder_articles")
            .update({ status: "Done" })
            .eq("id", articleId);
          mutateThreads?.();
          return; // stop polling
        }

        if (["error", "failed", "interrupted", "timeout", "cancelled"].includes(status)) {
          // Agent failed or was interrupted → revert to Pending for reprocessing
          await supabase
            .from("feeder_articles")
            .update({ status: "Pending" })
            .eq("id", articleId);
          console.warn(`[pollRunStatus] Run ${runId} ended with '${status}' → article reverted to Pending`);
          mutateThreads?.();
          return; // stop polling
        }

        // Still running — keep polling if under limit
        polls++;
        if (polls < MAX_POLLS) {
          setTimeout(tick, POLL_MS);
        } else {
          // Timeout: revert to Pending so it can be retried
          await supabase
            .from("feeder_articles")
            .update({ status: "Pending" })
            .eq("id", articleId);
          console.warn(`[pollRunStatus] Run ${runId} timed out after 20min → article reverted to Pending`);
        }
      } catch (e) {
        console.error("[pollRunStatus] error:", e);
        // On poll error, revert to Pending to be safe
        await supabase
          .from("feeder_articles")
          .update({ status: "Pending" })
          .eq("id", articleId);
      }
    };

    // Start first check after 10s (give agent time to begin)
    setTimeout(tick, POLL_MS);
  };


  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sleek left sidebar styled like Gemini */}
      <aside className={cn(
        "bg-sidebar flex flex-col justify-between shrink-0 transition-all duration-300",
        isSidebarExpanded ? "w-64" : "w-16"
      )}>
        <div className="flex flex-col gap-3 p-3 overflow-hidden flex-1">
          {/* Logo / Branding */}
          <div className={cn(
            "flex items-center gap-2 h-10 relative",
            isSidebarExpanded ? "px-2" : "justify-center"
          )}>
            <button
              onClick={() => setIsSidebarExpanded(!isSidebarExpanded)}
              className="flex items-center justify-center h-8 w-8 rounded-lg hover:bg-accent text-foreground shrink-0 transition-colors"
              title="Toggle Sidebar"
            >
              <Menu className="h-5 w-5 text-muted-foreground hover:text-foreground shrink-0" />
            </button>
            {isSidebarExpanded && (
              <span className="font-semibold text-base tracking-tight truncate text-foreground animate-fade-in font-serif">
                Deep Agent UI
              </span>
            )}
          </div>

          {/* New Thread Button */}
          <button
            onClick={() => setThreadId(null)}
            disabled={!threadId}
            className={cn(
              "flex items-center justify-start gap-3 rounded-xl bg-accent/40 transition-all duration-200 hover:bg-accent/70 text-foreground",
              isSidebarExpanded
                ? "h-10 w-full px-3 text-sm font-medium"
                : "h-10 w-10 p-0 justify-center"
            )}
            title="New chat"
          >
            <SquarePen className="h-5 w-5 shrink-0" />
            {isSidebarExpanded && <span className="truncate">New chat</span>}
          </button>

          {/* Nav Items */}
          <nav className="flex flex-col gap-1.5 mt-2">
            {/* Posts Page */}
            <Link
              href="/posts"
              className={cn(
                "flex items-center transition-all duration-200 text-muted-foreground hover:bg-accent hover:text-foreground",
                isSidebarExpanded 
                  ? "gap-3 rounded-xl h-10 px-3 text-sm font-medium" 
                  : "h-10 w-10 justify-center rounded-xl p-0"
              )}
              title="Posts"
            >
              <LayoutGrid className="h-5 w-5 shrink-0" />
              {isSidebarExpanded && <span className="truncate">Posts</span>}
            </Link>
          </nav>

          {/* Gemini Recents Thread History */}
          {isSidebarExpanded && (
            <div className="flex flex-col gap-1 mt-2 px-1 overflow-hidden flex-1 min-h-0">
              <div className="text-[10px] font-bold text-muted-foreground/80 uppercase tracking-wider px-2 mb-1.5 select-none">
                Recents
              </div>
              <div className="overflow-y-auto flex-1 custom-scrollbar pr-1 max-h-[300px] flex flex-col gap-0.5 scrollbar-pretty">
                {threadItems.length === 0 ? (
                  <div className="text-xs text-muted-foreground/60 px-2 py-1.5 italic">
                    No recent chats
                  </div>
                ) : (
                  threadItems.slice(0, 30).map((thread) => {
                    const isActive = threadId === thread.id;
                    return (
                      <div
                        key={thread.id}
                        className={cn(
                          "group relative flex items-center justify-between rounded-xl px-2.5 py-2 text-xs font-medium transition-all duration-200 cursor-pointer select-none",
                          isActive
                            ? "bg-primary/15 text-primary font-semibold"
                            : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                        )}
                        onClick={() => setThreadId(thread.id)}
                      >
                        <span className="truncate pr-4 w-full">
                          {thread.title}
                        </span>
                        {/* Delete button on hover */}
                        <button
                          onClick={(e) => handleDeleteThread(thread.id, thread.status, e)}
                          className="absolute right-1.5 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-accent hover:text-destructive transition-all duration-150"
                          title="Delete chat"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Collapsible Queue inside Sidebar */}
          {isSidebarExpanded && (
            <div className="flex flex-col mt-2 pt-2 px-1 flex-shrink-0">
              <button
                onClick={() => setIsQueueCollapsed(!isQueueCollapsed)}
                className="flex items-center justify-between px-2 py-1.5 hover:bg-accent/30 rounded-lg text-xs font-semibold text-muted-foreground/90 w-full transition-colors"
              >
                <span className="flex items-center gap-1.5 uppercase tracking-wider text-[10px]">
                  Queue ({queueTotalPending})
                </span>
                {isQueueCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>

              {!isQueueCollapsed && (
                <div className="mt-1.5 flex flex-col gap-1.5 max-h-[180px] overflow-y-auto px-1.5 py-1 text-xs scrollbar-pretty">
                  {queueArticles.length === 0 ? (
                    <div className="text-[11px] text-muted-foreground/60 italic py-1 pl-1">
                      Queue is empty
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-col gap-1.5">
                        {queueArticles.map((article, index) => (
                          <div
                            key={article.id}
                            className="p-2 rounded-lg border border-border/50 bg-card/30 flex flex-col gap-0.5 text-[11px] leading-tight"
                            title={article.title}
                          >
                            <div className="font-medium text-foreground line-clamp-1">
                              {index + 1}. {article.title}
                            </div>
                            <div className="text-[10px] text-muted-foreground/80 flex justify-between">
                              <span>{article.source_domain}</span>
                              <span>
                                {new Date(article.created_at).toLocaleDateString("en-PK", {
                                  timeZone: "Asia/Karachi",
                                })}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                      {queueTotalPending > queueBatchSize && (
                        <div className="text-[10px] text-muted-foreground/60 text-center py-1 border-t border-border/20 mt-1">
                          +{queueTotalPending - queueBatchSize} more pending
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Bottom Panel */}
        <div className="flex flex-col gap-2 p-3">
          {/* User Info / Assistant ID */}
          {isSidebarExpanded && (
            <div className="px-2 py-1.5 rounded-lg bg-accent/20 text-xxs text-muted-foreground truncate font-mono select-text" title={`Assistant ID: ${config.assistantId}`}>
              Assistant: {config.assistantId.substring(0, 16)}...
            </div>
          )}

          {isSidebarExpanded ? (
            /* Horizontal expanded footer */
            <div className="flex items-center justify-between gap-1 h-10 px-1">
              <div className="flex items-center gap-2 overflow-hidden shrink min-w-0">
                <div className="h-7 w-7 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-xs shrink-0 select-none">
                  {userEmail ? userEmail[0].toUpperCase() : "U"}
                </div>
                <span className="text-xs font-semibold truncate text-foreground select-text">
                  {userEmail || "User"}
                </span>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <ThemeToggle />
                <Link href="/agent-settings" title="Agent Settings">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                    <Settings className="h-5 w-5" />
                  </div>
                </Link>
              </div>
            </div>
          ) : (
            /* Vertical stacked collapsed footer */
            <div className="flex flex-col items-center gap-3 py-1">
              <ThemeToggle />
              <Link href="/agent-settings" title="Agent Settings">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                  <Settings className="h-5 w-5" />
                </div>
              </Link>
              <div className="h-7 w-7 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-xs select-none">
                {userEmail ? userEmail[0].toUpperCase() : "U"}
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden bg-background">
        {/* ChatGPT-style top header */}
        <header className="flex h-14 items-center justify-between px-6 bg-background flex-shrink-0 select-none">
          <div className="flex items-center gap-3">
            {/* ChatGPT-style dropdown for Agent Selector */}
            <div className="relative">
              <button
                onClick={() => setIsWfDropdownOpen(!isWfDropdownOpen)}
                className="flex items-center gap-1 text-base font-semibold text-foreground hover:bg-accent/50 px-2.5 py-1.5 rounded-xl transition-all duration-200 cursor-pointer select-none outline-none font-sans"
              >
                <span>
                  {workflows.find(w => w.id === activeWorkflowId)?.name ?? "Select Agent"}
                </span>
                <ChevronDown className="h-4 w-4 text-muted-foreground/60" />
              </button>

              {isWfDropdownOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setIsWfDropdownOpen(false)}
                  />
                  <div className="absolute top-full left-0 mt-1.5 w-56 rounded-2xl border border-border/30 bg-popover/95 backdrop-blur-md text-popover-foreground shadow-xl p-1.5 z-50 animate-fade-in origin-top-left">
                    {workflows.map((wf) => (
                      <button
                        key={wf.id}
                        onClick={() => {
                          setActiveWorkflowId(wf.id);
                          setIsWfDropdownOpen(false);
                        }}
                        className={cn(
                          "w-full text-left px-3 py-2 rounded-xl text-sm font-semibold transition-colors flex items-center justify-between hover:bg-accent",
                          activeWorkflowId === wf.id ? "text-primary bg-primary/5" : "text-foreground"
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
          </div>
          <div className="flex items-center gap-2">
            {/* Right side items */}
          </div>
        </header>

        <ChatProvider
          activeAssistant={assistant}
          onHistoryRevalidate={() => mutateThreads?.()}
          submitRef={streamSubmitRef}
          onStreamFinish={handleStreamFinish}
          onStreamError={handleStreamError}
          workflowId={activeWorkflowId}
        >
          <ChatInterface assistant={assistant} onStartAgent={handleStartAgent} />
        </ChatProvider>
      </div>
    </div>
  );
}

function HomePageContent() {
  const [config, setConfig] = useState<StandaloneConfig | null>(null);
  const [assistantId, setAssistantId] = useQueryState("assistantId");

  // On mount, check for saved config, otherwise auto-fill from env vars or show dialog
  useEffect(() => {
    const savedConfig = getConfig();
    if (savedConfig) {
      setConfig(savedConfig);
      if (!assistantId) {
        setAssistantId(savedConfig.assistantId);
      }
    } else {
      // Auto-populate from NEXT_PUBLIC_ env vars if available
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

  // If config changes, update the assistantId
  useEffect(() => {
    if (config && !assistantId) {
      setAssistantId(config.assistantId);
    }
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
            <Button
              className="mt-6 w-full shadow-sm bg-primary text-primary-foreground hover:bg-primary/95"
            >
              Open Agent Settings
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <ClientProvider
      deploymentUrl={config.deploymentUrl}
      apiKey={langsmithApiKey}
    >
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
