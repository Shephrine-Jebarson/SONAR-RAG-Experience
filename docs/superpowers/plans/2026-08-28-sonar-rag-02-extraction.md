# SONAR-RAG Checkpoint 2: Extraction Services — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the extraction and chunking service layer — PDF/TXT/PPTX/URL
text extraction into a shared `ExtractedSegment` shape, then token-windowed
chunking into the exact metadata schema `instructions.md` §5 requires. No
routes, no embeddings, no Qdrant yet — that's checkpoint 3. Everything here
is a plain importable function, fully unit-testable with zero API keys and
zero live network access.

**Architecture:** `backend/app/models.py` defines the two shared shapes
(`ExtractedSegment`, `Chunk`) every extractor and the chunker produce/consume.
`backend/app/services/extraction.py` holds PDF/TXT/PPTX extraction (each
returns one `ExtractedSegment` per page/slide, or one for a whole TXT file).
`backend/app/services/scraper.py` holds URL extraction separately, per
`instructions.md` §3's folder structure, since it's async (uses the
singleton `httpx.AsyncClient` from checkpoint 1) while the file extractors
are sync. `backend/app/services/chunking.py` takes a list of segments from
any extractor and produces token-windowed `Chunk`s, tagging every chunk with
its originating segment's page/slide so metadata never has to be
reconstructed later. Each extractor raises a shared `ExtractionError` with a
human-readable message on failure (corrupted file, empty content, HTTP
error, timeout) — checkpoint 3's `/process` route will catch these per-source
so one bad file/URL never aborts the whole batch.

**Tech Stack:** PyMuPDF (`fitz`), python-pptx, httpx (already a checkpoint 1
singleton), trafilatura, beautifulsoup4, tiktoken, pytest-asyncio.

**Spec:** `docs/superpowers/specs/2026-08-28-sonar-rag-voice-assistant-design.md`
§6 (Ingestion & Processing Pipeline) and `instructions.md` §5 (Ingestion &
Metadata) and §6 (Chunking). Overall progress tracked in
`docs/superpowers/plans/2026-08-28-sonar-rag-roadmap.md`, which also records
two decisions from checkpoint 1's review that affect *later* checkpoints
(Gemini SDK choice for checkpoint 3, `/health` contract for checkpoint 6) —
neither is relevant to this checkpoint's extraction/chunking work.

## Global Constraints

- **PDF**: PyMuPDF, extract text per page, keep the page number
  (`instructions.md` §5).
- **TXT**: read UTF-8, clean, no page/slide field needed (`instructions.md` §5).
- **PPTX**: python-pptx, extract slide text **and table text** — tables are
  explicitly called out as a differentiator for extraction-quality marks,
  do not skip them (`instructions.md` §5). Keep the slide number.
- **URL**: httpx GET → readable text via trafilatura, with BeautifulSoup as
  a secondary cleanup pass when trafilatura returns thin content (design
  spec §6). Raise a clear, typed error on failure (bot-blocked, JS-heavy,
  timeout, non-200) — checkpoint 3's `/process` route is responsible for
  catching these per-URL and continuing the batch; this checkpoint only
  needs to raise `ExtractionError` with a useful message, not implement
  batch-continuation itself.
- **Chunking**: ~500–800 tokens per chunk, ~50–100 token overlap, using a
  tiktoken-based token counter — an accurate cheap estimate, not a real
  Gemini tokenizer, which is fine since it's only used for chunk sizing
  (`instructions.md` §6, design spec §6).
- **Metadata schema** — every chunk carries exactly: `chunk_id`, `text`,
  `source_type` (`pdf|txt|pptx|url`), `source_name`, `source_url`, `page`,
  `slide` (`instructions.md` §5).
- No Groq/Gemini/Qdrant Cloud accounts exist yet — this checkpoint's code
  must be fully unit-testable with no real keys **and no live network
  access** (design spec §4). URL-extraction tests use `httpx.MockTransport`,
  never a real HTTP request.
- Do NOT introduce LangGraph, multi-agent frameworks, local LLMs, local
  Whisper, custom TTS models, auth/user accounts, Redis, Celery, Kubernetes
  (`instructions.md` §2).

---

### Task 1: Shared models + TXT extraction

**Files:**
- Create: `backend/app/models.py`
- Create: `backend/app/services/__init__.py`
- Create: `backend/app/services/extraction.py`
- Test: `backend/tests/test_extraction.py`

