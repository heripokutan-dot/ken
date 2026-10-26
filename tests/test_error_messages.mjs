import test from "node:test";
import assert from "node:assert/strict";
import { userFacingError, tokenErrorMessage } from "../frontend/error-messages.js";

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

test("unknown token endpoint statuses fall back to a retry message", () => {
  assert.match(tokenErrorMessage(500), /再試行/);
});
