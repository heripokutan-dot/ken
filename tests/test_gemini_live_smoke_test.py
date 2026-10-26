import tempfile
import unittest
import wave
from pathlib import Path

from scripts.gemini_live_smoke_test import (
    collect_audio_bytes,
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
                self.assertEqual(wav.getnframes(), 12)
                self.assertEqual(wav.readframes(wav.getnframes()), pcm)

    def test_rejects_empty_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "response.wav"
            with self.assertRaisesRegex(ValueError, "audio"):
                write_wav(b"", output)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
