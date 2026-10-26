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
