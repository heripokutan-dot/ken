// Saves a finished conversation as a note through POST /api/notes, and keeps track of the save.
//
// No DOM here: the page hands in what to send and draws what comes back through onChange.
// Nothing is written to browser storage or to any log. The text of a note never appears in a message
// shown to the person, and an error here never reaches the caller (the caller is the end-of-conversation code).
//
//   postNote(note, { idToken })   one request, always resolves to a result (see RESULTS)
//   createNoteSaver({ send, onChange })
//     submit(takeResult)  save what the transcript recorder handed over, or explain why nothing is saved
//     retry()             send the kept note once more (only while a "save again" button is offered)
//     reset()             a new conversation starts: clear the display and the kept note, and ignore results still on their way

export const SAVE_TIMEOUT_MS = 15000;
export const SAVING_MESSAGE = "メモを保存中…";
export const RETRY_HINT = "次の会話を始めると、消えます。";

// What to say when there is nothing to save (the switch is on, but no note was made).
export const NONE_MESSAGES = {
  empty: "保存するものがありませんでした",
  no_user_speech: "あなたの発言が記録されなかったため、保存しませんでした",
};

// kind -> message and whether "save again" is offered. A note is kept in memory only when retry is true.
export const RESULTS = {
  saved: { ok: true, retry: false, message: "メモに保存しました" },
  saved_truncated: { ok: true, retry: false, message: "メモに保存しました（長い会話のため、途中までです）" },
  empty_body: { ok: true, retry: false, message: "保存するものがありませんでした" },
  bad_request: { ok: false, retry: false, message: "保存できませんでした（内容に問題があります）" },
  unauthorized: {
    ok: false,
    retry: true,
    message:
      "ログインの期限が切れました。もう一度サインインしてから、「メモをもう一度保存」を押してください。ページを再読み込みすると、このメモは消えます。",
  },
  forbidden: { ok: false, retry: false, message: "保存できませんでした（アクセスが許可されていません）" },
  conflict: {
    ok: false,
    retry: true,
    message: "メモが 200 件に達しています。古いメモを削除してから、「メモをもう一度保存」を押してください。",
  },
  too_large: { ok: false, retry: false, message: "会話が長すぎて、保存できませんでした" },
  app_problem: { ok: false, retry: false, message: "保存できませんでした（アプリの不具合の可能性があります）" },
  rate_limited: {
    ok: false,
    retry: true,
    message: "操作が多すぎます。1分ほど待ってから、もう一度保存してください。",
  },
  unavailable: { ok: false, retry: true, message: "サーバーの設定が足りないため、保存できませんでした" },
  server_error: {
    ok: false,
    retry: true,
    message:
      "サーバーでエラーが起きました。保存されている可能性があります。少し待ってから、メモの一覧で確かめて、もう一度保存してください。",
  },
  network: {
    ok: false,
    retry: true,
    message:
      "通信に失敗しました。保存されている可能性があります。つながる場所で、メモの一覧で確かめて、もう一度保存してください。",
  },
};

function result(kind) {
  const entry = RESULTS[kind];
  return { kind, ok: entry.ok, retry: entry.retry, message: entry.message };
}

// Maps the response to a result. Only the status (and, for 200 and 201, whether the JSON is what we expect) is used;
// the body of an error response is never read, so nothing from the server can end up on the screen.
async function interpret(response) {
  const status = response.status;
  if (status === 201) {
    const data = await response.json();
    if (data?.saved !== true) return result("network");
    return result(data.note?.truncated === true ? "saved_truncated" : "saved");
  }
  if (status === 200) {
    const data = await response.json();
    return data?.saved === false ? result("empty_body") : result("network");
  }
  if (status === 400) return result("bad_request");
  if (status === 401) return result("unauthorized");
  if (status === 403) return result("forbidden");
  if (status === 409) return result("conflict");
  if (status === 413) return result("too_large");
  if (status === 429) return result("rate_limited");
  if (status === 503) return result("unavailable");
  if (status >= 500 && status <= 599) return result("server_error");
  if (status >= 400 && status <= 499) return result("app_problem"); // 405, 415 and anything else we did not expect
  return result("network"); // 1xx, 3xx, other 2xx: not an answer this request can get
}

export async function postNote(note, { idToken, fetchImpl, timeoutMs = SAVE_TIMEOUT_MS } = {}) {
  try {
    // Without a token there is nothing to send. The caller's sign-in state is not touched.
    if (typeof idToken !== "string" || idToken === "") return result("unauthorized");

    const doFetch = typeof fetchImpl === "function" ? fetchImpl : (...args) => globalThis.fetch(...args);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const body = JSON.stringify({ title: note?.title, body: note?.body });

    let timer = null;
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
    const work = (async () => {
      const response = await doFetch("/api/notes", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body,
        signal: controller?.signal,
      });
      return interpret(response);
    })();
    work.catch(() => {}); // if the timeout wins, a late failure of the request is not reported anywhere

    try {
      return await Promise.race([work, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return result("network");
  }
}

function validResult(value) {
  return value !== null && typeof value === "object" && typeof value.message === "string" && typeof value.retry === "boolean";
}

export function createNoteSaver({ send, onChange } = {}) {
  let generation = 0; // bumped by reset(); a result that belongs to an older number is dropped
  let saving = false;
  let message = "";
  let pending = null; // { title, body } kept only while "save again" is offered

  function getView() {
    const offered = pending !== null;
    return {
      visible: message !== "",
      message,
      showRetry: offered,
      retryDisabled: saving,
      hint: offered ? RETRY_HINT : "",
    };
  }

  function emit() {
    try {
      onChange?.(getView());
    } catch {
      // Drawing is the page's business; it must not break saving.
    }
  }

  async function run(note) {
    const mine = generation;
    saving = true;
    message = SAVING_MESSAGE;
    emit();

    let outcome;
    try {
      outcome = await send(note);
    } catch {
      outcome = result("network");
    }
    if (mine !== generation) return; // a new conversation started meanwhile: neither the screen nor the kept note changes
    if (!validResult(outcome)) outcome = result("network");

    saving = false;
    message = outcome.message;
    pending = outcome.retry ? { title: note.title, body: note.body } : null;
    emit();
  }

  async function submit(taken) {
    try {
      if (taken === null || typeof taken !== "object") return;
      if (taken.kind === "note") {
        if (typeof taken.title !== "string" || typeof taken.body !== "string") return;
        if (saving) return;
        await run({ title: taken.title, body: taken.body });
        return;
      }
      if (taken.kind === "none") {
        const text = NONE_MESSAGES[taken.reason]; // already_taken shows nothing and leaves the display as it is
        if (typeof text !== "string" || saving) return;
        pending = null;
        message = text;
        emit();
      }
    } catch {
      // Never reaches the caller.
    }
  }

  async function retry() {
    try {
      if (saving || pending === null) return false;
      await run(pending);
      return true;
    } catch {
      return false;
    }
  }

  function reset() {
    generation += 1;
    saving = false;
    message = "";
    pending = null;
    emit();
  }

  return { submit, retry, reset, getView };
}
