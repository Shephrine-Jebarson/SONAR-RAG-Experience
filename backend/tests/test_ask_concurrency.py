"""Regression test: /ask must not block the asyncio event loop.

routes/ask.py declares `async def ask(...)` but historically called fully
synchronous, network-blocking functions (_rewrite_query, retrieve, and the
Groq/Gemini streaming generator) directly inside the coroutine. Since these
calls never `await`, they hog the single-threaded event loop for their full
duration, serializing every other concurrent request on the same worker —
a real latency/throughput problem when multiple documents/users are being
served concurrently.

This test proves the fix directly: it runs a lightweight "heartbeat" task
(an asyncio.sleep loop) concurrently with an /ask request that has an
artificially slow (blocking) LLM call, and asserts the heartbeat keeps
ticking. If /ask blocks the event loop, the heartbeat task never gets
scheduled to run at all for the full duration of the blocking call —
which is exactly what was observed against the pre-fix code (zero ticks).

A wall-clock race against a second HTTP endpoint (e.g. /health) was tried
first and rejected: asyncio.gather's scheduling order let /health resolve
before /ask ever reached its blocking call often enough to mask the bug.
Measuring event-loop responsiveness directly has no such ordering luck.
"""

import asyncio
import time
from unittest.mock import MagicMock

import httpx

from app.config import Settings
from app.dependencies import get_app_settings, get_gemini_client, get_groq_client, get_qdrant_client
from app.main import app

_GROQ_DELAY = 0.4
_HEARTBEAT_INTERVAL = 0.01


def _slow_groq(delay: float):
    """Mock Groq client whose chat completion blocks synchronously for `delay`
    seconds — simulates real network latency without an actual network call."""
    groq = MagicMock()

    def _create(*args, **kwargs):
        time.sleep(delay)
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "answer"
        return iter([chunk])

    groq.chat.completions.create.side_effect = _create
    return groq


def _fast_gemini_and_qdrant():
    gemini = MagicMock()
    response = MagicMock()
    response.embeddings = [MagicMock(values=[1.0, 0.0])]
    gemini.models.embed_content.return_value = response

    qdrant = MagicMock()
    point = MagicMock()
    point.id = 1
    point.score = 0.9
    point.vector = [1.0, 0.0]
    point.payload = {
        "chunk_id": "c1", "text": "content", "source_type": "txt",
        "source_name": "a.txt", "source_url": None, "page": None, "slide": None,
    }
    result = MagicMock()
    result.points = [point]
    qdrant.query_points.return_value = result
    qdrant.get_collections.return_value = MagicMock(collections=[])
    return gemini, qdrant


async def test_ask_does_not_block_event_loop_during_llm_call():
    """The asyncio event loop must keep servicing other ready tasks (proxied
    here by a heartbeat timer) while /ask is mid-flight with a slow LLM call."""
    gemini, qdrant = _fast_gemini_and_qdrant()
    settings = Settings(groq_api_key="x", gemini_api_key="x", qdrant_url="x", qdrant_api_key="x")

    app.dependency_overrides[get_app_settings] = lambda: settings
    app.dependency_overrides[get_gemini_client] = lambda: gemini
    app.dependency_overrides[get_qdrant_client] = lambda: qdrant
    app.dependency_overrides[get_groq_client] = lambda: _slow_groq(delay=_GROQ_DELAY)

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            gaps: list[float] = []
            last = time.monotonic()
            stop = False

            async def _heartbeat():
                nonlocal last
                while not stop:
                    await asyncio.sleep(_HEARTBEAT_INTERVAL)
                    now = time.monotonic()
                    gaps.append(now - last)
                    last = now

            hb_task = asyncio.create_task(_heartbeat())
            try:
                ask_resp = await client.post("/ask?stream=false", json={"query": "what is this?"})
            finally:
                stop = True
                hb_task.cancel()
                try:
                    await hb_task
                except asyncio.CancelledError:
                    pass

        assert ask_resp.status_code == 200

        # Expect roughly _GROQ_DELAY / _HEARTBEAT_INTERVAL ticks. If /ask blocks
        # the event loop for its whole blocking call, the heartbeat task never
        # gets scheduled during that window (in the worst case: zero ticks at
        # all for the entire request).
        expected_ticks = _GROQ_DELAY / _HEARTBEAT_INTERVAL
        assert len(gaps) >= expected_ticks * 0.5, (
            f"heartbeat only ticked {len(gaps)} times (expected ~{expected_ticks:.0f}) "
            "while /ask was in flight — the event loop was blocked, meaning /ask is "
            "not offloading its blocking calls to a thread."
        )
        assert max(gaps, default=0.0) < _GROQ_DELAY * 0.5, (
            f"largest heartbeat gap was {max(gaps):.2f}s — the event loop stalled "
            "while /ask was in flight."
        )
    finally:
        app.dependency_overrides.pop(get_app_settings, None)
        app.dependency_overrides.pop(get_gemini_client, None)
        app.dependency_overrides.pop(get_qdrant_client, None)
        app.dependency_overrides.pop(get_groq_client, None)
