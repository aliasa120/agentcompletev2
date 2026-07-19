import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

function getSupabaseClient(cookieStore: any) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {}
      }
    }
  );
}

export async function GET() {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  
  let rows: any[] = [];
  let user_id = "";
  if (user) {
    user_id = user.id;
    const { data } = await supabase
      .from("agent_settings")
      .select("key, value")
      .eq("user_id", user.id);
    rows = data || [];
  } else {
    // If not logged in, try with process.env keys if we can
    const anonClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    const { data } = await anonClient
      .from("agent_settings")
      .select("key, value, user_id");
    rows = data || [];
  }
  
  console.log("=== TEMP KEY DEBUG ===");
  console.log("User ID:", user_id);
  console.log("Rows:", JSON.stringify(rows.map(r => ({ ...r, value: r.value ? r.value.substring(0, 10) + "..." : null })), null, 2));
  console.log("=======================");

  return NextResponse.json({ success: true, user_id, rows });
}
