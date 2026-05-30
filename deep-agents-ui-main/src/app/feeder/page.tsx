"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import {
    Settings, Home, Activity, Database, RefreshCw, Trash2,
    Rss, Globe, Clock, ChevronRight
} from "lucide-react";

interface PendingArticle {
    id: string;
    title: string;
    source_domain: string;
    published_at: string | null;
    created_at: string;
    url: string;
}

function formatPKT(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString("en-PK", {
        timeZone: "Asia/Karachi",
        month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
        hour12: false,
    });
}

export default function FeederDashboard() {
    const [stats, setStats] = useState({ pending: 0, processing: 0, done: 0, total: 0 });
    const [pendingArticles, setPendingArticles] = useState<PendingArticle[]>([]);
    const [isFetching, setIsFetching] = useState(false);
    const [pipelineLog, setPipelineLog] = useState<string>("");

    const loadData = useCallback(async () => {
        try {
            const [pendRes, procRes, doneRes, artRes] = await Promise.all([
                supabase.from("feeder_articles").select("id", { count: "exact", head: true }).eq("status", "Pending"),
                supabase.from("feeder_articles").select("id", { count: "exact", head: true }).eq("status", "Processing"),
                supabase.from("feeder_articles").select("id", { count: "exact", head: true }).eq("status", "Done"),
                supabase.from("feeder_articles").select("id", { count: "exact", head: true }),
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
                .order("created_at", { ascending: true })
                .limit(50);
            setPendingArticles(data ?? []);
        } catch (e) {
            console.error(e);
        }
    }, []);

    useEffect(() => { loadData(); }, [loadData]);

    const triggerPipeline = async () => {
        setIsFetching(true);
        setPipelineLog("Running pipeline…");
        try {
            const res = await fetch("/api/feeder/run", { method: "POST" });
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
            loadData();
        }
    };

    const clearPending = async () => {
        if (!confirm("Delete all Pending articles?")) return;
        await supabase.from("feeder_articles").delete().eq("status", "Pending");
        loadData();
    };

    return (
        <div className="flex h-screen flex-col bg-background">
            <header className="flex h-16 shrink-0 items-center justify-between border-b px-6">
                <div className="flex items-center gap-3">
                    <Activity className="h-5 w-5 text-primary" />
                    <h1 className="text-xl font-semibold">Feeder Dashboard</h1>
                </div>
                <div className="flex items-center gap-2">
                    {/* Run Pipeline — moved to header per user request */}
                    <Button
                        onClick={triggerPipeline}
                        disabled={isFetching}
                        size="sm"
                        className="bg-primary text-primary-foreground"
                    >
                        <Rss className={`mr-2 h-4 w-4 ${isFetching ? "animate-pulse" : ""}`} />
                        {isFetching ? "Running…" : "Run Feeder"}
                    </Button>

                    {/* Clear Pending — moved to header per user request */}
                    <Button
                        variant="destructive"
                        size="sm"
                        onClick={clearPending}
                        disabled={isFetching}
                    >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Clear Pending
                    </Button>

                    <Button variant="outline" size="sm" onClick={loadData}>
                        <RefreshCw className="mr-2 h-4 w-4" />Refresh
                    </Button>
                    <Link href="/feeder/settings">
                        <Button variant="outline" size="sm">
                            <Settings className="mr-2 h-4 w-4" />Settings
                        </Button>
                    </Link>
                    <Link href="/">
                        <Button variant="outline" size="sm">
                            <Home className="mr-2 h-4 w-4" />Agent
                        </Button>
                    </Link>
                </div>
            </header>

            <main className="flex-1 overflow-auto p-6 space-y-6">
                {/* Stats row */}
                <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
                    {[
                        { label: "Pending", value: stats.pending, icon: Database, color: "text-yellow-500", sub: "In queue" },
                        { label: "Processing", value: stats.processing, icon: Activity, color: "text-blue-500", sub: "With agent" },
                        { label: "Done", value: stats.done, icon: Activity, color: "text-green-500", sub: "Completed" },
                        { label: "Total", value: stats.total, icon: Globe, color: "text-purple-500", sub: "All articles" },
                    ].map(({ label, value, icon: Icon, color, sub }) => (
                        <div key={label} className="rounded-xl border bg-card shadow-sm p-4 flex items-center gap-4">
                            <div className={`rounded-lg p-2.5 bg-muted ${color}`}>
                                <Icon className="h-5 w-5" />
                            </div>
                            <div>
                                <p className="text-xs text-muted-foreground">{label}</p>
                                <p className="text-2xl font-bold">{value}</p>
                                <p className="text-xs text-muted-foreground">{sub}</p>
                            </div>
                        </div>
                    ))}
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

                {/* Pending articles list */}
                <div className="rounded-xl border bg-card shadow-sm">
                    <div className="p-4 border-b flex items-center gap-2">
                        <Database className="h-4 w-4 text-yellow-500" />
                        <h2 className="font-semibold">Pending Articles</h2>
                        <span className="ml-auto text-xs text-muted-foreground">
                            {stats.pending} ready · FIFO order
                        </span>
                    </div>
                    <div className="divide-y max-h-[420px] overflow-auto">
                        {pendingArticles.length === 0 ? (
                            <div className="p-8 text-center text-muted-foreground text-sm">
                                No pending articles. Run the feeder pipeline to fetch new ones.
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
                                            className="text-sm font-medium hover:underline line-clamp-2"
                                        >
                                            {art.title}
                                        </a>
                                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                                            <span className="flex items-center gap-1">
                                                <Globe className="h-3 w-3" />{art.source_domain}
                                            </span>
                                            <span className="flex items-center gap-1">
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
    );
}
