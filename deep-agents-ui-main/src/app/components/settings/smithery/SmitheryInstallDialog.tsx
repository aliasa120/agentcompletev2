"use client";

import React, { useState } from "react";
import {
  Download, Loader2, CheckCircle2, AlertTriangle, XCircle,
  Key, Plus, X, Eye, EyeOff
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SmitheryInstallDialogProps {
  server: {
    qualifiedName: string;
    displayName: string;
    description: string;
    iconUrl: string;
    isInstalledOnServer?: boolean;
  };
  onClose: () => void;
  onSuccess: (connectionId: string) => void;
}

type InstallStep = "install" | "credentials" | "done" | "error";

/**
 * Multi-tenant install dialog:
 *
 * If NOT yet installed on server:
 *   Step 1 → Install (runs npx on server, one-time shared)
 *   Step 2 → User enters their own API credentials
 *   Step 3 → Done
 *
 * If ALREADY installed on server (by another user):
 *   Skip to Step 2 → User enters their own API credentials
 *   Step 3 → Done
 */
export function SmitheryInstallDialog({
  server,
  onClose,
  onSuccess,
}: SmitheryInstallDialogProps) {
  const [step, setStep] = useState<InstallStep>(
    server.isInstalledOnServer ? "credentials" : "install"
  );
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [isPrivateError, setIsPrivateError] = useState(false);

  // User credentials (dynamic key-value pairs they enter)
  const [credentials, setCredentials] = useState<{ key: string; value: string; description?: string }[]>([
    { key: "", value: "" },
  ]);
  const [credentialLabel, setCredentialLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [showValues, setShowValues] = useState<Record<number, boolean>>({});

  // Auto-fetch schema if already installed to pre-populate credentials
  React.useEffect(() => {
    if (server.isInstalledOnServer) {
      setInstalling(true);
      fetch("/api/mcp/smithery/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qualifiedName: server.qualifiedName,
          displayName: server.displayName,
        }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.success && data.schema?.properties) {
            const properties = data.schema.properties;
            const requiredVars = Object.keys(properties);
            if (requiredVars.length > 0) {
              setCredentials(
                requiredVars.map((key) => ({
                  key,
                  value: "",
                  description: properties[key]?.description ?? "",
                }))
              );
            }
          }
        })
        .catch((e) => console.warn("[Smithery Schema Load Error]:", e))
        .finally(() => setInstalling(false));
    }
  }, [server.isInstalledOnServer, server.qualifiedName, server.displayName]);

  const handleInstall = async () => {
    setInstalling(true);
    setInstallLog(["⏳ Starting Smithery CLI install...", `📦 Package: ${server.qualifiedName}`]);

    try {
      const res = await fetch("/api/mcp/smithery/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qualifiedName: server.qualifiedName,
          displayName: server.displayName,
        }),
      });

      const data = await res.json();

      if (data.success) {
        if (data.alreadyInstalled) {
          setInstallLog((prev) => [
            ...prev,
            "✅ Already installed on this server — using cached configuration",
          ]);
        } else {
          setInstallLog((prev) => [
            ...prev,
            "✅ Installation complete!",
            "📁 Config extracted from Claude Desktop config",
            ...(data.stdout ? data.stdout.split("\n").filter(Boolean).slice(0, 5) : []),
          ]);
        }

        // Auto-populate required environment variables if schema exists in response
        if (data.schema?.properties) {
          const properties = data.schema.properties;
          const requiredVars = Object.keys(properties);
          if (requiredVars.length > 0) {
            setCredentials(
              requiredVars.map((key) => ({
                key,
                value: "",
                description: properties[key]?.description ?? "",
              }))
            );
          }
        }

        // Move to credentials step
        setTimeout(() => setStep("credentials"), 800);
      } else {
        setIsPrivateError(!!data.isPrivate || !!data.requiresLogin);
        setErrorMsg(data.error ?? "Installation failed");
        setInstallLog((prev) => [
          ...prev,
          `❌ Error: ${data.error}`,
          ...(data.rawError ? [`Raw: ${data.rawError.slice(0, 200)}`] : []),
        ]);
        setStep("error");
      }
    } catch (e: any) {
      setErrorMsg(e.message ?? "Network error");
      setInstallLog((prev) => [...prev, `❌ Network error: ${e.message}`]);
      setStep("error");
    } finally {
      setInstalling(false);
    }
  };

  const handleAddCredential = () => {
    setCredentials((prev) => [...prev, { key: "", value: "" }]);
  };

  const handleRemoveCredential = (idx: number) => {
    setCredentials((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleCredentialChange = (idx: number, field: "key" | "value", val: string) => {
    setCredentials((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, [field]: val } : c))
    );
  };

  const handleSaveConnection = async () => {
    setSaving(true);
    try {
      const userCredentials: Record<string, string> = {};
      for (const { key, value } of credentials) {
        if (key.trim() && value.trim()) {
          userCredentials[key.trim()] = value.trim();
        }
      }

      const res = await fetch("/api/mcp/smithery/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "local",
          qualifiedName: server.qualifiedName,
          displayName: server.displayName,
          label: credentialLabel || `Smithery: ${server.displayName}`,
          userCredentials,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setStep("done");
        setTimeout(() => onSuccess(data.connectionId), 1200);
      } else {
        setErrorMsg(data.error ?? "Failed to save connection");
        setStep("error");
      }
    } catch (e: any) {
      setErrorMsg(e.message ?? "Network error");
      setStep("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center gap-3 p-5 border-b">
          {server.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={server.iconUrl}
              alt={server.displayName}
              className="w-9 h-9 rounded-lg object-contain bg-muted"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="w-9 h-9 rounded-lg bg-violet-500/10 flex items-center justify-center">
              <Download className="h-5 w-5 text-violet-500" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{server.displayName}</p>
            <p className="text-[10px] text-muted-foreground font-mono truncate">
              {server.qualifiedName}
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Step indicators */}
        <div className="flex items-center gap-0 px-5 pt-4 pb-2">
          {[
            { label: "Install", stepKey: "install" },
            { label: "Credentials", stepKey: "credentials" },
            { label: "Done", stepKey: "done" },
          ].map((s, i, arr) => {
            const currentOrder = ["install", "credentials", "done", "error"].indexOf(step);
            const thisOrder = ["install", "credentials", "done", "error"].indexOf(s.stepKey);
            const isCompleted = step !== "error" && currentOrder > thisOrder;
            const isCurrent = step === s.stepKey || (step === "error" && s.stepKey === "install");
            const isSkipped = server.isInstalledOnServer && s.stepKey === "install";

            return (
              <React.Fragment key={s.stepKey}>
                <div className="flex flex-col items-center gap-1">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-all ${
                      isCompleted || isSkipped
                        ? "bg-emerald-500 text-white"
                        : isCurrent
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isCompleted || isSkipped ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
                  </div>
                  <span
                    className={`text-[9px] font-medium ${
                      isCurrent ? "text-primary" : "text-muted-foreground"
                    }`}
                  >
                    {s.label}
                  </span>
                </div>
                {i < arr.length - 1 && (
                  <div
                    className={`flex-1 h-0.5 mx-1 rounded ${
                      isCompleted || isSkipped ? "bg-emerald-400" : "bg-muted"
                    }`}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>

        <div className="p-5 space-y-4">
          {/* STEP: Install */}
          {step === "install" && (
            <div className="space-y-4">
              <div className="rounded-xl bg-violet-500/5 border border-violet-500/20 p-4 space-y-2">
                <p className="text-xs font-semibold text-violet-700 dark:text-violet-300 flex items-center gap-1.5">
                  <Download className="h-3.5 w-3.5" />
                  Server-Side Installation
                </p>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  This MCP server will be downloaded <strong>once</strong> and shared
                  across all users of this application. Each user then adds their own
                  API credentials.
                </p>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  If another user already installed this, you&apos;ll skip directly to
                  adding your credentials.
                </p>
              </div>

              {installLog.length > 0 && (
                <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3 space-y-1 max-h-40 overflow-y-auto font-mono">
                  {installLog.map((line, i) => (
                    <p key={i} className="text-[11px] text-zinc-300 leading-relaxed">
                      {line}
                    </p>
                  ))}
                  {installing && (
                    <p className="text-[11px] text-amber-400 animate-pulse">
                      ⏳ Installing via npx...
                    </p>
                  )}
                </div>
              )}

              <Button
                onClick={handleInstall}
                disabled={installing}
                className="w-full gap-2"
              >
                {installing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {installing ? "Installing…" : "Install on Server"}
              </Button>
            </div>
          )}

          {/* STEP: Credentials */}
          {step === "credentials" && (
            <div className="space-y-4">
              {server.isInstalledOnServer && (
                <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 p-3 flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-emerald-700 dark:text-emerald-400 leading-relaxed">
                    Already installed on server. Add your own API credentials below — they are
                    stored privately for your account only.
                  </p>
                </div>
              )}

              <div>
                <label className="text-xs font-semibold text-muted-foreground block mb-1.5">
                  Connection Label
                </label>
                <Input
                  value={credentialLabel}
                  onChange={(e) => setCredentialLabel(e.target.value)}
                  placeholder={`Smithery: ${server.displayName}`}
                  className="h-9 text-sm"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                    <Key className="h-3.5 w-3.5" />
                    Your API Credentials
                  </label>
                  <button
                    onClick={handleAddCredential}
                    className="text-[10px] text-primary hover:underline font-semibold flex items-center gap-0.5"
                  >
                    <Plus className="h-3 w-3" /> Add key
                  </button>
                </div>
                <p className="text-[10px] text-muted-foreground mb-2 leading-relaxed">
                  Enter the environment variables this MCP server needs (e.g.{" "}
                  <code className="font-mono bg-muted px-1 rounded">GITHUB_TOKEN</code>,{" "}
                  <code className="font-mono bg-muted px-1 rounded">API_KEY</code>).
                  Stored encrypted and used only for your connection.
                </p>

                <div className="space-y-2.5">
                  {credentials.map((cred, idx) => (
                    <div key={idx} className="flex flex-col gap-1.5 p-2 rounded-lg border bg-muted/20">
                      <div className="flex items-center gap-2">
                        <Input
                          value={cred.key}
                          onChange={(e) => handleCredentialChange(idx, "key", e.target.value)}
                          placeholder="ENV_VAR_NAME"
                          className="h-8 text-xs font-mono w-2/5"
                        />
                        <div className="relative flex-1">
                          <Input
                            type={showValues[idx] ? "text" : "password"}
                            value={cred.value}
                            onChange={(e) => handleCredentialChange(idx, "value", e.target.value)}
                            placeholder="your-api-key"
                            className="h-8 text-xs font-mono pr-8"
                          />
                          <button
                            onClick={() =>
                              setShowValues((prev) => ({ ...prev, [idx]: !prev[idx] }))
                            }
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          >
                            {showValues[idx] ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                        {credentials.length > 1 && (
                          <button
                            onClick={() => handleRemoveCredential(idx)}
                            className="text-muted-foreground hover:text-destructive shrink-0"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      {cred.description && (
                        <p className="text-[10px] text-muted-foreground pl-1 leading-normal italic">
                          {cred.description}
                        </p>
                      )}
                    </div>
                  ))}
                </div>

                <p className="text-[10px] text-muted-foreground mt-2">
                  No credentials needed? Leave all fields empty and click Save.
                </p>
              </div>

              <Button
                onClick={handleSaveConnection}
                disabled={saving}
                className="w-full gap-2"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {saving ? "Saving…" : "Save Connection"}
              </Button>
            </div>
          )}

          {/* STEP: Done */}
          {step === "done" && (
            <div className="flex flex-col items-center justify-center py-6 gap-3 text-center">
              <div className="w-14 h-14 rounded-full bg-emerald-500/10 flex items-center justify-center">
                <CheckCircle2 className="h-7 w-7 text-emerald-500" />
              </div>
              <div>
                <p className="font-semibold text-sm">Connection Saved!</p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {server.displayName} is now connected. Go to the Tools tab to enable
                  individual tools.
                </p>
              </div>
            </div>
          )}

          {/* STEP: Error */}
          {step === "error" && (
            <div className="space-y-4">
              <div
                className={`rounded-xl border p-4 space-y-2 ${
                  isPrivateError
                    ? "bg-amber-500/5 border-amber-500/30"
                    : "bg-destructive/5 border-destructive/30"
                }`}
              >
                <div className="flex items-start gap-2">
                  {isPrivateError ? (
                    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                  )}
                  <div>
                    <p
                      className={`text-xs font-semibold ${
                        isPrivateError
                          ? "text-amber-700 dark:text-amber-400"
                          : "text-destructive"
                      }`}
                    >
                      {isPrivateError ? "Cannot Download This MCP" : "Installation Failed"}
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                      {errorMsg}
                    </p>
                  </div>
                </div>
              </div>

              {isPrivateError && (
                <div className="rounded-xl bg-blue-500/5 border border-blue-500/20 p-3">
                  <p className="text-[11px] text-blue-700 dark:text-blue-400 font-medium mb-1">
                    💡 Use Remote Connection Instead
                  </p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Close this dialog and click &quot;Connect Remote&quot; on the server card.
                    You&apos;ll need your own Smithery API key to use the managed cloud version.
                  </p>
                </div>
              )}

              {installLog.length > 0 && (
                <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3 max-h-32 overflow-y-auto font-mono">
                  {installLog.map((line, i) => (
                    <p key={i} className="text-[10px] text-zinc-400">
                      {line}
                    </p>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <Button variant="outline" onClick={onClose} className="flex-1 h-8 text-xs">
                  Close
                </Button>
                {!isPrivateError && (
                  <Button
                    onClick={() => {
                      setStep("install");
                      setInstallLog([]);
                      setErrorMsg("");
                    }}
                    className="flex-1 h-8 text-xs gap-1"
                  >
                    Try Again
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
