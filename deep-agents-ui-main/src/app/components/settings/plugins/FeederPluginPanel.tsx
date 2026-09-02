"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  Rss, ExternalLink, Settings2, AlarmClock, Globe, Database, ChevronRight
} from "lucide-react";
import { JanCard, CardItem } from "@/components/settings/JanCard";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/lib/supabase";
import { PluginInfo } from "@/lib/plugins";

/**
 * Compact feeder plugin card: enable/disable, live status summary, and links
 * into the dedicated Dashboard & Settings pages (single source of truth for
 * all feeder configuration).
 */
export function FeederPluginPanel({
  plugin,
  onToggle,
  toggling,
}: {
  plugin: PluginInfo;
  onToggle: (key: string, enabled: boolean) => void;
  toggling: boolean;
}) {
  const [activeSources, setActiveSources] = useState(0);
  const [scheduledWorkflows, setScheduledWorkflows] = useState<string[]>([]);
  const [pending, setPending] = useState(0);

  const load = async () => {
    try {
      const [srcRes, wfRes, pendRes] = await Promise.all([
        supabase.from("feeder_sources").select("id", { count: "exact", head: true }).eq("is_active", true),
        supabase.from("workflows").select("name, feeder_interval_minutes").eq("is_active", true).eq("feeder_enabled", true),
        supabase.from("feeder_articles").select("id", { count: "exact", head: true }).eq("status", "Pending"),
      ]);
      setActiveSources(srcRes.count ?? 0);
      setScheduledWorkflows((wfRes.data ?? []).map((w: any) => `${w.name} (${w.feeder_interval_minutes}m)`));
      setPending(pendRes.count ?? 0);
    } catch (e) {
      console.error("Failed to load feeder summary:", e);
    }
  };

  useEffect(() => {
    load();
  }, [plugin.enabled]);

  return (
    <div className="space-y-4">
      <JanCard>
        <CardItem
          align="start"
          className="flex-col sm:flex-row gap-3"
          title={
            <span className="flex items-center gap-2">
              <Rss className="h-5 w-5 text-primary" />
              Feeder Plugin
              {plugin.enabled ? (
                <span className="text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded-full font-semibold uppercase border border-emerald-500/20">
                  Active
                </span>
              ) : (
                <span className="text-[10px] bg-muted text-muted-foreground px-2 py-0.5 rounded-full font-semibold uppercase border border-border/50">
                  Disabled
                </span>
              )}
            </span>
          }
          description="Fetches articles from your RSS feeds on a per-workflow schedule, deduplicates them with AI, and queues them for the agent."
          actions={
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground">
                {plugin.enabled ? "On" : "Off"}
              </span>
              <Switch
                checked={plugin.enabled}
                disabled={toggling}
                onCheckedChange={(checked: boolean) =>
                  onToggle(plugin.plugin_key, checked)
                }
              />
            </div>
          }
        />
      </JanCard>

      {plugin.enabled && (
        <JanCard title="At a Glance">
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
              <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
                <div className="rounded-lg p-2 bg-primary/10 text-primary"><Globe className="h-4 w-4" /></div>
                <div className="min-w-0">
                  <p className="text-lg font-bold leading-tight">{activeSources}</p>
                  <p className="text-xs text-muted-foreground truncate">Active feed sources</p>
                </div>
              </div>
              <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
                <div className="rounded-lg p-2 bg-primary/10 text-primary"><AlarmClock className="h-4 w-4" /></div>
                <div className="min-w-0">
                  <p className="text-lg font-bold leading-tight">{scheduledWorkflows.length}</p>
                  <p className="text-xs text-muted-foreground truncate" title={scheduledWorkflows.join(", ")}>
                    {scheduledWorkflows.length > 0 ? `Auto-run: ${scheduledWorkflows.join(", ")}` : "No workflow on auto-run"}
                  </p>
                </div>
              </div>
              <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
                <div className="rounded-lg p-2 bg-amber-500/10 text-amber-500"><Database className="h-4 w-4" /></div>
                <div className="min-w-0">
                  <p className="text-lg font-bold leading-tight">{pending}</p>
                  <p className="text-xs text-muted-foreground truncate">Pending articles in queue</p>
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-2 pt-4">
              <Link href="/feeder" className="flex-1">
                <Button className="w-full gap-1.5 text-xs font-semibold">
                  <ExternalLink className="h-3.5 w-3.5" />Open Dashboard
                  <ChevronRight className="h-3.5 w-3.5 ml-auto" />
                </Button>
              </Link>
              <Link href="/feeder/settings" className="flex-1">
                <Button variant="outline" className="w-full gap-1.5 text-xs font-semibold">
                  <Settings2 className="h-3.5 w-3.5" />Feeder Settings
                  <ChevronRight className="h-3.5 w-3.5 ml-auto" />
                </Button>
              </Link>
            </div>
          </JanCard>
      )}
    </div>
  );
}
