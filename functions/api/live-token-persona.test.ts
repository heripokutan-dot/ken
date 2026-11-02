import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { handleLiveToken, type LiveTokenEnv } from "./live-token.ts";
import { clearJwksCache } from "../_shared/jwt-rs256.ts";
import { RATE_LIMIT_SCHEMA } from "../_shared/rate-limit.ts";
import { makeKey, signJwt, d1FromSqlite } from "../_shared/test-utils.ts";

// The token endpoint with a character (persona) in the request body. Google is never called: a fake fetch answers.

const ORIGIN = "https://ken.example.pages.dev";
const URL_ = `${ORIGIN}/api/live-token`;
const SECRET = "AIzaSy-TOP-SECRET-KEY";
const ALLOWED = "owner@example.com";
const CLIENT_ID = "123456-abc.apps.googleusercontent.com";

// The issue body before voices existed, with the two clock-dependent values replaced by markers.
const STANDARD_TEMPLATE =
  '{"uses":1,"expireTime":"<T30>","newSessionExpireTime":"<T1>","bidiGenerateContentSetup":{"model":"models/gemini-3.8-live"}}';
const voicedTemplate = (voiceName: string) =>
  '{"uses":1,"expireTime":"<T30>","newSessionExpireTime":"<T1>","bidiGenerateContentSetup":{"model":"models/gemini-3.8-live",' +
  '"generationConfig":{"responseModalities":["AUDIO"],"speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":' +
  `{"voiceName":"${voiceName}"}}}}}}`;
const normalize = (body: string) =>
  body.replace(/"expireTime":"[^"]+"/, '"expireTime":"<T30>"').replace(/"newSessionExpireTime":"[^"]+"/, '"newSessionExpireTime":"<T1>"');

interface Options {
  body?: BodyInit | null;
  headers?: Record<string, string>;
  noAuth?: boolean;
  limitPreFill?: number;
  geminiStatus?: number;
  geminiBody?: unknown;
  secret?: string | undefined;
  allowlist?: string | undefined;
  rateLimitDb?: "sqlite" | "missing";
}

async function run(opts: Options = {}) {
  clearJwksCache(); // a new signing key per call; a test may call run() many times
  const google = await makeKey("g-kid");
  const googleCalls: Array<{ url: string; body: string }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      return new Response(JSON.stringify({ keys: [google.publicJwk] }), { status: 200 });
    }
    googleCalls.push({ url, body: String(init?.body) });
    return new Response(JSON.stringify(opts.geminiBody ?? { name: "auth_tokens/tok-1" }), { status: opts.geminiStatus ?? 200 });
  }) as unknown as typeof fetch;

  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJwt(google, {
    iss: "https://accounts.google.com", aud: CLIENT_ID, azp: CLIENT_ID, exp: now + 300, sub: "g-sub",
    email: ALLOWED, email_verified: true,
  });
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(RATE_LIMIT_SCHEMA);
  if (opts.limitPreFill) {
    sqlite
      .prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)")
      .run(ALLOWED, Math.floor(now / 60) * 60, opts.limitPreFill);
  }
  const env: LiveTokenEnv = {
    AUTH_PROVIDER: "google",
    GEMINI_API_KEY: "secret" in opts ? opts.secret : SECRET,
    ALLOWED_EMAIL: "allowlist" in opts ? opts.allowlist : ALLOWED,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    RATE_LIMIT_DB: opts.rateLimitDb === "missing" ? undefined : d1FromSqlite(sqlite),
  };
  const headers: Record<string, string> = { Origin: ORIGIN, "Content-Type": "application/json", ...(opts.headers ?? {}) };
  if (!opts.noAuth) headers.Authorization = `Bearer ${jwt}`;
  const request = new Request(URL_, { method: "POST", headers, body: "body" in opts ? opts.body : "{}" });
  const res = await handleLiveToken(request, env, fetcher);
  const text = await res.text();
  return { res, text, request, googleCalls };
}

const errorOf = (text: string) => (JSON.parse(text) as { error?: string }).error;

// ---- standard: the same as before ---------------------------------------------------------------------------------------

