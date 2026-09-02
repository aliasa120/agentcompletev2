"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
    ArrowLeft, Save, RefreshCw, CheckCircle2, XCircle, Loader2,
    Sparkles, Youtube, Check, Layers,
} from "lucide-react";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { PluginGate } from "@/app/components/settings/PluginsSection";

interface SocialSettings {
    social_fb_enabled: string;
    social_ig_enabled: string;
    social_youtube_enabled: string;
    social_twitter_enabled: string;
    social_auto_publish: string;
    wp_auto_publish: string;
    fb_page_id?: string;
    fb_page_name?: string;
    yt_channel_id?: string;
    yt_channel_title?: string;
}

const DEFAULT_SETTINGS: SocialSettings = {
    social_fb_enabled: "true",
    social_ig_enabled: "true",
    social_youtube_enabled: "true",
    social_twitter_enabled: "false",
    social_auto_publish: "false",
    wp_auto_publish: "false",
};

const TOGGLE_KEYS: (keyof SocialSettings)[] = [
    "social_fb_enabled",
    "social_ig_enabled",
    "social_youtube_enabled",
    "social_twitter_enabled",
    "social_auto_publish",
    "wp_auto_publish",
];

type TestStatus = "idle" | "loading" | "success" | "error";

interface ComposioConnection {
    id: string;
    toolkit_slug: string;
    status: string;
    created_at: string;
}

interface FacebookPage {
    id: string;
    name: string;
    category?: string;
}

