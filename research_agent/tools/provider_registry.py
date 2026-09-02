"""Enterprise LLM Provider Registry.

Single source of truth for every AI provider this system supports.
To add a new provider at the enterprise level:
  1. Add an entry to PROVIDER_REGISTRY below.
  2. Add the env var (e.g. MY_PROVIDER_API_KEY=sk-xxx) to .env.
  3. No other code changes needed — provider_engine and the UI auto-discover it.

Provider schema:
  base_url      : Direct endpoint URL (string, optional if base_url_env is set).
  base_url_env  : Env var that overrides base_url at runtime (used for LiteLLM).
  base_url_default: Fallback when base_url_env is not set (used for LiteLLM).
  env_key       : Name of the env var holding the API key.
  label         : Human-readable name shown in the UI.
  openai_compat : True → use ChatOpenAI-compatible client (all of these are True).
  default_models: Ordered list of models the UI pre-populates for this provider.
  badge_color   : Tailwind gradient hint for the UI card (optional, cosmetic).
"""

from __future__ import annotations

from typing import TypedDict


class ProviderConfig(TypedDict, total=False):
    base_url: str
    base_url_env: str
    base_url_default: str
    env_key: str
    agent_settings_key: str
    label: str
    openai_compat: bool
    default_models: list[dict[str, str]]
    badge_color: str


# ── Core Registry ──────────────────────────────────────────────────────────────
# Order determines the display order in the UI. 10 major OpenAI-compatible providers.

PROVIDER_REGISTRY: dict[str, ProviderConfig] = {
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "env_key": "OPENROUTER_API_KEY",
        "agent_settings_key": "openrouter_client_api_key",
        "label": "OpenRouter AI Gateway",
        "openai_compat": True,
        "badge_color": "from-violet-500 to-purple-600",
        "default_models": [
            {"value": "google/gemini-2.5-flash",        "label": "Gemini 2.5 Flash",        "badge": "Vision"},
            {"value": "anthropic/claude-3.7-sonnet",     "label": "Claude 3.7 Sonnet",       "badge": "Vision"},
            {"value": "deepseek/deepseek-r1",            "label": "DeepSeek R1",             "badge": "Reasoning"},
            {"value": "meta-llama/llama-3.3-70b-instruct", "label": "Llama 3.3 70B",        "badge": "Fast"},
        ],
    },
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "env_key": "GEMINI_API_KEY",
        "agent_settings_key": "gemini_client_api_key",
        "label": "Gemini (Direct API)",
        "openai_compat": True,
        "badge_color": "from-blue-500 to-indigo-600",
        "default_models": [
            {"value": "gemini-2.5-flash", "label": "Gemini 2.5 Flash", "badge": "Vision"},
            {"value": "gemini-2.5-pro",   "label": "Gemini 2.5 Pro",   "badge": "Vision"},
            {"value": "gemini-2.0-flash", "label": "Gemini 2.0 Flash", "badge": "Vision"},
        ],
    },
    "grok": {
        "base_url": "https://api.x.ai/v1",
        "env_key": "XAI_API_KEY",
        "agent_settings_key": "grok_client_api_key",
        "label": "xAI (Grok)",
        "openai_compat": True,
        "badge_color": "from-zinc-700 to-neutral-900",
        "default_models": [
            {"value": "grok-2-vision-1212", "label": "Grok 2 Vision", "badge": "Vision"},
            {"value": "grok-2-latest",      "label": "Grok 2 Latest", "badge": "Direct"},
            {"value": "grok-beta",          "label": "Grok Beta",     "badge": "Direct"},
        ],
    },
    "together": {
        "base_url": "https://api.together.xyz/v1",
        "env_key": "TOGETHER_API_KEY",
        "agent_settings_key": "together_client_api_key",
        "label": "Together AI (Meta Llama)",
        "openai_compat": True,
        "badge_color": "from-blue-600 to-cyan-600",
        "default_models": [
            {"value": "meta-llama/Llama-3.2-11B-Vision-Instruct",     "label": "Llama 3.2 11B Vision", "badge": "Vision"},
            {"value": "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo", "label": "Llama 3.1 70B Turbo",  "badge": "Direct"},
            {"value": "deepseek-ai/DeepSeek-R1",                      "label": "DeepSeek R1",          "badge": "Reasoning"},
            {"value": "Qwen/Qwen2.5-72B-Instruct-Turbo",              "label": "Qwen 2.5 72B Turbo",   "badge": "Direct"},
        ],
    },
    "cerebras": {
        "base_url": "https://api.cerebras.ai/v1",
        "env_key": "CEREBRAS_API_KEY",
        "agent_settings_key": "cerebras_client_api_key",
        "label": "Cerebras (Ultra-Fast)",
        "openai_compat": True,
        "badge_color": "from-emerald-500 to-teal-600",
        "default_models": [
            {"value": "llama3.1-70b", "label": "Llama 3.1 70B (Fastest)", "badge": "UltraFast"},
            {"value": "llama3.1-8b",  "label": "Llama 3.1 8B",            "badge": "UltraFast"},
            {"value": "llama-3.3-70b","label": "Llama 3.3 70B",           "badge": "UltraFast"},
        ],
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "env_key": "GROQ_API_KEY",
        "agent_settings_key": "groq_client_api_key",
        "label": "Groq (LPU Inference)",
        "openai_compat": True,
        "badge_color": "from-orange-500 to-amber-600",
        "default_models": [
            {"value": "llama-3.3-70b-versatile",           "label": "Llama 3.3 70B Versatile",  "badge": "Fast"},
            {"value": "llama-3.2-11b-vision-preview",       "label": "Llama 3.2 11B Vision",     "badge": "Vision"},
            {"value": "deepseek-r1-distill-llama-70b",      "label": "DeepSeek R1 Distill 70B",  "badge": "Reasoning"},
        ],
    },
    "deepseek": {
        "base_url": "https://api.deepseek.com/v1",
        "env_key": "DEEPSEEK_API_KEY",
        "agent_settings_key": "deepseek_client_api_key",
        "label": "DeepSeek (Direct API)",
        "openai_compat": True,
        "badge_color": "from-sky-500 to-blue-700",
        "default_models": [
            {"value": "deepseek-chat",     "label": "DeepSeek V3 (Chat)",     "badge": "Direct"},
            {"value": "deepseek-reasoner", "label": "DeepSeek R1 (Reasoner)", "badge": "Reasoning"},
        ],
    },
    "mistral": {
        "base_url": "https://api.mistral.ai/v1",
        "env_key": "MISTRAL_API_KEY",
        "agent_settings_key": "mistral_client_api_key",
        "label": "Mistral AI",
        "openai_compat": True,
        "badge_color": "from-amber-500 to-orange-700",
        "default_models": [
            {"value": "mistral-large-latest", "label": "Mistral Large", "badge": "Direct"},
            {"value": "pixtral-large-latest", "label": "Pixtral Large", "badge": "Vision"},
            {"value": "codestral-latest",     "label": "Codestral",     "badge": "Code"},
        ],
    },
    "fireworks": {
        "base_url": "https://api.fireworks.ai/inference/v1",
        "env_key": "FIREWORKS_API_KEY",
        "agent_settings_key": "fireworks_client_api_key",
        "label": "Fireworks AI",
        "openai_compat": True,
        "badge_color": "from-rose-500 to-red-600",
        "default_models": [
            {"value": "accounts/fireworks/models/llama-v3p3-70b-instruct",       "label": "Llama 3.3 70B",       "badge": "Direct"},
            {"value": "accounts/fireworks/models/llama-v3p2-11b-vision-instruct", "label": "Llama 3.2 11B Vision", "badge": "Vision"},
            {"value": "accounts/fireworks/models/deepseek-r1",                    "label": "DeepSeek R1",          "badge": "Reasoning"},
        ],
    },
    "ollama": {
        "base_url": "http://localhost:11434/v1",
        "base_url_env": "OLLAMA_BASE_URL",
        "base_url_default": "http://localhost:11434/v1",
        "env_key": "OLLAMA_API_KEY",
        "agent_settings_key": "ollama_client_api_key",
        "label": "Ollama (Self-Hosted)",
        "openai_compat": True,
        "badge_color": "from-slate-600 to-zinc-800",
        "default_models": [
            {"value": "llama3.2-vision:latest", "label": "Llama 3.2 Vision (Local)", "badge": "LocalVision"},
            {"value": "qwen2.5:latest",         "label": "Qwen 2.5 (Local)",         "badge": "Local"},
            {"value": "deepseek-r1:latest",     "label": "DeepSeek R1 (Local)",     "badge": "Local"},
        ],
    },
}


