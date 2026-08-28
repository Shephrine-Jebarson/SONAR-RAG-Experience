import httpx
from fastapi import Request
from google import genai
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


def get_gemini_client(request: Request) -> genai.Client:
    return request.app.state.gemini_client
