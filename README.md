# ken

## Gemini Live 音声会話アプリ（ローカル試作）

Python のローカルサーバーとブラウザーを使い、日本語で Gemini Live と音声会話する試作アプリです。会話や音声はこのアプリ内に保存しません。

### ホスト版（Cloudflare Pages・iPhone Safari 向け）

`frontend/` を Cloudflare Pages で配信し、`functions/api/live-token.ts` がトークンを発行する構成です。PC を起動しておく必要はありません。利用は Google サインインで、許可された本人のアカウントのみです（カード登録を前提としない構成です。ただし、各サービスで支払い情報を求められる可能性は未確認のため、求められた場合は手順書の指示どおり停止してください）。

- 現状の構成、設定、落とし穴は [プロジェクトの現状と引き継ぎメモ](docs/project-status.md) にまとめています。
- 配置・Secret・サインイン・D1 によるレート制限の手順は [セットアップガイド](docs/superpowers/plans/2026-10-27-gemini-live-iphone-cloudflare-setup.md) を参照してください。
- 設定が揃うまでトークン API は安全側に倒れ（503）、トークンを発行しません。
- 本番デプロイ・Secret 登録・GitHub Actions の実行は、利用者の明示的な許可があるまで行いません。
- 以下の「ローカル試作」の手順は、この Pages 版とは別の経路です。

### 必要なもの

- Python 3.12 以降
- 最新の Chrome または Edge（マイクと AudioWorklet に対応したブラウザー）
- Gemini API キーと、Gemini Live API を利用できるアカウント／割り当て

### 起動方法（macOS / Linux）

リポジトリのルートで、依存関係をインストールします。

```bash
python -m pip install -r requirements.txt
```

API キーを画面に表示せず入力し、サーバーをループバックアドレスだけで起動します。

```bash
read -s -p "Gemini API key: " GEMINI_API_KEY
echo
export GEMINI_API_KEY
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

ブラウザーで http://127.0.0.1:8000 を開き、「会話を開始」を押してマイクの使用を許可してください。終了時は「終了」を押し、サーバーのターミナルで `Ctrl+C` を押します。

### Windows PowerShell

```powershell
python -m pip install -r requirements.txt
$secure = Read-Host "Gemini API key" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:GEMINI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

その後、http://127.0.0.1:8000 を開きます。サーバー停止後は `Remove-Item Env:GEMINI_API_KEY` で環境変数を削除してください。

### テスト

```bash
python -m pytest -q
node --test tests/test_pcm_utils.mjs
node --test tests/test_error_messages.mjs
npm test   # Pages Functions（Node 22 以降）と frontend の Node テストをまとめて実行
```

### セキュリティと制限

- アプリは `127.0.0.1` でのみ起動してください。公開サーバーや他の端末からアクセスできる設定にはしないでください。
- 長期 API キーはローカルサーバーでのみ使用し、ブラウザーには短時間・単一セッション用のエフェメラルトークンだけを渡します。
- エフェメラルトークンと Live API はプレビュー機能として案内されているため、利用可否や仕様は変更される可能性があります。
- Gemini API の利用にはアカウントの割り当てや料金が適用される場合があります。
- この試作は会話履歴を保存せず、アカウント、カメラ、公開ホスティングには対応しません。
