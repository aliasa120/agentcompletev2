import { NextResponse } from "next/server";
import { spawn } from "child_process";

// 1. Stdio Tester Helper
export async function testStdioMcp(command: string, args: string[], env: Record<string, string>): Promise<{ tools: any[]; logs: any[] }> {
  return new Promise((resolve, reject) => {
    const logs: any[] = [];
    
    // Setup environment
    const processEnv: NodeJS.ProcessEnv = { ...process.env };
    // Inherit basic safe variables if not present
    const safeKeys = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"];
    for (const key of safeKeys) {
      if (process.env[key] && !processEnv[key]) {
        processEnv[key] = process.env[key]!;
      }
    }
    // Mix in custom variables
    Object.assign(processEnv, env);

    // Shebang-proofing: Remove .JS and .JSE from PATHEXT on Windows to avoid Windows Script Host hijacking
    if (process.platform === "win32" && processEnv.PATHEXT) {
      processEnv.PATHEXT = processEnv.PATHEXT.split(";")
        .filter(ext => {
          const upper = ext.trim().toUpperCase();
          return upper !== ".JS" && upper !== ".JSE";
        })
        .join(";");
    }

    logs.push({ direction: "info", message: `Spawning stdio child process: "${command}" with args: ${JSON.stringify(args)}` });
    
    const child: any = spawn(command, args, {
      env: processEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    let stdoutBuffer = "";
    let completed = false;

    const cleanup = () => {
      completed = true;
      try {
        child.kill();
      } catch (err) {}
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(Object.assign(
        new Error("Timeout waiting for Stdio response (60 seconds). Check command, args, and that the MCP server writes JSON to stdout."),
        { logs }
      ));
    }, 60000);

    child.on("error", (err: any) => {
      clearTimeout(timeout);
      cleanup();
      logs.push({ direction: "error", message: `Process spawn error: ${err.message}` });
      reject(err);
    });

    child.on("close", (code: number) => {
      if (completed) return;
      clearTimeout(timeout);
      cleanup();
      logs.push({ direction: "info", message: `Process exited with code ${code}` });
      const errMsgs = logs
        .filter(l => l.direction === "error")
        .map(l => l.message)
        .join("\n");
      const err = new Error(`Process exited with code ${code}.${errMsgs ? ` Stderr:\n${errMsgs}` : ""}`);
      Object.assign(err, { logs });
      reject(err);
    });

    child.stderr.on("data", (data: any) => {
      const msg = data.toString().trim();
      if (msg) {
        logs.push({ direction: "error", message: `stderr: ${msg}` });
      }
    });

    const sendJson = (obj: any) => {
      if (completed) return;
      const str = JSON.stringify(obj);
      logs.push({ direction: "send", message: str });
      child.stdin.write(str + "\n");
    };

    child.stdout.on("data", (chunk: any) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        logs.push({ direction: "receive", message: trimmed });
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.id === 1) {
            // Send initialized notification
            sendJson({
              jsonrpc: "2.0",
              method: "notifications/initialized",
            });
            // Send tools/list request
            sendJson({
              jsonrpc: "2.0",
              method: "tools/list",
              params: {},
              id: 2,
            });
          } else if (parsed.id === 2) {
            clearTimeout(timeout);
            cleanup();
            const tools = parsed.result?.tools || [];
            resolve({ tools, logs });
            break;
          }
        } catch (e: any) {
          logs.push({ direction: "error", message: `Failed to parse stdout line as JSON: ${e.message}` });
        }
      }
    });

    // Write initialize request
    sendJson({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "gateway-tester", version: "1.0.0" },
      },
      id: 1,
    });
  });
}

