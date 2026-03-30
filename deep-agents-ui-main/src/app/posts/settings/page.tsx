"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Save, RefreshCw, CheckCircle2, XCircle, Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";

interface SocialSettings {
    social_fb_enabled: string;
    social_ig_enabled: string;
    social_twitter_enabled: string;
    social_auto_publish: string;
    social_fb_token: string;
    social_fb_page_id: string;
    social_ig_account_id: string;
    social_twitter_api_key: string;
    social_twitter_api_secret: string;
    social_twitter_access_token: string;
    social_twitter_access_secret: string;
}

interface EnvStatus {
    fb_token_in_env: boolean;
    fb_page_id_in_env: boolean;
    fb_page_id_value: string | null;
    ig_account_id_in_env: boolean;
    ig_account_id_value: string | null;
    twitter_api_key_in_env: boolean;
    twitter_api_secret_in_env: boolean;
    twitter_access_token_in_env: boolean;
    twitter_access_secret_in_env: boolean;
}

const DEFAULT_SETTINGS: SocialSettings = {
    social_fb_enabled: "true",
    social_ig_enabled: "true",
    social_twitter_enabled: "false",
    social_auto_publish: "false",
    social_fb_token: "",
    social_fb_page_id: "",
    social_ig_account_id: "",
    social_twitter_api_key: "",
    social_twitter_api_secret: "",
    social_twitter_access_token: "",
    social_twitter_access_secret: "",
};

type TestStatus = "idle" | "loading" | "success" | "error";

