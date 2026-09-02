"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import {
    Database, ShieldCheck, Activity, Timer, BarChart3,
    Rss, Filter, AlarmClock, Sparkles, ChevronRight, BadgeCheck
} from "lucide-react";
import { StatCard, SectionCard, FeederWorkflow, minutesLabel, formatPKT } from "../_components/feeder-ui";

const NAV_CARDS = [
    {
        href: "/feeder/settings/sources", icon: Rss, title: "Feed Sources",
        description: "Add RSS feeds (incl. a guided Google News builder) and assign them to workflows.",
    },
    {
        href: "/feeder/settings/filters", icon: Filter, title: "Filters & Limits",
        description: "Per-workflow time window, articles per run, clustering and whitelisted domains.",
    },
    {
        href: "/feeder/settings/schedule", icon: AlarmClock, title: "Auto-Run Schedule",
        description: "Turn the background feeder on or off per workflow and set how often it runs.",
    },
    {
        href: "/feeder/settings/ai", icon: Sparkles, title: "AI Model",
        description: "Choose the LLM that decides which articles are unique (per user).",
    },
    {
        href: "/feeder/settings/data", icon: Database, title: "Data & Cleanup",
        description: "Inspect stored data, clear tables, or reset everything.",
    },
];

export default function FeederSettingsOverview() {
    const [workflows, setWorkflows] = useState<FeederWorkflow[]>([]);
    const [statsWorkflowId, setStatsWorkflowId] = useState<string>("");
    const [stats, setStats] = useState({ guids: 0, hashes: 0, articles: 0, pending: 0, done: 0 });
    const [sourceCount, setSourceCount] = useState(0);

    const loadStats = useCallback(async (workflowId: string) => {
        try {
            let guidQuery = supabase.from("feeder_seen_guids").select("id", { count: "exact", head: true });
            let hashQuery = supabase.from("feeder_seen_hashes").select("id", { count: "exact", head: true });
            let artQuery = supabase.from("feeder_articles").select("status");

            if (workflowId) {
                guidQuery = guidQuery.eq("workflow_id", workflowId);
                hashQuery = hashQuery.eq("workflow_id", workflowId);
                artQuery = artQuery.eq("workflow_id", workflowId);
            }

            const [guidRes, hashRes, artRes] = await Promise.all([guidQuery, hashQuery, artQuery]);
            const statusCounts: Record<string, number> = {};
            for (const a of artRes.data ?? []) {
                statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
            }
            setStats({
                guids: guidRes.count ?? 0,
                hashes: hashRes.count ?? 0,
                articles: artRes.data?.length ?? 0,
                pending: statusCounts["Pending"] ?? 0,
                done: statusCounts["Done"] ?? 0,
            });
        } catch (e) {
            console.error("Error loading stats:", e);
        }
    }, []);

    useEffect(() => {
        const load = async () => {
            const [wfsRes, srcRes] = await Promise.all([
                supabase.from("workflows")
                    .select("id, name, is_active, feeder_enabled, feeder_interval_minutes, feeder_last_trigger_at, feeder_max_age_minutes, feeder_max_articles_per_run, feeder_cluster_threshold")
                    .order("name"),
                supabase.from("feeder_sources").select("id", { count: "exact", head: true }).eq("is_active", true),
            ]);
            setWorkflows(wfsRes.data ?? []);
            setSourceCount(srcRes.count ?? 0);
        };
        load();
    }, []);

    useEffect(() => { loadStats(statsWorkflowId); }, [statsWorkflowId, loadStats]);

    return (
        <div className="space-y-6 max-w-6xl mx-auto">
            {/* Stats */}
            <SectionCard
                title="Database Statistics"
                icon={BarChart3}
                badge={
                    <select
                        value={statsWorkflowId}
                        onChange={e => setStatsWorkflowId(e.target.value)}
                        className="h-8 rounded border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary font-semibold max-w-[140px] sm:max-w-none"
                    >
                        <option value="">All workflows</option>
                        {workflows.map(w => (
                            <option key={w.id} value={w.id}>{w.name}</option>
                        ))}
                    </select>
                }
            >
                <div className="p-4 grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
                    <StatCard label="Seen GUIDs" value={stats.guids} icon={Database} sub="Dedup layer 1" />
                    <StatCard label="Seen Hashes" value={stats.hashes} icon={ShieldCheck} sub="Dedup layer 2" />
                    <StatCard label="Articles Total" value={stats.articles} icon={Activity} color="text-muted-foreground" sub="All statuses" />
                    <StatCard label="Pending" value={stats.pending} icon={Timer} color="text-amber-500" sub="In queue" />
                    <StatCard label="Done" value={stats.done} icon={BadgeCheck} color="text-emerald-600" sub="Processed" />
                </div>
            </SectionCard>

            {/* Schedule status */}
            <SectionCard title="Auto-Run Status" icon={AlarmClock} badge={
                <Link href="/feeder/settings/schedule" className="text-primary hover:underline font-semibold">Manage</Link>
            }>
                <div className="divide-y divide-border/50">
                    {workflows.length === 0 && (
                        <p className="p-4 text-sm text-muted-foreground">No workflows yet. Create one in Agent Settings → Workflows.</p>
                    )}
                    {workflows.map(w => (
                        <div key={w.id} className="p-4 flex flex-wrap items-center gap-x-4 gap-y-1">
                            <span className="font-medium text-sm">{w.name}</span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase border ${w.feeder_enabled
                                ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                                : "bg-muted text-muted-foreground border-border/50"}`}>
                                {w.feeder_enabled ? `Auto every ${minutesLabel(w.feeder_interval_minutes)}` : "Auto-run off"}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                Last run: {formatPKT(w.feeder_last_trigger_at)}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                Keeps {w.feeder_max_articles_per_run ?? 100}/run · window {minutesLabel(w.feeder_max_age_minutes ?? 60)}
                            </span>
                        </div>
                    ))}
                </div>
                {sourceCount === 0 && workflows.length > 0 && (
                    <div className="p-4 border-t border-amber-500/30 bg-amber-500/5 text-sm text-amber-700 dark:text-amber-400 flex flex-wrap items-center gap-2">
                        <span>No active feed sources yet — the feeder has nothing to fetch.</span>
                        <Link href="/feeder/settings/sources" className="font-semibold underline">Add your first feed</Link>
                    </div>
                )}
            </SectionCard>

            {/* Navigation cards */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {NAV_CARDS.map(({ href, icon: Icon, title, description }) => (
                    <Link key={href} href={href} className="group">
                        <div className="rounded-xl border bg-card shadow-sm p-5 h-full flex flex-col gap-2 transition-all hover:border-primary/50 hover:shadow-md">
                            <div className="flex items-center gap-2">
                                <div className="rounded-lg p-2 bg-primary/10 text-primary"><Icon className="h-4 w-4" /></div>
                                <h3 className="font-semibold text-sm">{title}</h3>
                                <ChevronRight className="h-4 w-4 ml-auto text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
                        </div>
                    </Link>
                ))}
            </div>
        </div>
    );
}
