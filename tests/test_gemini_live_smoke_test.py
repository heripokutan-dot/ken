import asyncio
import tempfile
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path

from scripts.gemini_live_smoke_test import (
    collect_audio_bytes,
    run_live_test,
    validate_api_key,
    write_wav,
)


class ValidateApiKeyTests(unittest.TestCase):
    def test_returns_nonblank_key_unchanged(self):
        self.assertEqual(validate_api_key("  secret-value  "), "  secret-value  ")

    def test_rejects_missing_key(self):
        with self.assertRaisesRegex(ValueError, "GEMINI_API_KEY"):
            validate_api_key(None)

    def test_rejects_blank_key(self):
        with self.assertRaisesRegex(ValueError, "GEMINI_API_KEY"):
            validate_api_key("   ")


class CollectAudioBytesTests(unittest.TestCase):
    def test_concatenates_chunks_in_order(self):
        self.assertEqual(collect_audio_bytes([b"first", b"", b"second"]), b"firstsecond")

    def test_rejects_no_usable_audio(self):
        with self.assertRaisesRegex(ValueError, "audio"):
            collect_audio_bytes([])
        with self.assertRaisesRegex(ValueError, "audio"):
            collect_audio_bytes([b"", b""])


class WriteWavTests(unittest.TestCase):
    def test_writes_mono_16_bit_24khz_wav(self):
        pcm = b"\x01\x00\x02\x00" * 12
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "response.wav"
            write_wav(pcm, output)
            with wave.open(str(output), "rb") as wav:
                self.assertEqual(wav.getnchannels(), 1)
                self.assertEqual(wav.getsampwidth(), 2)
                self.assertEqual(wav.getframerate(), 24000)
                self.assertEqual(wav.getnframes(), 24)
                self.assertEqual(wav.readframes(wav.getnframes()), pcm)

    def test_rejects_empty_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "response.wav"
            with self.assertRaisesRegex(ValueError, "audio"):
                write_wav(b"", output)
            self.assertFalse(output.exists())


class FakeSession:
    def __init__(self, responses=None, receive_error=None):
        self.responses = responses or []
        self.receive_error = receive_error
        self.sent_turn = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    async def send_client_content(self, **kwargs):
        self.sent_turn = kwargs

    async def receive(self):
        if self.receive_error:
            raise self.receive_error
        for response in self.responses:
            if isinstance(response, Exception):
                raise response
            if response == "hang":
                await asyncio.sleep(5)
            else:
                yield response


class FakeLive:
    def __init__(self, session):
        self.session = session

    def connect(self, **kwargs):
        self.config = kwargs
        return self.session


class FakeClient:
    def __init__(self, session):
        self.aio = SimpleNamespace(live=FakeLive(session))


class RunLiveTestTests(unittest.IsolatedAsyncioTestCase):
    def make_response(self, audio=b"\x01\x00\x02\x00", transcript="こんにちは"):
        part = SimpleNamespace(inline_data=SimpleNamespace(data=audio))
        server_content = SimpleNamespace(
            model_turn=SimpleNamespace(parts=[part]) if audio is not None else None,
            output_transcription=SimpleNamespace(text=transcript) if transcript else None,
            turn_complete=True,
        )
        return SimpleNamespace(server_content=server_content)

    async def test_receives_audio_writes_wav_and_returns_transcription(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "live-output" / "response.wav"
            session = FakeSession([self.make_response()])
            client = FakeClient(session)
            with patch("scripts.gemini_live_smoke_test._create_client", return_value=client):
                transcript = await run_live_test("test-key", output)
            self.assertEqual(transcript, "こんにちは")
            self.assertTrue(output.is_file())
            self.assertEqual(session.sent_turn["turn_complete"], True)
            self.assertEqual(client.aio.live.config["model"], "gemini-3.8-live")
            with wave.open(str(output), "rb") as wav:
                self.assertEqual(wav.getframerate(), 24000)

    async def test_fails_when_server_returns_no_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "response.wav"
            session = FakeSession([self.make_response(audio=None)])
            with patch("scripts.gemini_live_smoke_test._create_client", return_value=FakeClient(session)):
                with self.assertRaisesRegex(ValueError, "audio"):
                    await run_live_test("test-key", output)
            self.assertFalse(output.exists())

    async def test_surfaces_api_errors_without_logging_api_key(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "response.wav"
            session = FakeSession([RuntimeError("simulated API failure")])
            with patch("scripts.gemini_live_smoke_test._create_client", return_value=FakeClient(session)):
                with self.assertRaisesRegex(RuntimeError, "simulated API failure"):
                    await run_live_test("test-key", output)

    async def test_times_out_when_session_never_completes(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "response.wav"
            session = FakeSession(["hang"])
            with patch("scripts.gemini_live_smoke_test._create_client", return_value=FakeClient(session)), patch(
                "scripts.gemini_live_smoke_test.SESSION_TIMEOUT_SECONDS", 0.01
            ):
                with self.assertRaises(TimeoutError):
                    await run_live_test("test-key", output)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
