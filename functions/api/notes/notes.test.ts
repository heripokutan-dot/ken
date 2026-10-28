import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleNotes, type NotesEnv, MAX_NOTES, MAX_REQUEST_BYTES } from "./index.ts";
import type { NotesD1Like } from "./d1.ts";
import { BODY_MAX_CHARS, TRUNCATION_MARK } from "./text.ts";
import { clearJwksCache } from "../../_shared/jwt-rs256.ts";
import { RATE_LIMIT_SCHEMA } from "../../_shared/rate-limit.ts";
import { makeKey, signJwt, validClaims } from "../../_shared/test-utils.ts";

const ORIGIN = "https://ken.example.pages.dev";
const ALLOWED = "owner@example.com";
const GOOGLE_CLIENT_ID = "123456-abc.apps.googleusercontent.com";
const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-tag-123";
const SOME_ID = "11111111-1111-4111-8111-111111111111";
const NOTES_SQL = readFileSync(new URL("../../../migrations/0002_notes.sql", import.meta.url), "utf8");

beforeEach(() => clearJwksCache());

// Test-only D1 adapter over node:sqlite that also supports all() (the shared test adapter has no all()).
function d1WithAll(db: DatabaseSync): NotesD1Like {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              return ((stmt.get(...(args as never[])) as T | undefined) ?? null) as T | null;
            },
            async run() {
              stmt.run(...(args as never[]));
              return {};
            },
            async all<T>() {
              return { results: stmt.all(...(args as never[])) as T[] };
            },
          };
        },
      };
    },
  };
}

interface Opts {
  provider?: string;
  email?: string;
  googleClaims?: Record<string, unknown>;
  allowlist?: string | undefined;
  clientId?: string | undefined;
  teamDomain?: string | undefined;
  rateLimitDb?: "sqlite" | "missing" | "broken";
  accessJwt?: boolean;
}

interface CallInit {
  body?: string | Uint8Array | ReadableStream<Uint8Array>;
  headers?: Record<string, string>;
  origin?: string | null; // null = send no Origin header
  contentType?: string | null; // null = send no Content-Type header
  auth?: boolean;
}

async function makeContext(opts: Opts = {}) {
  // Every context signs with fresh keys that share a key id, so the cached signing keys must be dropped each time.
  // Without this, a second context in one test fails sign-in for the wrong reason (stale key) and a test that
  // expects 401 would pass without checking anything.
  clearJwksCache();
  const google = await makeKey("g-kid");
  const access = await makeKey("a-kid");
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      return new Response(JSON.stringify({ keys: [google.publicJwk] }), { status: 200 });
    }
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: [access.publicJwk] }), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;

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
  sqlite.exec(NOTES_SQL);
  const db = d1WithAll(sqlite);
  const rateLimitDb =
    opts.rateLimitDb === "missing"
      ? undefined
      : opts.rateLimitDb === "broken"
        ? ({ prepare: () => { throw new Error("x"); } } as never)
        : db;

  const env: NotesEnv = {
    AUTH_PROVIDER: opts.provider ?? "google",
    ALLOWED_EMAIL: "allowlist" in opts ? opts.allowlist : ALLOWED,
    GOOGLE_CLIENT_ID: "clientId" in opts ? opts.clientId : GOOGLE_CLIENT_ID,
    ACCESS_TEAM_DOMAIN: "teamDomain" in opts ? opts.teamDomain : TEAM,
    ACCESS_AUDIENCE: AUD,
    RATE_LIMIT_DB: rateLimitDb,
  };

  async function call(method: string, path: string, init: CallInit = {}) {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN;
    if (method === "POST" && init.contentType !== null) headers["Content-Type"] = init.contentType ?? "application/json";
    if (init.auth !== false) {
      if (opts.provider === "access" || opts.accessJwt) headers["Cf-Access-Jwt-Assertion"] = accessToken;
      else headers.Authorization = `Bearer ${googleToken}`;
    }
    const requestInit: Record<string, unknown> = { method, headers, body: init.body };
    if (init.body instanceof ReadableStream) requestInit.duplex = "half"; // a streamed upload needs this in Node
    const request = new Request(`${ORIGIN}${path}`, requestInit as RequestInit);
    const res = await handleNotes(request, env, fetcher);
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { res, text, json, request };
  }

  const save = (payload: unknown, init: CallInit = {}) =>
    call("POST", "/api/notes", { body: JSON.stringify(payload), ...init });

  const rows = <T = Record<string, unknown>>(sql: string, ...args: unknown[]) =>
    sqlite.prepare(sql).all(...(args as never[])).map((r) => ({ ...r })) as T[];
  const noteCount = () => (rows<{ n: number }>("SELECT COUNT(*) AS n FROM notes")[0]).n;

  function seed(count: number, startAt = 1_700_000_000_000) {
    const insert = sqlite.prepare("INSERT INTO notes (id, created_at, body) VALUES (?, ?, ?)");
    for (let i = 0; i < count; i++) insert.run(`seed-${i}`, startAt + i, `body ${i}`);
  }

  function prefill(key: string, count: number) {
    const bucket = Math.floor(Date.now() / 1000 / 60) * 60;
    sqlite.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)").run(key, bucket, count);
  }

  return { call, save, env, rows, noteCount, seed, prefill, sqlite };
}

