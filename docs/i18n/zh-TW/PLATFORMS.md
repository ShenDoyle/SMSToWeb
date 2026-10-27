# 多平台部署總覽

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | **繁體中文** | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 自英語主版同步（繁體中文版）

SMSToWeb 的全部六個平台（Cloudflare 主版本 + 五個移植平台）都在 `platforms/` 目錄。**每個平台子目錄完全自包含**：
程式碼（入口 + 核心應用 + 資料庫介接層）+ `schema.sql` + 該平台的詳細部署教學（README.md）。

| 平台 | 執行階段 | 定時清理 | 詳細教學 |
|---|---|---|---|
| **Cloudflare**（主版本） | Worker + D1 | 平台 cron | [CLOUDFLARE.md](./CLOUDFLARE.md) |
| Vercel | Edge Function | 平台 cron | [VERCEL.md](./VERCEL.md) |
| Deno Deploy | Deno 原生 | `Deno.cron`（內建） | [DENO.md](./DENO.md) |
| Netlify | Functions v2（Node） | Scheduled Function | [NETLIFY.md](./NETLIFY.md) |
| EdgeOne Makers（騰訊） | Functions | 外部 cron 呼叫 /api/cron | [EDGEONE.md](./EDGEONE.md) |
| Fly.io / Railway / VPS | Docker（Node 22）+ Turso/本機 SQLite | 處理程序內建 | [NODE.md](./NODE.md) |

六平台（含 Cloudflare）端點路徑、驗證邏輯、訊息模型、管理頁、多渠道通知轉發、每日清理（UTC 17:00）完全一致，
資料表結構相同，可隨時互相遷移。

> **一鍵部署**：Cloudflare / Vercel / Netlify 三個平台的教學頂部有官方一鍵部署按鈕（Cloudflare 按鈕連建立資料庫與資料表都自動完成），
> Deno Deploy、EdgeOne、Docker 自架暫無官方按鈕，依各平台教學操作即可。

## 平台怎麼選

- **想要零成本 + 省心** → Cloudflare 主版本（D1 免費額度大，Worker 無時長問題）
- **想體驗多平台** → Deno Deploy（與 Worker 語義最接近，長輪詢基本無截斷）
- **主要供中國大陸存取** → EdgeOne Makers（注意自訂網域需備案）
- **已有伺服器 / 想完全自控** → node/（Docker 自架）

> **長輪詢與平台逾時**：管理頁透過 `GET /api/wait` 掛起等待新訊息，預設最長 25 秒，可用環境變數 `WAIT_MAX_SECONDS`（3–25）依平台調低。
> Netlify Functions 現行上限 60 秒（入口預設 `WAIT_MAX_SECONDS=8` 保守調整，可按需調高）；Vercel Edge 建議 `20`；Cloudflare / Deno / Node 保持預設即可。
> 前端對失敗做**指數退避**（2→30s）並在頁面重新可見時立即補拉，即使被平台提前截斷也**不會影響功能**，僅新訊息提醒稍有延遲。

## 通用準備（所有非 Cloudflare 平台共用）

