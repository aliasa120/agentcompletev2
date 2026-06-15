"""Unified Image Generation tool — wraps KIE AI and Gemini 2.5 Flash Image.

Reads provider settings from Supabase agent_settings (cached 60s).
Image generation uses max 2 retries per provider (as per requirements).

Fallback hierarchy (configurable):
  Primary: KIE AI (image-to-image, best for brand-style editing)
  Fallback: Gemini 2.5 Flash Image (chat completions, via Vercel AI Gateway)

The KIE AI flow includes the existing Supabase upload step for reliable access.
The Gemini Flash flow sends the prompt directly and decodes the base64 response.
Both normalize output as a PIL Image saved to disk.
"""

import asyncio
import io
import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import List

import requests
from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig
from PIL import Image

from .provider_engine import execute_with_fallback, get_settings

logger = logging.getLogger("unified_image")

# ── Constants ─────────────────────────────────────────────────────────────────
_REPO_ROOT         = Path(__file__).resolve().parents[2]
_OUTPUT_DIR        = _REPO_ROOT / "output"
_MANIFEST_FILE     = _OUTPUT_DIR / "candidate_images" / "manifest.json"
_LATEST_IMAGE_FILE = _OUTPUT_DIR / "latest_image_path.txt"

_DEFAULTS = {
    "image_provider_primary": "kie",
    "image_provider_secondary": "gemini_flash",
    "image_max_retries": "2",    # 2 attempts × 15 s per provider
}


# ── Shared Helpers ─────────────────────────────────────────────────────────────

def _make_filename(headline: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", headline.lower()).strip("-")[:50]
    return f"{slug}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.jpg"


def _load_source_image(image_url: str) -> Image.Image:
    """Load full-res image from disk manifest, or download as fallback."""
    if _MANIFEST_FILE.exists():
        try:
            manifest = json.loads(_MANIFEST_FILE.read_text(encoding="utf-8"))
            cached = manifest.get(image_url)
            if cached and Path(cached).exists():
                logger.info(f"[unified_image] Loaded from disk: {cached}")
                return Image.open(cached).convert("RGB")
        except Exception as e:
            logger.warning(f"[unified_image] Manifest read failed: {e}")

    logger.info(f"[unified_image] Downloading from URL: {image_url[:80]}")
    resp = requests.get(image_url, timeout=20,
                        headers={"User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)"})
    resp.raise_for_status()
    return Image.open(io.BytesIO(resp.content)).convert("RGB")


def _upload_to_supabase(pil_img: Image.Image, slug: str) -> str | None:
    """Upload image to Supabase Storage. Returns public URL or None."""
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        return None
    buf = io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=92)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"kie-targets/{slug}-{ts}.jpg"
    try:
        resp = requests.post(
            f"{url}/storage/v1/object/post-images/{filename}",
            headers={"apikey": key, "Authorization": f"Bearer {key}",
                     "Content-Type": "image/jpeg", "x-upsert": "true"},
            data=buf.getvalue(), timeout=(10, 30),
        )
        if resp.ok:
            pub = f"{url}/storage/v1/object/public/post-images/{filename}"
            logger.info(f"[unified_image] Supabase upload OK: {pub}")
            return pub
    except Exception as e:
        logger.warning(f"[unified_image] Supabase upload error: {e}")
    return None


def _get_workflow_reference_images(workflow_id: str) -> list[str]:
    """Retrieve reference image public URLs for the active workflow's Main Agent.
    
    If none are found, we raise ValueError (no fallback to default).
    """
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        raise ValueError("Supabase URL and Key must be set in environment.")

    client = create_client(url, key)

    # 1. Get Main Agent ID for this workflow
    main_agent_resp = client.table("agent_configs").select("id").eq("workflow_id", workflow_id).eq("agent_type", "main").execute()
    if not main_agent_resp.data:
        raise ValueError(f"No Main Agent configured for workflow '{workflow_id}'.")
    
    main_agent_id = main_agent_resp.data[0]["id"]

    # 2. Get design assets linked to this Main Agent
    resp = client.table("agent_design_assets").select("design_assets(*)").eq("agent_id", main_agent_id).execute()
    assets = []
    for row in (resp.data or []):
        if row.get("design_assets"):
            assets.append(row["design_assets"])

    if not assets:
        raise ValueError(
            f"No style reference images are attached to the Main Agent of workflow '{workflow_id}'. "
            f"Please attach style reference images in the Settings UI."
        )

    # 3. For each asset, load from disk and upload to Supabase to get a public URL for KIE AI
    public_urls = []
    for asset in assets:
        file_path = asset.get("file_path")
        if not file_path:
            continue
        
        # Load local image using PIL
        repo_root = Path(__file__).resolve().parents[2]
        full_path = repo_root / file_path
        if not full_path.exists():
            raise FileNotFoundError(f"Reference image file not found on disk: {full_path}")
        
        img = Image.open(full_path).convert("RGB")
        
        # Upload to Supabase Storage and get public URL
        asset_key = asset.get("asset_key", "ref")
        pub_url = _upload_to_supabase(img, asset_key)
        if pub_url:
            public_urls.append(pub_url)
        else:
            raise RuntimeError(f"Failed to upload reference image '{file_path}' to Supabase Storage.")
            
    return public_urls


