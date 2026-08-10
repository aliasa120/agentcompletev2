"use client";

import React from "react";
import Link from "next/link";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { cn } from "@/lib/utils";
import {
  Palette, Shield, Layers, AlarmClock, Wrench, Cpu, Route, Brain, Bot, Users,
  BookOpen, ImageIcon, ListChecks, Settings2, Database, Share2, LayoutGrid,
  Zap, LogOut, ChevronDown, Menu, X,
} from "lucide-react";
import { type SettingsSection } from "./SettingsSidebar";

interface ApplicationShellProps {
  active: SettingsSection;
  onChange: (s: SettingsSection) => void;
  userEmail?: string;
  onSignOut: () => void;
  children: React.ReactNode;
}

interface NavItem {
  title: string;
  id: SettingsSection;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  subItems?: { title: string; id: SettingsSection }[];
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Core",
    items: [
      { title: "Appearance", id: "appearance", icon: Palette },
      { title: "ENV Keys", id: "env-keys", icon: Shield, badge: "NEW" },
      { title: "Workflows", id: "workflows", icon: Layers },
      { title: "Scheduled Tasks", id: "scheduled-tasks", icon: AlarmClock },
      {
        title: "Additional Features",
        id: "additional-features",
        icon: LayoutGrid,
        subItems: [
          { title: "Overview", id: "additional-features" },
          { title: "Voice & TTS", id: "additional-features-voice" },
        ],
      },
    ],
  },
  {
    label: "Integrations",
    items: [
      {
        title: "Tools & MCP",
        id: "tools",
        icon: Wrench,
        subItems: [
          { title: "All Tools", id: "tools" },
          { title: "Composio Gateway", id: "tools-composio" },
          { title: "Manual MCP", id: "tools-manual" },
          { title: "Smithery AI", id: "tools-smithery" },
          { title: "Zapier Platform", id: "tools-zapier" },
        ],
      },
      { title: "Platforms Connection", id: "telegram-bots", icon: Share2 },
    ],
  },
  {
    label: "Models",
    items: [
      { title: "AI Providers", id: "providers", icon: Cpu },
      { title: "OpenRouter Setup", id: "gateway", icon: Route },
      { title: "Omni Analyzer", id: "omni-settings", icon: Brain },
      { title: "Main Agents", id: "agents", icon: Bot },
      { title: "Subagents", id: "subagents", icon: Users },
      { title: "Skills Library", id: "skills", icon: BookOpen },
    ],
  },
  {
    label: "Content",
    items: [
      { title: "Brand Assets", id: "design-assets", icon: ImageIcon },
      { title: "Queue & Schedule", id: "queue", icon: ListChecks },
      { title: "API Configuration", id: "configuration", icon: Settings2 },
      { title: "Feeder Dashboard", id: "feeder", icon: Database },
      { title: "Memories", id: "memories", icon: Brain },
    ],
  },
];

/** Flattened lookup used for the topbar title. */
const ALL_TABS: { title: string; id: SettingsSection }[] = NAV_GROUPS.flatMap((g) =>
  g.items.flatMap((item) =>
    item.subItems ? item.subItems : [{ title: item.title, id: item.id }],
  ),
);

export const ApplicationShell = ({
  active,
  onChange,
  userEmail,
  onSignOut,
  children,
}: ApplicationShellProps) => {
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const activeTitle = ALL_TABS.find((t) => t.id === active)?.title ?? "Settings";

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background">
      <Topbar
        activeTitle={activeTitle}
        userEmail={userEmail}
        onSignOut={onSignOut}
        onOpenNav={() => setMobileNavOpen(true)}
      />
      <div className="flex flex-1 min-h-0">
        {/* Desktop grouped menu */}
        <DesktopNav active={active} onChange={onChange} onSignOut={onSignOut} />
        {/* Content column */}
        <main className="flex-1 min-w-0 overflow-y-auto min-h-0">
          <div className="p-3 pt-4 md:p-6 md:pt-4 w-full">{children}</div>
        </main>
      </div>

      {/* Closeable mobile sidebar drawer */}
      <MobileNavDrawer
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        active={active}
        onChange={onChange}
        onSignOut={onSignOut}
      />
    </div>
  );
};

/* ── Topbar ──────────────────────────────────────────────────────────────── */

const Topbar = ({
  activeTitle,
  userEmail,
  onSignOut,
  onOpenNav,
}: {
  activeTitle: string;
  userEmail?: string;
  onSignOut: () => void;
  onOpenNav: () => void;
}) => {
  return (
    <header className="h-14 shrink-0 flex items-center gap-2 md:gap-3 bg-background px-3 md:px-5">
      {/* Mobile hamburger */}
      <button
        onClick={onOpenNav}
        className="md:hidden size-9 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
        title="Open settings menu"
        aria-label="Open settings menu"
      >
        <Menu className="h-4 w-4" />
      </button>
      <Link href="/" className="flex items-center gap-2 shrink-0 group">
        <Zap className="h-5 w-5 text-primary shrink-0" />
        <span className="font-bold text-sm text-foreground tracking-tight hidden sm:inline">
          Agent Console
        </span>
      </Link>
      <span className="text-muted-foreground/60 hidden sm:inline">/</span>
      <span className="font-medium text-sm font-studio text-foreground truncate">
        {activeTitle}
      </span>

      <div className="ml-auto flex items-center gap-2 md:gap-3">
        {userEmail && (
          <span className="hidden md:inline text-xs text-muted-foreground font-medium truncate max-w-[180px]">
            {userEmail}
          </span>
        )}
        <ThemeToggle />
        <button
          onClick={onSignOut}
          title="Log out"
          className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span className="hidden lg:inline">Log out</span>
        </button>
      </div>
    </header>
  );
};

