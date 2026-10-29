import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NONE_MESSAGES,
  RESULTS,
  RETRY_HINT,
  SAVE_TIMEOUT_MS,
  SAVING_MESSAGE,
  createNoteSaver,
  postNote,
} from "../frontend/notes-client.js";

const sourceOf = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

// A secret-looking token and a recognisable body: neither may ever show up in a message.
const TOKEN = "tok-AAAA-test-value";
const NOTE = { title: "架空のタイトル", body: "あなた：架空の発言です\nAI：架空の返事です" };

function fakeFetch(status, json, { jsonThrows = false } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      async json() {
        if (jsonThrows) throw new SyntaxError("Unexpected token");
        return json;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

const post = (fetchImpl, overrides = {}) => postNote(NOTE, { idToken: TOKEN, fetchImpl, ...overrides });

// ---------- the request ----------

test("the request goes to /api/notes with the agreed method, headers and body", async () => {
  const f = fakeFetch(201, { saved: true, note: { truncated: false } });
  await post(f);
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, "/api/notes");
  assert.equal(init.method, "POST");
  assert.equal(init.cache, "no-store");
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers.Accept, "application/json");
  assert.deepEqual(JSON.parse(init.body), { title: NOTE.title, body: NOTE.body });
  assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), ["body", "title"], "no persona, nothing else");
});

test("the timeout is 15 seconds", () => {
  assert.equal(SAVE_TIMEOUT_MS, 15000);
});

test("without an ID token nothing is sent and the answer is the sign-in message", async () => {
  for (const idToken of [undefined, null, "", 0, {}]) {
    const f = fakeFetch(201, { saved: true });
    const r = await postNote(NOTE, { idToken, fetchImpl: f });
    assert.equal(f.calls.length, 0);
    assert.equal(r.kind, "unauthorized");
    assert.equal(r.retry, true);
  }
});

// ---------- every status ----------

const TABLE = [
  [201, { saved: true, note: { truncated: false } }, "saved", "メモに保存しました", false],
  [201, { saved: true, note: { truncated: true } }, "saved_truncated", "メモに保存しました（長い会話のため、途中までです）", false],
  [200, { saved: false, reason: "empty_body" }, "empty_body", "保存するものがありませんでした", false],
  [400, { error: "x" }, "bad_request", "保存できませんでした（内容に問題があります）", false],
  [
    401,
    { error: "x" },
    "unauthorized",
    "ログインの期限が切れました。もう一度サインインしてから、「メモをもう一度保存」を押してください。ページを再読み込みすると、このメモは消えます。",
    true,
  ],
  [403, { error: "x" }, "forbidden", "保存できませんでした（アクセスが許可されていません）", false],
  [405, {}, "app_problem", "保存できませんでした（アプリの不具合の可能性があります）", false],
  [415, {}, "app_problem", "保存できませんでした（アプリの不具合の可能性があります）", false],
  [409, { error: "x" }, "conflict", "メモが 200 件に達しています。古いメモを削除してから、「メモをもう一度保存」を押してください。", true],
  [413, { error: "x" }, "too_large", "会話が長すぎて、保存できませんでした", false],
  [429, { error: "x" }, "rate_limited", "操作が多すぎます。1分ほど待ってから、もう一度保存してください。", true],
  [503, { error: "x" }, "unavailable", "サーバーの設定が足りないため、保存できませんでした", true],
  [
    500,
    { error: "x" },
    "server_error",
    "サーバーでエラーが起きました。保存されている可能性があります。少し待ってから、メモの一覧で確かめて、もう一度保存してください。",
    true,
  ],
];

for (const [status, json, kind, message, retry] of TABLE) {
  test(`status ${status} (${kind}) gives the agreed message and ${retry ? "offers" : "does not offer"} saving again`, async () => {
    const r = await post(fakeFetch(status, json));
    assert.equal(r.kind, kind);
    assert.equal(r.message, message);
    assert.equal(r.retry, retry);
    assert.equal(r.ok, status === 201 || status === 200);
  });
}

test("other 5xx statuses use the server-error message; other 4xx statuses use the app-problem message", async () => {
  for (const status of [500, 502, 504, 599]) assert.equal((await post(fakeFetch(status, {}))).kind, "server_error");
  for (const status of [404, 410, 422, 499]) {
    const r = await post(fakeFetch(status, {}));
    assert.equal(r.kind, "app_problem");
    assert.equal(r.retry, false);
  }
});

