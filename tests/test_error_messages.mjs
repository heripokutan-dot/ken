import test from "node:test";
import assert from "node:assert/strict";
import { userFacingError, tokenErrorMessage, closeDetail } from "../frontend/error-messages.js";

test("microphone permission errors are explained in Japanese", () => {
  assert.equal(
    userFacingError({ name: "NotAllowedError", message: "Permission denied" }),
    "マイクの使用が許可されませんでした。ブラウザーのサイト設定でマイクを許可して、もう一度お試しください。",
  );
});

test("missing microphone errors are explained in Japanese", () => {
  assert.equal(
    userFacingError({ name: "NotFoundError", message: "Requested device not found" }),
    "マイクが見つかりません。マイクを接続してから、もう一度お試しください。",
  );
});

test("existing Japanese app errors are preserved", () => {
  const message = "Gemini Live に接続できませんでした。ネットワークを確認してください。";
  assert.equal(userFacingError(new Error(message)), message);
});

test("unknown browser errors are sanitized into a Japanese recovery message", () => {
  assert.equal(
    userFacingError(new Error("Failed to fetch")),
    "音声会話を開始できませんでした。ブラウザーのマイク権限とローカルサーバーの状態を確認して、もう一度お試しください。",
  );
});

test("token endpoint 401 asks the user to sign in again without exposing details", () => {
  const message = tokenErrorMessage(401);
  assert.match(message, /ログイン/);
});

test("token endpoint 403 explains the account is not permitted", () => {
  assert.match(tokenErrorMessage(403), /許可されていない/);
});

test("token endpoint 429 asks the user to wait before retrying", () => {
  assert.match(tokenErrorMessage(429), /しばらく/);
});

test("token endpoint 503 and 502 give recovery guidance", () => {
  assert.match(tokenErrorMessage(503), /設定/);
  assert.match(tokenErrorMessage(502), /トークン/);
});

test("token endpoint 503 names the missing setting only for known error codes", () => {
  assert.match(tokenErrorMessage(503, "service_misconfigured"), /ALLOWED_EMAIL/);
  assert.match(tokenErrorMessage(503, "rate_limit_unavailable"), /RATE_LIMIT_DB/);
  assert.match(tokenErrorMessage(503, "gemini_not_configured"), /GEMINI_API_KEY/);
  const unknown = tokenErrorMessage(503, "<script>secret</script>");
  assert.equal(unknown, tokenErrorMessage(503));
  assert.doesNotMatch(unknown, /script|secret/);
  assert.equal(tokenErrorMessage(503, "__proto__"), tokenErrorMessage(503));
});

test("token endpoint 502 shows only the reason code and numeric upstream status", () => {
  assert.match(tokenErrorMessage(502, "token_issue_failed", { reason: "token_upstream_rejected", upstream_status: 403 }), /HTTP 403/);
  assert.match(tokenErrorMessage(502, "token_issue_failed", { reason: "token_upstream_unreachable" }), /接続できません/);
  const hostile = tokenErrorMessage(502, "token_issue_failed", { reason: "<b>key</b>", upstream_status: "403 <script>" });
  assert.equal(hostile, tokenErrorMessage(502));
  assert.doesNotMatch(tokenErrorMessage(502, "x", { reason: "token_upstream_rejected", upstream_status: "abc" }), /abc/);
});

test("token endpoint 503 lists only known missing setting names", () => {
  const m = tokenErrorMessage(503, "service_misconfigured", { missing: ["ALLOWED_EMAIL", "<script>x</script>"] });
  assert.match(m, /届いていない設定: ALLOWED_EMAIL。/);
  assert.doesNotMatch(m, /script/);
});

test("token endpoint 502 shows allowlisted Google error type, reason and field only", () => {
  const m = tokenErrorMessage(502, "token_issue_failed", {
    reason: "token_upstream_rejected", upstream_status: 400, upstream_code: "INVALID_ARGUMENT",
    upstream_reason: "API_KEY_INVALID", upstream_field: "config.systemInstruction",
  });
  assert.match(m, /種別: INVALID_ARGUMENT/);
  assert.match(m, /理由: API_KEY_INVALID/);
  assert.match(m, /項目: config.systemInstruction/);
  const bad = tokenErrorMessage(502, "x", { reason: "token_upstream_rejected", upstream_status: 400, upstream_code: "bad value <x>", upstream_field: "a b" });
  assert.doesNotMatch(bad, /bad value|<x>|a b/);
});

test("token endpoint 502 shows short Google validation text and hides key-shaped text", () => {
  const ok = tokenErrorMessage(502, "x", { reason: "token_upstream_rejected", upstream_status: 400, upstream_detail: "Unknown name at 'auth_token'" });
  assert.match(ok, /詳細: Unknown name at 'auth_token'/);
  const bad = tokenErrorMessage(502, "x", { reason: "token_upstream_rejected", upstream_status: 400, upstream_detail: "AIzaSyABCDEFGHIJKLMNOP" });
  assert.doesNotMatch(bad, /AIza/);
});

test("unknown token endpoint statuses fall back to a retry message", () => {
  assert.match(tokenErrorMessage(500), /再試行/);
});

test("websocket close detail shows the code and a short plain reason only", () => {
  assert.equal(closeDetail(1007, "Invalid JSON payload"), "コード 1007、理由: Invalid JSON payload");
  assert.equal(closeDetail(1006, ""), "コード 1006");
  assert.equal(closeDetail(undefined, "x".repeat(300)), "");
  assert.doesNotMatch(closeDetail(1008, "bad AIzaSyABCDEFGHIJKLMNOP"), /AIza/);
  assert.doesNotMatch(closeDetail(1008, "token auth_tokens/abc"), /auth_tokens/);
});