/* ── Shared grouped nav content ──────────────────────────────────────────── */

const NavSections = ({
  active,
  onChange,
}: {
  active: SettingsSection;
  onChange: (s: SettingsSection) => void;
}) => (
  <div className="flex flex-col gap-0.5 w-full font-medium">
    {NAV_GROUPS.map((group, gi) => (
      <div key={group.label} className={cn(gi > 0 && "mt-4")}>
        <span className="px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {group.label}
        </span>
        <div className="mt-1 flex flex-col gap-0.5">
          {group.items.map((item) => (
            <NavItemButton key={item.id} item={item} active={active} onChange={onChange} />
          ))}
        </div>
      </div>
    ))}
  </div>
);

const NavItemButton = ({
  item,
  active,
  onChange,
}: {
  item: NavItem;
  active: SettingsSection;
  onChange: (s: SettingsSection) => void;
}) => {
  const hasSubs = !!item.subItems;
  const isActive = active === item.id;
  const isGroupActive =
    hasSubs && item.subItems!.some((s) => s.id === active);
  const [expanded, setExpanded] = React.useState<boolean>(isGroupActive);

  React.useEffect(() => {
    if (isGroupActive) setExpanded(true);
  }, [isGroupActive]);

  if (hasSubs) {
    return (
      <div>
        <button
          onClick={() => {
            setExpanded((e) => !e);
          }}
          className={cn(
            "flex w-full items-center gap-2 px-2 py-1.5 rounded-sm text-sm transition-colors",
            isGroupActive || isActive
              ? "bg-secondary text-foreground"
              : "text-foreground/80 hover:bg-secondary/60",
          )}
        >
          <item.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate flex-1 text-left">{item.title}</span>
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
              expanded && "rotate-180",
            )}
          />
        </button>
        {expanded && (
          <div className="ml-4 mt-0.5 flex flex-col gap-0.5 border-l border-border/50 pl-2">
            {item.subItems!.map((sub) => {
              const isSubActive = active === sub.id;
              return (
                <button
                  key={sub.id}
                  onClick={() => onChange(sub.id)}
                  className={cn(
                    "flex w-full items-center px-2 py-1 rounded-sm text-[13px] transition-colors",
                    isSubActive
                      ? "bg-secondary text-foreground font-medium"
                      : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  )}
                >
                  <span className="truncate">{sub.title}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={() => onChange(item.id)}
      className={cn(
        "flex w-full items-center gap-2 px-2 py-1.5 rounded-sm text-sm transition-colors",
        isActive
          ? "bg-secondary text-foreground"
          : "text-foreground/80 hover:bg-secondary/60",
      )}
    >
      <item.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate flex-1 text-left">{item.title}</span>
      {item.badge && (
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-primary/15 text-primary">
          {item.badge}
        </span>
      )}
    </button>
  );
};

/* ── Desktop grouped nav ─────────────────────────────────────────────────── */

const DesktopNav = ({
  active,
  onChange,
  onSignOut,
}: {
  active: SettingsSection;
  onChange: (s: SettingsSection) => void;
  onSignOut: () => void;
}) => {
  return (
    <aside className="hidden md:flex h-full w-60 shrink-0 flex-col bg-sidebar">
      <nav className="flex-1 overflow-y-auto scrollbar-pretty px-1.5 py-3 min-h-0">
        <NavSections active={active} onChange={onChange} />
      </nav>
      <div className="shrink-0 border-t border-border/60 p-1.5">
        <button
          onClick={onSignOut}
          className="flex w-full items-center gap-2 px-2 py-1.5 rounded-sm text-sm text-destructive hover:bg-destructive/10 transition-colors"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          <span>Log Out</span>
        </button>
      </div>
    </aside>
  );
};

/* ── Closeable mobile sidebar drawer ─────────────────────────────────────── */

const MobileNavDrawer = ({
  open,
  onClose,
  active,
  onChange,
  onSignOut,
}: {
  open: boolean;
  onClose: () => void;
  active: SettingsSection;
  onChange: (s: SettingsSection) => void;
  onSignOut: () => void;
}) => {
  // Lock body scroll while the drawer is open
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  const handleSelect = (s: SettingsSection) => {
    onChange(s);
    onClose();
  };

  return (
    <div className="md:hidden fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 animate-in fade-in duration-200"
        onClick={onClose}
      />
      {/* Panel */}
      <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-sidebar text-sidebar-foreground shadow-xl flex flex-col animate-in slide-in-from-left duration-200">
        {/* Drawer header */}
        <div className="flex items-center justify-between h-14 px-3 border-b border-sidebar-border shrink-0">
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-sidebar-primary shrink-0" />
            <span className="font-medium text-sm font-studio text-sidebar-foreground">
              Settings
            </span>
          </div>
          <button
            onClick={onClose}
            className="size-9 flex items-center justify-center rounded-md text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
            aria-label="Close settings menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* Grouped menu */}
        <nav className="flex-1 overflow-y-auto scrollbar-pretty px-1.5 py-3 min-h-0">
          <NavSections active={active} onChange={handleSelect} />
        </nav>
        {/* Drawer footer */}
        <div className="shrink-0 border-t border-sidebar-border p-1.5">
          <button
            onClick={onSignOut}
            className="flex w-full items-center gap-2 px-2 py-1.5 rounded-sm text-sm text-destructive hover:bg-destructive/10 transition-colors"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            <span>Log Out</span>
          </button>
        </div>
      </div>
    </div>
  );
};