# ── KIE AI Provider ────────────────────────────────────────────────────────────

async def _kie_generate(
    target_url: str,
    editing_prompt: str,
    ref_urls: list[str],
    **_,
) -> Image.Image:
    """Call KIE AI image-to-image. Raises RuntimeError on any failure."""
    import time

    api_key = os.environ.get("KIE_API_KEY", "")
    if not api_key:
        raise RuntimeError("KIE_API_KEY not set — 401 would follow.")

    full_prompt = (
        "TASK: Apply THE ECHO brand style from the reference images to the FIRST TARGET NEWS IMAGE.\n"
        "CRITICAL: Keep the original photo of the target unchanged.\n"
        "DO NOT blend photographic content from reference images.\n"
        "ONLY add layout, typography, color overlays, and brand elements.\n"
        "EDITING INSTRUCTIONS:\n"
        + editing_prompt
    )

    payload = {
        "model": "gpt-image/1.5-image-to-image",
        "input": {
            "input_urls": [target_url] + ref_urls,
            "prompt": full_prompt,
            "aspect_ratio": "1:1",
            "quality": "medium",
        }
    }

    loop = asyncio.get_event_loop()

    def _create_task():
        resp = requests.post(
            "https://api.kie.ai/api/v1/jobs/createTask",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload, timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 200:
            raise RuntimeError(f"KIE API error code {data.get('code')}: {data}")
        task_id = data.get("data", {}).get("taskId")
        if not task_id:
            raise RuntimeError("KIE API returned no taskId.")
        return task_id

    task_id = await loop.run_in_executor(None, _create_task)
    logger.info(f"[unified_image] KIE task created: {task_id}")

    def _poll_task():
        for i in range(120):
            time.sleep(3)
            poll = requests.get(
                f"https://api.kie.ai/api/v1/jobs/recordInfo?taskId={task_id}",
                headers={"Authorization": f"Bearer {api_key}"}, timeout=20,
            )
            poll.raise_for_status()
            data = poll.json()
            state = data.get("data", {}).get("state")
            if state == "success":
                result_json = json.loads(data.get("data", {}).get("resultJson", "{}"))
                urls = result_json.get("resultUrls", [])
                if not urls:
                    raise RuntimeError("KIE returned success but no resultUrls.")
                # Download with 3 retries
                for attempt in range(3):
                    try:
                        r = requests.get(urls[0], timeout=60)
                        r.raise_for_status()
                        return Image.open(io.BytesIO(r.content)).convert("RGB")
                    except Exception as e:
                        if attempt < 2:
                            time.sleep(2)
                        else:
                            raise RuntimeError(f"KIE result download failed: {e}")
            elif state == "fail":
                raise RuntimeError(f"KIE task failed: {data.get('data', {}).get('failMsg', 'unknown')}")
            logger.info(f"[unified_image] KIE polling... state={state} ({i+1}/120)")
        raise RuntimeError("KIE polling timed out after 6 minutes.")

    return await loop.run_in_executor(None, _poll_task)


# ── Gemini Flash Image Provider ────────────────────────────────────────────────

async def _gemini_generate(
    editing_prompt: str,
    source_img: Image.Image | None = None,
    ref_urls: list[str] = None,
    **_,
) -> Image.Image:
    """Call Gemini 3.1 Flash Image via Vercel AI Gateway (Chat Completions API)."""
    from .gemini_flash_image import gemini_flash_generate

    result = await gemini_flash_generate(
        prompt=editing_prompt,
        source_img=source_img,
        ref_urls=ref_urls,
        timeout=180,
    )
    img = Image.open(io.BytesIO(result["image_bytes"])).convert("RGB")
    logger.info(f"[unified_image] Gemini Flash image received: {img.size}")
    return img


# ── Provider Map ───────────────────────────────────────────────────────────────

_PROVIDER_MAP = {
    "kie":          ("KIE AI",        _kie_generate),
    "gemini_flash": ("Gemini Flash",  _gemini_generate),
}


# ── LangGraph Tool ─────────────────────────────────────────────────────────────

@tool(parse_docstring=True)
def create_post_image(
    image_url: str,
    headline_text: str,
    editing_prompt: str,
    config: RunnableConfig,
) -> str:
    """Create a styled social post image using the configured AI image model.

    Loads the full-resolution target image from disk, uploads it to Supabase
    (to bypass hotlink protection), then calls the primary image AI model with
    the editing prompt and both THE ECHO reference images.

    Provider selection (KIE AI ↔ Gemini 2.5 Flash), retry count (2), and
    automatic fallback are configured via the Agent Settings UI in Supabase.

    Args:
        image_url: URL of the chosen news photo from analyze_images_gemini.
        headline_text: Short headline (max 10 words) for filename generation.
        editing_prompt: Full editing instruction JSON from analyze_images_gemini.
        config: LangChain runnable configuration.

    Returns:
        Absolute path to the saved output image file.
    """
    _OUTPUT_DIR.mkdir(exist_ok=True)
    output_path = _OUTPUT_DIR / _make_filename(headline_text)

    # Load source image
    try:
        source_img = _load_source_image(image_url)
        logger.info(f"[unified_image] Source image size: {source_img.size}")
    except Exception as e:
        return f"❌ Could not load source image: {e}"

    # Resolve active workflow ID
    workflow_id = config.get("configurable", {}).get("workflow_id")
    if not workflow_id:
        try:
            from supabase import create_client
            url = os.environ.get("SUPABASE_URL", "").rstrip("/")
            key = os.environ.get("SUPABASE_ANON_KEY", "")
            if url and key:
                client = create_client(url, key)
                wf_resp = client.table("workflows").select("id").eq("enabled", True).order("created_at").limit(1).execute()
                if wf_resp.data:
                    workflow_id = wf_resp.data[0]["id"]
        except Exception as e:
            logger.warning(f"[unified_image] Error resolving fallback workflow_id: {e}")

    if not workflow_id:
        return "❌ Error: workflow_id is not set and could not be resolved from active workflows."

    # Load workflow reference images (throws error on failure/empty list - NO fallback to default)
    try:
        ref_urls = _get_workflow_reference_images(workflow_id)
        logger.info(f"[unified_image] Loaded {len(ref_urls)} workflow-specific reference images: {ref_urls}")
    except Exception as e:
        return f"❌ Error loading reference images for workflow: {e}"

    # Upload to Supabase (for KIE AI URL access)
    slug = re.sub(r"[^a-z0-9]+", "-", headline_text.lower())[:40].strip("-")
    supabase_url = _upload_to_supabase(source_img, slug) or image_url

    # Read provider settings
    settings = get_settings()
    primary_key = settings.get("image_provider_primary", _DEFAULTS["image_provider_primary"])
    secondary_key = settings.get("image_provider_secondary", _DEFAULTS["image_provider_secondary"])
    max_retries = int(settings.get("image_max_retries", _DEFAULTS["image_max_retries"]))

    primary_name, primary_fn = _PROVIDER_MAP.get(primary_key, _PROVIDER_MAP["kie"])
    secondary_entry = _PROVIDER_MAP.get(secondary_key)
    secondary_name = secondary_entry[0] if secondary_entry else "none"
    secondary_fn = secondary_entry[1] if secondary_entry else None

    logger.info(f"[unified_image] Primary={primary_name}, Fallback={secondary_name}, Retries={max_retries}")

    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

    result_img: Image.Image | None = None
    try:
        result = loop.run_until_complete(
            execute_with_fallback(
                primary_fn=primary_fn,
                secondary_fn=secondary_fn,
                primary_name=primary_name,
                secondary_name=secondary_name,
                max_retries=max_retries,
                timeout_seconds=300,  # image generation can take a long time
                # kwargs passed to provider adapters:
                target_url=supabase_url,
                editing_prompt=editing_prompt,
                source_img=source_img,
                ref_urls=ref_urls,
            )
        )
        if result.failed:
            # All image providers failed — fall through to raw-source fallback below
            logger.error(f"[unified_image] All image providers failed: {result.data}")
            result_img = None
        else:
            result_img = result.data
            if result.fallback_used:
                logger.warning(f"[unified_image] Used fallback provider: {result.provider_used}")
    except RuntimeError as e:
        logger.error(f"[unified_image] Unexpected error: {e}")
        result_img = None

    # Save output
    if result_img is not None:
        result_img.save(str(output_path), "JPEG", quality=92)
        _LATEST_IMAGE_FILE.write_text(str(output_path), encoding="utf-8")
        return output_path.resolve().as_posix()

    # Last resort fallback: save raw source image
    logger.warning("[unified_image] All edit providers failed. Saving raw source image.")
    fallback_path = output_path.with_name(f"{output_path.stem}-fallback.jpg")
    try:
        source_img.save(str(fallback_path), "JPEG", quality=92)
        _LATEST_IMAGE_FILE.write_text(str(fallback_path), encoding="utf-8")
        return fallback_path.resolve().as_posix()
    except Exception as e:
        return f"❌ All image providers failed and fallback save also failed: {e}"
