"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Sparkles, Loader2, Save, Info, User, ShieldCheck } from "lucide-react";
import { SectionCard, SaveStatus } from "../../_components/feeder-ui";

const DEFAULT_PROVIDER = "openrouter";
const DEFAULT_MODEL = "google/gemini-2.5-flash";

interface ModelPickerProps {
    provider: string;
    model: string;
    providerMetas: any[];
    onProviderChange: (prov: string) => void;
    onModelChange: (model: string) => void;
}

function ModelPicker({ provider, model, providerMetas, onProviderChange, onModelChange }: ModelPickerProps) {
    const providerMeta = providerMetas.find((p: any) => p.id === provider) || providerMetas[0];
    const models = providerMeta?.defaultModels || [];
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground block">Provider</label>
                <select
                    value={provider}
                    onChange={e => onProviderChange(e.target.value)}
                    className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary font-semibold"
                    disabled={providerMetas.length === 0}
                >
                    {providerMetas.length === 0 ? (
                        <option value="">No gateway providers configured</option>
                    ) : (
                        providerMetas.map((p: any) => (
                            <option key={p.id} value={p.id}>{p.label}</option>
                        ))
                    )}
                </select>
            </div>
            <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground block">Model</label>
                <select
                    value={model}
                    onChange={e => onModelChange(e.target.value)}
                    className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary font-mono"
                >
                    {models.map((m: any) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                    {model && !models.some((m: any) => m.value === model) && (
                        <option value={model}>{model}</option>
                    )}
                </select>
            </div>
        </div>
    );
}

export default function FeederAiPage() {
    // Pass-1 dedup agent
    const [provider, setProvider] = useState(DEFAULT_PROVIDER);
    const [model, setModel] = useState(DEFAULT_MODEL);
    // Pass-2 verifier agent (independent second reviewer)
    const [verifierEnabled, setVerifierEnabled] = useState(true);
    const [vProvider, setVProvider] = useState(DEFAULT_PROVIDER);
    const [vModel, setVModel] = useState(DEFAULT_MODEL);

    const [saved, setSaved] = useState({
        provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL,
        verifierEnabled: true, vProvider: DEFAULT_PROVIDER, vModel: DEFAULT_MODEL,
    });
    const [providerMetas, setProviderMetas] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [settRes, provsRes] = await Promise.all([
                fetch("/api/agent-settings").then(r => r.json()).catch(() => ({})),
                fetch("/api/provider-status").then(r => r.json()).catch(() => ({ providers: [] })),
            ]);
            setProviderMetas(provsRes.providers ?? []);

            const next = {
                provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL,
                verifierEnabled: true, vProvider: DEFAULT_PROVIDER, vModel: DEFAULT_MODEL,
            };
            const rows: { key: string; value: string }[] = settRes.settings ?? settRes.rows ?? [];
            for (const row of rows) {
                if (row.key === "feeder_provider" && row.value) next.provider = row.value;
                if (row.key === "feeder_model" && row.value) next.model = row.value;
                if (row.key === "feeder_verifier_provider" && row.value) next.vProvider = row.value;
                if (row.key === "feeder_verifier_model" && row.value) next.vModel = row.value;
                if (row.key === "feeder_verifier_enabled" && row.value) {
                    next.verifierEnabled = ["true", "1", "yes"].includes(row.value.toLowerCase());
                }
            }
            setProvider(next.provider); setModel(next.model);
            setVerifierEnabled(next.verifierEnabled);
            setVProvider(next.vProvider); setVModel(next.vModel);
            setSaved(next);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const dirty = provider !== saved.provider || model !== saved.model
        || verifierEnabled !== saved.verifierEnabled
        || vProvider !== saved.vProvider || vModel !== saved.vModel;

    const providerChangeFactory = (setP: (p: string) => void, setM: (m: string) => void) => (prov: string) => {
        const meta = providerMetas.find((p: any) => p.id === prov) || providerMetas[0];
        setP(prov);
        setM(meta?.defaultModels?.[0]?.value || "");
    };

    const save = async () => {
        setSaveStatus("saving");
        try {
            const res = await fetch("/api/agent-settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ rows: [
                    { key: "feeder_provider", value: provider || DEFAULT_PROVIDER },
                    { key: "feeder_model", value: model || DEFAULT_MODEL },
                    { key: "feeder_verifier_enabled", value: String(verifierEnabled) },
                    { key: "feeder_verifier_provider", value: vProvider || DEFAULT_PROVIDER },
                    { key: "feeder_verifier_model", value: vModel || DEFAULT_MODEL },
                ] }),
            });
            if (res.ok) {
                setSaveStatus("saved");
                setSaved({ provider, model, verifierEnabled, vProvider, vModel });
            } else {
                setSaveStatus("error");
            }
        } catch {
            setSaveStatus("error");
        } finally {
            setTimeout(() => setSaveStatus("idle"), 3000);
        }
    };

    return (
        <div className="space-y-6 max-w-4xl mx-auto">
            <div className="rounded-xl border bg-primary/5 p-4 flex items-start gap-3">
                <Info className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                <p className="text-xs text-muted-foreground leading-relaxed">
                    Deduplication runs in <strong className="text-foreground">two independent LLM passes</strong>.
                    <strong className="text-foreground"> Pass 1 (Dedup Agent)</strong> clusters each batch into developing
                    storylines and keeps one article per storyline.
                    <strong className="text-foreground"> Pass 2 (Verifier Agent)</strong> re-reviews the survivors with
                    drop-only authority to catch whatever Pass 1 missed — including leftovers across batch chunks.
                    The Verifier can only remove, never re-add, so the two passes converge. Pick fast, cheap models —
                    Pass 1 runs once per chunk per run; Pass 2 runs once per run.
                </p>
            </div>

            <SectionCard title="Pass 1 — Dedup Agent Model" icon={Sparkles} badge={
                <span className="flex items-center gap-1"><User className="h-3 w-3" />Per user</span>
            }>
                {loading ? (
                    <div className="p-8 flex items-center justify-center text-muted-foreground text-sm gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                    </div>
                ) : (
                    <div className="p-4 sm:p-5">
                        <ModelPicker
                            provider={provider}
                            model={model}
                            providerMetas={providerMetas}
                            onProviderChange={providerChangeFactory(setProvider, setModel)}
                            onModelChange={setModel}
                        />
                    </div>
                )}
            </SectionCard>

            <SectionCard title="Pass 2 — Verifier Agent Model" icon={ShieldCheck} badge={
                <span className="flex items-center gap-1"><User className="h-3 w-3" />Per user</span>
            }>
                {loading ? (
                    <div className="p-8 flex items-center justify-center text-muted-foreground text-sm gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                    </div>
                ) : (
                    <div className="p-4 sm:p-5 space-y-4">
                        <label className="flex items-center gap-3 cursor-pointer select-none">
                            <input
                                type="checkbox"
                                checked={verifierEnabled}
                                onChange={e => setVerifierEnabled(e.target.checked)}
                                className="h-4 w-4 rounded border-input accent-primary"
                            />
                            <span>
                                <span className="text-sm font-semibold block">Enable second review pass</span>
                                <span className="text-xs text-muted-foreground">
                                    Recommended. Catches duplicates Pass 1 missed. Uses its own model below —
                                    a different model family than Pass 1 gives the best independent review.
                                </span>
                            </span>
                        </label>
                        <div className={verifierEnabled ? "" : "opacity-40 pointer-events-none"}>
                            <ModelPicker
                                provider={vProvider}
                                model={vModel}
                                providerMetas={providerMetas}
                                onProviderChange={providerChangeFactory(setVProvider, setVModel)}
                                onModelChange={setVModel}
                            />
                        </div>
                    </div>
                )}
            </SectionCard>

            <div className="flex flex-wrap items-center gap-3">
                <Button onClick={save} disabled={saveStatus === "saving" || !dirty || loading}>
                    {saveStatus === "saving"
                        ? <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />Saving…</>
                        : <><Save className="mr-2 h-3.5 w-3.5" />{dirty ? "Save Model Settings" : "No Changes"}</>}
                </Button>
                <SaveStatus status={saveStatus} dirty={dirty} />
            </div>
        </div>
    );
}
