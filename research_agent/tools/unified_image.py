"""Unified Image Generation tool — wraps KIE AI and xAI Grok Imagine Image (via Vercel AI Gateway).

Reads provider settings and fallback priority from Supabase agent_settings / unified_tool_configs.
Image generation uses configurable retries (default 2 retries per provider).

Supported Providers:
  - KIE AI (gpt-image/1.5-image-to-image, brand-style image editing)
  - Grok Imagine Image (xai/grok-imagine-image via Vercel AI Gateway, text-to-image & multi-reference editing)

Supports:
  - Thread-isolated outputs: saved directly to output/threads/<thread_id>/<filename>.jpg
  - Supabase Storage upload: uploaded to Supabase public storage bucket
  - Thread chat file card rendering: outputs FILE_URL:<url> for assistant-ui file-reply
  - Aspect ratio selection: '1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16'
  - Reference images: multiple style reference images (< 20MB per image)
  - Source image editing & text-to-image generation
"""

import asyncio
import io
import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import List, Optional

import requests
from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig
from PIL import Image

from .provider_engine import execute_with_fallback, get_settings
from research_agent.fs_backend import get_thread_output_dir

logger = logging.getLogger("unified_image")

# ── Constants ─────────────────────────────────────────────────────────────────
_REPO_ROOT         = Path(__file__).resolve().parents[2]
_OUTPUT_DIR        = _REPO_ROOT / "output"
_MANIFEST_FILE     = _OUTPUT_DIR / "candidate_images" / "manifest.json"
_LATEST_IMAGE_FILE = _OUTPUT_DIR / "latest_image_path.txt"

_DEFAULTS = {
    "image_provider_primary": "kie",
    "image_provider_secondary": "grok_imagine",
    "image_max_retries": "2",
}


# ── Shared Helpers ─────────────────────────────────────────────────────────────

def _make_filename(headline: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", headline.lower()).strip("-")[:50]
    if not slug:
        slug = "generated-image"
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
    resp = requests.get(
        image_url,
        timeout=20,
        headers={"User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)"}
    )
    resp.raise_for_status()
    return Image.open(io.BytesIO(resp.content)).convert("RGB")


def _upload_to_supabase(pil_img: Image.Image, slug: str) -> str | None:
    """Upload target image to unified storage (R2-first) for KIE AI access. Returns public URL or None."""
    from research_agent import storage_service

    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
    buf = io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=92)

    # R2-first via unified storage service
    r2_url = storage_service.upload_file(
        data=buf.getvalue(),
        filename=f"{slug}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.jpg",
        mime_type="image/jpeg",
        category="kie-targets",
    )
    if r2_url:
        return r2_url

    if not url or not key:
        return None
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


def _upload_output_image_to_supabase(pil_img: Image.Image, filename: str, thread_id: str = "") -> str | None:
    """Upload final generated image to unified storage (R2-first) and return public URL."""
    from research_agent import storage_service

    buf = io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=92)
    img_bytes = buf.getvalue()

    # R2-first via unified storage service
    r2_url = storage_service.upload_file(
        data=img_bytes,
        filename=filename,
        mime_type="image/jpeg",
        category="images",
        thread_id=thread_id,
    )
    if r2_url:
        return r2_url

    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        return None

    safe_thread = re.sub(r'[^a-zA-Z0-9_\-.]', '_', str(thread_id).strip()) if thread_id else "general"
    storage_path = f"threads/{safe_thread}/{filename}"

    # Try uploading to "uploads" bucket first, then "post-images"
    for bucket in ["uploads", "post-images"]:
        try:
            resp = requests.post(
                f"{url}/storage/v1/object/{bucket}/{storage_path}",
                headers={
                    "apikey": key,
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "image/jpeg",
                    "x-upsert": "true",
                },
                data=img_bytes,
                timeout=(10, 30),
            )
            if resp.ok:
                public_url = f"{url}/storage/v1/object/public/{bucket}/{storage_path}"
                logger.info(f"[unified_image] Output image uploaded to Supabase {bucket}: {public_url}")
                return public_url
        except Exception as e:
            logger.warning(f"[unified_image] Failed to upload to Supabase bucket '{bucket}': {e}")

    return None