function EnvBadge({ set }: { set: boolean }) {
    return set ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700">
            <ShieldCheck size={10} />.env.local
        </span>
    ) : null;
}

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
    return (
        <button
            onClick={onToggle}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${enabled ? "bg-primary" : "bg-muted"}`}
        >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} />
        </button>
    );
}

function PasswordInput({
    value, onChange, placeholder, readOnly, envSet,
}: {
    value: string; onChange: (v: string) => void; placeholder?: string; readOnly?: boolean; envSet?: boolean;
}) {
    const [show, setShow] = useState(false);
    if (envSet) {
        return (
            <div className="flex items-center gap-2 mt-1.5 px-3 py-2 rounded-lg bg-green-50 border border-green-200 text-sm text-green-700">
                <ShieldCheck size={14} />
                <span className="font-medium">Set in .env.local</span>
                <span className="text-green-500 text-xs ml-auto">env var takes priority</span>
            </div>
        );
    }
    return (
        <div className="relative mt-1.5">
            <Input
                type={show ? "text" : "password"}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                readOnly={readOnly}
                className="pr-10 font-mono text-sm"
            />
            <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
                {show ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
        </div>
    );
}

function IdInput({
    value, onChange, placeholder, envSet, envValue,
}: {
    value: string; onChange: (v: string) => void; placeholder?: string; envSet?: boolean; envValue?: string | null;
}) {
    if (envSet) {
        return (
            <div className="flex items-center gap-2 mt-1.5 px-3 py-2 rounded-lg bg-green-50 border border-green-200 text-sm text-green-700">
                <ShieldCheck size={14} />
                <span className="font-medium">Set in .env.local</span>
                {envValue && <span className="font-mono text-xs text-green-600 ml-2">{envValue}</span>}
                <span className="text-green-500 text-xs ml-auto">env var takes priority</span>
            </div>
        );
    }
    return (
        <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="mt-1.5 font-mono text-sm"
        />
    );
}

function TestButton({ platform }: { platform: string }) {
    const [status, setStatus] = useState<TestStatus>("idle");
    const [msg, setMsg] = useState("");

    const run = async () => {
        setStatus("loading");
        setMsg("");
        try {
            const res = await fetch(`/api/publish?platform=${platform}`);
            const json = await res.json();
            if (json.success) { setStatus("success"); setMsg(json.info || "Connected"); }
            else { setStatus("error"); setMsg(json.error || "Connection failed"); }
        } catch {
            setStatus("error");
            setMsg("Network error");
        }
    };

    return (
        <div className="flex items-center gap-2 mt-2">
            <Button variant="outline" size="sm" onClick={run} disabled={status === "loading"} className="text-xs">
                {status === "loading" ? <Loader2 size={12} className="animate-spin mr-1" /> : null}
                Test Connection
            </Button>
            {status === "success" && <span className="flex items-center gap-1 text-xs text-green-600"><CheckCircle2 size={13} />{msg}</span>}
            {status === "error" && <span className="flex items-center gap-1 text-xs text-red-500"><XCircle size={13} />{msg}</span>}
        </div>
    );
}

export default function PostSettingsPage() {
    const [settings, setSettings] = useState<SocialSettings>(DEFAULT_SETTINGS);
    const [envStatus, setEnvStatus] = useState<EnvStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState("");

    const loadAll = useCallback(async () => {
        setLoading(true);
        const [{ data }, envRes] = await Promise.all([
            supabase.from("agent_settings").select("key,value"),
            fetch("/api/social-settings"),
        ]);
        const map: Record<string, string> = {};
        for (const row of data ?? []) map[row.key] = row.value ?? "";
        setSettings((prev) => ({ ...prev, ...map } as SocialSettings));
        const envData: EnvStatus = await envRes.json();
        setEnvStatus(envData);
        setLoading(false);
    }, []);

    useEffect(() => { loadAll(); }, [loadAll]);

    const set = (key: keyof SocialSettings, value: string) =>
        setSettings((prev) => ({ ...prev, [key]: value }));

    const toggle = async (key: keyof SocialSettings) => {
        const nextVal = settings[key] === "true" ? "false" : "true";
        setSettings((prev) => ({ ...prev, [key]: nextVal }));
    };

    const saveToggles = async () => {
        setSaving(true);
        setSaveMsg("");
        const toggleKeys: (keyof SocialSettings)[] = [
            "social_fb_enabled", "social_ig_enabled", "social_twitter_enabled", "social_auto_publish",
        ];
        const credKeys: (keyof SocialSettings)[] = [
            "social_fb_token", "social_fb_page_id", "social_ig_account_id",
            "social_twitter_api_key", "social_twitter_api_secret", "social_twitter_access_token", "social_twitter_access_secret",
        ];
        // Save toggles always; save credential fields only if not in env
        const keysToSave = [...toggleKeys, ...credKeys.filter((k) => {
            if (k === "social_fb_token" && envStatus?.fb_token_in_env) return false;
            if (k === "social_fb_page_id" && envStatus?.fb_page_id_in_env) return false;
            if (k === "social_ig_account_id" && envStatus?.ig_account_id_in_env) return false;
            if (k === "social_twitter_api_key" && envStatus?.twitter_api_key_in_env) return false;
            if (k === "social_twitter_api_secret" && envStatus?.twitter_api_secret_in_env) return false;
            if (k === "social_twitter_access_token" && envStatus?.twitter_access_token_in_env) return false;
            if (k === "social_twitter_access_secret" && envStatus?.twitter_access_secret_in_env) return false;
            return true;
        })];
        const upserts = keysToSave.map((key) =>
            supabase.from("agent_settings").upsert({ key, value: settings[key], updated_at: new Date().toISOString() })
        );

        await Promise.all(upserts);
        setSaving(false);
        setSaveMsg("Settings saved.");
        setTimeout(() => setSaveMsg(""), 3000);
    };

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center bg-background">
                <Loader2 className="animate-spin h-8 w-8 text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#F0F2F5]">
            <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/95 backdrop-blur-md shadow-sm">
                <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
                    <Link href="/posts">
                        <Button variant="ghost" size="sm" className="gap-2 text-gray-600">
                            <ArrowLeft size={16} />Back to Posts
                        </Button>
                    </Link>
                    <div className="h-5 w-px bg-gray-200" />
                    <h1 className="text-[15px] font-bold text-gray-900 flex-1">Post Settings</h1>
                    <Button variant="outline" size="sm" onClick={loadAll} className="gap-1.5 text-gray-600 text-[13px]">
                        <RefreshCw size={13} />Refresh
                    </Button>
                    <Button size="sm" onClick={saveToggles} disabled={saving} className="gap-1.5 text-[13px]">
                        {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                        Save
                    </Button>
                </div>
                {saveMsg && (
                    <div className="bg-green-50 border-t border-green-200 px-4 py-2 text-sm text-green-700 flex items-center gap-2">
                        <CheckCircle2 size={14} />{saveMsg}
                    </div>
                )}
            </header>

            <main className="mx-auto max-w-3xl px-4 py-8 space-y-6">

                {/* Auto-Publish */}
                <section className="rounded-xl border bg-white shadow-sm overflow-hidden">
                    <div className="px-5 py-4 flex items-center gap-3">
                        <div className="h-8 w-8 rounded-lg bg-purple-100 flex items-center justify-center shrink-0">
                            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-purple-600"><path d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                        </div>
                        <div className="flex-1">
                            <p className="font-semibold text-[15px]">Auto-Publish</p>
                            <p className="text-xs text-muted-foreground">Automatically publish new posts via the background cron scheduler. Toggle per-platform below.</p>
                        </div>
                        <span className="text-sm text-muted-foreground mr-1">{settings.social_auto_publish === "true" ? "ON" : "OFF"}</span>
                        <Toggle enabled={settings.social_auto_publish === "true"} onToggle={() => toggle("social_auto_publish")} />
                    </div>
                </section>

                {/* Facebook */}
                <section className="rounded-xl border bg-white shadow-sm overflow-hidden">
                    <div className="px-5 py-4 border-b bg-gray-50 flex items-center gap-2">
                        <div className="h-8 w-8 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
                            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-[#1877F2]"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" /></svg>
                        </div>
                        <div className="flex-1">
                            <p className="font-semibold text-[15px]">Facebook</p>
                            <p className="text-xs text-muted-foreground">Bug news page · ID: {envStatus?.fb_page_id_value || settings.social_fb_page_id || "Not set"}</p>
                        </div>
                        <span className="text-sm text-muted-foreground mr-1">{settings.social_fb_enabled === "true" ? "Enabled" : "Disabled"}</span>
                        <Toggle enabled={settings.social_fb_enabled === "true"} onToggle={() => toggle("social_fb_enabled")} />
                    </div>
                    <div className="px-5 py-5 space-y-4">
                        <div>
                            <div className="flex items-center gap-2">
                                <label className="text-sm font-medium">Access Token</label>
                                <EnvBadge set={!!envStatus?.fb_token_in_env} />
                            </div>
                            <p className="text-xs text-muted-foreground mb-1">Meta Business system user token with pages_manage_posts &amp; instagram_content_publish permissions.</p>
                            <PasswordInput
                                value={settings.social_fb_token}
                                onChange={(v) => set("social_fb_token", v)}
                                placeholder="EAAZA..."
                                envSet={!!envStatus?.fb_token_in_env}
                            />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <label className="text-sm font-medium">Facebook Page ID</label>
                                <EnvBadge set={!!envStatus?.fb_page_id_in_env} />
                            </div>
                            <IdInput
                                value={settings.social_fb_page_id}
                                onChange={(v) => set("social_fb_page_id", v)}
                                placeholder="e.g. 1002976109566045"
                                envSet={!!envStatus?.fb_page_id_in_env}
                                envValue={envStatus?.fb_page_id_value}
                            />
                        </div>
                        <TestButton platform="facebook" />
                    </div>
                </section>

                {/* Instagram */}
                <section className="rounded-xl border bg-white shadow-sm overflow-hidden">
                    <div className="px-5 py-4 border-b bg-gray-50 flex items-center gap-2">
                        <div className="h-8 w-8 rounded-lg flex items-center justify-center bg-gradient-to-br from-[#FCAF45] via-[#E1306C] to-[#833AB4] shrink-0">
                            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" /></svg>
                        </div>
                        <div className="flex-1">
                            <p className="font-semibold text-[15px]">Instagram</p>
                            <p className="text-xs text-muted-foreground">
                                Instagram connected · ID: {envStatus?.ig_account_id_value || settings.social_ig_account_id || "Not set"}
                            </p>
                        </div>
                        <span className="text-sm text-muted-foreground mr-1">{settings.social_ig_enabled === "true" ? "Enabled" : "Disabled"}</span>
                        <Toggle enabled={settings.social_ig_enabled === "true"} onToggle={() => toggle("social_ig_enabled")} />
                    </div>
                    <div className="px-5 py-5 space-y-4">
                        <div className="rounded-lg bg-blue-50 border border-blue-100 px-3 py-2 text-xs text-blue-700">
                            Instagram uses the same access token as Facebook. The token needs <code>instagram_basic</code> and <code>instagram_content_publish</code> permissions. <strong>Posts require an image.</strong>
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <label className="text-sm font-medium">Instagram Account ID</label>
                                <EnvBadge set={!!envStatus?.ig_account_id_in_env} />
                            </div>
                            <IdInput
                                value={settings.social_ig_account_id}
                                onChange={(v) => set("social_ig_account_id", v)}
                                placeholder="e.g. 17841448472333671"
                                envSet={!!envStatus?.ig_account_id_in_env}
                                envValue={envStatus?.ig_account_id_value}
                            />
                        </div>
                        <TestButton platform="instagram" />
                    </div>
                </section>

                {/* Twitter / X */}
                <section className="rounded-xl border bg-white shadow-sm overflow-hidden">
                    <div className="px-5 py-4 border-b bg-gray-50 flex items-center gap-2">
                        <div className="h-8 w-8 rounded-lg bg-black flex items-center justify-center shrink-0">
                            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.74l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
                        </div>
                        <div className="flex-1">
                            <p className="font-semibold text-[15px]">X (Twitter)</p>
                            <p className="text-xs text-muted-foreground">
                                Official OAuth 1.0a API Link
                            </p>
                        </div>
                        <span className="text-sm text-muted-foreground mr-1">{settings.social_twitter_enabled === "true" ? "Enabled" : "Disabled"}</span>
                        <Toggle enabled={settings.social_twitter_enabled === "true"} onToggle={() => toggle("social_twitter_enabled")} />
                    </div>
                    <div className="px-5 py-5 space-y-4">
                        <div className="rounded-lg bg-blue-50 border border-blue-100 px-3 py-2 text-xs text-blue-800">
                            Posting to X involves the official API. Provide developer OAuth 1.0 credentials here or in <code>.env.local</code>.
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <div className="flex items-center gap-2 mb-1"><label className="text-sm font-medium">Consumer Key (API Key)</label><EnvBadge set={!!envStatus?.twitter_api_key_in_env} /></div>
                                <PasswordInput value={settings.social_twitter_api_key} onChange={(v) => set("social_twitter_api_key", v)} placeholder="API Key" envSet={!!envStatus?.twitter_api_key_in_env} />
                            </div>
                            <div>
                                <div className="flex items-center gap-2 mb-1"><label className="text-sm font-medium">Consumer Secret (API Secret)</label><EnvBadge set={!!envStatus?.twitter_api_secret_in_env} /></div>
                                <PasswordInput value={settings.social_twitter_api_secret} onChange={(v) => set("social_twitter_api_secret", v)} placeholder="API Secret" envSet={!!envStatus?.twitter_api_secret_in_env} />
                            </div>
                            <div>
                                <div className="flex items-center gap-2 mb-1"><label className="text-sm font-medium">Access Token</label><EnvBadge set={!!envStatus?.twitter_access_token_in_env} /></div>
                                <PasswordInput value={settings.social_twitter_access_token} onChange={(v) => set("social_twitter_access_token", v)} placeholder="Access Token" envSet={!!envStatus?.twitter_access_token_in_env} />
                            </div>
                            <div>
                                <div className="flex items-center gap-2 mb-1"><label className="text-sm font-medium">Access Token Secret</label><EnvBadge set={!!envStatus?.twitter_access_secret_in_env} /></div>
                                <PasswordInput value={settings.social_twitter_access_secret} onChange={(v) => set("social_twitter_access_secret", v)} placeholder="Access Secret" envSet={!!envStatus?.twitter_access_secret_in_env} />
                            </div>
                        </div>
                        <TestButton platform="twitter" />
                    </div>
                </section>

                <div className="flex justify-end gap-3 pb-8">
                    <Link href="/posts"><Button variant="outline">Cancel</Button></Link>
                    <Button onClick={saveToggles} disabled={saving} className="gap-2 min-w-[140px]">
                        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                        Save Settings
                    </Button>
                </div>
            </main>
        </div>
    );
}
