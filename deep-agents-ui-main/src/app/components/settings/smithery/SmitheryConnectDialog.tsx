"use client";

import React, { useState } from "react";
import { Globe, Loader2, CheckCircle2, X, Eye, EyeOff, ExternalLink, Key, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SmitheryConnectDialogProps {
  server: {
    qualifiedName: string;
    displayName: string;
    description: string;
    iconUrl: string;
    homepage: string;
  };
  onClose: () => void;
  onSuccess: (connectionId: string) => void;
}

/**
 * Remote connection dialog — handles all three Smithery auth states:
 *
 *  1. "connected"      → No auth needed, connected immediately ✅
 *  2. "auth_required"  → OAuth — opens popup, poll until connected 🔐
 *  3. "input_required" → API key / settings needed — renders a dynamic
 *                        form from Smithery's configSchema, then re-connects
 *                        with the filled-in values embedded in the URL 🔑
 *
 * Multi-tenant: User A's Smithery key is completely separate from User B's key.
 */
export function SmitheryConnectDialog({
  server,
  onClose,
  onSuccess,
}: SmitheryConnectDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  // ── OAuth states ────────────────────────────────────────────────────────────
  const [requiresAuth, setRequiresAuth] = useState(false);
  const [authUrl, setAuthUrl] = useState("");
  const [authStatus, setAuthStatus] = useState<"waiting" | "success" | "failed">("waiting");

  // ── API key / input_required states ────────────────────────────────────────
  /** Triggered when Smithery returns state="input_required" */
  const [requiresInput, setRequiresInput] = useState(false);
  /** JSON Schema from Smithery describing what fields the server needs */
  const [configSchema, setConfigSchema] = useState<any>(null);
  /** Field names that are currently missing */
  const [missingFields, setMissingFields] = useState<any>(null);
  /** User-filled values for the config fields */
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  /** Show/hide for each config secret field */
  const [showConfigField, setShowConfigField] = useState<Record<string, boolean>>({});
  /** Smithery namespace + connectionId saved for the re-connect after input */
  const [pendingNamespace, setPendingNamespace] = useState("");
  const [pendingSmitheryConnId, setPendingSmitheryConnId] = useState("");
  /** Optional hosted form URL from Smithery for the input_required step */
  const [inputSetupUrl, setInputSetupUrl] = useState("");

  // Keep references to popup and interval for cleanup
  const popupRef = React.useRef<Window | null>(null);
  const pollIntervalRef = React.useRef<NodeJS.Timeout | null>(null);

  // Cleanup polling and popup on unmount
  React.useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (popupRef.current) popupRef.current.close();
    };
  }, []);

  const remoteUrl = `https://server.smithery.ai/${server.qualifiedName}/mcp`;

  // ── OAuth polling ────────────────────────────────────────────────────────────
  const startPolling = (namespace: string, smitheryConnectionId: string, finalConnectionId: string) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

    pollIntervalRef.current = setInterval(async () => {
      // Check if popup has been closed manually by the user
      if (popupRef.current && popupRef.current.closed) {
        clearInterval(pollIntervalRef.current!);
        setConnecting(false);
        setError("Authorization popup was closed. Please try again.");
        return;
      }

      try {
        const queryParams = new URLSearchParams({
          namespace,
          connectionId: smitheryConnectionId,
          smitheryApiKey: apiKey.trim(),
        });
        const res = await fetch(`/api/mcp/smithery/connect?${queryParams.toString()}`);
        const data = await res.json();

        if (data.success && data.state === "connected") {
          // Success! Clear interval and close popup
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          if (popupRef.current) popupRef.current.close();

          setAuthStatus("success");
          setDone(true);
          setConnecting(false);
          setTimeout(() => onSuccess(finalConnectionId), 1200);
        } else if (data.success && data.state === "failed") {
          // Failed authorization
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          if (popupRef.current) popupRef.current.close();
          
          setAuthStatus("failed");
          setConnecting(false);
          setError("Smithery connection authorization failed.");
        }
      } catch (err: any) {
        console.warn("[Smithery Auth Poll Error]:", err);
      }
    }, 2000);
  };

  const handleOpenPopup = (urlToOpen: string) => {
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.focus();
      return;
    }

    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    popupRef.current = window.open(
      urlToOpen,
      "Smithery Authorization",
      `width=${width},height=${height},left=${left},top=${top}`
    );
  };

  // ── Main connect call ────────────────────────────────────────────────────────
  const callConnect = async (configOverride?: any) => {
    setConnecting(true);
    setError("");

    try {
      const res = await fetch("/api/mcp/smithery/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "remote",
          qualifiedName: server.qualifiedName,
          displayName: server.displayName,
          smitheryApiKey: apiKey.trim(),
          label: label.trim() || `Smithery (Remote): ${server.displayName}`,
          ...(configOverride ? { config: configOverride } : {}),
        }),
      });
      const data = await res.json();

      if (!data.success) {
        setError(data.error ?? "Failed to create connection.");
        setConnecting(false);
        return;
      }

      // ── State: auth_required (OAuth) ─────────────────────────────────────
      if (data.requiresAuth) {
        setRequiresAuth(true);
        setAuthUrl(data.setupUrl);
        setAuthStatus("waiting");
        handleOpenPopup(data.setupUrl);
        startPolling(data.namespace, data.smitheryConnectionId, data.connectionId);
        // Keep connecting=true while polling
        return;
      }

      // ── State: input_required (API key / settings) ───────────────────────
      if (data.requiresInput) {
        setRequiresInput(true);
        setConfigSchema(data.configSchema);
        setMissingFields(data.missingFields);
        setPendingNamespace(data.namespace);
        setPendingSmitheryConnId(data.smitheryConnectionId);
        setInputSetupUrl(data.setupUrl ?? "");
        // Initialize config values to empty for all required fields in query and headers
        const initial: Record<string, string> = {};
        const schema = data.configSchema;
        if (schema?.query) {
          for (const fieldKey of Object.keys(schema.query)) {
            initial[fieldKey] = "";
          }
        }
        if (schema?.headers) {
          for (const fieldKey of Object.keys(schema.headers)) {
            initial[fieldKey] = "";
          }
        }
        setConfigValues(initial);
        setConnecting(false);
        return;
      }

      // ── State: connected ─────────────────────────────────────────────────
      setDone(true);
      setTimeout(() => onSuccess(data.connectionId), 1200);
    } catch (e: any) {
      setError(e.message ?? "Network error");
      setConnecting(false);
    }
  };

  const handleConnect = async () => {
    if (!apiKey.trim()) {
      setError("Please enter your Smithery API key.");
      return;
    }
    setRequiresAuth(false);
    setRequiresInput(false);
    setAuthUrl("");
    await callConnect();
  };

  // Re-connect after filling in the config form (input_required flow)
  const handleSubmitConfig = async () => {
    // Validate all required fields are filled
    const schema = configSchema;
    
    // 1. Validate query fields
    if (schema?.query) {
      for (const [key, spec] of Object.entries(schema.query) as [string, any][]) {
        const isRequired = spec.required || (missingFields?.query || []).includes(key);
        if (isRequired && !configValues[key]?.trim()) {
          setError(`Please provide a value for: ${spec.label || key}`);
          return;
        }
      }
    }

    // 2. Validate headers fields
    if (schema?.headers) {
      for (const [key, spec] of Object.entries(schema.headers) as [string, any][]) {
        const isRequired = spec.required || (missingFields?.headers || []).includes(key);
        if (isRequired && !configValues[key]?.trim()) {
          setError(`Please provide a value for: ${spec.label || key}`);
          return;
        }
      }
    }

    setError("");

    // Build structured payload
    const queryValues: Record<string, string> = {};
    const headerValues: Record<string, string> = {};

    if (schema?.query) {
      for (const k of Object.keys(schema.query)) {
        if (configValues[k] !== undefined && configValues[k] !== "") {
          queryValues[k] = configValues[k];
        }
      }
    }
    if (schema?.headers) {
      for (const k of Object.keys(schema.headers)) {
        if (configValues[k] !== undefined && configValues[k] !== "") {
          headerValues[k] = configValues[k];
        }
      }
    }

    await callConnect({
      query: queryValues,
      headers: headerValues
    });
  };

  // ── Render helpers ───────────────────────────────────────────────────────────
  const renderConfigForm = () => {
    if (!configSchema) return null;

    interface FormField {
      key: string;
      fieldType: "query" | "headers";
      spec: any;
      isRequired: boolean;
    }

    const fields: FormField[] = [];

    // 1. Collect query fields
    if (configSchema.query) {
      for (const [key, spec] of Object.entries(configSchema.query) as [string, any][]) {
        const isRequired = spec.required || (missingFields?.query || []).includes(key);
        fields.push({ key, fieldType: "query", spec, isRequired });
      }
    }

    // 2. Collect headers fields
    if (configSchema.headers) {
      for (const [key, spec] of Object.entries(configSchema.headers) as [string, any][]) {
        const isRequired = spec.required || (missingFields?.headers || []).includes(key);
        fields.push({ key, fieldType: "headers", spec, isRequired });
      }
    }

    if (fields.length === 0) return null;

    return (
      <div className="space-y-3">
        {fields.map(({ key, fieldType, spec, isRequired }) => {
          const isSecret =
            spec.format === "password" ||
            key.toLowerCase().includes("key") ||
            key.toLowerCase().includes("token") ||
            key.toLowerCase().includes("secret") ||
            (spec.label && spec.label.toLowerCase().includes("key"));
          const showThis = showConfigField[key] ?? false;

          return (
            <div key={key}>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                  {isSecret && <Key className="h-3 w-3 text-amber-500" />}
                  {spec.label || key}
                  {isRequired && (
                    <span className="text-destructive ml-0.5">*</span>
                  )}
                </label>
                {!isRequired && (
                  <span className="text-[10px] text-muted-foreground">Optional</span>
                )}
              </div>
              {spec.description && (
                <p className="text-[10px] text-muted-foreground mb-1.5 leading-relaxed">
                  {spec.description}
                </p>
              )}
              <div className="relative">
                <Input
                  type={isSecret && !showThis ? "password" : "text"}
                  value={configValues[key] ?? ""}
                  onChange={(e) =>
                    setConfigValues((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  placeholder={spec.examples?.[0] ?? (isSecret ? "Enter your key…" : `Enter ${spec.label || key}`)}
                  className="h-9 text-sm font-mono pr-10"
                />
                {isSecret && (
                  <button
                    type="button"
                    onClick={() =>
                      setShowConfigField((prev) => ({ ...prev, [key]: !showThis }))
                    }
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showThis ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // ── Component output ────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md">
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
            <div className="w-9 h-9 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <Globe className="h-5 w-5 text-emerald-500" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">
              Connect Remote: {server.displayName}
            </p>
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

        <div className="p-5 space-y-4">
          {!done ? (
            <>
              {/* Info about remote mode */}
              <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 p-3 space-y-1.5">
                <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                  <Globe className="h-3.5 w-3.5" />
                  Smithery Managed Cloud
                </p>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  This connects directly to Smithery&apos;s hosted infrastructure. No local
                  installation needed. Your Smithery API key is stored only for this
                  connection — it is not shared with other users.
                </p>
                {server.homepage && (
                  <a
                    href={server.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                  >
                    View on Smithery <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </div>

              {/* ── State: OAuth authorization required ───────────────── */}
              {requiresAuth && (
                <div className="rounded-xl bg-violet-500/5 border border-violet-500/20 p-3 space-y-2.5">
                  <p className="text-[11px] font-semibold text-violet-700 dark:text-violet-400 flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" />
                    Authorization Required
                  </p>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    This MCP server requires OAuth login. Please complete authorization in the popup window.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleOpenPopup(authUrl)}
                    className="h-8 text-[10.5px] border-violet-500/20 text-violet-700 dark:text-violet-400 hover:bg-violet-500/10 gap-1.5 w-full justify-center"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Open Authorization Window
                  </Button>
                </div>
              )}

              {/* ── State: input_required (API key / settings) ─────────── */}
              {requiresInput && (
                <div className="space-y-3">
                  <div className="rounded-xl bg-amber-500/5 border border-amber-500/20 p-3 space-y-1.5">
                    <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                      <Lock className="h-3.5 w-3.5" />
                      API Key Required
                    </p>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      This MCP server requires your own API key(s) to connect. Fill in the
                      fields below — they are stored only within your connection and never
                      shared.
                    </p>
                    {inputSetupUrl && (
                      <a
                        href={inputSetupUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                      >
                        Configure on Smithery <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    )}
                  </div>

                  {/* Dynamic config form from configSchema */}
                  {renderConfigForm()}
                </div>
              )}

              {/* ── Initial form (before any state is determined) ───────── */}
              {!requiresAuth && !requiresInput && (
                <>
                  {/* Remote URL (read-only) */}
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground block mb-1.5">
                      Remote Endpoint
                    </label>
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-muted/30 font-mono text-[11px] text-muted-foreground break-all">
                      {remoteUrl}
                    </div>
                  </div>

                  {/* Connection Label */}
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground block mb-1.5">
                      Connection Label
                    </label>
                    <Input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder={`Smithery (Remote): ${server.displayName}`}
                      className="h-9 text-sm"
                    />
                  </div>

                  {/* Smithery API Key — per user */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-semibold text-muted-foreground">
                        Your Smithery API Key
                      </label>
                      <a
                        href="https://smithery.run/account/api-keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-primary hover:underline flex items-center gap-0.5"
                      >
                        Get key <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    </div>
                    <div className="relative">
                      <Input
                        type={showKey ? "text" : "password"}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                        className="h-9 text-sm font-mono pr-10"
                      />
                      <button
                        onClick={() => setShowKey((v) => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showKey ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      Stored only for your connection. Never shared. Required for Smithery&apos;s
                      managed hosting to authenticate you.
                    </p>
                  </div>
                </>
              )}

              {error && (
                <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/20 p-2.5">
                  <X className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                  <p className="text-[11px] text-destructive leading-snug">{error}</p>
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <Button
                  variant="outline"
                  onClick={() => {
                    if (requiresInput) {
                      // Go back to the initial form
                      setRequiresInput(false);
                      setConfigSchema(null);
                      setMissingFields([]);
                      setConfigValues({});
                      setError("");
                    } else {
                      onClose();
                    }
                  }}
                  className="flex-1 h-9 text-xs"
                >
                  {requiresAuth ? "Close" : requiresInput ? "← Back" : "Cancel"}
                </Button>

                {/* Show connect button when in initial state */}
                {!requiresAuth && !requiresInput && (
                  <Button
                    onClick={handleConnect}
                    disabled={connecting || !apiKey.trim()}
                    className="flex-1 h-9 text-xs gap-1.5"
                  >
                    {connecting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Globe className="h-3.5 w-3.5" />
                    )}
                    {connecting ? "Connecting…" : "Connect"}
                  </Button>
                )}

                {/* Show submit button when in input_required state */}
                {requiresInput && (
                  <Button
                    onClick={handleSubmitConfig}
                    disabled={connecting}
                    className="flex-1 h-9 text-xs gap-1.5"
                  >
                    {connecting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Key className="h-3.5 w-3.5" />
                    )}
                    {connecting ? "Connecting…" : "Submit & Connect"}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-6 gap-3 text-center">
              <div className="w-14 h-14 rounded-full bg-emerald-500/10 flex items-center justify-center">
                <CheckCircle2 className="h-7 w-7 text-emerald-500" />
              </div>
              <div>
                <p className="font-semibold text-sm">Connected!</p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {server.displayName} remote connection is active. Go to the Tools tab to
                  manage tools.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
