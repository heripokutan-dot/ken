# Gemini Live iPhone Cloudflare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Convert the existing local browser prototype into an authenticated Cloudflare Pages web app usable from iPhone Safari without a PC, while keeping the long-lived Gemini API key server-side.

**Architecture:** Cloudflare Pages serves the existing static HTML/CSS/JS. A Pages Function at POST /api/live-token validates Cloudflare Access authentication, same-origin request properties, and rate limits before issuing a constrained ephemeral Gemini Live token using a Cloudflare Secret. The browser then connects directly to Gemini Live; audio is not proxied through Cloudflare.

**Tech Stack:** Cloudflare Pages, Pages Functions (TypeScript), Cloudflare Access email one-time PIN, Web Crypto API, Gemini Live ephemeral-token REST API, existing HTML/CSS/JavaScript and Node/Python tests.

**Spec:** docs/superpowers/specs/2026-10-27-gemini-live-iphone-cloudflare-design.md

## Global Constraints

- Only the explicitly allowlisted personal email may access the application.
- GEMINI_API_KEY must remain a Cloudflare Secret and never appear in client assets, responses, logs, URLs, browser storage, or Git history.
- Each token is single-use, short-lived, model-constrained to gemini-3.8-live, and limited to the audio configuration the app needs.
- The app is served over HTTPS; microphone capture starts only after a user gesture.
- Do not persist audio, transcripts, conversation history, or ephemeral tokens on the app server.
- Do not modify or dispatch existing GitHub Actions, existing API smoke-test/TTS workflows, or merge/deploy without separate explicit permission.
- Keep the existing FastAPI local prototype intact unless a specific compatibility fix is required.
- No production Cloudflare account changes, secret creation, DNS changes, or deployment during implementation of this plan without explicit user permission.

## Review Focus

1. **Missing or forged Access credentials:** requests must fail closed when the Access JWT is missing, malformed, expired, wrong issuer, wrong audience, or has an invalid signature. Tests: access-auth.test.ts.
2. **Secret leakage on provider failures:** upstream errors may contain sensitive details; client responses and logs must not include the API key or ephemeral token. Tests: gemini-token.test.ts and live-token.test.ts.
3. **Cross-origin or non-POST token requests:** invalid Origin, wrong content type, and alternate methods must not issue tokens. Tests: http-security.test.ts and live-token.test.ts.
4. **Token replay and excessive issuance:** one token is scoped to one session and the endpoint has an explicit rate-limit control; UI must not fire parallel requests. Tests: live-token.test.ts and app-client.test.mjs.
5. **iOS Safari audio lifecycle:** denied microphone permission, page suspension, socket close, and repeated start/stop must clean up media tracks and audio resources. Tests: existing frontend unit tests plus a documented real-device checklist.

---

## File Map

### Create
- functions/api/live-token.ts — Pages Function entrypoint; validates request and issues ephemeral token.
- functions/_shared/access-auth.ts — Cloudflare Access JWT verification helpers.
- functions/_shared/gemini-token.ts — Google ephemeral-token request construction and safe response parsing.
- functions/_shared/http-security.ts — Origin, method, content-type, and security-header helpers.
- functions/_shared/rate-limit.ts — rate-limit adapter/guard for the chosen supported Cloudflare binding.
- functions/api/live-token.test.ts — endpoint integration tests with mocked upstream calls and environment.
- functions/_shared/access-auth.test.ts — JWT validation tests.
- functions/_shared/gemini-token.test.ts — upstream request and response sanitization tests.
- functions/_shared/http-security.test.ts — request validation tests.
- tests/app-client.test.mjs — frontend behavior tests for login/error/token-request lifecycle where testable without a browser.
- wrangler.toml or wrangler.jsonc — Pages local-development configuration only; no account identifiers or secrets.
- package.json — Node test and type-check scripts, with pinned development dependencies.
- docs/superpowers/plans/2026-10-27-gemini-live-iphone-cloudflare-setup.md — operator setup and deployment checklist.

### Modify
- frontend/index.html — explain Access login and add a small signed-in / access-required state if needed; keep accessible labels.
- frontend/app.js — handle Access redirects/401 errors, prevent concurrent token requests, and make iOS Safari lifecycle cleanup reliable.
- frontend/styles.css — ensure controls and transcripts work on narrow iPhone screens.
- README.md — distinguish the existing local prototype from the Cloudflare-hosted setup and link to the operator guide.
- Existing tests only if a behavior change requires a regression assertion; do not weaken existing assertions.

