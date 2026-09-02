import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import fs from "fs";
import path from "path";

const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY ?? "";
const COMPOSIO_BASE = "https://backend.composio.dev/api/v3";
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours in ms

function getSupabaseClient(cookieStore: any) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {}
        },
      },
    }
  );
}

export interface ToolkitItem {
  slug: string;
  name: string;
  description: string;
  logo_url: string;
  category: string;
  categories: string[];
}

async function fetchAllToolkitsFromAPI(apiKey: string): Promise<ToolkitItem[]> {
  const allToolkits: ToolkitItem[] = [];
  let cursor: string | null = null;
  let attempts = 0;
  const maxAttempts = 20;

  while (attempts < maxAttempts) {
    attempts++;
    let url = `${COMPOSIO_BASE}/toolkits?limit=250`;
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }

    const res = await fetch(url, {
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      if (allToolkits.length > 0) break; // Return what we have
      throw new Error(`Composio API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    const items = data.items ?? data.toolkits ?? [];
    if (!Array.isArray(items) || items.length === 0) break;

    for (const t of items) {
      const meta = t.meta ?? {};
      const rawCategories: string[] = Array.isArray(meta.categories)
        ? meta.categories
            .map((c: any) => (typeof c === "string" ? c : c?.name || c?.id || ""))
            .filter(Boolean)
        : [];
      const primaryCategory = (t.category as string) || rawCategories[0] || "General";

      allToolkits.push({
        slug: t.slug ?? t.key,
        name: t.name ?? t.display_name ?? t.slug,
        description: t.description ?? meta.description ?? "",
        logo_url: t.logo ?? t.logo_url ?? meta.logo ?? t.icon ?? `https://logos.composio.dev/api/${t.slug ?? t.key}`,
        category: primaryCategory,
        categories: rawCategories.length > 0 ? rawCategories : [primaryCategory],
      });
    }

    cursor = data.next_cursor ?? null;
    if (!cursor) break;
  }

  // Deduplicate by slug
  const seen = new Set<string>();
  const uniqueToolkits: ToolkitItem[] = [];
  for (const tk of allToolkits) {
    if (!seen.has(tk.slug)) {
      seen.add(tk.slug);
      uniqueToolkits.push(tk);
    }
  }

  return uniqueToolkits;
}

