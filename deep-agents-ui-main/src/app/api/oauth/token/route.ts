import { NextRequest, NextResponse } from "next/server";
import { oauthStore } from "@/lib/oauthStore";

const ALLOWED_CLIENT_ID = "easyclaw_client_id";
const ALLOWED_CLIENT_SECRET = "easyclaw_client_secret_xyz123";

export async function POST(request: NextRequest) {
  let clientId = "";
  let clientSecret = "";
  let code = "";
  let grantType = "";

  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await request.formData();
    clientId = formData.get("client_id")?.toString() || "";
    clientSecret = formData.get("client_secret")?.toString() || "";
    code = formData.get("code")?.toString() || "";
    grantType = formData.get("grant_type")?.toString() || "";
  } else {
    try {
      const body = await request.json();
      clientId = body.client_id || "";
      clientSecret = body.client_secret || "";
      code = body.code || "";
      grantType = body.grant_type || "";
    } catch {}
  }

  console.log("[OAuth /api/oauth/token] Received request:", {
    contentType,
    clientId,
    clientSecret,
    code,
    grantType
  });

  // Validate credentials
  if (clientId !== ALLOWED_CLIENT_ID || clientSecret !== ALLOWED_CLIENT_SECRET) {
    console.error("[OAuth /api/oauth/token] Invalid client ID or secret");
    return NextResponse.json({ error: "invalid_client" }, { status: 400 });
  }

  if (grantType !== "authorization_code") {
    console.error("[OAuth /api/oauth/token] Unsupported grant type:", grantType);
    return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  // Validate code in database
  const codeData = await oauthStore.validateCode(code);
  if (!codeData) {
    console.error("[OAuth /api/oauth/token] Invalid or expired authorization code:", code);
    return NextResponse.json({ error: "invalid_grant" }, { status: 400 });
  }

  // Generate tokens
  const accessToken = "access_" + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  const refreshToken = "refresh_" + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

  // Save the access token linked to the user
  await oauthStore.saveToken(accessToken, codeData.userId, codeData.email);

  console.log("[OAuth /api/oauth/token] Successfully exchanged code for token. User:", codeData.email);

  return NextResponse.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: 30 * 24 * 60 * 60, // 30 days
  });
}
