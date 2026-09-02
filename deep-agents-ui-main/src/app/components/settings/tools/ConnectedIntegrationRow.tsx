"use client";

import React, { useState, useCallback, useEffect } from "react";
import {
  Loader2, ToggleLeft, ToggleRight,
  ChevronDown, ChevronRight, Settings2, Globe, Link2,
  CheckCircle2, AlertTriangle, Trash2, Shield, ShieldAlert,
  ShieldCheck, Sliders, Check, X, Sparkles
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { JanCard } from "@/components/settings/JanCard";
import { Input } from "@/components/ui/input";

export interface ToolSetting {
  id: string;
  connection_id: string;
  tool_key: string;
  tool_name: string;
  enabled: boolean;
  loading_mode?: string;
  permission_mode?: string;
  parameter_bindings?: Record<string, any>;
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

// ── Tool Toggle Component ───────────────────────────────────────────────────

export function ToolToggle({
  setting,
  onToggle,
  onModeChange,
  onPermissionChange,
  onBindingChange,
  toggling,
  togglingMode,
}: {
  setting: ToolSetting;
  onToggle: (key: string, enabled: boolean) => void;
  onModeChange: (key: string, mode: string) => void;
  onPermissionChange: (key: string, perm: string) => void;
  onBindingChange: (key: string, param: string, binding: { value: any; decide_by_ai: boolean } | null) => void;
  toggling: boolean;
  togglingMode: boolean;
}) {
  const currentMode = setting.loading_mode || "primary";
  const currentPerm = setting.permission_mode || "always_allow";
  const bindings = setting.parameter_bindings || {};
  const hasBindings = Object.keys(bindings).length > 0;
  const [showSchema, setShowSchema] = useState(false);
  const [schema, setSchema] = useState<any>(null);
  const [loadingSchema, setLoadingSchema] = useState(false);

  const fetchSchema = async () => {
    if (schema) return;
    setLoadingSchema(true);
    try {
      const res = await fetch(`/api/tools/schemas?tool_key=${setting.tool_key}`);
      const data = await res.json();
      if (data.schema) setSchema(data.schema);
    } catch (e) {
      console.warn("Failed to load MCP tool schema:", e);
    } finally {
      setLoadingSchema(false);
    }
  };

  return (
    <div
      className={`flex flex-col gap-2.5 px-3.5 py-3 rounded-lg border transition-all ${
        !setting.enabled
          ? "bg-muted/20 border-border/40 opacity-60"
          : currentPerm === "ask"
          ? "bg-card border-amber-500/40 shadow-xs"
          : currentPerm === "deny"
          ? "bg-card border-destructive/40 opacity-70"
          : "bg-card border-border shadow-xs"
      }`}
    >
      <div className="flex items-center justify-between w-full">
        <div className="flex-1 min-w-0 pr-2">
          <div className="flex items-center gap-1.5">
            <p className="text-xs font-semibold truncate text-foreground">
              {setting.tool_name || setting.tool_key}
            </p>
            {hasBindings && (
              <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 font-semibold uppercase shrink-0 border border-violet-500/20">
                Locked
              </span>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground font-mono truncate">
            {setting.tool_key}
          </p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = !showSchema;
              setShowSchema(next);
              if (next) fetchSchema();
            }}
            className={`h-6 px-1.5 text-[10px] gap-1 ${showSchema ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}
            title="Inspect & lock parameters"
          >
            <Sliders className="h-3 w-3" />
          </Button>

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
      </div>

      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-dashed border-border/50">
        {/* Permission Dropdown */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-muted-foreground font-semibold uppercase flex items-center gap-1">
            {currentPerm === "ask" ? (
              <ShieldAlert className="h-3 w-3 text-amber-500 shrink-0" />
            ) : currentPerm === "deny" ? (
              <X className="h-3 w-3 text-destructive shrink-0" />
            ) : (
              <ShieldCheck className="h-3 w-3 text-green-500 shrink-0" />
            )}
            Permission
          </span>
          <select
            value={currentPerm}
            disabled={!setting.enabled}
            onChange={(e) => onPermissionChange(setting.tool_key, e.target.value)}
            className={`h-7 w-full text-xs rounded-md border bg-background px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary font-medium cursor-pointer ${
              currentPerm === "ask"
                ? "border-amber-500 text-amber-600 dark:text-amber-400 font-bold bg-amber-500/5"
                : currentPerm === "deny"
                ? "border-destructive text-destructive font-bold bg-destructive/5"
                : "border-input text-foreground"
            }`}
          >
            <option value="always_allow">Always Allow</option>
            <option value="ask">Ask Before Running</option>
            <option value="deny">Deny / Block</option>
          </select>
        </div>

        {/* Indexing Mode Dropdown */}
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-muted-foreground font-semibold uppercase">
            Indexing Mode
          </span>
          <select
            value={currentMode}
            disabled={!setting.enabled || togglingMode}
            onChange={(e) => onModeChange(setting.tool_key, e.target.value)}
            className="h-7 w-full text-xs rounded-md border border-input bg-background px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary font-medium cursor-pointer"
          >
            <option value="primary">Primary</option>
            <option value="normal">Normal</option>
            <option value="super">Super</option>
          </select>
        </div>
      </div>

      {/* Schema Drawer */}
      {showSchema && (
        <div className="mt-2 pt-2 border-t bg-muted/30 p-2 rounded text-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-primary text-[11px]">Parameter Bindings</span>
            <span className="text-[9px] text-muted-foreground italic">Lock default values</span>
          </div>

          {loadingSchema ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs py-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading schema...
            </div>
          ) : !schema?.parameters?.properties || Object.keys(schema.parameters.properties).length === 0 ? (
            <p className="text-[10px] text-muted-foreground italic">No schema properties found for this MCP tool.</p>
          ) : (
            <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
              {Object.entries(schema.parameters.properties).map(([paramName, paramSchema]: [string, any]) => {
                const binding = bindings[paramName];
                const decideByAi = binding ? binding.decide_by_ai : true;
                const val = binding ? binding.value : (paramSchema.default !== undefined ? paramSchema.default : "");

                return (
                  <div key={paramName} className="p-2 rounded border border-border/50 bg-background/90 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] font-bold">{paramName}</span>
                      <select
                        value={decideByAi ? "ai" : "fixed"}
                        onChange={(e) => {
                          if (e.target.value === "ai") {
                            onBindingChange(setting.tool_key, paramName, null);
                          } else {
                            onBindingChange(setting.tool_key, paramName, { value: val, decide_by_ai: false });
                          }
                        }}
                        className="h-5 text-[9px] rounded border px-1"
                      >
                        <option value="ai">Decide by AI</option>
                        <option value="fixed">Fixed Value</option>
                      </select>
                    </div>

                    {!decideByAi && (
                      <Input
                        type="text"
                        value={val}
                        onChange={(e) => onBindingChange(setting.tool_key, paramName, { value: e.target.value, decide_by_ai: false })}
                        className="h-6 text-[10px]"
                        placeholder="Fixed value..."
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
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
  const [bulkWorking, setBulkWorking] = useState(false);

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

  const handlePermissionChange = async (toolKey: string, permissionMode: string) => {
    try {
      await fetch("/api/mcp/tool-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection_id: conn.id, tool_key: toolKey, permission_mode: permissionMode }),
      });
      setToolSettings((prev) =>
        prev.map((s) => s.tool_key === toolKey ? { ...s, permission_mode: permissionMode } : s)
      );
      if (onReloadAgent) onReloadAgent();
    } catch (e) {
      console.error("Failed to change permission:", e);
    }
  };

  const handleBindingChange = async (toolKey: string, paramName: string, binding: { value: any; decide_by_ai: boolean } | null) => {
    const targetTool = toolSettings.find((s) => s.tool_key === toolKey);
    const currentBindings = { ...(targetTool?.parameter_bindings || {}) };
    if (binding === null) {
      delete currentBindings[paramName];
    } else {
      currentBindings[paramName] = binding;
    }

    try {
      await fetch("/api/mcp/tool-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connection_id: conn.id,
          tool_key: toolKey,
          parameter_bindings: currentBindings,
        }),
      });
      setToolSettings((prev) =>
        prev.map((s) => s.tool_key === toolKey ? { ...s, parameter_bindings: currentBindings } : s)
      );
      if (onReloadAgent) onReloadAgent();
    } catch (e) {
      console.error("Failed to update binding:", e);
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

  // 1-Click Bulk Permission Updates
  const handleBulkPermission = async (permission_mode: string) => {
    setBulkWorking(true);
    try {
      await fetch("/api/tools/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connection_id: conn.id,
          permission_mode,
          tool_keys: toolSettings.map((s) => s.tool_key),
        }),
      });
      setToolSettings((prev) => prev.map((s) => ({ ...s, permission_mode })));
      if (onReloadAgent) onReloadAgent();
    } finally {
      setBulkWorking(false);
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
  const alwaysAllowedCount = toolSettings.filter((s) => s.enabled && (s.permission_mode === "always_allow" || !s.permission_mode)).length;
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
    <JanCard className="p-0 overflow-hidden border border-border">
      <button
        onClick={handleExpand}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/20 transition-colors cursor-pointer"
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
              ? `${enabledCount} of ${totalCount} tools enabled (${alwaysAllowedCount} auto-allowed)`
              : `${totalCount} tools available`
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
          {/* 1-Click Bulk Permissions & Controls Bar */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b bg-background/70 flex-wrap gap-2">
            <div className="flex items-center gap-1.5">
              <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                Bulk Actions & Permissions
              </span>
            </div>

            <div className="flex items-center gap-2 flex-wrap text-xs">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleBulkPermission("always_allow")}
                disabled={bulkWorking}
                className="h-6 px-2 text-[10px] font-bold bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 border-green-500/30 gap-1"
                title="Allow all tools of this MCP without prompting"
              >
                <Check className="h-3 w-3" /> Always Allow All
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => handleBulkPermission("ask")}
                disabled={bulkWorking}
                className="h-6 px-2 text-[10px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 border-amber-500/30 gap-1"
                title="Require confirmation before running any tool from this MCP"
              >
                <ShieldAlert className="h-3 w-3" /> Ask for All
              </Button>

              <span className="text-muted-foreground text-[10px]">|</span>

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
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {(toolSettings.length > 0 ? toolSettings : conn.available_tools.map((t) => ({
                  id: t.tool_key,
                  connection_id: conn.id,
                  tool_key: t.tool_key,
                  tool_name: t.tool_name,
                  enabled: true,
                  loading_mode: "primary",
                  permission_mode: "always_allow",
                  parameter_bindings: {},
                }))).map((setting) => (
                  <ToolToggle
                    key={setting.tool_key}
                    setting={setting as ToolSetting}
                    onToggle={handleToggle}
                    onModeChange={handleModeChange}
                    onPermissionChange={handlePermissionChange}
                    onBindingChange={handleBindingChange}
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
    </JanCard>
  );
}
