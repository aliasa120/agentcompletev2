"""Gemini 3.1 Flash Image provider — via Vercel AI Gateway Chat Completions API.

IMPORTANT: google/gemini-3.1-flash-image-preview is a MULTIMODAL LLM. It does NOT use
the /v1/images/generations endpoint. Images are returned inside the message
object under `message.images[]` in the chat completions response.

Input images (source news photo + brand reference images) are sent as base64-encoded
multimodal content parts — the same 3-image approach as KIE AI, but via Chat Completions
instead of URL-based image-to-image.

The OpenAI Python SDK silently drops unknown fields from the response, so this
module uses raw httpx HTTP calls and reads the JSON directly.
"""

import base64
import io
import logging
import os
from typing import List, Optional

import httpx
import requests
from PIL import Image

logger = logging.getLogger("gemini_flash_image")

_GATEWAY_BASE = "https://ai-gateway.vercel.sh/v1"
_MODEL = "google/gemini-3.1-flash-image-preview"
_OUTPUT_SIZE = 1024  # target output resolution (width and height)


def _pil_to_base64(img: Image.Image, fmt: str = "JPEG") -> str:
    """Encode a PIL image to a base64 data URI string."""
    buf = io.BytesIO()
    img.save(buf, format=fmt, quality=92)
    b64 = base64.b64encode(buf.getvalue()).decode()
    mime = "image/jpeg" if fmt.upper() == "JPEG" else "image/png"
    return f"data:{mime};base64,{b64}"


def _url_to_base64(url: str) -> str | None:
    """Download an image from a URL and encode it as a base64 data URI."""
    try:
        resp = requests.get(url, timeout=20,
                            headers={"User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)"})
        resp.raise_for_status()
        img = Image.open(io.BytesIO(resp.content)).convert("RGB")
        return _pil_to_base64(img, fmt="PNG")
    except Exception as e:
        logger.warning(f"[gemini_flash_image] Could not load ref image {url}: {e}")
        return None


