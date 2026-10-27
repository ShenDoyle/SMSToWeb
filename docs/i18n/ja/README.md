# SMSToWeb — SMS & 通知クラウドゲートウェイ

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | **日本語** | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 英語原文から同期（日本語版）

> 英語版がこのドキュメントの一次メンテナンス版です。翻訳は [`docs/i18n/<lang>/`](../../../docs/i18n/README.md) 配下にあり、最新化が遅れることがあります。迷ったら英語版を参照してください。

Android スマホ（およびその他のあらゆるデバイス）からの SMS と通知をリアルタイムでクラウドへプッシュし、どこからでも Web ページで閲覧できるようにします。デプロイ無料、サーバー不要、全体の所要時間は約 10 分です。

- **マルチプラットフォームデプロイ**: Cloudflare（主力）/ Vercel / Deno Deploy / Netlify / Tencent EdgeOne Makers / Docker セルフホスト — 6 つから 1 つを選ぶだけで、機能は完全に同一
- **リアルタイム受信**: Webhook プッシュが数秒でデータベースに到着。Web ページは自分で更新されるので手作業不要
- **汎用プッシュ**: HTTP リクエストを送れるあらゆるデバイス（Linux / Windows / macOS / iOS / NAS / スクリプト）から、同じページへ通知をプッシュ可能
- **ソース & フィルター**: ソース（SMS / 通知、および自動集計されるカスタムソース）で動的に絞り込み、キーワード検索や今日 / 過去 7 日 / 過去 30 日の期間指定と重ねがけ可能。ページサイズは調整可
- **マルチチャネル転送**: 新着メッセージを Feishu / WeCom / DingTalk / Telegram / ServerChan / PushPlus / Bark / ntfy / Gotify / メール / 汎用 Webhook へ自動転送 — 使うものだけを設定（任意）
- **オプションのセキュリティ**: 管理画面ログインのオン/オフ、多形式の OTP コード抽出（コード先行 / キーワード先行 / 分割型 / 混合、誤検知に強い）とワンタップコピー、ダークモード
- **データ & アラート**: 現在のフィルター条件で CSV / JSON エクスポート。ページ表示中は新着メッセージのトースト / 任意サウンド / フローティングピル、非表示時はブラウザ通知 + 未読タイトル。長文は自動折りたたみ
- **番号認識**: 一般的な機関の番号（キャリア / 銀行 / 宅配 / 官公庁）の内蔵ディレクトリで自動ラベル付け。未知の携帯番号はキャリア地域の検索も可能（デフォルト有効、無効化可）
- **9 言語**: 管理画面とログインページに zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR を内蔵。ヘッダーの 🌐 メニューから切替（`?lang=` ディープリンク対応、選択はローカルに記憶）。日付・相対時刻・ディレクトリラベルも連動して切替
- **モバイル対応**: ノッチやジェスチャーバー向けの `viewport-fit` セーフエリア対応、iOS の自動ズームを防ぐ 16px 入力欄、大きめのタッチターゲット、ボトムシートダイアログ、PWA のホーム画面追加
- **一括操作 & 元に戻す**: 複数選択での削除、フィルター条件でのワンタップ一括クリア。削除後 5 秒は取り消し可能（ソフトデリート）。ダークモードは自動 / ライト / ダーク
- **スター / 未読 / 統計**: スターでピン留め、スターのみ / 未読のみのビュー、統計パネル（ソース内訳 + 過去 7 日）。カスタム番号ラベル。検索ハイライトと履歴。設定にはおやすみモードとサウンド。PWA 対応

```
[SMS] Android(SmsForwarder) ──POST /api/receive──┐
                                                 ├─→ クラウドゲートウェイ（任意のプラットフォーム） ─→ データベース
[通知] スクリプト / ショートカット ──POST /api/push────┘        │
                                                ブラウザ ◀── Web 管理画面（ゲートウェイに組み込み）
```

**ワンクリックデプロイ（Cloudflare 主力、約 2 分）**：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

