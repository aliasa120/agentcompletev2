import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// Helper to fetch tools from a Streamable HTTP connection (Zapier style)
async function fetchMcpStreamableHttpTools(mcpUrl: string, secret?: string): Promise<{ tool_key: string; tool_name: string }[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
  };
  if (secret) {
    headers["Authorization"] = `Bearer ${secret}`;
  }

  // 1. Initialize
  const initRes = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "easyclaw-client", version: "1.0.0" }
      },
      id: 1
    }),
    signal: AbortSignal.timeout(5000)
  });

  if (!initRes.ok) {
    throw new Error(`Initialize failed with status: ${initRes.status}`);
  }

  // 2. Send initialized notification
  await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    }),
    signal: AbortSignal.timeout(5000)
  });

  // 3. List tools
  const toolsRes = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
      id: 2
    }),
    signal: AbortSignal.timeout(5000)
  });

  if (!toolsRes.ok) {
    throw new Error(`Tools list request failed with status: ${toolsRes.status}`);
  }

  const toolsText = await toolsRes.text();
  let toolsDataJson = "";
  const lines = toolsText.split("\n");
  for (const line of lines) {
    if (line.startsWith("data:")) {
      toolsDataJson += line.slice(5).trim();
    }
  }

  if (!toolsDataJson) {
    throw new Error("No data: line found in tools list response");
  }

  const toolsData = JSON.parse(toolsDataJson);
  if (!toolsData.result?.tools) {
    throw new Error("Invalid response format, tools not found under result.tools");
  }

  return toolsData.result.tools.map((t: any) => ({
    tool_key: t.name,
    tool_name: t.title || t.name,
  }));
}

// Helper to fetch user's enabled actions from a connected Zapier server
async function fetchZapierEnabledActions(mcpUrl: string, secret?: string): Promise<{ tool_key: string; tool_name: string; underlying_tool: string; selected_api: string; action: string; app: string }[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
  };
  if (secret) {
    headers["Authorization"] = `Bearer ${secret}`;
  }

  // 1. Initialize
  const initRes = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "easyclaw-client", version: "1.0.0" }
      },
      id: 1
    }),
    signal: AbortSignal.timeout(5000)
  });
  if (!initRes.ok) throw new Error("Initialize failed");

  // 2. Send initialized notification
  await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    }),
    signal: AbortSignal.timeout(5000)
  });

  // 3. Get list of apps
  const appsRes = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "list_enabled_zapier_actions",
        arguments: {}
      },
      id: 3
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!appsRes.ok) throw new Error("Failed to call list_enabled_zapier_actions");

  const appsText = await appsRes.text();
  let appsDataJson = "";
  for (const line of appsText.split("\n")) {
    if (line.startsWith("data:")) {
      appsDataJson += line.slice(5).trim();
    }
  }
  if (!appsDataJson) return [];

  const appsParsed = JSON.parse(appsDataJson);
  const textContent = appsParsed.result?.content?.[0]?.text;
  if (!textContent) return [];

  const appsData = JSON.parse(textContent);
  const apps = appsData.apps || [];
  const actionTools: { tool_key: string; tool_name: string; underlying_tool: string; selected_api: string; action: string; app: string }[] = [];

  let idCounter = 4;
  for (const app of apps) {
    if (!app.selected_api) continue;
    try {
      const actionsRes = await fetch(mcpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "list_enabled_zapier_actions",
            arguments: {
              selected_api: app.selected_api
            }
          },
          id: idCounter++
        }),
        signal: AbortSignal.timeout(8000)
      });
      if (!actionsRes.ok) continue;

      const actionsText = await actionsRes.text();
      let actionsDataJson = "";
      for (const line of actionsText.split("\n")) {
        if (line.startsWith("data:")) {
          actionsDataJson += line.slice(5).trim();
        }
      }
      if (!actionsDataJson) continue;

      const actionsParsed = JSON.parse(actionsDataJson);
      const actionsTextContent = actionsParsed.result?.content?.[0]?.text;
      if (!actionsTextContent) continue;

      const actionsArray = JSON.parse(actionsTextContent);
      const appObj = Array.isArray(actionsArray) ? actionsArray[0] : actionsArray;
      const actions = appObj?.actions || [];

      for (const act of actions) {
        if (act.tool_name) {
          actionTools.push({
            tool_key: act.tool_name,
            tool_name: `Zapier: ${app.app} - ${act.name}`,
            underlying_tool: act.tool,
            selected_api: app.selected_api,
            action: act.key,
            app: app.app
          });
        }
      }
    } catch (e) {
      console.warn("Failed to fetch actions for app:", app.app, e);
    }
  }

  return actionTools;
}

