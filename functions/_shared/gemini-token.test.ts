import { test } from "node:test";
import assert from "node:assert/strict";
import { createGeminiEphemeralToken, GeminiTokenError, MODEL_ID, WEBSOCKET_URL } from "./gemini-token.ts";

const KEY = "AIzaSy-SECRET-KEY-VALUE";
const NOW = new Date("2026-10-27T00:00:00Z");

function recordingFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

const okToken = () => new Response(JSON.stringify({ name: "auth_tokens/abc123" }), { status: 200 });

test("sends_api_key_only_to_google_endpoint", async () => {
  const f = recordingFetch(okToken);
  await createGeminiEphemeralToken({ apiKey: KEY, fetcher: f.fetch, now: NOW });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/auth_tokens");
  const headers = f.calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-goog-api-key"], KEY);
  assert.equal(JSON.stringify(f.calls[0].init.body).includes(KEY), false, "key must not be in the body");
});

test("locks_model_and_single_use", async () => {
  const f = recordingFetch(okToken);
  await createGeminiEphemeralToken({ apiKey: KEY, fetcher: f.fetch, now: NOW });
  const body = JSON.parse(String(f.calls[0].init.body));
  assert.equal(body.uses, 1);
  assert.equal(body.liveConnectConstraints.model, `models/${MODEL_ID}`);
  assert.equal(MODEL_ID, "gemini-3.8-live");
});

test("sets_short_session_start_window", async () => {
  const f = recordingFetch(okToken);
  await createGeminiEphemeralToken({ apiKey: KEY, fetcher: f.fetch, now: NOW });
  const body = JSON.parse(String(f.calls[0].init.body));
  assert.equal(body.newSessionExpireTime, "2026-10-27T00:01:00.000Z");
  assert.equal(body.expireTime, "2026-10-27T00:30:00.000Z");
  assert.deepEqual(body.liveConnectConstraints.config.responseModalities, ["AUDIO"]);
});

test("returns_expected_token_shape", async () => {
  const f = recordingFetch(okToken);
  const result = await createGeminiEphemeralToken({ apiKey: KEY, fetcher: f.fetch, now: NOW });
  assert.deepEqual(result, { token: "auth_tokens/abc123", model: MODEL_ID, websocketUrl: WEBSOCKET_URL });
});

test("rejects_missing_api_key", async () => {
  const f = recordingFetch(okToken);
  await assert.rejects(
    createGeminiEphemeralToken({ apiKey: "", fetcher: f.fetch, now: NOW }),
    (e: unknown) => e instanceof GeminiTokenError && e.status === 503,
  );
  assert.equal(f.calls.length, 0, "must not call Google without a key");
});

test("rejects_missing_token_in_provider_response", async () => {
  const f = recordingFetch(() => new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
  await assert.rejects(
    createGeminiEphemeralToken({ apiKey: KEY, fetcher: f.fetch, now: NOW }),
    (e: unknown) => e instanceof GeminiTokenError && e.status === 502,
  );
});

test("sanitizes_provider_errors", async () => {
  const leaky = `Invalid key ${KEY} for project 1234; raw body echoed`;
  const f = recordingFetch(() => new Response(JSON.stringify({ error: { message: leaky } }), { status: 403 }));
  await assert.rejects(
    createGeminiEphemeralToken({ apiKey: KEY, fetcher: f.fetch, now: NOW }),
    (e: unknown) => {
      assert.ok(e instanceof GeminiTokenError);
      assert.equal(e.status, 502);
      assert.equal(e.message.includes(KEY), false);
      assert.equal(e.message.includes("project 1234"), false);
      return true;
    },
  );
});

test("sanitizes_network_failures", async () => {
  const f = {
    fetch: (async () => {
      throw new Error(`socket to host failed using ${KEY}`);
    }) as unknown as typeof fetch,
  };
  await assert.rejects(
    createGeminiEphemeralToken({ apiKey: KEY, fetcher: f.fetch, now: NOW }),
    (e: unknown) => {
      assert.ok(e instanceof GeminiTokenError);
      assert.equal(e.message.includes(KEY), false);
      return true;
    },
  );
});
