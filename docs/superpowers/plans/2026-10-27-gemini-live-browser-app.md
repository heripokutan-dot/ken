# Gemini Live Browser Voice App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local browser app that streams microphone audio to Gemini Live and plays spoken Japanese responses in near real time.

**Architecture:** A loopback-only FastAPI server serves a plain HTML/CSS/JavaScript frontend and issues constrained ephemeral tokens. The browser uses Web Audio and a WebSocket connection directly to the official Gemini Live endpoint; the permanent API key remains in the server environment.

**Tech Stack:** Python 3.12, FastAPI, Uvicorn, `google-genai`, pytest/httpx, plain browser JavaScript, Web Audio API, AudioWorklet.

**Spec:** `docs/superpowers/specs/2026-10-27-gemini-live-browser-app-design.md`

## Global Constraints

- Local prototype for one user only; bind the server to `127.0.0.1`.
- Never send, persist, or log `GEMINI_API_KEY` in the browser.
- Use a short-lived, constrained ephemeral token and a fresh token for every connection.
- No permissive CORS; validate local Host/Origin expectations for the token endpoint.
- Outgoing audio is mono PCM16 little-endian at 16 kHz; incoming audio is mono PCM16 at 24 kHz.
- No conversation/audio persistence, public hosting, accounts, camera, tools, or frontend framework.
- Do not modify existing smoke-test or TTS workflows; do not dispatch workflows, merge, or publish without separate user permission.
- Verify the currently supported Live model ID, ephemeral-token API, SDK calls, and constrained WebSocket protocol against official Google documentation before coding against them; the design's model ID is provisional and must not be assumed correct without verification.

## Review Focus

- Missing or invalid `GEMINI_API_KEY`: token endpoint fails safely with no secret leakage; test in Task 1.
- Invalid Host/Origin or cross-origin token request: request is rejected; test in Task 1.
- Microphone permission denied or browser APIs unsupported: Japanese recoverable error and no leaked media resources; manual checks in Task 4.
- Unexpected WebSocket close, malformed audio payload, or server error: UI returns to a safe disconnected state and playback stops; unit/manual checks in Tasks 3–4.
- Repeated connect/disconnect or interruption during playback: no duplicate capture streams, dangling audio nodes, or continuing queued sound; checks in Tasks 3–4.

---

## File Structure

- Create `server.py`: FastAPI app, same-origin static serving, security checks, and token endpoint.
- Create `requirements.txt`: pinned compatible runtime dependencies and test dependencies.
- Create `frontend/index.html`: Japanese interface, status, transcript areas, start/interrupt/end controls.
- Create `frontend/styles.css`: responsive accessible presentation and status/error styling.
- Create `frontend/app.js`: session lifecycle, token request, Live WebSocket protocol, audio playback queue, transcript rendering, and cleanup.
- Create `frontend/pcm-worklet.js`: microphone PCM16 conversion/resampling and chunk delivery.
- Create `frontend/error-messages.js`: map browser permission/device failures to recoverable Japanese messages.
- Create `tests/test_live_token.py`: mocked SDK tests for token endpoint and request security.
- Create `tests/test_app_static.py`: verify the Japanese page and same-origin static serving.
- Create `tests/test_error_messages.mjs`: verify Japanese error mapping without a frontend build system.
- Add audio conversion tests only if the resampling/PCM logic is factored into a deterministic testable helper; do not introduce a build system solely for tests.
- Create `docs/superpowers/plans/2026-10-27-gemini-live-browser-app.md`: this plan.

## Task 1: Verify API contract and implement secure token endpoint

**Files:**
- Create: `server.py`
- Create: `requirements.txt`
- Create: `tests/test_live_token.py`

**Interfaces:**
- `create_app(*, api_key: str | None = None, token_client: object | None = None) -> FastAPI` builds an app with injectable configuration/client for tests.
- `POST /api/live-token` returns only the ephemeral token and the minimum connection metadata the browser needs; never returns the permanent API key.
- Token provisioning is isolated behind a small helper so SDK calls can be mocked and SDK upgrades remain localized.

- [x] **Step 1: Verify the official contract before fixing dependency versions.** Read current Google documentation for ephemeral tokens, Live WebSocket setup, session constraints, model ID, and token expiry. Record the exact SDK method, request fields, endpoint/version, and response shape in implementation notes. Do not copy provisional or deprecated examples.
- [x] **Step 2: Write failing endpoint tests.** Add tests for missing API key (safe 503/500 response), successful mocked token creation (expected token and minimal metadata only), SDK exception (sanitized error), and assertions that neither API key nor token appears in captured logs.
- [x] **Step 3: Run the focused tests and confirm failure.** Run: `pytest tests/test_live_token.py -q`. Expected: FAIL because the app/endpoint is not implemented.
- [x] **Step 4: Implement the endpoint and security checks.** Create the FastAPI app with dependency injection, current supported SDK token provisioning, restricted model/audio configuration, short session expiry, loopback binding defaults, and Host/Origin validation. Return no secret values in errors.
- [x] **Step 5: Run focused tests and confirm pass.** Run: `pytest tests/test_live_token.py -q`. Expected: all token endpoint tests PASS.
- [x] **Step 6: Commit the task.** Commit message: `feat: add secure Gemini Live token endpoint`.

## Task 2: Build the Japanese interface and local server entry point

**Files:**
- Create: `frontend/index.html`
- Create: `frontend/styles.css`
- Modify: `server.py`