def _get_workflow_reference_images(workflow_id: str) -> list[str]:
    """Retrieve reference image public URLs for the active workflow's Main Agent."""
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        return []

    client = create_client(url, key)

    try:
        main_agent_resp = client.table("agent_configs").select("id").eq("workflow_id", workflow_id).eq("agent_type", "main").execute()
        if not main_agent_resp.data:
            return []

        main_agent_id = main_agent_resp.data[0]["id"]
        resp = client.table("agent_design_assets").select("design_assets(*)").eq("agent_id", main_agent_id).execute()
        assets = []
        for row in (resp.data or []):
            if row.get("design_assets"):
                assets.append(row["design_assets"])

        public_urls = []
        repo_root = Path(__file__).resolve().parents[2]
        for asset in assets:
            file_path = asset.get("file_path")
            if not file_path:
                continue
            full_path = repo_root / file_path
            if full_path.exists():
                img = Image.open(full_path).convert("RGB")
                asset_key = asset.get("asset_key", "ref")
                pub_url = _upload_to_supabase(img, asset_key)
                if pub_url:
                    public_urls.append(pub_url)

        return public_urls
    except Exception as e:
        logger.warning(f"[unified_image] Could not load workflow design assets: {e}")
        return []


# ── KIE AI Provider ────────────────────────────────────────────────────────────

