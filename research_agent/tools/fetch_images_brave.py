"""Brave Image Search tool — fetches real images from the Brave index."""

import os
import time
import requests
from langchain_core.tools import tool


_BRAVE_API_URL = "https://api.search.brave.com/res/v1/images/search"


@tool(parse_docstring=True)
def fetch_images_brave(query: str, count: int = 10) -> str:
    """Search for news images using Brave Image Search API.

    Returns a numbered list of direct image URLs matching the query.
    Call this AFTER research is complete, using a keyword query describing
    the news event. Pick the most relevant image URL before calling create_post_images.

    Args:
        query: 4-10 keyword string about the news image needed, no quotes or special chars.
               Max 400 characters. Write a descriptive keyword query for the news topic,
               including person names, location and the event being reported on.
        count: Number of image results to return, between 1 and 20. Defaults to 10.

    Returns:
        Numbered list of image results with title, source and direct image URL.
        Pick the image whose title and source best matches the story being written.
        Returns a skip message if no images are found or the API key is missing.
    """
    api_key = os.environ.get("BRAVE_API_KEY", "")
    if not api_key:
        return (
            "BRAVE_API_KEY not set. Cannot fetch images via Brave. "
            "Skip the image pipeline steps."
        )

    last_err = None
    for attempt in range(1, 4):
        try:
            resp = requests.get(
                _BRAVE_API_URL,
                headers={
                    "Accept": "application/json",
                    "Accept-Encoding": "gzip",
                    "X-Subscription-Token": api_key,
                },
                params={
                    "q": query,
                    "count": min(max(int(count), 1), 20),
                    "safesearch": "strict",
                    "spellcheck": "1",
                },
                timeout=15,
            )

            if resp.status_code == 429:
                raise Exception("Brave API rate limited (429)")
            if resp.status_code == 422:
                raise Exception(f"Bad request (422): {resp.text[:300]}")
            resp.raise_for_status()

            data = resp.json()
            results = data.get("results", [])

            if not results:
                return (
                    "No images found for this query via Brave Image Search. "
                    "Try a different query or skip the image pipeline."
                )

            lines = ["IMAGES FOUND — pick the one whose title/source best matches your story:\n"]
            skipped = 0
            shown = 0
            for i, r in enumerate(results, 1):
                title = r.get("title", "(no title)")
                source = r.get("source", r.get("url", ""))
                img_url = r.get("properties", {}).get("url", "")
                thumb_url = r.get("thumbnail", {}).get("src", "")
                width = r.get("properties", {}).get("width") or 0
                height = r.get("properties", {}).get("height") or 0

                # Skip low-resolution images — not useful for news post editing
                if width and height and (width < 400 or height < 200):
                    skipped += 1
                    continue

                dim = f"{width}x{height}" if width and height else "unknown"
                shown += 1
                lines.append(f"{shown}. Title:      {title}")
                lines.append(f"   Source:     {source}")
                lines.append(f"   Image URL:  {img_url or thumb_url}")
                lines.append(f"   Dimensions: {dim}\n")

            if not lines[1:]:  # only header remains
                return (
                    "No usable images found (all were low-resolution). "
                    "Try a different query or skip the image pipeline."
                )

            if skipped:
                lines.append(f"({skipped} low-resolution images were filtered out automatically.)\n")

            return "\n".join(lines)

        except Exception as e:
            last_err = e
            print(f"[fetch_images_brave] Attempt {attempt}/3 failed: {e}")
            if attempt < 3:
                print("[fetch_images_brave] Retrying in 2 seconds...")
                time.sleep(2)

    return (
        f"Brave image search failed after 3 attempts: {last_err}. "
        "Skip image pipeline steps and save social_posts.md without images."
    )
