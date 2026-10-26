# Gemini Live iPhone 音声会話アプリ — Cloudflare 配置設計

**状態:** ユーザー承認待ち（設計案）  
**リポジトリ:** `heripokutan-dot/ken`  
**設計ブランチ:** `feat/gemini-live-iphone-cloudflare-design`  
**対象:** iPhone Safari、個人利用  
**日付:** 2026-10-27

## 1. 目的

既存の Gemini Live ブラウザー音声会話試作を、PCを起動・接続しておかなくても iPhone の Safari から利用できる、本人専用の HTTPS Web アプリにする。ログインにはユーザー本人のメールアドレスを使う。既存の基本方針である「長期 Gemini API キーをブラウザーへ渡さず、サーバー側で管理し、ブラウザーには制約付きの短命エフェメラルトークンだけを渡す」を維持する。

## 2. 目標

- iPhone Safari でページを開き、本人のメールアドレスで認証して音声会話を開始できる。
- PCが稼働していなくても使える。
- マイクの取得、音声ストリーミング、音声再生、文字起こし、割り込み、終了を既存の試作から引き継ぐ。
- 長期 API キーを GitHub、HTML、JavaScript、ブラウザーのストレージ、クライアント向けレスポンスへ含めない。
- アプリは指定した本人のメールアドレスだけに限定し、トークン発行エンドポイントを認証・濫用対策で保護する。
- 会話音声・文字起こし・履歴をアプリのサーバー側へ保存しない。
- 既存の API スモークテスト、TTS、GitHub Actions ワークフローを変更・実行しない。

## 3. 対象外

- App Store 配布のネイティブ iOS アプリ。
- 複数ユーザー対応、公開サインアップ、会話履歴の保存、音声録音の保存。
- Gemini の音声データを自前サーバー経由で中継すること。
- 自動デプロイ、GitHub Actions の変更・実行、独断でのマージ。
- API 利用料金・割り当ての無制限化。Google 側の制限と課金条件は引き続き適用される。

## 4. 検討した方式と選択

1. **Cloudflare Pages + Pages Functions + Cloudflare Access（選択）**  
   静的フロントエンドを Pages で配信し、Functions でトークンを発行する。Access のメールワンタイム PIN 認証で本人だけにアクセスを許可する。PC不要で HTTPS を使え、既存の単純な HTML/CSS/JavaScript を活かしやすい。
2. **Google Cloud 上で FastAPI を運用**  
   既存の Python バックエンドを再利用しやすい一方、ランタイム、公開エンドポイント、認証、スケーリング等の運用対象が増える。
3. **ネイティブ iOS アプリ**  
   iPhone 体験を細かく制御できるが、Swift 実装・署名・配布などの作業が増え、今回は「Safariで使う」という希望より範囲が広い。

**選択理由:** Cloudflare 方式は既存のブラウザー UI を再利用しながら、PC不要・HTTPS・サーバー側シークレット・メール認証を実現できるため。

## 5. 構成

```text
iPhone Safari
  ├─ HTTPS ──> Cloudflare Access
  │               └─ 指定メールアドレスへワンタイム PIN
  ├─ HTTPS ──> Cloudflare Pages（HTML / CSS / JS）
  ├─ HTTPS ──> Pages Function: POST /api/live-token
  │               ├─ Access 認証の確認
  │               ├─ Origin / Content-Type / メソッドの確認
  │               ├─ 発行頻度の制限
  │               └─ Cloudflare Secret の GEMINI_API_KEY で短命トークンを発行
  └─ WSS ────> Gemini Live API（短命トークンを使用）
```

音声のリアルタイム送受信はブラウザーから Gemini Live API へ直接行う。Pages Functions は音声データを中継しない。

## 6. 認証とアクセス制御

- Cloudflare Access の Self-hosted application でアプリのホスト名全体を保護する。
- 認証方式はメールのワンタイム PIN とする。Allow policy はユーザーが指定した本人のメールアドレスだけを許可し、公開サインアップや広いドメイン許可は設けない。
- トークン発行 API も同じ Access 保護対象とし、未認証リクエストは Functions に到達する前に拒否する。
- Functions 側でも Access JWT の issuer と audience を検証し、設定された Access アプリ向けの認証であることを確認する。検証に必要な値は環境設定として保持し、クライアントから受け取った値を信頼しない。
- `POST /api/live-token` は同一オリジンの要求だけを受け付け、許可しない CORS は設定しない。GET など別メソッドではトークンを発行しない。
- ログイン後の画面にログアウト導線を設け、Cloudflare Access のセッション終了方法を案内する。

## 7. API キーとエフェメラルトークンの保護

- `GEMINI_API_KEY` は Cloudflare Pages/Functions の Secret として登録し、リポジトリ、コミット、フロントエンド、URL、ブラウザーの localStorage/sessionStorage/cookie に保存しない。
- Functions は Google の公式 API/SDK を用いてトークンを発行し、API キーやトークンの値をログに出さない。
- トークンは用途を単一セッションに制限し、モデルを既存試作で使う `gemini-3.8-live` に固定する。必要な音声入出力・文字起こし設定と日本語向け指示だけを許可する。
- セッション開始可能時間を短くし、セッション有効期間も必要最小限にする。具体的なトークンフィールド・上限値は実装時に最新の公式 Gemini Live API 仕様を確認して決定する。
- トークン API の応答に `Cache-Control: no-store` を付け、トークンを永続化しない。ブラウザーのエラー表示にはトークン、API キー、プロバイダー例外の詳細を含めない。
- API キーが未設定の場合は安全なエラーを返し、プロバイダー障害時も例外の生データをクライアントへ返さない。

