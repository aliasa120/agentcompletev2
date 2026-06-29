import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { testSseMcp, testStdioMcp } from "../../manual/test/route";
import { resolveNpmPackage, mapCommonEnvVariables } from "../../manual/route";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

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
    return handleLocalConnect(body);
  } else if (mode === "remote") {
    return handleRemoteConnect(body);
  }

  return NextResponse.json({ success: false, error: `Unknown mode: ${mode}` }, { status: 400 });
}

/**
 * Local connect: User connects to a server-side installed MCP using their own credentials.
 * The install_config (command + args) comes from the smithery_server_installs table.
 * User credentials are stored as env vars in the mcp_url JSON.
 */
async function handleLocalConnect(body: {
  qualifiedName: string;
  displayName: string;
  userCredentials: Record<string, string>;
  label?: string;
}) {
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
      runCommand = "npx";
      runArgs = ["-y", npmPackageName];
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
    .from("mcp_connections")
    .select("id")
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
async function handleRemoteConnect(body: {
  qualifiedName: string;
  displayName: string;
  smitheryApiKey: string;
  label?: string;
  config?: any; // User-provided API key values (input_required flow)
}) {
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
    if (!nsRes.ok) throw new Error(`Namespace lookup returned ${nsRes.status}`);
    const nsData = await nsRes.json();
    namespace = nsData.namespaces?.[0]?.name;
  } catch (e: any) {
    return NextResponse.json({ success: false, error: `Invalid Smithery API Key: ${e.message}` });
  }

  if (!namespace) {
    return NextResponse.json({ success: false, error: "No namespace found for this API key on Smithery." });
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
    const connRes = await fetch(`https://smithery.run/${namespace}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
        "Authorization": `Bearer ${smitheryApiKey.trim()}`,
      },
      body: JSON.stringify({
        mcpUrl: mcpServerUrl,
        name: displayName,
        headers: headersToSend
      })
    });
    if (!connRes.ok) throw new Error(`Connection creation returned ${connRes.status}`);
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

  const { data: conn, error: insertError } = await supabase
    .from("mcp_connections")
    .insert({
      label: label ?? `Smithery (Remote): ${displayName}`,
      toolkit_slug: qualifiedName,
      connection_type: "manual",
      status: state === "auth_required" ? "inactive" : "active",
      mcp_url: mcpUrlJson,
      available_tools,
    })
    .select()
    .single();

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
      // Auto-activate connection in DB and fetch tools
      try {
        const { data: inactiveConns } = await supabase
          .from("mcp_connections")
          .select("id, mcp_url")
          .eq("connection_type", "manual")
          .eq("status", "inactive");
        
        for (const conn of inactiveConns ?? []) {
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
