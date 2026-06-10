"use client";

import React from "react";
import { CardShell } from "./CardShell";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";

import { cardAccent, tw } from "@/lib/theme";

interface TodoItem {
  id?: string;
  content?: string;
  title?: string;
  text?: string;
  status?: "pending" | "in_progress" | "completed" | "done";
  completed?: boolean;
}

function extractTodos(args: Record<string, unknown>): TodoItem[] {
  const raw = args.todos ?? args.items ?? args.tasks ?? [];
  if (!Array.isArray(raw)) {
    if (typeof raw === "string") return [{ content: raw, status: "pending" }];
    return [];
  }
  return raw.map((item: unknown) => {
    if (typeof item === "string") return { content: item, status: "pending" };
    return item as TodoItem;
  });
}

function getTodoText(todo: TodoItem): string {
  return todo.content ?? todo.title ?? todo.text ?? "—";
}

function getTodoStatus(
  todo: TodoItem
): "pending" | "in_progress" | "completed" {
  if (todo.completed === true) return "completed";
  if (todo.status === "done" || todo.status === "completed") return "completed";
  if (todo.status === "in_progress") return "in_progress";
  return "pending";
}

function TodoStatusIcon({
  status,
}: {
  status: "pending" | "in_progress" | "completed";
}) {
  if (status === "completed")
    return (
      <CheckCircle2 size={13} className="text-primary shrink-0 mt-0.5" />
    );
  if (status === "in_progress")
    return (
      <Loader2
        size={13}
        className="text-primary animate-spin shrink-0 mt-0.5"
      />
    );
  return (
    <Circle size={13} className="text-muted-foreground/40 shrink-0 mt-0.5" />
  );
}

export const TodoCard = React.memo<{ toolCall: ToolCall }>(({ toolCall }) => {
  const args = toolCall.args as Record<string, unknown>;
  const todos = extractTodos(args);
  const hasResult =
    Boolean(toolCall.result) || toolCall.status === "completed";
  const { phase } = useCardPhase(toolCall.status, hasResult, 12, 10);

  const totalCount = todos.length;
  const doneCount = todos.filter(
    (t) => getTodoStatus(t) === "completed"
  ).length;
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  return (
    <CardShell
      title="✅ Updating todos"
      accentColor={cardAccent.todo}
      phase={phase}
      toggleable={totalCount > 0}
    >
      <div className="flex flex-col gap-2.5">
        {/* Progress bar */}
        {totalCount > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-muted-foreground tabular-nums shrink-0 font-medium">
              {doneCount}/{totalCount}
            </span>
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-700"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[11px] font-semibold text-primary tabular-nums shrink-0">
              {pct}%
            </span>
          </div>
        )}

        {/* Todo list */}
        {todos.length > 0 ? (
          <div className="flex flex-col gap-1">
            {todos.map((todo, i) => {
              const status = getTodoStatus(todo);
              const isCompleted = status === "completed";
              const isActive = status === "in_progress";

              return (
                <div
                  key={todo.id ?? i}
                  className={[
                    "flex items-start gap-2.5 px-2.5 py-2 rounded-lg border",
                    isCompleted
                      ? "bg-muted/60 border-border"
                      : isActive
                      ? "bg-primary/5 border-primary/20"
                      : "bg-card border-border",
                  ].join(" ")}
                  style={{ animation: `agentFadeIn 0.22s ${i * 0.04}s ease both` }}
                >
                  <TodoStatusIcon status={status} />
                  <span
                    className={[
                      "text-[12px] leading-snug flex-1 font-medium",
                      isCompleted
                        ? "line-through text-muted-foreground"
                        : "text-foreground",
                    ].join(" ")}
                  >
                    {getTodoText(todo)}
                  </span>
                  {isActive && (
                    <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 shrink-0 self-center">
                      Active
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground italic px-1">
            Todo list updated
          </p>
        )}

        {/* Done indicator */}
        {hasResult && (
          <div
            className="text-[11px] font-semibold text-primary flex items-center gap-1.5"
            style={{ animation: "agentFadeIn 0.3s ease both" }}
          >
            <CheckCircle2 size={12} /> Todos saved
          </div>
        )}
      </div>
    </CardShell>
  );
});

TodoCard.displayName = "TodoCard";
