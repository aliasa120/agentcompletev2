import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY ?? "";
const COMPOSIO_BASE = "https://backend.composio.dev/api/v3";
const CACHE_FILE = path.join(process.cwd(), "composio_toolkits_cache.json");
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours in ms

async function fetchAllToolkitsFromAPI() {
  const url = new URL(`${COMPOSIO_BASE}/toolkits`);
  url.searchParams.set("page", "1");
  url.searchParams.set("limit", "500");

  const res = await fetch(url.toString(), {
    headers: {
      "x-api-key": COMPOSIO_API_KEY,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) {
    throw new Error(`Composio API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const items = data.items ?? data.toolkits ?? [];
  return items.map((t: any) => {
    const meta = t.meta ?? {};
    const categories = meta.categories ?? [];
    const categoryName = categories[0]?.name ?? categories[0]?.id ?? "General";
    return {
      slug: t.slug ?? t.key,
      name: t.name ?? t.display_name ?? t.slug,
      description: t.description ?? meta.description ?? "",
      logo_url: t.logo ?? t.logo_url ?? meta.logo ?? t.icon ?? "",
      category: (t.category as string) ?? categoryName,
    };
  });
}

export async function GET(req: Request) {
  if (!COMPOSIO_API_KEY) {
    return NextResponse.json(
      { error: "COMPOSIO_API_KEY not set in environment", toolkits: [] },
      { status: 200 }
    );
  }

  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") ?? "").trim().toLowerCase();
  const category = (searchParams.get("category") ?? "").trim().toLowerCase();
  const sort = searchParams.get("sort") ?? "name-asc";
  const page = parseInt(searchParams.get("page") ?? "1", 10);
  const limit = parseInt(searchParams.get("limit") ?? "24", 10);

  let toolkits: any[] = [];
  let useCache = false;

  // 1. Try reading from local cache file
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const stats = fs.statSync(CACHE_FILE);
      const isFresh = Date.now() - stats.mtimeMs < CACHE_TTL;
      if (isFresh) {
        const cachedData = fs.readFileSync(CACHE_FILE, "utf-8");
        toolkits = JSON.parse(cachedData);
        useCache = true;
      }
    }
  } catch (err) {
    console.error("[Toolkits Cache Read Error]", err);
  }

  // 2. Fetch from API if cache is missing, stale, or failed
  if (!useCache) {
    try {
      toolkits = await fetchAllToolkitsFromAPI();
      // Write to cache
      try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(toolkits), "utf-8");
      } catch (writeErr) {
        console.error("[Toolkits Cache Write Error]", writeErr);
      }
    } catch (apiErr) {
      console.error("[Toolkits API Fetch Error]", apiErr);
      // Fallback to stale cache if it exists
      if (fs.existsSync(CACHE_FILE)) {
        try {
          const cachedData = fs.readFileSync(CACHE_FILE, "utf-8");
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
    filtered = filtered.filter(
      (t) =>
        t.name.toLowerCase().includes(query) ||
        t.slug.toLowerCase().includes(query) ||
        t.description.toLowerCase().includes(query)
    );
  }

  if (category && category !== "all") {
    filtered = filtered.filter((t) => t.category.toLowerCase() === category);
  }

  // 4. Sort in-memory
  filtered.sort((a, b) => {
    if (sort === "name-desc") {
      return b.name.localeCompare(a.name);
    } else if (sort === "category-asc") {
      const catComp = a.category.localeCompare(b.category);
      if (catComp !== 0) return catComp;
      return a.name.localeCompare(b.name);
    } else {
      // Default: name-asc
      return a.name.localeCompare(b.name);
    }
  });

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
}

