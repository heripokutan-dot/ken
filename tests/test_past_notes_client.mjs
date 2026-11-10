import test from "node:test";
import assert from "node:assert/strict";
import { loadPastNotes } from "../frontend/past-notes.js";

// How the start of a conversation gets the notes: one list request, then one request for each of the newest three,
// all at once, inside a time limit, and whatever goes wrong the answer is "start without notes". Every request goes
// to a fake fetch; every sentence is made up.

const TOKEN = "dummy-token-for-tests";
const FIXED_DATE = () => "2026/11/02 21:10";
const FAILED = (reason) => `過去のメモを読み込めなかったため、使わずに始めました（理由：${reason}）`;

const response = (status, body) => ({ status, json: async () => body });
const summary = (id) => ({ id, created_at: Date.UTC(2026, 10, 2, 12, 10), persona: "standard", title: `題${id}`, truncated: false });
const listOf = (ids) => response(200, { notes: ids.map(summary), limit: 200 });
const noteOf = (id, lines) => response(200, { note: { ...summary(id), body: lines.join("\n") } });
const idOf = (url) => decodeURIComponent(url.slice("/api/notes/".length));

// A fake fetch. `onList` and `onGet(id)` return a response (or a promise of one). Every call is written down.
function fakeFetch({ onList, onGet }) {
  const calls = [];
  const fetchImpl = (url, init = {}) => {
    calls.push({ url, method: init.method, authorization: init.headers?.Authorization, body: init.body });
    return url === "/api/notes" ? onList() : onGet(idOf(url));
  };
  return { fetchImpl, calls, gets: () => calls.filter((c) => c.url !== "/api/notes"), lists: () => calls.filter((c) => c.url === "/api/notes") };
}

const load = (fetchImpl, extra = {}) =>
  loadPastNotes({ getIdToken: () => TOKEN, fetchImpl, formatDate: FIXED_DATE, waitMs: 500, ...extra });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const small = (id) => noteOf(id, [`あなた：（ダミー）${id}の質問`, `AI：（ダミー）${id}の答え`]);

// ---------- the normal path ----------

test("one list request, then one request for each of the newest three, sent together; the block holds them newest first", async () => {
  let arrived = 0;
  let openGate;
  const gate = new Promise((resolve) => (openGate = resolve));
  const fake = fakeFetch({
    onList: () => listOf(["n1", "n2", "n3", "n4", "n5"]),
    // Nobody gets an answer until all three requests are in, so one-after-the-other requests would never finish.
    onGet: async (id) => {
      arrived += 1;
      if (arrived === 3) openGate();
      await gate;
      if (id === "n1") await sleep(30); // the newest answers last; the order must still follow the list
      return small(id);
    },
  });
  const out = await load(fake.fetchImpl);

  assert.equal(fake.lists().length, 1);
  assert.deepEqual(fake.gets().map((c) => c.url), ["/api/notes/n1", "/api/notes/n2", "/api/notes/n3"]);
  assert.equal(out.status, "used");
  assert.equal(out.reason, null);
  assert.equal(out.count, 3);
  const at = (text) => out.block.indexOf(text);
  assert.ok(at("題n1") > 0 && at("題n1") < at("題n2") && at("題n2") < at("題n3"));
  assert.equal(out.block.includes("題n4"), false);
  assert.ok(out.block.includes("記録ここから（3件）"));
  const rounded = Math.max(100, Math.round(out.excerptChars / 100) * 100);
  assert.equal(out.message, `過去のメモ 3 件を使いました（約 ${rounded} 文字）`);
});

test("every request is a plain GET with the sign-in token and no body", async () => {
  const fake = fakeFetch({ onList: () => listOf(["n1"]), onGet: (id) => small(id) });
  await load(fake.fetchImpl);
  assert.equal(fake.calls.length, 2);
  for (const call of fake.calls) {
    assert.equal(call.method, "GET");
    assert.equal(call.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.body, undefined);
  }
});

test("notes longer than the limit give the 'shortened' message, which has no size in it", async () => {
  const long = (id) => noteOf(id, Array.from({ length: 12 }, (_, i) => `あなた：（ダミー）${id}の第${i}行${"あ".repeat(80)}`));
  const out = await load(fakeFetch({ onList: () => listOf(["a", "b", "c"]), onGet: long }).fetchImpl);
  assert.equal(out.status, "used_shortened");
  assert.equal(out.message, "過去のメモ 3 件を使いました（長いため一部を省略）");
  assert.ok(out.excerptChars > 1000);
});

test("the size is shown as 約 N 文字 with a comma when it is a thousand or more", async () => {
  // Three notes of about 340 characters each: not cut, so the plain message is used.
  const mid = (id) => noteOf(id, [`あなた：${"あ".repeat(100)}`, `AI：${"い".repeat(100)}`, `あなた：${"う".repeat(100)}`]);
  const out = await load(fakeFetch({ onList: () => listOf(["a", "b", "c"]), onGet: mid }).fetchImpl);
  assert.equal(out.status, "used");
  const rounded = Math.max(100, Math.round(out.excerptChars / 100) * 100);
  const text = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  assert.equal(out.message, `過去のメモ 3 件を使いました（約 ${text} 文字）`);
  assert.ok(rounded >= 1000 && text.includes(","));
});

