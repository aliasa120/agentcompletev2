import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import fs from "fs";

export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate user
    const cookieStore = await cookies();
    const supabase = createServerClient(
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

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2. Fetch the 9Router client API key from Supabase agent_settings
    const { data: settingsData } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("key", "ninerouter_client_api_key")
      .single();

    const clientApiKey = settingsData?.value?.trim() || process.env.NINE_ROUTER_API_KEY || "";

    // 3. Query local 9Router instance models endpoint
    const isDocker = fs.existsSync("/.dockerenv");
    const nineRouterBaseUrl = process.env.NEXT_PUBLIC_NINE_ROUTER_URL || (isDocker ? "http://ninerouter:20128" : "http://localhost:20128");
    
    const headers: Record<string, string> = {};
    if (clientApiKey) {
      headers["Authorization"] = `Bearer ${clientApiKey}`;
    }

    const res = await fetch(`${nineRouterBaseUrl}/v1/models`, {
      headers,
      next: { revalidate: 10 } // cache for 10 seconds to reduce load
    });

    if (!res.ok) {
      const errMsg = await res.text();
      return NextResponse.json({ error: `9Router returned error: ${errMsg}` }, { status: res.status });
    }

    const payload = await res.json();
    return NextResponse.json(payload);
  } catch (error: any) {
    console.error("Error fetching 9Router models:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
