"use client";

import useSWR from "swr";

export interface PluginInfo {
  plugin_key: string;
  label: string;
  description: string | null;
  icon: string | null;
  page_route: string | null;
  settings_route: string | null;
  sort_order: number;
  default_enabled: boolean;
  tool_keys: string[];
  // Resolved for the current user (user override, else catalog default).
  enabled: boolean;
}

// Fallback plugin -> tools mapping, mirroring research_agent/plugins.py and the
// seeded `plugins.tool_keys` column. Used if the API payload lacks tool_keys.
export const KNOWN_PLUGIN_TOOLS: Record<string, string[]> = {
  posts: [
    "save_posts_to_supabase",
    "get_wordpress_categories",
    "publish_to_wordpress",
  ],
  feeder: [],
};

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch ${url}`);
  return res.json();
};

export function usePlugins() {
  const { data, error, mutate } = useSWR<{ plugins: PluginInfo[] }>(
    "/api/plugins",
    fetcher
  );
  const loading = !data && !error;
  const plugins: PluginInfo[] = (data?.plugins ?? []).map((p) => ({
    ...p,
    tool_keys: p.tool_keys?.length
      ? p.tool_keys
      : KNOWN_PLUGIN_TOOLS[p.plugin_key] ?? [],
  }));

  const setEnabled = async (plugin_key: string, enabled: boolean) => {
    const res = await fetch("/api/plugins", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugin_key, enabled }),
    });
    if (res.ok) {
      await mutate();
    }
    return res.ok;
  };

  return { plugins, loading, setEnabled, refresh: mutate };
}

export function isPluginEnabled(plugins: PluginInfo[], pluginKey: string): boolean {
  const p = plugins.find((x) => x.plugin_key === pluginKey);
  // Unknown plugin (catalog still loading, or never registered): keep
  // legacy behavior and treat it as enabled so nothing breaks.
  if (!p) return true;
  return p.enabled;
}

// Returns the set of tool keys owned by currently-disabled plugins.
export function disabledPluginToolKeys(plugins: PluginInfo[] | undefined): Set<string> {
  const disabled = new Set<string>();
  if (!plugins) return disabled;
  for (const p of plugins) {
    if (!p.enabled) {
      const tools = p.tool_keys?.length
        ? p.tool_keys
        : KNOWN_PLUGIN_TOOLS[p.plugin_key] ?? [];
      for (const t of tools) disabled.add(t);
    }
  }
  return disabled;
}
