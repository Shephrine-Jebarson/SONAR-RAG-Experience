"""DELETE /reset — wipe all indexed vectors (called on frontend page load)."""

from fastapi import APIRouter, Depends
from qdrant_client import QdrantClient

from app.config import Settings
from app.dependencies import get_app_settings, get_qdrant_client
from app.services.vector_store import ensure_collection

router = APIRouter()


@router.delete("/reset")
def reset(
    settings: Settings = Depends(get_app_settings),
    qdrant: QdrantClient = Depends(get_qdrant_client),
):
    """Drop and recreate the Qdrant collection, clearing all indexed data."""
    try:
        existing = {c.name for c in qdrant.get_collections().collections}
        if settings.qdrant_collection in existing:
            qdrant.delete_collection(settings.qdrant_collection)
        ensure_collection(qdrant, settings.qdrant_collection)
        return {"status": "ok", "message": "Collection reset."}
    except Exception as exc:
        return {"status": "error", "message": str(exc)}
