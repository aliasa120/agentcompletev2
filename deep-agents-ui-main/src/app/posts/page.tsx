"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import {
    RefreshCcw, ArrowLeft, Heart, MessageCircle, Repeat2,
    Bookmark, Share2, ThumbsUp, Trash2, Download, MoreHorizontal, Globe,
    Settings, Send, CheckCircle2, Loader2, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface PostData {
    id: string;
    created_at: string;
    title: string;
    twitter: string;
    instagram: string;
    facebook: string;
    sources: string[];
    image: boolean;
    image_url: string | null;
    published_to: Record<string, boolean>;
}

interface PublishResult {
    success: boolean;
    post_id?: string;
    error?: string;
}

// Strip the "Social Media Posts: " prefix agents sometimes add
function cleanTitle(t: string) {
    return t.replace(/^social\s+media\s+posts?:\s*/i, "").trim();
}

// ─── X / Twitter Card ────────────────────────────────────────────────────────
function TwitterPost({ post, imageSrc, title }: { post: string; imageSrc: string | null; title: string }) {
    const cleanPost = post.replace(/\*Character count:.*?\*\s*/gi, "").replace(/^---+\s*/gm, "").trim();
    return (
        <div style={{ fontFamily: "'TwitterChirp', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}
            className="overflow-hidden rounded-2xl border border-[#2F3336] bg-[#000000] text-white shadow-xl w-full">
            <div className="flex gap-3 px-4 pt-4 pb-2">
                <div className="shrink-0">
                    <div className="h-10 w-10 rounded-full bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center font-bold text-white text-base">N</div>
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 flex-wrap">
                        <span className="font-bold text-[15px]">News Agent</span>
                        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] fill-[#1D9BF0]">
                            <path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.27 2.52-.81 3.91C2.63 9.33 1.75 10.57 1.75 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.27 3.91.81c.66 1.31 1.91 2.19 3.34 2.19s2.67-.88 3.34-2.19c1.39.46 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z" />
                        </svg>
                        <span className="text-[#71767B] text-[14px]">@newsagent · Just now</span>
                    </div>
                    <p className="text-[12px] text-[#71767B] italic mb-1 mt-0.5 truncate">{title}</p>
                    <p className="mt-1 text-[15px] leading-[1.5] text-[#E7E9EA] whitespace-pre-wrap break-words">{cleanPost}</p>
                    {imageSrc && (
                        <div className="mt-3 overflow-hidden rounded-2xl border border-[#2F3336] w-full">
                            <Image src={imageSrc} alt="Post image" width={600} height={338} className="w-full object-cover" unoptimized />
                        </div>
                    )}
                    <div className="mt-3 flex items-center justify-between text-[#71767B] max-w-[425px]">
                        {[MessageCircle, Repeat2, Heart, Bookmark, Share2].map((Icon, i) => (
                            <button key={i} className="rounded-full p-2 hover:bg-white/10 transition-colors"><Icon size={18} strokeWidth={1.5} /></button>
                        ))}
                    </div>
                </div>
                <button className="shrink-0 self-start text-[#71767B] hover:text-white p-1 rounded-full hover:bg-white/10"><MoreHorizontal size={18} /></button>
            </div>
            <div className="border-t border-[#2F3336] mx-4" />
            <div className="flex items-center gap-3 px-4 py-3 text-[#71767B] text-[14px]">
                <div className="h-8 w-8 rounded-full bg-[#2F3336] flex items-center justify-center text-xs font-bold">U</div>
                <span>Post your reply</span>
            </div>
        </div>
    );
}

// ─── Instagram Card ───────────────────────────────────────────────────────────
function InstagramPost({ post, imageSrc, title }: { post: string; imageSrc: string | null; title: string }) {
    const [expanded, setExpanded] = useState(false);
    const lines = post.split("\n");
    const captionLines = lines.filter((l) => !l.trim().startsWith("#")).join("\n").trim();
    const hashtagLine = lines.filter((l) => l.trim().startsWith("#")).join(" ").trim();
    const PREVIEW_CHARS = 125;
    const needsTruncation = captionLines.length > PREVIEW_CHARS;
    const visibleCaption = expanded || !needsTruncation ? captionLines : captionLines.slice(0, PREVIEW_CHARS) + "…";

    return (
        <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}
            className="overflow-hidden rounded-2xl border border-[#DBDBDB] bg-white shadow-xl w-full">
            <div className="flex items-center justify-between px-3 py-3 border-b border-[#EFEFEF]">
                <div className="flex items-center gap-2.5">
                    <div className="h-9 w-9 rounded-full p-[2px] bg-gradient-to-br from-[#FCAF45] via-[#E1306C] to-[#833AB4]">
                        <div className="h-full w-full rounded-full bg-white p-[2px]">
                            <div className="h-full w-full rounded-full bg-gradient-to-br from-[#FCAF45] via-[#E1306C] to-[#833AB4] flex items-center justify-center text-white font-bold text-xs">N</div>
                        </div>
                    </div>
                    <div>
                        <p className="text-[13px] font-semibold text-[#262626] leading-4">newsagent</p>
                        <p className="text-[11px] text-[#8E8E8E] truncate max-w-[220px]">{title}</p>
                    </div>
                </div>
                <button className="text-[#262626] p-1"><MoreHorizontal size={20} /></button>
            </div>
            <div className="aspect-square w-full overflow-hidden bg-[#FAFAFA]">
                {imageSrc ? (
                    <Image src={imageSrc} alt="Instagram post" width={470} height={470} className="h-full w-full object-cover" unoptimized />
                ) : (
                    <div className="h-full w-full bg-gradient-to-br from-[#FCAF45] via-[#E1306C] to-[#833AB4] opacity-10 flex items-center justify-center">
                        <span className="text-6xl">📷</span>
                    </div>
                )}
            </div>
            <div className="px-3 pt-3">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex gap-3">
                        <button className="hover:opacity-60 transition-opacity"><Heart size={24} className="text-[#262626]" strokeWidth={1.5} /></button>
                        <button className="hover:opacity-60 transition-opacity"><MessageCircle size={24} className="text-[#262626]" strokeWidth={1.5} /></button>
                        <button className="hover:opacity-60 transition-opacity"><Share2 size={24} className="text-[#262626]" strokeWidth={1.5} /></button>
                    </div>
                    <button className="hover:opacity-60 transition-opacity"><Bookmark size={24} className="text-[#262626]" strokeWidth={1.5} /></button>
                </div>
                <div className="text-[14px] text-[#262626] leading-[1.5]">
                    <span className="font-semibold mr-1">newsagent</span>
                    <span className="whitespace-pre-wrap">{visibleCaption}</span>
                    {needsTruncation && !expanded && (
                        <button onClick={() => setExpanded(true)} className="text-[#8E8E8E] ml-1 hover:text-[#262626]">more</button>
                    )}
                </div>
                {hashtagLine && <p className="mt-1 text-[14px] text-[#00376B]">{hashtagLine}</p>}
                <p className="mt-1 mb-3 text-[10px] uppercase tracking-widest text-[#8E8E8E]">Just now</p>
            </div>
            <div className="border-t border-[#EFEFEF] flex items-center gap-3 px-3 py-2">
                <div className="h-6 w-6 rounded-full bg-gray-300 flex items-center justify-center text-white text-xs font-bold">U</div>
                <span className="text-[14px] text-[#8E8E8E]">Add a comment…</span>
            </div>
        </div>
    );
}

// ─── Facebook Card ────────────────────────────────────────────────────────────
function FacebookPost({ post, imageSrc, title }: { post: string; imageSrc: string | null; title: string }) {
    const [expanded, setExpanded] = useState(false);
    const PREVIEW_CHARS = 250;
    const needsTruncation = post.length > PREVIEW_CHARS;
    const visiblePost = expanded || !needsTruncation ? post : post.slice(0, PREVIEW_CHARS) + "…";

    return (
        <div style={{ fontFamily: "'Helvetica Neue', Arial, sans-serif" }}
            className="overflow-hidden rounded-2xl bg-white shadow-xl w-full border border-[#E4E6EB]">
            <div className="flex items-center gap-2 px-4 pt-4 pb-3">
                <div className="h-10 w-10 rounded-full bg-[#1877F2] flex items-center justify-center text-white font-bold text-sm">N</div>
                <div className="flex-1 min-w-0">
                    <p className="text-[15px] font-semibold text-[#050505]">News Agent</p>
                    <p className="text-[12px] text-[#65676B] truncate">{title}</p>
                    <div className="flex items-center gap-1">
                        <span className="text-[13px] text-[#65676B]">Just now ·</span>
                        <Globe size={12} className="text-[#65676B]" />
                    </div>
                </div>
                <button className="text-[#65676B] rounded-full hover:bg-[#F2F2F2] p-2"><MoreHorizontal size={20} /></button>
            </div>
            <div className="px-4 pb-3">
                <p className="text-[15px] text-[#050505] whitespace-pre-wrap leading-[1.52]">{visiblePost}</p>
                {needsTruncation && !expanded && (
                    <button onClick={() => setExpanded(true)} className="text-[#65676B] text-[15px] font-semibold mt-0.5 hover:underline">See more</button>
                )}
            </div>
            {imageSrc && (
                <div className="overflow-hidden w-full bg-[#F0F2F5]">
                    <Image src={imageSrc} alt="Facebook post" width={500} height={500} className="w-full object-cover" unoptimized />
                </div>
            )}
            <div className="px-4 pt-3 pb-1 flex items-center justify-between text-[13px] text-[#65676B]">
                <span>👍 ❤️ 😮 1.2K</span>
                <div className="flex gap-3">
                    <span className="hover:underline cursor-pointer">84 comments</span>
                    <span className="hover:underline cursor-pointer">312 shares</span>
                </div>
            </div>
            <div className="mx-4 border-t border-[#E4E6EB] mt-1 py-1 flex">
                {[{ icon: ThumbsUp, label: "Like" }, { icon: MessageCircle, label: "Comment" }, { icon: Share2, label: "Share" }].map(({ icon: Icon, label }) => (
                    <button key={label} className="flex flex-1 items-center justify-center gap-2 py-2 rounded-lg text-[15px] font-medium text-[#65676B] hover:bg-[#F2F2F2]">
                        <Icon size={18} strokeWidth={1.5} />{label}
                    </button>
                ))}
            </div>
        </div>
    );
}

// ─── Platform tab config ──────────────────────────────────────────────────────
const PLATFORMS = [
    {
        key: "twitter" as const,
        label: "X",
        activeClass: "bg-black text-white",
        inactiveClass: "bg-white text-gray-700 hover:bg-gray-50",
        icon: (active: boolean) => (
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${active ? "fill-white" : "fill-black"}`}>
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.74l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
        ),
    },
    {
        key: "instagram" as const,
        label: "Instagram",
        activeClass: "bg-gradient-to-r from-[#FCAF45] via-[#E1306C] to-[#833AB4] text-white",
        inactiveClass: "bg-white text-gray-700 hover:bg-gray-50",
        icon: (active: boolean) => (
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${active ? "fill-white" : "fill-[#E1306C]"}`}>
                <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
            </svg>
        ),
    },
    {
        key: "facebook" as const,
        label: "Facebook",
        activeClass: "bg-[#1877F2] text-white",
        inactiveClass: "bg-white text-gray-700 hover:bg-gray-50",
        icon: (active: boolean) => (
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${active ? "fill-white" : "fill-[#1877F2]"}`}>
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
            </svg>
        ),
    },
] as const;

type Platform = typeof PLATFORMS[number]["key"];

function formatPKT(dateStr: string) {
    return new Date(dateStr).toLocaleString("en-PK", {
        timeZone: "Asia/Karachi", hour12: false,
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
}

// ─── Publish Status Badge ─────────────────────────────────────────────────────
const PLATFORM_META = [
    { key: "twitter", label: "X", color: "bg-black" },
    { key: "instagram", label: "IG", color: "bg-gradient-to-br from-[#FCAF45] via-[#E1306C] to-[#833AB4]" },
    { key: "facebook", label: "FB", color: "bg-[#1877F2]" },
];

function PublishStatusIcons({ publishedTo }: { publishedTo: Record<string, boolean> }) {
    const published = PLATFORM_META.filter((p) => publishedTo[p.key]);
    if (!published.length) return null;
    return (
        <div className="flex items-center gap-1">
            {published.map((p) => (
                <span key={p.key} title={`Published to ${p.label}`}
                    className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white ${p.color}`}>
                    <CheckCircle2 size={9} />{p.label}
                </span>
            ))}
        </div>
    );
}