const OPERATIONS: Array<{ name: string; method: string; path: string; body?: string }> = [
  { name: "list", method: "GET", path: "/api/notes" },
  { name: "get", method: "GET", path: `/api/notes/${SOME_ID}` },
  { name: "save", method: "POST", path: "/api/notes", body: JSON.stringify({ body: "hello" }) },
  { name: "delete", method: "DELETE", path: `/api/notes/${SOME_ID}` },
  { name: "delete_all", method: "DELETE", path: "/api/notes?confirm=delete-all" },
];

// Runs every operation against a context and checks the same status, and that no seeded note changed.
async function everyOperationIs(opts: Opts, expected: number, init: CallInit = {}, errorName?: string) {
  for (const op of OPERATIONS) {
    const ctx = await makeContext(opts);
    ctx.seed(1);
    const { res, text, json } = await ctx.call(op.method, op.path, { ...init, body: op.body });
    assert.equal(res.status, expected, `${op.name} should be ${expected}`);
    if (errorName) assert.equal(json?.error, errorName, `${op.name} should fail with ${errorName}`);
    assert.deepEqual(ctx.rows("SELECT id FROM notes"), [{ id: "seed-0" }], `${op.name} must not change notes`);
    assert.equal(text.includes("hello"), false);
  }
}

// ---------- sign-in (the same cases live-token.test.ts covers) ----------

test("returns_401_without_sign_in_for_every_operation", async () => {
  await everyOperationIs({}, 401, { auth: false }, "unauthenticated");
});

test("returns_401_for_a_malformed_authorization_header", async () => {
  await everyOperationIs({}, 401, { auth: false, headers: { Authorization: "Basic abc" } });
  await everyOperationIs({}, 401, { auth: false, headers: { Authorization: "Bearer not a token" } });
});

test("returns_401_for_invalid_google_token_for_every_operation", async () => {
  await everyOperationIs({ googleClaims: { iss: "https://evil.example" } }, 401);
});

test("returns_401_for_a_non_allowlisted_google_account_for_every_operation", async () => {
  await everyOperationIs({ email: "stranger@example.com" }, 401);
});

test("returns_401_for_an_unverified_google_email_for_every_operation", async () => {
  await everyOperationIs({ googleClaims: { email_verified: false } }, 401);
});

test("returns_401_for_an_expired_google_token", async () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  await everyOperationIs({ googleClaims: { exp: past } }, 401);
});

test("access_path_still_works_when_selected", async () => {
  const ctx = await makeContext({ provider: "access" });
  const { res } = await ctx.call("GET", "/api/notes");
  assert.equal(res.status, 200);
});

test("access_path_returns_401_for_non_allowlisted_email_unlike_live_token_which_returns_403", async () => {
  await everyOperationIs({ provider: "access", email: "stranger@example.com" }, 401, {}, "unauthenticated");
});

test("access_path_returns_401_without_the_access_header", async () => {
  await everyOperationIs({ provider: "access" }, 401, { auth: false });
});

test("returns_503_for_unknown_auth_provider_for_every_operation", async () => {
  await everyOperationIs({ provider: "none" }, 503, {}, "service_misconfigured");
});

test("returns_503_when_google_client_id_is_missing_fails_closed", async () => {
  await everyOperationIs({ clientId: undefined }, 503);
  const ctx = await makeContext({ clientId: undefined });
  const { json } = await ctx.call("GET", "/api/notes");
  assert.deepEqual(json, { error: "service_misconfigured", missing: ["GOOGLE_CLIENT_ID"] });
});

test("returns_503_when_allowlist_is_missing_fails_closed", async () => {
  await everyOperationIs({ allowlist: undefined }, 503, {}, "service_misconfigured");
});

test("returns_503_when_access_settings_are_missing", async () => {
  await everyOperationIs({ provider: "access", teamDomain: undefined }, 503);
});

