"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import {
    Settings, Home, Activity, Database, RefreshCw, Trash2,
    Rss, Globe, Clock, ChevronRight, AlarmClock
} from "lucide-react";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { PluginGate } from "@/app/components/settings/PluginsSection";
import { StatCard, FeederWorkflow, minutesLabel, formatPKT } from "./_components/feeder-ui";
import { RunHistoryCard } from "./_components/run-history";

interface PendingArticle {
    id: string;
    title: string;
    source_domain: string;
    published_at: string | null;
    created_at: string;
    url: string;
}

export default function FeederDashboard() {
    const [workflows, setWorkflows] = useState<FeederWorkflow[]>([]);
    const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
    const [stats, setStats] = useState({ pending: 0, processing: 0, done: 0, total: 0 });
    const [pendingArticles, setPendingArticles] = useState<PendingArticle[]>([]);
    const [isFetching, setIsFetching] = useState(false);
    const [pipelineLog, setPipelineLog] = useState<string>("");
    const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

    const selectedWorkflow = workflows.find(w => w.id === selectedWorkflowId);

    const loadData = useCallback(async (workflowId: string) => {
        if (!workflowId) return;
        try {
            const [pendRes, procRes, doneRes, artRes] = await Promise.all([
                supabase.from("feeder_articles").select("id", { count: "exact", head: true }).eq("status", "Pending").eq("workflow_id", workflowId),
                supabase.from("feeder_articles").select("id", { count: "exact", head: true }).eq("status", "Processing").eq("workflow_id", workflowId),
                supabase.from("feeder_articles").select("id", { count: "exact", head: true }).eq("status", "Done").eq("workflow_id", workflowId),
                supabase.from("feeder_articles").select("id", { count: "exact", head: true }).eq("workflow_id", workflowId),
            ]);
            setStats({
                pending: pendRes.count ?? 0,
                processing: procRes.count ?? 0,
                done: doneRes.count ?? 0,
                total: artRes.count ?? 0,
            });

            // Load pending articles list (FIFO — oldest first)
            const { data } = await supabase
                .from("feeder_articles")
                .select("id,title,source_domain,published_at,created_at,url")
                .eq("status", "Pending")
                .eq("workflow_id", workflowId)
                .order("created_at", { ascending: true })
                .limit(50);
            setPendingArticles(data ?? []);
        } catch (e) {
            console.error(e);
        }
    }, []);

    // Load active workflows on mount
    useEffect(() => {
        const loadWorkflows = async () => {
            try {
                const { data } = await supabase
                    .from("workflows")
                    .select("id, name, is_active, feeder_enabled, feeder_interval_minutes, feeder_last_trigger_at, feeder_max_age_minutes, feeder_max_articles_per_run, feeder_cluster_threshold")
                    .eq("is_active", true)
                    .order("name");
                if (data && data.length > 0) {
                    setWorkflows(data);
                    setSelectedWorkflowId(data[0].id);
                }
            } catch (e) {
                console.error("Error loading workflows:", e);
            }
        };
        loadWorkflows();
    }, []);

    // Reload data when selected workflow changes
    useEffect(() => {
        if (selectedWorkflowId) {
            loadData(selectedWorkflowId);
        }
    }, [selectedWorkflowId, loadData]);

    const triggerPipeline = async () => {
        if (!selectedWorkflowId) return;
        setIsFetching(true);
        setPipelineLog("Running pipeline…");
        try {
            const res = await fetch("/api/feeder/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ workflow_id: selectedWorkflowId }),
            });
            const data = await res.json();
            if (data.success) {
                setPipelineLog(data.log || "Pipeline ran successfully.");
            } else {
                setPipelineLog("Error: " + data.error);
            }
        } catch (e: any) {
            setPipelineLog("Error: " + e.message);
        } finally {
            setIsFetching(false);
            if (selectedWorkflowId) {
                loadData(selectedWorkflowId);
            }
            setHistoryRefreshKey(k => k + 1);
        }
    };

    const clearPending = async () => {
        if (!selectedWorkflowId) return;
        if (!confirm("Delete all Pending articles for this workflow?")) return;
        await supabase.from("feeder_articles").delete().eq("status", "Pending").eq("workflow_id", selectedWorkflowId);
        loadData(selectedWorkflowId);
    };

    return (
        <PluginGate pluginKey="feeder">
        <div className="flex h-screen flex-col bg-background">
            <header className="flex flex-wrap shrink-0 items-center gap-x-3 gap-y-2 border-b px-4 sm:px-6 py-2">
                <div className="flex items-center gap-2 min-w-0">
                    <Activity className="h-5 w-5 text-primary shrink-0" />
                    <h1 className="text-lg sm:text-xl font-semibold truncate">Feeder Dashboard</h1>
                </div>
                {workflows.length > 0 && (
                    <select
                        value={selectedWorkflowId}
                        onChange={e => setSelectedWorkflowId(e.target.value)}
                        className="h-8 rounded-lg border border-input bg-background px-2 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-primary transition-all max-w-[160px] sm:max-w-none"
                    >
                        {workflows.map(wf => (
                            <option key={wf.id} value={wf.id}>{wf.name}</option>
                        ))}
                    </select>
                )}
                <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
                    <ThemeToggle />
                    <Button
                        onClick={triggerPipeline}
                        disabled={isFetching || !selectedWorkflowId}
                        size="sm"
                        className="bg-primary text-primary-foreground h-8"
                    >
                        <Rss className={`h-4 w-4 sm:mr-2 ${isFetching ? "animate-pulse" : ""}`} />
                        <span className="hidden sm:inline">{isFetching ? "Running…" : "Run Feeder"}</span>
                    </Button>
                    <Button
                        variant="destructive"
                        size="sm"
                        onClick={clearPending}
                        disabled={isFetching || !selectedWorkflowId}
                        className="h-8"
                        title="Clear pending articles"
                    >
                        <Trash2 className="h-4 w-4 sm:mr-2" />
                        <span className="hidden sm:inline">Clear Pending</span>
                    </Button>
                    <Button
                        variant="outline" size="sm" className="h-8"
                        onClick={() => selectedWorkflowId && loadData(selectedWorkflowId)}
                        disabled={!selectedWorkflowId}
                        title="Refresh"
                    >
                        <RefreshCw className="h-4 w-4" />
                    </Button>
                    <Link href="/feeder/settings">
                        <Button variant="outline" size="sm" className="h-8" title="Feeder settings">
                            <Settings className="h-4 w-4 sm:mr-2" />
                            <span className="hidden sm:inline">Settings</span>
                        </Button>
                    </Link>
                    <Link href="/">
                        <Button variant="outline" size="sm" className="h-8" title="Back to agent">
                            <Home className="h-4 w-4" />
                        </Button>
                    </Link>
                </div>
            </header>

            <main className="flex-1 overflow-auto p-4 sm:p-6 space-y-4 sm:space-y-6">
                {/* Schedule status strip */}
                {selectedWorkflow && (
                    <div className="rounded-xl border bg-card shadow-sm px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                        <span className="flex items-center gap-1.5 font-semibold text-foreground">
                            <AlarmClock className="h-3.5 w-3.5 text-primary" />
                            {selectedWorkflow.feeder_enabled
                                ? <>Auto-run every {minutesLabel(selectedWorkflow.feeder_interval_minutes)}</>
                                : <>Auto-run is off</>}
                        </span>
                        <span className="text-muted-foreground">
                            Keeps {selectedWorkflow.feeder_max_articles_per_run ?? 100} articles/run · window {minutesLabel(selectedWorkflow.feeder_max_age_minutes ?? 60)}
                        </span>
                        <span className="text-muted-foreground">Last run: {formatPKT(selectedWorkflow.feeder_last_trigger_at)}</span>
                        <Link
                            href="/feeder/settings/schedule"
                            className="ml-auto font-semibold text-primary hover:underline"
                        >
                            Change schedule
                        </Link>
                    </div>
                )}

                {/* Stats row */}
                <div className="grid gap-3 sm:gap-4 grid-cols-2 md:grid-cols-4">
                    <StatCard label="Pending" value={stats.pending} icon={Database} color="text-amber-500" sub="In queue" />
                    <StatCard label="Processing" value={stats.processing} icon={Activity} sub="With agent" />
                    <StatCard label="Done" value={stats.done} icon={Activity} color="text-emerald-600" sub="Completed" />
                    <StatCard label="Total" value={stats.total} icon={Globe} color="text-muted-foreground" sub="All articles" />
                </div>

                {/* Pipeline log */}
                {pipelineLog && (
                    <div className="rounded-xl border bg-card shadow-sm p-4">
                        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
                            Last Pipeline Output
                        </p>
                        <pre className="text-xs whitespace-pre-wrap text-foreground font-mono max-h-48 overflow-auto">
                            {pipelineLog}
                        </pre>
                    </div>
                )}

                {/* Run history: which layer stopped which article, and why */}
                <RunHistoryCard workflowId={selectedWorkflowId} refreshKey={historyRefreshKey} />

                {/* Pending articles list */}
                <div className="rounded-xl border bg-card shadow-sm">
                    <div className="p-4 border-b flex items-center gap-2">
                        <Database className="h-4 w-4 text-primary" />
                        <h2 className="font-semibold">Pending Articles</h2>
                        <span className="ml-auto text-xs text-muted-foreground">
                            {stats.pending} ready · FIFO order
                        </span>
                    </div>
                    <div className="divide-y max-h-[420px] overflow-auto">
                        {pendingArticles.length === 0 ? (
                            <div className="p-8 text-center text-muted-foreground text-sm">
                                No pending articles. Run the feeder or enable auto-run in Settings → Schedule.
                            </div>
                        ) : (
                            pendingArticles.map((art, i) => (
                                <div key={art.id} className="flex items-start gap-3 p-3 hover:bg-muted/40 transition-colors">
                                    <span className="text-xs text-muted-foreground w-5 shrink-0 mt-0.5">{i + 1}</span>
                                    <div className="flex-1 min-w-0">
                                        <a
                                            href={art.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-sm font-medium text-foreground hover:text-primary hover:underline line-clamp-2 transition-colors"
                                        >
                                            {art.title}
                                        </a>
                                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                                            <span className="flex items-center gap-1 min-w-0">
                                                <Globe className="h-3 w-3 shrink-0" />
                                                <span className="truncate">{art.source_domain}</span>
                                            </span>
                                            <span className="flex items-center gap-1 shrink-0">
                                                <Clock className="h-3 w-3" />
                                                {formatPKT(art.published_at || art.created_at)}
                                            </span>
                                        </div>
                                    </div>
                                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </main>
        </div>
        </PluginGate>
    );
}
