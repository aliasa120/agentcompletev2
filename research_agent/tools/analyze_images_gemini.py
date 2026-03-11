"""Image selector and editing prompt generator using Gemini Flash vision.

New Flow (single Gemini call with full context):
1. Receives a list of candidate image URLs (already on disk from view_candidate_images).
2. Reads /social_posts.md and /design.md from disk (written in earlier steps).
3. Sends ALL images + both markdown files in ONE request to Gemini Flash (vision).
4. Gemini vision:
   - Sees all images simultaneously
   - Reads the social posts content to understand the story and tone
   - Reads the design guide to understand THE ECHO brand styles
   - Selects the SINGLE best image that fits the post scenario AND fits our design
   - Returns: chosen_image_url, editing_prompt (ready to pass to create_post_image_gemini)
5. Returns a structured response with the chosen URL and the full editing prompt.
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
_MANIFEST_FILE  = Path("output") / "candidate_images" / "manifest.json"
_SOCIAL_POSTS   = Path("social_posts.md")
_DESIGN_MD      = Path("design.md")
_MODEL          = "google/gemini-3-flash"   # vision model via Vercel AI Gateway
_GATEWAY_BASE   = "https://ai-gateway.vercel.sh/v1"

# Brand reference images — always loaded from local storage as visual style guides
_REF_IMAGES_DIR = Path("reference images")
_REF_IMAGE_PATHS = [
    _REF_IMAGES_DIR / "ref1.png",
    _REF_IMAGES_DIR / "ref2.jpg",
]

# ── Prompt sent alongside the images ─────────────────────────────────────────
_SELECTOR_PROMPT = """You are THE ECHO brand's visual director and photo editor.

You will receive:
1. Multiple candidate images (news photos to evaluate)
2. THE ECHO brand REFERENCE IMAGES — real published Echo post examples (labelled "ECHO BRAND REF IMAGE 1" and "ECHO BRAND REF IMAGE 2")
3. The social media posts (social_posts.md) — so you understand the story, tone, and platform text
4. The design guide (design.md) — so you understand THE ECHO's 6 brand styles

⚠️ CRITICAL: You must FIRST study the ECHO BRAND REF IMAGES carefully. These are real published examples of THE ECHO brand. Use them as your primary visual reference — do NOT invent or hallucinate the design. The design guide (design.md) describes these images in text, but the images themselves are the ground truth.

Your tasks:
A) Evaluate every CANDIDATE image (the news photos, NOT the reference images):
   - Reject any image with visible logos, chyrons, or watermarks from competing news outlets.
   - Assess quality (sharpness, lighting, composition).
   - Assess relevance (does it depict the actual story described in social_posts.md?).
   - Identify available text-safe zones (clear areas for overlay text without covering faces).
   - Which candidate image would look best when the THE ECHO brand overlay (as seen in the reference images) is applied?

B) Select the SINGLE best candidate image:
   - Highest quality + story-relevant + clean (no foreign branding) + has text-safe zones that align with THE ECHO brand style.

C) Pick the matching THE ECHO style (1-6) from design.md:
   - Match the news type (Breaking, Quote, Feature, Tabloid, Tech, Disaster/Grief).

D) Write a complete editing_prompt for create_post_image_gemini:
   - Start with: "Reproduce the layout shown in the attached THE ECHO brand reference images."
   - Include: style name and number, exact zone references (e.g. "top-left 40% sky area"),
     three text layers (KICKER, HEADLINE, SPICE LINE) with exact wording from social_posts.md,
     THE ECHO official colors: Deep Teal #0E4D4A (header bar, accents), Mustard Gold #CBA052 (category tag, highlights), Deep Charcoal #1A1A1A (text box background), White #FFFFFF (headline), Light Grey #E0E0E0 (sub-text).
   - Brand mark: THE ECHO wordmark on solid Deep Teal #0E4D4A bar, top-left.
   - Watermark: 'theecho.news.tv' bottom-right, small Mustard Gold text.
   - Finish with: "Preserve original photo quality, sharpness and colors exactly — only add overlay and text. Do not upscale, blur, or re-compress."

