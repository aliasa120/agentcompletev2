import { NextResponse } from 'next/server';

// In Docker, the frontend cannot exec Python directly.
// Instead, call the feeder HTTP server running in the backend container.
// The backend service is named "backend" in docker-compose, so it's
// reachable at http://backend:8080 from within the Docker network.
// Locally (non-Docker), fall back to localhost:8080.
const FEEDER_SERVER_URL = process.env.FEEDER_SERVER_URL || 'http://backend:8080';

export async function POST() {
    try {
        const response = await fetch(`${FEEDER_SERVER_URL}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
