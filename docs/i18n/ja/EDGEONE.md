# Tencent EdgeOne Makers デプロイチュートリアル

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | **日本語** | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 英語原文から同期（日本語版）

SMSToWeb を Tencent EdgeOne Makers（旧 EdgeOne Pages、Functions + Turso データベース）へデプロイします。中国国内からのアクセス体験が良く、全体の所要時間は約 15 分です。

**このディレクトリのファイル**：`functions/index.js`（ルートパス `/` 専用のエントリ。すべてのロジックと ENV_KEYS ホワイトリストの単一ソース）、`functions/[[default]].js`（その他のルートを捕捉するフォールバック。index.js を re-export するだけで個別メンテナンス不要）、`app.js`（コアアプリ）、`db.js`（Turso アダプタ）、`schema.sql`（テーブル作成）。

---

## 事前準備

1. Tencent Cloud アカウント 1 つ（[登録入口](https://cloud.tencent.com)。実名認証が必要）
2. GitHub アカウント 1 つ（EdgeOne Makers は Git リポジトリからのデプロイに対応）

## ステップ 1：コードリポジトリの準備

プロジェクトの GitHub リポジトリを開き、右上の **Fork** をクリック（または自分がすでに Push 済みのリポジトリを使用）。

## ステップ 2：Turso データベースの作成

Turso は SQLite 互換のデータベースを提供します（無料枠：データベース 100 個、5GB ストレージ、月 5 億行の読み取り）。EdgeOne Functions 内から外部データベースへのアクセスは自由です。

1. [turso.tech](https://turso.tech) を開き、**Start for free now** をクリックして GitHub でログイン
2. コンソールに入る → **Create Database**：
   - Name：`sms-gateway`
   - Location：Singapore / Hong Kong を推奨（中国国内からのアクセス遅延が低い）
   - Type：Free
3. 作成後、データベースの詳細ページに入る：
   - **Database URL**（`libsql://sms-gateway-xxxx.turso.io` の形式）を控える
   - **Create Token** をクリックしてアクセストークンを作成し、**すぐにコピーして保存**（一度しか表示されません）
4. テーブル構造の初期化：データベース詳細ページ → **Console** → このディレクトリの [`schema.sql`](../../../platforms/edgeone/schema.sql) の全内容を貼り付け → 実行 → 成功と表示されます

> Turso CLI も使えます：`turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`。

## ステップ 3：EdgeOne Makers でプロジェクトを作成

1. Tencent Cloud コンソールにログイン → **EdgeOne Makers** を検索（旧「EdgeOne Pages」。または [console.cloud.tencent.com/edgeone/pages](https://console.cloud.tencent.com/edgeone/pages) にアクセス）
2. **プロジェクトを作成** → **Git リポジトリからインポート**を選択 → GitHub を認証して Fork したリポジトリを選ぶ
3. ビルド設定：
   - **ルートディレクトリ**：`platforms/edgeone`
   - フレームワークプリセット：「なし / Other」を選択または空欄（純粋な Functions なのでビルド不要）
4. 環境変数の設定欄で先に変数を追加（ステップ 4 参照）してから、デプロイを開始
5. デプロイ完了（約 1 分）を待ち、割り当てられたデフォルトドメイン（例：`*.edgeone.app`）を控える

## ステップ 4：環境変数の設定

プロジェクトの **設定 → 環境変数** で 1 つずつ追加します（Functions は `onRequest` の `env` パラメータ経由で読み取ります）：

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

保存後に再デプロイすると有効になります。

## ステップ 5：デプロイの検証

1. ブラウザで割り当てられたドメインを開くと、管理画面が表示されるはずです（デフォルトは「短信网关」。ログイン有効時は先にログインページ）
2. プッシュ API を検証します：

```
curl "https://<ドメイン>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"EdgeOne 部署成功\"}"
```

`{"success":true,...}` が返れば接続 OK で、Web ページにすぐこのメッセージが現れます。

## ステップ 6：カスタムドメインのバインド（中国国内アクセス向けに推奨）

1. プロジェクトの **設定 → カスタムドメイン** → あなたのドメインを追加（例：`sms.あなたのドメイン.com`）
2. 案内に従ってドメインの DNS に CNAME レコードを追加し、EdgeOne が割り当てたアドレスへ向ける
3. ドメインは ICP 備案（ICP 登録）が完了している必要があります（Tencent Cloud 中国国内ノードの要件）。未備案のドメインは解決を拒否されます

## ステップ 7：定期クリーンアップの設定（外部 cron）

EdgeOne Makers には現時点でネイティブの定時タスクがないため、任意の無料外部 cron サービスで毎日 1 回クリーンアップ API を呼びます：

1. [cron-job.org](https://cron-job.org) を開いて登録し、**Create cronjob**：
   - URL：`https://<あなたのドメイン>/api/cron?token=<あなたのRECEIVE_TOKEN>`
   - Schedule：毎日（例：北京時間 01:00、すなわち UTC 17:00）
2. 保存して有効化。時刻になるとゲートウェイが `RETENTION_DAYS` を超えたデータを自動削除します

## スマホとデバイスの接続

[マルチプラットフォームデプロイ & 取り込みガイド](./DEPLOYMENT.md)に従って Android SmsForwarder と各デバイスの通知プッシュを設定し、ドメインはあなたの EdgeOne ドメインを使用してください。

## 注意事項とよくある質問

- **ルートパスが 404 になる（重要、2026-10 実機検証）**：EdgeOne Makers の Functions ルーティングルールでは、`[[default]].js` のフォールバックは `/foo`、`/api/xxx` などの非ルートパスにのみマッチし、**ルートパス `/` は `functions/index.js` のみを認識します** — このファイルが欠けていると、トップページを開くとプラットフォームのデフォルト 404 ページに直行します（API エンドポイントは正常）。このディレクトリには解決策として `functions/index.js` を内蔵しています（ロジックと ENV_KEYS ホワイトリストの単一ソース。`[[default]].js` はそれを re-export するだけで 2 箇所のメンテナンスは不要）
- **ロングポーリング**：Functions の実行時間上限が比較的厳しいため、`/api/wait`（25 秒滞留）は途中で切断されることがあります — フロントエンドが自動リトライするため機能には影響しません
- **デプロイ失敗の排查**：ルートディレクトリは必ず `platforms/edgeone` にすること。`TURSO_*` 環境変数が欠けると 500 で "config error" になります
- **コードの更新**：GitHub リポジトリへ push すると自動で再デプロイされます