### Preserve
- server.py, current Python token tests, PCM utility tests, error-message tests, and existing workflows. The local prototype remains a separate path.

---

## Task 1: Establish Pages/Functions test scaffolding

**Files:**
- Create: package.json
- Create: wrangler.toml (or wrangler.jsonc, choose one format and use it consistently)
- Create: functions/_shared/http-security.ts
- Create: functions/_shared/http-security.test.ts

**Interfaces:**
- validateTokenRequest(request: Request, expectedOrigin: string): Response | null returns a rejection response or null when the request method, Origin, and content type are valid.
- Use the Pages Functions environment type only where supported by the selected pinned Cloudflare type package.

- [ ] Write tests named rejects_non_post_method, rejects_missing_or_mismatched_origin, rejects_cross_origin_origin, rejects_wrong_content_type, and accepts_same_origin_json_post.
- [ ] Run the focused Node test command and verify the new tests fail before implementation.
- [ ] Implement the minimal request-validation helper and secure response headers; do not add permissive CORS.
- [ ] Run the focused tests and type check; confirm all pass.
- [ ] Review the configuration to confirm no API key, account ID, or deployment target is committed.

## Task 2: Verify Cloudflare Access JWTs

**Files:**
- Create: functions/_shared/access-auth.ts
- Create: functions/_shared/access-auth.test.ts

**Interfaces:**
- verifyAccessJwt(token: string, config: { teamDomain: string; audience: string; nowSeconds?: number }, fetcher?: typeof fetch): Promise<{ email: string; subject: string }>
- Validate signature using the Access issuer's published public keys, plus issuer, audience, expiry, and not-before claims. Do not accept an email claim alone without a valid signature.
- The handler obtains the token from the documented Cloudflare Access JWT header/cookie mechanism and never trusts a client-supplied email field.

- [ ] Add tests named rejects_missing_token, rejects_malformed_token, rejects_bad_signature, rejects_wrong_issuer, rejects_wrong_audience, rejects_expired_token, rejects_not_yet_valid_token, and returns_verified_email_for_valid_token.
- [ ] Run the focused tests and verify they fail before implementation.
- [ ] Implement JWT verification with Web Crypto and the official Access key-discovery endpoint; cache only public verification keys for a bounded duration.
- [ ] Add a check that the verified email exactly matches the configured allowlisted email, normalized only as appropriate for email comparison; fail closed if configuration is absent.
- [ ] Run tests and type checks. Confirm upstream key-fetch errors do not result in accepting an unverified token.

## Task 3: Implement constrained Gemini ephemeral token issuance

**Files:**
- Create: functions/_shared/gemini-token.ts
- Create: functions/_shared/gemini-token.test.ts

**Interfaces:**
- createGeminiEphemeralToken(input: { apiKey: string; fetcher?: typeof fetch; now?: Date }): Promise<{ token: string; model: "gemini-3.8-live"; websocketUrl: string }>
- Build the token request against the current official Gemini ephemeral-token REST contract. Keep model, uses, session-start expiry, session expiry, response modalities, transcription settings, and Japanese system instruction server-defined; accept no client-supplied model/configuration.
- Do not log request headers, API key, token, or raw provider response.

- [ ] Add tests named sends_api_key_only_to_google_endpoint, locks_model_and_single_use, sets_short_session_start_window, returns_expected_token_shape, rejects_missing_api_key, rejects_missing_token_in_provider_response, and sanitizes_provider_errors.
- [ ] Mock fetch and verify tests fail before implementation.
- [ ] Check the current official Gemini docs for exact endpoint, JSON field names, and constraints immediately before implementation; update this interface only if the documented contract requires it.
- [ ] Implement request and response parsing; use Cache-Control: no-store on the app endpoint response.
- [ ] Run tests and confirm neither mocked provider errors nor logs include the API key or token value.

## Task 4: Compose the Pages Function and abuse controls

**Files:**
- Create: functions/api/live-token.ts
- Create: functions/api/live-token.test.ts
- Create or modify: functions/_shared/rate-limit.ts
- Modify: wrangler.toml (or wrangler.jsonc)

**Interfaces:**
- Pages handler onRequestPost(context) composes the security validation, Access authentication, allowlisted-email check, rate-limit guard, and createGeminiEphemeralToken.
- Environment bindings: GEMINI_API_KEY, ACCESS_TEAM_DOMAIN, ACCESS_AUDIENCE, ALLOWED_EMAIL, plus the selected supported rate-limit binding/configuration. Secret values are set out-of-band, not in configuration files.

