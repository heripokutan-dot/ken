// Temporary diagnostic (JavaScript, no imports): shows whether Pages routes files under functions/api/.
export function onRequest() {
  return new Response(JSON.stringify({ ok: true, route: "/api/ping" }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
