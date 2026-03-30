"""Embed selected images into the blog post markdown file at designated placeholders.

The agent selects 2 images from the downloaded candidate_images after running
view_candidate_images. This tool places them at the <!-- BLOG_IMAGE_1 --> and
<!-- BLOG_IMAGE_2 --> markers in blog_post.md.

IMPORTANT: Images are ALWAYS embedded using the original hosted URL — never
a local file path. This ensures WordPress renders them correctly.
"""

import json
import re
from pathlib import Path

from langchain_core.tools import tool

_BLOG_POST_FILE   = Path("blog_post.md")
_CANDIDATE_DIR    = Path("output") / "candidate_images"
_MANIFEST_FILE    = _CANDIDATE_DIR / "manifest.json"


def _load_manifest() -> dict:
    """Load the image URL → local path manifest written by view_candidate_images."""
    if _MANIFEST_FILE.exists():
        try:
            return json.loads(_MANIFEST_FILE.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"[embed_blog_images] ⚠️  Could not read manifest: {e}")
    return {}


def _derive_caption(url: str, fallback_index: int) -> str:
    """Generate a short image caption from the URL domain + path."""
    try:
        # Extract domain and last path segment
        no_proto = re.sub(r"^https?://", "", url)
        parts = no_proto.split("/")
        domain = parts[0].replace("www.", "")
        # Use last meaningful path chunk as hint
        path_hint = parts[-1] if len(parts) > 1 else ""
        path_hint = re.sub(r"\.(jpg|jpeg|png|webp|gif)$", "", path_hint, flags=re.I)
        path_hint = re.sub(r"[-_]+", " ", path_hint).strip()
        if path_hint and len(path_hint) > 5:
            caption = f"{path_hint.title()} (via {domain})"
        else:
            caption = f"Related image {fallback_index} (source: {domain})"
        return caption[:120]  # truncate at 120 chars
    except Exception:
        return f"Image {fallback_index}"