**Interfaces:**
- Produces: `app.models.ExtractedSegment` (pydantic `BaseModel`: `text: str`,
  `source_type: Literal["pdf","txt","pptx","url"]`, `source_name: str`,
  `source_url: str | None = None`, `page: int | None = None`,
  `slide: int | None = None`). `app.models.Chunk` (same fields plus
  `chunk_id: str` first). `app.services.extraction.ExtractionError(Exception)`.
  `app.services.extraction.extract_txt(file_path: Path, source_name: str) -> list[ExtractedSegment]`.
  Later tasks in this checkpoint import `ExtractedSegment`, `Chunk`, and
  `ExtractionError` from these exact locations — don't rename them.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_extraction.py`:

```python
import pytest

from app.services.extraction import ExtractionError, extract_txt


def test_extract_txt_reads_and_cleans_whitespace(tmp_path):
    path = tmp_path / "notes.txt"
    path.write_text("  Line one.  \n\n\n  Line two.  \n", encoding="utf-8")

    segments = extract_txt(path, source_name="notes.txt")

    assert len(segments) == 1
    seg = segments[0]
    assert seg.source_type == "txt"
    assert seg.source_name == "notes.txt"
    assert seg.page is None
    assert seg.slide is None
    assert "Line one." in seg.text
    assert "Line two." in seg.text


def test_extract_txt_raises_on_empty_file(tmp_path):
    path = tmp_path / "empty.txt"
    path.write_text("   \n\n   ", encoding="utf-8")

    with pytest.raises(ExtractionError, match="empty"):
        extract_txt(path, source_name="empty.txt")


def test_extract_txt_raises_on_invalid_utf8(tmp_path):
    path = tmp_path / "bad_encoding.txt"
    path.write_bytes(b"\xff\xfe\x00\x01invalid")

    with pytest.raises(ExtractionError, match="UTF-8"):
        extract_txt(path, source_name="bad_encoding.txt")
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `backend/`, with the venv from checkpoint 1 active):
`pytest tests/test_extraction.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services'`

- [ ] **Step 3: Implement `app/models.py`**

```python
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
```

- [ ] **Step 4: Implement `app/services/extraction.py`**

`backend/app/services/__init__.py`: empty file.

```python
from pathlib import Path

from app.models import ExtractedSegment


class ExtractionError(Exception):
    """Raised when a source cannot be extracted. Message is human-readable."""


def extract_txt(file_path: Path, source_name: str) -> list[ExtractedSegment]:
    try:
        raw = file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ExtractionError(f"TXT file is not valid UTF-8: {source_name}") from exc

    text = "\n".join(line.strip() for line in raw.splitlines() if line.strip())

    if not text:
        raise ExtractionError(f"TXT file is empty: {source_name}")

    return [ExtractedSegment(text=text, source_type="txt", source_name=source_name)]
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest tests/test_extraction.py -v`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/app/models.py backend/app/services/__init__.py \
  backend/app/services/extraction.py backend/tests/test_extraction.py
git commit -m "feat(backend): add shared extraction models and TXT extraction"
```

---

### Task 2: PDF extraction

**Files:**
- Modify: `backend/app/services/extraction.py` (add `extract_pdf`)
- Modify: `backend/tests/test_extraction.py` (append PDF tests)
- Modify: `backend/requirements.txt` (add PyMuPDF)

**Interfaces:**
- Consumes: `ExtractedSegment`, `ExtractionError` (Task 1).
- Produces: `extract_pdf(file_path: Path, source_name: str) -> list[ExtractedSegment]`,
  one segment per page with `page` set to the 1-indexed page number.

- [ ] **Step 1: Add the dependency**

Append to `backend/requirements.txt`:

```
pymupdf>=1.24
```

Install it into the existing venv: `pip install pymupdf>=1.24` (from `backend/`,
venv active).

- [ ] **Step 2: Write the failing test**

Append to `backend/tests/test_extraction.py`:

```python
import fitz

from app.services.extraction import extract_pdf


def _make_pdf(tmp_path, pages_text: list[str]):
    doc = fitz.open()
    for text in pages_text:
        page = doc.new_page()
        if text:
            page.insert_text((72, 72), text)
    path = tmp_path / "sample.pdf"
    doc.save(str(path))
    doc.close()
    return path


