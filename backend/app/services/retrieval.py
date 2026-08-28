"""Retrieval service — the highest-value component of the RAG pipeline.

Pipeline per instructions.md §9:
  1. Embed the query (RETRIEVAL_QUERY task type, identical config to ingestion).
  2. Fetch a larger candidate pool (top_k * CANDIDATE_MULTIPLIER) by cosine
     similarity from Qdrant.
  3. Apply MMR (Maximal Marginal Relevance) re-ranking down to top_k to force
     diversity across source_type — prevents one long PDF from dominating when
     the answer needs cross-source synthesis.
  4. Similarity threshold gate: if the best MMR-selected score is below
     SIMILARITY_THRESHOLD, skip LLM entirely and return an empty list so the
     caller can return the fixed "I could not find that information" response.
"""

import math
from typing import Optional

from google import genai
from qdrant_client import QdrantClient

from app.models import RetrievedChunk
from app.services.embeddings import EmbeddingError, embed_query

# Fetch this many candidates before MMR re-ranking.
CANDIDATE_MULTIPLIER = 3

# Cosine similarity cutoff below which we skip the LLM call entirely.
#
# Empirically tuned against a real Gemini-embedded Qdrant collection (two
# resumes): genuinely irrelevant questions ("What is the capital of
# France?", "What is the weather like today?") scored 0.4723-0.5011, while
# legitimate, answerable questions — including ones that embed weakly
# because the answer is a low-information proper noun ("What are the names
# of the 2 candidates?") — scored 0.5484-0.6146. The old value of 0.55 sat
# inside that second range, silently rejecting real matches as false
# negatives. 0.5 sits in the gap between the two clusters.
#
# This is a hard cutoff on a single absolute cosine score, which will always
# be somewhat brittle across content/query types — but a false negative here
# is unrecoverable (the LLM never gets a chance to look), while a false
# positive is caught by the LLM's own system-prompt instruction to say it
# can't find the answer. That asymmetry is why the value errs permissive,
# sitting in the empirical gap rather than at either cluster's edge.
SIMILARITY_THRESHOLD = 0.52

# MMR lambda: 0 = pure diversity, 1 = pure relevance. 0.6 balances both.
MMR_LAMBDA = 0.6


class RetrievalError(Exception):
    """Raised when retrieval fails (Qdrant unreachable, embedding failure, etc.)."""


def _cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two equal-length vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def _mmr_rerank(
    candidates: list[RetrievedChunk],
    candidate_vectors: list[list[float]],
    top_k: int,
    lambda_: float = MMR_LAMBDA,
) -> list[RetrievedChunk]:
    """Maximal Marginal Relevance re-ranking.

    Iteratively selects the candidate that maximises:
        lambda * relevance_score - (1 - lambda) * max_similarity_to_selected

    This forces diversity: once a chunk from source X is selected, subsequent
    candidates from source X are penalised by their similarity to it.
    """
    if not candidates:
        return []

    selected_indices: list[int] = []
    selected_vectors: list[list[float]] = []

    remaining = list(range(len(candidates)))

    for _ in range(min(top_k, len(candidates))):
        best_idx = -1
        best_score = float("-inf")

        for i in remaining:
            relevance = candidates[i].score
            if selected_vectors:
                redundancy = max(
                    _cosine(candidate_vectors[i], sv) for sv in selected_vectors
                )
            else:
                redundancy = 0.0

            mmr_score = lambda_ * relevance - (1 - lambda_) * redundancy
            if mmr_score > best_score:
                best_score = mmr_score
                best_idx = i

        if best_idx == -1:
            break

        selected_indices.append(best_idx)
        selected_vectors.append(candidate_vectors[best_idx])
        remaining.remove(best_idx)

    return [candidates[i] for i in selected_indices]


def retrieve(
    query: str,
    top_k: int,
    qdrant: QdrantClient,
    gemini: genai.Client,
    collection_name: str,
    similarity_threshold: float = SIMILARITY_THRESHOLD,
) -> list[RetrievedChunk]:
    """Embed query → fetch candidates → MMR re-rank → threshold gate.

    Returns an empty list when the best score is below similarity_threshold
    (caller must return the fixed fallback response without calling the LLM).
    Raises RetrievalError on infrastructure failures.
    """
    # 1. Embed the query
    try:
        query_vector = embed_query(query, gemini)
    except EmbeddingError as exc:
        raise RetrievalError(f"Query embedding failed: {exc}") from exc

    # 2. Fetch candidate pool
    candidate_limit = top_k * CANDIDATE_MULTIPLIER
    try:
        result = qdrant.query_points(
            collection_name=collection_name,
            query=query_vector,
            limit=candidate_limit,
            with_payload=True,
            with_vectors=True,
        )
    except Exception as exc:
        raise RetrievalError(f"Qdrant search failed: {exc}") from exc

    if not result.points:
        return []

    candidates: list[RetrievedChunk] = []
    candidate_vectors: list[list[float]] = []

    for point in result.points:
        payload = point.payload or {}
        candidates.append(RetrievedChunk(
            chunk_id=payload.get("chunk_id", str(point.id)),
            text=payload.get("text", ""),
            source_type=payload.get("source_type", "txt"),
            source_name=payload.get("source_name", ""),
            source_url=payload.get("source_url"),
            page=payload.get("page"),
            slide=payload.get("slide"),
            score=point.score,
        ))
        # point.vector is a list[float] when with_vectors=True
        vec = point.vector if isinstance(point.vector, list) else list(point.vector)
        candidate_vectors.append(vec)

    # 3. MMR re-rank
    reranked = _mmr_rerank(candidates, candidate_vectors, top_k)

    # 4. Similarity threshold gate — use best raw cosine score across reranked set
    if not reranked or max(c.score for c in reranked) < similarity_threshold:
        return []

    return reranked
