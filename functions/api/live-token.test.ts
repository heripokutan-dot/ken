import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleLiveToken, type LiveTokenEnv } from "./live-token.ts";
import { clearAccessKeyCache } from "../_shared/access-auth.ts";
import { makeKey, signJwt, validClaims, jwksFetcher } from "../_shared/test-utils.ts";

const ORIGIN = "https://ken.example.pages.dev";
const URL_ = `${ORIGIN}/api/live-token`;
const SECRET = "AIzaSy-TOP-SECRET-KEY";
const ALLOWED = "owner@example.com";

beforeEach(() => clearAccessKeyCache());

async function setup(opts: {
  email?: string;
  secret?: string | undefined;
  rateLimit?: "ok" | "limited" | "missing";
  geminiStatus?: number;
  geminiBody?: unknown;
  noJwt?: boolean;
  allowlist?: string | undefined;
  teamDomain?: string | undefined;
} = {}) {
  const key = await makeKey();
  const jwt = await signJwt(key, validClaims({ email: opts.email ?? ALLOWED }));
  const access = jwksFetcher([key.publicJwk]);
  const geminiCalls: string[] = [];
  const upstream = async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    if (u.includes("/cdn-cgi/access/certs")) return access.fetch(u);
    geminiCalls.push(u);
    return new Response(
      JSON.stringify(opts.geminiBody ?? { name: "auth_tokens/tok-1" }),
      { status: opts.geminiStatus ?? 200 },
    );
  };
  const limiter =
    opts.rateLimit === "missing"
      ? undefined
      : { limit: async () => ({ success: (opts.rateLimit ?? "ok") === "ok" }) };
  const env: LiveTokenEnv = {
    GEMINI_API_KEY: "secret" in opts ? opts.secret : SECRET,
    ACCESS_TEAM_DOMAIN: "teamDomain" in opts ? opts.teamDomain : "team.cloudflareaccess.com",
    ACCESS_AUDIENCE: "aud-tag-123",
    ALLOWED_EMAIL: "allowlist" in opts ? opts.allowlist : ALLOWED,
    RATE_LIMITER: limiter,
  };
  const headers: Record<string, string> = { Origin: ORIGIN, "Content-Type": "application/json" };
  if (!opts.noJwt) headers["Cf-Access-Jwt-Assertion"] = jwt;
  const request = new Request(URL_, { method: "POST", headers, body: "{}" });
  return { request, env, upstream, geminiCalls };
}

async function call(opts: Parameters<typeof setup>[0] = {}, overrides: { method?: string; origin?: string } = {}) {
  const s = await setup(opts);
  let request = s.request;
  if (overrides.method || overrides.origin) {
    const headers = new Headers(request.headers);
    if (overrides.origin) headers.set("Origin", overrides.origin);
    request = new Request(URL_, { method: overrides.method ?? "POST", headers, body: overrides.method === "GET" ? undefined : "{}" });
  }
  const res = await handleLiveToken(request, s.env, s.upstream as unknown as typeof fetch);
  return { res, geminiCalls: s.geminiCalls, body: await res.text() };
}

test("returns_401_without_access_auth", async () => {
  const { res, geminiCalls } = await call({ noJwt: true });
  assert.equal(res.status, 401);
  assert.equal(geminiCalls.length, 0);
});

test("returns_403_for_non_allowlisted_email", async () => {
  const { res, geminiCalls } = await call({ email: "stranger@example.com" });
  assert.equal(res.status, 403);
  assert.equal(geminiCalls.length, 0);
});

test("rejects_invalid_origin", async () => {
  const { res, geminiCalls } = await call({}, { origin: "https://evil.example" });
  assert.equal(res.status, 403);
  assert.equal(geminiCalls.length, 0);
});

test("rejects_wrong_method", async () => {
  const { res, geminiCalls } = await call({}, { method: "GET" });
  assert.equal(res.status, 405);
  assert.equal(geminiCalls.length, 0);
});

test("returns_503_when_secret_missing", async () => {
  const { res, geminiCalls, body } = await call({ secret: undefined });
  assert.equal(res.status, 503);
  assert.equal(geminiCalls.length, 0);
  assert.equal(body.includes(SECRET), false);
});

test("returns_503_when_access_config_missing_fails_closed", async () => {
  const { res, geminiCalls } = await call({ teamDomain: undefined });
  assert.equal(res.status, 503);
  assert.equal(geminiCalls.length, 0);
});

test("returns_503_when_allowlist_missing_fails_closed", async () => {
  const { res, geminiCalls } = await call({ allowlist: undefined });
  assert.equal(res.status, 503);
  assert.equal(geminiCalls.length, 0);
});

test("returns_429_when_rate_limited", async () => {
  const { res, geminiCalls } = await call({ rateLimit: "limited" });
  assert.equal(res.status, 429);
  assert.equal(geminiCalls.length, 0);
});

test("fails_closed_when_rate_limit_binding_missing", async () => {
  const { res, geminiCalls } = await call({ rateLimit: "missing" });
  assert.equal(res.status, 503);
  assert.equal(geminiCalls.length, 0, "must not issue tokens without a rate-limit guard");
});

test("returns_502_with_sanitized_body_on_google_failure", async () => {
  const { res, body } = await call({ geminiStatus: 403, geminiBody: { error: { message: `bad key ${SECRET}` } } });
  assert.equal(res.status, 502);
  assert.equal(body.includes(SECRET), false);
  assert.equal(body.includes("bad key"), false);
});

test("returns_token_without_caching", async () => {
  const { res, body } = await call();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  assert.deepEqual(JSON.parse(body), {
    token: "auth_tokens/tok-1",
    model: "gemini-3.8-live",
    websocket_url:
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained",
  });
  assert.equal(body.includes(SECRET), false);
});