export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch user's custom Composio key from agent_settings or user_settings or environment
    let apiKey = "";
    const { data: agentSetting } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("user_id", user.id)
      .eq("key", "composio_api_key")
      .maybeSingle();

    if (agentSetting?.value?.trim()) {
      apiKey = agentSetting.value.trim();
    } else {
      const { data: userSetting } = await supabase
        .from("user_settings")
        .select("composio_api_key")
        .eq("id", user.id)
        .maybeSingle();
      if (userSetting?.composio_api_key?.trim()) {
        apiKey = userSetting.composio_api_key.trim();
      } else {
        apiKey = COMPOSIO_API_KEY;
      }
    }

    if (!apiKey) {
      return NextResponse.json(
        { error: "Composio API key not set in environment or settings", toolkits: [] },
        { status: 200 }
      );
    }

    const { searchParams } = new URL(req.url);
    const query = (searchParams.get("q") ?? "").trim().toLowerCase();
    const category = (searchParams.get("category") ?? "").trim().toLowerCase();
    const sort = searchParams.get("sort") ?? "name-asc";
    const page = parseInt(searchParams.get("page") ?? "1", 10);
    const limit = parseInt(searchParams.get("limit") ?? "24", 10);
    const forceRefresh = searchParams.get("refresh") === "true";

    let toolkits: ToolkitItem[] = [];
    let useCache = false;

    // Use user-specific cache file if we are using their custom key
    const userCacheSuffix = agentSetting?.value ? `_${user.id}` : "";
    const cacheFilePath = path.join(process.cwd(), `composio_toolkits_cache${userCacheSuffix}.json`);

    // 1. Try reading from local cache file
    if (!forceRefresh) {
      try {
        if (fs.existsSync(cacheFilePath)) {
          const stats = fs.statSync(cacheFilePath);
          const isFresh = Date.now() - stats.mtimeMs < CACHE_TTL;
          const cachedData = fs.readFileSync(cacheFilePath, "utf-8");
          const parsed = JSON.parse(cachedData);
          // If the cache contains at least 1000 items and is fresh, use it
          if (Array.isArray(parsed) && parsed.length >= 1000 && isFresh) {
            toolkits = parsed;
            useCache = true;
          }
        }
      } catch (err) {
        console.error("[Toolkits Cache Read Error]", err);
      }
    }

    // 2. Fetch all toolkits from API if cache is missing, stale, or incomplete (<1000 items)
    if (!useCache) {
      try {
        toolkits = await fetchAllToolkitsFromAPI(apiKey);
        // Write to cache
        try {
          fs.writeFileSync(cacheFilePath, JSON.stringify(toolkits), "utf-8");
        } catch (writeErr) {
          console.error("[Toolkits Cache Write Error]", writeErr);
        }
      } catch (apiErr) {
        console.error("[Toolkits API Fetch Error]", apiErr);
        // Fallback to stale cache if it exists
        if (fs.existsSync(cacheFilePath)) {
          try {
            const cachedData = fs.readFileSync(cacheFilePath, "utf-8");
            toolkits = JSON.parse(cachedData);
            console.log("[Toolkits Fallback] Using stale cache due to API failure.");
          } catch (readErr) {
            return NextResponse.json({ error: "Failed to fetch toolkits from API and no valid cache found.", toolkits: [] });
          }
        } else {
          return NextResponse.json({ error: String(apiErr), toolkits: [] });
        }
      }
    }

    // 3. Filter in-memory
    let filtered = [...toolkits];
    if (query) {
      filtered = filtered.filter((t) => {
        const nameMatch = (t.name || "").toLowerCase().includes(query);
        const slugMatch = (t.slug || "").toLowerCase().includes(query);
        const descMatch = (t.description || "").toLowerCase().includes(query);
        return nameMatch || slugMatch || descMatch;
      });
    }

    if (category && category !== "all") {
      const catLower = category.toLowerCase();
      filtered = filtered.filter((t) => {
        const primaryCat = (t.category || "").toLowerCase();
        const cats = Array.isArray(t.categories) ? t.categories.map((c) => (c || "").toLowerCase()) : [];
        return (
          primaryCat.includes(catLower) ||
          catLower.includes(primaryCat) ||
          cats.some((c) => c.includes(catLower) || catLower.includes(c))
        );
      });
    }

    // 4. Sort in-memory (with relevance ranking when querying)
    if (query) {
      filtered.sort((a, b) => {
        const aName = (a.name || "").toLowerCase();
        const bName = (b.name || "").toLowerCase();
        const aSlug = (a.slug || "").toLowerCase();
        const bSlug = (b.slug || "").toLowerCase();

        // Exact match
        const aExact = aName === query || aSlug === query;
        const bExact = bName === query || bSlug === query;
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;

        // Starts with
        const aStarts = aName.startsWith(query) || aSlug.startsWith(query);
        const bStarts = bName.startsWith(query) || bSlug.startsWith(query);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;

        // Name includes vs only description includes
        const aNameInc = aName.includes(query) || aSlug.includes(query);
        const bNameInc = bName.includes(query) || bSlug.includes(query);
        if (aNameInc && !bNameInc) return -1;
        if (!aNameInc && bNameInc) return 1;

        return aName.localeCompare(bName);
      });
    } else {
      filtered.sort((a, b) => {
        if (sort === "name-desc") {
          return b.name.localeCompare(a.name);
        } else if (sort === "category-asc") {
          const catComp = (a.category || "").localeCompare(b.category || "");
          if (catComp !== 0) return catComp;
          return a.name.localeCompare(b.name);
        } else {
          // Default: name-asc
          return a.name.localeCompare(b.name);
        }
      });
    }

    // 5. Paginate in-memory
    const total = filtered.length;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginated = filtered.slice(startIndex, endIndex);

    return NextResponse.json({
      toolkits: paginated,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown", toolkits: [] }, { status: 500 });
  }
}

