import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BUSY_MESSAGE,
  DELETE_ALL_CONFIRM,
  EMPTY_LIST_MESSAGE,
  NO_TITLE_TEXT,
  REQUEST_TIMEOUT_MS,
  RESULTS,
  TRUNCATED_MARK,
  UNKNOWN_DATE_TEXT,
  createNotesApi,
  createNotesPanel,
  formatDateTime,
} from "../frontend/notes-list-client.js";

const sourceOf = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

// Recognisable fake data: none of it may ever show up in a message, and the token must never show up anywhere.
const TOKEN = "tok-AAAA-test-value";
const N1 = { id: "id-1", created_at: 1700000000000, persona: "", title: "架空のタイトル", truncated: false };
const N2 = { id: "id-2", created_at: 1700000100000, persona: "", title: "", truncated: true };
const BODY1 = "あなた：架空の発言です\nAI：架空の返事です";
const LIST = { notes: [N1, N2], limit: 200 };

// The agreed messages, written out here so that a change in the module's text is caught.
const MSG = {
  unauthorized: "ログインの期限が切れました。もう一度サインインしてから、もう一度試してください。",
  no_token: "サインインしてから、もう一度試してください。",
  forbidden: "アクセスが許可されていません",
  not_found: "このメモは見つかりませんでした（すでに削除された可能性があります）",
  already_deleted: "すでに削除されています",
  app_problem: "できませんでした（アプリの不具合の可能性があります）",
  rate_limited: "操作が多すぎます。1分ほど待ってから、もう一度試してください。",
  unavailable: "サーバーの設定が足りないか、一時的に使えません。少し待ってから、もう一度試してください。",
  server_error: "サーバーでエラーが起きました。少し待ってから、もう一度試してください。",
  network: "通信に失敗しました。つながる場所で、もう一度試してください。",
  delete_unknown: "削除できたか分かりません。一覧を更新して、確かめてください。",
  deleted: "削除しました",
};

function resp(status, json, { jsonThrows = false, jsonHangs = false } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      if (jsonHangs) return new Promise(() => {});
      if (jsonThrows) throw new SyntaxError("Unexpected token");
      return json;
    },
  };
}

// A fake fetch. The handler gets { url, method, n } and returns a response (or a promise of one).
function server(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init?.method, init });
    return handler({ url, method: init?.method, n: calls.length });
  };
  impl.calls = calls;
  return impl;
}
const fixed = (status, json, opts) => server(() => resp(status, json, opts));
const apiWith = (fetchImpl, extra = {}) => createNotesApi({ getIdToken: () => TOKEN, fetchImpl, ...extra });

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------- the requests ----------

test("the list request: GET /api/notes, bearer token, no body, no cache", async () => {
  const f = fixed(200, LIST);
  await apiWith(f).list();
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, "/api/notes");
  assert.equal(init.method, "GET");
  assert.equal(init.cache, "no-store");
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers.Accept, "application/json");
  assert.deepEqual(Object.keys(init.headers).sort(), ["Accept", "Authorization"], "no Content-Type: there is no body");
  assert.equal(init.body, undefined);
});

test("the get request: GET /api/notes/<id> with the id encoded for a URL", async () => {
  const f = fixed(200, { note: { ...N1, body: BODY1 } });
  await apiWith(f).get("id-1");
  assert.equal(f.calls[0].url, "/api/notes/id-1");
  assert.equal(f.calls[0].init.method, "GET");
  assert.equal(f.calls[0].init.body, undefined);

  const g = fixed(200, { note: { ...N1, id: "a/b c?d#e", body: "x" } });
  await apiWith(g).get("a/b c?d#e");
  assert.equal(g.calls[0].url, "/api/notes/a%2Fb%20c%3Fd%23e");
});

test("the delete request: DELETE /api/notes/<id>, no body, id encoded", async () => {
  const f = fixed(200, { deleted: true });
  await apiWith(f).remove("a/b c?d#e");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "/api/notes/a%2Fb%20c%3Fd%23e");
  assert.equal(f.calls[0].init.method, "DELETE");
  assert.equal(f.calls[0].init.cache, "no-store");
  assert.equal(f.calls[0].init.credentials, "same-origin");
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(f.calls[0].init.body, undefined);
});

test("the delete-all request carries the confirmation value in the URL", async () => {
  assert.equal(DELETE_ALL_CONFIRM, "delete-all");
  const f = fixed(200, { deleted: 2 });
  await apiWith(f).removeAll();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "/api/notes?confirm=delete-all");
  assert.equal(f.calls[0].init.method, "DELETE");
  assert.equal(f.calls[0].init.body, undefined);
});

test("an id that is not a non-empty string is never sent", async () => {
  for (const id of [undefined, null, "", 5, {}]) {
    const f = fixed(200, {});
    const a = apiWith(f);
    assert.equal((await a.get(id)).kind, "app_problem");
    assert.equal((await a.remove(id)).kind, "app_problem");
    assert.equal(f.calls.length, 0);
  }
});

test("the timeout is 15 seconds", () => {
  assert.equal(REQUEST_TIMEOUT_MS, 15000);
});

test("the ID token is read at the moment of each request", async () => {
  let token = "first";
  const f = fixed(200, LIST);
  const a = createNotesApi({ getIdToken: () => token, fetchImpl: f });
  await a.list();
  token = "second"; // signed in again without reloading
  await a.list();
  assert.equal(f.calls[0].init.headers.Authorization, "Bearer first");
  assert.equal(f.calls[1].init.headers.Authorization, "Bearer second");
});

test("without an ID token nothing is sent, for every operation", async () => {
  for (const token of [undefined, null, "", 0, {}]) {
    const f = fixed(200, LIST);
    const a = createNotesApi({ getIdToken: () => token, fetchImpl: f });
    for (const r of [await a.list(), await a.get("id-1"), await a.remove("id-1"), await a.removeAll()]) {
      assert.equal(r.kind, "no_token");
      assert.equal(r.message, MSG.no_token);
      assert.equal(r.retry, true);
      assert.equal(r.refresh, false);
      assert.equal(r.ok, false);
    }
    assert.equal(f.calls.length, 0);
  }
  const throwing = createNotesApi({ getIdToken: () => { throw new Error("boom"); }, fetchImpl: fixed(200, LIST) });
  assert.equal((await throwing.list()).kind, "no_token");
});

// ---------- reading: every status ----------

// [status, kind, retry offered, refresh offered, message]
const READ_TABLE = [
  [401, "unauthorized", true, false, MSG.unauthorized],
  [403, "forbidden", false, false, MSG.forbidden],
  [400, "app_problem", false, false, MSG.app_problem],
  [405, "app_problem", false, false, MSG.app_problem],
  [415, "app_problem", false, false, MSG.app_problem],
  [422, "app_problem", false, false, MSG.app_problem],
  [499, "app_problem", false, false, MSG.app_problem],
  [429, "rate_limited", true, false, MSG.rate_limited],
  [503, "unavailable", true, false, MSG.unavailable],
  [500, "server_error", true, false, MSG.server_error],
  [502, "server_error", true, false, MSG.server_error],
  [504, "server_error", true, false, MSG.server_error],
  [599, "server_error", true, false, MSG.server_error],
  [204, "network", true, false, MSG.network],
  [301, "network", true, false, MSG.network],
  [304, "network", true, false, MSG.network],
  [100, "network", true, false, MSG.network],
];

