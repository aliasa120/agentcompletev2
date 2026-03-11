import { NextResponse } from "next/server";

export async function GET() {
    return NextResponse.json({
        fb_token_in_env: !!process.env.FB_TOKEN?.trim(),
        fb_page_id_in_env: !!process.env.FB_PAGE_ID?.trim(),
        fb_page_id_value: process.env.FB_PAGE_ID?.trim() || null,
        ig_account_id_in_env: !!process.env.IG_ACCOUNT_ID?.trim(),
        ig_account_id_value: process.env.IG_ACCOUNT_ID?.trim() || null,
        twitter_api_key_in_env: !!process.env.TWITTER_API_KEY?.trim(),
        twitter_username_in_env: !!process.env.TWITTER_USERNAME?.trim(),
        twitter_username_value: process.env.TWITTER_USERNAME?.trim() || null,
        twitter_email_in_env: !!process.env.TWITTER_EMAIL?.trim(),
        twitter_password_in_env: !!process.env.TWITTER_PASSWORD?.trim(),
        twitter_proxy_in_env: !!process.env.TWITTER_PROXY?.trim(),
        twitter_totp_in_env: !!process.env.TWITTER_TOTP?.trim(),
    });
}
