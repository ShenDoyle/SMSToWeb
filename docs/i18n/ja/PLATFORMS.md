# マルチプラットフォームデプロイ概要

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | **日本語** | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 英語原文から同期（日本語版）

SMSToWeb の 6 つのプラットフォームすべて（Cloudflare 主力版 + 5 つの移植版）がこのディレクトリにあります。**各プラットフォームのサブディレクトリは完全に自己完結**しています：
コード（エントリ + コアアプリ + データベースアダプタ）+ `schema.sql` + そのプラットフォームの詳細なデプロイチュートリアル（README.md）。

| プラットフォーム | ランタイム | 定期クリーンアップ | 詳細ガイド |
|---|---|---|---|
| **Cloudflare**（主力版） | Worker + D1 | プラットフォーム cron | [CLOUDFLARE.md](./CLOUDFLARE.md) |
| Vercel | Edge Function | プラットフォーム cron | [VERCEL.md](./VERCEL.md) |
| Deno Deploy | Deno ネイティブ | `Deno.cron`（内蔵） | [DENO.md](./DENO.md) |
| Netlify | Functions v2（Node） | Scheduled Function | [NETLIFY.md](./NETLIFY.md) |
| EdgeOne Makers（Tencent） | Functions | 外部 cron で /api/cron を呼ぶ | [EDGEONE.md](./EDGEONE.md) |
| Fly.io / Railway / VPS | Docker（Node 22）+ Turso/ローカル SQLite | プロセス内蔵 | [NODE.md](./NODE.md) |

6 プラットフォーム（Cloudflare を含む）は、API パス、認証ロジック、メッセージモデル、管理画面、マルチチャネル通知転送、毎日のクリーンアップ（UTC 17:00）が完全に一致し、
データテーブル構造も同じであるため、いつでも相互に移行できます。

> **ワンクリックデプロイ**：Cloudflare / Vercel / Netlify の 3 プラットフォームのチュートリアル冒頭に公式のワンクリックデプロイボタンがあります（Cloudflare のボタンはデータベース作成・テーブル作成まで自動で行います）。
> Deno Deploy、EdgeOne、Docker セルフホストには現時点で公式ボタンがありません。各プラットフォームのチュートリアルに従って操作してください。

## プラットフォームの選び方

- **ゼロコスト + 手間いらずがしたい** → Cloudflare 主力版（D1 の無料枠が大きく、Worker に実行時間の問題なし）
- **複数プラットフォームを体験したい** → Deno Deploy（Worker と意味論が最も近く、ロングポーリングがほとんど切断されない）
- **主に中国国内からのアクセス** → EdgeOne Makers（カスタムドメインには ICP 備案が必要な点に注意）
- **サーバーを既に持っている / 完全に自分で管理したい** → node/（Docker セルフホスト）

> **ロングポーリングとプラットフォームのタイムアウト**：管理画面は `GET /api/wait` で新着メッセージを待ち受け、デフォルトの最大滞留は 25 秒です。環境変数 `WAIT_MAX_SECONDS`（3–25）でプラットフォームごとに引き下げ可能です。
> Netlify Functions の現行上限は 60 秒（エントリのデフォルト `WAIT_MAX_SECONDS=8` は保守的な適応値で、必要に応じて引き上げ可）；Vercel Edge は `20` を推奨；Cloudflare / Deno / Node はデフォルトのままで OK です。
> フロントエンドは失敗時に**指数バックオフ**（2→30 秒）を行い、ページが再び表示されると即座に追加取得するため、プラットフォームに途中で切断されても**機能には影響せず**、新着メッセージの通知が少し遅れるだけです。

## 共通の事前準備（Cloudflare 以外のすべてのプラットフォーム）

