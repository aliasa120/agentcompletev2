"use client";

import React, { useState, useEffect } from "react";
import { Loader2, Zap, Package, ChevronDown, ChevronRight, ToggleRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { JanCard } from "@/components/settings/JanCard";

const BUILTIN_TOOLS = [
  { key: "unified_search", label: "Web Search", desc: "Tavily, Linkup, Parallel AI" },
  { key: "unified_extract", label: "URL Extractor", desc: "Exa AI, Tavily Extract" },
  { key: "think_tool", label: "Think Tool", desc: "Internal reasoning" },
  { key: "fetch_images_brave", label: "Brave Image Search", desc: "OG image fetcher" },
  { key: "view_candidate_images", label: "View Candidates", desc: "Download & cache images" },
  { key: "create_post_image", label: "Image Generator", desc: "KIE AI / Gemini" },
  { key: "read_skill", label: "Read Skill", desc: "Load SKILL.md instructions" },
  { key: "save_posts_to_supabase", label: "Save to DB", desc: "Supabase storage" },
  { key: "get_wordpress_categories", label: "WP Categories", desc: "Fetch WordPress categories" },
  { key: "publish_to_wordpress", label: "WordPress Publish", desc: "WP REST API" },
  { key: "youtube_transcript", label: "YouTube Transcript", desc: "Get video transcripts without keys via youtube-transcript.ai" },
  { key: "search_conversation_history", label: "Smart Search History", desc: "3-Strategy (Full-text + Semantic + Entity Probe) search over history and memory files" },
  { key: "add_memory", label: "Add Memory", desc: "Save new fact to USER.md or MEMORY.md" },
  { key: "replace_memory", label: "Replace Memory", desc: "Update existing memory fact or user preference" },
  { key: "remove_memory", label: "Remove Memory", desc: "Delete invalidated memory fact" },
  { key: "honcho_search", label: "Honcho Search", desc: "Hybrid search over Honcho cloud message history" },
  { key: "honcho_reasoning", label: "Honcho Reasoning", desc: "Dialectic LLM agent for multi-hop synthesis" },
  { key: "list_tools", label: "List Tools", desc: "Discover tools via semantic search" },
  { key: "load_tools", label: "Load Tools", desc: "Load parameters and schemas on demand" },
  { key: "call_tool", label: "Call Tool", desc: "Execute dynamically routed tools" },
  { key: "cronjob", label: "Cron Scheduler", desc: "Manage scheduled tasks and background ticks" },
  { key: "omni_analyzer", label: "Omni Analyzer", desc: "Analyze ANY file or URL (images, audio, video, documents)" },
  { key: "text_to_speech", label: "Text to Speech (Voice)", desc: "Convert text to spoken audio via ElevenLabs, Edge, or OpenAI" },
  { key: "terminal", label: "Terminal", desc: "Execute OS shell commands (hardline blocklist enforced)" },
  { key: "ask_permission", label: "Ask Permission (HITL)", desc: "Agent requests explicit human approval before risky/destructive actions" },
];

export function BuiltinToolsPanel({ onReloadAgent }: { onReloadAgent?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [builtinModes, setBuiltinModes] = useState<Record<string, string>>({});

  useEffect(() => {
    async function loadBuiltinModes() {
      try {
        let { data, error } = await supabase
          .from("agent_settings")
          .select("value")
          .eq("key", "builtin_tools_loading_modes")
          .single();
        if (error) {
          if (error.code === "PGRST116") {
            // Row not found in fresh/truncated database — expected
            setBuiltinModes({});
            return;
          }
          if (error.code === "PGRST303" || error.message?.includes("JWT expired")) {
            await supabase.auth.signOut().catch(() => {});
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (key && key.includes("-auth-token")) localStorage.removeItem(key);
            }
            const retry = await supabase
              .from("agent_settings")
              .select("value")
              .eq("key", "builtin_tools_loading_modes")
              .single();
            data = retry.data;
            error = retry.error;
            if (error) {
              if (error.code !== "PGRST116") {
                console.error("Error loading built-in tool modes after retry:", error);
              } else {
                setBuiltinModes({});
              }
            }
          } else {
            console.error("Error loading built-in tool modes:", error);
          }
        }
        if (data?.value) setBuiltinModes(JSON.parse(data.value));
      } catch (e) {
        console.error("Failed to load built-in tool modes:", e);
      }
    }
    loadBuiltinModes();
  }, []);

  const handleBuiltinModeChange = async (toolKey: string, nextMode: string) => {
    const updatedModes = { ...builtinModes, [toolKey]: nextMode };
    setBuiltinModes(updatedModes);
    try {
      let { data, error } = await supabase
        .from("agent_settings")
        .upsert({
          key: "builtin_tools_loading_modes",
          value: JSON.stringify(updatedModes),
          updated_at: new Date().toISOString()
        }, { onConflict: "key" })
        .select();
      if (error) {
        if (error.code === "PGRST303" || error.message?.includes("JWT expired")) {
          await supabase.auth.signOut().catch(() => {});
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.includes("-auth-token")) localStorage.removeItem(key);
          }
          const retry = await supabase
            .from("agent_settings")
            .upsert({
              key: "builtin_tools_loading_modes",
              value: JSON.stringify(updatedModes),
              updated_at: new Date().toISOString()
            }, { onConflict: "key" })
            .select();
          if (retry.error) console.error("Error saving built-in tool modes after retry:", retry.error);
        } else {
          console.error("Error saving built-in tool modes:", error);
        }
      }
      if (onReloadAgent) onReloadAgent();
    } catch (e) {
      console.error("Failed to save built-in tool modes:", e);
    }
  };

  return (
    <JanCard className="p-0 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/20 transition-colors"
      >
        <div className="shrink-0 w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
          <Package className="h-4 w-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">Built-in Tools</p>
          <p className="text-[11px] text-muted-foreground">
            Core agent tools · {BUILTIN_TOOLS.length} tools · always active
          </p>
        </div>
        {expanded
          ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
          : <ChevronRight className="h-4 w-4 text-muted-foreground" />
        }
      </button>
      {expanded && (
        <div className="border-t bg-muted/10 p-4">
          <div className="grid grid-cols-2 gap-2">
            {BUILTIN_TOOLS.map((tool) => {
              const currentMode = builtinModes[tool.key] || "primary";
              return (
                <div key={tool.key} className="flex flex-col gap-2 p-3 rounded-lg border border-border/40 bg-card shadow-xs">
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-2 min-w-0">
                      <Zap className="h-3.5 w-3.5 text-primary shrink-0" />
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold truncate">{tool.label}</p>
                        <p className="text-[10px] font-mono text-muted-foreground truncate">{tool.key}</p>
                      </div>
                    </div>
                    <ToggleRight className="h-5 w-5 text-primary shrink-0" />
                  </div>
                  <p className="text-[10px] text-muted-foreground line-clamp-1 leading-tight">{tool.desc}</p>
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-dashed border-border/50 mt-1">
                    <span className="text-[9px] text-muted-foreground font-medium uppercase shrink-0">Indexing Mode</span>
                    <select
                      value={currentMode}
                      onChange={(e) => handleBuiltinModeChange(tool.key, e.target.value)}
                      style={{ width: "120px", minWidth: "120px", paddingLeft: "6px", paddingRight: "20px", paddingTop: "0px", paddingBottom: "0px" }}
                      className="h-6 shrink-0 text-[10px] rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-primary font-medium cursor-pointer"
                    >
                      <option value="primary">Primary</option>
                      <option value="normal">Normal</option>
                      <option value="super">Super</option>
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </JanCard>
  );
}
