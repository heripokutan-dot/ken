"""Minimal Gemini Live API smoke test with WAV output."""

from __future__ import annotations

import asyncio
import base64
import os
import pathlib
import sys
import wave
from typing import Any

MODEL = "gemini-3.8-live"
SAMPLE_PROMPT = "日本語で短く自己紹介をしてください。明るく自然な声で、2文以内で話してください。"
SESSION_TIMEOUT_SECONDS = 120
OUTPUT_PATH = pathlib.Path("live-output/gemini-live-response.wav")


def validate_api_key(api_key: str | None) -> str:
    if api_key is None or not api_key.strip():
        raise ValueError("GEMINI_API_KEY is missing or blank.")
    return api_key


def collect_audio_bytes(chunks: list[bytes]) -> bytes:
    audio = b"".join(chunk for chunk in chunks if chunk)
    if not audio:
        raise ValueError("Gemini Live returned no audio data.")
    return audio


def write_wav(audio_bytes: bytes, output_path: pathlib.Path) -> None:
    if not audio_bytes:
        raise ValueError("Cannot write a WAV file without audio data.")
    if len(audio_bytes) % 2:
        raise ValueError("PCM audio data must contain complete 16-bit samples.")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(output_path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(24000)
        wav_file.writeframes(audio_bytes)


def _create_client(api_key: str) -> Any:
    from google import genai
    return genai.Client(api_key=api_key)


async def _run_live_session(client: Any, output_path: pathlib.Path) -> str:
    chunks: list[bytes] = []
    transcript: list[str] = []
    completed = False
    config = {"response_modalities": ["AUDIO"], "output_audio_transcription": {}}

    async with client.aio.live.connect(model=MODEL, config=config) as session:
        await session.send_client_content(
            turns={"role": "user", "parts": [{"text": SAMPLE_PROMPT}]},
            turn_complete=True,
        )
        async for response in session.receive():
            server_content = getattr(response, "server_content", None)
            if server_content is None:
                continue
            model_turn = getattr(server_content, "model_turn", None)
            if model_turn is not None:
                for part in getattr(model_turn, "parts", None) or []:
                    inline_data = getattr(part, "inline_data", None)
                    data = getattr(inline_data, "data", None) if inline_data else None
                    if isinstance(data, (bytes, bytearray)) and data:
                        chunks.append(bytes(data))
                    elif isinstance(data, str) and data:
                        try:
                            chunks.append(base64.b64decode(data, validate=True))
                        except (ValueError, base64.binascii.Error) as exc:
                            raise ValueError("Gemini Live returned invalid audio data.") from exc
            output_transcription = getattr(server_content, "output_transcription", None)
            text = getattr(output_transcription, "text", None)
            if text:
                transcript.append(text)
            if getattr(server_content, "turn_complete", False):
                completed = True
                break

    if not completed:
        raise RuntimeError("Live API session ended before the model turn completed.")
    write_wav(collect_audio_bytes(chunks), output_path)
    return "".join(transcript).strip() or "Audio received successfully; no transcription was returned."


async def run_live_test(api_key: str, output_path: pathlib.Path) -> str:
    client = _create_client(validate_api_key(api_key))
    return await asyncio.wait_for(
        _run_live_session(client, output_path),
        timeout=SESSION_TIMEOUT_SECONDS,
    )


def main() -> int:
    try:
        key = validate_api_key(os.environ.get("GEMINI_API_KEY"))
        result = asyncio.run(run_live_test(key, OUTPUT_PATH))
    except TimeoutError:
        print("::error::Gemini Live session timed out.", file=sys.stderr)
        return 1
    except Exception as exc:
        detail = str(exc).replace("\n", " ").replace("\r", " ")
        if key := os.environ.get("GEMINI_API_KEY"):
            detail = detail.replace(key, "[REDACTED]")
        if not detail.strip():
            detail = "No additional error details were returned."
        print(
            f"::error::Gemini Live request failed ({type(exc).__name__}): {detail[:500]}",
            file=sys.stderr,
        )
        return 1
    print(f"Live API audio saved to {OUTPUT_PATH}")
    print(f"Output transcription: {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
