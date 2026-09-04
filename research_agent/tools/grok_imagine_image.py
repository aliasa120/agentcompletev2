"""xAI Grok Imagine Image provider — via Vercel AI Gateway.

Model: xai/grok-imagine-image
Gateway Base: https://ai-gateway.vercel.sh/v1

Supports:
- Text-to-image generation
- Multi-image editing & style transfer with reference images (< 20MB per image)
- Multiple aspect ratios ('1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16')
- Base64 & URL image response parsing
"""

import base64
import io
import logging
import os
from typing import List, Optional

import httpx
import requests
from PIL import Image

logger = logging.getLogger("grok_imagine_image")

_GATEWAY_BASE = "https://ai-gateway.vercel.sh/v1"
_MODEL = "spacexai/grok-imagine-image"
_MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MB limit per reference/source image
_VALID_ASPECT_RATIOS = {"1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16"}


def _get_api_key() -> str:
    """Resolve Vercel AI Gateway API Key from agent_settings or environment variables."""
    try:
        from .provider_engine import get_user_api_key
        key = get_user_api_key("ai_gateway_api_key", env_fallback="AI_GATEWAY_API_KEY")
        if key:
            return key
    except Exception:
        pass

    return (
        os.environ.get("AI_GATEWAY_API_KEY", "")
        or os.environ.get("VERCEL_AI_GATEWAY_API_KEY", "")
        or os.environ.get("VERCEL_API_KEY", "")
    ).strip()


def _optimize_pil_image(img: Image.Image, max_bytes: int = _MAX_IMAGE_BYTES) -> tuple[bytes, str]:
    """Ensure a PIL image is encoded as JPEG/PNG and strictly under max_bytes (<20MB)."""
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    data = buf.getvalue()

    if len(data) <= max_bytes:
        return data, "image/jpeg"

    # If over 20MB, progressively resize & lower quality
    quality = 85
    curr_img = img.copy()
    while len(data) > max_bytes and quality > 30:
        w, h = curr_img.size
        curr_img = curr_img.resize((int(w * 0.85), int(h * 0.85)), Image.LANCZOS)
        buf = io.BytesIO()
        curr_img.save(buf, format="JPEG", quality=quality)
        data = buf.getvalue()
        quality -= 10

    return data, "image/jpeg"


def _pil_to_base64_data_uri(img: Image.Image) -> str:
    """Encode a PIL image to a base64 data URI string, ensuring < 20MB."""
    data, mime = _optimize_pil_image(img)
    b64 = base64.b64encode(data).decode("utf-8")
    return f"data:{mime};base64,{b64}"


def _url_to_pil(url: str) -> Optional[Image.Image]:
    """Download an image from a URL and return as PIL Image (RGB)."""
    try:
        resp = requests.get(
            url,
            timeout=25,
            headers={"User-Agent": "Mozilla/5.0 (compatible; GrokImagineBot/1.0)"},
        )
        resp.raise_for_status()
        return Image.open(io.BytesIO(resp.content)).convert("RGB")
    except Exception as e:
        logger.warning(f"[grok_imagine_image] Failed to download image from {url[:60]}: {e}")
        return None


