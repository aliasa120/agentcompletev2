"use client";

/**
 * ZapierSection — extracted from ToolsSection.tsx.
 * Dynamically imported in ToolsSection to keep the main bundle lean.
 */

import React, { useState, useEffect, useRef } from "react";
import { CheckCircle2, Loader2, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";

export function ZapierSection({
  onRefresh,
  onReloadAgent,
}: {
  onRefresh?: () => void;
  onReloadAgent?: () => void;
}) {
  const [connections, setConnections] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [userEmail, setUserEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [loadingUser, setLoadingUser] = useState(true);
  const [activeSubTab, setActiveSubTab] = useState<"embed" | "developer">("embed");

  const zapierRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        setUserEmail(data.user.email ?? "");
        const metadata = data.user.user_metadata || {};
        const fullName = metadata.full_name || metadata.name || "";
        const fName = metadata.first_name || fullName.split(" ")[0] || (data.user.email ?? "").split("@")[0] || "User";
        const lName = metadata.last_name || fullName.split(" ").slice(1).join(" ") || "Easyclaw";
        setFirstName(fName);
        setLastName(lName);
      }
      setLoadingUser(false);
    });
  }, []);

  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://mcp.zapier.com/embed/v1/mcp.js";
    script.async = true;
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, []);

  useEffect(() => {
    const el = zapierRef.current;
    if (!el) return;

    const handleServerUrl = async (event: any) => {
      const serverUrl = event.detail?.serverUrl;
      if (!serverUrl) return;
      try {
        const response = await fetch("/api/mcp/manual", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: `Zapier MCP - ${userEmail || "User"}`, mcp_url: serverUrl }),
        });
        if (response.ok) {
          if (onRefresh) onRefresh();
          if (onReloadAgent) onReloadAgent();
        } else {
          const err = await response.json();
          console.error("[Zapier MCP] Failed to register connection:", err.error);
        }
      } catch (e) {
        console.error("[Zapier MCP] Error saving manual connection:", e);
      }
    };

    const handleToolsChanged = () => { if (onReloadAgent) onReloadAgent(); };
    const handleCloseRequested = () => {};

    el.addEventListener("mcp-server-url", handleServerUrl);
    el.addEventListener("tools-changed", handleToolsChanged);
    el.addEventListener("close-requested", handleCloseRequested);

    return () => {
      el.removeEventListener("mcp-server-url", handleServerUrl);
      el.removeEventListener("tools-changed", handleToolsChanged);
      el.removeEventListener("close-requested", handleCloseRequested);
    };
  }, [userEmail, onRefresh, onReloadAgent]);

  const fetchConnections = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/oauth/connections");
      const data = await res.json();
      setConnections(data.connections ?? []);
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  useEffect(() => { fetchConnections(); }, []);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleDisconnect = async (id: string) => {
    if (!confirm("Are you sure you want to disconnect this Zapier account?")) return;
    try {
      await fetch("/api/oauth/connections", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await fetchConnections();
    } catch (e) { console.error(e); }
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
      <div className="flex border-b border-border gap-6">
        <button onClick={() => setActiveSubTab("embed")}
          className={`pb-2.5 text-sm font-medium transition-all relative ${activeSubTab === "embed" ? "text-primary border-b-2 border-primary -mb-[2px]" : "text-muted-foreground hover:text-foreground border-b-2 border-transparent"}`}>
          Connect Apps (Embed)
        </button>
        <button onClick={() => setActiveSubTab("developer")}
          className={`pb-2.5 text-sm font-medium transition-all relative ${activeSubTab === "developer" ? "text-primary border-b-2 border-primary -mb-[2px]" : "text-muted-foreground hover:text-foreground border-b-2 border-transparent"}`}>
          Developer Credentials
        </button>
      </div>

      {activeSubTab === "embed" ? (
        <div className="rounded-lg border bg-card p-5 space-y-4 shadow-sm">
          <div className="flex items-center gap-3 border-b pb-3.5">
            <div className="w-9 h-9 rounded-lg bg-orange-500/10 flex items-center justify-center text-orange-600">
              <Zap className="h-5 w-5 animate-pulse" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">Integrate Zapier Connections</h3>
              <p className="text-[11px] text-muted-foreground">Connect your AI agent to Gmail, Slack, Salesforce, Google Sheets, and 9,000+ other apps.</p>
            </div>
          </div>

          {loadingUser ? (
            <div className="flex flex-col items-center justify-center py-20 text-xs text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              Initializing Zapier Embed...
            </div>
          ) : (
            <div className="rounded-xl overflow-hidden border bg-background relative w-full h-[600px]">
              {React.createElement("zapier-mcp", {
                ref: zapierRef,
                "embed-id": "35b5974d-78e9-4938-9e29-156dd8a9be41",
                width: "100%",
                height: "100%",
                style: { display: "block", width: "100%", height: "100%" },
                "sign-up-email": userEmail,
                "sign-up-first-name": firstName,
                "sign-up-last-name": lastName,
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-5 space-y-4 shadow-sm">
            <div className="flex items-center gap-3 border-b pb-3.5">
              <div className="w-9 h-9 rounded-lg bg-orange-500/10 flex items-center justify-center text-orange-600">
                <Zap className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold">Zapier Developer Platform Integration</h3>
                <p className="text-[11px] text-muted-foreground">Standard OAuth2 settings to configure your private Zapier app &quot;easyclaw&quot;</p>
              </div>
            </div>

            <p className="text-xs text-muted-foreground leading-relaxed">
              Use the credentials and URLs below to set up OAuth v2 Authentication in your Zapier Developer dashboard.
            </p>

            <div className="space-y-3">
              {copyableFields.map(field => (
                <div key={field.label} className="flex flex-col md:flex-row md:items-center justify-between gap-1 p-2 rounded-lg border bg-muted/30">
                  <span className="text-xs font-semibold text-muted-foreground min-w-[200px]">{field.label}</span>
                  <div className="flex items-center gap-2 flex-1 justify-end min-w-0">
                    <span className="text-xs font-mono text-foreground truncate select-all">{field.value}</span>
                    <Button size="sm" variant="outline" onClick={() => handleCopy(field.value, field.label)} className="h-6 px-2 text-[10px]">
                      {copiedKey === field.label ? "Copied!" : "Copy"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

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
                No Zapier accounts connected yet.
              </div>
            ) : (
              <div className="space-y-2">
                {connections.map(conn => (
                  <div key={conn.id} className="flex items-center justify-between p-3 rounded-lg border bg-card shadow-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold truncate">{conn.email}</p>
                        <p className="text-[10px] text-muted-foreground font-mono">Connected: {new Date(conn.created_at).toLocaleString()}</p>
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => handleDisconnect(conn.id)}
                      className="h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
