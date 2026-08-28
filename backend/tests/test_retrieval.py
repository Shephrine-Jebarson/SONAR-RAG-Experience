"""Tests for checkpoint 4: retrieval service and /ask route.

All Qdrant and Gemini calls are mocked — no real API keys required.
"""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.dependencies import get_gemini_client, get_groq_client, get_qdrant_client
from app.main import app
from app.models import RetrievedChunk
from app.services.retrieval import (
    SIMILARITY_THRESHOLD,
    RetrievalError,
    _cosine,
    _mmr_rerank,
    retrieve,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_chunk(chunk_id: str, source_type: str, source_name: str, score: float) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk_id,
        text=f"text for {chunk_id}",
        source_type=source_type,
        source_name=source_name,
        score=score,
    )


def _fake_gemini_for_retrieval(query_vector: list[float]):
    """Mock genai.Client that returns a fixed query vector."""
    client = MagicMock()
    response = MagicMock()
    response.embeddings = [MagicMock(values=query_vector)]
    client.models.embed_content.return_value = response
    return client


def _fake_qdrant_with_points(scored_points: list):
    """Mock QdrantClient.query_points returning given ScoredPoint-like objects."""
    client = MagicMock()
    result = MagicMock()
    result.points = scored_points
    client.query_points.return_value = result
    return client


def _make_scored_point(chunk_id: str, source_type: str, source_name: str,
                        score: float, vector: list[float]):
    p = MagicMock()
    p.id = abs(hash(chunk_id)) % (2 ** 63)
    p.score = score
    p.vector = vector
    p.payload = {
        "chunk_id": chunk_id,
        "text": f"text for {chunk_id}",
        "source_type": source_type,
        "source_name": source_name,
        "source_url": None,
        "page": None,
        "slide": None,
    }
    return p


# ---------------------------------------------------------------------------
# _cosine unit tests
# ---------------------------------------------------------------------------

def test_cosine_identical_vectors_returns_one():
    v = [1.0, 0.0, 0.0]
    assert abs(_cosine(v, v) - 1.0) < 1e-6


def test_cosine_orthogonal_vectors_returns_zero():
    assert abs(_cosine([1.0, 0.0], [0.0, 1.0])) < 1e-6


def test_cosine_zero_vector_returns_zero():
    assert _cosine([0.0, 0.0], [1.0, 0.0]) == 0.0


# ---------------------------------------------------------------------------
# _mmr_rerank unit tests
# ---------------------------------------------------------------------------

