import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

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

import { testSseMcp, testStdioMcp, resolveNpmPackage, mapCommonEnvVariables } from "@/lib/mcp-tester";

// Supabase client is initialized per-request using getSupabaseClient(cookieStore)

/**
 * POST /api/mcp/smithery/connect
 * 
 * Creates an MCP connection for the current user — either:
 *   mode: "local"  → Uses a server-side installed package + user's own credentials as env vars
 *   mode: "remote" → Connects to Smithery's managed cloud hosting with user's Smithery API key
 * 
 * Body:
 *   { mode: "local",  qualifiedName, displayName, userCredentials: Record<string, string> }
 *   { mode: "remote", qualifiedName, displayName, smitheryApiKey: string, config?: Record<string, string> }
 *
 * The optional `config` field carries user-provided API keys for servers that return
 * state="input_required". Values are embedded into the connection URL as query params
 * or headers according to the server's configSchema x-from metadata.
 */
export async function POST(req: Request) {
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
  }

  const { mode, qualifiedName, displayName } = body;

  if (!mode || !qualifiedName) {
    return NextResponse.json(
      { success: false, error: "mode and qualifiedName are required" },
      { status: 400 }
    );
  }

  if (mode === "local") {
    return handleLocalConnect(body, supabase, user);
  } else if (mode === "remote") {
    return handleRemoteConnect(body, supabase, user);
  }

  return NextResponse.json({ success: false, error: `Unknown mode: ${mode}` }, { status: 400 });
}

/**
 * Local connect: User connects to a server-side installed MCP using their own credentials.
 * The install_config (command + args) comes from the smithery_server_installs table.
 * User credentials are stored as env vars in the mcp_url JSON.
 */
