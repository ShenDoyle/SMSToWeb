# Netlify 部署教學

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | **繁體中文** | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 自英語主版同步（繁體中文版）

把 SMSToWeb 部署到 Netlify（Functions v2 + Turso 資料庫）。免費額度足夠個人使用，全程約 15 分鐘。

**本目錄檔案**：`functions/api.mjs`（入口）、`functions/cron.mjs`（定時清理）、`app.js`（核心應用）、`db.js`（Turso 介接層）、`schema.sql`（建表）、`netlify.toml`（含定時任務設定）。

---

## 一鍵部署（推薦）

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/ShenDoyle/SMSToWeb)

Netlify 按鈕會把本平台子目錄複製為你的倉庫並建立專案。**部署嚮導中直接填好下方第五步的環境變數**（至少 `RECEIVE_TOKEN`、`TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN` 三個），避免部署後再補。部署成功後**務必執行一次第三步的建表 SQL**（Netlify 無法自動建表），否則頁面開啟無資料。

---

## 準備工作

1. 一個 GitHub 帳號
2. 一個 Netlify 帳號（[註冊入口](https://app.netlify.com/signup)，直接用 GitHub 登入）

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
   - 點 **Create Token** 建立存取權杖，**立即複製儲存**（只顯示一次）
4. 初始化資料表結構：資料庫詳細資訊頁 → **Console**（網頁版 SQL 主控台）→ 把本目錄 [`schema.sql`](../../../platforms/netlify/schema.sql) 全部內容貼上進去 → 執行 → 提示成功（建立 `messages` 和 `devices` 兩張資料表）

## 第三步：匯入倉庫到 Netlify

1. 登入 [app.netlify.com](https://app.netlify.com) → **Add new site → Import an existing project**
2. 選 **Deploy with GitHub**，授權後在清單找到你 Fork 的倉庫點選
3. 展開 **Advanced build settings**，先不動其他欄位（`netlify.toml` 已內建函式目錄等設定）
4. Base directory 可不填；之後在 **Site configuration → Build & deploy → Build settings → Base directory** 填 `platforms/netlify` 亦可

## 第四步：設定環境變數

Site configuration → **Environment variables → Add a variable → Import from a .env file**（或逐個手動新增）：

| 變數 | 值 | 說明 |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | 第二步記下的 URL |
| `TURSO_AUTH_TOKEN` | （第二步的權杖） | 只顯示一次的那個 |
| `RECEIVE_TOKEN` | 自行編的長隨機字串 | 推送驗證，勿用範例值 |
| `ENABLE_AUTH` | `false` | 要登入改 `true` |
| `ADMIN_PASSWORD` | 自行編的密碼 | 僅 `ENABLE_AUTH="true"` 時需要 |
| `SESSION_SECRET` | 高熵隨機值（≥32 位隨機字串） | 僅 `ENABLE_AUTH="true"` 時需要；與密碼獨立，與其他平台分別設定獨立值；缺失時登入/驗證安全失敗，輪替後舊工作階段全部失效 |
| `RETENTION_DAYS` | `30` | 資料保留天數 |
| `WAIT_MAX_SECONDS` | `8` | **重要**：Netlify Functions 預設 10s 上限，長輪詢掛起秒數需低於它，避免被平台強制終止 |
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

環境變數改動後需 **Deploys → Trigger deploy** 重新部署才生效。

## 第五步：驗證部署

1. 部署完成，記下分配的網域（形如 `https://xxx.netlify.app`）
2. 瀏覽器開啟該網域，應看到管理頁（預設「簡訊閘道」；開了登入則先見登入頁）
3. 驗證推送端點（把 `<網域>` 和 `<金鑰>` 換成你的）：

```
curl -X POST "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d '{"source":"notify","sender":"netlify-test","content":"部署測試"}'
```

回傳 `{"success":true,...}` 即通，網頁應立刻出現這則訊息。

## 第六步：接入手機端與裝置

按 [多平台串接部署指南](../../../docs/多平台接入部署指南.md) 設定安卓 SmsForwarder（簡訊走 `/api/receive`）和各裝置通知推送（走 `/api/push`），網域用你的 `xxx.netlify.app`（或綁定自訂網域）。

綁定自訂網域：Site configuration → **Domain management → Add a domain**，Netlify 免費自動簽發 HTTPS 憑證。

## 注意事項與常見問題

- **長輪詢截斷**：Netlify Functions 免費方案現行上限 60 秒，入口已保守把長輪詢設為 `WAIT_MAX_SECONDS=8`（可用環境變數在 3–25 之間調整）；前端遇失敗會指數退避自動重試，**不影響功能**，僅新訊息提醒稍不及時
- **定時清理**：`netlify.toml` 已設定每天 UTC 17:00（北京 01:00）跑 `functions/cron.mjs`（Scheduled Function）；帳號需啟用 Background / Scheduled Functions 能力（免費方案已支援）
- **部署失敗排查**：多為環境變數漏填——缺 `TURSO_*` 會 500 且報 "config error"；檢查 Base directory 是否設為 `platforms/netlify`
- **更新程式碼**：推送（push）到你 Fork 的倉庫，Netlify 自動重新部署
