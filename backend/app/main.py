from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from groq import Groq
from qdrant_client import QdrantClient

from app.config import get_settings
from app.routes.ask import router as ask_router
from app.routes.health import router as health_router
from app.routes.process import router as process_router
from app.routes.reset import router as reset_router
from app.routes.upload import router as upload_router
from app.routes.urls import router as urls_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.settings = settings

    app.state.httpx_client = httpx.AsyncClient(timeout=30.0)

    if settings.qdrant_url:
        app.state.qdrant_client = QdrantClient(
            url=settings.qdrant_url,
            api_key=settings.qdrant_api_key or None,
        )
    else:
        # No QDRANT_URL configured — keep the app bootable so /health
        # can report "offline" instead of crashing on startup.
        app.state.qdrant_client = QdrantClient(location=":memory:")

    app.state.groq_client = Groq(api_key=settings.groq_api_key or "unset")

    # Modern google-genai singleton (replaces deprecated google-generativeai).
    # api_key="" is accepted by the Client constructor; actual calls will fail
    # with an auth error if the key is missing — that's surfaced by /health.
    app.state.gemini_client = genai.Client(
        api_key=settings.gemini_api_key or "unset",
        http_options={'api_version': 'v1'}
    )

    # Ensure the collection exists — idempotent, never destroys existing data.
    # Clearing stale vectors between sessions is the frontend's job (DELETE
    # /reset on page load, see resetOnLoad in App.tsx), not startup's: wiping
    # here on every process boot broke real deployments where the platform
    # cold-starts the backend independently of the user's browser session
    # (e.g. Render's free-tier idle spin-down), silently deleting a user's
    # just-processed documents on the next request after any idle period.
    try:
        from app.services.vector_store import ensure_collection
        ensure_collection(app.state.qdrant_client, settings.qdrant_collection)
    except Exception:
        pass  # non-fatal — /health will report degraded if Qdrant is down

    yield

    await app.state.httpx_client.aclose()


def create_app() -> FastAPI:
    settings = get_settings()
    fastapi_app = FastAPI(title="SONAR-RAG Backend", lifespan=lifespan)

    fastapi_app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    fastapi_app.include_router(health_router)
    fastapi_app.include_router(reset_router)
    fastapi_app.include_router(upload_router)
    fastapi_app.include_router(urls_router)
    fastapi_app.include_router(process_router)
    fastapi_app.include_router(ask_router)

    return fastapi_app


app = create_app()
