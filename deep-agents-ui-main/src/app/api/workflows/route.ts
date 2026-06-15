import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { triggerAgentReload } from "@/lib/agent-reloader";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// GET /api/workflows — list all workflows
export async function GET() {
  try {
    const { data: workflows, error } = await supabase
      .from("workflows")
      .select("*")
      .order("created_at", { ascending: true });

    if (error) throw error;
    return NextResponse.json({ workflows: workflows ?? [] });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// POST /api/workflows — create a new workflow
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { name, description, interval_minutes, batch_size, enabled } = body;

    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("workflows")
      .insert({
        name,
        description: description ?? "",
        interval_minutes: interval_minutes ?? 30,
        batch_size: batch_size ?? 2,
        enabled: enabled ?? true,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[workflows] Failed to trigger agent reload:", reloadErr);
    }

    return NextResponse.json({ workflow: data });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