def test_mmr_rerank_returns_top_k_items():
    chunks = [
        _make_chunk("a", "pdf", "doc.pdf", 0.9),
        _make_chunk("b", "txt", "notes.txt", 0.85),
        _make_chunk("c", "url", "https://x.com", 0.80),
        _make_chunk("d", "pdf", "doc.pdf", 0.75),
    ]
    # Orthogonal vectors — no redundancy penalty, so order is by relevance
    vectors = [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
    result = _mmr_rerank(chunks, vectors, top_k=2)
    assert len(result) == 2


def test_mmr_rerank_penalises_redundant_chunks():
    """Two nearly identical chunks from the same source — MMR should prefer
    the diverse one (different source) over the redundant one."""
    chunks = [
        _make_chunk("a", "pdf", "doc.pdf", 0.9),   # highest relevance
        _make_chunk("b", "pdf", "doc.pdf", 0.88),  # very similar to a
        _make_chunk("c", "url", "https://x.com", 0.70),  # diverse source
    ]
    # a and b are nearly identical; c is orthogonal
    vectors = [
        [1.0, 0.0],
        [0.99, 0.14],   # almost same direction as a
        [0.0, 1.0],     # orthogonal
    ]
    result = _mmr_rerank(chunks, vectors, top_k=2, lambda_=0.5)
    ids = [r.chunk_id for r in result]
    # a is selected first (highest relevance); b should be penalised so c wins
    assert ids[0] == "a"
    assert ids[1] == "c", f"Expected diverse chunk 'c' at position 1, got {ids[1]}"


def test_mmr_rerank_empty_input_returns_empty():
    assert _mmr_rerank([], [], top_k=4) == []


def test_mmr_rerank_fewer_candidates_than_top_k():
    chunks = [_make_chunk("a", "pdf", "doc.pdf", 0.9)]
    vectors = [[1.0, 0.0]]
    result = _mmr_rerank(chunks, vectors, top_k=4)
    assert len(result) == 1


# ---------------------------------------------------------------------------
# retrieve() integration tests (mocked Qdrant + Gemini)
# ---------------------------------------------------------------------------

def test_retrieve_returns_reranked_chunks():
    query_vec = [1.0, 0.0, 0.0]
    points = [
        _make_scored_point("a", "pdf", "doc.pdf", 0.92, [1.0, 0.0, 0.0]),
        _make_scored_point("b", "txt", "notes.txt", 0.85, [0.0, 1.0, 0.0]),
        _make_scored_point("c", "url", "https://x.com", 0.80, [0.0, 0.0, 1.0]),
    ]
    gemini = _fake_gemini_for_retrieval(query_vec)
    qdrant = _fake_qdrant_with_points(points)

    result = retrieve("what is RAG?", top_k=2, qdrant=qdrant, gemini=gemini,
                      collection_name="col", similarity_threshold=0.5)

    assert len(result) == 2
    assert all(isinstance(r, RetrievedChunk) for r in result)


def test_retrieve_returns_empty_when_no_points():
    gemini = _fake_gemini_for_retrieval([1.0, 0.0])
    qdrant = _fake_qdrant_with_points([])

    result = retrieve("anything", top_k=4, qdrant=qdrant, gemini=gemini,
                      collection_name="col")
    assert result == []


def test_default_similarity_threshold_accepts_real_world_near_miss():
    """Regression test for a live false-negative: against a real 2-resume
    Qdrant collection, the query "What are the names of the 2 candidates?"
    scored 0.5484 for the chunk that actually answers it — a legitimate,
    answerable match — but the old default threshold of 0.55 rejected it,
    silently returning the "could not find" fallback instead of asking the
    LLM. Independently, genuinely irrelevant questions against the same
    collection scored 0.4723-0.5011. The default must sit below the former
    and above the latter so this exact class of query is no longer a false
    negative, without reopening the gate to genuinely irrelevant content."""
    assert SIMILARITY_THRESHOLD < 0.5484, (
        "default threshold must accept the empirically-observed real-world "
        "near-miss score for a legitimate, answerable query"
    )
    assert SIMILARITY_THRESHOLD > 0.5011, (
        "default threshold must still reject the empirically-observed "
        "scores for genuinely irrelevant queries"
    )


def test_retrieve_accepts_previously_rejected_near_miss_score():
    """Same regression, expressed behaviorally with a mocked score pinned to
    the exact real-world value that used to be wrongly rejected."""
    query_vec = [1.0, 0.0]
    near_miss_score = 0.5484  # the real score observed for a legitimate match
    points = [_make_scored_point("a", "txt", "resume_a.txt", near_miss_score, [1.0, 0.0])]
    gemini = _fake_gemini_for_retrieval(query_vec)
    qdrant = _fake_qdrant_with_points(points)

    result = retrieve("What are the names of the 2 candidates?", top_k=4,
                      qdrant=qdrant, gemini=gemini, collection_name="col")

    assert len(result) == 1, "a legitimate near-miss match must not be silently dropped"


def test_retrieve_returns_empty_when_best_score_below_threshold():
    query_vec = [1.0, 0.0]
    points = [_make_scored_point("a", "pdf", "doc.pdf", 0.30, [1.0, 0.0])]
    gemini = _fake_gemini_for_retrieval(query_vec)
    qdrant = _fake_qdrant_with_points(points)

    result = retrieve("anything", top_k=4, qdrant=qdrant, gemini=gemini,
                      collection_name="col", similarity_threshold=0.5)
    assert result == []


def test_retrieve_raises_retrieval_error_on_qdrant_failure():
    gemini = _fake_gemini_for_retrieval([1.0, 0.0])
    qdrant = MagicMock()
    qdrant.query_points.side_effect = ConnectionError("qdrant down")

    with pytest.raises(RetrievalError, match="Qdrant search failed"):
        retrieve("query", top_k=4, qdrant=qdrant, gemini=gemini, collection_name="col")


def test_retrieve_raises_retrieval_error_on_embedding_failure():
    gemini = MagicMock()
    gemini.models.embed_content.side_effect = RuntimeError("quota exceeded")
    qdrant = MagicMock()

    with pytest.raises(RetrievalError, match="Query embedding failed"):
        retrieve("query", top_k=4, qdrant=qdrant, gemini=gemini, collection_name="col")


# ---------------------------------------------------------------------------
# /ask route tests
# ---------------------------------------------------------------------------

def _fake_groq_empty():
    """Mock Groq client that returns an empty stream (LLM not under test here)."""
    groq = MagicMock()
    chunk = MagicMock()
    chunk.choices = [MagicMock()]
    chunk.choices[0].delta.content = "answer text"
    groq.chat.completions.create.return_value = iter([chunk])
    return groq


def _setup_ask_overrides(gemini=None, qdrant=None):
    app.dependency_overrides[get_gemini_client] = lambda: gemini
    app.dependency_overrides[get_qdrant_client] = lambda: qdrant
    app.dependency_overrides[get_groq_client] = lambda: _fake_groq_empty()


def _teardown_ask_overrides():
    app.dependency_overrides.pop(get_gemini_client, None)
    app.dependency_overrides.pop(get_qdrant_client, None)
    app.dependency_overrides.pop(get_groq_client, None)


def test_ask_returns_fallback_when_no_chunks_retrieved():
    query_vec = [1.0, 0.0]
    gemini = _fake_gemini_for_retrieval(query_vec)
    qdrant = _fake_qdrant_with_points([])
    _setup_ask_overrides(gemini=gemini, qdrant=qdrant)
    try:
        with TestClient(app) as client:
            resp = client.post("/ask?stream=false", json={"query": "unknown topic"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["fallback"] is True
        assert "could not find" in body["answer"].lower()
        assert body["citations"] == []
    finally:
        _teardown_ask_overrides()


def test_ask_returns_citations_when_chunks_retrieved():
    query_vec = [1.0, 0.0, 0.0]
    points = [
        _make_scored_point("a", "pdf", "report.pdf", 0.92, [1.0, 0.0, 0.0]),
        _make_scored_point("b", "txt", "notes.txt", 0.85, [0.0, 1.0, 0.0]),
    ]
    gemini = _fake_gemini_for_retrieval(query_vec)
    qdrant = _fake_qdrant_with_points(points)
    _setup_ask_overrides(gemini=gemini, qdrant=qdrant)
    try:
        with TestClient(app) as client:
            resp = client.post("/ask?stream=false", json={"query": "what is the architecture?"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["fallback"] is False
        assert len(body["citations"]) >= 1
        assert body["citations"][0]["source_name"] in ("report.pdf", "notes.txt")
    finally:
        _teardown_ask_overrides()


def test_ask_returns_fallback_when_score_below_threshold():
    query_vec = [1.0, 0.0]
    points = [_make_scored_point("a", "pdf", "doc.pdf", 0.20, [1.0, 0.0])]
    gemini = _fake_gemini_for_retrieval(query_vec)
    qdrant = _fake_qdrant_with_points(points)
    _setup_ask_overrides(gemini=gemini, qdrant=qdrant)
    try:
        with TestClient(app) as client:
            resp = client.post("/ask?stream=false", json={"query": "irrelevant question"})
        assert resp.status_code == 200
        assert resp.json()["fallback"] is True
    finally:
        _teardown_ask_overrides()


def test_ask_returns_503_on_retrieval_error():
    gemini = MagicMock()
    gemini.models.embed_content.side_effect = RuntimeError("embedding down")
    qdrant = MagicMock()
    _setup_ask_overrides(gemini=gemini, qdrant=qdrant)
    try:
        with TestClient(app) as client:
            resp = client.post("/ask?stream=false", json={"query": "test"})
        assert resp.status_code == 503
    finally:
        _teardown_ask_overrides()


def test_ask_rejects_empty_query():
    with TestClient(app) as client:
        resp = client.post("/ask?stream=false", json={"query": "   "})
    assert resp.status_code == 422


def test_ask_respects_top_k_parameter():
    query_vec = [1.0, 0.0, 0.0, 0.0]
    points = [
        _make_scored_point(f"chunk_{i}", "pdf", "doc.pdf", 0.9 - i * 0.05,
                           [1.0 if j == i else 0.0 for j in range(4)])
        for i in range(4)
    ]
    gemini = _fake_gemini_for_retrieval(query_vec)
    qdrant = _fake_qdrant_with_points(points)
    _setup_ask_overrides(gemini=gemini, qdrant=qdrant)
    try:
        with TestClient(app) as client:
            resp = client.post("/ask?stream=false", json={"query": "test", "top_k": 2})
        assert resp.status_code == 200
        assert len(resp.json()["citations"]) <= 2
    finally:
        _teardown_ask_overrides()