KEY_MAPPINGS: dict[str, str] = {name: cfg["env_key"] for name, cfg in PROVIDER_REGISTRY.items()}


# ── Helpers ────────────────────────────────────────────────────────────────────

def get_provider_config(provider_name: str) -> ProviderConfig | None:
    """Return the config dict for a named provider, or None if unknown."""
    return PROVIDER_REGISTRY.get(provider_name.strip().lower())


def get_all_provider_names() -> list[str]:
    """Return ordered list of all registered provider identifiers."""
    return list(PROVIDER_REGISTRY.keys())


def get_provider_base_url(provider_name: str) -> str:
    """Resolve the base URL for a provider (handles env-override for LiteLLM etc.)."""
    import os
    cfg = get_provider_config(provider_name)
    if cfg is None:
        raise ValueError(f"Unknown provider '{provider_name}'. "
                         f"Valid providers: {get_all_provider_names()}")

    if "base_url_env" in cfg:
        return (
            os.environ.get(cfg["base_url_env"], "").rstrip("/")
            or cfg.get("base_url_default", "").rstrip("/")
        )
    return cfg.get("base_url", "").rstrip("/")


def get_provider_api_key(provider_name: str) -> str:
    """Resolve the API key for a provider from env vars (never from DB)."""
    import os
    cfg = get_provider_config(provider_name)
    if cfg is None:
        raise ValueError(f"Unknown provider '{provider_name}'.")
    return os.environ.get(cfg["env_key"], "")


def is_provider_key_set(provider_name: str) -> bool:
    """Return True if the provider's API key env var is set and non-empty."""
    return bool(get_provider_api_key(provider_name))


def get_provider_status() -> dict[str, bool]:
    """Return {provider_name: has_key_set} for all registered providers.

    Used by the /api/provider-status endpoint.
    Never returns key values — only booleans.
    """
    return {name: is_provider_key_set(name) for name in PROVIDER_REGISTRY}


def get_ui_registry() -> list[dict]:
    """Return a serializable list of provider metadata for the frontend.

    Includes labels, colors, and model lists — but NOT env var names or key values.
    """
    result = []
    for name, cfg in PROVIDER_REGISTRY.items():
        result.append({
            "id": name,
            "label": cfg.get("label", name),
            "badge_color": cfg.get("badge_color", "from-gray-500 to-gray-600"),
            "default_models": cfg.get("default_models", []),
            "key_set": is_provider_key_set(name),
        })
    return result