test("the_notes_api_does_not_need_the_gemini_key", async () => {
  const ctx = await makeContext();
  assert.equal("GEMINI_API_KEY" in ctx.env, false);
  const { res } = await ctx.call("GET", "/api/notes");
  assert.equal(res.status, 200);
});

test("rejects_a_foreign_origin_for_reads_and_writes", async () => {
  for (const op of OPERATIONS) {
    const ctx = await makeContext();
    ctx.seed(1);
    const { res } = await ctx.call(op.method, op.path, { origin: "https://evil.example", body: op.body });
    assert.equal(res.status, 403, op.name);
    assert.equal(ctx.noteCount(), 1, op.name);
  }
});

test("writes_without_an_origin_header_are_rejected_but_a_plain_same_origin_get_is_allowed", async () => {
  const ctx = await makeContext();
  assert.equal((await ctx.call("GET", "/api/notes", { origin: null })).res.status, 200);
  assert.equal((await ctx.save({ body: "x" }, { origin: null })).res.status, 403);
  assert.equal((await ctx.call("DELETE", `/api/notes/${SOME_ID}`, { origin: null })).res.status, 403);
  assert.equal(ctx.noteCount(), 0);
});

test("rejects_a_non_json_content_type_on_save", async () => {
  const ctx = await makeContext();
  const { res } = await ctx.call("POST", "/api/notes", { body: "body=x", contentType: "text/plain" });
  assert.equal(res.status, 415);
  assert.equal((await ctx.call("POST", "/api/notes", { body: "{}", contentType: null })).res.status, 415);
  assert.equal(ctx.noteCount(), 0);
});

test("returns_405_with_an_allow_header_for_other_methods", async () => {
  const ctx = await makeContext();
  for (const method of ["PUT", "PATCH", "OPTIONS"]) {
    const { res } = await ctx.call(method, "/api/notes");
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("Allow"), "GET, POST, DELETE");
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  }
  const post = await ctx.call("POST", `/api/notes/${SOME_ID}`, { body: "{}" });
  assert.equal(post.res.status, 405);
  assert.equal(post.res.headers.get("Allow"), "GET, DELETE");
  assert.equal((await ctx.call("PUT", `/api/notes/${SOME_ID}`)).res.status, 405);
});

test("unknown_paths_under_notes_are_404", async () => {
  const ctx = await makeContext();
  assert.equal((await ctx.call("GET", `/api/notes/${SOME_ID}/extra`)).res.status, 404);
  assert.equal((await ctx.call("GET", "/api/notesx")).res.status, 404);
});

// ---------- rate limit ----------

test("returns_429_for_writes_when_the_write_window_is_full", async () => {
  for (const op of OPERATIONS.filter((o) => o.method !== "GET")) {
    const ctx = await makeContext();
    ctx.seed(1);
    ctx.prefill(`notes:write:${ALLOWED}`, 10);
    const { res } = await ctx.call(op.method, op.path, { body: op.body });
    assert.equal(res.status, 429, op.name);
    assert.equal(res.headers.get("Retry-After"), "60");
    assert.equal(ctx.noteCount(), 1, op.name);
  }
});

test("returns_429_for_reads_when_the_read_window_is_full", async () => {
  for (const op of OPERATIONS.filter((o) => o.method === "GET")) {
    const ctx = await makeContext();
    ctx.prefill(`notes:read:${ALLOWED}`, 30);
    const { res } = await ctx.call(op.method, op.path);
    assert.equal(res.status, 429, op.name);
  }
});

test("the_write_limit_is_10_and_the_read_limit_is_30_per_window", async () => {
  const ctx = await makeContext();
  ctx.prefill(`notes:write:${ALLOWED}`, 9);
  assert.equal((await ctx.save({ body: "tenth" })).res.status, 201);
  assert.equal((await ctx.save({ body: "eleventh" })).res.status, 429);
  ctx.prefill(`notes:read:${ALLOWED}`, 29);
  assert.equal((await ctx.call("GET", "/api/notes")).res.status, 200);
  assert.equal((await ctx.call("GET", "/api/notes")).res.status, 429);
});

test("reads_never_use_the_write_quota_and_writes_never_use_the_read_quota", async () => {
  const ctx = await makeContext();
  ctx.prefill(`notes:write:${ALLOWED}`, 10); // writes are exhausted
  for (let i = 0; i < 5; i++) assert.equal((await ctx.call("GET", "/api/notes")).res.status, 200);
  assert.deepEqual(ctx.rows("SELECT key, count FROM rate_limits WHERE key LIKE 'notes:read:%'"), [
    { key: `notes:read:${ALLOWED}`, count: 5 },
  ]);
  const other = await makeContext();
  other.prefill(`notes:read:${ALLOWED}`, 30); // reads are exhausted
  assert.equal((await other.save({ body: "still works" })).res.status, 201);
  assert.deepEqual(other.rows("SELECT key, count FROM rate_limits WHERE key LIKE 'notes:write:%'"), [
    { key: `notes:write:${ALLOWED}`, count: 1 },
  ]);
});

