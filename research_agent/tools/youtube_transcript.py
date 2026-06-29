import re
import httpx
from langchain_core.tools import tool
import logging

logger = logging.getLogger("youtube_transcript")

def extract_youtube_video_id(url_or_id: str) -> str:
    """Extract 11-character video ID from raw ID or various YouTube URL formats."""
    # If it's already a raw 11-char ID
    if len(url_or_id) == 11 and re.match(r"^[A-Za-z0-9_-]{11}$", url_or_id):
        return url_or_id
    
    # Try matching YouTube URL formats
    patterns = [
        r"(?:https?://)?(?:www\.)?youtube\.com/watch\?v=([A-Za-z0-9_-]{11})",
        r"(?:https?://)?(?:www\.)?youtu\.be/([A-Za-z0-9_-]{11})",
        r"(?:https?://)?(?:www\.)?youtube\.com/embed/([A-Za-z0-9_-]{11})",
        r"(?:https?://)?(?:www\.)?youtube\.com/v/([A-Za-z0-9_-]{11})",
        r"(?:https?://)?(?:www\.)?youtube\.com/shorts/([A-Za-z0-9_-]{11})",
        r"(?:https?://)?(?:www\.)?youtube-transcript\.ai/transcript/([A-Za-z0-9_-]{11})"
    ]
    for pattern in patterns:
        match = re.search(pattern, url_or_id)
        if match:
            return match.group(1)
    
    raise ValueError(f"Could not extract a valid 11-character YouTube video ID from: {url_or_id}")


@tool(parse_docstring=True)
def youtube_transcript(video_id_or_url: str, lang: str = "") -> str:
    """Extract transcript from YouTube videos as structured Markdown.

    Fetches the full transcript of a public YouTube video as a clean, timestamped
    Markdown document using the youtube-transcript.ai API. No authentication required.

    Args:
        video_id_or_url: The YouTube video URL (e.g. 'https://www.youtube.com/watch?v=dQw4w9WgXcQ') or its 11-character video ID (e.g. 'dQw4w9WgXcQ').
        lang: Optional. A YouTube language code such as 'en', 'es', or 'zh-Hant'. Falls back to human-uploaded, then auto-generated.
    """
    try:
        video_id = extract_youtube_video_id(video_id_or_url.strip())
    except ValueError as ve:
        return str(ve)
    
    url = f"https://youtube-transcript.ai/transcript/{video_id}.txt"
    params = {}
    if lang:
        params["lang"] = lang
        
    try:
        logger.info(f"Requesting YouTube transcript for video {video_id} via youtube-transcript.ai...")
        with httpx.Client(timeout=15.0) as client:
            resp = client.get(url, params=params)
            if resp.status_code == 200:
                return resp.text
            else:
                return f"Error fetching YouTube transcript (HTTP {resp.status_code}): {resp.text}"
    except Exception as e:
        logger.error(f"Failed to fetch YouTube transcript: {e}")
        return f"Request failed: {e}"
