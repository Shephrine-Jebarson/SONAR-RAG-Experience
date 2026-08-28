"""POST /add-url — scrape a URL and stage it for /process."""

import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import get_httpx_client
from app.models import ExtractedSegment
from app.services.extraction import ExtractionError
from app.services.scraper import extract_url

router = APIRouter()

# Shared staging store — same pattern as upload.py.
_staged: dict[str, list[ExtractedSegment]] = {}


class AddUrlRequest(BaseModel):
    url: str


class AddUrlResponse(BaseModel):
    source_id: str
    source_name: str
    source_type: str = "url"
    segment_count: int


@router.post("/add-url", response_model=AddUrlResponse)
async def add_url(
    body: AddUrlRequest,
    http_client: httpx.AsyncClient = Depends(get_httpx_client),
) -> AddUrlResponse:
    url = body.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=422, detail=f"Invalid URL (must start with http/https): {url}")

    try:
        segments = await extract_url(url, http_client)
    except ExtractionError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    source_id = str(uuid.uuid4())
    _staged[source_id] = segments

    return AddUrlResponse(
        source_id=source_id,
        source_name=url,
        segment_count=len(segments),
    )


def get_staged() -> dict[str, list[ExtractedSegment]]:
    """Expose the staging store for /process to consume."""
    return _staged
