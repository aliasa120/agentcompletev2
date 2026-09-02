"""Backward-compatibility shim: Gemini Flash Image -> xAI Grok Imagine Image.

Redirects all calls to grok_imagine_image.py.
"""

from typing import List, Optional
from PIL import Image

from .grok_imagine_image import (
    grok_imagine_generate,
    test_connection as grok_test_connection,
)


async def gemini_flash_generate(
    prompt: str,
    source_img: Optional[Image.Image] = None,
    ref_urls: Optional[List[str]] = None,
    aspect_ratio: str = "1:1",
    timeout: int = 180,
) -> dict:
    """Redirects to Grok Imagine Image generator via Vercel AI Gateway."""
    return await grok_imagine_generate(
        prompt=prompt,
        source_img=source_img,
        ref_urls=ref_urls,
        aspect_ratio=aspect_ratio,
        timeout=timeout,
    )


async def test_connection() -> dict:
    """Redirects connection test to Grok Imagine Image."""
    return await grok_test_connection()