// Helper to fetch tools from an SSE connection (standard MCP SSE protocol)
async function fetchMcpSseTools(mcpUrl: string, secret?: string): Promise<{ tool_key: string; tool_name: string }[]> {
  return new Promise(async (resolve, reject) => {
    let sseResponse: Response;
    try {
      const headers: Record<string, string> = { "Accept": "text/event-stream" };
      if (secret) {
        headers["Authorization"] = `Bearer ${secret}`;
      }
      sseResponse = await fetch(mcpUrl, { headers });
      if (!sseResponse.ok) {
        return reject(new Error(`SSE connection failed with status: ${sseResponse.status}`));
      }
    } catch (err) {
      return reject(err);
    }

    const reader = sseResponse.body?.getReader();
    if (!reader) {
      return reject(new Error("No response body reader available"));
    }

    let endpointUrl = "";
    let accumulatedText = "";
    const decoder = new TextDecoder();

    // Set a safety timeout
    const timeoutId = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(new Error("Timeout waiting for MCP tools list (8s)"));
    }, 8000);

    const cleanup = () => {
      clearTimeout(timeoutId);
      reader.cancel().catch(() => {});
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        accumulatedText += decoder.decode(value, { stream: true });
        
        // Parse SSE events
        const messages = accumulatedText.split("\n\n");
        accumulatedText = messages.pop() || "";

        for (const msg of messages) {
          const lines = msg.split("\n");
          let currentEvent = "";
          let currentData = "";

          for (const line of lines) {
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              currentData = line.slice(5).trim();
            }
          }

          // Case 1: We received the POST message endpoint URL
          if (currentEvent === "endpoint" && currentData) {
            if (currentData.startsWith("/")) {
              const origin = new URL(mcpUrl).origin;
              endpointUrl = `${origin}${currentData}`;
            } else {
              endpointUrl = currentData;
            }

            // Send the tools/list request via POST
            const postHeaders: Record<string, string> = { "Content-Type": "application/json" };
            if (secret) {
              postHeaders["Authorization"] = `Bearer ${secret}`;
            }

            fetch(endpointUrl, {
              method: "POST",
              headers: postHeaders,
              body: JSON.stringify({
                jsonrpc: "2.0",
                method: "tools/list",
                params: {},
                id: 1
              })
            }).catch(err => console.error("Error sending tools/list POST:", err));
          }

          // Case 2: We received a message. Let's see if it's the tools/list response
          if (currentEvent === "message" && currentData) {
            try {
              const parsed = JSON.parse(currentData);
              if (parsed.id === 1 && parsed.result?.tools) {
                const tools = parsed.result.tools.map((t: any) => ({
                  tool_key: t.name,
                  tool_name: t.title || t.name,
                }));
                cleanup();
                return resolve(tools);
              }
            } catch (e) {
              // Ignore parse errors on other messages
            }
          }
        }
      }
      cleanup();
      reject(new Error("Stream ended without receiving tools list"));
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

