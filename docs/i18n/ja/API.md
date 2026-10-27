# API ドキュメント（API）

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | **日本語** | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 英語原文から同期（日本語版）

すべての API は `/` をルートとし、レスポンスは JSON（`Content-Type: application/json`）、CORS に対応しています。「公開 API」を除き、ログインスイッチによって保護されます（セキュリティ設定の推奨はルート README の「セキュリティ推奨事項」を参照）。

## 認証方式

| API タイプ | 認証 |
|---|---|
| 受信プッシュ（`/api/receive`、`/api/push`） | `?token=<RECEIVE_TOKEN>`（query またはフォームフィールド）、**ログインスイッチの影響を受けない** |
| 管理 API | Cookie セッション `sms_auth`（`POST /api/login` で取得。`ENABLE_AUTH=true` のとき有効）。セッションは**ステートレス署名トークン**（`nonce.exp.HMAC-SHA256` の 3 セグメント形式、署名シークレット `SESSION_SECRET`）で、有効期限は 30 分。`SESSION_SECRET` が欠落している場合は安全に失敗し（ログイン 500、管理 API は一律 401、パスワード派生にはフォールバックしない）、設定欠落時は一律通しません。`SESSION_SECRET` をローテーションするとすべての旧セッションが即時無効になります |
| 定期クリーンアップ（`GET /api/cron`） | `?token=<RECEIVE_TOKEN>` または `Authorization: Bearer <RECEIVE_TOKEN>` |

## 1. 受信プッシュ（公開）

### POST/GET `/api/receive` — SMS の保存（SmsForwarder 互換）

パラメータ（JSON ボディ。GET の場合は query）：

| フィールド | 必須 | 説明 |
|---|---|---|
| `token` | はい | RECEIVE_TOKEN（query に置いても可） |
| `name` | いいえ | デバイス名（アプリテンプレートの name フィールド）。デフォルト `unknown` |
| `sim` | いいえ | 受信電話番号。そのまま保存・表示される |
| `from` | いいえ | 送信者 |
| `content` | はい | SMS 本文（サーバー側で 8000 文字に切り詰め） |
| `time` | いいえ | クライアント時刻。省略時はサーバーの北京時間 |

```bash
curl -X POST "https://<your-site>/api/receive?token=<RECEIVE_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"私のスマホ","sim":"13800000000","from":"10086","content":"認証コード 123456"}'
```

レスポンス：`{ "success": true, "device_id": 1, "duplicated": false }`。同一デバイス+送信者+内容+秒単位の同一時刻で再プッシュすると → `duplicated: true`（保存はスキップされ、**通知は転送されない**）。

### POST `/api/push` — 汎用プッシュ（任意のプラットフォームソースを接続）

| フィールド | 必須 | 説明 |
|---|---|---|
| `token` | はい | RECEIVE_TOKEN（query） |
| `content` | はい | 本文（8000 文字に切り詰め） |
| `name` / `sender` | いいえ | デバイス名 / 送信元（アプリ名、スクリプト名など） |
| `source` | いいえ | ソース分類（デフォルト `notify`。例：`alert`、`jd`。フロントエンドでソースごとに絞り込み可能） |
| `time` | いいえ | クライアント時刻。省略時はサーバーの現在時刻 |

メッセージ受信後、同様に 11 チャネルの通知転送が発火します（3 状態レンダリング：認証コードのない push → 🔔 デバイス通知）。

## 2. メッセージの照会と管理（ログイン状態が必要）

### GET `/api/messages` — メッセージ一覧

Query パラメータ：

| パラメータ | 説明 |
|---|---|
| `q` | キーワード検索（sender/content にマッチ） |
| `source` | ソースフィルター（例：`sms` / `notify` / カスタムソース） |
| `device_id` | デバイスで絞り込み |
| `range` | 期間：`1d` / `7d` / `30d` |
| `limit` / `page` | ページング（デフォルト 50 件/ページ） |
| `starred` | `1` でスター付きのみ表示 |