// 2. SSE Tester Helper
export async function testSseMcp(mcpUrl: string, customHeaders: Record<string, string>): Promise<{ tools: any[]; logs: any[] }> {
  const logs: any[] = [];
  const headers: Record<string, string> = { 
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...customHeaders 
  };

  logs.push({ direction: "info", message: `Initiating HTTP/SSE connection check to ${mcpUrl}` });

  // 1. Try stateless direct POST first (very fast, works for stateless servers like Smithery Remote)
  try {
    logs.push({ direction: "info", message: "Trying direct POST tools/list..." });
    const postRes = await fetch(mcpUrl, {
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
      
      // Try 1: direct JSON response (stateless HTTP mode)
      try {
        const data = JSON.parse(text);
        if (data?.result?.tools) {
          logs.push({ direction: "info", message: "Direct POST tools/list succeeded (JSON)!" });
          return { tools: data.result.tools, logs };
        }
      } catch { /* fall through to SSE parse */ }

      // Try 2: SSE-encoded response (Smithery Remote returns SSE even for stateless POST)
      // Format: "event: message\ndata: {"jsonrpc":"2.0","result":{"tools":[...]}, "id":1}"
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            const parsed = JSON.parse(payload);
            if (parsed?.result?.tools) {
              logs.push({ direction: "info", message: `Direct POST tools/list succeeded (SSE-encoded, ${parsed.result.tools.length} tools)!` });
              return { tools: parsed.result.tools, logs };
            }
          } catch { /* continue */ }
        }
      }

      logs.push({ direction: "info", message: "Direct POST returned OK but no tools found in response, falling back to SSE stream..." });
    } else {
      logs.push({ direction: "info", message: `Direct POST returned HTTP status ${postRes.status}, falling back to SSE...` });
    }
  } catch (postErr: any) {
    logs.push({ direction: "info", message: `Direct POST failed: ${postErr.message || String(postErr)}. Falling back to SSE...` });
  }

  // 2. Fallback to standard SSE GET streaming (stateful mode)
  return new Promise(async (resolve, reject) => {
    let sseResponse: Response;
    
    logs.push({ direction: "info", message: `Connecting to SSE endpoint: ${mcpUrl}` });
    
    try {
      const getHeaders = { ...headers, "Accept": "text/event-stream" };
      sseResponse = await fetch(mcpUrl, { headers: getHeaders });
      if (!sseResponse.ok) {
        return reject(Object.assign(new Error(`SSE stream connection failed with HTTP ${sseResponse.status}`), { logs }));
      }
    } catch (err: any) {
      return reject(Object.assign(err, { logs }));
    }

    const reader = sseResponse.body?.getReader();
    if (!reader) {
      return reject(new Error("Response body is not a streamable reader"));
    }

    let endpointUrl = "";
    let accumulatedText = "";
    const decoder = new TextDecoder();

    const timeout = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(new Error("Timeout waiting for SSE Server-Sent Events (12 seconds)"));
    }, 12000);

    const cleanup = () => {
      clearTimeout(timeout);
      reader.cancel().catch(() => {});
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        accumulatedText += decoder.decode(value, { stream: true });
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

          if (currentEvent === "endpoint" && currentData) {
            if (currentData.startsWith("/")) {
              const origin = new URL(mcpUrl).origin;
              endpointUrl = `${origin}${currentData}`;
            } else {
              endpointUrl = currentData;
            }

            logs.push({ direction: "info", message: `Found POST message endpoint: ${endpointUrl}` });

            // Post initialize
            const postHeaders = { "Content-Type": "application/json", ...customHeaders };
            const initPayload = {
              jsonrpc: "2.0",
              method: "initialize",
              params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "gateway-tester", version: "1.0.0" }
              },
              id: 1
            };
            logs.push({ direction: "send", message: JSON.stringify(initPayload) });

            fetch(endpointUrl, {
              method: "POST",
              headers: postHeaders,
              body: JSON.stringify(initPayload)
            }).catch(err => {
              logs.push({ direction: "error", message: `HTTP POST initialize request failed: ${err.message}` });
            });
          }

          if (currentEvent === "message" && currentData) {
            logs.push({ direction: "receive", message: currentData });
            try {
              const parsed = JSON.parse(currentData);
              if (parsed.id === 1) {
                // Initialize response received, send initialized notification & tools/list request
                const postHeaders = { "Content-Type": "application/json", ...customHeaders };
                
                const initializedPayload = { jsonrpc: "2.0", method: "notifications/initialized" };
                logs.push({ direction: "send", message: JSON.stringify(initializedPayload) });
                await fetch(endpointUrl, {
                  method: "POST",
                  headers: postHeaders,
                  body: JSON.stringify(initializedPayload)
                });

                const listPayload = { jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 };
                logs.push({ direction: "send", message: JSON.stringify(listPayload) });
                fetch(endpointUrl, {
                  method: "POST",
                  headers: postHeaders,
                  body: JSON.stringify(listPayload)
                }).catch(err => {
                  logs.push({ direction: "error", message: `HTTP POST tools/list request failed: ${err.message}` });
                });
              } else if (parsed.id === 2) {
                cleanup();
                const tools = parsed.result?.tools || [];
                return resolve({ tools, logs });
              }
            } catch (e: any) {
              logs.push({ direction: "error", message: `Failed to parse message event payload: ${e.message}` });
            }
          }
        }
      }
      cleanup();
      reject(new Error("SSE Connection closed without returning tools/list result"));
    } catch (err: any) {
      cleanup();
      reject(err);
    }
  });
}

