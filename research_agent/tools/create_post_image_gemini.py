"""Create social post image using KIE AI GPT-Image-1.5 via the KIE AI API.

Flow:
1. Load the full-resolution target image from disk (saved by view_candidate_images).
2. Upload the target image to Supabase Storage (required — news site URLs have hotlink protection).
3. Send to KIE AI with the editing_prompt and BOTH THE ECHO reference images as style guides.
4. Poll for completion, download the result.
5. Fall back to saving the raw target image if KIE AI fails.
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


# ── Constants ─────────────────────────────────────────────────────────────────
# Use absolute paths anchored to the repo root so they work in Docker/LangGraph
_REPO_ROOT         = Path(__file__).resolve().parents[2]   # research_agent/tools/ -> repo root
_OUTPUT_DIR        = _REPO_ROOT / "output"
_MANIFEST_FILE     = _OUTPUT_DIR / "candidate_images" / "manifest.json"
_LATEST_IMAGE_FILE = _OUTPUT_DIR / "latest_image_path.txt"

# THE ECHO brand reference images — served from Cloudflare R2
_R2_BASE = "https://pub-61765db165154158829d1ed1ff18c3e0.r2.dev/ref%20images"
_REF_URLS = [
    f"{_R2_BASE}/ref1.png",
    f"{_R2_BASE}/ref2.png",
]

_FONT_PATHS = [
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]

_GATEWAY_BASE = "https://ai-gateway.vercel.sh/v1"


# ── Helpers ───────────────────────────────────────────────────────────────────

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


def _make_image_filename(editing_prompt: str) -> str:
    """Extract headline from editing_prompt JSON for filename slug. Falls back to timestamp-only."""
    try:
        # editing_prompt may be a JSON string or already a dict
        data = json.loads(editing_prompt) if isinstance(editing_prompt, str) else editing_prompt
        headline = data.get("text_layers", {}).get("headline", "")
        if headline:
            slug = re.sub(r"[^a-z0-9]+", "-", headline.lower()).strip("-")[:50]
            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            return f"{slug}-{ts}.jpg"
    except Exception:
        pass
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"post-image-{ts}.jpg"


def _upload_target_to_supabase(pil_img: Image.Image, slug: str) -> str | None:
    """Upload target image to Supabase Storage so KIE AI can access it.

    News website URLs are often blocked by hotlink protection.
    Supabase provides a guaranteed-accessible public URL for KIE AI.
    Returns public URL or None if upload fails.
    """
    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    api_key = os.environ.get("SUPABASE_ANON_KEY", "")
    if not supabase_url or not api_key:
        print("[create_post_image] ⚠️ SUPABASE_URL/KEY not set — KIE AI will use original URL (may fail)")
        return None

    buf = io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=92)
    img_bytes = buf.getvalue()

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"kie-targets/{slug}-{timestamp}.jpg"
    upload_url = f"{supabase_url}/storage/v1/object/post-images/{filename}"

    headers = {
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "image/jpeg",
        "x-upsert": "true",
    }
    try:
        resp = requests.post(upload_url, headers=headers, data=img_bytes, timeout=(10, 30))
        if resp.ok:
            public_url = f"{supabase_url}/storage/v1/object/public/post-images/{filename}"
            print(f"[create_post_image] ✅ Target uploaded to Supabase: {public_url}")
            return public_url
        else:
            print(f"[create_post_image] ⚠️ Supabase upload failed ({resp.status_code}) — will use original URL")
            return None
    except Exception as e:
        print(f"[create_post_image] ⚠️ Supabase upload error: {e} — will use original URL")
        return None


# ── KIE AI Image-to-Image ─────────────────────────────────────────────────────

def _kie_image_edit(target_url: str, editing_prompt: str) -> Image.Image | None:
    """Edit a news photo using KIE AI GPT-Image-1.5.

    Sends the target image plus BOTH THE ECHO reference images.
    Retries createTask once (2 total attempts, 10s wait) on any error.
    Returns edited PIL image or None on failure.
    """
    import time

    api_key = os.environ.get("KIE_API_KEY", "")
    if not api_key:
        print("[create_post_image] KIE_API_KEY not set — skipping image edit.")
        return None

    # Target image first, then both reference images
    input_urls = [target_url] + _REF_URLS
    print(f"[create_post_image] KIE input: 1 target + {len(_REF_URLS)} reference images")

    full_prompt = (
        "TASK: Apply THE ECHO brand style from the reference images to the FIRST TARGET NEWS IMAGE.\n"
        "CRITICAL: Keep the original photographic content of the TARGET NEWS IMAGE exactly as it is.\n"
        "DO NOT blend or copy any photographic elements from the reference images into the target image.\n"
        "ONLY apply the layout, typography, color overlays, and brand elements shown in the reference images.\n"
        "EDITING INSTRUCTIONS:\n"
        + editing_prompt
    )

    payload = {
        "model": "gpt-image/1.5-image-to-image",
        "input": {
            "input_urls": input_urls,
            "prompt": full_prompt,
            "aspect_ratio": "1:1",
            "quality": "medium",
        }
    }

    try:
        # Retry 2: attempt createTask up to 2 times with 10s wait
        task_id = None
        for create_attempt in range(1, 3):
            try:
                print(f"[create_post_image] Calling KIE AI API (createTask) attempt {create_attempt}/2...")
                resp = requests.post(
                    "https://api.kie.ai/api/v1/jobs/createTask",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                    timeout=60,
                )
                resp.raise_for_status()
                data = resp.json()

                if data.get("code") != 200:
                    raise RuntimeError(f"KIE API returned code {data.get('code')}: {data}")

                task_id = data.get("data", {}).get("taskId")
                if not task_id:
                    raise RuntimeError("No taskId returned from KIE API")

                print(f"[create_post_image] KIE task created: {task_id}")
                break  # success — stop retrying

            except Exception as e:
                print(f"[create_post_image] createTask attempt {create_attempt}/2 failed: {e}")
                if create_attempt < 2:
                    print("[create_post_image] Waiting 10s before retry...")
                    time.sleep(10)
                else:
                    print("[create_post_image] KIE createTask failed after 2 attempts — falling back to raw image.")
                    return None

        print(f"[create_post_image] Polling for completion (task {task_id})...")

        max_attempts = 120
        for i in range(max_attempts):
            time.sleep(3)
            poll_resp = requests.get(
                f"https://api.kie.ai/api/v1/jobs/recordInfo?taskId={task_id}",
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=20,
            )
            poll_resp.raise_for_status()
            poll_data = poll_resp.json()

            if poll_data.get("code") != 200:
                print(f"[create_post_image] KIE Poll Error: {poll_data}")
                return None

            state = poll_data.get("data", {}).get("state")
            if state == "success":
                result_str = poll_data.get("data", {}).get("resultJson", "{}")
                result_json = json.loads(result_str)
                result_urls = result_json.get("resultUrls", [])
                if result_urls:
                    final_url = result_urls[0]
                    print(f"[create_post_image] KIE Success! Downloading from {final_url} (with retries)...")

                    img_resp = None
                    for attempt in range(3):
                        try:
                            img_resp = requests.get(final_url, timeout=60)
                            img_resp.raise_for_status()
                            break
                        except Exception as e:
                            print(f"[create_post_image] Download attempt {attempt+1} failed: {e}")
                            if attempt < 2:
                                time.sleep(2)
                            else:
                                raise e

                    if img_resp and img_resp.ok:
                        return Image.open(io.BytesIO(img_resp.content)).convert("RGB")

                print(f"[create_post_image] KIE Success but no resultUrls or download failed: {result_str}")
                return None

            elif state == "fail":
                fail_msg = poll_data.get("data", {}).get("failMsg", "Unknown failure")
                print(f"[create_post_image] KIE Task Failed: {fail_msg}")
                return None

            print(f"[create_post_image] Task {task_id} state: {state} ... ({i+1}/{max_attempts})")

        print(f"[create_post_image] Polling timed out for task {task_id}.")
        return None

    except Exception as e:
        print(f"[create_post_image] KIE Exception: {e}")
        return None


# ── Main Tool ─────────────────────────────────────────────────────────────────

@tool(parse_docstring=True)
def create_post_image_gemini(
    image_url: str,
    editing_prompt: str,
) -> str:
    """Edit the chosen news image using KIE AI and save as a social post.

    Loads the full-resolution target image from disk, uploads it to Supabase Storage
    (to avoid hotlink blocking), then calls KIE AI with the editing prompt and BOTH
    THE ECHO reference images (ref1.png, ref2.png) as style guides.

    The headline is already embedded inside editing_prompt (written by analyze_images_gemini
    from the blog title). Do NOT pass a separate headline_text — it is not needed.

    Output is saved as output/<headline-slug>-<timestamp>.jpg.

    Args:
        image_url: URL of the chosen image (used to look up the full-res file on disk).
        editing_prompt: Full editing instruction JSON string from analyze_images_gemini.
                        Contains the headline inside text_layers.headline.

    Returns:
        Absolute POSIX path to the saved output image.
    """
    _OUTPUT_DIR.mkdir(exist_ok=True)
    output_filename = _make_image_filename(editing_prompt)
    output_path = _OUTPUT_DIR / output_filename

    # Load target image (full-res from disk or download)
    try:
        source_img = _load_image(image_url)
        print(f"[create_post_image] Source image size: {source_img.size}")
    except Exception as e:
        return f"❌ Could not load image: {e}"

    # Derive slug from the headline embedded in editing_prompt (for Supabase path)
    try:
        ep_data = json.loads(editing_prompt) if isinstance(editing_prompt, str) else editing_prompt
        headline_for_slug = ep_data.get("text_layers", {}).get("headline", "post-image")
    except Exception:
        headline_for_slug = "post-image"
    slug = re.sub(r"[^a-z0-9]+", "-", headline_for_slug.lower())[:40].strip("-")

    kie_target_url = _upload_target_to_supabase(source_img, slug) or image_url
    print(f"[create_post_image] KIE AI target URL: {kie_target_url[:80]}...")
    print(f"[create_post_image] KIE AI reference URLs: {_REF_URLS}")

    # Call KIE AI
    result_img = _kie_image_edit(kie_target_url, editing_prompt)

    if result_img is not None:
        result_img.save(str(output_path), "JPEG", quality=92)
        _LATEST_IMAGE_FILE.write_text(str(output_path), encoding="utf-8")
        return output_path.resolve().as_posix()

    # Fallback: save raw target image
    print("[create_post_image] ⚠️ KIE AI edit failed — using raw image fallback.")
    base_name = output_path.stem
    fallback_path = output_path.with_name(f"{base_name}-fallback.jpg")
    try:
        source_img.save(str(fallback_path), "JPEG", quality=92)
        _LATEST_IMAGE_FILE.write_text(str(fallback_path), encoding="utf-8")
        return fallback_path.resolve().as_posix()
    except Exception as e:
        return f"❌ Failed to save fallback image: {e}"
