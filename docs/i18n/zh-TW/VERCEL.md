# Vercel 部署教學

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | **繁體中文** | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 自英語主版同步（繁體中文版）

把 SMSToWeb 部署到 Vercel（Edge Function + Turso 資料庫）。免費額度足夠個人使用，全程約 15 分鐘。

**本目錄檔案**：`api/[[...route]].js`（入口）、`app.js`（核心應用）、`db.js`（Turso 介接層）、`schema.sql`（建表）、`vercel.json`（含定時任務設定）。

---

## 一鍵部署（推薦）

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb%2Ftree%2Fmain%2Fplatforms%2Fvercel)

建議**先完成下方第二步（建 Turso 資料庫）拿到連線資訊**，再點按鈕：Vercel 會把本平台子目錄複製為你的倉庫並建立專案，依提示填 `RECEIVE_TOKEN`（推送驗證金鑰，自編長隨機字串）與 Turso 的 URL / Token 即可部署。部署成功後**務必執行一次第三步的建表 SQL**（Vercel 無法自動建表），否則頁面開啟無資料。

---

## 準備工作

1. 一個 GitHub 帳號（Vercel 透過 GitHub 倉庫部署）
2. 一個 Vercel 帳號（[註冊入口](https://vercel.com/signup)，直接用 GitHub 登入）

## 第一步：準備程式碼倉庫

1. 開啟專案 GitHub 倉庫，點右上角 **Fork**（或用你自己已 Push 的倉庫）
2. Fork 完成，你就有一份可自由修改的專案副本

## 第二步：建立 Turso 資料庫

Turso 提供 SQLite 相容資料庫（免費額度：100 個資料庫、5GB 儲存、每月 5 億列讀取）。

1. 開啟 [turso.tech](https://turso.tech)，點 **Start for free now**，用 GitHub 登入
2. 進入主控台 → **Create Database**（建立資料庫）：
   - Name：`sms-gateway`
   - Location：選離你近的區域（如 Singapore / Hong Kong）
   - Type：Free
3. 建立後進入資料庫詳細資訊頁：
   - 記下 **Database URL**（形如 `libsql://sms-gateway-xxxx.turso.io`）
   - 點 **Create Token**（或 Turso Platform Tokens）建立存取權杖，**立即複製儲存**（只顯示一次）
4. 初始化資料表結構：資料庫詳細資訊頁 → **Console**（網頁版 SQL 主控台）→ 把本目錄 [`schema.sql`](../../../platforms/vercel/schema.sql) 全部內容貼上進去 → 執行 → 提示成功（建立 `messages` 和 `devices` 兩張資料表）

> 也可用 Turso CLI：`turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`。

## 第三步：匯入倉庫到 Vercel

1. 登入 [vercel.com](https://vercel.com) → **Add New → Project**
2. 在 **Import Git Repository** 清單找到你 Fork 的倉庫，點 **Import**
3. 在設定頁展開 **Root Directory**（根目錄），選擇 `platforms/vercel`
   ——Vercel 會自動辨識目錄內的 `vercel.json` 和 `api/` 目錄，無需其他設定
4. 先不要急著點 Deploy，先做第四步的環境變數設定（在同一頁面 **Environment Variables** 區新增）

## 第四步：設定環境變數

在部署設定頁的 **Environment Variables** 中逐個新增（後續也可在 Project → Settings 裡改）：

| 變數 | 值 | 說明 |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | 第二步記下的 URL |
| `TURSO_AUTH_TOKEN` | （第二步的權杖） | 只顯示一次的那個 |
| `RECEIVE_TOKEN` | 自行編的長隨機字串 | 推送驗證，勿用範例值 |
| `ENABLE_AUTH` | `false` | 要登入改 `true` |
| `ADMIN_PASSWORD` | 自行編的密碼 | 僅 `ENABLE_AUTH="true"` 時需要 |
| `SESSION_SECRET` | 高熵隨機值（≥32 位隨機字串） | 僅 `ENABLE_AUTH="true"` 時需要；與密碼獨立，與其他平台分別設定獨立值；缺失時登入/驗證安全失敗，輪替後舊工作階段全部失效 |
| `RETENTION_DAYS` | `30` | 資料保留天數 |
| `CRON_SECRET` | **與 RECEIVE_TOKEN 相同的值** | Vercel Cron 呼叫 /api/cron 時自動附帶 `Bearer $CRON_SECRET` |
| `FEISHU_WEBHOOK`（選配 `FEISHU_SECRET`） | （選配）飛書群機器人 Webhook | 設定後新訊息自動轉發飛書群；機器人安全設定選「簽章驗證」時另配 `FEISHU_SECRET` |
| `WECOM_WEBHOOK` | （選配）企業微信群機器人 Webhook | 設定後新訊息自動轉發企微群 |
| `DINGTALK_WEBHOOK` | （選配）釘釘群機器人 Webhook | 加簽安全設定需另配 `DINGTALK_SECRET` |
| `SERVERCHAN_SENDKEY` | （選配）Server醬 SendKey | 微信推播 |
| `PUSHPLUS_TOKEN` | （選配）PushPlus 權杖 | 微信推播 |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | （選配）Telegram Bot | 兩者都設定才生效 |
| `BARK_DEVICE_KEY` | （選配）Bark 裝置 Key | 自建伺服器另配 `BARK_URL`，預設官方 |
| `NTFY_URL`（選配 `NTFY_TOKEN`） | （選配）ntfy 主題 URL | 完整 URL，如 `https://ntfy.sh/my-sms`；受保護主題另配 `NTFY_TOKEN`（Token 或 user:password） |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | （選配）Gotify | 伺服器地址 + 應用程式權杖 |
| `RESEND_API_KEY` + `MAIL_TO` | （選配）郵件（Resend） | 選配 `MAIL_FROM`，預設 `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS`（選配 `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`） | （選配）通用 Webhook | 逗號分隔多個 URL；選配範本自訂請求主體，`GENERIC_WEBHOOK_HEADERS`（JSON 字串）自訂請求標頭 |
| `SITE_NAME` / `SITE_ICON` | （選配） | 網站名稱 / 圖示 URL |
| `NOTIFY_LINK` | （選配） | 管理頁首頁網址；設定後所有通知渠道附上「開啟管理頁」入口，未設定自動省略 |

全部填完點 **Deploy**，等待約 1 分鐘部署完成。

## 第五步：驗證部署

1. 部署完成頁點 **Continue to Dashboard**，記下頂部分配的網域（形如 `https://xxx.vercel.app`）
2. 瀏覽器開啟該網域，應看到管理頁（預設「簡訊閘道」；開了登入則先見登入頁）
3. 驗證推送端點（把 `<網域>` 和 `<金鑰>` 換成你的）：

```
curl -X POST "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d '{"source":"notify","sender":"vercel-test","content":"部署測試"}'
```

回傳 `{"success":true,...}` 即通，網頁應立刻出現這則訊息。

## 第六步：接入手機端與裝置

按 [多平台串接部署指南](../../../docs/多平台接入部署指南.md) 設定安卓 SmsForwarder（簡訊走 `/api/receive`）和各裝置通知推送（走 `/api/push`），網域用你的 `xxx.vercel.app`（或綁定自訂網域）。

綁定自訂網域：Project → **Settings → Domains** → Add，依提示在網域 DNS 加一條 CNAME 記錄——目標值以 Domains 頁面顯示的為準（Vercel 為每個專案分配專屬的 `xxxxxx.vercel-dns.com` 地址）。

## 注意事項與常見問題

- **定時清理**：`vercel.json` 已設定每天 UTC 17:00（北京 01:00）呼叫 `/api/cron` 清理過期資料。Vercel Cron 會自動帶 `Authorization: Bearer $CRON_SECRET`，所以 `CRON_SECRET` 必須與 `RECEIVE_TOKEN` 一致
- **Hobby（免費）方案限制**：cron 僅支援每天一次（本專案正好一天一次，滿足；實際觸發時刻可能在設定小時內浮動，屬正常現象）；Edge 函式須在 **25 秒內開始回傳回應**（之後可持續串流 300 秒），管理頁長輪詢 `/api/wait` 恰好掛起 25 秒處於邊界——若被提前截斷，前端輪詢迴圈會自動重試，**不影響功能**，僅新訊息提醒稍不及時
- **Edge Runtime**：入口已宣告 `runtime = "edge"`，冷啟動快、全球邊緣節點執行
- **部署失敗排查**：多為環境變數漏填——缺 `TURSO_*` 會 500 且報 "config error"；檢查 Root Directory 是否選對 `platforms/vercel`
- **更新程式碼**：推送（push）到你 Fork 的倉庫，Vercel 自動重新部署