// GET /api/mcp/manual — list manual connections
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const sync = searchParams.get("sync") === "true";

    let { data } = await supabase
      .from("mcp_connections")
      .select("*")
      .eq("connection_type", "manual")
      .order("created_at", { ascending: false });

    let connections = data ?? [];

    if (sync) {
      const secret = process.env.ZAPIER_MCP_SECRET;
      // Find all unique base server URLs from Zapier connections
      const baseUrls = new Set<string>();
      for (const conn of connections) {
        if (conn.mcp_url?.startsWith("https://mcp.zapier.com/")) {
          baseUrls.add(conn.mcp_url.split("#")[0]);
        }
      }

      for (const baseServerUrl of baseUrls) {
        try {
          const defaultTools = await fetchMcpStreamableHttpTools(baseServerUrl, secret);
          const enabledActions = await fetchZapierEnabledActions(baseServerUrl, secret);

          // Group actions by app
          const appsActions: Record<string, any[]> = {};
          for (const act of enabledActions) {
            const appName = act.app || "Unknown App";
            if (!appsActions[appName]) {
              appsActions[appName] = [];
            }
            appsActions[appName].push(act);
          }

          // 1. Update/Insert Base
          const baseMcpUrl = `${baseServerUrl}#Base`;
          const { data: baseExisting } = await supabase
            .from("mcp_connections")
            .select("*")
            .eq("mcp_url", baseMcpUrl)
            .maybeSingle();

          if (baseExisting) {
            await supabase
              .from("mcp_connections")
              .update({ available_tools: defaultTools, updated_at: new Date().toISOString() })
              .eq("id", baseExisting.id);
          } else {
            await supabase
              .from("mcp_connections")
              .insert({
                connection_type: "manual",
                label: "Zapier MCP (Base)",
                mcp_url: baseMcpUrl,
                status: "active",
                available_tools: defaultTools,
                updated_at: new Date().toISOString(),
              });
          }

          // 2. Update/Insert Apps
          for (const appName of Object.keys(appsActions)) {
            const appMcpUrl = `${baseServerUrl}#${appName}`;
            const appLabel = `Zapier: ${appName}`;
            const appTools = appsActions[appName];

            const { data: appExisting } = await supabase
              .from("mcp_connections")
              .select("*")
              .eq("mcp_url", appMcpUrl)
              .maybeSingle();

            if (appExisting) {
              await supabase
                .from("mcp_connections")
                .update({ available_tools: appTools, updated_at: new Date().toISOString() })
                .eq("id", appExisting.id);
            } else {
              await supabase
                .from("mcp_connections")
                .insert({
                  connection_type: "manual",
                  label: appLabel,
                  mcp_url: appMcpUrl,
                  status: "active",
                  available_tools: appTools,
                  updated_at: new Date().toISOString(),
                });
            }
          }

          // 3. Clean up deleted apps
          const activeMcpUrls = [
            baseMcpUrl,
            ...Object.keys(appsActions).map(appName => `${baseServerUrl}#${appName}`)
          ];
          const { data: allUserConns } = await supabase
            .from("mcp_connections")
            .select("id, mcp_url")
            .eq("connection_type", "manual");
          
          for (const conn of (allUserConns || [])) {
            if (conn.mcp_url.startsWith(baseServerUrl) && !activeMcpUrls.includes(conn.mcp_url)) {
              await supabase.from("mcp_connections").delete().eq("id", conn.id);
            }
          }
        } catch (syncErr) {
          console.warn(`[Manual MCP] Sync failed for base ${baseServerUrl}:`, syncErr);
        }
      }

      // Re-fetch connections after sync
      const { data: updatedData } = await supabase
        .from("mcp_connections")
        .select("*")
        .eq("connection_type", "manual")
        .order("created_at", { ascending: false });
      connections = updatedData ?? [];
    }

    return NextResponse.json({ connections });
  } catch (e: unknown) {
    return NextResponse.json({ connections: [], error: e instanceof Error ? e.message : "Unknown" });
  }
}

