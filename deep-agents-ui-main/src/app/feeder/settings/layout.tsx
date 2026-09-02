"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
    LayoutDashboard, Rss, Filter, AlarmClock, Sparkles, Database,
    Settings, Home, Activity
} from "lucide-react";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { PluginGate } from "@/app/components/settings/PluginsSection";

const NAV_ITEMS = [
    { href: "/feeder/settings", label: "Overview", icon: LayoutDashboard, exact: true },
    { href: "/feeder/settings/sources", label: "Sources", icon: Rss },
    { href: "/feeder/settings/filters", label: "Filters", icon: Filter },
    { href: "/feeder/settings/schedule", label: "Schedule", icon: AlarmClock },
    { href: "/feeder/settings/ai", label: "AI Model", icon: Sparkles },
    { href: "/feeder/settings/data", label: "Data", icon: Database },
];

export default function FeederSettingsLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const current = NAV_ITEMS.find(item =>
        item.exact ? pathname === item.href : pathname?.startsWith(item.href)
    );

    return (
        <PluginGate pluginKey="feeder">
            <div className="flex h-screen flex-col bg-background overflow-hidden">
                {/* Header */}
                <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 sm:px-6 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                        <Settings className="h-5 w-5 text-primary shrink-0" />
                        <h1 className="text-lg sm:text-xl font-semibold truncate">
                            Feeder Settings
                            {current && current.href !== "/feeder/settings" && (
                                <span className="text-muted-foreground font-normal"> · {current.label}</span>
                            )}
                        </h1>
                    </div>
                    <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
                        <ThemeToggle />
                        <Link href="/feeder">
                            <Button variant="outline" size="sm" className="h-8">
                                <Activity className="h-4 w-4 sm:mr-2" />
                                <span className="hidden sm:inline">Dashboard</span>
                            </Button>
                        </Link>
                        <Link href="/">
                            <Button variant="outline" size="sm" className="h-8">
                                <Home className="h-4 w-4 sm:mr-2" />
                                <span className="hidden sm:inline">Agent</span>
                            </Button>
                        </Link>
                    </div>
                </header>

                {/* Sub-navigation: horizontal scroll chips (works on mobile + desktop) */}
                <nav className="shrink-0 border-b bg-muted/30">
                    <div className="flex gap-1 overflow-x-auto px-3 sm:px-6 py-2 scrollbar-none">
                        {NAV_ITEMS.map(({ href, label, icon: Icon, exact }) => {
                            const active = exact ? pathname === href : pathname?.startsWith(href);
                            return (
                                <Link
                                    key={href}
                                    href={href}
                                    className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors
                                        ${active
                                            ? "bg-primary text-primary-foreground shadow-sm"
                                            : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
                                >
                                    <Icon className="h-3.5 w-3.5" />
                                    {label}
                                </Link>
                            );
                        })}
                    </div>
                </nav>

                <main className="flex-1 overflow-auto p-4 sm:p-6">
                    {children}
                </main>
            </div>
        </PluginGate>
    );
}