このボタンはデータベースとテーブルの作成、リソースのバインド、CI の設定まで自動で行います。案内に従って `RECEIVE_TOKEN`（プッシュ認証シークレット）を入力すればすぐに運用開始できます。Vercel / Netlify のワンクリックボタンは各プラットフォームガイドにあります。

| プラットフォーム | デプロイ方式 | 定期クリーンアップ | ガイド |
|---|---|---|---|
| **Cloudflare**（推奨） | Worker + D1 | プラットフォーム cron | [CLOUDFLARE.md](./CLOUDFLARE.md) |
| Vercel | Edge Function + Turso | プラットフォーム cron | [VERCEL.md](./VERCEL.md) |
| Deno Deploy | Deno ネイティブ + Turso | Deno.cron | [DENO.md](./DENO.md) |
| Netlify | Functions v2 + Turso | Scheduled Function | [NETLIFY.md](./NETLIFY.md) |
| Tencent EdgeOne Makers | Functions + Turso | 外部 cron | [EDGEONE.md](./EDGEONE.md) |
| Fly.io / Railway / VPS | Docker（Node 22）+ Turso / ローカル SQLite | プロセス内蔵 | [NODE.md](./NODE.md) |

> どのプラットフォームディレクトリも**完全に自己完結**しています（コード + スキーマ + 独立したドキュメント、npm 依存ゼロ、ビルド不要）。上のガイドを開いて手順に従ってください。機能とデータスキーマは全プラットフォームで同一であり、いつでも相互に移行できます。
> プラットフォーム比較と共通の事前準備（Turso データベース）は [PLATFORMS.md](./PLATFORMS.md) を参照してください。

### ランタイムの違い（デプロイ前に読んでください）

ビジネスコードは 6 プラットフォーム全体でバイト単位で同一ですが、**タイムアウト / バックグラウンドタスク / タイマー**はランタイムごとに異なります。必要に応じて環境変数で調整してください：

| プラットフォーム | 関数タイムアウト | バックグラウンド通知 | 定期クリーンアップ | 推奨設定 |
|---|---|---|---|---|
| Cloudflare | 実時間の上限なし（CPU 制限のみ） | `ctx.waitUntil` がレスポンス後も継続 | プラットフォーム cron | デフォルトのままで OK |
| Vercel Edge | リクエストあたり約 25 秒の上限 | レスポンス前にインラインで完了 | プラットフォーム cron | `WAIT_MAX_SECONDS=20` |
| Netlify Functions | 60 秒（全プラン共通） | レスポンス前にインラインで完了 | scheduled function | エントリのデフォルトは `WAIT_MAX_SECONDS=8` |
| Deno Deploy | プラン依存 | レスポンス前にインラインで完了 | 外部トリガーが必要 | 外部 cron で `/api/cron?token=` を呼ぶ |
| EdgeOne Makers | プラン依存 | レスポンス前にインラインで完了 | 外部トリガーが必要 | プランに応じて `WAIT_MAX_SECONDS` を下げる |
| Node / Docker | 自由に設定可能 | レスポンス前にインラインで完了 | 外部トリガーが必要 | ローカル SQLite には Node ≥ 22.13 が必要 |

> - **ロングポーリング**: フロントエンドは**指数バックオフ**（2→30 秒）で失敗をリトライし、ページが再び表示されると即座に再ポーリングします。プラットフォームに強制切断されたリクエストが関数に殺到することはありません。
> - **通知転送**: Cloudflare は `waitUntil` を使用します。その他のプラットフォームはレスポンスの前に通知送信を完了させます（チャネルあたりタイムアウト 10 秒）。低速なチャネルが多いと多少レイテンシが増えます。
> - **定期クリーンアップ**: cron がないプラットフォームでは、任意のスケジューラで `GET /api/cron?token=<RECEIVE_TOKEN>` を叩いてください。

---

## スマホの設定 & マルチデバイス取り込み

すべてのプラットフォームが同じ Web ページへメッセージを届けます。スマホの SMS は `/api/receive`（Android SmsForwarder）経由、それ以外はすべて汎用の `/api/push` を使います。

