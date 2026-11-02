import test from "node:test";
import assert from "node:assert/strict";
import { tokenErrorMessage, personaRejectedHint, PERSONA_REJECTED_HINT } from "../frontend/error-messages.js";

// The messages that depend on the chosen character. The messages for "standard" are checked against text that was
// captured from the code before this change (5c75dfc) and is written out here character for character.

const HINT = "選んだキャラ（声）の指定が拒否された可能性があります。「標準」に切り替えて、もう一度お試しください。";
const INVALID_PERSONA = "選んだキャラを認識できませんでした。ページを再読み込みして、「標準」を選んでお試しください。";
const NON_STANDARD = ["buddy", "teacher", "listener"];

const REJECTED = {
  reason: "token_upstream_rejected",
  upstream_status: 400,
  upstream_code: "INVALID_ARGUMENT",
  upstream_reason: "API_KEY_INVALID",
  upstream_field: "auth_token.bidi_generate_content_setup",
  upstream_detail: "Unknown name",
};

// [label, arguments, the message before this change]
const BEFORE = [
  ["401", [401], "ログインの確認が必要です。ページを再読み込みして、もう一度サインインしてください。"],
  ["403", [403], "このアカウントは許可されていないため、このアプリを利用できません。"],
  ["429", [429], "短時間に接続しすぎています。しばらく待ってから、もう一度お試しください。"],
  ["502 with no body", [502], "Gemini Live のトークンを作成できませんでした。しばらくしてから、もう一度お試しください。"],
  [
    "502, rejected by Gemini, all fields",
    [502, "token_issue_failed", REJECTED],
    "Gemini Live のトークンを作成できませんでした。しばらくしてから、もう一度お試しください。Gemini に拒否されました（Gemini の応答: HTTP 400）。種別: INVALID_ARGUMENT、理由: API_KEY_INVALID、項目: auth_token.bidi_generate_content_setup、詳細: Unknown name。API キーの値と権限、リクエスト内容を確認してください。",
  ],
  [
    "502, rejected by Gemini, no fields",
    [502, "token_issue_failed", { reason: "token_upstream_rejected" }],
    "Gemini Live のトークンを作成できませんでした。しばらくしてから、もう一度お試しください。Gemini に拒否されました。API キーの値と権限、リクエスト内容を確認してください。",
  ],
  [
    "502, Gemini unreachable",
    [502, "token_issue_failed", { reason: "token_upstream_unreachable" }],
    "Gemini Live のトークンを作成できませんでした。しばらくしてから、もう一度お試しください。Gemini に接続できませんでした。",
  ],
  [
    "502, Gemini answer malformed",
    [502, "token_issue_failed", { reason: "token_upstream_malformed" }],
    "Gemini Live のトークンを作成できませんでした。しばらくしてから、もう一度お試しください。Gemini の応答が想定と異なります。",
  ],
  ["503 with no code", [503], "サーバーの設定が完了していません。管理者に設定状況を確認してください。"],
  [
    "503 misconfigured",
    [503, "service_misconfigured"],
    "サーバーの設定が完了していません。管理者に設定状況を確認してください。ログイン設定（ALLOWED_EMAIL・AUTH_PROVIDER・GOOGLE_CLIENT_ID）のいずれかが、この環境に届いていません。",
  ],
  [
    "503 rate limit database",
    [503, "rate_limit_unavailable"],
    "サーバーの設定が完了していません。管理者に設定状況を確認してください。レート制限用のデータベース（RATE_LIMIT_DB）に接続できません。",
  ],
  [
    "503 Gemini key",
    [503, "gemini_not_configured"],
    "サーバーの設定が完了していません。管理者に設定状況を確認してください。Gemini の API キー（GEMINI_API_KEY）が、この環境に届いていません。",
  ],
  [
    "503 with the names of missing settings",
    [503, "service_misconfigured", { missing: ["ALLOWED_EMAIL", "<b>x</b>"] }],
    "サーバーの設定が完了していません。管理者に設定状況を確認してください。届いていない設定: ALLOWED_EMAIL。",
  ],
  ["400 with no code", [400], "セッションを開始できませんでした。しばらくしてから再試行してください。"],
  ["400 with another code", [400, "x"], "セッションを開始できませんでした。しばらくしてから再試行してください。"],
  ["413", [413, "payload_too_large"], "セッションを開始できませんでした。しばらくしてから再試行してください。"],
  ["500", [500], "セッションを開始できませんでした。しばらくしてから再試行してください。"],
  ["no status", [undefined], "セッションを開始できませんでした。しばらくしてから再試行してください。"],
];