for (const op of ["list", "get"]) {
  for (const [status, kind, retry, refresh, message] of READ_TABLE) {
    test(`${op}: status ${status} gives "${kind}" with the agreed message and actions`, async () => {
      const r = await apiWith(fixed(status, { error: "x" }))[op]("id-1");
      assert.equal(r.kind, kind);
      assert.equal(r.message, message);
      assert.equal(r.retry, retry);
      assert.equal(r.refresh, refresh);
      assert.equal(r.ok, false);
    });
  }
}

test("get: 404 is 'not found' and offers only 'update the list'", async () => {
  const r = await apiWith(fixed(404, { error: "not_found" })).get("id-1");
  assert.equal(r.kind, "not_found");
  assert.equal(r.message, MSG.not_found);
  assert.equal(r.retry, false);
  assert.equal(r.refresh, true);
  assert.equal(r.ok, false);
});

test("list: 404 is not a table case of its own: it is the app-problem message", async () => {
  const r = await apiWith(fixed(404, {})).list();
  assert.equal(r.kind, "app_problem");
  assert.equal(r.message, MSG.app_problem);
});

test("list: 200 gives the notes and the limit as received", async () => {
  const r = await apiWith(fixed(200, LIST)).list();
  assert.equal(r.kind, "listed");
  assert.equal(r.ok, true);
  assert.equal(r.message, "");
  assert.deepEqual(r.data, LIST);
});

test("get: 200 gives the note with its body", async () => {
  const note = { ...N1, body: BODY1 };
  const r = await apiWith(fixed(200, { note })).get("id-1");
  assert.equal(r.kind, "opened");
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { note });
});

test("a 200 answer of the wrong shape is a communication failure, for reading", async () => {
  const badLists = [null, "ok", 5, [], {}, { notes: null, limit: 200 }, { notes: {}, limit: 200 }, { notes: [] }, { notes: [], limit: "200" }, { notes: [], limit: 0 }, { notes: [], limit: 1.5 }, { notes: [null], limit: 200 }, { notes: [{ title: "x" }], limit: 200 }, { notes: [{ id: "" }], limit: 200 }, { notes: [{ id: 5 }], limit: 200 }];
  for (const json of badLists) assert.equal((await apiWith(fixed(200, json)).list()).kind, "network", JSON.stringify(json));
  const badNotes = [null, "ok", 5, {}, { note: null }, { note: "x" }, { note: { id: "id-1" } }, { note: { id: "id-1", body: 5 } }, { note: { body: "x" } }, { note: { id: "", body: "x" } }];
  for (const json of badNotes) assert.equal((await apiWith(fixed(200, json)).get("id-1")).kind, "network", JSON.stringify(json));
});

test("a broken JSON body on a 200 is a communication failure, for reading", async () => {
  for (const op of ["list", "get"]) {
    const r = await apiWith(fixed(200, null, { jsonThrows: true }))[op]("id-1");
    assert.equal(r.kind, "network");
    assert.equal(r.message, MSG.network);
    assert.equal(r.retry, true);
  }
});

test("a note with an empty body is still a note", async () => {
  const r = await apiWith(fixed(200, { note: { ...N1, body: "" } })).get("id-1");
  assert.equal(r.kind, "opened");
});

// ---------- deleting: every status ----------

const DELETE_TABLE = [
  [401, "unauthorized", true, false, MSG.unauthorized],
  [403, "forbidden", false, false, MSG.forbidden],
  [400, "app_problem", false, false, MSG.app_problem],
  [405, "app_problem", false, false, MSG.app_problem],
  [415, "app_problem", false, false, MSG.app_problem],
  [422, "app_problem", false, false, MSG.app_problem],
  [429, "rate_limited", true, false, MSG.rate_limited],
  [503, "unavailable", true, false, MSG.unavailable],
  // The outcome is unknown, so nothing may be sent again: only "update the list" is offered.
  [500, "delete_unknown", false, true, MSG.delete_unknown],
  [502, "delete_unknown", false, true, MSG.delete_unknown],
  [504, "delete_unknown", false, true, MSG.delete_unknown],
  [599, "delete_unknown", false, true, MSG.delete_unknown],
  [204, "delete_unknown", false, true, MSG.delete_unknown],
  [301, "delete_unknown", false, true, MSG.delete_unknown],
];

for (const op of ["remove", "removeAll"]) {
  for (const [status, kind, retry, refresh, message] of DELETE_TABLE) {
    test(`${op}: status ${status} gives "${kind}" with the agreed message and actions`, async () => {
      const r = await apiWith(fixed(status, { error: "x" }))[op]("id-1");
      assert.equal(r.kind, kind);
      assert.equal(r.message, message);
      assert.equal(r.retry, retry);
      assert.equal(r.refresh, refresh);
      assert.equal(r.ok, false);
    });
  }
}

test("remove: 404 is 'already deleted', which counts as a success", async () => {
  const r = await apiWith(fixed(404, { error: "not_found" })).remove("id-1");
  assert.equal(r.kind, "already_deleted");
  assert.equal(r.ok, true);
  assert.equal(r.message, MSG.already_deleted);
  assert.equal(r.retry, false);
  assert.equal(r.refresh, false);
});

test("removeAll: 404 is not 'already deleted'; it is the app-problem message", async () => {
  const r = await apiWith(fixed(404, {})).removeAll();
  assert.equal(r.kind, "app_problem");
  assert.equal(r.ok, false);
});

test("remove: a 200 is a success whatever the body looks like", async () => {
  for (const options of [{ json: { deleted: true } }, { json: null }, { json: "ok" }, { json: { deleted: "yes" } }, { json: {}, jsonThrows: true }, { json: {}, jsonHangs: true }]) {
    const r = await apiWith(fixed(200, options.json, options)).remove("id-1");
    assert.equal(r.kind, "deleted", JSON.stringify(options));
    assert.equal(r.ok, true);
    assert.equal(r.message, MSG.deleted);
  }
});

test("removeAll: a 200 is a success, with the count when it can be read as a number", async () => {
  const withCount = await apiWith(fixed(200, { deleted: 7 })).removeAll();
  assert.equal(withCount.kind, "deleted");
  assert.equal(withCount.message, "7 件削除しました");
  assert.equal(withCount.count, 7);
  const zero = await apiWith(fixed(200, { deleted: 0 })).removeAll();
  assert.equal(zero.message, "0 件削除しました");
  for (const json of [null, "ok", {}, { deleted: true }, { deleted: "7" }, { deleted: -1 }, { deleted: 1.5 }, { deleted: null }]) {
    const r = await apiWith(fixed(200, json)).removeAll();
    assert.equal(r.kind, "deleted", JSON.stringify(json));
    assert.equal(r.ok, true);
    assert.equal(r.message, MSG.deleted, JSON.stringify(json));
    assert.equal(r.count, undefined);
  }
  const broken = await apiWith(fixed(200, null, { jsonThrows: true })).removeAll();
  assert.equal(broken.kind, "deleted");
  assert.equal(broken.message, MSG.deleted);
});