def test_extract_pdf_returns_one_segment_per_page(tmp_path):
    path = _make_pdf(tmp_path, ["First page body", "Second page body"])

    segments = extract_pdf(path, source_name="sample.pdf")

    assert len(segments) == 2
    assert segments[0].page == 1
    assert segments[1].page == 2
    assert "First page body" in segments[0].text
    assert "Second page body" in segments[1].text
    assert all(seg.source_type == "pdf" for seg in segments)
    assert all(seg.source_name == "sample.pdf" for seg in segments)


def test_extract_pdf_skips_blank_pages_but_keeps_real_page_numbers(tmp_path):
    path = _make_pdf(tmp_path, ["Only real content", ""])

    segments = extract_pdf(path, source_name="sample.pdf")

    assert len(segments) == 1
    assert segments[0].page == 1


def test_extract_pdf_raises_when_no_extractable_text(tmp_path):
    path = _make_pdf(tmp_path, ["", ""])

    with pytest.raises(ExtractionError, match="no extractable text"):
        extract_pdf(path, source_name="sample.pdf")


def test_extract_pdf_raises_on_corrupted_file(tmp_path):
    path = tmp_path / "corrupted.pdf"
    path.write_bytes(b"this is not a real pdf")

    with pytest.raises(ExtractionError, match="Corrupted"):
        extract_pdf(path, source_name="corrupted.pdf")
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pytest tests/test_extraction.py -v`
Expected: FAIL with `ImportError: cannot import name 'extract_pdf'`

- [ ] **Step 4: Implement `extract_pdf`**

Add to `backend/app/services/extraction.py` (add `import fitz` at the top,
alongside the existing imports):

```python
def extract_pdf(file_path: Path, source_name: str) -> list[ExtractedSegment]:
    try:
        doc = fitz.open(file_path)
    except Exception as exc:
        raise ExtractionError(f"Corrupted or unreadable PDF: {source_name} ({exc})") from exc

    segments: list[ExtractedSegment] = []
    try:
        for page_index in range(doc.page_count):
            page = doc.load_page(page_index)
            text = page.get_text().strip()
            if text:
                segments.append(ExtractedSegment(
                    text=text,
                    source_type="pdf",
                    source_name=source_name,
                    page=page_index + 1,
                ))
    finally:
        doc.close()

    if not segments:
        raise ExtractionError(f"PDF has no extractable text: {source_name}")

    return segments
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest tests/test_extraction.py -v`
Expected: PASS (7 tests total)

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/extraction.py backend/tests/test_extraction.py \
  backend/requirements.txt
git commit -m "feat(backend): add per-page PDF extraction via PyMuPDF"
```

---

### Task 3: PPTX extraction (text + tables)

**Files:**
- Modify: `backend/app/services/extraction.py` (add `extract_pptx`)
- Modify: `backend/tests/test_extraction.py` (append PPTX tests)
- Modify: `backend/requirements.txt` (add python-pptx)

**Interfaces:**
- Consumes: `ExtractedSegment`, `ExtractionError` (Task 1).
- Produces: `extract_pptx(file_path: Path, source_name: str) -> list[ExtractedSegment]`,
  one segment per slide with `slide` set to the 1-indexed slide number,
  combining text-frame text and table cell text.

- [ ] **Step 1: Add the dependency**

Append to `backend/requirements.txt`:

```
python-pptx>=1.0
```

Install: `pip install python-pptx>=1.0` (from `backend/`, venv active).

- [ ] **Step 2: Write the failing test**

Append to `backend/tests/test_extraction.py`:

