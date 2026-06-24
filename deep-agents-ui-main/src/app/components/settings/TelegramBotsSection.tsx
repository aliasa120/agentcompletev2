"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Plus, Trash2, Save, Loader2, CheckCircle2,
  Bot, AlertTriangle, ToggleLeft, ToggleRight
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Workflow {
  id: string;
  name: string;
}

interface TelegramBot {
  id: string;
  bot_token: string;
  workflow_id: string | null;
  is_active: boolean;
  created_at: string;
  workflows?: {
    name: string;
  };
}

export function TelegramBotsSection() {
  const [bots, setBots] = useState<TelegramBot[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form State
  const [tokenInput, setTokenInput] = useState("");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [isActive, setIsActive] = useState(true);

  // Alert/Status State
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const fetchBotsAndWorkflows = useCallback(async () => {
    setLoading(true);
    try {
      const [botsRes, wfRes] = await Promise.all([
        fetch("/api/telegram-bots"),
        fetch("/api/workflows")
      ]);
      const botsData = await botsRes.json();
      const wfData = await wfRes.json();

      setBots(botsData.bots ?? []);
      setWorkflows(wfData.workflows ?? []);
      
      if (wfData.workflows && wfData.workflows.length > 0) {
        setSelectedWorkflowId(wfData.workflows[0].id);
      }
    } catch (e) {
      console.error("Failed to load telegram bots or workflows:", e);
      showStatus("error", "Failed to load database config.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBotsAndWorkflows();
  }, [fetchBotsAndWorkflows]);

  const showStatus = (type: "success" | "error", text: string) => {
    setStatusMessage({ type, text });
    setTimeout(() => setStatusMessage(null), 3000);
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
          workflow_id: selectedWorkflowId || null,
          is_active: isActive
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        showStatus("success", "Telegram Bot registered successfully!");
        setTokenInput("");
        fetchBotsAndWorkflows();
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
          workflow_id: bot.workflow_id,
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
    if (!confirm("Are you sure you want to delete this bot registration? This will stop its active listeners.")) {
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
              Add your bot API keys and connect them to workflows. Each bot runs on its own isolated thread memory.
            </p>
          </div>
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
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground">Connect to Workflow</label>
                {workflows.length === 0 ? (
                  <div className="text-xs text-amber-500 py-1">
                    No active workflows. Please create a workflow first.
                  </div>
                ) : (
                  <select
                    value={selectedWorkflowId}
                    onChange={e => setSelectedWorkflowId(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {workflows.map(wf => (
                      <option key={wf.id} value={wf.id}>{wf.name}</option>
                    ))}
                  </select>
                )}
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
                disabled={saving || workflows.length === 0} 
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
                      <p className="text-xs text-muted-foreground">
                        Bound Workflow: <strong className="text-foreground">{bot.workflows?.name || "None (Disabled)"}</strong>
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
