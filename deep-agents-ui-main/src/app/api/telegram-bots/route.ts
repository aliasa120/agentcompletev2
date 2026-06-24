import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

function getSupabaseClient(cookieStore: any) {
  return createServerClient(
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
}

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 1. Fetch bots from database
    let { data: bots, error } = await supabase
      .from("telegram_bots")
      .select("id, bot_token, is_active, created_at")
      .eq("user_id", user.id);

    if (error) {
      console.error("Error fetching telegram bots:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 2. Auto-seed if empty and TELEGRAM_BOT_TOKEN is set in environment
    const envToken = process.env.TELEGRAM_BOT_TOKEN || "";
    if ((!bots || bots.length === 0) && envToken && !envToken.toLowerCase().includes("your_")) {
      console.log("[api] No bots found in db, but TELEGRAM_BOT_TOKEN is set in .env. Auto-seeding...");

      const { data: inserted, error: insertError } = await supabase
        .from("telegram_bots")
        .insert({
          user_id: user.id,
          bot_token: envToken,
          is_active: true
        })
        .select("id, bot_token, is_active, created_at")
        .single();

      if (insertError) {
        console.error("Failed to auto-seed telegram bot from .env:", insertError);
      } else if (inserted) {
        bots = [inserted];
      }
    }

    return NextResponse.json({ bots: bots || [] });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id, bot_token, is_active } = await request.json();

    if (!bot_token) {
      return NextResponse.json({ error: "bot_token is required" }, { status: 400 });
    }

    if (id) {
      // Update existing bot
      const { data, error } = await supabase
        .from("telegram_bots")
        .update({
          bot_token,
          is_active: is_active ?? true,
          updated_at: new Date().toISOString()
        })
        .eq("id", id)
        .eq("user_id", user.id)
        .select();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      return NextResponse.json({ success: true, bot: data[0] });
    } else {
      // Create new bot
      const { data, error } = await supabase
        .from("telegram_bots")
        .insert({
          user_id: user.id,
          bot_token,
          is_active: is_active ?? true
        })
        .select();

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      return NextResponse.json({ success: true, bot: data[0] });
    }
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = request.nextUrl;
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const { error } = await supabase
      .from("telegram_bots")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
