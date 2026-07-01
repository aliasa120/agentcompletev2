import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { testStdioMcp, testSseMcp, testHttpMcp } from "./test/route";

export async function resolveNpmPackage(qualifiedName: string): Promise<string> {
  const lowercaseQualifiedName = qualifiedName.toLowerCase();
  const mappings: Record<string, string> = {
    "tavily": "tavily-mcp",
    "outlook": "outlook-mcp",
    "jina": "jina-mcp-tools",
    "linkupplatform/linkup-mcp-server": "linkup-mcp-server",
    "node2flow/wordpress": "@node2flow/wordpress-mcp",
    "node2flow/gmail": "@node2flow/gmail-mcp",
    "youtube": "@modelcontextprotocol/server-youtube",
    "brave": "@modelcontextprotocol/server-brave",
    "slack": "@modelcontextprotocol/server-slack",
    "googledocs": "@modelcontextprotocol/server-google-docs",
    "gmail": "@modelcontextprotocol/server-gmail",
    "exa": "exa-mcp-server",
    "postgres": "@modelcontextprotocol/server-postgres",
    "sqlite": "@modelcontextprotocol/server-sqlite",
    "github": "@modelcontextprotocol/server-github",
    "gcal": "@modelcontextprotocol/server-gcal",
    "parallel/search": "@parallel-web/mcp-server"
  };

  if (mappings[lowercaseQualifiedName]) {
    return mappings[lowercaseQualifiedName];
  }

  try {
    const parts = qualifiedName.split("/");
    const shortName = parts[parts.length - 1].toLowerCase();
    
    // First check if <shortName>-mcp exists directly on npm
    try {
      const directRes = await fetch(`https://registry.npmjs.org/${shortName}-mcp`, {
        method: "HEAD",
        signal: AbortSignal.timeout(3000)
      });
      if (directRes.ok) {
        return `${shortName}-mcp`;
      }
    } catch (_) {}

    // Search NPM preferring MCP packages
    const res = await fetch(`https://registry.npmjs.org/-/v1/search?text=${shortName}+mcp&size=8`, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.objects && data.objects.length > 0) {
        // Look for package that contains the shortName AND (-mcp or mcp- or /mcp) in its name
        for (const obj of data.objects) {
          const pkgName = obj.package.name.toLowerCase();
          const cleanPkgName = pkgName.replace(/^@/, "").split("/").pop() || "";
          
          if (cleanPkgName.includes(shortName)) {
            if (pkgName.includes("-mcp") || pkgName.includes("mcp-") || pkgName.includes("/mcp")) {
              return obj.package.name;
            }
          }
        }
        
        // Fallback to first result ONLY if it contains the shortName to prevent false positives
        const firstPkgName = data.objects[0].package.name.toLowerCase();
        const cleanFirstPkgName = firstPkgName.replace(/^@/, "").split("/").pop() || "";
        if (cleanFirstPkgName.includes(shortName)) {
          return data.objects[0].package.name;
        }
      }
    }
  } catch (e) {
    console.warn("[Smithery Resolve] NPM search failed, falling back to name:", e);
  }

  return qualifiedName.split("/").pop() || qualifiedName;
}

export function mapCommonEnvVariables(env: Record<string, string>, packageName: string): Record<string, string> {
  const mapped = { ...env };
  
  const apiKeyValue = mapped.apiKey || mapped.apikey || mapped.api_key || mapped.API_KEY;
  if (apiKeyValue) {
    const cleanPkgName = packageName.replace(/^@/, "").split("/").pop() || "";
    const baseName = cleanPkgName.replace(/-mcp-server$/, "").replace(/-mcp$/, "").replace(/-server$/, "");
    const envKey = `${baseName.replace(/-/g, "_").toUpperCase()}_API_KEY`;
    
    if (!mapped[envKey]) {
      mapped[envKey] = apiKeyValue;
    }
  }

  return mapped;
}

