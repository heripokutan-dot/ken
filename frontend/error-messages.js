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

// Value-free hint for a 502: only an allowlisted reason code and a numeric HTTP status are ever used.
function geminiFailureHint(body) {
  const reason = typeof body?.reason === "string" ? body.reason : "";
  const upstream = body?.upstream_status;
  if (reason === "token_upstream_rejected") {
    const n = Number.isInteger(upstream) && upstream >= 100 && upstream <= 599 ? `（Gemini の応答: HTTP ${upstream}）` : "";
    const safe = (v, re) => (typeof v === "string" && re.test(v) ? v : "");
    const code = safe(body?.upstream_code, /^[A-Z_]{3,40}$/);
    const why = safe(body?.upstream_reason, /^[A-Z_]{3,60}$/);
    const field = safe(body?.upstream_field, /^[A-Za-z][A-Za-z0-9_.\[\]]{0,79}$/);
    const extra = [code && `種別: ${code}`, why && `理由: ${why}`, field && `項目: ${field}`].filter(Boolean).join("、");
    return `Gemini に拒否されました${n}。${extra ? `${extra}。` : ""}API キーの値と権限、リクエスト内容を確認してください。`;
  }
  if (reason === "token_upstream_unreachable") return "Gemini に接続できませんでした。";
  if (reason === "token_upstream_malformed") return "Gemini の応答が想定と異なります。";
  return "";
}

// Maps a non-OK response from POST /api/live-token to a safe Japanese message.
// Only the status and an allowlisted error code are used; the response body text is never shown,
// so provider or account details cannot leak.
export function tokenErrorMessage(status, code, body) {
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
    const known = ["ALLOWED_EMAIL", "AUTH_PROVIDER", "GOOGLE_CLIENT_ID", "ACCESS_TEAM_DOMAIN", "ACCESS_AUDIENCE"];
    const names = Array.isArray(body?.missing) ? body.missing.filter((n) => known.includes(n)) : [];
    const detail = names.length ? `届いていない設定: ${names.join("、")}。` : "";
    return hint ? `${base}${detail || hint}` : base;
  }
  if (status === 502) {
    const base = "Gemini Live のトークンを作成できませんでした。しばらくしてから、もう一度お試しください。";
    return `${base}${geminiFailureHint(body)}`;
  }
  return "セッションを開始できませんでした。しばらくしてから再試行してください。";
}
