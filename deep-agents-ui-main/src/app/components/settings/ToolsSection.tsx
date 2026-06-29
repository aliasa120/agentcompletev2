"use client";

/**
 * ToolsSection — thin orchestrator.
 *
 * All heavy sub-components have been extracted to:
 *   composio/ComposioMarketplace.tsx
 *   manual/  (ManualMCPForm + manual connection list inline below)
 *   zapier/ZapierSection.tsx
 *   smithery/SmitheryMarketplace.tsx
 *   tools/ToolsTab.tsx
 *   tools/ConnectedIntegrationRow.tsx
 *   tools/BuiltinToolsPanel.tsx
 */

import React, { useState, useEffect } from "react";
import {
  Loader2, Globe, Trash2, Link2, Plus,
  CheckCircle2, Zap, Search, ExternalLink,
  AlertCircle, AlertTriangle, XCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ComposioMarketplace } from "./composio/ComposioMarketplace";
import { SmitheryMarketplace } from "./smithery/SmitheryMarketplace";
import { ToolsTab } from "./tools/ToolsTab";
import type { MCPConnection } from "./tools/ConnectedIntegrationRow";

// ── ManualMCPForm (kept inline — re-export-friendly) ─────────────────────────
// Intentionally kept here for now to avoid a circular dependency with
// settings/manual/ManualMCPForm.tsx. The logic is ~250 lines and not duplicated.