async function handleLocalConnect(
  body: {
    qualifiedName: string;
    displayName: string;
    userCredentials: Record<string, string>;
    label?: string;
  },
  supabase: any,
  user: any
) {
  const { qualifiedName, displayName, userCredentials, label } = body;

  // Fetch the install config from the DB
  const { data: installRecord, error: fetchError } = await supabase
    .from("smithery_server_installs")
    .select("install_config, status")
    .eq("qualified_name", qualifiedName)
    .eq("status", "installed")
    .single();

  if (fetchError || !installRecord) {
    return NextResponse.json({
      success: false,
      error: `No installed package found for '${qualifiedName}'. Please install it first.`,
    });
  }

  const installConfig = installRecord.install_config as {
    command: string;
    args: string[];
    env: Record<string, string>;
  };

  // Determine if it uses mcp-remote and rewrite accordingly
  let runCommand = installConfig.command;
  let runArgs = installConfig.args || [];
  let baseEnv = {
    ...installConfig.env,
    ...(userCredentials ?? {}),
  };

  const isMcpRemote = runArgs.some(arg => arg.includes("mcp-remote"));
  if (isMcpRemote) {
    try {
      const npmPackageName = await resolveNpmPackage(qualifiedName);
      
      // Validate if the resolved package is a match or a false positive
      const parts = qualifiedName.split("/");
      const shortName = parts[parts.length - 1].toLowerCase();
      const cleanPkgName = npmPackageName.replace(/^@/, "").split("/").pop() || "";
      if (!cleanPkgName.toLowerCase().includes(shortName)) {
        throw new Error(`Package name mismatch: resolved ${npmPackageName} for ${qualifiedName}`);
      }
      
      // Ensure the package is installed locally in the project's node_modules
      const fs = await import("fs/promises");
      const path = await import("path");
      const localPkgPath = path.join(process.cwd(), "node_modules", npmPackageName);
      
      try {
        await fs.access(localPkgPath);
      } catch {
        console.log(`[Smithery Connect] Package ${npmPackageName} not found in node_modules, installing on the fly...`);
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);
        await execAsync(`npm install --no-save --legacy-peer-deps ${npmPackageName}`, {
          timeout: 300000,
          env: process.env,
        });
      }

      // Read bin path from package.json
      let binPath = "";
      try {
        const pjPath = path.join(localPkgPath, "package.json");
        const pjContent = await fs.readFile(pjPath, "utf-8");
        const pj = JSON.parse(pjContent);
        if (typeof pj.bin === "string") {
          binPath = pj.bin;
        } else if (pj.bin && typeof pj.bin === "object") {
          const keys = Object.keys(pj.bin);
          binPath = pj.bin[keys[0]];
        }
        
        if (!binPath) {
          if (typeof pj.main === "string") {
            binPath = pj.main;
          } else if (pj.exports && typeof pj.exports === "object") {
            const exp = pj.exports["."] || pj.exports;
            if (typeof exp === "string") {
              binPath = exp;
            } else if (exp && typeof exp === "object") {
              binPath = exp.default || exp.import || exp.require || "";
            }
          }
        }
      } catch (pjErr) {
        console.warn(`[Smithery Connect] Failed to read package.json for ${npmPackageName}:`, pjErr);
      }

      if (binPath) {
        runCommand = "node";
        runArgs = [path.join("node_modules", npmPackageName, binPath)];
      } else {
        runCommand = "npx";
        runArgs = ["-y", npmPackageName];
      }
      
      baseEnv = mapCommonEnvVariables(baseEnv, npmPackageName);
    } catch (e) {
      console.warn("[Smithery Connect] Failed to rewrite mcp-remote config, using original:", e);
    }
  }

  // Build the mcp_url JSON
  const mcpUrlJson = JSON.stringify({
    transport: "stdio",
    command: runCommand,
    args: runArgs,
    env: baseEnv,
    description: `Smithery Local: ${displayName}`,
    smithery_qualified_name: qualifiedName,
    smithery_mode: "local",
  });

  // Fetch tools immediately for local stdio connection
  let available_tools: any[] = [];
  try {
    const testRes = await testStdioMcp(runCommand, runArgs, baseEnv);
    available_tools = (testRes.tools || []).map((t: any) => ({
      tool_key: t.name,
      tool_name: t.title || t.name,
      description: t.description || ""
    }));
  } catch (stdioErr) {
    console.warn("[Smithery Connect] Stdio immediate tools fetch failed:", stdioErr);
  }

  // Check if a connection with this toolkit_slug already exists to prevent duplicates
  const { data: existingConn } = await supabase
    .from("mcp_connections").select("id").eq("user_id", user.id)
    .eq("toolkit_slug", qualifiedName)
    .maybeSingle();

  let conn: any = null;
  let insertError: any = null;

  if (existingConn) {
    const { data, error } = await supabase
      .from("mcp_connections")
      .update({
        label: label ?? `Smithery: ${displayName}`,
        status: "active",
        mcp_url: mcpUrlJson,
        available_tools,
        updated_at: new Date().toISOString()
      })
      .eq("id", existingConn.id)
      .select()
      .single();
    conn = data;
    insertError = error;
  } else {
    const { data, error } = await supabase
      .from("mcp_connections")
      .insert({
        user_id: user.id,
        label: label ?? `Smithery: ${displayName}`,
        toolkit_slug: qualifiedName,
        connection_type: "manual",
        status: "active",
        mcp_url: mcpUrlJson,
        available_tools,
        updated_at: new Date().toISOString()
      })
      .select()
      .single();
    conn = data;
    insertError = error;
  }

  if (insertError) {
    return NextResponse.json({ success: false, error: insertError.message });
  }

  return NextResponse.json({ success: true, connectionId: conn.id, connection: conn });
}



async function getServerConfigSchema(qualifiedName: string): Promise<any | null> {
  try {
    const res = await fetch(`https://api.smithery.ai/servers/${qualifiedName}`, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const connections = data.connections ?? [];
      const httpConn = connections.find((c: any) => c.configSchema && Object.keys(c.configSchema).length > 0);
      if (httpConn && httpConn.configSchema) {
        return httpConn.configSchema;
      }
    }
  } catch (e) {
    console.warn("[Smithery Connect] Failed to fetch server schema from registry:", e);
  }
  return null;
}