test("statuses that are not an answer to this request are treated as a communication failure", async () => {
  for (const status of [204, 301, 302, 304, 100]) assert.equal((await post(fakeFetch(status, {}))).kind, "network", String(status));
});

test("the message table in the module is exactly the one tested here", () => {
  assert.deepEqual(Object.keys(RESULTS).sort(), [
    "app_problem", "bad_request", "conflict", "empty_body", "forbidden", "network", "rate_limited",
    "saved", "saved_truncated", "server_error", "too_large", "unauthorized", "unavailable",
  ]);
});

// ---------- broken answers and communication failures ----------

const NETWORK_MESSAGE =
  "通信に失敗しました。保存されている可能性があります。つながる場所で、メモの一覧で確かめて、もう一度保存してください。";

test("a broken JSON body on 200 or 201 is a communication failure", async () => {
  for (const status of [200, 201]) {
    const r = await post(fakeFetch(status, null, { jsonThrows: true }));
    assert.equal(r.kind, "network");
    assert.equal(r.message, NETWORK_MESSAGE);
    assert.equal(r.retry, true);
  }
});

test("a 200 or 201 body of the wrong shape is a communication failure", async () => {
  for (const json of [null, "ok", 5, {}, { saved: "true" }, { saved: 1 }]) {
    assert.equal((await post(fakeFetch(201, json))).kind, "network", JSON.stringify(json));
  }
  for (const json of [null, {}, { saved: true }, { saved: "false" }]) {
    assert.equal((await post(fakeFetch(200, json))).kind, "network", JSON.stringify(json));
  }
});

test("truncated is only believed when it is exactly true", async () => {
  for (const truncated of [1, "true", undefined, null]) {
    assert.equal((await post(fakeFetch(201, { saved: true, note: { truncated } }))).kind, "saved");
  }
  assert.equal((await post(fakeFetch(201, { saved: true }))).kind, "saved");
});

test("a failing fetch is a communication failure and never throws", async () => {
  const r = await post(async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.equal(r.kind, "network");
  assert.equal(r.message, NETWORK_MESSAGE);
});

test("a request that never answers is cut off by the timeout, even if the fetch ignores the abort signal", async () => {
  const started = Date.now();
  const r = await post(() => new Promise(() => {}), { timeoutMs: 30 });
  assert.equal(r.kind, "network");
  assert.ok(Date.now() - started < 2000);
});

test("the timeout aborts the request when the fetch honours the signal", async () => {
  let aborted = false;
  const f = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  const r = await post(f, { timeoutMs: 30 });
  assert.equal(r.kind, "network");
  assert.equal(aborted, true);
});

test("a body that never finishes arriving is also cut off by the timeout", async () => {
  const f = async () => ({ status: 201, json: () => new Promise(() => {}) });
  assert.equal((await post(f, { timeoutMs: 30 })).kind, "network");
});

test("a late failure after the timeout does not become an unhandled rejection", async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const f = () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late")), 80));
    assert.equal((await post(f, { timeoutMs: 20 })).kind, "network");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("a fast answer is not delayed or turned into a failure by the timer", async () => {
  const r = await post(fakeFetch(201, { saved: true, note: {} }), { timeoutMs: 5000 });
  assert.equal(r.kind, "saved");
});

// ---------- nothing private in a message ----------

test("no message contains the note, the title or the token", async () => {
  const everything = [
    ...Object.values(RESULTS).map((r) => r.message),
    ...Object.values(NONE_MESSAGES),
    SAVING_MESSAGE,
    RETRY_HINT,
  ];
  for (const text of everything) {
    assert.equal(text.includes("架空"), false);
    assert.equal(text.includes(TOKEN), false);
  }
  const seen = [];
  for (const [status, json] of TABLE) seen.push((await post(fakeFetch(status, json))).message);
  seen.push((await post(async () => { throw new Error(`${TOKEN} ${NOTE.body}`); })).message);
  for (const text of seen) {
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes("架空"), false);
  }
});

test("the text of an error response is never read or shown", async () => {
  const f = fakeFetch(500, { error: "secret detail", message: "あなたのメモ" });
  const r = await post(f);
  assert.equal(r.message.includes("secret"), false);
  assert.equal(r.message.includes("あなたのメモ"), false);
});

// ---------- saver: saving ----------

function makeSaver(sendImpl) {
  const views = [];
  const sent = [];
  const saver = createNoteSaver({
    send: async (note) => {
      sent.push(note);
      return sendImpl(note);
    },
    onChange: (view) => views.push(view),
  });
  return { saver, views, sent, last: () => saver.getView() };
}
const ok = () => ({ kind: "saved", ok: true, retry: false, message: RESULTS.saved.message });
const failRetry = () => ({ kind: "network", ok: false, retry: true, message: RESULTS.network.message });
const failFinal = () => ({ kind: "forbidden", ok: false, retry: false, message: RESULTS.forbidden.message });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("a note is sent once, 'saving' is shown meanwhile, and the result replaces it", async () => {
  const gate = deferred();
  const { saver, views, sent } = makeSaver(() => gate.promise);
  const done = saver.submit({ kind: "note", title: NOTE.title, body: NOTE.body, clipped: false });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { title: NOTE.title, body: NOTE.body }, "only title and body are passed on");
  assert.equal(saver.getView().message, SAVING_MESSAGE);
  assert.equal(saver.getView().visible, true);
  assert.equal(saver.getView().showRetry, false);
  gate.resolve(ok());
  await done;
  assert.equal(saver.getView().message, RESULTS.saved.message);
  assert.equal(saver.getView().showRetry, false);
  assert.ok(views.length >= 2);
});

