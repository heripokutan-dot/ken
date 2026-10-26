# Gemini Live iPhone App — Cloudflare Setup Guide (operator checklist)

> **Status:** Checklist only. None of these steps have been performed by the implementation. Each Cloudflare account change, secret entry, hostname change, and deployment requires explicit user authorization.

This guide describes how the hosted app is intended to be configured. The local FastAPI prototype (`server.py`) is a separate path and is not affected by these settings.

## 0. Gates that must be satisfied before the app is public

The token endpoint (`functions/api/live-token.ts`) fails closed. It returns 503 and issues no token unless all of the following are configured:

| Gate | Where | Failure if missing |
| --- | --- | --- |
| `GEMINI_API_KEY` | Pages Secret | 503 `gemini_not_configured` |
| `ACCESS_TEAM_DOMAIN` | Pages variable (hostname only, e.g. `yourteam.cloudflareaccess.com`) | 503 `service_misconfigured` |
| `ACCESS_AUDIENCE` | Pages variable (Access application AUD tag) | 503 `service_misconfigured` |
| `ALLOWED_EMAIL` | Pages variable (the single permitted address) | 503 `service_misconfigured` |
| `RATE_LIMITER` | Rate-limiting binding (see step 4) | 503 `rate_limit_unavailable` |

**Open item:** the rate-limiting binding must be confirmed available on your Pages plan before deployment. If it is not available, do not deploy an unprotected token endpoint; choose an alternative protection and review it first.

## 1. Create the Pages project

1. In the Cloudflare dashboard, create a Pages project connected to the repository, or upload the build output manually.
2. Set the build output directory to `frontend`. No build command is needed.
3. Disable automatic production deployments from workflows until deployment is explicitly approved.

## 2. Protect the application with Cloudflare Access

1. Create a **Self-hosted** Access application covering the whole hostname (including `/api/*`).
2. Set the identity provider to **One-time PIN** (email).
3. Create one **Allow** policy that includes only your own email address. Do not add domain-wide rules or public signup.
4. Copy the application's **Audience (AUD) tag** and your team domain (`<team>.cloudflareaccess.com`).
5. Put the team domain into `ACCESS_TEAM_DOMAIN`, the AUD tag into `ACCESS_AUDIENCE`, and your email into `ALLOWED_EMAIL`. Enter the email only in the dashboard, never in the repository.

The function verifies the `Cf-Access-Jwt-Assertion` token signature, issuer, audience, and expiry, then checks the email against `ALLOWED_EMAIL`. Client-supplied identity values are never trusted.

## 3. Add the Gemini API key as a Secret

1. In the Pages project settings, add `GEMINI_API_KEY` as an **encrypted** environment variable (Secret).
2. Never commit it, paste it into code, or place it in `frontend/`.
3. Check the Gemini API project's quota and billing limits separately. Rate limiting in step 4 does not cap spending.

## 4. Configure rate limiting

1. Add a rate-limiting binding named `RATE_LIMITER` to the Pages Functions configuration, with a limit suitable for personal use (for example, a small number of token requests per minute per user).
2. Confirm the binding is supported on your plan. The code treats its absence as a hard failure on purpose.

## 5. Deploy (requires explicit authorization)

Deployment is a user-authorized operation. When approved, deploy the Pages project and confirm `GET /` requires Access sign-in before anything else.

## 6. Smoke checks

1. Open the HTTPS URL in a private window: you should be asked for an emailed PIN, and a different email should be refused.
2. With a permitted email, confirm `POST /api/live-token` from the page returns a token and `Cache-Control: no-store`.
3. Confirm a request without the Access header, from another origin, or with GET returns an error and issues no token.
4. Confirm the response bodies and Pages function logs contain no API key, token, or provider error text.

## 7. Real-device test (iPhone Safari)

- Load the HTTPS URL and complete the email PIN sign-in.
- Grant microphone permission, speak a short Japanese phrase, and confirm a spoken Japanese response.
- Check transcripts, interruption during playback, and stop cleanup (microphone indicator off).
- Test network loss, screen lock and resume, and a denied microphone permission.

Automated tests cannot replace this step.

## 8. Rollback and key rotation

- **Rollback:** redeploy the previous Pages deployment from the dashboard. Keep Access enabled during rollback.
- **Key rotation:** create a new Gemini API key, update the `GEMINI_API_KEY` Secret, redeploy, then revoke the old key.
- **Access revocation:** remove the email from the Allow policy or end the Access session to block a device immediately.

## 9. What the app stores

The app stores no audio, transcripts, conversation history, or tokens on the server. Audio is streamed directly between the browser and Gemini Live. Google's own data handling for the Gemini API is governed by Google's terms and is separate from this app.
