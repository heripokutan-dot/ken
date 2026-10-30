// The notes panel's side of the notes API: list, open one, delete one, delete all. And the state of the panel.
//
// Nothing here touches the page. The page hands in what it has and draws what comes back through onChange.
// Nothing is written to browser storage or to any log. The text of a note (title, body) never appears in a
// message shown to the person, and the ID token never leaves the request header. An error never reaches the caller.
//
//   createNotesApi({ getIdToken })   one request per call; always resolves to a result (see RESULTS)
//     list()  get(id)  remove(id)  removeAll()
//   createNotesPanel({ api, onChange })   what is on screen: the list, the open note, the question, the message
//     open() close() refresh() select(id) back() askDeleteOne() askDeleteAll() confirmDelete() cancelConfirm() retry()
//     getView()   everything the page needs to draw, as plain data
//   formatDateTime(ms)   the time of a note, in the device's own time zone

export const REQUEST_TIMEOUT_MS = 15000;
export const COUNT_READ_TIMEOUT_MS = 2000; // after a 200 for "delete all": how long to wait for the count before giving up on it
export const DELETE_ALL_CONFIRM = "delete-all";

export const BUSY_MESSAGE = "通信中…";
export const EMPTY_LIST_MESSAGE = "保存されたメモはありません";
export const NO_TITLE_TEXT = "（タイトルなし）";
export const TRUNCATED_MARK = "（途中まで）";
export const UNKNOWN_DATE_TEXT = "日時不明";

const CONFIRM_ONE_TEXT = "このメモを削除します。元に戻せません。";
const CONFIRM_ONE_YES = "削除する";
const CONFIRM_ALL_YES = "すべて削除する";
const CONFIRM_NO = "やめる";

// kind -> what happened, whether "try again" is offered (retry), whether "update the list" is offered (refresh).
// ok is true for the answers that mean "done" (also "already deleted"). A message is empty when there is nothing to say.
export const RESULTS = {
  listed: { ok: true, retry: false, refresh: false, message: "" },
  opened: { ok: true, retry: false, refresh: false, message: "" },
  deleted: { ok: true, retry: false, refresh: false, message: "削除しました" },
  already_deleted: { ok: true, retry: false, refresh: false, message: "すでに削除されています" },
  unauthorized: {
    ok: false,
    retry: true,
    refresh: false,
    message: "ログインの期限が切れました。もう一度サインインしてから、もう一度試してください。",
  },
  no_token: { ok: false, retry: true, refresh: false, message: "サインインしてから、もう一度試してください。" },
  forbidden: { ok: false, retry: false, refresh: false, message: "アクセスが許可されていません" },
  not_found: {
    ok: false,
    retry: false,
    refresh: true,
    message: "このメモは見つかりませんでした（すでに削除された可能性があります）",
  },
  app_problem: { ok: false, retry: false, refresh: false, message: "できませんでした（アプリの不具合の可能性があります）" },
  rate_limited: {
    ok: false,
    retry: true,
    refresh: false,
    message: "操作が多すぎます。1分ほど待ってから、もう一度試してください。",
  },
  unavailable: {
    ok: false,
    retry: true,
    refresh: false,
    message: "サーバーの設定が足りないか、一時的に使えません。少し待ってから、もう一度試してください。",
  },
  server_error: {
    ok: false,
    retry: true,
    refresh: false,
    message: "サーバーでエラーが起きました。少し待ってから、もう一度試してください。",
  },
  network: {
    ok: false,
    retry: true,
    refresh: false,
    message: "通信に失敗しました。つながる場所で、もう一度試してください。",
  },
  // A delete whose outcome is not known: it may have happened. Nothing is sent again; the person checks the list.
  delete_unknown: {
    ok: false,
    retry: false,
    refresh: true,
    message: "削除できたか分かりません。一覧を更新して、確かめてください。",
  },
};

function result(kind, extra) {
  const entry = RESULTS[kind];
  return { kind, ok: entry.ok, retry: entry.retry, refresh: entry.refresh, message: entry.message, ...extra };
}

function isDeleteOp(op) {
  return op === "remove" || op === "removeAll";
}

// Maps a status that is not the expected 200 to a kind. The body of such a response is never read,
// so nothing the server wrote can end up on the screen.
function failureKind(status, op) {
  const deleting = isDeleteOp(op);
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) {
    if (op === "get") return "not_found";
    if (op === "remove") return "already_deleted";
    return "app_problem";
  }
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  if (status >= 500 && status <= 599) return deleting ? "delete_unknown" : "server_error";
  if (status >= 400 && status <= 499) return "app_problem"; // 400, 405, 415 and anything else we did not expect
  return deleting ? "delete_unknown" : "network"; // 1xx, 3xx, other 2xx: not an answer this request can get
}