test("notes_counts_do_not_touch_live_tokens_key_and_live_tokens_count_does_not_block_notes", async () => {
  const ctx = await makeContext();
  ctx.prefill(ALLOWED, 10); // live-token's own key is exhausted
  assert.equal((await ctx.call("GET", "/api/notes")).res.status, 200);
  assert.equal((await ctx.save({ body: "x" })).res.status, 201);
  assert.deepEqual(ctx.rows("SELECT key, count FROM rate_limits WHERE key = ?", ALLOWED), [{ key: ALLOWED, count: 10 }]);
  assert.deepEqual(
    ctx.rows<{ key: string }>("SELECT key FROM rate_limits WHERE key NOT LIKE 'notes:%' AND key <> ?", ALLOWED),
    [],
  );
});

test("sign_in_failures_do_not_use_up_the_rate_limit", async () => {
  const ctx = await makeContext();
  await ctx.call("GET", "/api/notes", { auth: false });
  await ctx.call("POST", "/api/notes", { auth: false, body: JSON.stringify({ body: "x" }) });
  assert.deepEqual(ctx.rows("SELECT * FROM rate_limits"), []);
});

test("fails_closed_when_the_rate_limit_database_is_missing", async () => {
  await everyOperationIs({ rateLimitDb: "missing" }, 503, {}, "rate_limit_unavailable");
});

test("fails_closed_when_the_rate_limit_database_errors", async () => {
  await everyOperationIs({ rateLimitDb: "broken" }, 503, {}, "rate_limit_unavailable");
});

// ---------- save ----------

test("saves_a_note_and_lists_and_reads_it_back", async () => {
  const ctx = await makeContext();
  const before = Date.now();
  const saved = await ctx.save({ body: "こんにちは\nsecond line", title: "挨拶", persona: "相棒" });
  const after = Date.now();
  assert.equal(saved.res.status, 201);
  assert.equal(saved.json.saved, true);
  const { id, created_at } = saved.json.note;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(created_at >= before && created_at <= after, "created_at is the server time in milliseconds");
  assert.deepEqual(saved.json.note, { id, created_at, persona: "相棒", title: "挨拶", truncated: false });
  assert.equal(saved.text.includes("こんにちは"), false, "the save response does not echo the body");

  const one = await ctx.call("GET", `/api/notes/${id}`);
  assert.equal(one.res.status, 200);
  assert.deepEqual(one.json, {
    note: { id, created_at, persona: "相棒", title: "挨拶", truncated: false, body: "こんにちは\nsecond line" },
  });

  const list = await ctx.call("GET", "/api/notes");
  assert.equal(list.res.status, 200);
  assert.deepEqual(list.json, { notes: [{ id, created_at, persona: "相棒", title: "挨拶", truncated: false }], limit: 200 });
  assert.equal(list.text.includes("こんにちは"), false, "the list never carries body text");
});

test("title_and_persona_can_be_omitted", async () => {
  const ctx = await makeContext();
  const saved = await ctx.save({ body: "only a body" });
  assert.equal(saved.res.status, 201);
  assert.equal(saved.json.note.title, "");
  assert.equal(saved.json.note.persona, "");
  const nulls = await ctx.save({ body: "nulls", title: null, persona: null });
  assert.equal(nulls.res.status, 201);
});

test("title_is_cut_to_30_characters_and_persona_to_32", async () => {
  const ctx = await makeContext();
  const saved = await ctx.save({ body: "x", title: "あ".repeat(40), persona: "p".repeat(50) });
  assert.equal(saved.res.status, 201);
  assert.equal([...saved.json.note.title].length, 30);
  assert.equal([...saved.json.note.persona].length, 32);
  const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
  const edge = await ctx.save({ body: "x", title: `${"a".repeat(29)}${family}` });
  assert.equal(edge.json.note.title, "a".repeat(29), "an emoji sequence is not cut in half");
});

test("a_body_of_only_whitespace_saves_nothing_and_says_so", async () => {
  const ctx = await makeContext();
  for (const body of ["", "   ", "\n\t \r\n", "　  "]) {
    const { res, json } = await ctx.save({ body, title: "t" });
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(json, { saved: false, reason: "empty_body" });
  }
  assert.equal(ctx.noteCount(), 0);
});

