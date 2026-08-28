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
