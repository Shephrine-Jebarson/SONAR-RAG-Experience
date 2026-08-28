from unittest.mock import patch

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


def test_startup_does_not_wipe_existing_collection_data():
    """Startup must not delete_collection. A platform cold-start (e.g. Render
    free-tier idle spin-down) is a backend implementation detail unrelated to
    whether the user's browser session actually changed — wiping here would
    silently delete a user's just-processed documents on the next request
    after any idle period. Clearing stale vectors between real sessions is
    the frontend's job (DELETE /reset on page load, see resetOnLoad in
    App.tsx), not something startup should also do destructively."""
    with patch.object(QdrantClient, "delete_collection") as mock_delete:
        with TestClient(app):
            pass

    mock_delete.assert_not_called()


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
