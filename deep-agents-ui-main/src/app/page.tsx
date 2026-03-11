"use client";

import React, { useState, useEffect, useCallback, Suspense, useRef } from "react";
import Link from "next/link";
import { useQueryState } from "nuqs";
import { supabase } from "@/lib/supabase";
import { v4 as uuidv4 } from "uuid";
import { getConfig, saveConfig, StandaloneConfig } from "@/lib/config";
import { ConfigDialog } from "@/app/components/ConfigDialog";
import { Button } from "@/components/ui/button";
import { Assistant } from "@langchain/langgraph-sdk";
import { ClientProvider, useClient } from "@/providers/ClientProvider";
import { Settings, MessagesSquare, SquarePen, LayoutGrid, ListOrdered, Play, Database, Zap } from "lucide-react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ThreadList } from "@/app/components/ThreadList";
import { QueueSidebar } from "@/app/components/QueueSidebar";
import { ChatProvider } from "@/providers/ChatProvider";
import { ChatInterface } from "@/app/components/ChatInterface";

interface HomePageInnerProps {
  config: StandaloneConfig;
  configDialogOpen: boolean;
  setConfigDialogOpen: (open: boolean) => void;
  handleSaveConfig: (config: StandaloneConfig) => void;
}

function HomePageInner({
  config,
  configDialogOpen,
  setConfigDialogOpen,
  handleSaveConfig,
}: HomePageInnerProps) {
  const client = useClient();
  const [threadId, setThreadId] = useQueryState("threadId");
  const [sidebar, setSidebar] = useQueryState("sidebar");
  const [queueOpen, setQueueOpen] = useQueryState("queue");

  const [mutateThreads, setMutateThreads] = useState<(() => void) | null>(null);
  const [interruptCount, setInterruptCount] = useState(0);
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [queueBatchSize, setQueueBatchSize] = useState(2);

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

  // Load queue batch size from Supabase
  useEffect(() => {
    supabase.from("agent_settings").select("key,value").then(({ data }) => {
      if (!data) return;
      const m: Record<string, string> = {};
      for (const row of data) m[row.key] = row.value;
      if (m.queue_batch_size) setQueueBatchSize(parseInt(m.queue_batch_size, 10));
    });
  }, []);

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
          config: { ...(assistant?.config ?? {}), recursion_limit: 200 },
        }
      );
      mutateThreads?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

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

    try {
      // FIFO: fetch oldest Pending articles up to batch size
      const { data: pendingArticles, error } = await supabase
        .from("feeder_articles")
        .select("id, title, description")
        .eq("status", "Pending")
        .order("created_at", { ascending: true })
        .limit(queueBatchSize);

      await supabase.from("agent_settings").upsert({
        key: "last_trigger_at",
        value: new Date().toISOString()
      });

      if (error) throw error;
      if (!pendingArticles || pendingArticles.length === 0) {
        alert("No pending articles in the queue.");
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
                config: { ...(assistant.config ?? {}), recursion_limit: 200 },
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
          const thread = await client.threads.create();
          const run = await client.runs.create(thread.thread_id, assistant.assistant_id, {
            input: {
              messages: [{ role: "user", content: message }],
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
    <>
      <ConfigDialog
        open={configDialogOpen}
        onOpenChange={setConfigDialogOpen}
        onSave={handleSaveConfig}
        initialConfig={config}
      />
      <div className="flex h-screen flex-col">
        <header className="flex h-16 items-center justify-between border-b border-border px-6">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-semibold">Deep Agent UI</h1>
            {!sidebar && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSidebar("1")}
                className="rounded-md border border-border bg-card p-3 text-foreground hover:bg-accent"
              >
                <MessagesSquare className="mr-2 h-4 w-4" />
                Threads
                {interruptCount > 0 && (
                  <span className="ml-2 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] text-destructive-foreground">
                    {interruptCount}
                  </span>
                )}
              </Button>
            )}
            {!queueOpen && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setQueueOpen("1")}
                className="rounded-md border border-border bg-card p-3 text-foreground hover:bg-accent ml-2"
              >
                <ListOrdered className="mr-2 h-4 w-4" />
                Queue
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="text-sm text-muted-foreground">
              <span className="font-medium">Assistant:</span>{" "}
              {config.assistantId}
            </div>
            <Link href="/feeder">
              <Button variant="outline" size="sm" className="border-[#2F6868] text-[#2F6868] hover:bg-[#2F6868]/10">
                <Database className="mr-2 h-4 w-4" />
                Feeder
              </Button>
            </Link>
            <Link href="/agent-settings">
              <Button variant="outline" size="sm">
                <Zap className="mr-2 h-4 w-4" />
                Agent Settings
              </Button>
            </Link>
            <Link href="/posts">
              <Button variant="outline" size="sm">
                <LayoutGrid className="mr-2 h-4 w-4" />
                Posts
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfigDialogOpen(true)}
            >
              <Settings className="mr-2 h-4 w-4" />
              Settings
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setThreadId(null)}
              disabled={!threadId}
              className="border-[#2F6868] bg-[#2F6868] text-white hover:bg-[#2F6868]/80"
            >
              <SquarePen className="mr-2 h-4 w-4" />
              New Thread
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleStartAgent}
              className="bg-green-600 text-white hover:bg-green-700 ml-2"
            >
              <Play className="mr-2 h-4 w-4" />
              Start Agent
            </Button>
          </div>
        </header>

        <div className="flex-1 overflow-hidden">
          <ResizablePanelGroup
            direction="horizontal"
            autoSaveId="standalone-chat"
          >
            {sidebar && (
              <>
                <ResizablePanel
                  id="thread-history"
                  order={1}
                  defaultSize={25}
                  minSize={20}
                  className="relative min-w-[380px]"
                >
                  <ThreadList
                    onThreadSelect={async (id) => {
                      await setThreadId(id);
                    }}
                    onMutateReady={(fn) => setMutateThreads(() => fn)}
                    onClose={() => setSidebar(null)}
                    onInterruptCountChange={setInterruptCount}
                  />
                </ResizablePanel>
                <ResizableHandle />
              </>
            )}

            {queueOpen && (
              <>
                <ResizablePanel
                  id="queue-panel"
                  order={2}
                  defaultSize={25}
                  minSize={20}
                  className="relative min-w-[380px]"
                >
                  <QueueSidebar onClose={() => setQueueOpen(null)} />
                </ResizablePanel>
                <ResizableHandle />
              </>
            )}

            <ResizablePanel
              id="chat"
              className="relative flex flex-col"
              order={3}
            >
              <ChatProvider
                activeAssistant={assistant}
                onHistoryRevalidate={() => mutateThreads?.()}
                submitRef={streamSubmitRef}
                onStreamFinish={handleStreamFinish}
                onStreamError={handleStreamError}
              >
                <ChatInterface assistant={assistant} />
              </ChatProvider>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div >
    </>
  );
}

