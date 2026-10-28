# プロジェクトの現状と引き継ぎメモ（2026-10-28）

Gemini Live と日本語で音声会話する個人用アプリです。パソコンと iPhone の Safari で、本番 URL での動作を確認済みです。秘密情報（API キー、メールアドレス、トークン）はこのリポジトリに入れません。

## 構成

| 場所 | 役割 |
| --- | --- |
| `frontend/` | 画面（`app.js`、`error-messages.js`、`live-setup.js`、`pcm-*.js`）。Cloudflare Pages が配信します |
| `functions/api/auth-config.ts` | `GET /api/auth-config`。Google のクライアント ID だけを返します |
| `functions/api/live-token.ts` | `POST /api/live-token`。Google ID トークンを検証し、許可された1人だけに Gemini の一時トークンを発行します |
| `functions/_shared/` | JWT 検証、Google 認証、レート制限（D1）、Gemini トークン発行、HTTP の共通処理 |
| `migrations/0001_rate_limits.sql` | レート制限用の D1 テーブル |
| `server.py`, `tests/test_*.py` | ローカル試作（FastAPI）。Pages 版とは別の経路です |

流れ: ブラウザーが Google でサインイン → `/api/live-token` が ID トークン・許可メール・レート制限（1分10回）を確認 → Gemini の一時トークンを返す → ブラウザーが Gemini Live の WebSocket に直接つなぐ。音声は Gemini と直接やり取りし、サーバーには残りません。

## 本番

- URL: `https://ken-chl.pages.dev`（Cloudflare Pages のプロジェクト `ken`）。
- 本番ブランチ: `feat/gemini-live-iphone-cloudflare-impl`。ここに push すると本番デプロイが走ります。
- `main` は古いままです（PR #1・#2 のみ）。本番ブランチは `main` より先に進んでいます。`main` に取り込むかどうかは、利用者の判断待ちです。

## 設定（Cloudflare Pages のダッシュボードで管理）

| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `GEMINI_API_KEY` | Secret | Gemini の API キー |
| `ALLOWED_EMAIL` | Secret | 使ってよい Google アカウントのメール |
| `AUTH_PROVIDER` | 変数または Secret | `google` |
| `GOOGLE_CLIENT_ID` | 変数または Secret | OAuth のウェブ クライアント ID（公開前提の値） |
| `RATE_LIMIT_DB` | D1 バインディング | データベース `ken-rate-limits` |

設定が足りないと、`/api/live-token` は必ず止まります（503）。認証やレート制限を緩める変更はしないでください。

## やってはいけないこと

- **`wrangler.toml` / `wrangler.jsonc` を追加しない。** 追加すると、Pages はそのファイルを設定の正とみなし、ダッシュボードの変数・バインディングが関数に届かなくなります（実際に起きました）。テストでもファイルの不在を確認しています。
- 秘密情報をリポジトリ、チャット、ログに出さない。
- カード・支払い情報の入力を求められたら、止めて利用者に報告する。
- Google の「承認済みの JavaScript 生成元」には、**使う URL のオリジンを1つずつ登録**する（`https://ken-chl.pages.dev`）。ワイルドカードやコミットごとの URL は使えません。

## 動作確認で分かった落とし穴

| 症状 | 原因と対処 |
| --- | --- |
| `/api/auth-config` が 404 | `wrangler.toml` があるとダッシュボードの設定が届かない。ファイルを置かない |
| Google の `origin_mismatch` | 開いた URL のオリジンが未登録。登録して数分待つ |
| ブランチの固定 URL が古い | 本番ブランチを切り替えた間、固定 URL が古い Preview を指すことがある。本番 URL で確認する |
| トークン発行が 400 | REST の `auth_tokens` は `liveConnectConstraints` を受け付けない。`bidiGenerateContentSetup`（接続設定と同じ形）を使い、日時はミリ秒なしの形式にする |
| WebSocket が 1007 で切断 | 接続設定では `responseModalities` を `generationConfig` の中に置く |
| 「正しい応答を受信できませんでした」 | Gemini Live は JSON をバイナリ（Blob）で送る。デコードしてから解析する |

画面には、原因の手がかりになる診断（足りない設定の名前、Google の種別コード・理由・項目名、WebSocket の終了コード）が出ます。値や API キーは出しません。

## テスト

```bash
npm install
npm test          # 型チェック + functions + フロント
```

`tests/test_*.py` は FastAPI が必要で、Pages 版には関係しません。

## 機能を追加するときの注意（拡張の検討用）

- システム指示と文字起こしの設定は、ブラウザー側の接続設定（`frontend/live-setup.js`、`frontend/app.js` の `SYSTEM_INSTRUCTION`）で渡しています。トークンで固定しているのはモデルだけです。
- モデル名は `functions/_shared/gemini-token.ts` の `MODEL_ID` です。
- 1人専用の作りです（`ALLOWED_EMAIL`）。複数人に広げる場合は、認証、レート制限、利用料の上限を先に設計してください。
- 新しい API やプロバイダーのキーは、サーバー側（Function）に Secret として置き、ブラウザーに渡さないでください。

## 残っていること

- `main` に取り込むかどうか（利用者の判断）。
- 未マージの独自ブランチ `feat/gemini-live-api-smoke-test`（Python SDK を使った動作確認用のスクリプトとテスト）は残してあります。
- ID トークンは約1時間で切れます。切れたら再サインインが必要です。
