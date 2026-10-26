"""Minimal Gemini Live API smoke test with WAV output."""

from __future__ import annotations

import os
import pathlib
import sys
import wave


def validate_api_key(api_key: str | None) -> str:
    """Return a configured API key or fail without attempting a request."""
    if api_key is None or not api_key.strip():
        raise ValueError("GEMINI_API_KEY is missing or blank.")
    return api_key


def collect_audio_bytes(chunks: list[bytes]) -> bytes:
    """Concatenate audio chunks in arrival order and reject empty output."""
    audio = b"".join(chunk for chunk in chunks if chunk)
    if not audio:
        raise ValueError("Gemini Live returned no audio data.")
    return audio


def write_wav(audio_bytes: bytes, output_path: pathlib.Path) -> None:
    """Write raw mono 16-bit PCM at 24 kHz to a WAV file."""
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


def main() -> int:
    try:
        validate_api_key(os.environ.get("GEMINI_API_KEY"))
    except ValueError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        return 1
    print("Live API orchestration is not configured yet.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