function HomePageContent() {
  const [config, setConfig] = useState<StandaloneConfig | null>(null);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [assistantId, setAssistantId] = useQueryState("assistantId");

  // On mount, check for saved config, otherwise show config dialog
  useEffect(() => {
    const savedConfig = getConfig();
    if (savedConfig) {
      setConfig(savedConfig);
      if (!assistantId) {
        setAssistantId(savedConfig.assistantId);
      }
    } else {
      setConfigDialogOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If config changes, update the assistantId
  useEffect(() => {
    if (config && !assistantId) {
      setAssistantId(config.assistantId);
    }
  }, [config, assistantId, setAssistantId]);

  const handleSaveConfig = useCallback((newConfig: StandaloneConfig) => {
    saveConfig(newConfig);
    setConfig(newConfig);
  }, []);

  const langsmithApiKey =
    config?.langsmithApiKey || process.env.NEXT_PUBLIC_LANGSMITH_API_KEY || "";

  if (!config) {
    return (
      <>
        <ConfigDialog
          open={configDialogOpen}
          onOpenChange={setConfigDialogOpen}
          onSave={handleSaveConfig}
        />
        <div className="flex h-screen items-center justify-center">
          <div className="text-center">
            <h1 className="text-2xl font-bold">Welcome to Standalone Chat</h1>
            <p className="mt-2 text-muted-foreground">
              Configure your deployment to get started
            </p>
            <Button
              onClick={() => setConfigDialogOpen(true)}
              className="mt-4"
            >
              Open Configuration
            </Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <ClientProvider
      deploymentUrl={config.deploymentUrl}
      apiKey={langsmithApiKey}
    >
      <HomePageInner
        config={config}
        configDialogOpen={configDialogOpen}
        setConfigDialogOpen={setConfigDialogOpen}
        handleSaveConfig={handleSaveConfig}
      />
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
