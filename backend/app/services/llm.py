"""LLM answer generation service.

Groq primary (llama3-70b-8192, stream=True) with a real try/except
that catches timeout, rate-limit, and service errors and falls back to
Gemini (gemini-2.5-flash, generate_content_stream).

Both paths yield plain text tokens so the caller can build a StreamingResponse
and the frontend can start speechSynthesis on the first complete sentence
rather than waiting for full generation — the single biggest perceived-latency
improvement for a voice assistant (design spec §7, instructions.md §12).
"""

from collections.abc import Iterator
from typing import Optional

from google import genai
from google.genai import types as genai_types
from groq import Groq

from app.models import RetrievedChunk

# Models
GROQ_MODEL = "openai/gpt-oss-120b"
GEMINI_MODEL = "gemini-2.0-flash"

# Cap tokens — keeps spoken answers concise but not clipped.
MAX_TOKENS = 500

# Groq errors that should trigger Gemini fallback.
_GROQ_FALLBACK_EXCEPTIONS = (Exception,)  # catch-all; Groq raises various subtypes

_SYSTEM_PROMPT = """\
You are a helpful, conversational voice assistant. Answer naturally as if speaking to a person — warm, clear, and direct.

Rules:
- Answer using only the information in the SOURCE EXCERPTS below.
- If the excerpts don't contain the answer, say: "I couldn't find that in the uploaded sources."
- Always start your answer by naturally referencing where the information comes from — for example: "Under the summary section on page 8..." or "From the introduction on slide 3..." or "In the methodology section...". Use the page or slide number from the source if available.
- Keep answers concise and spoken-friendly. For simple questions use 1-2 sentences. For comparisons or multi-part questions use up to 5 sentences. No bullet points or lists.
- Never mention chunk IDs, document names, or internal system details.
- Sound natural — like a knowledgeable friend explaining something, not a formal report.
"""

_FALLBACK_ANSWER = "I could not find that information in the uploaded sources."


def _build_messages(
    query: str,
    chunks: list[RetrievedChunk],
    conversation_history: list[dict],
) -> list[dict]:
    """Build the messages list for Groq chat completions.

    Includes rolling conversation history (last 6 turns max) so follow-up
    questions like "What about international customers?" resolve correctly
    even when raw retrieval is imperfect (design spec §7 option b).
    """
    context_block = "\n\n".join(
        f"[Source: {c.source_name}"
        + (f", page {c.page}" if c.page else "")
        + (f", slide {c.slide}" if c.slide else "")
        + f"]\n{c.text}"
        for c in chunks
    )

    # Keep last 6 turns (3 exchanges) to stay within context limits.
    recent_history = conversation_history[-6:] if conversation_history else []

    messages: list[dict] = [{"role": "system", "content": _SYSTEM_PROMPT}]
    messages.extend(recent_history)
    messages.append({
        "role": "user",
        "content": f"SOURCE EXCERPTS:\n{context_block}\n\nQUESTION: {query}",
    })
    return messages


def _build_gemini_contents(
    query: str,
    chunks: list[RetrievedChunk],
    conversation_history: list[dict],
) -> list[dict]:
    """Build contents list for Gemini generate_content_stream.

    Gemini uses role=user/model (not assistant), so we remap.
    """
    context_block = "\n\n".join(
        f"[Source: {c.source_name}"
        + (f", page {c.page}" if c.page else "")
        + (f", slide {c.slide}" if c.slide else "")
        + f"]\n{c.text}"
        for c in chunks
    )

    recent_history = conversation_history[-6:] if conversation_history else []
    contents: list[dict] = []

    for turn in recent_history:
        role = "model" if turn.get("role") == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": turn.get("content", "")}]})

    contents.append({
        "role": "user",
        "parts": [{"text": f"INSTRUCTIONS:\n{_SYSTEM_PROMPT}\n\nSOURCE EXCERPTS:\n{context_block}\n\nQUESTION: {query}\n\nAnswer naturally and conversationally in 1-3 sentences."}],
    })
    return contents


def generate_answer_stream(
    query: str,
    chunks: list[RetrievedChunk],
    conversation_history: list[dict],
    groq: Groq,
    gemini: genai.Client,
    temperature: float = 0.4,
) -> Iterator[str]:
    """Yield plain-text tokens for the LLM answer.

    Tries Groq first; falls back to Gemini on any error.
    Each yielded string is a raw token/delta — the caller accumulates them
    into a StreamingResponse.
    """
    messages = _build_messages(query, chunks, conversation_history)

    # --- Groq primary ---
    try:
        stream = groq.chat.completions.create(
            model=GROQ_MODEL,
            messages=messages,
            max_tokens=MAX_TOKENS,
            temperature=temperature,
            stream=True,
        )
        for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
        return
    except Exception as groq_exc:
        # Log and fall through to Gemini.
        import logging
        logging.getLogger(__name__).warning(
            "Groq call failed (%s), falling back to Gemini.", groq_exc
        )

    # --- Gemini fallback ---
    try:
        contents = _build_gemini_contents(query, chunks, conversation_history)
        stream = gemini.models.generate_content_stream(
            model=GEMINI_MODEL,
            contents=contents,
            config=genai_types.GenerateContentConfig(
                temperature=temperature,
                max_output_tokens=MAX_TOKENS,
            ),
        )
        for response in stream:
            if response.text:
                yield response.text
        return
    except Exception as gemini_exc:
        import logging
        logging.getLogger(__name__).error(
            "Gemini fallback also failed: %s", gemini_exc
        )

    # Both failed — yield the fixed fallback line.
    yield _FALLBACK_ANSWER
