# Node 自架部署教學（Docker / VPS）

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | **繁體中文** | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 自英語主版同步（繁體中文版）

把 SMSToWeb 部署到自己的伺服器（Docker / VPS / Fly.io / Railway）。**處理程序常駐**、無函式時長限制、資料完全自控。本平台是移植版：業務程式碼與 Cloudflare 主版本逐位元組一致，差異僅在雙模式介接層（Turso / 本機 SQLite）。

**本目錄檔案**：`server.mjs`（node:http 入口）、`app.js`（核心應用）、`db.js`（Turso + 本機 SQLite 雙模式介接層，獨立維護）、`schema.sql`（建表）、`Dockerfile`、`package.json`。

---

## 準備工作

- 一台 VPS（或 Fly.io / Railway 帳號），Docker 可用
- Node 自架模式兩種資料庫任選：
  - **本機 SQLite**（推薦個人使用，零外部依賴）：需 **Node ≥ 22.13**（內建 node:sqlite），設 `SQLITE_PATH`
  - **Turso**（多平台共用資料時）：設 `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`

## 方式 A：Docker（推薦）

1. 把本目錄上傳到伺服器（git clone 或 scp）
2. 建置映像：

```bash
docker build -t smstoweb .
```

3. 執行（本機 SQLite 模式）：

```bash
docker run -d --name smstoweb \
  -p 3000:3000 \
  -v /opt/smstoweb-data:/app/data \
  -e RECEIVE_TOKEN="換成你的長隨機字串" \
  -e SQLITE_PATH="/app/data/smstoweb.db" \
  -e ENABLE_AUTH="true" \
  -e ADMIN_PASSWORD="換成你的密碼" \
  -e SESSION_SECRET="換成32位以上的高熵隨機字串" \
  --restart unless-stopped \
  smstoweb
```

4. 啟動時自動建表（SQLite）；瀏覽器開啟 `http://<伺服器IP>:3000` 驗證

> Turso 模式改為：`-e TURSO_DATABASE_URL="..." -e TURSO_AUTH_TOKEN="..."`（不設 `SQLITE_PATH`）；建表用 Turso 主控台或 `turso db shell sms-gateway < schema.sql`。

## 方式 B：裸 Node（VPS 直接執行）

1. 安裝 Node 22.13+（`apt install nodejs` 版本過舊者用 nvm）
2. 上傳本目錄後：

```bash
node server.mjs
```

3. 環境變數可寫進 systemd unit 的 `Environment=`（`SQLITE_PATH` 指向可寫目錄）或 `export` 後執行；建議配 systemd 開機自啟

## 方式 C：Fly.io / Railway

- Fly.io：安裝 [flyctl](https://fly.io/docs/flyctl/) 後在本目錄執行：

```bash
fly launch   # 依指示建立應用程式：區域自選；詢問資料庫時選 No（我們用 Turso 或本機磁碟區）
fly secrets set RECEIVE_TOKEN=... ENABLE_AUTH=true ADMIN_PASSWORD=... SESSION_SECRET=... SQLITE_PATH=/data/smstoweb.db
fly volumes create smstoweb_data --size 1   # 本機 SQLite 需要持久磁碟區
fly deploy   # 記下分配的網域 https://<app>.fly.dev
```

- Railway：New Project → Deploy from repo → **Settings → Root Directory** 填 `platforms/node`，再在 **Variables** 頁新增環境變數（見下表）

## 環境變數一覽

| 變數 | 必填 | 說明 |
|---|---|---|
| `RECEIVE_TOKEN` | 是 | 推送驗證金鑰，自編長隨機字串 |
| `SQLITE_PATH` | 二選一 | 本機 SQLite 檔案路徑（需 Node ≥ 22.13；容器內放持久磁碟區目錄） |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | 二選一 | Turso 模式憑證（配了就用 Turso，否則用 `SQLITE_PATH`） |
| `ENABLE_AUTH` | 否 | `"true"` 管理頁需登入（**安全考量強烈建議開啟**）；預設免登入 |
| `ADMIN_PASSWORD` | 否 | 登入密碼（`ENABLE_AUTH="true"` 時設定；漏設定時管理端點一律拒絕存取並輸出警示——設定缺失不放行） |
| `SESSION_SECRET` | 開啟登入時必須 | 登入工作階段簽章金鑰：高熵隨機值（≥32 位隨機字串，與密碼獨立），與其他平台分別設定獨立值；缺失時登入/驗證安全失敗，不回退為密碼衍生；輪替後舊工作階段全部失效需重新登入 |
| `RETENTION_DAYS` | 否 | 資料保留天數，預設 30 |
| `WAIT_MAX_SECONDS` | 否 | 長輪詢最長掛起秒數（3–25，預設 25；常駐處理程序無平台截斷，一般保持預設） |
| 通知渠道變數 | 否 | 同其他平台：`FEISHU_WEBHOOK`（選配 `FEISHU_SECRET`）/ `WECOM_WEBHOOK` / `DINGTALK_WEBHOOK`（選配 `DINGTALK_SECRET`）/ `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY`（選配 `BARK_URL`）/ `NTFY_URL`（選配 `NTFY_TOKEN`）/ `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO`（選配 `MAIL_FROM`）/ `GENERIC_WEBHOOKS`（選配 `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`） |
| `SITE_NAME` / `SITE_ICON` | 否 | 網站名稱 / 圖示 URL，未設定則用預設值 |
| `NOTIFY_LINK` | 否 | 管理頁首頁網址；設定後所有通知渠道附上「開啟管理頁」入口，未設定自動省略 |

## 驗證部署

瀏覽器開啟 `http://<伺服器IP>:3000`（或你的網域）應看到管理頁。驗證推送端點（把 `<網域>` 和 `<金鑰>` 換成你的）：

```
curl -X POST "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d '{"source":"notify","sender":"node-test","content":"部署測試"}'
```

回傳 `{"success":true,...}` 即通，網頁應立刻出現這則訊息。

## 接入手機端與裝置

按 [多平台串接部署指南](../../../docs/多平台接入部署指南.md) 設定安卓 SmsForwarder（簡訊走 `/api/receive`）和各裝置通知推送（走 `/api/push`），網域換成你的伺服器地址。

## 注意事項與常見問題

- **反向代理**：Nginx/Caddy 反代時保留 `X-Forwarded-For`（登入速率限制與寫入速率限制按真實來源 IP 計算）；WebSocket 非必需（長輪詢走普通 HTTP）
- **定時清理**：處理程序內建每天 UTC 17:00（北京 01:00）自動清理，無需外部 cron
- **常駐處理程序優勢**：長輪詢完整掛起、無函式時長限制、通知轉發全走背景
- **免費額度情況**：Fly.io 新帳號一次性 $5 試用額度（30 天有效）；Railway 免費試用一次 $5（30 天）；Hobby 方案 $5/月含等額使用額度，綁卡後按用量計費，本專案微用量費用很低。**長期零成本首選 Cloudflare 主版本**
- **資料備份**：本機 SQLite 就是單檔案（`SQLITE_PATH`），定期備份該檔案即可；Turso 資料在雲端，可隨時匯出
- **換伺服器**：只需重新設定好環境變數，資料無損（搬 SQLite 檔案 / Turso 不動）
- **登入保護**：登入速率限制存在記憶體中（處理程序重啟即歸零）；http 部署的登入 cookie 自動降級，不強制 Secure（Alook 等瀏覽器登入後跳轉正常）
- **日誌排查**：`docker logs -f smstoweb`（或 systemd journal），關注 `notify forward failed:`（轉發失敗）與 `config error`（環境變數缺失）
