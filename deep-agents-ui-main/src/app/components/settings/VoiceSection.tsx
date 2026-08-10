"use client";

/**
 * VoiceSection - Voice and Text-to-Speech settings sub-page.
 * Shown under Additional Features -> Voice & TTS in the sidebar.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Volume2, Eye, EyeOff, CheckCircle2, Loader2, AlertCircle,
  ExternalLink, ChevronDown, Mic, AudioLines, Settings2, Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JanCard } from "@/components/settings/JanCard";

type SaveState = "idle" | "saving" | "saved" | "error";

interface SettingField {
  key: string;
  label: string;
  placeholder: string;
  helpUrl?: string;
  type?: "password" | "text" | "url";
  options?: { value: string; label: string }[];
  description?: string;
}

const TTS_SETTINGS: SettingField[] = [
  {
    key: "tts_provider",
    label: "TTS Provider",
    placeholder: "elevenlabs",
    type: "text",
    options: [
      { value: "elevenlabs", label: "ElevenLabs (best quality, multilingual)" },
      { value: "edge",       label: "Edge TTS (free, no API key needed)" },
      { value: "openai",     label: "OpenAI (gpt-4o-mini-tts)" },
    ],
    description: "Select the text-to-speech engine.",
  },
  {
    key: "elevenlabs_api_key",
    label: "ElevenLabs API Key",
    placeholder: "sk_...",
    type: "password",
    helpUrl: "https://elevenlabs.io/app/settings/api-keys",
    description: "Required when TTS Provider is ElevenLabs.",
  },
  {
    key: "tts_voice_id",
    label: "ElevenLabs Voice ID",
    placeholder: "pNInz6obpgDQGcFmaJgB (Adam)",
    type: "text",
    helpUrl: "https://elevenlabs.io/app/voice-library",
    description: "Voice ID from your ElevenLabs voice library.",
  },
  {
    key: "tts_model_id",
    label: "ElevenLabs Model ID",
    placeholder: "eleven_multilingual_v2",
    type: "text",
    description: "eleven_multilingual_v2 is recommended.",
  },
  {
    key: "edge_tts_voice",
    label: "Edge TTS Voice",
    placeholder: "en-US-AriaNeural",
    type: "text",
    description: "Voice name for Edge TTS (free, no key needed).",
  },
  {
    key: "openai_api_key",
    label: "OpenAI API Key (for TTS)",
    placeholder: "sk-proj-...",
    type: "password",
    helpUrl: "https://platform.openai.com/api-keys",
    description: "Required when TTS Provider is OpenAI.",
  },
];

const PROVIDER_FIELDS: Record<string, string[]> = {
  elevenlabs: ["tts_provider", "elevenlabs_api_key", "tts_voice_id", "tts_model_id"],
  edge:       ["tts_provider", "edge_tts_voice"],
  openai:     ["tts_provider", "openai_api_key"],
};

function SettingRow({ field, value, onChange, onSave, saveState }: {
  field: SettingField;
  value: string;
  onChange: (v: string) => void;
  onSave: (v: string) => void;  // now takes the value directly to avoid stale closure
  saveState: SaveState;
}) {
  const [visible, setVisible] = useState(false);
  const isPassword = field.type === "password";

  if (field.options) {
    return (
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-foreground">{field.label}</label>
        {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
        <div className="relative">
          <select
            value={value}
            onChange={(e) => {
              const v = e.target.value;
              onChange(v);
              onSave(v); // pass value directly — state may not have flushed yet
            }}
            className="w-full h-10 rounded-md border border-input bg-background px-3 pr-9 text-sm shadow-sm appearance-none focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {field.options.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        </div>
        {saveState === "saved" && (
          <span className="text-xs text-emerald-500 flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" /> Saved
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium text-foreground">{field.label}</label>
        {field.helpUrl && (
          <a href={field.helpUrl} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-primary">
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      <div className="flex gap-2 items-center">
        <div className="relative flex-1">
          <Input
            type={isPassword && !visible ? "password" : "text"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSave(value)}
            placeholder={field.placeholder}
            className="pr-10"
          />
          {isPassword && (
            <button
              type="button"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setVisible((v) => !v)}
            >
              {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          )}
        </div>
        <Button variant="outline" size="sm" className="shrink-0 h-9 px-4" onClick={() => onSave(value)} disabled={saveState === "saving"}>
          {saveState === "saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
           : saveState === "saved" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
           : saveState === "error" ? <AlertCircle className="h-3.5 w-3.5 text-destructive" />
           : "Save"}
        </Button>
      </div>
    </div>
  );
}

export function VoiceSection() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/agent-settings");
        if (!res.ok) return;
        const data = await res.json();
        // API returns { settings: [{key, value}] }
        const rows: { key: string; value: string }[] =
          Array.isArray(data) ? data :
          Array.isArray(data?.settings) ? data.settings :
          Array.isArray(data?.rows) ? data.rows :
          [];
        const loaded: Record<string, string> = {};
        for (const f of TTS_SETTINGS) {
          const row = rows.find((r) => r.key === f.key);
          loaded[f.key] = row?.value ?? "";
        }
        setValues(loaded);
      } catch (e) {
        console.error("Failed to load voice settings:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSave = useCallback(async (key: string, value: string) => {
    setSaveStates((s) => ({ ...s, [key]: "saving" }));
    setSaveError(null);
    try {
      const res = await fetch("/api/agent-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: [{ key, value }] }),
      });
      if (res.ok) {
        setSaveStates((s) => ({ ...s, [key]: "saved" }));
        setTimeout(() => setSaveStates((s) => ({ ...s, [key]: "idle" })), 2000);
        // Keep values in sync with what the backend actually stored.
        setValues((prev) => ({ ...prev, [key]: value }));
      } else {
        setSaveStates((s) => ({ ...s, [key]: "error" }));
        const body = await res.json().catch(() => null);
        setSaveError(`Failed to save "${key}": ${body?.error ?? res.statusText ?? "unknown error"}`);
      }
    } catch (e) {
      setSaveStates((s) => ({ ...s, [key]: "error" }));
      setSaveError(`Failed to save "${key}": network error`);
    }
  }, []);

  const provider = values["tts_provider"] || "edge";
  const visibleKeys = PROVIDER_FIELDS[provider] ?? TTS_SETTINGS.map((f) => f.key);

  return (
    <div className="space-y-4">
      <JanCard
        title="Voice & Text-to-Speech"
        header={
          <div className="-mt-2 mb-4 space-y-1">
            <div className="flex items-center gap-1.5">
              <Volume2 className="h-4 w-4 text-indigo-500" />
              <p className="text-sm text-muted-foreground">
                Configure voice synthesis. Only settings for your chosen provider are shown.
                The agent synthesizes audio via the <strong>text_to_speech</strong> tool or automatic voice mirroring.
              </p>
            </div>
          </div>
        }
      >
        {saveError && (
          <div className="border-destructive/40 bg-destructive/10 text-destructive mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{saveError}</span>
          </div>
        )}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading voice settings…
          </div>
        ) : (
          <div className="divide-y divide-border">
            {TTS_SETTINGS.filter((f) => visibleKeys.includes(f.key)).map((field) => (
              <div key={field.key} className="py-4 first:pt-0 last:pb-0">
                <SettingRow
                  field={field}
                  value={values[field.key] ?? ""}
                  onChange={(v) => setValues((prev) => ({ ...prev, [field.key]: v }))}
                  onSave={(v) => handleSave(field.key, v)}
                  saveState={saveStates[field.key] ?? "idle"}
                />
              </div>
            ))}
          </div>
        )}
      </JanCard>

      <JanCard title="How Voice Replies Work"
        header={
          <div className="flex items-center gap-1.5 -mt-2 mb-3">
            <AudioLines className="h-4 w-4 text-indigo-400" />
            <span className="text-sm text-muted-foreground">Voice modes you can use in chat</span>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-muted-foreground">
          <div className="flex gap-3">
            <Mic className="h-4 w-4 mt-0.5 text-indigo-500 shrink-0" />
            <div>
              <p className="font-medium text-foreground">Voice Mirroring — Default</p>
              <p>Send a voice note → agent replies with text + audio. Use <code className="bg-muted px-1 rounded text-xs">/voice-on</code> in chat.</p>
            </div>
          </div>
          <div className="flex gap-3">
            <Volume2 className="h-4 w-4 mt-0.5 text-violet-500 shrink-0" />
            <div>
              <p className="font-medium text-foreground">Always Speak — <code className="bg-muted px-1 rounded text-xs">/voice-tts</code></p>
              <p>Every reply (text or voice) gets an audio version too.</p>
            </div>
          </div>
          <div className="flex gap-3">
            <Settings2 className="h-4 w-4 mt-0.5 text-rose-400 shrink-0" />
            <div>
              <p className="font-medium text-foreground">Explicit Request</p>
              <p>Ask the agent to &quot;read this aloud&quot; and it calls <strong>text_to_speech</strong> directly.</p>
            </div>
          </div>
          <div className="flex gap-3">
            <Volume2 className="h-4 w-4 mt-0.5 opacity-40 shrink-0" />
            <div>
              <p className="font-medium text-foreground">Off — <code className="bg-muted px-1 rounded text-xs">/voice-off</code></p>
              <p>Disables all automatic audio replies. Text only.</p>
            </div>
          </div>
        </div>
      </JanCard>
    </div>
  );
}