const STANDARD_BODIES: Array<[string, BodyInit | null | undefined]> = [
  ["no body at all", null],
  ["an empty body", ""],
  ["{}", "{}"],
  ["an object without persona", '{"other":1}'],
  ['{"persona":"standard"}', '{"persona":"standard"}'],
  ["whitespace around the object", ' {"persona":"standard"}\n'],
];

test("standard (or nothing chosen) sends Google exactly the body it always did", async () => {
  for (const [label, body] of STANDARD_BODIES) {
    const { res, googleCalls, text } = await run({ body });
    assert.equal(res.status, 200, label);
    assert.equal(googleCalls.length, 1, label);
    assert.equal(normalize(googleCalls[0].body), STANDARD_TEMPLATE, label);
    assert.deepEqual(Object.keys(JSON.parse(text)), ["token", "model", "websocket_url"], label);
  }
});

test("the success response is unchanged for every character: token, model, websocket_url", async () => {
  for (const persona of ["standard", "buddy", "teacher", "listener"]) {
    const { res, text } = await run({ body: JSON.stringify({ persona }) });
    assert.equal(res.status, 200, persona);
    assert.deepEqual(JSON.parse(text), {
      token: "auth_tokens/tok-1",
      model: "gemini-3.8-live",
      websocket_url:
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained",
    }, persona);
  }
});

// ---- the three characters with a voice ---------------------------------------------------------------------------------

const VOICES: Array<[string, string]> = [["buddy", "Puck"], ["teacher", "Charon"], ["listener", "Kore"]];

test("each character with a voice puts that voice, and only that, into the body sent to Google", async () => {
  for (const [persona, voice] of VOICES) {
    const { res, googleCalls } = await run({ body: JSON.stringify({ persona }) });
    assert.equal(res.status, 200, persona);
    assert.equal(googleCalls.length, 1, persona);
    assert.equal(googleCalls[0].url, "https://generativelanguage.googleapis.com/v1beta/auth_tokens");
    assert.equal(normalize(googleCalls[0].body), voicedTemplate(voice), persona);
    assert.doesNotMatch(googleCalls[0].body, /fieldMask|lockAdditionalFields/, persona);
    assert.equal(googleCalls[0].body.includes(SECRET), false);
  }
});

test("the voiced body is the standard body plus responseModalities and speechConfig, nothing else different", async () => {
  const standard = JSON.parse((await run({ body: "{}" })).googleCalls[0].body);
  for (const [persona] of VOICES) {
    const voiced = JSON.parse((await run({ body: JSON.stringify({ persona }) })).googleCalls[0].body);
    const { generationConfig, ...setupRest } = voiced.bidiGenerateContentSetup;
    assert.notEqual(generationConfig, undefined, `${persona}: a voice is in the body`);
    assert.deepEqual(setupRest, standard.bidiGenerateContentSetup, persona);
    assert.deepEqual(Object.keys(generationConfig), ["responseModalities", "speechConfig"], persona);
    assert.deepEqual(generationConfig.responseModalities, ["AUDIO"]);
    assert.equal(voiced.uses, standard.uses);
    assert.deepEqual(Object.keys(voiced), Object.keys(standard));
  }
});

// ---- bad choices: 400, and Google is not called ---------------------------------------------------------------------------

const BAD_PERSONAS: unknown[] = [
  "BUDDY", "Buddy", " buddy", "buddy ", "buddy\n", "", " ", "unknown", "__proto__", "constructor", "toString", "prototype",
  "Puck", "Kore", "相棒", "x".repeat(500),
  0, 1, -1, 1.5, true, false, null, ["buddy"], [], {}, { id: "buddy" }, { persona: "buddy" },
];

test("a persona that is not exactly one of the four ids is refused with 400 invalid_persona, and Google is not called", async () => {
  for (const persona of BAD_PERSONAS) {
    const { res, text, googleCalls } = await run({ body: JSON.stringify({ persona }) });
    assert.equal(res.status, 400, JSON.stringify(persona));
    assert.equal(errorOf(text), "invalid_persona", JSON.stringify(persona));
    assert.deepEqual(JSON.parse(text), { error: "invalid_persona" }, "nothing else in the answer");
    assert.equal(googleCalls.length, 0, JSON.stringify(persona));
  }
});