test("removeAll: a body that never arrives after a 200 is still a success (the count is just missing)", async () => {
  const started = Date.now();
  const r = await apiWith(fixed(200, null, { jsonHangs: true }), { countTimeoutMs: 30 }).removeAll();
  assert.equal(r.kind, "deleted");
  assert.equal(r.message, MSG.deleted);
  assert.ok(Date.now() - started < 2000);
});

// ---------- communication failures ----------

test("a failing fetch: 'network' when reading, 'delete_unknown' when deleting; never a throw", async () => {
  const failing = async () => {
    throw new TypeError("Failed to fetch");
  };
  const a = apiWith(failing);
  for (const r of [await a.list(), await a.get("id-1")]) {
    assert.equal(r.kind, "network");
    assert.equal(r.message, MSG.network);
    assert.equal(r.retry, true);
    assert.equal(r.refresh, false);
  }
  for (const r of [await a.remove("id-1"), await a.removeAll()]) {
    assert.equal(r.kind, "delete_unknown");
    assert.equal(r.message, MSG.delete_unknown);
    assert.equal(r.retry, false);
    assert.equal(r.refresh, true);
  }
  const syncThrow = apiWith(() => {
    throw new Error("sync");
  });
  assert.equal((await syncThrow.list()).kind, "network");
  assert.equal((await syncThrow.remove("id-1")).kind, "delete_unknown");
});

test("a request that never answers is cut off by the timeout, even if the fetch ignores the abort signal", async () => {
  const started = Date.now();
  const a = apiWith(() => new Promise(() => {}), { timeoutMs: 30 });
  assert.equal((await a.list()).kind, "network");
  assert.equal((await a.get("id-1")).kind, "network");
  assert.equal((await a.remove("id-1")).kind, "delete_unknown");
  assert.equal((await a.removeAll()).kind, "delete_unknown");
  assert.ok(Date.now() - started < 3000);
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
  const r = await apiWith(f, { timeoutMs: 30 }).list();
  assert.equal(r.kind, "network");
  assert.equal(aborted, true);
});

test("a read body that never finishes arriving is cut off by the timeout", async () => {
  const r = await apiWith(fixed(200, null, { jsonHangs: true }), { timeoutMs: 30 }).list();
  assert.equal(r.kind, "network");
});

