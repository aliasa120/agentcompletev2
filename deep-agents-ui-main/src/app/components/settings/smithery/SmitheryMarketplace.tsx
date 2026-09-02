"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Search, Globe, CheckCircle2, Loader2, AlertTriangle,
  ExternalLink, Shield, ShieldAlert, Users, ChevronDown, RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JanCard } from "@/components/settings/JanCard";
import { SmitheryConnectDialog } from "./SmitheryConnectDialog";

interface SmitheryServer {
  qualifiedName: string;
  displayName: string;
  description: string;
  iconUrl: string;
  useCount: number;
  securityType: "managed" | "verified" | "community";
  isVerified: boolean;
  isRemote: boolean;
  homepage: string;
  isDeployable: boolean;
  isInstalledOnServer?: boolean;
  isConnectedRemote?: boolean;
}

interface SmitheryMarketplaceProps {
  onRefresh: () => void;
  onReloadAgent?: () => void;
}

function formatUseCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function SmitheryMarketplace({ onRefresh, onReloadAgent }: SmitheryMarketplaceProps) {
  const [servers, setServers] = useState<SmitheryServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("use-count-desc");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [apiError, setApiError] = useState("");

  const [connectTarget, setConnectTarget] = useState<SmitheryServer | null>(null);

  const searchTimeout = useRef<NodeJS.Timeout | null>(null);

  const fetchServers = useCallback(
    async (
      searchQuery = "",
      sortOrder = "use-count-desc",
      verified = false,
      pageNum = 1,
      append = false
    ) => {
      setLoading(append ? false : true);
      setApiError("");
      try {
        const params = new URLSearchParams({
          q: searchQuery,
          sort: sortOrder,
          page: String(pageNum),
          limit: "24",
        });
        if (verified) params.set("verified", "true");

        const res = await fetch(`/api/mcp/smithery/servers?${params.toString()}`);
        const data = await res.json();

        if (data.error && !data.servers?.length) {
          setApiError(data.error);
        }

        setServers((prev) => {
          const rawServers: SmitheryServer[] = append ? [...prev, ...(data.servers ?? [])] : (data.servers ?? []);
          // Deduplicate by qualifiedName — the Smithery API can return duplicates across pages
          const seen = new Set<string>();
          const deduped = rawServers.filter((s) => {
            if (seen.has(s.qualifiedName)) return false;
            seen.add(s.qualifiedName);
            return true;
          });
          return deduped;
        });
        setHasMore(data.page < data.totalPages);
        setTotalCount(data.total ?? 0);
      } catch (err: any) {
        setApiError(`Failed to load Smithery catalog: ${err.message}`);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchServers(query, sort, verifiedOnly, 1);
  }, []);

  const handleSearch = (q: string) => {
    setQuery(q);
    setPage(1);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(
      () => fetchServers(q, sort, verifiedOnly, 1),
      400
    );
  };

  const handleSortChange = (s: string) => {
    setSort(s);
    setPage(1);
    fetchServers(query, s, verifiedOnly, 1);
  };

  const handleVerifiedToggle = (v: boolean) => {
    setVerifiedOnly(v);
    setPage(1);
    fetchServers(query, sort, v, 1);
  };

  const handleLoadMore = () => {
    const next = page + 1;
    setPage(next);
    fetchServers(query, sort, verifiedOnly, next, true);
  };



  const handleConnectSuccess = (connectionId: string) => {
    setConnectTarget(null);
    onRefresh();
    if (onReloadAgent) onReloadAgent();
    fetchServers(query, sort, verifiedOnly, 1);
  };

  return (
    <>
      <div className="space-y-4">
        {/* Header info banner */}
        <div className="rounded-xl border border-violet-500/20 bg-gradient-to-br from-violet-500/5 to-indigo-500/5 p-4 flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0 mt-0.5">
            <Globe className="h-5 w-5 text-violet-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-violet-700 dark:text-violet-300">
              Smithery AI · {totalCount > 0 ? `${totalCount.toLocaleString()}+` : "10,000+"} MCP Servers
            </p>
            <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">
              Browse the free Smithery registry and connect to any server securely via your Smithery account
              with managed OAuth and configuration settings directly in our app.
            </p>
          </div>
          <button
            onClick={() => fetchServers(query, sort, verifiedOnly, 1)}
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-lg hover:bg-muted"
            title="Refresh catalog"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Search + Filters */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search 10,000+ MCP servers (GitHub, Slack, Notion…)"
              className="pl-9 h-10"
            />
          </div>

          <select
            value={sort}
            onChange={(e) => handleSortChange(e.target.value)}
            className="h-10 px-3 rounded-md border border-input bg-background text-xs focus:outline-none focus:ring-2 focus:ring-primary min-w-[140px] cursor-pointer"
          >
            <option value="use-count-desc">Most Popular</option>
            <option value="name-asc">Name (A-Z)</option>
            <option value="name-desc">Name (Z-A)</option>
          </select>

          <button
            onClick={() => handleVerifiedToggle(!verifiedOnly)}
            className={`flex items-center gap-1.5 h-10 px-3 rounded-md border text-xs font-semibold transition-all whitespace-nowrap ${
              verifiedOnly
                ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
                : "bg-background border-input text-muted-foreground hover:text-foreground"
            }`}
          >
            <Shield className="h-3.5 w-3.5" />
            Verified only
          </button>
        </div>

        {/* API Error */}
        {apiError && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                Smithery Registry Unavailable
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{apiError}</p>
            </div>
          </div>
        )}

        {/* Stats bar */}
        {!loading && servers.length > 0 && (
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>
              Showing {servers.length} of {totalCount.toLocaleString()} servers
              {verifiedOnly ? " (verified only)" : ""}
            </span>
            <span className="flex items-center gap-1">
              <ShieldAlert className="h-3 w-3 text-amber-500" />
              Unverified = community server · review before use
            </span>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && page === 1 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="rounded-lg border bg-card p-3 space-y-2 animate-pulse"
              >
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-md bg-muted" />
                  <div className="flex-1 space-y-1">
                    <div className="h-2.5 bg-muted rounded w-3/4" />
                    <div className="h-2 bg-muted rounded w-1/2" />
                  </div>
                </div>
                <div className="h-2 bg-muted rounded" />
                <div className="h-2 bg-muted rounded w-2/3" />
                <div className="h-6 bg-muted rounded" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-h-[560px] overflow-y-auto pr-1">
             {servers.map((server, idx) => (
              <SmitheryServerCard
                key={`${server.qualifiedName}-${idx}`}
                server={server}
                onConnect={() => setConnectTarget(server)}
              />
            ))}

            {servers.length === 0 && !loading && (
              <div className="col-span-3 py-14 text-center text-muted-foreground text-sm">
                No servers found for &ldquo;{query}&rdquo;
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
                  {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronDown className="h-3 w-3" />}
                  Load More ({servers.length.toLocaleString()} shown of {totalCount.toLocaleString()})
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Dialogs */}

      {connectTarget && (
        <SmitheryConnectDialog
          server={connectTarget}
          onClose={() => setConnectTarget(null)}
          onSuccess={handleConnectSuccess}
        />
      )}
    </>
  );
}

// ── Server Card ───────────────────────────────────────────────────────────────

function SmitheryServerCard({
  server,
  onConnect,
}: {
  server: SmitheryServer;
  onConnect: () => void;
}) {
  return (
    <JanCard
      className={`p-3 flex flex-col gap-2.5 transition-all hover:shadow-md ${
        server.isConnectedRemote
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-border bg-card hover:border-primary/30"
      }`}
    >
      {/* Top row: icon + name + badges */}
      <div className="flex items-start gap-2">
        {server.iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={server.iconUrl}
            alt={server.displayName}
            className="w-8 h-8 rounded-lg object-contain bg-muted shrink-0"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
            <Globe className="h-4 w-4 text-violet-500" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-xs font-semibold truncate max-w-[120px]">{server.displayName}</p>
            {/* Badge depending on Smithery classification */}
            {server.securityType === "managed" ? (
              <span className="flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-700 dark:text-violet-400 border border-violet-500/20 shrink-0">
                <Globe className="h-2.5 w-2.5" />
                Managed by Smithery
              </span>
            ) : server.securityType === "verified" ? (
              <span className="flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 shrink-0">
                <Shield className="h-2.5 w-2.5" />
                Verified
              </span>
            ) : (
              <span className="flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-500 border border-amber-500/20 shrink-0">
                <ShieldAlert className="h-2.5 w-2.5" />
                Community
              </span>
            )}
          </div>
          <p className="text-[9px] text-muted-foreground font-mono truncate mt-0.5">
            {server.qualifiedName}
          </p>
        </div>
        {server.homepage && (
          <a
            href={server.homepage}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {/* Description */}
      <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed flex-1">
        {server.description || `Connect your ${server.displayName} account`}
      </p>

      {/* Use count + installed badge */}
      <div className="flex items-center justify-between">
        {server.useCount > 0 && (
          <span className="flex items-center gap-1 text-[9px] text-muted-foreground">
            <Users className="h-2.5 w-2.5" />
            {formatUseCount(server.useCount)} uses
          </span>
        )}
        {server.isConnectedRemote && (
          <span className="flex items-center gap-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-2.5 w-2.5" />
            Connected
          </span>
        )}
      </div>

      {/* Action button */}
      <div className="mt-auto">
        <Button
          size="sm"
          variant={server.isConnectedRemote ? "outline" : "default"}
          onClick={onConnect}
          className={`w-full h-7 text-[10px] gap-1 ${
            server.isConnectedRemote
              ? "border-emerald-400/50 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
              : ""
          }`}
        >
          <Globe className="h-3 w-3" />
          {server.isConnectedRemote ? "Configure" : "Connect"}
        </Button>
      </div>
    </JanCard>
  );
}
