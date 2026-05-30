"use client";
import { useEffect } from "react";

// Heartbeat: pings /api/cron every 60 seconds, regardless of which page the user is on.
// This is the ONLY place the auto-trigger logic runs — keeping it server-side and page-navigation-proof.
export function CronHeartbeat() {
    useEffect(() => {
        // Fire once immediately on mount, then every 60s
        const ping = () => {
            fetch("/api/cron").catch(() => { }); // silent on error
        };
        ping();
        const id = setInterval(ping, 60_000);
        return () => clearInterval(id);
    }, []);
    return null;
}