```python
from pptx import Presentation
from pptx.util import Inches

from app.services.extraction import extract_pptx


def _make_pptx(tmp_path, slides: list[dict]):
    """slides: list of {"heading": str|None, "table_rows": list[list[str]]|None}"""
    prs = Presentation()
    blank_layout = prs.slide_layouts[6]

    for slide_spec in slides:
        slide = prs.slides.add_slide(blank_layout)

        heading = slide_spec.get("heading")
        if heading:
            textbox = slide.shapes.add_textbox(Inches(1), Inches(0.5), Inches(6), Inches(1))
            textbox.text_frame.text = heading

        table_rows = slide_spec.get("table_rows")
        if table_rows:
            rows, cols = len(table_rows), len(table_rows[0])
            table_shape = slide.shapes.add_table(rows, cols, Inches(1), Inches(2), Inches(6), Inches(1.5))
            table = table_shape.table
            for r, row_values in enumerate(table_rows):
                for c, value in enumerate(row_values):
                    table.cell(r, c).text = value

    path = tmp_path / "sample.pptx"
    prs.save(str(path))
    return path


def test_extract_pptx_returns_one_segment_per_slide_with_text(tmp_path):
    path = _make_pptx(tmp_path, [
        {"heading": "Slide one heading"},
        {"heading": "Slide two heading"},
    ])

    segments = extract_pptx(path, source_name="sample.pptx")

    assert len(segments) == 2
    assert segments[0].slide == 1
    assert segments[1].slide == 2
    assert "Slide one heading" in segments[0].text
    assert "Slide two heading" in segments[1].text
    assert all(seg.source_type == "pptx" for seg in segments)


def test_extract_pptx_includes_table_cell_text(tmp_path):
    path = _make_pptx(tmp_path, [
        {
            "heading": "Pricing",
            "table_rows": [["Plan", "Price"], ["Basic", "$10"], ["Pro", "$25"]],
        },
    ])

    segments = extract_pptx(path, source_name="sample.pptx")

    assert len(segments) == 1
    text = segments[0].text
    assert "Pricing" in text
    assert "Basic" in text and "$10" in text
    assert "Pro" in text and "$25" in text


def test_extract_pptx_raises_when_no_extractable_text(tmp_path):
    path = _make_pptx(tmp_path, [{}, {}])

    with pytest.raises(ExtractionError, match="no extractable text"):
        extract_pptx(path, source_name="sample.pptx")


def test_extract_pptx_raises_on_corrupted_file(tmp_path):
    path = tmp_path / "corrupted.pptx"
    path.write_bytes(b"this is not a real pptx")

    with pytest.raises(ExtractionError, match="Corrupted"):
        extract_pptx(path, source_name="corrupted.pptx")
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pytest tests/test_extraction.py -v`
Expected: FAIL with `ImportError: cannot import name 'extract_pptx'`

- [ ] **Step 4: Implement `extract_pptx`**

Add to `backend/app/services/extraction.py` (add `from pptx import Presentation`
at the top, alongside the existing imports):

```python
def extract_pptx(file_path: Path, source_name: str) -> list[ExtractedSegment]:
    try:
        presentation = Presentation(file_path)
    except Exception as exc:
        raise ExtractionError(f"Corrupted or unreadable PPTX: {source_name} ({exc})") from exc

    segments: list[ExtractedSegment] = []
    for slide_index, slide in enumerate(presentation.slides):
        parts: list[str] = []
        for shape in slide.shapes:
            if shape.has_text_frame:
                shape_text = shape.text_frame.text.strip()
                if shape_text:
                    parts.append(shape_text)
            if shape.has_table:
                for row in shape.table.rows:
                    row_text = " | ".join(
                        cell.text.strip() for cell in row.cells if cell.text.strip()
                    )
                    if row_text:
                        parts.append(row_text)

        slide_text = "\n".join(parts).strip()
        if slide_text:
            segments.append(ExtractedSegment(
                text=slide_text,
                source_type="pptx",
                source_name=source_name,
                slide=slide_index + 1,
            ))

    if not segments:
        raise ExtractionError(f"PPTX has no extractable text: {source_name}")

    return segments
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest tests/test_extraction.py -v`
Expected: PASS (11 tests total)

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/extraction.py backend/tests/test_extraction.py \
  backend/requirements.txt
