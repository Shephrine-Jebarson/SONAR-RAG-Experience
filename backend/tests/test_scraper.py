import httpx
import pytest

from app.services.extraction import ExtractionError
from app.services.scraper import extract_url


def _client_with(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_extract_url_uses_trafilatura_for_rich_content():
    article_body = "This is a real article sentence. " * 40
    html = f"<html><body><article><p>{article_body}</p></article></body></html>"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=html)

    client = _client_with(handler)
    try:
        segments = await extract_url("https://example.com/article", client)
    finally:
        await client.aclose()

    assert len(segments) == 1
    seg = segments[0]
    assert seg.source_type == "url"
    assert seg.source_url == "https://example.com/article"
    assert seg.page is None and seg.slide is None
    assert "real article sentence" in seg.text


async def test_extract_url_falls_back_to_beautifulsoup_when_trafilatura_thin():
    html = "<html><body><div>short page content</div></body></html>"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=html)

    client = _client_with(handler)
    try:
        segments = await extract_url("https://example.com/thin", client)
    finally:
        await client.aclose()

    assert "short page content" in segments[0].text


async def test_extract_url_raises_on_http_error_status():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="not found")

    client = _client_with(handler)
    try:
        with pytest.raises(ExtractionError, match="404"):
            await extract_url("https://example.com/missing", client)
    finally:
        await client.aclose()


async def test_extract_url_raises_on_timeout():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("timed out", request=request)

    client = _client_with(handler)
    try:
        with pytest.raises(ExtractionError, match="timed out"):
            await extract_url("https://example.com/slow", client)
    finally:
        await client.aclose()


async def test_extract_url_raises_when_no_readable_content():
    html = "<html><body></body></html>"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=html)

    client = _client_with(handler)
    try:
        with pytest.raises(ExtractionError, match="No readable content"):
            await extract_url("https://example.com/empty", client)
    finally:
        await client.aclose()
