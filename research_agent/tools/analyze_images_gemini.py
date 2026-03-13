"""Image selector and editing prompt generator using Gemini Flash vision.

Simplified Flow (single Gemini call):
1. Receives a list of candidate image URLs (already on disk from view_candidate_images).
2. Reads social_posts.md and design.md from disk.
3. Loads both THE ECHO reference images (ref1.png, ref2.png) from local disk.
4. Sends ALL candidate images + both ref images + markdown files to Gemini Flash vision.
5. Gemini:
   - Reads social_posts.md to understand the story
   - Evaluates each candidate image for quality and relevance
   - Selects the single BEST candidate image
   - Studies the reference images (ref1.png, ref2.png) and design.md carefully
   - Writes a detailed editing prompt to apply THE ECHO brand style to the chosen image
6. Returns chosen_image_url and editing_prompt for create_post_image_gemini.
"""

import base64
import io
import json
import os
from pathlib import Path

import requests
from langchain_core.tools import tool
from PIL import Image

# ── Config ────────────────────────────────────────────────────────────────────
_MANIFEST_FILE = Path("output") / "candidate_images" / "manifest.json"
_SOCIAL_POSTS  = Path("social_posts.md")
_DESIGN_MD     = Path("design.md")
_MODEL         = "google/gemini-3-flash"
_GATEWAY_BASE  = "https://ai-gateway.vercel.sh/v1"

# Two THE ECHO brand reference images
_REF_IMAGES_DIR = Path("reference images")
_REF_IMAGE_PATHS = [
    _REF_IMAGES_DIR / "ref1.png",
    _REF_IMAGES_DIR / "ref2.png",
]

# ── Prompt ────────────────────────────────────────────────────────────────────
_SELECTOR_PROMPT = """
ROLE: You are an expert Visual Editor for THE ECHO news brand.
Your job: choose the best news photo from the candidates, then write a precise editing prompt.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1 — Understand the News Story
Read social_posts.md carefully:
- What is the topic, urgency level, and tone?
- What kind of visual best matches the story (person, place, event, protest, etc.)?

STEP 2 — Evaluate All Candidate Images
For each candidate image, assess:
- Image quality: Is it sharp, well-lit, and high resolution?
- Relevance: Does it match the story's topic?
- Composition: Is there empty space for text overlays (top or bottom)?
- Problems: Reject images with foreign news logos, chyrons, blurriness, or unrelated content.

STEP 3 — Select the Single Best Candidate Image
Pick the ONE image that best matches the story and has the best quality.
Return its EXACT URL as chosen_image_url.

STEP 4 — Study the Reference Images and Design Guide
You have been given:
  [REF1] — THE ECHO reference image 1
  [REF2] — THE ECHO reference image 2
  design.md — THE ECHO complete brand guide

Study them carefully and note:
- The exact layout geometry (header bar, photo zone, text box at the bottom)
- The color palette from design.md: Deep Teal #0E4D4A, Mustard Gold #CBA052, White #FFFFFF
- Typography style (font weight, capitalization, headline formatting)
- Graphical details (inset white border, mustard gold accent elements, logo position)
- The THE ECHO logo style (globe/soundwave icon + THE ECHO wordmark)

⛔ DO NOT copy photographic content from ref images into the target image.
⛔ DO NOT use any logos other than THE ECHO logo from design.md.
The reference images show THE ECHO's STYLE — apply that same style to the chosen candidate image.

STEP 5 — Write the Editing Prompt
Write a detailed, specific editing_prompt JSON object that instructs the editor
to apply THE ECHO brand style to the selected candidate image.

The editing_prompt MUST be a valid JSON object with these keys:
{
    "strict_instruction": "Apply THE ECHO brand style (as shown in the reference images) to the TARGET image. DO NOT modify the target photo itself. DO NOT copy any photo content from reference images. ONLY add the brand overlay elements.",
    "layout_geometry": {
        "top_header_bar": "<describe EXACTLY what you saw in the ref images — height, color, contents>",
        "bottom_text_box": "<describe EXACTLY — size, color, shape, transparency>",
        "inset_border": "<describe EXACTLY — color, thickness>",
        "photo_zone": "<describe where the target photo sits>"
    },
    "colors": {
        "primary": "#0E4D4A",
        "accent": "#CBA052",
        "background": "#0E4D4A",
        "text_main": "#FFFFFF",
        "text_sub": "#CBA052"
    },
    "text_layers": {
        "kicker_tag": "<content from social_posts.md — e.g. '# NEWS' or 'BREAKING'>",
        "headline": "<actual headline text from social_posts.md>",
        "sub_headline": "<actual sub-headline or summary text from social_posts.md>"
    },
    "watermarks_and_logos": {
        "logo": "THE ECHO wordmark with globe/soundwave icon — top header bar, centered, white",
        "footer": "theecho.news.tv — bottom of image, small white text",
        "restriction": "NO logos from other news networks. NO Gemini AI watermark/sparkle."
    }
}

STEP 6 — Return JSON result
Return ONLY this JSON structure (no extra text):
{
  "chosen_image_url": "<exact URL of chosen candidate>",
  "selection_reason": "<brief reason for choosing this image>",
  "editing_prompt": <the JSON object from STEP 5 — NOT as a string, as a nested object>
}
"""


# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_image_b64(url: str, max_px: int = 800) -> str | None:
    """Load image from disk manifest (or download) and return base64 JPEG."""
    raw = None

    if _MANIFEST_FILE.exists():
        try:
            manifest = json.loads(_MANIFEST_FILE.read_text(encoding="utf-8"))
            fpath = manifest.get(url)
            if fpath and Path(fpath).exists():
                raw = Path(fpath).read_bytes()
        except Exception:
            pass

    if raw is None:
        try:
            r = requests.get(
                url,
                timeout=15,
                headers={"User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)"},
            )
            r.raise_for_status()
            raw = r.content
        except Exception as e:
            print(f"[analyze_images] Download failed for {url[:60]}: {e}")
            return None

    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        w, h = img.size
        if max(w, h) > max_px:
            scale = max_px / max(w, h)
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        return base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        print(f"[analyze_images] Image encode failed: {e}")
        return None


def _load_ref_image_b64(path: Path) -> tuple[str, str] | None:
    """Load a local reference brand image and return (mime_type, base64) at full quality."""
    if not path.exists():
        print(f"[analyze_images] ⚠️ Reference image not found: {path}")
        return None
    try:
        raw_bytes = path.read_bytes()
        b64 = base64.b64encode(raw_bytes).decode("utf-8")
        mime_type = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
        print(f"[analyze_images] ✅ Loaded reference image: {path.name} ({len(b64)//1024} KB)")
        return mime_type, b64
    except Exception as e:
        print(f"[analyze_images] ⚠️ Failed to load reference image {path}: {e}")
        return None


def _read_file(path: Path, fallback: str) -> str:
    """Read a markdown context file, return fallback string if missing."""
    if path.exists():
        try:
            return path.read_text(encoding="utf-8")
        except Exception:
            pass
    return fallback


# ── Main Tool ─────────────────────────────────────────────────────────────────

