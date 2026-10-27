# アーキテクチャドキュメント（ARCHITECTURE）

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | **日本語** | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 英語原文から同期（日本語版）

SMSToWeb は「単一コア + マルチプラットフォームエントリ」の SMS/通知アグリゲーションシステムです：npm 依存ゼロのビジネスコア（`src/worker.js`）を 1 つ持ち、生成スクリプト経由で 6 つのデプロイプラットフォームへ同期します。各プラットフォームは自前のランタイムとデータベースに接続するための薄いアダプタ層だけを保持します。

## 1. 全体トポロジ

```
スマホ（SmsForwarder / 任意のスクリプト）
   │  POST /api/receive（SMS）または /api/push（汎用プッシュ）+ token
   ▼
┌─────────────────────── 任意の 1 プラットフォームにデプロイ ───────────────────────┐
│  Cloudflare Workers (D1)   Vercel Edge   Deno Deploy                              │
│  Netlify Functions         EdgeOne (Turso)   Node セルフホスト (Docker)             │
│                                                                                   │
│  エントリ層（薄いアダプタ）：リクエスト受信 → buildEnv で環境変数を透過 → fetchApp() │
│  ビジネスコア（単一ファイル app.js）：認証 → 保存 → 照会 → ロングポーリング → 通知転送 │
└───────────────────────────────────────────────────────────────────────────────────┘
   │                                  │
   ▼                                  ▼
管理画面（内蔵 HTML、ログイン認証）      11 チャネルの通知転送（Feishu/WeCom/DingTalk/…）
```

コア設計原則：**ビジネスコードとプラットフォームエントリの分離**。コアロジックはデプロイプラットフォームによって変更されず、薄いアダプタ層を通じて各プラットフォームのランタイムとデータベースインターフェースに接続するだけです。6 プラットフォームの機能は厳密に一致します。

## 2. ディレクトリ構造

```
src/worker.js                 # 唯一のビジネスソースファイル（Cloudflare Worker 形態：export default { fetch, scheduled }）
platforms/
  gen_app.py                 # 同期生成スクリプト（§3 参照）
  shared/app.js               # 生成物：src/worker.js のビジネス部分とバイト単位で一致、エクスポート形態のみ置換
  cloudflare/                 # CF 主力版のコピー + wrangler.toml（静的メンテナンス）
  vercel/  netlify/  deno/    # 各プラットフォームの自己完結ディレクトリ：エントリ + app.js + db.js + schema.sql + README
  edgeone/ node/              # EdgeOne は Turso を使用。node/db.js は Turso + ローカル SQLite のデュアルアダプタ（独立メンテナンス）
tests/run.mjs                 # 依存ゼロのテストスイート（node:sqlite、204 項目）
docs/                         # ドキュメント（このディレクトリ）
schema.sql                    # データベースのテーブル作成スクリプト（単一ソース）
```

各プラットフォームのディレクトリは**完全に自己完結**しています：エントリはこのディレクトリ内の `app.js` / `db.js` のみを参照するため、独立してデプロイでき、相互に依存しません。

## 3. 同期メカニズム（platforms/gen_app.py）

`python platforms/gen_app.py` はワンクリックで完了します（冪等、再実行してもドリフトなし）：

1. `src/worker.js` を唯一のソースとし、`export default {` より前のビジネスコードをすべて切り出し、汎用のエクスポート後尾部（`fetchApp` / `runCron` / `handleCronRequest`）を連結して `platforms/shared/app.js` に書き込みます；
2. shared のコピーを `shared/db.js`、ルートの `schema.sql` とともに各プラットフォームのディレクトリへ複製します（`node/db.js` を除く。独立メンテナンス）；
3. スクリプト内の **ENV_KEYS ホワイトリスト**（単一リスト、31 個の環境変数）で、各エントリファイルの `/* ==== ENV_KEYS BEGIN ==== */ … /* ==== ENV_KEYS END ==== */` マーカーブロック間の内容を置き換え、6 プラットフォームが透過する環境変数の集合を一致させてドリフトを防止します。

鉄則：**ビジネスの変更は必ず `src/worker.js`（と gen_app.py の ENV_KEYS）だけを変更し、変更後は必ず gen_app.py を再実行する**。platforms/ 配下の生成物を直接手で変更することは禁止（node/db.js と wrangler.toml を除く）。

## 4. リクエストライフサイクル

`POST /api/receive` を例にします：