function parseAndNormalizeMcpConfig(mcpUrlStr: string): {
  transport: "stdio" | "sse" | "http";
  url: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
} | null {
  const trimmed = mcpUrlStr.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    let parsed = JSON.parse(trimmed);
    let result: {
      transport: "stdio" | "sse" | "http";
      url: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      headers?: Record<string, string>;
    } | null = null;
    
    // Check if it's Claude Desktop format: {"mcpServers": {"serverName": {...}}}
    if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
      const serverNames = Object.keys(parsed.mcpServers);
      if (serverNames.length > 0) {
        const serverName = serverNames[0];
        const serverConfig = parsed.mcpServers[serverName];
        result = {
          transport: "stdio",
          url: "",
          command: serverConfig.command || "",
          args: serverConfig.args || [],
          env: serverConfig.env || {},
          headers: {}
        };
      }
    }

    // Check for direct server-name-as-key format: {"supadata": {"command": "npx", ...}}
    if (!result) {
      const metadataKeys = new Set(["description", "mcp_version", "transport", "url", "headers"]);
      let firstVal: any = null;
      for (const key of Object.keys(parsed)) {
        if (!metadataKeys.has(key) && typeof parsed[key] === "object" && parsed[key] !== null) {
          if (parsed[key].command || parsed[key].url) {
            firstVal = parsed[key];
            break;
          }
        }
      }
      if (firstVal) {
        const transport = firstVal.url ? (firstVal.transport === "sse" || parsed.transport === "sse" ? "sse" : "http") : "stdio";
        result = {
          transport,
          url: firstVal.url || "",
          command: firstVal.command || "",
          args: firstVal.args || [],
          env: firstVal.env || {},
          headers: firstVal.headers || {}
        };
      }
    }

    // Standard flat transport config: {"transport": "stdio", "command": "npx", ...}
    if (!result) {
      const transport = parsed.transport || "sse";
      result = {
        transport: transport === "streamable-http" ? "http" : transport,
        url: parsed.url || parsed.mcp_url || "",
        command: parsed.command || "",
        args: parsed.args || [],
        env: parsed.env || {},
        headers: parsed.headers || {}
      };
    }

    // Translate Windows-specific shell wrappers (cmd /c) to direct commands on non-Windows platforms
    if (result && result.transport === "stdio" && process.platform !== "win32") {
      if (result.command === "cmd" && result.args?.[0] === "/c") {
        if (result.args.length > 1) {
          result.command = result.args[1];
          result.args = result.args.slice(2);
        }
      }
    }

    return result;

  } catch (err) {
    console.warn("Failed to parse mcp_url as JSON config:", err);
    return null;
  }
}

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
async function fetchMcpSseTools(mcpUrl: string, secret?: string): Promise<{ tool_key: string; tool_name: string; description?: string }[]> {
  let targetUrl = mcpUrl;
  const headers: Record<string, string> = { 
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json" 
  };

  if (secret) {
    headers["Authorization"] = `Bearer ${secret}`;
  }

  if (mcpUrl.trim().startsWith("{")) {
      try {
        const config = JSON.parse(mcpUrl);
        targetUrl = config.url || targetUrl;
        if (config.headers && typeof config.headers === "object") {
          Object.assign(headers, config.headers);
        }
      } catch (je) {
        console.warn("Failed to parse mcpUrl as JSON in fetchMcpSseTools:", je);
      }
    }

    // Ensure Accept includes application/json and text/event-stream
    if (!headers["Accept"]?.includes("application/json")) {
      headers["Accept"] = "application/json, text/event-stream";
    }

    // 1. Try stateless direct POST first (very fast, works for stateless servers like Smithery Remote)
    try {
      const postRes = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
          id: 1
        }),
        signal: AbortSignal.timeout(8000)
      });

      if (postRes.ok) {
        const text = await postRes.text();

        // Try 1: direct JSON response
        try {
          const data = JSON.parse(text);
          if (data?.result?.tools) {
            return data.result.tools.map((t: any) => ({
              tool_key: t.name,
              tool_name: t.title || t.name,
              description: t.description || ""
            }));
          }
        } catch { /* fall through to SSE parse */ }

        // Try 2: SSE-encoded response (Smithery returns SSE even for stateless POST)
        for (const line of text.split("\n")) {
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const parsed = JSON.parse(payload);
              if (parsed?.result?.tools) {
                return parsed.result.tools.map((t: any) => ({
                  tool_key: t.name,
                  tool_name: t.title || t.name,
                  description: t.description || ""
                }));
              }
            } catch { /* continue */ }
          }
        }
      }
    } catch (postErr) {
      console.warn("[fetchMcpSseTools] Direct POST fallback trigger:", postErr);
    }

    // 2. Fallback to standard SSE GET streaming (stateful mode)
    return new Promise(async (resolve, reject) => {
      let sseResponse: Response;
      const getHeaders = { ...headers, "Accept": "text/event-stream" };
      try {
        sseResponse = await fetch(targetUrl, { headers: getHeaders });

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
              const origin = new URL(targetUrl).origin;
              endpointUrl = `${origin}${currentData}`;
            } else {
              endpointUrl = currentData;
            }

            // Send the tools/list request via POST
            const postHeaders: Record<string, string> = { 
              "Content-Type": "application/json",
              ...headers // Keep all connection headers (including Smithery Bearer tokens)
            };
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
      // Sync all active manual HTTP connections (SSE, streamable-http, Smithery Remote, Tavily, YouTube, etc.)
      for (const conn of connections) {
        if (conn.status === "active" && !conn.mcp_url?.startsWith("https://mcp.zapier.com/")) {
          try {
            // Resolve URL and headers from config or raw URL
            let urlToSync = "";
            let headersToSync: Record<string, string> = {};
            
            if (conn.mcp_url?.trim().startsWith("{")) {
              const config = parseAndNormalizeMcpConfig(conn.mcp_url);
              if (config && config.transport === "stdio") {
                // Auto-heal/rewrite mcp-remote connection
                const isMcpRemote = config.args?.some((arg: string) => arg.includes("mcp-remote"));
                const isNpxY = config.command === "npx" && config.args?.includes("-y");
                
                if ((isMcpRemote || isNpxY) && (conn.toolkit_slug || config.args)) {
                  try {
                    let npmPackageName = "";
                    if (conn.toolkit_slug) {
                      npmPackageName = await resolveNpmPackage(conn.toolkit_slug);
                    } else if (config.args) {
                      const yIdx = config.args.indexOf("-y");
                      if (yIdx !== -1 && yIdx + 1 < config.args.length) {
                        npmPackageName = config.args[yIdx + 1];
                      }
                    }

                    if (npmPackageName) {
                      const baseEnv = config.env || {};
                      const env = mapCommonEnvVariables(baseEnv, npmPackageName);
                      
                      // Ensure the package is installed locally in the project's node_modules
                      const fs = await import("fs/promises");
                      const path = await import("path");
                      const localPkgPath = path.join(process.cwd(), "node_modules", npmPackageName);
                      
                      try {
                        await fs.access(localPkgPath);
                      } catch {
                        console.log(`[Manual MCP Sync] Package ${npmPackageName} not found in node_modules, installing on the fly...`);
                        const { exec } = await import("child_process");
                        const { promisify } = await import("util");
                        const execAsync = promisify(exec);
                        await execAsync(`npm install --no-save --legacy-peer-deps ${npmPackageName}`, {
                          timeout: 300000,
                          env: process.env,
                        });
                      }

                      // Read bin path from package.json (or fallback to main/exports)
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
                        console.warn(`[Manual MCP Sync] Failed to read package.json for ${npmPackageName}:`, pjErr);
                      }

                      let healedConfig;
                      if (binPath) {
                        healedConfig = {
                          transport: "stdio",
                          command: "node",
                          args: [path.join("node_modules", npmPackageName, binPath)],
                          env
                        };
                      } else {
                        healedConfig = {
                          transport: "stdio",
                          command: "npx",
                          args: ["-y", npmPackageName],
                          env
                        };
                      }
                      
                      // Save healed config back to DB
                      await supabase
                        .from("mcp_connections")
                        .update({ mcp_url: JSON.stringify(healedConfig), updated_at: new Date().toISOString() })
                        .eq("id", conn.id);
                        
                      console.log(`[Manual MCP Sync] Auto-healed connection ${conn.label} to local node package: ${npmPackageName}`);
                      config.command = healedConfig.command;
                      config.args = healedConfig.args;
                      config.env = env;
                    }
                  } catch (healErr) {
                    console.warn(`[Manual MCP Sync] Failed to auto-heal ${conn.label}:`, healErr);
                  }
                }

                // Execute the stdio child process to retrieve available tools
                try {
                  const testRes = await testStdioMcp(config.command || "", config.args || [], config.env || {});
                  const tools = (testRes.tools || []).map((t: any) => ({
                    tool_key: t.name,
                    tool_name: t.title || t.name,
                    description: t.description || ""
                  }));
                  if (tools.length > 0) {
                    await supabase
                      .from("mcp_connections")
                      .update({ 
                        available_tools: tools,
                        updated_at: new Date().toISOString()
                      })
                      .eq("id", conn.id);
                  }
                } catch (stdioErr) {
                  console.warn(`[Manual MCP Sync] Stdio sync failed for ${conn.label}:`, stdioErr);
                }
                continue;
              }
              urlToSync = config?.url || "";
              headersToSync = config?.headers || {};
            } else if (conn.mcp_url?.startsWith("http://") || conn.mcp_url?.startsWith("https://")) {
              urlToSync = conn.mcp_url;
            }
            
            if (!urlToSync) continue;
            
            const testRes = await testSseMcp(urlToSync, headersToSync);
            const tools = (testRes.tools || []).map((t: any) => ({
              tool_key: t.name,
              tool_name: t.title || t.name,
              description: t.description || ""
            }));
            if (tools.length > 0) {
              await supabase
                .from("mcp_connections")
                .update({ 
                  available_tools: tools,
                  updated_at: new Date().toISOString()
                })
                .eq("id", conn.id);
            }
          } catch (err) {
            console.warn(`[Manual MCP Sync] Failed to sync tools for manual connection ${conn.label}:`, err);
          }
        }
      }

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
            .update({ available_tools: appTools, status: "active", updated_at: new Date().toISOString() })
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

    // Use user-provided manual tools list if available, otherwise attempt Stdio/SSE/HTTP introspection
    let available_tools: any[] = [];
    if (manual_tools && Array.isArray(manual_tools)) {
      available_tools = manual_tools;
    } else {
      const config = parseAndNormalizeMcpConfig(mcp_url);
      if (config) {
        try {
          if (config.transport === "stdio") {
            const res = await testStdioMcp(config.command || "", config.args || [], config.env || {});
            available_tools = (res.tools || []).map((t: any) => ({
              tool_key: t.name,
              tool_name: t.title || t.name,
              description: t.description || ""
            }));
          } else if (config.transport === "sse") {
            const res = await testSseMcp(config.url, config.headers || {});
            available_tools = (res.tools || []).map((t: any) => ({
              tool_key: t.name,
              tool_name: t.title || t.name,
              description: t.description || ""
            }));
          } else if (config.transport === "http") {
            const res = await testHttpMcp(config.url, config.headers || {});
            available_tools = (res.tools || []).map((t: any) => ({
              tool_key: t.name,
              tool_name: t.title || t.name,
              description: t.description || ""
            }));
          }
        } catch (err: any) {
          console.warn(`[Manual MCP] Introspection of config failed: ${err.message}`);
        }
      } else {
        // Fallback for raw URL (default to SSE first, then HTTP)
        try {
          const res = await testSseMcp(mcp_url, {});
          available_tools = (res.tools || []).map((t: any) => ({
            tool_key: t.name,
            tool_name: t.title || t.name,
            description: t.description || ""
          }));
        } catch (sseErr) {
          console.warn("[Manual MCP] SSE fallback introspection failed:", sseErr instanceof Error ? sseErr.message : sseErr);
          try {
            const res = await testHttpMcp(mcp_url, {});
            available_tools = (res.tools || []).map((t: any) => ({
              tool_key: t.name,
              tool_name: t.title || t.name,
              description: t.description || ""
            }));
          } catch (httpErr) {
            console.warn("[Manual MCP] HTTP fallback introspection failed:", httpErr);
          }
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
  async function cleanupToolAssignments(conn: any) {
    if (conn && conn.available_tools && Array.isArray(conn.available_tools)) {
      const toolKeys = conn.available_tools.map((t: any) => t.tool_key).filter(Boolean);
      if (toolKeys.length > 0) {
        await supabase
          .from("agent_tool_assignments")
          .delete()
          .in("tool_key", toolKeys);
      }
    }
  }

  async function cleanupSmitheryInstall(conn: any) {
    if (conn && conn.mcp_url) {
      try {
        const parsed = JSON.parse(conn.mcp_url);
        if (parsed.smithery_qualified_name) {
          await supabase
            .from("smithery_server_installs")
            .delete()
            .eq("qualified_name", parsed.smithery_qualified_name);
        }
      } catch (_) {}
    }
  }

  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    // Fetch the connection first to determine its type and URL
    const { data: conn } = await supabase
      .from("mcp_connections")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (conn) {
      if (conn.mcp_url?.startsWith("https://mcp.zapier.com/")) {
        if (conn.mcp_url.endsWith("#Base")) {
          // Deleting entire Zapier integration -> delete the base and all associated apps
          const baseServerUrl = conn.mcp_url.split("#")[0];
          const { data: allConns } = await supabase
            .from("mcp_connections")
            .select("*")
            .eq("connection_type", "manual");
          
          for (const c of (allConns || [])) {
            if (c.mcp_url?.startsWith(baseServerUrl)) {
              await cleanupToolAssignments(c);
              await cleanupSmitheryInstall(c);
              await supabase.from("mcp_connections").delete().eq("id", c.id);
            }
          }
        } else {
          // Deleting a specific Zapier app connection -> set status to "inactive"
          // so that the background/manual sync loop respects the user's deletion
          // and does not re-insert the connection.
          await cleanupToolAssignments(conn);
          await supabase
            .from("mcp_connections")
            .update({ status: "inactive", updated_at: new Date().toISOString() })
            .eq("id", id);
        }
      } else {
        // Standard manual connection -> delete the row from DB
        await cleanupToolAssignments(conn);
        await cleanupSmitheryInstall(conn);
        await supabase.from("mcp_connections").delete().eq("id", id);
      }
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}
