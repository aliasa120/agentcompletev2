import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SMITHERY_REGISTRY = "https://api.smithery.ai/servers";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export interface SmitheryServer {
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
  createdAt?: string;
}

// Simple in-memory page cache for non-search catalog pages (snappy browsing)
// Key format: `page_${page}_limit_${limit}_verified_${verifiedOnly}`
const pageCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes cache

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") ?? "").trim().toLowerCase();
  const verifiedOnly = searchParams.get("verified") === "true";
  const sort = searchParams.get("sort") ?? "use-count-desc";
  const page = parseInt(searchParams.get("page") ?? "1", 10);
  const limit = parseInt(searchParams.get("limit") ?? "24", 10);

  // 1. Build Smithery API request URL
  const smitheryUrl = new URL(SMITHERY_REGISTRY);
  smitheryUrl.searchParams.set("page", String(page));
  smitheryUrl.searchParams.set("pageSize", String(limit));
  
  if (query) {
    smitheryUrl.searchParams.set("q", query);
  }
  if (verifiedOnly) {
    smitheryUrl.searchParams.set("verified", "true");
  }

  const cacheKey = `${page}_${limit}_${query}_${verifiedOnly}`;
  const now = Date.now();

  let apiData: any = null;

  // Read cache (only for non-search queries to allow live updates on search)
  if (!query && pageCache.has(cacheKey)) {
    const cached = pageCache.get(cacheKey)!;
    if (now - cached.timestamp < CACHE_TTL) {
      apiData = cached.data;
    }
  }

  if (!apiData) {
    try {
      const res = await fetch(smitheryUrl.toString(), {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        throw new Error(`Smithery Registry API returned ${res.status}`);
      }

      apiData = await res.json();
      
      // Cache non-search queries
      if (!query) {
        pageCache.set(cacheKey, { data: apiData, timestamp: now });
      }
    } catch (err) {
      console.error("[Smithery API proxy error]:", err);
      return NextResponse.json({
        servers: [],
        total: 0,
        page,
        limit,
        totalPages: 0,
        error: `Failed to reach Smithery Registry: ${String(err)}`,
      });
    }
  }

  const rawServers: any[] = apiData.servers ?? apiData.data ?? [];
  const pagination = apiData.pagination ?? {};

  // totalCount represents the true count in Smithery's entire database matching the query!
  const total = pagination.totalCount ?? pagination.total ?? rawServers.length;
  const totalPages = pagination.totalPages ?? Math.ceil(total / limit);

  // Load active remote manual connections from Supabase
  let activeRemoteSlugs = new Set<string>();
  try {
    const { data: conns } = await supabase
      .from("mcp_connections")
      .select("toolkit_slug, status")
      .eq("connection_type", "manual")
      .eq("status", "active");
    for (const row of conns ?? []) {
      if (row.toolkit_slug) {
        activeRemoteSlugs.add(row.toolkit_slug);
      }
    }
  } catch (e) {
    // Non-fatal
  }

  // 3. Map servers into unified structure with proper categories
  let servers: SmitheryServer[] = rawServers.map((s: any) => {
    const isRemote = s.remote ?? s.isRemote ?? s.is_remote ?? false;
    const isVerified = s.verified ?? s.isVerified ?? s.is_verified ?? false;
    const bySmithery = s.bySmithery ?? s.by_smithery ?? false;

    // Categorization:
    // bySmithery === true -> Managed by Smithery
    // bySmithery === false && verified === true -> Verified
    // bySmithery === false && verified === false -> Community
    let securityType: "managed" | "verified" | "community" = "community";
    if (bySmithery) {
      securityType = "managed";
    } else if (isVerified) {
      securityType = "verified";
    }

    const qualName = s.qualifiedName ?? s.qualified_name ?? s.name ?? "";

    return {
      qualifiedName: qualName,
      displayName: s.displayName ?? s.display_name ?? s.name ?? s.qualifiedName ?? "",
      description: s.description ?? "",
      iconUrl: s.iconUrl ?? s.icon_url ?? s.icon ?? "",
      useCount: s.useCount ?? s.use_count ?? s.score ?? 0,
      securityType,
      isVerified,
      isRemote,
      homepage: s.homepage ?? s.url ?? "",
      isDeployable: false, // Local download disabled entirely
      isInstalledOnServer: false,
      isConnectedRemote: activeRemoteSlugs.has(qualName),
      createdAt: s.createdAt ?? s.created_at,
    };
  });

  // 4. Sort results in memory if Smithery doesn't sort it for us, or to preserve requested order
  servers.sort((a, b) => {
    if (sort === "name-asc") return a.displayName.localeCompare(b.displayName);
    if (sort === "name-desc") return b.displayName.localeCompare(a.displayName);
    // Default: use-count-desc (popularity)
    return b.useCount - a.useCount;
  });

  return NextResponse.json({
    servers,
    total,
    page,
    limit,
    totalPages,
  });
}
