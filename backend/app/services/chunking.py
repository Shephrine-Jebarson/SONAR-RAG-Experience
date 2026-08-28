"""Chunking service — splits extracted document text into token-windowed
Chunks ready for embedding.

Takes the ExtractedSegments produced by app/services/extraction.py (one
segment per page/slide/whole-file) and slides a fixed-size token window
across each one, with overlap, so long segments become multiple Chunks
while short ones stay as a single Chunk. Each chunk_id is deterministic
(derived from the source_id passed in) so re-processing the same source
overwrites the same Qdrant points instead of creating duplicates — see the
chunk_id format note on chunk_segments() below.
"""

import tiktoken

from app.models import Chunk, ExtractedSegment

# cl100k_base is the encoding used by text-embedding-ada-002 and GPT-4.
# It's a cheap, accurate-enough token counter for chunk sizing — we're not
# calling the Gemini tokenizer here, just sizing windows consistently.
_ENCODING = tiktoken.get_encoding("cl100k_base")

DEFAULT_TARGET_TOKENS = 650   # ~500–800 token target per instructions.md §6
DEFAULT_OVERLAP_TOKENS = 75   # ~50–100 token overlap per instructions.md §6


def _slugify(value: str) -> str:
    """Convert a source name to a safe lowercase identifier fragment."""
    slug = "".join(c.lower() if c.isalnum() else "_" for c in value)
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug.strip("_") or "source"


def chunk_segments(
    segments: list[ExtractedSegment],
    source_id: str,
    target_tokens: int = DEFAULT_TARGET_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
) -> list[Chunk]:
    """Split a list of ExtractedSegments into token-windowed Chunks.

    Each chunk carries the full metadata (source_type, source_name,
    source_url, page, slide) from its originating segment so checkpoint 3
    can store it directly in Qdrant without reconstruction.

    source_id must be the caller's unique id for this source (e.g. the
    upload/url source_id). It's folded into chunk_id so two different
    documents that happen to share a filename (e.g. two "notes.txt"
    uploads) never collide on chunk_id — a collision would make the
    second document's vectors silently overwrite the first's in Qdrant.

    chunk_id format: {source_slug}_{source_id}_{seg_index:03d}_{window_index:03d}
    e.g. "report_pdf_3f2a.._002_005" — segment 2, window 5 of report.pdf
    """
    if target_tokens <= overlap_tokens:
        raise ValueError("target_tokens must be greater than overlap_tokens")

    # Track per-source segment counters so IDs are stable regardless of how
    # many other sources appear in the same batch.
    source_seg_counters: dict[str, int] = {}

    chunks: list[Chunk] = []
    for segment in segments:
        tokens = _ENCODING.encode(segment.text)
        slug = _slugify(segment.source_name)
        seg_index = source_seg_counters.get(slug, 0)
        source_seg_counters[slug] = seg_index + 1

        if len(tokens) <= target_tokens:
            windows = [tokens]
        else:
            windows = []
            step = target_tokens - overlap_tokens
            start = 0
            while start < len(tokens):
                end = min(start + target_tokens, len(tokens))
                windows.append(tokens[start:end])
                if end == len(tokens):
                    break
                start += step

        for window_index, window in enumerate(windows):
            chunks.append(Chunk(
                chunk_id=f"{slug}_{source_id}_{seg_index:03d}_{window_index:03d}",
                text=_ENCODING.decode(window),
                source_type=segment.source_type,
                source_name=segment.source_name,
                source_url=segment.source_url,
                page=segment.page,
                slide=segment.slide,
            ))

    return chunks