test("a late failure after the timeout does not become an unhandled rejection", async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const f = () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late")), 80));
    assert.equal((await apiWith(f, { timeoutMs: 20 }).list()).kind, "network");
    assert.equal((await apiWith(f, { timeoutMs: 20 }).remove("id-1")).kind, "delete_unknown");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("a fast answer is not turned into a failure by the timer", async () => {
  assert.equal((await apiWith(fixed(200, LIST), { timeoutMs: 5000 }).list()).kind, "listed");
});

// ---------- nothing private in a message ----------

test("no message contains the title, the body or the token", async () => {
  const texts = [
    ...Object.values(RESULTS).map((r) => r.message),
    BUSY_MESSAGE,
    EMPTY_LIST_MESSAGE,
    NO_TITLE_TEXT,
    TRUNCATED_MARK,
    UNKNOWN_DATE_TEXT,
  ];
  const note = { ...N1, body: BODY1 };
  const secret = async () => {
    throw new Error(`${TOKEN} ${BODY1} ${N1.title}`);
  };
  for (const op of ["list", "get", "remove", "removeAll"]) {
    for (const [status] of [...READ_TABLE, ...DELETE_TABLE]) {
      texts.push((await apiWith(fixed(status, { error: "架空のタイトル", message: BODY1 }))[op]("id-1")).message);
    }
    texts.push((await apiWith(secret)[op]("id-1")).message);
  }
  texts.push((await apiWith(fixed(200, { note })).get("id-1")).message);
  for (const text of texts) {
    assert.equal(text.includes("架空"), false);
    assert.equal(text.includes(TOKEN), false);
  }
});

test("the text of an error response is never read or shown", async () => {
  let read = false;
  const f = server(() => ({
    status: 500,
    ok: false,
    async json() {
      read = true;
      return { error: "secret detail" };
    },
  }));
  const r = await apiWith(f).list();
  assert.equal(read, false);
  assert.equal(r.message.includes("secret"), false);
});

// ---------- dates ----------

class FakeDateTimeFormat {
  static instances = [];
  constructor(locale, options) {
    this.locale = locale;
    this.options = options;
    this.formatted = [];
    FakeDateTimeFormat.instances.push(this);
  }
  format(date) {
    this.formatted.push(date);
    return `D:${date.getTime()}`;
  }
}

test("a date is formatted with Intl.DateTimeFormat for ja-JP, from the milliseconds as a Date", () => {
  FakeDateTimeFormat.instances.length = 0;
  assert.equal(formatDateTime(1700000000000, FakeDateTimeFormat), "D:1700000000000");
  const [instance] = FakeDateTimeFormat.instances;
  assert.equal(instance.locale, "ja-JP");
  assert.equal(typeof instance.options, "object");
  assert.equal(instance.formatted.length, 1);
  assert.ok(instance.formatted[0] instanceof Date);
  assert.equal(instance.formatted[0].getTime(), 1700000000000);
  assert.ok(!("timeZone" in instance.options), "the device's own time zone is used");
});

test("a date that cannot be formatted is 'unknown'", () => {
  assert.equal(UNKNOWN_DATE_TEXT, "日時不明");
  FakeDateTimeFormat.instances.length = 0;
  for (const value of [undefined, null, "1700000000000", NaN, Infinity, {}, [], true]) {
    assert.equal(formatDateTime(value, FakeDateTimeFormat), "日時不明", String(value));
  }
  assert.equal(FakeDateTimeFormat.instances.length, 0, "nothing is formatted for a value that is not a number");

  class Throwing {
    format() {
      throw new RangeError("Invalid time value");
    }
  }
  assert.equal(formatDateTime(1700000000000, Throwing), "日時不明");
  class ThrowingConstructor {
    constructor() {
      throw new RangeError("bad locale");
    }
  }
  assert.equal(formatDateTime(1700000000000, ThrowingConstructor), "日時不明");
  class Empty {
    format() {
      return "";
    }
  }
  assert.equal(formatDateTime(1700000000000, Empty), "日時不明");
  class NotText {
    format() {
      return 5;
    }
  }
  assert.equal(formatDateTime(1700000000000, NotText), "日時不明");
});

test("with the real Intl, a valid time is formatted and an out-of-range one is 'unknown' (no time zone assumed)", () => {
  const ok = formatDateTime(1700000000000);
  assert.equal(typeof ok, "string");
  assert.ok(ok.length > 0 && ok !== "日時不明");
  assert.equal(formatDateTime(1e20), "日時不明");
  assert.equal(formatDateTime(8.64e15 + 1), "日時不明");
});

// ---------- the panel ----------

function makePanel(handler, { token = TOKEN, apiOptions = {} } = {}) {
  const f = server(handler);
  const tokenBox = { value: token };
  const views = [];
  const panel = createNotesPanel({
    api: createNotesApi({ getIdToken: () => tokenBox.value, fetchImpl: f, ...apiOptions }),
    onChange: (view) => views.push(view),
    DateTimeFormat: FakeDateTimeFormat,
  });
  return { panel, f, calls: f.calls, views, tokenBox };
}

// The usual server: a list of two notes, and the first one can be opened.
function usual({ list = LIST, del } = {}) {
  return ({ url, method }) => {
    if (method === "GET" && url === "/api/notes") return resp(200, list);
    if (method === "GET" && url === "/api/notes/id-1") return resp(200, { note: { ...N1, body: BODY1 } });
    if (method === "GET" && url === "/api/notes/id-2") return resp(200, { note: { ...N2, body: "<img src=x onerror=alert(1)>" } });
    if (method === "DELETE" && del) return del(url);
    if (method === "DELETE" && url.startsWith("/api/notes?confirm=")) return resp(200, { deleted: 2 });
    if (method === "DELETE") return resp(200, { deleted: true });
    return resp(500, {});
  };
}
const gets = (calls) => calls.filter((c) => c.method === "GET").map((c) => c.url);
const deletes = (calls) => calls.filter((c) => c.method === "DELETE").map((c) => c.url);

test("a new panel is closed and empty, and nothing has been requested", () => {
  const { panel, calls } = makePanel(usual());
  const v = panel.getView();
  assert.equal(v.open, false);
  assert.equal(v.busy, false);
  assert.equal(v.list, null);
  assert.equal(v.detail, null);
  assert.equal(v.confirm, null);
  assert.equal(v.status.message, "");
  assert.equal(calls.length, 0);
});

test("opening asks for the list once, and shows the count, dates, titles and the 'partial' mark", async () => {
  FakeDateTimeFormat.instances.length = 0;
  const { panel, calls } = makePanel(usual());
  const done = panel.open();
  assert.equal(panel.getView().open, true);
  assert.equal(panel.getView().busy, true);
  assert.equal(panel.getView().busyText, BUSY_MESSAGE);
  await done;
  assert.deepEqual(gets(calls), ["/api/notes"]);
  const v = panel.getView();
  assert.equal(v.busy, false);
  assert.equal(v.screen, "list");
  assert.equal(v.list.countText, "2 / 200 件");
  assert.equal(v.list.emptyText, "");
  assert.equal(v.list.showDeleteAll, true);
  assert.deepEqual(v.list.items, [
    { id: "id-1", dateText: "D:1700000000000", titleText: "架空のタイトル", truncatedMark: "" },
    { id: "id-2", dateText: "D:1700000100000", titleText: "（タイトルなし）", truncatedMark: "（途中まで）" },
  ]);
  assert.equal(NO_TITLE_TEXT, "（タイトルなし）");
  assert.equal(TRUNCATED_MARK, "（途中まで）");
  assert.equal(v.status.message, "");
});

test("the count uses the limit of the answer, and a title that is not text counts as no title", async () => {
  const { panel } = makePanel(usual({ list: { notes: [{ ...N1, title: 5 }], limit: 150 } }));
  await panel.open();
  assert.equal(panel.getView().list.countText, "1 / 150 件");
  assert.equal(panel.getView().list.items[0].titleText, "（タイトルなし）");
});

test("a note whose time cannot be shown says so, and 'truncated' is only believed when it is exactly true", async () => {
  const notes = [{ ...N1, created_at: "x", truncated: 1 }, { ...N2, created_at: 1e20, truncated: "true" }];
  const { panel } = makePanel(usual({ list: { notes, limit: 200 } }));
  await panel.open();
  const items = panel.getView().list.items;
  assert.equal(items[0].dateText, "日時不明");
  assert.equal(items[1].dateText, "日時不明");
  assert.equal(items[0].truncatedMark, "");
  assert.equal(items[1].truncatedMark, "");
});

test("no notes: the empty message, '0 / 200', and no delete-all button", async () => {
  const { panel } = makePanel(usual({ list: { notes: [], limit: 200 } }));
  await panel.open();
  const v = panel.getView();
  assert.equal(v.list.countText, "0 / 200 件");
  assert.equal(v.list.emptyText, "保存されたメモはありません");
  assert.equal(EMPTY_LIST_MESSAGE, "保存されたメモはありません");
  assert.equal(v.list.items.length, 0);
  assert.equal(v.list.showDeleteAll, false);
  assert.equal(v.canAskDeleteAll, false);
});

test("opening twice sends one request; nothing is requested on its own afterwards", async () => {
  const { panel, calls } = makePanel(usual());
  const a = panel.open();
  const b = panel.open();
  await Promise.all([a, b]);
  await panel.open();
  assert.equal(calls.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, 1, "no refresh on a timer");
});

test("update asks for the list again, once, and is ignored while busy", async () => {
  const gate = deferred();
  let n = 0;
  const { panel, calls } = makePanel(({ url, method }) => (method === "GET" && url === "/api/notes" && ++n === 2 ? gate.promise : resp(200, LIST)));
  await panel.open();
  const a = panel.refresh();
  const b = panel.refresh();
  const c = panel.refresh();
  assert.equal(calls.length, 2, "one request for three presses");
  assert.equal(panel.getView().busy, true);
  gate.resolve(resp(200, { notes: [N1], limit: 200 }));
  await Promise.all([a, b, c]);
  assert.equal(calls.length, 2);
  assert.equal(panel.getView().list.items.length, 1);
});

test("refresh does nothing while the panel is closed", async () => {
  const { panel, calls } = makePanel(usual());
  await panel.refresh();
  await panel.select("id-1");
  await panel.back();
  await panel.retry();
  assert.equal(calls.length, 0);
  assert.equal(panel.getView().open, false);
});

test("pressing a note asks for that one note once, shows its title, time, mark and body, and keeps the list", async () => {
  const { panel, calls } = makePanel(usual());
  await panel.open();
  assert.deepEqual(gets(calls), ["/api/notes"], "the bodies are not read ahead");
  const a = panel.select("id-1");
  const b = panel.select("id-1");
  const c = panel.select("id-2");
  assert.equal(calls.length, 2, "one request for three presses");
  await Promise.all([a, b, c]);
  assert.deepEqual(gets(calls), ["/api/notes", "/api/notes/id-1"]);
  const v = panel.getView();
  assert.equal(v.screen, "detail");
  assert.deepEqual(
    { ...v.detail, version: undefined },
    { id: "id-1", titleText: "架空のタイトル", dateText: "D:1700000000000", truncatedMark: "", body: BODY1, version: undefined },
  );
  assert.equal(v.list.items.length, 2, "the list stays in memory behind it");
});

test("an unknown note id is ignored", async () => {
  const { panel, calls } = makePanel(usual());
  await panel.open();
  for (const id of ["nope", "", undefined, null, 5]) await panel.select(id);
  assert.equal(calls.length, 1);
  assert.equal(panel.getView().screen, "list");
});

test("a note with HTML-like text is kept as plain text, exactly", async () => {
  const { panel } = makePanel(usual());
  await panel.open();
  await panel.select("id-2");
  assert.equal(panel.getView().detail.body, "<img src=x onerror=alert(1)>");
  assert.equal(panel.getView().detail.truncatedMark, "（途中まで）");
  assert.equal(panel.getView().detail.titleText, "（タイトルなし）");
});

test("back to the list throws the body away, uses the list already received, and asks for nothing", async () => {
  const { panel, calls } = makePanel(usual());
  await panel.open();
  await panel.select("id-1");
  const before = panel.getView();
  assert.ok(JSON.stringify(before).includes("架空の発言"));
  await panel.back();
  const v = panel.getView();
  assert.equal(v.screen, "list");
  assert.equal(v.detail, null);
  assert.equal(v.list.items.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(v).includes("架空の発言"), false, "the body is gone from what the panel holds");
  assert.notEqual(v.detailVersion, before.detailVersion, "the page is told that the body changed");
});

test("closing throws away the list, the body and the confirmation, and a new opening asks again", async () => {
  const { panel, calls } = makePanel(usual());
  await panel.open();
  await panel.select("id-1");
  await panel.askDeleteOne();
  assert.ok(panel.getView().confirm);
  panel.close();
  const v = panel.getView();
  assert.equal(v.open, false);
  assert.equal(v.list, null);
  assert.equal(v.detail, null);
  assert.equal(v.confirm, null);
  assert.equal(v.busy, false);
  assert.equal(JSON.stringify(v).includes("架空"), false);
  await panel.open();
  assert.deepEqual(gets(calls), ["/api/notes", "/api/notes/id-1", "/api/notes"]);
  assert.equal(panel.getView().screen, "list", "it starts at the list again");
  assert.equal(panel.getView().confirm, null);
  assert.equal(deletes(calls).length, 0);
});

test("the list version changes when the list changes, so the page redraws only then", async () => {
  const { panel } = makePanel(usual());
  const v0 = panel.getView().listVersion;
  await panel.open();
  const v1 = panel.getView().listVersion;
  assert.notEqual(v1, v0);
  await panel.select("id-1");
  assert.equal(panel.getView().listVersion, v1, "opening a note does not touch the list");
  await panel.back();
  assert.equal(panel.getView().listVersion, v1);
  await panel.refresh();
  assert.notEqual(panel.getView().listVersion, v1);
});

// ---------- the panel: old results ----------

test("a result that arrives after the panel was closed changes nothing on screen", async () => {
  const gate = deferred();
  const { panel, views } = makePanel(() => gate.promise);
  const pending = panel.open();
  panel.close();
  const shown = views.length;
  gate.resolve(resp(200, LIST));
  await pending;
  const v = panel.getView();
  assert.equal(v.open, false);
  assert.equal(v.list, null);
  assert.equal(v.busy, false);
  assert.equal(views.length, shown, "nothing was drawn for the old result");
});

test("an old failure after closing shows no message either", async () => {
  const gate = deferred();
  const { panel } = makePanel(() => gate.promise);
  const pending = panel.open();
  panel.close();
  gate.resolve(resp(503, {}));
  await pending;
  assert.equal(panel.getView().status.message, "");
});

test("an old result that arrives after a newer opening does not replace the newer one", async () => {
  const gates = [];
  const { panel } = makePanel(() => {
    const g = deferred();
    gates.push(g);
    return g.promise;
  });
  const first = panel.open();
  panel.close();
  const second = panel.open();
  assert.equal(gates.length, 2);
  gates[1].resolve(resp(200, { notes: [N2], limit: 200 })); // the new one first
  await second;
  gates[0].resolve(resp(200, { notes: [N1, N2], limit: 200 })); // then the old one
  await first;
  assert.equal(panel.getView().list.items.length, 1);
  assert.equal(panel.getView().list.items[0].id, "id-2");
  assert.equal(panel.getView().busy, false);
});

test("a note that arrives after the panel was closed is not shown and not kept", async () => {
  const gate = deferred();
  const { panel } = makePanel(({ url }) => (url === "/api/notes/id-1" ? gate.promise : resp(200, LIST)));
  await panel.open();
  const pending = panel.select("id-1");
  panel.close();
  gate.resolve(resp(200, { note: { ...N1, body: BODY1 } }));
  await pending;
  assert.equal(panel.getView().detail, null);
  assert.equal(JSON.stringify(panel.getView()).includes("架空"), false);
});

// ---------- the panel: deleting one note ----------

test("deleting one: the confirmation comes first, 'cancel' sends nothing, and the text is as agreed", async () => {
  const { panel, calls } = makePanel(usual());
  await panel.open();
  await panel.select("id-1");
  assert.equal(panel.getView().canAskDeleteOne, true);
  await panel.askDeleteOne();
  let v = panel.getView();
  assert.deepEqual(v.confirm, {
    kind: "one",
    text: "このメモを削除します。元に戻せません。",
    yesLabel: "削除する",
    noLabel: "やめる",
  });
  assert.equal(v.canAskDeleteOne, false, "the button is replaced by the question");
  assert.equal(deletes(calls).length, 0, "nothing is sent before the answer");
  await panel.cancelConfirm();
  v = panel.getView();
  assert.equal(v.confirm, null);
  assert.equal(v.canAskDeleteOne, true);
  assert.equal(v.screen, "detail");
  assert.equal(deletes(calls).length, 0);
});

test("deleting one: after 'delete' exactly one DELETE is sent; then 'deleted' is shown and the list is asked for again", async () => {
  const { panel, calls } = makePanel(usual());
  await panel.open();
  await panel.select("id-1");
  await panel.askDeleteOne();
  await panel.confirmDelete();
  assert.deepEqual(deletes(calls), ["/api/notes/id-1"]);
  assert.equal(calls.find((c) => c.method === "DELETE").init.body, undefined);
  assert.deepEqual(gets(calls), ["/api/notes", "/api/notes/id-1", "/api/notes"], "the list was asked for again");
  const v = panel.getView();
  assert.equal(v.screen, "list");
  assert.equal(v.detail, null);
  assert.equal(v.confirm, null);
  assert.equal(v.status.message, "削除しました");
  assert.equal(v.status.showRetry, false);
  assert.equal(v.busy, false);
});

test("deleting one: pressing 'delete' twice, and pressing other buttons meanwhile, sends one request", async () => {
  const gate = deferred();
  const { panel, calls } = makePanel(usual({ del: () => gate.promise }));
  await panel.open();
  await panel.select("id-1");
  await panel.askDeleteOne();
  const a = panel.confirmDelete();
  const b = panel.confirmDelete();
  const c = panel.confirmDelete();
  await panel.cancelConfirm();
  await panel.back();
  await panel.refresh();
  assert.equal(deletes(calls).length, 1);
  const v = panel.getView();
  assert.equal(v.busy, true);
  assert.ok(v.confirm, "the question stays, with its buttons disabled by the page");
  assert.equal(v.screen, "detail");
  gate.resolve(resp(200, { deleted: true }));
  await Promise.all([a, b, c]);
  assert.equal(deletes(calls).length, 1);
  assert.equal(panel.getView().status.message, "削除しました");
});

test("deleting is never sent without a confirmation, whatever else is pressed", async () => {
  const { panel, calls } = makePanel(usual());
  await panel.confirmDelete(); // closed
  await panel.open();
  await panel.confirmDelete(); // list, nothing asked
  await panel.select("id-1");
  await panel.confirmDelete(); // detail, nothing asked
  await panel.askDeleteOne();
  await panel.cancelConfirm();
  await panel.confirmDelete(); // asked and cancelled
  assert.equal(deletes(calls).length, 0);
});

test("deleting one: 404 is 'already deleted', handled like a success, and the list is asked for again", async () => {
  const { panel, calls } = makePanel(usual({ del: () => resp(404, { error: "not_found" }) }));
  await panel.open();
  await panel.select("id-1");
  await panel.askDeleteOne();
  await panel.confirmDelete();
  assert.equal(panel.getView().status.message, "すでに削除されています");
  assert.equal(panel.getView().status.showRetry, false);
  assert.equal(panel.getView().status.showRefresh, false);
  assert.equal(panel.getView().screen, "list");
  assert.deepEqual(gets(calls), ["/api/notes", "/api/notes/id-1", "/api/notes"]);
});

test("deleting one: a 200 with a broken body is a success", async () => {
  const { panel, calls } = makePanel(usual({ del: () => resp(200, null, { jsonThrows: true }) }));
  await panel.open();
  await panel.select("id-1");
  await panel.askDeleteOne();
  await panel.confirmDelete();
  assert.equal(panel.getView().status.message, "削除しました");
  assert.equal(gets(calls).length, 3);
});

test("deleting one: if the list cannot be fetched again, that failure is shown, and 'try again' asks for the list, not for another delete", async () => {
  let listCalls = 0;
  const { panel, calls } = makePanel(({ url, method }) => {
    if (method === "GET" && url === "/api/notes") return ++listCalls === 2 ? resp(503, {}) : resp(200, LIST);
    if (method === "GET") return resp(200, { note: { ...N1, body: BODY1 } });
    return resp(200, { deleted: true });
  });
  await panel.open();
  await panel.select("id-1");
  await panel.askDeleteOne();
  await panel.confirmDelete();
  assert.equal(panel.getView().status.message, MSG.unavailable);
  assert.equal(panel.getView().status.showRetry, true);
  await panel.retry();
  assert.equal(deletes(calls).length, 1, "the note is not deleted a second time");
  assert.equal(gets(calls).filter((u) => u === "/api/notes").length, 3);
  assert.equal(panel.getView().status.message, "");
  assert.equal(panel.getView().list.items.length, 2);
});

// ---------- the panel: deleting everything ----------

test("deleting everything: the question names the number on screen; nothing is sent, and the confirm value is not used, before the answer", async () => {
  const { panel, calls } = makePanel(usual());
  await panel.open();
  assert.equal(panel.getView().canAskDeleteAll, true);
  await panel.askDeleteAll();
  const v = panel.getView();
  assert.deepEqual(v.confirm, {
    kind: "all",
    text: "表示中の 2 件のメモをすべて削除します。元に戻せません。",
    yesLabel: "すべて削除する",
    noLabel: "やめる",
  });
  assert.equal(calls.filter((c) => c.url.includes("confirm")).length, 0);
  assert.equal(deletes(calls).length, 0);
  await panel.cancelConfirm();
  assert.equal(panel.getView().confirm, null);
  assert.equal(calls.length, 1, "only the list was ever asked for");
});

test("deleting everything: after the answer one DELETE with the confirm value; the count is shown and the list is empty without a new request", async () => {
  const { panel, calls } = makePanel(usual());
  await panel.open();
  await panel.askDeleteAll();
  await panel.confirmDelete();
  assert.deepEqual(deletes(calls), ["/api/notes?confirm=delete-all"]);
  assert.equal(calls.length, 2, "the list is not asked for again");
  const v = panel.getView();
  assert.equal(v.status.message, "2 件削除しました");
  assert.equal(v.confirm, null);
  assert.equal(v.list.items.length, 0);
  assert.equal(v.list.countText, "0 / 200 件");
  assert.equal(v.list.emptyText, "保存されたメモはありません");
  assert.equal(v.list.showDeleteAll, false);
  assert.equal(v.screen, "list");
});

test("deleting everything: a count that cannot be read gives 'deleted' without a number", async () => {
  const { panel } = makePanel(usual({ del: () => resp(200, { deleted: "many" }) }));
  await panel.open();
  await panel.askDeleteAll();
  await panel.confirmDelete();
  assert.equal(panel.getView().status.message, "削除しました");
  assert.equal(panel.getView().list.items.length, 0);
});

test("deleting everything: pressing twice sends one request", async () => {
  const gate = deferred();
  const { panel, calls } = makePanel(usual({ del: () => gate.promise }));
  await panel.open();
  await panel.askDeleteAll();
  const a = panel.confirmDelete();
  const b = panel.confirmDelete();
  assert.equal(deletes(calls).length, 1);
  gate.resolve(resp(200, { deleted: 2 }));
  await Promise.all([a, b]);
  assert.equal(deletes(calls).length, 1);
});

test("asking with no notes on screen does nothing", async () => {
  const { panel } = makePanel(usual({ list: { notes: [], limit: 200 } }));
  await panel.open();
  await panel.askDeleteAll();
  assert.equal(panel.getView().confirm, null);
});

test("closing while the question is on screen cancels it; a delete still on its way is not shown", async () => {
  const gate = deferred();
  const { panel, calls } = makePanel(usual({ del: () => gate.promise }));
  await panel.open();
  await panel.askDeleteAll();
  panel.close();
  assert.equal(panel.getView().confirm, null);
  await panel.confirmDelete();
  assert.equal(deletes(calls).length, 0, "after closing, the old question cannot be answered");

  await panel.open();
  await panel.askDeleteAll();
  const pending = panel.confirmDelete();
  assert.equal(deletes(calls).length, 1);
  panel.close();
  gate.resolve(resp(200, { deleted: 2 }));
  await pending;
  assert.equal(panel.getView().open, false);
  assert.equal(panel.getView().status.message, "");
  assert.equal(panel.getView().list, null);
});

// ---------- the panel: failures ----------

test("a failed opening shows the message with the agreed actions, and 'try again' sends the same request once more", async () => {
  const answers = [resp(401, {}), resp(200, LIST)];
  const { panel, calls } = makePanel(() => answers.shift());
  await panel.open();
  let v = panel.getView();
  assert.equal(v.status.message, MSG.unauthorized);
  assert.equal(v.status.showRetry, true);
  assert.equal(v.status.showRefresh, false);
  assert.equal(v.list, null);
  assert.equal(calls.length, 1, "no automatic retry");
  await panel.retry();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "/api/notes");
  v = panel.getView();
  assert.equal(v.status.message, "");
  assert.equal(v.status.showRetry, false);
  assert.equal(v.list.items.length, 2);
});

