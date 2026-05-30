"""Image downloader and text-based metadata reporter.

Flow (text-based selection — no vision model needed):
1. Receives image URLs from fetch_images_brave (already has title + source text).
2. Downloads ALL images at FULL RESOLUTION to disk (output/candidate_images/).
3. Returns a text-only manifest with: URL, title, source, resolved filename, dimensions.
4. Agent reads the text metadata + Brave's title/source to select the best 3-5 images.
5. Passes those URLs to analyze_images_gemini, which sends them to the vision model.
"""

import io
import json
from pathlib import Path
from typing import Any

import requests
from langchain_core.tools import tool
from PIL import Image


_CANDIDATE_DIR = Path("output") / "candidate_images"
_MANIFEST_FILE = _CANDIDATE_DIR / "manifest.json"


def _download_and_save(url: str, save_path: Path) -> dict:
    """Download an image, save full-res, return metadata dict."""
    try:
        r = requests.get(
            url,
            timeout=15,
            headers={"User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)"},
        )
        r.raise_for_status()
        raw = r.content

        img = Image.open(io.BytesIO(raw)).convert("RGB")
        w, h = img.size
        img.save(str(save_path), "JPEG", quality=95)

        return {
            "ok": True,
            "path": str(save_path),
            "width": w,
            "height": h,
            "size_kb": len(raw) // 1024,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


@tool(parse_docstring=True)
def view_candidate_images(image_urls: list[str]) -> str:
    """Download candidate images to disk and return text metadata for selection.

    Downloads every image at FULL RESOLUTION to disk (for Gemini editing later),
    then returns a text-only list of metadata so you can select the best images
    WITHOUT needing to view thumbnails.

    Selection rules — read carefully:
    - **Cleanliness** (MOST IMPORTANT): Prefer URLs from neutral photo agencies
      (AFP, Reuters, AP, Getty) or reputable news outlets. AVOID URLs whose
      domain or title contains other competitor media branding.
    - **Relevance**: Choose images whose title/source directly describes the news story.
    - **Resolution**: Prefer larger images (wider width = better quality for editing).
    - **Impact**: Based on the source title, prefer action scenes over archival/file photos.

    After reading the metadata list, use think_tool to record:
    1. A 1-line assessment of each downloaded image (clean? relevant? resolution ok?)
    2. Which 3-5 URLs you are selecting for Gemini vision analysis and WHY
    3. The exact URLs of your chosen images

    Then call analyze_images_gemini with your selected URLs (3-5 max).

    Args:
        image_urls: All image URLs returned by fetch_images_brave (pass all of them).

    Returns:
        Text metadata list: index, URL, file path, dimensions, and file size.
        Helps you select images by reading Brave's title/source descriptions.
    """
    _CANDIDATE_DIR.mkdir(parents=True, exist_ok=True)

    # Skip animated GIFs
    urls = [u for u in image_urls[:10] if u and not u.lower().endswith(".gif")]

    manifest: dict[str, str] = {}
    lines = [
        f"✅ Downloading {len(urls)} images to disk at full resolution...\n",
        "Select your best 3-5 images based on title/source relevance and resolution:\n",
        "─" * 60,
    ]

    downloaded_count = 0
    for i, url in enumerate(urls, 1):
        save_path = _CANDIDATE_DIR / f"image_{i}.jpg"
        meta = _download_and_save(url, save_path)

        if meta["ok"]:
            manifest[url] = str(save_path)
            downloaded_count += 1
            lines.append(
                f"\n📷 Image {i}:\n"
                f"   URL:        {url}\n"
                f"   Saved as:   output/candidate_images/image_{i}.jpg\n"
                f"   Dimensions: {meta['width']}×{meta['height']} px\n"
                f"   File size:  {meta['size_kb']} KB"
            )
        else:
            lines.append(
                f"\n❌ Image {i} — download failed:\n"
                f"   URL:   {url}\n"
                f"   Error: {meta['error']}"
            )

    # Persist manifest
    _MANIFEST_FILE.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    lines.append("\n" + "─" * 60)
    lines.append(
        f"\n✅ {downloaded_count}/{len(urls)} images saved to disk.\n"
        "Now use think_tool to pick your top 3-5 images based on:\n"
        "  1. The title/source text Brave provided for each URL (most reliable signal)\n"
        "  2. Resolution (wider = higher quality for editing)\n"
        "  3. Source domain (prefer neutral agencies: AP, Reuters, AFP, Getty)\n"
        "Then call analyze_images_gemini with your chosen URLs."
    )

    return "\n".join(lines)
