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
    label: str
    openai_compat: bool
    default_models: list[dict[str, str]]
    badge_color: str


# ── Core Registry ──────────────────────────────────────────────────────────────
# Order determines the display order in the UI.

PROVIDER_REGISTRY: dict[str, ProviderConfig] = {
    "vercel": {
        "base_url": "https://ai-gateway.vercel.sh/v1",
        "env_key": "AI_GATEWAY_API_KEY",
        "label": "Vercel AI Gateway",
        "openai_compat": True,
        "badge_color": "from-blue-500 to-indigo-600",
        "default_models": [
            {"value": "xiaomi/mimo-v2.5-pro",        "label": "Mimo v2.5 Pro",       "badge": "Recommended"},
            {"value": "moonshotai/kimi-k2.5",         "label": "Kimi K2.5",           "badge": "Vision"},
            {"value": "minimax/minimax-m2.7",          "label": "MiniMax M2.7",        "badge": "Fast"},
            {"value": "openai/gpt-4o",                 "label": "GPT-4o",              "badge": "OpenAI"},
            {"value": "google/gemini-2.5-flash",       "label": "Gemini 2.5 Flash",    "badge": "Google"},
            {"value": "anthropic/claude-sonnet-4-5",  "label": "Claude Sonnet 4.5",   "badge": "Anthropic"},
        ],
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "env_key": "OPENAI_API_KEY",
        "label": "OpenAI",
        "openai_compat": True,
        "badge_color": "from-green-500 to-emerald-600",
        "default_models": [
            {"value": "gpt-4.1",         "label": "GPT-4.1",           "badge": "Latest"},
            {"value": "gpt-4o",          "label": "GPT-4o",            "badge": "Vision"},
            {"value": "gpt-4o-mini",     "label": "GPT-4o Mini",       "badge": "Fast"},
            {"value": "o3",              "label": "o3",                "badge": "Reasoning"},
            {"value": "o4-mini",         "label": "o4-mini",           "badge": "Reasoning"},
        ],
    },
    "anthropic": {
        "base_url": "https://api.anthropic.com/v1",
        "env_key": "ANTHROPIC_API_KEY",
        "label": "Anthropic",
        "openai_compat": True,  # via OpenAI-compat proxy; direct use needs langchain-anthropic
        "badge_color": "from-orange-500 to-amber-600",
        "default_models": [
            {"value": "claude-opus-4-5",       "label": "Claude Opus 4.5",     "badge": "Most Capable"},
            {"value": "claude-sonnet-4-5",     "label": "Claude Sonnet 4.5",   "badge": "Balanced"},
            {"value": "claude-haiku-3-5",      "label": "Claude Haiku 3.5",    "badge": "Fast"},
        ],
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "env_key": "OPENROUTER_API_KEY",
        "label": "OpenRouter",
        "openai_compat": True,
        "badge_color": "from-violet-500 to-purple-600",
        "default_models": [
            {"value": "google/gemini-2.5-flash",              "label": "Gemini 2.5 Flash",       "badge": "Google"},
            {"value": "meta-llama/llama-4-maverick",          "label": "Llama 4 Maverick",       "badge": "Meta"},
            {"value": "deepseek/deepseek-r2",                 "label": "DeepSeek R2",            "badge": "Reasoning"},
            {"value": "anthropic/claude-sonnet-4-5",         "label": "Claude Sonnet 4.5",      "badge": "Anthropic"},
            {"value": "openai/gpt-4o",                        "label": "GPT-4o",                 "badge": "OpenAI"},
            {"value": "mistralai/mistral-large",              "label": "Mistral Large",          "badge": "Mistral"},
        ],
    },
    "litellm": {
        "base_url_env": "LITELLM_BASE_URL",
        "base_url_default": "http://47.82.164.26:4000",
        "env_key": "LITELLM_API_KEY",
        "label": "LiteLLM Proxy",
        "openai_compat": True,
        "badge_color": "from-purple-500 to-pink-600",
        "default_models": [
            {"value": "mimo-v2.5-pro",         "label": "Mimo v2.5 Pro",    "badge": "LiteLLM"},
            {"value": "openai/gpt-oss-120b",   "label": "GPT OSS 120B",     "badge": "LiteLLM"},
        ],
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "env_key": "GROQ_API_KEY",
        "label": "Groq",
        "openai_compat": True,
        "badge_color": "from-rose-500 to-red-600",
        "default_models": [
            {"value": "llama-3.3-70b-versatile",   "label": "Llama 3.3 70B",     "badge": "Fast"},
            {"value": "llama-3.1-8b-instant",      "label": "Llama 3.1 8B",      "badge": "Ultra-Fast"},
            {"value": "gemma2-9b-it",              "label": "Gemma 2 9B",        "badge": "Google"},
            {"value": "deepseek-r1-distill-llama-70b", "label": "DeepSeek R1 70B", "badge": "Reasoning"},
        ],
    },
    "together": {
        "base_url": "https://api.together.xyz/v1",
        "env_key": "TOGETHER_API_KEY",
        "label": "Together AI",
        "openai_compat": True,
        "badge_color": "from-teal-500 to-cyan-600",
        "default_models": [
            {"value": "meta-llama/Llama-3.3-70B-Instruct-Turbo",  "label": "Llama 3.3 70B Turbo",   "badge": "Fast"},
            {"value": "deepseek-ai/DeepSeek-R1",                  "label": "DeepSeek R1",            "badge": "Reasoning"},
            {"value": "Qwen/Qwen2.5-72B-Instruct-Turbo",          "label": "Qwen 2.5 72B",          "badge": "Qwen"},
            {"value": "mistralai/Mistral-7B-Instruct-v0.3",       "label": "Mistral 7B",             "badge": "Efficient"},
        ],
    },
    "nvidia": {
        # NVIDIA NIM — OpenAI-compatible inference API.
        # NOTE: NIM sometimes emits empty-choices SSE chunks; the provider_engine
        # and agent's astream() already guard against these (check choices before
        # reading delta.content).
        "base_url": "https://integrate.api.nvidia.com/v1",
        "env_key": "NVIDIA_API_KEY",
        "label": "NVIDIA NIM",
        "openai_compat": True,
        "badge_color": "from-green-600 to-lime-500",
        "default_models": [
            {"value": "minimaxai/minimax-m2.7",      "label": "MiniMax M2.7",        "badge": "Recommended"},
            {"value": "stepfun-ai/step-3.7-flash",    "label": "Step 3.7 Flash",      "badge": "Fast"},
            {"value": "openai/gpt-oss-120b",           "label": "GPT OSS 120B",        "badge": "Large"},
            {"value": "deepseek-ai/deepseek-v4-flash", "label": "DeepSeek V4 Flash",   "badge": "Reasoning"},
        ],
    },
    "mimo": {
        # Xiaomi MiMo — OpenAI-compatible chat API.
        # Endpoint: https://api.xiaomimimo.com/v1/chat/completions
        # Auth: Authorization: Bearer $MIMO_API_KEY
        # Docs: https://platform.xiaomimimo.com/docs/en-US/api/chat/openai-api
        "base_url": "https://api.xiaomimimo.com/v1",
        "env_key": "MIMO_API_KEY",
        "label": "Xiaomi MiMo",
        "openai_compat": True,
        "badge_color": "from-orange-400 to-red-500",
        "default_models": [
            {"value": "mimo-v2.5-pro", "label": "MiMo V2.5 Pro", "badge": "Flagship"},
            {"value": "mimo-v2.5",     "label": "MiMo V2.5",     "badge": "Fast"},
        ],
    },
    "novita": {
        # Novita AI — OpenAI-compatible inference API.
        # Endpoint: https://api.novita.ai/openai/v1
        # Auth: Authorization: Bearer $NOVITA_API_KEY
        # Docs: https://novita.ai/docs
        "base_url": "https://api.novita.ai/openai/v1",
        "env_key": "NOVITA_API_KEY",
        "label": "Novita AI",
        "openai_compat": True,
        "badge_color": "from-cyan-500 to-blue-600",
        "default_models": [
            {"value": "deepseek/deepseek-v4-flash",            "label": "DeepSeek V4 Flash",    "badge": "Recommended"},
            {"value": "deepseek/deepseek-r2",                  "label": "DeepSeek R2",           "badge": "Reasoning"},
            {"value": "meta-llama/llama-4-maverick",           "label": "Llama 4 Maverick",      "badge": "Meta"},
            {"value": "meta-llama/llama-3.3-70b-instruct",    "label": "Llama 3.3 70B",         "badge": "Fast"},
            {"value": "qwen/qwen3-235b-a22b",                  "label": "Qwen3 235B",            "badge": "Large"},
            {"value": "google/gemma-3-27b-it",                 "label": "Gemma 3 27B",           "badge": "Google"},
        ],
    },
    "opencode": {
        "base_url": "https://opencode.ai/zen/v1",
        "env_key": "OPENCODE_API_KEY",
        "label": "OpenCode AI",
        "openai_compat": True,
        "badge_color": "from-violet-600 to-indigo-700",
        "default_models": [
            {"value": "minimax-m3-free",       "label": "MiniMax M3 Free",       "badge": "MiniMax"},
            {"value": "mimo-v2.5-free",        "label": "MiMo V2.5 Free",        "badge": "Xiaomi"},
            {"value": "north-mini-code-free",  "label": "North Mini Code Free",  "badge": "Stealth"},
            {"value": "nemotron-3-ultra-free", "label": "Nemotron 3 Ultra Free", "badge": "NVIDIA"},
            {"value": "deepseek-v4-flash-free", "label": "DeepSeek V4 Flash Free", "badge": "DeepSeek"},
            {"value": "qwen3.6-plus",          "label": "Qwen3.6 Plus Free",     "badge": "Qwen"},
        ],
    },
}


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
