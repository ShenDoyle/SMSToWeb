# Deno Deploy デプロイチュートリアル

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | **日本語** | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 英語原文から同期（日本語版）

SMSToWeb を Deno Deploy（Deno ネイティブランタイム + Turso データベース）へデプロイします。Cloudflare Worker と意味論が最も近く、無料版は月 100 万リクエストで、全体の所要時間は約 15 分です。

> プラットフォームの説明：Deno Deploy は新世代プラットフォームにアップグレード済みで、コンソールは [console.deno.com](https://console.deno.com) です（旧 dash.deno.com は shutting down 済み）。CI に近い Git ビルドモデルを採用しています。

**このディレクトリのファイル**：`main.js`（エントリ、`Deno.serve` と内蔵の `Deno.cron` による定期クリーンアップを含む）、`app.js`（コアアプリ）、`db.js`（Turso アダプタ）、`schema.sql`（テーブル作成）。

---

## 事前準備

1. GitHub アカウント 1 つ
2. Deno Deploy アカウント 1 つ（[登録入口](https://console.deno.com)。GitHub でそのままログインできます）

## ステップ 1：コードリポジトリの準備

1. プロジェクトの GitHub リポジトリを開き、右上の **Fork** をクリック（または自分がすでに Push 済みのリポジトリを使用）

## ステップ 2：Turso データベースの作成

Turso は SQLite 互換のデータベースを提供します（無料枠：データベース 100 個、5GB ストレージ、月 5 億行の読み取り）。

1. [turso.tech](https://turso.tech) を開き、**Start for free now** をクリックして GitHub でログイン
2. コンソールに入る → **Create Database**：
   - Name：`sms-gateway`
   - Location：自分に近いリージョンを選択（例：Singapore / Hong Kong）
   - Type：Free
3. 作成後、データベースの詳細ページに入る：
   - **Database URL**（`libsql://sms-gateway-xxxx.turso.io` の形式）を控える
   - **Create Token** をクリックしてアクセストークンを作成し、**すぐにコピーして保存**（一度しか表示されません）
4. テーブル構造の初期化：データベース詳細ページ → **Console** → このディレクトリの [`schema.sql`](../../../platforms/deno/schema.sql) の全内容を貼り付け → 実行 → 成功と表示されます

> Turso CLI も使えます：`turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`。

## ステップ 3：Deno Deploy でアプリを作成しリポジトリを関連付け

1. [console.deno.com](https://console.deno.com) にログイン → **+ New App**（新規アプリ作成）をクリック
2. **GitHub リポジトリからデプロイ**を選択し、認証して Fork したリポジトリを選ぶ
3. ビルド設定（Build Configuration）：
   - **実行ディレクトリ**（Runtime working directory）：`platforms/deno`
   - **Entrypoint**（エントリファイル）：`main.js`
4. 先に環境変数を追加（ステップ 4 参照）してから、最初のデプロイを起動
5. デプロイ完了後、GitHub リポジトリへの push で自動的に再ビルドされます

## ステップ 4：環境変数の設定

アプリの **Settings → Environment Variables** で 1 つずつ追加します（アプリ作成時の設定ページで追加することもできます）：

| 名称 | 値 | 説明 |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | ステップ 2 で控えた URL |
| `TURSO_AUTH_TOKEN` | （ステップ 2 のトークン） | 一度しか表示されないあのトークン |
| `RECEIVE_TOKEN` | 自作の長いランダム文字列 | プッシュ認証。サンプル値は使わないこと |
| `ENABLE_AUTH` | `false` | ログインが必要なら `true` に変更 |
| `ADMIN_PASSWORD` | 自作のパスワード | `ENABLE_AUTH="true"` のときだけ必要 |
| `SESSION_SECRET` | 高エントロピーな乱数値（≥32 文字のランダム文字列） | `ENABLE_AUTH="true"` のときだけ必要。パスワードとは独立し、他のプラットフォームとは別々の独立した値を設定。欠落時はログイン/認証が安全に失敗し、ローテーション後はすべての旧セッションが無効になる |
| `RETENTION_DAYS` | `30` | データ保持日数 |
| `FEISHU_WEBHOOK`（任意 `FEISHU_SECRET`） | （任意）Feishu グループボットの Webhook | 設定すると新着メッセージを Feishu グループへ自動転送。ボットのセキュリティ設定で「署名検証」を選んだ場合は別途 `FEISHU_SECRET` |
| `WECOM_WEBHOOK` | （任意）WeCom グループボットの Webhook | 設定すると新着メッセージを WeCom グループへ自動転送 |
| `DINGTALK_WEBHOOK` | （任意）DingTalk グループボットの Webhook | 加签（署名追加）のセキュリティ設定では別途 `DINGTALK_SECRET` |
| `SERVERCHAN_SENDKEY` | （任意）ServerChan の SendKey | WeChat プッシュ |
| `PUSHPLUS_TOKEN` | （任意）PushPlus のトークン | WeChat プッシュ |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | （任意）Telegram Bot | 両方設定して初めて有効 |
| `BARK_DEVICE_KEY` | （任意）Bark デバイス Key | 自前サーバーは別途 `BARK_URL`、デフォルトは公式 |
| `NTFY_URL`（任意 `NTFY_TOKEN`） | （任意）ntfy のトピック URL | 完全な URL。例：`https://ntfy.sh/my-sms`。保護トピックは別途 `NTFY_TOKEN`（Token または user:password） |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | （任意）Gotify | サーバーアドレス + アプリトークン |
| `RESEND_API_KEY` + `MAIL_TO` | （任意）メール（Resend） | 任意 `MAIL_FROM`、デフォルトは `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS`（任意 `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`） | （任意）汎用 Webhook | 複数 URL はカンマ区切り。任意のテンプレートでリクエストボディをカスタマイズ、`GENERIC_WEBHOOK_HEADERS`（JSON 文字列）でリクエストヘッダーをカスタマイズ |
| `SITE_NAME` / `SITE_ICON` | （任意） | サイト名 / アイコン URL |
| `NOTIFY_LINK` | （任意） | 管理画面ホームのアドレス。設定するとすべての通知チャネルに「管理画面を開く」エントリが付く。未設定時は自動的に省略 |

保存後、自動再デプロイが有効になるのを待ちます。

## ステップ 5：デプロイの検証

1. 割り当てられたドメイン（`https://<アプリ名>.<組織名>.deno.net` の形式）を控える
2. ブラウザでそのドメインを開くと、管理画面が表示されるはずです（デフォルトは「短信网关」。ログイン有効時は先にログインページ）
3. プッシュ API を検証します：

```
curl "https://<ドメイン>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Deno Deploy 部署成功\"}"
```

`{"success":true,...}` が返れば接続 OK で、Web ページにすぐこのメッセージが現れます。

## ステップ 6：スマホとデバイスの接続

[マルチプラットフォームデプロイ & 取り込みガイド](./DEPLOYMENT.md)に従って Android SmsForwarder と各デバイスの通知プッシュを設定し、ドメインはあなたの `xxx.deno.net` を使用してください。

カスタムドメイン：組織の **Domains** タブでドメインを追加してアプリに割り当て、案内に従ってドメインの DNS に CNAME（または A レコード）と検証レコードを追加します。HTTPS 証明書は自動で発行されます。

## 注意事項とよくある質問

- **定期クリーンアップ**：`Deno.cron` はデプロイ時に自動登録されます（毎日 UTC 17:00 = 北京時間 01:00）。追加設定は不要で、手動でのテスト実行もできません — 検証は Turso のデータが期間どおりに減っているかで確認できます
- **無料枠**：月 100 万リクエスト、Active CPU 10 時間、送信トラフィック 20GiB で、個人利用には十分すぎます
- **ロングポーリング**：Deno Deploy には厳密な単一リクエストの時間上限がなく、`/api/wait` の 25 秒ロングポーリングは良好に動作します。インスタンスがアイドル状態のときはプラットフォームに回収・再起動されることがあります（中断されたロングポーリングはフロントエンドが自動リトライします）。リアルタイム性は Worker 版とほぼ同じです
- **デプロイ失敗の排查**：Entrypoint は必ず `main.js`、実行ディレクトリは必ず `platforms/deno` にすること。`TURSO_*` 環境変数が欠けると 500 で "config error" になります
- **コードの更新**：GitHub リポジトリへ push すると自動で再デプロイされます
