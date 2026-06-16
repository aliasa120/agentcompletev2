import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

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

    // Use user-provided manual tools list if available, otherwise attempt HTTP introspection
    let available_tools: { tool_key: string; tool_name: string }[] = [];
    if (manual_tools && Array.isArray(manual_tools)) {
      available_tools = manual_tools;
    } else {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (mcp_url.startsWith("https://mcp.zapier.com/")) {
          const secret = process.env.ZAPIER_MCP_SECRET;
          if (secret) {
            headers["Authorization"] = `Bearer ${secret}`;
          }
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
      } catch {
        // Introspection failed — save without tools list
      }
    }

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