interface YouTubeChannel {
    id: string;
    title: string;
    customUrl?: string;
    subscriberCount?: string;
    thumbnail?: string;
}

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
    return (
        <button
            onClick={onToggle}
            aria-pressed={enabled}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${enabled ? "bg-primary" : "bg-muted"}`}
        >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} />
        </button>
    );
}

function ChannelCard({
    icon,
    title,
    description,
    toolkitSlug,
    toggleKey,
    enabled,
    isConnected,
    isConnecting,
    onToggle,
    onConnect,
    onDisconnect,
    children,
}: {
    icon: React.ReactNode;
    title: string;
    description: string;
    toolkitSlug: string;
    toggleKey: keyof SocialSettings;
    enabled: boolean;
    isConnected: boolean;
    isConnecting: boolean;
    onToggle: () => void;
    onConnect: (slug: string) => void;
    onDisconnect: (slug: string) => void;
    children?: React.ReactNode;
}) {
    const [testStatus, setTestStatus] = useState<TestStatus>("idle");
    const [testMsg, setTestMsg] = useState("");

    const runTest = async () => {
        setTestStatus("loading");
        setTestMsg("");
        try {
            const res = await fetch(`/api/publish?platform=${toolkitSlug}`);
            const json = await res.json();
            if (json.success && json.connected) {
                setTestStatus("success");
                setTestMsg(json.info || "Connection verified");
            } else {
                setTestStatus("error");
                setTestMsg(json.error || "Not connected");
            }
        } catch {
            setTestStatus("error");
            setTestMsg("Network error");
        }
    };

    return (
        <div className="p-4 sm:p-5 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0 shadow-sm border border-border/40">
                        {icon}
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <p className="font-semibold text-[15px]">{title}</p>
                            {isConnected ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                                    <Check size={11} strokeWidth={2.5} /> Connected
                                </span>
                            ) : (
                                <span className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full bg-muted text-muted-foreground">
                                    Not Connected
                                </span>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground leading-snug mt-0.5">{description}</p>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                        {enabled ? "Active" : "Disabled"}
                    </span>
                    <Toggle enabled={enabled} onToggle={onToggle} />
                </div>
            </div>

            {/* Custom Channel/Page Selectors if connected */}
            {isConnected && children && (
                <div className="mt-1 pt-3 pb-1 border-t border-border/40">
                    {children}
                </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/40 mt-1">
                <div className="flex items-center gap-2">
                    {isConnected ? (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onDisconnect(toolkitSlug)}
                            className="text-xs h-8 text-destructive hover:bg-destructive/10 hover:border-destructive/30"
                        >
                            Disconnect
                        </Button>
                    ) : (
                        <Button
                            variant="default"
                            size="sm"
                            onClick={() => onConnect(toolkitSlug)}
                            disabled={isConnecting}
                            className="text-xs h-8 gap-1.5 shadow-sm"
                        >
                            {isConnecting ? (
                                <Loader2 size={12} className="animate-spin" />
                            ) : (
                                <Sparkles size={12} />
                            )}
                            1-Click Connect
                        </Button>
                    )}

                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={runTest}
                        disabled={testStatus === "loading"}
                        className="text-xs h-8 text-muted-foreground hover:text-foreground"
                    >
                        {testStatus === "loading" ? <Loader2 size={12} className="animate-spin mr-1" /> : null}
                        Test
                    </Button>
                </div>

                {testStatus === "success" && (
                    <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                        <CheckCircle2 size={13} className="shrink-0" /> {testMsg}
                    </span>
                )}
                {testStatus === "error" && (
                    <span className="flex items-center gap-1 text-xs text-destructive font-medium">
                        <XCircle size={13} className="shrink-0" /> {testMsg}
                    </span>
                )}
            </div>
        </div>
    );
}

export default function PostSettingsPage() {
    const [settings, setSettings] = useState<SocialSettings>(DEFAULT_SETTINGS);
    const [connections, setConnections] = useState<ComposioConnection[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [connectingSlug, setConnectingSlug] = useState<string | null>(null);
    const [saveMsg, setSaveMsg] = useState("");

    // Facebook Pages state
    const [fbPages, setFbPages] = useState<FacebookPage[]>([]);
    const [loadingFbPages, setLoadingFbPages] = useState(false);
    const [selectedFbPageId, setSelectedFbPageId] = useState("");
    const [savingFbPage, setSavingFbPage] = useState(false);
    const [fbPageStatus, setFbPageStatus] = useState("");

    // YouTube Channels state
    const [ytChannels, setYtChannels] = useState<YouTubeChannel[]>([]);
    const [loadingYtChannels, setLoadingYtChannels] = useState(false);
    const [selectedYtChannelId, setSelectedYtChannelId] = useState("");
    const [savingYtChannel, setSavingYtChannel] = useState(false);
    const [ytChannelStatus, setYtChannelStatus] = useState("");

    // Fetch Facebook pages from Composio
    const fetchFacebookPages = useCallback(async (currentSelectedId?: string) => {
        setLoadingFbPages(true);
        setFbPageStatus("");
        try {
            const res = await fetch("/api/social-settings/channels?platform=facebook");
            const data = await res.json();
            if (data.pages && Array.isArray(data.pages)) {
                setFbPages(data.pages);
                if (data.pages.length > 0) {
                    const found = currentSelectedId && data.pages.some((p: any) => p.id === currentSelectedId);
                    if (!found) {
                        setSelectedFbPageId(data.pages[0].id);
                    }
                }
            } else if (data.error) {
                setFbPageStatus(`Error: ${data.error}`);
            }
        } catch (e: any) {
            setFbPageStatus(`Failed to load pages: ${e.message}`);
        } finally {
            setLoadingFbPages(false);
        }
    }, []);

    // Fetch YouTube channels from Composio
    const fetchYouTubeChannels = useCallback(async (currentSelectedId?: string) => {
        setLoadingYtChannels(true);
        setYtChannelStatus("");
        try {
            const res = await fetch("/api/social-settings/channels?platform=youtube");
            const data = await res.json();
            if (data.channels && Array.isArray(data.channels)) {
                setYtChannels(data.channels);
                if (data.channels.length > 0) {
                    const found = currentSelectedId && data.channels.some((c: any) => c.id === currentSelectedId);
                    if (!found) {
                        setSelectedYtChannelId(data.channels[0].id);
                    }
                }
            } else if (data.error) {
                setYtChannelStatus(`Error: ${data.error}`);
            }
        } catch (e: any) {
            setYtChannelStatus(`Failed to load channels: ${e.message}`);
        } finally {
            setLoadingYtChannels(false);
        }
    }, []);

    const loadAll = useCallback(async () => {
        setLoading(true);
        try {
            const [settingsRes, connRes, savedChannelsRes] = await Promise.all([
                fetch("/api/agent-settings"),
                fetch("/api/mcp/composio/connections?sync=true"),
                fetch("/api/social-settings/channels?platform=saved"),
            ]);

            let savedFbId = "";
            let savedYtId = "";

            if (savedChannelsRes.ok) {
                const savedData = await savedChannelsRes.json();
                if (savedData.saved) {
                    if (savedData.saved.fb_page_id) {
                        savedFbId = savedData.saved.fb_page_id;
                        setSelectedFbPageId(savedFbId);
                    }
                    if (savedData.saved.yt_channel_id) {
                        savedYtId = savedData.saved.yt_channel_id;
                        setSelectedYtChannelId(savedYtId);
                    }
                }
            }

            if (settingsRes.ok) {
                const data = await settingsRes.json();
                const map: Record<string, string> = {};
                for (const row of data.settings ?? []) map[row.key] = row.value ?? "";
                setSettings((prev) => ({ ...prev, ...map } as SocialSettings));
            }

            if (connRes.ok) {
                const connData = await connRes.json();
                const conns: ComposioConnection[] = connData.connections || [];
                setConnections(conns);

                const fbActive = conns.some((c) => c.toolkit_slug?.toLowerCase() === "facebook" && c.status?.toLowerCase() === "active");
                if (fbActive) {
                    fetchFacebookPages(savedFbId);
                }

                const ytActive = conns.some((c) => c.toolkit_slug?.toLowerCase() === "youtube" && c.status?.toLowerCase() === "active");
                if (ytActive) {
                    fetchYouTubeChannels(savedYtId);
                }
            }
        } catch (err) {
            console.error("Failed to load settings:", err);
        } finally {
            setLoading(false);
        }
    }, [fetchFacebookPages, fetchYouTubeChannels]);

    useEffect(() => {
        loadAll();
    }, [loadAll]);

    const isConnected = (slug: string) => {
        return connections.some((c) => c.toolkit_slug?.toLowerCase() === slug.toLowerCase() && c.status?.toLowerCase() === "active");
    };

    const handleSaveFacebookPage = async () => {
        if (!selectedFbPageId) return;
        setSavingFbPage(true);
        setFbPageStatus("");
        try {
            const pageObj = fbPages.find((p) => p.id === selectedFbPageId);
            const pageName = pageObj?.name || selectedFbPageId;

            const res = await fetch("/api/social-settings/channels", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    fb_page_id: selectedFbPageId,
                    fb_page_name: pageName,
                }),
            });
            if (res.ok) {
                setFbPageStatus(`Saved active page: ${pageName}`);
                setSettings((prev) => ({ ...prev, fb_page_id: selectedFbPageId, fb_page_name: pageName }));
                setTimeout(() => setFbPageStatus(""), 3500);
            } else {
                setFbPageStatus("Failed to save page selection");
            }
        } catch (e: any) {
            setFbPageStatus(`Error: ${e.message}`);
        } finally {
            setSavingFbPage(false);
        }
    };

    const handleSaveYouTubeChannel = async () => {
        if (!selectedYtChannelId) return;
        setSavingYtChannel(true);
        setYtChannelStatus("");
        try {
            const chanObj = ytChannels.find((c) => c.id === selectedYtChannelId);
            const chanTitle = chanObj?.title || selectedYtChannelId;

            const res = await fetch("/api/social-settings/channels", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    yt_channel_id: selectedYtChannelId,
                    yt_channel_title: chanTitle,
                }),
            });
            if (res.ok) {
                setYtChannelStatus(`Saved active channel: ${chanTitle}`);
                setSettings((prev) => ({ ...prev, yt_channel_id: selectedYtChannelId, yt_channel_title: chanTitle }));
                setTimeout(() => setYtChannelStatus(""), 3500);
            } else {
                setYtChannelStatus("Failed to save channel selection");
            }
        } catch (e: any) {
            setYtChannelStatus(`Error: ${e.message}`);
        } finally {
            setSavingYtChannel(false);
        }
    };

    const toggle = (key: keyof SocialSettings) =>
        setSettings((prev) => ({ ...prev, [key]: prev[key] === "true" ? "false" : "true" }));

    const handleConnect = async (toolkitSlug: string) => {
        setConnectingSlug(toolkitSlug);
        try {
            const res = await fetch("/api/mcp/composio/connections", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ toolkit_slug: toolkitSlug }),
            });
            const data = await res.json();
            if (data.connect_url) {
                const popup = window.open(data.connect_url, "composio-oauth", "width=620,height=720,left=200,top=80");
                const poll = setInterval(async () => {
                    if (popup?.closed) {
                        clearInterval(poll);
                        setConnectingSlug(null);
                        await loadAll();
                    }
                }, 800);
                setTimeout(() => {
                    clearInterval(poll);
                    setConnectingSlug(null);
                }, 180000);
            } else if (data.success) {
                setConnectingSlug(null);
                await loadAll();
            } else {
                alert(data.error || "Failed to initiate connection.");
                setConnectingSlug(null);
            }
        } catch (e: any) {
            alert(e.message || "Connection failed");
            setConnectingSlug(null);
        }
    };

    const handleDisconnect = async (toolkitSlug: string) => {
        const conn = connections.find((c) => c.toolkit_slug?.toLowerCase() === toolkitSlug.toLowerCase());
        if (!conn) return;
        try {
            await fetch("/api/mcp/composio/connections", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ connection_id: conn.id }),
            });
            await loadAll();
        } catch (e) {
            console.error("Disconnect error:", e);
        }
    };

    const saveToggles = async () => {
        setSaving(true);
        setSaveMsg("");
        try {
            const rows = TOGGLE_KEYS.map((key) => ({
                key,
                value: settings[key] ?? "",
            }));
            const res = await fetch("/api/agent-settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ rows }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) {
                throw new Error(data.error || "Save failed");
            }
            setSaveMsg("Settings saved successfully.");
            setTimeout(() => setSaveMsg(""), 3000);
        } catch (err: any) {
            setSaveMsg(err.message || "Failed to save settings");
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center bg-background">
                <Loader2 className="animate-spin h-8 w-8 text-muted-foreground" />
            </div>
        );
    }

    return (
        <PluginGate pluginKey="posts">
            <div className="min-h-screen bg-background text-foreground">
                <header className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur-md shadow-sm">
                    <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3">
                        <Link href="/posts">
                            <Button variant="ghost" size="sm" className="gap-2 -ml-2 text-muted-foreground hover:text-foreground">
                                <ArrowLeft size={16} />
                                <span className="hidden sm:inline">Back to Posts</span>
                                <span className="sm:hidden">Back</span>
                            </Button>
                        </Link>
                        <div className="hidden sm:block h-5 w-px bg-border" />
                        <h1 className="text-[15px] font-bold text-foreground flex-1 min-w-0 truncate">Post Settings & Channels</h1>
                        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                            <ThemeToggle />
                            <Button variant="outline" size="sm" onClick={loadAll} className="gap-1.5 text-muted-foreground hover:text-foreground text-[13px]">
                                <RefreshCw size={13} />
                                <span className="hidden sm:inline">Refresh</span>
                            </Button>
                            <Button size="sm" onClick={saveToggles} disabled={saving} className="gap-1.5 text-[13px]">
                                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                                Save
                            </Button>
                        </div>
                    </div>
                    {saveMsg && (
                        <div className="bg-emerald-500/10 border-t border-emerald-500/30 px-4 py-2 text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
                            <CheckCircle2 size={14} /> {saveMsg}
                        </div>
                    )}
                </header>

                <main className="mx-auto max-w-3xl px-3 sm:px-4 py-5 sm:py-8 space-y-4 sm:space-y-6">
                    {/* Automation */}
                    <section className="rounded-xl border bg-card shadow-sm overflow-hidden divide-y divide-border/60">
                        <div className="px-4 sm:px-5 pt-4 pb-3">
                            <h2 className="font-semibold text-[15px]">Publishing Automation</h2>
                            <p className="text-xs text-muted-foreground mt-0.5">Control how new posts created by agents are published.</p>
                        </div>
                        <div className="px-4 sm:px-5 py-4 flex items-center justify-between gap-3">
                            <div>
                                <p className="font-semibold text-[14px]">Social Auto-Publish</p>
                                <p className="text-xs text-muted-foreground mt-0.5">Automatically publish approved posts via background cron scheduler.</p>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="text-[11px] font-medium text-muted-foreground uppercase">
                                    {settings.social_auto_publish === "true" ? "On" : "Off"}
                                </span>
                                <Toggle enabled={settings.social_auto_publish === "true"} onToggle={() => toggle("social_auto_publish")} />
                            </div>
                        </div>
                        <div className="px-4 sm:px-5 py-4 flex items-center justify-between gap-3">
                            <div>
                                <p className="font-semibold text-[14px]">WordPress Auto-Publish</p>
                                <p className="text-xs text-muted-foreground mt-0.5">Publish blog articles immediately as Live instead of creating Drafts.</p>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="text-[11px] font-medium text-muted-foreground uppercase">
                                    {settings.wp_auto_publish === "true" ? "Live" : "Draft"}
                                </span>
                                <Toggle enabled={settings.wp_auto_publish === "true"} onToggle={() => toggle("wp_auto_publish")} />
                            </div>
                        </div>
                    </section>

                    {/* Social Channels */}
                    <section className="rounded-xl border bg-card shadow-sm overflow-hidden divide-y divide-border/60">
                        <div className="px-4 sm:px-5 pt-4 pb-3">
                            <h2 className="font-semibold text-[15px]">Social Channels & Pages</h2>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                Connect accounts, select target pages/channels, and enable 1-click live publishing.
                            </p>
                        </div>

                        {/* Instagram */}
                        <ChannelCard
                            icon={
                                <div className="h-full w-full rounded-xl bg-gradient-to-br from-[#FCAF45] via-[#E1306C] to-[#833AB4] flex items-center justify-center">
                                    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-white"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" /></svg>
                                </div>
                            }
                            title="Instagram"
                            description="Publish Reels, Photos, Feed Videos, and Carousels via Composio container flow."
                            toolkitSlug="instagram"
                            toggleKey="social_ig_enabled"
                            enabled={settings.social_ig_enabled === "true"}
                            isConnected={isConnected("instagram")}
                            isConnecting={connectingSlug === "instagram"}
                            onToggle={() => toggle("social_ig_enabled")}
                            onConnect={handleConnect}
                            onDisconnect={handleDisconnect}
                        />

                        {/* Facebook */}
                        <ChannelCard
                            icon={
                                <div className="h-full w-full rounded-xl bg-[#1877F2] flex items-center justify-center">
                                    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-white"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" /></svg>
                                </div>
                            }
                            title="Facebook Page"
                            description="Publish text posts, photos, and video reels directly to your Facebook Page feed."
                            toolkitSlug="facebook"
                            toggleKey="social_fb_enabled"
                            enabled={settings.social_fb_enabled === "true"}
                            isConnected={isConnected("facebook")}
                            isConnecting={connectingSlug === "facebook"}
                            onToggle={() => toggle("social_fb_enabled")}
                            onConnect={handleConnect}
                            onDisconnect={handleDisconnect}
                        >
                            <div className="space-y-2.5 bg-muted/20 p-3 rounded-lg border border-border/40">
                                <div className="flex items-center justify-between">
                                    <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                                        <Layers size={13} className="text-primary" /> Target Facebook Page
                                    </label>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => fetchFacebookPages(selectedFbPageId)}
                                        disabled={loadingFbPages}
                                        className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground gap-1"
                                    >
                                        <RefreshCw size={10} className={loadingFbPages ? "animate-spin" : ""} />
                                        Refresh Pages
                                    </Button>
                                </div>

                                {loadingFbPages ? (
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                                        <Loader2 size={12} className="animate-spin" /> Fetching Facebook pages...
                                    </div>
                                ) : fbPages.length > 0 ? (
                                    <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                                        <select
                                            value={selectedFbPageId}
                                            onChange={(e) => setSelectedFbPageId(e.target.value)}
                                            className="h-8 px-2.5 rounded-md border border-input bg-background text-xs font-medium focus:outline-none focus:ring-1 focus:ring-primary flex-1"
                                        >
                                            {fbPages.map((p) => (
                                                <option key={p.id} value={p.id}>
                                                    {p.name} {p.category ? `(${p.category})` : ""} — ID: {p.id}
                                                </option>
                                            ))}
                                        </select>
                                        <Button
                                            size="sm"
                                            onClick={handleSaveFacebookPage}
                                            disabled={savingFbPage || !selectedFbPageId}
                                            className="h-8 px-3 text-xs font-semibold shrink-0 gap-1"
                                        >
                                            {savingFbPage ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                                            Set Target Page
                                        </Button>
                                    </div>
                                ) : (
                                    <p className="text-xs text-muted-foreground italic">
                                        No managed pages found. Click &quot;Refresh Pages&quot; to fetch your Facebook Pages.
                                    </p>
                                )}

                                {fbPageStatus && (
                                    <p className={`text-[11px] font-medium ${fbPageStatus.startsWith("Saved") ? "text-emerald-500" : "text-destructive"}`}>
                                        {fbPageStatus}
                                    </p>
                                )}
                            </div>
                        </ChannelCard>

                        {/* YouTube */}
                        <ChannelCard
                            icon={
                                <div className="h-full w-full rounded-xl bg-[#FF0000] flex items-center justify-center text-white">
                                    <Youtube size={22} className="fill-white" />
                                </div>
                            }
                            title="YouTube"
                            description="Upload videos and Shorts with automated custom thumbnail application and SEO tags."
                            toolkitSlug="youtube"
                            toggleKey="social_youtube_enabled"
                            enabled={settings.social_youtube_enabled === "true"}
                            isConnected={isConnected("youtube")}
                            isConnecting={connectingSlug === "youtube"}
                            onToggle={() => toggle("social_youtube_enabled")}
                            onConnect={handleConnect}
                            onDisconnect={handleDisconnect}
                        >
                            <div className="space-y-2.5 bg-muted/20 p-3 rounded-lg border border-border/40">
                                <div className="flex items-center justify-between">
                                    <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                                        <Youtube size={13} className="text-red-500" /> Target YouTube Channel
                                    </label>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => fetchYouTubeChannels(selectedYtChannelId)}
                                        disabled={loadingYtChannels}
                                        className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground gap-1"
                                    >
                                        <RefreshCw size={10} className={loadingYtChannels ? "animate-spin" : ""} />
                                        Refresh Channels
                                    </Button>
                                </div>

                                {loadingYtChannels ? (
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                                        <Loader2 size={12} className="animate-spin" /> Fetching YouTube channels...
                                    </div>
                                ) : ytChannels.length > 0 ? (
                                    <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                                        <select
                                            value={selectedYtChannelId}
                                            onChange={(e) => setSelectedYtChannelId(e.target.value)}
                                            className="h-8 px-2.5 rounded-md border border-input bg-background text-xs font-medium focus:outline-none focus:ring-1 focus:ring-primary flex-1"
                                        >
                                            {ytChannels.map((c) => (
                                                <option key={c.id} value={c.id}>
                                                    {c.title} {c.customUrl ? `(${c.customUrl})` : ""} — ID: {c.id}
                                                </option>
                                            ))}
                                        </select>
                                        <Button
                                            size="sm"
                                            onClick={handleSaveYouTubeChannel}
                                            disabled={savingYtChannel || !selectedYtChannelId}
                                            className="h-8 px-3 text-xs font-semibold shrink-0 gap-1"
                                        >
                                            {savingYtChannel ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                                            Set Target Channel
                                        </Button>
                                    </div>
                                ) : (
                                    <p className="text-xs text-muted-foreground italic">
                                        No channels found. Click &quot;Refresh Channels&quot; to fetch your YouTube Channels.
                                    </p>
                                )}

                                {ytChannelStatus && (
                                    <p className={`text-[11px] font-medium ${ytChannelStatus.startsWith("Saved") ? "text-emerald-500" : "text-destructive"}`}>
                                        {ytChannelStatus}
                                    </p>
                                )}
                            </div>
                        </ChannelCard>

                        {/* X / Twitter */}
                        <ChannelCard
                            icon={
                                <div className="h-full w-full rounded-xl bg-foreground flex items-center justify-center text-background">
                                    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.74l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
                                </div>
                            }
                            title="X (Twitter)"
                            description="Publish tweets and threads directly through Composio Twitter MCP gateway."
                            toolkitSlug="twitter"
                            toggleKey="social_twitter_enabled"
                            enabled={settings.social_twitter_enabled === "true"}
                            isConnected={isConnected("twitter")}
                            isConnecting={connectingSlug === "twitter"}
                            onToggle={() => toggle("social_twitter_enabled")}
                            onConnect={handleConnect}
                            onDisconnect={handleDisconnect}
                        />
                    </section>

                    <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 pb-8">
                        <Link href="/posts" className="sm:w-auto w-full">
                            <Button variant="outline" className="w-full sm:w-auto">Cancel</Button>
                        </Link>
                        <Button onClick={saveToggles} disabled={saving} className="gap-2 sm:min-w-[140px] w-full sm:w-auto">
                            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                            Save Settings
                        </Button>
                    </div>
                </main>
            </div>
        </PluginGate>
    );
}
