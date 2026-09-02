"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useTheme } from "@/providers/ThemeProvider";
import { useAppearance } from "@/providers/AppearanceProvider";
import { ACCENT_PRESETS, FONT_SIZES, THEME_VARIANTS } from "@/lib/appearance";
import { JanCard, CardItem } from "@/components/settings/JanCard";
import { Button } from "@/components/ui/button";
import {
  Sun,
  Moon,
  Monitor,
  Check,
  Trash2,
  AlertTriangle,
  RefreshCw,
  MessageSquare,
  HardDrive,
  Brain,
  Database,
  Loader2,
  ShieldAlert,
  Sparkles,
  SlidersHorizontal,
  Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { mutate } from "swr";

interface HistoryStats {
  sessionCount: number;
  messageCount: number;
  threadCount: number;
  diskFolderCount: number;
  diskFilesCount: number;
  hasMemoryProfile: boolean;
  userId: string | null;
  userEmail: string | null;
}

export function UserPreferencesSection() {
  // ── Appearance / Theme State ────────────────────────────────────────────────
  const { theme, setTheme } = useTheme();
  const {
    themeVariant,
    accent,
    fontSize,
    setThemeVariant,
    setAccent,
    setFontSize,
  } = useAppearance();

  // ── Personal History State ──────────────────────────────────────────────────
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Deletion options
  const [clearMemories, setClearMemories] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");

  const fetchStats = useCallback(async () => {
    setLoadingStats(true);
    try {
      const res = await fetch("/api/user-history", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data.stats) {
          setStats(data.stats);
        }
      }
    } catch (err) {
      console.warn("Failed to fetch history stats:", err);
    } finally {
      setLoadingStats(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const handleDeleteHistory = async () => {
    setDeleting(true);
    try {
      const res = await fetch("/api/user-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clearSessions: true,
          clearThreads: true,
          clearDiskFiles: true,
          clearMemories: clearMemories,
          clearChatBindings: true,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data?.error || "Failed to delete personal history");
      }

      // Invalidate SWR thread and message caches across the app
      await mutate(
        (key) =>
          typeof key === "string" &&
          (key.startsWith("threads") ||
            key.startsWith("/api/user-history") ||
            key.startsWith("/api/memories")),
        undefined,
        { revalidate: true }
      );

      // Clean local storage thread state
      try {
        if (typeof window !== "undefined") {
          // Clear active thread pointers and voice mode preferences
          const keysToRemove: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && (k.startsWith("voice_mode_") || k === "active_thread_id")) {
              keysToRemove.push(k);
            }
          }
          keysToRemove.forEach((k) => localStorage.removeItem(k));
        }
      } catch {}

      const s = data.summary;
      toast.success(
        `Deleted ${s?.deletedSessionsCount ?? 0} sessions, ${s?.deletedMessagesCount ?? 0} messages, & ${s?.deletedThreadsCount ?? 0} threads from Database and Disk.`
      );

      setShowConfirmModal(false);
      setConfirmInput("");
      setClearMemories(false);
      fetchStats();
    } catch (err: any) {
      console.error("Delete history error:", err);
      toast.error(err?.message || "Failed to delete personal history");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6 pb-8">
      {/* ── Section Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-border/40">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <SlidersHorizontal className="h-5 w-5 text-primary" />
            User Preferences
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Customize interface appearance, theme styling, and manage personal data & history.
          </p>
        </div>
      </div>

      {/* ── Theme ── */}
      <JanCard title="Theme">
        <CardItem
          title="Interface theme"
          description="Select or sync with your system's color scheme"
          className="flex-col sm:flex-row items-start sm:items-center gap-3"
          actions={
            <div className="flex flex-wrap gap-2 w-full sm:w-auto">
              {(
                [
                  { value: "light", icon: Sun, label: "Light" },
                  { value: "dark", icon: Moon, label: "Dark" },
                  { value: "system", icon: Monitor, label: "System" },
                ] as const
              ).map(({ value, icon: Icon, label }) => (
                <button
                  key={value}
                  onClick={() => setTheme(value)}
                  className={cn(
                    "flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors border shadow-xs min-h-[38px]",
                    theme === value
                      ? "border-primary bg-primary text-primary-foreground font-semibold"
                      : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  {label}
                </button>
              ))}
            </div>
          }
        />
      </JanCard>

      {/* ── Theme Style (Theme 1 / Theme 2) ── */}
      <JanCard title="Theme Style">
        <CardItem
          column
          title="Base theme"
          description="Switch between the default modern theme and the vintage Archive theme. Layout stays the same — only base colors and typography change. Accent colors are shared across both themes."
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 w-full">
            {THEME_VARIANTS.map((variant) => (
              <button
                key={variant.value}
                onClick={() => setThemeVariant(variant.value)}
                className={cn(
                  "relative flex flex-col gap-2.5 rounded-xl border p-3.5 text-left transition-all duration-200 cursor-pointer shadow-xs",
                  themeVariant === variant.value
                    ? "border-primary ring-2 ring-primary/20 bg-accent/40"
                    : "border-border bg-card/60 hover:border-primary/50 hover:bg-accent/20"
                )}
              >
                {/* Mini preview swatch */}
                <div
                  className="h-14 w-full rounded-lg border overflow-hidden flex shadow-inner"
                  style={{
                    backgroundColor: variant.preview.bg,
                    borderColor: "var(--border)",
                  }}
                >
                  <div className="flex-1 flex flex-col justify-center gap-1.5 px-3">
                    <div
                      className="h-1.5 w-2/3 rounded-full"
                      style={{ backgroundColor: variant.preview.text }}
                    />
                    <div
                      className="h-1.5 w-1/3 rounded-full opacity-50"
                      style={{ backgroundColor: variant.preview.text }}
                    />
                  </div>
                  <div
                    className="w-1/3"
                    style={{ backgroundColor: variant.preview.surface }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground">
                    {variant.name}
                  </span>
                  {themeVariant === variant.value && (
                    <div className="size-5 rounded-full bg-primary flex items-center justify-center shadow-xs">
                      <Check className="h-3 w-3 text-primary-foreground" />
                    </div>
                  )}
                </div>
                <span className="text-[11px] text-muted-foreground leading-relaxed">
                  {variant.description}
                </span>
              </button>
            ))}
          </div>
        </CardItem>
      </JanCard>

      {/* ── Accent Color ── */}
      <JanCard title="Accent Color">
        <CardItem
          column
          title="Accent"
          description="Sets the secondary accent color across buttons, active states, and interactive controls."
        >
          <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-11 gap-3 mt-3 w-full">
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset.value}
                onClick={() => setAccent(preset.value)}
                title={preset.name}
                className={cn(
                  "relative flex flex-col items-center gap-1.5 group p-1.5 rounded-lg transition-all",
                  accent === preset.value
                    ? "bg-accent/60"
                    : "hover:bg-accent/30"
                )}
              >
                <div
                  className={cn(
                    "h-8 w-8 rounded-full transition-transform group-hover:scale-110 shadow-xs cursor-pointer",
                    accent === preset.value &&
                      "ring-2 ring-offset-2 ring-primary ring-offset-background"
                  )}
                  style={{ backgroundColor: preset.thumb }}
                >
                  {accent === preset.value && (
                    <div className="h-full w-full flex items-center justify-center">
                      <Check className="h-4 w-4 text-white drop-shadow-xs" />
                    </div>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground font-medium truncate max-w-full">
                  {preset.name}
                </span>
              </button>
            ))}
          </div>
        </CardItem>
      </JanCard>

      {/* ── Font Size ── */}
      <JanCard title="Font Size">
        <CardItem
          title="Interface font size"
          description="Adjust the base font size across the entire application"
          className="flex-col sm:flex-row items-start sm:items-center gap-3"
          actions={
            <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
              {FONT_SIZES.map((size) => (
                <button
                  key={size}
                  onClick={() => setFontSize(size)}
                  className={cn(
                    "flex-1 sm:flex-none h-9 min-w-[3rem] px-2.5 rounded-lg text-xs font-medium border transition-colors shadow-xs",
                    fontSize === size
                      ? "border-primary bg-primary text-primary-foreground font-semibold"
                      : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground"
                  )}
                >
                  {size}px
                </button>
              ))}
            </div>
          }
        />
      </JanCard>

      {/* ── Personal History & Data Management ── */}
      <JanCard
        title="Personal History & Data"
        header={
          <div className="mb-4">
            <p className="text-xs sm:text-sm text-muted-foreground">
              Manage your personal chat sessions, thread checkpoints, disk file workspaces, and database storage.
            </p>
          </div>
        }
      >
        {/* Storage Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="p-3.5 rounded-xl bg-secondary/40 border border-border/50 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
              <Database className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
                DB Sessions
              </p>
              <p className="text-lg font-bold text-foreground truncate">
                {loadingStats ? (
                  <Loader2 className="h-4 w-4 animate-spin mt-1" />
                ) : (
                  stats?.sessionCount ?? 0
                )}
              </p>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-secondary/40 border border-border/50 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
              <MessageSquare className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
                DB Messages
              </p>
              <p className="text-lg font-bold text-foreground truncate">
                {loadingStats ? (
                  <Loader2 className="h-4 w-4 animate-spin mt-1" />
                ) : (
                  stats?.messageCount ?? 0
                )}
              </p>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-secondary/40 border border-border/50 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
              <Layers className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
                LG Threads
              </p>
              <p className="text-lg font-bold text-foreground truncate">
                {loadingStats ? (
                  <Loader2 className="h-4 w-4 animate-spin mt-1" />
                ) : (
                  stats?.threadCount ?? 0
                )}
              </p>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-secondary/40 border border-border/50 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
              <HardDrive className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
                Workspace Folders
              </p>
              <p className="text-lg font-bold text-foreground truncate">
                {loadingStats ? (
                  <Loader2 className="h-4 w-4 animate-spin mt-1" />
                ) : (
                  stats?.diskFolderCount ?? 0
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Delete History Action Item */}
        <CardItem
          className="flex-col sm:flex-row items-start sm:items-center gap-4 pt-2"
          title={
            <span className="flex items-center gap-2 text-destructive font-semibold">
              <Trash2 className="h-4 w-4" />
              Delete Personal History
            </span>
          }
          description="Permanently delete all your conversation history, chat checkpoints, and generated workspace files from the database and disk."
          actions={
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <Button
                variant="outline"
                size="sm"
                onClick={fetchStats}
                disabled={loadingStats}
                className="h-9 px-3 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                title="Refresh stats"
              >
                <RefreshCw
                  className={cn("h-3.5 w-3.5", loadingStats && "animate-spin")}
                />
                <span className="hidden sm:inline">Refresh</span>
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowConfirmModal(true)}
                className="h-9 px-4 gap-1.5 text-xs font-semibold shadow-xs"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete History
              </Button>
            </div>
          }
        />
      </JanCard>

      {/* ── Confirmation Modal ── */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-xs animate-in fade-in-0">
          <div className="w-full max-w-lg rounded-2xl border border-destructive/30 bg-card p-5 sm:p-6 shadow-2xl space-y-5 animate-in zoom-in-95 max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex items-start gap-3.5">
              <div className="size-10 rounded-full bg-destructive/15 text-destructive flex items-center justify-center shrink-0">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="space-y-1 flex-1">
                <h3 className="text-lg font-bold text-foreground">
                  Delete Personal History?
                </h3>
                <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
                  This action is irreversible and will permanently delete your conversation data from Supabase Database, LangGraph Checkpointer, and Disk storage layers.
                </p>
              </div>
            </div>

            {/* Deletion Breakdown List */}
            <div className="p-3.5 rounded-xl bg-destructive/5 border border-destructive/20 space-y-2.5 text-xs">
              <p className="font-semibold text-destructive flex items-center gap-1.5">
                <ShieldAlert className="h-4 w-4" />
                What will be permanently deleted:
              </p>
              <ul className="space-y-1.5 text-muted-foreground pl-5 list-disc">
                <li>
                  <strong className="text-foreground">Supabase Postgres DB:</strong> {stats?.sessionCount ?? 0} chat sessions and {stats?.messageCount ?? 0} messages.
                </li>
                <li>
                  <strong className="text-foreground">LangGraph Checkpointer DB:</strong> {stats?.threadCount ?? 0} threads, active/completed runs, and state checkpoints.
                </li>
                <li>
                  <strong className="text-foreground">Disk Workspace Files:</strong> {stats?.diskFolderCount ?? 0} workspace folders under <code className="text-[11px] bg-muted px-1 py-0.5 rounded text-foreground">output/threads/</code>.
                </li>
                <li>
                  <strong className="text-foreground">Chat Bindings:</strong> Telegram and connected chat session bindings.
                </li>
              </ul>
            </div>

            {/* Optional Options */}
            <div className="space-y-3 pt-1">
              <label className="flex items-start gap-2.5 p-3 rounded-lg border border-border bg-secondary/30 cursor-pointer hover:bg-secondary/50 transition-colors">
                <input
                  type="checkbox"
                  checked={clearMemories}
                  onChange={(e) => setClearMemories(e.target.checked)}
                  className="mt-0.5 size-4 rounded border-border text-primary focus:ring-primary"
                />
                <div className="text-xs space-y-0.5">
                  <span className="font-medium text-foreground block">
                    Also reset persistent AI memory profile
                  </span>
                  <span className="text-muted-foreground block text-[11px]">
                    Clears your stored user facts and standing instructions (<code className="text-[10px]">USER.md</code> & <code className="text-[10px]">MEMORY.md</code>) in the database.
                  </span>
                </div>
              </label>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground block">
                  To confirm, type <strong className="text-destructive font-mono">DELETE</strong> below:
                </label>
                <input
                  type="text"
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  placeholder="Type DELETE to confirm"
                  className="w-full h-9 rounded-lg border border-input bg-background px-3 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-destructive focus:border-destructive"
                  autoFocus
                />
              </div>
            </div>

            {/* Modal Actions */}
            <div className="flex flex-col-reverse sm:flex-row items-center justify-end gap-2 pt-2 border-t border-border/50">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowConfirmModal(false);
                  setConfirmInput("");
                }}
                disabled={deleting}
                className="w-full sm:w-auto h-9 text-xs"
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDeleteHistory}
                disabled={deleting || confirmInput.trim() !== "DELETE"}
                className="w-full sm:w-auto h-9 text-xs font-semibold gap-1.5 shadow-sm"
              >
                {deleting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Deleting History & DB Records...
                  </>
                ) : (
                  <>
                    <Trash2 className="h-3.5 w-3.5" />
                    Permanently Delete History
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
