# Gemini Live Browser Voice App — Design

**Status:** Proposed for user approval  
**Repository:** `heripokutan-dot/ken`  
**Feature branch:** `feat/gemini-live-browser-app` (branched from `main`)  
**Date:** 2026-10-27

## Intent

Build a small browser app for one person to speak Japanese into a microphone and hear Gemini Live respond with natural audio in near real time. This advances beyond the existing text-to-audio smoke test, which sends a fixed text prompt and saves a WAV artifact. The first version is a local prototype, not a publicly hosted multi-user service.

## Goals

- Run locally on the user's computer and open in a browser.
- Request microphone permission explicitly and stream microphone audio to Gemini Live.
- Play Gemini's native audio response as it arrives, rather than waiting for a complete WAV file.
- Show clear connection/microphone states and readable input/output transcription when available.
- Support Connect/Start conversation and Disconnect/Stop controls, plus basic interruption and error handling.
- Keep the long-lived `GEMINI_API_KEY` on the local backend; use a short-lived, constrained ephemeral token in the browser.
- Add the app as new files without modifying the existing smoke-test or TTS workflows.

## Non-goals for version 1

- Public hosting, accounts, or multi-user authentication.
- Saving conversations or audio to disk.
- Camera/video input, tools/function calling, file upload, or conversation export.
- A production-grade deployment, analytics, or background service.
- Changes to existing GitHub Actions workflows or automatic workflow dispatch.

## Approaches considered

1. **Local browser app + ephemeral token (selected):** A small local Python backend serves the UI and issues constrained short-lived tokens; the browser connects directly to Gemini Live over WebSocket. This fits the user's solo-use goal and avoids relaying every audio chunk through the backend.
2. **Browser + backend WebSocket proxy:** The backend carries the entire audio stream and owns the Live API connection. It centralizes secrets and policy but adds latency and more streaming infrastructure than needed for a local prototype.
3. **Native Python desktop/terminal app:** Reuses Python, but requires desktop audio-device handling and is less convenient to use from a browser or phone.

## Proposed architecture

- **Backend:** Python 3.12, FastAPI, Uvicorn, and the official `google-genai` Python SDK.
  - Serve static app files from the same origin.
  - Read `GEMINI_API_KEY` from the process environment; never return or log it.
  - Expose a same-origin `POST /api/live-token` endpoint that provisions a single-use ephemeral token with restricted session settings.
  - Bind to `127.0.0.1` only by default; reject unexpected Host/Origin values and do not enable permissive CORS.
- **Frontend:** Plain HTML, CSS, and JavaScript; no frontend build system for the first version.
  - Use the browser's `getUserMedia` API for microphone capture.
  - Use an `AudioWorklet` to convert captured audio to mono, signed 16-bit little-endian PCM at 16 kHz and send small chunks.
  - Connect directly to the Gemini Live constrained WebSocket endpoint with the ephemeral token; do not send the permanent API key to the browser.
  - Decode the model's 24 kHz, mono, 16-bit PCM audio chunks and schedule them for continuous playback using Web Audio.
  - Display connection state and input/output transcription where the API provides it.
- **Model:** `gemini-3.8-live`, subject to current API availability and the user's account access.
- **Session settings:** Audio output, input/output audio transcription where supported, and a Japanese-friendly system instruction. The token's constraints lock the allowed model and relevant configuration.
- **Audio flow:** Microphone → AudioWorklet resampling/PCM chunking → WebSocket → Gemini Live; Gemini audio chunks → playback queue → speakers.
- **Lifecycle:** Connect requests a token, opens the Live session, then requests microphone permission and starts streaming. Disconnect stops media tracks, closes the WebSocket, stops scheduled audio, and releases audio contexts. Connection errors and permission denials return the UI to a recoverable state.

## Token and security design

- The browser must never receive `GEMINI_API_KEY`.
- The backend issues an ephemeral token constrained to one session, the selected model, audio response modality, and only the configuration needed by this app.
- Set a short window to start a session and a limited session expiry; request a fresh token for each connection. Exact token fields and SDK calls will be checked against the current official SDK/API during implementation because ephemeral-token support is documented as preview and SDK details can evolve.
- Do not persist tokens, log token values, expose them in UI, or include them in error messages.
- The app is for local use only. Binding to loopback and validating same-origin requests reduce exposure, but this is not a substitute for authentication if the app is ever exposed beyond the local computer.
- API usage may incur charges or be limited by account quota. The app should show concise sanitized errors and must not retry in an unbounded loop.

## Proposed file layout

```text
server.py
requirements.txt
frontend/
  index.html
  styles.css
  app.js
  pcm-worklet.js
tests/
  test_live_token.py
docs/superpowers/specs/2026-10-27-gemini-live-browser-app-design.md
```

The exact test file layout can be adjusted to match existing repository conventions. Existing smoke-test scripts and workflows remain untouched.

## UX outline

1. The page opens with a short Japanese description and a status of “未接続”.
2. The user clicks “会話を開始”; the browser requests microphone permission.
3. The app obtains an ephemeral token and connects to Gemini Live.
4. Status changes to “会話中”; the user speaks and hears the response.
5. Transcription is shown when available; an interrupt/stop action immediately stops queued playback and/or the session as appropriate.
6. The user clicks “終了” to stop the microphone and close the session.
7. Errors (permission denied, token request failed, connection lost, unsupported browser) are shown in Japanese with a retry path.

## Testing and acceptance criteria

- Unit tests verify token endpoint behavior with a mocked Google SDK: missing API key, token success, safe errors, and that secrets/token values are not logged.
- Frontend/manual checks cover microphone permission granted/denied, connect/disconnect cleanup, incoming audio playback, transcription display, connection loss, and interruption.
- Audio processing checks verify the outgoing PCM format is mono 16 kHz PCM16 and incoming playback handles 24 kHz PCM16 chunks in order.
- A real manual test confirms that speaking Japanese results in an audible Japanese response in a supported browser.
- No test requires a real API key; the end-to-end Live API test is performed manually by the user.
- Existing API smoke-test and TTS workflows remain unchanged; no workflow is dispatched and no changes are merged without separate permission.

## Documentation basis and implementation caveat

The design follows Google's official [ephemeral-token guide](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens?hl=ja), [Live API WebSocket guide](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket), and [Live API overview](https://ai.google.dev/gemini-api/docs/live). Ephemeral tokens are currently documented as preview functionality. During implementation, confirm the current token-creation SDK method, constrained WebSocket endpoint/version, and message field names against the current official docs and add tests for the selected request/response shapes.

## Decisions left to the implementer

- Select the current supported `google-genai` token-provisioning call and pin compatible dependency versions.
- Use the official constrained WebSocket protocol fields for audio streaming and transcription.
- Choose practical chunk duration and playback queue handling after validating the API's expected message shape.
- Keep the app simple, readable, and accessible; do not add a frontend framework unless a concrete need appears.
