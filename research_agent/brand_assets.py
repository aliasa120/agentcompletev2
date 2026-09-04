"""Brand asset resolution and capability-aware routing helpers."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from supabase import create_client, ClientOptions

from research_agent.preflight import get_model_capabilities

_REPO_ROOT = Path(__file__).resolve().parents[1]

try:
    from dotenv import load_dotenv
    load_dotenv(_REPO_ROOT / ".env")
    load_dotenv(_REPO_ROOT / "deep-agents-ui-main" / ".env.local", override=False)
except Exception:
    pass

def _supabase_client():
    url = (os.environ.get("SUPABASE_URL", "") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")).rstrip("/")
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        or os.environ.get("SUPABASE_ANON_KEY", "")
        or os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY", "")
    )
    if not url or not key:
        return None
    opts = ClientOptions(postgrest_client_timeout=30, storage_client_timeout=30)
    return create_client(url, key, options=opts)

def get_agent_brand_assets(agent_id: str) -> List[Dict[str, Any]]:
    """Return assets attached directly or through folders to an agent."""
    client = _supabase_client()
    if not client or not agent_id:
        return []

    assets: List[Dict[str, Any]] = []
    seen: set[str] = set()

    try:
        direct = client.table("agent_design_assets").select("design_assets(*)").eq("agent_id", agent_id).execute()
        for row in direct.data or []:
            asset = row.get("design_assets")
            if asset and asset.get("id") not in seen:
                seen.add(asset["id"])
                assets.append(asset)
    except Exception:
        pass

    try:
        folders = client.table("agent_design_folders").select("folder_id").eq("agent_id", agent_id).execute()
        folder_ids = [row.get("folder_id") for row in folders.data or [] if row.get("folder_id")]
        for folder_id in folder_ids:
            resp = client.table("design_assets").select("*").eq("folder_id", folder_id).execute()
            for asset in resp.data or []:
                if asset.get("id") not in seen:
                    seen.add(asset["id"])
                    assets.append(asset)
    except Exception:
        pass

    return assets

def get_agent_model_config(agent_id: str) -> Tuple[str, str]:
    """Return (provider, model) for an agent, or sensible defaults."""
    client = _supabase_client()
    if not client or not agent_id:
        return ("openrouter", "google/gemini-2.5-flash")
    try:
        resp = client.table("agent_configs").select("provider,model").eq("id", agent_id).single().execute()
        if resp.data:
            return (resp.data.get("provider") or "openrouter", resp.data.get("model") or "google/gemini-2.5-flash")
    except Exception:
        pass
    return ("openrouter", "google/gemini-2.5-flash")

def get_agent_capabilities(agent_id: str, user_id: Optional[str] = None) -> Dict[str, bool]:
    provider, model = get_agent_model_config(agent_id)
    return get_model_capabilities(provider, model, user_id=user_id)

def _asset_media_type(asset: Dict[str, Any]) -> str:
    media_type = (asset.get("media_type") or "").lower()
    if media_type:
        return media_type
    mime = (asset.get("mime_type") or "").lower()
    if mime.startswith("image/"):
        return "image"
    if mime.startswith("video/"):
        return "video"
    if mime.startswith("audio/"):
        return "audio"
    if mime == "application/pdf" or mime.endswith("pdf"):
        return "document"
    return "image"

def _asset_url(asset: Dict[str, Any]) -> str:
    public_url = asset.get("public_url")
    if public_url:
        return public_url
    file_path = asset.get("file_path") or ""
    if file_path:
        return str((_REPO_ROOT / "reference images" / Path(file_path).name).resolve())
    return ""

def asset_supports_direct_context(asset: Dict[str, Any], caps: Dict[str, bool]) -> bool:
    media_type = _asset_media_type(asset)
    if media_type == "image":
        return bool(caps.get("vision"))
    if media_type == "video":
        return bool(caps.get("videoInput"))
    if media_type == "audio":
        return bool(caps.get("audioInput"))
    if media_type == "document":
        return bool(caps.get("pdf"))
    return False

def resolve_selected_assets(file_sources: Iterable[str], agent_assets: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Match user-provided source names to attached brand assets."""
    selected: List[Dict[str, Any]] = []
    missing: List[str] = []

    normalized_assets = []
    for asset in agent_assets:
        url = _asset_url(asset)
        normalized_assets.append({
            **asset,
            "resolved_media_type": _asset_media_type(asset),
            "resolved_url": url,
            "normalized_keys": {
                (asset.get("asset_key") or "").lower(),
                (asset.get("label") or "").lower(),
                Path(asset.get("file_path") or "").name.lower(),
                Path(url).name.lower() if url else "",
            },
        })

    for source in file_sources:
        source_clean = (source or "").strip()
        if not source_clean:
            continue
        source_lower = source_clean.lower()
        matched = None
        for asset in normalized_assets:
            keys = asset["normalized_keys"]
            if source_lower in keys or source_lower == asset["resolved_url"].lower():
                matched = asset
                break
        if matched is None:
            missing.append(source_clean)
        else:
            selected.append(matched)

    return selected, missing

