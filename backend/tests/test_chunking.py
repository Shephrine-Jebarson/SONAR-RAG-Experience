import pytest

from app.models import ExtractedSegment
from app.services.chunking import chunk_segments


def test_chunk_segments_short_text_produces_one_chunk():
    segment = ExtractedSegment(text="Hello world, this is a short note.", source_type="txt", source_name="notes.txt")

    chunks = chunk_segments([segment], source_id="src1")

    assert len(chunks) == 1
    chunk = chunks[0]
    assert chunk.text.strip() != ""
    assert chunk.source_name == "notes.txt"
    assert chunk.source_type == "txt"
    assert chunk.page is None
    assert chunk.slide is None
    assert chunk.chunk_id == "notes_txt_src1_000_000"


def test_chunk_segments_long_text_splits_with_real_overlap():
    words = [f"word{i:04d}" for i in range(3000)]
    long_text = " ".join(words)
    segment = ExtractedSegment(text=long_text, source_type="pdf", source_name="report.pdf", page=3)

    chunks = chunk_segments([segment], source_id="src1", target_tokens=650, overlap_tokens=75)

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

    chunks = chunk_segments(segments, source_id="src1")

    assert [c.chunk_id for c in chunks] == ["a_txt_src1_000_000", "b_txt_src1_000_000"]


def test_chunk_segments_preserves_slide_metadata():
    segment = ExtractedSegment(text="Slide body text", source_type="pptx", source_name="deck.pptx", slide=5)

    chunks = chunk_segments([segment], source_id="src1")

    assert chunks[0].slide == 5
    assert chunks[0].page is None


def test_chunk_segments_rejects_overlap_not_smaller_than_target():
    segment = ExtractedSegment(text="x", source_type="txt", source_name="x.txt")

    with pytest.raises(ValueError, match="target_tokens must be greater than overlap_tokens"):
        chunk_segments([segment], source_id="src1", target_tokens=100, overlap_tokens=100)


def test_chunk_segments_produces_different_ids_for_different_sources_with_same_filename():
    """Two distinct uploads sharing a filename (e.g. two 'notes.txt' uploads) must
    never collide on chunk_id — a collision means the second document's vectors
    silently overwrite the first document's vectors in Qdrant."""
    segment_a = ExtractedSegment(text="Alpha document content about cats.", source_type="txt", source_name="notes.txt")
    segment_b = ExtractedSegment(text="Beta document content about dogs.", source_type="txt", source_name="notes.txt")

    chunks_a = chunk_segments([segment_a], source_id="11111111-1111-1111-1111-111111111111")
    chunks_b = chunk_segments([segment_b], source_id="22222222-2222-2222-2222-222222222222")

    assert chunks_a[0].chunk_id != chunks_b[0].chunk_id
