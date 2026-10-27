# SMSToWeb 多平台串接部署指南

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | **繁體中文** | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 自英語主版同步（繁體中文版）

本系統由兩部分組成：**接收端**（各平台的推送用戶端）+ **雲端閘道**（六個平台任選其一：Cloudflare / Vercel / Deno / Netlify / EdgeOne Makers / Docker 自架，見 [PLATFORMS.md](./PLATFORMS.md)，串接方式完全相同）。
簡訊只是串接路徑之一——任何能發 HTTP 請求的裝置/指令碼，都能把通知推到同一個網頁裡查看。

```
安卓(SmsForwarder)──┐  簡訊+App 通知
iOS(捷徑)───────┤
Linux(curl/ntfy)────┼──→ POST /api/receive（簡訊）或 /api/push（通用通知）
Windows(PowerShell)─┤         │
macOS(捷徑)─────┘         ▼
                        Cloudflare Worker ──→ D1 儲存 ──→ 統一網頁（來源篩選）
                              │
                              └──（選配）多渠道通知 → 飛書/企微/釘釘/TG/Bark/郵件…
```

---

## 一、雲端設定（Cloudflare 側）

### 1. 變數與金鑰

部署 Worker 後，在 **Workers 和 Pages → sms-gateway → 設定 → 變數和機密** 中設定：

| 名稱 | 類型 | 必填 | 說明 |
|---|---|---|---|
| `RECEIVE_TOKEN` | 機密 | 是 | 推送驗證權杖，自行編一串隨機字元（不要用範例值） |
| `ADMIN_PASSWORD` | 機密 | 開登入時設定 | 管理頁登入密碼，建議強密碼；漏設定時管理端點一律拒絕存取（設定缺失不放行），並輸出警示 |
| `ENABLE_AUTH` | 文字 | 否 | `"true"` 開啟登入（**安全考量強烈建議**：管理頁承載簡訊驗證碼等敏感內容，預設免登入等於對任何知道網域的人開放）；`"false"` 或不設為免登入 |
| `FEISHU_WEBHOOK` | 文字 | 否 | 飛書群機器人 Webhook，設定後新訊息自動轉發飛書群（簽章驗證另配 `FEISHU_SECRET`） |
| `FEISHU_SECRET` | 機密 | 否 | 僅當飛書機器人安全設定選「簽章驗證」時設定，程式自動計算簽章 |
| `WECOM_WEBHOOK` | 文字 | 否 | 企業微信群機器人 Webhook |
| `DINGTALK_WEBHOOK` | 文字 | 否 | 釘釘群機器人 Webhook（加簽安全設定需另配 `DINGTALK_SECRET`） |
| `SERVERCHAN_SENDKEY` | 文字 | 否 | Server醬 SendKey（微信推播） |
| `PUSHPLUS_TOKEN` | 文字 | 否 | PushPlus 權杖（微信推播） |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | 文字 | 否 | Telegram Bot 權杖 + 工作階段/群組 ID |
| `BARK_DEVICE_KEY` | 文字 | 否 | Bark 裝置 Key（自建伺服器另配 `BARK_URL`，預設官方） |
| `NTFY_URL` | 文字 | 否 | ntfy 完整主題 URL，如 `https://ntfy.sh/my-sms`（受保護主題另配 `NTFY_TOKEN`） |
| `NTFY_TOKEN` | 文字 | 否 | ntfy 受保護主題存取權杖：Access Token 直接填（走 Bearer）；自建伺服器按 `user:password` 填（走 Basic） |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | 文字 | 否 | Gotify 伺服器地址（不含 `/message`）+ 應用程式權杖 |
| `RESEND_API_KEY` + `MAIL_TO` | 文字 | 否 | 郵件（Resend API）；選配 `MAIL_FROM`，預設 `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS` | 文字 | 否 | 通用 Webhook，逗號分隔多個 URL；選配 `GENERIC_WEBHOOK_TEMPLATE` 自訂請求主體、`GENERIC_WEBHOOK_HEADERS` 自訂請求標頭 |
| `GENERIC_WEBHOOK_HEADERS` | 文字 | 否 | 通用 Webhook 自訂請求標頭，JSON 物件字串，如 `{"Authorization":"Bearer xxx"}` |
| `NOTIFY_LINK` | 文字 | 否 | 管理頁首頁網址；設定後所有通知渠道附上「開啟管理頁」入口（飛書按鈕、各渠道連結行、Bark url、ntfy click 等），未設定自動省略 |
| `SESSION_SECRET` | Secret | 開啟登入時必須 | 登入工作階段簽章金鑰：**高熵隨機值（建議 ≥32 位隨機字串），與管理密碼完全獨立**；CF 與 EO（及各平台）分別設定獨立值，嚴禁提交 Git 或重複使用密碼。缺失時登入與驗證安全失敗（登入 500、管理端點 401），不回退為密碼衍生。輪替後所有舊工作階段立即失效需重新登入；工作階段有效期 30 分鐘，登出僅清瀏覽器 Cookie，已複製 Token 在 TTL 內仍可能有效 |
| `RETENTION_DAYS` | 文字 | 否 | 資料保留天數，預設 30，改完即時生效 |
| `WAIT_MAX_SECONDS` | 文字 | 否 | 長輪詢 `/api/wait` 最長掛起秒數，預設 25（3–25）。**Netlify Functions 預設 10s 上限 → 建議填 `8`**；Vercel Edge 建議 `20`。前端遇失敗會指數退避，不會灌爆函式 |