const BAD_BODIES: Array<[string, BodyInit]> = [
  ["not JSON", "not json"],
  ["cut off", '{"persona":'],
  ["whitespace only", "   "],
  ["an array", "[]"],
  ["an array holding the id", '["buddy"]'],
  ["null", "null"],
  ["a bare string", '"buddy"'],
  ["a number", "5"],
  ["a boolean", "true"],
  ["bytes that are not UTF-8", new Uint8Array([0xff, 0xfe, 0xfd])],
  ["two objects", "{}{}"],
];

test("a body that is not a JSON object is refused with 400 invalid_persona, and Google is not called", async () => {
  for (const [label, body] of BAD_BODIES) {
    const { res, text, googleCalls } = await run({ body });
    assert.equal(res.status, 400, label);
    assert.equal(errorOf(text), "invalid_persona", label);
    assert.equal(googleCalls.length, 0, label);
  }
});

test("a 400 never contains a secret, a token, or the text that was sent", async () => {
  for (const body of ['{"persona":"SENTINEL-TEXT"}', "SENTINEL-TEXT", '{"persona":["SENTINEL-TEXT"]}']) {
    const { res, text } = await run({ body });
    assert.equal(res.status, 400, body);
    assert.doesNotMatch(text, /SENTINEL-TEXT|AIza|auth_tokens/);
  }
});

// ---- extra fields are ignored ---------------------------------------------------------------------------------------------

test("a voice name, a model, or any other extra field in the body is not used", async () => {
  const body = JSON.stringify({
    persona: "buddy", voiceName: "Aoede", voice: "Aoede", model: "gemini-other", uses: 50,
    generationConfig: { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } } },
    bidiGenerateContentSetup: { model: "models/other" }, fieldMask: "x", lockAdditionalFields: ["y"],
  });
  const { res, googleCalls } = await run({ body });
  assert.equal(res.status, 200);
  assert.equal(normalize(googleCalls[0].body), voicedTemplate("Puck"));
});

test("extra fields without a persona give the standard body, and nothing in them is used", async () => {
  const { res, googleCalls } = await run({ body: '{"voiceName":"Aoede","model":"gemini-other","uses":50}' });
  assert.equal(res.status, 200);
  assert.equal(normalize(googleCalls[0].body), STANDARD_TEMPLATE);
});

test("a __proto__ key in the body is not read as a persona", async () => {
  const { res, googleCalls } = await run({ body: '{"__proto__":{"persona":"buddy"}}' });
  assert.equal(res.status, 200);
  assert.equal(normalize(googleCalls[0].body), STANDARD_TEMPLATE);
});

// ---- the order of checks: the body is read only after sign-in and the rate limit ---------------------------------------

test("without sign-in, a bad body gives 401, Google is not called, and the body is not read", async () => {
  for (const body of ["not json", '{"persona":"nope"}', "x".repeat(5000)]) {
    const { res, googleCalls, request } = await run({ noAuth: true, body });
    assert.equal(res.status, 401);
    assert.equal(googleCalls.length, 0);
    assert.equal(request.bodyUsed, false);
  }
});

test("with a sign-in that is not valid, a bad body still gives 401 and is not read", async () => {
  const { res, googleCalls, request } = await run({ noAuth: true, body: "not json", headers: { Authorization: "Bearer abc.def.ghi" } });
  assert.equal(res.status, 401);
  assert.equal(googleCalls.length, 0);
  assert.equal(request.bodyUsed, false);
});

test("when rate limited, a bad body gives 429, Google is not called, and the body is not read", async () => {
  for (const body of ["not json", '{"persona":"nope"}', "x".repeat(5000), '{"persona":"buddy"}']) {
    const { res, googleCalls, request } = await run({ limitPreFill: 10, body });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "60");
    assert.equal(googleCalls.length, 0);
    assert.equal(request.bodyUsed, false);
  }
});

test("when the rate-limit database is missing, it stops with 503 before the body is read", async () => {
  const { res, text, googleCalls, request } = await run({ rateLimitDb: "missing", body: "not json" });
  assert.equal(res.status, 503);
  assert.equal(errorOf(text), "rate_limit_unavailable");
  assert.equal(googleCalls.length, 0);
  assert.equal(request.bodyUsed, false);
});

test("when settings are missing, it stops with 503 before the body is read", async () => {
  const { res, text, googleCalls, request } = await run({ allowlist: undefined, body: "not json" });
  assert.equal(res.status, 503);
  assert.equal(errorOf(text), "service_misconfigured");
  assert.equal(googleCalls.length, 0);
  assert.equal(request.bodyUsed, false);
});

