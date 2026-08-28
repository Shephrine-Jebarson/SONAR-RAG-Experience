"""Qdrant vector store service.

Handles collection setup (idempotent — safe to call on every startup or
health check) and chunk upsert. Checkpoint 4's retrieval functions will
import from here too.
"""

import uuid

from qdrant_client import QdrantClient
from qdrant_client.http.exceptions import UnexpectedResponse
from qdrant_client.models import Distance, PointStruct, VectorParams

from app.models import Chunk
from app.services.embeddings import EMBEDDING_DIM

# Namespace for deriving Qdrant point IDs from chunk_id via uuid5. uuid5 is a
# pure, deterministic function of (namespace, name) per RFC 4122 — unlike
# Python's built-in hash(), it does not depend on PYTHONHASHSEED, so the same
# chunk_id always maps to the same point id across processes/restarts/workers.
# This is what makes upsert_chunks a true idempotent upsert instead of an
# accumulation of duplicate points.
_POINT_ID_NAMESPACE = uuid.UUID("6f5d2c1a-0f0e-4b1a-9c3d-8e2f1a7b6c9d")


def _point_id(chunk_id: str) -> str:
    return str(uuid.uuid5(_POINT_ID_NAMESPACE, chunk_id))


class VectorStoreError(Exception):
    """Raised when a Qdrant operation fails."""


def ensure_collection(client: QdrantClient, collection_name: str) -> None:
    """Create the Qdrant collection if it doesn't already exist.

    Safe to call multiple times — does nothing if the collection is present
    with the correct vector size. Raises VectorStoreError on unexpected
    Qdrant failures.
    """
    try:
        existing = {c.name for c in client.get_collections().collections}
        if collection_name not in existing:
            try:
                client.create_collection(
                    collection_name=collection_name,
                    vectors_config=VectorParams(
                        size=EMBEDDING_DIM,
                        distance=Distance.COSINE,
                    ),
                )
            except UnexpectedResponse as exc:
                # Two callers can both see "missing" and both race to create it
                # (e.g. React StrictMode double-invoking an effect on page
                # load, or two browser tabs). Qdrant accepts the first and
                # 409s the second — but the desired state (collection exists)
                # was still achieved, so this isn't a real failure.
                if exc.status_code != 409:
                    raise
    except Exception as exc:
        raise VectorStoreError(f"Failed to ensure Qdrant collection '{collection_name}': {exc}") from exc


def upsert_chunks(
    chunks: list[Chunk],
    vectors: list[list[float]],
    client: QdrantClient,
    collection_name: str,
) -> None:
    """Upsert chunk vectors + metadata into Qdrant.

    chunks and vectors must be the same length and in the same order.
    Uses chunk_id as the Qdrant point ID (hashed to uint64 for compatibility).
    """
    if not chunks:
        return

    if len(chunks) != len(vectors):
        raise ValueError(f"chunks ({len(chunks)}) and vectors ({len(vectors)}) length mismatch")

    points = [
        PointStruct(
            id=_point_id(chunk.chunk_id),
            vector=vector,
            payload={
                "chunk_id": chunk.chunk_id,
                "text": chunk.text,
                "source_type": chunk.source_type,
                "source_name": chunk.source_name,
                "source_url": chunk.source_url,
                "page": chunk.page,
                "slide": chunk.slide,
            },
        )
        for chunk, vector in zip(chunks, vectors)
    ]

    try:
        client.upsert(collection_name=collection_name, points=points)
    except Exception as exc:
        raise VectorStoreError(f"Qdrant upsert failed: {exc}") from exc