async def _kie_generate(
    target_url: str = "",
    editing_prompt: str = "",
    ref_urls: list[str] = None,
    aspect_ratio: str = "1:1",
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

    ratio = aspect_ratio if aspect_ratio in {"1:1", "16:9", "4:3", "3:4", "9:16"} else "1:1"
    input_urls = ([target_url] if target_url else []) + (ref_urls or [])

    payload = {
        "model": "gpt-image/1.5-image-to-image",
        "input": {
            "input_urls": input_urls,
            "prompt": full_prompt,
            "aspect_ratio": ratio,
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


# ── Grok Imagine Image Provider (via Vercel AI Gateway) ────────────────────────

async def _grok_imagine_generate(
    editing_prompt: str = "",
    source_img: Image.Image | None = None,
    ref_urls: list[str] = None,
    aspect_ratio: str = "1:1",
    **_,
) -> Image.Image:
    """Call xAI Grok Imagine Image via Vercel AI Gateway."""
    from .grok_imagine_image import grok_imagine_generate

    result = await grok_imagine_generate(
        prompt=editing_prompt,
        source_img=source_img,
        ref_urls=ref_urls,
        aspect_ratio=aspect_ratio,
        timeout=180,
    )
    img = Image.open(io.BytesIO(result["image_bytes"])).convert("RGB")
    logger.info(f"[unified_image] Grok Imagine image received: {img.size}")
    return img


# ── Provider Map ───────────────────────────────────────────────────────────────

_PROVIDER_MAP = {
    "kie":          ("KIE AI",             _kie_generate),
    "grok_imagine": ("Grok Imagine Image", _grok_imagine_generate),
    "gemini_flash": ("Grok Imagine Image", _grok_imagine_generate),  # Backwards compat alias
}


# ── LangGraph Tool ─────────────────────────────────────────────────────────────

@tool(parse_docstring=True)
def create_post_image(
    image_url: str = "",
    editing_prompt: str = "",
    prompt: str = "",
    headline_text: str = "",
    aspect_ratio: str = "1:1",
    reference_image_urls: list[str] = None,
    config: RunnableConfig = None,
) -> str:
    """Create or edit a styled post image using the configured AI image model (KIE AI or Grok Imagine Image).

    Supports both text-to-image generation and multi-image editing with reference images.
    When editing a target image, provide image_url along with editing_prompt or prompt.
    You can select the aspect ratio ('1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16') and
    optionally pass reference image URLs (<20MB each) for brand style consistency.

    Args:
        image_url: URL of the chosen target image/photo to edit (optional; leave empty for text-to-image).
        editing_prompt: Detailed editing instructions or JSON from analyze_images_gemini.
        prompt: Text prompt for image generation or editing (alternative to editing_prompt).
        headline_text: Short headline (max 10 words) for filename generation or text overlays.
        aspect_ratio: Aspect ratio for the image: '1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16'. Default is '1:1'.
        reference_image_urls: Optional list of reference image URLs (<20MB each) for style/brand guidance.
        config: LangChain runnable configuration.

    Returns:
        Result string containing absolute file path and FILE_URL:<public_url> for chat preview.
    """
    # 1. Resolve thread-isolated workspace output directory
    thread_id = ""
    if config:
        thread_id = config.get("configurable", {}).get("thread_id", "")

    thread_output_dir = Path(get_thread_output_dir(config, create=False))

    # 2. Normalize prompt text
    effective_prompt = editing_prompt or prompt or "Social media post image"

    # Derive headline text for filename if not given
    if not headline_text:
        try:
            ep_data = json.loads(effective_prompt) if isinstance(effective_prompt, str) else effective_prompt
            if isinstance(ep_data, dict):
                headline_text = ep_data.get("text_layers", {}).get("headline", "")
                if not aspect_ratio or aspect_ratio == "1:1":
                    aspect_ratio = ep_data.get("aspect_ratio", aspect_ratio)
        except Exception:
            headline_text = "post-image"

    if not headline_text:
        headline_text = "post-image"

    filename = _make_filename(headline_text)
    output_path = thread_output_dir / filename

    # 3. Load source image if provided
    source_img: Optional[Image.Image] = None
    if image_url:
        try:
            source_img = _load_source_image(image_url)
            logger.info(f"[unified_image] Source image size: {source_img.size}")
        except Exception as e:
            logger.warning(f"[unified_image] Could not load source image from {image_url[:60]}: {e}")

    # 4. Resolve reference image URLs: use passed reference_image_urls or load from active workflow
    ref_urls = reference_image_urls or []
    if not ref_urls and config:
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

        if workflow_id:
            ref_urls = _get_workflow_reference_images(workflow_id)
            logger.info(f"[unified_image] Loaded {len(ref_urls)} workflow reference images.")

    # Upload target to Supabase for KIE AI access if available
    slug = re.sub(r"[^a-z0-9]+", "-", headline_text.lower())[:40].strip("-")
    supabase_url = ""
    if source_img is not None:
        supabase_url = _upload_to_supabase(source_img, slug) or image_url

    # 5. Read provider priority settings
    settings = get_settings()
    primary_key = settings.get("image_provider_primary", _DEFAULTS["image_provider_primary"])
    secondary_key = settings.get("image_provider_secondary", _DEFAULTS["image_provider_secondary"])
    max_retries = int(settings.get("image_max_retries", _DEFAULTS["image_max_retries"]))

    primary_name, primary_fn = _PROVIDER_MAP.get(primary_key, _PROVIDER_MAP["kie"])
    secondary_entry = _PROVIDER_MAP.get(secondary_key)
    secondary_name = secondary_entry[0] if secondary_entry else "none"
    secondary_fn = secondary_entry[1] if secondary_entry else None

    logger.info(
        f"[unified_image] Primary={primary_name}, Fallback={secondary_name}, "
        f"Aspect={aspect_ratio}, Thread={thread_id or 'default'}, Retries={max_retries}"
    )

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
                timeout_seconds=300,
                # kwargs passed to provider adapters:
                target_url=supabase_url,
                editing_prompt=effective_prompt,
                source_img=source_img,
                ref_urls=ref_urls,
                aspect_ratio=aspect_ratio,
            )
        )
        if result.failed:
            logger.error(f"[unified_image] All image providers failed: {result.data}")
            result_img = None
        else:
            result_img = result.data
            if result.fallback_used:
                logger.warning(f"[unified_image] Used fallback provider: {result.provider_used}")
    except RuntimeError as e:
        logger.error(f"[unified_image] Unexpected error: {e}")
        result_img = None

    # 6. Save output image locally in thread directory and upload to Supabase Storage
    if result_img is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        result_img.save(str(output_path), "JPEG", quality=92)
        try:
            _LATEST_IMAGE_FILE.write_text(str(output_path), encoding="utf-8")
        except Exception:
            pass

        # Upload generated image to Supabase Storage so it is accessible everywhere
        public_url = _upload_output_image_to_supabase(result_img, filename, thread_id=thread_id)

        posix_path = output_path.resolve().as_posix()
        if public_url:
            return (
                f"✅ Image generated and saved to thread workspace:\n{posix_path}\n"
                f"FILE_URL:{public_url}"
            )
        return posix_path

    # Last resort fallback: save raw source image if available
    if source_img is not None:
        logger.warning("[unified_image] All edit providers failed. Saving raw source image as fallback.")
        fallback_path = output_path.with_name(f"{output_path.stem}-fallback.jpg")
        try:
            fallback_path.parent.mkdir(parents=True, exist_ok=True)
            source_img.save(str(fallback_path), "JPEG", quality=92)
            try:
                _LATEST_IMAGE_FILE.write_text(str(fallback_path), encoding="utf-8")
            except Exception:
                pass
            fallback_public = _upload_output_image_to_supabase(source_img, fallback_path.name, thread_id=thread_id)
            posix_path = fallback_path.resolve().as_posix()
            if fallback_public:
                return (
                    f"⚠️ Edit providers failed. Saved source image fallback:\n{posix_path}\n"
                    f"FILE_URL:{fallback_public}"
                )
            return posix_path
        except Exception as e:
            return f"❌ Image providers failed and fallback save failed: {e}"

    return "❌ Image generation failed across all configured providers."