test("'none' results explain themselves, 'already_taken' shows nothing and leaves the display alone", async () => {
  const { saver, sent } = makeSaver(ok);
  await saver.submit({ kind: "none", reason: "empty" });
  assert.equal(saver.getView().message, "保存するものがありませんでした");
  assert.equal(saver.getView().showRetry, false);
  await saver.submit({ kind: "none", reason: "no_user_speech" });
  assert.equal(saver.getView().message, "あなたの発言が記録されなかったため、保存しませんでした");
  await saver.submit({ kind: "none", reason: "already_taken" });
  assert.equal(saver.getView().message, "あなたの発言が記録されなかったため、保存しませんでした", "unchanged");
  assert.equal(sent.length, 0);

  const fresh = makeSaver(ok);
  await fresh.saver.submit({ kind: "none", reason: "already_taken" });
  assert.equal(fresh.saver.getView().visible, false, "nothing appears at all");
});

test("unknown or malformed take results are ignored without throwing", async () => {
  const { saver, sent } = makeSaver(ok);
  for (const bad of [undefined, null, 5, "note", {}, { kind: "none" }, { kind: "none", reason: "other" }, { kind: "note" }, { kind: "note", title: 1, body: "x" }, { kind: "note", title: "x", body: 2 }]) {
    await assert.doesNotReject(saver.submit(bad));
  }
  assert.equal(sent.length, 0);
  assert.equal(saver.getView().visible, false);
});

test("a send that throws or returns nonsense is shown as a communication failure", async () => {
  const thrown = makeSaver(() => { throw new Error("boom"); });
  await thrown.saver.submit({ kind: "note", title: "t", body: "b" });
  assert.equal(thrown.saver.getView().message, RESULTS.network.message);
  assert.equal(thrown.saver.getView().showRetry, true);

  for (const nonsense of [undefined, null, "x", { message: 1, retry: true }, { message: "m" }]) {
    const { saver } = makeSaver(() => nonsense);
    await saver.submit({ kind: "note", title: "t", body: "b" });
    assert.equal(saver.getView().message, RESULTS.network.message);
  }
});

test("a drawing callback that throws does not break saving", async () => {
  const saver = createNoteSaver({ send: async () => ok(), onChange: () => { throw new Error("draw"); } });
  await assert.doesNotReject(saver.submit({ kind: "note", title: "t", body: "b" }));
  assert.equal(saver.getView().message, RESULTS.saved.message);
});

// ---------- saver: saving again ----------

test("after a failure that can be retried, the note is kept and the button is offered with its hint", async () => {
  const { saver } = makeSaver(failRetry);
  await saver.submit({ kind: "note", title: NOTE.title, body: NOTE.body });
  const view = saver.getView();
  assert.equal(view.showRetry, true);
  assert.equal(view.retryDisabled, false);
  assert.equal(view.hint, "次の会話を始めると、消えます。");
  assert.equal(view.message, RESULTS.network.message);
});

