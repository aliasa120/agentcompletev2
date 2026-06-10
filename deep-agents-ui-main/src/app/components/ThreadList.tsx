"use client";

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { format } from "date-fns";
import { Loader2, MessageSquare, X, Trash2, StopCircle } from "lucide-react";
import { useQueryState } from "nuqs";
import { Client } from "@langchain/langgraph-sdk";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ThreadItem } from "@/app/hooks/useThreads";
import { useThreads } from "@/app/hooks/useThreads";
import { getConfig } from "@/lib/config";
import { toast } from "sonner";

type StatusFilter = "all" | "idle" | "busy" | "interrupted" | "error";

const GROUP_LABELS = {
  interrupted: "Requiring Attention",
  today: "Today",
  yesterday: "Yesterday",
  week: "This Week",
  older: "Older",
} as const;

const STATUS_COLORS: Record<ThreadItem["status"], string> = {
  idle: "bg-emerald-500",
  busy: "bg-primary",
  interrupted: "bg-amber-500",
  error: "bg-destructive",
};

function getThreadColor(status: ThreadItem["status"]): string {
  return STATUS_COLORS[status] ?? "bg-muted-foreground";
}

function formatTime(date: Date, now = new Date()): string {
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return format(date, "HH:mm");
  if (days === 1) return "Yesterday";
  if (days < 7) return format(date, "EEEE");
  return format(date, "MM/dd");
}

function StatusFilterItem({
  status,
  label,
  badge,
}: {
  status: ThreadItem["status"];
  label: string;
  badge?: number;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={cn(
          "inline-block size-2 rounded-full",
          getThreadColor(status)
        )}
      />
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-xs font-bold leading-none text-primary-foreground">
          {badge}
        </span>
      )}
    </span>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center p-8 text-center">
      <p className="text-sm text-destructive">Failed to load threads</p>
      <p className="mt-1 text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-16 w-full"
        />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center p-8 text-center">
      <MessageSquare className="mb-2 h-12 w-12 text-gray-300" />
      <p className="text-sm text-muted-foreground">No threads found</p>
    </div>
  );
}

/** Creates a LangGraph client from saved config */
function getLangGraphClient(): Client | null {
  const config = getConfig();
  if (!config) return null;
  const apiKey =
    config.langsmithApiKey ||
    process.env.NEXT_PUBLIC_LANGSMITH_API_KEY ||
    "";
  return new Client({
    apiUrl: config.deploymentUrl,
    defaultHeaders: apiKey ? { "X-Api-Key": apiKey } : {},
  });
}

interface ThreadListProps {
  onThreadSelect: (id: string) => void;
  onMutateReady?: (mutate: () => void) => void;
  onClose?: () => void;
  onInterruptCountChange?: (count: number) => void;
}

