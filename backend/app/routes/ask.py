"""POST /ask — voice query endpoint.

Returns a StreamingResponse of plain text tokens so the frontend can start
speechSynthesis on the first complete sentence rather than waiting for full
generation (design spec §7 / instructions.md §12 latency checklist).

The stream format is newline-delimited plain text. The frontend reads it via
a ReadableStream reader, accumulates tokens, and fires TTS on each sentence
boundary (period/question-mark/exclamation followed by whitespace or end).

A non-streaming JSON path (?stream=false) is kept for tests and health checks.
"""

import json
from collections.abc import AsyncIterator, Iterator
from typing import TypeVar

import anyio
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from google import genai
from groq import Groq
from pydantic import BaseModel
from qdrant_client import QdrantClient

from app.config import Settings
from app.dependencies import get_app_settings, get_gemini_client, get_groq_client, get_qdrant_client
from app.models import RetrievedChunk
from app.services.llm import GROQ_MODEL, generate_answer_stream
from app.services.retrieval import RetrievalError, retrieve

router = APIRouter()

_FALLBACK_ANSWER = "I could not find that information in the uploaded sources."

_T = TypeVar("_T")
_EXHAUSTED = object()


def _next_or_exhausted(sync_iter: Iterator[_T]):
    # Must not let StopIteration cross the anyio thread/coroutine boundary:
    # anyio.to_thread.run_sync awaits the worker result from inside its own
    # coroutine, and PEP 479 turns an escaping StopIteration into a bare
    # RuntimeError there — so it has to be caught here, in the worker
    # thread, and turned into a plain sentinel return value instead.
    try:
        return next(sync_iter)
    except StopIteration:
        return _EXHAUSTED


async def _iter_in_thread(sync_iter: Iterator[_T]) -> AsyncIterator[_T]:
    """Bridge a synchronous iterator (Groq/Gemini streaming SDKs) into an
    async iterator without blocking the event loop.

    Each `next()` call — which may block on network I/O — runs in FastAPI's
    worker thread pool, so other requests on this worker keep making
    progress while a slow LLM call is in flight.
    """
    while True:
        item = await anyio.to_thread.run_sync(_next_or_exhausted, sync_iter)
        if item is _EXHAUSTED:
            return
        yield item

_REWRITE_PROMPT = """\
You are a query rewriter for a RAG system. Given the conversation history and a follow-up question,
rewrite the follow-up into a single self-contained search query that captures the full intent.
Output ONLY the rewritten query, no explanation.
"""


def _rewrite_query(query: str, history: list[dict], groq: Groq) -> str:
    """Rewrite a follow-up query using conversation history (spec §9 option a).

    Falls back to the original query on any error.
    """
    if not history:
        return query
    try:
        recent = history[-4:]  # last 2 exchanges
        history_text = "\n".join(
            f"{t['role'].upper()}: {t['content']}" for t in recent
        )
        response = groq.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": _REWRITE_PROMPT},
                {"role": "user", "content": f"HISTORY:\n{history_text}\n\nFOLLOW-UP: {query}"},
            ],
            max_tokens=80,
            temperature=0.0,
        )
        rewritten = response.choices[0].message.content.strip()
        return rewritten if rewritten else query
    except Exception:
        return query


class AskRequest(BaseModel):
    query: str
    top_k: int = 6
    temperature: float = 0.2
    conversation_history: list[dict] = []  # [{role: user|assistant, content: str}]


class CitationOut(BaseModel):
    chunk_id: str
    source_name: str
    source_type: str
    source_url: str | None = None
    page: int | None = None
    slide: int | None = None
    score: float
    excerpt: str


class AskResponse(BaseModel):
    answer: str
    citations: list[CitationOut]
    fallback: bool = False


def _make_citations(chunks: list[RetrievedChunk]) -> list[CitationOut]:
    return [
        CitationOut(
            chunk_id=c.chunk_id,
            source_name=c.source_name,
            source_type=c.source_type,
            source_url=c.source_url,
            page=c.page,
            slide=c.slide,
            score=round(c.score, 4),
            excerpt=c.text[:300],
        )
        for c in chunks
    ]


@router.post("/ask")
async def ask(
    body: AskRequest,
    stream: bool = Query(default=True),
    settings: Settings = Depends(get_app_settings),
    gemini: genai.Client = Depends(get_gemini_client),
    groq: Groq = Depends(get_groq_client),
    qdrant: QdrantClient = Depends(get_qdrant_client),
):
    if not body.query.strip():
        raise HTTPException(status_code=422, detail="query must not be empty")

    # --- Query rewrite for multi-turn (spec §9 option a) ---
    # Offloaded to the worker thread pool: this is a synchronous, blocking
    # Groq call, and `ask` is an `async def` route — calling it inline would
    # freeze the single-threaded event loop for its full round trip, stalling
    # every other concurrent request on this worker.
    effective_query = await run_in_threadpool(
        _rewrite_query, body.query, body.conversation_history, groq
    )

    # --- Retrieval --- (also offloaded: embeds the query + searches Qdrant,
    # both blocking network calls)
    try:
        chunks = await run_in_threadpool(
            retrieve,
            query=effective_query,
            top_k=body.top_k,
            qdrant=qdrant,
            gemini=gemini,
            collection_name=settings.qdrant_collection,
        )
    except RetrievalError as exc:
        raise HTTPException(status_code=503, detail=f"Retrieval failed: {exc}")

    citations = _make_citations(chunks)

    # Similarity gate fired — no relevant chunks.
    if not chunks:
        if stream:
            async def _fallback_stream():
                # Send citations header then fallback text
                yield json.dumps({"citations": [c.model_dump() for c in citations], "fallback": True}) + "\n"
                yield _FALLBACK_ANSWER
            return StreamingResponse(_fallback_stream(), media_type="text/plain")
        return AskResponse(answer=_FALLBACK_ANSWER, citations=[], fallback=True)

    # --- Streaming path (default) ---
    if stream:
        async def _answer_stream() -> AsyncIterator[str]:
            # First line: JSON metadata (citations + fallback flag) so the
            # frontend can render source chips before the answer finishes.
            yield json.dumps({
                "citations": [c.model_dump() for c in citations],
                "fallback": False,
            }) + "\n"

            # Subsequent lines: raw LLM tokens.
            # generate_answer_stream is a sync iterator — Groq and Gemini SDKs
            # are sync — so each `next()` (which may block on network I/O) is
            # bridged through the thread pool to keep the event loop free.
            sync_stream = generate_answer_stream(
                query=body.query,
                chunks=chunks,
                conversation_history=body.conversation_history,
                groq=groq,
                gemini=gemini,
                temperature=body.temperature,
            )
            async for token in _iter_in_thread(sync_stream):
                yield token

        return StreamingResponse(_answer_stream(), media_type="text/plain")

    # --- Non-streaming path (?stream=false) — used by tests ---
    def _collect_answer() -> str:
        return "".join(generate_answer_stream(
            query=body.query,
            chunks=chunks,
            conversation_history=body.conversation_history,
            groq=groq,
            gemini=gemini,
            temperature=body.temperature,
        ))

    answer = await run_in_threadpool(_collect_answer)
    return AskResponse(answer=answer, citations=citations, fallback=False)
