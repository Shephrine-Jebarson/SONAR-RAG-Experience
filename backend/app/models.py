from typing import Literal, Optional

from pydantic import BaseModel

SourceType = Literal["pdf", "txt", "pptx", "url"]


class ExtractedSegment(BaseModel):
    text: str
    source_type: SourceType
    source_name: str
    source_url: Optional[str] = None
    page: Optional[int] = None
    slide: Optional[int] = None


class Chunk(BaseModel):
    chunk_id: str
    text: str
    source_type: SourceType
    source_name: str
    source_url: Optional[str] = None
    page: Optional[int] = None
    slide: Optional[int] = None


class RetrievedChunk(BaseModel):
    """A Chunk returned from vector search, augmented with its similarity score."""
    chunk_id: str
    text: str
    source_type: SourceType
    source_name: str
    source_url: Optional[str] = None
    page: Optional[int] = None
    slide: Optional[int] = None
    score: float
