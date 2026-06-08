"use client";

import React from "react";
import { CardShell } from "./CardShell";
import { useCardPhase } from "./useCardPhase";
import type { ToolCall } from "@/app/types/types";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";

const ACCENT = "#7C3AED"; // Purple for todos

interface TodoItem {
  id?: string;
  content?: string;
  title?: string;
  text?: string;
  status?: "pending" | "in_progress" | "completed" | "done";
  completed?: boolean;
}

function extractTodos(args: Record<string, unknown>): TodoItem[] {
  // deepagents write_todos uses args.todos = array of todo items
  const raw = args.todos ?? args.items ?? args.tasks ?? [];
  if (!Array.isArray(raw)) {
    // fallback: might be a single string (task name) or object
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

function getTodoStatus(todo: TodoItem): "pending" | "in_progress" | "completed" {
  if (todo.completed === true) return "completed";
  if (todo.status === "done" || todo.status === "completed") return "completed";
  if (todo.status === "in_progress") return "in_progress";
  return "pending";
}

function TodoStatusIcon({ status }: { status: "pending" | "in_progress" | "completed" }) {
  if (status === "completed") return <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />;
  if (status === "in_progress") return <Loader2 size={14} className="text-blue-500 animate-spin shrink-0" />;
  return <Circle size={14} className="text-muted-foreground shrink-0" />;
}

export const TodoCard = React.memo<{ toolCall: ToolCall }>(({ toolCall }) => {
  const args = toolCall.args as Record<string, unknown>;
  const todos = extractTodos(args);
  const hasResult = Boolean(toolCall.result) || toolCall.status === "completed";
  const { phase } = useCardPhase(toolCall.status, hasResult, 12, 10);

  const totalCount = todos.length;
  const doneCount = todos.filter((t) => getTodoStatus(t) === "completed").length;

  return (
    <CardShell
      title="✅ Updating todos"
      accentColor={ACCENT}
      phase={phase}
      toggleable={totalCount > 0}
    >
      <div className="flex flex-col gap-2">
        {/* Progress header */}
        {totalCount > 0 && (
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] text-muted-foreground">
              {doneCount}/{totalCount} tasks
            </span>
            <div className="flex-1 mx-3 h-1 rounded-full overflow-hidden bg-muted/50">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width: totalCount > 0 ? `${(doneCount / totalCount) * 100}%` : "0%",
                  background: `linear-gradient(90deg, ${ACCENT}88, ${ACCENT})`,
                }}
              />
            </div>
            <span className="text-[11px] font-semibold" style={{ color: ACCENT }}>
              {totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0}%
            </span>
          </div>
        )}

        {/* Todo list */}
        {todos.length > 0 ? (
          <div className="space-y-1.5">
            {todos.map((todo, i) => {
              const status = getTodoStatus(todo);
              return (
                <div
                  key={todo.id ?? i}
                  className="flex items-start gap-2 px-2 py-1.5 rounded-lg transition-colors"
                  style={{
                    background: status === "completed"
                      ? "rgba(16, 185, 129, 0.06)"
                      : status === "in_progress"
                        ? "rgba(59, 130, 246, 0.06)"
                        : `${ACCENT}06`,
                    border: `1px solid ${
                      status === "completed"
                        ? "rgba(16,185,129,0.20)"
                        : status === "in_progress"
                          ? "rgba(59,130,246,0.20)"
                          : `${ACCENT}20`
                    }`,
                    animation: `agentFadeIn 0.25s ${i * 0.05}s ease both`,
                  }}
                >
                  <TodoStatusIcon status={status} />
                  <span
                    className="text-[12px] leading-relaxed flex-1"
                    style={{
                      textDecoration: status === "completed" ? "line-through" : "none",
                      color: status === "completed" ? "var(--muted-foreground)" : "var(--foreground)",
                    }}
                  >
                    {getTodoText(todo)}
                  </span>
                  {status === "in_progress" && (
                    <span className="text-[9px] font-semibold text-blue-500 bg-blue-500/10 px-1.5 py-0.5 rounded-full shrink-0">
                      ACTIVE
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-[12px] text-muted-foreground italic px-1">
            Todo list updated
          </div>
        )}

        {/* Done message */}
        {hasResult && (
          <div
            className="text-[11px] font-semibold text-emerald-500 flex items-center gap-1.5 mt-1"
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