> **兩條安全提示**
> 1. 管理頁登入（`ENABLE_AUTH="true"`）強烈建議開啟，並配強密碼 `ADMIN_PASSWORD`；登入端點已內建速率限制（同 IP 連續失敗 5 次鎖定 10 分鐘），`/api/receive`、`/api/push` 每分鐘寫入超過 120 次會回傳 429（稍後自動恢復）。
> 2. 推送 token 相容 `?token=` URL 傳參（SmsForwarder 場景），token 會出現在 URL 中、可能進平台存取日誌；介意者改用 POST + `Authorization: Bearer <RECEIVE_TOKEN>` 請求標頭傳遞，兩種方式都支援。

### 2. 通知轉發渠道（選配，設定哪個轉發哪個）

在部署平台的「環境變數 / Variables」頁面新增對應變數即可啟用，**全部未設定則不轉發，不影響訊息寫入資料庫與網頁查看**。
多渠道並行轉發，單一渠道失敗不影響其他渠道；重複訊息（`duplicated:true`）不會重複轉發。

通知依內容自動分**三態**渲染（全渠道一致）：偵測到驗證碼 → **驗證碼提醒**（驗證碼進標題/卡片大字；Bark 通知一點即複製驗證碼，Bark 與 ntfy 提升優先順序）；無驗證碼簡訊 → **新簡訊**；App/裝置推送 → **裝置通知**。設定選配變數 `NOTIFY_LINK` 後各渠道自動附上「開啟管理頁」入口，未設定自動省略。

通用 Webhook 預設請求主體為 JSON，新增 `type`（`verify`/`sms`/`notify`）與 `code`（辨識出的驗證碼，未偵測出為空字串）欄位；`GENERIC_WEBHOOK_TEMPLATE` 範本預留位置隨之支援 `{{type}}`/`{{code}}`。

各渠道申請步驟：

**飛書群機器人** — `FEISHU_WEBHOOK`（選配 `FEISHU_SECRET`）
1. 飛書目標群 → 設定 → 群機器人 → 新增機器人 → **自訂機器人**
2. 取得 Webhook 地址，形如 `https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx`，填入變數即可
3. 安全設定三選一：**自訂關鍵字**（推薦：關鍵字填 `簡訊` 等即可，無需其他設定）；**簽章驗證**（把金鑰填入 `FEISHU_SECRET`，程式自動計算簽章）；IP 白名單（Worker 出口 IP 不固定，勿選）

**企業微信群機器人** — `WECOM_WEBHOOK`
1. 企微目標群 → 右上角群設定 → 群機器人 → 新增機器人 → 新建
2. 複製 Webhook 地址，形如 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx`，填入變數即可

**釘釘群機器人** — `DINGTALK_WEBHOOK`（選配 `DINGTALK_SECRET`）
1. 釘釘目標群 → 群設定 → 智慧群助手 → 新增機器人 → **自訂**（Webhook 接入）
2. 安全設定建議選 **加簽**：把頁面顯示的金鑰（SEC 開頭）填入 `DINGTALK_SECRET`；不配則按無簽直連
3. 複製 Webhook 地址（形如 `https://oapi.dingtalk.com/robot/send?access_token=xxxx`）填入 `DINGTALK_WEBHOOK`

