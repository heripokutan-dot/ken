import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { handleLiveToken, type LiveTokenEnv } from "./live-token.ts";
import { handleAuthConfig } from "./auth-config.ts";
import { clearJwksCache } from "../_shared/jwt-rs256.ts";
import { RATE_LIMIT_SCHEMA } from "../_shared/rate-limit.ts";
import { makeKey, signJwt, validClaims, d1FromSqlite } from "../_shared/test-utils.ts";

const ORIGIN = "https://ken.example.pages.dev";
const URL_ = `${ORIGIN}/api/live-token`;
const SECRET = "AIzaSy-TOP-SECRET-KEY";
const ALLOWED = "owner@example.com";
const GOOGLE_CLIENT_ID = "123456-abc.apps.googleusercontent.com";
const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-tag-123";

beforeEach(() => clearJwksCache());

// Serves signing keys for both Google's and Cloudflare Access's JWKS URLs.
function router(keys: { google: JsonWebKey & { kid: string }; access: JsonWebKey & { kid: string } }, geminiStatus: number, geminiBody: unknown) {
  const geminiCalls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      return new Response(JSON.stringify({ keys: [keys.google] }), { status: 200 });
    }
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: [keys.access] }), { status: 200 });
    }
    geminiCalls.push(url);
    return new Response(JSON.stringify(geminiBody), { status: geminiStatus });
  }) as unknown as typeof fetch;
  return { fetcher, geminiCalls };
}

async function setup(opts: {
  provider?: string;
  email?: string;
  googleClaims?: Record<string, unknown>;
  secret?: string | undefined;
  allowlist?: string | undefined;
  clientId?: string | undefined;
  teamDomain?: string | undefined;
  rateLimitDb?: "sqlite" | "missing" | "broken";
  limitPreFill?: number;
  geminiStatus?: number;
  geminiBody?: unknown;
  noAuth?: boolean;
  accessJwt?: boolean;
} = {}) {
  const google = await makeKey("g-kid");
  const access = await makeKey("a-kid");
  const { fetcher, geminiCalls } = router(
    { google: google.publicJwk, access: access.publicJwk },
    opts.geminiStatus ?? 200,
    opts.geminiBody ?? { name: "auth_tokens/tok-1" },
  );
  const now = Math.floor(Date.now() / 1000);
  const email = opts.email ?? ALLOWED;
  const googleToken = await signJwt(google, {
    iss: "https://accounts.google.com",
    aud: GOOGLE_CLIENT_ID,
    azp: GOOGLE_CLIENT_ID,
    exp: now + 300,
    sub: "g-sub",
    email,
    email_verified: true,
    ...(opts.googleClaims ?? {}),
  });
  const accessToken = await signJwt(access, validClaims({ email, aud: [AUD] }));

  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(RATE_LIMIT_SCHEMA);
  const db = d1FromSqlite(sqlite);
  if (opts.limitPreFill) {
    const bucket = Math.floor(now / 60) * 60;
    sqlite.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)").run(
      email.toLowerCase(),
      bucket,
      opts.limitPreFill,
    );
  }
  const rateLimitDb =
    opts.rateLimitDb === "missing" ? undefined : opts.rateLimitDb === "broken" ? ({ prepare: () => { throw new Error("x"); } } as never) : db;

  const env: LiveTokenEnv = {
    AUTH_PROVIDER: opts.provider ?? "google",
    GEMINI_API_KEY: "secret" in opts ? opts.secret : SECRET,
    ALLOWED_EMAIL: "allowlist" in opts ? opts.allowlist : ALLOWED,
    GOOGLE_CLIENT_ID: "clientId" in opts ? opts.clientId : GOOGLE_CLIENT_ID,
    ACCESS_TEAM_DOMAIN: "teamDomain" in opts ? opts.teamDomain : TEAM,
    ACCESS_AUDIENCE: AUD,
    RATE_LIMIT_DB: rateLimitDb,
  };
  const headers: Record<string, string> = { Origin: ORIGIN, "Content-Type": "application/json" };
  if (!opts.noAuth) {
    if (opts.provider === "access" || opts.accessJwt) headers["Cf-Access-Jwt-Assertion"] = accessToken;
    else headers.Authorization = `Bearer ${googleToken}`;
  }
  const request = new Request(URL_, { method: "POST", headers, body: "{}" });
  return { request, env, fetcher, geminiCalls };
}

async function call(opts: Parameters<typeof setup>[0] = {}, overrides: { method?: string; origin?: string } = {}) {
  const s = await setup(opts);
  let request = s.request;
  if (overrides.method || overrides.origin) {
    const headers = new Headers(request.headers);
    if (overrides.origin) headers.set("Origin", overrides.origin);
    request = new Request(URL_, {
      method: overrides.method ?? "POST",
      headers,
      body: overrides.method === "GET" ? undefined : "{}",
    });
  }
  const res = await handleLiveToken(request, s.env, s.fetcher);
  return { res, geminiCalls: s.geminiCalls, body: await res.text() };
}

test("returns_401_without_sign_in", async () => {
  const { res, geminiCalls } = await call({ noAuth: true });
  assert.equal(res.status, 401);
  assert.equal(geminiCalls.length, 0);
});

test("returns_401_for_invalid_google_token", async () => {
  const { res, geminiCalls } = await call({ googleClaims: { iss: "https://evil.example" } });
  assert.equal(res.status, 401);
  assert.equal(geminiCalls.length, 0);
});

