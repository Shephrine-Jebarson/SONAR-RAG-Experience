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
        "http://localhost:5174",
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