// ---------- nothing to use ----------

test("no notes at all: nothing is added, it is not an error, and no note is requested", async () => {
  const fake = fakeFetch({ onList: () => response(200, { notes: [], limit: 200 }), onGet: () => assert.fail("no get expected") });
  const out = await load(fake.fetchImpl);
  assert.deepEqual({ status: out.status, count: out.count, block: out.block, message: out.message }, {
    status: "empty",
    count: 0,
    block: "",
    message: "過去のメモはまだありません",
  });
  assert.equal(fake.gets().length, 0);
});

test("notes with nothing usable in them count as no notes", async () => {
  const out = await load(fakeFetch({ onList: () => listOf(["a"]), onGet: (id) => noteOf(id, ["（以降省略）"]) }).fetchImpl);
  assert.equal(out.status, "empty");
  assert.equal(out.block, "");
});

// ---------- failures of the list: the conversation still starts, without notes ----------

const LIST_FAILURES = [
  [401, "unauthorized", "ログインの期限切れ"],
  [429, "rate_limited", "操作が多すぎる"],
  [503, "unavailable", "サーバーの設定不足か、一時的に使えない"],
  [500, "error", "通信またはサーバーのエラー"],
  [403, "error", "通信またはサーバーのエラー"],
  [404, "error", "通信またはサーバーのエラー"],
];

for (const [status, reason, text] of LIST_FAILURES) {
  test(`the list answers ${status}: no notes, reason ${reason}, no request for any note`, async () => {
    const state = { idToken: TOKEN };
    const fake = fakeFetch({ onList: () => response(status, { error: "x" }), onGet: () => assert.fail("no get expected") });
    const out = await loadPastNotes({ getIdToken: () => state.idToken, fetchImpl: fake.fetchImpl, formatDate: FIXED_DATE, waitMs: 500 });
    assert.deepEqual(
      { status: out.status, reason: out.reason, count: out.count, block: out.block, message: out.message },
      { status: "failed", reason, count: 0, block: "", message: FAILED(text) },
    );
    assert.equal(fake.gets().length, 0);
    assert.equal(state.idToken, TOKEN, "the sign-in state is not touched");
  });
}

test("a network failure, a broken answer, and a fetch that throws all end the same way: no notes", async () => {
  const cases = [
    () => Promise.reject(new TypeError("Failed to fetch")),
    () => response(200, { not: "a list" }),
    () => {
      throw new Error("sync failure");
    },
  ];
  for (const onList of cases) {
    const out = await load(fakeFetch({ onList, onGet: () => assert.fail("no get expected") }).fetchImpl);
    assert.equal(out.status, "failed");
    assert.equal(out.reason, "error");
    assert.equal(out.block, "");
    assert.equal(out.message, FAILED("通信またはサーバーのエラー"));
  }
});

// ---------- failures of the notes ----------

test("when one of three notes cannot be read, the other two are used and the message says so", async () => {
  const out = await load(
    fakeFetch({ onList: () => listOf(["a", "b", "c"]), onGet: (id) => (id === "b" ? response(500, {}) : small(id)) }).fetchImpl,
  );
  assert.equal(out.status, "used_partial");
  assert.equal(out.count, 2);
  assert.equal(out.message, "過去のメモ 2 件を使いました（取れなかったものがあります）");
  assert.ok(out.block.includes("題a") && out.block.includes("題c") && !out.block.includes("題b"));
  assert.ok(out.block.includes("記録ここから（2件）"));
});

test("when none of the notes can be read, it is a failure with the reason of the first one", async () => {
  const kinds = { a: 429, b: 500, c: 503 };
  const out = await load(fakeFetch({ onList: () => listOf(["a", "b", "c"]), onGet: (id) => response(kinds[id], {}) }).fetchImpl);
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "rate_limited");
  assert.equal(out.block, "");
  assert.equal(out.message, FAILED("操作が多すぎる"));
});

test("a note that was deleted between the list and the request (404) is a missing note, not a stop", async () => {
  const out = await load(fakeFetch({ onList: () => listOf(["a", "b"]), onGet: (id) => (id === "a" ? response(404, {}) : small(id)) }).fetchImpl);
  assert.equal(out.status, "used_partial");
  assert.equal(out.count, 1);
});

// ---------- no token ----------

