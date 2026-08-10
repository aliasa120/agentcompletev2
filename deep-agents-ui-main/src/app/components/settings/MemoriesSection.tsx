"use client";

import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import {
  Brain, Save, RefreshCw, FileText, UserCheck, Cloud, CheckCircle2, AlertCircle
} from "lucide-react";
import { JanCard, CardItem } from "@/components/settings/JanCard";
import { toast } from "sonner";

interface MemoriesSectionProps {
  globalSettings?: Record<string, string>;
  setGlobalSetting?: (k: string, v: string) => void;
  saveGlobalSettings?: () => Promise<void>;
  saveStatus?: "idle" | "saving" | "saved" | "error";
}

export function MemoriesSection({
  globalSettings = {},
  setGlobalSetting = () => {},
  saveGlobalSettings = async () => {},
  saveStatus = "idle"
}: MemoriesSectionProps) {
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"USER.md" | "MEMORY.md" | "HONCHO">("USER.md");
  const [fileContent, setFileContent] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [userCharLimit, setUserCharLimit] = useState<number>(1375);
  const [memoryCharLimit, setMemoryCharLimit] = useState<number>(2200);
  const [honchoStatus, setHonchoStatus] = useState<any>(null);

  // Fetch workflows from Supabase
  const fetchWorkflows = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("workflows")
        .select("id, name, description")
        .order("name", { ascending: true });
      if (error) throw error;
      setWorkflows(data ?? []);
      if (data && data.length > 0 && !selectedWorkflowId) {
        setSelectedWorkflowId(data[0].id);
      }
    } catch (e: any) {
      toast.error(`Failed to load workflows: ${e.message}`);
    }
  }, [selectedWorkflowId]);

  useEffect(() => {
    fetchWorkflows();
  }, [fetchWorkflows]);

  // Load memory file content for selected workflow and file tab
  const loadMemoryFile = useCallback(async () => {
    if (!selectedWorkflowId) return;
    setLoading(true);
    try {
      const url = new URL("/api/memories", window.location.origin);
      url.searchParams.set("workflow_id", selectedWorkflowId);
      url.searchParams.set("file", activeTab === "HONCHO" ? "USER.md" : activeTab);

      const response = await fetch(url.toString());
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to load memory file");
      }
      setFileContent(data.content ?? "");
      setHonchoStatus(data.honcho_status ?? null);
      if (data.budget_limits) {
        setUserCharLimit(data.budget_limits.user_char_limit || 1375);
        setMemoryCharLimit(data.budget_limits.memory_char_limit || 2200);
      }
    } catch (e: any) {
      toast.error(e.message || "Failed to load memory file");
    } finally {
      setLoading(false);
    }
  }, [selectedWorkflowId, activeTab]);

  useEffect(() => {
    loadMemoryFile();
  }, [selectedWorkflowId, activeTab, loadMemoryFile]);

  // Save current markdown file content & budget limits
  const handleSaveFile = async () => {
    if (!selectedWorkflowId || activeTab === "HONCHO") return;
    setSaving(true);
    try {
      const response = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow_id: selectedWorkflowId,
          file: activeTab,
          content: fileContent,
          memory_user_char_limit: userCharLimit,
          memory_file_char_limit: memoryCharLimit,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to save memory settings");
      }
      toast.success(data.message || `Successfully saved ${activeTab} & memory limits`);
    } catch (e: any) {
      toast.error(e.message || "Failed to save file");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header Card */}
      <JanCard
        header={
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary shrink-0">
              <Brain className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-medium text-foreground font-studio">Hermes 3-Layer Memory Manager</h2>
              <p className="text-xs text-muted-foreground mt-1">
                Workflow-isolated memory files (<code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">USER.md</code> & <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">MEMORY.md</code>) + optional Honcho Cloud Provider.
              </p>
            </div>
          </div>
        }
      />

      {/* Workflow Selection & File Selector */}
      <JanCard title="Memory Files">
        <CardItem
          className="flex-col sm:flex-row items-start sm:items-center gap-3"
          title="Active Workflow Context"
          description="Memory files are isolated per workflow"
          actions={
            <select
              value={selectedWorkflowId}
              onChange={(e) => setSelectedWorkflowId(e.target.value)}
              className="w-full sm:w-72 h-9 rounded-md border border-input bg-background px-3 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-primary"
            >
              {workflows.length === 0 ? (
                <option value="">Default Workflow</option>
              ) : (
                workflows.map((wf) => (
                  <option key={wf.id} value={wf.id}>
                    {wf.name} ({wf.id})
                  </option>
                ))
              )}
            </select>
          }
        />

        <CardItem
          className="flex-col sm:flex-row items-start sm:items-center gap-3"
          title="Memory Layer"
          description="Choose which file to edit"
          actions={
            <div className="flex flex-wrap items-center gap-1 p-1 bg-muted/40 rounded-lg border border-border/40 text-xs">
              <button
                onClick={() => setActiveTab("USER.md")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors ${activeTab === "USER.md" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                <UserCheck className="h-3.5 w-3.5" />
                USER.md
              </button>
              <button
                onClick={() => setActiveTab("MEMORY.md")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors ${activeTab === "MEMORY.md" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                <FileText className="h-3.5 w-3.5" />
                MEMORY.md
              </button>
              <button
                onClick={() => setActiveTab("HONCHO")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors ${activeTab === "HONCHO" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                <Cloud className="h-3.5 w-3.5" />
                Honcho Cloud
              </button>
            </div>
          }
        />

        <CardItem
          className="flex-col sm:flex-row items-start sm:items-center gap-3"
          title="Character Budget Limits"
          description="Controls max memory size before truncation"
          actions={
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <label htmlFor="user-char-limit-input" className="whitespace-nowrap font-mono text-foreground">USER.md Max:</label>
                <input
                  id="user-char-limit-input"
                  type="number"
                  value={userCharLimit}
                  onChange={(e) => setUserCharLimit(parseInt(e.target.value, 10) || 1375)}
                  className="w-20 h-7 rounded border border-input bg-background px-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <span>chars</span>
              </div>
              <div className="flex items-center gap-1.5">
                <label htmlFor="memory-char-limit-input" className="whitespace-nowrap font-mono text-foreground">MEMORY.md Max:</label>
                <input
                  id="memory-char-limit-input"
                  type="number"
                  value={memoryCharLimit}
                  onChange={(e) => setMemoryCharLimit(parseInt(e.target.value, 10) || 2200)}
                  className="w-20 h-7 rounded border border-input bg-background px-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <span>chars</span>
              </div>
            </div>
          }
        />

        {/* Tab Content 1 & 2: USER.md or MEMORY.md Editor */}
        {activeTab !== "HONCHO" && (
          <CardItem
            column
            className="mt-4"
            title={
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs font-bold text-primary px-2 py-0.5 rounded bg-primary/10">
                  {activeTab}
                </span>
              </span>
            }
            description={
              activeTab === "USER.md"
                ? "Durable user profile, preferences, and standing rules for this workflow."
                : "Curated persistent project facts, learnings, and decisions."
            }
            actions={
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadMemoryFile}
                  disabled={loading}
                  className="h-8 gap-1.5 text-xs"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
                <Button
                  size="sm"
                  onClick={handleSaveFile}
                  disabled={saving}
                  className="h-8 gap-1.5 text-xs"
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? "Saving..." : "Save File"}
                </Button>
              </div>
            }
            classNameWrapperAction="self-end"
          >
            <textarea
              value={fileContent}
              onChange={(e) => setFileContent(e.target.value)}
              placeholder={`# ${activeTab}\nWrite markdown content here...`}
              className="w-full h-64 md:h-80 rounded-lg border border-input bg-background p-4 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary shadow-inner"
            />
          </CardItem>
        )}

        {/* Tab Content 3: Honcho Cloud Provider Status */}
        {activeTab === "HONCHO" && (
          <div className="mt-4 p-4 sm:p-5 rounded-lg border border-border/40 bg-muted/10 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/40 pb-3">
              <div className="flex items-center gap-2">
                <Cloud className="h-5 w-5 text-primary" />
                <h3 className="font-semibold text-sm">Honcho Cloud Provider Status</h3>
              </div>
              <span className={`px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 self-start sm:self-auto ${honchoStatus?.configured ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20" : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"}`}>
                {honchoStatus?.configured ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
                {honchoStatus?.configured ? "Connected & Live" : "Optional / Unconfigured"}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="space-y-1 p-3 rounded-md bg-card border border-border/40">
                <p className="font-semibold text-muted-foreground">Honcho Base API URL</p>
                <p className="font-mono text-foreground break-all">{honchoStatus?.api_url || "Not set"}</p>
              </div>
              <div className="space-y-1 p-3 rounded-md bg-card border border-border/40">
                <p className="font-semibold text-muted-foreground">Workspace Name</p>
                <p className="font-mono text-foreground break-all">{honchoStatus?.workspace || "default_workspace"}</p>
              </div>
            </div>

            <div className="p-3.5 rounded-lg border border-border/40 bg-card text-xs space-y-2">
              <p className="font-semibold">How Honcho Works in 3-Layer Memory:</p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1">
                <li><strong>Local Files (`USER.md` / `MEMORY.md`)</strong> handle immediate preferences & standing instructions.</li>
                <li><strong>Honcho Cloud Provider</strong> handles cross-session message searching, Peer Identity Cards, and Dialectic reasoning.</li>
                <li>When Honcho is active, its tools (<code className="font-mono bg-muted px-1 rounded">honcho_search</code>, <code className="font-mono bg-muted px-1 rounded">honcho_reasoning</code>, <code className="font-mono bg-muted px-1 rounded">honcho_profile</code>) are automatically available to your agent.</li>
              </ul>
            </div>
          </div>
        )}
      </JanCard>
    </div>
  );
}
