"use client";

import React from "react";
import {
  Wrench, Cpu, Bot, Users, LayoutList, BookOpen, Image as ImageIcon,
  ChevronRight, Database, Settings, Menu, Brain, Route, AlarmClock, LayoutGrid, Shield
} from "lucide-react";
import { cn } from "@/lib/utils";

export type SettingsSection =
  | "env-keys"
  | "workflows"
  | "tools"
  | "tools-composio"
  | "tools-manual"
  | "tools-smithery"
  | "tools-zapier"
  | "providers"
  | "gateway"
  | "agents"
  | "subagents"
  | "skills"
  | "design-assets"
  | "queue"
  | "configuration"
  | "feeder"
  | "memories"
  | "telegram-bots"
  | "scheduled-tasks"
  | "omni-settings"
  | "additional-features";

interface NavItem {
  id: SettingsSection;
  label: string;
  description: string;
  icon: React.ReactNode;
  badge?: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "env-keys",
    label: "ENV Keys",
    description: "Your API credentials & provider keys",
    icon: <Shield className="h-4 w-4" />,
    badge: "NEW",
  },
  {
    id: "workflows",
    label: "Workflows",
    description: "Manage multiple agentic pipelines",
    icon: <LayoutList className="h-4 w-4" />,
  },
  {
    id: "scheduled-tasks",
    label: "Scheduled Tasks",
    description: "Replicated Hermes background cron jobs",
    icon: <AlarmClock className="h-4 w-4" />,
  },
  {
    id: "tools",
    label: "Tools & MCP",
    description: "Composio, manual MCP, core tools",
    icon: <Wrench className="h-4 w-4" />,
  },
  {
    id: "providers",
    label: "AI Providers",
    description: "Models, search, extract, image",
    icon: <Cpu className="h-4 w-4" />,
  },
  {
    id: "gateway",
    label: "OpenRouter Setup",
    description: "API key, custom models setup",
    icon: <Route className="h-4 w-4" />,
  },
  {
    id: "omni-settings",
    label: "Omni Analyzer",
    description: "Multimodal preflight & analyzer",
    icon: <Brain className="h-4 w-4" />,
  },
  {
    id: "agents",
    label: "Main Agents",
    description: "Prompt, tools, model per agent",
    icon: <Bot className="h-4 w-4" />,
  },
  {
    id: "subagents",
    label: "Subagents",
    description: "Specialist agents with own context",
    icon: <Users className="h-4 w-4" />,
  },
  {
    id: "skills",
    label: "Skills Library",
    description: "Instruction sets for agents",
    icon: <BookOpen className="h-4 w-4" />,
  },
  {
    id: "design-assets",
    label: "Brand Assets",
    description: "Reference images, design guide",
    icon: <ImageIcon className="h-4 w-4" />,
  },
  {
    id: "queue",
    label: "Queue & Schedule",
    description: "Auto-trigger, batch size",
    icon: <LayoutList className="h-4 w-4" />,
  },
  {
    id: "configuration",
    label: "API Configuration",
    description: "LangGraph URL, keys, assistant",
    icon: <Settings className="h-4 w-4" />,
  },
  {
    id: "feeder",
    label: "Feeder Dashboard",
    description: "Run feeder, manage queue",
    icon: <Database className="h-4 w-4" />,
  },
  {
    id: "memories",
    label: "Memories",
    description: "Manage semantic facts & graph",
    icon: <Brain className="h-4 w-4" />,
  },
  {
    id: "telegram-bots",
    label: "Platforms Connection",
    description: "Connect Telegram, Slack, Discord, & Email",
    icon: <Bot className="h-4 w-4" />,
  },
  {
    id: "additional-features",
    label: "Additional Features",
    description: "Manage content, posts, and publishing",
    icon: <LayoutGrid className="h-4 w-4" />,
  },
];

interface SettingsSidebarProps {
  active: SettingsSection;
  onChange: (s: SettingsSection) => void;
  isExpanded?: boolean;
  onToggleExpanded?: () => void;
}

