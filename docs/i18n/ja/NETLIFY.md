# Netlify デプロイチュートリアル

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | **日本語** | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 英語原文から同期（日本語版）

SMSToWeb を Netlify（Functions v2 + Turso データベース）へデプロイします。全体の所要時間は約 15 分です。

**このディレクトリのファイル**：`functions/api.mjs`（エントリ、`path: "/*"` ですべてのルートを捕捉）、`functions/cron.mjs`（定期クリーンアップの Scheduled Function）、`app.js`（コアアプリ）、`db.js`（Turso アダプタ）、`schema.sql`（テーブル作成）、`netlify.toml`（サイト設定）。

---

## ワンクリックデプロイ（推奨）

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/ShenDoyle/SMSToWeb)

ボタンをクリックするとリポジトリがあなたの GitHub へクローンされ、作成ウィザードに入ります。2 点に注意：

1. **ビルド設定の Base directory に `platforms/netlify` を入力**（本プラットフォームの `netlify.toml` はこのサブディレクトリにあり、正しく入力すればビルドコマンドなどが自動で引き継がれます）。それ以外はデフォルトのままで OK
2. まず下記のステップ 2（Turso データベースの作成）を完了して接続情報を取得し、作成後に **Site configuration → Environment variables** で `RECEIVE_TOKEN` / `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` を入力して再デプロイ。最後にステップ 3 のテーブル作成 SQL を実行（Netlify はテーブルを自動作成できません）

---

## 事前準備

1. GitHub アカウント 1 つ
2. Netlify アカウント 1 つ（[登録入口](https://app.netlify.com/signup)。GitHub でそのままログインできます）

## ステップ 1：コードリポジトリの準備

プロジェクトの GitHub リポジトリを開き、右上の **Fork** をクリック（または自分がすでに Push 済みのリポジトリを使用）。

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
4. テーブル構造の初期化：データベース詳細ページ → **Console** → このディレクトリの [`schema.sql`](../../../platforms/netlify/schema.sql) の全内容を貼り付け → 実行 → 成功と表示されます

> Turso CLI も使えます：`turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`。

## ステップ 3：リポジトリを Netlify へインポート

1. [app.netlify.com](https://app.netlify.com) にログイン → **Add new project → Import an existing project**
2. **Deploy with GitHub** を選択し、認証後にリストから Fork したリポジトリを選択
3. デプロイ設定ページ（Site settings for…）：
   - **Base directory**（ルートディレクトリ）：`platforms/netlify` を入力
   - Build command / Publish directory：デフォルトのままで OK（`netlify.toml` がディレクトリ内にあるため自動で有効になります）
4. 下の **Show advanced → New variable** を展開し、先に環境変数を追加（ステップ 4 参照）してから **Deploy** をクリック

## ステップ 4：環境変数の設定

デプロイ設定ページの高度なオプションで追加します（後から **Project configuration → Environment variables** で変更することもできます）：

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

**Deploy** をクリックし、約 1 分でデプロイが完了します。

## ステップ 5：デプロイの検証

1. デプロイが完了したら、サイトのドメイン（`https://xxx.netlify.app` の形式）を控える
2. ブラウザでそのドメインを開くと、管理画面が表示されるはずです（デフォルトは「短信网关」。ログイン有効時は先にログインページ）
3. プッシュ API を検証します：

```
curl "https://<ドメイン>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Netlify 部署成功\"}"
```

`{"success":true,...}` が返れば接続 OK で、Web ページにすぐこのメッセージが現れます。

## ステップ 6：スマホとデバイスの接続

[マルチプラットフォームデプロイ & 取り込みガイド](./DEPLOYMENT.md)に従って Android SmsForwarder と各デバイスの通知プッシュを設定し、ドメインはあなたの `xxx.netlify.app` を使用してください。

カスタムドメイン：**Project configuration → Change site name**（サブドメインの変更）または **Domain management → Add a domain**（独自ドメイン。案内に従って DNS を追加）。

## 注意事項とよくある質問

- **定期クリーンアップ**：`functions/cron.mjs` は Netlify の Scheduled Function で、デプロイ後に自動登録されます（毎日 UTC 17:00 = 北京時間 01:00）。追加設定は不要です。検証：サイトの **Functions** ページで `cron` 関数とそのスケジュール状態を確認できます
- **関数の実行時間とリアルタイム性**：関数の実行上限は現在 60 秒（全プラン共通）で、管理画面のロングポーリング `/api/wait`（25 秒滞留）は余裕を持って待ち受けられ、リアルタイム性は良好です。リアルタイム性が極めて重要な場合は Cloudflare / セルフホスト版を推奨します
- **無料枠**：2025-09 以降の新アカウントはクレジット制課金です（Free プランは月 300 クレジット、関数の使用量は GB 時間として計上）。個人の小規模トラフィックには十分です。旧アカウントは元のプランのまま使えます
- **デプロイ失敗の排查**：Base directory は必ず `platforms/netlify` にすること。`TURSO_*` 環境変数が欠けると 500 で "config error" になります。サイトの **Functions → api → ログ** でエラーの詳細を確認できます
- **コードの更新**：GitHub リポジトリへ push すると自動で再デプロイされます
