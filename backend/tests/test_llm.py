"""Tests for checkpoint 5: LLM generation service and streaming /ask route.

All Groq and Gemini generation calls are mocked — no real API keys required.
"""

import json
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from app.dependencies import get_gemini_client, get_groq_client, get_qdrant_client
from app.main import app
from app.models import RetrievedChunk
from app.services.llm import (
    GROQ_MODEL,
    _FALLBACK_ANSWER,
    _SYSTEM_PROMPT,
    _build_messages,
    generate_answer_stream,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_chunk(chunk_id: str, source_name: str, text: str = "chunk text") -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk_id,
        text=text,
        source_type="pdf",
        source_name=source_name,
        score=0.9,
    )


def _fake_groq_stream(tokens: list[str]):
    """Mock Groq client that yields given tokens from chat.completions.create."""
    groq = MagicMock()
    chunks = []
    for token in tokens:
        c = MagicMock()
        c.choices = [MagicMock()]
        c.choices[0].delta.content = token
        chunks.append(c)
    groq.chat.completions.create.return_value = iter(chunks)
    return groq


def _fake_groq_error():
    groq = MagicMock()
    groq.chat.completions.create.side_effect = RuntimeError("groq rate limit")
    return groq


def _fake_gemini_stream(tokens: list[str]):
    gemini = MagicMock()
    responses = [MagicMock(text=t) for t in tokens]
    gemini.models.generate_content_stream.return_value = iter(responses)
    return gemini


def _fake_gemini_error():
    gemini = MagicMock()
    gemini.models.generate_content_stream.side_effect = RuntimeError("gemini down")
    return gemini


def _fake_gemini_for_retrieval(query_vector: list[float]):
    client = MagicMock()
    response = MagicMock()
    response.embeddings = [MagicMock(values=query_vector)]
    client.models.embed_content.return_value = response
    return client


def _fake_qdrant_with_points(scored_points: list):
    client = MagicMock()
    result = MagicMock()
    result.points = scored_points
    client.query_points.return_value = result
    return client


def _make_scored_point(chunk_id: str, score: float, vector: list[float]):
    p = MagicMock()
    p.id = abs(hash(chunk_id)) % (2 ** 63)
    p.score = score
    p.vector = vector
    p.payload = {
        "chunk_id": chunk_id,
        "text": f"text for {chunk_id}",
        "source_type": "pdf",
        "source_name": "doc.pdf",
        "source_url": None,
        "page": 1,
        "slide": None,
    }
    return p


# ---------------------------------------------------------------------------
# _build_messages tests
# ---------------------------------------------------------------------------

def test_build_messages_includes_system_prompt():
    chunks = [_make_chunk("a", "doc.pdf", "Some content.")]
    messages = _build_messages("what is this?", chunks, [])
    assert messages[0]["role"] == "system"
    assert "using only the information" in messages[0]["content"].lower()


def test_build_messages_includes_source_name_in_context():
    chunks = [_make_chunk("a", "report.pdf", "Important finding.")]
    messages = _build_messages("summarise", chunks, [])
    user_msg = messages[-1]["content"]
    assert "report.pdf" in user_msg
    assert "Important finding." in user_msg


def test_build_messages_includes_conversation_history():
    history = [
        {"role": "user", "content": "What is RAG?"},
        {"role": "assistant", "content": "RAG stands for Retrieval-Augmented Generation."},
    ]
    chunks = [_make_chunk("a", "doc.pdf")]
    messages = _build_messages("Tell me more.", chunks, history)
    roles = [m["role"] for m in messages]
    assert "user" in roles
    assert "assistant" in roles


def test_build_messages_truncates_history_to_last_six_turns():
    history = [{"role": "user", "content": f"msg {i}"} for i in range(20)]
    chunks = [_make_chunk("a", "doc.pdf")]
    messages = _build_messages("new question", chunks, history)
    # system + up to 6 history + 1 user = max 8
    assert len(messages) <= 8


def test_build_messages_includes_page_number_when_present():
    chunk = RetrievedChunk(
        chunk_id="a", text="text", source_type="pdf",
        source_name="manual.pdf", score=0.9, page=7,
    )
    messages = _build_messages("question", [chunk], [])
    assert "page 7" in messages[-1]["content"]


# ---------------------------------------------------------------------------
# generate_answer_stream tests
# ---------------------------------------------------------------------------

def test_groq_stream_yields_tokens():
    groq = _fake_groq_stream(["Hello", " world", "."])
    gemini = MagicMock()
    chunks = [_make_chunk("a", "doc.pdf")]

    tokens = list(generate_answer_stream("q", chunks, [], groq, gemini))

    assert "".join(tokens) == "Hello world."
    groq.chat.completions.create.assert_called_once()
    gemini.models.generate_content_stream.assert_not_called()


def test_gemini_fallback_used_when_groq_fails():
    groq = _fake_groq_error()
    gemini = _fake_gemini_stream(["Fallback", " answer."])
    chunks = [_make_chunk("a", "doc.pdf")]

    tokens = list(generate_answer_stream("q", chunks, [], groq, gemini))

    assert "Fallback answer." in "".join(tokens)
    gemini.models.generate_content_stream.assert_called_once()


def test_fixed_fallback_returned_when_both_fail():
    groq = _fake_groq_error()
    gemini = _fake_gemini_error()
    chunks = [_make_chunk("a", "doc.pdf")]

    tokens = list(generate_answer_stream("q", chunks, [], groq, gemini))

    assert "".join(tokens) == _FALLBACK_ANSWER


