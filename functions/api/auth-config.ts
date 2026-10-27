// GET /api/auth-config — public sign-in settings for the browser (no secrets).
// Returns only the OAuth client ID, which is public by design. Never returns the allowlisted email.

import { errorResponse, SECURITY_HEADERS } from "../_shared/http-security.ts";

export interface AuthConfigEnv {
  AUTH_PROVIDER?: string;
  GOOGLE_CLIENT_ID?: string;
}

export function handleAuthConfig(request: Request, env: AuthConfigEnv): Response {
  if (request.method !== "GET") return errorResponse(405, "method_not_allowed", { Allow: "GET" });
  // 404 with a JSON body: this function ran, but the deployed environment lacks these settings.
  // Only the NAMES of missing settings are returned, never their values.
  const missing: string[] = [];
  if (env.AUTH_PROVIDER !== "google") missing.push("AUTH_PROVIDER");
  if (!env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (missing.length > 0) {
    return new Response(JSON.stringify({ error: "not_configured", missing }), {
      status: 404,
      headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify({ provider: "google", clientId: env.GOOGLE_CLIENT_ID }), {
    status: 200,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

export const onRequest = (context: { request: Request; env: AuthConfigEnv }) =>
  handleAuthConfig(context.request, context.env);
