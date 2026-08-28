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
