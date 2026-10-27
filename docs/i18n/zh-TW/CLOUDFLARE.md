# Cloudflare 部署教學（主版本，全程網頁操作）

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | **繁體中文** | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 自英語主版同步（繁體中文版）

這是專案的主版本：手機簡訊/通知 → Cloudflare Worker → D1 資料庫 → 網頁管理頁。
無需伺服器、免費額度充足、全程網頁點選即可完成，無需安裝任何工具。

本目錄**完全自包含**：[`worker.js`](../../../platforms/cloudflare/worker.js)（部署原始碼）+ [`schema.sql`](../../../platforms/cloudflare/schema.sql)（建表指令碼）+ [`wrangler.toml`](../../../platforms/cloudflare/wrangler.toml)（命令列部署選配設定），不依賴倉庫其他檔案。其餘平台見 [PLATFORMS.md](./PLATFORMS.md)。

---

## 一鍵部署（推薦新手）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

點上方按鈕，Cloudflare 自動完成：複製程式碼到你的 GitHub → **自動建立 D1 資料庫並執行建表** → 綁定資源 → 設定 CI（之後你倉庫每次 push 自動重新部署）→ 上線。過程中依提示填入以下金鑰：

- `RECEIVE_TOKEN`：推送驗證金鑰，自行編一個足夠長的隨機字串（手機端串接 URL 中 `token=` 與之保持一致）
- `ADMIN_PASSWORD`：管理頁登入密碼（**強烈建議設定**——管理頁承載簡訊驗證碼等敏感內容；`ENABLE_AUTH="true"` 但漏設定時管理端點一律拒絕存取，不會免登入放行）
- `SESSION_SECRET`：登入工作階段簽章金鑰，**開啟登入時必須設定**——高熵隨機值（≥32 位隨機字串，如 `node -e "console.log(crypto.randomBytes(32).toString('hex'))"` 產生），與密碼完全獨立；缺失時登入與驗證安全失敗（登入 500、管理端點 401），不會回退為密碼衍生；輪替後所有舊工作階段立即失效

> 綁自訂網域（如 `sms.example.com`）：部署完成後進入 Worker → 設定 → 網域和路由 → 新增自訂網域。
> 下方手動教學保留給不想走一鍵流程、或想逐步理解每一步的使用者。

## 準備工作

