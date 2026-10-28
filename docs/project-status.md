# プロジェクトの現状と引き継ぎメモ（2026-10-28）

Gemini Live と日本語で音声会話する個人用アプリです。パソコンと iPhone の Safari で、本番 URL での動作を確認済みです。秘密情報（API キー、メールアドレス、トークン）はこのリポジトリに入れません。

## 構成

| 場所 | 役割 |
| --- | --- |
| `frontend/` | 画面（`app.js`、`error-messages.js`、`live-setup.js`、`pcm-*.js`）。Cloudflare Pages が配信します |
| `functions/api/auth-config.ts` | `GET /api/auth-config`。Google のクライアント ID だけを返します |
| `functions/api/live-token.ts` | `POST /api/live-token`。Google ID トークンを検証し、許可された1人だけに Gemini の一時トークンを発行します |
| `functions/_shared/` | JWT 検証、Google 認証、レート制限（D1）、Gemini トークン発行、HTTP の共通処理 |
| `functions/api/notes/` | `/api/notes` と `/api/notes/<id>`。会話の文字起こしを、メモとして保存・一覧・取得・削除します。`index.ts` が本体、`[id].ts` が id つきのルートです（本番への反映状況は「状態」の節） |
| `migrations/0001_rate_limits.sql` | レート制限用の D1 テーブル |
| `migrations/0002_notes.sql` | メモ用の D1 テーブル `notes` |
| `server.py`, `tests/test_*.py` | ローカル試作（FastAPI）。Pages 版とは別の経路です |

流れ: ブラウザーが Google でサインイン → `/api/live-token` が ID トークン・許可メール・レート制限（1分10回）を確認 → Gemini の一時トークンを返す → ブラウザーが Gemini Live の WebSocket に直接つなぐ。音声は Gemini と直接やり取りし、サーバーには残りません。会話の文字起こしを残すための `/api/notes` を作りましたが、画面からはまだ使えず、本番にもまだありません（「メモ保存」と「状態」の節）。

## 本番

- URL: `https://ken-chl.pages.dev`（Cloudflare Pages のプロジェクト `ken`）。
- 本番ブランチ: `feat/gemini-live-iphone-cloudflare-impl`。ここに push すると本番デプロイが走ります。
- 作業用ブランチに push すると、本番ではなく Preview が作られます（`feat/notes` で、Cloudflare Pages のチェック結果に Preview の URL とブランチの Preview の URL が出ることを確認しました。本番ブランチの先頭が変わらないことも確認しましたが、Cloudflare の画面は見ていません）。
- `main` は古いままです（PR #1・#2 のみ）。本番ブランチは `main` より先に進んでいます。`main` に取り込むかどうかは、利用者の判断待ちです。

## 設定（Cloudflare Pages のダッシュボードで管理）

| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `GEMINI_API_KEY` | Secret | Gemini の API キー |
| `ALLOWED_EMAIL` | Secret | 使ってよい Google アカウントのメール |
| `AUTH_PROVIDER` | 変数または Secret | `google` |
| `GOOGLE_CLIENT_ID` | 変数または Secret | OAuth のウェブ クライアント ID（公開前提の値） |
| `RATE_LIMIT_DB` | D1 バインディング | 利用者の話では、データベース `ken-rate-limits`（回数制限の表とメモの表の両方が入る。次の節を参照） |

設定が足りないと、`/api/live-token` と `/api/notes` は必ず止まります（503）。認証やレート制限を緩める変更はしないでください。

## D1 の名前と実態のずれ

- 接続名（バインディング）は `RATE_LIMIT_DB` のままです。名前は「回数制限」ですが、メモの表（`notes`）も同じ D1 に入れました。メモ用の新しい接続、変数、Secret は作っていません。
- データベース名は、利用者の話では `ken-rate-limits` です。Pages の画面で、`RATE_LIMIT_DB` がそのデータベースにつながっていることは、見て確かめていません（推測を含みます）。`ken-rate-limits` に `rate_limits` の表があることからは、同じものと見てよいと考えています。
- メモ専用の D1 に分ける場合は、Pages の画面で接続を足す作業と、コードの変更が要ります（利用者の許可が要る作業です）。
- データベースの ID やアカウント ID は、このリポジトリに書きません。

## メモ保存（`/api/notes`）

会話の文字起こしを、D1 にメモとして残すための API です。画面（保存のスイッチ、メモの一覧）はまだありません。

### `notes` 表（`migrations/0002_notes.sql`）

