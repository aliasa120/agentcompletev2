import { NextResponse } from 'next/server';
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// In Docker, the frontend cannot exec Python directly.
// Instead, call the feeder HTTP server running in the backend container.
const FEEDER_SERVER_URL = process.env.FEEDER_SERVER_URL || 'http://backend:8080';

export async function POST(req: Request) {
    try {
        // Get authenticated user to pass user_id for per-user key resolution
        const cookieStore = await cookies();
        const supabase = createServerClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                cookies: {
                    getAll() { return cookieStore.getAll(); },
                    setAll(cookiesToSet) {
                        try { cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); } catch {}
                    },
                },
            }
        );
        const { data: { user } } = await supabase.auth.getUser();

        let body: Record<string, unknown> = {};
        try {
            body = await req.json();
        } catch (e) {
            // Ignore parse errors for empty/non-JSON bodies
        }

        // Inject user_id so the backend pipeline uses per-user API keys
        if (user?.id) {
            body.user_id = user.id;
        }

        const response = await fetch(`${FEEDER_SERVER_URL}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(310_000), // 5-min + buffer
        });

        const data = await response.json();

        if (!data.success) {
            return NextResponse.json(
                { success: false, error: data.error || 'Feeder pipeline failed' },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            message: 'Feeder pipeline ran successfully.',
            log: data.log,
        });
    } catch (error: any) {
        console.error('Feeder Pipeline execution failed:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