IMPORTANT: Return JSON — but if you cannot produce valid JSON, return the result as plain text with clearly labelled fields. Do NOT return empty output.
Preferred format (no markdown fences):
{
  "chosen_image_index": <int: 1-based index of the chosen candidate image>,
  "chosen_image_url": "<exact URL of chosen image>",
  "selection_reason": "<2-3 sentence explanation: why this image fits the story + design>",
  "rejected_images": [{"index": <int>, "reason": "<brief rejection reason>"}],
  "style_number": <int: 1-6>,
  "style_name": "<The ECHO style name>",
  "editing_prompt": "<complete editing instruction for create_post_image_gemini>"
}"""


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


def _load_ref_image_b64(path: Path, max_px: int = 1024) -> str | None:
    """Load a local reference brand image and return base64 JPEG."""
    if not path.exists():
        print(f"[analyze_images] ⚠️ Reference image not found: {path}")
        return None
    try:
        img = Image.open(path).convert("RGB")
        w, h = img.size
        if max(w, h) > max_px:
            scale = max_px / max(w, h)
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        b64 = base64.b64encode(buf.getvalue()).decode()
        print(f"[analyze_images] ✅ Loaded reference image: {path.name} ({len(b64)//1024} KB)")
        return b64
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


@tool(parse_docstring=True)
def analyze_images_gemini(image_urls: list[str]) -> str:
    """Select best news image and generate editing prompt using Gemini Flash vision.

    Sends all candidate images PLUS the social posts markdown and design guide to
    Gemini Flash (vision) in a SINGLE request. Gemini reads the post content, understands
    the news scenario, and:
    1. Rejects images with foreign branding or low quality.
    2. Selects the single best image that fits the story AND our brand design.
    3. Picks the correct THE ECHO style (1-6) from the design guide.
    4. Writes a complete editing_prompt for create_post_image_gemini.

    Use AFTER view_candidate_images. Pass your selected 3-5 image URLs.
    This replaces the old analyze → then agent crafts prompt workflow.
    Gemini now handles both selection AND prompt writing.

    After this tool returns, call create_post_image_gemini directly with the
    chosen_image_url and editing_prompt from this response.

    Args:
        image_urls: List of 3-5 selected image URLs from view_candidate_images.
                    These should be URLs previously returned by fetch_images_brave.

    Returns:
        JSON object with: chosen_image_url, selection_reason, style chosen, and
        the complete editing_prompt ready to pass to create_post_image_gemini.
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
        "(design.md not found — use THE ECHO 6 brand styles from your training)"
    )

    # ── Load images ───────────────────────────────────────────────────────────
    content_parts: list[dict] = []

    # Add context text first
    context_text = (
        f"=== SOCIAL POSTS (social_posts.md) ===\n\n{social_posts_content}\n\n"
        f"=== DESIGN GUIDE (design.md) ===\n\n{design_content}\n\n"
    )
    content_parts.append({"type": "text", "text": context_text})

    # ── Attach THE ECHO brand reference images FIRST ──────────────────────────
    # These images show the real published brand style — they guide Gemini to
    # reproduce the exact visual identity (not hallucinate a design).
    ref_images_loaded = 0
    for i, ref_path in enumerate(_REF_IMAGE_PATHS, 1):
        ref_b64 = _load_ref_image_b64(ref_path)
        if ref_b64:
            content_parts.append({
                "type": "text",
                "text": f"\n=== ECHO BRAND REF IMAGE {i} ('{ref_path.name}') — Study this for the real visual style ==="
            })
            content_parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{ref_b64}"},
            })
            ref_images_loaded += 1
        else:
            content_parts.append({
                "type": "text",
                "text": f"\n⚠️ ECHO BRAND REF IMAGE {i} could not be loaded (file: {ref_path}). Follow design.md instead."
            })

    print(f"[analyze_images_gemini] Brand reference images loaded: {ref_images_loaded}/{len(_REF_IMAGE_PATHS)}")

    # ── Now add the candidate news images ─────────────────────────────────────
    content_parts.append({
        "type": "text",
        "text": (
            f"\n=== CANDIDATE NEWS IMAGES ===\n"
            f"Below are {len(urls)} candidate images (indexed 1 to {len(urls)}). "
            "Evaluate all of them against the posts and design guide above. "
            "DO NOT choose the reference images — choose from the candidate images below only."
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
            content_parts.append({"type": "text", "text": f"\n--- Candidate Image {i}: {url} (⚠️ failed to load)"})

    # Add final instruction
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
        print(f"[analyze_images_gemini] Sending {len(valid_urls)} images + posts + design to {_MODEL}...")
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
        # Return raw if JSON parsing fails — agent can still read it
        return (
            f"⚠️ Gemini returned non-JSON response. Read the raw output below and "
            f"extract the chosen image URL and editing prompt manually:\n\n{raw_text}"
        )

    # ── Format output for agent ───────────────────────────────────────────────
    chosen_url    = result.get("chosen_image_url", "")
    chosen_idx    = result.get("chosen_image_index", "?")
    reason        = result.get("selection_reason", "")
    style_num     = result.get("style_number", "?")
    style_name    = result.get("style_name", "")
    editing_prompt = result.get("editing_prompt", "")
    rejected      = result.get("rejected_images", [])

    output_lines = [
        "🎯 GEMINI IMAGE SELECTION RESULT",
        "=" * 60,
        f"\n✅ CHOSEN IMAGE (index {chosen_idx}):",
        f"   URL: {chosen_url}",
        f"   Reason: {reason}",
        f"\n🎨 STYLE SELECTED: Style {style_num} — {style_name}",
    ]

    if rejected:
        output_lines.append("\n❌ REJECTED IMAGES:")
        for r in rejected:
            output_lines.append(f"   Image {r.get('index', '?')}: {r.get('reason', '')}")

    output_lines += [
        "\n📝 EDITING PROMPT (pass this to create_post_image_gemini):",
        "─" * 60,
        editing_prompt,
        "─" * 60,
        "\n✅ NEXT STEP: Call create_post_image_gemini with:",
        f"   image_url=\"{chosen_url}\"",
        "   headline_text=\"<first ~8 words from your X post>\"",
        "   editing_prompt=\"<the editing prompt above>\"",
    ]

    return "\n".join(output_lines)