function validList(data) {
  return (
    data !== null &&
    typeof data === "object" &&
    Array.isArray(data.notes) &&
    Number.isInteger(data.limit) &&
    data.limit > 0 &&
    data.notes.every((note) => note !== null && typeof note === "object" && typeof note.id === "string" && note.id !== "")
  );
}

function validNote(data) {
  const note = data?.note;
  return note !== null && typeof note === "object" && typeof note.id === "string" && note.id !== "" && typeof note.body === "string";
}

// After a 200 for "delete all": the number deleted, or null when it cannot be read in time. Never throws.
async function readCount(response, waitMs) {
  let timer = null;
  try {
    const body = Promise.resolve(response.json());
    body.catch(() => {});
    const giveUp = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
    });
    const data = await Promise.race([body, giveUp]);
    const deleted = data?.deleted;
    return Number.isInteger(deleted) && deleted >= 0 ? deleted : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function exchange(op, request, { getIdToken, fetchImpl, timeoutMs, countTimeoutMs }) {
  const deleting = isDeleteOp(op);
  let timer = null;
  try {
    // Without a token there is nothing to send. The caller's sign-in state is not touched.
    let idToken = null;
    try {
      idToken = getIdToken?.();
    } catch {
      idToken = null;
    }
    if (typeof idToken !== "string" || idToken === "") return result("no_token");

    const doFetch = typeof fetchImpl === "function" ? fetchImpl : (...args) => globalThis.fetch(...args);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timedOut = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        try {
          controller?.abort();
        } catch {
          // Aborting is only a courtesy; the timeout result does not depend on it.
        }
        reject(new Error("timeout"));
      }, timeoutMs);
    });
    timedOut.catch(() => {});

    let fetching;
    try {
      fetching = Promise.resolve(
        doFetch(request.url, {
          method: request.method,
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json", Authorization: `Bearer ${idToken}` },
          signal: controller?.signal,
        }),
      );
    } catch (error) {
      fetching = Promise.reject(error);
    }
    fetching.catch(() => {}); // if the timeout wins, a late failure of the request is not reported anywhere

    const response = await Promise.race([fetching, timedOut]);
    const status = response?.status;

    if (deleting) {
      if (status !== 200) return result(failureKind(status, op));
      // A 200 is a success whatever the body looks like. The timer no longer applies: the answer is in.
      clearTimeout(timer);
      if (op === "remove") return result("deleted");
      const count = await readCount(response, countTimeoutMs);
      return count === null ? result("deleted") : result("deleted", { message: `${count} 件削除しました`, count });
    }

    if (status !== 200) return result(failureKind(status, op));
    const body = Promise.resolve(response.json());
    body.catch(() => {});
    const data = await Promise.race([body, timedOut]);
    if (op === "list") {
      return validList(data) ? result("listed", { data: { notes: data.notes, limit: data.limit } }) : result("network");
    }
    return validNote(data) ? result("opened", { data: { note: data.note } }) : result("network");
  } catch {
    return result(deleting ? "delete_unknown" : "network");
  } finally {
    clearTimeout(timer);
  }
}

function validId(id) {
  return typeof id === "string" && id !== "";
}

export function createNotesApi({
  getIdToken,
  fetchImpl,
  timeoutMs = REQUEST_TIMEOUT_MS,
  countTimeoutMs = COUNT_READ_TIMEOUT_MS,
} = {}) {
  const options = { getIdToken, fetchImpl, timeoutMs, countTimeoutMs };
  const notePath = (id) => `/api/notes/${encodeURIComponent(id)}`;
  return {
    list: () => exchange("list", { url: "/api/notes", method: "GET" }, options),
    get: (id) =>
      validId(id) ? exchange("get", { url: notePath(id), method: "GET" }, options) : Promise.resolve(result("app_problem")),
    remove: (id) =>
      validId(id)
        ? exchange("remove", { url: notePath(id), method: "DELETE" }, options)
        : Promise.resolve(result("app_problem")),
    // The confirmation value is part of this one request only; nothing else ever builds this URL.
    removeAll: () => exchange("removeAll", { url: `/api/notes?confirm=${DELETE_ALL_CONFIRM}`, method: "DELETE" }, options),
  };
}