**Server醬（微信推播）** — `SERVERCHAN_SENDKEY`
1. 開啟 [sct.ftqq.com](https://sct.ftqq.com)，微信掃碼登入
2. 首頁複製 **SendKey**（形如 `SCTxxxxxxxxxxxx`），填入變數；訊息推播到你的微信「方糖」服務號

**PushPlus（微信推播）** — `PUSHPLUS_TOKEN`
1. 開啟 [pushplus.plus](https://www.pushplus.plus)，微信掃碼登入
2. 首頁複製 **token**，填入變數；關注公眾號後即可在微信收到推播

**Telegram Bot** — `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`（兩個都設定才生效）
1. TG 裡找 [@BotFather](https://t.me/BotFather) → `/newbot` 依指示建立 → 得到 Bot Token（形如 `123456:ABC-xxx`）
2. 取 `chat_id`：先給你的 Bot 傳一則訊息，再於瀏覽器開啟 `https://api.telegram.org/bot<你的Token>/getUpdates`，在回傳 JSON 裡找 `chat.id`（群聊把 Bot 拉進群並傳一則訊息後同樣可查到群 ID）
3. 兩個值分別填入 `TELEGRAM_BOT_TOKEN` 與 `TELEGRAM_CHAT_ID`

**Bark（iOS 推播）** — `BARK_DEVICE_KEY`（選配 `BARK_URL`）
1. App Store 安裝 [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865)，開啟 App 複製範例 URL 中的 Key 部分（`https://api.day.app/<這串就是Key>/...`）
2. Key 填入 `BARK_DEVICE_KEY`；自建伺服器再配 `BARK_URL`（預設官方 `https://api.day.app`）

**ntfy（Android/iOS/網頁訂閱）** — `NTFY_URL`（選配 `NTFY_TOKEN`）
1. 手機裝 ntfy App（或用 [ntfy.sh](https://ntfy.sh) 網頁），訂閱一個自訂主題名（topic），如 `my-sms-9f2k`（名字越隨機越私密）
2. `NTFY_URL` 填完整主題 URL：`https://ntfy.sh/my-sms-9f2k`（自建伺服器填你的地址；支援反向代理子路徑部署）
3. 主題開啟存取控制時配 `NTFY_TOKEN`：Access Token（`tk_` 開頭）直接填入；自建伺服器按 `使用者名稱:密碼` 格式填入

**Gotify（自建推播服務）** — `GOTIFY_URL` + `GOTIFY_TOKEN`
1. 已自建 Gotify 的，網頁登入 → **Apps** → 建立應用程式 → 複製 **Token**
2. `GOTIFY_URL` 填伺服器地址（如 `https://push.example.com`，**不要帶** `/message`），Token 填 `GOTIFY_TOKEN`

**郵件（Resend API）** — `RESEND_API_KEY` + `MAIL_TO`（選配 `MAIL_FROM`）
1. 開啟 [resend.com](https://resend.com) 註冊（免費額度每天 100 封、每月 3000 封）
2. **API Keys** → Create API Key，複製填入 `RESEND_API_KEY`
3. `MAIL_TO` 填收件信箱（多個用逗號分隔）；`MAIL_FROM` 不填時預設 `onboarding@resend.dev`（該預設寄件人只能寄給你註冊 Resend 的信箱；要寄給任意信箱需在 Resend 驗證自己的網域並配 `MAIL_FROM`）

**通用 Webhook / 第三方 API** — `GENERIC_WEBHOOKS`（選配 `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`）
1. `GENERIC_WEBHOOKS` 填一個或多個 URL（**逗號分隔**）。預設 POST JSON：

```json
{"title":"【短信】13800138000 ← 10086","content":"正文…","time":"2026-10-14 12:30:00（北京時間）","source":"sms","sender":"1069012345678","device":"我的手機"}
```

2. 對端需要特定格式時配 `GENERIC_WEBHOOK_TEMPLATE`，用預留位置 `{{title}}` / `{{content}}` / `{{time}}` / `{{source}}` / `{{sender}}` / `{{device}}` 自訂請求主體；範本能被解析為 JSON 就按 JSON 傳送，否則按純文字傳送。範例：

```
{"phone":"13800138000","msg":"{{content}}","at":"{{time}}"}
```

3. 對端需要驗證請求標頭（金鑰不放 URL）時配 `GENERIC_WEBHOOK_HEADERS`，值為 JSON 物件字串，如：

```json
{"Authorization":"Bearer sk-xxx","X-Api-Key":"yyy"}
```

該值不是合法 JSON 時會被忽略，不影響預設轉發。簡訊閘道、Home Assistant、n8n、自建指令碼等任何第三方 API 都可用該範本接入。各渠道的變數名與設定位置見上文「變數與金鑰」表；Cloudflare 在 Worker 的「變數和機密」頁設定，其餘平台在各平台教學對應的環境變數處設定。

### 3. 資料庫

D1 的 `messages` 資料表需要包含 `source`（區分簡訊/通知）與 `deleted_at`（軟刪除/復原）欄位。全新部署直接執行 [schema.sql](../../../schema.sql)；舊資料庫升級執行：

```sql
ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'sms';
ALTER TABLE messages ADD COLUMN deleted_at TEXT;
ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN read_at TEXT;
```

---

## 二、推送端點規格

兩個公開端點共用 `RECEIVE_TOKEN` 驗證（token 放 query 或 body 均可）：

### 1. 簡訊接收 `POST /api/receive`（Android App 專用）

```
POST https://<你的域名>/api/receive?token=<RECEIVE_TOKEN>
Content-Type: application/json

{
  "name": "我的手機",
  "sim": "13800138000",
  "from": "10086",
  "content": "您的驗證碼是 734752，5 分鐘內有效",
  "time": "2026-10-14 12:30:00"
}
```

### 2. 通用推播 `POST /api/push`（各平台通知）

```
POST https://<你的域名>/api/push?token=<RECEIVE_TOKEN>
Content-Type: application/json

{
  "source": "notify",
  "sender": "db-backup",
  "name": "資料庫備份",
  "content": "每日備份完成，耗時 3 分 12 秒",
  "time": "2026-10-14 03:00:00"
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `token` | 是 | 驗證權杖 |
| `content` | 是 | 訊息內文（`text`/`message`/`msg` 亦可） |
| `source` | 否 | 來源標識，預設 `notify`；網頁「來源篩選」用，可自訂（如 `cron`、`alert`） |
| `sender` | 否 | 來源標題（主機名/App 名/指令碼名） |
| `name` | 否 | 裝置標籤名（自訂命名），預設「通知閘道」，與簡訊標籤並列顯示 |
| `time` | 否 | 事件時間，預設取伺服器目前時間；支援時間戳記或 `YYYY-MM-DD HH:MM:SS` 文字 |

回應：`{"success":true,"device_id":17,"duplicated":false}`（`duplicated=true` 表示重複訊息已忽略，不會重複轉發到通知渠道）

---

## 三、各平台串接方法

### 安卓（簡訊 + App 通知）—— SmsForwarder

1. 安裝開源 App「簡訊轉發器」([pppscn/SmsForwarder](https://github.com/pppscn/SmsForwarder))
2. 通用設定裡**開啟「轉發簡訊廣播」總開關**
3. 新增「Webhook 通道」：URL 填 `/api/receive?token=<RECEIVE_TOKEN>`，訊息範本：

```json
{"name":"我的手機","sim":"13800138000","from":"{{FROM}}","content":"{{SMS}}","time":"{{DATE}}"}
```

> 要點：`name` 填自訂裝置名（網頁標籤顯示它，改名會產生新標籤）；`sim` 直接填手機號碼（卡片右下角顯示，點兩下複製）；`content` 必須用 `{{SMS}}` 變數。
> App 通知轉發：再加一條「App 通知」轉發規則，範本裡 `sender` 用 `{{APP_NAME}}`、`content` 用 `{{MSG}}`，改推 `/api/push`。

### iOS —— 捷徑（Shortcuts）

1. 捷徑 → 自動化 → 新增「個人自動化」→ 選「收到簡訊/訊息」
2. 新增動作 →「取得 URL 內容」：
   - URL：`https://<你的域名>/api/push`
   - 方法：POST，請求主體 JSON：

```json
{"token":"<RECEIVE_TOKEN>","source":"sms","sender":"iPhone","name":"通知閘道","content":"[訊息正文變數]"}
```

3. 關閉「執行前詢問」即可全自動。定時類通知（電量、專注模式）同理，選對應觸發器。

### Linux —— curl / 指令碼 / systemd

最簡單的一行：

```bash
curl -s -X POST https://<你的域名>/api/push \
  -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"web-01","content":"Nginx 已重啟"}'
```

定時/事件通知範例（`/usr/local/bin/notify.sh`）：

```bash
#!/bin/bash
curl -s -X POST https://<你的域名>/api/push \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"<RECEIVE_TOKEN>\",\"sender\":\"$HOSTNAME\",\"content\":\"$1\"}"
```

配合 systemd timer 或 cron 呼叫：`notify.sh "每日備份完成"`。
進階選配：自架 [ntfy](https://ntfy.sh)（單一二進位檔/Docker），讓多台機器訂閱同一事件流，再由一個小橋接指令碼把 ntfy 訊息轉發到本閘道。

### Windows —— PowerShell / 工作排程

`C:\Tools\notify.ps1`：

```powershell
param([string]$Message = "test")
Invoke-RestMethod -Uri "https://<你的域名>/api/push" -Method Post -ContentType "application/json" -Body (@{token="<RECEIVE_TOKEN>";sender=$env:COMPUTERNAME;content=$Message} | ConvertTo-Json)
```

呼叫：`powershell -File C:\Tools\notify.ps1 -Message "磁碟清理完成"`；可在工作排程器中掛到關機前、備份後等事件。

### macOS —— 捷徑 / launchd

- 捷徑：與 iOS 相同（自動化觸發器換成「特定時間」「檔案變更」等）
- 定時指令碼 + launchd（`~/Library/LaunchAgents/local.notify.plist`）：

```bash
curl -s -X POST https://<你的域名>/api/push \
  -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"mac-mini","content":"Time Machine 備份完成"}'
```

- 要在 Mac 接收 iPhone 簡訊的使用者：用 AppleScript 輪詢 Messages.app SQLite 資料庫的增量並推送（進階玩法）

### 伺服器/容器通用 —— Apprise（選配聚合層）

[Apprise](https://github.com/caronc/apprise) 支援 100+ 通知目標，可把本閘道當作其中一個自訂 webhook 使用，統一管理多目標推送。

---

## 四、驗證清單

| 驗證項 | 方法 |
|---|---|
| 端點驗證 | 無 token 請求應回傳 403 unauthorized |
| 通用推播 | 用上面任一範例發一則，網頁「通知」來源下可見，已設定的通知渠道同步收到 |
| 簡訊鏈路 | 手機發一則真實簡訊 → 網頁「簡訊」來源可見 + 驗證碼辨識 + 通知渠道轉發 |
| 來源篩選 | 管理頁工具列「來源篩選」下拉切換：全部 / 簡訊 / 通知及自訂來源 |
| 九語言切換 | 管理頁與登入頁內建九語言（簡體中文 / 繁體中文 / English / 日本語 / 한국어 / Español / Français / Deutsch / Português (BR)），右上「🌐」選單選擇後整頁切換，選擇記在瀏覽器本機；也可直接開啟 `https://你的域名/?lang=ja` 等網址直連。舊連結 `?lang=zh` / `?lang=en` 仍然相容（自動歸一化為 zh-CN / en） |
| 匯出與篩選 | 點「匯出 CSV / JSON」下載目前篩選結果；切換「近 7 天」「每頁 50」後列表與匯出隨之變化 |
| 重複攔截 | 相同內容秒級重發，回應 `duplicated:true`，通知渠道不重複推送 |

## 五、常見問題

- **推了訊息網頁沒重新整理？** 管理頁走長輪詢自動重新整理（預設最長 25 秒掛起，可用 `WAIT_MAX_SECONDS` 調整）；切回頁面時會立即補拉一次；也可手動切一下來源篩選觸發載入。
- **手機瀏覽器上介面擠 / 登入框被放大？** 已針對行動裝置調整（安全區、16px 輸入框防 iOS 自動放大、加大觸控目標）；若仍異常，清一下該網站快取後重試。
- **Netlify 上長輪詢總是報錯？** 把 `WAIT_MAX_SECONDS` 設為 `8`（低於 Functions 的 10s 上限）。
- **通知渠道沒收到？** 檢查對應渠道變數是否已設定且值正確（兩變數成對的如 Telegram/Gotify 需全部設定）；看部署平台日誌有無 `notify forward failed:`；`duplicated:true` 的訊息不會轉發。
- **想換標籤名？** 點裝置標籤後的「✎」重新命名（設為別名），或點「⇄」把該標籤的訊息合併到另一台裝置；無訊息的標籤可直接「×」刪除。
- **訊息能保留多久？** 由 `RETENTION_DAYS` 控制，預設 30 天，每天 UTC 17:00（北京時間凌晨 1 點）自動清理。
