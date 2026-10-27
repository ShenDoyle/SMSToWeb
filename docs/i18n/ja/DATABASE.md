# データベースドキュメント（DATABASE）

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | **日本語** | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 英語原文から同期（日本語版）

SMSToWeb は統一されたデータベースアダプタ層（`prepare/bind/first/all/run` の 4 メソッド。Cloudflare D1 API と完全に一致）によって 3 つのストレージバックエンドの差異を吸収し、ビジネスコードには SQL 方言の差異がまったくありません。

## 1. バックエンドマトリクス

| プラットフォーム | データベース | 認証情報の変数 | アダプタファイル |
|---|---|---|---|
| Cloudflare | D1 | コンソールでバインド（`env.DB`）、wrangler.toml で設定 | ネイティブ、アダプタなし |
| Vercel / Netlify / Deno / EdgeOne | Turso（libsql） | `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | `platforms/shared/db.js` |
| Node セルフホスト | Turso **または** ローカル SQLite | Turso 変数があれば Turso を使用。なければ `SQLITE_PATH`（デフォルト `./data/smstoweb.db`、node:sqlite） | `platforms/node/db.js`（デュアルアダプタ、独立メンテナンス） |

クロスプラットフォームのアダプタは純粋な `fetch` で実装されており（Turso HTTP /v2/pipeline）、npm 依存はありません。

## 2. テーブル構造（schema.sql が単一ソース）

### devices — デバイステーブル

| カラム | 型 | 説明 |
|---|---|---|
| `id` | INTEGER PK | 自動採番 |
| `device` | TEXT | デバイス名（アプリテンプレートの name フィールド。デフォルト `unknown`） |
| `sim` | TEXT | 受信番号（そのまま保存・表示、マッピングなし） |
| `alias` | TEXT | 任意のエイリアス（管理画面での表示優先度：alias > device） |
| `created_at` | TEXT | 保存時刻 |

一意インデックス `idx_devices_key(device, sim)`：同一デバイス+同一受信番号で一意。

### messages — メッセージテーブル（10 カラム）

| カラム | 型 | 説明 |
|---|---|---|
| `id` | INTEGER PK | 自動採番 |
| `device_id` | INTEGER FK | → devices.id |
| `sender` | TEXT | 送信者 |
| `content` | TEXT | 本文（保存前に 8000 文字に切り詰め） |
| `received_at` | TEXT | 北京時間（秒単位） |
| `source` | TEXT | ソース：`sms` / `notify` / カスタム（例：`alert`） |
| `created_at` | TEXT | 保存時刻 |
| `deleted_at` | TEXT NULL | ソフトデリートのタイムスタンプ（NULL=正常） |
| `starred` | INTEGER | スター 0/1 |
| `read_at` | TEXT NULL | 既読タイムスタンプ |

インデックス：`idx_messages_device_time(device_id, received_at DESC)`、`idx_messages_time(received_at)`、`idx_messages_source(source, received_at DESC)`、および**重複除去の一意インデックス** `idx_messages_dedup(device_id, sender, content, received_at)` — 重複プッシュはデータベース層で兜底拒否され、コードが一意制約の衝突を捕捉して `duplicated:true` を返します。

## 3. マイグレーションの鉄則（重要）

**schema.sql を変更したときは、必ずすべてのデプロイ済みプラットフォームのデータベースマイグレーションを同時に周知・実行すること**（2026-10-22 の本番障害の教訓：コードが schema に先行してデプロイされ、Turso の旧データベースに `starred` カラムが欠けていたため、一覧系 API が全面的に 500 になりました）。

- 新規デプロイ：ルートの `schema.sql` をそのまま実行（冪等、`CREATE TABLE IF NOT EXISTS`）；
- 既存 DB のアップグレード：新しいカラムに対して `ALTER TABLE messages ADD COLUMN deleted_at TEXT;` / `ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;` / `ADD COLUMN read_at TEXT;` を実行（schema.sql の末尾に備考あり）；
- すでに対応済みの本番データベース：CF D1（sms-gateway-db、10 カラム検証済み）と EO Turso（sms-gateway、移行済み）は再対応不要。

## 4. データ保持とクリーンアップ

- 定期クリーンアップ（cron）：`received_at` が `RETENTION_DAYS`（デフォルト 30 日）より前の messages を削除；
- 起動方式：プラットフォームのネイティブ cron（CF scheduled / Vercel Cron / Netlify Scheduled）または任意のスケジューラによる `GET /api/cron?token=<RECEIVE_TOKEN>`。

## 5. Turso 使用上の注意（排障経験）

- **トークンの種類**：組織レベルの API Token（JWT ペイロードは org_id のみ）≠ データベーストークン（ペイロードに `a:"rw"` を含む）。データベーストークンの生成場所：Turso コンソール → データベース詳細 → Tokens タブ。間違った種類のトークンで /v2/pipeline にアクセスすると `invalid JWT token` となり、全 DB API が 500「internal error」になります（ログインページは DB を参照しないため正常に見えます）。
- **クライアントキャッシュ**：Turso クライアントは認証情報のフィンガープリントでキー管理されたキャッシュを持ちます（dbUrl+dbToken の変更で自動再構築）。コンソールでトークンを交換した後も再デプロイは不要です。
- **クイック診断**：データベーストークンで直接 `POST https://<db-url>/v2/pipeline` を叩く（body: `{"requests":[{"type":"execute","stmt":{"sql":"SELECT 1"}},{"type":"close"}]}`）。
