import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

interface ProviderMeta {
  id: string;
  label: string;
  badgeColor: string;
  keySet: boolean;
  defaultModels: { value: string; label: string; badge: string }[];
}

interface RegistryProvider {
  id: string;
  alias: string;
  name: string;
  noAuth: boolean;
  fetcherUrl: string | null;
  staticModels: { id: string; name: string }[];
}

function getBadgeColorForPrefix(prefix: string): string {
  const colors: Record<string, string> = {
    openai: "from-green-500 to-emerald-600",
    anthropic: "from-orange-500 to-amber-600",
    google: "from-blue-500 via-red-500 to-yellow-500",
    novita: "from-cyan-500 to-blue-600",
    openrouter: "from-violet-500 to-purple-600",
    groq: "from-rose-500 to-red-600",
    together: "from-teal-500 to-cyan-600",
    opencode: "from-violet-600 to-indigo-700",
    oc: "from-violet-600 to-indigo-700",
    deepseek: "from-blue-600 via-sky-500 to-cyan-400",
    ninerouter: "from-cyan-500 to-blue-600",
    xiaomi: "from-orange-500 to-amber-600",
    mimo: "from-orange-500 to-amber-600",
    mmf: "from-orange-500 to-amber-600",
    cbcn: "from-violet-500 to-purple-600",
    kr: "from-blue-500 to-sky-600",
  };
  return colors[prefix.toLowerCase()] || "from-cyan-500 to-blue-600";
}

