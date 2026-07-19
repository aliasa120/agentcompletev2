"use client";

import React, { useState } from "react";
import Link from "next/link";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarTrigger,
  SidebarInput,
} from "@relume_io/relume-ui";
import {
  BiAlarm,
  BiBookOpen,
  BiBot,
  BiBrain,
  BiCog,
  BiGridAlt,
  BiGroup,
  BiHelpCircle,
  BiHome,
  BiImage,
  BiLayer,
  BiListUl,
  BiLogOut,
  BiSearch,
  BiShareAlt,
  BiSlider,
  BiUser,
} from "react-icons/bi";
import { Cpu, Database, Route, Zap, Shield } from "lucide-react";
import { RxChevronRight, RxCross2 } from "react-icons/rx";
import { AnimatePresence, motion } from "framer-motion";
import { type SettingsSection } from "./SettingsSidebar";

interface ApplicationShellProps {
  active: SettingsSection;
  onChange: (s: SettingsSection) => void;
  userEmail?: string;
  onSignOut: () => void;
  children: React.ReactNode;
}

export const ApplicationShell = ({
  active,
  onChange,
  userEmail,
  onSignOut,
  children,
}: ApplicationShellProps) => {
  return (
    <SidebarProvider style={{ "--sidebar-width": "220px", "--sidebar-width-mobile": "220px" } as React.CSSProperties}>
      <div className="flex h-screen w-screen overflow-hidden bg-background">
        <AppSidebar active={active} onChange={onChange} onSignOut={onSignOut} />
        <main className="flex-1 flex flex-col min-w-0 bg-background-secondary overflow-hidden">
          <Topbar userEmail={userEmail} onSignOut={onSignOut} />
          <div className="flex-1 overflow-y-auto p-6 md:p-8">
            <div className="mx-auto w-full">
              {children}
            </div>
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
};

const Topbar = ({
  userEmail,
  onSignOut,
}: {
  userEmail?: string;
  onSignOut: () => void;
}) => {
  const [isSearchIconClicked, setIsSearchIconClicked] = useState(false);

  return (
    <header className="sticky top-0 z-30 flex h-16 w-full items-center border-b border-border-primary bg-background text-foreground px-4 md:px-8 shrink-0">
      <div className="mx-auto grid size-full grid-cols-2 items-center justify-between gap-4 lg:grid-cols-[1fr_1.5fr_1fr]">
        <div className="flex items-center gap-4">
          <SidebarTrigger className="lg:hidden" />
          <Link href="/" className="justify-self-start flex items-center gap-2 lg:hidden">
            <Zap className="h-5 w-5 text-primary shrink-0" />
            <span className="font-bold text-sm text-foreground tracking-tight hidden sm:inline">
              Agent Console
            </span>
          </Link>
        </div>
        <div className="hidden lg:flex lg:w-full lg:max-w-lg items-center gap-4 lg:justify-self-center">
          <ThemeToggle />
          <SidebarInput
            className="w-full"
            placeholder="Search settings..."
            icon={<BiSearch className="size-6" />}
          />
        </div>
        <TopbarActions
          isSearchIconClicked={isSearchIconClicked}
          setIsSearchIconClicked={setIsSearchIconClicked}
          userEmail={userEmail}
          onSignOut={onSignOut}
        />
      </div>
      <AnimatePresence>
        {isSearchIconClicked && (
          <motion.div
            variants={{
              visible: { opacity: 1 },
              hidden: { opacity: 0 },
            }}
            initial="hidden"
            exit="hidden"
            animate={isSearchIconClicked ? "visible" : "hidden"}
            className="absolute bottom-0 left-0 right-0 top-16 flex min-h-16 max-w-md items-center justify-center border-b border-border-primary bg-white px-6 lg:hidden"
          >
            <Input
              className="h-fit w-full"
              placeholder="Search settings..."
              icon={<BiSearch className="size-6" />}
            />
            <button onClick={() => setIsSearchIconClicked(!isSearchIconClicked)}>
              <RxCross2 className="ml-4 size-6" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
};

const TopbarActions = ({
  isSearchIconClicked,
  setIsSearchIconClicked,
  userEmail,
  onSignOut,
}: {
  isSearchIconClicked: boolean;
  setIsSearchIconClicked: (value: boolean) => void;
  userEmail?: string;
  onSignOut: () => void;
}) => {
  return (
    <div className="flex items-center gap-2 justify-self-end md:gap-4">
      <div className="lg:hidden">
        <ThemeToggle />
      </div>
      <button
        onClick={() => setIsSearchIconClicked(!isSearchIconClicked)}
        className="p-2 lg:hidden"
      >
        <BiSearch className="size-6" />
      </button>

      {userEmail && (
        <span className="hidden md:inline text-xs text-muted-foreground font-medium">
          {userEmail}
        </span>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger className="flex items-center p-0">
          <img
            src="https://d22po4pjz3o32e.cloudfront.net/avatar-image.svg"
            alt="Avatar"
            className="size-10 rounded-full object-cover"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={0} className="mt-1.5 px-0 py-2">
          <DropdownMenuGroup>
            <DropdownMenuItem asChild>
              <Link href="/">Home Dashboard</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="mx-4" />
            <DropdownMenuItem onClick={onSignOut}>
              <span className="text-destructive flex items-center gap-2">
                <BiLogOut className="size-4" /> Log Out
              </span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

interface MenuNavItem {
  title: string;
  id: SettingsSection;
  icon: React.ComponentType<{ className?: string }> | any;
  badge?: string;
  subItems?: { title: string; id: SettingsSection }[];
}

const menuItems: MenuNavItem[] = [
  { title: "ENV Keys", id: "env-keys", icon: Shield, badge: "NEW" },
  { title: "Workflows", id: "workflows", icon: BiLayer },
  { title: "Scheduled Tasks", id: "scheduled-tasks", icon: BiAlarm },
  {
    title: "Tools & MCP",
    id: "tools",
    icon: BiCog,
    subItems: [
      { title: "All Tools", id: "tools" },
      { title: "Composio Gateway", id: "tools-composio" },
      { title: "Manual MCP", id: "tools-manual" },
      { title: "Smithery AI", id: "tools-smithery" },
      { title: "Zapier Platform", id: "tools-zapier" },
    ],
  },
  { title: "AI Providers", id: "providers", icon: Cpu },
  { title: "OpenRouter Setup", id: "gateway", icon: Route },
  { title: "Omni Analyzer", id: "omni-settings", icon: BiBrain },
  { title: "Main Agents", id: "agents", icon: BiBot },
  { title: "Subagents", id: "subagents", icon: BiGroup },
  { title: "Skills Library", id: "skills", icon: BiBookOpen },
  { title: "Brand Assets", id: "design-assets", icon: BiImage },
  { title: "Queue & Schedule", id: "queue", icon: BiListUl },
  { title: "API Configuration", id: "configuration", icon: BiSlider },
  { title: "Feeder Dashboard", id: "feeder", icon: Database },
  { title: "Memories", id: "memories", icon: BiBrain },
  { title: "Platforms Connection", id: "telegram-bots", icon: BiShareAlt },
  { title: "Additional Features", id: "additional-features", icon: BiGridAlt },
];

const AppSidebar = ({
  active,
  onChange,
  onSignOut,
}: {
  active: SettingsSection;
  onChange: (s: SettingsSection) => void;
  onSignOut: () => void;
}) => {
  return (
    <Sidebar className="border-r border-border-primary bg-sidebar text-sidebar-foreground" closeButtonClassName="fixed top-4 right-4 text-white">
      {/* Sidebar Header with Logo */}
      <div className="flex h-16 items-center px-4 border-b border-border-primary shrink-0">
        <Link href="/" className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary shrink-0" />
          <span className="font-bold text-xs text-foreground tracking-tight">
            Agent Console
          </span>
        </Link>
      </div>

      <SidebarContent className="py-4 overflow-y-auto scrollbar-thin">
        <SidebarMenu>
          {menuItems.map((item, index) => {
            const isSelected = active === item.id || (item.subItems && item.subItems.some(sub => sub.id === active));
            
            return (
              <SidebarMenuItem key={index}>
                {item.subItems ? (
                  <Accordion type="single" collapsible className="w-full">
                    <AccordionItem value={item.id} className="border-none">
                      <AccordionTrigger className={`p-2 text-sm font-medium hover:no-underline rounded-lg transition-colors [&>svg]:size-4 ${
                        isSelected ? "bg-primary/5 text-primary" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                      }`}>
                        <span className="flex items-center gap-3">
                          <item.icon className="size-5 shrink-0" />
                          <span>{item.title}</span>
                        </span>
                      </AccordionTrigger>
                      <AccordionContent className="pb-1 pt-1 flex flex-col gap-1 pl-8">
                        {item.subItems.map((subItem, subIndex) => {
                          const isSubSelected = active === subItem.id;
                          return (
                            <button
                              key={subIndex}
                              onClick={() => onChange(subItem.id)}
                              className={`flex items-center w-full text-left py-1.5 px-3 rounded-md text-xs font-medium transition-colors ${
                                isSubSelected
                                  ? "text-primary bg-primary/10"
                                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                              }`}
                            >
                              <span>{subItem.title}</span>
                            </button>
                          );
                        })}
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                ) : (
                  <SidebarMenuButton
                    onClick={() => onChange(item.id)}
                    className={`flex w-full items-center gap-3 p-2 rounded-lg text-sm font-medium transition-colors ${
                      isSelected
                        ? "bg-primary/10 text-primary hover:bg-primary/15"
                        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                    }`}
                  >
                    <item.icon className="size-5 shrink-0" />
                    <span>{item.title}</span>
                    {item.badge && (
                      <Badge variant="outline" className="ml-auto">
                        {item.badge}
                      </Badge>
                    )}
                  </SidebarMenuButton>
                )}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter className="mt-auto pt-4 border-t border-border-primary">
        <SidebarMenuButton
          onClick={onSignOut}
          className="flex w-full items-center gap-3 p-2 rounded-lg text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
        >
          <BiLogOut className="size-5 shrink-0" />
          <span>Log Out</span>
        </SidebarMenuButton>
      </SidebarFooter>
    </Sidebar>
  );
};
