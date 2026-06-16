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
export async function GET() {
  try {
    const { data } = await supabase
      .from("mcp_connections")
      .select("*")
      .eq("connection_type", "manual")
      .order("created_at", { ascending: false });
    return NextResponse.json({ connections: data ?? [] });
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
    let available_tools: { tool_key: string; tool_name: string }[] = [];
    if (manual_tools && Array.isArray(manual_tools)) {
      available_tools = manual_tools;
    } else {
      const secret = process.env.ZAPIER_MCP_SECRET;
      // 1. Try Streamable HTTP handshake first for Zapier URLs, else fallback to SSE
      if (mcp_url.startsWith("https://mcp.zapier.com/")) {
        try {
          available_tools = await fetchMcpStreamableHttpTools(mcp_url, secret);
        } catch (streamableErr) {
          console.warn("[Manual MCP] Streamable HTTP introspection failed, falling back to SSE:", streamableErr instanceof Error ? streamableErr.message : streamableErr);
          try {
            available_tools = await fetchMcpSseTools(mcp_url, secret);
          } catch (sseErr) {
            console.warn("[Manual MCP] SSE fallback introspection failed:", sseErr instanceof Error ? sseErr.message : sseErr);
          }
        }
      }

      // 2. Fall back to standard HTTP POST /tools/list if SSE failed or is not a Zapier URL
      if (available_tools.length === 0) {
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (mcp_url.startsWith("https://mcp.zapier.com/") && secret) {
            headers["Authorization"] = `Bearer ${secret}`;
          }
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