function getRegistryProviders(): RegistryProvider[] {
  const providers: RegistryProvider[] = [];
  try {
    const registryDir = path.join(process.cwd(), "../9router-master/open-sse/providers/registry");
    if (fs.existsSync(registryDir)) {
      const files = fs.readdirSync(registryDir);
      for (const file of files) {
        if (file.endsWith(".js") && file !== "index.js") {
          const content = fs.readFileSync(path.join(registryDir, file), "utf8");
          
          // Skip hidden registry providers
          if (/hidden:\s*true/.test(content)) {
            continue;
          }

          // Skip non-LLM registry providers (like tts, stt, image-only)
          const serviceKindsMatch = content.match(/serviceKinds:\s*\[([\s\S]*?)\]/);
          if (serviceKindsMatch) {
            const kinds = serviceKindsMatch[1].replace(/["'\s]/g, "").split(",");
            if (!kinds.includes("chat")) {
              continue; 
            }
          }

          const idMatch = content.match(/id:\s*["']([^"']+)["']/);
          const aliasMatch = content.match(/alias:\s*["']([^"']+)["']/);
          const noAuthMatch = content.match(/noAuth:\s*true/);
          const fetcherMatch = content.match(/modelsFetcher:\s*\{\s*url:\s*["']([^"']+)["']/);
          
          let name = "";
          const displayBlockMatch = content.match(/display:\s*\{([^}]+)\}/);
          if (displayBlockMatch) {
            const nameMatch = displayBlockMatch[1].match(/name:\s*["']([^"']+)["']/);
            if (nameMatch) name = nameMatch[1];
          }

          let staticModels: { id: string; name: string }[] = [];
          const modelsMatch = content.match(/models:\s*\[([\s\S]*?)\]/);
          if (modelsMatch) {
            const rawModels = modelsMatch[1];
            const modelMatches = [...rawModels.matchAll(/id:\s*["']([^"']+)["'](?:,\s*name:\s*["']([^"']+)["'])?/g)];
            staticModels = modelMatches.map(m => ({
              id: m[1],
              name: m[2] || m[1]
            }));
          }

          if (idMatch) {
            providers.push({
              id: idMatch[1],
              alias: aliasMatch ? aliasMatch[1] : idMatch[1],
              name: name || idMatch[1],
              noAuth: !!noAuthMatch,
              fetcherUrl: fetcherMatch ? fetcherMatch[1] : null,
              staticModels
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("Failed to parse 9Router registry:", err);
  }
  return providers;
}

export async function GET() {
  let ninerouter_key = "";
  try {
    const { data } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("key", "ninerouter_client_api_key")
      .single();
    if (data?.value) {
      ninerouter_key = data.value.trim();
    }
  } catch {}

  // Multi-tenant isolation: new users with no 9Router Client key have zero providers
  if (!ninerouter_key) {
    return NextResponse.json({ providers: [] });
  }

  let gatewayModels: any[] = [];
  
  // Dynamically load all free/noAuth providers from the 9Router source code folder
  const registryProviders = getRegistryProviders();
  const idToAlias: Record<string, string> = {};
  for (const p of registryProviders) {
    idToAlias[p.id.toLowerCase()] = p.alias.toLowerCase();
  }

  const noAuthProviders = registryProviders.filter(p => p.noAuth);
  const noAuthAliases = new Set(noAuthProviders.map(p => p.alias.toLowerCase()));

  // Query 9Router SQLite DB for disabled & custom models list
  let dbData = { disabled: {} as Record<string, string[]>, custom: {} as Record<string, { id: string, name: string }[]> };
  try {
    const scriptPath = path.join(process.cwd(), "query_disabled_models.py");
    const output = execSync("python " + JSON.stringify(scriptPath), { encoding: "utf8" });
    dbData = JSON.parse(output.trim());
  } catch (err) {
    console.error("Failed to query 9Router SQLite DB:", err);
  }

  try {
    const isDocker = !!process.env.NINE_ROUTER_INTERNAL_URL;
    const nineRouterBaseUrl = process.env.NINE_ROUTER_INTERNAL_URL || process.env.NEXT_PUBLIC_NINE_ROUTER_URL || (isDocker ? "http://ninerouter:20128" : "http://localhost:20128");
    
    // Fetch all available models from 9Router using client Bearer token
    // x-9r-only-active: true filters out providers with no active connections configured
    const res = await fetch(`${nineRouterBaseUrl}/v1/models`, {
      headers: {
        "Authorization": `Bearer ${ninerouter_key}`,
        "x-9r-only-active": "true"
      }
    });
    if (res.ok) {
      const d = await res.json();
      gatewayModels = d.data || [];
    }
  } catch (err) {
    console.error("Failed to load models from 9Router:", err);
    return NextResponse.json({ providers: [] });
  }

  const groupedProviders: Record<string, { label: string; badgeColor: string; defaultModels: any[] }> = {};

  // Process models returned dynamically by 9Router
  for (const m of gatewayModels) {
    const parts = m.id.split("/");
    let prefix = "ninerouter";
    let modelLabel = m.name || m.id;
    if (parts.length > 1) {
      prefix = parts[0].toLowerCase();
      modelLabel = parts.slice(1).join("/");
    }

    // Ignore free providers from the dynamic list as we fetch them live below
    if (noAuthAliases.has(prefix)) {
      continue;
    }

    if (!groupedProviders[prefix]) {
      const niceLabel = prefix.charAt(0).toUpperCase() + prefix.slice(1);
      groupedProviders[prefix] = {
        label: `${niceLabel} (9Router)`,
        badgeColor: getBadgeColorForPrefix(prefix),
        defaultModels: []
      };
    }

    groupedProviders[prefix].defaultModels.push({
      value: m.id,
      label: modelLabel,
      badge: "Gateway"
    });
  }

  // Map dynamically active providers
  const providers: ProviderMeta[] = Object.entries(groupedProviders).map(([id, cfg]) => ({
    id,
    label: cfg.label,
    badgeColor: cfg.badgeColor,
    keySet: true,
    defaultModels: cfg.defaultModels
  }));

  // Track unique aliases to prevent React key duplication (e.g. mmf.js vs mimo-free.js)
  const seenAliases = new Set<string>(providers.map(p => p.id.toLowerCase()));

  // Inject the free/no-auth providers' models dynamically
  for (const free of noAuthProviders) {
    const aliasLower = free.alias.toLowerCase();
    
    // Prevent duplicate entries for the same alias prefix
    if (seenAliases.has(aliasLower)) {
      continue;
    }

    const customList = dbData.custom[aliasLower] || [];
    const combinedModels = [...customList];
    const seenModelIds = new Set<string>(combinedModels.map(m => m.id.toLowerCase()));

    // Merge static models from registry file if they aren't already added
    if (free.staticModels) {
      for (const sm of free.staticModels) {
        if (!seenModelIds.has(sm.id.toLowerCase())) {
          combinedModels.push(sm);
        }
      }
    }

    const models = combinedModels.map(m => ({
      value: `${free.alias}/${m.id}`,
      label: m.name || m.id,
      badge: "Gateway"
    }));

    const disabledList = dbData.disabled[aliasLower] || [];
    const filteredModels = models.filter(m => {
      const modelId = m.value.split("/")[1];
      return !disabledList.includes(modelId);
    });

    if (filteredModels.length > 0) {
      providers.push({
        id: free.alias,
        label: `${free.name} (9Router)`,
        badgeColor: getBadgeColorForPrefix(free.alias),
        keySet: true,
        defaultModels: filteredModels
      });
      seenAliases.add(aliasLower);
    }
  }

  return NextResponse.json({ providers });
}
