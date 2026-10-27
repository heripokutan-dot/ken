# Claude Handoff: Cloudflare Pages setup for Gemini Live iPhone app

## Goal

Continue the setup of the existing app in this repository and help the user get it working on Cloudflare Pages without requiring payment-card registration if a supported free option exists.

The user wants Claude to take over work that ChatGPT could not complete directly. Do not assume the user has authorized adding secrets or weakening authentication.

## Repository and branch

- Repository: `heripokutan-dot/ken`
- Working branch: `feat/gemini-live-iphone-cloudflare-impl`
- Cloudflare Pages project is believed to be `ken`, with a deployment URL previously noted as `https://ken-chl.pages.dev`. Verify before relying on this.
- Existing Wrangler config file: `wrangler.toml`

## Current known configuration

The current `wrangler.toml` content observed on this branch was:

```toml
# Cloudflare Pages configuration for the hosted iPhone app. No account IDs, secrets, or hostnames here.
# Set in the Pages dashboard (never in this file):
#   Secret:    GEMINI_API_KEY
#   Variables: ACCESS_TEAM_DOMAIN, ACCESS_AUDIENCE, ALLOWED_EMAIL
#   Binding:   RATE_LIMITER (rate-limiting binding; see the setup guide — the endpoint fails closed without it)
name = "ken-live"
pages_build_output_dir = "frontend"
compatibility_date = "2026-10-01"
```

No rate-limit binding had been added at the time of writing. No API key or other secret had been added.

The Cloudflare Pages dashboard was showing a notice that environment variables for the project are managed through `wrangler.toml`, and only encrypted Secrets can be managed through the dashboard. The user found the Variables and Secrets UI but has not entered any values.

## Relevant code behavior observed

- `functions/api/live-token.ts` requires `ACCESS_TEAM_DOMAIN`, `ACCESS_AUDIENCE`, `ALLOWED_EMAIL`, a `RATE_LIMITER` binding, and `GEMINI_API_KEY`.
- It checks same-origin requests, validates the Cloudflare Access JWT from `Cf-Access-Jwt-Assertion`, checks the email against `ALLOWED_EMAIL`, applies rate limiting by email, and fails closed when configuration or the rate-limit binding is missing.
- `functions/_shared/rate-limit.ts` expects the binding to provide `limit({ key })` and return an object with `success`; missing/unavailable binding is treated as unavailable.
- A GitHub search for `RATE_LIMITER` did not find an existing binding declaration.

## Important constraints and user preferences

1. The user prefers not to register a payment card. Do not ask them to enter card details unless they explicitly change this preference. Do not suggest fake card information.
2. Do not place API keys, tokens, passwords, account IDs, or other secrets in this repository or this handoff document.
3. Do not publish or leave a publicly usable endpoint that issues Gemini Live tokens without working authentication and rate limiting.
4. The user wants guidance and a handoff to Claude. Explain actions and risks clearly; do not claim a deployment or verification succeeded unless it was actually checked.
5. Do not silently change production configuration or push unrelated changes.

## Work to continue

1. Inspect the current branch and relevant source files before editing; verify that the observations above are still accurate.
2. Determine the correct, currently supported way to declare a Cloudflare Rate Limiting binding for **Cloudflare Pages Functions** in the repository's configuration. Confirm compatibility with the build/deploy setup and the Wrangler version actually used. Do not assume a config snippet works without verification.
3. A previous *proposal only* (not committed) was:
   ```toml
   [[ratelimits]]
   name = "RATE_LIMITER"
   namespace_id = "731042"

     [ratelimits.simple]
     limit = 5
     period = 60
   ```
   The namespace ID is illustrative and must be checked for suitability/uniqueness before use. This sample means 5 requests per 60-second period per key; choose limits appropriate to the app. Do not blindly apply it without validating the configuration and Cloudflare requirements.
4. Investigate whether Cloudflare Access can be configured for this use case on a supported free plan without entering payment-card details. The user previously reached a Zero Trust screen titled “Activate Zero Trust Free” that asked for card details and stopped there. Do not claim a card-free path exists unless verified. If Access requires a card for this account, propose a secure alternative before making changes; do not simply remove authentication checks.
5. Prepare the smallest safe implementation and a clear manual setup checklist for the user. Keep secrets in Cloudflare's encrypted Secret UI or another secure supported secret store, never in source control.
6. After changes, report exactly which files were changed, the commit/branch, any checks performed, and what remains for the user to configure. Do not claim production is ready until authentication, rate limiting, and deployment behavior are verified.

## Useful official documentation to consult

- Cloudflare Workers Rate Limiting: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Cloudflare Pages Functions Wrangler configuration: https://developers.cloudflare.com/pages/functions/wrangler-configuration/
- Cloudflare Pages Functions pricing/limits: https://developers.cloudflare.com/pages/functions/pricing/

## Current status

No rate-limit config change was made by ChatGPT. The snippet above was only suggested in chat. The user was asked to add it manually, but then asked to hand the work over to Claude instead.
