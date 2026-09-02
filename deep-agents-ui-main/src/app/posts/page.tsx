"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import {
    RefreshCcw, ArrowLeft, Heart, MessageCircle, Repeat2,
    Bookmark, Share2, ThumbsUp, MoreHorizontal, Globe,
    Settings, CheckCircle2, Loader2, XCircle, Play, Tag, Volume2, VolumeX,
    Maximize2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { PluginGate } from "@/app/components/settings/PluginsSection";

interface PostData {
    id: string;
    created_at: string;
    title: string;
    twitter: string;
    instagram: string;
    facebook: string;
    youtube?: string;
    instagram_data?: Record<string, any> | null;
    facebook_data?: Record<string, any> | null;
    youtube_data?: Record<string, any> | null;
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

// Helper: Convert local path or remote URL into streamable URL
function getMediaStreamUrl(urlOrPath?: string | null): string | null {
    if (!urlOrPath) return null;
    const trimmed = urlOrPath.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        // If external web URL that is an image/video, can load directly, or stream if it has special characters
        return trimmed;
    }
    // Local filesystem path (Windows or Unix)
    return `/api/media/stream?path=${encodeURIComponent(trimmed)}`;
}

function isVideoMedia(urlOrPath?: string | null, mediaType?: string): boolean {
    if (mediaType === "video" || mediaType === "reel") return true;
    if (!urlOrPath) return false;
    const lower = urlOrPath.toLowerCase();
    return lower.endsWith(".mp4") || lower.endsWith(".mov") || lower.endsWith(".webm") || lower.endsWith(".mkv") || lower.includes("video");
}

// Strip the "Social Media Posts: " prefix agents sometimes add
function cleanTitle(t: string) {
    return t.replace(/^social\s+media\s+posts?:\s*/i, "").trim();
}

// ─── Realtime Interactive Video Player Component ─────────────────────────────
function VideoPlayer({
    src,
    poster,
    className = "",
}: {
    src: string;
    poster?: string | null;
    className?: string;
}) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const streamUrl = getMediaStreamUrl(src);

    if (!streamUrl) return null;

    return (
        <div className={`relative overflow-hidden bg-black group rounded-xl shadow-md flex items-center justify-center ${className}`}>
            <video
                ref={videoRef}
                src={streamUrl}
                poster={poster ? (getMediaStreamUrl(poster) || undefined) : undefined}
                controls
                playsInline
                preload="metadata"
                className="w-full h-full max-h-[460px] object-contain bg-black"
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
            />
        </div>
    );
}

