from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    groq_api_key: str = ""
    gemini_api_key: str = ""
    qdrant_url: str = ""
    qdrant_api_key: str = ""
    qdrant_collection: str = "sonar_rag_chunks"
    cors_origins: str = "http://localhost:5174,http://localhost:5173,http://localhost:3000"

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