test("rejects_non_allowlisted_google_account_at_verification", async () => {
  // The Google verifier enforces the allowlist itself, so a valid token for another account is a 401.
  const { res, geminiCalls } = await call({ email: "stranger@example.com" });
  assert.equal(res.status, 401);
  assert.equal(geminiCalls.length, 0);
});

test("google_path_rejects_unverified_email", async () => {
  const { res, geminiCalls } = await call({ googleClaims: { email_verified: false } });
  assert.equal(res.status, 401);
  assert.equal(geminiCalls.length, 0);
});

test("access_path_still_works_when_selected", async () => {
  const { res } = await call({ provider: "access" });
  assert.equal(res.status, 200);
});

test("access_path_returns_403_for_non_allowlisted_email", async () => {
  const { res, geminiCalls } = await call({ provider: "access", email: "stranger@example.com" });
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

test("returns_503_for_unknown_auth_provider", async () => {
  const { res, geminiCalls } = await call({ provider: "none" });
  assert.equal(res.status, 503);
  assert.equal(geminiCalls.length, 0);
});

test("returns_503_when_google_client_id_missing_fails_closed", async () => {
  const { res, geminiCalls } = await call({ clientId: undefined });
  assert.equal(res.status, 503);
  assert.equal(geminiCalls.length, 0);
});

test("returns_503_when_allowlist_missing_fails_closed", async () => {
  const { res, geminiCalls } = await call({ allowlist: undefined });
  assert.equal(res.status, 503);
  assert.equal(geminiCalls.length, 0);
});

test("returns_503_when_secret_missing", async () => {
  const { res, geminiCalls, body } = await call({ secret: undefined });
  assert.equal(res.status, 503);
  assert.equal(geminiCalls.length, 0);
  assert.equal(body.includes(SECRET), false);
});

test("returns_429_when_rate_limited", async () => {
  const { res, geminiCalls } = await call({ limitPreFill: 10 });
  // 10 pre-filled means the next (11th) request in the window is over the limit of 10.
  assert.equal(res.status, 429);
  assert.equal(geminiCalls.length, 0);
});

test("fails_closed_when_rate_limit_database_missing", async () => {
  const { res, geminiCalls } = await call({ rateLimitDb: "missing" });
  assert.equal(res.status, 503);
  assert.equal(geminiCalls.length, 0, "must not issue tokens without a rate-limit guard");
});

test("fails_closed_when_rate_limit_database_errors", async () => {
  const { res, geminiCalls } = await call({ rateLimitDb: "broken" });
  assert.equal(res.status, 503);
  assert.equal(geminiCalls.length, 0);
});

test("returns_502_with_sanitized_body_on_google_failure", async () => {
  const { res, body } = await call({ geminiStatus: 403, geminiBody: { error: { message: `bad key ${SECRET}` } } });
  assert.equal(res.status, 502);
  assert.equal(body.includes(SECRET), false);
  assert.equal(body.includes("bad key"), false);
  // Only a fixed reason code and the upstream HTTP status number are exposed for troubleshooting.
  assert.deepEqual(JSON.parse(body), { error: "token_issue_failed", reason: "token_upstream_rejected", upstream_status: 403 });
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

test("auth_config_exposes_only_public_client_id", async () => {
  const res = handleAuthConfig(new Request(`${ORIGIN}/api/auth-config`, { method: "GET" }), {
    AUTH_PROVIDER: "google",
    GOOGLE_CLIENT_ID,
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.deepEqual(JSON.parse(body), { provider: "google", clientId: GOOGLE_CLIENT_ID });
  assert.equal(body.includes(ALLOWED), false, "allowlisted email must not be exposed");
});

test("auth_config_hidden_when_not_google", () => {
  const res = handleAuthConfig(new Request(`${ORIGIN}/api/auth-config`, { method: "GET" }), {
    AUTH_PROVIDER: "access",
    GOOGLE_CLIENT_ID,
  });
  assert.equal(res.status, 404);
});

test("auth_config_rejects_non_get", () => {
  const res = handleAuthConfig(new Request(`${ORIGIN}/api/auth-config`, { method: "POST" }), {
    AUTH_PROVIDER: "google",
    GOOGLE_CLIENT_ID,
  });
  assert.equal(res.status, 405);
});

test("auth_config_404_body_names_missing_settings_without_values", async () => {
  const res = handleAuthConfig(new Request(`${ORIGIN}/api/auth-config`, { method: "GET" }), {
    AUTH_PROVIDER: "google",
    GOOGLE_CLIENT_ID: undefined,
  });
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.deepEqual(JSON.parse(body), { error: "not_configured", missing: ["GOOGLE_CLIENT_ID"], diagnostic: { authProviderPresent: true, authProviderIsGoogle: true, googleClientIdPresent: false } });
  assert.equal(body.includes(ALLOWED), false);
});

test("auth_config_404_lists_auth_provider_when_unset", async () => {
  const res = handleAuthConfig(new Request(`${ORIGIN}/api/auth-config`, { method: "GET" }), {
    GOOGLE_CLIENT_ID,
  });
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(await res.text()), { error: "not_configured", missing: ["AUTH_PROVIDER"], diagnostic: { authProviderPresent: false, authProviderIsGoogle: false, googleClientIdPresent: true } });
});
