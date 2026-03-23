"""Gemini 2.5 Flash Image provider — via Vercel AI Gateway Chat Completions API.

IMPORTANT: google/gemini-2.5-flash-image is a MULTIMODAL LLM. It does NOT use
the /v1/images/generations endpoint. Images are returned inside the message
object under `message.images[]` in the chat completions response.

The OpenAI Python SDK silently drops unknown fields from the response, so this
module uses raw httpx HTTP calls and reads the JSON directly.
"""

import base64
import io
import os

import httpx
from PIL import Image

_GATEWAY_BASE = "https://ai-gateway.vercel.sh/v1"
_MODEL = "google/gemini-2.5-flash-image"


async def gemini_flash_generate(
    prompt: str,
    timeout: int = 120,
) -> dict:
    """Call Gemini 2.5 Flash Image via Vercel AI Gateway and return raw image bytes.

    Uses raw httpx instead of the OpenAI SDK because the SDK does not parse
    the `images` field in the message object (it silently drops unknown fields).

    Args:
        prompt: Full text prompt describing the image to generate/edit.
        timeout: Request timeout in seconds (default 120 for image generation).

    Returns:
        Dict with keys: image_bytes (bytes), format (str), text_response (str)

    Raises:
        RuntimeError: If the API call fails or returns no images.
    """
    api_key = os.environ.get("AI_GATEWAY_API_KEY", "")
    if not api_key:
        raise RuntimeError("AI_GATEWAY_API_KEY not set — Gemini Flash Image unavailable.")

    # Prepend aspect ratio instruction — Gemini has no native aspect_ratio param
    square_prompt = (
        "IMPORTANT: The output image MUST be a perfect square (1:1 aspect ratio). "
        "Do NOT produce a wide or tall image. Square format only.\n\n"
        + prompt
    )

    payload = {
        "model": _MODEL,
        "messages": [
            {"role": "user", "content": square_prompt}
        ],
        "temperature": 0.4,
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

    # Decode, validate, and force 1:1 center-crop (matches KIE AI "aspect_ratio": "1:1")
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
