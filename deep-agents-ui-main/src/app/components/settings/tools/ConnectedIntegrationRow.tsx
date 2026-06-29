"use client";

import React, { useState, useCallback } from "react";
import {
  Loader2, ToggleLeft, ToggleRight,
  ChevronDown, ChevronRight, Settings2, Globe, Link2,
  CheckCircle2, AlertTriangle, Trash2
} from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ToolSetting {
  id: string;
  connection_id: string;
  tool_key: string;
  tool_name: string;
  enabled: boolean;
  loading_mode?: string;
}

export interface MCPConnection {
  id: string;
  label: string;
  toolkit_slug: string;
  connection_type: string;
  status: string;
  composio_conn_id?: string;
  mcp_url?: string;
  available_tools: { tool_key: string; tool_name: string }[];
}

// ── Tool Toggle ───────────────────────────────────────────────────────────────

export function ToolToggle({
  setting,
  onToggle,
  onModeChange,
  toggling,
  togglingMode,
}: {
  setting: ToolSetting;
  onToggle: (key: string, enabled: boolean) => void;
  onModeChange: (key: string, mode: string) => void;
  toggling: boolean;
  togglingMode: boolean;
}) {
  const currentMode = setting.loading_mode || "primary";

  return (
    <div
      className={`flex flex-col gap-2 px-3 py-2.5 rounded-lg border transition-all
        ${setting.enabled
          ? "bg-card border-border"
          : "bg-muted/30 border-border/50 opacity-60"
        }`}
    >
      <div className="flex items-center justify-between w-full">
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold truncate text-foreground">
            {setting.tool_name || setting.tool_key}
          </p>
          <p className="text-[10px] text-muted-foreground font-mono truncate">
            {setting.tool_key}
          </p>
        </div>
        <button
          onClick={() => onToggle(setting.tool_key, !setting.enabled)}
          disabled={toggling}
          className={`shrink-0 transition-colors ${setting.enabled ? "text-primary hover:text-primary/80" : "text-muted-foreground hover:text-foreground"}`}
          title={setting.enabled ? "Disable tool" : "Enable tool"}
        >
          {toggling
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : setting.enabled
              ? <ToggleRight className="h-5 w-5" />
              : <ToggleLeft className="h-5 w-5" />
          }
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-dashed border-border/50">
        <span className="text-[9px] text-muted-foreground font-medium uppercase shrink-0">
          Indexing Mode
        </span>
        <select
          value={currentMode}
          disabled={!setting.enabled || togglingMode}
          onChange={(e) => onModeChange(setting.tool_key, e.target.value)}
          style={{ width: "120px", minWidth: "120px", paddingLeft: "6px", paddingRight: "20px", paddingTop: "0px", paddingBottom: "0px" }}
          className="h-6 shrink-0 text-[10px] rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-primary font-medium cursor-pointer"
        >
          <option value="primary">Primary</option>
          <option value="normal">Normal</option>
          <option value="super">Super</option>
        </select>
      </div>
    </div>
  );
}

// ── Connected Integration Row ─────────────────────────────────────────────────

