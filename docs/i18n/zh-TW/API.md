# API 文件（API）

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | **繁體中文** | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 自英語主版同步（繁體中文版）

所有端點均以 `/` 為根，回應為 JSON（`Content-Type: application/json`），支援 CORS。除「公開端點」外，受登入開關保護（安全設定建議見 README「安全強烈建議」）。

## 驗證方式

| 端點類型 | 驗證 |
|---|---|
| 入站推送（`/api/receive`、`/api/push`） | `?token=<RECEIVE_TOKEN>`（query 或表單欄位），**不受登入開關影響** |
| 管理端點 | Cookie 工作階段 `sms_auth`（`POST /api/login` 取得；`ENABLE_AUTH=true` 時啟用）。工作階段為**無狀態簽章 Token**（`nonce.exp.HMAC-SHA256` 三段式，簽章金鑰 `SESSION_SECRET`），有效期 30 分鐘；`SESSION_SECRET` 缺失時安全失敗（登入 500、管理端點一律 401，不回退為密碼衍生），配置缺失一律不放行。輪替 `SESSION_SECRET` 後所有舊工作階段立即失效 |
| 定時清理（`GET /api/cron`） | `?token=<RECEIVE_TOKEN>` 或 `Authorization: Bearer <RECEIVE_TOKEN>` |

## 1. 入站推送（公開）

### POST/GET `/api/receive` — 簡訊寫入資料庫（SmsForwarder 相容）

參數（JSON body，GET 時走 query）：

| 欄位 | 必填 | 說明 |
|---|---|---|
| `token` | 是 | RECEIVE_TOKEN（亦可放 query） |
| `name` | 否 | 裝置名（App 範本 name 欄位），預設 `unknown` |
| `sim` | 否 | 收件手機號碼，原樣寫入資料庫與顯示 |
| `from` | 否 | 寄件人 |
| `content` | 是 | 簡訊內文（伺服器端截斷至 8000 字元） |
| `time` | 否 | 用戶端時間；未提供時用伺服器端北京時間 |

```bash
curl -X POST "https://<域名>/api/receive?token=<RECEIVE_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"我的手機","sim":"13800138000","from":"10086","content":"您的驗證碼是 734752，5 分鐘內有效"}'
```

回應：`{ "success": true, "device_id": 1, "duplicated": false }`。同裝置+寄件人+內容+秒級時間重複推送 → `duplicated: true`（跳過入庫且**不轉發通知**）。

### POST `/api/push` — 通用推播（任意平台來源接入）

| 欄位 | 必填 | 說明 |
|---|---|---|
| `token` | 是 | RECEIVE_TOKEN（query） |
| `content` | 是 | 內文（截斷至 8000 字元） |
| `name` / `sender` | 否 | 裝置名 / 寄件方（App 名、指令碼名等） |
| `source` | 否 | 來源分類（預設 `notify`；如 `alert`、`jd`，前端可依來源篩選） |
| `time` | 否 | 用戶端時間，未提供時用伺服器端目前時間 |

收到訊息後同樣觸發 11 渠道通知轉發（三態渲染：無驗證碼的 push → 🔔 裝置通知）。

## 2. 訊息查詢與管理（需登入狀態）

### GET `/api/messages` — 訊息列表

Query 參數：

| 參數 | 說明 |
|---|---|
| `q` | 關鍵字檢索（比對 sender/content） |
| `source` | 來源篩選（如 `sms` / `notify` / 自訂來源） |
| `device_id` | 依裝置篩選 |
| `range` | 時間範圍：`1d` / `7d` / `30d` |
| `limit` / `page` | 分頁（預設 50/頁） |
| `starred` | `1` 僅看星號 |
| `unread` | `1` 僅看未讀 |

回應：`{ "total": 123, "page": 1, "limit": 50, "sources": ["sms","notify"], "messages": [ { "id": 456, "device_id": 17, "device": "我的手機", "alias": "主力機", "sim": "13800138000", "sender": "1069012345678", "content": "您的驗證碼是 734752", "code": "734752", "time": "2026-10-14 12:30:00", "source": "sms", "starred": 0, "unread": 1 } ] }`

### 訊息操作

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/messages/remove` | 軟刪除（body: `{ ids: [..] }`，寫入 deleted_at） |
| POST | `/api/messages/restore` | 復原軟刪除（body: `{ ids: [..] }`） |
| POST | `/api/messages/clear` | 清空資源回收筒/全部（body: `{ scope: "trash" \| "all" }`） |
| POST | `/api/messages/star` | 星號切換（body: `{ id, starred }`） |
| POST | `/api/messages/read` | 標記已讀（body: `{ id }`） |
| DELETE | `/api/messages/{id}` | 實體刪除單則 |

### GET `/api/export?format=csv|json` — 匯出

支援同列表的篩選參數；CSV 帶 BOM 與 `attachment` 下載標頭，公式注入防護（`=/+-@` 開頭的儲存格前置單引號）。

### GET `/api/stats` — 統計

今日/總數/裝置數等彙總。GET `/api/sources` — 來源清單（`[{ source, count }]`）。

## 3. 裝置管理（需登入狀態）

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/devices` | 裝置清單（含 `display_name`：別名 > 裝置名、訊息計數） |
| POST | `/api/devices/alias` | 設定別名（body: `{ id, alias }`；空字串清除） |
| POST | `/api/devices/merge` | 合併裝置（body: `{ from, to }`，遷移全部訊息後刪除來源裝置；來源→自身回傳 400） |
| DELETE | `/api/devices/{id}` | 刪除裝置（有訊息時回傳 `has messages` 拒絕） |

## 4. 即時與輔助

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/wait?last_id=N` | 長輪詢：有比 N 更新的訊息立即回傳 `{ changed: true }`，否則掛起（預設 25s，`WAIT_MAX_SECONDS` 可調） |
| GET | `/api/phone?number=` | 號碼歸屬地查詢（`PHONE_AREA_ENABLED=false` 關閉；上游限速代理，獨立每分鐘 120 次配額） |
| POST | `/api/login` | 登入（body: `{ password }` → `Set-Cookie: sms_auth=<簽章工作階段>`，無狀態 HMAC-SHA256 三段式 Token、TTL 30 分鐘、HttpOnly + SameSite=Lax；失敗 5 次鎖 10 分鐘；密碼錯誤 403，`SESSION_SECRET` 缺失 500 配置錯誤） |
| POST | `/api/logout` | 登出 |
| GET | `/api/cron?token=` | 觸發定時清理（刪除超過 `RETENTION_DAYS` 的舊訊息） |
| GET | `/` `/manifest.webmanifest` `/sw.js` | 管理頁 / PWA 清單 / Service Worker |

## 5. 通用 Webhook 轉發格式（出站）

設定 `GENERIC_WEBHOOKS` 後，每則訊息 POST 預設 JSON：

```json
{ "title": "【短信】13800138000 ← 10086", "content": "您的驗證碼是 734752", "time": "2026-10-14 12:30:00", "source": "sms", "sender": "1069012345678", "device": "我的手機", "type": "verify", "code": "734752" }
```

`type` ∈ `verify | sms | notify`；`code` 為伺服器端輕量偵測出的驗證碼（未偵測出為空字串）。配 `GENERIC_WEBHOOK_TEMPLATE` 後按範本渲染（預留位置 `{{title}} {{content}} {{time}} {{source}} {{sender}} {{device}} {{type}} {{code}}`），可解析為 JSON 則按 JSON 傳送，否則按純文字；`GENERIC_WEBHOOK_HEADERS` 可自訂請求標頭（JSON 物件字串）。
