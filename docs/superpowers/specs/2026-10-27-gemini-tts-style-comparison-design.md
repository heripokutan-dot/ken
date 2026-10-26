# Gemini TTS Style Comparison — Design

**Status:** Approved by the user on 2026-10-27

## Goal
Add a manually triggered GitHub Actions workflow to compare three Japanese speech-generation styles using the Gemini API, without changing the existing API smoke-test workflow.

## User experience
- The user opens Actions and manually runs the new workflow.
- The workflow synthesizes the same Japanese sample text in three styles: calm/natural narration, bright/friendly, and dramatic/emotional.
- It saves each generated result as a WAV file and uploads all three as one GitHub Actions artifact.
- The user downloads the artifact and listens to compare the results.

## Technical approach
- Repository: `heripokutan-dot/ken`
- Workflow: a new file under `.github/workflows/`, triggered only by `workflow_dispatch`.
- Model: `gemini-3.8-flash-tts`, using the Gemini Interactions API speech-generation request format.
- Authentication: reuse the existing `GEMINI_API_KEY` GitHub Actions secret; never print or commit it.
- Keep `.github/workflows/gemini-api-smoke-test.yml` unchanged.
- Store the three outputs as WAV files and upload via `actions/upload-artifact`.
- Make errors visible in workflow logs, without exposing the API key.

## Constraints and risks
- Do not add a scheduled trigger or automatically consume API quota.
- Google model access, free-tier eligibility, and quotas depend on the user's account and can change; do not promise unlimited free use.
- Validate that the response contains audio before writing files; fail with a useful error if the API response is unsuccessful or malformed.
- Do not commit generated audio files to the repository.
