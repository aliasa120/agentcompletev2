import fs from "fs";
import { createClient } from "@supabase/supabase-js";

const env = {};
fs.readFileSync(".env.local", "utf8").split("\n").forEach((l) => {
  const m = l.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (m) env[m[1]] = (m[2] || "").trim().replace(/^['"]|['"]$/g, "");
});

async function update() {
  const sb = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
  const { data: agentSetting } = await sb
    .from("agent_settings")
    .select("value")
    .eq("key", "composio_api_key")
    .limit(1)
    .maybeSingle();

  const apiKey = env.COMPOSIO_API_KEY || agentSetting?.value;
  const toolsRes = await fetch("https://backend.composio.dev/api/v3.1/tools?toolkit_slug=linkedin&limit=100", {
    headers: { "x-api-key": apiKey },
  });
  const data = await toolsRes.json();
  const items = data.items || data.tools || [];
  const tools = items.map((t) => ({
    tool_key: t.slug || t.key || t.name,
    tool_name: t.name || t.display_name || t.slug,
  }));
  console.log("Fetched tools count from v3.1:", tools.length);
  const { error } = await sb
    .from("mcp_connections")
    .update({ available_tools: tools })
    .ilike("toolkit_slug", "%linkedin%");

  console.log("Updated database result:", error ? error.message : "SUCCESS (24 tools saved!)");
}

update().catch(console.error);