手順ごとの設定方法（プラットフォーム別のコピペ用コマンド / スクリプト付き）：**[デプロイ & 取り込みガイド](./DEPLOYMENT.md)**

**汎用プッシュ早見表**（全フィールドはガイド参照）：

```
POST https://<your-domain>/api/push?token=<RECEIVE_TOKEN>
{"source":"notify","sender":"demo","content":"hello from anywhere"}
```

`{"success":true,...}` のレスポンスが返れば保存済みです。まったく同じペイロードを再プッシュすると `duplicated:true` が返ります。

## 環境変数（全プラットフォーム共通）

| 変数 | 必須 | 説明 |
|---|---|---|
| `RECEIVE_TOKEN` | はい | プッシュ認証シークレット。長めのランダム文字列を指定してください |
| `ENABLE_AUTH` | いいえ | `"true"` で管理画面にログインが必須になります（**強く推奨**、下記のセキュリティ注記参照）。デフォルトはログインなし |
| `ADMIN_PASSWORD` | いいえ | ログインパスワード（`ENABLE_AUTH="true"` のときに設定。未設定の場合、管理 API はアクセスを一律拒否してアラートを記録します — 設定漏れで扉が開くことはありません） |
| `RETENTION_DAYS` | いいえ | データ保持日数。デフォルト 30 |
| `WAIT_MAX_SECONDS` | いいえ | `/api/wait` ロングポーリングの最大滞留秒数。デフォルト 25（範囲 3–25）。**Netlify Functions**（10 秒上限）など短いタイムアウトのプラットフォームでは `8` に設定し、プラットフォームに強制終了されないようにしてください |
| `PHONE_AREA_ENABLED` / `PHONE_AREA_API` | いいえ | キャリア地域の検索：デフォルト有効（無料の 360 API、キー不要、24 時間のサーバー側キャッシュ、11 桁の携帯番号のみ）。`false` で無効化。`PHONE_AREA_API` でカスタムソースを指定可能（`{number}` プレースホルダ付き URL） |
| 通知チャネル変数 | いいえ | `FEISHU_WEBHOOK`（Feishu）/ `WECOM_WEBHOOK`（WeCom）/ `DINGTALK_WEBHOOK`（DingTalk、任意で `DINGTALK_SECRET` 署名）/ `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY`（任意 `BARK_URL`）/ `NTFY_URL`（任意 `NTFY_TOKEN`）/ `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO`（メール、任意 `MAIL_FROM`）/ `GENERIC_WEBHOOKS`（汎用 Webhook、任意 `GENERIC_WEBHOOK_TEMPLATE` ボディ / `GENERIC_WEBHOOK_HEADERS` ヘッダー）。使うものだけを設定し、1 つも設定しなければ何も転送されません。通知は内容に応じて 3 モードで自動レンダリング（🔐 OTP / 💬 SMS / 🔔 通知） |
| `SITE_NAME` / `SITE_ICON` | いいえ | サイト名 / アイコン URL。未設定時はデフォルト値が適用されます |
| `NOTIFY_LINK` | いいえ | 管理画面ホームの URL。設定するとすべての通知チャネルに「管理画面を開く」エントリ（ボタン / リンク / click）が付きます。未設定時は自動的に省略 |
| `SESSION_SECRET` | ログイン有効時は必須 | セッション署名シークレット：**高エントロピーなランダム値（≥32 文字のランダム文字列を推奨）、管理パスワードとは完全に独立**。Cloudflare と EdgeOne（および各プラットフォーム）はそれぞれ独立した値を持つこと。Git にコミットしたりパスワードを流用したりしないでください。欠落時はログインと認証が**フェイルクローズド**（ログインは 500、管理 API は 401、パスワード派生へのフォールバックなし）。値をローテーションすると既存の全セッションが即時無効になります。セッションは 30 分間有効。ログアウトはブラウザの Cookie を消すだけです — コピーされたセッショントークンは TTL 内（最大 30 分）は有効のままです |

