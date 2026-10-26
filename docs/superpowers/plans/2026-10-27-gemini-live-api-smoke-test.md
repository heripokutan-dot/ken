# Gemini Live API Smoke Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manually triggered GitHub Actions workflow that sends Japanese text to Gemini Live, receives audio, and uploads a playable WAV artifact.

**Architecture:** Keep Live API orchestration in a small Python script under `scripts/`; test audio validation and WAV generation locally without network access. A dedicated `workflow_dispatch` workflow installs the official Google Gen AI SDK, supplies the existing API-key secret, runs the script, and uploads the WAV artifact.

**Tech Stack:** Python 3.12, `google-genai`, standard-library `asyncio` and `wave`, `unittest`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-27-gemini-live-api-smoke-test-design.md`

## Global Constraints

- Workflow trigger is `workflow_dispatch` only; do not add a schedule.
- Use model `gemini-3.8-live` and the official `google-genai` Python SDK.
- Reuse `secrets.GEMINI_API_KEY`; never print or commit the key.
- Output file is `live-output/gemini-live-response.wav`.
- WAV format is mono, 16-bit PCM, 24,000 Hz.
- Artifact name is `gemini-live-smoke-test`, retained for 7 days.
- Do not modify the existing API smoke-test or TTS workflow, and do not commit generated audio.

## Review Focus

- Missing or blank API key must fail before attempting a network connection; test the validation function.
- Empty or missing audio payload must fail clearly instead of producing a silent/invalid artifact; test the audio validation function.
- Multiple audio chunks must be preserved in order; test concatenation.
- WAV output must have the specified channel count, sample width, and sample rate; inspect it using `wave` in a unit test.
- Connection/API failures and a session that does not complete within the timeout must fail the workflow without exposing the secret; mock the Live API boundary for error-path tests and set a workflow timeout.

---

### Task 1: Add tested audio and input helpers

**Files:**
- Create: `scripts/gemini_live_smoke_test.py`
- Create: `tests/test_gemini_live_smoke_test.py`

**Interfaces:**
- Produce `validate_api_key(api_key: str | None) -> str`, which returns a non-empty key or raises `ValueError`.
- Produce `collect_audio_bytes(chunks: list[bytes]) -> bytes`, which concatenates non-empty chunks in order and raises `ValueError` if no usable audio exists.
- Produce `write_wav(audio_bytes: bytes, output_path: pathlib.Path) -> None`, which writes mono, 16-bit, 24,000 Hz WAV and rejects empty audio.

- [ ] **Step 1: Write failing unit tests** for missing/blank key, preserved chunk order, empty chunk list, empty audio rejection, and WAV header properties.
- [ ] **Step 2: Run tests to verify they fail** with missing helper/import errors.

  Run: `python -m unittest discover -s tests -v`

  Expected: FAIL because the helpers have not been implemented.

- [ ] **Step 3: Implement the three helpers** in `scripts/gemini_live_smoke_test.py` using only the Python standard library.
- [ ] **Step 4: Run unit tests and verify they pass.**

  Run: `python -m unittest discover -s tests -v`

  Expected: PASS for all helper tests, including the WAV metadata assertions.

- [ ] **Step 5: Commit the helper and test files.**

  ```bash
  git add scripts/gemini_live_smoke_test.py tests/test_gemini_live_smoke_test.py
  git commit -m "test: add Gemini Live audio helpers"
  ```

### Task 2: Implement the asynchronous Live API smoke test

**Files:**
- Modify: `scripts/gemini_live_smoke_test.py`
- Modify: `tests/test_gemini_live_smoke_test.py`

**Interfaces:**
- Add `async def run_live_test(api_key: str, output_path: pathlib.Path) -> str`, returning output-audio transcription when supplied, otherwise a concise success message.
- The command-line entry point reads `GEMINI_API_KEY`, calls `validate_api_key`, and runs the async test.
- Use `client.aio.live.connect(model="gemini-3.8-live", config=...)`, request audio output and output-audio transcription, send one fixed short Japanese text turn, and collect PCM chunks until the server marks the turn complete.
- Bound the session with a 120-second timeout; write the WAV only after non-empty audio has been collected.

- [ ] **Step 1: Add mocked tests** for successful chunk collection, empty server audio, API exception, and timeout; keep all tests offline and do not require a real API key.
- [ ] **Step 2: Run the targeted tests and verify they fail** before the Live API orchestration exists.

  Run: `python -m unittest discover -s tests -v`

  Expected: FAIL on the new orchestration tests.

- [ ] **Step 3: Implement the async Live API flow** with the official SDK; extract audio data from received model-turn parts, preserve chunk order, handle completion, and surface concise errors without logging the key.
- [ ] **Step 4: Run the full offline unit-test suite.**

  Run: `python -m unittest discover -s tests -v`

  Expected: PASS; no test opens a network connection.

- [ ] **Step 5: Commit the Live API implementation and tests.**

  ```bash
  git add scripts/gemini_live_smoke_test.py tests/test_gemini_live_smoke_test.py
  git commit -m "feat: add Gemini Live API smoke test"
  ```

### Task 3: Add the manual GitHub Actions workflow

**Files:**
- Create: `.github/workflows/gemini-live-api-smoke-test.yml`

**Interfaces:**
- Workflow runs on `workflow_dispatch` only, with read-only repository contents permission and a 5-minute job timeout.
- Set `GEMINI_API_KEY` from `${{ secrets.GEMINI_API_KEY }}` in the test step environment.
- Install Python 3.12 and `google-genai`, run the offline tests, then run `python scripts/gemini_live_smoke_test.py`.
- Upload `live-output/gemini-live-response.wav` as `gemini-live-smoke-test` with 7-day retention, only when the file exists.

- [ ] **Step 1: Create the workflow YAML** with manual trigger, least-privilege permissions, explicit timeout, test/run steps, and artifact upload.
- [ ] **Step 2: Validate YAML and review the diff** for accidental changes to existing workflows or secrets.
- [ ] **Step 3: Run local offline tests again** to confirm the script and tests remain self-contained.

  Run: `python -m unittest discover -s tests -v`

  Expected: PASS.

- [ ] **Step 4: Commit the workflow.**

  ```bash
  git add .github/workflows/gemini-live-api-smoke-test.yml
  git commit -m "ci: add manual Gemini Live API smoke test"
  ```

- [ ] **Step 5: Review the branch diff** and confirm only the new script, its tests, and the new workflow are included. Do not merge or dispatch the workflow without the user's explicit approval.

### Task 4: First-run verification checklist

**Files:**
- No additional files; use the workflow run and uploaded artifact.

- [ ] **Step 1: After explicit approval, manually run** `Gemini Live API Smoke Test` from GitHub Actions on this branch.
- [ ] **Step 2: Verify the run completes successfully** and reports the transcription or a concise audio-received confirmation without exposing the API key.
- [ ] **Step 3: Download `gemini-live-smoke-test` and play the WAV** to verify it contains audible output.
- [ ] **Step 4: If the run fails, inspect sanitized logs and adjust only the SDK/API handling required by the observed response shape; add a regression test before retrying.**