test("a_body_with_surrounding_whitespace_is_saved_as_given", async () => {
  const ctx = await makeContext();
  const saved = await ctx.save({ body: "  keep me \n" });
  const one = await ctx.call("GET", `/api/notes/${saved.json.note.id}`);
  assert.equal(one.json.note.body, "  keep me \n");
});

test("a_body_of_exactly_8000_characters_is_saved_whole", async () => {
  const ctx = await makeContext();
  const saved = await ctx.save({ body: "a".repeat(BODY_MAX_CHARS) });
  assert.equal(saved.json.note.truncated, false);
  const one = await ctx.call("GET", `/api/notes/${saved.json.note.id}`);
  assert.equal(one.json.note.body, "a".repeat(BODY_MAX_CHARS));
});

test("a_body_over_8000_characters_is_cut_marked_and_flagged", async () => {
  const ctx = await makeContext();
  const saved = await ctx.save({ body: "a".repeat(BODY_MAX_CHARS + 1) });
  assert.equal(saved.res.status, 201);
  assert.equal(saved.json.note.truncated, true);
  const one = await ctx.call("GET", `/api/notes/${saved.json.note.id}`);
  assert.equal(one.json.note.body, "a".repeat(BODY_MAX_CHARS) + TRUNCATION_MARK);
  assert.equal(one.json.note.truncated, true);
  const list = await ctx.call("GET", "/api/notes");
  assert.equal(list.json.notes[0].truncated, true);
});

test("the_8000_character_cut_never_splits_an_emoji", async () => {
  const ctx = await makeContext();
  const saved = await ctx.save({ body: "\u{1F600}".repeat(BODY_MAX_CHARS + 1) });
  const one = await ctx.call("GET", `/api/notes/${saved.json.note.id}`);
  const stored: string = one.json.note.body;
  assert.equal(stored, "\u{1F600}".repeat(BODY_MAX_CHARS) + TRUNCATION_MARK);
  assert.equal(stored.isWellFormed(), true);
});

test("the_8000_character_cut_never_splits_a_zwj_sequence_or_a_flag", async () => {
  const ctx = await makeContext();
  const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
  const first = await ctx.save({ body: `${"a".repeat(7998)}${family}tail` });
  const firstBody = (await ctx.call("GET", `/api/notes/${first.json.note.id}`)).json.note.body;
  assert.equal(firstBody, "a".repeat(7998) + TRUNCATION_MARK);
  const flag = "\u{1F1EF}\u{1F1F5}";
  const second = await ctx.save({ body: `${"a".repeat(7999)}${flag}x` });
  const secondBody = (await ctx.call("GET", `/api/notes/${second.json.note.id}`)).json.note.body;
  assert.equal(secondBody, "a".repeat(7999) + TRUNCATION_MARK);
});

// ---------- request size ----------

test("a_request_of_exactly_64_kb_is_accepted_and_one_byte_more_is_refused", async () => {
  const ctx = await makeContext();
  const overhead = new TextEncoder().encode(JSON.stringify({ body: "" })).length;
  const exact = JSON.stringify({ body: "a".repeat(MAX_REQUEST_BYTES - overhead) });
  assert.equal(new TextEncoder().encode(exact).length, 65536);
  assert.equal((await ctx.call("POST", "/api/notes", { body: exact })).res.status, 201);
  const over = JSON.stringify({ body: "a".repeat(MAX_REQUEST_BYTES - overhead + 1) });
  const refused = await ctx.call("POST", "/api/notes", { body: over });
  assert.equal(refused.res.status, 413);
  assert.deepEqual(refused.json, { error: "payload_too_large" });
  assert.equal(ctx.noteCount(), 1);
});

test("the_64_kb_limit_counts_bytes_not_characters", async () => {
  const ctx = await makeContext();
  // 22,000 characters is far under 64K characters but about 66,000 bytes in UTF-8.
  const { res } = await ctx.call("POST", "/api/notes", { body: JSON.stringify({ body: "あ".repeat(22000) }) });
  assert.equal(res.status, 413);
  assert.equal(ctx.noteCount(), 0);
});

test("a_declared_content_length_over_64_kb_is_refused_before_the_body_is_read", async () => {
  const ctx = await makeContext();
  const { res, request } = await ctx.call("POST", "/api/notes", {
    body: JSON.stringify({ body: "small" }),
    headers: { "Content-Length": String(MAX_REQUEST_BYTES + 1) },
  });
  assert.equal(res.status, 413);
  assert.equal(request.bodyUsed, false, "the body must not have been read");
  assert.equal(ctx.noteCount(), 0);
});