// ---- the new sentence ---------------------------------------------------------------------------------------------------

test("the added sentence is exactly the agreed one", () => {
  assert.equal(PERSONA_REJECTED_HINT, HINT);
});

test("personaRejectedHint: the sentence for a character with a voice, nothing for standard or for no choice", () => {
  for (const id of NON_STANDARD) assert.equal(personaRejectedHint(id), HINT, id);
  for (const none of ["standard", "", undefined, null, 0, 1, true, {}, [], ["buddy"], { id: "buddy" }]) {
    assert.equal(personaRejectedHint(none), "", String(typeof none));
  }
});

test("personaRejectedHint never repeats what it was given", () => {
  assert.equal(personaRejectedHint("<b>SENTINEL</b>"), HINT);
  assert.doesNotMatch(personaRejectedHint("<b>SENTINEL</b>"), /SENTINEL|<b>/);
});

// ---- 502: Gemini refused the token request ------------------------------------------------------------------------------

test("a character with a voice: when Gemini refuses the token request, the sentence is added at the end of the usual message", () => {
  for (const id of NON_STANDARD) {
    for (const body of [REJECTED, { reason: "token_upstream_rejected" }]) {
      const usual = tokenErrorMessage(502, "token_issue_failed", body);
      const message = tokenErrorMessage(502, "token_issue_failed", body, id);
      assert.equal(message, usual + HINT, id);
      assert.ok(message.endsWith(HINT));
    }
  }
});

test("the sentence is added only when Gemini refused: not when it could not be reached, nor for a malformed answer, nor with no reason", () => {
  for (const id of NON_STANDARD) {
    for (const body of [
      { reason: "token_upstream_unreachable" }, { reason: "token_upstream_malformed" }, {}, null, undefined,
      { reason: "<b>key</b>", upstream_status: "403 <script>" },
    ]) {
      assert.equal(tokenErrorMessage(502, "token_issue_failed", body, id), tokenErrorMessage(502, "token_issue_failed", body));
    }
    assert.equal(tokenErrorMessage(502, undefined, undefined, id), tokenErrorMessage(502));
  }
});

test("the sentence is added to no other status", () => {
  for (const id of NON_STANDARD) {
    for (const [status, code] of [[401], [403], [429], [503], [503, "service_misconfigured"], [500], [413, "payload_too_large"], [undefined]]) {
      assert.equal(tokenErrorMessage(status, code, REJECTED, id), tokenErrorMessage(status, code, REJECTED), `${status} ${id}`);
    }
  }
});

// ---- 400: the server did not recognise the character ----------------------------------------------------------------------

test("400 invalid_persona has its own message, with or without a character given", () => {
  assert.equal(tokenErrorMessage(400, "invalid_persona"), INVALID_PERSONA);
  assert.equal(tokenErrorMessage(400, "invalid_persona", { error: "invalid_persona" }), INVALID_PERSONA);
  for (const id of ["standard", ...NON_STANDARD, undefined]) {
    assert.equal(tokenErrorMessage(400, "invalid_persona", null, id), INVALID_PERSONA, String(id));
  }
});

test("only status 400 with exactly that code gets it", () => {
  assert.notEqual(tokenErrorMessage(400, "x"), INVALID_PERSONA);
  assert.notEqual(tokenErrorMessage(400), INVALID_PERSONA);
  for (const status of [200, 401, 403, 413, 429, 500, 502, 503]) {
    assert.notEqual(tokenErrorMessage(status, "invalid_persona"), INVALID_PERSONA, String(status));
  }
  for (const code of ["Invalid_Persona", "invalid_persona ", "__proto__", undefined, null, 5]) {
    assert.notEqual(tokenErrorMessage(400, code), INVALID_PERSONA, String(code));
  }
});

// ---- standard: not one character different ---------------------------------------------------------------------------------

test("without a character argument, every message is what it was before", () => {
  for (const [label, args, before] of BEFORE) assert.equal(tokenErrorMessage(...args), before, label);
});

test("with standard, or with nothing chosen, every message is what it was before", () => {
  for (const [label, args, before] of BEFORE) {
    const [status, code, body] = args;
    assert.equal(tokenErrorMessage(status, code, body, "standard"), before, `${label} / standard`);
    assert.equal(tokenErrorMessage(status, code, body, undefined), before, `${label} / undefined`);
    assert.equal(tokenErrorMessage(status, code, body, null), before, `${label} / null`);
  }
});

test("the new sentences never contain a secret-shaped or key-shaped text", () => {
  for (const text of [HINT, INVALID_PERSONA]) assert.doesNotMatch(text, /AIza|auth_tokens|Bearer|access_token/);
});
