import { NextRequest, NextResponse } from "next/server";
import { oauthStore } from "@/lib/oauthStore";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization") || "";
  console.log("[OAuth /api/oauth/me] Authorization header received:", authHeader);

  if (!authHeader.startsWith("Bearer ")) {
    console.error("[OAuth /api/oauth/me] Missing or malformed Bearer prefix in header");
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const token = authHeader.substring(7);
  const tokenData = await oauthStore.validateToken(token);
  if (!tokenData) {
    console.error("[OAuth /api/oauth/me] Token validation failed in DB for token:", token);
    return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  }

  console.log("[OAuth /api/oauth/me] Token verified successfully. User:", tokenData.email);

  // Return user info for Zapier testing
  return NextResponse.json({
    id: tokenData.userId,
    email: tokenData.email,
  });
}
