# SONAR-RAG Checkpoint 1: Backend Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the FastAPI backend skeleton — config loading, CORS, singleton
async clients (httpx/Qdrant/Groq/Gemini), and a `/health` endpoint that
actually verifies Qdrant connectivity and required env vars, not a static OK.

**Architecture:** `instructions.md` §3 describes `backend/` as a sibling of a
`frontend/` folder, but the design spec decided to keep the existing React
scaffold at the repo root (it already *is* the frontend). So `backend/` is
added as a new top-level sibling directory next to `src/`, `package.json`,
etc. — not nested under a `frontend/` that doesn't exist. Inside `backend/`,
`app/config.py` loads settings via `pydantic-settings`, `app/main.py` builds
one instance each of `httpx.AsyncClient`, `QdrantClient`, and `Groq` client
in a FastAPI `lifespan` context manager and stores them on `app.state`,
`app/dependencies.py` exposes typed getters for those singletons, and
`app/routes/health.py` is the first route, wired through those getters so
tests can swap in fakes via `app.dependency_overrides` instead of needing
real credentials.

**Tech Stack:** Python 3.11+, FastAPI, pydantic-settings, httpx,
qdrant-client, groq (official SDK), google-generativeai, pytest.

**Spec:** `docs/superpowers/specs/2026-08-28-sonar-rag-voice-assistant-design.md`
(§5 Backend Architecture, §9 Error Handling) and `instructions.md` (§2 Tech
Stack, §3 Folder Structure, §4 API Endpoints, §12 Latency Checklist, §14
CORS & Environment). Overall progress tracked in
`docs/superpowers/plans/2026-08-28-sonar-rag-roadmap.md`.

## Global Constraints

- Tech stack is fixed: FastAPI backend, Qdrant Cloud vector DB, Gemini
  embeddings, Groq primary / Gemini fallback LLM (`instructions.md` §2).
- Do NOT introduce: LangGraph, multi-agent frameworks, local LLMs, local
  Whisper, custom TTS models, auth/user accounts, Redis, Celery, Kubernetes
  (`instructions.md` §2).
- Singleton async clients for httpx/Groq/Qdrant — construct once at startup,
  never re-instantiate per request (`instructions.md` §12, design spec §5).
- `/health` must verify Qdrant connectivity and that API keys loaded, not
  just return a static `{"status": "ok"}` (`instructions.md` §4).
- Backend `.env` vars: `GROQ_API_KEY`, `GEMINI_API_KEY`, `QDRANT_URL`,
  `QDRANT_API_KEY`, `QDRANT_COLLECTION` (`instructions.md` §14).
- Never put provider keys in frontend code (`instructions.md` §14) — not
  touched in this checkpoint, but no task here should leak a key into `src/`.
- CORS must allow the deployed frontend origin and `localhost` during dev
  (`instructions.md` §14).
- No Groq/Gemini/Qdrant Cloud accounts exist yet — this checkpoint's code
  must be fully unit-testable with no real keys and no network access
  (design spec §4).

---

### Task 1: Backend scaffold + settings

**Files:**
- Create: `backend/requirements.txt`
- Create: `backend/.env.example`
- Create: `backend/pytest.ini`
- Create: `backend/app/__init__.py`
- Create: `backend/app/config.py`
- Create: `backend/tests/__init__.py`
- Test: `backend/tests/test_config.py`

**Interfaces:**
- Produces: `app.config.Settings` (pydantic-settings model) with fields
  `groq_api_key: str`, `gemini_api_key: str`, `qdrant_url: str`,
  `qdrant_api_key: str`, `qdrant_collection: str` (default
  `"sonar_rag_chunks"`), `cors_origins: str` (comma-separated, default
  `"http://localhost:5173,http://localhost:3000"`), and a
  `cors_origin_list` property returning `list[str]`. Also
  `app.config.get_settings() -> Settings`.

- [ ] **Step 1: Create the scaffold files**

`backend/requirements.txt`:

```
fastapi>=0.115
uvicorn[standard]>=0.32
pydantic-settings>=2.6
httpx>=0.27
qdrant-client>=1.11
groq>=0.11
google-generativeai>=0.8
pytest>=8.3
```

`backend/.env.example`:

```
GROQ_API_KEY=
GEMINI_API_KEY=
QDRANT_URL=
QDRANT_API_KEY=
QDRANT_COLLECTION=sonar_rag_chunks
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
```

`backend/pytest.ini`:

```ini
[pytest]
pythonpath = .
```

`backend/app/__init__.py` and `backend/tests/__init__.py`: empty files.

- [ ] **Step 2: Write the failing test**

`backend/tests/test_config.py`:

```python
from app.config import Settings


def test_defaults_when_env_unset(monkeypatch):
    for var in ("GROQ_API_KEY", "GEMINI_API_KEY", "QDRANT_URL",
                "QDRANT_API_KEY", "CORS_ORIGINS"):
        monkeypatch.delenv(var, raising=False)

    settings = Settings(_env_file=None)

    assert settings.groq_api_key == ""
    assert settings.gemini_api_key == ""
    assert settings.qdrant_url == ""
    assert settings.qdrant_collection == "sonar_rag_chunks"
    assert settings.cors_origin_list == [
        "http://localhost:5173",
        "http://localhost:3000",
    ]


def test_reads_env_vars(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-groq-key")
    monkeypatch.setenv("QDRANT_URL", "https://example.qdrant.io")
    monkeypatch.setenv(
        "CORS_ORIGINS", "https://app.example.com,http://localhost:5173"
    )

    settings = Settings(_env_file=None)

    assert settings.groq_api_key == "test-groq-key"
    assert settings.qdrant_url == "https://example.qdrant.io"
    assert settings.cors_origin_list == [
        "https://app.example.com",
        "http://localhost:5173",
    ]
```

- [ ] **Step 3: Run the test to verify it fails**

Run (from `backend/`): `pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.config'`

- [ ] **Step 4: Implement `app/config.py`**

```python
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    groq_api_key: str = ""
    gemini_api_key: str = ""
    qdrant_url: str = ""
    qdrant_api_key: str = ""
    qdrant_collection: str = "sonar_rag_chunks"
    cors_origins: str = "http://localhost:5173,http://localhost:3000"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="",
        extra="ignore",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


def get_settings() -> Settings:
    return Settings()
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest tests/test_config.py -v`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/requirements.txt backend/.env.example backend/pytest.ini \
  backend/app/__init__.py backend/app/config.py backend/tests/__init__.py \
  backend/tests/test_config.py
git commit -m "feat(backend): add FastAPI scaffold and env-driven settings"
```

---

### Task 2: FastAPI app with singleton clients + CORS

**Files:**
- Create: `backend/app/dependencies.py`
- Create: `backend/app/main.py`
- Test: `backend/tests/test_main.py`

**Interfaces:**
- Consumes: `app.config.Settings`, `app.config.get_settings` (Task 1).
- Produces: `app.dependencies.get_app_settings(request) -> Settings`,
  `get_httpx_client(request) -> httpx.AsyncClient`,
  `get_qdrant_client(request) -> QdrantClient`,
  `get_groq_client(request) -> Groq`. `app.main.create_app() -> FastAPI`
  and module-level `app.main.app`. Later checkpoints depend on these
  dependency getters to inject their own fakes in tests, and on
  `app.state.httpx_client` / `qdrant_client` / `groq_client` for real
  singleton reuse.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_main.py`:

```python
import httpx
from fastapi.testclient import TestClient
from groq import Groq
from qdrant_client import QdrantClient

from app.main import app


def test_singleton_clients_created_on_startup():
    with TestClient(app) as client:
        assert isinstance(client.app.state.httpx_client, httpx.AsyncClient)
        assert isinstance(client.app.state.qdrant_client, QdrantClient)
        assert isinstance(client.app.state.groq_client, Groq)


def test_cors_allows_configured_localhost_origin():
    with TestClient(app) as client:
        resp = client.options(
            "/health",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
            },
        )
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == "http://localhost:5173"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_main.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.main'`
(the `/health` route referenced in the CORS test doesn't need to exist yet
for the preflight `OPTIONS` check — CORS middleware handles it — but the
import failure will still be the first error)

- [ ] **Step 3: Implement `app/dependencies.py`**

```python
import httpx
from fastapi import Request
from groq import Groq
from qdrant_client import QdrantClient

from app.config import Settings


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_httpx_client(request: Request) -> httpx.AsyncClient:
    return request.app.state.httpx_client


def get_qdrant_client(request: Request) -> QdrantClient:
    return request.app.state.qdrant_client


def get_groq_client(request: Request) -> Groq:
    return request.app.state.groq_client
```

- [ ] **Step 4: Implement `app/main.py`**

```python
from contextlib import asynccontextmanager

import google.generativeai as genai
import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from groq import Groq
from qdrant_client import QdrantClient

from app.config import get_settings


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
        # No QDRANT_URL configured yet - keep the app bootable so /health
        # can report "offline" instead of crashing on startup.
        app.state.qdrant_client = QdrantClient(location=":memory:")

    app.state.groq_client = Groq(api_key=settings.groq_api_key or "unset")

    if settings.gemini_api_key:
        genai.configure(api_key=settings.gemini_api_key)

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

    return fastapi_app


app = create_app()
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest tests/test_main.py -v`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/app/dependencies.py backend/app/main.py backend/tests/test_main.py
git commit -m "feat(backend): boot FastAPI app with singleton clients and CORS"
```

---

### Task 3: `/health` endpoint

**Files:**
- Create: `backend/app/routes/__init__.py`
- Create: `backend/app/routes/health.py`
- Modify: `backend/app/main.py` (register the health router)
- Test: `backend/tests/test_health.py`

**Interfaces:**
- Consumes: `app.dependencies.get_app_settings`,
  `app.dependencies.get_qdrant_client` (Task 2); `app.config.Settings`
  (Task 1).
- Produces: `GET /health` returning JSON
  `{"status": "online"|"degraded"|"offline", "reason": str|null,
  "qdrant_connected": bool, "missing_env_vars": list[str],
  "qdrant_collection": str, "timestamp": str}`. Later checkpoints (and the
  frontend's `checkHealth()` in `src/services/apiService.ts`) read this
  shape — don't rename `status` or `qdrant_connected` without updating
  checkpoint 6.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_health.py`:

```python
from fastapi.testclient import TestClient

from app.config import Settings
from app.dependencies import get_app_settings, get_qdrant_client
from app.main import app


class _FakeQdrantOK:
    def get_collections(self):
        return []


class _FakeQdrantDown:
    def get_collections(self):
        raise ConnectionError("connection refused")


def _settings(**overrides) -> Settings:
    base = dict(
        groq_api_key="groq-key",
        gemini_api_key="gemini-key",
        qdrant_url="https://example.qdrant.io",
        qdrant_api_key="qdrant-key",
    )
    base.update(overrides)
    return Settings(_env_file=None, **base)


def test_health_online_when_keys_present_and_qdrant_reachable():
    app.dependency_overrides[get_app_settings] = lambda: _settings()
    app.dependency_overrides[get_qdrant_client] = lambda: _FakeQdrantOK()
    try:
        with TestClient(app) as client:
            resp = client.get("/health")
        body = resp.json()
        assert resp.status_code == 200
        assert body["status"] == "online"
        assert body["qdrant_connected"] is True
        assert body["missing_env_vars"] == []
    finally:
        app.dependency_overrides.clear()


def test_health_offline_when_keys_missing():
    app.dependency_overrides[get_app_settings] = lambda: _settings(
        groq_api_key="", qdrant_url=""
    )
    app.dependency_overrides[get_qdrant_client] = lambda: _FakeQdrantOK()
    try:
        with TestClient(app) as client:
            resp = client.get("/health")
        body = resp.json()
        assert body["status"] == "offline"
        assert "GROQ_API_KEY" in body["missing_env_vars"]
        assert "QDRANT_URL" in body["missing_env_vars"]
    finally:
        app.dependency_overrides.clear()


def test_health_degraded_when_qdrant_unreachable():
    app.dependency_overrides[get_app_settings] = lambda: _settings()
    app.dependency_overrides[get_qdrant_client] = lambda: _FakeQdrantDown()
    try:
        with TestClient(app) as client:
            resp = client.get("/health")
        body = resp.json()
        assert body["status"] == "degraded"
        assert body["qdrant_connected"] is False
        assert "connection refused" in body["reason"]
    finally:
        app.dependency_overrides.clear()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_health.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.routes'`

- [ ] **Step 3: Implement `app/routes/health.py`**

`backend/app/routes/__init__.py`: empty file.

```python
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
async def health_check(
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
```

- [ ] **Step 4: Register the router in `app/main.py`**

Add near the top of `backend/app/main.py`:

```python
from app.routes.health import router as health_router
```

And at the end of `create_app()`, before `return fastapi_app`:

```python
    fastapi_app.include_router(health_router)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest tests/test_health.py -v`
Expected: PASS (3 tests)

- [ ] **Step 6: Run the full backend test suite**

Run: `pytest -v`
Expected: PASS (7 tests total across `test_config.py`, `test_main.py`,
`test_health.py`)

- [ ] **Step 7: Commit**

```bash
git add backend/app/routes/__init__.py backend/app/routes/health.py \
  backend/app/main.py backend/tests/test_health.py
git commit -m "feat(backend): add /health endpoint with real Qdrant + env checks"
```

---

## Manual verification (do this once, after Task 3)

From `backend/`:

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env    # Windows; `cp .env.example .env` elsewhere
uvicorn app.main:app --reload --port 8000
```

In another terminal: `curl http://localhost:8000/health` — with the
placeholder empty `.env`, expect
`{"status": "offline", "missing_env_vars": ["GROQ_API_KEY", "GEMINI_API_KEY", "QDRANT_URL", "QDRANT_API_KEY"], ...}`.
This confirms the endpoint reports real state instead of a static OK, per
`instructions.md` §4, without needing any real credentials yet.

## After this checkpoint

Update `docs/superpowers/plans/2026-08-28-sonar-rag-roadmap.md`: mark
checkpoint 1 done, fill in "Where we left off", then write checkpoint 2's
plan (`2026-08-28-sonar-rag-02-extraction.md`) before starting it.
