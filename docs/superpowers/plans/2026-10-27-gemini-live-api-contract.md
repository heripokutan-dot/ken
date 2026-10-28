# Gemini Live API contract verified for the browser app

Checked against Google's official documentation on 2026-10-27.

## Selected model

- Model ID: `gemini-3.8-live`
- Google's model catalog identifies it as the stable default for low-latency voice-agent and real-time dialogue use.
- Audio input is raw mono PCM16 little-endian at 16 kHz; native audio output is PCM16 little-endian at 24 kHz.

Sources:
- https://ai.google.dev/gemini-api/docs/models
- https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live
- https://ai.google.dev/gemini-api/docs/live-api?hl=ja

## Ephemeral token provisioning

- SDK: official Python `google-genai` package.
- SDK call: `client.auth_tokens.create(config={...})`.
- Token value returned to the browser: `token.name`.
- Request configuration uses Python snake_case keys:
  - `uses: 1`
  - `expire_time`: UTC datetime, 30 minutes after issuance
  - `new_session_expire_time`: UTC datetime, 1 minute after issuance
  - `live_connect_constraints.model: "gemini-3.8-live"`
  - `live_connect_constraints.config.response_modalities: ["AUDIO"]`
  - Verified against the live API (2026-10-28): adding transcription settings or `systemInstruction` to the REST token constraints is rejected with HTTP 400 `INVALID_ARGUMENT` (field `auth_token`), so the token locks only the model and `responseModalities`; the browser's setup message supplies transcription and the Japanese system instruction.
- The endpoint response exposes only the ephemeral token, model ID, and constrained WebSocket base URL. It sets `Cache-Control: no-store`; it does not return the long-lived API key.

Source:
- https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens?hl=en

## Browser WebSocket

- Endpoint: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained`
- Authentication: ephemeral token in the `access_token` query parameter.
- The first client message is `{"setup": {...}}`; the setup config must agree with the token constraints.
- Microphone messages use `realtimeInput.audio` with base64 PCM and `mimeType: "audio/pcm;rate=16000"`.
- Incoming native audio is in `serverContent.modelTurn.parts[].inlineData.data`; input/output transcript messages are `serverContent.inputTranscription.text` and `serverContent.outputTranscription.text`.
- `serverContent.interrupted` indicates that scheduled playback should be stopped and cleared.

Source:
- https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
- https://ai.google.dev/api/live?hl=ja

## Security notes

- Ephemeral token features are documented as Preview.
- Google documents that raw WebSocket clients must use the v1beta constrained endpoint and pass the token as `access_token`.
- The app is intentionally local-only, binds to loopback, validates Host/Origin for token requests, and never logs token values or provider exception text.
