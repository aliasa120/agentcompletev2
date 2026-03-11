"""Exa AI image search tool — fetches OG images from news articles."""

import os
import time

from exa_py import Exa
from langchain_core.tools import tool

_exa_client = None


def _get_exa_client():
    """Lazy-init Exa client so no network call happens at import time."""
    global _exa_client
    if _exa_client is None:
        _exa_client = Exa(api_key=os.environ.get("EXA_API_KEY", ""))
    return _exa_client


@tool(parse_docstring=True)
def fetch_images_exa(query: str, category: str = "news") -> str:
    """Search for OG images from news articles using Exa AI search.

    Exa natively returns the article's og:image in every search result.
    Call this AFTER Step 6b (self-scoring), using the same keyword query
    from your research.  The agent then reads the titles/descriptions and
    picks the most relevant image URL before calling create_post_images.

    Args:
        query: Same 4-8 word keyword string used in linkup_search. No quotes,
               e.g. "Imran Khan eye surgery Adiala 2026".
        category: Topic category — 'news' for current events (default),
                  'general' for background topics.

    Returns:
        Numbered list of articles with their OG image URLs and titles.
        Pick the image whose title best matches the story you are writing about.
        Returns a skip message if no images are found.
    """
    last_err = None

    for attempt in range(1, 4):          # 3 attempts with delay between each
        try:
            results = _get_exa_client().search(
                query=query,
                type="auto",
                num_results=10,
                category=category if category in ("news", "general") else "news",
            )

            images = [
                {
                    "image_url": result.image,
                    "title": result.title or "(no title)",
                    "source_url": result.url or "",
                }
                for result in results.results
                if getattr(result, "image", None)
            ]

            if not images:
                return (
                    "No OG images found for this query via Exa. "
                    "Skip the image pipeline steps."
                )

            lines = ["OG IMAGES FOUND — pick the one whose title best matches your story:\n"]
            for i, img in enumerate(images, 1):
                lines.append(f"{i}. Title:      {img['title']}")
                lines.append(f"   Source:     {img['source_url']}")
                lines.append(f"   Image URL:  {img['image_url']}\n")

            return "\n".join(lines)

        except Exception as e:
            last_err = e
            print(f"[fetch_images_exa] Attempt {attempt}/3 failed: {e}")
            if attempt < 3:
                print(f"[fetch_images_exa] Retrying in 3 seconds...")
                time.sleep(3)           # wait 3 s then retry

    return (
        f"Exa image search failed after 3 attempts: {last_err}. "
        "Skip image pipeline steps and save social_posts.md without images."
    )