test("an_oversized_body_without_a_content_length_is_refused_after_reading_at_most_the_limit", async () => {
  const ctx = await makeContext();
  let pulled = 0;
  const chunk = new Uint8Array(16 * 1024).fill(97);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (pulled > 200) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const { res, request } = await ctx.call("POST", "/api/notes", { body: stream });
  assert.equal(request.headers.get("Content-Length"), null);
  assert.equal(res.status, 413);
  assert.ok(pulled <= 8, `pulled ${pulled} chunks of 16 KB; the 64 KB limit means about 5 are enough to refuse`);
  assert.equal(ctx.noteCount(), 0);
});

// ---------- bad input ----------

test("returns_400_for_invalid_json_without_echoing_it", async () => {
  const ctx = await makeContext();
  for (const raw of ["{not json", "", "{\"body\":", "\u0000"]) {
    const { res, json, text } = await ctx.call("POST", "/api/notes", { body: raw });
    assert.equal(res.status, 400, JSON.stringify(raw));
    assert.deepEqual(json, { error: "invalid_json" });
    assert.equal(text.includes("not json"), false);
  }
  const invalidUtf8 = await ctx.call("POST", "/api/notes", { body: new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]) });
  assert.equal(invalidUtf8.res.status, 400);
  assert.equal(ctx.noteCount(), 0);
});

test("returns_400_when_the_json_is_not_an_object", async () => {
  const ctx = await makeContext();
  for (const raw of ["[]", "\"text\"", "42", "null", "true"]) {
    const { res, json } = await ctx.call("POST", "/api/notes", { body: raw });
    assert.equal(res.status, 400, raw);
    assert.deepEqual(json, { error: "invalid_json" });
  }
});

test("returns_400_when_body_is_missing_or_not_a_string", async () => {
  const ctx = await makeContext();
  for (const payload of [{}, { body: 123 }, { body: null }, { body: ["x"] }, { body: { a: 1 } }]) {
    const { res, json } = await ctx.save(payload);
    assert.equal(res.status, 400, JSON.stringify(payload));
    assert.deepEqual(json, { error: "invalid_request", field: "body" });
  }
  assert.deepEqual((await ctx.save({ body: "x", title: 5 })).json, { error: "invalid_request", field: "title" });
  assert.deepEqual((await ctx.save({ body: "x", persona: {} })).json, { error: "invalid_request", field: "persona" });
  assert.equal(ctx.noteCount(), 0);
});

test("unknown_fields_are_ignored", async () => {
  const ctx = await makeContext();
  const saved = await ctx.save({ body: "x", id: "attacker-chosen", created_at: 1, truncated: 1 });
  assert.equal(saved.res.status, 201);
  assert.notEqual(saved.json.note.id, "attacker-chosen");
  assert.notEqual(saved.json.note.created_at, 1);
  assert.equal(saved.json.note.truncated, false);
});

// ---------- 200 note cap ----------

test("saving_stops_at_200_notes_and_nothing_old_is_removed", async () => {
  const ctx = await makeContext();
  ctx.seed(MAX_NOTES);
  const { res, json } = await ctx.save({ body: "one too many" });
  assert.equal(res.status, 409);
  assert.deepEqual(json, { error: "notes_limit_reached", limit: 200 });
  assert.equal(ctx.noteCount(), 200);
  assert.deepEqual(ctx.rows("SELECT id FROM notes WHERE id = 'seed-0'"), [{ id: "seed-0" }], "the oldest note is kept");
});

test("the_200th_note_is_saved_and_the_201st_is_not", async () => {
  const ctx = await makeContext();
  ctx.seed(MAX_NOTES - 1);
  assert.equal((await ctx.save({ body: "200th" })).res.status, 201);
  assert.equal((await ctx.save({ body: "201st" })).res.status, 409);
  assert.equal(ctx.noteCount(), 200);
});

test("two_saves_arriving_together_cannot_pass_the_limit", async () => {
  const ctx = await makeContext();
  ctx.seed(MAX_NOTES - 1);
  const results = await Promise.all([ctx.save({ body: "A" }), ctx.save({ body: "B" })]);
  assert.deepEqual(results.map((r) => r.res.status).sort(), [201, 409]);
  assert.equal(ctx.noteCount(), 200);
});

test("deleting_makes_room_again", async () => {
  const ctx = await makeContext();
  ctx.seed(MAX_NOTES);
  assert.equal((await ctx.call("DELETE", "/api/notes/seed-0")).res.status, 200);
  assert.equal((await ctx.save({ body: "fits now" })).res.status, 201);
});

// ---------- list / get / delete ----------

