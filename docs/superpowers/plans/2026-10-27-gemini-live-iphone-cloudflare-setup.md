# Gemini Live iPhone App — Cloudflare Setup Guide (operator checklist)

> **Status:** Checklist only. The implementation has not performed any of these steps. Each Cloudflare account change, secret entry, and deployment requires explicit user authorization.

This guide describes how the hosted app is configured. It deliberately avoids Cloudflare Zero Trust (Access), which requires payment details to activate even on the free plan. The local FastAPI prototype (`server.py`) is a separate path and is not affected.

## 0. Gates (the endpoint fails closed until all are present)

| Gate | Where to set it | Missing → |
| --- | --- | --- |
| `GEMINI_API_KEY` | Pages **Secret** | 503 `gemini_not_configured` |
| `AUTH_PROVIDER` = `google` | Pages **Secret** | 503 `service_misconfigured` |
| `GOOGLE_CLIENT_ID` | Pages **Secret** | 503 `service_misconfigured` |
| `ALLOWED_EMAIL` | Pages **Secret** | 503 `service_misconfigured` |
| `RATE_LIMIT_DB` | Pages **D1 binding** | 503 `rate_limit_unavailable` |

Secrets are used for the email and client ID so that personal data does not enter the repository. The Google client ID is public, but keeping it out of Git is simpler.

## 1. Create the Pages project

1. Create a Pages project connected to the repository (or upload the output manually).
2. Build output directory: `frontend`. No build command.
3. Keep automatic production deployment from workflows disabled until deployment is explicitly approved.

## 2. Sign-in with Google (no payment method needed)

1. In Google Cloud Console, create a project (if you do not have one) and configure the **OAuth consent screen** (External, testing mode is fine for one user).
2. Create an **OAuth client ID** of type **Web application**.
   - Authorized JavaScript origins: `https://<your-pages-hostname>` (exact origin, no path).
   - Redirect URIs are not needed for the Identity Services button flow.
3. Put the client ID into the `GOOGLE_CLIENT_ID` Secret, and your own Google account email into `ALLOWED_EMAIL`.
4. Set `AUTH_PROVIDER` to `google`.

Verification on the server: the function checks the ID token signature against Google's published keys, the issuer, the audience (your client ID), expiry, `email_verified`, and the exact allowlisted email. The browser keeps the ID token only in memory.

> **Unverified:** whether creating an OAuth client needs a billing account in your Google Cloud project. Check the console before starting; if billing is requested, stop and report it.

## 3. Add the Gemini API key as a Secret

1. Add `GEMINI_API_KEY` as an **encrypted** Secret in the Pages project.
2. Never commit it, paste it into code or chat, or place it in `frontend/`.
3. Gemini quota and billing limits are separate from the app's rate limit; check them in the Gemini API project.

## 4. Rate limiting with D1

1. Create a D1 database (Workers & Pages → D1) and apply the schema:
   ```bash
   wrangler d1 execute <database-name> --remote --file migrations/0001_rate_limits.sql
   ```
   The `wrangler` command runs on your machine with your own login; it is not run by the implementation.
2. In the Pages project, add a **D1 database binding** named `RATE_LIMIT_DB` pointing at that database.
3. The limit is 10 token requests per 60 seconds per account (see `TOKEN_RATE_LIMIT` in `functions/api/live-token.ts`).

> **Unverified:** whether creating a D1 database on your account requires payment details. Check first; if it does, stop and report it rather than adding payment details.
>
> The Rate Limiting binding is intentionally not used: it is not in the list of supported Pages Functions bindings.

## 5. Deploy (requires explicit authorization)

Deployment is user-authorized. When approved, open the HTTPS URL and confirm the sign-in button appears and that the start button stays disabled until a permitted account signs in.

## 6. Smoke checks

1. `GET /api/auth-config` returns `{ "provider": "google", "clientId": "..." }` only (no email).
2. `POST /api/live-token` without a sign-in returns 401; from a different origin returns 403; with GET returns 405.
3. A signed-in permitted account gets a token response with `Cache-Control: no-store`.
4. No API key, token, or provider error text appears in responses or function logs.

## 7. Real-device test (iPhone Safari)

- Open the HTTPS URL, sign in with Google, and allow the microphone.
- Speak a short Japanese phrase and confirm a spoken Japanese response.
- Check transcripts, interruption during playback, and stop cleanup (microphone indicator off).
- Test network loss, screen lock and resume, and a denied microphone permission.
- Note: the ID token expires after about an hour; sign in again if you see the sign-in message.

Automated tests cannot replace this step.

## 8. Rollback and key rotation

- **Rollback:** redeploy a previous Pages deployment from the dashboard.
- **Key rotation:** create a new Gemini key, update the `GEMINI_API_KEY` Secret, redeploy, then revoke the old key.
- **Blocking access:** change `ALLOWED_EMAIL` to another value, or set `AUTH_PROVIDER` to anything but `google`; both take effect on redeploy.

## 9. What the app stores

The server stores no audio, transcripts, conversation history, or tokens. Only per-minute request counters (keyed by email) are kept in D1. Audio goes directly between the browser and Gemini Live. Google's own data handling for the Gemini API is governed by Google's terms.