test("without a sign-in token nothing is sent and no timer is started", async () => {
  for (const getIdToken of [() => null, () => "", () => undefined, () => 5, () => { throw new Error("no auth"); }, undefined]) {
    const fake = fakeFetch({ onList: () => assert.fail("no request expected"), onGet: () => assert.fail("no request expected") });
    const realSetTimeout = globalThis.setTimeout;
    let timers = 0;
    globalThis.setTimeout = (...args) => {
      timers += 1;
      return realSetTimeout(...args);
    };
    let pending;
    try {
      pending = loadPastNotes({ getIdToken, fetchImpl: fake.fetchImpl, formatDate: FIXED_DATE, waitMs: 500 });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.equal(timers, 0, "no timer");
    const out = await pending;
    assert.deepEqual({ status: out.status, reason: out.reason, block: out.block, message: out.message }, {
      status: "failed",
      reason: "no_token",
      block: "",
      message: FAILED("サインインしていない"),
    });
    assert.equal(fake.calls.length, 0);
  }
});

// ---------- time ----------

test("when the time is up the answer is: no notes, reason 時間切れ, and it comes back in time", async () => {
  const hang = (signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push(url);
    return hang(init.signal);
  };
  const started = Date.now();
  const out = await loadPastNotes({ getIdToken: () => TOKEN, fetchImpl, formatDate: FIXED_DATE, waitMs: 80 });
  const took = Date.now() - started;
  assert.deepEqual({ status: out.status, reason: out.reason, block: out.block, message: out.message }, {
    status: "failed",
    reason: "timeout",
    block: "",
    message: FAILED("時間切れ"),
  });
  assert.ok(took >= 70 && took < 600, `${took} ms`);
});

test("a list that is slower than the limit ends in 時間切れ, and no note is requested afterwards", async () => {
  // Not tested separately: the check "is the time up?" right after the list. The list's own time limit is the same as the
  // overall one, so an answer can only slip in between the two in the same instant, which a test cannot arrange.
  const fake = fakeFetch({
    onList: async () => {
      await sleep(120); // the list itself takes longer than the limit
      return listOf(["a", "b", "c"]);
    },
    onGet: (id) => small(id),
  });
  const out = await loadPastNotes({ getIdToken: () => TOKEN, fetchImpl: fake.fetchImpl, formatDate: FIXED_DATE, waitMs: 60 });
  assert.equal(out.reason, "timeout");
  await sleep(250);
  assert.equal(fake.gets().length, 0, "the late list answer did not start any note request");
});

test("a note answer that arrives after the time is up is not used", async () => {
  const fake = fakeFetch({
    onList: () => listOf(["a", "b"]),
    onGet: async (id) => {
      if (id === "b") await sleep(300);
      return small(id);
    },
  });
  const out = await loadPastNotes({ getIdToken: () => TOKEN, fetchImpl: fake.fetchImpl, formatDate: FIXED_DATE, waitMs: 100 });
  assert.equal(out.status, "failed");
  assert.equal(out.reason, "timeout");
  assert.equal(out.block, "");
});

test("a quick answer does not wait for the (default, four second) limit and leaves no timer behind", async () => {
  // The default is checked in test_past_notes.mjs (PAST_NOTES_LIMITS.waitMs). Here the default is simply used.
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const fake = fakeFetch({ onList: () => listOf(["a"]), onGet: (id) => small(id) });
  const before = timers();
  const started = Date.now();
  const out = await loadPastNotes({ getIdToken: () => TOKEN, fetchImpl: fake.fetchImpl, formatDate: FIXED_DATE });
  const after = timers();
  assert.equal(out.status, "used");
  assert.ok(Date.now() - started < 1000, "a quick answer does not wait for the limit");
  assert.ok(after <= before, `a timer was left behind (${before} before, ${after} after)`);
});

test("after a failure, too, no timer is left behind", async () => {
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  for (const onList of [() => response(503, {}), () => Promise.reject(new TypeError("Failed to fetch"))]) {
    const before = timers();
    const out = await loadPastNotes({ getIdToken: () => TOKEN, fetchImpl: fakeFetch({ onList, onGet: () => assert.fail() }).fetchImpl, formatDate: FIXED_DATE });
    assert.equal(out.status, "failed");
    assert.ok(timers() <= before);
  }
});

// ---------- what the answer carries ----------

test("messages never carry a title or any words of a note, whatever happened", async () => {
  const secret = "ダミー秘密語ZZ";
  const richNote = (id) => response(200, { note: { ...summary(id), title: `${secret}の題`, body: `あなた：${secret}の話` } });
  const scenarios = [
    fakeFetch({ onList: () => listOf(["a", "b"]), onGet: richNote }),
    fakeFetch({ onList: () => listOf(["a", "b"]), onGet: (id) => (id === "a" ? response(500, {}) : richNote(id)) }),
    fakeFetch({ onList: () => response(503, {}), onGet: richNote }),
  ];
  for (const fake of scenarios) {
    const out = await load(fake.fetchImpl);
    assert.equal(out.message.includes(secret), false);
    assert.equal(JSON.stringify({ ...out, block: "" }).includes(secret), false, "only the block holds the words");
  }
});

test("a load never throws, whatever it is given", async () => {
  for (const options of [undefined, {}, { getIdToken: () => TOKEN }, { getIdToken: () => TOKEN, fetchImpl: 5 }, { getIdToken: () => TOKEN, fetchImpl: () => null }]) {
    const out = await loadPastNotes(options);
    assert.equal(out.status, "failed");
    assert.equal(out.block, "");
  }
});
