// POST /api/live-token — Cloudflare Pages Function.
// Order: same-origin request checks -> sign-in verification (google | access) -> allowlisted email
//        -> rate limit (D1) -> Gemini ephemeral token.
// Nothing (key, token, provider error text) is logged or echoed back on failure.

import { validateTokenRequest, errorResponse, SECURITY_HEADERS } from "../_shared/http-security.ts";
import { verifyAccessJwt } from "../_shared/access-auth.ts";
import { verifyGoogleIdToken } from "../_shared/google-auth.ts";
import { createGeminiEphemeralToken, GeminiTokenError } from "../_shared/gemini-token.ts";
import { checkRateLimit, type D1Like } from "../_shared/rate-limit.ts";

export interface LiveTokenEnv {
  AUTH_PROVIDER?: string; // "google" (default recommended) or "access"
  ALLOWED_EMAIL?: string;
  GOOGLE_CLIENT_ID?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUDIENCE?: string;
  GEMINI_API_KEY?: string;
  RATE_LIMIT_DB?: D1Like;
}

export const TOKEN_RATE_LIMIT = { limit: 10, windowSeconds: 60 };

async function authenticate(
  request: Request,
  env: LiveTokenEnv,
  fetcher: typeof fetch,
  allowedEmail: string,
): Promise<{ email: string } | Response> {
  const provider = env.AUTH_PROVIDER;
  try {
    if (provider === "google") {
      const bearer = request.headers.get("Authorization") ?? "";
      const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(bearer);
      if (!match) return errorResponse(401, "unauthenticated");
      const user = await verifyGoogleIdToken(
        match[1],
        { clientId: env.GOOGLE_CLIENT_ID ?? "", allowedEmail },
        fetcher,
      );
      return { email: user.email };
    }
    if (provider === "access") {
      const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
      if (!jwt) return errorResponse(401, "unauthenticated");
      const user = await verifyAccessJwt(
        jwt,
        { teamDomain: env.ACCESS_TEAM_DOMAIN ?? "", audience: env.ACCESS_AUDIENCE ?? "" },
        fetcher,
      );
      return { email: user.email };
    }
  } catch {
    return errorResponse(401, "unauthenticated");
  }
  return errorResponse(503, "service_misconfigured");
}

export async function handleLiveToken(
  request: Request,
  env: LiveTokenEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const expectedOrigin = new URL(request.url).origin;
  const rejected = validateTokenRequest(request, expectedOrigin);
  if (rejected) return rejected;

  // Fail closed on incomplete configuration; never fall back to an open endpoint.
  // The 503 body names missing settings (names only, never values) so a wrong environment is easy to spot.
  const missing: string[] = [];
  if (!env.ALLOWED_EMAIL) missing.push("ALLOWED_EMAIL");
  if (env.AUTH_PROVIDER === "google") {
    if (!env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  } else if (env.AUTH_PROVIDER === "access") {
    if (!env.ACCESS_TEAM_DOMAIN) missing.push("ACCESS_TEAM_DOMAIN");
    if (!env.ACCESS_AUDIENCE) missing.push("ACCESS_AUDIENCE");
  } else {
    missing.push("AUTH_PROVIDER");
  }
  if (missing.length > 0) {
    return new Response(JSON.stringify({ error: "service_misconfigured", missing }), {
      status: 503,
      headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const allowedEmail = env.ALLOWED_EMAIL as string;

  const auth = await authenticate(request, env, fetcher, allowedEmail);
  if (auth instanceof Response) return auth;

  if (auth.email.trim().toLowerCase() !== allowedEmail.trim().toLowerCase()) {
    return errorResponse(403, "forbidden");
  }

  const limit = await checkRateLimit(env.RATE_LIMIT_DB, auth.email.trim().toLowerCase(), {
    ...TOKEN_RATE_LIMIT,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
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
    // Safe diagnostics only: a fixed reason code and Google's HTTP status number. Never key, token or provider text.
    const detail: Record<string, string | number> = {};
    if (err instanceof GeminiTokenError) {
      detail.reason = err.message;
      if (Number.isInteger(err.upstreamStatus)) detail.upstream_status = err.upstreamStatus as number;
      if (err.upstreamCode) detail.upstream_code = err.upstreamCode;
      if (err.upstreamReason) detail.upstream_reason = err.upstreamReason;
      if (err.upstreamField) detail.upstream_field = err.upstreamField;
    }
    return new Response(JSON.stringify({ error: "token_issue_failed", ...detail }), {
      status: 502,
      headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

// Pages Functions entrypoint: method checks happen inside handleLiveToken.
export const onRequest = (context: { request: Request; env: LiveTokenEnv }) =>
  handleLiveToken(context.request, context.env);
