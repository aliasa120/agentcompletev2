"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Plus, Trash2, Loader2, CheckCircle2,
  Bot, AlertTriangle, ToggleLeft, ToggleRight, Workflow
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface TelegramBot {
  id: string;
  bot_token: string;
  is_active: boolean;
  created_at: string;
}

export function TelegramBotsSection() {
  const [bots, setBots] = useState<TelegramBot[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form State
  const [tokenInput, setTokenInput] = useState("");
  const [isActive, setIsActive] = useState(true);

  // Alert/Status State
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const fetchBots = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/telegram-bots");
      const data = await res.json();
      setBots(data.bots ?? []);
    } catch (e) {
      console.error("Failed to load telegram bots:", e);
      showStatus("error", "Failed to load bot configuration.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBots();
  }, [fetchBots]);

  const showStatus = (type: "success" | "error", text: string) => {
    setStatusMessage({ type, text });
    setTimeout(() => setStatusMessage(null), 3500);
  };

  const handleRegisterBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenInput.trim()) {
      showStatus("error", "Bot Token is required.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/telegram-bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bot_token: tokenInput.trim(),
          is_active: isActive
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        showStatus("success", "Telegram Bot registered successfully!");
        setTokenInput("");
        fetchBots();
      } else {
        showStatus("error", data.error || "Failed to register bot.");
      }
    } catch (err) {
      console.error("Error registering bot:", err);
      showStatus("error", "Network error registering bot.");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (bot: TelegramBot) => {
    try {
      const res = await fetch("/api/telegram-bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: bot.id,
          bot_token: bot.bot_token,
          is_active: !bot.is_active
        })
      });

      if (res.ok) {
        setBots(prev => prev.map(b => b.id === bot.id ? { ...b, is_active: !b.is_active } : b));
        showStatus("success", `Bot ${!bot.is_active ? "enabled" : "disabled"}`);
      } else {
        showStatus("error", "Failed to update bot status.");
      }
    } catch (err) {
      console.error("Error toggling bot status:", err);
      showStatus("error", "Network error updating status.");
    }
  };

  const handleDeleteBot = async (id: string) => {
    if (!confirm("Are you sure you want to delete this bot? This will stop all its active listeners.")) {
      return;
    }

    try {
      const res = await fetch(`/api/telegram-bots?id=${id}`, {
        method: "DELETE"
      });

      if (res.ok) {
        setBots(prev => prev.filter(b => b.id !== id));
        showStatus("success", "Bot deleted successfully.");
      } else {
        const data = await res.json();
        showStatus("error", data.error || "Failed to delete bot.");
      }
    } catch (err) {
      console.error("Error deleting bot:", err);
      showStatus("error", "Network error deleting bot.");
    }
  };

  const maskToken = (token: string) => {
    if (!token) return "";
    if (token.length <= 15) return "••••••••••••";
    return `${token.slice(0, 8)}••••••••${token.slice(-6)}`;
  };

  return (
    <div className="space-y-6">
      {/* Header card */}
      <div className="rounded-xl border bg-card shadow-sm p-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-primary/10 text-primary rounded-lg">
            <Bot className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight">Telegram Bots Integration</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Register your Telegram bot token. Users can then type <code className="text-xs bg-muted px-1 py-0.5 rounded">/start</code> in Telegram to pick any of their enabled workflows and start chatting.
            </p>
          </div>
        </div>
      </div>

      {/* How it works banner */}
      <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 flex gap-3 items-start">
        <Workflow className="h-4 w-4 text-primary shrink-0 mt-0.5" />
        <div className="text-sm text-muted-foreground space-y-1">
          <p className="font-semibold text-foreground">How it works</p>
          <p>1. Register your bot token below and enable it.</p>
          <p>2. Open Telegram and send <code className="text-xs bg-muted px-1 py-0.5 rounded">/start</code> to your bot.</p>
          <p>3. All your enabled workflows appear as buttons — tap one to begin a <strong>new conversation</strong>.</p>
          <p>4. Send <code className="text-xs bg-muted px-1 py-0.5 rounded">/start</code> again anytime to switch workflows or start a fresh thread.</p>
        </div>
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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Register bot form */}
        <div className="md:col-span-1 space-y-6">
          <div className="rounded-xl border bg-card shadow-sm p-5 space-y-4">
            <h3 className="font-semibold text-sm">Register New Bot</h3>

            <form onSubmit={handleRegisterBot} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground">Bot API Token</label>
                <Input
                  type="password"
                  placeholder="8802642908:AAEd5X..."
                  value={tokenInput}
                  onChange={e => setTokenInput(e.target.value)}
                  className="h-9 text-sm"
                  autoComplete="off"
                />
                <p className="text-[10px] text-muted-foreground">
                  Get this from <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-primary underline">@BotFather</a> on Telegram.
                </p>
              </div>

              <div className="flex items-center justify-between py-1">
                <span className="text-xs font-semibold text-muted-foreground">Enable Bot Listener</span>
                <button
                  type="button"
                  onClick={() => setIsActive(!isActive)}
                  className="text-primary hover:opacity-85 focus:outline-none"
                >
                  {isActive ? <ToggleRight className="h-7 w-7 text-primary" /> : <ToggleLeft className="h-7 w-7 text-muted-foreground" />}
                </button>
              </div>

              <Button
                type="submit"
                disabled={saving}
                className="w-full h-9 gap-1.5 text-xs mt-2"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Register Bot
              </Button>
            </form>
          </div>
        </div>

        {/* Bots List */}
        <div className="md:col-span-2 space-y-4">
          <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
            <div className="p-4 border-b bg-muted/20">
              <h3 className="font-semibold text-sm">Active Telegram Bot Connections</h3>
            </div>

            <div className="divide-y">
              {loading ? (
                <div className="p-12 flex items-center justify-center text-muted-foreground text-sm gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading configuration...
                </div>
              ) : bots.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground text-sm">
                  No bots registered. Use the form to link your first Telegram bot.
                </div>
              ) : (
                bots.map(bot => (
                  <div key={bot.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm font-mono">{maskToken(bot.bot_token)}</span>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                          bot.is_active
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/20 dark:text-emerald-400 dark:border-emerald-900/30"
                            : "bg-muted text-muted-foreground border-border"
                        }`}>
                          {bot.is_active ? "Active Listener" : "Disabled"}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Workflow className="h-3 w-3" />
                        <span>Routes to <strong className="text-foreground">all enabled workflows</strong> via /start menu</span>
                      </p>
                      <p className="text-[10px] text-muted-foreground/75">
                        Added: {new Date(bot.created_at).toLocaleString()}
                      </p>
                    </div>

                    <div className="flex items-center gap-3">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs gap-1.5"
                        onClick={() => handleToggleActive(bot)}
                      >
                        {bot.is_active ? "Pause" : "Resume"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 text-destructive hover:bg-destructive/10"
                        onClick={() => handleDeleteBot(bot.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