test("after a failure without a button, the kept note is thrown away (and cannot be sent)", async () => {
  const { saver, sent } = makeSaver(failFinal);
  await saver.submit({ kind: "note", title: "t", body: "b" });
  assert.equal(saver.getView().showRetry, false);
  assert.equal(saver.getView().hint, "");
  assert.equal(await saver.retry(), false);
  assert.equal(sent.length, 1);
});

test("a success also leaves nothing to send again", async () => {
  const { saver, sent } = makeSaver(ok);
  await saver.submit({ kind: "note", title: "t", body: "b" });
  assert.equal(await saver.retry(), false);
  assert.equal(sent.length, 1);
});

test("retry sends the kept note once, with the same title and body, and a success removes the button", async () => {
  let n = 0;
  const { saver, sent } = makeSaver(() => (n++ === 0 ? failRetry() : ok()));
  await saver.submit({ kind: "note", title: NOTE.title, body: NOTE.body });
  assert.equal(await saver.retry(), true);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], { title: NOTE.title, body: NOTE.body });
  assert.equal(saver.getView().message, RESULTS.saved.message);
  assert.equal(saver.getView().showRetry, false);
  assert.equal(saver.getView().hint, "");
  assert.equal(await saver.retry(), false, "the kept note is gone");
  assert.equal(sent.length, 2);
});

test("a retry that fails again keeps the note and the button; one that fails for good removes them", async () => {
  const steps = [failRetry, failRetry, failFinal];
  let n = 0;
  const { saver, sent } = makeSaver(() => steps[n++]());
  await saver.submit({ kind: "note", title: "t", body: "b" });
  await saver.retry();
  assert.equal(saver.getView().showRetry, true);
  await saver.retry();
  assert.equal(saver.getView().showRetry, false);
  assert.equal(sent.length, 3);
});

test("pressing the button twice while saving sends one request, and the button is disabled meanwhile", async () => {
  const gates = [];
  const { saver, sent } = makeSaver(() => {
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  });
  const first = saver.submit({ kind: "note", title: "t", body: "b" });
  gates[0].resolve(failRetry());
  await first;
  assert.equal(sent.length, 1);

  const a = saver.retry();
  const b = saver.retry();
  const c = saver.retry();
  assert.equal(sent.length, 2, "one request for three presses");
  assert.equal(saver.getView().retryDisabled, true);
  assert.equal(saver.getView().showRetry, true, "the button stays on screen, disabled");
  assert.equal(saver.getView().message, SAVING_MESSAGE);
  assert.equal(await b, false);
  assert.equal(await c, false);
  gates[1].resolve(ok());
  assert.equal(await a, true);
  assert.equal(sent.length, 2);
  assert.equal(saver.getView().showRetry, false);
});

test("retry does nothing when there is nothing kept", async () => {
  const { saver, sent } = makeSaver(ok);
  assert.equal(await saver.retry(), false);
  assert.equal(sent.length, 0);
});

test("a save that is already running is not started a second time", async () => {
  const gate = deferred();
  const { saver, sent } = makeSaver(() => gate.promise);
  const a = saver.submit({ kind: "note", title: "t", body: "b" });
  const b = saver.submit({ kind: "note", title: "t", body: "b" });
  assert.equal(sent.length, 1);
  gate.resolve(ok());
  await Promise.all([a, b]);
  assert.equal(sent.length, 1);
});

// ---------- saver: a new conversation ----------

test("reset clears the display and the kept note", async () => {
  const { saver, sent } = makeSaver(failRetry);
  await saver.submit({ kind: "note", title: "t", body: "b" });
  saver.reset();
  const view = saver.getView();
  assert.equal(view.visible, false);
  assert.equal(view.message, "");
  assert.equal(view.showRetry, false);
  assert.equal(view.hint, "");
  assert.equal(await saver.retry(), false);
  assert.equal(sent.length, 1);
});

test("the result of a request still on its way when a new conversation starts reaches neither the screen nor the kept note", async () => {
  const gate = deferred();
  const { saver, sent } = makeSaver(() => gate.promise);
  const pendingSave = saver.submit({ kind: "note", title: "old", body: "old" });
  saver.reset(); // the next conversation starts while the request is in flight
  gate.resolve(failRetry()); // an old result that would offer the button
  await pendingSave;
  assert.equal(saver.getView().visible, false, "nothing from the old request on screen");
  assert.equal(saver.getView().showRetry, false);
  assert.equal(await saver.retry(), false, "and no old note was kept");
  assert.equal(sent.length, 1);

  // An old success must not show up either.
  const gate2 = deferred();
  const second = makeSaver(() => gate2.promise);
  const p = second.saver.submit({ kind: "note", title: "old", body: "old" });
  second.saver.reset();
  gate2.resolve(ok());
  await p;
  assert.equal(second.saver.getView().visible, false);
});