test("the same-origin checks still come first: wrong Origin and wrong Content-Type do not read the body", async () => {
  const wrongOrigin = await run({ headers: { Origin: "https://evil.example" }, body: "not json" });
  assert.equal(wrongOrigin.res.status, 403);
  assert.equal(wrongOrigin.request.bodyUsed, false);
  const wrongType = await run({ headers: { "Content-Type": "text/plain" }, body: "not json" });
  assert.equal(wrongType.res.status, 415);
  assert.equal(wrongType.request.bodyUsed, false);
  for (const r of [wrongOrigin, wrongType]) assert.equal(r.googleCalls.length, 0);
});

test("a valid choice with the Gemini key missing still gives 503 gemini_not_configured, and Google is not called", async () => {
  const { res, text, googleCalls } = await run({ secret: undefined, body: '{"persona":"buddy"}' });
  assert.equal(res.status, 503);
  assert.equal(errorOf(text), "gemini_not_configured");
  assert.equal(googleCalls.length, 0);
});

// ---- the size limit ------------------------------------------------------------------------------------------------------------

const padded = (size: number) => {
  const head = '{"persona":"buddy","pad":"';
  return head + "x".repeat(size - head.length - 2) + '"}';
};

test("a body of 1 KB is accepted; a body over 1 KB is refused with 413 payload_too_large and Google is not called", async () => {
  const ok = await run({ body: padded(1024) });
  assert.equal(ok.res.status, 200);
  assert.equal(normalize(ok.googleCalls[0].body), voicedTemplate("Puck"));

  const tooBig = await run({ body: padded(1025) });
  assert.equal(tooBig.res.status, 413);
  assert.equal(errorOf(tooBig.text), "payload_too_large");
  assert.equal(tooBig.googleCalls.length, 0);
});

test("a declared Content-Length over 1 KB is refused with 413 without reading the body", async () => {
  const { res, text, googleCalls, request } = await run({ body: '{"persona":"buddy"}', headers: { "Content-Length": "5000" } });
  assert.equal(res.status, 413);
  assert.equal(errorOf(text), "payload_too_large");
  assert.equal(googleCalls.length, 0);
  assert.equal(request.bodyUsed, false);
});

// ---- Google says no -------------------------------------------------------------------------------------------------------------

test("when Google refuses a request with a voice, the 502 shows the same safe fields as before and no secret", async () => {
  const geminiBody = {
    error: {
      status: "INVALID_ARGUMENT",
      message: `Invalid value for ${SECRET}`,
      details: [{ reason: "API_KEY_INVALID", fieldViolations: [{ field: "bidi_generate_content_setup.generation_config", description: "Unknown field." }] }],
    },
  };
  const { res, text, googleCalls } = await run({ body: '{"persona":"teacher"}', geminiStatus: 400, geminiBody });
  assert.equal(res.status, 502);
  assert.equal(googleCalls.length, 1);
  assert.deepEqual(JSON.parse(text), {
    error: "token_issue_failed",
    reason: "token_upstream_rejected",
    upstream_status: 400,
    upstream_code: "INVALID_ARGUMENT",
    upstream_reason: "API_KEY_INVALID",
    upstream_field: "bidi_generate_content_setup.generation_config",
    upstream_detail: "Unknown field.",
  });
  assert.equal(text.includes(SECRET), false);
});

test("a refusal for the standard request has the same 502 shape", async () => {
  const geminiBody = { error: { status: "INVALID_ARGUMENT", message: "Bad request." } };
  const { res, text } = await run({ body: "{}", geminiStatus: 400, geminiBody });
  assert.equal(res.status, 502);
  assert.deepEqual(JSON.parse(text), {
    error: "token_issue_failed", reason: "token_upstream_rejected", upstream_status: 400,
    upstream_code: "INVALID_ARGUMENT", upstream_detail: "Bad request.",
  });
});

test("each request calls Google at most once, whatever the body", async () => {
  for (const body of ["{}", '{"persona":"buddy"}', '{"persona":"nope"}', "not json"]) {
    const { googleCalls } = await run({ body });
    assert.ok(googleCalls.length <= 1, body);
  }
});
