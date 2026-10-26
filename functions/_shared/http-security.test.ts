import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTokenRequest } from "./http-security.ts";

const ORIGIN = "https://app.example.pages.dev";
const URL_ = `${ORIGIN}/api/live-token`;

function req(init: { method?: string; origin?: string | null; contentType?: string | null } = {}) {
  const headers = new Headers();
  if (init.origin !== null) headers.set("Origin", init.origin ?? ORIGIN);
  if (init.contentType !== null) headers.set("Content-Type", init.contentType ?? "application/json");
  return new Request(URL_, { method: init.method ?? "POST", headers, body: init.method === "GET" ? undefined : "{}" });
}

test("rejects_non_post_method", () => {
  const res = validateTokenRequest(req({ method: "GET" }), ORIGIN);
  assert.equal(res?.status, 405);
});

test("rejects_missing_or_mismatched_origin", () => {
  assert.equal(validateTokenRequest(req({ origin: null }), ORIGIN)?.status, 403);
});

test("rejects_cross_origin_origin", () => {
  assert.equal(validateTokenRequest(req({ origin: "https://evil.example" }), ORIGIN)?.status, 403);
});

test("rejects_wrong_content_type", () => {
  assert.equal(validateTokenRequest(req({ contentType: "text/plain" }), ORIGIN)?.status, 415);
});

test("accepts_same_origin_json_post", () => {
  assert.equal(validateTokenRequest(req(), ORIGIN), null);
});

test("rejection_responses_are_not_cacheable_and_set_nosniff", () => {
  const res = validateTokenRequest(req({ origin: "https://evil.example" }), ORIGIN);
  assert.equal(res?.headers.get("Cache-Control"), "no-store");
  assert.equal(res?.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(res?.headers.get("Access-Control-Allow-Origin"), null);
});