test("no ID token: the sign-in message and 'try again'; nothing is sent; after signing in 'try again' works", async () => {
  const { panel, calls, tokenBox } = makePanel(usual(), { token: null });
  await panel.open();
  assert.equal(calls.length, 0);
  assert.equal(panel.getView().status.message, MSG.no_token);
  assert.equal(panel.getView().status.showRetry, true);
  tokenBox.value = TOKEN; // signed in
  await panel.retry();
  assert.equal(calls.length, 1);
  assert.equal(panel.getView().list.items.length, 2);
});

test("403: the message, and no action at all", async () => {
  const { panel } = makePanel(() => resp(403, {}));
  await panel.open();
  assert.equal(panel.getView().status.message, MSG.forbidden);
  assert.equal(panel.getView().status.showRetry, false);
  assert.equal(panel.getView().status.showRefresh, false);
  await panel.retry();
  assert.equal(panel.getView().status.message, MSG.forbidden);
});

test("opening a note that is gone: the message and 'update the list'; the list stays where it is", async () => {
  const { panel, calls } = makePanel(({ url }) => (url === "/api/notes/id-1" ? resp(404, {}) : resp(200, LIST)));
  await panel.open();
  await panel.select("id-1");
  const v = panel.getView();
  assert.equal(v.status.message, MSG.not_found);
  assert.equal(v.status.showRetry, false);
  assert.equal(v.status.showRefresh, true);
  assert.equal(v.screen, "list");
  assert.equal(v.detail, null);
  await panel.refresh();
  assert.equal(calls.length, 3);
  assert.equal(panel.getView().status.message, "");
});

