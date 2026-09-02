"use client";

import React from "react";
import Link from "next/link";
import {
  FileText, Loader2, Puzzle, Rss, Zap, ExternalLink, Settings2,
} from "lucide-react";
import { JanCard, CardItem } from "@/components/settings/JanCard";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { usePlugins, PluginInfo } from "@/lib/plugins";
import { PostsPluginPanel } from "./plugins/PostsPluginPanel";
import { FeederPluginPanel } from "./plugins/FeederPluginPanel";

const PLUGIN_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  FileText,
  Rss,
  Puzzle,
};

const TOOL_LABELS: Record<string, string> = {
  save_posts_to_supabase: "Save to DB",
  get_wordpress_categories: "WP Categories",
  publish_to_wordpress: "WordPress Publish",
};

function PluginIcon({ icon, className }: { icon: string | null; className: string }) {
  const Icon = (icon && PLUGIN_ICONS[icon]) || Puzzle;
  return <Icon className={className} />;
}

// Wraps a page (or page section) that belongs to a plugin. When the plugin is
// disabled, the wrapped content is replaced by an "enable plugin" prompt.
export function PluginGate({
  pluginKey,
  children,
}: {
  pluginKey: string;
  children: React.ReactNode;
}) {
  const { plugins, loading, setEnabled } = usePlugins();
  const [toggling, setToggling] = React.useState(false);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Checking plugin state…</span>
      </div>
    );
  }

  const plugin = plugins.find((p) => p.plugin_key === pluginKey);
  // Unknown plugin — preserve current behavior and render the content.
  if (!plugin || plugin.enabled) {
    return <>{children}</>;
  }

  return (
    <div className="flex items-center justify-center py-20">
      <JanCard className="max-w-xl">
        <CardItem
          align="start"
          className="flex-col gap-3"
          title={
            <span className="flex items-center gap-2">
              <PluginIcon icon={plugin.icon} className="h-4 w-4 text-primary" />
              The {plugin.label} plugin is disabled
            </span>
          }
          description={
            `${plugin.label} tools and settings are hidden while the plugin is ` +
            `disabled. Enable it to use this page, or manage it under ` +
            `Settings → Plugins.`
          }
          actions={
            <Button
              size="sm"
              disabled={toggling}
              onClick={async () => {
                setToggling(true);
                try {
                  await setEnabled(pluginKey, true);
                } finally {
                  setToggling(false);
                }
              }}
              className="shrink-0 gap-1.5 text-xs font-semibold"
            >
              {toggling ? "Enabling..." : `Enable ${plugin.label} plugin`}
            </Button>
          }
        />
      </JanCard>
    </div>
  );
}

function PluginCard({
  plugin,
  onToggle,
  toggling,
}: {
  plugin: PluginInfo;
  onToggle: (key: string, enabled: boolean) => void;
  toggling: boolean;
}) {
  return (
    <JanCard>
      <CardItem
        align="start"
        className="flex-col sm:flex-row gap-3"
        title={
          <span className="flex items-center gap-2">
            <PluginIcon icon={plugin.icon} className="h-4 w-4 text-primary" />
            {plugin.label}
            {plugin.enabled ? (
              <span className="text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded-full font-semibold uppercase border border-emerald-500/20">
                Enabled
              </span>
            ) : (
              <span className="text-[10px] bg-muted text-muted-foreground px-2 py-0.5 rounded-full font-semibold uppercase border border-border/50">
                Disabled
              </span>
            )}
          </span>
        }
        description={plugin.description ?? ""}
        actions={
          <div className="flex items-center gap-2 shrink-0">
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

      {plugin.tool_keys.length > 0 && (
        <CardItem
          column
          title={
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
              <Zap className="h-3.5 w-3.5 text-primary" />
              Plugin Tools
            </span>
          }
          description={
            plugin.enabled
              ? "These tools are available in the Tools section and can be attached to agents."
              : "Enable the plugin to expose these tools in the Tools section."
          }
        >
          <div className="flex flex-wrap gap-1.5 mt-1">
            {plugin.tool_keys.map((toolKey) => (
              <span
                key={toolKey}
                className="text-[11px] font-mono px-2 py-1 rounded-md border border-border/60 bg-muted/30"
              >
                {TOOL_LABELS[toolKey] ?? toolKey}
                <span className="text-muted-foreground/70 ml-1.5">({toolKey})</span>
              </span>
            ))}
          </div>
        </CardItem>
      )}

      <CardItem
        column
        title={
          <span className="text-xs font-semibold uppercase text-muted-foreground">
            Pages & Settings
          </span>
        }
      >
        <div className="flex flex-wrap gap-2 mt-1">
          {plugin.page_route && (
            <Link href={plugin.page_route}>
              <Button variant="outline" size="sm" className="h-7 px-3 text-xs gap-1.5">
                <ExternalLink className="h-3 w-3" />
                Open {plugin.label} Page
              </Button>
            </Link>
          )}
          {plugin.settings_route && (
            <Link href={plugin.settings_route}>
              <Button variant="outline" size="sm" className="h-7 px-3 text-xs gap-1.5">
                <Settings2 className="h-3 w-3" />
                Open Settings
              </Button>
            </Link>
          )}
        </div>
      </CardItem>
    </JanCard>
  );
}

export function PluginsSection({ pluginKey }: { pluginKey?: string }) {
  const { plugins, loading, setEnabled } = usePlugins();
  const [toggling, setToggling] = React.useState(false);

  const handleToggle = async (key: string, enabled: boolean) => {
    setToggling(true);
    try {
      // The API route persists the change and triggers a backend agent reload.
      await setEnabled(key, enabled);
    } finally {
      setToggling(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading plugins…</span>
      </div>
    );
  }

  const shown = pluginKey
    ? plugins.filter((p) => p.plugin_key === pluginKey)
    : plugins;

  if (pluginKey && shown.length === 0) {
    return (
      <JanCard>
        <p className="text-sm text-muted-foreground">
          Unknown plugin: <span className="font-mono">{pluginKey}</span>
        </p>
      </JanCard>
    );
  }

  if (pluginKey === "posts" && shown[0]) {
    return <PostsPluginPanel plugin={shown[0]} onToggle={handleToggle} toggling={toggling} />;
  }

  if (pluginKey === "feeder" && shown[0]) {
    return <FeederPluginPanel plugin={shown[0]} onToggle={handleToggle} toggling={toggling} />;
  }

  return (
    <div className="space-y-4">
      <JanCard
        title="Plugins"
        header={
          <p className="text-sm text-muted-foreground -mt-2 mb-4">
            Plugins bundle optional features, settings, and agent tools. Enabling a
            plugin exposes its tools in the Tools section so they can be attached
            to agents; disabling it removes its tools and settings from the app.
          </p>
        }
      >
        <div className="space-y-4">
          {shown.map((plugin) => (
            <PluginCard
              key={plugin.plugin_key}
              plugin={plugin}
              onToggle={handleToggle}
              toggling={toggling}
            />
          ))}
        </div>
      </JanCard>
    </div>
  );
}