## 8. 濫用・コスト対策

- `/api/live-token` に Cloudflare のレート制限を設定し、短時間に大量のトークンを発行できないようにする。
- アプリ側でも連続クリックや多重リクエストを防ぎ、接続ごとに新しいトークンを要求する。失敗時の自動再試行は無制限に行わない。
- 制限ルールが利用プランで使えるかはデプロイ前に確認する。利用できない場合は、対応する Cloudflare の保護機能または追加のサーバー側制限を設計レビュー後に選び、無保護のまま公開しない。
- API 利用量・料金の上限は Gemini API 側のプロジェクト設定でも確認する。レート制限は課金上限そのものではない。

## 9. iPhone Safari と音声 UX

- Pages の HTTPS URL で配信する。マイク取得には HTTPS のセキュアコンテキストが必要。
- ユーザーの明示的なタップで会話を開始し、その操作内で音声コンテキストを起動する。マイク権限が拒否された場合、Safari が非対応の場合、通信が切れた場合に日本語の回復可能なエラーを表示する。
- 既存の AudioWorklet による 16 kHz mono PCM16 入力、24 kHz mono PCM16 再生、文字起こし表示、割り込み、終了処理を維持する。iOS Safari で必要な差分があれば最小限に対応する。
- 画面は狭い縦画面を前提にし、タップしやすい操作ボタンと明確な接続状態を設ける。
- 会話をサーバー側へ保存しないことを画面に明記する。ただし、Gemini API 提供者側のデータ処理はアプリの保存方針とは別であることを説明する。

## 10. 変更範囲の見込み

- フロントエンド：既存 `frontend/` の HTML/CSS/JS を Pages で配信できる形に整え、ログイン後の状態・エラー・モバイル表示を追加する。
- バックエンド：ローカル専用 FastAPI のトークン発行ロジックを、Cloudflare Pages Functions（TypeScript/JavaScript）へ移植する。既存の `server.py` はローカル試作用として残し、必要がない限り削除・置換しない。
- 配置設定：Pages のビルド／出力設定、Functions ルート、必要な Access 設定手順をドキュメント化する。
- テスト：Functions のトークン発行・Access JWT 検証・不正 Origin・API キー未設定・エラーの安全な処理・レート制限の振る舞いを検証する。既存の Python/JavaScript テストは引き続き通す。
- ドキュメント：Cloudflare の初期設定、独自ホスト名または Pages URL の選び方、Secret 登録、Access の許可メール設定、デプロイ、ロールバック、キーのローテーション手順を記載する。

## 11. 受け入れ条件

1. 未認証または許可されていないメールアドレスではアプリとトークン API を利用できない。
2. 認証済みの本人が iPhone Safari で HTTPS ページを開き、マイク許可後に日本語で話して音声応答を聞ける。
3. ブラウザー配信物、開発者ツールで見えるクライアント応答、ログ、Git 履歴に長期 API キーが現れない。
4. トークンは毎回短命・単一セッション・モデル制限付きで、キャッシュ・永続化・ログ出力されない。
5. トークン発行 API は Access 認証、Origin 検証、レート制限で保護される。
6. 終了操作でマイクのトラック、WebSocket、AudioContext、再生中の音声を停止する。
7. 会話・音声のサーバー側保存がなく、エラー時に秘密情報が漏れない。
8. 既存のスモークテスト／TTS／GitHub Actions は変更も実行もしない。

## 12. 検証計画と制約

- 自動テストでは Google API をモックし、実 API キーなしでトークン設定、失敗系、認証拒否、レート制限を検証する。
- デプロイ前に設定手順と Secret の扱いをレビューする。実際の Cloudflare アカウント設定や Secret 登録は、ユーザーの明示的な許可後に行う。
- 公開後の実機テストは iPhone Safari で実施する。自動テストだけで iOS のマイク許可・バックグラウンド遷移・音声再生を保証しない。
- Gemini Live のエフェメラルトークン機能はプレビューとして変更される可能性があるため、実装時点の公式仕様で確認する。
- 料金、クォータ、Cloudflare のプラン別機能、カスタムドメインの利用可否は実際のアカウント設定で確認する。

## 13. 公式資料

- Google Gemini API — [Ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens?hl=ja)
- Google Gemini API — [Live API WebSocket guide](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket)
- Cloudflare — [Pages Functions bindings and secrets](https://developers.cloudflare.com/pages/functions/bindings/)
- Cloudflare — [Cloudflare Access for self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)
- MDN — [getUserMedia()](https://developer.mozilla.org/ja/docs/Web/API/MediaDevices/getUserMedia)

## 14. 設計段階で残す確認事項

- ユーザーが許可する本人のメールアドレス（Cloudflare Access の許可リスト設定時に必要）。
- Cloudflare アカウント、Pages プロジェクト、ホスト名の選択と、利用可能なレート制限機能。
- Gemini Live の現行トークン作成 API/SDK と制約フィールド。
- iOS Safari の実機テストで必要になる AudioContext・割り込み・画面ロック時の扱い。

これらは実装またはデプロイ時の確認事項であり、設計承認前に API キーやメールアドレスなどの秘密情報を要求しない。実装・デプロイ・GitHub Actions の実行は、この設計書の承認後に別途計画と許可を得て行う。