git commit -m "feat(backend): add PPTX extraction with slide text and table cells"
```

---

### Task 4: URL scraping

**Files:**
- Create: `backend/app/services/scraper.py`
- Create: `backend/tests/test_scraper.py`
- Modify: `backend/requirements.txt` (add trafilatura, beautifulsoup4, pytest-asyncio)
- Modify: `backend/pytest.ini` (enable asyncio auto mode)

**Interfaces:**
- Consumes: `ExtractedSegment`, `ExtractionError` (Task 1); `httpx.AsyncClient`
  (the checkpoint-1 singleton type, injected as a parameter here rather than
  via FastAPI `Depends` since this is a plain service function, not a route).
- Produces: `async def extract_url(url: str, http_client: httpx.AsyncClient) -> list[ExtractedSegment]`,
  always returning exactly one segment with `source_type="url"` and
  `source_url` set. Checkpoint 3's `/process` route will call this with
  `app.state.httpx_client`.

- [ ] **Step 1: Add the dependencies**

Append to `backend/requirements.txt`:

```
trafilatura>=1.12
beautifulsoup4>=4.12
pytest-asyncio>=0.24
```

Install: `pip install trafilatura>=1.12 beautifulsoup4>=4.12 pytest-asyncio>=0.24`
(from `backend/`, venv active).

Update `backend/pytest.ini` to:

```ini
[pytest]
pythonpath = .
asyncio_mode = auto
```

- [ ] **Step 2: Write the failing test**

`backend/tests/test_scraper.py`:

```python
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pytest tests/test_scraper.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.scraper'`

- [ ] **Step 4: Implement `app/services/scraper.py`**

```python
import httpx
import trafilatura
from bs4 import BeautifulSoup

from app.models import ExtractedSegment
from app.services.extraction import ExtractionError

_MIN_TRAFILATURA_CHARS = 200


async def extract_url(url: str, http_client: httpx.AsyncClient) -> list[ExtractedSegment]:
    try:
        response = await http_client.get(url, timeout=15.0, follow_redirects=True)
    except httpx.TimeoutException as exc:
        raise ExtractionError(f"URL timed out: {url}") from exc
    except httpx.HTTPError as exc:
        raise ExtractionError(f"Could not reach URL: {url} ({exc})") from exc

    if response.status_code >= 400:
        raise ExtractionError(f"URL returned HTTP {response.status_code}: {url}")

    html = response.text
    text = (trafilatura.extract(html) or "").strip()

    if len(text) < _MIN_TRAFILATURA_CHARS:
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "nav", "header", "footer"]):
            tag.decompose()
        fallback_text = soup.get_text(separator="\n").strip()
        if len(fallback_text) > len(text):
            text = fallback_text

    text = "\n".join(line.strip() for line in text.splitlines() if line.strip())

    if not text:
        raise ExtractionError(f"No readable content found at URL: {url}")

    return [ExtractedSegment(text=text, source_type="url", source_name=url, source_url=url)]
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest tests/test_scraper.py -v`
Expected: PASS (5 tests)

- [ ] **Step 6: Run the full backend test suite**

Run: `pytest -v`
Expected: PASS (23 tests total: 7 from checkpoint 1 + 11 extraction + 5 scraper)

- [ ] **Step 7: Commit**

```bash
git add backend/app/services/scraper.py backend/tests/test_scraper.py \
  backend/requirements.txt backend/pytest.ini
git commit -m "feat(backend): add URL extraction via trafilatura with BeautifulSoup fallback"
```

---

### Task 5: Token-windowed chunking

**Files:**
- Create: `backend/app/services/chunking.py`
- Create: `backend/tests/test_chunking.py`
- Modify: `backend/requirements.txt` (add tiktoken)

**Interfaces:**
- Consumes: `ExtractedSegment`, `Chunk` (Task 1).
- Produces: `chunk_segments(segments: list[ExtractedSegment], target_tokens: int = 650, overlap_tokens: int = 75) -> list[Chunk]`.
  Checkpoint 3's `/process` route calls this with the combined output of
  every extractor for one source.

- [ ] **Step 1: Add the dependency**

Append to `backend/requirements.txt`:

```
tiktoken>=0.7
```

Install: `pip install tiktoken>=0.7` (from `backend/`, venv active).

- [ ] **Step 2: Write the failing test**

`backend/tests/test_chunking.py`:

