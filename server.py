from __future__ import annotations

import datetime as dt
import logging
import os
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

MODEL_ID = "gemini-3.8-live"
WEBSOCKET_URL = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService."
    "BidiGenerateContentConstrained"
)
SYSTEM_INSTRUCTION = (
    "あなたは日本語で自然に会話する音声アシスタントです。"
    "簡潔で親しみやすく、相手の発話に直接答えてください。"
)

logger = logging.getLogger(__name__)
FRONTEND_DIR = Path(__file__).resolve().parent / "frontend"


def _is_loopback_host(host: str) -> bool:
    try:
        parsed = urlsplit("//" + host)
    except ValueError:
        return False
    if parsed.netloc != host or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        return False
    hostname = parsed.hostname
    return hostname is not None and hostname.lower() in {"localhost", "127.0.0.1", "::1"}


def _origin_matches_host(origin: str, host: str) -> bool:
    try:
        parsed = urlsplit(origin)
    except ValueError:
        return False
    if parsed.scheme != "http" or not parsed.netloc:
        return False
    if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        return False
    return parsed.netloc.lower() == host.lower() and _is_loopback_host(parsed.netloc)


def _create_ephemeral_token(token_client: object) -> object:
    now = dt.datetime.now(dt.timezone.utc)
    return token_client.auth_tokens.create(
        config={
            "uses": 1,
            "expire_time": now + dt.timedelta(minutes=30),
            "new_session_expire_time": now + dt.timedelta(minutes=1),
            "live_connect_constraints": {
                "model": MODEL_ID,
                "config": {
                    "response_modalities": ["AUDIO"],
                    "input_audio_transcription": {},
                    "output_audio_transcription": {},
                    "system_instruction": {
                        "parts": [{"text": SYSTEM_INSTRUCTION}]
                    },
                },
            },
        }
    )


def create_app(*, api_key: str | None = None, token_client: object | None = None) -> FastAPI:
    configured_api_key = api_key if api_key is not None else os.getenv("GEMINI_API_KEY")
    app = FastAPI(title="Gemini Live Browser Voice App")
    app.state.token_client = token_client

    @app.middleware("http")
    async def restrict_to_loopback(request: Request, call_next):
        if not _is_loopback_host(request.headers.get("host", "")):
            return JSONResponse({"detail": "Local requests only."}, status_code=400)
        return await call_next(request)

    @app.get("/")
    async def serve_index() -> FileResponse:
        return FileResponse(FRONTEND_DIR / "index.html", headers={"Cache-Control": "no-store"})

    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.post("/api/live-token")
    async def create_live_token(request: Request) -> JSONResponse:
        host = request.headers.get("host", "")
        if not _is_loopback_host(host):
            raise HTTPException(status_code=400, detail="Local requests only.")

        origin = request.headers.get("origin", "")
        if not origin or not _origin_matches_host(origin, host):
            raise HTTPException(status_code=403, detail="Same-origin requests only.")

        if not configured_api_key:
            raise HTTPException(status_code=503, detail="Gemini API is not configured.")

        try:
            client = app.state.token_client
            if client is None:
                from google import genai

                client = genai.Client(api_key=configured_api_key)
                app.state.token_client = client

            token = _create_ephemeral_token(client)
            token_value = getattr(token, "name", None)
            if not isinstance(token_value, str) or not token_value:
                raise ValueError("Token response did not contain a token name")
        except Exception:
            # Do not include exception details: provider errors may contain credentials.
            logger.error("Gemini Live token provisioning failed")
            raise HTTPException(
                status_code=502,
                detail="Could not create a Gemini Live session token.",
            ) from None

        return JSONResponse(
            {
                "token": token_value,
                "model": MODEL_ID,
                "websocket_url": WEBSOCKET_URL,
            },
            headers={"Cache-Control": "no-store"},
        )

    return app


app = create_app()