**データベースは [Turso](https://turso.tech) に統一します**（SQLite 互換。無料枠：データベース 100 個、5GB ストレージ、月 5 億行の読み取り）：

1. [turso.tech](https://turso.tech) を開き、GitHub でログイン
2. **Create Database**：名称 `sms-gateway`、リージョンは Singapore / Hong Kong を選択、タイプは Free
3. データベースの詳細ページで **Database URL**（`libsql://sms-gateway-xxxx.turso.io`）を控える；**Create Token** をクリックしてトークンを作成し、すぐに保存（一度しか表示されません）
4. テーブル構造の初期化：詳細ページの **Console** に、各プラットフォームディレクトリ内の `schema.sql` の全内容を貼り付けて実行（リポジトリルートの `schema.sql` と同じもの）

CLI の同等コマンド：

```bash
turso auth login
turso db create sms-gateway          # データベースを作成
turso db show sms-gateway --url      # URL を確認
turso db tokens create sms-gateway   # トークンを作成
turso db shell sms-gateway < schema.sql   # テーブルを作成
```

**環境変数**（各プラットフォームの設定パネルで設定。詳細は各プラットフォームのチュートリアル参照）：

| 変数 | 必須 | 説明 |
|---|---|---|
| `TURSO_DATABASE_URL` | はい | `libsql://sms-gateway-<組織名>.turso.io` |
| `TURSO_AUTH_TOKEN` | はい | データベースのアクセストークン |
| `RECEIVE_TOKEN` | はい | プッシュ認証シークレット（取り込み側 URL の `token=` と一致させる） |
| `ENABLE_AUTH` | いいえ | `"true"` で管理画面にログインが必要（**セキュリティ上強く推奨**、下記のセキュリティ推奨事項参照）。デフォルトはログインなし |
| `ADMIN_PASSWORD` | いいえ | ログインパスワード（`ENABLE_AUTH="true"` のときに設定。設定漏れの場合は管理 API が一律アクセスを拒否してアラートを出力 — 設定欠落でも通しません） |
| `SESSION_SECRET` | ログイン有効時は必須 | ログインセッションの署名シークレット：高エントロピーな乱数値（≥32 文字のランダム文字列、管理パスワードとは独立）。各プラットフォームでそれぞれ独立した値を設定すること。欠落時はログインと認証が安全に失敗（ログイン 500、管理 API 401）、パスワード派生へはフォールバックしません。ローテーション後はすべての旧セッションが無効になり再ログインが必要 |
| `RETENTION_DAYS` | いいえ | データ保持日数。デフォルト 30 |
| `WAIT_MAX_SECONDS` | いいえ | ロングポーリングの滞留秒数（3–25、デフォルト 25）；Netlify は `8`、Vercel Edge は `20` を設定 |
| 通知チャネル変数 | いいえ | `FEISHU_WEBHOOK`（Feishu）/ `WECOM_WEBHOOK`（WeCom）/ `DINGTALK_WEBHOOK`（DingTalk、任意 `DINGTALK_SECRET`、署名追加（加签））/ `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY`（任意 `BARK_URL`）/ `NTFY_URL`（任意 `NTFY_TOKEN`）/ `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO`（メール、任意 `MAIL_FROM`）/ `GENERIC_WEBHOOKS`（汎用 Webhook、任意 `GENERIC_WEBHOOK_TEMPLATE` ボディ / `GENERIC_WEBHOOK_HEADERS` ヘッダー）。設定したものだけが転送され、何も設定しなければ転送しません。通知は内容に応じて自動的に 3 状態でレンダリング（🔐 認証コード / 💬 SMS / 🔔 通知） |
| `SITE_NAME` / `SITE_ICON` | いいえ | サイト名 / アイコン URL。未設定時はデフォルト値を使用 |
| `NOTIFY_LINK` | いいえ | 管理画面ホームのアドレス。設定するとすべての通知チャネルに「管理画面を開く」エントリ（ボタン/リンク/click）が付く。未設定時は自動的に省略 |
| `CRON_SECRET`（Vercel のみ） | いいえ | `RECEIVE_TOKEN` と同じ値を設定。Vercel Cron が /api/cron を呼ぶために使用 |
| `SQLITE_PATH`（node セルフホストのみ） | いいえ | ローカル SQLite モード：設定すると外部データベース不要（Node 22.13+ が必要、node/README.md 参照） |

> **セキュリティ上の強い推奨事項**
> 1. **管理画面ログインを有効にする**（`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`）：管理画面には SMS 認証コードなどの機密情報があります。デフォルトのログインなしでは、ドメインを知っている人なら誰でも全メッセージを閲覧しデータを削除できてしまいます。ログイン API にはレート制限が組み込まれています（同一 IP で連続 5 回失敗すると 10 分ロック）。`/api/receive`、`/api/push` には別途 IP あたり毎分 120 回の書き込みレート制限があります（超過で 429 を返す）。
> 2. **プッシュトークンを URL クエリで渡すことのトレードオフ**：SmsForwarder などのクライアントとの互換性のため、`/api/receive`、`/api/push` は `?token=` クエリパラメータでの認証に対応しています — トークンは URL に現れ、プラットフォームのアクセスログやブラウザ履歴に入る可能性があります。気になる場合は POST + リクエストヘッダー `Authorization: Bearer <RECEIVE_TOKEN>` での送信に変更してください（両方式とも対応）。

## ディレクトリ構造

```
platforms/
├── cloudflare/ # 主力版：worker.js + schema.sql + wrangler.toml + README.md（自己完結）
├── vercel/     # api/[[...route]].js + app.js + db.js + schema.sql + vercel.json + README.md
├── netlify/    # functions/{api,cron}.mjs + app.js + db.js + schema.sql + netlify.toml + README.md
├── deno/       # main.js + app.js + db.js + schema.sql + README.md
├── edgeone/    # functions/{[[default]].js,index.js} + app.js + db.js + schema.sql + README.md
├── node/       # server.mjs + app.js + db.js + schema.sql + Dockerfile + package.json + README.md
├── shared/     # app.js / db.js の唯一のソース（gen_app.py がここから各プラットフォームへ同期）
└── gen_app.py  # ジェネレータ：../src/worker.js から app.js を生成し全プラットフォームへ同期（cloudflare の独立コピーを含む）
```

各プラットフォームのディレクトリは、単独でデプロイルートディレクトリとして使用できます（Git デプロイ時はプラットフォームの Root Directory を対応するサブディレクトリに向けるだけ）。
npm 依存ゼロ、ビルド不要です。`src/worker.js` に更新があったら `python platforms/gen_app.py` を実行して全プラットフォームを一括同期します（CI がドリフトゼロを検証、`node tests/run.mjs` は 204 項目の機能アサーションをカバーします）。

## Cloudflare Worker から他のプラットフォームへの移行

1. 上記に従って Turso データベースを準備しテーブルを作成
2. （任意）履歴データの移行：CF Dashboard で D1 データ（SQLite ファイル）をエクスポート → `turso db import` でインポート（公式 CLI ドキュメント参照）
3. 対象プラットフォームの README に従ってデプロイし、管理画面と /api/push が正常に動作するか検証
4. スマホ側と各プッシュスクリプトの Webhook ドメインを新プラットフォームへ変更
5. 1〜2 日観察して異常がなければ旧 Worker を無効化

## 共通事項

- API パスは全プラットフォームで共通：`/api/receive`、`/api/push`、`/api/messages`（`device_id`/`source`/`range`/`q`/`limit`/`page`/`starred`/`unread` に対応）、`/api/messages/star`、`/api/messages/read`、`/api/messages/remove`、`/api/messages/restore`、`/api/messages/clear`、`/api/export`（CSV/JSON）、`/api/sources`、`/api/stats`、`/api/phone`（地域判定）、`/api/devices`、`/api/devices/alias`、`/api/devices/merge`、`/api/wait`、`/api/login`、`/api/logout`、`/api/cron`；このほかに公開された `/manifest.webmanifest`、`/sw.js` があります
- `/api/cron` は外部スケジューラがクリーンアップを起動するためのものです。認証：`?token=<RECEIVE_TOKEN>` または `Authorization: Bearer <RECEIVE_TOKEN>`
- `/api/receive` と `/api/push` はログインスイッチの影響を受けません
