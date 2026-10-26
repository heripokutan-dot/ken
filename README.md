# ken

## Gemini Live 音声会話アプリ（ローカル試作）

Python のローカルサーバーとブラウザーを使い、日本語で Gemini Live と音声会話する試作アプリです。会話や音声はこのアプリ内に保存しません。

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
$env:GEMINI_API_KEY = Read-Host "Gemini API key"
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

その後、http://127.0.0.1:8000 を開きます。PowerShell では `Read-Host` の入力がマスクされない環境もあるため、必要ならユーザー環境変数などの安全な方法で API キーを設定してください。

### テスト

```bash
python -m pytest -q
node --test tests/test_pcm_utils.mjs
```

### セキュリティと制限

- アプリは `127.0.0.1` でのみ起動してください。公開サーバーや他の端末からアクセスできる設定にはしないでください。
- 長期 API キーはローカルサーバーでのみ使用し、ブラウザーには短時間・単一セッション用のエフェメラルトークンだけを渡します。
- エフェメラルトークンと Live API はプレビュー機能として案内されているため、利用可否や仕様は変更される可能性があります。
- Gemini API の利用にはアカウントの割り当てや料金が適用される場合があります。
- この試作は会話履歴を保存せず、アカウント、カメラ、公開ホスティングには対応しません。