export function ConnectedIntegrationRow({
  conn,
  onRemove,
  onReloadAgent,
}: {
  conn: MCPConnection;
  onRemove: () => void;
  onReloadAgent?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [toolSettings, setToolSettings] = useState<ToolSetting[]>([]);
  const [loadingTools, setLoadingTools] = useState(false);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [togglingModeKey, setTogglingModeKey] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);

  const loadTools = useCallback(async () => {
    if (loadingTools) return;
    setLoadingTools(true);
    try {
      if (!seeded && conn.available_tools?.length > 0) {
        await fetch("/api/mcp/tool-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connection_id: conn.id }),
        });
        setSeeded(true);
      }
      const res = await fetch(`/api/mcp/tool-settings?connection_id=${conn.id}`);
      const data = await res.json();
      setToolSettings(data.settings ?? []);
    } finally {
      setLoadingTools(false);
    }
  }, [conn.id, conn.available_tools, seeded, loadingTools]);

  const handleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && toolSettings.length === 0) loadTools();
  };

  const handleToggle = async (toolKey: string, enabled: boolean) => {
    setTogglingKey(toolKey);
    try {
      await fetch("/api/mcp/tool-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection_id: conn.id, tool_key: toolKey, enabled }),
      });
      setToolSettings((prev) =>
        prev.map((s) => s.tool_key === toolKey ? { ...s, enabled } : s)
      );
      if (onReloadAgent) onReloadAgent();
    } finally {
      setTogglingKey(null);
    }
  };

  const handleModeChange = async (toolKey: string, loadingMode: string) => {
    setTogglingModeKey(toolKey);
    try {
      await fetch("/api/mcp/tool-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection_id: conn.id, tool_key: toolKey, loading_mode: loadingMode }),
      });
      setToolSettings((prev) =>
        prev.map((s) => s.tool_key === toolKey ? { ...s, loading_mode: loadingMode } : s)
      );
      if (onReloadAgent) onReloadAgent();
    } finally {
      setTogglingModeKey(null);
    }
  };

  const handleBulk = async (enabled: boolean) => {
    await fetch("/api/mcp/tool-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: conn.id, enabled }),
    });
    setToolSettings((prev) => prev.map((s) => ({ ...s, enabled })));
    if (onReloadAgent) onReloadAgent();
  };

  const handleBulkMode = async (loadingMode: string) => {
    await fetch("/api/mcp/tool-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: conn.id, loading_mode: loadingMode }),
    });
    setToolSettings((prev) => prev.map((s) => ({ ...s, loading_mode: loadingMode })));
    if (onReloadAgent) onReloadAgent();
  };

  const enabledCount = toolSettings.filter((s) => s.enabled).length;
  const totalCount = toolSettings.length || conn.available_tools?.length || 0;

  // Determine connection type label
  let typeLabel = "· Manual MCP";
  if (conn.connection_type === "composio") typeLabel = "· Composio";
  else if (conn.mcp_url) {
    try {
      const parsed = JSON.parse(conn.mcp_url);
      if (parsed.smithery_mode === "local") typeLabel = "· Smithery (Local)";
      else if (parsed.smithery_mode === "remote") typeLabel = "· Smithery (Remote)";
    } catch {}
  }

  return (
    <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
      <button
        onClick={handleExpand}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/20 transition-colors"
      >
        <div className="shrink-0 w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
          {conn.connection_type === "composio"
            ? <Globe className="h-4 w-4 text-primary" />
            : <Link2 className="h-4 w-4 text-primary" />
          }
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-semibold truncate">{conn.label}</p>
            <span className="text-[10px] text-muted-foreground shrink-0">{typeLabel}</span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {expanded && toolSettings.length > 0
              ? `${enabledCount} of ${totalCount} tools enabled`
              : `${totalCount} tools`
            }
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
            <CheckCircle2 className="h-3 w-3" /> active
          </span>
          {expanded
            ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
            : <ChevronRight className="h-4 w-4 text-muted-foreground" />
          }
        </div>
      </button>

      {expanded && (
        <div className="border-t bg-muted/10">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-dashed bg-background/50 flex-wrap gap-2">
            <div className="flex items-center gap-1.5">
              <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                Tool Settings
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <button onClick={() => handleBulk(true)} className="text-[10px] font-medium text-primary hover:underline font-semibold">Enable all</button>
              <span className="text-muted-foreground text-[10px]">·</span>
              <button onClick={() => handleBulk(false)} className="text-[10px] font-medium text-muted-foreground hover:text-foreground hover:underline">Disable all</button>
              <span className="text-muted-foreground text-[10px]">·</span>
              <button onClick={() => handleBulkMode("primary")} className="text-[10px] font-medium text-primary hover:underline">Set all Primary</button>
              <span className="text-muted-foreground text-[10px]">·</span>
              <button onClick={() => handleBulkMode("normal")} className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 hover:underline">Set all Normal</button>
              <span className="text-muted-foreground text-[10px]">·</span>
              <button onClick={() => handleBulkMode("super")} className="text-[10px] font-medium text-violet-600 dark:text-violet-400 hover:underline">Set all Super</button>
              <span className="text-muted-foreground text-[10px]">·</span>
              <button onClick={onRemove} className="text-[10px] font-medium text-destructive hover:underline">Remove</button>
            </div>
          </div>

          <div className="p-4">
            {loadingTools ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading tools…
              </div>
            ) : toolSettings.length === 0 && conn.available_tools?.length === 0 ? (
              <p className="text-xs text-muted-foreground italic text-center py-6">
                No tools found for this connection.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {(toolSettings.length > 0 ? toolSettings : conn.available_tools.map((t) => ({
                  id: t.tool_key,
                  connection_id: conn.id,
                  tool_key: t.tool_key,
                  tool_name: t.tool_name,
                  enabled: true,
                  loading_mode: "primary",
                }))).map((setting) => (
                  <ToolToggle
                    key={setting.tool_key}
                    setting={setting as ToolSetting}
                    onToggle={handleToggle}
                    onModeChange={handleModeChange}
                    toggling={togglingKey === setting.tool_key}
                    togglingMode={togglingModeKey === setting.tool_key}
                  />
                ))}
              </div>
            )}
            {conn.mcp_url && (
              <p className="mt-3 text-[10px] text-muted-foreground font-mono truncate border-t pt-2">
                {conn.mcp_url}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