// ─── Publish / Repost Button ──────────────────────────────────────────────────
function PublishButton({
    post,
    enabledPlatforms,
    onPublished,
}: {
    post: PostData;
    enabledPlatforms: string[];
    onPublished: (postId: string, publishedTo: Record<string, boolean>) => void;
}) {
    const [publishing, setPublishing] = useState(false);
    const [results, setResults] = useState<Record<string, PublishResult> | null>(null);
    const [showResults, setShowResults] = useState(false);
    const [showRepost, setShowRepost] = useState(false);
    const [selectedRepost, setSelectedRepost] = useState<string[]>([]);

    const unpublished = enabledPlatforms.filter((p) => !post.published_to[p]);
    const allPublished = unpublished.length === 0 && enabledPlatforms.length > 0;

    const doPublish = async (platforms: string[]) => {
        if (!platforms.length) return;
        setPublishing(true);
        setResults(null);
        setShowRepost(false);
        try {
            const res = await fetch("/api/publish", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ post_id: post.id, platforms }),
            });
            const json = await res.json();
            setResults(json.results || {});
            setShowResults(true);
            if (json.published_to) onPublished(post.id, json.published_to);
        } catch {
            setResults({ error: { success: false, error: "Network error" } });
            setShowResults(true);
        } finally {
            setPublishing(false);
            setTimeout(() => setShowResults(false), 6000);
        }
    };

    const toggleRepostPlatform = (key: string) =>
        setSelectedRepost((prev) =>
            prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
        );

    if (enabledPlatforms.length === 0) return null;

    return (
        <div className="relative">
            <div className="flex items-center gap-1">
                {/* Primary action button */}
                <button
                    onClick={() => !allPublished && doPublish(unpublished)}
                    disabled={publishing || allPublished}
                    className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-semibold transition-all
                        ${allPublished
                            ? "bg-green-100 text-green-700 cursor-default"
                            : publishing
                                ? "bg-blue-100 text-blue-600 cursor-wait"
                                : "bg-blue-600 text-white hover:bg-blue-700 shadow-sm"
                        }`}
                    title={allPublished ? "Published to all platforms" : `Publish to: ${unpublished.join(", ")}`}
                >
                    {publishing ? <Loader2 size={12} className="animate-spin" />
                        : allPublished ? <CheckCircle2 size={12} />
                            : <Send size={12} />}
                    {publishing ? "Posting…" : allPublished ? "Published" : "Approve"}
                </button>

                {/* Repost dropdown trigger */}
                {enabledPlatforms.length > 0 && (
                    <button
                        onClick={() => {
                            setShowRepost((s) => !s);
                            setSelectedRepost([...enabledPlatforms]);
                        }}
                        disabled={publishing}
                        title="Repost to platforms"
                        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition-all disabled:opacity-40"
                    >
                        <RefreshCcw size={11} />
                        Repost
                    </button>
                )}
            </div>

            {/* Repost dropdown */}
            {showRepost && (
                <div className="absolute right-0 top-full mt-1.5 z-30 rounded-xl border bg-white shadow-2xl text-[12px] w-52 p-3">
                    <p className="font-semibold text-gray-700 mb-2 text-[11px] uppercase tracking-wide">Select platforms to repost:</p>
                    <div className="space-y-1.5 mb-3">
                        {PLATFORM_META.filter((p) => enabledPlatforms.includes(p.key)).map((p) => (
                            <label key={p.key} className="flex items-center gap-2 cursor-pointer px-2 py-1.5 rounded-lg hover:bg-gray-50">
                                <input
                                    type="checkbox"
                                    checked={selectedRepost.includes(p.key)}
                                    onChange={() => toggleRepostPlatform(p.key)}
                                    className="rounded"
                                />
                                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold text-white ${p.color}`}>
                                    {p.label}
                                </span>
                                {post.published_to[p.key] && (
                                    <span className="text-[10px] text-green-600 ml-auto">✓ posted</span>
                                )}
                            </label>
                        ))}
                    </div>
                    <div className="flex gap-1.5">
                        <button
                            onClick={() => doPublish(selectedRepost)}
                            disabled={!selectedRepost.length || publishing}
                            className="flex-1 flex items-center justify-center gap-1 rounded-lg bg-blue-600 text-white px-2 py-1.5 font-semibold hover:bg-blue-700 disabled:opacity-40 transition-all"
                        >
                            <Send size={11} />Post Now
                        </button>
                        <button
                            onClick={() => setShowRepost(false)}
                            className="rounded-lg border px-3 py-1.5 text-gray-600 hover:bg-gray-50"
                        >
                            ✕
                        </button>
                    </div>
                </div>
            )}

            {/* Results toast */}
            {showResults && results && (
                <div className="absolute right-0 top-full mt-1 z-20 rounded-lg border bg-white shadow-xl text-[12px] w-56 p-2 space-y-1">
                    <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide px-1 mb-1">Publish results</p>
                    {Object.entries(results).map(([platform, r]) => (
                        <div key={platform} className={`flex items-start gap-1.5 px-2 py-1.5 rounded ${r.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
                            {r.success ? <CheckCircle2 size={11} className="mt-0.5 shrink-0" /> : <XCircle size={11} className="mt-0.5 shrink-0" />}
                            <span>
                                <span className="font-semibold capitalize">{platform}: </span>
                                <span className="break-words">{r.success ? "Posted!" : r.error}</span>
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function PostsPage() {
    const [posts, setPosts] = useState<PostData[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<Platform>("twitter");
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [enabledPlatforms, setEnabledPlatforms] = useState<string[]>([]);
    const [autoPublish, setAutoPublish] = useState(false);
    const [autoPublishSince, setAutoPublishSince] = useState<string | null>(null);
    const autoPublishRanRef = useRef(false);

    const fetchPosts = useCallback(async () => {
        setLoading(true);
        setError(null);
        setConfirmDeleteId(null);
        try {
            const [postsRes, settingsRes] = await Promise.all([
                fetch("/api/posts", { cache: "no-store" }),
                fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/agent_settings?select=key,value`, {
                    headers: {
                        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
                        Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""}`,
                    },
                    cache: "no-store",
                }),
            ]);
            const json = await postsRes.json();
            if (json.success) setPosts(json.posts);
            else setError(json.error);

            const settingsRows: { key: string; value: string }[] = await settingsRes.json();
            const settingsMap: Record<string, string> = {};
            for (const row of settingsRows ?? []) settingsMap[row.key] = row.value ?? "";

            const enabled: string[] = [];
            if (settingsMap.social_fb_enabled === "true") enabled.push("facebook");
            if (settingsMap.social_ig_enabled === "true") enabled.push("instagram");
            if (settingsMap.social_twitter_enabled === "true") enabled.push("twitter");
            setEnabledPlatforms(enabled);
            setAutoPublish(settingsMap.social_auto_publish === "true");
            // auto_publish_since: ISO timestamp set when user toggled ON — only publish posts after this time
            setAutoPublishSince(settingsMap.auto_publish_since ?? null);
        } catch {
            setError("Failed to fetch posts. Make sure the agent has run.");
        } finally {
            setLoading(false);
        }
    }, []);

    const handleDelete = useCallback(async (id: string) => {
        setDeletingId(id);
        try {
            const res = await fetch(`/api/posts/${id}`, { method: "DELETE" });
            const json = await res.json();
            if (json.success) await fetchPosts();
            else alert("Delete failed: " + json.error);
        } catch {
            alert("Unexpected error deleting post.");
        } finally {
            setDeletingId(null);
            setConfirmDeleteId(null);
        }
    }, [fetchPosts]);

    const handlePublished = useCallback((postId: string, publishedTo: Record<string, boolean>) => {
        setPosts((prev) => prev.map((p) => p.id === postId ? { ...p, published_to: publishedTo } : p));
    }, []);

    useEffect(() => { fetchPosts(); }, [fetchPosts]);

    // Auto-publish: only publish posts created AFTER auto_publish_since (set when toggle was turned ON)
    useEffect(() => {
        if (!autoPublish || loading || posts.length === 0 || enabledPlatforms.length === 0) return;
        if (autoPublishRanRef.current) return;
        autoPublishRanRef.current = true;

        // Only publish posts created after the toggle-on timestamp (or all if no timestamp set)
        const cutoff = autoPublishSince ? new Date(autoPublishSince).getTime() : null;
        const unpublishedPosts = posts.filter((p) => {
            const postTime = new Date(p.created_at).getTime();
            // Respect the cutoff: skip posts created before auto-publish was enabled
            if (cutoff && postTime < cutoff) return false;
            return enabledPlatforms.some((platform) => !p.published_to[platform]);
        });
        if (!unpublishedPosts.length) return;

        unpublishedPosts.forEach(async (post) => {
            const platforms = enabledPlatforms.filter((pl) => !post.published_to[pl]);
            if (!platforms.length) return;
            try {
                const res = await fetch("/api/publish", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ post_id: post.id, platforms }),
                });
                const json = await res.json();
                if (json.published_to) handlePublished(post.id, json.published_to);
            } catch { }
        });
    }, [autoPublish, autoPublishSince, loading, posts, enabledPlatforms, handlePublished]);

    const visiblePosts = posts.filter((p) => p[activeTab]?.trim());

    return (
        <div className="min-h-screen bg-[#F0F2F5]">
            {/* Header */}
            <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/95 backdrop-blur-md shadow-sm">
                <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 flex-wrap">
                    <Link href="/"><Button variant="ghost" size="sm" className="gap-2 text-gray-600"><ArrowLeft size={16} />Back</Button></Link>
                    <div className="h-5 w-px bg-gray-200" />
                    <h1 className="text-[15px] font-bold text-gray-900 shrink-0">Social Media Posts</h1>
                    <span className="text-[13px] text-gray-400 shrink-0">({posts.length} stories)</span>

                    {/* Platform tabs */}
                    <div className="flex gap-2 ml-4 flex-1 flex-wrap">
                        {PLATFORMS.map((p) => {
                            const active = activeTab === p.key;
                            const count = posts.filter((post) => post[p.key]?.trim()).length;
                            return (
                                <button
                                    key={p.key}
                                    onClick={() => setActiveTab(p.key)}
                                    className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-[13px] font-semibold border transition-all ${active ? p.activeClass + " border-transparent shadow" : p.inactiveClass + " border-gray-200"}`}
                                >
                                    {p.icon(active)}
                                    {p.label}
                                    <span className={`text-[11px] rounded-full px-1.5 py-0.5 ${active ? "bg-white/20" : "bg-gray-100 text-gray-500"}`}>{count}</span>
                                </button>
                            );
                        })}
                    </div>

                    <div className="flex items-center gap-2 ml-auto shrink-0">
                        {autoPublish && (
                            <span className="flex items-center gap-1 rounded-full bg-purple-100 px-2 py-1 text-[11px] font-semibold text-purple-700">
                                <Send size={10} />Auto-publish ON
                            </span>
                        )}
                        <Link href="/posts/settings">
                            <Button variant="outline" size="sm" className="gap-1.5 text-gray-600 text-[13px]">
                                <Settings size={13} />Settings
                            </Button>
                        </Link>
                        <Button variant="outline" size="sm" onClick={fetchPosts} disabled={loading} className="gap-1.5 text-gray-600 text-[13px]">
                            <RefreshCcw size={13} className={loading ? "animate-spin" : ""} />Refresh
                        </Button>
                    </div>
                </div>
            </header>

            <main className="mx-auto max-w-5xl px-4 py-8">
                {loading && (
                    <div className="flex min-h-[400px] items-center justify-center">
                        <div className="text-center">
                            <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
                            <p className="text-gray-500 text-[14px]">Loading posts…</p>
                        </div>
                    </div>
                )}

                {error && !loading && (
                    <div className="flex min-h-[400px] items-center justify-center">
                        <div className="text-center rounded-2xl border border-dashed border-gray-300 bg-white p-12 shadow-sm">
                            <p className="text-5xl mb-4">📭</p>
                            <h2 className="text-xl font-semibold text-gray-700 mb-2">No posts yet</h2>
                            <p className="text-gray-500 text-[14px] mb-6">{error}</p>
                            <Link href="/"><Button>Run the Agent →</Button></Link>
                        </div>
                    </div>
                )}

                {!loading && !error && visiblePosts.length === 0 && (
                    <div className="flex min-h-[300px] items-center justify-center">
                        <p className="text-gray-400 text-[15px]">No {PLATFORMS.find(p => p.key === activeTab)?.label} posts yet.</p>
                    </div>
                )}

                {!loading && visiblePosts.length > 0 && (
                    <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-2">
                        {visiblePosts.map((post) => {
                            const title = cleanTitle(post.title);
                            return (
                                <div key={`${activeTab}-${post.id}`} className="flex flex-col gap-2">
                                    {/* Story info bar */}
                                    <div className="flex items-start justify-between px-1">
                                        <div className="flex-1 min-w-0">
                                            <p className="text-[11px] text-gray-400 font-mono">{formatPKT(post.created_at)} PKT</p>
                                            <p className="text-[13px] font-semibold text-gray-800 line-clamp-2">{title}</p>
                                            {post.sources?.length > 0 && (
                                                <div className="flex flex-wrap gap-1 mt-1">
                                                    {post.sources.map((s, i) => (
                                                        <span key={i} className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">{s}</span>
                                                    ))}
                                                </div>
                                            )}
                                            <div className="mt-1">
                                                <PublishStatusIcons publishedTo={post.published_to} />
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1 ml-2 shrink-0">
                                            <PublishButton
                                                post={post}
                                                enabledPlatforms={enabledPlatforms}
                                                onPublished={handlePublished}
                                            />
                                            {post.image_url && (
                                                <a href={post.image_url} download="social_post.jpg"
                                                    className="flex items-center gap-1 rounded-lg bg-gray-800 px-2 py-1 text-[11px] font-medium text-white hover:bg-gray-600">
                                                    <Download size={11} />Img
                                                </a>
                                            )}
                                            {confirmDeleteId === post.id ? (
                                                <div className="flex items-center gap-1">
                                                    <button onClick={() => handleDelete(post.id)} disabled={!!deletingId}
                                                        className="rounded bg-red-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-red-700 disabled:opacity-50">
                                                        {deletingId === post.id ? "…" : "Yes"}
                                                    </button>
                                                    <button onClick={() => setConfirmDeleteId(null)}
                                                        className="rounded px-2 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-100">No</button>
                                                </div>
                                            ) : (
                                                <button onClick={() => setConfirmDeleteId(post.id)}
                                                    className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors">
                                                    <Trash2 size={13} />
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Styled card */}
                                    {activeTab === "twitter" && <TwitterPost post={post.twitter} imageSrc={post.image_url} title={title} />}
                                    {activeTab === "instagram" && <InstagramPost post={post.instagram} imageSrc={post.image_url} title={title} />}
                                    {activeTab === "facebook" && <FacebookPost post={post.facebook} imageSrc={post.image_url} title={title} />}
                                </div>
                            );
                        })}
                    </div>
                )}
            </main>
        </div>
    );
}
