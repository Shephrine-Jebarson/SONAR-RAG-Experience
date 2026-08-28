"""Gemini embedding service.

Uses the modern google-genai SDK (google.genai.Client), consistent with the
checkpoint-1 decision to build a real singleton rather than the deprecated
module-global genai.configure() approach.

The same embed_chunks / embed_query functions are used for both ingestion
(batch, called from /process) and retrieval (single query, called from /ask)
so both vector spaces are identical — a hard requirement for cosine search.
"""

from concurrent.futures import ThreadPoolExecutor

from google import genai
from google.genai import types

from app.models import Chunk
from app.services.extraction import ExtractionError

EMBEDDING_MODEL = "models/gemini-embedding-001"
EMBEDDING_DIM = 768          # fixed output dimension — Qdrant collection must match
_BATCH_SIZE = 100            # Gemini embed_content accepts up to 100 texts per call
_MAX_CONCURRENT_BATCHES = 4  # bounded so multi-document ingestion doesn't hammer the API


class EmbeddingError(Exception):
    """Raised when the Gemini embedding API call fails."""


def _embed_batch(batch: list[str], client: genai.Client) -> list[list[float]]:
    try:
        response = client.models.embed_content(
            model=EMBEDDING_MODEL,
            contents=batch,
            config=types.EmbedContentConfig(
                task_type="RETRIEVAL_DOCUMENT",
                output_dimensionality=EMBEDDING_DIM,
            ),
        )
    except Exception as exc:
        raise EmbeddingError(f"Gemini embedding API failed: {exc}") from exc

    return [embedding.values for embedding in response.embeddings]


def embed_chunks(chunks: list[Chunk], client: genai.Client) -> list[list[float]]:
    """Embed a list of Chunk objects in batches.

    Batches are independent API calls, so for multi-document ingestion
    (many chunks -> multiple batches) they run concurrently on a small
    bounded thread pool instead of one-at-a-time — this is what keeps
    ingestion latency from scaling linearly with document count.

    Returns a list of float vectors in the same order as the input chunks.
    Raises EmbeddingError on API failure so /process can surface it cleanly.
    """
    if not chunks:
        return []

    texts = [chunk.text for chunk in chunks]
    batches = [texts[i : i + _BATCH_SIZE] for i in range(0, len(texts), _BATCH_SIZE)]

    if len(batches) == 1:
        return _embed_batch(batches[0], client)

    with ThreadPoolExecutor(max_workers=min(_MAX_CONCURRENT_BATCHES, len(batches))) as executor:
        # executor.map preserves input order in its results, so batch results
        # can be flattened directly without manual reordering.
        batch_results = list(executor.map(lambda b: _embed_batch(b, client), batches))

    vectors: list[list[float]] = []
    for batch_result in batch_results:
        vectors.extend(batch_result)
    return vectors


def embed_query(query: str, client: genai.Client) -> list[float]:
    """Embed a single query string for retrieval.

    Uses RETRIEVAL_QUERY task type (vs RETRIEVAL_DOCUMENT for ingestion) —
    this is the correct asymmetric usage for semantic search.
    """
    try:
        response = client.models.embed_content(
            model=EMBEDDING_MODEL,
            contents=[query],
            config=types.EmbedContentConfig(
                task_type="RETRIEVAL_QUERY",
                output_dimensionality=EMBEDDING_DIM,
            ),
        )
    except Exception as exc:
        raise EmbeddingError(f"Gemini query embedding failed: {exc}") from exc

    return response.embeddings[0].values
