# Gemini TTS Style Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manually triggered workflow that generates and stores three comparable Japanese Gemini TTS WAV samples.

**Architecture:** A single GitHub Actions workflow invokes the Gemini Interactions API for three text/style pairs, validates audio responses, and uploads the WAV files as an artifact. The existing smoke-test workflow remains untouched.

**Tech Stack:** GitHub Actions YAML, Python 3, Python standard library, Gemini Interactions API, actions/upload-artifact.

**Spec:** `docs/superpowers/specs/2026-10-27-gemini-tts-style-comparison-design.md`

## Global Constraints
- Trigger only on `workflow_dispatch`; no schedule.
- Use model `gemini-3.8-flash-tts`.
- Read the key from `secrets.GEMINI_API_KEY`; never print it.
- Do not modify `.github/workflows/gemini-api-smoke-test.yml`.
- Do not commit generated WAV files.
- Produce three WAV files with the same Japanese text and distinct styles.

## Review Focus
- Missing secret: stop with a clear message that does not reveal secret contents.
- HTTP/API failure: fail the run and show a safe, useful error.
- Missing or malformed audio in the response: fail instead of uploading empty files.
- Base64 decoding failure: fail with context and no key disclosure.
- Artifact upload: ensure all three expected WAV files exist before upload.

---

### Task 1: Add the TTS comparison workflow

**Files:**
- Create: `.github/workflows/gemini-tts-style-comparison.yml`
- Reference only: `.github/workflows/gemini-api-smoke-test.yml` (must remain unchanged)

**Interfaces:**
- Consumes: GitHub Actions secret `GEMINI_API_KEY`.
- Produces: artifact `gemini-tts-style-comparison` containing `calm-natural.wav`, `bright-friendly.wav`, and `dramatic-emotional.wav`.

- [ ] **Step 1: Define manual trigger and safe job defaults**
  - Use only `workflow_dispatch`.
  - Set a bounded timeout and least permissions needed for checkout/artifact upload.
  - Fail early if `GEMINI_API_KEY` is absent.

- [ ] **Step 2: Implement the three synthesis requests**
  - Use Python standard-library HTTP and base64 handling, avoiding unnecessary dependencies.
  - Use the Interactions API endpoint and model named in the spec.
  - Send the same Japanese sample text for each style; vary `speech_metadata.style` for calm/natural, bright/friendly, and dramatic/emotional.
  - Use a documented voice identifier.
  - Do not log request headers or secret values.

- [ ] **Step 3: Validate and write WAV files**
  - Parse the API response, locate audio content, decode it, and verify each file starts with a RIFF/WAVE header.
  - Raise a clear, redacted error for non-success responses or missing/malformed audio.
  - Verify all three output files exist and are non-empty.

- [ ] **Step 4: Upload and review workflow artifact**
  - Upload the three WAV files with `actions/upload-artifact`.
  - Keep generated audio out of Git.
  - Review the final workflow diff and confirm the existing smoke-test file is unchanged.

- [ ] **Step 5: Validate the workflow definition**
  - Inspect YAML structure and expressions for valid syntax.
  - Confirm manual-only trigger, secret usage, artifact paths, timeout, and safe error handling.
  - If execution is available, run the workflow manually; otherwise report that a real API run is still needed to validate the response shape and audio playback.

---

## Acceptance Criteria
- A manual run can generate three WAV files and publish them in one downloadable artifact.
- The three files use the same Japanese text with the three specified delivery styles.
- The existing smoke-test workflow is unchanged.
- API errors are visible without exposing the secret.
- No schedule is configured and no audio files are committed.
