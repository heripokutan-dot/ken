# Gemini Live API Smoke Test — Design

**Status:** Proposed for user review

## Goal
Add a manually triggered GitHub Actions workflow to verify that the repository's existing `GEMINI_API_KEY` can connect to the Gemini Live API, submit a short Japanese text prompt, receive native audio output, and save it as a playable WAV artifact.

## User experience
- The user opens GitHub Actions and manually runs the new Live API smoke-test workflow.
- The workflow connects to the official Live API model `gemini-3.8-live` using the Google Gen AI Python SDK.
- It submits a fixed Japanese text prompt and receives the model's audio response.
- It writes the raw 24 kHz, mono, 16-bit PCM response to a WAV file and uploads it as an Actions artifact.
- The workflow also requests output-audio transcription and prints the resulting text, if returned.

## Approaches considered
1. **GitHub Actions, text input → Live audio output (recommended):** Reuses the existing secret and artifact workflow. Verifies the Live WebSocket session and audio reception without needing a microphone. It is a smoke test, not a real-time human voice conversation.
2. **Local/browser microphone demo:** More representative of a real Live conversation, but requires a client interface, microphone permissions, and additional security/configuration work; too much for the first test.

## Technical approach
- Repository: `heripokutan-dot/ken`
- Add a new workflow under `.github/workflows/`, triggered only by `workflow_dispatch`.
- Use Python and the official `google-genai` package; connect with `client.aio.live.connect(model="gemini-3.8-live", config=...)`.
- Request `AUDIO` output and enable `output_audio_transcription` for a readable confirmation when supported.
- Send one short Japanese text prompt as a completed user turn.
- Collect audio chunks until the model turn completes, then write `live-output/gemini-live-response.wav` using Python's standard `wave` module with 1 channel, 2-byte samples, and 24,000 Hz.
- Reuse `secrets.GEMINI_API_KEY` from GitHub Actions. Never print or commit the key.
- Upload the WAV as artifact `gemini-live-smoke-test`, retention 7 days.
- Leave the existing API smoke-test and TTS workflow unchanged.

## Constraints and risks
- Manual trigger only; do not add a schedule.
- Do not commit generated audio files to the repository.
- Live API model access, quota, and free-tier eligibility depend on the account and may change.
- Treat an empty audio response, connection error, API error, or timeout as a failed workflow with a useful non-secret error.
- This test sends text to Live and receives audio; it does not capture microphone input or prove full-duplex real-time voice conversation.
- Confirm actual response behavior with the first live run; SDK/API details can change.
