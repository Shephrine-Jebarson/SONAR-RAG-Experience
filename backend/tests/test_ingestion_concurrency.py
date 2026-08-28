"""Regression tests: multi-document ingestion must not serialize independent
network calls.

Two separate bottlenecks were found by reading embeddings.py and process.py:

1. embed_chunks() looped through Gemini embedding batches (100 chunks each)
   one at a time — for a multi-document upload producing many chunks, wall
   clock time scaled linearly with batch count even though batches are
   independent, embarrassingly-parallel API calls.

2. _run_pipeline() processed each uploaded source (chunk -> embed -> upsert)
   one at a time in a for loop — for a multi-document upload, wall clock
   time scaled linearly with document count even though each source's
   pipeline is independent of the others.

Both tests use a mocked Gemini client whose embed_content call sleeps for a
fixed delay, and assert that N independent units of work complete in well
under N * delay — proof they're actually running concurrently, not just
technically importable as "parallel-looking" code.
"""

import time
from unittest.mock import MagicMock

from app.job_store import JobStatus, SourceStatus, create_job
from app.models import Chunk, ExtractedSegment
from app.routes.process import _run_pipeline
from app.services.embeddings import EMBEDDING_DIM, _BATCH_SIZE, embed_chunks

_CALL_DELAY = 0.3


def _slow_gemini(delay: float = _CALL_DELAY):
    """Mock genai.Client whose embed_content blocks for `delay` seconds —
    simulates real Gemini API latency without a real network call."""
    client = MagicMock()

    def _embed(model, contents, config=None):
        time.sleep(delay)
        response = MagicMock()
        response.embeddings = [MagicMock(values=[0.1] * EMBEDDING_DIM) for _ in contents]
        return response

    client.models.embed_content.side_effect = _embed
    return client


def test_embed_chunks_processes_batches_concurrently():
    n_chunks = _BATCH_SIZE * 3 + 50  # -> 4 embedding batches
    chunks = [
        Chunk(chunk_id=f"c{i}", text=f"text {i}", source_type="txt", source_name="a.txt")
        for i in range(n_chunks)
    ]
    client = _slow_gemini()

    start = time.monotonic()
    vectors = embed_chunks(chunks, client)
    elapsed = time.monotonic() - start

    assert len(vectors) == n_chunks
    # 4 sequential batches at _CALL_DELAY each would take ~4 * _CALL_DELAY.
    # Running them concurrently should finish in well under half that — a
    # generous margin so this doesn't flake under CI/system load, while
    # still clearly distinguishing "concurrent" from "sequential".
    sequential_estimate = 4 * _CALL_DELAY
    assert elapsed < sequential_estimate / 2, (
        f"embed_chunks took {elapsed:.2f}s for 4 batches (sequential would be "
        f"~{sequential_estimate:.2f}s) — batches are not running concurrently."
    )


def test_run_pipeline_processes_sources_concurrently():
    n_sources = 3
    source_ids = [f"src{i}" for i in range(n_sources)]
    all_staged: dict[str, list[ExtractedSegment]] = {
        sid: [ExtractedSegment(text=f"content for {sid}", source_type="txt", source_name=f"{sid}.txt")]
        for sid in source_ids
    }
    job = create_job(source_ids, {sid: f"{sid}.txt" for sid in source_ids})

    gemini = _slow_gemini()
    qdrant = MagicMock()
    qdrant.get_collections.return_value = MagicMock(collections=[])

    start = time.monotonic()
    _run_pipeline(job, source_ids, all_staged, gemini, qdrant, "col")
    elapsed = time.monotonic() - start

    assert job.status == JobStatus.DONE
    assert all(sp.status == SourceStatus.INDEXED for sp in job.sources)
    # 3 sequential sources at ~_CALL_DELAY embedding time each would take
    # ~3 * _CALL_DELAY. Processing sources concurrently should finish in
    # well under half that — a generous margin so this doesn't flake under
    # CI/system load, while still clearly distinguishing "concurrent" from
    # "sequential".
    sequential_estimate = n_sources * _CALL_DELAY
    assert elapsed < sequential_estimate / 2, (
        f"_run_pipeline took {elapsed:.2f}s for {n_sources} sources (sequential "
        f"would be ~{sequential_estimate:.2f}s) — sources are not processed "
        "concurrently."
    )