@tool(parse_docstring=True)
def analyze_images_gemini(image_urls: list[str]) -> str:
    """Select best news image and generate THE ECHO editing prompt using Gemini Flash vision.

    Sends all candidate images PLUS both THE ECHO reference images (ref1.png, ref2.png)
    and the design guide to Gemini Flash vision in ONE request.

    Gemini:
    1. Reads social_posts.md to understand the story.
    2. Evaluates all candidate images for quality and relevance.
    3. Selects the single best candidate image.
    4. Studies both reference images and design.md to understand THE ECHO brand.
    5. Writes a detailed editing prompt to apply THE ECHO style to the chosen image.

    Use AFTER view_candidate_images. Pass 3-5 image URLs.
    After this returns, call create_post_image_gemini with the chosen_image_url and editing_prompt.

    Args:
        image_urls: List of 3-5 candidate image URLs from view_candidate_images.

    Returns:
        JSON with chosen_image_url and editing_prompt ready for create_post_image_gemini.
    """
    urls = image_urls[:5]
    if not urls:
        return "No image URLs provided."

    # ── Load context files ────────────────────────────────────────────────────
    social_posts_content = _read_file(
        _SOCIAL_POSTS,
        "(social_posts.md not found — proceeding without post context)"
    )
    design_content = _read_file(
        _DESIGN_MD,
        "(design.md not found — use THE ECHO brand colors: #0E4D4A, #CBA052, #FFFFFF)"
    )

    # ── Build message content ─────────────────────────────────────────────────
    content_parts: list[dict] = []

    # Context text first
    context_text = (
        f"=== SOCIAL POST CONTENT (social_posts.md) ===\n\n{social_posts_content}\n\n"
        f"=== DESIGN GUIDE (design.md) ===\n\n{design_content}\n\n"
    )
    content_parts.append({"type": "text", "text": context_text})

    # ── Attach THE ECHO reference images ──────────────────────────────────────
    content_parts.append({
        "type": "text",
        "text": (
            "\n=== THE ECHO BRAND REFERENCE IMAGES ===\n"
            "Study these carefully. Apply their layout, typography, and brand style to the chosen candidate image.\n"
            "DO NOT copy their photographic content. DO NOT use their logos — use 'THE ECHO' logo from design.md."
        )
    })

    ref_images_loaded = 0
    for i, ref_path in enumerate(_REF_IMAGE_PATHS, 1):
        ref_data = _load_ref_image_b64(ref_path)
        if ref_data:
            mime_type, ref_b64 = ref_data
            content_parts.append({
                "type": "text",
                "text": f"\n--- Reference Image {i} (REF{i}): {ref_path.name} ---"
            })
            content_parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime_type};base64,{ref_b64}"},
            })
            ref_images_loaded += 1
        else:
            content_parts.append({
                "type": "text",
                "text": f"\n⚠️ Reference image REF{i} ({ref_path.name}) could not be loaded."
            })

    print(f"[analyze_images_gemini] Reference images loaded: {ref_images_loaded}/{len(_REF_IMAGE_PATHS)}")

    # ── Add candidate news images ─────────────────────────────────────────────
    content_parts.append({
        "type": "text",
        "text": (
            f"\n=== CANDIDATE NEWS IMAGES ===\n"
            f"Below are {len(urls)} candidate images. Choose the BEST ONE for the story above.\n"
            "Evaluate quality, relevance, and composition. DO NOT choose the reference images above."
        )
    })

    valid_urls: list[str] = []
    for i, url in enumerate(urls, 1):
        b64 = _load_image_b64(url)
        if b64:
            content_parts.append({"type": "text", "text": f"\n--- Candidate Image {i}: {url}"})
            content_parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
            })
            valid_urls.append(url)
            print(f"[analyze_images_gemini] Loaded candidate image {i}: {url[:60]}")
        else:
            content_parts.append({
                "type": "text",
                "text": f"\n--- Candidate Image {i}: {url} (⚠️ failed to load — skip this one)"
            })

    # Add the main instruction prompt at the end
    content_parts.append({"type": "text", "text": _SELECTOR_PROMPT})

    if not valid_urls:
        return "❌ All image downloads failed. Cannot analyze."

    # ── Call Gemini Flash Vision ──────────────────────────────────────────────
    api_key = os.environ.get("AI_GATEWAY_API_KEY", "")
    if not api_key:
        return "❌ AI_GATEWAY_API_KEY not set. Cannot call Gemini vision."

    payload = {
        "model": _MODEL,
        "messages": [{"role": "user", "content": content_parts}],
        "temperature": 0.1,
        "max_tokens": 4096,
    }

    try:
        print(f"[analyze_images_gemini] Sending {len(valid_urls)} candidates + 2 ref images to {_MODEL}...")
        resp = requests.post(
            f"{_GATEWAY_BASE}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=120,
        )
        resp.raise_for_status()
        raw_text = resp.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:
        return f"❌ Gemini vision API error: {e}"

    # ── Parse JSON response ───────────────────────────────────────────────────
    import re
    if "```" in raw_text:
        fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw_text, re.DOTALL)
        if fence:
            raw_text = fence.group(1)
        else:
            raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text)
            raw_text = re.sub(r"\s*```$", "", raw_text)

    if not raw_text.startswith("{"):
        brace = re.search(r"\{.*\}", raw_text, re.DOTALL)
        if brace:
            raw_text = brace.group(0)

    try:
        result = json.loads(raw_text)
    except json.JSONDecodeError:
        return (
            f"⚠️ Gemini returned non-JSON response. Read the raw output below and "
            f"extract the chosen image URL and editing prompt manually:\n\n{raw_text}"
        )

    # ── Extract fields ────────────────────────────────────────────────────────
    chosen_url = result.get("chosen_image_url", "")
    reason = result.get("selection_reason", "")
    editing_prompt = result.get("editing_prompt", "")

    # Gemini sometimes returns editing_prompt as a dict — serialize to string
    if isinstance(editing_prompt, dict):
        editing_prompt = json.dumps(editing_prompt, indent=2)

    output_lines = [
        "🎯 GEMINI IMAGE SELECTION RESULT",
        "=" * 60,
        f"\n✅ CHOSEN IMAGE:",
        f"   URL: {chosen_url}",
        f"   Reason: {reason}",
        "\n📝 EDITING PROMPT (pass this to create_post_image_gemini):",
        "─" * 60,
        editing_prompt,
        "─" * 60,
        "\n✅ NEXT STEP: Call create_post_image_gemini with:",
        f'   image_url="{chosen_url}"',
        '   headline_text="<first ~8 words from your X post>"',
        '   editing_prompt="<the editing prompt above>"',
    ]

    return "\n".join(output_lines)
