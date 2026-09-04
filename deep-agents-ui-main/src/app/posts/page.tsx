"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import {
    RefreshCcw, ArrowLeft, Heart, MessageCircle, Repeat2,
    Bookmark, Share2, ThumbsUp, MoreHorizontal, Globe,
    Settings, CheckCircle2, Loader2, XCircle, Play, Tag,
    Pencil, Trash2, ExternalLink, ChevronDown, ChevronUp,
    BookOpen, Sparkles, Folder, Eye, Check, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    DialogDescription,
} from "@/components/ui/dialog";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { PluginGate } from "@/app/components/settings/PluginsSection";

// ─── Type Definitions ────────────────────────────────────────────────────────
interface PostData {
    id: string;
    created_at: string;
    title: string;
    twitter: string;
    instagram: string;
    facebook: string;
    youtube?: string;
    linkedin?: string;
    instagram_data?: Record<string, any> | null;
    facebook_data?: Record<string, any> | null;
    youtube_data?: Record<string, any> | null;
    linkedin_data?: Record<string, any> | null;
    twitter_data?: Record<string, any> | null;
    sources: string[];
    image: boolean;
    image_url: string | null;
    published_to: Record<string, boolean>;
}

interface BlogPostData {
    id: string;
    created_at: string;
    title: string;
    slug: string;
    content_md: string;
    excerpt: string;
    focus_keyword: string;
    meta_description: string;
    category_hint: string;
    has_image_1: boolean;
    has_image_2: boolean;
    image_1_url: string | null;
    image_2_url: string | null;
    wp_status: string;
    wp_post_url: string | null;
    wp_post_id: number | null;
    wp_edit_url: string | null;
}

interface WpCategory {
    id: number;
    name: string;
    slug: string;
    count: number;
    link: string;
}

// Helper: Convert local path or remote URL into streamable URL
function getMediaStreamUrl(urlOrPath?: string | null): string | null {
    if (!urlOrPath) return null;
    const trimmed = urlOrPath.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        return trimmed;
    }
    return `/api/media/stream?path=${encodeURIComponent(trimmed)}`;
}

function isVideoMedia(urlOrPath?: string | null, mediaType?: string): boolean {
    if (mediaType === "video" || mediaType === "reel") return true;
    if (!urlOrPath) return false;
    const lower = urlOrPath.toLowerCase();
    return lower.endsWith(".mp4") || lower.endsWith(".mov") || lower.endsWith(".webm") || lower.endsWith(".mkv") || lower.includes("video");
}

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
            />
        </div>
    );
}

// ─── Single Platform Publish Button ──────────────────────────────────────────
function SinglePlatformPublishButton({
    postId,
    platform,
    label,
    isPublished,
    onPublished,
}: {
    postId: string;
    platform: "youtube" | "instagram" | "facebook" | "twitter" | "linkedin";
    label: string;
    isPublished: boolean;
    onPublished: (postId: string, publishedTo: Record<string, boolean>) => void;
}) {
    const [publishing, setPublishing] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState("");
    const [showError, setShowError] = useState(false);

    const handlePublish = async () => {
        setPublishing(true);
        setError("");
        setShowError(false);
        try {
            const res = await fetch("/api/publish", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ post_id: postId, platforms: [platform] }),
            });
            const json = await res.json();
            if (json.results?.[platform]?.success || json.published_to?.[platform]) {
                if (platform === "youtube" && json.results?.youtube?.status === "processing") {
                    setIsProcessing(true);
                }
                onPublished(postId, json.published_to || { [platform]: true });
            } else {
                setError(json.results?.[platform]?.error || json.error || "Publishing failed");
                setShowError(true);
            }
        } catch (e: any) {
            setError(e.message || "Network error");
            setShowError(true);
        } finally {
            setPublishing(false);
        }
    };

    return (
        <div className="relative flex items-center gap-1.5">
            <Button
                variant={isPublished ? "outline" : "default"}
                size="sm"
                onClick={handlePublish}
                disabled={publishing}
                className="gap-1.5 text-xs font-semibold shadow-sm h-8"
            >
                {publishing ? (
                    <Loader2 size={13} className="animate-spin" />
                ) : isProcessing ? (
                    <Clock size={13} className="text-amber-500 animate-pulse" />
                ) : isPublished ? (
                    <CheckCircle2 size={13} className="text-emerald-500" />
                ) : (
                    <Share2 size={13} />
                )}
                {isProcessing
                    ? "YouTube: Checking & Auto-Publishing..."
                    : isPublished
                    ? `Published to ${label}`
                    : `1-Click Publish to ${label}`}
            </Button>
            {showError && error && (
                <div className="absolute right-0 top-full mt-1.5 z-20 w-64 rounded-xl border border-destructive/30 bg-card p-2.5 shadow-xl text-xs text-destructive flex items-start justify-between gap-2">
                    <span className="leading-tight">{error}</span>
                    <button onClick={() => setShowError(false)} className="font-bold text-xs shrink-0">✕</button>
                </div>
            )}
        </div>
    );
}