// POST /api/mcp/manual — add manual MCP server
export async function POST(req: Request) {
  try {
    const { label, mcp_url, available_tools: manual_tools } = await req.json();
    if (!label || !mcp_url) {
      return NextResponse.json({ error: "label and mcp_url required" }, { status: 400 });
    }

    if (mcp_url.startsWith("https://mcp.zapier.com/")) {
      const baseServerUrl = mcp_url.split("#")[0];
      const secret = process.env.ZAPIER_MCP_SECRET;
      
      let defaultTools: any[] = [];
      let enabledActions: any[] = [];
      try {
        defaultTools = await fetchMcpStreamableHttpTools(baseServerUrl, secret);
        enabledActions = await fetchZapierEnabledActions(baseServerUrl, secret);
      } catch (err) {
        return NextResponse.json({ error: `Failed to connect to Zapier MCP: ${err instanceof Error ? err.message : err}` }, { status: 500 });
      }

      // Group actions by app
      const appsActions: Record<string, any[]> = {};
      for (const act of enabledActions) {
        const appName = act.app || "Unknown App";
        if (!appsActions[appName]) {
          appsActions[appName] = [];
        }
        appsActions[appName].push(act);
      }

      const results = [];

      // 1. Register Base Server
      const baseMcpUrl = `${baseServerUrl}#Base`;
      const baseLabel = `Zapier MCP (Base)`;
      const { data: baseExisting } = await supabase
        .from("mcp_connections")
        .select("*")
        .eq("mcp_url", baseMcpUrl)
        .maybeSingle();

      if (baseExisting) {
        const { data } = await supabase
          .from("mcp_connections")
          .update({ available_tools: defaultTools, updated_at: new Date().toISOString() })
          .eq("id", baseExisting.id)
          .select()
          .single();
        results.push(data);
      } else {
        const { data } = await supabase
          .from("mcp_connections")
          .insert({
            connection_type: "manual",
            label: baseLabel,
            mcp_url: baseMcpUrl,
            status: "active",
            available_tools: defaultTools,
            updated_at: new Date().toISOString(),
          })
          .select()
          .single();
        results.push(data);
      }

      // 2. Register App Specific Connections
      for (const appName of Object.keys(appsActions)) {
        const appMcpUrl = `${baseServerUrl}#${appName}`;
        const appLabel = `Zapier: ${appName}`;
        const appTools = appsActions[appName];

        const { data: appExisting } = await supabase
          .from("mcp_connections")
          .select("*")
          .eq("mcp_url", appMcpUrl)
          .maybeSingle();

        if (appExisting) {
          const { data } = await supabase
            .from("mcp_connections")
            .update({ available_tools: appTools, updated_at: new Date().toISOString() })
            .eq("id", appExisting.id)
            .select()
            .single();
          results.push(data);
        } else {
          const { data } = await supabase
            .from("mcp_connections")
            .insert({
              connection_type: "manual",
              label: appLabel,
              mcp_url: appMcpUrl,
              status: "active",
              available_tools: appTools,
              updated_at: new Date().toISOString(),
            })
            .select()
            .single();
          results.push(data);
        }
      }

      // 3. Clean up deleted apps
      const activeMcpUrls = [
        baseMcpUrl,
        ...Object.keys(appsActions).map(appName => `${baseServerUrl}#${appName}`)
      ];
      const { data: allUserConns } = await supabase
        .from("mcp_connections")
        .select("id, mcp_url")
        .eq("connection_type", "manual");
      
      for (const conn of (allUserConns || [])) {
        if (conn.mcp_url.startsWith(baseServerUrl) && !activeMcpUrls.includes(conn.mcp_url)) {
          await supabase.from("mcp_connections").delete().eq("id", conn.id);
        }
      }

      return NextResponse.json({ connection: results[0] });
    }

    // Check if duplicate connection exists (same mcp_url)
    const { data: existing } = await supabase
      .from("mcp_connections")
      .select("*")
      .eq("mcp_url", mcp_url)
      .maybeSingle();

    if (existing && existing.available_tools?.length > 0) {
      return NextResponse.json({ connection: existing });
    }

    // Use user-provided manual tools list if available, otherwise attempt SSE/HTTP introspection
    let available_tools: any[] = [];
    if (manual_tools && Array.isArray(manual_tools)) {
      available_tools = manual_tools;
    } else {
      const secret = process.env.ZAPIER_MCP_SECRET;
      try {
        available_tools = await fetchMcpSseTools(mcp_url, secret);
      } catch (sseErr) {
        console.warn("[Manual MCP] SSE fallback introspection failed:", sseErr instanceof Error ? sseErr.message : sseErr);
      }

      // Fall back to standard HTTP POST /tools/list if SSE failed
      if (available_tools.length === 0) {
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          const introspectRes = await fetch(`${mcp_url}/tools/list`, {
            method: "POST",
            headers,
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(5000),
          });
          if (introspectRes.ok) {
            const data = await introspectRes.json();
            available_tools = (data.tools ?? []).map((t: Record<string, string>) => ({
              tool_key: t.name,
              tool_name: t.title ?? t.name,
            }));
          }
        } catch (httpErr) {
          console.warn("[Manual MCP] HTTP fallback introspection failed:", httpErr);
        }
      }
    }

    if (existing) {
      // Update existing record with the fetched tools
      const { data, error } = await supabase
        .from("mcp_connections")
        .update({
          available_tools,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select()
        .single();
      if (error) throw error;
      return NextResponse.json({ connection: data });
    } else {
      // Insert new record
      const { data, error } = await supabase
        .from("mcp_connections")
        .insert({
          connection_type: "manual",
          label,
          mcp_url,
          status: "active",
          available_tools,
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();
      if (error) throw error;
      return NextResponse.json({ connection: data });
    }
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

// DELETE /api/mcp/manual
export async function DELETE(req: Request) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    await supabase.from("mcp_connections").delete().eq("id", id);
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}