test("an old result does not overwrite what the new conversation is showing", async () => {
  const gates = [];
  const { saver, sent } = makeSaver(() => {
    const g = deferred();
    gates.push(g);
    return g.promise;
  });
  const oldSave = saver.submit({ kind: "note", title: "old", body: "old" });
  saver.reset();
  const newSave = saver.submit({ kind: "note", title: "new", body: "new" });
  assert.equal(sent.length, 2);
  gates[1].resolve(failRetry()); // the new one finishes first
  await newSave;
  gates[0].resolve(ok()); // then the old one
  await oldSave;
  assert.equal(saver.getView().message, RESULTS.network.message, "still the new conversation's result");
  assert.equal(saver.getView().showRetry, true);
  const again = saver.retry();
  assert.deepEqual(sent[2], { title: "new", body: "new" }, "the kept note is the new one");
  gates[2].resolve(ok());
  assert.equal(await again, true);
});

test("a retry in flight when a new conversation starts is dropped the same way", async () => {
  const gates = [];
  let n = 0;
  const { saver } = makeSaver(() => {
    if (n++ === 0) return failRetry();
    const g = deferred();
    gates.push(g);
    return g.promise;
  });
  await saver.submit({ kind: "note", title: "t", body: "b" });
  const retrying = saver.retry();
  saver.reset();
  gates[0].resolve(ok());
  await retrying;
  assert.equal(saver.getView().visible, false);
});

test("after reset the saver works again for the next conversation", async () => {
  const { saver, sent } = makeSaver(ok);
  await saver.submit({ kind: "note", title: "1", body: "1" });
  saver.reset();
  await saver.submit({ kind: "note", title: "2", body: "2" });
  assert.equal(sent.length, 2);
  assert.equal(saver.getView().message, RESULTS.saved.message);
});

// ---------- the whole path with a fake fetch ----------

test("postNote and the saver together: 429, then the token changes, then a retry succeeds", async () => {
  let token = "first-token";
  const f429 = fakeFetch(429, {});
  const f201 = fakeFetch(201, { saved: true, note: { truncated: false } });
  let current = f429;
  const saver = createNoteSaver({ send: (note) => postNote(note, { idToken: token, fetchImpl: (...a) => current(...a) }) });
  await saver.submit({ kind: "note", title: "t", body: "b" });
  assert.equal(saver.getView().message, "操作が多すぎます。1分ほど待ってから、もう一度保存してください。");
  token = "second-token"; // signed in again without reloading
  current = f201;
  await saver.retry();
  assert.equal(f201.calls[0].init.headers.Authorization, "Bearer second-token", "the retry uses the token of that moment");
  assert.equal(saver.getView().showRetry, false);
});

// ---------- the module keeps to itself ----------

test("the source has no storage, logging or HTML insertion, and no page access", () => {
  const source = sourceOf("../frontend/notes-client.js");
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|\bconsole\b|innerHTML|outerHTML|insertAdjacentHTML|document\.write/i);
  assert.doesNotMatch(source, /\bdocument\b|\bwindow\b|\blocation\b|\bnavigator\b/);
  assert.doesNotMatch(source, /^\s*import\s/m, "it imports nothing");
});

test("app.js uses no innerHTML, sessionStorage, IndexedDB or console", () => {
  const app = sourceOf("../frontend/app.js");
  assert.doesNotMatch(app, /sessionStorage|indexedDB|\bconsole\b|innerHTML|outerHTML|insertAdjacentHTML/i);
});

test("localStorage appears in app.js only inside the two functions that read and write the switch", () => {
  const app = sourceOf("../frontend/app.js");
  const uses = [...app.matchAll(/localStorage/g)].map((m) => m.index);
  assert.equal(uses.length, 2);
  const body = (name) => {
    const start = app.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    const end = app.indexOf("\n}\n", start);
    return [start, end];
  };
  const [rs, re] = body("readAutoSaveSetting");
  const [ws, we] = body("writeAutoSaveSetting");
  assert.ok(uses.some((i) => i > rs && i < re));
  assert.ok(uses.some((i) => i > ws && i < we));
  assert.doesNotMatch(app.slice(ws, we), /token|body|title/i, "only the true/false setting is written");
});

