"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Plus, Trash2, Loader2, CheckCircle2,
  Bot, AlertTriangle, ToggleLeft, ToggleRight, Workflow,
  MessageSquare, Mail, Layers, Server
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JanCard, CardItem } from "@/components/settings/JanCard";

interface TelegramBot {
  id: string;
  bot_token: string;
  is_active: boolean;
  created_at: string;
}

interface SlackConnection {
  id: string;
  bot_token: string;
  app_token: string;
  is_active: boolean;
  created_at: string;
}

interface DiscordConnection {
  id: string;
  bot_token: string;
  is_active: boolean;
  created_at: string;
}

interface EmailConnection {
  id: string;
  smtp_host: string;
  smtp_port: number;
  username: string;
  imap_host: string;
  imap_port: number;
  is_active: boolean;
  created_at: string;
}

type PlatformTab = "telegram" | "slack" | "discord" | "email";

export function TelegramBotsSection() {
  const [activeTab, setActiveTab] = useState<PlatformTab>("telegram");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Connection Lists
  const [tgBots, setTgBots] = useState<TelegramBot[]>([]);
  const [slackConns, setSlackConns] = useState<SlackConnection[]>([]);
  const [discordConns, setDiscordConns] = useState<DiscordConnection[]>([]);
  const [emailConns, setEmailConns] = useState<EmailConnection[]>([]);

  // Form inputs
  const [tgToken, setTgToken] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackAppToken, setSlackAppToken] = useState("");
  const [discordToken, setDiscordToken] = useState("");
  
  const [emailSmtpHost, setEmailSmtpHost] = useState("");
  const [emailSmtpPort, setEmailSmtpPort] = useState("587");
  const [emailImapHost, setEmailImapHost] = useState("");
  const [emailImapPort, setEmailImapPort] = useState("993");
  const [emailUsername, setEmailUsername] = useState("");
  const [emailPassword, setEmailPassword] = useState("");

  const showStatus = (type: "success" | "error", text: string) => {
    setStatusMessage({ type, text });
    setTimeout(() => setStatusMessage(null), 3500);
  };

  // ── Fetch Data ─────────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      if (activeTab === "telegram") {
        const res = await fetch("/api/telegram-bots");
        const data = await res.json();
        setTgBots(data.bots ?? []);
      } else if (activeTab === "slack") {
        const res = await fetch("/api/slack-connections");
        const data = await res.json();
        setSlackConns(data.connections ?? []);
      } else if (activeTab === "discord") {
        const res = await fetch("/api/discord-connections");
        const data = await res.json();
        setDiscordConns(data.connections ?? []);
      } else if (activeTab === "email") {
        const res = await fetch("/api/email-connections");
        const data = await res.json();
        setEmailConns(data.connections ?? []);
      }
    } catch (e) {
      console.error(`Failed to load connections for ${activeTab}:`, e);
      showStatus("error", `Failed to load ${activeTab} configurations.`);
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Telegram Handlers ──────────────────────────────────────────────────────
  const handleRegisterTelegram = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tgToken.trim()) return showStatus("error", "Bot Token is required.");
    setSaving(true);
    try {
      const res = await fetch("/api/telegram-bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot_token: tgToken.trim(), is_active: true })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showStatus("success", "Telegram Bot registered successfully!");
        setTgToken("");
        fetchData();
      } else {
        showStatus("error", data.error || "Failed to register bot.");
      }
    } catch (err) {
      showStatus("error", "Network error registering bot.");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleTgActive = async (bot: TelegramBot) => {
    try {
      const res = await fetch("/api/telegram-bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: bot.id, bot_token: bot.bot_token, is_active: !bot.is_active })
      });
      if (res.ok) {
        setTgBots(prev => prev.map(b => b.id === bot.id ? { ...b, is_active: !b.is_active } : b));
        showStatus("success", `Bot ${!bot.is_active ? "enabled" : "disabled"}`);
      }
    } catch (err) {
      showStatus("error", "Network error updating status.");
    }
  };

  const handleDeleteTg = async (id: string) => {
    if (!confirm("Delete this Telegram Bot?")) return;
    try {
      const res = await fetch(`/api/telegram-bots?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        setTgBots(prev => prev.filter(b => b.id !== id));
        showStatus("success", "Bot deleted.");
      }
    } catch (err) {
      showStatus("error", "Network error.");
    }
  };

  // ── Slack Handlers ─────────────────────────────────────────────────────────
  const handleRegisterSlack = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slackBotToken.trim() || !slackAppToken.trim()) {
      return showStatus("error", "Both OAuth Token and App Token are required.");
    }
    setSaving(true);
    try {
      const res = await fetch("/api/slack-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bot_token: slackBotToken.trim(),
          app_token: slackAppToken.trim(),
          is_active: true
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showStatus("success", "Slack gateway registered successfully!");
        setSlackBotToken("");
        setSlackAppToken("");
        fetchData();
      } else {
        showStatus("error", data.error || "Failed to register connection.");
      }
    } catch (err) {
      showStatus("error", "Network error.");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleSlackActive = async (conn: SlackConnection) => {
    try {
      const res = await fetch("/api/slack-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: conn.id, bot_token: conn.bot_token, app_token: conn.app_token, is_active: !conn.is_active })
      });
      if (res.ok) {
        setSlackConns(prev => prev.map(c => c.id === conn.id ? { ...c, is_active: !c.is_active } : c));
        showStatus("success", `Slack connection ${!conn.is_active ? "enabled" : "disabled"}`);
      }
    } catch (err) {
      showStatus("error", "Network error.");
    }
  };

  const handleDeleteSlack = async (id: string) => {
    if (!confirm("Delete this Slack Connection?")) return;
    try {
      const res = await fetch(`/api/slack-connections?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        setSlackConns(prev => prev.filter(c => c.id !== id));
        showStatus("success", "Slack connection deleted.");
      }
    } catch (err) {
      showStatus("error", "Network error.");
    }
  };

  // ── Discord Handlers ───────────────────────────────────────────────────────
  const handleRegisterDiscord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!discordToken.trim()) return showStatus("error", "Discord Token is required.");
    setSaving(true);
    try {
      const res = await fetch("/api/discord-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot_token: discordToken.trim(), is_active: true })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showStatus("success", "Discord bot registered successfully!");
        setDiscordToken("");
        fetchData();
      } else {
        showStatus("error", data.error || "Failed to register.");
      }
    } catch (err) {
      showStatus("error", "Network error.");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleDiscordActive = async (conn: DiscordConnection) => {
    try {
      const res = await fetch("/api/discord-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: conn.id, bot_token: conn.bot_token, is_active: !conn.is_active })
      });
      if (res.ok) {
        setDiscordConns(prev => prev.map(c => c.id === conn.id ? { ...c, is_active: !c.is_active } : c));
        showStatus("success", `Discord connection ${!conn.is_active ? "enabled" : "disabled"}`);
      }
    } catch (err) {
      showStatus("error", "Network error.");
    }
  };

  const handleDeleteDiscord = async (id: string) => {
    if (!confirm("Delete this Discord Connection?")) return;
    try {
      const res = await fetch(`/api/discord-connections?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        setDiscordConns(prev => prev.filter(c => c.id !== id));
        showStatus("success", "Discord connection deleted.");
      }
    } catch (err) {
      showStatus("error", "Network error.");
    }
  };

  // ── Email Handlers ─────────────────────────────────────────────────────────
  const handleRegisterEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailSmtpHost.trim() || !emailUsername.trim() || !emailPassword.trim() || !emailImapHost.trim()) {
      return showStatus("error", "All fields are required to register Email gateway.");
    }
    setSaving(true);
    try {
      const res = await fetch("/api/email-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          smtp_host: emailSmtpHost.trim(),
          smtp_port: emailSmtpPort.trim(),
          username: emailUsername.trim(),
          password: emailPassword.trim(),
          imap_host: emailImapHost.trim(),
          imap_port: emailImapPort.trim(),
          is_active: true
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showStatus("success", "Email gateway registered successfully!");
        setEmailSmtpHost("");
        setEmailUsername("");
        setEmailPassword("");
        setEmailImapHost("");
        fetchData();
      } else {
        showStatus("error", data.error || "Failed to register email gateway.");
      }
    } catch (err) {
      showStatus("error", "Network error.");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEmailActive = async (conn: EmailConnection) => {
    try {
      const res = await fetch("/api/email-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: conn.id,
          smtp_host: conn.smtp_host,
          smtp_port: conn.smtp_port,
          username: conn.username,
          password: "PRESERVED_PASSWORD_PLACEHOLDER",
          imap_host: conn.imap_host,
          imap_port: conn.imap_port,
          is_active: !conn.is_active
        })
      });
      if (res.ok) {
        setEmailConns(prev => prev.map(c => c.id === conn.id ? { ...c, is_active: !c.is_active } : c));
        showStatus("success", `Email gateway ${!conn.is_active ? "enabled" : "disabled"}`);
      }
    } catch (err) {
      showStatus("error", "Network error.");
    }
  };

  const handleDeleteEmail = async (id: string) => {
    if (!confirm("Delete this Email Connection?")) return;
    try {
      const res = await fetch(`/api/email-connections?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        setEmailConns(prev => prev.filter(c => c.id !== id));
        showStatus("success", "Email connection deleted.");
      }
    } catch (err) {
      showStatus("error", "Network error.");
    }
  };

  const maskToken = (token: string) => {
    if (!token) return "";
    if (token.length <= 15) return "••••••••••••";
    return `${token.slice(0, 8)}••••••••${token.slice(-6)}`;
  };

  return (
    <div className="space-y-6">
      {/* Header Card */}
      <JanCard>
        <CardItem
          align="start"
          title={
            <span className="flex items-center gap-3">
              <span className="p-2.5 bg-primary/10 text-primary rounded-lg">
                <Layers className="h-6 w-6" />
              </span>
              Platforms Connection
            </span>
          }
          description="Connect external messaging platforms to enable conversational workflows on Telegram, Slack, Discord, or Email."
        />
      </JanCard>

      {/* Tabs */}
      <div className="flex border-b gap-2">
        {(["telegram", "slack", "discord", "email"] as PlatformTab[]).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 capitalize transition-all ${
              activeTab === tab
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {statusMessage && (
        <div className={`p-4 rounded-lg flex items-center gap-3 border ${
          statusMessage.type === "success"
            ? "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/20 dark:text-emerald-300 dark:border-emerald-900/30"
            : "bg-destructive/5 text-destructive border-destructive/10"
        }`}>
          {statusMessage.type === "success" ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
          <span className="text-sm font-medium">{statusMessage.text}</span>
        </div>
      )}

      {/* Dynamic Content Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Form Column */}
        <div className="md:col-span-1">
          <JanCard title={`Register ${activeTab.toUpperCase()} Gateway`}>
            
            {activeTab === "telegram" && (
              <form onSubmit={handleRegisterTelegram}>
                <CardItem column className="mt-0" title="Bot API Token">
                  <div className="space-y-1.5">
                    <Input
                      type="password"
                      placeholder="8802642908:AAEd5X..."
                      value={tgToken}
                      onChange={e => setTgToken(e.target.value)}
                      className="h-9 text-sm"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Obtained from <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-primary underline">@BotFather</a>.
                    </p>
                  </div>
                </CardItem>
                <Button type="submit" disabled={saving} className="w-full h-9 text-xs mt-4">
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                  Add Telegram Bot
                </Button>
              </form>
            )}

            {activeTab === "slack" && (
              <form onSubmit={handleRegisterSlack}>
                <CardItem column className="mt-0" title="Bot User OAuth Token">
                  <Input
                    type="password"
                    placeholder="xoxb-..."
                    value={slackBotToken}
                    onChange={e => setSlackBotToken(e.target.value)}
                    className="h-9 text-sm"
                  />
                </CardItem>
                <CardItem column title="App-Level Token (Socket Mode)">
                  <div className="space-y-1.5">
                    <Input
                      type="password"
                      placeholder="xapp-..."
                      value={slackAppToken}
                      onChange={e => setSlackAppToken(e.target.value)}
                      className="h-9 text-sm"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Required for Slack Socket Mode communication.
                    </p>
                  </div>
                </CardItem>
                <Button type="submit" disabled={saving} className="w-full h-9 text-xs mt-4">
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                  Add Slack Gateway
                </Button>
              </form>
            )}

            {activeTab === "discord" && (
              <form onSubmit={handleRegisterDiscord}>
                <CardItem column className="mt-0" title="Discord Bot Token">
                  <div className="space-y-1.5">
                    <Input
                      type="password"
                      placeholder="MTY3..."
                      value={discordToken}
                      onChange={e => setDiscordToken(e.target.value)}
                      className="h-9 text-sm"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Get from the Discord Developer Portal (enable Message Content Intent).
                    </p>
                  </div>
                </CardItem>
                <Button type="submit" disabled={saving} className="w-full h-9 text-xs mt-4">
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                  Add Discord Bot
                </Button>
              </form>
            )}

            {activeTab === "email" && (
              <form onSubmit={handleRegisterEmail}>
                <CardItem column className="mt-0" title="Username / Email Address">
                  <Input
                    placeholder="agent@company.com"
                    value={emailUsername}
                    onChange={e => setEmailUsername(e.target.value)}
                    className="h-9 text-sm"
                  />
                </CardItem>
                <CardItem column title="Password / App Password">
                  <Input
                    type="password"
                    placeholder="••••••••••••"
                    value={emailPassword}
                    onChange={e => setEmailPassword(e.target.value)}
                    className="h-9 text-sm"
                  />
                </CardItem>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-2 gap-y-3 mt-3">
                  <CardItem column className="mt-0" title="SMTP Host">
                    <Input
                      placeholder="smtp.gmail.com"
                      value={emailSmtpHost}
                      onChange={e => setEmailSmtpHost(e.target.value)}
                      className="h-9 text-xs"
                    />
                  </CardItem>
                  <CardItem column className="mt-0" title="SMTP Port">
                    <Input
                      placeholder="587"
                      value={emailSmtpPort}
                      onChange={e => setEmailSmtpPort(e.target.value)}
                      className="h-9 text-xs"
                    />
                  </CardItem>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-2 gap-y-3 mt-3">
                  <CardItem column className="mt-0" title="IMAP Host">
                    <Input
                      placeholder="imap.gmail.com"
                      value={emailImapHost}
                      onChange={e => setEmailImapHost(e.target.value)}
                      className="h-9 text-xs"
                    />
                  </CardItem>
                  <CardItem column className="mt-0" title="IMAP Port">
                    <Input
                      placeholder="993"
                      value={emailImapPort}
                      onChange={e => setEmailImapPort(e.target.value)}
                      className="h-9 text-xs"
                    />
                  </CardItem>
                </div>
                <Button type="submit" disabled={saving} className="w-full h-9 text-xs mt-4">
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                  Add Email Gateway
                </Button>
              </form>
            )}
          </JanCard>
        </div>

        {/* Listing Column */}
        <div className="md:col-span-2 space-y-4">
          <JanCard
            className="p-0 overflow-hidden"
            header={
              <div className="p-4 border-b bg-muted/20">
                <h3 className="font-semibold text-sm capitalize">Active {activeTab} Connections</h3>
              </div>
            }
          >

            <div className="divide-y">
              {loading ? (
                <div className="p-12 flex items-center justify-center text-muted-foreground text-sm gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading connection logs...
                </div>
              ) : activeTab === "telegram" && tgBots.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground text-sm">
                  No Telegram bots registered.
                </div>
              ) : activeTab === "slack" && slackConns.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground text-sm">
                  No Slack connections registered.
                </div>
              ) : activeTab === "discord" && discordConns.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground text-sm">
                  No Discord bots registered.
                </div>
              ) : activeTab === "email" && emailConns.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground text-sm">
                  No Email gateways registered.
                </div>
              ) : (
                <>
                  {activeTab === "telegram" && tgBots.map(bot => (
                    <div key={bot.id} className="p-4 flex items-center justify-between gap-4">
                      <div className="space-y-1">
                        <span className="font-mono text-sm block font-semibold">{maskToken(bot.bot_token)}</span>
                        <span className="text-[10px] text-muted-foreground">Telegram Bot API Integration</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => handleToggleTgActive(bot)}>
                          {bot.is_active ? "Pause" : "Resume"}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8 text-destructive hover:bg-destructive/10" onClick={() => handleDeleteTg(bot.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}

                  {activeTab === "slack" && slackConns.map(conn => (
                    <div key={conn.id} className="p-4 flex items-center justify-between gap-4">
                      <div className="space-y-1">
                        <span className="font-mono text-sm block font-semibold">Bot: {maskToken(conn.bot_token)}</span>
                        <span className="font-mono text-xs block text-muted-foreground">App: {maskToken(conn.app_token)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => handleToggleSlackActive(conn)}>
                          {conn.is_active ? "Pause" : "Resume"}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8 text-destructive hover:bg-destructive/10" onClick={() => handleDeleteSlack(conn.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}

                  {activeTab === "discord" && discordConns.map(conn => (
                    <div key={conn.id} className="p-4 flex items-center justify-between gap-4">
                      <div className="space-y-1">
                        <span className="font-mono text-sm block font-semibold">{maskToken(conn.bot_token)}</span>
                        <span className="text-[10px] text-muted-foreground">Discord Gate Client Listener</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => handleToggleDiscordActive(conn)}>
                          {conn.is_active ? "Pause" : "Resume"}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8 text-destructive hover:bg-destructive/10" onClick={() => handleDeleteDiscord(conn.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}

                  {activeTab === "email" && emailConns.map(conn => (
                    <div key={conn.id} className="p-4 flex items-center justify-between gap-4">
                      <div className="space-y-1">
                        <span className="text-sm font-semibold block">{conn.username}</span>
                        <span className="text-xs text-muted-foreground block">
                          IMAP: {conn.imap_host}:{conn.imap_port} | SMTP: {conn.smtp_host}:{conn.smtp_port}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => handleToggleEmailActive(conn)}>
                          {conn.is_active ? "Pause" : "Resume"}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8 text-destructive hover:bg-destructive/10" onClick={() => handleDeleteEmail(conn.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </JanCard>
        </div>
      </div>
    </div>
  );
}
