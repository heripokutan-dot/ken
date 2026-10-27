const DEFAULT_MESSAGE =
  "音声会話を開始できませんでした。ブラウザーのマイク権限とローカルサーバーの状態を確認して、もう一度お試しください。";

export function userFacingError(error) {
  const name = typeof error?.name === "string" ? error.name : "";

  if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(name)) {
    return "マイクの使用が許可されませんでした。ブラウザーのサイト設定でマイクを許可して、もう一度お試しください。";
  }
  if (name === "NotFoundError") {
    return "マイクが見つかりません。マイクを接続してから、もう一度お試しください。";
  }
  if (["NotReadableError", "AbortError"].includes(name)) {
    return "マイクを使用できません。ほかのアプリで使用中でないか確認して、もう一度お試しください。";
  }

  const message = typeof error?.message === "string" ? error.message : "";
  return /[ぁ-んァ-ヶ一-龯]/u.test(message) ? message : DEFAULT_MESSAGE;
}

// Safe, value-free detail for the 503 error codes the token endpoint returns (names of settings only).
const SERVER_SETUP_HINTS = {
  service_misconfigured:
    "ログイン設定（ALLOWED_EMAIL・AUTH_PROVIDER・GOOGLE_CLIENT_ID）のいずれかが、この環境に届いていません。",
  rate_limit_unavailable: "レート制限用のデータベース（RATE_LIMIT_DB）に接続できません。",
  gemini_not_configured: "Gemini の API キー（GEMINI_API_KEY）が、この環境に届いていません。",
};

// Maps a non-OK response from POST /api/live-token to a safe Japanese message.
// Only the status and an allowlisted error code are used; the response body text is never shown,
// so provider or account details cannot leak.
export function tokenErrorMessage(status, code) {
  if (status === 401) {
    return "ログインの確認が必要です。ページを再読み込みして、もう一度サインインしてください。";
  }
  if (status === 403) {
    return "このアカウントは許可されていないため、このアプリを利用できません。";
  }
  if (status === 429) {
    return "短時間に接続しすぎています。しばらく待ってから、もう一度お試しください。";
  }
  if (status === 503) {
    const base = "サーバーの設定が完了していません。管理者に設定状況を確認してください。";
    const hint = typeof code === "string" && Object.hasOwn(SERVER_SETUP_HINTS, code) ? SERVER_SETUP_HINTS[code] : "";
    return hint ? `${base}${hint}` : base;
  }
  if (status === 502) {
    return "Gemini Live のトークンを作成できませんでした。しばらくしてから、もう一度お試しください。";
  }
  return "セッションを開始できませんでした。しばらくしてから再試行してください。";
}
