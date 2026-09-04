"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import useSWR from "swr";
import {
  FileText, ExternalLink, Bot, AlarmClock, Loader2, Save, ShieldCheck,
  Sparkles, Youtube, Globe, CheckCircle2,
} from "lucide-react";
import { JanCard, CardItem } from "@/components/settings/JanCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PluginInfo } from "@/lib/plugins";

interface Workflow {
  id: string;
  name: string;
  enabled: boolean;
  interval_minutes: number;
  batch_size: number;
}

export function PostsPluginPanel({
  plugin,
  onToggle,
  toggling,
}: {
  plugin: PluginInfo;
  onToggle: (key: string, enabled: boolean) => void;
  toggling: boolean;
}) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
  const [wfEnabled, setWfEnabled] = useState(false);
  const [wfInterval, setWfInterval] = useState("60");
  const [wfBatchSize, setWfBatchSize] = useState("2");
  const [savingWf, setSavingWf] = useState(false);
  const [wfSaveStatus, setWfSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [wfError, setWfError] = useState("");

  // WordPress settings state
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaveStatus, setSettingsSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [settingsError, setSettingsError] = useState("");

  const fetcher = (url: string) => fetch(url).then((r) => r.json());
  const { data: wfData, mutate: mutateWf } = useSWR("/api/workflows", fetcher);

  // Load WordPress settings from /api/agent-settings
  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/agent-settings");
      if (res.ok) {
        const data = await res.json();
        const map: Record<string, string> = {};
        for (const row of data.settings ?? []) {
          map[row.key] = row.value ?? "";
        }
        setSettings(map);
      }
    } catch (e) {
      console.error("Failed to load settings in PostsPluginPanel:", e);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (wfData?.workflows) {
      setWorkflows(wfData.workflows);
      if (!selectedWorkflowId && wfData.workflows.length > 0) {
        setSelectedWorkflowId(wfData.workflows[0].id);
      }
    }
  }, [wfData, selectedWorkflowId]);

  useEffect(() => {
    const activeWf = workflows.find((w) => w.id === selectedWorkflowId);
    if (activeWf) {
      setWfEnabled(activeWf.enabled ?? false);
      setWfInterval(String(activeWf.interval_minutes ?? 60));
      setWfBatchSize(String(activeWf.batch_size ?? 2));
    }
  }, [selectedWorkflowId, workflows]);

  const handleSaveWorkflowSchedule = async () => {
    if (!selectedWorkflowId) return;
    setSavingWf(true);
    setWfSaveStatus("idle");
    setWfError("");
    try {
      const res = await fetch(`/api/workflows/${selectedWorkflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: wfEnabled,
          interval_minutes: parseInt(wfInterval, 10) || 60,
          batch_size: parseInt(wfBatchSize, 10) || 2,
        }),
      });
      if (res.ok) {
        setWfSaveStatus("saved");
        mutateWf();
        setTimeout(() => setWfSaveStatus("idle"), 3000);
      } else {
        const json = await res.json().catch(() => ({}));
        setWfError(json.error || `Save failed (${res.status})`);
        setWfSaveStatus("error");
      }
    } catch (e) {
      setWfError(e instanceof Error ? e.message : "Network error");
      setWfSaveStatus("error");
    } finally {
      setSavingWf(false);
    }
  };

  const handleSaveWpSettings = async () => {
    setSavingSettings(true);
    setSettingsSaveStatus("idle");
    setSettingsError("");
    try {
      const WP_KEYS = ["wp_site_url", "wp_username", "wp_app_password", "wp_auto_publish"];
      const rows = WP_KEYS.map((key) => ({
        key,
        value: settings[key] ?? "",
      }));

      const res = await fetch("/api/agent-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });

      if (res.ok) {
        setSettingsSaveStatus("saved");
        setTimeout(() => setSettingsSaveStatus("idle"), 3000);
      } else {
        const data = await res.json().catch(() => ({}));
        setSettingsError(data.error || "Save failed");
        setSettingsSaveStatus("error");
      }
    } catch (e: any) {
      setSettingsError(e.message || "Save failed");
      setSettingsSaveStatus("error");
    } finally {
      setSavingSettings(false);
    }
  };

  const setSetting = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="space-y-6">
      {/* ── Plugin Overview Card ── */}
      <JanCard
        title="Posts Plugin"
        header={
          <div className="flex items-center justify-between gap-4 -mt-2 mb-4">
            <p className="text-sm text-muted-foreground">
              Automated and 1-click publishing hub for WordPress, YouTube, Instagram, Facebook, and X.
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {plugin.enabled ? "Active" : "Disabled"}
              </span>
              <Switch
                checked={plugin.enabled}
                onCheckedChange={(checked) => onToggle(plugin.plugin_key, checked)}
                disabled={toggling}
              />
            </div>
          </div>
        }
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 rounded-xl border border-border/70 bg-card/60 flex items-start gap-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
              <FileText className="h-5 w-5" />
            </div>
            <div>
              <p className="font-semibold text-sm">Posts & Articles Console</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                Review generated articles, YouTube shorts, Instagram reels, and Facebook posts with 1-click live publishing.
              </p>
              <Link href="/posts" className="inline-flex items-center gap-1 text-xs font-medium text-primary mt-2 hover:underline">
                Open Posts Console <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </div>

          <div className="p-4 rounded-xl border border-border/70 bg-card/60 flex items-start gap-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <p className="font-semibold text-sm">Composio Social Gateway</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                Connect YouTube, Instagram, Facebook, and X accounts in 1 click without manual API keys.
              </p>
              <Link href="/posts/settings" className="inline-flex items-center gap-1 text-xs font-medium text-primary mt-2 hover:underline">
                Manage Channels & OAuth <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </div>
        </div>
      </JanCard>

      {/* ── Workflow Schedule ── */}
      <JanCard
        title="Workflow Schedule & Automation"
        header={
          <p className="text-sm text-muted-foreground -mt-2 mb-4">
            Automate recurring post generation schedules and batch sizes.
          </p>
        }
      >
        {workflows.length > 0 ? (
          <>
            <CardItem
              title="Target Workflow"
              description="Select the workflow to configure its background cron schedule"
              actions={
                <select
                  value={selectedWorkflowId}
                  onChange={(e) => setSelectedWorkflowId(e.target.value)}
                  className="h-9 px-3 rounded-lg border border-border bg-background text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  {workflows.map((wf) => (
                    <option key={wf.id} value={wf.id}>
                      {wf.name}
                    </option>
                  ))}
                </select>
              }
            />
            <CardItem
              title="Schedule Status"
              description="Enable or pause automated background execution for this workflow"
              actions={
                <Switch
                  checked={wfEnabled}
                  onCheckedChange={(checked) => setWfEnabled(checked)}
                />
              }
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-3 border-y border-border/50">
              <div>
                <label className="text-xs font-semibold text-muted-foreground block mb-1.5">Interval (Minutes)</label>
                <Input
                  type="number"
                  min="5"
                  value={wfInterval}
                  onChange={(e) => setWfInterval(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground block mb-1.5">Batch Size (Articles)</label>
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={wfBatchSize}
                  onChange={(e) => setWfBatchSize(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
            </div>
            <CardItem
              title="Save Schedule"
              description="Apply interval and batch size changes"
              actions={
                <div className="flex items-center gap-2">
                  {wfSaveStatus === "saved" && (
                    <span className="text-xs text-emerald-500 font-medium">Saved!</span>
                  )}
                  {wfSaveStatus === "error" && (
                    <span className="text-xs text-destructive font-medium">{wfError}</span>
                  )}
                  <Button
                    onClick={handleSaveWorkflowSchedule}
                    disabled={savingWf}
                    size="sm"
                    className="gap-1.5 text-xs font-semibold"
                  >
                    {savingWf ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    Save Schedule
                  </Button>
                </div>
              }
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No workflows found. Create a workflow under Workflows first.</p>
        )}
      </JanCard>

      {/* ── Plugin-Owned Agent Tools ── */}
      <JanCard
        title="Plugin-Owned Agent Tools"
        header={
          <p className="text-sm text-muted-foreground -mt-2 mb-4">
            These specialized tools are registered and available to your AI Agents when the Posts plugin is active.
          </p>
        }
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {[
            {
              key: "save_youtube_video",
              label: "YouTube Video Saver",
              desc: "Saves video upload drafts with title, description, SEO tags, and custom thumbnail.",
            },
            {
              key: "save_instagram_post",
              label: "Instagram Post & Reel Saver",
              desc: "Saves Instagram Reels, Photos, Videos, and Carousels to Posts console.",
            },
            {
              key: "save_facebook_post",
              label: "Facebook Post Saver",
              desc: "Saves Facebook Page posts, photos, and video reels with captions.",
            },
            {
              key: "save_linkedin_post",
              label: "LinkedIn Post & Video Saver",
              desc: "Saves LinkedIn thought leadership posts, native videos, photos, and article shares to Posts console.",
            },
            {
              key: "save_twitter_post",
              label: "X (Twitter) Post Saver",
              desc: "Saves tweets and threads with attached photos and videos from Cloudflare R2 to Posts console.",
            },
            {
              key: "save_social_bundle",
              label: "Social Campaign Bundle Saver",
              desc: "Saves multi-platform cross-channel campaigns across social networks in one turn.",
            },
            {
              key: "save_wordpress_post",
              label: "WordPress Article Saver",
              desc: "Saves blog articles with category, slug, excerpt, focus keyword, and featured images.",
            },
            {
              key: "publish_to_wordpress",
              label: "Publish to WordPress",
              desc: "Publishes or drafts formatted HTML posts directly to your WordPress website.",
            },
            {
              key: "get_wordpress_categories",
              label: "WP Categories",
              desc: "Fetches live taxonomy and categories from WordPress REST API.",
            },
          ].map((t) => (
            <div key={t.key} className="p-3.5 rounded-xl border border-border/60 bg-muted/20 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-semibold text-xs text-foreground">{t.label}</span>
                  <span className="text-[10px] font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                    Tool
                  </span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{t.desc}</p>
              </div>
              <span className="font-mono text-[11px] text-muted-foreground/70 mt-3">{t.key}</span>
            </div>
          ))}
        </div>
        <div className="pt-3 border-t border-border/40 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Attach these tools in Agent Settings</span>
          <Link href="/agent-settings?tab=agents">
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5">
              <Bot className="h-3.5 w-3.5" />
              Configure Agent Tools
            </Button>
          </Link>
        </div>
      </JanCard>

      {/* ── WordPress Publisher Credentials ── */}
      <JanCard
        title="WordPress Publisher Credentials"
        header={
          <p className="text-sm text-muted-foreground -mt-2 mb-4">
            Configure your WordPress REST API credentials for automatic or 1-click blog publishing.
          </p>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
          <CardItem column title="WordPress Site URL">
            <Input
              placeholder="https://yoursite.com"
              value={settings.wp_site_url || ""}
              onChange={(e) => setSetting("wp_site_url", e.target.value)}
              className="h-9 text-sm"
            />
          </CardItem>
          <CardItem column title="WordPress Username">
            <Input
              placeholder="admin"
              value={settings.wp_username || ""}
              onChange={(e) => setSetting("wp_username", e.target.value)}
              className="h-9 text-sm"
            />
          </CardItem>
          <CardItem column title="WordPress Application Password" className="sm:col-span-2">
            <Input
              type="password"
              placeholder="xxxx xxxx xxxx xxxx"
              value={settings.wp_app_password || ""}
              onChange={(e) => setSetting("wp_app_password", e.target.value)}
              className="h-9 text-sm"
            />
          </CardItem>
        </div>
        <CardItem
          title="Auto-Publish to WordPress"
          description="Automatically publish without manual review when agent finishes"
          actions={
            <Switch
              checked={settings.wp_auto_publish === "true"}
              onCheckedChange={(checked) => setSetting("wp_auto_publish", checked ? "true" : "false")}
            />
          }
        />
        <div className="pt-3 border-t border-border/40 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {settingsSaveStatus === "saved" && (
              <span className="text-xs font-semibold text-emerald-500 flex items-center gap-1">
                <CheckCircle2 size={13} /> WordPress credentials saved!
              </span>
            )}
            {settingsSaveStatus === "error" && (
              <span className="text-xs font-semibold text-destructive">{settingsError}</span>
            )}
          </div>
          <Button
            onClick={handleSaveWpSettings}
            disabled={savingSettings}
            className="gap-1.5 text-xs font-semibold"
          >
            {savingSettings ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save WordPress Credentials
          </Button>
        </div>
      </JanCard>

      {/* ── Social Media Channels Gateway Card ── */}
      <JanCard
        title="Social Media Channels (Composio OAuth Gateway)"
        header={
          <p className="text-sm text-muted-foreground -mt-2 mb-4">
            Instagram, Facebook, YouTube, and X (Twitter) accounts are connected securely via 1-Click Composio OAuth gateways. No manual API tokens or secret keys required.
          </p>
        }
      >
        <div className="rounded-xl border border-primary/20 bg-gradient-to-r from-primary/5 via-transparent to-primary/5 p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <p className="font-semibold text-sm text-foreground">1-Click Connected Social Channels</p>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed max-w-lg">
              Manage live connections, test credentials, and toggle channel availability for YouTube, Instagram Reels, Facebook Pages, and X.
            </p>
          </div>
          <Link href="/posts/settings" className="shrink-0">
            <Button variant="default" size="sm" className="text-xs gap-1.5 font-semibold shadow-sm">
              Manage Social Channels <ExternalLink size={13} />
            </Button>
          </Link>
        </div>
      </JanCard>
    </div>
  );
}