export function SettingsSidebar({ active, onChange, isExpanded = true, onToggleExpanded }: SettingsSidebarProps) {
  const isToolsActive = ["tools", "tools-composio", "tools-manual", "tools-smithery", "tools-zapier"].includes(active);
  const [isToolsExpanded, setIsToolsExpanded] = React.useState(isToolsActive);
  const prevIsToolsActive = React.useRef(isToolsActive);

  React.useEffect(() => {
    if (isToolsActive && !prevIsToolsActive.current) {
      setIsToolsExpanded(true);
    } else if (!isToolsActive && prevIsToolsActive.current) {
      setIsToolsExpanded(false);
    }
    prevIsToolsActive.current = isToolsActive;
  }, [isToolsActive]);

  return (
    <nav className={cn(
      "shrink-0 flex flex-col border-r bg-card/50 h-full overflow-hidden transition-all duration-300",
      isExpanded ? "w-64" : "w-16"
    )}>
      <div className={cn(
        "p-4 border-b flex items-center justify-between h-14 shrink-0",
        !isExpanded && "justify-center px-0"
      )}>
        {isExpanded && (
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
            Settings
          </p>
        )}
        {onToggleExpanded && (
          <button
            onClick={onToggleExpanded}
            className="flex items-center justify-center h-8 w-8 rounded-lg hover:bg-accent text-foreground shrink-0 transition-colors"
            title={isExpanded ? "Collapse Sidebar" : "Expand Sidebar"}
          >
            <Menu className="h-4.5 w-4.5 text-muted-foreground hover:text-foreground shrink-0" />
          </button>
        )}
      </div>
      <div className="flex-1 py-2 overflow-y-auto scrollbar-pretty min-h-0">
        {NAV_ITEMS.map((item) => {
          if (item.id === "tools") {
            return (
              <div key={item.id} className="flex flex-col">
                <button
                  onClick={() => {
                    onChange("tools");
                    setIsToolsExpanded(true);
                  }}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 py-3 text-left transition-all group",
                    isToolsActive
                      ? "bg-primary/10 border-r-2 border-primary text-primary"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    !isExpanded && "justify-center px-0 py-3 border-r-0"
                  )}
                  title={item.label}
                >
                  <span className={cn(
                    "shrink-0 transition-colors",
                    isToolsActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                    !isExpanded && "mx-auto"
                  )}>
                    {item.icon}
                  </span>
                  {isExpanded && (
                    <div className="flex-1 min-w-0">
                      <p className={cn("text-sm font-medium truncate", isToolsActive ? "text-primary" : "")}>
                        {item.label}
                      </p>
                      <p className="text-xs text-muted-foreground truncate mt-0.5 leading-tight">
                        {item.description}
                      </p>
                    </div>
                  )}
                  {isExpanded && (
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsToolsExpanded(prev => !prev);
                      }}
                      className={cn(
                        "p-1 rounded hover:bg-muted-foreground/10 text-muted-foreground hover:text-foreground transition-all duration-200 shrink-0",
                        isToolsActive && "text-primary hover:text-primary hover:bg-primary/20"
                      )}
                    >
                      <ChevronRight
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
                          isToolsExpanded ? "rotate-90" : ""
                        )}
                      />
                    </div>
                  )}
                </button>

                {isExpanded && isToolsExpanded && (
                  <div className="pl-6 border-l border-border/60 ml-6 flex flex-col gap-1 mt-1 mb-2">
                    {[
                      { id: "tools-composio" as const, label: "Composio Gateway" },
                      { id: "tools-manual" as const, label: "Manual MCP" },
                      { id: "tools-smithery" as const, label: "Smithery AI" },
                      { id: "tools-zapier" as const, label: "Zapier Platform" },
                    ].map((sub) => {
                      const isSubActive = active === sub.id;
                      return (
                        <button
                          key={sub.id}
                          onClick={() => onChange(sub.id)}
                          className={cn(
                            "text-left px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all",
                            isSubActive
                              ? "text-primary font-semibold bg-primary/5"
                              : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                          )}
                        >
                          {sub.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onChange(item.id)}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 text-left transition-all group",
                isActive
                  ? "bg-primary/10 border-r-2 border-primary text-primary"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                !isExpanded && "justify-center px-0 py-3 border-r-0"
              )}
              title={item.label}
            >
              <span className={cn(
                "shrink-0 transition-colors",
                isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                !isExpanded && "mx-auto"
              )}>
                {item.icon}
              </span>
              {isExpanded && (
                <div className="flex-1 min-w-0">
                  <p className={cn("text-sm font-medium truncate", isActive ? "text-primary" : "")}>
                    {item.label}
                  </p>
                  <p className="text-xs text-muted-foreground truncate mt-0.5 leading-tight">
                    {item.description}
                  </p>
                </div>
              )}
              {isExpanded && isActive && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-primary" />}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
