import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { oauthStore } from "@/lib/oauthStore";

const ALLOWED_CLIENT_ID = "easyclaw_client_id";
const ALLOWED_REDIRECT_URI = "https://zapier.com/dashboard/auth/oauth/return/App242777CLIAPI/";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const clientId = searchParams.get("client_id");
  const redirectUri = searchParams.get("redirect_uri");
  const state = searchParams.get("state");
  const responseType = searchParams.get("response_type");

  // Verify parameters
  if (clientId !== ALLOWED_CLIENT_ID || redirectUri !== ALLOWED_REDIRECT_URI || responseType !== "code") {
    return new NextResponse("Invalid Client ID or Redirect URI", { status: 400 });
  }

  // Get active Supabase session
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

  // If user is not logged in, redirect to login page
  if (!user) {
    const proto = request.headers.get("x-forwarded-proto") || "http";
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "localhost:3000";
    const redirectBase = `${proto}://${host}`;

    const loginUrl = new URL("/login", redirectBase);
    loginUrl.searchParams.set("redirectTo", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl.toString());
  }

  // Return a beautifully styled HTML authorization/consent page
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Authorize easyclaw</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
      <style>
        body {
          font-family: 'Outfit', sans-serif;
          background-color: #faf9f5;
          color: #3d3929;
        }
        .dark body {
          background-color: #141413;
          color: #faf9f5;
        }
      </style>
      <script>
        // Check system / localStorage theme
        if (localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
          document.documentElement.classList.add('dark');
        }
      </script>
    </head>
    <body class="flex items-center justify-center min-h-screen p-4 bg-[#faf9f5] dark:bg-[#141413]">
      <div class="w-full max-w-md p-8 bg-white dark:bg-[#1e1e1d] rounded-2xl shadow-sm border border-[#dad9d4] dark:border-[#2d2d2a] text-center">
        <!-- App Icon Placeholder / Zapier Icon -->
        <div class="flex items-center justify-center gap-4 mb-6">
          <div class="w-12 h-12 rounded-xl bg-[#c96442]/10 flex items-center justify-center text-[#c96442] font-bold text-xl">
            E
          </div>
          <div class="h-px w-8 bg-gray-300 dark:bg-gray-700"></div>
          <div class="w-12 h-12 rounded-xl bg-orange-500/10 flex items-center justify-center text-orange-500 font-bold text-xl">
            Z
          </div>
        </div>

        <h1 class="text-xl font-semibold mb-2 text-gray-900 dark:text-gray-100">
          Authorize easyclaw
        </h1>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-6">
          Connect your account to Zapier and grant access to workflows and automation actions.
        </p>

        <div class="p-4 rounded-xl bg-gray-50 dark:bg-gray-800/40 text-left mb-6 border border-gray-100 dark:border-gray-800 text-xs text-gray-600 dark:text-gray-400 space-y-2">
          <p class="font-medium text-gray-700 dark:text-gray-300">Logged in as:</p>
          <p class="truncate font-semibold text-gray-900 dark:text-gray-100">${user.email}</p>
        </div>

        <form action="/api/oauth/authorize" method="POST" class="space-y-3">
          <input type="hidden" name="client_id" value="${clientId || ""}" />
          <input type="hidden" name="redirect_uri" value="${redirectUri || ""}" />
          <input type="hidden" name="state" value="${state || ""}" />
          <input type="hidden" name="response_type" value="${responseType || ""}" />

          <button type="submit" class="w-full py-3 px-4 bg-[#c96442] hover:bg-[#b05730] text-white font-medium rounded-xl transition duration-200 focus:outline-none">
            Allow Access
          </button>
          
          <a href="${redirectUri}?error=access_denied&state=${state || ""}" class="block w-full py-2.5 px-4 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition duration-200">
            Cancel
          </a>
        </form>
      </div>
    </body>
    </html>
  `;

  return new NextResponse(html, { headers: { "Content-Type": "text/html" } });
}

export async function POST(request: NextRequest) {
  // Parse form body
  const formData = await request.formData();
  const clientId = formData.get("client_id");
  const redirectUri = formData.get("redirect_uri");
  const state = formData.get("state");
  const responseType = formData.get("response_type");

  if (clientId !== ALLOWED_CLIENT_ID || redirectUri !== ALLOWED_REDIRECT_URI || responseType !== "code") {
    return new NextResponse("Invalid Client ID or Redirect URI", { status: 400 });
  }

  // Get current user session
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
  if (!user || !user.email) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // Generate a random temporary authorization code
  const code = "code_" + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

  // Save temporary auth code mapped to the user in database
  await oauthStore.saveCode(code, user.id, user.email);

  // Redirect back to Zapier with the auth code
  const targetUrl = new URL(ALLOWED_REDIRECT_URI);
  targetUrl.searchParams.set("code", code);
  if (state) {
    targetUrl.searchParams.set("state", state.toString());
  }

  return NextResponse.redirect(targetUrl.toString());
}
