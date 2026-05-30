import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Read-only status reporter.
// Actual triggering is done by cron_scheduler.py (dedicated Python process).
// This endpoint is called every 60s by CronHeartbeat and returns current
// schedule status so the UI can display countdown info.

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function elapsed(isoStr: string | null | undefined): number {
    if (!isoStr) return Infinity;
    return (Date.now() - new Date(isoStr).getTime()) / 1000;
}

export async function GET() {
    const now = new Date().toISOString();
    const status: Record<string, unknown> = { checked_at: now };

    try {
        // ── Feeder status ──────────────────────────────────────────────────
        const { data: fRows } = await supabase
            .from("feeder_settings")
            .select("key,value")
            .in("key", ["feeder_auto_trigger_enabled", "feeder_auto_trigger_interval_minutes", "feeder_last_trigger_at"]);

        const fm: Record<string, string> = {};
        for (const r of fRows ?? []) fm[r.key] = r.value ?? "";

        const fEnabled = fm.feeder_auto_trigger_enabled === "true";
        const fInterval = parseFloat(fm.feeder_auto_trigger_interval_minutes || "30");
        const fElapsed = elapsed(fm.feeder_last_trigger_at) / 60; // minutes
        const fNextIn = Math.max(0, fInterval - fElapsed);
        status.feeder = fEnabled
            ? { enabled: true, interval_min: fInterval, elapsed_min: Math.round(fElapsed), next_in_min: Math.round(fNextIn) }
            : { enabled: false };

        // ── Agent status ───────────────────────────────────────────────────
        const { data: aRows } = await supabase
            .from("agent_settings")
            .select("key,value")
            .in("key", ["auto_trigger_enabled", "auto_trigger_interval_minutes", "auto_trigger_last_at"]);

        const am: Record<string, string> = {};
        for (const r of aRows ?? []) am[r.key] = r.value ?? "";

        const aEnabled = am.auto_trigger_enabled === "true";
        const aInterval = parseFloat(am.auto_trigger_interval_minutes || "30");
        const aElapsed = elapsed(am.auto_trigger_last_at) / 60;
        const aNextIn = Math.max(0, aInterval - aElapsed);
        status.agent = aEnabled
            ? { enabled: true, interval_min: aInterval, elapsed_min: Math.round(aElapsed), next_in_min: Math.round(aNextIn) }
            : { enabled: false };

    } catch (e: any) {
        status.error = e.message;
    }

    return NextResponse.json({ ok: true, ...status });
}
