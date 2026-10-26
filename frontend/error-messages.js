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

// Maps a non-OK response from POST /api/live-token to a safe Japanese message.
// The response body is intentionally not used, so provider or account details are never shown.
export function tokenErrorMessage(status) {
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
    return "サーバーの設定が完了していません。管理者に設定状況を確認してください。";
  }
  if (status === 502) {
    return "Gemini Live のトークンを作成できませんでした。しばらくしてから、もう一度お試しください。";
  }
  return "セッションを開始できませんでした。しばらくしてから再試行してください。";
}