test("a failed opening of a note: 'try again' sends the same note request once more", async () => {
  let n = 0;
  const { panel, calls } = makePanel(({ url }) => {
    if (url === "/api/notes") return resp(200, LIST);
    return ++n === 1 ? resp(500, {}) : resp(200, { note: { ...N1, body: BODY1 } });
  });
  await panel.open();
  await panel.select("id-1");
  assert.equal(panel.getView().status.message, MSG.server_error);
  assert.equal(panel.getView().status.showRetry, true);
  await panel.retry();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, "/api/notes/id-1");
  assert.equal(panel.getView().screen, "detail");
  assert.equal(panel.getView().status.message, "");
});

test("'try again' while a request is on its way, or twice in a row, sends one request", async () => {
  const gate = deferred();
  const answers = [resp(429, {}), gate.promise];
  const { panel, calls } = makePanel(() => answers.shift());
  await panel.open();
  const a = panel.retry();
  const b = panel.retry();
  assert.equal(calls.length, 2);
  gate.resolve(resp(200, LIST));
  await Promise.all([a, b]);
  assert.equal(calls.length, 2);
});

test("every kind of failure of reading shows its message, with the agreed actions", async () => {
  for (const [status, kind, retry, refresh, message] of READ_TABLE) {
    const { panel } = makePanel(() => resp(status, {}));
    await panel.open();
    const s = panel.getView().status;
    assert.equal(s.message, message, `${status}`);
    assert.equal(s.showRetry, retry, `${status}`);
    assert.equal(s.showRefresh, refresh, `${kind}`);
  }
  const notFoundOnList = makePanel(() => resp(404, {}));
  await notFoundOnList.panel.open();
  assert.equal(notFoundOnList.panel.getView().status.message, MSG.app_problem);
});