**資料庫統一用 [Turso](https://turso.tech)**（SQLite 相容，免費額度：100 個資料庫、5GB 儲存、每月 5 億列讀取）：

1. 開啟 [turso.tech](https://turso.tech)，用 GitHub 登入
2. **Create Database**：名稱 `sms-gateway`，區域選 Singapore / Hong Kong，類型 Free
3. 資料庫詳細資訊頁記下 **Database URL**（`libsql://sms-gateway-xxxx.turso.io`）；點 **Create Token** 建立權杖並立即儲存（只顯示一次）
4. 初始化資料表結構：詳細資訊頁 **Console** 中貼上各平台目錄內 `schema.sql` 全部內容執行（與倉庫根目錄 `schema.sql` 相同）

CLI 等價指令：

```bash
turso auth login
turso db create sms-gateway          # 建立資料庫
turso db show sms-gateway --url      # 查看 URL
turso db tokens create sms-gateway   # 建立權杖
turso db shell sms-gateway < schema.sql   # 建立資料表
```

**環境變數**（各平台設定面板設定，完整說明見各平台教學）：

| 變數 | 必填 | 說明 |
|---|---|---|
| `TURSO_DATABASE_URL` | 是 | `libsql://sms-gateway-<組織>.turso.io` |
| `TURSO_AUTH_TOKEN` | 是 | 資料庫存取權杖 |
| `RECEIVE_TOKEN` | 是 | 推送驗證金鑰（與串接端 URL 中 `token=` 一致） |
| `ENABLE_AUTH` | 否 | `"true"` 管理頁需登入（**安全考量強烈建議開啟**，見下方安全建議）；預設免登入 |
| `ADMIN_PASSWORD` | 否 | 登入密碼（`ENABLE_AUTH="true"` 時設定；漏設定時管理端點一律拒絕存取並輸出警示——設定缺失不放行） |
| `SESSION_SECRET` | 開啟登入時必須 | 登入工作階段簽章金鑰：高熵隨機值（≥32 位隨機字串，與管理密碼獨立），各平台須分別設定獨立值；缺失時登入與驗證安全失敗（fail-closed：登入 500、管理端點 401），不回退為密碼衍生；工作階段有效期 30 分鐘，輪替後舊工作階段全部失效需重新登入 |
| `RETENTION_DAYS` | 否 | 資料保留天數，預設 30 |
| `WAIT_MAX_SECONDS` | 否 | 長輪詢掛起秒數（3–25，預設 25）；Netlify 設 `8`、Vercel Edge 設 `20` |
| 通知渠道變數 | 否 | `FEISHU_WEBHOOK`（飛書，選配 `FEISHU_SECRET` 簽章）/ `WECOM_WEBHOOK`（企微）/ `DINGTALK_WEBHOOK`（釘釘，選配 `DINGTALK_SECRET` 加簽）/ `SERVERCHAN_SENDKEY`（Server醬）/ `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY`（選配 `BARK_URL`）/ `NTFY_URL`（選配 `NTFY_TOKEN`）/ `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO`（郵件，選配 `MAIL_FROM`）/ `GENERIC_WEBHOOKS`（選配 `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`）。設定哪個轉發哪個，全部未設定則不轉發 |
| `SITE_NAME` / `SITE_ICON` | 否 | 網站名稱 / 圖示 URL，未設定則用預設值 |
| `NOTIFY_LINK` | 否 | 管理頁首頁網址；設定後所有通知渠道附上「開啟管理頁」入口（按鈕/連結/click），未設定自動省略 |
| `CRON_SECRET`（僅 Vercel） | 否 | 設為與 `RECEIVE_TOKEN` 相同值，供 Vercel Cron 呼叫 /api/cron |
| `SQLITE_PATH`（僅 node 自架） | 否 | 本機 SQLite 模式：設定後免外部資料庫（需 Node 22.13+，見 [NODE.md](./NODE.md)） |

> **安全強烈建議**
> 1. **開啟管理頁登入**（`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`）：管理頁承載簡訊驗證碼等敏感內容，預設免登入意味著知道網域的人都能查看全部訊息並刪除資料。登入端點已內建速率限制（同 IP 連續失敗 5 次鎖定 10 分鐘）；`/api/receive`、`/api/push` 另有每 IP 每分鐘 120 次的寫入速率限制（超限回傳 429）。
> 2. **推送 token 走 URL query 的取捨**：為相容 SmsForwarder 等用戶端，`/api/receive`、`/api/push` 支援 `?token=` 查詢參數傳驗證——token 會出現在 URL 中，可能進入平台存取日誌、瀏覽器歷史。若在意的話請改用 POST + 請求標頭 `Authorization: Bearer <RECEIVE_TOKEN>` 傳遞（兩種方式都支援）。

## 目錄結構

```
platforms/
├── cloudflare/ # 主版本：worker.js + schema.sql + wrangler.toml + README.md（自包含）
├── vercel/     # api/[[...route]].js + app.js + db.js + schema.sql + vercel.json + README.md
├── netlify/    # functions/{api,cron}.mjs + app.js + db.js + schema.sql + netlify.toml + README.md
├── deno/       # main.js + app.js + db.js + schema.sql + README.md
├── edgeone/    # functions/{[[default]].js,index.js} + app.js + db.js + schema.sql + README.md
├── node/       # server.mjs + app.js + db.js + schema.sql + Dockerfile + package.json + README.md
├── shared/     # app.js / db.js 唯一原始檔（gen_app.py 由此同步到各平台目錄）
└── gen_app.py  # 產生器：從 ../src/worker.js 產生 app.js 並同步全部平台（含 cloudflare 獨立副本）
```

每個平台目錄可單獨作為部署根目錄（Git 部署時把平台 Root Directory 指到對應子目錄即可），
零 npm 依賴、無需建置。`src/worker.js` 有更新後執行 `python platforms/gen_app.py` 一鍵同步全部平台（CI 校驗零漂移，`node tests/run.mjs` 涵蓋 204 項功能斷言）。

## 從 Cloudflare Worker 遷移到其他平台

1. 依上文準備 Turso 資料庫並建立資料表
2. （選配）遷移歷史資料：CF Dashboard 匯出 D1 資料（SQLite 檔案）→ `turso db import` 匯入（見官方 CLI 文件）
3. 依目標平台 README 部署，驗證管理頁與 /api/push 正常
4. 把手機端與各推送指令碼的 Webhook 網域換到新平台
5. 觀察一兩天無異常後停用舊 Worker

## 通用說明

- API 路徑全平台一致：`/api/receive`、`/api/push`、`/api/messages`（支援 `device_id`/`source`/`range`/`q`/`limit`/`page`/`starred`/`unread`）、`/api/messages/star`、`/api/messages/read`、`/api/messages/remove`、`/api/messages/restore`、`/api/messages/clear`、`/api/export`（CSV/JSON）、`/api/sources`、`/api/stats`、`/api/phone`（歸屬地）、`/api/devices`、`/api/devices/alias`、`/api/devices/merge`、`/api/wait`、`/api/login`、`/api/logout`、`/api/cron`；另有公開的 `/manifest.webmanifest`、`/sw.js`
- `/api/cron` 供外部排程器觸發清理，驗證：`?token=<RECEIVE_TOKEN>` 或 `Authorization: Bearer <RECEIVE_TOKEN>`
- `/api/receive` 與 `/api/push` 不受登入開關影響