**Interfaces:**
- `GET /` serves `frontend/index.html`; static assets are served from the same origin.
- Frontend elements have stable IDs: `status`, `error-message`, `input-transcript`, `output-transcript`, `start-button`, `interrupt-button`, and `stop-button`.

- [x] **Step 1: Add the minimal HTML structure.** Include Japanese instructions, status initially “未接続”, live input/output transcript regions, and start/interrupt/end buttons. Use semantic buttons, visible focus indicators, and accessible status announcements.
- [x] **Step 2: Add responsive styles.** Style the conversation area, status states, error messages, and disabled controls without external assets or libraries.
- [x] **Step 3: Mount static files on the same origin.** Add static serving to the FastAPI app without changing the token endpoint contract.
- [x] **Step 4: Verify the page locally.** Run the server with a dummy test environment and confirm `GET /` and static asset requests succeed; verify no API key is embedded in HTML or JavaScript.
- [x] **Step 5: Commit the task.** Commit message: `feat: add Japanese browser voice interface`.

## Task 3: Implement audio capture, protocol handling, playback, and cleanup

**Files:**
- Create: `frontend/app.js`
- Create: `frontend/pcm-worklet.js`
- Create: `frontend/pcm-utils.js`
- Create: `frontend/error-messages.js`

**Interfaces:**
- `startSession() -> Promise<void>` requests a token, establishes the Live session, obtains microphone access, and starts streaming.
- `stopSession() -> Promise<void>` stops microphone tracks, closes the WebSocket, stops scheduled playback, disconnects audio nodes, and closes audio contexts.
- `interruptPlayback() -> void` immediately stops queued/scheduled output and sends the supported interruption signal if the current protocol provides one.
- `setStatus(message: string, state: "idle" | "connecting" | "connected" | "error") -> void` updates the accessible status UI.
- AudioWorklet outputs mono PCM16 little-endian frames at 16 kHz in small chunks. Playback decodes mono PCM16 at 24 kHz in arrival order.

- [x] **Step 1: Implement a testable PCM conversion helper if practical.** Pin sample-rate conversion and PCM16 clamping/endianness with deterministic tests or a browser-side diagnostic harness. Avoid assuming the microphone hardware runs at 16 kHz.
- [x] **Step 2: Implement the AudioWorklet.** Downmix microphone input to mono, resample to 16 kHz, convert to signed PCM16 little-endian, and post bounded-size chunks to the main thread.
- [x] **Step 3: Implement token acquisition and WebSocket setup.** Fetch `POST /api/live-token`, connect to the exact current official constrained endpoint, and use only the ephemeral token. Follow the verified protocol's message fields for setup, audio input, transcription, server audio, interruption, and errors.
- [x] **Step 4: Implement continuous audio playback.** Convert incoming 24 kHz PCM16 chunks to audio buffers and schedule them in order without waiting for a complete response. Track scheduled nodes so interruption and disconnect can stop them immediately.
- [x] **Step 5: Implement lifecycle and failure cleanup.** Handle permission denial, unsupported APIs, token failure, WebSocket error/close, malformed messages, and repeated start/stop safely. Prevent duplicate streams and retry only when the user explicitly starts again.
- [ ] **Step 6: Verify the UI contract manually in a browser.** With mocked or disconnected API responses, check status changes, transcript rendering, errors, and cleanup. Confirm start/stop can be repeated without leaving the microphone active.
- [x] **Step 7: Commit the task.** Commit message: `feat: stream browser audio through Gemini Live`.

## Task 4: Complete manual end-to-end validation and user instructions

**Files:**
- Modify: `frontend/app.js` (only if fixes are required)
- Modify: `frontend/index.html` (only if usage guidance is needed)
- Create or update: a concise run section in the repository README only if a README exists on the feature branch.

**Interfaces:**
- Run command: `python -m pip install -r requirements.txt`, then set `GEMINI_API_KEY` in the local shell and run the documented Uvicorn command bound to `127.0.0.1`.
- User-facing behavior: Japanese speech produces audible Japanese audio response in a supported browser; transcripts are displayed when the API provides them.

- [x] **Step 1: Run all automated tests.** Run: `pytest -q`. Expected: PASS without requiring a real API key.
- [ ] **Step 2: Perform browser checks.** Verify microphone grant/deny, start/stop, interrupt during response, incoming audio playback, transcript updates, network loss, and cleanup. Confirm that tokens and the API key do not appear in console logs.
- [ ] **Step 3: Perform the real Live API check with the user-configured key.** Start the app locally, speak a short Japanese phrase, and confirm a spoken response. Record any model/account availability limitations clearly; do not claim success without the user's result.
- [x] **Step 4: Review changed files.** Confirm only the planned app, tests, dependency, and documentation files changed and existing GitHub Actions workflow files remain untouched.
- [x] **Step 5: Commit final fixes and instructions.** Commit message: `test: verify local Gemini Live browser conversation`.

## Final verification checklist

- [x] `pytest -q` passes without a live API key.
- [x] The permanent API key is only read server-side and never sent to the browser.
- [x] Token endpoint rejects missing key and unexpected Host/Origin and emits sanitized errors.
- [ ] Browser streams 16 kHz mono PCM16 and plays 24 kHz mono PCM16 chunks in order.
- [ ] Disconnect and interruption stop microphone capture and queued playback.
- [ ] A real user-run browser test confirms Japanese speech-to-speech behavior.
- [x] Existing smoke-test/TTS workflows are unchanged; no workflow run, merge, or deployment occurs without explicit permission.
