"""GET /health — reports whether the backend is actually usable, not just
that the process is running.

Deliberately "honest": returns "offline" if required API keys are missing
and "degraded" if Qdrant is unreachable, rather than always returning 200.
The frontend polls this to drive the header's connection status indicator
and to gate the startup collection-reset in app/main.py's lifespan.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from qdrant_client import QdrantClient

from app.config import Settings
from app.dependencies import get_app_settings, get_qdrant_client

router = APIRouter()

REQUIRED_ENV_VARS = {
    "GROQ_API_KEY": "groq_api_key",
    "GEMINI_API_KEY": "gemini_api_key",
    "QDRANT_URL": "qdrant_url",
    "QDRANT_API_KEY": "qdrant_api_key",
}


@router.get("/health")
def health_check(
    settings: Settings = Depends(get_app_settings),
    qdrant: QdrantClient = Depends(get_qdrant_client),
):
    missing = [
        env_name
        for env_name, attr in REQUIRED_ENV_VARS.items()
        if not getattr(settings, attr)
    ]

    qdrant_ok = False
    qdrant_error: str | None = None
    try:
        qdrant.get_collections()
        qdrant_ok = True
    except Exception as exc:  # noqa: BLE001 - any backend failure degrades, never crashes
        qdrant_error = str(exc)

    if missing:
        status = "offline"
        reason = f"Missing environment variables: {', '.join(missing)}"
    elif not qdrant_ok:
        status = "degraded"
        reason = f"Qdrant unreachable: {qdrant_error}"
    else:
        status = "online"
        reason = None

    return {
        "status": status,
        "reason": reason,
        "qdrant_connected": qdrant_ok,
        "missing_env_vars": missing,
        "qdrant_collection": settings.qdrant_collection,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