function mapConfigSchema(configSchema: any) {
  const query: Record<string, any> = {};
  const headers: Record<string, any> = {};
  
  if (configSchema && configSchema.properties) {
    const requiredList = configSchema.required ?? [];
    
    for (const [key, prop] of Object.entries(configSchema.properties) as [string, any][]) {
      const isRequired = requiredList.includes(key);
      const xFrom = prop["x-from"] ?? {};
      
      const fieldSpec = {
        type: prop.type ?? "string",
        label: prop.title ?? key,
        description: prop.description ?? "",
        required: isRequired,
        examples: prop.examples ?? [],
        format: prop.format ?? ""
      };
      
      if (xFrom.header || xFrom.headers) {
        headers[key] = fieldSpec;
      } else if (xFrom.query) {
        query[key] = fieldSpec;
      } else {
        // Fallback guess: default to query parameters to prevent Smithery "does not accept manual headers" restriction
        query[key] = fieldSpec;
      }
    }
  }
  
  return { query, headers };
}

/**
 * Remote connect: User connects to Smithery's managed cloud using their own Smithery API key.
 * Initiates the connection on Smithery, detects if OAuth/API-key input is required,
 * and returns the appropriate state to the frontend.
 * 
 * Smithery returns three states:
 *   "connected"      → Tools available immediately — no user action needed
 *   "auth_required"  → OAuth flow — open setupUrl popup, poll until connected
 *   "input_required" → API key required — show configSchema form, re-submit with values
 */