// ─── X / Twitter Card ────────────────────────────────────────────────────────
function TwitterPost({
    post,
    imageSrc,
    title,
    rawData,
}: {
    post: string;
    imageSrc: string | null;
    title: string;
    rawData?: any;
}) {
    const tweetText = (post || rawData?.text || "").replace(/\*Character count:.*?\*\s*/gi, "").replace(/^---+\s*/gm, "").trim();
    const mediaSource = rawData?.media_url || imageSrc;
    const mediaStream = getMediaStreamUrl(mediaSource);
    const isVideo = isVideoMedia(mediaSource, rawData?.media_type);

    return (
        <div style={{ fontFamily: "'TwitterChirp', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}
            className="overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-sm w-full">
            <div className="flex gap-3 px-4 pt-4 pb-2">
                <div className="shrink-0">
                    <div className="h-10 w-10 rounded-full bg-foreground text-background flex items-center justify-center font-bold text-base">X</div>
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 flex-wrap">
                        <span className="font-bold text-[15px]">Legend</span>
                        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] fill-primary">
                            <path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.27 2.52-.81 3.91C2.63 9.33 1.75 10.57 1.75 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.27 3.91.81c.66 1.31 1.91 2.19 3.34 2.19s2.67-.88 3.34-2.19c1.39.46 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z" />
                        </svg>
                        <span className="text-muted-foreground text-[14px]">@legend · Just now</span>
                    </div>
                    <p className="text-[12px] text-muted-foreground/80 italic mb-1 mt-0.5 truncate">{title}</p>
                    <p className="mt-1 text-[15px] leading-[1.5] text-foreground whitespace-pre-wrap break-words">{tweetText}</p>
                    
                    {mediaStream && (
                        <div className="mt-3 overflow-hidden rounded-2xl border border-border w-full">
                            {isVideo ? (
                                <VideoPlayer src={mediaSource!} />
                            ) : (
                                <Image src={mediaStream} alt="Tweet media" width={600} height={338} className="w-full object-cover" unoptimized />
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

// ─── LinkedIn Card ────────────────────────────────────────────────────────────
function LinkedInPost({
    post,
    imageSrc,
    title,
    rawData,
}: {
    post: string;
    imageSrc: string | null;
    title: string;
    rawData?: any;
}) {
    const [expanded, setExpanded] = useState(false);
    const commentary = post || rawData?.commentary || "";
    const mediaSource = rawData?.media_url || imageSrc;
    const mediaType = rawData?.media_type || (isVideoMedia(mediaSource) ? "video" : mediaSource ? "image" : "text");
    const isVideo = mediaType === "video" || isVideoMedia(mediaSource);
    const mediaStream = getMediaStreamUrl(mediaSource);
    const linkUrl = rawData?.link;
    const visibility = rawData?.visibility || "PUBLIC";

    const PREVIEW_CHARS = 240;
    const needsTruncation = commentary.length > PREVIEW_CHARS;
    const visibleCommentary = expanded || !needsTruncation ? commentary : commentary.slice(0, PREVIEW_CHARS) + "…";

    return (
        <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" }}
            className="overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-sm w-full">
            {/* Header */}
            <div className="flex items-start justify-between px-4 pt-4 pb-2.5">
                <div className="flex items-center gap-3">
                    <div className="h-12 w-12 rounded-full bg-[#0A66C2] flex items-center justify-center text-white font-bold text-base shadow-sm shrink-0">
                        LG
                    </div>
                    <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-bold text-[15px] text-foreground hover:text-[#0A66C2] cursor-pointer transition-colors">Legend gamerz</span>
                            <span className="text-muted-foreground text-[11px] font-normal">• 1st</span>
                        </div>
                        <p className="text-[12px] text-muted-foreground truncate max-w-[280px] sm:max-w-md">Thought Leadership &amp; Industry Perspectives</p>
                        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-0.5">
                            <span>Just now</span>
                            <span>•</span>
                            <span className="flex items-center gap-0.5">
                                <Globe size={11} /> {visibility === "PUBLIC" ? "Public" : "Connections"}
                            </span>
                        </div>
                    </div>
                </div>
                <button className="text-muted-foreground hover:text-foreground p-1 rounded-full hover:bg-accent">
                    <MoreHorizontal size={18} />
                </button>
            </div>

            {/* Title / Topic badge */}
            {title && (
                <div className="px-4 pb-1">
                    <span className="text-[11px] font-medium text-muted-foreground/90 italic truncate block">
                        {title}
                    </span>
                </div>
            )}

            {/* Commentary text */}
            <div className="px-4 py-2 text-[14px] leading-[1.5] text-foreground whitespace-pre-wrap break-words">
                {visibleCommentary}
                {needsTruncation && !expanded && (
                    <button
                        onClick={() => setExpanded(true)}
                        className="text-muted-foreground ml-1 font-semibold hover:text-[#0A66C2]"
                    >
                        …see more
                    </button>
                )}
            </div>

            {/* Media: Video, Image, or Article Link */}
            {mediaStream && (
                <div className="mt-2 w-full overflow-hidden border-y border-border bg-black/5">
                    {isVideo ? (
                        <VideoPlayer src={mediaSource!} />
                    ) : (
                        <div className="relative w-full max-h-[420px] overflow-hidden flex items-center justify-center bg-black">
                            <Image
                                src={mediaStream}
                                alt="LinkedIn post media"
                                width={700}
                                height={400}
                                className="w-full object-cover max-h-[420px]"
                                unoptimized
                            />
                        </div>
                    )}
                </div>
            )}

            {/* Link Preview (if article / external link) */}
            {!mediaStream && linkUrl && (
                <div className="mx-4 my-2 p-3 rounded-xl border border-border/70 bg-muted/30 hover:bg-muted/50 transition-colors">
                    <a href={linkUrl} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0 flex-1">
                            <p className="font-semibold text-foreground truncate">{rawData?.title || linkUrl}</p>
                            <p className="text-[11px] text-muted-foreground truncate">{linkUrl}</p>
                        </div>
                        <ExternalLink size={14} className="text-muted-foreground shrink-0" />
                    </a>
                </div>
            )}

            {/* Social Counts bar */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-border/40 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                    <span className="h-4 w-4 rounded-full bg-[#0A66C2] flex items-center justify-center text-white text-[9px]">👍</span>
                    <span>12 reactions</span>
                </span>
                <span>3 comments</span>
            </div>

            {/* LinkedIn Action Buttons */}
            <div className="flex items-center justify-around px-2 py-1 text-muted-foreground text-xs font-semibold">
                <button className="flex items-center gap-1.5 py-2 px-3 rounded-lg hover:bg-accent hover:text-foreground transition-colors">
                    <ThumbsUp size={16} /> <span>Like</span>
                </button>
                <button className="flex items-center gap-1.5 py-2 px-3 rounded-lg hover:bg-accent hover:text-foreground transition-colors">
                    <MessageCircle size={16} /> <span>Comment</span>
                </button>
                <button className="flex items-center gap-1.5 py-2 px-3 rounded-lg hover:bg-accent hover:text-foreground transition-colors">
                    <Repeat2 size={16} /> <span>Repost</span>
                </button>
                <button className="flex items-center gap-1.5 py-2 px-3 rounded-lg hover:bg-accent hover:text-foreground transition-colors">
                    <Share2 size={16} /> <span>Send</span>
                </button>
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
            className="overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-sm w-full">
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

            <div className="w-full bg-black relative flex items-center justify-center min-h-[260px] sm:min-h-[300px]">
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
            className="overflow-hidden rounded-2xl bg-card shadow-sm w-full border border-border">
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
            className="overflow-hidden rounded-2xl bg-card shadow-sm w-full border border-border">
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

            <div className="p-4 space-y-3">
                <h3 className="font-bold text-[16px] text-foreground leading-snug">{ytTitle}</h3>
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

// ─── WordPress Blog Article Card ──────────────────────────────────────────────
function BlogPostCard({
    post,
    onEdit,
    onDelete,
    onPublished,
    onCategoryClick,
}: {
    post: BlogPostData;
    onEdit: (post: BlogPostData) => void;
    onDelete: (id: string, title: string) => void;
    onPublished: (id: string, url: string) => void;
    onCategoryClick: (category: string) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const [publishing, setPublishing] = useState(false);
    const [publishStatus, setPublishStatus] = useState<"idle" | "success" | "error">("idle");
    const [publishError, setPublishError] = useState("");

    const isLive = post.wp_status === "publish" || !!post.wp_post_url;
    const heroImage = post.image_1_url || post.image_2_url;

    const handlePublishToWordpress = async () => {
        setPublishing(true);
        setPublishStatus("idle");
        setPublishError("");
        try {
            const res = await fetch("/api/posts/wordpress/publish", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ blog_post_id: post.id }),
            });
            const data = await res.json();
            if (data.success && data.post_url) {
                setPublishStatus("success");
                onPublished(post.id, data.post_url);
            } else {
                setPublishStatus("error");
                setPublishError(data.error || "Publishing failed");
            }
        } catch (e: any) {
            setPublishStatus("error");
            setPublishError(e.message || "Network error");
        } finally {
            setPublishing(false);
        }
    };

    return (
        <div className="rounded-2xl border border-border/80 bg-card/70 p-4 sm:p-6 shadow-sm space-y-4 transition-all">
            {/* Header: Title, Category Badge, Status & Actions */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border/50 pb-3.5">
                <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        {/* Category Badge - Clickable to filter */}
                        <button
                            onClick={() => onCategoryClick(post.category_hint)}
                            title={`Filter articles by ${post.category_hint}`}
                            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
                        >
                            <Folder size={11} />
                            <span>{post.category_hint || "Uncategorized"}</span>
                        </button>

                        {post.focus_keyword && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground bg-muted/60 px-2 py-0.5 rounded-full">
                                <Tag size={10} /> {post.focus_keyword}
                            </span>
                        )}

                        {isLive ? (
                            <a
                                href={post.wp_post_url!}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] font-semibold text-white bg-emerald-600 px-2.5 py-0.5 rounded-full hover:bg-emerald-500 transition-colors"
                            >
                                <CheckCircle2 size={11} /> Live on WordPress <ExternalLink size={10} />
                            </a>
                        ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                                Draft
                            </span>
                        )}
                    </div>

                    <h2 className="font-bold text-base sm:text-lg text-foreground leading-snug pt-0.5">
                        {post.title}
                    </h2>
                    <p className="text-[11px] text-muted-foreground">
                        Created {new Date(post.created_at).toLocaleDateString()} · ID: {post.id.slice(0, 8)}
                        {post.slug && <span className="ml-2 font-mono text-[10px] text-muted-foreground/80">/{post.slug}</span>}
                    </p>
                </div>

                {/* Actions: Publish, Edit, Delete */}
                <div className="flex items-center gap-2 shrink-0 self-start sm:self-center">
                    <Button
                        variant={isLive ? "outline" : "default"}
                        size="sm"
                        onClick={handlePublishToWordpress}
                        disabled={publishing}
                        className="gap-1.5 text-xs font-semibold shadow-sm h-8"
                    >
                        {publishing ? (
                            <Loader2 size={13} className="animate-spin" />
                        ) : isLive ? (
                            <CheckCircle2 size={13} className="text-emerald-500" />
                        ) : (
                            <Globe size={13} />
                        )}
                        {isLive ? "Republish to WP" : "1-Click Publish to WP"}
                    </Button>

                    <Button
                        variant="outline"
                        size="icon"
                        onClick={() => onEdit(post)}
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        title="Edit Article"
                    >
                        <Pencil size={13} />
                    </Button>

                    <Button
                        variant="outline"
                        size="icon"
                        onClick={() => onDelete(post.id, post.title)}
                        className="h-8 w-8 text-destructive/80 hover:text-destructive hover:bg-destructive/10 hover:border-destructive/30"
                        title="Delete Article"
                    >
                        <Trash2 size={13} />
                    </Button>
                </div>
            </div>

            {publishStatus === "error" && (
                <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive flex items-center justify-between gap-2">
                    <span className="truncate">{publishError}</span>
                    <button onClick={() => setPublishStatus("idle")} className="font-bold text-xs">✕</button>
                </div>
            )}

            {/* Body: Hero Image + Excerpt */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
                {heroImage && (
                    <div className="md:col-span-1 overflow-hidden rounded-xl border border-border relative aspect-video bg-black/5">
                        <Image
                            src={getMediaStreamUrl(heroImage)!}
                            alt={post.title}
                            fill
                            className="object-cover"
                            unoptimized
                        />
                    </div>
                )}

                <div className={heroImage ? "md:col-span-2 space-y-2.5" : "col-span-3 space-y-2.5"}>
                    <p className="text-sm text-foreground/90 leading-relaxed">
                        {post.excerpt || post.meta_description || "No summary provided for this article."}
                    </p>

                    <div className="pt-1 flex items-center gap-3">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setExpanded(!expanded)}
                            className="h-7 px-2 text-xs font-semibold gap-1 text-primary hover:text-primary hover:bg-primary/10"
                        >
                            <BookOpen size={12} />
                            {expanded ? "Hide Full Content" : "Read Full Article Content"}
                            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        </Button>

                        {isLive && post.wp_post_url && (
                            <a
                                href={post.wp_post_url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground font-medium underline-offset-4 hover:underline"
                            >
                                View Live Post <ExternalLink size={11} />
                            </a>
                        )}
                    </div>
                </div>
            </div>

            {/* Expandable Markdown Body */}
            {expanded && (
                <div className="pt-3 border-t border-border/40 mt-3">
                    <div className="max-h-96 overflow-y-auto rounded-xl bg-muted/40 p-4 border border-border/50 text-xs font-mono whitespace-pre-wrap leading-relaxed">
                        {post.content_md}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Platform tab config (All Channels tab removed as requested) ─────────────
const PLATFORMS = [
    {
        key: "blog" as const,
        label: "Blog Articles",
        activeClass: "bg-[#0073AA] text-white shadow-sm",
        inactiveClass: "bg-card text-muted-foreground hover:bg-accent hover:text-foreground border-border",
        icon: (active: boolean) => (
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${active ? "fill-white" : "fill-current"}`}>
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-8.86 10c0-1.84.58-3.54 1.57-4.94l6.09 16.69c-4.33-.92-7.66-4.52-7.66-8.75zm8.86 8.86c-1.12 0-2.18-.23-3.15-.65l3.52-10.22 3.6 9.87c-1.22.64-2.58 1-3.97 1zm1.25-13.62l3.41 9.94c1.86-1.54 3.06-3.87 3.06-6.48 0-1.07-.21-2.09-.59-3.03l-5.88-.43zm7.04-1.57c-.89-.98-1.99-1.74-3.23-2.21l-3.32 9.68 3.02-8.77c1.37.38 2.59 1.13 3.53 2.15z" />
            </svg>
        ),
    },
    {
        key: "youtube" as const,
        label: "YouTube",
        activeClass: "bg-[#FF0000] text-white shadow-sm",
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
        activeClass: "bg-gradient-to-r from-[#FCAF45] via-[#E1306C] to-[#833AB4] text-white shadow-sm",
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
        activeClass: "bg-[#1877F2] text-white shadow-sm",
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
        activeClass: "bg-foreground text-background dark:bg-foreground dark:text-background shadow-sm",
        inactiveClass: "bg-card text-muted-foreground hover:bg-accent hover:text-foreground border-border",
        icon: (active: boolean) => (
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${active ? "fill-background dark:fill-background" : "fill-current"}`}>
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.74l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
        ),
    },
    {
        key: "linkedin" as const,
        label: "LinkedIn",
        activeClass: "bg-[#0A66C2] text-white shadow-sm",
        inactiveClass: "bg-card text-muted-foreground hover:bg-accent hover:text-foreground border-border",
        icon: (active: boolean) => (
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${active ? "fill-white" : "fill-current"}`}>
                <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.46 10.9v8.37H9.2V10.9H6.46M7.83 6.45a1.6 1.6 0 0 0-1.6 1.6 1.6 1.6 0 0 0 1.6-1.6 1.6 1.6 0 0 0 1.6-1.6 1.6 1.6 0 0 0-1.6-1.6z" />
            </svg>
        ),
    },
] as const;

type Platform = typeof PLATFORMS[number]["key"];

// ─── Edit Modal Component ─────────────────────────────────────────────────────
function PostEditDialog({
    open,
    onOpenChange,
    editTarget,
    onSaved,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    editTarget: { type: "social" | "blog"; platformTab?: Platform; data: any } | null;
    onSaved: (type: "social" | "blog", updatedData: any) => void;
}) {
    const [formData, setFormData] = useState<Record<string, any>>({});
    const [saving, setSaving] = useState(false);
    const [errorMsg, setErrorMsg] = useState("");
    const [liveCategories, setLiveCategories] = useState<WpCategory[]>([]);
    const [loadingCats, setLoadingCats] = useState(false);

    useEffect(() => {
        if (editTarget?.data) {
            setFormData({ ...editTarget.data });
            setErrorMsg("");
        }
    }, [editTarget]);

    // Fetch live categories when editing blog posts
    useEffect(() => {
        if (open && editTarget?.type === "blog") {
            setLoadingCats(true);
            fetch("/api/posts/wordpress/categories")
                .then((r) => r.json())
                .then((res) => {
                    if (res.success && Array.isArray(res.categories)) {
                        setLiveCategories(res.categories);
                    }
                })
                .catch(() => {})
                .finally(() => setLoadingCats(false));
        }
    }, [open, editTarget]);

    if (!editTarget) return null;
    const isBlog = editTarget.type === "blog";
    const platform = editTarget.platformTab;

    const handleSave = async () => {
        setSaving(true);
        setErrorMsg("");
        try {
            const res = await fetch(`/api/posts/${formData.id}?type=${editTarget.type}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(formData),
            });
            const json = await res.json();
            if (json.success && json.post) {
                onSaved(editTarget.type, json.post);
                onOpenChange(false);
            } else {
                setErrorMsg(json.error || "Failed to update post.");
            }
        } catch (e: any) {
            setErrorMsg(e.message || "Network error.");
        } finally {
            setSaving(false);
        }
    };

    const twitterText = formData.twitter || "";
    const twitterCharCount = twitterText.length;
    const twitterOverLimit = twitterCharCount > 280;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-4 sm:p-6 rounded-2xl">
                <DialogHeader>
                    <DialogTitle className="text-base sm:text-lg font-bold flex items-center gap-2">
                        <Pencil className="h-4 w-4 text-primary" />
                        {isBlog
                            ? "Edit WordPress Blog Article"
                            : `Edit ${platform ? platform.toUpperCase() : "Social"} Post`}
                    </DialogTitle>
                    <DialogDescription className="text-xs text-muted-foreground">
                        {isBlog
                            ? "Update headline, category, SEO tags, excerpt, and article body."
                            : "Customize post content and media before publishing."}
                    </DialogDescription>
                </DialogHeader>

                {errorMsg && (
                    <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/30 text-xs text-destructive font-medium">
                        {errorMsg}
                    </div>
                )}

                <div className="space-y-4 py-2 text-xs">
                    {/* Common: Headline */}
                    <div>
                        <label className="font-semibold block mb-1 text-foreground">Post Headline / Title</label>
                        <Input
                            value={formData.title || ""}
                            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                            className="h-9 text-xs"
                            placeholder="Headline or Title"
                        />
                    </div>

                    {/* 1. Blog-Specific Fields */}
                    {isBlog && (
                        <>
                            <div>
                                <div className="flex items-center justify-between mb-1">
                                    <label className="font-semibold text-foreground flex items-center gap-1">
                                        <Folder size={12} className="text-primary" />
                                        WordPress Category
                                    </label>
                                    {loadingCats && (
                                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                                            <Loader2 size={10} className="animate-spin" /> Loading WP categories...
                                        </span>
                                    )}
                                </div>
                                <Input
                                    value={formData.category_hint || ""}
                                    onChange={(e) => setFormData({ ...formData, category_hint: e.target.value })}
                                    className="h-9 text-xs mb-1.5"
                                    placeholder="e.g. Technology, Health, News"
                                />
                                {liveCategories.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                                        <span className="text-[10px] text-muted-foreground self-center mr-1">Live WP Categories:</span>
                                        {liveCategories.slice(0, 8).map((cat) => (
                                            <button
                                                key={cat.id}
                                                type="button"
                                                onClick={() => setFormData({ ...formData, category_hint: cat.name })}
                                                className={`text-[10px] font-medium px-2 py-0.5 rounded-md border transition-all ${
                                                    formData.category_hint?.toLowerCase() === cat.name.toLowerCase()
                                                        ? "bg-primary text-primary-foreground border-primary"
                                                        : "bg-muted/40 hover:bg-muted text-muted-foreground border-border"
                                                }`}
                                            >
                                                {cat.name}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="font-semibold block mb-1 text-foreground">URL Slug</label>
                                    <Input
                                        value={formData.slug || ""}
                                        onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                                        className="h-9 text-xs"
                                        placeholder="url-friendly-slug"
                                    />
                                </div>
                                <div>
                                    <label className="font-semibold block mb-1 text-foreground">Focus SEO Keyword</label>
                                    <Input
                                        value={formData.focus_keyword || ""}
                                        onChange={(e) => setFormData({ ...formData, focus_keyword: e.target.value })}
                                        className="h-9 text-xs"
                                        placeholder="primary keyword"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="font-semibold block mb-1 text-foreground">Featured Hero Image URL</label>
                                <Input
                                    value={formData.image_1_url || ""}
                                    onChange={(e) => setFormData({ ...formData, image_1_url: e.target.value })}
                                    className="h-9 text-xs"
                                    placeholder="https://... or storage URL"
                                />
                            </div>

                            <div>
                                <label className="font-semibold block mb-1 text-foreground">Excerpt / Meta Summary</label>
                                <Textarea
                                    rows={2}
                                    value={formData.excerpt || ""}
                                    onChange={(e) => setFormData({ ...formData, excerpt: e.target.value })}
                                    className="text-xs"
                                    placeholder="Brief summary for Google & readers..."
                                />
                            </div>

                            <div>
                                <label className="font-semibold block mb-1 text-foreground">Full Markdown Content</label>
                                <Textarea
                                    rows={8}
                                    value={formData.content_md || ""}
                                    onChange={(e) => setFormData({ ...formData, content_md: e.target.value })}
                                    className="text-xs font-mono"
                                    placeholder="# Heading\n\nArticle body..."
                                />
                            </div>
                        </>
                    )}

                    {/* 2. YouTube Fields */}
                    {platform === "youtube" && (
                        <>
                            <div>
                                <label className="font-semibold block mb-1 text-foreground">YouTube Video Description</label>
                                <Textarea
                                    rows={5}
                                    value={formData.youtube || formData.youtube_data?.description || ""}
                                    onChange={(e) => setFormData({
                                        ...formData,
                                        youtube: e.target.value,
                                        youtube_data: { ...(formData.youtube_data || {}), description: e.target.value },
                                    })}
                                    className="text-xs"
                                    placeholder="Video description, timestamps, links..."
                                />
                            </div>
                            <div>
                                <label className="font-semibold block mb-1 text-foreground">Video File URL</label>
                                <Input
                                    value={formData.youtube_data?.video_url || formData.image_url || ""}
                                    onChange={(e) => setFormData({
                                        ...formData,
                                        youtube_data: { ...(formData.youtube_data || {}), video_url: e.target.value },
                                    })}
                                    className="h-9 text-xs"
                                    placeholder="https://.../video.mp4"
                                />
                            </div>
                            <div>
                                <label className="font-semibold block mb-1 text-foreground">Thumbnail URL</label>
                                <Input
                                    value={formData.youtube_data?.thumbnail_url || formData.image_url || ""}
                                    onChange={(e) => setFormData({
                                        ...formData,
                                        image_url: e.target.value,
                                        youtube_data: { ...(formData.youtube_data || {}), thumbnail_url: e.target.value },
                                    })}
                                    className="h-9 text-xs"
                                    placeholder="https://.../thumbnail.jpg"
                                />
                            </div>
                        </>
                    )}

                    {/* 3. Instagram Fields */}
                    {platform === "instagram" && (
                        <>
                            <div>
                                <label className="font-semibold block mb-1 text-foreground">Instagram Caption &amp; Hashtags</label>
                                <Textarea
                                    rows={5}
                                    value={formData.instagram || formData.instagram_data?.caption || ""}
                                    onChange={(e) => setFormData({
                                        ...formData,
                                        instagram: e.target.value,
                                        instagram_data: { ...(formData.instagram_data || {}), caption: e.target.value },
                                    })}
                                    className="text-xs"
                                    placeholder="Post or Reel caption..."
                                />
                            </div>
                            <div>
                                <label className="font-semibold block mb-1 text-foreground">Media URL (Video / Photo)</label>
                                <Input
                                    value={formData.instagram_data?.media_url || formData.image_url || ""}
                                    onChange={(e) => setFormData({
                                        ...formData,
                                        image_url: e.target.value,
                                        instagram_data: { ...(formData.instagram_data || {}), media_url: e.target.value },
                                    })}
                                    className="h-9 text-xs"
                                    placeholder="https://.../media.mp4 or .jpg"
                                />
                            </div>
                        </>
                    )}

                    {/* 4. Facebook Fields */}
                    {platform === "facebook" && (
                        <>
                            <div>
                                <label className="font-semibold block mb-1 text-foreground">Facebook Message</label>
                                <Textarea
                                    rows={5}
                                    value={formData.facebook || formData.facebook_data?.message || ""}
                                    onChange={(e) => setFormData({
                                        ...formData,
                                        facebook: e.target.value,
                                        facebook_data: { ...(formData.facebook_data || {}), message: e.target.value },
                                    })}
                                    className="text-xs"
                                    placeholder="Post message..."
                                />
                            </div>
                            <div>
                                <label className="font-semibold block mb-1 text-foreground">Media URL (Photo or Video)</label>
                                <Input
                                    value={formData.facebook_data?.media_url || formData.image_url || ""}
                                    onChange={(e) => setFormData({
                                        ...formData,
                                        image_url: e.target.value,
                                        facebook_data: { ...(formData.facebook_data || {}), media_url: e.target.value },
                                    })}
                                    className="h-9 text-xs"
                                    placeholder="https://.../media.mp4 or .jpg"
                                />
                            </div>
                        </>
                    )}

                    {/* 5. X / Twitter Fields */}
                    {platform === "twitter" && (
                        <>
                            <div>
                                <div className="flex items-center justify-between mb-1">
                                    <label className="font-semibold text-foreground">Tweet Text</label>
                                    <span className={`text-[11px] font-mono ${twitterOverLimit ? "text-destructive font-bold" : "text-muted-foreground"}`}>
                                        {twitterCharCount}/280
                                    </span>
                                </div>
                                <Textarea
                                    rows={4}
                                    value={formData.twitter || formData.twitter_data?.text || ""}
                                    onChange={(e) => setFormData({
                                        ...formData,
                                        twitter: e.target.value,
                                        twitter_data: { ...(formData.twitter_data || {}), text: e.target.value },
                                    })}
                                    className={`text-xs ${twitterOverLimit ? "border-destructive focus-visible:ring-destructive" : ""}`}
                                    placeholder="Tweet text with hashtags..."
                                />
                            </div>
                            <div>
                                <label className="font-semibold block mb-1 text-foreground">Attached Media URL (Cloudflare R2 or Web URL)</label>
                                <Input
                                    value={formData.twitter_data?.media_url || formData.image_url || ""}
                                    onChange={(e) => setFormData({
                                        ...formData,
                                        image_url: e.target.value,
                                        twitter_data: { ...(formData.twitter_data || {}), media_url: e.target.value },
                                    })}
                                    className="h-9 text-xs"
                                    placeholder="https://... R2 image or video URL"
                                />
                            </div>
                        </>
                    )}

                    {/* 6. LinkedIn Fields */}
                    {platform === "linkedin" && (
                        <>
                            <div>
                                <label className="font-semibold block mb-1 text-foreground">Post Commentary / Insights</label>
                                <Textarea
                                    rows={5}
                                    value={formData.linkedin || formData.linkedin_data?.commentary || ""}
                                    onChange={(e) => setFormData({
                                        ...formData,
                                        linkedin: e.target.value,
                                        linkedin_data: { ...(formData.linkedin_data || {}), commentary: e.target.value },
                                    })}
                                    className="text-xs"
                                    placeholder="Thought leadership commentary, insights, hashtags..."
                                />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="font-semibold block mb-1 text-foreground">Media Type</label>
                                    <Input
                                        value={formData.linkedin_data?.media_type || "text"}
                                        onChange={(e) => setFormData({
                                            ...formData,
                                            linkedin_data: { ...(formData.linkedin_data || {}), media_type: e.target.value },
                                        })}
                                        className="h-9 text-xs"
                                        placeholder="text, image, video, or article"
                                    />
                                </div>
                                <div>
                                    <label className="font-semibold block mb-1 text-foreground">Visibility</label>
                                    <Input
                                        value={formData.linkedin_data?.visibility || "PUBLIC"}
                                        onChange={(e) => setFormData({
                                            ...formData,
                                            linkedin_data: { ...(formData.linkedin_data || {}), visibility: e.target.value },
                                        })}
                                        className="h-9 text-xs"
                                        placeholder="PUBLIC or CONNECTIONS"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="font-semibold block mb-1 text-foreground">Attached Media URL (Cloudflare R2 or Web URL)</label>
                                <Input
                                    value={formData.linkedin_data?.media_url || formData.image_url || ""}
                                    onChange={(e) => setFormData({
                                        ...formData,
                                        image_url: e.target.value,
                                        linkedin_data: { ...(formData.linkedin_data || {}), media_url: e.target.value },
                                    })}
                                    className="h-9 text-xs"
                                    placeholder="https://... image or video URL"
                                />
                            </div>
                            <div>
                                <label className="font-semibold block mb-1 text-foreground">Article / External Link</label>
                                <Input
                                    value={formData.linkedin_data?.link || ""}
                                    onChange={(e) => setFormData({
                                        ...formData,
                                        linkedin_data: { ...(formData.linkedin_data || {}), link: e.target.value },
                                    })}
                                    className="h-9 text-xs"
                                    placeholder="https://example.com/article"
                                />
                            </div>
                        </>
                    )}
                </div>

                <DialogFooter className="flex flex-row items-center justify-end gap-2 pt-2 border-t border-border">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onOpenChange(false)}
                        className="text-xs"
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="default"
                        size="sm"
                        onClick={handleSave}
                        disabled={saving || (platform === "twitter" && twitterOverLimit)}
                        className="text-xs font-semibold gap-1.5"
                    >
                        {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                        Save Changes
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ─── Delete Confirmation Dialog ───────────────────────────────────────────────
function DeleteConfirmDialog({
    open,
    onOpenChange,
    deleteTarget,
    onConfirmDelete,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    deleteTarget: { id: string; title: string; type: "social" | "blog"; platformName?: string } | null;
    onConfirmDelete: (id: string, type: "social" | "blog") => Promise<void>;
}) {
    const [deleting, setDeleting] = useState(false);

    if (!deleteTarget) return null;

    const handleDelete = async () => {
        setDeleting(true);
        try {
            await onConfirmDelete(deleteTarget.id, deleteTarget.type);
            onOpenChange(false);
        } finally {
            setDeleting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md p-5 rounded-2xl">
                <DialogHeader>
                    <DialogTitle className="text-base font-bold flex items-center gap-2 text-destructive">
                        <Trash2 size={16} /> Delete {deleteTarget.platformName || "Post"}
                    </DialogTitle>
                    <DialogDescription className="text-xs text-muted-foreground pt-1 leading-relaxed">
                        Are you sure you want to permanently delete <strong className="text-foreground">&ldquo;{deleteTarget.title}&rdquo;</strong>?
                        This will remove it from your console and database.
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter className="flex flex-row items-center justify-end gap-2 pt-3 border-t border-border">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onOpenChange(false)}
                        className="text-xs"
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        size="sm"
                        onClick={handleDelete}
                        disabled={deleting}
                        className="text-xs font-semibold gap-1.5"
                    >
                        {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                        Delete Post
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ─── Main Scalable Posts Page Component ───────────────────────────────────────
export default function PostsPage() {
    const [posts, setPosts] = useState<PostData[]>([]);
    const [blogPosts, setBlogPosts] = useState<BlogPostData[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<Platform>("blog");
    const [selectedCategory, setSelectedCategory] = useState<string>("all");

    // Edit and Delete Modal states
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [editTarget, setEditTarget] = useState<{ type: "social" | "blog"; platformTab?: Platform; data: any } | null>(null);

    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string; type: "social" | "blog"; platformName?: string } | null>(null);

    const loadPosts = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/posts?type=all");
            if (res.ok) {
                const data = await res.json();
                setPosts(data.posts || []);
                setBlogPosts(data.blog_posts || []);
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

    const handleBlogPublishedUpdate = (blogId: string, url: string) => {
        setBlogPosts((prev) =>
            prev.map((b) => (b.id === blogId ? { ...b, wp_status: "publish", wp_post_url: url } : b))
        );
    };

    // Edit Handlers
    const handleOpenEdit = (type: "social" | "blog", data: any, platformTab?: Platform) => {
        setEditTarget({ type, platformTab, data });
        setEditModalOpen(true);
    };

    const handleSaveEdit = (type: "social" | "blog", updated: any) => {
        if (type === "blog") {
            setBlogPosts((prev) => prev.map((b) => (b.id === updated.id ? { ...b, ...updated } : b)));
        } else {
            setPosts((prev) => prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)));
        }
    };

    // Delete Handlers
    const handleOpenDelete = (id: string, title: string, type: "social" | "blog", platformName?: string) => {
        setDeleteTarget({ id, title, type, platformName });
        setDeleteModalOpen(true);
    };

    const handleConfirmDelete = async (id: string, type: "social" | "blog") => {
        try {
            const res = await fetch(`/api/posts/${id}?type=${type}`, { method: "DELETE" });
            if (res.ok) {
                if (type === "blog") {
                    setBlogPosts((prev) => prev.filter((b) => b.id !== id));
                } else {
                    setPosts((prev) => prev.filter((p) => p.id !== id));
                }
            }
        } catch (err) {
            console.error("Failed to delete post:", err);
        }
    };

    // Category filter for Blog Articles
    const allCategories = Array.from(
        new Set(blogPosts.map((b) => b.category_hint).filter(Boolean))
    );

    const filteredBlogPosts = blogPosts.filter((b) => {
        if (selectedCategory === "all") return true;
        return b.category_hint.toLowerCase() === selectedCategory.toLowerCase();
    });

    // Platform-specific filtered post lists
    const youtubePosts = posts.filter((p) => !!(p.youtube_data || p.youtube));
    const instagramPosts = posts.filter((p) => !!(p.instagram_data || p.instagram));
    const facebookPosts = posts.filter((p) => !!(p.facebook_data || p.facebook));
    const twitterPosts = posts.filter((p) => !!(p.twitter || p.twitter_data));
    const linkedinPosts = posts.filter((p) => !!(p.linkedin || p.linkedin_data));

    // Current tab items count
    let currentTabCount = 0;
    if (activeTab === "blog") currentTabCount = filteredBlogPosts.length;
    else if (activeTab === "youtube") currentTabCount = youtubePosts.length;
    else if (activeTab === "instagram") currentTabCount = instagramPosts.length;
    else if (activeTab === "facebook") currentTabCount = facebookPosts.length;
    else if (activeTab === "twitter") currentTabCount = twitterPosts.length;
    else if (activeTab === "linkedin") currentTabCount = linkedinPosts.length;

    return (
        <PluginGate pluginKey="posts">
            <div className="min-h-screen bg-background text-foreground pb-16">
                {/* ── Mobile-Optimized Sticky Top Navbar ── */}
                <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur-md shadow-sm">
                    <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-3 sm:px-4 py-2.5 sm:py-3">
                        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                            <Link href="/">
                                <Button variant="ghost" size="sm" className="h-8 px-2 -ml-1 text-muted-foreground hover:text-foreground">
                                    <ArrowLeft size={16} />
                                    <span className="hidden sm:inline ml-1">Dashboard</span>
                                </Button>
                            </Link>
                            <div className="h-4 w-px bg-border hidden sm:block" />
                            <h1 className="text-base sm:text-lg font-bold tracking-tight truncate">
                                Posts Console
                            </h1>
                        </div>

                        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                            <ThemeToggle />
                            <Button variant="outline" size="sm" onClick={loadPosts} className="h-8 px-2 sm:px-3 text-xs gap-1.5">
                                <RefreshCcw size={13} className={loading ? "animate-spin" : ""} />
                                <span className="hidden sm:inline">Refresh</span>
                            </Button>
                            <Link href="/posts/settings">
                                <Button variant="outline" size="sm" className="h-8 px-2 sm:px-3 text-xs gap-1.5">
                                    <Settings size={13} />
                                    <span className="hidden sm:inline">Channels</span>
                                </Button>
                            </Link>
                        </div>
                    </div>
                </header>

                <main className="mx-auto max-w-5xl px-3 sm:px-4 py-4 sm:py-6 space-y-5">
                    {/* ── Scalable Platform Tabs (All Channels removed) ── */}
                    <div className="flex items-center gap-1.5 sm:gap-2 overflow-x-auto pb-1 scrollbar-none -mx-3 px-3 sm:mx-0 sm:px-0">
                        {PLATFORMS.map((p) => {
                            const active = activeTab === p.key;
                            let count = 0;
                            if (p.key === "blog") count = blogPosts.length;
                            else if (p.key === "youtube") count = youtubePosts.length;
                            else if (p.key === "instagram") count = instagramPosts.length;
                            else if (p.key === "facebook") count = facebookPosts.length;
                            else if (p.key === "twitter") count = twitterPosts.length;
                            else if (p.key === "linkedin") count = linkedinPosts.length;

                            return (
                                <button
                                    key={p.key}
                                    onClick={() => setActiveTab(p.key)}
                                    className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold border transition-all shrink-0 min-h-[38px] ${
                                        active ? p.activeClass : p.inactiveClass
                                    }`}
                                >
                                    {p.icon(active)}
                                    <span>{p.label}</span>
                                    <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full ${
                                        active ? "bg-black/20 text-white" : "bg-muted text-muted-foreground"
                                    }`}>
                                        {count}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    {/* ── Category Filter Bar (Visible on Blog tab) ── */}
                    {activeTab === "blog" && allCategories.length > 0 && (
                        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs scrollbar-none">
                            <span className="text-muted-foreground text-[11px] font-medium mr-1 shrink-0 flex items-center gap-1">
                                <Folder size={12} /> Category:
                            </span>
                            <button
                                onClick={() => setSelectedCategory("all")}
                                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors shrink-0 ${
                                    selectedCategory === "all"
                                        ? "bg-primary text-primary-foreground border-primary"
                                        : "bg-card text-muted-foreground border-border hover:bg-accent"
                                }`}
                            >
                                All ({blogPosts.length})
                            </button>
                            {allCategories.map((cat) => {
                                const catCount = blogPosts.filter((b) => b.category_hint.toLowerCase() === cat.toLowerCase()).length;
                                return (
                                    <button
                                        key={cat}
                                        onClick={() => setSelectedCategory(cat)}
                                        className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors shrink-0 ${
                                            selectedCategory.toLowerCase() === cat.toLowerCase()
                                                ? "bg-emerald-600 text-white border-emerald-600 shadow-sm"
                                                : "bg-card text-muted-foreground border-border hover:bg-accent"
                                        }`}
                                    >
                                        {cat} ({catCount})
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {/* ── Platform-Specific Content List ── */}
                    {loading ? (
                        <div className="flex h-64 items-center justify-center">
                            <Loader2 className="animate-spin h-8 w-8 text-muted-foreground" />
                        </div>
                    ) : currentTabCount === 0 ? (
                        <div className="rounded-2xl border border-dashed border-border p-8 sm:p-12 text-center space-y-3">
                            <div className="h-12 w-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mx-auto text-xl font-bold">
                                ✍️
                            </div>
                            <h3 className="font-bold text-base sm:text-lg">No {activeTab.toUpperCase()} posts found</h3>
                            <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
                                {activeTab === "blog"
                                    ? "Ask your AI Agent to create and save a WordPress article (e.g. 'Research AI news and write a blog post')."
                                    : `Ask your AI Agent to draft posts for ${activeTab.toUpperCase()} (e.g. 'Create a ${activeTab.toUpperCase()} video and reel').`}
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-6 sm:space-y-8">
                            {/* 1. Blog Tab: WordPress Articles */}
                            {activeTab === "blog" && (
                                <div className="space-y-4">
                                    {filteredBlogPosts.map((blog) => (
                                        <BlogPostCard
                                            key={blog.id}
                                            post={blog}
                                            onEdit={(b) => handleOpenEdit("blog", b, "blog")}
                                            onDelete={(id, title) => handleOpenDelete(id, title, "blog", "WordPress Article")}
                                            onPublished={handleBlogPublishedUpdate}
                                            onCategoryClick={(cat) => setSelectedCategory(cat)}
                                        />
                                    ))}
                                </div>
                            )}

                            {/* 2. YouTube Tab */}
                            {activeTab === "youtube" && (
                                <div className="space-y-6">
                                    {youtubePosts.map((post) => {
                                        const ytTitle = post.youtube_data?.title || cleanTitle(post.title);
                                        const isPublished = Boolean(post.published_to?.youtube);

                                        return (
                                            <div key={post.id} className="rounded-2xl border border-border/80 bg-card/60 p-4 sm:p-6 shadow-sm space-y-4">
                                                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 pb-3">
                                                    <div className="min-w-0 flex-1">
                                                        <h2 className="font-bold text-base text-foreground leading-snug truncate">{ytTitle}</h2>
                                                        <p className="text-[11px] text-muted-foreground mt-0.5">
                                                            Created {new Date(post.created_at).toLocaleDateString()} · ID: {post.id.slice(0, 8)}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <SinglePlatformPublishButton
                                                            postId={post.id}
                                                            platform="youtube"
                                                            label="YouTube"
                                                            isPublished={isPublished}
                                                            onPublished={handlePublishedUpdate}
                                                        />
                                                        <Button
                                                            variant="outline"
                                                            size="icon"
                                                            onClick={() => handleOpenEdit("social", post, "youtube")}
                                                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                                            title="Edit YouTube Video"
                                                        >
                                                            <Pencil size={13} />
                                                        </Button>
                                                        <Button
                                                            variant="outline"
                                                            size="icon"
                                                            onClick={() => handleOpenDelete(post.id, ytTitle, "social", "YouTube Video")}
                                                            className="h-8 w-8 text-destructive/80 hover:text-destructive hover:bg-destructive/10 hover:border-destructive/30"
                                                            title="Delete YouTube Video"
                                                        >
                                                            <Trash2 size={13} />
                                                        </Button>
                                                    </div>
                                                </div>

                                                <div className="max-w-2xl mx-auto">
                                                    <YouTubePost
                                                        post={post.youtube || ""}
                                                        imageSrc={post.image_url}
                                                        title={ytTitle}
                                                        rawData={post.youtube_data}
                                                    />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {/* 3. Instagram Tab */}
                            {activeTab === "instagram" && (
                                <div className="space-y-6">
                                    {instagramPosts.map((post) => {
                                        const igTitle = cleanTitle(post.title);
                                        const isPublished = Boolean(post.published_to?.instagram);

                                        return (
                                            <div key={post.id} className="rounded-2xl border border-border/80 bg-card/60 p-4 sm:p-6 shadow-sm space-y-4">
                                                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 pb-3">
                                                    <div className="min-w-0 flex-1">
                                                        <h2 className="font-bold text-base text-foreground leading-snug truncate">{igTitle}</h2>
                                                        <p className="text-[11px] text-muted-foreground mt-0.5">
                                                            Created {new Date(post.created_at).toLocaleDateString()} · ID: {post.id.slice(0, 8)}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <SinglePlatformPublishButton
                                                            postId={post.id}
                                                            platform="instagram"
                                                            label="Instagram"
                                                            isPublished={isPublished}
                                                            onPublished={handlePublishedUpdate}
                                                        />
                                                        <Button
                                                            variant="outline"
                                                            size="icon"
                                                            onClick={() => handleOpenEdit("social", post, "instagram")}
                                                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                                            title="Edit Instagram Post"
                                                        >
                                                            <Pencil size={13} />
                                                        </Button>
                                                        <Button
                                                            variant="outline"
                                                            size="icon"
                                                            onClick={() => handleOpenDelete(post.id, igTitle, "social", "Instagram Post")}
                                                            className="h-8 w-8 text-destructive/80 hover:text-destructive hover:bg-destructive/10 hover:border-destructive/30"
                                                            title="Delete Instagram Post"
                                                        >
                                                            <Trash2 size={13} />
                                                        </Button>
                                                    </div>
                                                </div>

                                                <div className="max-w-xl mx-auto">
                                                    <InstagramPost
                                                        post={post.instagram || ""}
                                                        imageSrc={post.image_url}
                                                        title={igTitle}
                                                        rawData={post.instagram_data}
                                                    />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {/* 4. Facebook Tab */}
                            {activeTab === "facebook" && (
                                <div className="space-y-6">
                                    {facebookPosts.map((post) => {
                                        const fbTitle = post.facebook_data?.title || cleanTitle(post.title);
                                        const isPublished = Boolean(post.published_to?.facebook);

                                        return (
                                            <div key={post.id} className="rounded-2xl border border-border/80 bg-card/60 p-4 sm:p-6 shadow-sm space-y-4">
                                                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 pb-3">
                                                    <div className="min-w-0 flex-1">
                                                        <h2 className="font-bold text-base text-foreground leading-snug truncate">{fbTitle}</h2>
                                                        <p className="text-[11px] text-muted-foreground mt-0.5">
                                                            Created {new Date(post.created_at).toLocaleDateString()} · ID: {post.id.slice(0, 8)}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <SinglePlatformPublishButton
                                                            postId={post.id}
                                                            platform="facebook"
                                                            label="Facebook"
                                                            isPublished={isPublished}
                                                            onPublished={handlePublishedUpdate}
                                                        />
                                                        <Button
                                                            variant="outline"
                                                            size="icon"
                                                            onClick={() => handleOpenEdit("social", post, "facebook")}
                                                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                                            title="Edit Facebook Post"
                                                        >
                                                            <Pencil size={13} />
                                                        </Button>
                                                        <Button
                                                            variant="outline"
                                                            size="icon"
                                                            onClick={() => handleOpenDelete(post.id, fbTitle, "social", "Facebook Post")}
                                                            className="h-8 w-8 text-destructive/80 hover:text-destructive hover:bg-destructive/10 hover:border-destructive/30"
                                                            title="Delete Facebook Post"
                                                        >
                                                            <Trash2 size={13} />
                                                        </Button>
                                                    </div>
                                                </div>

                                                <div className="max-w-2xl mx-auto">
                                                    <FacebookPost
                                                        post={post.facebook || ""}
                                                        imageSrc={post.image_url}
                                                        title={fbTitle}
                                                        rawData={post.facebook_data}
                                                    />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {/* 5. X / Twitter Tab */}
                            {activeTab === "twitter" && (
                                <div className="space-y-6">
                                    {twitterPosts.map((post) => {
                                        const twTitle = cleanTitle(post.title);
                                        const isPublished = Boolean(post.published_to?.twitter);

                                        return (
                                            <div key={post.id} className="rounded-2xl border border-border/80 bg-card/60 p-4 sm:p-6 shadow-sm space-y-4">
                                                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 pb-3">
                                                    <div className="min-w-0 flex-1">
                                                        <h2 className="font-bold text-base text-foreground leading-snug truncate">{twTitle}</h2>
                                                        <p className="text-[11px] text-muted-foreground mt-0.5">
                                                            Created {new Date(post.created_at).toLocaleDateString()} · ID: {post.id.slice(0, 8)}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <SinglePlatformPublishButton
                                                            postId={post.id}
                                                            platform="twitter"
                                                            label="X"
                                                            isPublished={isPublished}
                                                            onPublished={handlePublishedUpdate}
                                                        />
                                                        <Button
                                                            variant="outline"
                                                            size="icon"
                                                            onClick={() => handleOpenEdit("social", post, "twitter")}
                                                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                                            title="Edit X Post"
                                                        >
                                                            <Pencil size={13} />
                                                        </Button>
                                                        <Button
                                                            variant="outline"
                                                            size="icon"
                                                            onClick={() => handleOpenDelete(post.id, twTitle, "social", "X Tweet")}
                                                            className="h-8 w-8 text-destructive/80 hover:text-destructive hover:bg-destructive/10 hover:border-destructive/30"
                                                            title="Delete X Post"
                                                        >
                                                            <Trash2 size={13} />
                                                        </Button>
                                                    </div>
                                                </div>

                                                <div className="max-w-xl mx-auto">
                                                    <TwitterPost
                                                        post={post.twitter}
                                                        imageSrc={post.image_url}
                                                        title={twTitle}
                                                        rawData={post.twitter_data}
                                                    />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {/* 6. LinkedIn Tab */}
                            {activeTab === "linkedin" && (
                                <div className="space-y-6">
                                    {linkedinPosts.map((post) => {
                                        const liTitle = post.linkedin_data?.title || cleanTitle(post.title);
                                        const isPublished = Boolean(post.published_to?.linkedin);

                                        return (
                                            <div key={post.id} className="rounded-2xl border border-border/80 bg-card/60 p-4 sm:p-6 shadow-sm space-y-4">
                                                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 pb-3">
                                                    <div className="min-w-0 flex-1">
                                                        <h2 className="font-bold text-base text-foreground leading-snug truncate">{liTitle}</h2>
                                                        <p className="text-[11px] text-muted-foreground mt-0.5">
                                                            Created {new Date(post.created_at).toLocaleDateString()} · ID: {post.id.slice(0, 8)}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <SinglePlatformPublishButton
                                                            postId={post.id}
                                                            platform="linkedin"
                                                            label="LinkedIn"
                                                            isPublished={isPublished}
                                                            onPublished={handlePublishedUpdate}
                                                        />
                                                        <Button
                                                            variant="outline"
                                                            size="icon"
                                                            onClick={() => handleOpenEdit("social", post, "linkedin")}
                                                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                                            title="Edit LinkedIn Post"
                                                        >
                                                            <Pencil size={13} />
                                                        </Button>
                                                        <Button
                                                            variant="outline"
                                                            size="icon"
                                                            onClick={() => handleOpenDelete(post.id, liTitle, "social", "LinkedIn Post")}
                                                            className="h-8 w-8 text-destructive/80 hover:text-destructive hover:bg-destructive/10 hover:border-destructive/30"
                                                            title="Delete LinkedIn Post"
                                                        >
                                                            <Trash2 size={13} />
                                                        </Button>
                                                    </div>
                                                </div>

                                                <div className="max-w-2xl mx-auto">
                                                    <LinkedInPost
                                                        post={post.linkedin || ""}
                                                        imageSrc={post.image_url}
                                                        title={liTitle}
                                                        rawData={post.linkedin_data}
                                                    />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}
                </main>

                {/* ── Modals: Edit & Delete ── */}
                <PostEditDialog
                    open={editModalOpen}
                    onOpenChange={setEditModalOpen}
                    editTarget={editTarget}
                    onSaved={handleSaveEdit}
                />

                <DeleteConfirmDialog
                    open={deleteModalOpen}
                    onOpenChange={setDeleteModalOpen}
                    deleteTarget={deleteTarget}
                    onConfirmDelete={handleConfirmDelete}
                />
            </div>
        </PluginGate>
    );
}
