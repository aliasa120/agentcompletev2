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
    "ninerouter": {
        "base_url_env": "NINE_ROUTER_URL",
        "base_url_default": "http://localhost:20128/v1",
        "env_key": "NINE_ROUTER_API_KEY",
        "label": "9Router AI Gateway",
        "openai_compat": True,
        "badge_color": "from-cyan-500 to-blue-600",
        "default_models": [
            {"value": "kr/claude-sonnet-4.5", "label": "Claude Sonnet 4.5 (Kiro)", "badge": "Free"},
            {"value": "oc/auto",              "label": "OpenCode Auto",           "badge": "Free"},
            {"value": "cc/claude-opus-4-7",   "label": "Claude Opus 4.7 (Sub)",   "badge": "Subscription"},
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