test("a communication failure and a timeout, when reading, are the communication message with 'try again'", async () => {
  const failing = makePanel(() => {
    throw new TypeError("Failed to fetch");
  });
  await failing.panel.open();
  assert.equal(failing.panel.getView().status.message, MSG.network);
  assert.equal(failing.panel.getView().status.showRetry, true);

  const silent = makePanel(() => new Promise(() => {}), { apiOptions: { timeoutMs: 30 } });
  await silent.panel.open();
  assert.equal(silent.panel.getView().status.message, MSG.network);
  assert.equal(silent.panel.getView().status.showRetry, true);
  assert.equal(silent.panel.getView().busy, false);
});

test("the next action clears the message: open, update, press a note, back to the list", async () => {
  const failOnce = (match) => {
    let failed = false;
    return ({ url, method }) => {
      if (!failed && match(url, method)) {
        failed = true;
        return resp(500, {});
      }
      return usual()({ url, method });
    };
  };
  // update clears it
  let t = makePanel(failOnce((url) => url === "/api/notes"));
  await t.panel.open();
  assert.equal(t.panel.getView().status.message, MSG.server_error);
  await t.panel.refresh();
  assert.equal(t.panel.getView().status.message, "");

  // opening again after closing clears it
  t = makePanel(failOnce((url) => url === "/api/notes"));
  await t.panel.open();
  t.panel.close();
  assert.equal(t.panel.getView().status.message, "");
  await t.panel.open();
  assert.equal(t.panel.getView().status.message, "");

  // pressing a note clears it (the failed message belongs to the previous action)
  t = makePanel(failOnce((url) => url === "/api/notes/id-1"));
  await t.panel.open();
  await t.panel.select("id-1");
  assert.equal(t.panel.getView().status.message, MSG.server_error);
  await t.panel.select("id-2");
  assert.equal(t.panel.getView().status.message, "");

  // back to the list clears it
  t = makePanel(usual({ del: () => resp(500, {}) }));
  await t.panel.open();
  await t.panel.select("id-1");
  await t.panel.askDeleteOne();
  await t.panel.confirmDelete();
  assert.equal(t.panel.getView().status.message, MSG.delete_unknown);
  await t.panel.back();
  assert.equal(t.panel.getView().status.message, "");
  assert.equal(t.panel.getView().status.showRefresh, false);
});

// ---------- the panel: failures of deleting ----------

async function failedDelete(status, { all = false } = {}) {
  const t = makePanel(usual({ del: () => (typeof status === "function" ? status() : resp(status, {})) }));
  await t.panel.open();
  if (all) {
    await t.panel.askDeleteAll();
  } else {
    await t.panel.select("id-1");
    await t.panel.askDeleteOne();
  }
  await t.panel.confirmDelete();
  return t;
}

test("a failed delete where nothing could have happened (401, 429, 503, no token) offers 'try again', which sends the delete once more", async () => {
  for (const [status, message] of [[401, MSG.unauthorized], [429, MSG.rate_limited], [503, MSG.unavailable]]) {
    for (const all of [false, true]) {
      const answers = [resp(status, {}), resp(200, { deleted: all ? 2 : true })];
      const t = makePanel(usual({ del: () => answers.shift() }));
      await t.panel.open();
      if (all) await t.panel.askDeleteAll();
      else {
        await t.panel.select("id-1");
        await t.panel.askDeleteOne();
      }
      await t.panel.confirmDelete();
      const s = t.panel.getView().status;
      assert.equal(s.message, message, `${status} ${all}`);
      assert.equal(s.showRetry, true);
      assert.equal(s.showRefresh, false);
      assert.equal(t.panel.getView().confirm, null, "the question is gone; the answer was already given");
      assert.equal(deletes(t.calls).length, 1);
      await t.panel.retry();
      assert.equal(deletes(t.calls).length, 2, `${status} ${all}: sent once more`);
      assert.equal(deletes(t.calls)[1], all ? "/api/notes?confirm=delete-all" : "/api/notes/id-1");
      assert.equal(t.panel.getView().status.showRetry, false);
    }
  }

  const noToken = makePanel(usual(), { token: TOKEN });
  await noToken.panel.open();
  await noToken.panel.select("id-1");
  await noToken.panel.askDeleteOne();
  noToken.tokenBox.value = null;
  await noToken.panel.confirmDelete();
  assert.equal(deletes(noToken.calls).length, 0, "nothing is sent without a token");
  assert.equal(noToken.panel.getView().status.message, MSG.no_token);
  assert.equal(noToken.panel.getView().status.showRetry, true);
  noToken.tokenBox.value = TOKEN;
  await noToken.panel.retry();
  assert.equal(deletes(noToken.calls).length, 1);
});