def test_groq_called_with_correct_model_and_stream_flag():
    groq = _fake_groq_stream(["ok"])
    gemini = MagicMock()
    chunks = [_make_chunk("a", "doc.pdf")]

    list(generate_answer_stream("q", chunks, [], groq, gemini))

    call_kwargs = groq.chat.completions.create.call_args.kwargs
    assert call_kwargs["stream"] is True
    assert call_kwargs["model"] == GROQ_MODEL
    assert call_kwargs["max_tokens"] > 0


def test_temperature_passed_to_groq():
    groq = _fake_groq_stream(["ok"])
    gemini = MagicMock()
    chunks = [_make_chunk("a", "doc.pdf")]

    list(generate_answer_stream("q", chunks, [], groq, gemini, temperature=0.7))

    assert groq.chat.completions.create.call_args.kwargs["temperature"] == 0.7


def test_none_delta_tokens_are_skipped():
    """Groq sometimes yields chunks with delta.content = None — must not crash."""
    groq = MagicMock()
    c1 = MagicMock(); c1.choices = [MagicMock()]; c1.choices[0].delta.content = None
    c2 = MagicMock(); c2.choices = [MagicMock()]; c2.choices[0].delta.content = "real"
    groq.chat.completions.create.return_value = iter([c1, c2])
    gemini = MagicMock()
    chunks = [_make_chunk("a", "doc.pdf")]

    tokens = list(generate_answer_stream("q", chunks, [], groq, gemini))
    assert "".join(tokens) == "real"


# ---------------------------------------------------------------------------
# /ask streaming route tests
# ---------------------------------------------------------------------------

def _setup_overrides(gemini_embed=None, qdrant=None, groq=None, gemini_gen=None):
    """Set up dependency overrides.

    gemini_embed: mock for embed_content (retrieval)
    gemini_gen:   mock for generate_content_stream (generation)
    When both are needed, we combine them on one mock.
    """
    if gemini_embed is not None and gemini_gen is not None:
        # Combine: embed_content on one mock, generate_content_stream on another
        combined = MagicMock()
        combined.models.embed_content.side_effect = gemini_embed.models.embed_content.side_effect or (
            lambda **kw: gemini_embed.models.embed_content(**kw)
        )
        combined.models.embed_content.return_value = gemini_embed.models.embed_content.return_value
        combined.models.generate_content_stream.return_value = gemini_gen.models.generate_content_stream.return_value
        app.dependency_overrides[get_gemini_client] = lambda: combined
    elif gemini_embed is not None:
        app.dependency_overrides[get_gemini_client] = lambda: gemini_embed
    if qdrant is not None:
        app.dependency_overrides[get_qdrant_client] = lambda: qdrant
    if groq is not None:
        app.dependency_overrides[get_groq_client] = lambda: groq


def _teardown_overrides():
    app.dependency_overrides.pop(get_gemini_client, None)
    app.dependency_overrides.pop(get_qdrant_client, None)
    app.dependency_overrides.pop(get_groq_client, None)


def test_streaming_ask_first_line_is_citations_json():
    query_vec = [1.0, 0.0]
    points = [_make_scored_point("a", 0.92, [1.0, 0.0])]

    gemini_embed = _fake_gemini_for_retrieval(query_vec)
    gemini_gen = _fake_gemini_stream(["The answer is here."])
    groq = _fake_groq_stream(["The answer is here."])

    _setup_overrides(
        gemini_embed=gemini_embed,
        gemini_gen=gemini_gen,
        qdrant=_fake_qdrant_with_points(points),
        groq=groq,
    )
    try:
        with TestClient(app) as client:
            resp = client.post("/ask", json={"query": "what is this?"})
        assert resp.status_code == 200
        lines = resp.text.strip().split("\n")
        first = json.loads(lines[0])
        assert "citations" in first
        assert first["fallback"] is False
        assert len(first["citations"]) >= 1
    finally:
        _teardown_overrides()


def test_streaming_ask_subsequent_lines_are_answer_tokens():
    query_vec = [1.0, 0.0]
    points = [_make_scored_point("a", 0.92, [1.0, 0.0])]

    gemini_embed = _fake_gemini_for_retrieval(query_vec)
    groq = _fake_groq_stream(["Token1", " Token2"])

    _setup_overrides(
        gemini_embed=gemini_embed,
        qdrant=_fake_qdrant_with_points(points),
        groq=groq,
    )
    try:
        with TestClient(app) as client:
            resp = client.post("/ask", json={"query": "test"})
        lines = resp.text.strip().split("\n")
        answer_text = "".join(lines[1:])
        assert "Token1" in answer_text
        assert "Token2" in answer_text
    finally:
        _teardown_overrides()


def test_streaming_ask_fallback_when_no_chunks():
    query_vec = [1.0, 0.0]
    gemini_embed = _fake_gemini_for_retrieval(query_vec)
    groq = _fake_groq_stream([])

    _setup_overrides(
        gemini_embed=gemini_embed,
        qdrant=_fake_qdrant_with_points([]),
        groq=groq,
    )
    try:
        with TestClient(app) as client:
            resp = client.post("/ask", json={"query": "unknown"})
        lines = resp.text.strip().split("\n")
        meta = json.loads(lines[0])
        assert meta["fallback"] is True
        assert "could not find" in "".join(lines[1:]).lower()
    finally:
        _teardown_overrides()
