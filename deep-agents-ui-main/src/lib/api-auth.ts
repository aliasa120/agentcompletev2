/**
 * Shared API-route authentication helpers.
 *
 * `middleware.ts` deliberately exempts every `/api/*` path (routes "handle auth
 * themselves if needed"), so any route that touches user data must call these
 * helpers explicitly.
 *
 * Two accepted identities:
 *   1. A signed-in browser session (Supabase auth cookie).
 *   2. A trusted server-to-server caller presenting the internal token — used by
 *      `cron_scheduler.py` and the agent's social savers, which have no cookies.
 *      The token defaults to SUPABASE_SERVICE_ROLE_KEY so existing deployments
 *      keep working without new configuration; set INTERNAL_API_TOKEN to
 *      decouple them.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export const INTERNAL_TOKEN_HEADER = "x-internal-token";

export function getInternalToken(): string {
  return (
    process.env.INTERNAL_API_TOKEN?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    ""
  );
}

/** True when the request carries a valid internal service token. */
export function isInternalRequest(req: Request): boolean {
  const expected = getInternalToken();
  if (!expected) return false;
  const provided = req.headers.get(INTERNAL_TOKEN_HEADER)?.trim();
  if (!provided || provided.length !== expected.length) return false;
  // Constant-time-ish comparison to avoid leaking the token via timing.
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Resolve the signed-in user from the Supabase auth cookie, or null. */
export async function getSessionUser(): Promise<{ id: string; email?: string } | null> {
  try {
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
            } catch {
              /* read-only cookie store in route handlers — safe to ignore */
            }
          },
        },
      }
    );
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user ? { id: user.id, email: user.email ?? undefined } : null;
  } catch {
    return null;
  }
}

export type ApiCaller =
  | { kind: "user"; userId: string; email?: string }
  | { kind: "internal"; userId: null };

/**
 * Authorize an API request. Returns the caller, or null when unauthorized.
 * Internal service callers are checked first so background jobs never depend on
 * cookie state.
 */
export async function authorizeRequest(req: Request): Promise<ApiCaller | null> {
  if (isInternalRequest(req)) return { kind: "internal", userId: null };
  const user = await getSessionUser();
  if (user) return { kind: "user", userId: user.id, email: user.email };
  return null;
}