// ─── X / Twitter Card ────────────────────────────────────────────────────────
function TwitterPost({ post, imageSrc, title }: { post: string; imageSrc: string | null; title: string }) {
    const cleanPost = post.replace(/\*Character count:.*?\*\s*/gi, "").replace(/^---+\s*/gm, "").trim();
    const mediaStream = getMediaStreamUrl(imageSrc);
    const isVideo = isVideoMedia(imageSrc);

    return (
        <div style={{ fontFamily: "'TwitterChirp', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}
            className="overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-xl w-full">
            <div className="flex gap-3 px-4 pt-4 pb-2">
                <div className="shrink-0">
                    <div className="h-10 w-10 rounded-full bg-primary flex items-center justify-center font-bold text-primary-foreground text-base">N</div>
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 flex-wrap">
                        <span className="font-bold text-[15px]">News Agent</span>
                        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] fill-primary">
                            <path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.27 2.52-.81 3.91C2.63 9.33 1.75 10.57 1.75 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.27 3.91.81c.66 1.31 1.91 2.19 3.34 2.19s2.67-.88 3.34-2.19c1.39.46 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z" />
                        </svg>
                        <span className="text-muted-foreground text-[14px]">@newsagent · Just now</span>
                    </div>
                    <p className="text-[12px] text-muted-foreground/80 italic mb-1 mt-0.5 truncate">{title}</p>
                    <p className="mt-1 text-[15px] leading-[1.5] text-foreground whitespace-pre-wrap break-words">{cleanPost}</p>
                    
                    {mediaStream && (
                        <div className="mt-3 overflow-hidden rounded-2xl border border-border w-full">
                            {isVideo ? (
                                <VideoPlayer src={imageSrc!} />
                            ) : (
                                <Image src={mediaStream} alt="Post image" width={600} height={338} className="w-full object-cover" unoptimized />
                            )}
                        </div>
                    )}
                    <div className="mt-3 flex items-center justify-between text-muted-foreground max-w-[425px]">
                        {[MessageCircle, Repeat2, Heart, Bookmark, Share2].map((Icon, i) => (
                            <button key={i} className="rounded-full p-2 hover:bg-accent transition-colors"><Icon size={18} strokeWidth={1.5} /></button>
                        ))}
                    </div>
                </div>
                <button className="shrink-0 self-start text-muted-foreground hover:text-foreground p-1 rounded-full hover:bg-accent"><MoreHorizontal size={18} /></button>
            </div>
            <div className="border-t border-border mx-4" />
            <div className="flex items-center gap-3 px-4 py-3 text-muted-foreground text-[14px]">
                <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold">U</div>
                <span>Post your reply</span>
            </div>
        </div>
    );
}

// ─── Instagram Card ───────────────────────────────────────────────────────────
function InstagramPost({ post, imageSrc, title, rawData }: { post: string; imageSrc: string | null; title: string; rawData?: any }) {
    const [expanded, setExpanded] = useState(false);
    const mediaType = rawData?.media_type || (imageSrc ? "photo" : "reel");
    const videoUrl = rawData?.media_url || (isVideoMedia(imageSrc, mediaType) ? imageSrc : null);
    const isReel = mediaType === "reel" || mediaType === "video" || !!videoUrl;
    const coverSrc = rawData?.cover_url || imageSrc;
    const lines = post.split("\n");
    const captionLines = lines.filter((l) => !l.trim().startsWith("#")).join("\n").trim();
    const hashtagLine = lines.filter((l) => l.trim().startsWith("#")).join(" ").trim();
    const PREVIEW_CHARS = 125;
    const needsTruncation = captionLines.length > PREVIEW_CHARS;
    const visibleCaption = expanded || !needsTruncation ? captionLines : captionLines.slice(0, PREVIEW_CHARS) + "…";

    return (
        <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}
            className="overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-xl w-full">
            <div className="flex items-center justify-between px-3 py-3 border-b border-border">
                <div className="flex items-center gap-2.5">
                    <div className="h-9 w-9 rounded-full p-[2px] bg-gradient-to-br from-[#FCAF45] via-[#E1306C] to-[#833AB4]">
                        <div className="h-full w-full rounded-full bg-card p-[2px]">
                            <div className="h-full w-full rounded-full bg-gradient-to-br from-[#FCAF45] via-[#E1306C] to-[#833AB4] flex items-center justify-center text-white font-bold text-xs">N</div>
                        </div>
                    </div>
                    <div>
                        <div className="flex items-center gap-1.5">
                            <p className="text-[13px] font-semibold text-foreground leading-4">newsagent</p>
                            {isReel && (
                                <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-pink-500/10 text-pink-500">Reel</span>
                            )}
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate max-w-[220px]">{title}</p>
                    </div>
                </div>
                <button className="text-foreground p-1"><MoreHorizontal size={20} /></button>
            </div>

            {/* Video Player or Image */}
            <div className="w-full bg-black relative flex items-center justify-center min-h-[300px]">
                {videoUrl ? (
                    <VideoPlayer src={videoUrl} poster={coverSrc} className="w-full aspect-square sm:aspect-[4/5]" />
                ) : coverSrc ? (
                    <div className="aspect-square w-full relative">
                        <Image src={getMediaStreamUrl(coverSrc)!} alt="Instagram post" fill className="object-cover" unoptimized />
                    </div>
                ) : (
                    <div className="h-64 w-full bg-gradient-to-br from-[#FCAF45] via-[#E1306C] to-[#833AB4] opacity-10 flex items-center justify-center">
                        <span className="text-6xl">{isReel ? "🎬" : "📷"}</span>
                    </div>
                )}
            </div>

            <div className="px-3 pt-3">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex gap-3">
                        <button className="hover:opacity-60 transition-opacity"><Heart size={24} className="text-foreground" strokeWidth={1.5} /></button>
                        <button className="hover:opacity-60 transition-opacity"><MessageCircle size={24} className="text-foreground" strokeWidth={1.5} /></button>
                        <button className="hover:opacity-60 transition-opacity"><Share2 size={24} className="text-foreground" strokeWidth={1.5} /></button>
                    </div>
                    <button className="hover:opacity-60 transition-opacity"><Bookmark size={24} className="text-foreground" strokeWidth={1.5} /></button>
                </div>
                <div className="text-[14px] text-foreground leading-[1.5]">
                    <span className="font-semibold mr-1">newsagent</span>
                    <span className="whitespace-pre-wrap">{visibleCaption}</span>
                    {needsTruncation && !expanded && (
                        <button onClick={() => setExpanded(true)} className="text-muted-foreground ml-1 hover:text-foreground">more</button>
                    )}
                </div>
                {hashtagLine && <p className="mt-1 text-[14px] text-primary">{hashtagLine}</p>}
                <p className="mt-1 mb-3 text-[10px] uppercase tracking-widest text-muted-foreground">Just now</p>
            </div>
            <div className="border-t border-border flex items-center gap-3 px-3 py-2">
                <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-muted-foreground text-xs font-bold">U</div>
                <span className="text-[14px] text-muted-foreground">Add a comment…</span>
            </div>
        </div>
    );
}

