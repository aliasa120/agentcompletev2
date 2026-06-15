import { NextResponse } from "next/server";

/**
 * GET /api/mcp/composio/callback
 *
 * OAuth callback endpoint for Composio. After the user authorizes a connection,
 * Composio redirects here. We just show a success message and close the popup.
 * The parent page polls or detects popup closure and refreshes the connection list.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") ?? "";
  const error = searchParams.get("error") ?? "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Composio Auth${error ? " — Error" : " — Success"}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh;
      background: ${error ? "#fff0f0" : "#f0fff4"};
      color: #111;
    }
    .card {
      text-align: center;
      padding: 2rem 2.5rem;
      border-radius: 12px;
      border: 1px solid ${error ? "#fca5a5" : "#86efac"};
      background: #fff;
      max-width: 380px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.25rem; font-weight: 700; margin-bottom: 0.5rem; color: ${error ? "#dc2626" : "#16a34a"}; }
    p { font-size: 0.9rem; color: #555; line-height: 1.5; }
    .status { margin-top: 1rem; font-size: 0.75rem; color: #999; font-family: monospace; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${error ? "❌" : "✅"}</div>
    <h1>${error ? "Connection Failed" : "Connected Successfully"}</h1>
    <p>${error
      ? `There was an error connecting your account: <strong>${error}</strong>`
      : "Your account has been connected. You can close this window."
    }</p>
    ${status ? `<p class="status">Status: ${status}</p>` : ""}
  </div>
  <script>
    // Auto-close the popup after a short delay
    setTimeout(() => {
      try { window.close(); } catch(e) {}
    }, ${error ? 4000 : 2000});
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}