export function ThreadList({
  onThreadSelect,
  onMutateReady,
  onClose,
  onInterruptCountChange,
}: ThreadListProps) {
  const [currentThreadId, setCurrentThreadId] = useQueryState("threadId");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [clearingAll, setClearingAll] = useState(false);

  const threads = useThreads({
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 20,
  });

  const flattened = useMemo(() => {
    return threads.data?.flat() ?? [];
  }, [threads.data]);

  const isLoadingMore =
    threads.size > 0 && threads.data?.[threads.size - 1] == null;
  const isEmpty = threads.data?.at(0)?.length === 0;
  const isReachingEnd = isEmpty || (threads.data?.at(-1)?.length ?? 0) < 20;

  // Group threads by time and status
  const grouped = useMemo(() => {
    const now = new Date();
    const groups: Record<keyof typeof GROUP_LABELS, ThreadItem[]> = {
      interrupted: [],
      today: [],
      yesterday: [],
      week: [],
      older: [],
    };

    flattened.forEach((thread) => {
      if (thread.status === "interrupted") {
        groups.interrupted.push(thread);
        return;
      }

      const diff = now.getTime() - thread.updatedAt.getTime();
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));

      if (days === 0) {
        groups.today.push(thread);
      } else if (days === 1) {
        groups.yesterday.push(thread);
      } else if (days < 7) {
        groups.week.push(thread);
      } else {
        groups.older.push(thread);
      }
    });

    return groups;
  }, [flattened]);

  const interruptedCount = useMemo(() => {
    return flattened.filter((t) => t.status === "interrupted").length;
  }, [flattened]);

  // Expose thread list revalidation to parent component
  const onMutateReadyRef = useRef(onMutateReady);
  const mutateRef = useRef(threads.mutate);

  useEffect(() => {
    onMutateReadyRef.current = onMutateReady;
  }, [onMutateReady]);

  useEffect(() => {
    mutateRef.current = threads.mutate;
  }, [threads.mutate]);

  const mutateFn = useCallback(() => {
    mutateRef.current();
  }, []);

  useEffect(() => {
    onMutateReadyRef.current?.(mutateFn);
    // Only run once on mount to avoid infinite loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Notify parent of interrupt count changes
  useEffect(() => {
    onInterruptCountChange?.(interruptedCount);
  }, [interruptedCount, onInterruptCountChange]);

  /** Cancel all active runs on a thread, then delete it */
  const handleDeleteThread = useCallback(
    async (threadId: string, status: ThreadItem["status"], e: React.MouseEvent) => {
      e.stopPropagation(); // don't select the thread
      const client = getLangGraphClient();
      if (!client) {
        toast.error("No LangGraph config found");
        return;
      }

      setDeletingIds((prev) => new Set(prev).add(threadId));
      try {
        // If thread is busy / stuck, cancel its runs first
        if (status === "busy") {
          try {
            const runs = await client.runs.list(threadId, { limit: 10 });
            for (const run of runs) {
              const s = (run as any).status ?? "";
              if (["pending", "running"].includes(s)) {
                await client.runs.cancel(threadId, run.run_id);
              }
            }
          } catch {
            // Ignore cancel errors — proceed to delete anyway
          }
        }

        await client.threads.delete(threadId);

        // If the deleted thread was active, clear the URL param
        if (currentThreadId === threadId) {
          await setCurrentThreadId(null);
        }

        toast.success("Thread deleted");
        threads.mutate();
      } catch (err: any) {
        console.error("Failed to delete thread:", err);
        toast.error("Failed to delete thread: " + (err?.message ?? "unknown error"));
      } finally {
        setDeletingIds((prev) => {
          const next = new Set(prev);
          next.delete(threadId);
          return next;
        });
      }
    },
    [currentThreadId, setCurrentThreadId, threads]
  );

  /** Cancel runs for a busy/stuck thread without deleting it */
  const handleCancelThread = useCallback(
    async (threadId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const client = getLangGraphClient();
      if (!client) {
        toast.error("No LangGraph config found");
        return;
      }

      setDeletingIds((prev) => new Set(prev).add(threadId));
      try {
        const runs = await client.runs.list(threadId, { limit: 10 });
        let cancelled = 0;
        for (const run of runs) {
          const s = (run as any).status ?? "";
          if (["pending", "running"].includes(s)) {
            await client.runs.cancel(threadId, run.run_id);
            cancelled++;
          }
        }
        toast.success(cancelled > 0 ? `Cancelled ${cancelled} run(s)` : "No active runs found");
        threads.mutate();
      } catch (err: any) {
        console.error("Failed to cancel runs:", err);
        toast.error("Failed to cancel: " + (err?.message ?? "unknown error"));
      } finally {
        setDeletingIds((prev) => {
          const next = new Set(prev);
          next.delete(threadId);
          return next;
        });
      }
    },
    [threads]
  );

  /** Delete ALL threads visible in the current filtered list */
  const handleClearAll = useCallback(async () => {
    if (flattened.length === 0) return;
    const confirmed = window.confirm(
      `Delete all ${flattened.length} thread(s)? This cannot be undone.`
    );
    if (!confirmed) return;

    const client = getLangGraphClient();
    if (!client) {
      toast.error("No LangGraph config found");
      return;
    }

    setClearingAll(true);
    let failed = 0;
    try {
      for (const thread of flattened) {
        try {
          if (thread.status === "busy") {
            try {
              const runs = await client.runs.list(thread.id, { limit: 10 });
              for (const run of runs) {
                const s = (run as any).status ?? "";
                if (["pending", "running"].includes(s)) {
                  await client.runs.cancel(thread.id, run.run_id);
                }
              }
            } catch {
              // continue
            }
          }
          await client.threads.delete(thread.id);
        } catch {
          failed++;
        }
      }
      if (currentThreadId) await setCurrentThreadId(null);
      toast.success(
        failed === 0
          ? "All threads cleared"
          : `Cleared with ${failed} error(s)`
      );
      threads.mutate();
    } finally {
      setClearingAll(false);
    }
  }, [flattened, currentThreadId, setCurrentThreadId, threads]);

  return (
    <div className="absolute inset-0 flex flex-col">
      {/* Header with title, filter, clear all, and close button */}
      <div className="grid flex-shrink-0 grid-cols-[1fr_auto] items-center gap-3 border-b border-border p-4">
        <h2 className="text-lg font-semibold tracking-tight">Threads</h2>
        <div className="flex items-center gap-2">
          {/* Clear All button */}
          {flattened.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearAll}
              disabled={clearingAll}
              className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
              title="Delete all threads"
            >
              {clearingAll ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
              Clear All
            </Button>
          )}

          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as StatusFilter)}
          >
            <SelectTrigger className="w-fit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="all">All statuses</SelectItem>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Active</SelectLabel>
                <SelectItem value="idle">
                  <StatusFilterItem
                    status="idle"
                    label="Idle"
                  />
                </SelectItem>
                <SelectItem value="busy">
                  <StatusFilterItem
                    status="busy"
                    label="Busy"
                  />
                </SelectItem>
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Attention</SelectLabel>
                <SelectItem value="interrupted">
                  <StatusFilterItem
                    status="interrupted"
                    label="Interrupted"
                    badge={interruptedCount}
                  />
                </SelectItem>
                <SelectItem value="error">
                  <StatusFilterItem
                    status="error"
                    label="Error"
                  />
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-8 w-8"
              aria-label="Close threads sidebar"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="h-0 flex-1">
        {threads.error && <ErrorState message={threads.error.message} />}

        {!threads.error && !threads.data && threads.isLoading && (
          <LoadingState />
        )}

        {!threads.error && !threads.isLoading && isEmpty && <EmptyState />}

        {!threads.error && !isEmpty && (
          <div className="box-border w-full max-w-full overflow-hidden p-2">
            {(
              Object.keys(GROUP_LABELS) as Array<keyof typeof GROUP_LABELS>
            ).map((group) => {
              const groupThreads = grouped[group];
              if (groupThreads.length === 0) return null;

              return (
                <div
                  key={group}
                  className="mb-4"
                >
                  <h4 className="m-0 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {GROUP_LABELS[group]}
                  </h4>
                  <div className="flex flex-col gap-1">
                    {groupThreads.map((thread) => {
                      const isDeleting = deletingIds.has(thread.id);
                      return (
                        <div
                          key={thread.id}
                          className="group relative"
                        >
                          <button
                            type="button"
                            onClick={() => onThreadSelect(thread.id)}
                            disabled={isDeleting}
                            className={cn(
                              "grid w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors duration-200",
                              "hover:bg-accent",
                              currentThreadId === thread.id
                                ? "border border-primary bg-accent hover:bg-accent"
                                : "border border-transparent bg-transparent",
                              isDeleting && "opacity-50 pointer-events-none"
                            )}
                            aria-current={currentThreadId === thread.id}
                          >
                            <div className="min-w-0 flex-1 pr-14">
                              {/* Title + Timestamp Row */}
                              <div className="mb-1 flex items-center justify-between">
                                <h3 className="truncate text-sm font-semibold">
                                  {thread.title}
                                </h3>
                                <span className="ml-2 flex-shrink-0 text-xs text-muted-foreground">
                                  {formatTime(thread.updatedAt)}
                                </span>
                              </div>
                              {/* Description + Status Row */}
                              <div className="flex items-center justify-between">
                                <p className="flex-1 truncate text-sm text-muted-foreground">
                                  {thread.description}
                                </p>
                                <div className="ml-2 flex-shrink-0">
                                  {isDeleting ? (
                                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                                  ) : (
                                    <div
                                      className={cn(
                                        "h-2 w-2 rounded-full",
                                        getThreadColor(thread.status)
                                      )}
                                    />
                                  )}
                                </div>
                              </div>
                            </div>
                          </button>

                          {/* Action buttons — shown on row hover */}
                          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                            {/* Cancel button — only for busy/stuck threads */}
                            {thread.status === "busy" && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-orange-500 hover:bg-orange-500/10"
                                title="Cancel stuck/running thread"
                                disabled={isDeleting}
                                onClick={(e) => handleCancelThread(thread.id, e)}
                              >
                                <StopCircle className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {/* Delete button */}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                              title="Delete thread"
                              disabled={isDeleting}
                              onClick={(e) => handleDeleteThread(thread.id, thread.status, e)}
                            >
                              {isDeleting ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {!isReachingEnd && (
              <div className="flex justify-center py-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => threads.setSize(threads.size + 1)}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    "Load More"
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
