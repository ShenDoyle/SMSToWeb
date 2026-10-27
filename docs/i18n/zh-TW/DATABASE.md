# 資料庫文件

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | **繁體中文** | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 自英語主版同步（繁體中文版）

## 資料庫類型

| 平台 | 資料庫 | 驅動 |
|---|---|---|
| Cloudflare | D1（SQLite） | 平台綁定 `env.DB`（prepare/bind） |
| Vercel / Netlify / Deno / EdgeOne | Turso（SQLite over HTTPS） | `@libsql/client-edge` |
| Node 自架 | 本機 SQLite（`SQLITE_PATH`）或 Turso | `node:sqlite`（Node ≥ 22.13 內建）或 `@libsql/client` |

各平台資料表結構完全一致（`schema.sql` 同一份），可隨時互相遷移。

## 資料表結構

### messages

| 欄位 | 類型 | 說明 |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | 主鍵 |
| `from` | TEXT | 寄件人（號碼/名稱） |
| `sim` | TEXT | 收件手機號碼 |
| `name` | TEXT | 裝置名（App 端自訂） |
| `content` | TEXT | 訊息內文（最長 8000 字元） |
| `source` | TEXT NOT NULL DEFAULT 'sms' | 來源：`sms` / `notify` / 自訂來源 |
| `time` | TEXT | 訊息時間（北京時間字串 `YYYY-MM-DD HH:MM:SS`） |
| `device_id` | INTEGER | 關聯 devices.id |
| `deleted_at` | TEXT | 軟刪除標記（NULL=未刪除；寫入刪除時間） |
| `starred` | INTEGER NOT NULL DEFAULT 0 | 星號（0/1） |
| `read_at` | TEXT | 已讀時間（NULL=未讀） |
| `created_at` | TEXT | 入庫時間（北京時間字串） |

### devices

| 欄位 | 類型 | 說明 |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | 主鍵 |
| `name` | TEXT UNIQUE | 裝置名（冪等鍵） |
| `created_at` | TEXT | 建立時間 |
| `alias` | TEXT | 裝置別名（NULL=未設定） |

## 索引與約束

- `messages(device_id)` 索引：按裝置篩選
- `messages(time)` 索引：時間範圍與分頁
- `messages(source)` 索引：來源篩選
- `devices.name` UNIQUE：裝置冪等（重複推送不產生重複裝置）

## 生命週期

- **寫入**：`/api/receive`（簡訊）與 `/api/push`（通知）→ 裝置冪等 upsert → 內容截斷 8000 字元 → 重複偵測（同裝置+寄件人+內容+秒級時間戳記）→ INSERT；`duplicated` 的訊息不重複轉發
- **軟刪除**：`/api/messages/remove` 寫 `deleted_at`，前端 5 秒內可復原（`/api/messages/restore`）
- **實體刪除**：`/api/messages/clear`（回收筒/全部）與 DELETE `/api/messages/{id}`
- **定時清理**：每天 UTC 17:00 刪除 `time` 早於 `RETENTION_DAYS`（預設 30 天）的訊息（Cloudflare cron / Vercel cron / Netlify scheduled function / Deno.cron / Node 內建計時器 / 外部觸發 `/api/cron?token=`）

## 建表與升級

新部署：執行各平台目錄內 `schema.sql`（或根目錄 `schema.sql`）。

舊資料庫升級（補欄位）：

```sql
ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'sms';
ALTER TABLE messages ADD COLUMN deleted_at TEXT;
ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN read_at TEXT;
```

Node 本機 SQLite 模式啟動時自動檢查並補齊缺失欄位。

## 遷移

- 平台間遷移：資料表結構一致，Turso ↔ D1 透過匯出/匯入 SQLite 檔案遷移（`turso db import` / D1 Console）
- 時區說明：`time` 欄位存北京時間字串（非 UTC），前端直接展示無需轉換