def build_direct_context_payload(query: str, assets: List[Dict[str, Any]]) -> str:
    payload = {
        "query": query,
        "assets": [
            {
                "asset_key": asset.get("asset_key", ""),
                "label": asset.get("label", ""),
                "media_type": asset.get("resolved_media_type", "image"),
                "mime_type": asset.get("mime_type", ""),
                "url": asset.get("resolved_url", ""),
            }
            for asset in assets
        ],
    }
    return "BRAND_ASSET_DIRECT_CONTEXT:" + json.dumps(payload, ensure_ascii=False)

def parse_direct_context_payload(tool_result: str) -> Optional[Dict[str, Any]]:
    marker = "BRAND_ASSET_DIRECT_CONTEXT:"
    idx = tool_result.find(marker)
    if idx < 0:
        return None
    raw = tool_result[idx + len(marker):].strip()
    try:
        return json.loads(raw)
    except Exception:
        return None

def build_agent_catalog(agent_id: str, max_assets_per_folder: int = 20) -> str:
    """Build a compact catalog of folders and assets attached to an agent."""
    client = _supabase_client()
    if not client or not agent_id:
        return ""

    lines: List[str] = []
    folders = []
    try:
        folder_rows = client.table("agent_design_folders").select("folder_id, design_folders(*)").eq("agent_id", agent_id).execute()
        for row in folder_rows.data or []:
            f = row.get("design_folders")
            if f:
                folders.append(f)
            elif row.get("folder_id"):
                f_resp = client.table("design_folders").select("*").eq("id", row["folder_id"]).single().execute()
                if f_resp.data:
                    folders.append(f_resp.data)
    except Exception:
        folders = []

    if folders:
        lines.append("Attached Brand Asset Folders:")
        for folder in folders:
            folder_id = folder.get("id")
            name = folder.get("name", "Untitled folder")
            description = folder.get("description") or ""
            try:
                asset_rows = client.table("design_assets").select("asset_key,label,media_type,mime_type").eq("folder_id", folder_id).limit(max_assets_per_folder).execute()
                assets = asset_rows.data or []
            except Exception:
                assets = []
            counts: Dict[str, int] = {}
            for asset in assets:
                media_type = (asset.get("media_type") or "image").lower()
                counts[media_type] = counts.get(media_type, 0) + 1
            summary = ", ".join(f"{count} {media_type}" for media_type, count in counts.items()) or "empty"
            lines.append(f"- Folder: '{name}' ({summary})" + (f": {description}" if description else ""))
            for asset in assets:
                lines.append(f"  - [{asset.get('media_type', 'image')}] {asset.get('label', '')} (key: `{asset.get('asset_key', '')}`)")

    direct_assets = get_agent_brand_assets(agent_id)
    folder_asset_ids = {
        asset.get("id")
        for folder in folders
        for asset in (client.table("design_assets").select("id").eq("folder_id", folder.get("id")).execute().data or [])
    }
    direct_only = [asset for asset in direct_assets if asset.get("id") not in folder_asset_ids]
    if direct_only:
        lines.append("Attached Individual Brand Assets:")
        for asset in direct_only[:max_assets_per_folder]:
            lines.append(f"- [{_asset_media_type(asset)}] {asset.get('label', '')} (key: `{asset.get('asset_key', '')}`)")

    if not lines:
        return ""

    return "\n".join(lines)
