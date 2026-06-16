import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY ?? "";
const COMPOSIO_BASE = "https://backend.composio.dev/api/v3";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// Helper: check if a connection status string means "active"
function isActiveStatus(status: string): boolean {
  const s = (status ?? "").toUpperCase();
  return s === "ACTIVE" || s === "ENABLED" || s === "CONNECTED" || s === "COMPLETED";
}

// Helper: fetch available tools for a toolkit slug from Composio
async function fetchToolsForSlug(slug: string): Promise<{ tool_key: string; tool_name: string }[]> {
  if (!slug) return [];
  try {
    const toolsRes = await fetch(
      `${COMPOSIO_BASE}/tools?toolkit_slug=${encodeURIComponent(slug)}&limit=100`,
      {
        headers: { "x-api-key": COMPOSIO_API_KEY },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!toolsRes.ok) return [];
    const toolsData = await toolsRes.json();
    const items = toolsData.items ?? toolsData.tools ?? [];
    return items.map((t: Record<string, string>) => ({
      tool_key: t.slug ?? t.key ?? t.name,
      tool_name: t.name ?? t.display_name ?? t.slug,
    }));
  } catch {
    return [];
  }
}

// GET /api/mcp/composio/connections — List active connections
export async function GET(req: Request) {
  try {
    // 1. Load cached connections from Supabase first
    const { data: cached } = await supabase
      .from("mcp_connections")
      .select("*")
      .eq("connection_type", "composio")
      .order("created_at", { ascending: false });

    const { searchParams } = new URL(req.url);
    const shouldSync = searchParams.get("sync") === "true";

    // 2. Sync from Composio API if requested and key is set
    if (shouldSync && COMPOSIO_API_KEY) {
      try {
        const res = await fetch(
          `${COMPOSIO_BASE}/connected_accounts?page=1&limit=100`,
          {
            headers: { "x-api-key": COMPOSIO_API_KEY },
            signal: AbortSignal.timeout(10000),
          }
        );
        if (res.ok) {
          const remote = await res.json();
          const accounts = remote.items ?? remote.connectedAccounts ?? [];

          // Map accounts and fetch tools in parallel where needed
          const upsertPromises = accounts.map(async (acc: any) => {
            const toolkitSlug =
              acc.toolkit?.slug ??
              acc.appName ??
              acc.app_name ??
              acc.integration?.appName ??
              "";

            const label =
              acc.alias ??
              acc.toolkit?.name ??
              acc.toolkit?.slug ??
              acc.appName ??
              "Unknown";

            const rawStatus = acc.status ?? acc.connectionStatus ?? "";
            const active = isActiveStatus(rawStatus);

            let toolsList: { tool_key: string; tool_name: string }[] = [];
            if (active && toolkitSlug) {
              const existing = cached?.find((c) => c.composio_conn_id === acc.id);
              toolsList = existing?.available_tools ?? [];
              if (!toolsList || toolsList.length === 0) {
                toolsList = await fetchToolsForSlug(toolkitSlug);
              }
            }

            return {
              connection_type: "composio",
              toolkit_slug: toolkitSlug,
              label,
              composio_conn_id: acc.id,
              status: active ? "active" : "disconnected",
              available_tools: toolsList,
              updated_at: new Date().toISOString(),
            };
          });

          const upsertData = await Promise.all(upsertPromises);

          if (upsertData.length > 0) {
            // Perform bulk upsert in a single database call
            await supabase.from("mcp_connections").upsert(upsertData, {
              onConflict: "composio_conn_id",
            });
          }

          // Clean up connections deleted on Composio
          const remoteIds = new Set(accounts.map((a: any) => a.id));
          const toDelete = (cached ?? [])
            .filter((c) => c.composio_conn_id && !remoteIds.has(c.composio_conn_id))
            .map((c) => c.id);

          if (toDelete.length > 0) {
            await supabase.from("mcp_connections").delete().in("id", toDelete);
          }
        }
      } catch (syncErr) {
        console.error("[Composio sync error]", syncErr);
      }

      // Re-fetch from Supabase after sync
      const { data: synced } = await supabase
        .from("mcp_connections")
        .select("*")
        .eq("connection_type", "composio")
        .order("created_at", { ascending: false });

      return NextResponse.json({ connections: synced ?? [] });
    }

    return NextResponse.json({ connections: cached ?? [] });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error", connections: [] },
      { status: 200 }
    );
  }
}