test("a failed delete whose outcome is unknown (communication failure, timeout, other 5xx) offers only 'update the list' and never sends again", async () => {
  const cases = [
    () => {
      throw new TypeError("Failed to fetch");
    },
    () => new Promise(() => {}),
    () => resp(500, {}),
    () => resp(502, {}),
    () => resp(504, {}),
  ];
  for (const handler of cases) {
    for (const all of [false, true]) {
      const t = makePanel(usual({ del: handler }), { apiOptions: { timeoutMs: 30 } });
      await t.panel.open();
      if (all) await t.panel.askDeleteAll();
      else {
        await t.panel.select("id-1");
        await t.panel.askDeleteOne();
      }
      await t.panel.confirmDelete();
      const s = t.panel.getView().status;
      assert.equal(s.message, MSG.delete_unknown);
      assert.equal(s.showRetry, false, "no 'try again'");
      assert.equal(s.showRefresh, true);
      await t.panel.retry();
      await t.panel.confirmDelete();
      assert.equal(deletes(t.calls).length, 1, "the delete was sent once, and never again");
      await t.panel.refresh();
      assert.equal(t.panel.getView().screen, "list", "'update the list' goes back to the list");
      assert.equal(t.panel.getView().detail, null);
      assert.equal(t.panel.getView().status.message, "");
      assert.equal(deletes(t.calls).length, 1);
    }
  }
});

test("a failed delete with 403, or an app problem: the message and nothing to press", async () => {
  for (const [status, message] of [[403, MSG.forbidden], [400, MSG.app_problem], [405, MSG.app_problem], [415, MSG.app_problem]]) {
    const t = await failedDelete(status);
    const s = t.panel.getView().status;
    assert.equal(s.message, message);
    assert.equal(s.showRetry, false);
    assert.equal(s.showRefresh, false);
    assert.equal(deletes(t.calls).length, 1);
  }
});

test("while a delete is on its way the page is told it is busy, and after any failure it is not", async () => {
  const t = await failedDelete(500);
  assert.equal(t.panel.getView().busy, false);
  assert.ok(t.views.some((v) => v.busy === true));
});

// ---------- the panel: private data ----------

test("no message in any view contains the title, the body or the token, and the panel never writes them anywhere", async () => {
  const statuses = [401, 403, 404, 429, 500, 503, 400];
  for (const status of statuses) {
    const t = makePanel(({ url, method }) => {
      if (method === "GET" && url === "/api/notes") return resp(200, LIST);
      return resp(status, { error: "架空のタイトル", message: BODY1 });
    });
    await t.panel.open();
    await t.panel.select("id-1");
    await t.panel.askDeleteOne();
    await t.panel.cancelConfirm();
    for (const v of t.views) {
      assert.equal(v.status.message.includes("架空"), false);
      assert.equal(v.status.message.includes(TOKEN), false);
      assert.equal(JSON.stringify(v).includes(TOKEN), false, "the token is never part of a view");
    }
  }
});

test("the panel survives a drawing callback that throws, and an api that throws", async () => {
  const f = server(usual());
  const panel = createNotesPanel({
    api: createNotesApi({ getIdToken: () => TOKEN, fetchImpl: f }),
    onChange: () => {
      throw new Error("draw");
    },
    DateTimeFormat: FakeDateTimeFormat,
  });
  await assert.doesNotReject(panel.open());
  assert.equal(panel.getView().list.items.length, 2);

  const broken = createNotesPanel({
    api: {
      list: () => {
        throw new Error("boom");
      },
      get: async () => {
        throw new Error("boom");
      },
      remove: () => Promise.reject(new Error("boom")),
      removeAll: () => null,
    },
    DateTimeFormat: FakeDateTimeFormat,
  });
  await assert.doesNotReject(broken.open());
  assert.equal(broken.getView().status.message, MSG.network);
  assert.equal(broken.getView().busy, false);
});

test("an api that answers with nonsense is shown as a communication failure, and for a delete as 'unknown'", async () => {
  const nonsense = [undefined, null, "x", 5, { message: 1 }, {}];
  for (const value of nonsense) {
    const panel = createNotesPanel({
      api: {
        list: async () => ({ kind: "listed", ok: true, retry: false, refresh: false, message: "", data: LIST }),
        get: async () => ({ kind: "opened", ok: true, retry: false, refresh: false, message: "", data: { note: { ...N1, body: BODY1 } } }),
        remove: async () => value,
        removeAll: async () => value,
      },
      DateTimeFormat: FakeDateTimeFormat,
    });
    await panel.open();
    await panel.select("id-1");
    await panel.askDeleteOne();
    await panel.confirmDelete();
    assert.equal(panel.getView().status.message, MSG.delete_unknown, JSON.stringify(value));
    assert.equal(panel.getView().status.showRetry, false);
    assert.equal(panel.getView().status.showRefresh, true);
  }
  const readNonsense = createNotesPanel({ api: { list: async () => 5, get: async () => 5, remove: async () => 5, removeAll: async () => 5 }, DateTimeFormat: FakeDateTimeFormat });
  await readNonsense.open();
  assert.equal(readNonsense.getView().status.message, MSG.network);
  assert.equal(readNonsense.getView().status.showRetry, true);
});

test("the panel and a conversation do not touch each other: the panel needs nothing but its api", async () => {
  // It takes no conversation, recorder or saver, so starting or ending a conversation cannot reach it.
  const { panel } = makePanel(usual());
  assert.deepEqual(Object.keys(panel).sort(), [
    "askDeleteAll", "askDeleteOne", "back", "cancelConfirm", "close", "confirmDelete", "getView", "open", "refresh", "retry", "select",
  ]);
});

// ---------- the module keeps to itself ----------

test("the new source has no storage, logging or HTML insertion, no page access and no imports", () => {
  const source = sourceOf("../frontend/notes-list-client.js");
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|\bconsole\b|innerHTML|outerHTML|insertAdjacentHTML|document\.write/i);
  assert.doesNotMatch(source, /\bdocument\b|\bwindow\b|\blocation\b|\bnavigator\b|\bconfirm\(|\balert\(|\bprompt\(/);
  assert.doesNotMatch(source, /^\s*import\s/m, "it imports nothing");
});
