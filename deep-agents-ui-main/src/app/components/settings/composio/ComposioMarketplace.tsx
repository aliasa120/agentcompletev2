"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Search, ExternalLink, CheckCircle2, Loader2, Link2, Unlink,
  Globe, AlertCircle, AlertTriangle, Key, ShieldCheck
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MCPConnection } from "../tools/ConnectedIntegrationRow";

interface Toolkit {
  slug: string;
  name: string;
  description: string;
  logo_url: string;
  category: string;
}

export function ComposioMarketplace({
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
  const [customApiKey, setCustomApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [isKeyConfigured, setIsKeyConfigured] = useState(false);
  const [showKeyInput, setShowKeyInput] = useState(false);
  const searchTimeout = useRef<NodeJS.Timeout | null>(null);

  const fetchToolkits = async (searchQuery = "", cat = "all", sortOrder = "name-asc", pageNum = 1, append = false) => {
    setLoading(append ? false : true);
    try {
      const res = await fetch(`/api/mcp/composio/toolkits?q=${encodeURIComponent(searchQuery)}&category=${encodeURIComponent(cat)}&sort=${sortOrder}&page=${pageNum}&limit=24`);
      const data = await res.json();
      if (data.error?.includes("not set")) {
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

  const loadSettings = async () => {
    try {
      const res = await fetch("/api/user-settings");
      const data = await res.json();
      if (data.settings?.composio_api_key) {
        setCustomApiKey(data.settings.composio_api_key);
        setIsKeyConfigured(true);
        setNoKey(false);
        // Fetch list as soon as we have a key
        fetchToolkits(query, category, sort, 1);
      } else {
        setIsKeyConfigured(false);
        // Check if there is a global fallback key
        fetchToolkits(query, category, sort, 1);
      }
    } catch (e) {
      console.error("Failed to load user settings:", e);
      fetchToolkits(query, category, sort, 1);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const handleSaveApiKey = async () => {
    setSavingKey(true);
    try {
      const res = await fetch("/api/user-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composio_api_key: customApiKey }),
      });
      if (res.ok) {
        setIsKeyConfigured(!!customApiKey);
        setShowKeyInput(false);
        fetchToolkits(query, category, sort, 1);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSavingKey(false);
    }
  };

  const handleSearch = (q: string) => {
    setQuery(q);
    setPage(1);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => fetchToolkits(q, category, sort, 1), 400);
  };

  const handleCategoryChange = (cat: string) => { setCategory(cat); setPage(1); fetchToolkits(query, cat, sort, 1); };
  const handleSortChange = (s: string) => { setSort(s); setPage(1); fetchToolkits(query, category, s, 1); };
  const handleLoadMore = () => { const next = page + 1; setPage(next); fetchToolkits(query, category, sort, next, true); };

  const isConnected = (slug: string) => connections.some(c => c.toolkit_slug === slug && c.status === "active");
  const getConnId = (slug: string) => connections.find(c => c.toolkit_slug === slug)?.composio_conn_id;

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
        const popup = window.open(data.connect_url, "composio-connect", "width=620,height=720,left=200,top=80");
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
        setConnectErrors(prev => ({ ...prev, [toolkit.slug]: "Requires custom setup at composio.dev first" }));
        setConnecting(null);
      } else {
        setConnectErrors(prev => ({ ...prev, [toolkit.slug]: data.error ?? "Failed to get connect URL" }));
        setConnecting(null);
      }
    } catch (e) {
      setConnectErrors(prev => ({ ...prev, [toolkit.slug]: e instanceof Error ? e.message : "Connection failed" }));
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

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={query} onChange={e => handleSearch(e.target.value)}
            placeholder="Search 1000+ integrations (Gmail, Slack, GitHub, Notion…)" className="pl-9 h-10" />
        </div>
        <select value={category} onChange={e => handleCategoryChange(e.target.value)}
          className="h-10 px-3 rounded-md border border-input bg-background text-xs focus:outline-none focus:ring-2 focus:ring-primary min-w-[140px]">
          <option value="all">All Categories</option>
          <option value="ai agents">AI &amp; Chatbots</option>
          <option value="calendar">Calendar &amp; Scheduling</option>
          <option value="crm">CRM &amp; Sales</option>
          <option value="developer tools">Developer Tools</option>
          <option value="email">Email</option>
          <option value="file management & storage">File Storage</option>
          <option value="social media accounts">Social Media</option>
          <option value="team chat">Team Chat</option>
          <option value="signatures">Signatures</option>
          <option value="databases">Databases</option>
          <option value="productivity">Productivity</option>
        </select>
        <select value={sort} onChange={e => handleSortChange(e.target.value)}
          className="h-10 px-3 rounded-md border border-input bg-background text-xs focus:outline-none focus:ring-2 focus:ring-primary min-w-[120px]">
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
              <div key={toolkit.slug} className={`rounded-lg border p-3 flex flex-col gap-2 transition-all
                ${connected ? "border-primary/30 bg-primary/5" : "border-border bg-card hover:border-primary/30 hover:shadow-sm"}`}>
                <div className="flex items-center gap-2">
                  {toolkit.logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={toolkit.logo_url} alt={toolkit.name} className="w-7 h-7 rounded-md object-contain"
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
                <Button size="sm" variant={connected ? "outline" : "default"}
                  onClick={() => connected ? handleDisconnect(toolkit.slug) : handleConnect(toolkit)}
                  disabled={isConnecting}
                  className={`h-7 text-xs mt-auto gap-1 ${connected ? "border-emerald-400 text-emerald-700 dark:text-emerald-400 hover:bg-destructive/10 hover:text-destructive hover:border-destructive" : ""}`}>
                  {isConnecting ? <Loader2 className="h-3 w-3 animate-spin" />
                    : connected ? <><Unlink className="h-3 w-3" />Disconnect</>
                    : <><Link2 className="h-3 w-3" />Connect</>}
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
              <Button variant="outline" size="sm" onClick={handleLoadMore} disabled={loading}
                className="h-8 text-xs gap-1.5 font-semibold">
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