| 列 | 内容 |
| --- | --- |
| `id` | 文字列の主キー。サーバーが `crypto.randomUUID()` で作ります |
| `created_at` | 整数。サーバーの時刻（ミリ秒）。インデックス `idx_notes_created_at` を付けています |
| `persona` | 文字列。初期値は空文字 |
| `title` | 文字列。初期値は空文字 |
| `body` | 文字列（文字起こし）。必須 |
| `truncated` | 0 か 1（それ以外は表の側で拒否）。初期値は 0 |

- 追加だけの SQL です（`CREATE TABLE IF NOT EXISTS`、`CREATE INDEX IF NOT EXISTS`）。`rate_limits` には触れません。何度実行しても安全です。
- 本番の D1 には、利用者が Cloudflare の画面から手で実行しました。実行後、`notes` と `rate_limits` の表と、`notes` のインデックスがあることを、利用者が確認しました（利用者の報告。私は画面を見ていません）。
- migration を自動で適用する仕組みは、このリポジトリにはありません。`.github/` の3つのワークフロー（`main` への push で GitHub Pages に配信するもの、手動で動かす Gemini の確認2つ）と `package.json` の scripts を調べて、D1・migration・wrangler への言及がないことを確認しました。Cloudflare 側のビルド設定は見ていないので、そちらで自動適用されないことは未確認です。
- **新しい migration を足したら、利用者が手で実行する必要があります**（Cloudflare の画面の D1 の Console、または `wrangler d1 execute`）。その表を使うコードを本番に出す前に、先に表を足します（追加だけの SQL なら、既存の動作に影響しません）。

### API

| 操作 | メソッドとパス | 主な応答 |
| --- | --- | --- |
| 一覧（本文なし、新しい順） | `GET /api/notes` | 200 `{notes, limit}` |
| 1件取得（本文あり） | `GET /api/notes/<id>` | 200、なければ 404 |
| 保存 | `POST /api/notes`（JSON: `body` 必須、`title` と `persona` は任意） | 201。本文が実質空なら 200 `{saved:false, reason:"empty_body"}`。200 件に達していれば 409 |
| 1件削除 | `DELETE /api/notes/<id>` | 200、なければ 404 |
| 全削除 | `DELETE /api/notes?confirm=delete-all` | 200 `{deleted: 件数}`。確認の値がない、または違えば 400 で何も消さない |

その他のステータス: 400（不正な JSON、`body` などの型の誤り）、401（サインインなし、許可外のメール）、403（Origin が違う）、405、413（64 KB 超）、415（JSON 以外）、429（回数制限）、503（設定不足、回数制限の D1 が使えない、`notes` 表が使えない）。

上限:

- リクエスト本文は 64 KB（65,536 バイト）まで。`Content-Length` が超えていれば読む前に 413、ヘッダーがなくても、読んだバイト数が超えれば 413。本文を読むのは、認証と回数制限のあとです。
- `body` は 8,000 文字まで。超えたら先頭から 8,000 文字を保存し、末尾に「（以降省略）」を付け、`truncated` を 1 にします（保存される本文は最大 8,006 文字）。文字は Unicode のコードポイントで数え、絵文字などを途中で割りません。前後の空白を除いて空なら、何も保存しません。
- `title` は 30 文字、`persona` は 32 文字まで（超えたら切る。省略できる）。
- 件数は 200 件まで。達したら保存せず、古いメモは消しません。件数の判定と保存は、1つの SQL 文（`INSERT … SELECT … WHERE (SELECT COUNT(*) FROM notes) < 200 RETURNING id`）です。
- 回数制限（60 秒の枠）: 書き込み系（保存・1件削除・全削除）を合わせて 10 回、読み取り系（一覧・1件取得）を合わせて 30 回。key は `notes:write:<メール>` と `notes:read:<メール>`。`live-token` の key（メールだけ）とは別で、互いの回数に影響しません（テストと実験で確認）。不正な JSON や、確認のない全削除も 1 回に数えます。

### 認証（`live-token` との違い）

`functions/api/notes/index.ts` の認証と設定不足の確認は、`functions/api/live-token.ts` から複製したものです（順番も同じ: メソッドとパス、Origin、設定（503）、サインイン、メール、回数制限、本文、D1）。JWT や Google の検証そのもの（`functions/_shared/`）は、共通のものを使っています。