// 3. HTTP Tester Helper (Direct POST)
export async function testHttpMcp(mcpUrl: string, customHeaders: Record<string, string>): Promise<{ tools: any[]; logs: any[] }> {
  const logs: any[] = [];
  const headers = { "Content-Type": "application/json", ...customHeaders };

  logs.push({ direction: "info", message: `Initiating direct HTTP connection to ${mcpUrl}` });

  // 1. Initialize
  const initPayload = {
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "gateway-tester", version: "1.0.0" }
    },
    id: 1
  };
  logs.push({ direction: "send", message: JSON.stringify(initPayload) });

  const initRes = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(initPayload),
    signal: AbortSignal.timeout(5000)
  });

  if (!initRes.ok) {
    throw new Error(`Initialize POST request failed with HTTP status: ${initRes.status}`);
  }

  const initText = await initRes.text();
  logs.push({ direction: "receive", message: initText });
  const initParsed = JSON.parse(initText);
  if (initParsed.error) {
    throw new Error(`JSON-RPC error: ${JSON.stringify(initParsed.error)}`);
  }

  // 2. Initialized Notification
  const initNotification = {
    jsonrpc: "2.0",
    method: "notifications/initialized"
  };
  logs.push({ direction: "send", message: JSON.stringify(initNotification) });
  await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(initNotification),
    signal: AbortSignal.timeout(5000)
  });

  // 3. List Tools
  const listPayload = {
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
    id: 2
  };
  logs.push({ direction: "send", message: JSON.stringify(listPayload) });

  const listRes = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(listPayload),
    signal: AbortSignal.timeout(5000)
  });

  if (!listRes.ok) {
    throw new Error(`Tools list POST request failed with HTTP status: ${listRes.status}`);
  }

  const listText = await listRes.text();
  logs.push({ direction: "receive", message: listText });
  const listParsed = JSON.parse(listText);
  if (listParsed.error) {
    throw new Error(`JSON-RPC error: ${JSON.stringify(listParsed.error)}`);
  }

  const tools = listParsed.result?.tools || [];
  return { tools, logs };
}

export async function POST(req: Request) {
  try {
    const { transport, mcp_url, command, args, env, headers } = await req.json();

    if (!transport) {
      return NextResponse.json({ error: "transport parameter required" }, { status: 400 });
    }

    let parsedHeaders: Record<string, string> = {};
    if (headers) {
      if (typeof headers === "object") {
        parsedHeaders = headers;
      } else if (typeof headers === "string" && headers.trim().length > 0) {
        try {
          parsedHeaders = JSON.parse(headers);
        } catch (je: any) {
          return NextResponse.json({ error: `Invalid custom headers JSON: ${je.message}` }, { status: 400 });
        }
      }
    }

    if (transport === "stdio") {
      if (!command) {
        return NextResponse.json({ error: "command required for stdio process transport" }, { status: 400 });
      }

      // Parse arguments
      let parsedArgs: string[] = [];
      if (Array.isArray(args)) {
        parsedArgs = args;
      } else if (typeof args === "string" && args.trim().length > 0) {
        parsedArgs = args.split(/\s+/).map(a => a.trim()).filter(a => a.length > 0);
      }

      // Parse environment variables
      let parsedEnv: Record<string, string> = {};
      if (env) {
        if (typeof env === "object") {
          parsedEnv = env;
        } else if (typeof env === "string") {
          env.split("\n").forEach(line => {
            const idx = line.indexOf("=");
            if (idx !== -1) {
              const k = line.slice(0, idx).trim();
              const v = line.slice(idx + 1).trim();
              if (k) parsedEnv[k] = v;
            }
          });
        }
      }

      try {
        const result = await testStdioMcp(command, parsedArgs, parsedEnv);
        return NextResponse.json({ success: true, tools: result.tools, logs: result.logs });
      } catch (err: any) {
        // Pass through any logs captured before the timeout/error
        const errLogs = err.logs || [];
        return NextResponse.json({ success: false, error: err.message || "Stdio process test failed", logs: errLogs }, { status: 500 });
      }
    } 

    if (!mcp_url) {
      return NextResponse.json({ error: "mcp_url required for network transport" }, { status: 400 });
    }

    if (transport === "sse") {
      try {
        const result = await testSseMcp(mcp_url, parsedHeaders);
        return NextResponse.json({ success: true, tools: result.tools, logs: result.logs });
      } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message || "SSE connection failed" }, { status: 500 });
      }
    }

    if (transport === "http") {
      try {
        const result = await testHttpMcp(mcp_url, parsedHeaders);
        return NextResponse.json({ success: true, tools: result.tools, logs: result.logs });
      } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message || "Direct HTTP POST request failed" }, { status: 500 });
      }
    }

    return NextResponse.json({ error: `Unsupported transport: ${transport}` }, { status: 400 });

  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Internal server error" }, { status: 500 });
  }
}