// ─── Facebook Card ────────────────────────────────────────────────────────────
function FacebookPost({ post, imageSrc, title, rawData }: { post: string; imageSrc: string | null; title: string; rawData?: any }) {
    const [expanded, setExpanded] = useState(false);
    const mediaType = rawData?.media_type || (imageSrc ? "photo" : "text");
    const videoUrl = rawData?.media_url || (isVideoMedia(imageSrc, mediaType) ? imageSrc : null);
    const isVideo = mediaType === "video" || !!videoUrl;
    const PREVIEW_CHARS = 250;
    const needsTruncation = post.length > PREVIEW_CHARS;
    const visiblePost = expanded || !needsTruncation ? post : post.slice(0, PREVIEW_CHARS) + "…";

    return (
        <div style={{ fontFamily: "'Helvetica Neue', Arial, sans-serif" }}
            className="overflow-hidden rounded-2xl bg-card shadow-xl w-full border border-border">
            <div className="flex items-center gap-2 px-4 pt-4 pb-3">
                <div className="h-10 w-10 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm">N</div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <p className="text-[15px] font-semibold text-foreground">News Agent</p>
                        {isVideo && (
                            <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500">Video</span>
                        )}
                    </div>
                    <p className="text-[12px] text-muted-foreground truncate">{title}</p>
                    <div className="flex items-center gap-1">
                        <span className="text-[13px] text-muted-foreground">Just now ·</span>
                        <Globe size={12} className="text-muted-foreground" />
                    </div>
                </div>
                <button className="text-muted-foreground rounded-full hover:bg-accent p-2"><MoreHorizontal size={20} /></button>
            </div>
            <div className="px-4 pb-3">
                <p className="text-[15px] text-foreground whitespace-pre-wrap leading-[1.52]">{visiblePost}</p>
                {needsTruncation && !expanded && (
                    <button onClick={() => setExpanded(true)} className="text-muted-foreground text-[15px] font-semibold mt-0.5 hover:underline">See more</button>
                )}
            </div>

            {/* Video Player or Image */}
            {videoUrl ? (
                <div className="w-full bg-black overflow-hidden">
                    <VideoPlayer src={videoUrl} poster={imageSrc} className="w-full aspect-video" />
                </div>
            ) : imageSrc ? (
                <div className="overflow-hidden w-full bg-muted/20 relative aspect-video">
                    <Image src={getMediaStreamUrl(imageSrc)!} alt="Facebook post" fill className="object-cover" unoptimized />
                </div>
            ) : null}

            <div className="px-4 pt-3 pb-1 flex items-center justify-between text-[13px] text-muted-foreground">
                <span>👍 ❤️ 😮 1.2K</span>
                <div className="flex gap-3">
                    <span className="hover:underline cursor-pointer">84 comments</span>
                    <span className="hover:underline cursor-pointer">312 shares</span>
                </div>
            </div>
            <div className="mx-4 border-t border-border mt-1 py-1 flex">
                {[{ icon: ThumbsUp, label: "Like" }, { icon: MessageCircle, label: "Comment" }, { icon: Share2, label: "Share" }].map(({ icon: Icon, label }) => (
                    <button key={label} className="flex flex-1 items-center justify-center gap-2 py-2 rounded-lg text-[15px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
                        <Icon size={18} strokeWidth={1.5} />{label}
                    </button>
                ))}
            </div>
        </div>
    );
}