| 点 | `live-token` | `notes` |
| --- | --- | --- |
| 許可外のメール（`access` 経路） | 403 | 401 |
| 許可外のメール（`google` 経路） | 401（検証の中で拒否） | 401（同じ） |
| Origin | POST のみ。必須で、一致しなければ 403 | POST と DELETE は同じ。GET は Origin がなければ通し、あって違えば 403 |
| 使うメソッド | POST のみ | GET、POST、DELETE（他は 405 と `Allow`） |
| `GEMINI_API_KEY` | 必要 | 不要 |

**認証の処理を直すときは、`live-token.ts` と `notes/index.ts` の両方を見てください。片方だけ直すと、違いが広がります。**

### 個人データの扱い

- メモの本文は、アプリ側では暗号化せず、D1 にそのまま保存されます。D1 側の保存時の扱いは確認していません。
- ログ、エラー文、応答に、本文、メール、トークンを出しません（`console` を使っていないことと、失敗時の応答にそれらが入らないことを、テストで確認しています）。保存の応答は本文を返しません。
- 応答には `Cache-Control: no-store` を付けます。CORS の許可は足していません。
- SQL の値は、すべて `bind` で渡します（文字列をつなげて SQL を作りません）。本文は文字として保存・返却し、HTML としては扱いません。
- 回数制限の key には、許可メール（前後の空白を除き、小文字にしたもの）がそのまま入ります。ハッシュにはしていません。`live-token` も同じ方式で、`notes` はその前に `notes:write:` か `notes:read:` を付けただけです。`rate_limits` の行は、次の呼び出しで新しい枠に入るまで消えないため、最後の呼び出しの行は残り続けることがあります（実験で確認）。

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
| 回数制限の数えが、思ったより早く 0 に戻る（枠を60秒以外にした場合。実験で確認、本番では起きていない） | `functions/_shared/rate-limit.ts` の古い行を消す処理（`DELETE FROM rate_limits WHERE window_start < 今の枠の開始`）は、全キーに効く。枠の長さが違うキーがあると、新しい枠の呼び出しが、別の長さの枠のカウンターを消す（1時間の枠の9回が60秒の枠の呼び出しで、60秒の枠の9回が10秒の枠の呼び出しで消えた）。`live-token` も `notes` も60秒で、変えない。変えるなら、消し方を先に直す。この処理は `rate_limits` にだけ働き、`notes` のメモは消えない |

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
- メモ保存の画面（自動保存のスイッチ、メモの一覧と削除）は未着手です。
- `/api/notes` を本番に出すこと（利用者の許可と、本番ブランチへの取り込みが要ります）。

## 状態（作業2 完了時点）

- 作業用ブランチ `feat/notes` のコミット: 作業1（`migrations/0002_notes.sql` とそのテスト）が `cd17015`、作業2（`/api/notes` とそのテスト）が `d5d52bd`。
- 本番ブランチ `feat/gemini-live-iphone-cloudflare-impl` は `a5d7f54` のままです。
- `/api/notes` は、`feat/notes` のプレビューにだけあります（Cloudflare のビルドが成功したところまで確認。動作は未確認）。本番には出ていません。本番に出すには、利用者の許可と、本番ブランチへの取り込みが要ります。
- `notes` 表は、本番の D1 にあります（利用者が手で実行。利用者の報告）。本番のコードはまだ使いません。
- 作業3（画面）は未着手です。

## 未確認のこと

- 本物の D1 での `INSERT … SELECT … RETURNING`、`DELETE … RETURNING` の動作。テストは `node:sqlite` で行いました。D1 が書き込みを順番に処理するため、同時に保存しても 200 件を超えない、という点も推測です。
- `/api/notes/<id>` のルート（`functions/api/notes/[id].ts`）が、Cloudflare 上で動くこと。ビルドは成功しています。
- Workers での `Intl.Segmenter` の動作。使えない場合は、絵文字の並び（家族の絵文字など）が途中で切れることがあります（半端な文字にはなりません）。
- プレビューの D1 接続の有無と、プレビューでの API の動作。
- `RATE_LIMIT_DB` の接続先が `ken-rate-limits` であること（「D1 の名前と実態のずれ」の節）。
- Cloudflare 側のビルド設定で、migration が自動で適用されないこと。D1 に保存した本文の、Cloudflare 側での保存時の扱い。
- 型チェックの版の差。`tsc` 7.0.2 で確認しましたが、`package.json` は `^6.0.3` です。6.x での結果は未確認です。追加したテストファイルは、`tsconfig.json` が型チェックの対象から外しています。
