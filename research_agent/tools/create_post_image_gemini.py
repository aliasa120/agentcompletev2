"""Create social post image using GPT-Image-1.5 via Vercel AI Gateway.

Flow:
1. Load the full-resolution image from disk (saved by view_candidate_images)
   — falls back to downloading from URL if not found on disk.
2. Crop to 1024×1024 square, encode as PNG.
3. POST to Vercel AI Gateway /v1/images/edits with model=openai/gpt-image-1.5,
   quality=medium, size=1024x1024.
4. Decode the returned base64 PNG and save as output/<slug>-<ts>.jpg.
5. Fall back to PIL overlay if the API call fails.
"""

import base64
import io
import json
import os
import re
from datetime import datetime
from pathlib import Path

import requests
import smartcrop
from langchain_core.tools import tool
from PIL import Image, ImageDraw, ImageFont


# ── constants ────────────────────────────────────────────────────────────────

_OUTPUT_DIR = Path("output")
_MANIFEST_FILE = Path("output") / "candidate_images" / "manifest.json"
_LATEST_IMAGE_FILE = Path("output") / "latest_image_path.txt"

# Brand reference images — attached to BOTH vision analysis AND editing calls
_REF_IMAGES_DIR = Path("reference images")
_REF_IMAGE_PATHS = [
    _REF_IMAGES_DIR / "ref1.png",
    _REF_IMAGES_DIR / "ref2.jpg",
]

_FONT_PATHS = [
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]

# Vercel AI Gateway base URL
_GATEWAY_BASE = "https://ai-gateway.vercel.sh/v1"


# ── helpers ──────────────────────────────────────────────────────────────────

def _get_font(size: int):
    for path in _FONT_PATHS:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            pass
    return ImageFont.load_default()


def _load_image(image_url: str) -> Image.Image:
    """Load image from disk (full-res from manifest) or download as fallback."""
    if _MANIFEST_FILE.exists():
        try:
            manifest = json.loads(_MANIFEST_FILE.read_text(encoding="utf-8"))
            cached = manifest.get(image_url)
            if cached and Path(cached).exists():
                print(f"[create_post_image] ✅ Loaded from disk: {cached}")
                return Image.open(cached).convert("RGB")
        except Exception as e:
            print(f"[create_post_image] Manifest read failed: {e}")

    print(f"[create_post_image] Downloading from URL: {image_url[:80]}")
    resp = requests.get(
        image_url,
        timeout=20,
        headers={"User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)"},
    )
    resp.raise_for_status()
    return Image.open(io.BytesIO(resp.content)).convert("RGB")


def _make_image_filename(headline: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", headline.lower()).strip("-")[:50]
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"{slug}-{ts}.jpg"


def _square_crop(img: Image.Image, size: int = 1024) -> Image.Image:
    """Smart-crop and resize to a square."""
    sc = smartcrop.SmartCrop()
    result = sc.crop(img, size, size)
    crop = result['top_crop']
    x, y, w, h = crop['x'], crop['y'], crop['width'], crop['height']
    return img.crop((x, y, x + w, y + h)).resize(
        (size, size), Image.LANCZOS
    )


def _img_to_png_bytes(img: Image.Image) -> bytes:
    """Encode PIL image as PNG bytes."""
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf.getvalue()


def _load_ref_image_b64(path: Path, size: int = 1024) -> str | None:
    """Load a local reference brand image as base64 JPEG, resized to max `size` px."""
    if not path.exists():
        print(f"[create_post_image] ⚠️ Reference image not found: {path}")
        return None
    try:
        img = Image.open(path).convert("RGB")
        w, h = img.size
        if max(w, h) > size:
            scale = size / max(w, h)
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        b64 = base64.b64encode(buf.getvalue()).decode()
        print(f"[create_post_image] ✅ Loaded ref image: {path.name} ({len(b64)//1024} KB)")
        return b64
    except Exception as e:
        print(f"[create_post_image] ⚠️ Failed to load ref image {path}: {e}")
        return None


# ── Gemini 2.5 Flash Image via Vercel AI Gateway ─────────────────────────────

_MODEL = "google/gemini-2.5-flash-image"

def _gpt_image_edit(img: Image.Image, editing_prompt: str) -> Image.Image | None:
    """Edit a news photo using Gemini-2.5-Flash-Image via Vercel AI Gateway.

    Uses /v1/chat/completions — Gemini 2.5 Flash Image is a multimodal LLM that
    accepts image input AND generates image output.

    Returns edited PIL image or None on failure.
    """
    api_key = os.environ.get("AI_GATEWAY_API_KEY", "")
    if not api_key or api_key in ("", "your_vercel_ai_gateway_key_here"):
        print("[create_post_image] AI_GATEWAY_API_KEY not set -- skipping image edit.")
        return None

    # Encode the reference photo as base64 JPEG (1024x1024)
    img_sq = _square_crop(img, size=1024)
    buf = io.BytesIO()
    img_sq.save(buf, format="JPEG", quality=85)
    b64_img = base64.b64encode(buf.getvalue()).decode()
    print(f"[create_post_image] Reference image: {len(b64_img)//1024} KB (1024x1024 JPEG)")

    # ── Build multimodal content ────────────────────────────────────────────────
    # Order: brand reference images FIRST (visual style guide)
    #        then the news image to edit
    #        then the editing instruction prompt
    message_content: list[dict] = []

    # 1. Attach brand reference images so editing model can copy The ECHO style
    ref_instructions_added = False
    for i, ref_path in enumerate(_REF_IMAGE_PATHS, 1):
        ref_b64 = _load_ref_image_b64(ref_path)
        if ref_b64:
            if not ref_instructions_added:
                message_content.append({
                    "type": "text",
                    "text": (
                        "The following images are THE ECHO brand reference examples — "
                        "study them to understand the EXACT layout, color scheme, overlay style, "
                        "text placement, and brand identity you must reproduce:"
                    )
                })
                ref_instructions_added = True
            message_content.append({"type": "text", "text": f"ECHO Brand Reference Image {i}:"})
            message_content.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{ref_b64}"},
            })

    # 2. Attach the news image to be edited
    message_content.append({"type": "text", "text": "This is the NEWS IMAGE to edit (apply THE ECHO brand overlay to this):"})
    message_content.append({
        "type": "image_url",
        "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"},
    })

    # 3. Editing instruction
    message_content.append({"type": "text", "text": editing_prompt})

    payload = {
        "model": _MODEL,
        "messages": [
            {
                "role": "user",
                "content": message_content,
            }
        ],
        "modalities": ["image", "text"],
    }

    try:
        print(f"[create_post_image] Calling {_MODEL} via Vercel AI Gateway (chat/completions)...")
        resp = requests.post(
            f"{_GATEWAY_BASE}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=180,
        )
        print(f"[create_post_image] Gateway status: {resp.status_code}")

        # Save debug info
        _OUTPUT_DIR.mkdir(exist_ok=True)
        try:
            debug = {"status_code": resp.status_code, "response": resp.text[:8000]}
            (_OUTPUT_DIR / "gemini_debug.json").write_text(
                json.dumps(debug, indent=2), encoding="utf-8"
            )
        except Exception:
            pass

        if not resp.ok:
            print(f"[create_post_image] Error {resp.status_code}: {resp.text[:500]}")
            return None

        data = resp.json()
        message = data["choices"][0]["message"]

        # Vercel Gateway returns images in message.images array
        images = message.get("images", [])
        if images:
            img_data = images[0]["image_url"]["url"]
            _, encoded = img_data.split(",", 1)
            print("[create_post_image] Got image from message.images")
            return Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGB")

        # Fallback: check content list for image_url parts
        content = message.get("content", "")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    img_data = part["image_url"]["url"]
                    _, encoded = img_data.split(",", 1)
                    print("[create_post_image] Got image from content array")
                    return Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGB")

        print(f"[create_post_image] No image in response. Keys: {list(message.keys())}")
        print(f"[create_post_image] Text response: {str(content)[:200]}")
        return None

    except Exception as e:
        print(f"[create_post_image] Exception: {e}")
        return None