Cloudflare では追加で `DB`（D1 バインディング）が必要です。その他のプラットフォームは `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`（Turso データベース、各プラットフォームガイド参照）が必要です。Node セルフホストは `SQLITE_PATH` によるローカル SQLite モードにも対応しています（[NODE.md](./NODE.md) 参照）。

> **セキュリティ推奨事項**
> 1. **管理画面ログインを有効にする**（`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`）：管理画面には SMS OTP コードなどの機密情報があります。ログインなしでは、ドメインを知っている人なら誰でも全メッセージを読み、データを削除できてしまいます。ログインエンドポイントにはレート制限があります（同一 IP で連続 5 回失敗すると 10 分ロック）。`/api/receive` と `/api/push` は IP あたり毎分 120 書き込みに制限されます（超過で 429）。
> 2. **URL 内 `?token=` のトレードオフ**：SmsForwarder などのクライアントとの互換性のため、`/api/receive` と `/api/push` は `?token=` クエリパラメータによる認証も受け付けます — トークンはプラットフォームのアクセスログやブラウザ履歴に残る可能性があります。気になる場合は `Authorization: Bearer <RECEIVE_TOKEN>` ヘッダー付きの POST に切り替えてください（両方式ともサポートしています）。

## FAQ（一般）

- **ラベルに `{{XXX}}` がそのまま表示される** → 起こりません：ゲートウェイは `{{` を含むラベルを空にして `sim` にフォールバックします。カスタム名はテンプレートの `name` フィールドに直接設定してください
- **API が 401/403 を返す** → URL の `token=` が `RECEIVE_TOKEN` と一致しているか確認してください。`/api/receive` と `/api/push` はログインスイッチの影響を受けません
- **API が 429 を返す** → 書き込みレート制限（120/IP/分）に到達しました。1 分後には回復します。通常の使用で発生する場合は、トークンが漏洩しているか何かが API を連打している可能性があります
- **非常に長いメッセージ** → 1 つの本文は 8000 文字が上限で、超過分は切り捨てられます
- **デバイスラベルの改名** → ラベルはメッセージテンプレートの `name` フィールドに由来します。`name` を変えると新しいラベルになります。Web ページでラベル横の「✎」で改名、「⇄」でそのラベルのメッセージを別デバイスへ統合、空のラベルは「×」で直接削除できます
- **旧バージョンからのアップグレード（新しいカラム）** → 既存のデータベースで実行：`ALTER TABLE messages ADD COLUMN deleted_at TEXT;`、`ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;`、`ALTER TABLE messages ADD COLUMN read_at TEXT;`（新規データベースには最初から含まれています。node のローカル SQLite は起動時に自動でカラムを追加します）

## 開発

- `src/worker.js`：コアソース（Cloudflare Worker 形態）
- `platforms/gen_app.py`：`src/worker.js` からプラットフォーム中立の `app.js` を生成して 5 つの移植プラットフォームへ同期し、Cloudflare コピーの `worker.js` も同期します（6 プラットフォームでビジネスコードをバイト単位で同一に維持）。31 変数の環境変数ホワイトリスト（ENV_KEYS、認証系を含む）も 6 プラットフォームのエントリへ同期してドリフトを防止します（node の db.js は Turso + ローカル SQLite のデュアルアダプタで、独立してメンテナンスされ同期対象外）
- `platforms/*/`：自己完結型のデプロイディレクトリ（エントリ + app.js + db.js アダプタ + schema.sql + プラットフォームガイド）
- `docs/i18n/en/`：英語ドキュメントセット（デプロイ / API / アーキテクチャ / データベース）。その他の言語は `docs/i18n/<lang>/` 配下 — [docs/i18n/README.md](../../../docs/i18n/README.md) 参照
- `tests/run.mjs`：依存ゼロのテストスイート（Node 22.13+ が必要）：`node tests/run.mjs`
- コアコードを変更した後：`python platforms/gen_app.py` で全プラットフォームを再同期し、続いて `node tests/run.mjs` を実行。CI が同期ドリフトゼロ + 構文 + テストを検証します

## ライセンス

[MIT](../../../LICENSE) © 2026 [左立方 (ZuoLifang)](https://cbm.im/)
