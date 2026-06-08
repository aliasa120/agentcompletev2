"use client";

import React, { useState, useEffect, useMemo } from "react";
import { CardShell, QueryChip } from "./CardShell";
import { useCardPhase } from "./useCardPhase";
import { useTypingAnimation } from "./useTypingAnimation";
import type { ToolCall } from "@/app/types/types";
import { FileCode, Twitter, Instagram, Facebook, RefreshCw } from "lucide-react";

const ACCENT = "#3B82F6"; // Royal Blue for writing files

interface SocialPosts {
  twitter: string;
  instagram: string;
  facebook: string;
  imagePath: string;
}

/**
 * Parses the raw markdown text inside social_posts.md to extract X/Twitter, Instagram, Facebook posts and images.
 */
function parseSocialPosts(content: string): SocialPosts {
  if (!content) return { twitter: "", instagram: "", facebook: "", imagePath: "" };

  const twitterMatch = content.match(/## X \(Twitter\)\s*\n([\s\S]*?)(?=\n---\n|\n##|$)/i);
  const instagramMatch = content.match(/## Instagram\s*\n([\s\S]*?)(?=\n---\n|\n##|$)/i);
  const facebookMatch = content.match(/## Facebook\s*\n([\s\S]*?)(?=\n---\n|\n##|$)/i);
  
  // Look for any image path like output/candidate_images/... or output/social_post.jpg
  const imageMatch = content.match(/## Images\s*\n\s*-\s*(.*)/i) || 
                     content.match(/output\/candidate_images\/[\w.-]+/i) ||
                     content.match(/output\/social_post\.jpg/i);
                     
  let imagePath = imageMatch ? imageMatch[0].replace(/-\s*/, "").trim() : "";

  const cleanPostText = (text: string) => {
    if (!text) return "";
    return text.replace(/^```markdown\n|^```\n|```$/g, "").trim();
  };

  return {
    twitter: cleanPostText(twitterMatch ? twitterMatch[1] : ""),
    instagram: cleanPostText(instagramMatch ? instagramMatch[1] : ""),
    facebook: cleanPostText(facebookMatch ? facebookMatch[1] : ""),
    imagePath,
  };
}

export const FileWriteCard = React.memo<{ toolCall: ToolCall }>(({ toolCall }) => {
  const args = toolCall.args as Record<string, unknown>;
  const path = String(args.path ?? args.file_path ?? "unknown file");
  const rawContent = String(args.content ?? args.code ?? "");
  const result = toolCall.result ?? "";
  const hasResult = Boolean(result) || toolCall.status === "completed";

  const isSocialPost = path.includes("social_posts.md") || rawContent.includes("## X (Twitter)") || rawContent.includes("## Instagram");

  const { phase } = useCardPhase(toolCall.status, hasResult, 12, rawContent.length);

  // We only run typewriter animation for non-social posts (normal code files)
  const isCompleted = toolCall.status !== "pending";
  const { displayText, isDone } = useTypingAnimation(
    rawContent,
    8,
    phase === "querying" || phase === "loading",
    isCompleted
  );

  // Parsed social posts
  const parsedPosts = useMemo(() => parseSocialPosts(rawContent), [rawContent]);

  // Tab management for Social previews
  const [activeTab, setActiveTab] = useState<"twitter" | "instagram" | "facebook" | "raw">("twitter");
  const [isAutoShuffling, setIsAutoShuffling] = useState(true);

  // 1. Follow the writer: while writing, auto-switch to the tab currently being typed
  useEffect(() => {
    if (toolCall.status === "pending" && isSocialPost) {
      if (rawContent.includes("## Facebook") && parsedPosts.facebook) {
        setActiveTab("facebook");
      } else if (rawContent.includes("## Instagram") && parsedPosts.instagram) {
        setActiveTab("instagram");
      } else if (rawContent.includes("## X (Twitter)") && parsedPosts.twitter) {
        setActiveTab("twitter");
      }
    }
  }, [rawContent, toolCall.status, isSocialPost, parsedPosts]);

  // 2. Auto-shuffle: once completed, cycle through the social tabs every 4 seconds
  useEffect(() => {
    if (toolCall.status !== "pending" && isSocialPost && isAutoShuffling) {
      const tabs: Array<"twitter" | "instagram" | "facebook"> = [];
      if (parsedPosts.twitter) tabs.push("twitter");
      if (parsedPosts.instagram) tabs.push("instagram");
      if (parsedPosts.facebook) tabs.push("facebook");

      if (tabs.length <= 1) return;

      const interval = setInterval(() => {
        setActiveTab((current) => {
          const currentIndex = tabs.indexOf(current as any);
          const nextIndex = (currentIndex + 1) % tabs.length;
          return tabs[nextIndex];
        });
      }, 4000);

      return () => clearInterval(interval);
    }
  }, [toolCall.status, isSocialPost, isAutoShuffling, parsedPosts]);

  // Image cache buster
  const imageSrc = useMemo(() => {
    if (!parsedPosts.imagePath) return null;
    return `/api/image/social?t=${Date.now()}`;
  }, [parsedPosts.imagePath]);

  return (
    <CardShell
      title={`💾 Writing file`}
      accentColor={ACCENT}
      phase={phase}
      toggleable={hasResult}
    >
      <div className="flex flex-col gap-3">
        {/* File Path Title Block */}
        <QueryChip accentColor={ACCENT}>
          <div className="flex items-center gap-1.5 font-mono text-[11.5px] text-foreground">
            <FileCode size={13} style={{ color: ACCENT }} />
            <span className="truncate max-w-[280px]">{path}</span>
          </div>
        </QueryChip>

        {/* SOCIAL POST RENDERING WITH PREVIEWS */}
        {isSocialPost ? (
          <div className="mt-1 border border-border rounded-xl overflow-hidden bg-muted/10">
            {/* Tabs Selector Header */}
            <div className="flex items-center justify-between border-b border-border bg-muted/40 px-2 py-1">
              <div className="flex items-center gap-1 overflow-x-auto">
                <button
                  onClick={() => { setActiveTab("twitter"); setIsAutoShuffling(false); }}
                  className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
                    activeTab === "twitter" ? "bg-foreground text-background" : "hover:bg-muted text-muted-foreground"
                  }`}
                >
                  <Twitter size={11} />
                  Twitter
                </button>
                <button
                  onClick={() => { setActiveTab("instagram"); setIsAutoShuffling(false); }}
                  className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
                    activeTab === "instagram" ? "bg-foreground text-background" : "hover:bg-muted text-muted-foreground"
                  }`}
                >
                  <Instagram size={11} />
                  Instagram
                </button>
                <button
                  onClick={() => { setActiveTab("facebook"); setIsAutoShuffling(false); }}
                  className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
                    activeTab === "facebook" ? "bg-foreground text-background" : "hover:bg-muted text-muted-foreground"
                  }`}
                >
                  <Facebook size={11} />
                  Facebook
                </button>
                <button
                  onClick={() => { setActiveTab("raw"); setIsAutoShuffling(false); }}
                  className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
                    activeTab === "raw" ? "bg-foreground text-background" : "hover:bg-muted text-muted-foreground"
                  }`}
                >
                  Raw Markdown
                </button>
              </div>

              {/* Auto Shuffle toggle indicator */}
              {isSocialPost && toolCall.status !== "pending" && (
                <button
                  onClick={() => setIsAutoShuffling((s) => !s)}
                  title={isAutoShuffling ? "Pause Auto Shuffle" : "Resume Auto Shuffle"}
                  className={`p-1 rounded transition-colors ${isAutoShuffling ? "text-emerald-500 bg-emerald-500/10" : "text-muted-foreground hover:bg-muted"}`}
                >
                  <RefreshCw size={11} className={isAutoShuffling ? "animate-spin" : ""} style={{ animationDuration: "8s" }} />
                </button>
              )}
            </div>

            {/* Platform Previews */}
            <div className="p-3 bg-card flex items-center justify-center min-h-[160px] transition-all duration-300">
              {activeTab === "twitter" && (
                <div className="w-full max-w-sm rounded-xl p-3 border bg-black text-white border-neutral-800 font-sans shadow-md" style={{ animation: "agentFadeIn 0.3s ease both" }}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-emerald-700 flex items-center justify-center font-bold text-white text-[13px] border border-neutral-700 shadow-inner">
                        E
                      </div>
                      <div className="flex flex-col">
                        <div className="flex items-center gap-1 leading-none">
                          <span className="font-bold text-[12.5px]">The Echo</span>
                          <span className="w-3 h-3 bg-[#1D9BF0] rounded-full flex items-center justify-center text-[7px] text-white select-none">✓</span>
                        </div>
                        <span className="text-[10.5px] text-neutral-400">@the_echo_pk</span>
                      </div>
                    </div>
                    <Twitter size={14} className="text-[#1D9BF0]" />
                  </div>
                  <p className="text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-neutral-100">
                    {parsedPosts.twitter || <span className="text-neutral-500 italic">Writing Twitter post...</span>}
                  </p>
                  <div className="flex items-center justify-between mt-3 pt-2 border-t border-neutral-900 text-neutral-500 text-[10.5px]">
                    <span>💬 0</span>
                    <span>🔁 0</span>
                    <span>❤️ 1</span>
                    <span className={`text-[10px] ${parsedPosts.twitter.length > 280 ? "text-red-500 font-bold" : "text-neutral-500"}`}>
                      {parsedPosts.twitter.length}/280
                    </span>
                  </div>
                </div>
              )}

              {activeTab === "instagram" && (
                <div className="w-full max-w-sm rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white text-black dark:bg-[#121212] dark:text-white overflow-hidden shadow-md" style={{ animation: "agentFadeIn 0.3s ease both" }}>
                  <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-100 dark:border-neutral-900">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-gradient-to-tr from-yellow-500 via-red-500 to-purple-600 p-[1px]">
                        <div className="w-full h-full rounded-full bg-white dark:bg-[#121212] flex items-center justify-center font-bold text-[9px]">
                          E
                        </div>
                      </div>
                      <span className="font-semibold text-[11px]">the_echo_pk</span>
                    </div>
                    <Instagram size={14} className="text-pink-500" />
                  </div>

                  {/* Square image frame */}
                  <div className="w-full aspect-square bg-neutral-100 dark:bg-neutral-900 relative flex flex-col items-center justify-center overflow-hidden">
                    {imageSrc ? (
                      <img src={imageSrc} alt="Instagram post visual" className="w-full h-full object-cover" />
                    ) : (
                      <div className="absolute inset-0 bg-gradient-to-tr from-pink-500/10 via-red-500/5 to-yellow-500/10 animate-pulse flex flex-col items-center justify-center gap-2 px-4 text-center">
                        <span className="text-pink-500 font-semibold text-xs">Waiting for Generated Image...</span>
                        <div className="w-6 h-6 border-2 border-pink-500 border-t-transparent rounded-full animate-spin"></div>
                        <span className="text-[10px] text-muted-foreground">Image pipeline will inject visual automatically</span>
                      </div>
                    )}
                  </div>

                  <div className="p-3">
                    <div className="flex items-center justify-between mb-1.5 text-neutral-700 dark:text-neutral-300">
                      <div className="flex items-center gap-3">
                        <span>❤️</span>
                        <span>💬</span>
                        <span>✈️</span>
                      </div>
                      <span>🔖</span>
                    </div>
                    <div className="text-[11px] font-semibold mb-1">Liked by <b>agentic_ai</b> and <b>others</b></div>
                    <p className="text-[11.5px] leading-relaxed break-words whitespace-pre-wrap">
                      <span className="font-semibold mr-1">the_echo_pk</span>
                      {parsedPosts.instagram || <span className="text-neutral-400 italic">Writing Instagram post...</span>}
                    </p>
                  </div>
                </div>
              )}

              {activeTab === "facebook" && (
                <div className="w-full max-w-sm rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white text-black dark:bg-[#242526] dark:text-white p-3 shadow-md" style={{ animation: "agentFadeIn 0.3s ease both" }}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-[#1877F2] flex items-center justify-center font-bold text-white text-[13px]">
                        E
                      </div>
                      <div>
                        <span className="font-bold text-[12.5px] leading-none block">The Echo Pakistan</span>
                        <span className="text-[9.5px] text-neutral-400 block mt-0.5">Just now • 🌐</span>
                      </div>
                    </div>
                    <Facebook size={14} className="text-[#1877F2]" />
                  </div>
                  <p className="text-[12.5px] leading-relaxed break-words whitespace-pre-wrap mb-2">
                    {parsedPosts.facebook || <span className="text-neutral-400 italic">Writing Facebook post...</span>}
                  </p>
                  {imageSrc && (
                    <div className="w-full aspect-[16/9] bg-neutral-100 dark:bg-neutral-900 rounded-lg overflow-hidden mb-2">
                      <img src={imageSrc} alt="Facebook post visual" className="w-full h-full object-cover" />
                    </div>
                  )}
                  <div className="flex items-center justify-around border-t border-neutral-100 dark:border-neutral-800 pt-2 mt-2 text-neutral-500 dark:text-neutral-400 text-[11px] font-semibold">
                    <span>👍 Like</span>
                    <span>💬 Comment</span>
                    <span>➡️ Share</span>
                  </div>
                </div>
              )}

              {activeTab === "raw" && (
                <div className="w-full" style={{ animation: "agentFadeIn 0.3s ease both" }}>
                  <pre className="m-0 p-2.5 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-all border border-border rounded-lg max-h-60 overflow-y-auto bg-muted/20">
                    {rawContent}
                  </pre>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* REGULAR FILE WRITING CODE VIEW */
          <div className="mt-1 border border-border rounded-lg overflow-hidden" style={{ animation: "agentFadeIn 0.3s ease both" }}>
            <div className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 text-muted-foreground border-b border-border bg-muted/20 flex items-center justify-between">
              <span>Code Editor</span>
              {toolCall.status === "pending" && <span className="animate-pulse text-blue-500">Writing...</span>}
            </div>
            <pre className="m-0 p-2.5 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-all max-h-60 overflow-y-auto bg-muted/10">
              {phase === "querying" || phase === "loading" ? displayText : rawContent}
              {(phase === "querying" || phase === "loading") && !isDone && (
                <span className="w-1.5 h-3 bg-blue-500 inline-block animate-pulse ml-0.5" />
              )}
            </pre>
          </div>
        )}

        {/* Written notification status */}
        {hasResult && (
          <div className="text-[11px] font-semibold text-emerald-500 flex items-center gap-1.5" style={{ animation: "agentFadeIn 0.3s ease both" }}>
            ✓ File written successfully
          </div>
        )}
      </div>
    </CardShell>
  );
});

FileWriteCard.displayName = "FileWriteCard";