test("the_list_is_newest_first_has_no_body_and_ties_go_to_the_later_insert", async () => {
  const ctx = await makeContext();
  const insert = ctx.sqlite.prepare("INSERT INTO notes (id, created_at, title, body) VALUES (?, ?, ?, ?)");
  insert.run("old", 1000, "old", "SECRET-OLD");
  insert.run("new", 3000, "new", "SECRET-NEW");
  insert.run("mid-a", 2000, "mid-a", "SECRET-A");
  insert.run("mid-b", 2000, "mid-b", "SECRET-B");
  const { json, text } = await ctx.call("GET", "/api/notes");
  assert.deepEqual(json.notes.map((n: { id: string }) => n.id), ["new", "mid-b", "mid-a", "old"]);
  assert.equal(text.includes("SECRET"), false);
  for (const note of json.notes) assert.equal("body" in note, false);
});

test("an_empty_list_is_an_empty_array", async () => {
  const ctx = await makeContext();
  assert.deepEqual((await ctx.call("GET", "/api/notes")).json, { notes: [], limit: 200 });
  assert.equal((await ctx.call("GET", "/api/notes/")).res.status, 200);
});

test("getting_an_unknown_id_is_404", async () => {
  const ctx = await makeContext();
  const { res, json } = await ctx.call("GET", `/api/notes/${SOME_ID}`);
  assert.equal(res.status, 404);
  assert.deepEqual(json, { error: "not_found" });
});

test("deleting_one_note_removes_only_that_note", async () => {
  const ctx = await makeContext();
  const a = await ctx.save({ body: "A" });
  const b = await ctx.save({ body: "B" });
  const deleted = await ctx.call("DELETE", `/api/notes/${a.json.note.id}`);
  assert.equal(deleted.res.status, 200);
  assert.deepEqual(deleted.json, { deleted: true });
  assert.deepEqual(ctx.rows("SELECT id FROM notes"), [{ id: b.json.note.id }]);
  assert.equal((await ctx.call("GET", `/api/notes/${a.json.note.id}`)).res.status, 404);
});

test("deleting_an_unknown_id_is_404_and_changes_nothing", async () => {
  const ctx = await makeContext();
  ctx.seed(2);
  const { res, json } = await ctx.call("DELETE", `/api/notes/${SOME_ID}`);
  assert.equal(res.status, 404);
  assert.deepEqual(json, { error: "not_found" });
  assert.equal(ctx.noteCount(), 2);
});

test("an_id_with_sql_in_it_is_just_an_unknown_id", async () => {
  const ctx = await makeContext();
  ctx.seed(3);
  const hostile = encodeURIComponent("x' OR '1'='1");
  assert.equal((await ctx.call("GET", `/api/notes/${hostile}`)).res.status, 404);
  assert.equal((await ctx.call("DELETE", `/api/notes/${hostile}`)).res.status, 404);
  assert.equal((await ctx.call("GET", "/api/notes/%E0%A4%A")).res.status, 404, "a malformed escape is not a crash");
  assert.equal(ctx.noteCount(), 3);
});

// ---------- delete all ----------

test("delete_all_without_confirmation_deletes_nothing", async () => {
  const ctx = await makeContext();
  ctx.seed(5);
  for (const path of ["/api/notes", "/api/notes?confirm=", "/api/notes?confirm=yes", "/api/notes?confirm=DELETE-ALL", "/api/notes?all=1"]) {
    const { res, json } = await ctx.call("DELETE", path);
    assert.equal(res.status, 400, path);
    assert.deepEqual(json, { error: "confirmation_required" });
  }
  assert.equal(ctx.noteCount(), 5);
});

test("delete_all_with_confirmation_deletes_everything_and_reports_the_count", async () => {
  const ctx = await makeContext();
  ctx.seed(5);
  const { res, json } = await ctx.call("DELETE", "/api/notes?confirm=delete-all");
  assert.equal(res.status, 200);
  assert.deepEqual(json, { deleted: 5 });
  assert.equal(ctx.noteCount(), 0);
  assert.deepEqual((await ctx.call("DELETE", "/api/notes?confirm=delete-all")).json, { deleted: 0 });
});

test("delete_all_never_touches_the_rate_limit_table", async () => {
  const ctx = await makeContext();
  ctx.seed(2);
  await ctx.call("DELETE", "/api/notes?confirm=delete-all");
  assert.deepEqual(ctx.rows("SELECT key FROM rate_limits"), [{ key: `notes:write:${ALLOWED}` }]);
});

// ---------- stored as text ----------