async def grok_imagine_generate(
    prompt: str,
    source_img: Optional[Image.Image] = None,
    ref_urls: Optional[List[str]] = None,
    aspect_ratio: str = "1:1",
    timeout: int = 180,
) -> dict:
    """Call xAI Grok Imagine Image via Vercel AI Gateway.

    Args:
        prompt: Full prompt or editing instructions.
        source_img: Target photo to edit (PIL Image), or None for text-to-image generation.
        ref_urls: List of reference image URLs for brand style / consistency (< 20MB each).
        aspect_ratio: One of '1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16'. Default '1:1'.
        timeout: Request timeout in seconds.

    Returns:
        Dict with keys: image_bytes (bytes), format (str), text_response (str)

    Raises:
        RuntimeError: If the API key is missing or the request fails.
    """
    api_key = _get_api_key()
    if not api_key:
        raise RuntimeError("AI_GATEWAY_API_KEY not configured for Grok Imagine Image.")

    # Validate aspect ratio
    ratio = aspect_ratio.strip() if aspect_ratio else "1:1"
    if ratio not in _VALID_ASPECT_RATIOS:
        logger.warning(f"[grok_imagine_image] Aspect ratio '{ratio}' not in {_VALID_ASPECT_RATIOS}, falling back to '1:1'")
        ratio = "1:1"

    # Collect reference images (up to 5 images, each < 20MB)
    input_images_b64: List[str] = []

    # 1. Main target source image
    if source_img is not None:
        b64_src = _pil_to_base64_data_uri(source_img)
        input_images_b64.append(b64_src)
        logger.info(f"[grok_imagine_image] Attached main target photo: {source_img.size}")

    # 2. Reference style images
    for i, ref_url in enumerate(ref_urls or []):
        ref_pil = _url_to_pil(ref_url)
        if ref_pil is not None:
            b64_ref = _pil_to_base64_data_uri(ref_pil)
            input_images_b64.append(b64_ref)
            logger.info(f"[grok_imagine_image] Attached reference image {i+1}: {ref_pil.size} (<20MB)")

    # Build full prompt
    is_editing = source_img is not None or len(input_images_b64) > 0
    if is_editing:
        full_prompt = (
            "TASK: Apply the brand style, layout, typography, and color palette from the reference images "
            "to the target image.\n"
            "CRITICAL: Maintain the core photographic subject of the target image unchanged.\n"
            f"Aspect ratio: {ratio}.\n\n"
            "DETAILED INSTRUCTIONS:\n"
            + prompt
        )
    else:
        full_prompt = f"{prompt}\nAspect ratio: {ratio}."

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    # First attempt: Try standard /images/generations endpoint
    payload_generations = {
        "model": _MODEL,
        "prompt": full_prompt,
        "aspect_ratio": ratio,
        "response_format": "b64_json",
    }
    if input_images_b64:
        payload_generations["images"] = input_images_b64

    logger.info(
        f"[grok_imagine_image] Requesting {_MODEL} (aspect_ratio={ratio}, images={len(input_images_b64)}) via {_GATEWAY_BASE}..."
    )

    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
        resp = None

        # 1. Image Editing: If a target source image is provided, call /v1/images/edits
        if source_img is not None:
            img_bytes, mime_type = _optimize_pil_image(source_img)
            logger.info(
                f"[grok_imagine_image] Editing target photo: sending {len(img_bytes)} bytes to {_GATEWAY_BASE}/images/edits..."
            )
            edit_headers = {"Authorization": f"Bearer {api_key}"}
            ext = "png" if "png" in mime_type else "jpg"
            files = {"image": (f"source.{ext}", img_bytes, mime_type)}
            data = {
                "model": _MODEL,
                "prompt": full_prompt,
            }
            try:
                resp = await client.post(
                    f"{_GATEWAY_BASE}/images/edits",
                    headers=edit_headers,
                    data=data,
                    files=files,
                )
                logger.info(f"[grok_imagine_image] /images/edits response status: {resp.status_code}")
            except Exception as edit_err:
                logger.warning(f"[grok_imagine_image] /images/edits request failed: {edit_err}")

        # 2. Text-to-Image Generation (or fallback if /images/edits returned non-success)
        if resp is None or not resp.is_success:
            payload_generations = {
                "model": _MODEL,
                "prompt": full_prompt,
                "aspect_ratio": ratio,
                "response_format": "b64_json",
            }
            if input_images_b64 and source_img is None:
                payload_generations["images"] = input_images_b64

            logger.info(
                f"[grok_imagine_image] Requesting {_MODEL} via {_GATEWAY_BASE}/images/generations (aspect_ratio={ratio})..."
            )
            resp = await client.post(
                f"{_GATEWAY_BASE}/images/generations",
                headers=headers,
                json=payload_generations,
            )

        # 3. Multimodal Chat Fallback: if /images/generations returns 404 or 400 and we have images
        if not resp.is_success and input_images_b64:
            logger.info("[grok_imagine_image] fallback -> trying /chat/completions multimodal...")
            content_parts: list = [{"type": "text", "text": full_prompt}]
            for img_uri in input_images_b64:
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": img_uri},
                })

            resp = await client.post(
                f"{_GATEWAY_BASE}/chat/completions",
                headers=headers,
                json={
                    "model": _MODEL,
                    "messages": [{"role": "user", "content": content_parts}],
                    "modalities": ["text", "image"],
                    "aspect_ratio": ratio,
                },
            )

    if resp.status_code == 401:
        raise RuntimeError("401 Unauthorized — invalid AI_GATEWAY_API_KEY for Vercel AI Gateway.")
    if resp.status_code == 403:
        raise RuntimeError(f"403 Forbidden — check Vercel AI Gateway permissions for model {_MODEL}.")
    if not resp.is_success:
        raise RuntimeError(f"Grok Imagine API error {resp.status_code}: {resp.text[:400]}")

    data = resp.json()
    image_bytes: Optional[bytes] = None
    fmt = "png"
    text_response = ""

    # Parse response: Case 1 - OpenAI images.generations response: { "data": [{ "b64_json": "..." }] }
    if "data" in data and isinstance(data["data"], list) and len(data["data"]) > 0:
        item = data["data"][0]
        if "b64_json" in item and item["b64_json"]:
            image_bytes = base64.b64decode(item["b64_json"])
        elif "url" in item and item["url"]:
            # Download image from URL
            dl_resp = requests.get(item["url"], timeout=60)
            dl_resp.raise_for_status()
            image_bytes = dl_resp.content

    # Parse response: Case 2 - Vercel AI SDK style: { "images": [{ "base64": "..." }] }
    elif "images" in data and isinstance(data["images"], list) and len(data["images"]) > 0:
        item = data["images"][0]
        if isinstance(item, dict) and "base64" in item:
            image_bytes = base64.b64decode(item["base64"])
        elif isinstance(item, str):
            b64_str = item.split(",")[-1]
            image_bytes = base64.b64decode(b64_str)

    # Parse response: Case 3 - Chat completions style: { "choices": [{ "message": { "images": [...] } }] }
    elif "choices" in data and len(data["choices"]) > 0:
        msg = data["choices"][0].get("message", {})
        text_response = msg.get("content", "")
        images = msg.get("images", [])
        if images:
            img_item = images[0]
            url_str = img_item.get("image_url", {}).get("url", "") or img_item.get("url", "")
            if "," in url_str:
                b64_data = url_str.split(",", 1)[1]
                image_bytes = base64.b64decode(b64_data)
            elif url_str.startswith("http"):
                dl_resp = requests.get(url_str, timeout=60)
                dl_resp.raise_for_status()
                image_bytes = dl_resp.content

    if not image_bytes:
        raise RuntimeError(f"Grok Imagine returned no image data. Response payload: {str(data)[:300]}")

    # Validate output image using PIL
    try:
        out_img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        buf = io.BytesIO()
        out_img.save(buf, format="PNG")
        image_bytes = buf.getvalue()
        fmt = "png"
    except Exception as e:
        logger.warning(f"[grok_imagine_image] PIL validation notice: {e}")

    return {
        "image_bytes": image_bytes,
        "format": fmt,
        "text_response": text_response,
    }


async def test_connection() -> dict:
    """Minimal connectivity test for Vercel AI Gateway and Grok Imagine Image."""
    api_key = _get_api_key()
    if not api_key:
        raise RuntimeError("AI_GATEWAY_API_KEY not set.")

    import time
    start = time.perf_counter()
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_GATEWAY_BASE}/models",
            headers={"Authorization": f"Bearer {api_key}"},
        )
    latency_ms = int((time.perf_counter() - start) * 1000)

    if not resp.is_success:
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")

    return {"latency_ms": latency_ms, "model": _MODEL}