レスポンス：`{ "total": 123, "limit": 50, "page": 1, "list": [ { "id", "device_id", "display_name", "sim_number", "sender", "source", "content", "received_at", "starred", "read_at", "deleted_at" } ] }`

### メッセージ操作

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/messages/remove` | ソフトデリート（body: `{ ids: [..] }`、deleted_at に書き込み） |
| POST | `/api/messages/restore` | ソフトデリートの復元（body: `{ ids: [..] }`） |
| POST | `/api/messages/clear` | ゴミ箱/全体を空にする（body: `{ scope: "trash" \| "all" }`） |
| POST | `/api/messages/star` | スターの切り替え（body: `{ id, starred }`） |
| POST | `/api/messages/read` | 既読にする（body: `{ id }`） |
| DELETE | `/api/messages/{id}` | 1 件を物理削除 |

### GET `/api/export?format=csv|json` — エクスポート

一覧と同じフィルターパラメータに対応。CSV は BOM 付きと `attachment` ダウンロードヘッダーを持ち、数式インジェクション対策（`=/+-@` で始まるセルには単一引用符を前置）を実装しています。

### GET `/api/stats` — 統計

今日/総数/デバイス数などの集計。GET `/api/sources` — ソース一覧（`[{ source, count }]`）。

## 3. デバイス管理（ログイン状態が必要）

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/devices` | デバイス一覧（`display_name` を含む：エイリアス > デバイス名、メッセージ数） |
| POST | `/api/devices/alias` | エイリアスを設定（body: `{ id, alias }`。空文字列で解除） |
| POST | `/api/devices/merge` | デバイスを統合（body: `{ from, to }`。全メッセージを移行した後ソースデバイスを削除。自分自身への統合は 400 を返す） |
| DELETE | `/api/devices/{id}` | デバイスを削除（メッセージがある場合は `has messages` で拒否） |

## 4. リアルタイムと補助

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/wait?last_id=N` | ロングポーリング：N より新しいメッセージがあれば即座に `{ changed: true }` を返し、なければ滞留（デフォルト 25 秒、`WAIT_MAX_SECONDS` で調整可） |
| GET | `/api/phone?number=` | 番号の地域（所属エリア）照会（`PHONE_AREA_ENABLED=false` で無効化。上流のレート制限付きプロキシで、独立した毎分 120 回のバケット） |
| POST | `/api/login` | ログイン（body: `{ password }` → `Set-Cookie: sms_auth=<署名セッション>`、ステートレス HMAC-SHA256 3 セグメントトークン、TTL 30 分、HttpOnly + SameSite=Lax；5 回失敗で 10 分ロック；パスワード誤りは 403、`SESSION_SECRET` 欠落は 500 設定エラー） |
| POST | `/api/logout` | ログアウト |
| GET | `/api/cron?token=` | 定期クリーンアップを起動（`RETENTION_DAYS` を超えた古いメッセージを削除） |
| GET | `/` `/manifest.webmanifest` `/sw.js` | 管理画面 / PWA マニフェスト / Service Worker |

## 5. 汎用 Webhook 転送フォーマット（送信方向）

`GENERIC_WEBHOOKS` を設定すると、各メッセージがデフォルトの JSON で POST されます：

```json
{
  "title": "🔐 認証コード 726418 · Gitee",
  "content": "認証コードは726418、5分間有効です",
  "time": "2026-10-27 14:23:45",
  "source": "sms",
  "sender": "Gitee",
  "device": "私のスマホ",
  "type": "verify",
  "code": "726418"
}
```

`type` ∈ `verify | sms | notify`；`code` はサーバー側の軽量検出による認証コード（未検出は空文字列）。`GENERIC_WEBHOOK_TEMPLATE` を設定するとテンプレートに従ってレンダリングされます（プレースホルダ `{{title}} {{content}} {{time}} {{source}} {{sender}} {{device}} {{type}} {{code}}`）。JSON として解析できれば JSON で送信され、そうでなければプレーンテキストで送信。`GENERIC_WEBHOOK_HEADERS` でリクエストヘッダーをカスタマイズできます（JSON オブジェクト文字列）。