// POST /api/mcp/composio/connections — Initiate OAuth connection for a toolkit
export async function POST(req: Request) {
  if (!COMPOSIO_API_KEY) {
    return NextResponse.json(
      { error: "COMPOSIO_API_KEY not configured. Add it to your .env file." },
      { status: 400 }
    );
  }

  try {
    const { toolkit_slug, redirect_url } = await req.json();
    if (!toolkit_slug) {
      return NextResponse.json({ error: "toolkit_slug is required" }, { status: 400 });
    }

    // Identify auth requirements first to handle no-auth toolkits instantly
    const tkRes = await fetch(`${COMPOSIO_BASE}/toolkits/${encodeURIComponent(toolkit_slug)}`, {
      headers: { "x-api-key": COMPOSIO_API_KEY }
    });
    
    if (tkRes.ok) {
      const tkData = await tkRes.json();
      const details = tkData.auth_config_details ?? [];
      if (details.length > 0 && details[0].mode === "NO_AUTH") {
        const toolsList = await fetchToolsForSlug(toolkit_slug);
        const label = tkData.name ?? tkData.slug ?? toolkit_slug;
        const connId = `no_auth_${toolkit_slug}`;

        await supabase.from("mcp_connections").upsert(
          {
            connection_type: "composio",
            toolkit_slug,
            label,
            composio_conn_id: connId,
            status: "active",
            available_tools: toolsList,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "composio_conn_id" }
        );

        return NextResponse.json({ success: true, instant: true });
      }
    }

    // 1. Check if auth config exists for this toolkit slug
    const listRes = await fetch(
      `${COMPOSIO_BASE}/auth_configs?toolkit_slug=${encodeURIComponent(toolkit_slug)}&show_disabled=false`,
      { headers: { "x-api-key": COMPOSIO_API_KEY } }
    );
    let auth_config_id = "";
    if (listRes.ok) {
      const listData = await listRes.json();
      const items: Record<string, string>[] = listData.items ?? [];
      if (items.length > 0) {
        // Prefer composio-managed, then pick the most recent
        const managed = items.filter((a) => a.is_composio_managed);
        const preferred = managed.length > 0 ? managed : items;
        preferred.sort(
          (a, b) =>
            new Date(b.created_at ?? b.last_updated_at ?? 0).getTime() -
            new Date(a.created_at ?? a.last_updated_at ?? 0).getTime()
        );
        auth_config_id = preferred[0].id;
      }
    }

    // 2. If not found, create a managed auth config
    if (!auth_config_id) {
      const createRes = await fetch(`${COMPOSIO_BASE}/auth_configs`, {
        method: "POST",
        headers: {
          "x-api-key": COMPOSIO_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          toolkit: { slug: toolkit_slug },
          auth_config: {
            type: "use_composio_managed_auth",
            tool_access_config: {
              tools_for_connected_account_creation: [],
            },
          },
        }),
      });
      if (createRes.ok) {
        const createData = await createRes.json();
        auth_config_id = createData.auth_config?.id ?? createData.id ?? "";
      } else {
        // Managed auth failed (likely because it requires custom credentials/API key)
        // Fall back to creating a custom auth config
        try {
          const tkRes = await fetch(`${COMPOSIO_BASE}/toolkits/${encodeURIComponent(toolkit_slug)}`, {
            headers: { "x-api-key": COMPOSIO_API_KEY }
          });
          let authScheme = "API_KEY";
          if (tkRes.ok) {
            const tkData = await tkRes.json();
            const details = tkData.auth_config_details ?? [];
            if (details.length > 0) {
              // Find the first scheme that has no required fields for auth_config_creation (e.g. API_KEY, BASIC)
              const simpleScheme = details.find(
                (d: any) =>
                  !d.fields?.auth_config_creation?.required ||
                  d.fields.auth_config_creation.required.length === 0
              );
              if (simpleScheme) {
                authScheme = simpleScheme.mode || "API_KEY";
              } else {
                authScheme = details[0].mode || "API_KEY";
              }
            }
          }

          const customCreateRes = await fetch(`${COMPOSIO_BASE}/auth_configs`, {
            method: "POST",
            headers: {
              "x-api-key": COMPOSIO_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              toolkit: { slug: toolkit_slug },
              auth_config: {
                name: `${toolkit_slug} Custom Auth Config`,
                type: "use_custom_auth",
                authScheme: authScheme,
              },
            }),
          });

          if (customCreateRes.ok) {
            const customCreateData = await customCreateRes.json();
            auth_config_id = customCreateData.auth_config?.id ?? customCreateData.id ?? "";
          } else {
            const errText = await customCreateRes.text();
            let parsedMsg = "";
            try {
              const parsed = JSON.parse(errText);
              parsedMsg = parsed.error?.message || parsed.message || "";
            } catch { /* ignore */ }
            
            const errorMsg = parsedMsg
              ? `Auth configuration failed: ${parsedMsg}. If this integration requires custom developer credentials (like Client ID/Secret) or a custom base URL, please create the Auth Config on your Composio dashboard first, then click Connect here.`
              : `Could not create auth configuration for this integration. Please configure its Auth Config on your Composio dashboard first.`;

            return NextResponse.json(
              {
                error: errorMsg,
                details: errText,
              },
              { status: 400 }
            );
          }
        } catch (fallbackErr: any) {
          return NextResponse.json(
            {
              error: `Failed to configure auth for ${toolkit_slug}: ${fallbackErr.message || fallbackErr}`,
            },
            { status: 400 }
          );
        }
      }
    }

    if (!auth_config_id) {
      return NextResponse.json(
        { error: "Could not find or create an auth config for this toolkit." },
        { status: 400 }
      );
    }

    // 3. Initiate link session via connected_accounts/link
    const callbackUrl =
      redirect_url ??
      `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/mcp/composio/callback`;

    const res = await fetch(`${COMPOSIO_BASE}/connected_accounts/link`, {
      method: "POST",
      headers: {
        "x-api-key": COMPOSIO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: "default",
        auth_config_id,
        callbackUrl,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Composio connect failed: ${res.status} — ${text}` },
        { status: 400 }
      );
    }

    const data = await res.json();
    const connect_url =
      data.redirectUrl ??
      data.redirect_url ??
      data.connectionRequest?.redirectUrl ??
      data.url;

    if (!connect_url) {
      return NextResponse.json(
        { error: "Composio did not return a connect URL. The integration may require manual API key setup." },
        { status: 400 }
      );
    }

    return NextResponse.json({
      connect_url,
      connection_id: data.id ?? data.connectionRequest?.id,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// DELETE /api/mcp/composio/connections — disconnect
export async function DELETE(req: Request) {
  try {
    const { connection_id } = await req.json();
    if (!connection_id) {
      return NextResponse.json({ error: "connection_id required" }, { status: 400 });
    }

    // Delete from Supabase
    await supabase
      .from("mcp_connections")
      .delete()
      .eq("composio_conn_id", connection_id);

    // Delete connection from Composio if key set
    if (COMPOSIO_API_KEY) {
      try {
        await fetch(`${COMPOSIO_BASE}/connected_accounts/${connection_id}`, {
          method: "DELETE",
          headers: { "x-api-key": COMPOSIO_API_KEY },
        });
      } catch {
        // Ignore errors — local delete already done
      }
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