@tool(parse_docstring=True)
def embed_images_in_blog(
    image_1_url: str,
    image_2_url: str,
    image_1_caption: str = "",
    image_2_caption: str = "",
    blog_post_path: str = "blog_post.md"
) -> str:
    """Embed two selected images into blog_post.md at the designated placeholders.

    This tool must be called AFTER view_candidate_images has downloaded the
    images and BEFORE calling analyze_images_gemini (for social post images).

    It reads blog_post.md, replaces the <!-- BLOG_IMAGE_1 --> marker with a
    full image block for image_1, and replaces <!-- BLOG_IMAGE_2 --> with
    image_2. The images are embedded as markdown with captions.

    If a marker is not found (because the agent forgot to include it), the
    tool appends the image after the first or second H2 heading instead.

    Args:
        image_1_url: URL of the first image to embed (placed after intro / 1st H2).
                     This should be the most relevant, high-quality candidate image.
        image_2_url: URL of the second image to embed (placed mid-article / 3rd H2).
                     Choose a different image from image_1.
        image_1_caption: Optional custom caption for image 1. Auto-derived from URL if empty.
        image_2_caption: Optional custom caption for image 2. Auto-derived from URL if empty.
        blog_post_path: Optional path to the blog post file. Defaults to "blog_post.md".

    Returns:
        Success message with updated blog_post.md path, or error description.
    """
    # ── Check blog_post.md exists ─────────────────────────────────────────────
    possible_paths = [
        Path(blog_post_path),
        Path(blog_post_path.lstrip("/\\")),
        Path("blog_post.md"),
        Path("/blog_post.md")
    ]
    
    target_file = None
    for p in possible_paths:
        if p.exists():
            target_file = p
            break

    if not target_file:
        return (
            f"❌ blog_post.md not found. Searched in: {[str(p) for p in possible_paths]}. "
            "Make sure Step 6 (write blog post) "
            "completed successfully before calling this tool."
        )

    try:
        content = target_file.read_text(encoding="utf-8")
    except Exception as e:
        return f"❌ Could not read {target_file}: {e}"

    original_length = len(content)
    manifest = _load_manifest()

    # ── Resolve local paths from manifest ─────────────────────────────────────
    local_path_1 = manifest.get(image_1_url, "")
    local_path_2 = manifest.get(image_2_url, "")

    print(f"[embed_blog_images] Image 1 URL:  {image_1_url}")
    print(f"[embed_blog_images] Image 1 path: {local_path_1 or 'not in manifest'}")
    print(f"[embed_blog_images] Image 2 URL:  {image_2_url}")
    print(f"[embed_blog_images] Image 2 path: {local_path_2 or 'not in manifest'}")

    # ── Build captions ─────────────────────────────────────────────────────────
    caption_1 = image_1_caption.strip() or _derive_caption(image_1_url, 1)
    caption_2 = image_2_caption.strip() or _derive_caption(image_2_url, 2)

    # ── Build markdown image blocks ────────────────────────────────────────────
    # ALWAYS use the original hosted URL as src — never a local file path.
    # Local paths (candidate_images/) are not accessible from WordPress,
    # so embedding them would result in broken images on the published post.
    # Automatically append WordPress sizing parameters (w=800 is the sweet spot for content)
    def add_wp_size(url: str, w: int = 800) -> str:
        if "?w=" in url or "&w=" in url:
            return url
        return f"{url}&w={w}" if "?" in url else f"{url}?w={w}"

    src_1 = add_wp_size(image_1_url, 800)
    src_2 = add_wp_size(image_2_url, 800)

    img_block_1 = (
        f"\n![{caption_1}]({src_1})\n"
        f"*{caption_1}*\n"
    )
    img_block_2 = (
        f"\n![{caption_2}]({src_2})\n"
        f"*{caption_2}*\n"
    )

    # ── Replace placeholders or inject after H2 headings ──────────────────────
    updated = content

    # Image 1
    if "<!-- BLOG_IMAGE_1 -->" in updated:
        updated = updated.replace("<!-- BLOG_IMAGE_1 -->", img_block_1, 1)
        placement_1 = "placeholder <!-- BLOG_IMAGE_1 -->"
    else:
        # Fallback: inject after the FIRST ## heading
        h2_match = re.search(r"(^##\s.+$)", updated, re.MULTILINE)
        if h2_match:
            insert_pos = int(h2_match.end())
            updated = updated[:insert_pos] + "\n" + img_block_1 + updated[insert_pos:]
            placement_1 = "after first H2 heading (fallback)"
        else:
            # Last resort: add after first paragraph
            para_match = re.search(r"\n\n", updated[updated.find("---\n", 3) + 4:])
            if para_match:
                real_pos = int(updated.find("---\n", 3) + 4 + para_match.end())
                updated = updated[:real_pos] + img_block_1 + updated[real_pos:]
                placement_1 = "after intro paragraph (last resort)"
            else:
                placement_1 = "FAILED — could not find insertion point for image 1"

    # Image 2
    if "<!-- BLOG_IMAGE_2 -->" in updated:
        updated = updated.replace("<!-- BLOG_IMAGE_2 -->", img_block_2, 1)
        placement_2 = "placeholder <!-- BLOG_IMAGE_2 -->"
    else:
        # Fallback: inject after the THIRD ## heading
        h2_matches = list(re.finditer(r"(^##\s.+$)", updated, re.MULTILINE))
        if len(h2_matches) >= 3:
            insert_pos = int(h2_matches[2].end())
            updated = updated[:insert_pos] + "\n" + img_block_2 + updated[insert_pos:]
            placement_2 = "after third H2 heading (fallback)"
        elif len(h2_matches) >= 2:
            insert_pos = int(h2_matches[1].end())
            updated = updated[:insert_pos] + "\n" + img_block_2 + updated[insert_pos:]
            placement_2 = "after second H2 heading (fallback)"
        else:
            # Last resort: append before Sources
            if "## Sources" in updated:
                updated = updated.replace("## Sources", img_block_2 + "\n## Sources", 1)
                placement_2 = "before Sources section (last resort)"
            else:
                updated = updated + "\n" + img_block_2
                placement_2 = "appended at end (last resort)"

    # ── Write back ─────────────────────────────────────────────────────────────
    try:
        target_file.write_text(updated, encoding="utf-8")
    except Exception as e:
        return f"❌ Could not write updated blog_post.md: {e}"

    new_length = len(updated)
    print(
        f"[embed_blog_images] ✅ Blog post updated: "
        f"{original_length} → {new_length} chars"
    )

    return (
        f"✅ Images embedded in blog_post.md:\n"
        f"  Image 1: placed at {placement_1}\n"
        f"    Caption: {caption_1}\n"
        f"    Source:  {image_1_url}\n"
        f"  Image 2: placed at {placement_2}\n"
        f"    Caption: {caption_2}\n"
        f"    Source:  {image_2_url}\n"
        f"\n"
        f"blog_post.md is now {new_length} characters.\n"
        f"You can now proceed with analyze_images_gemini for the social post image."
    )
