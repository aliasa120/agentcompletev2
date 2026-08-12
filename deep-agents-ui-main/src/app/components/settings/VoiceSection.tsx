"use client";

/**
 * VoiceSection - Voice and Text-to-Speech settings sub-page.
 * Supports segregated settings for:
 *   1. Voice Generation Tool (text_to_speech tool)
 *   2. Slash Voice Commands & Auto Voice Replies (voice mirroring / /voice-*)
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Volume2, Eye, EyeOff, CheckCircle2, Loader2, AlertCircle,
  ExternalLink, ChevronDown, Mic, AudioLines, Settings2, Sparkles, Wrench, Play
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

function createFieldGroup(prefix: string, titlePrefix: string): SettingField[] {
  const p = prefix ? `${prefix}_` : "";
  return [
    {
      key: `${p}tts_provider`,
      label: `${titlePrefix} TTS Provider`,
      placeholder: "elevenlabs",
      type: "text",
      options: [
        { value: "elevenlabs", label: "ElevenLabs (best quality, multilingual)" },
        { value: "edge",       label: "Edge TTS (free, no API key needed)" },
        { value: "openai",     label: "OpenAI (gpt-4o-mini-tts)" },
        { value: "mimo",       label: "Xiaomi MiMo-V2.5-TTS (Expressive Style & Accent Control)" },
      ],
      description: `Select the text-to-speech engine for ${titlePrefix.toLowerCase()}.`,
    },
    {
      key: `${p}elevenlabs_api_key`,
      label: "ElevenLabs API Key",
      placeholder: "sk_...",
      type: "password",
      helpUrl: "https://elevenlabs.io/app/settings/api-keys",
      description: "Required when TTS Provider is ElevenLabs.",
    },
    {
      key: `${p}tts_voice_id`,
      label: "ElevenLabs Voice ID",
      placeholder: "pNInz6obpgDQGcFmaJgB (Adam)",
      type: "text",
      helpUrl: "https://elevenlabs.io/app/voice-library",
      description: "Voice ID from your ElevenLabs voice library (e.g. pNInz6obpgDQGcFmaJgB for Adam, 21m00Tcm4TlvDq8ikWAM for Rachel).",
    },
    {
      key: `${p}tts_model_id`,
      label: "ElevenLabs Model ID",
      placeholder: "eleven_multilingual_v2",
      type: "text",
      options: [
        { value: "eleven_multilingual_v2", label: "eleven_multilingual_v2 (Recommended - Multilingual)" },
        { value: "eleven_turbo_v2_5",       label: "eleven_turbo_v2_5 (Low Latency)" },
        { value: "eleven_flash_v2_5",       label: "eleven_flash_v2_5 (Ultra Fast)" },
        { value: "eleven_monolingual_v1",    label: "eleven_monolingual_v1 (English Standard)" },
      ],
      description: "Select a valid ElevenLabs model ID.",
    },
    {
      key: `${p}edge_tts_voice`,
      label: "Edge TTS Voice",
      placeholder: "en-US-AriaNeural",
      type: "text",
      description: "Voice name for Edge TTS (free, no key needed).",
    },
    {
      key: `${p}openai_api_key`,
      label: "OpenAI API Key (for TTS)",
      placeholder: "sk-proj-...",
      type: "password",
      helpUrl: "https://platform.openai.com/api-keys",
      description: "Required when TTS Provider is OpenAI.",
    },
    {
      key: `${p}mimo_api_key`,
      label: "Xiaomi MiMo API Key",
      placeholder: "sk-...",
      type: "password",
      helpUrl: "https://api.xiaomimimo.com",
      description: "Required when TTS Provider is Xiaomi MiMo-V2.5-TTS.",
    },
    {
      key: `${p}mimo_model_id`,
      label: "Xiaomi MiMo Model",
      placeholder: "mimo-v2.5-tts",
      type: "text",
      options: [
        { value: "mimo-v2.5-tts",             label: "mimo-v2.5-tts (High-Quality Built-in Voices & Singing)" },
        { value: "mimo-v2.5-tts-voicedesign", label: "mimo-v2.5-tts-voicedesign (Voice Design from Prompt)" },
      ],
      description: "Select MiMo model flavor.",
    },
    {
      key: `${p}mimo_voice`,
      label: "Xiaomi MiMo Built-in Voice",
      placeholder: "Chloe",
      type: "text",
      options: [
        { value: "Chloe",        label: "Chloe (English Female)" },
        { value: "Mia",          label: "Mia (English Female)" },
        { value: "Milo",         label: "Milo (English Male)" },
        { value: "Dean",         label: "Dean (English Male)" },
        { value: "冰糖",         label: "冰糖 (Chinese Female)" },
        { value: "茉莉",         label: "茉莉 (Chinese Female)" },
        { value: "苏打",         label: "苏打 (Chinese Male)" },
        { value: "白桦",         label: "白桦 (Chinese Male)" },
        { value: "mimo_default", label: "mimo_default (Default)" },
      ],
      description: "Built-in voice for mimo-v2.5-tts model.",
    },
    {
      key: `${p}mimo_instruct`,
      label: "Xiaomi Voice Style & Accent Instructor",
      placeholder: "Heavy Russian accent, gruff male, blunt and matter-of-fact.",
      type: "text",
      description: "Natural language prompt to steer character, emotion, accent, and style (e.g. 'Bright, bouncy, podcast host' or 'Deep voice documentary narrator').",
    },
  ];
}

const TOOL_SETTINGS = createFieldGroup("tool", "Voice Tool");
const MIRROR_SETTINGS = createFieldGroup("mirror", "Voice Reply");
const GLOBAL_SETTINGS = createFieldGroup("", "Global / Default");

const ALL_FIELDS = [...TOOL_SETTINGS, ...MIRROR_SETTINGS, ...GLOBAL_SETTINGS];

function SettingRow({ field, value, onChange, onSave, saveState }: {
  field: SettingField;
  value: string;
  onChange: (v: string) => void;
  onSave: (v: string) => void;
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
              onSave(v);
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

function FieldList({ fields, values, saveStates, onChange, onSave }: {
  fields: SettingField[];
  values: Record<string, string>;
  saveStates: Record<string, SaveState>;
  onChange: (key: string, v: string) => void;
  onSave: (key: string, v: string) => void;
}) {
  const providerKey = fields.find((f) => f.key.includes("tts_provider"))?.key ?? "";
  const provider = values[providerKey] || "elevenlabs";

  const visibleFields = fields.filter((f) => {
    if (f.key.includes("tts_provider")) return true;
    if (provider === "elevenlabs") return f.key.includes("elevenlabs") || f.key.includes("voice_id") || f.key.includes("model_id");
    if (provider === "edge") return f.key.includes("edge_tts_voice");
    if (provider === "openai") return f.key.includes("openai");
    if (provider === "mimo") return f.key.includes("mimo");
    return true;
  });

  return (
    <div className="divide-y divide-border">
      {visibleFields.map((field) => (
        <div key={field.key} className="py-4 first:pt-0 last:pb-0">
          <SettingRow
            field={field}
            value={values[field.key] ?? ""}
            onChange={(v) => onChange(field.key, v)}
            onSave={(v) => onSave(field.key, v)}
            saveState={saveStates[field.key] ?? "idle"}
          />
        </div>
      ))}
    </div>
  );
}

export function VoiceSection() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // ── Voice Tester State ────────────────────────────────────────────────────────
  const [testText, setTestText] = useState("Hello! This is a live test of your text-to-speech configuration.");
  const [testingPurpose, setTestingPurpose] = useState<"tool" | "mirror" | null>(null);
  const [testResult, setTestResult] = useState<{
    audioUrl: string;
    provider: string;
    voiceId: string;
    modelId: string;
  } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const runVoiceTest = async (purpose: "tool" | "mirror") => {
    setTestingPurpose(purpose);
    setTestError(null);
    setTestResult(null);
    try {
      const res = await fetch("/api/tts-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: testText, purpose }),
      });
      const data = await res.json();
      if (res.ok && data.audioUrl) {
        setTestResult({
          audioUrl: data.audioUrl,
          provider: data.provider,
          voiceId: data.voiceId,
          modelId: data.modelId,
        });
      } else {
        setTestError(data.error || "Failed to synthesize test audio.");
      }
    } catch (e: any) {
      setTestError(e.message || "Network error while testing voice.");
    } finally {
      setTestingPurpose(null);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/agent-settings");
        if (!res.ok) return;
        const data = await res.json();
        const rows: { key: string; value: string }[] =
          Array.isArray(data) ? data :
          Array.isArray(data?.settings) ? data.settings :
          Array.isArray(data?.rows) ? data.rows :
          [];
        const loaded: Record<string, string> = {};
        for (const f of ALL_FIELDS) {
          const row = rows.find((r) => r.key === f.key);
          loaded[f.key] = row?.value ?? "";
        }

        // Inheritance fallbacks: if specific tool or mirror fields are missing in DB,
        // populate them with the saved global values so the inputs are filled immediately.
        const globalApiKey = loaded["elevenlabs_api_key"] || "";
        const globalVoiceId = loaded["tts_voice_id"] || "";
        const globalModelId = loaded["tts_model_id"] || "";
        const globalEdgeVoice = loaded["edge_tts_voice"] || "";
        const globalOpenAiKey = loaded["openai_api_key"] || "";
        const globalMimoKey = loaded["mimo_api_key"] || "";
        const globalMimoModel = loaded["mimo_model_id"] || "mimo-v2.5-tts";
        const globalMimoVoice = loaded["mimo_voice"] || "Chloe";
        const globalMimoInstruct = loaded["mimo_instruct"] || "Natural, clear, and expressive delivery.";
        const globalProvider = loaded["tts_provider"] || "elevenlabs";

        if (!loaded["tool_tts_provider"]) loaded["tool_tts_provider"] = globalProvider;
        if (!loaded["tool_elevenlabs_api_key"]) loaded["tool_elevenlabs_api_key"] = globalApiKey;
        if (!loaded["tool_tts_voice_id"]) loaded["tool_tts_voice_id"] = globalVoiceId;
        if (!loaded["tool_tts_model_id"]) loaded["tool_tts_model_id"] = globalModelId;
        if (!loaded["tool_edge_tts_voice"]) loaded["tool_edge_tts_voice"] = globalEdgeVoice;
        if (!loaded["tool_openai_api_key"]) loaded["tool_openai_api_key"] = globalOpenAiKey;
        if (!loaded["tool_mimo_api_key"]) loaded["tool_mimo_api_key"] = globalMimoKey;
        if (!loaded["tool_mimo_model_id"]) loaded["tool_mimo_model_id"] = globalMimoModel;
        if (!loaded["tool_mimo_voice"]) loaded["tool_mimo_voice"] = globalMimoVoice;
        if (!loaded["tool_mimo_instruct"]) loaded["tool_mimo_instruct"] = globalMimoInstruct;

        if (!loaded["mirror_tts_provider"]) loaded["mirror_tts_provider"] = globalProvider;
        if (!loaded["mirror_elevenlabs_api_key"]) loaded["mirror_elevenlabs_api_key"] = globalApiKey;
        if (!loaded["mirror_tts_voice_id"]) loaded["mirror_tts_voice_id"] = globalVoiceId;
        if (!loaded["mirror_tts_model_id"]) loaded["mirror_tts_model_id"] = globalModelId;
        if (!loaded["mirror_edge_tts_voice"]) loaded["mirror_edge_tts_voice"] = globalEdgeVoice;
        if (!loaded["mirror_openai_api_key"]) loaded["mirror_openai_api_key"] = globalOpenAiKey;
        if (!loaded["mirror_mimo_api_key"]) loaded["mirror_mimo_api_key"] = globalMimoKey;
        if (!loaded["mirror_mimo_model_id"]) loaded["mirror_mimo_model_id"] = globalMimoModel;
        if (!loaded["mirror_mimo_voice"]) loaded["mirror_mimo_voice"] = globalMimoVoice;
        if (!loaded["mirror_mimo_instruct"]) loaded["mirror_mimo_instruct"] = globalMimoInstruct;

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

    // Build rows to save — if saving ElevenLabs or MiMo API key, sync to all cards
    const rowsMap = new Map<string, { key: string; value: string }>();
    rowsMap.set(key, { key, value });
    if (key.includes("elevenlabs_api_key")) {
      rowsMap.set("elevenlabs_api_key", { key: "elevenlabs_api_key", value });
      rowsMap.set("tool_elevenlabs_api_key", { key: "tool_elevenlabs_api_key", value });
      rowsMap.set("mirror_elevenlabs_api_key", { key: "mirror_elevenlabs_api_key", value });
    }
    if (key.includes("mimo_api_key")) {
      rowsMap.set("mimo_api_key", { key: "mimo_api_key", value });
      rowsMap.set("tool_mimo_api_key", { key: "tool_mimo_api_key", value });
      rowsMap.set("mirror_mimo_api_key", { key: "mirror_mimo_api_key", value });
    }
    const rowsToSave = Array.from(rowsMap.values());

    try {
      const res = await fetch("/api/agent-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: rowsToSave }),
      });
      if (res.ok) {
        setSaveStates((s) => ({ ...s, [key]: "saved" }));
        setTimeout(() => setSaveStates((s) => ({ ...s, [key]: "idle" })), 2000);
        setValues((prev) => {
          const updated = { ...prev, [key]: value };
          if (key.includes("elevenlabs_api_key")) {
            updated["elevenlabs_api_key"] = value;
            updated["tool_elevenlabs_api_key"] = value;
            updated["mirror_elevenlabs_api_key"] = value;
          }
          return updated;
        });
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

  const handleFieldChange = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="space-y-6">
      {saveError && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading voice settings…
        </div>
      ) : (
        <>
          {/* Card 1: Voice Generation Tool (text_to_speech) */}
          <JanCard
            title="Voice Generation Tool (text_to_speech)"
            header={
              <div className="-mt-2 mb-4 space-y-1">
                <div className="flex items-center gap-1.5">
                  <Wrench className="h-4 w-4 text-emerald-500" />
                  <p className="text-sm text-muted-foreground">
                    Model &amp; provider settings used when the agent explicitly invokes the <strong>text_to_speech</strong> tool.
                  </p>
                </div>
              </div>
            }
          >
            <FieldList
              fields={TOOL_SETTINGS}
              values={values}
              saveStates={saveStates}
              onChange={handleFieldChange}
              onSave={handleSave}
            />
          </JanCard>

          {/* Card 2: Slash Voice Commands & Auto Voice Replies */}
          <JanCard
            title="Slash Voice Commands & Auto Replies (/voice-*)"
            header={
              <div className="-mt-2 mb-4 space-y-1">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="h-4 w-4 text-indigo-500" />
                  <p className="text-sm text-muted-foreground">
                    Model &amp; provider settings used for automatic voice responses and slash commands (<code className="bg-muted px-1 rounded text-xs">/voice-on</code>, <code className="bg-muted px-1 rounded text-xs">/voice-tts</code>).
                  </p>
                </div>
              </div>
            }
          >
            <FieldList
              fields={MIRROR_SETTINGS}
              values={values}
              saveStates={saveStates}
              onChange={handleFieldChange}
              onSave={handleSave}
            />
          </JanCard>

          {/* Card 4: Interactive Voice Tester */}
          <JanCard
            title="Interactive Voice Tester"
            header={
              <div className="-mt-2 mb-4 space-y-1">
                <div className="flex items-center gap-1.5">
                  <Play className="h-4 w-4 text-sky-500" />
                  <p className="text-sm text-muted-foreground">
                    Generate and listen to a live audio sample to test your active provider, voice, and model settings.
                  </p>
                </div>
              </div>
            }
          >
            <div className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-foreground">Sample Test Text</label>
                <Input
                  value={testText}
                  onChange={(e) => setTestText(e.target.value)}
                  placeholder="Enter test phrase to synthesize…"
                />
              </div>

              <div className="flex flex-wrap gap-3">
                <Button
                  variant="default"
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                  onClick={() => runVoiceTest("tool")}
                  disabled={testingPurpose !== null}
                >
                  {testingPurpose === "tool" ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Synthesizing Tool Voice…
                    </>
                  ) : (
                    <>
                      <Wrench className="mr-2 h-4 w-4" /> Test Voice Generation Tool
                    </>
                  )}
                </Button>

                <Button
                  variant="default"
                  className="bg-indigo-600 hover:bg-indigo-700 text-white"
                  onClick={() => runVoiceTest("mirror")}
                  disabled={testingPurpose !== null}
                >
                  {testingPurpose === "mirror" ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Synthesizing Voice Reply…
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-2 h-4 w-4" /> Test Slash Voice Commands (/voice-*)
                    </>
                  )}
                </Button>
              </div>

              {testError && (
                <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{testError}</span>
                </div>
              )}

              {testResult && (
                <div className="rounded-lg border border-border bg-card p-4 space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold uppercase px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-500 border border-indigo-500/20">
                        Provider: {testResult.provider}
                      </span>
                      {testResult.voiceId && (
                        <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
                          Voice ID: {testResult.voiceId}
                        </span>
                      )}
                      {testResult.modelId && (
                        <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
                          Model ID: {testResult.modelId}
                        </span>
                      )}
                    </div>
                  </div>
                  <audio controls src={testResult.audioUrl} autoPlay className="w-full h-10 rounded-md" />
                </div>
              )}
            </div>
          </JanCard>
        </>
      )}

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