# ── PIL fallback (Removed) ───────────────────────────────────────────────────
# ── main tool ─────────────────────────────────────────────────────────────────

@tool(parse_docstring=True)
def create_post_image_gemini(
    image_url: str,
    headline_text: str,
    editing_prompt: str,
) -> str:
    """Edit the chosen news image using GPT-Image-1.5 and save as a social post.

    Loads the full-resolution image from disk (downloaded earlier by view_candidate_images),
    crops it to 1024×1024, and sends it to GPT-Image-1.5 via Vercel AI Gateway with
    your detailed editing prompt (quality=medium, size=1024x1024).

    Output saved as output/<headline-slug>-<timestamp>.jpg.

    Args:
        image_url: URL of the chosen image (used to look up the full-res file on disk).
        headline_text: Short headline (max 10 words) — used for filename.
        editing_prompt: Full creative editing instruction: layout name, kicker text,
            headline text, spice/teaser line, exact colors, position, and watermark.

    Returns:
        Status message with the output path.
    """
    _OUTPUT_DIR.mkdir(exist_ok=True)
    output_filename = _make_image_filename(headline_text)
    output_path = _OUTPUT_DIR / output_filename

    # Load image (full-res from disk or download)
    try:
        source_img = _load_image(image_url)
        print(f"[create_post_image] Source image size: {source_img.size}")
    except Exception as e:
        return f"❌ Could not load image: {e}"

    # Try GPT-Image-1.5 first
    result_img = _gpt_image_edit(source_img, editing_prompt)

    if result_img is not None:
        final = _square_crop(result_img, size=1024)
        final.save(str(output_path), "JPEG", quality=92)
        _LATEST_IMAGE_FILE.write_text(str(output_path), encoding="utf-8")
        return (
            f"✅ Image saved to {output_path} ({final.size[0]}×{final.size[1]}) "
            f"— GPT-Image-1.5 edit applied successfully."
        )

    # Raw crop fallback
    print("[create_post_image] ⚠️ Gemini edit failed — using raw 1024x1024 crop fallback.")
    try:
        final = _square_crop(source_img, size=1024)
        final.save(str(output_path), "JPEG", quality=92)
        _LATEST_IMAGE_FILE.write_text(str(output_path), encoding="utf-8")
        return (
            f"⚠️ Gemini edit failed — using raw square image as fallback.\n"
            f"Image saved to {output_path} ({final.size[0]}×{final.size[1]}).\n"
            f"Check output/gemini_debug.json to see the exact API error."
        )
    except Exception as e:
        return f"❌ Both GPT-Image-1.5 and PIL failed: {e}. No image created."
