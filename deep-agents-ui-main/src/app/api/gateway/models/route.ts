import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll(); },
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

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: settings } = await supabase
      .from("agent_settings")
      .select("key, value");

    const settingsMap = new Map((settings || []).map(s => [s.key, s.value]));

    const openRouterKey = settingsMap.get("openrouter_client_api_key")?.trim() || process.env.OPENROUTER_API_KEY || "";
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: openRouterKey ? { "Authorization": `Bearer ${openRouterKey}` } : {}
    });

    if (!res.ok) {
      const errMsg = await res.text();
      return NextResponse.json({ error: `OpenRouter returned error: ${errMsg}` }, { status: res.status });
    }

    const payload = await res.json();
    return NextResponse.json(payload);
  } catch (error: any) {
    console.error("Error fetching gateway models:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
