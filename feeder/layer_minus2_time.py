"""Layer -2: Time-Based Filtering.
Drops articles older than the configured time threshold.
"""
from datetime import datetime, timedelta, timezone


def layer_minus2_time(article_published: datetime | None, max_age_hours: int = 24) -> bool:
    """Returns True if article is NEW ENOUGH to pass.
    
    Args:
        article_published: UTC datetime of publication (None = allow through)
        max_age_hours: drop articles older than this many hours
    """
    if article_published is None:
        return True  # no timestamp — allow through (better than silently dropping)

    threshold = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
    return article_published >= threshold
