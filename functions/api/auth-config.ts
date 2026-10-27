// GET /api/auth-config — public sign-in settings for the browser (no secrets).
// Returns only the OAuth client ID, which is public by design. Never returns the allowlisted email.

import { errorResponse, SECURITY_HEADERS } from "../_shared/http-security.ts";

export interface AuthConfigEnv {
  AUTH_PROVIDER?: string;
  GOOGLE_CLIENT_ID?: string;
}

export function handleAuthConfig(request: Request, env: AuthConfigEnv): Response {
  if (request.method !== "GET") return errorResponse(405, "method_not_allowed", { Allow: "GET" });
  if (env.AUTH_PROVIDER !== "google" || !env.GOOGLE_CLIENT_ID) return errorResponse(404, "not_found");
  return new Response(JSON.stringify({ provider: "google", clientId: env.GOOGLE_CLIENT_ID }), {
    status: 200,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

export const onRequest = (context: { request: Request; env: AuthConfigEnv }) =>
  handleAuthConfig(context.request, context.env);
