"use client";

import React, { useState, useEffect, useMemo } from "react";
import { CardShell, QueryChip } from "./CardShell";
import { useCardPhase } from "./useCardPhase";
import { useTypingAnimation } from "./useTypingAnimation";
import type { ToolCall } from "@/app/types/types";
import {
  FileCode,
  Twitter,
  Instagram,
  Facebook,
  RefreshCw,
  CheckCircle2,
} from "lucide-react";

import { cardAccent, tw } from "@/lib/theme";

interface SocialPosts {
  twitter: string;
  instagram: string;
  facebook: string;
  imagePath: string;
}

function parseSocialPosts(content: string): SocialPosts {
  if (!content) return { twitter: "", instagram: "", facebook: "", imagePath: "" };
  const twitterMatch = content.match(
    /## X \(Twitter\)\s*\n([\s\S]*?)(?=\n---\n|\n##|$)/i
  );
  const instagramMatch = content.match(
    /## Instagram\s*\n([\s\S]*?)(?=\n---\n|\n##|$)/i
  );
  const facebookMatch = content.match(
    /## Facebook\s*\n([\s\S]*?)(?=\n---\n|\n##|$)/i
  );
  const imageMatch =
    content.match(/## Images\s*\n\s*-\s*(.*)/i) ||
    content.match(/output\/candidate_images\/[\w.-]+/i) ||
    content.match(/output\/social_post\.jpg/i);
  const imagePath = imageMatch
    ? imageMatch[0].replace(/-\s*/, "").trim()
    : "";
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

type SocialTab = "twitter" | "instagram" | "facebook" | "raw";

export const FileWriteCard = React.memo<{ toolCall: ToolCall }>(
  ({ toolCall }) => {
    const args = toolCall.args as Record<string, unknown>;
    const path = String(args.path ?? args.file_path ?? "unknown file");
    const rawContent = String(args.content ?? args.code ?? "");
    const result = toolCall.result ?? "";
    const hasResult = Boolean(result) || toolCall.status === "completed";

    const isSocialPost =
      path.includes("social_posts.md") ||
      rawContent.includes("## X (Twitter)") ||
      rawContent.includes("## Instagram");

    const { phase } = useCardPhase(
      toolCall.status,
      hasResult,
      12,
      rawContent.length
    );

    const isCompleted = toolCall.status !== "pending";
    const { displayText, isDone } = useTypingAnimation(
      rawContent,
      8,
      phase === "querying" || phase === "loading",
      isCompleted
    );

    const parsedPosts = useMemo(
      () => parseSocialPosts(rawContent),
      [rawContent]
    );

    const [activeTab, setActiveTab] = useState<SocialTab>("twitter");
    const [isAutoShuffling, setIsAutoShuffling] = useState(true);

    useEffect(() => {
      if (toolCall.status === "pending" && isSocialPost) {
        if (rawContent.includes("## Facebook") && parsedPosts.facebook) {
          setActiveTab("facebook");
        } else if (
          rawContent.includes("## Instagram") &&
          parsedPosts.instagram
        ) {
          setActiveTab("instagram");
        } else if (
          rawContent.includes("## X (Twitter)") &&
          parsedPosts.twitter
        ) {
          setActiveTab("twitter");
        }
      }
    }, [rawContent, toolCall.status, isSocialPost, parsedPosts]);

    useEffect(() => {
      if (
        toolCall.status !== "pending" &&
        isSocialPost &&
        isAutoShuffling
      ) {
        const tabs: Array<"twitter" | "instagram" | "facebook"> = [];
        if (parsedPosts.twitter) tabs.push("twitter");
        if (parsedPosts.instagram) tabs.push("instagram");
        if (parsedPosts.facebook) tabs.push("facebook");
        if (tabs.length <= 1) return;
        const interval = setInterval(() => {
          setActiveTab((current) => {
            const idx = tabs.indexOf(current as any);
            return tabs[(idx + 1) % tabs.length];
          });
        }, 4000);
        return () => clearInterval(interval);
      }
    }, [toolCall.status, isSocialPost, isAutoShuffling, parsedPosts]);

    const imageSrc = useMemo(() => {
      if (!parsedPosts.imagePath) return null;
      return `/api/image/social?t=${Date.now()}`;
    }, [parsedPosts.imagePath]);

    return (
      <CardShell
        title="💾 Writing file"
        accentColor={cardAccent.fileWrite}
        phase={phase}
        toggleable={hasResult}
      >
        <div className="flex flex-col gap-3">
          {/* File path chip */}
          <QueryChip>
            <div className="flex items-center gap-1.5 font-mono text-[11px] text-foreground">
              <FileCode size={12} className="text-primary shrink-0" />
              <span className="truncate max-w-[260px] text-muted-foreground">{path}</span>
            </div>
          </QueryChip>

          {/* ── SOCIAL POST RENDERING ── */}
          {isSocialPost ? (
            <div className="border border-border rounded-xl overflow-hidden">
              {/* Tab bar */}
              <div className="flex items-center justify-between border-b border-border bg-muted/50 px-2 py-1 gap-1">
                <div className="flex items-center gap-0.5 overflow-x-auto">
                  {(
                    [
                      { key: "twitter" as SocialTab, icon: Twitter, label: "Twitter" },
                      { key: "instagram" as SocialTab, icon: Instagram, label: "Instagram" },
                      { key: "facebook" as SocialTab, icon: Facebook, label: "Facebook" },
                      { key: "raw" as SocialTab, icon: null, label: "Raw" },
                    ] as const
                  ).map(({ key, icon: Icon, label }) => (
                    <button
                      key={key}
                      onClick={() => {
                        setActiveTab(key);
                        setIsAutoShuffling(false);
                      }}
                      className={[
                        "flex items-center gap-1 px-2.5 py-1 text-[10.5px] font-semibold rounded-md transition-all shrink-0",
                        activeTab === key
                          ? "bg-foreground text-background"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted",
                      ].join(" ")}
                    >
                      {Icon && <Icon size={10} />}
                      {label}
                    </button>
                  ))}
                </div>
                {isSocialPost && toolCall.status !== "pending" && (
                  <button
                    onClick={() => setIsAutoShuffling((s) => !s)}
                    className={[
                      "p-1 rounded-md transition-colors shrink-0",
                      isAutoShuffling
                        ? "text-primary bg-primary/10"
                        : "text-muted-foreground hover:bg-muted",
                    ].join(" ")}
                  >
                    <RefreshCw
                      size={11}
                      className={isAutoShuffling ? "animate-spin" : ""}
                      style={{ animationDuration: "8s" }}
                    />
                  </button>
                )}
              </div>

              {/* Preview */}
              <div className="p-3 bg-card min-h-[160px] flex items-center justify-center">
                {activeTab === "twitter" && (
                  <div
                    className="w-full max-w-sm rounded-xl p-3 border border-neutral-800 bg-[#0f1924] text-white font-sans shadow-lg"
                    style={{ animation: "agentFadeIn 0.3s ease both" }}
                  >
                    <div className="flex items-center justify-between mb-2.5">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-emerald-700 flex items-center justify-center font-bold text-white text-[13px] border border-neutral-700">
                          E
                        </div>
                        <div className="flex flex-col leading-tight">
                          <div className="flex items-center gap-1">
                            <span className="font-bold text-[12.5px]">The Echo</span>
                            <span className="w-3 h-3 bg-[#1D9BF0] rounded-full flex items-center justify-center text-[7px] text-white">✓</span>
                          </div>
                          <span className="text-[10.5px] text-neutral-400">@the_echo_pk</span>
                        </div>
                      </div>
                      <Twitter size={14} className="text-[#1D9BF0]" />
                    </div>
                    <p className="text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-neutral-100">
                      {parsedPosts.twitter || (
                        <span className="text-neutral-500 italic">
                          Writing Twitter post...
                        </span>
                      )}
                    </p>
                    <div className="flex items-center justify-between mt-3 pt-2 border-t border-neutral-800 text-neutral-500 text-[10.5px]">
                      <span>💬 0</span>
                      <span>🔁 0</span>
                      <span>❤️ 1</span>
                      <span
                        className={
                          parsedPosts.twitter.length > 280
                            ? "text-red-500 font-bold"
                            : ""
                        }
                      >
                        {parsedPosts.twitter.length}/280
                      </span>
                    </div>
                  </div>
                )}

                {activeTab === "instagram" && (
                  <div
                    className="w-full max-w-sm rounded-xl border border-border bg-card overflow-hidden shadow-md"
                    style={{ animation: "agentFadeIn 0.3s ease both" }}
                  >
                    <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-gradient-to-tr from-yellow-500 via-red-500 to-purple-600 p-[1.5px]">
                          <div className="w-full h-full rounded-full bg-card flex items-center justify-center font-bold text-[9px] text-foreground">
                            E
                          </div>
                        </div>
                        <span className="font-semibold text-[11px] text-foreground">
                          the_echo_pk
                        </span>
                      </div>
                      <Instagram size={14} className="text-pink-500" />
                    </div>
                    <div className="w-full aspect-square bg-muted relative flex flex-col items-center justify-center overflow-hidden">
                      {imageSrc ? (
                        <img
                          src={imageSrc}
                          alt="Instagram post"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="absolute inset-0 bg-gradient-to-tr from-pink-500/10 via-red-500/5 to-yellow-500/10 animate-pulse flex flex-col items-center justify-center gap-2">
                          <span className="text-pink-500 font-semibold text-xs">
                            Waiting for image…
                          </span>
                          <div className="w-5 h-5 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <div className="flex items-center justify-between mb-1.5 text-muted-foreground">
                        <div className="flex items-center gap-3">
                          <span>❤️</span>
                          <span>💬</span>
                          <span>✈️</span>
                        </div>
                        <span>🔖</span>
                      </div>
                      <p className="text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground">
                        <span className="font-semibold mr-1">the_echo_pk</span>
                        {parsedPosts.instagram || (
                          <span className="text-muted-foreground italic">
                            Writing Instagram post...
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                )}

                {activeTab === "facebook" && (
                  <div
                    className="w-full max-w-sm rounded-xl border border-border bg-card p-3 shadow-md"
                    style={{ animation: "agentFadeIn 0.3s ease both" }}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-[#1877F2] flex items-center justify-center font-bold text-white text-[13px]">
                          E
                        </div>
                        <div>
                          <span className="font-bold text-[12.5px] leading-none block text-foreground">
                            The Echo Pakistan
                          </span>
                          <span className="text-[9.5px] text-muted-foreground block mt-0.5">
                            Just now · 🌐
                          </span>
                        </div>
                      </div>
                      <Facebook size={14} className="text-[#1877F2]" />
                    </div>
                    <p className="text-[12.5px] leading-relaxed break-words whitespace-pre-wrap mb-2 text-foreground">
                      {parsedPosts.facebook || (
                        <span className="text-muted-foreground italic">
                          Writing Facebook post...
                        </span>
                      )}
                    </p>
                    {imageSrc && (
                      <div className="w-full aspect-[16/9] bg-muted rounded-lg overflow-hidden mb-2">
                        <img
                          src={imageSrc}
                          alt="Facebook post"
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}
                    <div className="flex items-center justify-around border-t border-border pt-2 mt-2 text-muted-foreground text-[11px] font-semibold">
                      <span>👍 Like</span>
                      <span>💬 Comment</span>
                      <span>➡️ Share</span>
                    </div>
                  </div>
                )}

                {activeTab === "raw" && (
                  <div
                    className="w-full"
                    style={{ animation: "agentFadeIn 0.3s ease both" }}
                  >
                    <pre className="m-0 p-2.5 font-mono text-[10.5px] leading-relaxed text-foreground whitespace-pre-wrap break-all border border-border rounded-lg max-h-60 overflow-y-auto bg-muted/30">
                      {rawContent}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* ── REGULAR CODE VIEW ── */
            <div
              className="border border-border rounded-lg overflow-hidden"
              style={{ animation: "agentFadeIn 0.3s ease both" }}
            >
              <div className="flex items-center justify-between text-[9.5px] font-bold uppercase tracking-widest px-3 py-1.5 text-muted-foreground border-b border-border bg-muted/50">
                <span>Code Editor</span>
                {toolCall.status === "pending" && (
                  <span className="text-primary animate-pulse font-semibold">
                    Writing…
                  </span>
                )}
              </div>
              <pre className="m-0 px-3 py-2.5 font-mono text-[10.5px] leading-relaxed text-foreground whitespace-pre-wrap break-all max-h-60 overflow-y-auto bg-card">
                {phase === "querying" || phase === "loading"
                  ? displayText
                  : rawContent}
                {(phase === "querying" || phase === "loading") && !isDone && (
                  <span className="w-1.5 h-3 bg-primary inline-block animate-pulse ml-0.5 rounded-sm" />
                )}
              </pre>
            </div>
          )}

          {/* Success */}
          {hasResult && (
            <div
              className="text-[11px] font-semibold text-primary flex items-center gap-1.5"
              style={{ animation: "agentFadeIn 0.3s ease both" }}
            >
              <CheckCircle2 size={12} /> File written successfully
            </div>
          )}
        </div>
      </CardShell>
    );
  }
);

FileWriteCard.displayName = "FileWriteCard";