// The time of a note as the device shows it. A value that is not a time, or that cannot be formatted, is "unknown".
export function formatDateTime(value, DateTimeFormatImpl = Intl.DateTimeFormat) {
  try {
    if (typeof value !== "number" || !Number.isFinite(value)) return UNKNOWN_DATE_TEXT;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return UNKNOWN_DATE_TEXT;
    const formatter = new DateTimeFormatImpl("ja-JP", { dateStyle: "medium", timeStyle: "short" });
    const text = formatter.format(date);
    return typeof text === "string" && text !== "" ? text : UNKNOWN_DATE_TEXT;
  } catch {
    return UNKNOWN_DATE_TEXT;
  }
}

function validResult(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.kind === "string" &&
    typeof value.ok === "boolean" &&
    typeof value.retry === "boolean" &&
    typeof value.refresh === "boolean" &&
    typeof value.message === "string"
  );
}

export function createNotesPanel({ api, onChange, DateTimeFormat } = {}) {
  let seq = 0; // bumped by every new request and by closing; a result that belongs to an older number is dropped
  let isOpen = false;
  let busy = false;
  let screen = "list"; // "list" or "detail"
  let list = null; // { items: [{ id, dateText, titleText, truncatedMark }], limit }
  let detail = null; // { id, titleText, dateText, truncatedMark, body }
  let pendingConfirm = null; // { kind: "one" } or { kind: "all", count }
  let status = { message: "", retry: false, refresh: false };
  let lastOp = null; // { type, id? }: what "try again" sends once more. Never holds a title or a body.
  let listVersion = 0; // the page redraws the list (and the body) only when these change
  let detailVersion = 0;

  function setList(next) {
    list = next;
    listVersion += 1;
  }

  function setDetail(next) {
    detail = next;
    detailVersion += 1;
  }

  function clearStatus() {
    status = { message: "", retry: false, refresh: false };
    lastOp = null;
  }

  function getView() {
    const hasItems = list !== null && list.items.length > 0;
    let confirmView = null;
    if (pendingConfirm !== null) {
      confirmView =
        pendingConfirm.kind === "one"
          ? { kind: "one", text: CONFIRM_ONE_TEXT, yesLabel: CONFIRM_ONE_YES, noLabel: CONFIRM_NO }
          : {
              kind: "all",
              text: `表示中の ${pendingConfirm.count} 件のメモをすべて削除します。元に戻せません。`,
              yesLabel: CONFIRM_ALL_YES,
              noLabel: CONFIRM_NO,
            };
    }
    return {
      open: isOpen,
      busy,
      busyText: busy ? BUSY_MESSAGE : "",
      screen,
      status: { message: status.message, showRetry: status.retry && lastOp !== null, showRefresh: status.refresh },
      list:
        list === null
          ? null
          : {
              countText: `${list.items.length} / ${list.limit} 件`,
              emptyText: list.items.length === 0 ? EMPTY_LIST_MESSAGE : "",
              items: list.items.map((item) => ({ ...item })),
              showDeleteAll: hasItems,
            },
      detail: detail === null ? null : { ...detail },
      confirm: confirmView,
      canAskDeleteOne: isOpen && screen === "detail" && detail !== null && pendingConfirm === null,
      canAskDeleteAll: isOpen && screen === "list" && hasItems && pendingConfirm === null,
      listVersion,
      detailVersion,
    };
  }

  function emit() {
    try {
      onChange?.(getView());
    } catch {
      // Drawing is the page's business; it must not break the panel.
    }
  }

  function buildList(data) {
    const items = data.notes.map((note) => ({
      id: note.id,
      dateText: formatDateTime(note.created_at, DateTimeFormat),
      titleText: typeof note.title === "string" && note.title.trim() !== "" ? note.title : NO_TITLE_TEXT,
      truncatedMark: note.truncated === true ? TRUNCATED_MARK : "",
    }));
    return { items, limit: data.limit };
  }

  function buildDetail(note) {
    return {
      id: note.id,
      titleText: typeof note.title === "string" && note.title.trim() !== "" ? note.title : NO_TITLE_TEXT,
      dateText: formatDateTime(note.created_at, DateTimeFormat),
      truncatedMark: note.truncated === true ? TRUNCATED_MARK : "",
      body: note.body,
    };
  }

  function dispatch(op) {
    if (op.type === "list") return api.list();
    if (op.type === "get") return api.get(op.id);
    if (op.type === "remove") return api.remove(op.id);
    return api.removeAll();
  }

  function fallback(op) {
    return result(isDeleteOp(op.type) ? "delete_unknown" : "network");
  }

  // Shows a failure. Nothing is kept except what "try again" needs: the kind of request and the id.
  function showFailure(op, r) {
    status = { message: r.message, retry: r.retry, refresh: r.refresh };
    lastOp = r.retry ? op : null;
    pendingConfirm = null; // the answer was already given
    busy = false;
    emit();
  }

  async function apply(op, r) {
    if (isDeleteOp(op.type)) {
      if (!r.ok) return showFailure(op, r);
      // Deleted, or already gone: either way the note is not there any more.
      pendingConfirm = null;
      if (detail !== null) setDetail(null);
      screen = "list";
      status = { message: r.message, retry: false, refresh: false };
      lastOp = null;
      if (op.type === "removeAll") {
        if (list !== null) setList({ items: [], limit: list.limit });
        busy = false;
        emit();
        return undefined;
      }
      // One note: the list is asked for again, and the message stays until that answer is in.
      return execute({ type: "list" }, { keepStatus: true });
    }

    if (!r.ok) return showFailure(op, r);
    try {
      if (op.type === "list") {
        const next = buildList(r.data);
        setList(next);
        if (detail !== null) setDetail(null);
        screen = "list";
      } else {
        const next = buildDetail(r.data.note);
        setDetail(next);
        screen = "detail";
      }
    } catch {
      return showFailure(op, fallback(op));
    }
    pendingConfirm = null;
    busy = false;
    emit();
    return undefined;
  }

  async function execute(op, { keepStatus = false } = {}) {
    seq += 1;
    const mine = seq;
    busy = true;
    if (keepStatus) lastOp = null;
    else clearStatus();
    emit();

    let r;
    try {
      r = await dispatch(op);
    } catch {
      r = null;
    }
    if (mine !== seq) return undefined; // the panel was closed, or a newer request took over: this answer is old
    if (!validResult(r)) r = fallback(op);
    return apply(op, r);
  }

  async function open() {
    if (isOpen) return;
    isOpen = true;
    screen = "list";
    await execute({ type: "list" });
  }

  function close() {
    if (!isOpen) return;
    seq += 1; // whatever is still on its way is now old
    isOpen = false;
    busy = false;
    screen = "list";
    if (list !== null) setList(null);
    if (detail !== null) setDetail(null);
    pendingConfirm = null;
    clearStatus();
    emit();
  }

  async function refresh() {
    if (!isOpen || busy) return;
    screen = "list";
    if (detail !== null) setDetail(null);
    pendingConfirm = null;
    await execute({ type: "list" });
  }

  async function select(id) {
    if (!isOpen || busy || screen !== "list" || pendingConfirm !== null) return;
    if (typeof id !== "string" || list === null || !list.items.some((item) => item.id === id)) return;
    await execute({ type: "get", id });
  }

  async function back() {
    if (!isOpen || busy || screen !== "detail") return;
    setDetail(null); // the body is thrown away; the list that was already received is used
    screen = "list";
    pendingConfirm = null;
    clearStatus();
    emit();
  }

  async function askDeleteOne() {
    if (!isOpen || busy || screen !== "detail" || detail === null || pendingConfirm !== null) return;
    clearStatus();
    pendingConfirm = { kind: "one" };
    emit();
  }

  async function askDeleteAll() {
    if (!isOpen || busy || screen !== "list" || list === null || list.items.length === 0 || pendingConfirm !== null) return;
    clearStatus();
    pendingConfirm = { kind: "all", count: list.items.length };
    emit();
  }

  async function cancelConfirm() {
    if (!isOpen || busy || pendingConfirm === null) return;
    pendingConfirm = null;
    emit();
  }

  // The only place a delete is started, and only after the question was answered with "delete".
  async function confirmDelete() {
    if (!isOpen || busy || pendingConfirm === null) return;
    if (pendingConfirm.kind === "one") {
      if (detail === null) return;
      await execute({ type: "remove", id: detail.id });
      return;
    }
    await execute({ type: "removeAll" });
  }

  // Sends the last request once more, once per press, and only when "try again" is on offer.
  async function retry() {
    if (!isOpen || busy || lastOp === null || !status.retry) return;
    await execute(lastOp);
  }

  return { open, close, refresh, select, back, askDeleteOne, askDeleteAll, confirmDelete, cancelConfirm, retry, getView };
}
