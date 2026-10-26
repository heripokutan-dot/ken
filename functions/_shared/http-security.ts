export const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function errorResponse(status: number, error: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...SECURITY_HEADERS, ...extra, "Content-Type": "application/json; charset=utf-8" },
  });
}

// Returns a rejection response, or null when the request is an acceptable same-origin JSON POST.
// No CORS headers are ever emitted, so cross-origin browsers cannot read responses.
export function validateTokenRequest(request: Request, expectedOrigin: string): Response | null {
  if (request.method !== "POST") {
    return errorResponse(405, "method_not_allowed", { Allow: "POST" });
  }
  if (request.headers.get("Origin") !== expectedOrigin) {
    return errorResponse(403, "forbidden_origin");
  }
  const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return errorResponse(415, "unsupported_media_type");
  }
  return null;
}