test("html_looking_text_is_stored_and_returned_exactly_as_text", async () => {
  const ctx = await makeContext();
  const body = `<script>alert("x")</script> <img src=x onerror=alert(1)> &amp; &lt;b&gt; {{7*7}} \${1+1}`;
  const title = "<b>title</b>";
  const saved = await ctx.save({ body, title });
  assert.equal(saved.json.note.title, title);
  const one = await ctx.call("GET", `/api/notes/${saved.json.note.id}`);
  assert.equal(one.json.note.body, body);
  assert.match(one.res.headers.get("Content-Type") ?? "", /^application\/json/);
  assert.equal(one.res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(ctx.rows<{ body: string }>("SELECT body FROM notes")[0].body, body);
});

test("sql_looking_text_is_stored_as_text_and_the_table_survives", async () => {
  const ctx = await makeContext();
  const body = `'); DROP TABLE notes; --`;
  const saved = await ctx.save({ body, title: `' OR 1=1 --`, persona: `"; DELETE FROM notes; --` });
  assert.equal(saved.res.status, 201);
  assert.equal((await ctx.call("GET", `/api/notes/${saved.json.note.id}`)).json.note.body, body);
  assert.equal(ctx.noteCount(), 1);
});

// ---------- headers and privacy ----------

test("every_response_is_no_store_and_has_no_cors_headers", async () => {
  const ctx = await makeContext();
  const saved = await ctx.save({ body: "x" });
  const id = saved.json.note.id;
  const responses = [
    saved.res,
    (await ctx.save({ body: " " })).res,
    (await ctx.call("GET", "/api/notes")).res,
    (await ctx.call("GET", `/api/notes/${id}`)).res,
    (await ctx.call("GET", `/api/notes/${SOME_ID}`)).res,
    (await ctx.call("DELETE", "/api/notes")).res,
    (await ctx.call("PUT", "/api/notes")).res,
    (await ctx.call("GET", "/api/notes", { auth: false })).res,
    (await ctx.call("GET", "/api/notes", { origin: "https://evil.example" })).res,
    (await ctx.call("POST", "/api/notes", { body: "{" })).res,
    (await ctx.call("DELETE", `/api/notes/${id}`)).res,
  ];
  assert.ok(responses.length >= 10);
  for (const res of responses) {
    assert.equal(res.headers.get("Cache-Control"), "no-store", String(res.status));
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(res.headers.get("Access-Control-Allow-Credentials"), null);
  }
});

test("failure_responses_never_contain_the_note_the_email_or_the_token", async () => {
  const secretBody = "PRIVATE-NOTE-TEXT-12345";
  const ctx = await makeContext({ rateLimitDb: "broken" });
  const { text, request } = await ctx.save({ body: secretBody, title: "PRIVATE-TITLE" });
  const token = (request.headers.get("Authorization") ?? "").replace("Bearer ", "");
  assert.equal(text.includes(secretBody), false);
  assert.equal(text.includes("PRIVATE-TITLE"), false);
  assert.equal(text.includes(ALLOWED), false);
  assert.equal(text.includes(token), false);
  const other = await makeContext({ email: "stranger@example.com" });
  const denied = await other.save({ body: secretBody });
  assert.equal(denied.text.includes("stranger@example.com"), false);
  assert.equal(denied.text.includes(secretBody), false);
});

test("a_storage_failure_after_sign_in_is_503_and_nothing_is_logged", async () => {
  const logged: unknown[][] = [];
  const names = ["log", "info", "warn", "error", "debug"] as const;
  const originals = names.map((n) => console[n]);
  for (const n of names) console[n] = (...args: unknown[]) => void logged.push(args);
  try {
    const ctx = await makeContext();
    ctx.sqlite.exec("DROP TABLE notes"); // sign-in and rate limit still work, the notes table is gone
    const results = await Promise.all(
      OPERATIONS.map((op) => ctx.call(op.method, op.path, { body: op.body })),
    );
    assert.deepEqual(results.map((r) => r.res.status), [503, 503, 503, 503, 503]);
    for (const r of results) assert.deepEqual(r.json, { error: "notes_unavailable" });
    // A normal successful call as well.
    const fine = await makeContext();
    await fine.save({ body: "PRIVATE" });
    await fine.call("GET", "/api/notes");
  } finally {
    names.forEach((n, i) => (console[n] = originals[i] as never));
  }
  assert.deepEqual(logged, []);
});

test("the_source_has_no_logging_and_builds_no_sql_from_text", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /console\./);
  // Every prepare() call receives a fixed template string (no ${...} interpolation inside the SQL).
  for (const match of source.matchAll(/\.prepare\(\s*`([^`]*)`/g)) {
    assert.doesNotMatch(match[1], /\$\{/, "SQL must not be built by string interpolation");
  }
  assert.doesNotMatch(source, /wrangler/i);
});