// ─── YouTube Card ─────────────────────────────────────────────────────────────
function YouTubePost({ post, imageSrc, title, rawData }: { post: string; imageSrc: string | null; title: string; rawData?: any }) {
    const [expanded, setExpanded] = useState(false);
    const ytTitle = rawData?.title || title;
    const ytDesc = rawData?.description || post;
    const videoUrl = rawData?.video_url || (isVideoMedia(imageSrc) ? imageSrc : null);
    const thumbnailUrl = rawData?.thumbnail_url || imageSrc;
    const tags = rawData?.tags || [];
    const privacy = rawData?.privacy_status || "public";
    const isShorts = ytTitle.toLowerCase().includes("#shorts") || ytDesc.toLowerCase().includes("#shorts");

    return (
        <div style={{ fontFamily: "'Roboto', sans-serif" }}
            className="overflow-hidden rounded-2xl bg-card shadow-xl w-full border border-border">
            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border/50">
                <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-full bg-[#FF0000] flex items-center justify-center text-white shadow-sm">
                        <svg viewBox="0 0 24 24" className="h-5 w-5 fill-white">
                            <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                        </svg>
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <p className="text-[14px] font-bold text-foreground">News Channel</p>
                            {isShorts ? (
                                <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-red-500/10 text-red-500">Shorts</span>
                            ) : (
                                <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-muted text-muted-foreground">Video</span>
                            )}
                            <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                                {privacy}
                            </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground">Scheduled for YouTube Upload</p>
                    </div>
                </div>
            </div>

            {/* Video Player or Thumbnail */}
            <div className="w-full bg-black relative overflow-hidden flex items-center justify-center">
                {videoUrl ? (
                    <VideoPlayer src={videoUrl} poster={thumbnailUrl} className="w-full aspect-video" />
                ) : thumbnailUrl ? (
                    <div className="w-full aspect-video relative">
                        <Image src={getMediaStreamUrl(thumbnailUrl)!} alt="YouTube thumbnail" fill className="object-cover" unoptimized />
                    </div>
                ) : (
                    <div className="w-full aspect-video bg-zinc-900 flex flex-col items-center justify-center text-zinc-500">
                        <Play size={40} className="mb-2 opacity-50" />
                        <span className="text-xs">No video or thumbnail attached</span>
                    </div>
                )}
            </div>

            {/* Video Details */}
            <div className="p-4 space-y-3">
                <div>
                    <h3 className="font-bold text-[16px] text-foreground leading-snug">{ytTitle}</h3>
                </div>

                <div className="bg-muted/40 rounded-xl p-3 border border-border/50 text-[13px] leading-relaxed">
                    <p className="whitespace-pre-wrap text-foreground/90">
                        {expanded || ytDesc.length <= 160 ? ytDesc : ytDesc.slice(0, 160) + "..."}
                    </p>
                    {ytDesc.length > 160 && (
                        <button onClick={() => setExpanded(!expanded)} className="text-primary font-semibold text-xs mt-1 hover:underline">
                            {expanded ? "Show less" : "Show more"}
                        </button>
                    )}
                </div>

                {/* Tags */}
                {tags && tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                        {tags.map((tag: string, i: number) => (
                            <span key={i} className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                                <Tag size={10} /> #{tag.replace(/^#/, "")}
                            </span>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Platform tab config ──────────────────────────────────────────────────────
const PLATFORMS = [
    {
        key: "all" as const,
        label: "All Channels",
        activeClass: "bg-primary text-primary-foreground",
        inactiveClass: "bg-card text-muted-foreground hover:bg-accent hover:text-foreground border-border",
        icon: (active: boolean) => <Globe size={14} className={active ? "text-primary-foreground" : "text-muted-foreground"} />,
    },
    {
        key: "youtube" as const,
        label: "YouTube",
        activeClass: "bg-[#FF0000] text-white",
        inactiveClass: "bg-card text-muted-foreground hover:bg-accent hover:text-foreground border-border",
        icon: (active: boolean) => (
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${active ? "fill-white" : "fill-current"}`}>
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
            </svg>
        ),
    },
    {
        key: "instagram" as const,
        label: "Instagram",
        activeClass: "bg-gradient-to-r from-[#FCAF45] via-[#E1306C] to-[#833AB4] text-white",
        inactiveClass: "bg-card text-muted-foreground hover:bg-accent hover:text-foreground border-border",
        icon: (active: boolean) => (
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${active ? "fill-white" : "fill-current"}`}>
                <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
            </svg>
        ),
    },
    {
        key: "facebook" as const,
        label: "Facebook",
        activeClass: "bg-[#1877F2] text-white",
        inactiveClass: "bg-card text-muted-foreground hover:bg-accent hover:text-foreground border-border",
        icon: (active: boolean) => (
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${active ? "fill-white" : "fill-current"}`}>
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
            </svg>
        ),
    },
    {
        key: "twitter" as const,
        label: "X",
        activeClass: "bg-foreground text-background dark:bg-foreground dark:text-background",
        inactiveClass: "bg-card text-muted-foreground hover:bg-accent hover:text-foreground border-border",
        icon: (active: boolean) => (
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${active ? "fill-background dark:fill-background" : "fill-current"}`}>
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.74l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
        ),
    },
] as const;

type Platform = typeof PLATFORMS[number]["key"];

const PLATFORM_META = [
    { key: "youtube", label: "YT", color: "bg-[#FF0000]" },
    { key: "instagram", label: "IG", color: "bg-gradient-to-br from-[#FCAF45] via-[#E1306C] to-[#833AB4]" },
    { key: "facebook", label: "FB", color: "bg-[#1877F2]" },
    { key: "twitter", label: "X", color: "bg-black" },
];

function PublishStatusIcons({ publishedTo }: { publishedTo: Record<string, boolean> }) {
    const published = PLATFORM_META.filter((p) => publishedTo && publishedTo[p.key]);
    if (!published.length) return null;
    return (
        <div className="flex items-center gap-1">
            {published.map((p) => (
                <span key={p.key} title={`Published to ${p.label}`}
                    className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white ${p.color}`}>
                    <CheckCircle2 size={9} /> {p.label}
                </span>
            ))}
        </div>
    );
}

// ─── Publish Button Component ─────────────────────────────────────────────────
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

    const availablePlatforms = enabledPlatforms.filter((p) => {
        if (p === "youtube") return !!(post.youtube_data || post.youtube);
        if (p === "instagram") return !!(post.instagram_data || post.instagram);
        if (p === "facebook") return !!(post.facebook_data || post.facebook);
        if (p === "twitter") return !!post.twitter;
        return true;
    });

    const unpublished = availablePlatforms.filter((p) => !post.published_to?.[p]);
    const allPublished = unpublished.length === 0 && availablePlatforms.length > 0;

    const doPublish = async (platforms: string[]) => {
        if (!platforms.length) return;
        setPublishing(true);
        setResults(null);
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
        }
    };

    return (
        <div className="relative flex items-center gap-2">
            <Button
                variant={allPublished ? "outline" : "default"}
                size="sm"
                onClick={() => doPublish(unpublished.length > 0 ? unpublished : availablePlatforms)}
                disabled={publishing}
                className="gap-1.5 text-xs font-semibold shadow-sm"
            >
                {publishing ? (
                    <Loader2 size={13} className="animate-spin" />
                ) : allPublished ? (
                    <CheckCircle2 size={13} className="text-emerald-500" />
                ) : (
                    <Share2 size={13} />
                )}
                {allPublished ? "Published" : "1-Click Publish"}
            </Button>

            {showResults && results && (
                <div className="absolute right-0 top-full mt-2 z-20 w-72 rounded-xl border border-border bg-card p-3 shadow-xl space-y-2 text-xs">
                    <div className="flex items-center justify-between font-bold text-foreground pb-1 border-b border-border">
                        <span>Publish Status</span>
                        <button onClick={() => setShowResults(false)} className="text-muted-foreground hover:text-foreground">✕</button>
                    </div>
                    {Object.entries(results).map(([plat, r]: any) => (
                        <div key={plat} className="flex items-center justify-between">
                            <span className="capitalize font-medium text-foreground">{plat}</span>
                            {r.success ? (
                                <span className="text-emerald-500 flex items-center gap-1 font-semibold">
                                    <CheckCircle2 size={12} /> Live
                                </span>
                            ) : (
                                <span className="text-destructive flex items-center gap-1 truncate max-w-[140px]" title={r.error}>
                                    <XCircle size={12} /> {r.error || "Failed"}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default function PostsPage() {
    const [posts, setPosts] = useState<PostData[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<Platform>("all");
    const [enabledPlatforms, setEnabledPlatforms] = useState<string[]>(["youtube", "instagram", "facebook", "twitter"]);

    const loadPosts = useCallback(async () => {
        setLoading(true);
        try {
            const [postsRes, settingsRes] = await Promise.all([
                fetch("/api/posts"),
                fetch("/api/agent-settings"),
            ]);

            if (postsRes.ok) {
                const data = await postsRes.json();
                setPosts(data.posts || []);
            }

            if (settingsRes.ok) {
                const settingsData = await settingsRes.json();
                const settingsMap: Record<string, string> = {};
                for (const row of settingsData.settings ?? []) settingsMap[row.key] = row.value ?? "";

                const enabled: string[] = [];
                if (settingsMap.social_youtube_enabled !== "false") enabled.push("youtube");
                if (settingsMap.social_ig_enabled !== "false") enabled.push("instagram");
                if (settingsMap.social_fb_enabled !== "false") enabled.push("facebook");
                if (settingsMap.social_twitter_enabled === "true") enabled.push("twitter");
                setEnabledPlatforms(enabled);
            }
        } catch (err) {
            console.error("Failed to load posts:", err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadPosts();
    }, [loadPosts]);

    const handlePublishedUpdate = (postId: string, publishedTo: Record<string, boolean>) => {
        setPosts((prev) =>
            prev.map((p) => (p.id === postId ? { ...p, published_to: { ...p.published_to, ...publishedTo } } : p))
        );
    };

    return (
        <PluginGate pluginKey="posts">
            <div className="min-h-screen bg-background text-foreground">
                <header className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur-md shadow-sm">
                    <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
                        <div className="flex items-center gap-3">
                            <Link href="/">
                                <Button variant="ghost" size="sm" className="gap-2 -ml-2 text-muted-foreground hover:text-foreground">
                                    <ArrowLeft size={16} />
                                    <span>Dashboard</span>
                                </Button>
                            </Link>
                            <div className="h-5 w-px bg-border hidden sm:block" />
                            <h1 className="text-lg font-bold tracking-tight">Social Posts Console</h1>
                        </div>

                        <div className="flex items-center gap-2">
                            <ThemeToggle />
                            <Button variant="outline" size="sm" onClick={loadPosts} className="gap-1.5 text-xs">
                                <RefreshCcw size={13} /> Refresh
                            </Button>
                            <Link href="/posts/settings">
                                <Button variant="outline" size="sm" className="gap-1.5 text-xs">
                                    <Settings size={13} /> Channels
                                </Button>
                            </Link>
                        </div>
                    </div>
                </header>

                <main className="mx-auto max-w-5xl px-4 py-6 space-y-6">
                    {/* Platform Filter Tabs */}
                    <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
                        {PLATFORMS.map((p) => {
                            const active = activeTab === p.key;
                            return (
                                <button
                                    key={p.key}
                                    onClick={() => setActiveTab(p.key)}
                                    className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold border transition-all shrink-0 ${
                                        active ? p.activeClass : p.inactiveClass
                                    }`}
                                >
                                    {p.icon(active)}
                                    <span>{p.label}</span>
                                </button>
                            );
                        })}
                    </div>

                    {/* Posts List */}
                    {loading ? (
                        <div className="flex h-64 items-center justify-center">
                            <Loader2 className="animate-spin h-8 w-8 text-muted-foreground" />
                        </div>
                    ) : posts.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-border p-12 text-center space-y-3">
                            <div className="h-12 w-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mx-auto text-xl font-bold">
                                ✍️
                            </div>
                            <h3 className="font-bold text-base">No social posts created yet</h3>
                            <p className="text-xs text-muted-foreground max-w-md mx-auto">
                                Ask your AI Agent in chat to create posts or reels (e.g. &quot;Create a YouTube Shorts script and Instagram Reel for our launch&quot;).
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-8">
                            {posts.map((post) => {
                                const title = cleanTitle(post.title || "Social Post Draft");
                                const imageSrc = post.image_url || null;

                                return (
                                    <div key={post.id} className="rounded-2xl border border-border/80 bg-card/60 p-4 sm:p-6 shadow-sm space-y-4">
                                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 pb-3">
                                            <div>
                                                <h2 className="font-bold text-base text-foreground leading-snug">{title}</h2>
                                                <p className="text-[11px] text-muted-foreground mt-0.5">
                                                    Created {new Date(post.created_at).toLocaleDateString()} · ID: {post.id.slice(0, 8)}
                                                </p>
                                            </div>

                                            <div className="flex items-center gap-3">
                                                <PublishStatusIcons publishedTo={post.published_to} />
                                                <PublishButton
                                                    post={post}
                                                    enabledPlatforms={enabledPlatforms}
                                                    onPublished={handlePublishedUpdate}
                                                />
                                            </div>
                                        </div>

                                        {/* Card Renderers */}
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                                            {/* YouTube */}
                                            {(activeTab === "all" || activeTab === "youtube") && (post.youtube_data || post.youtube) && (
                                                <div className="flex flex-col items-center">
                                                    <YouTubePost
                                                        post={post.youtube || ""}
                                                        imageSrc={imageSrc}
                                                        title={title}
                                                        rawData={post.youtube_data}
                                                    />
                                                </div>
                                            )}

                                            {/* Instagram */}
                                            {(activeTab === "all" || activeTab === "instagram") && (post.instagram_data || post.instagram) && (
                                                <div className="flex flex-col items-center">
                                                    <InstagramPost
                                                        post={post.instagram || ""}
                                                        imageSrc={imageSrc}
                                                        title={title}
                                                        rawData={post.instagram_data}
                                                    />
                                                </div>
                                            )}

                                            {/* Facebook */}
                                            {(activeTab === "all" || activeTab === "facebook") && (post.facebook_data || post.facebook) && (
                                                <div className="flex flex-col items-center">
                                                    <FacebookPost
                                                        post={post.facebook || ""}
                                                        imageSrc={imageSrc}
                                                        title={title}
                                                        rawData={post.facebook_data}
                                                    />
                                                </div>
                                            )}

                                            {/* Twitter */}
                                            {(activeTab === "all" || activeTab === "twitter") && post.twitter && (
                                                <div className="flex flex-col items-center">
                                                    <TwitterPost
                                                        post={post.twitter}
                                                        imageSrc={imageSrc}
                                                        title={title}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </main>
            </div>
        </PluginGate>
    );
}