// ---------- how app.js uses it ----------

function functionBody(app, header) {
  const start = app.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  const end = app.indexOf("\n}\n", start);
  assert.ok(end > start);
  return app.slice(start, end);
}

test("app.js starts a save in exactly three places: stop, failure and unexpected close - and not in a failed start", () => {
  const app = sourceOf("../frontend/app.js");
  const callPattern = /saveEndedConversation\(\);/g;
  assert.equal([...app.matchAll(callPattern)].length, 3);
  for (const header of ["async function stopSession(", "async function failSession(", "async function handleUnexpectedClose("]) {
    assert.equal([...functionBody(app, header).matchAll(callPattern)].length, 1, header);
  }
  const start = functionBody(app, "async function startSession(");
  assert.doesNotMatch(start, /saveEndedConversation|noteSaver\.submit|\.take\(/, "a failed start never saves");
  const catchBlock = start.slice(start.indexOf("} catch (error)"));
  assert.doesNotMatch(catchBlock, /saveEndedConversation|noteSaver|take\(/);
});

test("the save call comes after the existing clean-up in each of the three functions", () => {
  const app = sourceOf("../frontend/app.js");
  for (const [header, marker] of [
    ["async function stopSession(", "updateControls();"],
    ["async function failSession(", "updateControls();"],
    ["async function handleUnexpectedClose(", "updateControls();"],
  ]) {
    const body = functionBody(app, header);
    assert.ok(body.indexOf("saveEndedConversation();") > body.lastIndexOf(marker), header);
    assert.ok(body.indexOf("saveEndedConversation();") > body.indexOf("await releaseAudioResources("), header);
    assert.doesNotMatch(body, /await\s+saveEndedConversation|await\s+noteSaver/, "saving is never waited for");
  }
});

test("take() is called from one place only, a function that never throws and checks the switch first", () => {
  const app = sourceOf("../frontend/app.js");
  assert.equal([...app.matchAll(/transcriptRecorder\.take\(\)/g)].length, 1);
  const body = functionBody(app, "function saveEndedConversation(");
  assert.ok(body.includes("transcriptRecorder.take()"));
  assert.ok(body.indexOf("autoSaveSwitch.checked") >= 0 && body.indexOf("autoSaveSwitch.checked") < body.indexOf("take()"), "the switch is read before taking");
  assert.ok(body.includes("authRequired"), "only in the hosted version");
  assert.ok(body.includes("try {") && body.includes("catch"), "an error here cannot reach the end-of-conversation code");
  assert.doesNotMatch(body, /await/);
});

test("a conversation counts as started only once it is connected, and a new start clears the save display", () => {
  const app = sourceOf("../frontend/app.js");
  assert.equal([...app.matchAll(/conversationActive = true;/g)].length, 1);
  const start = functionBody(app, "async function startSession(");
  assert.ok(start.indexOf("conversationActive = true;") > start.indexOf("isConnected = true;"));
  assert.equal([...app.matchAll(/noteSaver\.reset\(\)/g)].length, 1);
  assert.ok(functionBody(app, "async function startSession(").includes("noteSaver.reset();"));
  assert.ok(start.indexOf("noteSaver.reset();") < start.indexOf("await connectWebSocket("));
});

test("the sign-in code is not touched by saving: a failed save never discards the ID token", () => {
  const app = sourceOf("../frontend/app.js");
  assert.equal([...app.matchAll(/^\s+idToken = null/gm)].length, 1, "only the original place that clears it");
  assert.doesNotMatch(functionBody(app, "function saveEndedConversation("), /idToken\s*=/);
});

test("the module paths in index.html and app.js are written like the existing ones", () => {
  const app = sourceOf("../frontend/app.js");
  assert.ok(app.includes('import { createNoteSaver, postNote } from "./notes-client.js";'));
});

test("a save only starts for a conversation that was really running, and each conversation can start one save only", () => {
  const app = sourceOf("../frontend/app.js");
  const body = functionBody(app, "function saveEndedConversation(");
  const check = body.indexOf("if (!conversationActive) return;");
  const clear = body.indexOf("conversationActive = false;");
  assert.ok(check >= 0 && clear > check, "checked, then cleared, before anything else");
  assert.ok(clear < body.indexOf("transcriptRecorder.take()"));
  assert.ok(clear < body.indexOf("autoSaveSwitch.checked"), "cleared even when the switch is off");
});
