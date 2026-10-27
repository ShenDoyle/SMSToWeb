# セルフホストデプロイチュートリアル（Fly.io / Railway / VPS / ローカル）

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | **日本語** | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 英語原文から同期（日本語版）

SMSToWeb を Docker コンテナとしてセルフホストします。プロセスが常駐し関数の実行時間制限がなく、ロングポーリングのリアルタイム性が最良です。既存サーバーがあるユーザーや Fly.io / Railway へデプロイしたいユーザーに適しています（無料枠の状況は下記「プラットフォームの説明」参照）。

**このディレクトリのファイル**：`server.mjs`（Node 18+ 依存ゼロのエントリ、内蔵の毎日クリーンアップを含む）、`app.js`（コアアプリ）、`db.js`（Turso / ローカル SQLite デュアルモードアダプタ）、`schema.sql`（テーブル作成）、`Dockerfile`、`package.json`。

---

## 事前準備

- Fly.io または Railway のアカウント（または Docker が使える任意の VPS）
- データベースは引き続き Turso（SQLite 互換）を使用します。ステップ 1 で一括準備します

## ステップ 1：Turso データベースの作成

1. [turso.tech](https://turso.tech) を開き、**Start for free now** をクリックして GitHub でログイン
2. コンソールに入る → **Create Database**：
   - Name：`sms-gateway`
   - Location：サーバーに近いリージョンを選択
   - Type：Free
3. 作成後、データベースの詳細ページに入る：
   - **Database URL**（`libsql://sms-gateway-xxxx.turso.io` の形式）を控える
   - **Create Token** をクリックしてアクセストークンを作成し、**すぐにコピーして保存**（一度しか表示されません）
4. テーブル構造の初期化：データベース詳細ページ → **Console** → このディレクトリの [`schema.sql`](../../../platforms/node/schema.sql) の全内容を貼り付け → 実行 → 成功と表示されます

> CLI 方式：`turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`。

## 方式 A：Fly.io

1. ローカルに flyctl をインストール（[公式インストールガイド](https://fly.io/docs/flyctl/install/)）した後、`fly auth login`
2. このディレクトリで実行：

```bash
cd platforms/node
fly launch                 # 案内に従ってアプリを作成：リージョンは自由選択。データベースを尋ねられたら No（Turso を使うため）
fly secrets set TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io TURSO_AUTH_TOKEN=<あなたのトークン> RECEIVE_TOKEN=<あなたのシークレット>
fly secrets set ENABLE_AUTH=true ADMIN_PASSWORD=<あなたのパスワード>     # 任意
fly deploy
fly status                 # 割り当てられたドメイン https://<app>.fly.dev を控える
```

3. 検証：ブラウザで `https://<app>.fly.dev` を開くと管理画面が表示されるはずです。プッシュテスト：

```
curl "https://<app>.fly.dev/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Fly 部署成功\"}"
```

4. カスタムドメイン：`fly certs add sms.あなたのドメイン.com` を実行し、案内に従って DNS を追加（A レコードまたは CNAME）

## 方式 B：Railway

1. [railway.app](https://railway.app) にログイン → **New Project → Deploy from GitHub repo** で Fork したリポジトリを選択
2. サービス設定 **Settings → Root Directory**：`platforms/node`（Railway が Dockerfile を自動認識してビルドします）
3. **Variables** パネルで環境変数を追加（下記の共通表参照。`PORT` はプラットフォームが自動注入し、コードは対応済み）
4. **Settings → Public Networking → Generate Domain** で公開ドメインを生成
5. 検証は上記と同じ（ドメインをあなたの Railway ドメインに置き換える）

## 方式 C：任意の VPS（Docker）

```bash
# このディレクトリをサーバーへアップロードした後
cd platforms/node
docker build -t smstoweb .
docker run -d --name smstoweb --restart unless-stopped -p 8787:8787 \
  -e TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io \
  -e TURSO_AUTH_TOKEN=<あなたのトークン> \
  -e RECEIVE_TOKEN=<あなたのシークレット> \
  smstoweb
# 検証
curl "http://127.0.0.1:8787/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"content\":\"VPS 部署成功\"}"
```

HTTPS を追加するには Caddy/Nginx によるリバースプロキシを推奨します。Docker を使わなくても直接 `node server.mjs` で実行できます（Node 18+ が必要、npm 依存ゼロ。ローカル SQLite モードは Node 22.13+ が必要）。

## 環境変数（3 方式共通）

| 名称 | 値 | 説明 |
|---|---|---|
| `SQLITE_PATH`（任意） | 例：`/data/data.db` | **ローカル SQLite モード**：設定すると外部データベース不要になり、データはローカルファイルに保存（Node 22.13+ が必要、初回起動時にテーブルを自動作成。Turso との二択で、設定すると優先） |
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | Turso モード：ステップ 1 で控えた URL |
| `TURSO_AUTH_TOKEN` | （ステップ 1 のトークン） | Turso モード：一度しか表示されないあのトークン |
| `RECEIVE_TOKEN` | 自作の長いランダム文字列 | プッシュ認証。サンプル値は使わないこと |
| `ENABLE_AUTH` | `false` | ログインが必要なら `true` に変更（**セキュリティ上強く推奨**：管理画面は SMS 認証コードなどの機密情報を扱うため、デフォルトのログインなしはドメインを知るだけで全メッセージを閲覧できることを意味します） |
| `ADMIN_PASSWORD` | 自作のパスワード | `ENABLE_AUTH="true"` のときだけ必要 |
| `SESSION_SECRET` | 高エントロピーな乱数値（≥32 文字のランダム文字列） | `ENABLE_AUTH="true"` のときだけ必要。パスワードとは独立。欠落時はログイン/認証が安全に失敗し、ローテーション後はすべての旧セッションが無効になる |
| `RETENTION_DAYS` | `30` | データ保持日数 |
| `PORT` | デフォルト `8787` | 通常は設定不要（Railway が自動注入） |
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

## スマホとデバイスの接続

[マルチプラットフォームデプロイ & 取り込みガイド](./DEPLOYMENT.md)に従って Android SmsForwarder と各デバイスの通知プッシュを設定し、ドメインはあなたのサービスアドレスを使用してください。

## 注意事項とよくある質問

- **定期クリーンアップ**：プロセスに内蔵されており、毎日 UTC 17:00（北京時間 01:00）に自動クリーンアップします。設定不要です。プラットフォームのスケジューラ（Fly Machines Cron / Railway Cron）で `GET /api/cron?token=<RECEIVE_TOKEN>` を呼ぶ方法に切り替えることもでき、どちらか一方を選択します
- **常駐プロセスの利点**：関数の実行時間上限がなく、`/api/wait` ロングポーリングは Cloudflare Worker 版と同じ体験で、リアルタイム性は最良です
- **無料枠**：Fly.io には現在無料枠がありません（新アカウントのみ 7 日間 / 2 VM 時間のトライアル。カード登録で従量課金に移行しますが、微量使用の費用は非常に低い）。Railway は一度限りの $5 トライアルクレジット（30 日有効）を提供し、Hobby プランは $5/月で同額の使用枠が含まれます — 長期的なゼロコストなら Cloudflare 主力版が第一候補です
- **データバックアップ**：Turso モードではデータはすべて Turso 上にあるため、サーバーを替えるときは環境変数を設定し直すだけでデータは無傷です。ローカル SQLite モードでは `SQLITE_PATH` のファイルを定期的にバックアップするだけです
- **ログイン保護**：ログイン API にはレート制限が組み込まれています — 同一 IP で連続 5 回失敗すると 10 分ロック（メモリ上の状態で、プロセス再起動でリセット）
- **http デプロイでのログイン**：LAN IP / TLS なしの http アクセスでも直接ログインできます（Cookie は自動でダウングレードし、Secure を強制しません）。Alook などのブラウザでもログイン後のリダイレクトは正常です
- **ログの排查**：`fly logs` / Railway Deployments → Logs / `docker logs smstoweb`
