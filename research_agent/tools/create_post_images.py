"""Social media image creation tool — resize + text overlay with PIL."""

import io
import textwrap
from pathlib import Path

import requests
from langchain_core.tools import tool
from PIL import Image, ImageDraw, ImageFont

# Platform canvas sizes (width x height in pixels)
PLATFORM_SPECS: dict[str, tuple[int, int]] = {
    "twitter": (1200, 675),    # 16:9
    "instagram": (1080, 1080), # 1:1 square
    "facebook": (1200, 630),   # ~1.91:1
}

_FONTS_DIR = Path(__file__).parent / "fonts"
_OUTPUT_DIR = Path("output")


def _get_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Load Roboto Bold; fall back to common system fonts, then PIL default."""
    candidates = [
        _FONTS_DIR / "Roboto-Bold.ttf",
        Path(r"C:\Windows\Fonts\arialbd.ttf"),       # Windows Arial Bold
        Path(r"C:\Windows\Fonts\calibrib.ttf"),       # Windows Calibri Bold
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),  # Linux
        Path("/System/Library/Fonts/Helvetica.ttc"),  # macOS
    ]
    for path in candidates:
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size)
            except Exception:
                continue
    return ImageFont.load_default()


def _center_crop(image: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """Crop image to the target aspect ratio from the centre, then resize."""
    src_w, src_h = image.size
    tgt_ratio = target_w / target_h
    src_ratio = src_w / src_h

    if src_ratio > tgt_ratio:
        # Image is wider than needed — trim sides
        new_w = int(src_h * tgt_ratio)
        left = (src_w - new_w) // 2
        image = image.crop((left, 0, left + new_w, src_h))
    else:
        # Image is taller than needed — trim top/bottom
        new_h = int(src_w / tgt_ratio)
        top = (src_h - new_h) // 2
        image = image.crop((0, top, src_w, top + new_h))

    return image.resize((target_w, target_h), Image.LANCZOS)


def _add_text_overlay(image: Image.Image, headline: str) -> Image.Image:
    """Add a professional news-card style overlay.

    Layout:
    - Subtle dark vignette over the whole image
    - White rounded rectangle at the bottom 38%
    - Red left-edge accent bar inside the white box
    - Bold black headline text (title-case)
    - Red diagonal accent strip at the very bottom edge
    """
    img = image.copy().convert("RGBA")
    w, h = img.size

    # ── 1. Subtle vignette (keeps image visible but darkens edges) ──────────
    vignette = Image.new("RGBA", img.size, (0, 0, 0, 0))
    v_draw = ImageDraw.Draw(vignette)
    vig_h = int(h * 0.55)
    for y in range(vig_h):
        alpha = int(110 * (y / vig_h))
        v_draw.line([(0, h - vig_h + y), (w, h - vig_h + y)], fill=(0, 0, 0, alpha))
    img = Image.alpha_composite(img, vignette)

    draw = ImageDraw.Draw(img)

    # ── 2. Calculate text layout first, then size the box around it ──────────
    font_size = max(28, w // 24)
    font = _get_font(font_size)
    small_font = _get_font(max(14, w // 42))

    margin = int(w * 0.05)
    bar_w = int(w * 0.012)
    text_x = margin + bar_w + int(w * 0.025)
    text_area_w = w - text_x - margin - int(w * 0.02)

    chars_per_line = max(14, int(text_area_w / (font_size * 0.58)))
    headline_tc = headline.title()
    wrapped_lines = textwrap.wrap(headline_tc, width=chars_per_line)[:3]

    line_spacing = int(font_size * 1.3)
    text_block_h = len(wrapped_lines) * line_spacing

    # Padding inside the box (top/bottom)
    v_padding = int(h * 0.022)
    small_font_h = int(small_font.size if hasattr(small_font, 'size') else 14)
    card_h = text_block_h + v_padding * 2 + small_font_h + int(h * 0.01)
    # minimum sensible height
    card_h = max(card_h, int(h * 0.20))

    bottom_strip_h = int(h * 0.028)
    card_top = h - card_h - bottom_strip_h - int(h * 0.01)
    radius = int(w * 0.022)

    # Draw rounded white rectangle
    draw.rounded_rectangle(
        [margin, card_top, w - margin, h - bottom_strip_h - int(h * 0.008)],
        radius=radius,
        fill=(255, 255, 255, 242),
    )

    # ── 3. Red left-edge accent bar ─────────────────────────────────────────
    bar_x = margin
    bar_padding_v = int(h * 0.014)
    draw.rounded_rectangle(
        [bar_x, card_top + bar_padding_v, bar_x + bar_w, h - bottom_strip_h - int(h * 0.022)],
        radius=int(bar_w // 2),
        fill=(220, 30, 35, 255),
    )

    # ── 4. Headline text ─────────────────────────────────────────────────────
    text_y = card_top + v_padding
    for i, line in enumerate(wrapped_lines):
        color = (220, 30, 35, 255) if i == 0 else (20, 20, 20, 255)
        draw.text((text_x, text_y), line, font=font, fill=color)
        text_y += line_spacing

    # Source watermark — tight below text
    draw.text(
        (w - margin - 4, h - bottom_strip_h - int(h * 0.018)),
        "newsagent.ai",
        font=small_font,
        fill=(140, 140, 140, 210),
        anchor="rs",
    )

    # ── 5. Red bottom strip ──────────────────────────────────────────────────
    strip_y = h - bottom_strip_h
    draw.rectangle([0, strip_y, w, h], fill=(220, 30, 35, 235))
    draw.polygon(
        [(0, strip_y), (int(w * 0.12), strip_y), (0, h)],
        fill=(255, 255, 255, 45),
    )

    return img.convert("RGB")


@tool(parse_docstring=True)
def create_post_images(image_url: str, headline_text: str) -> str:
    """Download a chosen OG image and create 3 platform-sized versions with text.

    Downloads the image, centre-crops and resizes it for X (Twitter),
    Instagram, and Facebook, then adds a dark gradient overlay with bold
    white headline text.  Outputs are saved to output/twitter.png,
    output/instagram.png, output/facebook.png.

    Args:
        image_url: Direct URL of the OG image chosen from fetch_images_exa.
                   Must be a direct image URL (jpg / png / webp).
        headline_text: Short catchy headline for the text overlay — max 10 words.
                       Use the hook line from your X post, e.g.
                       "PTI Leader Detained Amid Protest Crackdown".

    Returns:
        File paths of all 3 saved images, or an error message if the
        download or processing failed.
    """
    _OUTPUT_DIR.mkdir(exist_ok=True)

    # Download source image
    try:
        resp = requests.get(
            image_url,
            timeout=12,
            headers={"User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)"},
        )
        resp.raise_for_status()
        source = Image.open(io.BytesIO(resp.content)).convert("RGB")
    except Exception as e:
        return (
            f"Failed to download image from {image_url}: {e}. "
            "Skip image pipeline — save social_posts.md without images."
        )

    # Create one image per platform
    saved: dict[str, str] = {}
    for platform, (pw, ph) in PLATFORM_SPECS.items():
        try:
            cropped = _center_crop(source, pw, ph)
            final = _add_text_overlay(cropped, headline_text)
            out_path = _OUTPUT_DIR / f"{platform}.png"
            final.save(str(out_path), "PNG", optimize=True)
            saved[platform] = str(out_path)
        except Exception as e:
            saved[platform] = f"ERROR: {e}"

    lines = ["PLATFORM IMAGES CREATED SUCCESSFULLY:\n"]
    for platform, path in saved.items():
        lines.append(f"  {platform.capitalize():12s} → {path}")
    lines.append(
        "\nUpdate social_posts.md — add an '## Images' section with these paths."
    )
    return "\n".join(lines)