- [ ] Add endpoint tests named returns_401_without_access_auth, returns_403_for_non_allowlisted_email, rejects_invalid_origin, rejects_wrong_method, returns_503_when_secret_missing, returns_429_when_rate_limited, returns_502_with_sanitized_body_on_google_failure, and returns_token_without_caching.
- [ ] Verify tests fail before the handler is implemented.
- [ ] Implement the handler so authentication and request validation occur before calling Google; rate-limit before token issuance.
- [ ] Use a supported Cloudflare rate-limiting mechanism available for the selected Pages deployment plan. If no supported mechanism is available, stop and report the blocker rather than ship an unprotected public token endpoint.
- [ ] Run all endpoint tests. Verify every rejection path avoids the upstream Gemini request and sensitive data.
- [ ] Document the Access and rate-limit settings as required deployment gates, but do not configure or deploy them.

## Task 5: Adapt the browser client for Access and iPhone Safari

**Files:**
- Modify: frontend/app.js
- Modify: frontend/index.html
- Modify: frontend/styles.css
- Create: tests/app-client.test.mjs (only for logic that can be tested without a full browser)

**Interfaces:**
- Keep the existing POST /api/live-token JSON response shape: { token, model, websocket_url }.
- The browser sends no API key and stores no ephemeral token beyond the active in-memory connection.
- Starting a session is guarded against parallel requests; stopping or failed startup closes the socket, stops microphone tracks, disconnects worklet nodes, cancels scheduled playback, and closes audio contexts.

- [ ] Add tests named prevents_parallel_start_requests, does_not_persist_ephemeral_token, cleans_up_after_microphone_denial, and cleans_up_after_socket_failure where practical with injected browser API fakes.
- [ ] Run existing PCM and error-message tests before changes to establish a baseline.
- [ ] Implement friendly 401/403, network, and rate-limit messages without showing response bodies that might contain sensitive details.
- [ ] Verify start, interruption, stop, permission-denied, and reconnect paths release all resources; avoid unbounded automatic retries.
- [ ] Make the UI responsive at iPhone viewport widths and ensure start requires a user gesture.
- [ ] Run the existing Node PCM and error-message suites plus new client tests and type checks.

## Task 6: Write operator setup and deployment documentation

**Files:**
- Create: docs/superpowers/plans/2026-10-27-gemini-live-iphone-cloudflare-setup.md
- Modify: README.md

- [ ] Document creating the Pages project and selecting the static asset directory without enabling automatic deployment from a workflow.
- [ ] Document configuring the Cloudflare Access self-hosted app, email one-time PIN, and exact allowlist; avoid asking the user to commit their email address.
- [ ] Document adding GEMINI_API_KEY as a Pages Function Secret and adding non-secret Access configuration as environment variables.
- [ ] Document rate limiting, HTTPS URL setup, smoke checks, rollback, and API key rotation.
- [ ] Explicitly label all actual Cloudflare account changes, secret entry, DNS/hostname configuration, and production deployment as user-authorized manual operations; do not perform them as part of this plan.
- [ ] Update README so local FastAPI use remains documented and is not confused with the hosted Pages deployment.

## Task 7: Regression, security review, and acceptance checklist

**Files:**
- Tests: all new Functions tests and existing tests/
- Documentation: setup guide and README as needed

- [ ] Run the Python test suite: python -m pytest -q.
- [ ] Run the existing Node PCM and error-message suites plus new Pages Function tests and type checks.
- [ ] Review built static assets for accidental server-only configuration; ensure no secrets are embedded.
- [ ] Review all log statements and client error responses for token/API-key leakage.
- [ ] Check access-denied, wrong-origin, missing-secret, provider-failure, and rate-limit scenarios.
- [ ] Add a manual iPhone Safari checklist for HTTPS, Access email PIN, microphone grant/denial, Japanese audio round trip, transcription, interruption, stop cleanup, network loss, and screen-lock/resume behavior.
- [ ] Report that automated checks cannot substitute for the real iPhone Safari test; do not claim end-to-end success until it is performed.
- [ ] Confirm no existing GitHub Actions workflow was edited or dispatched, no Cloudflare secret was created, no deployment was made, and no merge occurred.

## Completion Criteria

Implementation is ready for a separate deployment decision when all automated checks pass, the security review finds no key/token leakage, the setup guide is complete, and the real-device test checklist is prepared. Actual Cloudflare account configuration and production deployment remain outside this plan until the user explicitly authorizes them.
