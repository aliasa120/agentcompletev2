from datetime import datetime
from typing import Optional
from pydantic import BaseModel

class FeederArticle(BaseModel):
    title: str
    link: str
    description: str = ""
    guid: str
    published_parsed: Optional[datetime] = None
    domain: str = ""

    # Tracking fields added as it moves through layers
    hash: str = ""
    fingerprint: str = ""
    status: str = "Processing"
    embedding: Optional[list[float]] = None   # set by L5, stored atomically at pipeline end
    workflow_id: Optional[str] = None
    source_id: Optional[str] = None


class LayerResult(BaseModel):
    passed: bool
    reason: str = ""
    article: FeederArticle
