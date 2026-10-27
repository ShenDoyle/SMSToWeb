# 架構文件

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | **繁體中文** | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 自英語主版同步（繁體中文版）

## 總體架構

手機端裝置 → 入站 API → 資料庫 → 網頁管理頁。

兩條入站通道，共用一套資料庫與管理頁：

- `POST /api/receive` — 安卓手機的簡訊轉發（SmsForwarder）
- `POST /api/push` — 通用推播（任何能發 HTTP 請求的裝置/指令碼）

六個平台（Cloudflare 主版本 + 五個移植平台）執行同一份核心應用 `app.js`，差異只在入口與資料庫介接層。

## 六平台架構

| 平台 | 入口 | 資料庫介接層 | 定時清理 |
|---|---|---|---|
| Cloudflare | `worker.js`（單檔） | 內建 D1 綁定（`env.DB`） | 平台 cron |
| Vercel | `api/[[...route]].js` | `db.js`（Turso over HTTPS，@libsql/client-edge） | `vercel.json` cron |
| Netlify | `functions/api.mjs` + `functions/cron.mjs` | `db.js`（Turso over HTTPS） | Scheduled Function |
| Deno | `main.js` | `db.js`（Turso over HTTPS） | `Deno.cron` |
| EdgeOne Pages | `functions/index.js`（根路徑）+ `functions/[[default]].js`（捕獲全部路由） | `db.js`（Turso over HTTPS） | 外部觸發 `/api/cron` |
| Node 自架 | `server.mjs`（node:http） | `db.js`（Turso / 本機 SQLite 雙模式，獨立維護） | 處理程序內建 |

- 五個移植平台的 `app.js` / `db.js` 由 `platforms/gen_app.py` 從單一來源（`platforms/shared/`，經 `src/worker.js` 產生）同步，**六平台業務程式碼逐位元組一致**（Node 的 `db.js` 雙模式介接層獨立維護，不參與同步）
- **31 個環境變數白名單（ENV_KEYS，含驗證項）**在 `gen_app.py` 同步時寫入六個平台入口，防止各平台透傳漂移；**不在此白名單的環境變數一律拒絕透傳**（從源頭杜絕「平台 A 依賴了平台 B 沒有的變數」與意外洩漏），未覆蓋的條目以測試報錯兜底
- 本目錄 `app.js` / `db.js` 同步自 `shared/`（單一來源），請勿手改；業務改動統一改 `src/worker.js` 後執行 `python platforms/gen_app.py` 重新同步
- `platforms/*/schema.sql` 與根目錄 `schema.sql` 一致（id、from、sim、name、content、source、time、device_id、deleted_at、starred、read_at、created_at；devices 表含 name、created_at、alias）

## 模組結構

### src/worker.js（核心原始碼，單檔案）

- **路由層**：`route()` 依路徑與方法分發到 21 個處理函式（push/receive/messages/star/read/remove/restore/clear/export/sources/stats/phone/devices/devices-alias/devices-merge/wait/login/logout/cron 等公開端點與靜態資源）
- **業務層**：入站驗證（RECEIVE_TOKEN）、資料校驗與截斷、重複偵測（秒級視窗查重）、驗證碼偵測（碼前/碼後/分隔式/混合碼四種模式）、通知轉發（11 渠道、三態渲染模板、`waitUntil`）、工作階段簽章與校驗
- **視圖層**：內嵌單頁管理頁（HTML+CSS+JS 零依賴，支援九語言 zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR，缺失鍵兜底 en）+ 登入頁模板 + PWA manifest/SW
- **工具函式**：時間處理（統一 UTC+8 儲存）、分頁查詢建構、CORS、速率限制（記憶體 Map，Edge 執行個體級）

### platforms/shared/（移植平台單一來源）

- `app.js`：由 `src/worker.js` 產生（gen_app.py 剝離 Cloudflare 特有語法後同步）
- `db.js`：Turso over HTTPS（@libsql/client-edge），非 Cloudflare 平台共用

## 資料流

```
入站 POST /api/receive 或 /api/push
  → 驗證 token（query 或 body）
  → 裝置解析（name → devices 表，冪等取得 device_id）
  → 內容清洗與截斷（8000 字元）+ 重複偵測
  → INSERT messages（source 區分 sms/notify；time 統一北京時間字串）
  → 通知轉發（選配，waitUntil 不阻塞回應；單渠道 10s 逾時）
  → 回應 JSON（含 duplicated 標記）

查詢 GET /api/messages
  → 工作階段驗證（ENABLE_AUTH=true 時）
  → 動態 WHERE 構建（source/device/range/q/starred/unread）
  → 分頁 SELECT + 總數 COUNT
  → 前端渲染（來源篩選器動態聚合）
```

## 會話與安全

- `ENABLE_AUTH=true` 時登入密碼保護管理頁；登入後簽發**無狀態簽章 Session**（`nonce.exp.HMAC-SHA256` 三段式，Cookie `sms_auth`，TTL 30 分鐘）；**`SESSION_SECRET` 缺失時安全失敗（fail-closed）**：登入 500、管理端點一律 401，不回退為密碼衍生，配置缺失一律不放行
- 工作階段：無狀態簽章 Session（`nonce.exp.HMAC-SHA256` 三段式，Cookie `sms_auth`），TTL 30 分鐘，輪替密鑰即全失效
- 登入速率限制：同 IP 連續失敗 5 次鎖 10 分鐘（記憶體）；入站寫入速率限制：每 IP 每分鐘 120 次（超限 429）
- 匯出 CSV 公式注入防護；`?lang=` 參數白名單校驗；歸屬地查詢走後端代理（快取 24h，上游限速保護）

## 設計決策

- **單檔案 + 零依賴**：核心 `src/worker.js` 一個檔案搞定全部業務（路由/業務/視圖），移植平台零 npm 依賴，任何平台貼上即用
- **單一來源同步**：六平台程式碼由 gen_app.py 產生，杜絕手動同步漂移（CI 校驗 zero-drift，204 項測試）
- **長輪詢而非 WebSocket**：平台相容性最好（Workers/Edge/Node 通吃），`WAIT_MAX_SECONDS` 按平台上限調整，前端指數退避兜底
- **軟刪除 + 復原**：`deleted_at` 標記，5 秒內可復原，`clear` 才實體刪除
- **fail-closed 原則**：`ADMIN_PASSWORD` 或 `SESSION_SECRET` 配置缺失時管理端點一律拒絕，不降級放行
