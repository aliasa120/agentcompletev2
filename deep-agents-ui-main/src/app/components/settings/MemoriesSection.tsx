"use client";

import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Brain, Trash2, Search, Sparkles, Loader2, Database, AlertCircle, RefreshCw, Layers, Save, CheckCircle2
} from "lucide-react";
import { toast } from "sonner";
import { LLM_PROVIDERS } from "./ProviderOrderingSection";

interface Memory {
  id: string;
  text: string;
  created_at: string;
  user_id: string;
  score?: number;
}

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
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [isClearing, setIsClearing] = useState<boolean>(false);

  const mem0Enabled = globalSettings.mem0_enabled === "true";
  const selectedProvider = globalSettings.mem0_extraction_provider || "ninerouter";
  const selectedModel = globalSettings.mem0_extraction_model || "oc/auto";

  const [providerMetas, setProviderMetas] = useState<any[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    setLoadingModels(true);
    fetch("/api/provider-status")
      .then(r => r.json())
      .then(data => {
        setProviderMetas(data.providers || []);
      })
      .catch(err => {
        console.error("Failed to load providers in MemoriesSection:", err);
      })
      .finally(() => setLoadingModels(false));
  }, []);

  const providerMeta = providerMetas.find(p => p.id === selectedProvider) || providerMetas[0];
  const models = providerMeta?.defaultModels || [];

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

  // Load memories for the selected workflow
  const loadMemories = useCallback(async (query: string = "") => {
    if (!selectedWorkflowId) return;
    setLoading(true);
    try {
      const url = new URL("/api/memories", window.location.origin);
      url.searchParams.set("workflow_id", selectedWorkflowId);
      if (query.trim()) {
        url.searchParams.set("query", query.trim());
      }
      
      const response = await fetch(url.toString());
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to load memories");
      }
      setMemories(data.memories ?? []);
    } catch (e: any) {
      console.error(e);
      toast.error(e.message || "Failed to load memories from Pinecone");
    } finally {
      setLoading(false);
    }
  }, [selectedWorkflowId]);

  useEffect(() => {
    if (selectedWorkflowId) {
      loadMemories(searchQuery);
    }
  }, [selectedWorkflowId, loadMemories]);

  // Handle single memory deletion
  const handleDeleteMemory = async (memoryId: string) => {
    try {
      const response = await fetch(`/api/memories?id=${memoryId}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to delete memory");
      }
      toast.success("Fact deleted successfully from Pinecone.");
      // Refresh current memory list
      loadMemories(searchQuery);
    } catch (e: any) {
      toast.error(e.message || "Failed to delete fact");
    }
  };

  // Handle clearing all memories for selected workflow
  const handleClearAllMemories = async () => {
    if (!window.confirm("Are you sure you want to permanently clear all memories and graph nodes for this workflow? This action cannot be undone.")) {
      return;
    }
    
    setIsClearing(true);
    try {
      const response = await fetch(`/api/memories?workflow_id=${selectedWorkflowId}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to clear memories");
      }
      toast.success(data.message || "All memories for workflow cleared successfully.");
      setSearchQuery("");
      loadMemories("");
    } catch (e: any) {
      toast.error(e.message || "Failed to clear memories");
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Premium Header Card */}
      <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card to-background p-6 shadow-md">
        <div className="absolute right-0 top-0 -mr-6 -mt-6 h-36 w-36 rounded-full bg-primary/5 blur-3xl" />
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Brain className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight">Agent Memories</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Configure long-term memory providers, and view, search, or purge facts and entity relationships.
            </p>
          </div>
        </div>
      </div>

      {/* Mem0 Provider Configuration (Moved from Providers section) */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3 border-b bg-muted/20">
          <Brain className="h-4 w-4 text-primary animate-pulse" />
          <span className="font-semibold text-sm">Mem0 Memory & Pinecone Integration</span>
          <span className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full ml-1">
            Isolated agent memory stored centrally in Pinecone
          </span>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between p-3.5 rounded-lg border bg-muted/20">
            <div>
              <p className="text-xs font-semibold">Enable Mem0 Long-Term Memory</p>
              <p className="text-[10px] text-muted-foreground">Isolate and persist memories per agent in your Pinecone index ("memories")</p>
            </div>
            <button
              onClick={() => setGlobalSetting("mem0_enabled", mem0Enabled ? "false" : "true")}
              className={`relative w-11 h-6 rounded-full transition-colors ${mem0Enabled ? "bg-primary" : "bg-muted-foreground/30"}`}
            >
              <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${mem0Enabled ? "left-6" : "left-1"}`} />
            </button>
          </div>

          {mem0Enabled && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 rounded-lg border bg-card shadow-inner">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground mb-1 block">Memory Extraction Provider</label>
                <select
                  value={selectedProvider}
                  onChange={e => {
                    const prov = e.target.value;
                    setGlobalSetting("mem0_extraction_provider", prov);
                    const nextMeta = providerMetas.find(p => p.id === prov) || providerMetas[0];
                    if (nextMeta && nextMeta.defaultModels && nextMeta.defaultModels.length) {
                      setGlobalSetting("mem0_extraction_model", nextMeta.defaultModels[0].value);
                    }
                  }}
                  className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary transition-all font-medium"
                  disabled={providerMetas.length === 0}
                >
                  {providerMetas.length === 0 ? (
                    <option value="">No gateway providers configured</option>
                  ) : (
                    providerMetas.map(p => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))
                  )}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground mb-1 block">Memory Extraction Model</label>
                <select
                  value={selectedModel}
                  onChange={e => setGlobalSetting("mem0_extraction_model", e.target.value)}
                  className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary transition-all font-mono"
                  disabled={loadingModels}
                >
                  {loadingModels ? (
                    <option value="">Loading dynamic models...</option>
                  ) : (
                    models.map((m: any) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))
                  )}
                </select>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <Button
              onClick={saveGlobalSettings}
              disabled={saveStatus === "saving"}
              className="bg-primary text-primary-foreground text-xs font-semibold h-9 px-4 flex items-center gap-1.5"
            >
              {saveStatus === "saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save Memory Config
            </Button>
            {saveStatus === "saved" && (
              <span className="text-xs font-semibold text-emerald-500 flex items-center gap-1 animate-pulse">
                <CheckCircle2 className="h-4 w-4" /> Config saved successfully!
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Configurations & Details Banner */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="flex items-start gap-3 p-4 rounded-xl border bg-card/40">
          <Layers className="h-4.5 w-4.5 text-primary mt-0.5 shrink-0" />
          <div className="text-xs">
            <p className="font-semibold">Composite Scoping</p>
            <p className="text-muted-foreground mt-1 leading-relaxed">
              Memories are isolated per-user and per-workflow (`User_Workflow` namespace) to safeguard private facts across sessions.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 p-4 rounded-xl border bg-card/40">
          <Sparkles className="h-4.5 w-4.5 text-indigo-500 mt-0.5 shrink-0" />
          <div className="text-xs">
            <p className="font-semibold">Ingestion Gating</p>
            <p className="text-muted-foreground mt-1 leading-relaxed">
              Mem0 instructions filter out greetings/formatting rules automatically, avoiding long-term memory clutter.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 p-4 rounded-xl border bg-card/40">
          <Database className="h-4.5 w-4.5 text-emerald-500 mt-0.5 shrink-0" />
          <div className="text-xs">
            <p className="font-semibold">Graph Database</p>
            <p className="text-muted-foreground mt-1 leading-relaxed">
              Entity graph relationships (e.g. `User` ──► `likes` ──► `Python`) are stored in Neo4j to support multi-hop reasoning.
            </p>
          </div>
        </div>
      </div>

      {/* Control Panel */}
      <div className="rounded-xl border bg-card p-5 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">
              Select Agent Workflow
            </label>
            <select
              value={selectedWorkflowId}
              onChange={(e) => {
                setSelectedWorkflowId(e.target.value);
                setSearchQuery("");
              }}
              className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary transition-all"
            >
              {workflows.length === 0 ? (
                <option value="">No workflows available</option>
              ) : (
                workflows.map((wf) => (
                  <option key={wf.id} value={wf.id}>
                    {wf.name}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="flex-1 min-w-[260px]">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">
              Semantic Query Search
            </label>
            <div className="relative">
              <Input
                type="text"
                placeholder="Search memories semantically..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    loadMemories(searchQuery);
                  }
                }}
                className="pl-9 pr-8 h-9"
              />
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              {searchQuery && (
                <button
                  onClick={() => {
                    setSearchQuery("");
                    loadMemories("");
                  }}
                  className="absolute right-3 top-2.5 text-xs text-muted-foreground hover:text-foreground font-medium"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="flex items-end gap-2 shrink-0 pt-0 sm:pt-5">
            <Button
              onClick={() => loadMemories(searchQuery)}
              disabled={loading || !selectedWorkflowId}
              variant="outline"
              size="sm"
              className="gap-1 h-9"
            >
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Refresh
            </Button>
            <Button
              onClick={handleClearAllMemories}
              disabled={isClearing || memories.length === 0 || !selectedWorkflowId}
              variant="destructive"
              size="sm"
              className="gap-1 h-9"
            >
              {isClearing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Clear All
            </Button>
          </div>
        </div>
      </div>

      {/* Memories List */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="p-4 border-b bg-muted/30 flex items-center justify-between">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            Facts Stored in Pinecone
          </h3>
          <span className="text-xs bg-primary/10 text-primary font-medium px-2 py-0.5 rounded-full">
            {memories.length} matches
          </span>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center p-12 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-3" />
            <p className="text-sm font-medium">Retrieving vector embeddings from Pinecone...</p>
          </div>
        ) : memories.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 text-center">
            <div className="h-10 w-10 rounded-full bg-muted/60 flex items-center justify-center mb-3">
              <AlertCircle className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">No memories found</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              {searchQuery
                ? "No memories matched your semantic search criteria. Try a different query."
                : "This workflow has no long-term memories stored yet. Talk to the agent to build memories."}
            </p>
          </div>
        ) : (
          <div className="divide-y max-h-[460px] overflow-y-auto scrollbar-pretty">
            {memories.map((mem) => {
              const isComposite = mem.user_id && mem.user_id.includes("_");
              return (
                <div key={mem.id} className="p-4 flex items-start justify-between gap-4 hover:bg-muted/10 transition-colors">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground leading-relaxed">
                      {mem.text}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        Created: {mem.created_at ? new Date(mem.created_at).toLocaleString() : "Unknown"}
                      </span>
                      <span>•</span>
                      <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-[10px]">
                        ID: {mem.id.slice(0, 8)}...
                      </span>
                      <span>•</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        isComposite 
                          ? "bg-indigo-500/10 text-indigo-400" 
                          : "bg-emerald-500/10 text-emerald-400"
                      }`}>
                        {isComposite ? "User-Isolated Scope" : "Workflow Scope"}
                      </span>
                    </div>
                  </div>
                  <Button
                    onClick={() => handleDeleteMemory(mem.id)}
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0 p-2 h-8 w-8"
                    title="Delete Memory Fact"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
