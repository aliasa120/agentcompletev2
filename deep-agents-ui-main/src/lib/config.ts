export interface StandaloneConfig {
  deploymentUrl: string;
  assistantId: string;
  langsmithApiKey?: string;
}

const CONFIG_KEY = "deep-agent-config";

export function getConfig(): StandaloneConfig {
  const defaults: StandaloneConfig = {
    deploymentUrl:
      process.env.NEXT_PUBLIC_LANGGRAPH_API_URL ||
      process.env.LANGGRAPH_API_URL ||
      "http://localhost:2024",
    assistantId: process.env.NEXT_PUBLIC_ASSISTANT_ID || "research",
    langsmithApiKey: process.env.NEXT_PUBLIC_LANGSMITH_API_KEY || "",
  };

  if (typeof window === "undefined") {
    return defaults;
  }

  const stored = localStorage.getItem(CONFIG_KEY);
  if (!stored) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(stored);
    return {
      deploymentUrl: parsed.deploymentUrl || defaults.deploymentUrl,
      assistantId: parsed.assistantId || defaults.assistantId,
      langsmithApiKey: parsed.langsmithApiKey || defaults.langsmithApiKey,
    };
  } catch {
    return defaults;
  }
}

export function saveConfig(config: StandaloneConfig): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}