async function handleRemoteConnect(
  body: {
    qualifiedName: string;
    displayName: string;
    smitheryApiKey: string;
    label?: string;
    config?: any;
  },
  supabase: any,
  user: any
) {
  const { qualifiedName, displayName, smitheryApiKey, label, config } = body;

  if (!smitheryApiKey?.trim()) {
    return NextResponse.json({
      success: false,
      error: "Smithery API key is required for remote connections.",
    });
  }

  // 1. Get user's namespace
  let namespace = "";
  try {
    const nsRes = await fetch("https://api.smithery.ai/namespaces", {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
        "Authorization": `Bearer ${smitheryApiKey.trim()}`,
      }
    });
    if (!nsRes.ok) {
      let errMsg = `Namespace lookup returned ${nsRes.status}`;
      try {
        const errText = await nsRes.text();
        errMsg = `${errMsg}: ${errText}`;
      } catch {}
      throw new Error(errMsg);
    }
    const nsData = await nsRes.json();
    namespace = nsData.namespaces?.[0]?.name;
  } catch (e: any) {
    return NextResponse.json({ success: false, error: `Invalid Smithery API Key: ${e.message}` });
  }

  if (!namespace) {
    return NextResponse.json({ success: false, error: "No namespace found for this API key on Smithery." });
  }

  // 1.5 Fetch configuration schema from Smithery registry details
  const registrySchema = await getServerConfigSchema(qualifiedName);
  if (registrySchema && registrySchema.properties && Object.keys(registrySchema.properties).length > 0) {
    const requiredFields = registrySchema.required ?? [];
    const providedConfigKeys = new Set(
      config
        ? "query" in config || "headers" in config
          ? [...Object.keys(config.query ?? {}), ...Object.keys(config.headers ?? {})]
          : Object.keys(config)
        : []
    );
    
    const isMissingRequired = requiredFields.some((f: string) => !providedConfigKeys.has(f));
    
    if (!config || Object.keys(config).length === 0 || isMissingRequired) {
      const mappedSchema = mapConfigSchema(registrySchema);
      return NextResponse.json({
        success: true,
        requiresInput: true,
        configSchema: mappedSchema,
        missingFields: {
          query: requiredFields.filter((f: string) => {
            const prop = registrySchema.properties[f];
            const xFrom = prop?.["x-from"] ?? {};
            return !("headers" in xFrom) && !providedConfigKeys.has(f);
          }),
          headers: requiredFields.filter((f: string) => {
            const prop = registrySchema.properties[f];
            const xFrom = prop?.["x-from"] ?? {};
            return "headers" in xFrom && !providedConfigKeys.has(f);
          })
        },
        setupUrl: null,
        namespace,
        smitheryConnectionId: "",
      });
    }
  }

  // 2. Build the MCP URL — embed any user-provided config (API keys) into the URL/headers
  // Smithery uses configSchema/status.http to map values to headers or query params.
  let mcpServerUrl = `https://server.smithery.ai/${qualifiedName}/mcp`;
  let headersToSend: Record<string, string> = {};

  if (config && Object.keys(config).length > 0) {
    if ("query" in config || "headers" in config) {
      // Structured config passed from frontend
      const queryParams = config.query ?? {};
      if (Object.keys(queryParams).length > 0) {
        const qp = new URLSearchParams(queryParams);
        mcpServerUrl = `${mcpServerUrl}?${qp.toString()}`;
      }
      headersToSend = config.headers ?? {};
    } else {
      // Flat config fallback (default everything to query parameters)
      const qp = new URLSearchParams(config);
      mcpServerUrl = `${mcpServerUrl}?${qp.toString()}`;
    }
  }

  // 3. Create the remote connection on Smithery via POST
  let connectionResult: any;
  try {
    const postBody = {
      mcpUrl: mcpServerUrl,
      name: displayName,
      ...(Object.keys(headersToSend).length > 0 ? { headers: headersToSend } : {})
    };
    console.log("[Smithery Connect] namespace:", namespace);
    console.log("[Smithery Connect] mcpUrl:", mcpServerUrl);
    console.log("[Smithery Connect] headersToSend:", headersToSend);
    console.log("[Smithery Connect] POST body:", JSON.stringify(postBody));

    const connRes = await fetch(`https://smithery.run/${namespace}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
        "Authorization": `Bearer ${smitheryApiKey.trim()}`,
      },
      body: JSON.stringify(postBody)
    });
    if (!connRes.ok) {
      let errMsg = `Connection creation returned ${connRes.status}`;
      try {
        const errText = await connRes.text();
        errMsg = `${errMsg}: ${errText}`;
      } catch {}
      throw new Error(errMsg);
    }
    connectionResult = await connRes.json();
  } catch (e: any) {
    return NextResponse.json({ success: false, error: `Failed to create Smithery connection: ${e.message}` });
  }

  const connectionId = connectionResult.connectionId;
  const state = connectionResult.status?.state ?? "unknown";
  const setupUrl = connectionResult.status?.setupUrl ?? connectionResult.status?.authorizationUrl ?? null;
  
  // For input_required: status.http describes what fields the server needs (API keys etc.)
  const configSchema = connectionResult.status?.http ?? connectionResult.status?.configSchema ?? null;
  const missingFields = connectionResult.status?.missing ?? null;

  // ── Handle input_required (API key / settings required) ─────────────────────
  // Don't save the connection yet — return the schema to the frontend so the user
  // can fill in the required values, then re-call this endpoint with config=filled values.
  if (state === "input_required") {
    return NextResponse.json({
      success: true,
      requiresInput: true,
      configSchema,
      missingFields,
      setupUrl,           // Smithery may provide a hosted form URL too
      namespace,
      smitheryConnectionId: connectionId,
    });
  }

  // 4. Save to manual connection table
  // Stored with state="inactive" if OAuth is needed, activated on successful poll
  const mcpUrlJson = JSON.stringify({
    transport: "sse",
    url: `https://mcp.smithery.run/${namespace}/${connectionId}`,
    headers: {
      Authorization: `Bearer ${smitheryApiKey.trim()}`,
    },
    description: `Smithery Remote: ${displayName}`,
    smithery_qualified_name: qualifiedName,
    smithery_mode: "remote",
  });

  // Fetch tools immediately if connected and no auth is required
  let available_tools: any[] = [];
  if (state === "connected") {
    try {
      const mcpUrl = `https://mcp.smithery.run/${namespace}/${connectionId}`;
      const testRes = await testSseMcp(mcpUrl, {
        Authorization: `Bearer ${smitheryApiKey.trim()}`,
      });
      available_tools = (testRes.tools || []).map((t: any) => ({
        tool_key: t.name,
        tool_name: t.title || t.name,
        description: t.description || ""
      }));
    } catch (sseErr) {
      console.warn("[Smithery Connect] Immediate tools fetch failed:", sseErr);
    }
  }

  const { data: existingConn } = await supabase
    .from("mcp_connections")
    .select("id")
    .eq("user_id", user.id)
    .eq("toolkit_slug", qualifiedName)
    .maybeSingle();

  let conn: any = null;
  let insertError: any = null;

  if (existingConn) {
    const { data, error } = await supabase
      .from("mcp_connections")
      .update({
        label: label ?? `Smithery (Remote): ${displayName}`,
        status: state === "auth_required" ? "inactive" : "active",
        mcp_url: mcpUrlJson,
        available_tools,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingConn.id)
      .select()
      .single();
    conn = data;
    insertError = error;
  } else {
    const { data, error } = await supabase
      .from("mcp_connections")
      .insert({
        user_id: user.id,
        label: label ?? `Smithery (Remote): ${displayName}`,
        toolkit_slug: qualifiedName,
        connection_type: "manual",
        status: state === "auth_required" ? "inactive" : "active",
        mcp_url: mcpUrlJson,
        available_tools,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    conn = data;
    insertError = error;
  }

  if (insertError) {
    return NextResponse.json({ success: false, error: insertError.message });
  }

  return NextResponse.json({
    success: true,
    connectionId: conn.id,
    connection: conn,
    requiresAuth: state === "auth_required",
    setupUrl,
    namespace,
    smitheryConnectionId: connectionId,
  });
}

/**
 * GET /api/mcp/smithery/connect
 * 
 * Polls the connection status on Smithery. Auto-activates the connection in DB once state is "connected".
 */
export async function GET(req: Request) {
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  const { searchParams } = new URL(req.url);
  const namespace = searchParams.get("namespace");
  const connectionId = searchParams.get("connectionId");
  const smitheryApiKey = searchParams.get("smitheryApiKey");

  if (!namespace || !connectionId || !smitheryApiKey) {
    return NextResponse.json(
      { success: false, error: "namespace, connectionId, and smitheryApiKey are required" },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(`https://smithery.run/${namespace}/${connectionId}`, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
        "Authorization": `Bearer ${smitheryApiKey.trim()}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Smithery status check returned ${res.status}`);
    }

    const data = await res.json();
    const state = data.status?.state ?? "unknown";

    if (state === "connected") {
      try {
        const { data: allUserConns } = await supabase
          .from("mcp_connections").select("id, mcp_url").eq("user_id", user.id)
          .eq("connection_type", "manual");
        
        for (const conn of allUserConns ?? []) {
          if (conn.mcp_url?.includes(`/${namespace}/${connectionId}`)) {
            // Introspect tools first
            let available_tools: any[] = [];
            try {
              const mcpUrl = `https://mcp.smithery.run/${namespace}/${connectionId}`;
              const testRes = await testSseMcp(mcpUrl, {
                Authorization: `Bearer ${smitheryApiKey.trim()}`,
              });
              available_tools = (testRes.tools || []).map((t: any) => ({
                tool_key: t.name,
                tool_name: t.title || t.name,
                description: t.description || ""
              }));
            } catch (sseErr) {
              console.warn("[Smithery Poll] Tools fetch failed:", sseErr);
            }

            await supabase
              .from("mcp_connections")
              .update({ 
                status: "active",
                available_tools,
                updated_at: new Date().toISOString()
              })
              .eq("id", conn.id);
            break;
          }
        }
      } catch (dbErr) {
        console.error("[Smithery Poll] Failed to auto-activate connection in DB:", dbErr);
      }
    }

    return NextResponse.json({
      success: true,
      state,
      status: data.status,
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message });
  }
}