1. 一個 Cloudflare 帳號（[註冊入口](https://dash.cloudflare.com/sign-up)，免費，信箱即可）
2. 本專案程式碼（本目錄的 [`worker.js`](../../../platforms/cloudflare/worker.js) 就是要貼上的全部程式碼）

## 第一步：建立 D1 資料庫

1. 登入 [dash.cloudflare.com](https://dash.cloudflare.com)
2. 左側選單 **儲存和資料庫 → D1 SQL 資料庫**
3. 點 **建立資料庫**，名稱填 `sms-gateway-db`（其他預設），點建立
4. 進入剛建好的資料庫 → **主控台** 分頁
5. 把本目錄 [`schema.sql`](../../../platforms/cloudflare/schema.sql) 的全部內容複製貼上進輸入框，點 **執行**
6. 提示執行成功（會建立 `messages` 和 `devices` 兩張資料表）

## 第二步：建立 Worker 並貼上程式碼

1. 左側選單 **運算（Workers）→ Workers 和 Pages**
2. 點 **建立應用程式**，選擇 **Start with Hello World!**（從 Hello World 範本開始），名稱填 `sms-gateway`，點 **部署**（先用預設程式碼部署成功即可）
3. 點 **編輯程式碼**，刪除編輯器裡的全部預設程式碼
4. 開啟本目錄的 [`worker.js`](../../../platforms/cloudflare/worker.js)，全選複製，貼上進編輯器
5. 點右上角 **部署**，提示部署成功

## 第三步：綁定 D1 資料庫

1. 回到 Worker 總覽頁 → **Bindings（綁定）** 分頁
2. 點 **新增 → D1 資料庫**
3. 變數名稱填 `DB`（必須一模一樣，大寫），選擇剛建的 `sms-gateway-db`
4. 點 **部署/儲存**

## 第四步：設定變數與金鑰

同一位置 **設定 → 變數和機密（Variables and Secrets）**，逐個新增：

1. **新增變數**（類型選「文字」）：
   - 名稱 `RETENTION_DAYS`，值 `30`（想保留 90 天就填 `90`）
   - 名稱 `ENABLE_AUTH`，值 `false`（**安全考量強烈建議填 `true` 開啟登入**：管理頁承載簡訊驗證碼等敏感內容，免登入等於對任何知道網域的人開放。若用 Workers Builds 連倉庫自動部署，此值以倉庫內 `wrangler.toml` 為準——現已預設 `true`）
   - 名稱 `SITE_NAME`（選配），值自訂網站名稱，如 `我的簡訊站`
   - 名稱 `SITE_ICON`（選配），值圖示 URL（`http(s)://` 開頭）；不填或 URL 失效自動用內建圖示
   - 名稱 `NOTIFY_LINK`（選配），值管理頁首頁網址（`http(s)://` 開頭）；設定後所有通知渠道附上「開啟管理頁」入口
2. **新增機密**（類型選「機密/Secret」）：
   - 名稱 `RECEIVE_TOKEN`，值自行編一個足夠長的隨機字串（不要使用任何教學範例值，越長越好）
   - 名稱 `ADMIN_PASSWORD`，值自行編一個管理頁登入密碼（僅當 `ENABLE_AUTH="true"` 時才需要）
   - 名稱 `SESSION_SECRET`，值一組高熵隨機字串（≥32 位隨機值，與密碼獨立；僅當 `ENABLE_AUTH="true"` 時才需要）
3. 每次新增後點 **部署/儲存**

> 改這些值隨時生效，不用重新貼上程式碼。修改 `RECEIVE_TOKEN` 後記得同步更新手機端 URL 裡的 `token=`。

## 第五步（選配）：設定通知轉發渠道

新訊息寫入資料庫後可自動轉發到外部渠道，**設定哪個渠道的變數就轉發哪個，全部未設定則不轉發**。
在同一個「變數和機密」頁面新增對應變數即可：

| 渠道 | 變數 | 說明 |
|---|---|---|
| 飛書群機器人 | `FEISHU_WEBHOOK`（選配 `FEISHU_SECRET`） | 群機器人 Webhook 地址；安全設定選「簽章驗證」時另配 `FEISHU_SECRET` |
| 企業微信群機器人 | `WECOM_WEBHOOK` | 群機器人 Webhook 地址 |
| 釘釘群機器人 | `DINGTALK_WEBHOOK`（選配 `DINGTALK_SECRET`） | 加簽安全設定時需配 `DINGTALK_SECRET` |
| Server醬 | `SERVERCHAN_SENDKEY` | SendKey（微信推播） |
| PushPlus | `PUSHPLUS_TOKEN` | 權杖（微信推播） |
| Telegram Bot | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Bot 權杖 + 工作階段/群組 ID |
| Bark | `BARK_DEVICE_KEY`（選配 `BARK_URL`） | 自建伺服器時配 `BARK_URL`，預設官方 |
| ntfy | `NTFY_URL`（選配 `NTFY_TOKEN`） | 完整主題 URL，如 `https://ntfy.sh/my-sms`；受保護主題另配 `NTFY_TOKEN`（Token 或 user:password） |
| Gotify | `GOTIFY_URL` + `GOTIFY_TOKEN` | 伺服器地址（不含 `/message`）+ 應用程式權杖 |
| 郵件（Resend） | `RESEND_API_KEY` + `MAIL_TO`（選配 `MAIL_FROM`） | `MAIL_FROM` 預設 `onboarding@resend.dev` |
| 通用 Webhook | `GENERIC_WEBHOOKS`（選配 `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`） | 逗號分隔多個 URL；範本自訂請求主體、請求標頭 JSON，第三方 API（簡訊閘道等）由此接入 |

各渠道的申請與取得步驟、請求主體格式，見 [多平台串接部署指南 · 通知轉發渠道](../../../docs/多平台接入部署指南.md)。
多渠道並行轉發、單一渠道失敗不影響其他渠道與訊息寫入資料庫；重複訊息（`duplicated`）不會重複轉發。
通知依內容自動分三態渲染（🔐 驗證碼提醒 / 💬 新簡訊 / 🔔 裝置通知）：驗證碼自動進標題並觸發各平台增強能力（Bark 通知一點即複製、Bark/ntfy 提升優先順序、飛書 violet 卡片標頭等）。

## 第六步：設定定時清理任務

1. Worker → **設定 → 觸發器（Triggers）→ Cron 觸發器**
2. 點 **新增 Cron 觸發器**，填 `0 17 * * *`，儲存
3. 含義：每天 UTC 17:00（北京時間凌晨 1 點）自動刪除超過保留天數的資料

## 第七步：綁定網域（選配，推薦）

1. Worker → **設定 → 網域和路由**
2. 點 **新增 → 自訂網域**，填一個子網域（如 `sms.你的域名.com`）
3. Cloudflare 自動建立 DNS 記錄並簽發 HTTPS 憑證，幾分鐘內生效
4. 之後瀏覽器直接開啟 `https://sms.你的域名.com` 即為管理頁

> 沒有網域也可用預設的 `https://sms-gateway.<你的子網域>.workers.dev` 地址。

## 第八步：驗證部署

瀏覽器開啟管理頁應看到你的網站名稱頁面（預設「簡訊閘道」，可用 `SITE_NAME` 修改；若開了登入則先見登入頁）。再驗證接收端點（把 `<網域>` 和 `<金鑰>` 換成你的）：

```
curl "https://<域名>/api/receive?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"name\":\"test\",\"sim\":\"13800138000\",\"from\":\"10086\",\"content\":\"部署測試\"}"
```

回傳 `{"success":true,...}` 即通。這則測試簡訊可在網頁上刪除。

## 接入手機端與各裝置

按 [多平台串接部署指南](../../../docs/多平台接入部署指南.md) 設定安卓 SmsForwarder 與各裝置通知推送，把端點網域換成你的 Worker 地址即可。

## 命令列部署（備選，會安裝 wrangler 的人適用）

在本目錄（含 `wrangler.toml`，`main` 已指向本目錄 `worker.js`）執行：

```bash
npm install wrangler        # 官方推薦專案內安裝；全域 npm install -g wrangler 亦可
npx wrangler login
npx wrangler d1 execute sms-gateway-db --file=schema.sql --remote
npx wrangler secret put RECEIVE_TOKEN
npx wrangler secret put ADMIN_PASSWORD   # 僅開登入時需要
npx wrangler secret put SESSION_SECRET   # 僅開登入時需要（高熵隨機值，與密碼獨立）
npx wrangler deploy
```

## 注意事項與常見問題

- **收不到轉發簡訊**：依序排查 ① SmsForwarder 通用設定「轉發簡訊廣播」總開關（最容易漏，關了會靜默丟棄且通道測試全綠）→ ② 轉發規則的 token/URL 是否與 Worker 金鑰一致 → ③ Worker 即時日誌看請求是否到達
- **通知渠道沒收到**：確認對應渠道變數已設定且值正確；看 Worker 即時日誌有無 `notify forward failed:`；`duplicated:true` 的訊息不會轉發
- **Worker 免費額度**：每天 10 萬次請求，個人使用綽綽有餘；D1 免費額度每天 500 萬列讀取
- **長輪詢**：管理頁 `/api/wait` 掛起最長 25 秒等待新訊息，Workers 無請求時長問題，即時性最好
- **資料遷移**：從其他平台遷回 CF 時，匯出 Turso 資料再匯入 D1 即可（資料表結構完全一致）
