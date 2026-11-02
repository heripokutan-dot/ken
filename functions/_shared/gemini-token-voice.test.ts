import { test } from "node:test";
import assert from "node:assert/strict";
import { createGeminiEphemeralToken, GeminiTokenError } from "./gemini-token.ts";

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

// What the issue request body was before voices existed. This string was captured from the code at 5c75dfc
// (clock fixed at NOW) and is written out here character for character.
const STANDARD_BODY =
  '{"uses":1,"expireTime":"2026-10-27T00:30:00Z","newSessionExpireTime":"2026-10-27T00:01:00Z",' +
  '"bidiGenerateContentSetup":{"model":"models/gemini-3.8-live"}}';

// The same request with a voice: only bidiGenerateContentSetup differs.
const voicedBody = (voiceName: string) =>
  '{"uses":1,"expireTime":"2026-10-27T00:30:00Z","newSessionExpireTime":"2026-10-27T00:01:00Z",' +
  '"bidiGenerateContentSetup":{"model":"models/gemini-3.8-live","generationConfig":{"responseModalities":["AUDIO"],' +
  `"speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"${voiceName}"}}}}}}`;

async function sentBody(voiceName?: string | null, explicit = true): Promise<string> {
  const f = recordingFetch(okToken);
  const input = explicit
    ? { apiKey: KEY, fetcher: f.fetch, now: NOW, voiceName }
    : { apiKey: KEY, fetcher: f.fetch, now: NOW };
  await createGeminiEphemeralToken(input);
  assert.equal(f.calls.length, 1);
  return String(f.calls[0].init.body);
}

// ---- standard: nothing changes ----------------------------------------------------------------------------------------

test("without a voice, the body sent to Google is the same, character for character", async () => {
  assert.equal(await sentBody(undefined, false), STANDARD_BODY);
});

test("a voice of null or undefined gives that same body", async () => {
  assert.equal(await sentBody(null), STANDARD_BODY);
  assert.equal(await sentBody(undefined), STANDARD_BODY);
});

// ---- with a voice -------------------------------------------------------------------------------------------------------

test("with a voice, the body is exactly the standard body plus generationConfig inside bidiGenerateContentSetup", async () => {
  for (const name of ["Puck", "Charon", "Kore"]) assert.equal(await sentBody(name), voicedBody(name), name);
});

test("with a voice, only bidiGenerateContentSetup differs from the standard body", async () => {
  const standard = JSON.parse(await sentBody(null));
  const voiced = JSON.parse(await sentBody("Puck"));
  assert.deepEqual(Object.keys(voiced), Object.keys(standard));
  for (const key of ["uses", "expireTime", "newSessionExpireTime"]) assert.deepEqual(voiced[key], standard[key], key);
  assert.deepEqual(Object.keys(voiced.bidiGenerateContentSetup), ["model", "generationConfig"]);
  assert.equal(voiced.bidiGenerateContentSetup.model, standard.bidiGenerateContentSetup.model);
  assert.deepEqual(voiced.bidiGenerateContentSetup.generationConfig, {
    responseModalities: ["AUDIO"],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
  });
});

test("nothing without a known basis is added: no fieldMask, no lockAdditionalFields", async () => {
  for (const name of [null, "Puck", "Charon", "Kore"]) {
    const text = await sentBody(name);
    assert.doesNotMatch(text, /fieldMask|lockAdditionalFields|liveConnectConstraints/, String(name));
  }
});

test("the API key never goes into the body, with or without a voice", async () => {
  for (const name of [null, "Puck"]) assert.equal((await sentBody(name)).includes(KEY), false);
});

test("the key still goes only in the header, to Google's endpoint", async () => {
  const f = recordingFetch(okToken);
  await createGeminiEphemeralToken({ apiKey: KEY, fetcher: f.fetch, now: NOW, voiceName: "Kore" });
  assert.equal(f.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/auth_tokens");
  assert.equal((f.calls[0].init.headers as Record<string, string>)["x-goog-api-key"], KEY);
});

test("the result has the same shape with a voice", async () => {
  const f = recordingFetch(okToken);
  const result = await createGeminiEphemeralToken({ apiKey: KEY, fetcher: f.fetch, now: NOW, voiceName: "Puck" });
  assert.deepEqual(Object.keys(result).sort(), ["model", "token", "websocketUrl"]);
  assert.equal(result.token, "auth_tokens/abc123");
});

test("when Google refuses a request with a voice, the error carries the same safe fields as before", async () => {
  const f = recordingFetch(
    () =>
      new Response(
        JSON.stringify({
          error: {
            status: "INVALID_ARGUMENT",
            message: `Invalid value ${KEY}`,
            details: [
              { fieldViolations: [{ field: "bidi_generate_content_setup.generation_config", description: "Unknown field." }] },
            ],
          },
        }),
        { status: 400 },
      ),
  );
  await assert.rejects(
    createGeminiEphemeralToken({ apiKey: KEY, fetcher: f.fetch, now: NOW, voiceName: "Puck" }),
    (e: unknown) =>
      e instanceof GeminiTokenError &&
      e.status === 502 &&
      e.message === "token_upstream_rejected" &&
      e.upstreamStatus === 400 &&
      e.upstreamCode === "INVALID_ARGUMENT" &&
      e.upstreamField === "bidi_generate_content_setup.generation_config" &&
      e.upstreamDetail === "Unknown field." &&
      !JSON.stringify(e).includes(KEY),
  );
});

test("a missing key is still refused before Google is called, with a voice too", async () => {
  const f = recordingFetch(okToken);
  await assert.rejects(
    createGeminiEphemeralToken({ apiKey: "", fetcher: f.fetch, now: NOW, voiceName: "Puck" }),
    (e: unknown) => e instanceof GeminiTokenError && e.status === 503,
  );
  assert.equal(f.calls.length, 0);
});
