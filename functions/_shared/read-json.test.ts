import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_JSON_BODY_BYTES, readJsonBody, readLimitedBytes } from "./read-json.ts";

const URL_ = "https://ken.example.pages.dev/api/live-token";
const post = (body?: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request(URL_, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });

// A JSON object of exactly `size` bytes (ASCII only).
function jsonOfSize(size: number): string {
  const head = '{"persona":"buddy","pad":"';
  const tail = '"}';
  return head + "x".repeat(size - head.length - tail.length) + tail;
}

test("the limit is 1 KB", () => {
  assert.equal(MAX_JSON_BODY_BYTES, 1024);
});

// ---- what comes back ------------------------------------------------------------------------------------------------

test("no body, and a body of zero bytes, are 'empty'", async () => {
  assert.deepEqual(await readJsonBody(post()), { kind: "empty" });
  assert.deepEqual(await readJsonBody(post("")), { kind: "empty" });
});

test("JSON is parsed, whatever its shape (judging the shape is the caller's job)", async () => {
  assert.deepEqual(await readJsonBody(post("{}")), { kind: "json", value: {} });
  assert.deepEqual(await readJsonBody(post('{"persona":"buddy"}')), { kind: "json", value: { persona: "buddy" } });
  assert.deepEqual(await readJsonBody(post("[]")), { kind: "json", value: [] });
  assert.deepEqual(await readJsonBody(post("null")), { kind: "json", value: null });
  assert.deepEqual(await readJsonBody(post('"buddy"')), { kind: "json", value: "buddy" });
  assert.deepEqual(await readJsonBody(post("5")), { kind: "json", value: 5 });
});

test("text that is not JSON, and bytes that are not UTF-8, are 'invalid'", async () => {
  for (const body of ["not json", '{"persona":', "{'a':1}", "   ", "{} {}"]) {
    assert.deepEqual(await readJsonBody(post(body)), { kind: "invalid" }, body);
  }
  assert.deepEqual(await readJsonBody(post(new Uint8Array([0xff, 0xfe, 0xfd]))), { kind: "invalid" });
});

// ---- the limit ------------------------------------------------------------------------------------------------------

test("a body of exactly the limit is read; one byte more is 'too_large'", async () => {
  assert.equal(new TextEncoder().encode(jsonOfSize(1024)).length, 1024);
  const atLimit = await readJsonBody(post(jsonOfSize(1024)));
  assert.equal(atLimit.kind, "json");
  assert.deepEqual(await readJsonBody(post(jsonOfSize(1025))), { kind: "too_large" });
});

test("the limit counts bytes, not characters", async () => {
  // 600 characters of 3 bytes each = 1800 bytes
  const body = JSON.stringify({ persona: "あ".repeat(600) });
  assert.ok(body.length < 1024 && new TextEncoder().encode(body).length > 1024);
  assert.deepEqual(await readJsonBody(post(body)), { kind: "too_large" });
});

test("a smaller limit can be given", async () => {
  assert.deepEqual(await readJsonBody(post('{"a":"0123456789"}'), 10), { kind: "too_large" });
  assert.equal((await readJsonBody(post("{}"), 10)).kind, "json");
});

test("a declared Content-Length over the limit is refused without reading the body", async () => {
  const request = post("{}", { "Content-Length": "5000" });
  assert.deepEqual(await readJsonBody(request), { kind: "too_large" });
  assert.equal(request.bodyUsed, false);
});

test("a Content-Length that is not a plain number is ignored, and the real size decides", async () => {
  for (const declared of ["abc", "-1", "1e9", "", "50 00"]) {
    const result = await readJsonBody(post("{}", { "Content-Length": declared }));
    assert.equal(result.kind, "json", declared);
  }
});

test("reading stops at the limit: a long body is not read to the end, and the stream is cancelled", async () => {
  let pulled = 0;
  let cancelled = false;
  const chunk = new TextEncoder().encode("x".repeat(100));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (pulled > 1000) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit);
  assert.deepEqual(await readJsonBody(request), { kind: "too_large" });
  assert.equal(cancelled, true);
  assert.ok(pulled < 100, `pulled ${pulled} chunks`);
});

// ---- the byte reader --------------------------------------------------------------------------------------------------

test("readLimitedBytes: bytes up to the limit, null above it, and zero bytes for no body", async () => {
  assert.equal((await readLimitedBytes(post(), 10))?.byteLength, 0);
  assert.equal((await readLimitedBytes(post("0123456789"), 10))?.byteLength, 10);
  assert.equal(await readLimitedBytes(post("0123456789x"), 10), null);
});

test("a body that cannot be read is 'invalid', not an exception", async () => {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("connection lost"));
    },
  });
  const request = new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit);
  assert.deepEqual(await readJsonBody(request), { kind: "invalid" });
});
