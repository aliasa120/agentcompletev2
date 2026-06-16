"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Search, ExternalLink, CheckCircle2, XCircle, Loader2,
  Link2, Unlink, Plus, Trash2, Globe, Zap, AlertCircle,
  AlertTriangle, ChevronDown, ChevronRight, Package,
  ToggleLeft, ToggleRight, Settings2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Toolkit {
  slug: string;
  name: string;
  description: string;
  logo_url: string;
  category: string;
}

interface MCPConnection {
  id: string;
  label: string;
  toolkit_slug: string;
  connection_type: string;
  status: string;
  composio_conn_id?: string;
  mcp_url?: string;
  available_tools: { tool_key: string; tool_name: string }[];
}

interface ToolSetting {
  id: string;
  connection_id: string;
  tool_key: string;
  tool_name: string;
  enabled: boolean;
}

// ── Tool toggle component ─────────────────────────────────────────────────────

function ToolToggle({
  setting,
  onToggle,
  toggling,
}: {
  setting: ToolSetting;
  onToggle: (key: string, enabled: boolean) => void;
  toggling: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all
      ${setting.enabled
        ? "bg-card border-border"
        : "bg-muted/30 border-border/50 opacity-60"
      }`}>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-semibold truncate text-foreground">{setting.tool_name || setting.tool_key}</p>
        <p className="text-[10px] text-muted-foreground font-mono truncate">{setting.tool_key}</p>
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
  );
}

// ── Connected integration row ─────────────────────────────────────────────────

function ConnectedIntegrationRow({
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
  const [seeded, setSeeded] = useState(false);

  const loadTools = useCallback(async () => {
    if (loadingTools) return;
    setLoadingTools(true);
    try {
      // Seed tools into DB if not already done
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
      setToolSettings(prev =>
        prev.map(s => s.tool_key === toolKey ? { ...s, enabled } : s)
      );
      if (onReloadAgent) onReloadAgent();
    } finally {
      setTogglingKey(null);
    }
  };

  const handleBulk = async (enabled: boolean) => {
    await fetch("/api/mcp/tool-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: conn.id, enabled }),
    });
    setToolSettings(prev => prev.map(s => ({ ...s, enabled })));
    if (onReloadAgent) onReloadAgent();
  };

  const enabledCount = toolSettings.filter(s => s.enabled).length;
  const totalCount = toolSettings.length || conn.available_tools?.length || 0;

  return (
    <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
      {/* Header row */}
      <button
        onClick={handleExpand}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/20 transition-colors"
      >
        {/* Icon / logo */}
        <div className="shrink-0 w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
          {conn.connection_type === "composio"
            ? <Globe className="h-4 w-4 text-primary" />
            : <Link2 className="h-4 w-4 text-primary" />
          }
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-semibold truncate">{conn.label}</p>
            <span className="text-[10px] text-muted-foreground shrink-0">
              {conn.connection_type === "composio" ? "· Composio" : "· Manual MCP"}
            </span>
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

      {/* Expanded tools panel */}
      {expanded && (
        <div className="border-t bg-muted/10">
          {/* Toolbar */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-dashed bg-background/50">
            <div className="flex items-center gap-1.5">
              <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Tool Settings</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleBulk(true)}
                className="text-[10px] font-medium text-primary hover:underline"
              >
                Enable all
              </button>
              <span className="text-muted-foreground text-[10px]">·</span>
              <button
                onClick={() => handleBulk(false)}
                className="text-[10px] font-medium text-muted-foreground hover:text-foreground hover:underline"
              >
                Disable all
              </button>
              <span className="text-muted-foreground text-[10px]">·</span>
              <button
                onClick={onRemove}
                className="text-[10px] font-medium text-destructive hover:underline"
              >
                Remove
              </button>
            </div>
          </div>

          {/* Tools grid */}
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
                {(toolSettings.length > 0 ? toolSettings : conn.available_tools.map(t => ({
                  id: t.tool_key,
                  connection_id: conn.id,
                  tool_key: t.tool_key,
                  tool_name: t.tool_name,
                  enabled: true,
                }))).map(setting => (
                  <ToolToggle
                    key={setting.tool_key}
                    setting={setting as ToolSetting}
                    onToggle={handleToggle}
                    toggling={togglingKey === setting.tool_key}
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

// ── Composio Marketplace ──────────────────────────────────────────────────────

function ComposioMarketplace({
  connections,
  onRefresh,
  onReloadAgent,
}: {
  connections: MCPConnection[];
  onRefresh: () => void;
  onReloadAgent?: () => void;
}) {
  const [toolkits, setToolkits] = useState<Toolkit[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState("name-asc");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectErrors, setConnectErrors] = useState<Record<string, string>>({});
  const [noKey, setNoKey] = useState(false);
  const searchTimeout = useRef<NodeJS.Timeout | null>(null);

  const fetchToolkits = async (searchQuery = "", cat = "all", sortOrder = "name-asc", pageNum = 1, append = false) => {
    setLoading(append ? false : true);
    try {
      const res = await fetch(`/api/mcp/composio/toolkits?q=${encodeURIComponent(searchQuery)}&category=${encodeURIComponent(cat)}&sort=${sortOrder}&page=${pageNum}&limit=24`);
      const data = await res.json();
      if (data.error?.includes("COMPOSIO_API_KEY not set")) {
        setNoKey(true);
      } else {
        setNoKey(false);
        setToolkits(prev => append ? [...prev, ...(data.toolkits ?? [])] : (data.toolkits ?? []));
        setHasMore(data.page < data.totalPages);
        setTotalCount(data.total ?? 0);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchToolkits(query, category, sort, 1);
  }, []);

  const handleSearch = (q: string) => {
    setQuery(q);
    setPage(1);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => fetchToolkits(q, category, sort, 1), 400);
  };

  const handleCategoryChange = (cat: string) => {
    setCategory(cat);
    setPage(1);
    fetchToolkits(query, cat, sort, 1);
  };

  const handleSortChange = (s: string) => {
    setSort(s);
    setPage(1);
    fetchToolkits(query, category, s, 1);
  };

  const handleLoadMore = () => {
    const next = page + 1;
    setPage(next);
    fetchToolkits(query, category, sort, next, true);
  };

  const isConnected = (slug: string) =>
    connections.some(c => c.toolkit_slug === slug && c.status === "active");

  const getConnId = (slug: string) =>
    connections.find(c => c.toolkit_slug === slug)?.composio_conn_id;

  const handleConnect = async (toolkit: Toolkit) => {
    setConnecting(toolkit.slug);
    setConnectErrors(prev => ({ ...prev, [toolkit.slug]: "" }));
    try {
      const res = await fetch("/api/mcp/composio/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolkit_slug: toolkit.slug }),
      });
      const data = await res.json();
      if (data.connect_url) {
        const popup = window.open(data.connect_url, "composio-connect",
          "width=620,height=720,left=200,top=80");
        const poll = setInterval(async () => {
          if (popup?.closed) {
            clearInterval(poll);
            setConnecting(null);
            await onRefresh();
            if (onReloadAgent) onReloadAgent();
          }
        }, 600);
        setTimeout(() => { clearInterval(poll); setConnecting(null); }, 300_000);
      } else if (data.success) {
        setConnecting(null);
        await onRefresh();
        if (onReloadAgent) onReloadAgent();
      } else if (data.requires_custom_auth) {
        setConnectErrors(prev => ({
          ...prev,
          [toolkit.slug]: "Requires custom setup at composio.dev first",
        }));
        setConnecting(null);
      } else {
        setConnectErrors(prev => ({
          ...prev,
          [toolkit.slug]: data.error ?? "Failed to get connect URL",
        }));
        setConnecting(null);
      }
    } catch (e) {
      setConnectErrors(prev => ({
        ...prev,
        [toolkit.slug]: e instanceof Error ? e.message : "Connection failed",
      }));
      setConnecting(null);
    }
  };

  const handleDisconnect = async (slug: string) => {
    const connId = getConnId(slug);
    if (!connId) return;
    await fetch("/api/mcp/composio/connections", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: connId }),
    });
    await onRefresh();
    if (onReloadAgent) onReloadAgent();
  };

  if (noKey) {
    return (
      <div className="rounded-xl border border-dashed border-orange-300 bg-orange-50 dark:bg-orange-950/20 p-8 text-center">
        <AlertCircle className="h-8 w-8 text-orange-500 mx-auto mb-3" />
        <p className="font-semibold text-orange-700 dark:text-orange-400 mb-1">Composio API Key Required</p>
        <p className="text-sm text-orange-600 dark:text-orange-500 mb-4">
          Add <code className="bg-orange-100 dark:bg-orange-900/50 px-1 rounded font-mono text-xs">COMPOSIO_API_KEY</code> to your{" "}
          <code className="font-mono text-xs bg-orange-100 dark:bg-orange-900/50 px-1 rounded">.env</code> file
        </p>
        <a href="https://app.composio.dev" target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-orange-700 dark:text-orange-400 hover:underline">
          Get free API key at composio.dev <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Search 1000+ integrations (Gmail, Slack, GitHub, Notion…)"
            className="pl-9 h-10"
          />
        </div>

        <select
          value={category}
          onChange={e => handleCategoryChange(e.target.value)}
          className="h-10 px-3 rounded-md border border-input bg-background text-xs focus:outline-none focus:ring-2 focus:ring-primary min-w-[140px]"
        >
          <option value="all">All Categories</option>
          <option value="ai agents">AI & Chatbots</option>
          <option value="calendar">Calendar & Scheduling</option>
          <option value="crm">CRM & Sales</option>
          <option value="developer tools">Developer Tools</option>
          <option value="email">Email</option>
          <option value="file management & storage">File Storage</option>
          <option value="social media accounts">Social Media</option>
          <option value="team chat">Team Chat</option>
          <option value="signatures">Signatures</option>
          <option value="databases">Databases</option>
          <option value="productivity">Productivity</option>
        </select>

        <select
          value={sort}
          onChange={e => handleSortChange(e.target.value)}
          className="h-10 px-3 rounded-md border border-input bg-background text-xs focus:outline-none focus:ring-2 focus:ring-primary min-w-[120px]"
        >
          <option value="name-asc">Name (A-Z)</option>
          <option value="name-desc">Name (Z-A)</option>
          <option value="category-asc">Category</option>
        </select>
      </div>

      {loading && page === 1 ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading integrations…
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-h-[500px] overflow-y-auto pr-1">
          {toolkits.map(toolkit => {
            const connected = isConnected(toolkit.slug);
            const isConnecting = connecting === toolkit.slug;
            const errMsg = connectErrors[toolkit.slug];
            return (
              <div key={toolkit.slug}
                className={`rounded-lg border p-3 flex flex-col gap-2 transition-all
                  ${connected
                    ? "border-primary/30 bg-primary/5"
                    : "border-border bg-card hover:border-primary/30 hover:shadow-sm"
                  }`}
              >
                <div className="flex items-center gap-2">
                  {toolkit.logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={toolkit.logo_url} alt={toolkit.name}
                      className="w-7 h-7 rounded-md object-contain"
                      onError={e => { (e.target as HTMLImageElement).style.display = "none" }} />
                  ) : (
                    <div className="w-7 h-7 rounded-md bg-muted flex items-center justify-center">
                      <Globe className="h-4 w-4 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold truncate">{toolkit.name}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{toolkit.category}</p>
                  </div>
                  {connected && <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />}
                </div>
                <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
                  {toolkit.description || "Connect your " + toolkit.name + " account"}
                </p>
                {errMsg && (
                  <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 border border-destructive/20 p-1.5">
                    <AlertTriangle className="h-3 w-3 text-destructive shrink-0 mt-0.5" />
                    <p className="text-[10px] text-destructive leading-snug">{errMsg}</p>
                  </div>
                )}
                <Button
                  size="sm"
                  variant={connected ? "outline" : "default"}
                  onClick={() => connected ? handleDisconnect(toolkit.slug) : handleConnect(toolkit)}
                  disabled={isConnecting}
                  className={`h-7 text-xs mt-auto gap-1 ${connected
                    ? "border-emerald-400 text-emerald-700 dark:text-emerald-400 hover:bg-destructive/10 hover:text-destructive hover:border-destructive"
                    : ""
                  }`}
                >
                  {isConnecting
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : connected
                      ? <><Unlink className="h-3 w-3" />Disconnect</>
                      : <><Link2 className="h-3 w-3" />Connect</>
                  }
                </Button>
              </div>
            );
          })}
          {toolkits.length === 0 && !loading && (
            <div className="col-span-3 py-12 text-center text-muted-foreground text-sm">
              No integrations found for &ldquo;{query}&rdquo;
            </div>
          )}
          {hasMore && (
            <div className="col-span-full flex justify-center pt-4 pb-2 border-t mt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleLoadMore}
                disabled={loading}
                className="h-8 text-xs gap-1.5 font-semibold"
              >
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Load More Integrations ({toolkits.length} shown of {totalCount})
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Manual MCP Form ───────────────────────────────────────────────────────────

function ManualMCPForm({ onRefresh, onReloadAgent }: { onRefresh: () => void; onReloadAgent?: () => void }) {
  const [transport, setTransport] = useState<"sse" | "stdio">("sse");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  
  // Stdio configuration
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [tools, setTools] = useState("");

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<"idle" | "ok" | "error">("idle");
  const [testMsg, setTestMsg] = useState("");

  const handleTest = async () => {
    if (transport !== "sse") return;
    setTesting(true); setTestResult("idle"); setTestMsg("");
    try {
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
      setTestResult(res.ok ? "ok" : "error");
      setTestMsg(res.ok ? "Reachable" : `HTTP ${res.status}`);
    } catch (e) {
      setTestResult("error");
      setTestMsg(e instanceof Error ? e.message : "Unreachable");
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (transport === "sse" && (!label || !url)) return;
    if (transport === "stdio" && (!label || !command)) return;

    setSaving(true);
    try {
      let finalUrl = url;
      let availableTools: { tool_key: string; tool_name: string }[] = [];

      if (transport === "stdio") {
        // Parse arguments
        const parsedArgs = args
          .split(/\s+/)
          .map(a => a.trim())
          .filter(a => a.length > 0);

        // Parse env vars
        const envObj: Record<string, string> = {};
        env.split("\n").forEach(line => {
          const parts = line.split("=");
          if (parts.length >= 2) {
            const key = parts[0].trim();
            const val = parts.slice(1).join("=").trim();
            if (key) envObj[key] = val;
          }
        });

        // Serialize the stdio configuration inside the mcp_url column
        finalUrl = JSON.stringify({
          transport: "stdio",
          command: command.trim(),
          args: parsedArgs,
          env: envObj
        });

        // Parse user-defined tools
        availableTools = tools
          .split(",")
          .map(t => t.trim())
          .filter(t => t.length > 0)
          .map(t => ({
            tool_key: t,
            tool_name: t.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
          }));
      }

      const res = await fetch("/api/mcp/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          mcp_url: finalUrl,
          available_tools: transport === "stdio" ? availableTools : undefined
        }),
      });
      const data = await res.json();
      if (!data.error) {
        setLabel("");
        setUrl("");
        setCommand("");
        setArgs("");
        setEnv("");
        setTools("");
        setTestResult("idle");
        setTestMsg("");
        onRefresh();
        if (onReloadAgent) onReloadAgent();
      } else {
        setTestMsg(data.error);
        setTestResult("error");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-5 space-y-4 shadow-sm">
      <div className="flex items-center justify-between border-b pb-3.5">
        <div>
          <h3 className="text-sm font-semibold">Add Manual MCP Connection</h3>
          <p className="text-[11px] text-muted-foreground">Add custom servers via Server-Sent Events or local stdio processes</p>
        </div>
        <div className="flex gap-1 p-0.5 bg-muted rounded-md shrink-0">
          <button
            onClick={() => { setTransport("sse"); setTestResult("idle"); setTestMsg(""); }}
            className={`px-3 py-1 text-[10px] font-semibold rounded transition-all ${transport === "sse" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            SSE (HTTP)
          </button>
          <button
            onClick={() => { setTransport("stdio"); setTestResult("idle"); setTestMsg(""); }}
            className={`px-3 py-1 text-[10px] font-semibold rounded transition-all ${transport === "stdio" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            Stdio (Local)
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">Connection Label</label>
          <Input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder={transport === "sse" ? "e.g. Brave Image Search SSE" : "e.g. SQLite Database MCP Server"}
            className="h-9 text-sm"
          />
        </div>

        {transport === "sse" ? (
          <div className="md:col-span-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">SSE Endpoint URL</label>
            <Input
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="http://localhost:3001/sse"
              className="h-9 text-sm font-mono"
            />
          </div>
        ) : (
          <>
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">Command</label>
              <Input
                value={command}
                onChange={e => setCommand(e.target.value)}
                placeholder="e.g. npx, python, node"
                className="h-9 text-sm font-mono"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">Arguments</label>
              <Input
                value={args}
                onChange={e => setArgs(e.target.value)}
                placeholder="e.g. -y @modelcontextprotocol/server-sqlite"
                className="h-9 text-sm font-mono"
              />
            </div>
            <div className="md:col-span-2">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">Environment Variables (KEY=VALUE, one per line)</label>
              <textarea
                value={env}
                onChange={e => setEnv(e.target.value)}
                placeholder="SQLITE_DB_PATH=/users/database.db&#10;DEBUG=true"
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="md:col-span-2">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">Exposed Tools (Comma-separated name list)</label>
              <Input
                value={tools}
                onChange={e => setTools(e.target.value)}
                placeholder="e.g. query_db, get_schema, execute_sql"
                className="h-9 text-sm font-mono"
              />
              <p className="text-[10px] text-muted-foreground mt-1.5 leading-snug">
                Define the tool slugs that this local server exposes so you can assign and toggle them in the Tools list.
              </p>
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 pt-2 border-t mt-2">
        {transport === "sse" && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleTest}
            disabled={!url || testing}
            className="h-8 gap-1.5 text-xs font-semibold"
          >
            {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
            Test Connection
          </Button>
        )}
        {transport === "stdio" && (
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <AlertCircle className="h-3.5 w-3.5" /> Runs locally on the agent server.
          </span>
        )}

        {testResult === "ok" && (
          <span className="flex items-center gap-1 text-xs text-emerald-500 font-semibold animate-fade-in">
            <CheckCircle2 className="h-3.5 w-3.5" /> {testMsg}
          </span>
        )}
        {testResult === "error" && (
          <span className="flex items-center gap-1 text-xs text-rose-400 font-medium font-mono animate-fade-in max-w-[200px] truncate">
            <XCircle className="h-3.5 w-3.5 shrink-0" /> {testMsg || "Failed"}
          </span>
        )}

        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving || (transport === "sse" ? (!label || !url) : (!label || !command))}
          className="h-8 gap-1.5 text-xs font-semibold ml-auto"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          Add Connection
        </Button>
      </div>
    </div>
  );
}

// ── Tools Tab — all connected tools with enable/disable ───────────────────────

const BUILTIN_TOOLS = [
  { key: "unified_search", label: "Web Search", desc: "Tavily, Linkup, Parallel AI" },
  { key: "unified_extract", label: "URL Extractor", desc: "Exa AI, Tavily Extract" },
  { key: "think_tool", label: "Think Tool", desc: "Internal reasoning" },
  { key: "fetch_images_brave", label: "Brave Image Search", desc: "OG image fetcher" },
  { key: "view_candidate_images", label: "View Candidates", desc: "Download & cache images" },
  { key: "create_post_image", label: "Image Generator", desc: "KIE AI / Gemini" },
  { key: "read_skill", label: "Read Skill", desc: "Load SKILL.md instructions" },
  { key: "save_posts_to_supabase", label: "Save to DB", desc: "Supabase storage" },
  { key: "publish_to_wordpress", label: "WordPress Publish", desc: "WP REST API" },
];

function ToolsTab({
  connections,
  onRemoveComposio,
  onRemoveManual,
  onReloadAgent,
}: {
  connections: MCPConnection[];
  onRemoveComposio: (slug: string) => void;
  onRemoveManual: (id: string) => void;
  onReloadAgent?: () => void;
}) {
  const [builtinExpanded, setBuiltinExpanded] = useState(false);
  const activeConns = connections.filter(c => c.status === "active");

  return (
    <div className="space-y-3">
      {activeConns.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          No tools connected yet.<br />
          <span className="text-xs">Go to the <strong>Composio Gateway</strong> or <strong>Manual MCP</strong> tabs to connect integrations.</span>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Click any integration to expand and manage its individual tools. Toggles are saved to the database.
          </p>
          {activeConns.map(conn => (
            <ConnectedIntegrationRow
              key={conn.id}
              conn={conn}
              onRemove={() =>
                conn.connection_type === "composio"
                  ? onRemoveComposio(conn.toolkit_slug)
                  : onRemoveManual(conn.id)
              }
              onReloadAgent={onReloadAgent}
            />
          ))}
        </>
      )}

      {/* Built-in tools expandable row */}
      <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
        <button
          onClick={() => setBuiltinExpanded(v => !v)}
          className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/20 transition-colors"
        >
          <div className="shrink-0 w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Package className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">Built-in Tools</p>
            <p className="text-[11px] text-muted-foreground">Core agent tools · {BUILTIN_TOOLS.length} tools · always active</p>
          </div>
          {builtinExpanded
            ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
            : <ChevronRight className="h-4 w-4 text-muted-foreground" />
          }
        </button>
        {builtinExpanded && (
          <div className="border-t bg-muted/10 p-4">
            <div className="grid grid-cols-2 gap-2">
              {BUILTIN_TOOLS.map(tool => (
                <div key={tool.key}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-lg border bg-card">
                  <Zap className="h-3.5 w-3.5 text-primary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-semibold truncate">{tool.label}</p>
                    <p className="text-[10px] font-mono text-muted-foreground truncate">{tool.key}</p>
                    <p className="text-[10px] text-muted-foreground">{tool.desc}</p>
                  </div>
                  <ToggleRight className="h-5 w-5 text-primary shrink-0" />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Zapier Platform Section ──────────────────────────────────────────────────

function ZapierSection() {
  const [connections, setConnections] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const fetchConnections = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/oauth/connections");
      const data = await res.json();
      setConnections(data.connections ?? []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConnections();
  }, []);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleDisconnect = async (id: string) => {
    if (!confirm("Are you sure you want to disconnect this Zapier account?")) return;
    try {
      await fetch("/api/oauth/connections", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await fetchConnections();
    } catch (e) {
      console.error(e);
    }
  };

  const copyableFields = [
    { label: "Client ID", value: "easyclaw_client_id" },
    { label: "Client Secret", value: "easyclaw_client_secret_xyz123" },
    { label: "Authorization URL", value: `${window.location.origin}/api/oauth/authorize` },
    { label: "Access Token URL", value: `${window.location.origin}/api/oauth/token` },
    { label: "Test Request (User Profile) URL", value: `${window.location.origin}/api/oauth/me` },
  ];

  return (
    <div className="space-y-6">
      {/* Overview Card */}
      <div className="rounded-lg border bg-card p-5 space-y-4 shadow-sm">
        <div className="flex items-center gap-3 border-b pb-3.5">
          <div className="w-9 h-9 rounded-lg bg-orange-500/10 flex items-center justify-center text-orange-600">
            <Zap className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">Zapier Developer Platform Integration</h3>
            <p className="text-[11px] text-muted-foreground">Standard OAuth2 settings to configure your private Zapier app "easyclaw"</p>
          </div>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed">
          Use the credentials and URLs below to set up **OAuth v2 Authentication** in your Zapier Developer dashboard.
        </p>

        <div className="space-y-3">
          {copyableFields.map(field => (
            <div key={field.label} className="flex flex-col md:flex-row md:items-center justify-between gap-1 p-2 rounded-lg border bg-muted/30">
              <span className="text-xs font-semibold text-muted-foreground min-w-[200px]">{field.label}</span>
              <div className="flex items-center gap-2 flex-1 justify-end min-w-0">
                <span className="text-xs font-mono text-foreground truncate select-all">{field.value}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleCopy(field.value, field.label)}
                  className="h-6 px-2 text-[10px]"
                >
                  {copiedKey === field.label ? "Copied!" : "Copy"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Connected Accounts */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          Connected Zapier Accounts
          <span className="text-xs font-normal text-muted-foreground">({connections.length})</span>
        </h3>

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading connected accounts…
          </div>
        ) : connections.length === 0 ? (
          <div className="text-center py-8 text-xs text-muted-foreground border rounded-xl border-dashed">
            No Zapier accounts connected yet. Connect an account from your Zapier Developer console to test.
          </div>
        ) : (
          <div className="space-y-2">
            {connections.map(conn => (
              <div key={conn.id} className="flex items-center justify-between p-3 rounded-lg border bg-card shadow-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold truncate">{conn.email}</p>
                    <p className="text-[10px] text-muted-foreground font-mono">
                      Connected: {new Date(conn.created_at).toLocaleString()}
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDisconnect(conn.id)}
                  className="h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tools Section Main ────────────────────────────────────────────────────────

export function ToolsSection({ initialTab = "tools" }: { initialTab?: "composio" | "manual" | "tools" | "zapier" }) {
  const [connections, setConnections] = useState<MCPConnection[]>([]);
  const [loadingConn, setLoadingConn] = useState(true);
  const [activeTab, setActiveTab] = useState<"composio" | "manual" | "tools" | "zapier">(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const reloadAgent = async () => {
    try {
      await fetch("/api/reload-agent", { method: "POST" });
    } catch (e) {
      console.error("Failed to reload agent settings", e);
    }
  };

  const fetchConnections = async (forceSync = false) => {
    setLoadingConn(true);
    try {
      const [cRes, mRes] = await Promise.all([
        fetch(`/api/mcp/composio/connections${forceSync ? "?sync=true" : ""}`),
        fetch("/api/mcp/manual"),
      ]);
      const cData = await cRes.json();
      const mData = await mRes.json();
      setConnections([
        ...(cData.connections ?? []),
        ...(mData.connections ?? []),
      ]);
    } finally {
      setLoadingConn(false);
    }
  };

  useEffect(() => { fetchConnections(); }, []);

  const handleRemoveComposio = async (slug: string) => {
    const conn = connections.find(c => c.toolkit_slug === slug);
    if (!conn?.composio_conn_id) return;
    await fetch("/api/mcp/composio/connections", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: conn.composio_conn_id }),
    });
    await fetchConnections();
    await reloadAgent();
  };

  const handleRemoveManual = async (id: string) => {
    await fetch("/api/mcp/manual", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await fetchConnections();
    await reloadAgent();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between border-b pb-4">
        <div>
          <h2 className="font-semibold text-base mb-0.5">
            {activeTab === "zapier" ? "Zapier Platform Integration" : "Tools & MCP Connections"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {activeTab === "zapier"
              ? "Configure OAuth2 settings and view connected accounts for your private Zapier app 'easyclaw'."
              : "Connect external tools via Composio or manual MCP servers."}
          </p>
        </div>
        {activeTab !== "zapier" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => fetchConnections(true)}
            disabled={loadingConn}
            className="h-8 gap-1.5 text-xs font-semibold shrink-0"
          >
            {loadingConn ? <Loader2 className="h-3 w-3 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
            Sync Connections
          </Button>
        )}
      </div>

      {/* Loading indicator */}
      {loadingConn && activeTab !== "zapier" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Syncing connections list…
        </div>
      )}

      {/* Tab content */}
      {activeTab === "zapier" && (
        <ZapierSection />
      )}

      {activeTab === "composio" && (
        <ComposioMarketplace connections={connections} onRefresh={fetchConnections} onReloadAgent={reloadAgent} />
      )}

      {activeTab === "manual" && (
        <div className="space-y-4">
          <ManualMCPForm onRefresh={fetchConnections} onReloadAgent={reloadAgent} />
          {connections.filter(c => c.connection_type === "manual").map(conn => (
            <div key={conn.id} className="flex items-center gap-3 p-3 rounded-lg border bg-card">
              <Link2 className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{conn.label}</p>
                <p className="text-xs text-muted-foreground font-mono truncate">{conn.mcp_url}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {conn.available_tools?.length ?? 0} tools · Go to <strong>Tools</strong> tab to manage
                </p>
              </div>
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border
                ${conn.status === "active"
                  ? "bg-primary/10 text-primary border border-primary/20"
                  : "bg-muted text-muted-foreground border-border"
                }`}>
                {conn.status}
              </span>
              <Button size="sm" variant="ghost" onClick={() => handleRemoveManual(conn.id)}
                className="h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          {connections.filter(c => c.connection_type === "manual").length === 0 && !loadingConn && (
            <div className="text-center py-8 text-sm text-muted-foreground border rounded-xl border-dashed">
              No manual MCP servers added yet
            </div>
          )}
        </div>
      )}

      {activeTab === "tools" && (
        <ToolsTab
          connections={connections}
          onRemoveComposio={handleRemoveComposio}
          onRemoveManual={handleRemoveManual}
          onReloadAgent={reloadAgent}
        />
      )}
    </div>
  );
}
