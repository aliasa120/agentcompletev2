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

// Mirrors research_agent/plugins.py semantics: enabled when any user enabled
// the plugin, else when no override exists and the catalog default is on.
async function isPluginEnabled(pluginKey: string): Promise<boolean> {
    try {
        const { data: pluginRow } = await supabase
            .from("plugins")
            .select("default_enabled")
            .eq("plugin_key", pluginKey)
            .maybeSingle();
        if (!pluginRow) return true;
        const { data: overrides } = await supabase
            .from("user_plugin_settings")
            .select("enabled")
            .eq("plugin_key", pluginKey);
        const rows = overrides ?? [];
        if (rows.some((r: { enabled: boolean }) => r.enabled)) return true;
        if (rows.length > 0) return false;
        return !!pluginRow.default_enabled;
    } catch {
        return true;
    }
}

export async function GET() {
    const now = new Date().toISOString();
    const status: Record<string, unknown> = { checked_at: now };

    try {
        // ── Feeder status (per-workflow schedules — matches cron_scheduler.py) ──
        const feederPluginEnabled = await isPluginEnabled("feeder");
        if (!feederPluginEnabled) {
            status.feeder = { enabled: false };
        } else {
            const { data: wfs } = await supabase
                .from("workflows")
                .select("id, name, feeder_interval_minutes, feeder_last_trigger_at")
                .eq("is_active", true)
                .eq("feeder_enabled", true);

            const schedules = (wfs ?? []).map((w) => {
                const interval = w.feeder_interval_minutes || 30;
                const elapsedMin = elapsed(w.feeder_last_trigger_at) / 60;
                return {
                    workflow_id: w.id,
                    workflow_name: w.name,
                    interval_min: interval,
                    elapsed_min: Math.round(elapsedMin),
                    next_in_min: Math.round(Math.max(0, interval - elapsedMin)),
                };
            });

            if (schedules.length === 0) {
                status.feeder = { enabled: false };
            } else {
                // Report the soonest upcoming run as the headline status
                const soonest = schedules.reduce((a, b) => (b.next_in_min < a.next_in_min ? b : a));
                status.feeder = {
                    enabled: true,
                    interval_min: soonest.interval_min,
                    elapsed_min: soonest.elapsed_min,
                    next_in_min: soonest.next_in_min,
                    schedules,
                };
            }
        }

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

        // ── YouTube Processing Sweeper ─────────────────────────────────────
        // Checks any YouTube videos in 'processing' status to promote to public once checks finish
        try {
            const { data: processingVideos } = await supabase
                .from("social_youtube_posts")
                .select("id, post_id, published_video_id, user_id, created_at")
                .eq("status", "processing")
                .not("published_video_id", "is", null)
                .limit(5);

            if (processingVideos && processingVideos.length > 0) {
                const { checkAndPromoteYoutubeProcessing } = await import("@/lib/youtube-publish");
                for (const row of processingVideos) {
                    if (row.published_video_id) {
                        await checkAndPromoteYoutubeProcessing(row.published_video_id, row.post_id, row.user_id);
                    }
                }
            }
        } catch (ytCronErr) {
            console.warn("[cron] YouTube sweeper error:", ytCronErr);
        }

    } catch (e: any) {
        status.error = e.message;
    }

    return NextResponse.json({ ok: true, ...status });
}
