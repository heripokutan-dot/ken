// POST /api/live-token — Cloudflare Pages Function.
// Order: same-origin request checks -> Access JWT -> allowlisted email -> rate limit -> Gemini token.
// Nothing (key, token, provider error text) is logged or echoed back on failure.

import { validateTokenRequest, errorResponse, SECURITY_HEADERS } from "../_shared/http-security.ts";
import { verifyAccessJwt } from "../_shared/access-auth.ts";
import { createGeminiEphemeralToken, GeminiTokenError } from "../_shared/gemini-token.ts";
import { checkRateLimit, type RateLimiterBinding } from "../_shared/rate-limit.ts";

export interface LiveTokenEnv {
  GEMINI_API_KEY?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUDIENCE?: string;
  ALLOWED_EMAIL?: string;
  RATE_LIMITER?: RateLimiterBinding;
}

const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";

export async function handleLiveToken(
  request: Request,
  env: LiveTokenEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const expectedOrigin = new URL(request.url).origin;
  const rejected = validateTokenRequest(request, expectedOrigin);
  if (rejected) return rejected;

  // Fail closed on incomplete configuration; never fall back to an open endpoint.
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUDIENCE || !env.ALLOWED_EMAIL) {
    return errorResponse(503, "service_misconfigured");
  }

  const jwt = request.headers.get(ACCESS_HEADER);
  if (!jwt) return errorResponse(401, "unauthenticated");

  let email: string;
  try {
    ({ email } = await verifyAccessJwt(
      jwt,
      { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUDIENCE },
      fetcher,
    ));
  } catch {
    return errorResponse(401, "unauthenticated");
  }

  if (email.trim().toLowerCase() !== env.ALLOWED_EMAIL.trim().toLowerCase()) {
    return errorResponse(403, "forbidden");
  }

  const limit = await checkRateLimit(env.RATE_LIMITER, email.toLowerCase());
  if (limit === "limited") return errorResponse(429, "rate_limited", { "Retry-After": "60" });
  if (limit === "unavailable") return errorResponse(503, "rate_limit_unavailable");

  if (!env.GEMINI_API_KEY) return errorResponse(503, "gemini_not_configured");

  try {
    const issued = await createGeminiEphemeralToken({ apiKey: env.GEMINI_API_KEY, fetcher });
    return new Response(
      JSON.stringify({ token: issued.token, model: issued.model, websocket_url: issued.websocketUrl }),
      { status: 200, headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" } },
    );
  } catch (err) {
    if (err instanceof GeminiTokenError && err.status === 503) return errorResponse(503, "gemini_not_configured");
    return errorResponse(502, "token_issue_failed");
  }
}

// Pages Functions entrypoint: method checks happen inside handleLiveToken.
export const onRequest = (context: { request: Request; env: LiveTokenEnv }) =>
  handleLiveToken(context.request, context.env);
