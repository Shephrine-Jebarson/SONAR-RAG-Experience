"""URL extraction service — the web-page counterpart to extraction.py.

Fetches a URL and returns readable article text as a single ExtractedSegment
(source_type="url"), matching the shape produced for uploaded files so the
rest of the ingestion pipeline (chunking, embedding, indexing) doesn't need
to distinguish file sources from web sources. Tries trafilatura first
(handles most article/blog layouts well); falls back to a plain
BeautifulSoup text extraction if trafilatura returns too little content.
"""

import httpx
import trafilatura
from bs4 import BeautifulSoup

from app.models import ExtractedSegment
from app.services.extraction import ExtractionError

# Minimum chars from trafilatura before we try the BeautifulSoup fallback.
_MIN_TRAFILATURA_CHARS = 200


async def extract_url(url: str, http_client: httpx.AsyncClient) -> list[ExtractedSegment]:
    """Fetch a URL and return one ExtractedSegment with cleaned readable text.

    Raises ExtractionError on HTTP errors, timeouts, or empty content.
    Checkpoint 3's /process route is responsible for catching this per-URL
    so one bad URL never aborts the whole batch.
    """
    try:
        response = await http_client.get(url, timeout=15.0, follow_redirects=True)
    except httpx.TimeoutException as exc:
        raise ExtractionError(f"URL timed out: {url}") from exc
    except httpx.HTTPError as exc:
        raise ExtractionError(f"Could not reach URL: {url} ({exc})") from exc

    if response.status_code >= 400:
        raise ExtractionError(f"URL returned HTTP {response.status_code}: {url}")

    html = response.text

    # Primary: trafilatura — best for article-style pages
    text = (trafilatura.extract(html) or "").strip()

    # Fallback: BeautifulSoup when trafilatura returns thin content
    if len(text) < _MIN_TRAFILATURA_CHARS:
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "nav", "header", "footer"]):
            tag.decompose()
        fallback_text = soup.get_text(separator="\n").strip()
        if len(fallback_text) > len(text):
            text = fallback_text

    # Normalise: strip blank lines and leading/trailing whitespace per line
    text = "\n".join(line.strip() for line in text.splitlines() if line.strip())

    if not text:
        raise ExtractionError(f"No readable content found at URL: {url}")

    return [ExtractedSegment(
        text=text,
        source_type="url",
        source_name=url,
        source_url=url,
    )]