function ManualMCPForm({ onRefresh, onReloadAgent }: { onRefresh: () => void; onReloadAgent?: () => void }) {
  const [transport, setTransport] = useState<"stdio" | "sse" | "http">("stdio");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [mcpVersion, setMcpVersion] = useState("2025-03-26");
  const [tools, setTools] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<"idle" | "ok" | "error">("idle");
  const [testMsg, setTestMsg] = useState("");
  const [terminalLogs, setTerminalLogs] = useState<{ direction: string; message: string }[]>([]);
  const [lastTestedContent, setLastTestedContent] = useState("");

  const handleTest = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setTesting(true);
    setTestResult("idle");
    setTestMsg("Auto-fetching tools...");
    setTerminalLogs([]);

    let commandVal = "", argsVal: any = [], envVal: any = {}, mcpUrlVal = trimmed, headersVal: any = {};

    if (transport === "stdio") {
      if (trimmed.startsWith("{")) {
        try {
          let parsed = JSON.parse(trimmed);
          if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
            const firstKey = Object.keys(parsed.mcpServers)[0];
            if (firstKey) { const sc = parsed.mcpServers[firstKey]; commandVal = sc.command || ""; argsVal = sc.args || []; envVal = sc.env || {}; }
          } else {
            const topKeys = Object.keys(parsed);
            const firstVal = topKeys.length === 1 ? parsed[topKeys[0]] : null;
            if (firstVal && typeof firstVal === "object" && (firstVal.command || firstVal.url)) {
              commandVal = firstVal.command || ""; argsVal = firstVal.args || []; envVal = firstVal.env || {};
            } else { commandVal = parsed.command || ""; argsVal = parsed.args || []; envVal = parsed.env || {}; }
          }
        } catch (e) { setTesting(false); setTestResult("error"); setTestMsg("Invalid Stdio JSON configuration."); return; }
      } else { setTesting(false); setTestResult("error"); setTestMsg("Stdio config must be a valid JSON object."); return; }
    } else {
      if (trimmed.startsWith("{")) {
        try { const p = JSON.parse(trimmed); mcpUrlVal = p.url || p.mcp_url || ""; headersVal = p.headers || {}; } catch (e) { mcpUrlVal = trimmed; }
      }
    }

    try {
      const res = await fetch("/api/mcp/manual/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transport, mcp_url: mcpUrlVal, command: commandVal, args: argsVal, env: envVal, headers: headersVal })
      });
      const data = await res.json();
      if (data.success) {
        setTestResult("ok"); setTestMsg(`Reachable (${data.tools?.length || 0} tools found)`);
        setTerminalLogs(data.logs || []); setLastTestedContent(trimmed);
        if (data.tools?.length > 0) setTools(data.tools.map((t: any) => t.name).join(", "));
      } else {
        setTestResult("error"); setTestMsg(data.error || "Connection failed");
        setTerminalLogs(data.logs || [{ direction: "error", message: data.error || "Connection failed" }]);
        setLastTestedContent(trimmed);
      }
    } catch (e: any) {
      setTestResult("error"); setTestMsg(e.message || "Request failed");
      setTerminalLogs([{ direction: "error", message: e.message || "Network error" }]); setLastTestedContent(trimmed);
    } finally { setTesting(false); }
  };

  const handleSave = async () => {
    const trimmedUrl = url.trim();
    if (!label || !trimmedUrl) return;
    setSaving(true);
    try {
      let finalUrl = trimmedUrl;
      let availableTools: { tool_key: string; tool_name: string }[] = [];
      if (tools.trim().length > 0) {
        availableTools = tools.split(",").map(t => t.trim()).filter(t => t.length > 0)
          .map(t => ({ tool_key: t, tool_name: t.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) }));
      }
      if (trimmedUrl.startsWith("{")) {
        try { const p = JSON.parse(trimmedUrl); p.description = description; p.mcp_version = mcpVersion; p.transport = p.transport || transport; finalUrl = JSON.stringify(p); } catch (je) {}
      } else {
        finalUrl = JSON.stringify({ transport, url: trimmedUrl, description, mcp_version: mcpVersion });
      }
      const res = await fetch("/api/mcp/manual", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, mcp_url: finalUrl, available_tools: availableTools.length > 0 ? availableTools : undefined }),
      });
      const data = await res.json();
      if (!data.error) {
        setLabel(""); setDescription(""); setUrl(""); setTools(""); setTestResult("idle"); setTestMsg(""); setTerminalLogs([]); setLastTestedContent("");
        onRefresh(); if (onReloadAgent) onReloadAgent();
      } else { setTestMsg(data.error); setTestResult("error"); }
    } finally { setSaving(false); }
  };

  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed || trimmed === lastTestedContent || testing) return;
    let shouldTest = false;
    if (transport === "stdio") {
      if (trimmed.startsWith("{")) { try { const p = JSON.parse(trimmed); if (p.command || (p.mcpServers && Object.keys(p.mcpServers).length > 0)) shouldTest = true; } catch (e) {} }
    } else { if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("{")) shouldTest = true; }
    if (!shouldTest) return;
    const timer = setTimeout(() => handleTest(), 1200);
    return () => clearTimeout(timer);
  }, [url, transport, lastTestedContent, testing]);

  return (
    <div className="rounded-lg border bg-card p-6 space-y-5 shadow-sm">
      <div className="border-b pb-3">
        <h3 className="text-sm font-semibold">Add Manual MCP Connection</h3>
        <p className="text-[11px] text-muted-foreground">Add custom MCP servers via SSE, direct HTTP, or local stdio processes</p>
      </div>
      <div className="space-y-4">
        <div>
          <label className="text-xs font-semibold text-muted-foreground block mb-1.5">MCP Server Name</label>
          <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. circle_ci" className="h-9 text-sm" />
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground block mb-1.5">Description</label>
          <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Brief description of what this server does" className="h-9 text-sm" />
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground block mb-1.5"><span className="text-rose-500 mr-1">*</span>Transport Type</label>
          <select value={transport} onChange={e => { setTransport(e.target.value as any); setTestResult("idle"); setTestMsg(""); setTerminalLogs([]); setLastTestedContent(""); }}
            className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer">
            <option value="stdio">Standard Input/Output (stdio)</option>
            <option value="sse">Server-Sent Events (sse)</option>
            <option value="http">Direct HTTP (JSON-RPC)</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground block mb-1.5">
            <span className="text-rose-500 mr-1">*</span>
            {transport === "stdio" && "Stdio Configuration (JSON)"}
            {transport === "sse" && "SSE Connection (URL or JSON)"}
            {transport === "http" && "Direct HTTP Connection (URL or JSON)"}
          </label>
          <textarea value={url} onChange={e => setUrl(e.target.value)}
            placeholder={transport === "stdio" ? '{\n  "mcpServers": {\n    "my-server": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-sqlite"],\n      "env": {}\n    }\n  }\n}' : 'http://localhost:3001/sse'}
            rows={7} className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary" />
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground block mb-1.5"><span className="text-rose-500 mr-1">*</span>MCP Version</label>
          <select value={mcpVersion} onChange={e => setMcpVersion(e.target.value)}
            className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer">
            <option value="2025-03-26">2025-03-26 (Latest)</option>
            <option value="2024-11-05">2024-11-05</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground block mb-1.5">Exposed Tools</label>
          <Input value={tools} onChange={e => setTools(e.target.value)} placeholder="Auto-fetch will populate this once connection is verified" className="h-9 text-sm font-mono" />
        </div>
        {terminalLogs.length > 0 && (
          <div className="space-y-2 mt-2">
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block">JSON-RPC Diagnostic Exchange Log</label>
            <div className="w-full rounded-md bg-zinc-950 p-4 font-mono text-[11px] leading-relaxed overflow-y-auto max-h-60 border border-zinc-800 shadow-inner">
              {terminalLogs.map((log, idx) => {
                let color = "text-zinc-400", prefix = "";
                if (log.direction === "send") { color = "text-emerald-400 font-medium"; prefix = "--> "; }
                else if (log.direction === "receive") { color = "text-cyan-400 font-medium"; prefix = "<-- "; }
                else if (log.direction === "error") { color = "text-rose-400 font-semibold"; prefix = "[ERR] "; }
                else if (log.direction === "info") { color = "text-amber-400"; prefix = "[INFO] "; }
                return (<div key={idx} className={`${color} whitespace-pre-wrap break-all mb-1`}><span>{prefix}</span>{log.message}</div>);
              })}
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-3.5 border-t mt-2">
        <Button size="sm" variant="outline" onClick={handleTest} disabled={!url.trim() || testing} className="h-8 gap-1.5 text-xs font-semibold">
          {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
          Test Connection
        </Button>
        {testing && <span className="flex items-center gap-1.5 text-xs text-amber-500 font-medium animate-pulse"><Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" /> Auto-fetching tools...</span>}
        {testResult === "ok" && !testing && <span className="flex items-center gap-1.5 text-xs text-emerald-500 font-semibold"><CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> {testMsg}</span>}
        {testResult === "error" && !testing && <span className="flex items-center gap-1.5 text-xs text-rose-400 font-medium font-mono max-w-[300px] truncate"><XCircle className="h-3.5 w-3.5 shrink-0" /> {testMsg || "Failed"}</span>}
        <Button size="sm" onClick={handleSave} disabled={saving || !label || !url.trim()} className="h-8 gap-1.5 text-xs font-semibold ml-auto">
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          Add Connection
        </Button>
      </div>
    </div>
  );
}

// ── ZapierSection (inline) ───────────────────────────────────────────────────
function ZapierSection({ onRefresh, onReloadAgent }: { onRefresh?: () => void; onReloadAgent?: () => void }) {
  // Dynamic import to keep ZapierSection isolated — same code as original
  const [ZapComp, setZapComp] = useState<React.ComponentType<any> | null>(null);
  useEffect(() => {
    import("./zapier/ZapierSection").then((m) => setZapComp(() => m.ZapierSection));
  }, []);
  if (!ZapComp) return <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading Zapier integration…</div>;
  return <ZapComp onRefresh={onRefresh} onReloadAgent={onReloadAgent} />;
}

// ── Tools Section Main ────────────────────────────────────────────────────────

export function ToolsSection({ initialTab = "tools" }: { initialTab?: "composio" | "manual" | "tools" | "zapier" | "smithery" }) {
  const [connections, setConnections] = useState<MCPConnection[]>([]);
  const [loadingConn, setLoadingConn] = useState(true);
  const [activeTab, setActiveTab] = useState<"composio" | "manual" | "tools" | "zapier" | "smithery">(initialTab);

  useEffect(() => { setActiveTab(initialTab); }, [initialTab]);

  const reloadAgent = async () => {
    try { await fetch("/api/reload-agent", { method: "POST" }); } catch (e) { console.error("Failed to reload agent settings", e); }
  };

  const fetchConnections = async (forceSync = false) => {
    setLoadingConn(true);
    try {
      const [cRes, mRes] = await Promise.all([
        fetch(`/api/mcp/composio/connections${forceSync ? "?sync=true" : ""}`),
        fetch(`/api/mcp/manual${forceSync ? "?sync=true" : ""}`),
      ]);
      const cData = await cRes.json();
      const mData = await mRes.json();
      setConnections([...(cData.connections ?? []), ...(mData.connections ?? [])]);
    } finally { setLoadingConn(false); }
  };

  useEffect(() => { fetchConnections(); }, []);

  const handleRemoveComposio = async (slug: string) => {
    const conn = connections.find(c => c.toolkit_slug === slug);
    if (!conn?.composio_conn_id) return;
    await fetch("/api/mcp/composio/connections", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: conn.composio_conn_id }),
    });
    await fetchConnections();
    await reloadAgent();
  };

  const handleRemoveManual = async (id: string) => {
    await fetch("/api/mcp/manual", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
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
              : activeTab === "smithery"
              ? "Browse 3,000+ Smithery MCP servers. Install locally or connect via Smithery's managed cloud."
              : "Connect external tools via Composio, Smithery, or manual MCP servers."}
          </p>
        </div>
        {activeTab !== "zapier" && activeTab !== "smithery" && (
          <Button size="sm" variant="outline" onClick={() => fetchConnections(true)} disabled={loadingConn}
            className="h-8 gap-1.5 text-xs font-semibold shrink-0">
            {loadingConn ? <Loader2 className="h-3 w-3 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
            Sync Connections
          </Button>
        )}
      </div>

      {loadingConn && activeTab !== "zapier" && activeTab !== "smithery" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Syncing connections list…
        </div>
      )}

      {activeTab === "zapier" && <ZapierSection onRefresh={fetchConnections} onReloadAgent={reloadAgent} />}

      {activeTab === "composio" && (
        <ComposioMarketplace connections={connections} onRefresh={fetchConnections} onReloadAgent={reloadAgent} />
      )}

      {activeTab === "smithery" && (
        <SmitheryMarketplace onRefresh={fetchConnections} onReloadAgent={reloadAgent} />
      )}

      {activeTab === "manual" && (
        <div className="space-y-4">
          <ManualMCPForm onRefresh={fetchConnections} onReloadAgent={reloadAgent} />
          {connections.filter(c => c.connection_type === "manual").map(conn => (
            <div key={conn.id} className="flex items-center gap-3 p-3 rounded-lg border bg-card">
              <Link2 className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                {(() => {
                  let displayUrl = conn.mcp_url || "";
                  let descText = "";
                  let transportLabel = "";
                  if (conn.mcp_url && conn.mcp_url.trim().startsWith("{")) {
                    try {
                      const parsed = JSON.parse(conn.mcp_url);
                      transportLabel = parsed.transport ? `[${parsed.transport.toUpperCase()}] ` : "";
                      if (parsed.transport === "stdio") {
                        let cmd = parsed.command || "";
                        let argsList = parsed.args || [];
                        if (!cmd) {
                          const metadataKeys = new Set(["description", "mcp_version", "transport", "url", "headers"]);
                          for (const key of Object.keys(parsed)) {
                            if (!metadataKeys.has(key) && typeof parsed[key] === "object" && parsed[key]?.command) { cmd = parsed[key].command; argsList = parsed[key].args || []; break; }
                          }
                        }
                        displayUrl = `${cmd} ${argsList.join(" ")}`.trim();
                      } else {
                        let u = parsed.url || parsed.mcp_url || "";
                        if (!u) { const metadataKeys = new Set(["description", "mcp_version", "transport", "url", "headers"]); for (const key of Object.keys(parsed)) { if (!metadataKeys.has(key) && typeof parsed[key] === "object" && parsed[key]?.url) { u = parsed[key].url; break; } } }
                        displayUrl = u;
                      }
                      descText = parsed.description || "";
                    } catch (e) {}
                  }
                  return (
                    <>
                      <p className="text-sm font-medium truncate">{conn.label}</p>
                      {descText && <p className="text-xs text-muted-foreground mb-0.5">{descText}</p>}
                      <p className="text-xs text-muted-foreground font-mono truncate">{transportLabel}{displayUrl}</p>
                    </>
                  );
                })()}
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {conn.available_tools?.length ?? 0} tools · Go to <strong>Tools</strong> tab to manage
                </p>
              </div>
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${conn.status === "active" ? "bg-primary/10 text-primary border-primary/20" : "bg-muted text-muted-foreground border-border"}`}>
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