```python
import pytest

from app.models import ExtractedSegment
from app.services.chunking import chunk_segments


def test_chunk_segments_short_text_produces_one_chunk():
    segment = ExtractedSegment(text="Hello world, this is a short note.", source_type="txt", source_name="notes.txt")

    chunks = chunk_segments([segment])

    assert len(chunks) == 1
    chunk = chunks[0]
    assert chunk.text.strip() != ""
    assert chunk.source_name == "notes.txt"
    assert chunk.source_type == "txt"
    assert chunk.page is None
    assert chunk.slide is None
    assert chunk.chunk_id == "notes_txt_000_000"


def test_chunk_segments_long_text_splits_with_real_overlap():
    words = [f"word{i:04d}" for i in range(3000)]
    long_text = " ".join(words)
    segment = ExtractedSegment(text=long_text, source_type="pdf", source_name="report.pdf", page=3)

    chunks = chunk_segments([segment], target_tokens=650, overlap_tokens=75)

    assert len(chunks) > 1
    for chunk in chunks:
        assert chunk.page == 3
        assert chunk.source_type == "pdf"
        assert chunk.source_name == "report.pdf"

    first_words = set(chunks[0].text.split())
    second_words = set(chunks[1].text.split())
    shared = first_words & second_words
    assert len(shared) >= 5, "expected real overlap between consecutive chunks"


def test_chunk_segments_assigns_sequential_ids_per_segment():
    segments = [
        ExtractedSegment(text="short a", source_type="txt", source_name="a.txt"),
        ExtractedSegment(text="short b", source_type="txt", source_name="b.txt"),
    ]

    chunks = chunk_segments(segments)

    assert [c.chunk_id for c in chunks] == ["a_txt_000_000", "b_txt_000_000"]


def test_chunk_segments_preserves_slide_metadata():
    segment = ExtractedSegment(text="Slide body text", source_type="pptx", source_name="deck.pptx", slide=5)

    chunks = chunk_segments([segment])

    assert chunks[0].slide == 5
    assert chunks[0].page is None


def test_chunk_segments_rejects_overlap_not_smaller_than_target():
    segment = ExtractedSegment(text="x", source_type="txt", source_name="x.txt")

    with pytest.raises(ValueError, match="target_tokens must be greater than overlap_tokens"):
        chunk_segments([segment], target_tokens=100, overlap_tokens=100)
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pytest tests/test_chunking.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.chunking'`

- [ ] **Step 4: Implement `app/services/chunking.py`**

```python
import tiktoken

from app.models import Chunk, ExtractedSegment

_ENCODING = tiktoken.get_encoding("cl100k_base")

DEFAULT_TARGET_TOKENS = 650
DEFAULT_OVERLAP_TOKENS = 75


def _slugify(value: str) -> str:
    slug = "".join(c.lower() if c.isalnum() else "_" for c in value)
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug.strip("_") or "source"


def chunk_segments(
    segments: list[ExtractedSegment],
    target_tokens: int = DEFAULT_TARGET_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
) -> list[Chunk]:
    if target_tokens <= overlap_tokens:
        raise ValueError("target_tokens must be greater than overlap_tokens")

    chunks: list[Chunk] = []
    for seg_index, segment in enumerate(segments):
        tokens = _ENCODING.encode(segment.text)
        slug = _slugify(segment.source_name)

        if len(tokens) <= target_tokens:
            windows = [tokens]
        else:
            windows = []
            start = 0
            step = target_tokens - overlap_tokens
            while start < len(tokens):
                end = min(start + target_tokens, len(tokens))
                windows.append(tokens[start:end])
                if end == len(tokens):
                    break
                start += step

        for window_index, window in enumerate(windows):
            chunks.append(Chunk(
                chunk_id=f"{slug}_{seg_index:03d}_{window_index:03d}",
                text=_ENCODING.decode(window),
                source_type=segment.source_type,
                source_name=segment.source_name,
                source_url=segment.source_url,
                page=segment.page,
                slide=segment.slide,
            ))

    return chunks
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest tests/test_chunking.py -v`
Expected: PASS (5 tests)

- [ ] **Step 6: Run the full backend test suite**

Run: `pytest -v`
Expected: PASS (28 tests total)

- [ ] **Step 7: Commit**

```bash
git add backend/app/services/chunking.py backend/tests/test_chunking.py \
  backend/requirements.txt
git commit -m "feat(backend): add token-windowed chunking with metadata passthrough"
```

---

## After this checkpoint

Update `docs/superpowers/plans/2026-08-28-sonar-rag-roadmap.md`: mark
checkpoint 2 done, fill in "Where we left off", then write checkpoint 3's
plan (`2026-08-28-sonar-rag-03-embeddings-qdrant.md` — embeddings + Qdrant
collection setup + `/upload`, `/add-url`, `/process`) before starting it.
Checkpoint 3 is the first one that needs real Gemini + Qdrant Cloud keys for
end-to-end verification (unit tests still won't need them) — flag that to
Shephrine explicitly when checkpoint 2 wraps up.