1. **エントリ層**：プラットフォームエントリ（例：`platforms/edgeone/functions/index.js`）がリクエストを受け取り、`env = buildEnv(vars)` を構成し（ホワイトリスト変数 + データベース認証情報の分岐を透過）、`fetchApp(request, env[, ctx])` を呼びます；
2. **認証**：`/api/receive`、`/api/push`、`/api/login`、`/api/logout`、`/api/cron`、静的リソースは公開パス。その他の管理・ページ系 API はログインスイッチ（`ENABLE_AUTH`）で制御されます — ログイン後に**ステートレス署名セッション**（`nonce.exp.HMAC-SHA256` の 3 セグメント形式、Cookie `sms_auth`、TTL 30 分）を発行し、`SESSION_SECRET` が欠落している場合は安全に失敗します（ログイン 500、管理 API は一律 401、パスワード派生にはフォールバックしない）。設定欠落時は一律通しません；
3. **保存**：token を検証（`safeEqual` でタイミング攻撃を防止）→ device+sim でデバイスを特定/作成 → messages へ書き込み（データベースの一意インデックスが重複除去を兜底し、重複プッシュは `duplicated:true` を返して転送しない）；
4. **通知転送**：重複でないメッセージは `bgRun(ctx, dispatchNotify(env, msg))` でバックグラウンドへ — Cloudflare は実際の `ctx.waitUntil` を渡してレスポンス後も送信を継続します。その他のプラットフォームは ctx が省略された場合にインライン `await` へ退行し、エッジ関数にバックグラウンドタスクを途中で切断されないようにします；
5. **レスポンス**：直ちに JSON を返します（`success/device_id/duplicated`）。転送の完了は待ちません（CF プラットフォーム）。

## 5. 通知転送サブシステム

`dispatchNotify(env, msg)` は全チャネル唯一の組み立て層です：

- `extractCodeLite(content)`：サーバー側の軽量認証コード検出（カスケード順序はフロントエンドの `extractCode` と一致。コード先頭パターンはキーワード先頭パターンより優先。検出前に電話番号/日付/時刻/金額/注文番号を剥離）；
- `buildNotifyInfo(env, msg)`：認証コード検出 + `NOTIFY_LINK` の読み取りは全チャネルで 1 回だけ計算し、`verify/sms/notify` の 3 状態と統一タイトルを生成；
- 各チャネルの renderer が `info` を消費して自前の形式をレンダリングします（Feishu Interactive カード / WeCom・DingTalk markdown / Telegram HTML / Bark / ntfy / Gotify / Resend メール / 汎用 Webhook テンプレートなど）。文字数上限、署名、エスケープは renderer 内で処理；
- `Promise.allSettled` で並列スケジュールし、単一チャネルの失敗はログに記録するだけで、他のチャネルやメインフローには影響しません。

## 6. フロントエンド（内蔵管理画面）

管理画面の HTML は `String.raw` のテンプレートリテラルとして `src/worker.js` に内蔵されています（サーバーサイドレンダリング、独立したフロントエンドプロジェクトなし）：ログインページと管理画面はルート `/` を共有し、ログインスイッチがレンダリング形態を決定します。9 言語対応（zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR、`data-i18n` 内蔵辞書 + `?lang=` ダイレクトアクセス、欠落キーは en にフォールバック）、ダークモード、認証コードの自動コピー、ロングポーリングによる自動更新（`/api/wait`）、ソースフィルター、デバイス管理に対応しています。

## 7. マルチプラットフォームの差異一覧

| プラットフォーム | エントリファイル | データベース | cron |
|---|---|---|---|
| Cloudflare | `export default`（worker.js 本体） | D1（`env.DB`） | ネイティブ `scheduled` + `/api/cron` HTTP |
| Vercel | `api/[[...route]].js` | Turso | Vercel Cron（Bearer `CRON_SECRET`） |
| Netlify | `functions/api.mjs` + `functions/cron.mjs` | Turso | Scheduled Functions |
| Deno | `main.js`（`Deno.serve`） | Turso | 外部スケジューラ |
| EdgeOne | `functions/index.js`（ルートパスは必ず index.js） | Turso（クライアントは認証情報のフィンガープリントでキー管理されたキャッシュ） | 外部スケジューラ |
| Node | `server.mjs`（node:http） | Turso / ローカル SQLite（デュアルアダプタ） | 外部スケジューラ / Docker |

すべてのプラットフォームの `/api/cron` HTTP 起動セマンティクスは同一です：`?token=<RECEIVE_TOKEN>` または `Authorization: Bearer <RECEIVE_TOKEN>`。
