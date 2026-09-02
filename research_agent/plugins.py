"""Plugin registry — groups optional feature tools under toggleable plugins.

Each plugin owns a set of agent-facing tools. A tool that belongs to a plugin
is only available to agents (and to the dynamic tool router) while that plugin
is enabled. Plugins without owned tools (e.g. "feeder") act purely as
feature/settings gates.

The plugin catalog lives in the ``plugins`` table and per-user enablement in
``user_plugin_settings``. The ``PLUGIN_TOOLS`` mapping below mirrors the seeded
``tool_keys`` column and serves as a fallback when the DB is unreachable.
"""

import os
from typing import Dict, List, Optional, Set

# Canonical plugin -> owned tools mapping. Keep in sync with the seeded rows in
# the ``plugins`` table (tool_keys column).
PLUGIN_TOOLS: Dict[str, List[str]] = {
    "posts": [
        "save_wordpress_post",
        "save_instagram_post",
        "save_facebook_post",
        "save_youtube_video",
        "save_social_bundle",
        "get_wordpress_categories",
        "publish_to_wordpress",
    ],
    "feeder": [],
}

# Reverse lookup: tool_key -> owning plugin_key (None means core tool).
TOOL_PLUGIN: Dict[str, str] = {
    tool_key: plugin_key
    for plugin_key, tool_keys in PLUGIN_TOOLS.items()
    for tool_key in tool_keys
}


def plugin_for_tool(tool_key: str) -> Optional[str]:
    """Return the plugin owning ``tool_key``, or None for core tools."""
    return TOOL_PLUGIN.get(tool_key)


def is_tool_allowed(tool_key: str, enabled_plugins: Set[str]) -> bool:
    """True if ``tool_key`` is a core tool or its owning plugin is enabled."""
    owner = TOOL_PLUGIN.get(tool_key)
    return owner is None or owner in enabled_plugins


def resolve_enabled_plugins(
    plugins: Optional[List[dict]] = None,
    user_plugin_settings: Optional[List[dict]] = None,
) -> Set[str]:
    """Compute the set of enabled plugin keys.

    Args:
        plugins: rows from the ``plugins`` table (with plugin_key,
            default_enabled, and optionally tool_keys).
        user_plugin_settings: rows from ``user_plugin_settings`` (plugin_key,
            enabled).

    Agents are compiled globally (not per user), so a plugin counts as enabled
    if any user enabled it, or — when no user has expressed a preference — if
    its catalog default is enabled.
    """
    if plugins is None and user_plugin_settings is None:
        # No catalog available (e.g. DB offline) — keep current behaviour by
        # treating all known plugins as enabled.
        return set(PLUGIN_TOOLS)

    enabled_overrides: Set[str] = set()
    disabled_overrides: Set[str] = set()
    for row in user_plugin_settings or []:
        key = row.get("plugin_key")
        if not key:
            continue
        if row.get("enabled"):
            enabled_overrides.add(key)
        else:
            disabled_overrides.add(key)

    enabled: Set[str] = set()
    catalog_keys: Set[str] = set()
    for plugin in plugins or []:
        key = plugin.get("plugin_key")
        if not key:
            continue
        catalog_keys.add(key)
        if key in enabled_overrides:
            enabled.add(key)
        elif key in disabled_overrides:
            continue
        elif plugin.get("default_enabled", True):
            enabled.add(key)

    if not catalog_keys:
        # Catalog missing but overrides present: fall back to known defaults
        # minus explicitly disabled ones.
        enabled = (set(PLUGIN_TOOLS) - disabled_overrides) | enabled_overrides

    return enabled


def enabled_plugins_from_bootstrap(bootstrap: Optional[dict]) -> Set[str]:
    """Resolve enabled plugins from a ``get_backend_bootstrap_data()`` payload."""
    bootstrap = bootstrap or {}
    return resolve_enabled_plugins(
        bootstrap.get("plugins"),
        bootstrap.get("user_plugin_settings"),
    )


def enabled_plugins_from_db() -> Set[str]:
    """Fetch the enabled plugin set directly from Supabase.

    Falls back to "all plugins enabled" when the database is unreachable, so
    callers degrade to the legacy (always-available) behaviour.
    """
    try:
        from supabase import create_client

        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = (
            os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
            or os.environ.get("SUPABASE_ANON_KEY", "")
        )
        if not url or not key:
            return set(PLUGIN_TOOLS)
        client = create_client(url, key)
        bootstrap = client.rpc("get_backend_bootstrap_data").execute().data or {}
        return enabled_plugins_from_bootstrap(bootstrap)
    except Exception:
        return set(PLUGIN_TOOLS)