async def gemini_flash_generate(
    prompt: str,
    source_img: Optional[Image.Image] = None,
    ref_urls: Optional[List[str]] = None,
    timeout: int = 180,
) -> dict:
    """Call Gemini 3.1 Flash Image via Vercel AI Gateway and return raw image bytes.

    Sends a multimodal message containing:
      [0] Text prompt with editing instructions
      [1] Source news photo (the target image to edit) — base64 JPEG
      [2] Brand reference image ref1.png — base64 PNG
      [3] Brand reference image ref2.png — base64 PNG

    This mirrors KIE AI's 3-image approach (target + 2 refs) but via Chat Completions
    with base64-encoded images instead of URLs.

    Args:
        prompt: Full editing instruction text from analyze_images_gemini.
        source_img: The target news photo as a PIL Image (required for editing).
        ref_urls: List of R2 CDN URLs for THE ECHO brand reference images.
        timeout: Request timeout in seconds.

    Returns:
        Dict with keys: image_bytes (bytes), format (str), text_response (str)

    Raises:
        RuntimeError: If the API call fails or returns no images.
    """
    api_key = os.environ.get("AI_GATEWAY_API_KEY", "")
    if not api_key:
        raise RuntimeError("AI_GATEWAY_API_KEY not set — Gemini Flash Image unavailable.")

    # ── Build multimodal content list ─────────────────────────────────────────
    # Order: text prompt → source image → ref images (same as KIE AI URL order)
    content: list = [
        {
            "type": "text",
            "text": (
                "TASK: Apply THE ECHO brand style from the REFERENCE IMAGES to the TARGET NEWS IMAGE.\n"
                "CRITICAL: Keep the original photographic content of the TARGET NEWS IMAGE exactly as it is.\n"
                "DO NOT blend photographic elements from the reference images.\n"
                "ONLY apply the layout, typography, color overlays, and brand elements from the references.\n"
                "Output must be exactly 1024x1024 pixels, square (1:1 aspect ratio).\n\n"
                "EDITING INSTRUCTIONS:\n"
                + prompt
            ),
        }
    ]

    # Add source (target) news image
    if source_img is not None:
        b64_source = _pil_to_base64(source_img, fmt="JPEG")
        content.append({
            "type": "image_url",
            "image_url": {"url": b64_source},
        })
        logger.info(f"[gemini_flash_image] Source image attached: {source_img.size}")
    else:
        logger.warning("[gemini_flash_image] No source_img provided — Gemini will generate without target photo.")

    # Add reference brand images
    for i, ref_url in enumerate(ref_urls or []):
        b64_ref = _url_to_base64(ref_url)
        if b64_ref:
            content.append({
                "type": "image_url",
                "image_url": {"url": b64_ref},
            })
            logger.info(f"[gemini_flash_image] Reference image {i+1} attached from: {ref_url[:60]}")

    logger.info(f"[gemini_flash_image] Sending {len(content)} content parts to {_MODEL} "
                f"(1 text + {len(content)-1} images)")

    payload = {
        "model": _MODEL,
        "messages": [
            {"role": "user", "content": content}
        ],
        "temperature": 0.4,
        # Native Gemini image config — forwarded by Vercel AI Gateway to generationConfig
        # imageSize: "1K" = 1024×1024, aspectRatio: "1:1" explicitly set
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {
                "aspectRatio": "1:1",
                "imageSize": "1K",
            },
        },
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
        resp = await client.post(
            f"{_GATEWAY_BASE}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )

    if resp.status_code == 401:
        raise RuntimeError(f"401 Unauthorized — invalid AI_GATEWAY_API_KEY for Gemini Flash Image.")
    if resp.status_code == 403:
        raise RuntimeError(f"403 Forbidden — check Vercel AI Gateway access for model {_MODEL}.")
    if not resp.is_success:
        raise RuntimeError(f"Gemini Flash API error {resp.status_code}: {resp.text[:400]}")

    data = resp.json()

    # Navigate the chat completions response
    try:
        message = data["choices"][0]["message"]
    except (KeyError, IndexError) as e:
        raise RuntimeError(f"Unexpected Gemini response structure: {e}\n{data}")

    text_response = message.get("content", "")

    # ── Extract image from message.images[] ──────────────────────────────────
    # Format: [{ "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }]
    images = message.get("images", [])
    if not images:
        raise RuntimeError(
            f"Gemini 2.5 Flash Image returned no images. "
            f"Text response: {text_response[:200]}"
        )

    image_entry = images[0]
    image_url_str = image_entry.get("image_url", {}).get("url", "")

    if not image_url_str:
        raise RuntimeError("Gemini response contained an empty image_url.")

    # Parse "data:image/png;base64,<data>" or plain base64
    if "," in image_url_str:
        header, b64_data = image_url_str.split(",", 1)
        fmt = "png" if "png" in header else "jpeg"
    else:
        b64_data = image_url_str
        fmt = "png"

    try:
        image_bytes = base64.b64decode(b64_data)
    except Exception as e:
        raise RuntimeError(f"Failed to decode Gemini image base64: {e}")

    # Decode, validate, force 1:1 center-crop, then resize to exactly 1024x1024
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception as e:
        raise RuntimeError(f"Gemini returned invalid image data: {e}")

    w, h = img.size
    if w != h:
        side = min(w, h)
        left  = (w - side) // 2
        top   = (h - side) // 2
        img   = img.crop((left, top, left + side, top + side))

    # Resize to target output size (1024x1024)
    if img.size != (_OUTPUT_SIZE, _OUTPUT_SIZE):
        img = img.resize((_OUTPUT_SIZE, _OUTPUT_SIZE), Image.LANCZOS)

    # Re-encode to bytes
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    image_bytes = buf.getvalue()
    fmt = "png"

    return {
        "image_bytes": image_bytes,
        "format": fmt,
        "text_response": text_response,
    }


async def test_connection() -> dict:
    """Minimal connectivity test for the agent-settings Test button."""
    api_key = os.environ.get("AI_GATEWAY_API_KEY", "")
    if not api_key:
        raise RuntimeError("AI_GATEWAY_API_KEY not set.")

    import time
    start = time.perf_counter()
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            f"{_GATEWAY_BASE}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": _MODEL,
                "messages": [{"role": "user", "content": "Say 'ok' only."}],
                "max_tokens": 5,
            }
        )
    latency_ms = int((time.perf_counter() - start) * 1000)

    if not resp.is_success:
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")

    return {"latency_ms": latency_ms, "model": _MODEL}
