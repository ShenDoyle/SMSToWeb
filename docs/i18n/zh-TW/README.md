# SMSToWeb — 簡訊/通知雲端閘道

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | **繁體中文** | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 本倉庫文件以英語為主要維護版本；本繁體中文版與其他語言譯文存放於 `docs/i18n/`，可能落後於英語主版。

把 Android 手機的簡訊和各類裝置的通知即時推播到雲端，隨時透過網頁查看。免費部署、無需伺服器、約 10 分鐘完成。

- **多平台部署**：Cloudflare（主版本）/ Vercel / Deno Deploy / Netlify / 騰訊 EdgeOne Makers / Docker 自架，六擇一，功能完全一致
- **即時接收**：Webhook 秒級寫入資料庫，網頁自動重新整理，無需手動操作
- **通用推播**：任何能發 HTTP 請求的裝置（Linux / Windows / macOS / iOS / NAS / 指令碼）都能把通知推進同一個頁面
- **來源與篩選**：依來源動態篩選（自動聚合簡訊 / 通知及自訂來源），疊加關鍵字搜尋與今天 / 近 7 天 / 近 30 天時間範圍，分頁筆數可調
- **多渠道通知**：新訊息可自動轉發到飛書 / 企微 / 釘釘 / Telegram / Server醬 / PushPlus / Bark / ntfy / Gotify / 郵件 / 自訂 Webhook，設定哪個轉發哪個（選配）
- **安全選配**：管理頁登入開關、多格式驗證碼辨識（碼前/碼後/分隔式/混合碼，防誤報）與一鍵複製、深色模式
- **資料與提醒**：依目前篩選一鍵匯出 CSV / JSON；頁面可見時新訊息有 toast / 選配提示音 / 懸浮提醒，在背景時以瀏覽器通知 + 標題未讀提示；超長訊息自動摺疊
- **號碼辨識**：內建常見機構號碼庫（電信業者 / 銀行 / 快遞 / 政府等）自動標註；未知手機號碼可選顯示歸屬地（預設開啟，可關閉）
- **九種語言**：管理頁與登入頁內建簡體中文 / 繁體中文 / English / 日本語 / 한국어 / Español / Français / Deutsch / Português (BR)，頂部 🌐 選單一鍵切換（`?lang=` 可直連，選擇記在本機）；日期、相對時間、號碼機構名同步切換
- **行動裝置友善**：`viewport-fit` 安全校區對應劉海螢幕與手勢條、輸入框 16px 防 iOS 自動放大、觸控目標加大、底部抽屜式彈出層、PWA 可新增到主畫面
- **批次與復原**：批次選取刪除、依目前篩選一鍵清空；刪除後 5 秒內可復原（軟刪除）；深色模式支援自動 / 淺色 / 深色三態
- **收藏 / 未讀 / 統計**：星號置頂、只看收藏 / 未讀、統計面板（來源分布 + 近 7 天）；自訂號碼標籤；搜尋醒目提示與歷史；設定裡可配勿擾與提示音；可新增到主畫面（PWA）

```
【簡訊】Android(SmsForwarder) ──POST /api/receive──┐
                                                   ├─→ 雲端閘道（任選一平台）─→ 資料庫
【通知】各平台指令碼/捷徑 ──POST /api/push────────┘         │
                                                  瀏覽器 ◀── 網頁管理頁（閘道內嵌）
```

**一鍵部署（Cloudflare 主版本，約 2 分鐘）**：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

點按鈕自動完成建立資料庫與資料表、資源綁定與 CI 設定，依提示填 `RECEIVE_TOKEN`（推送驗證金鑰）即可上線；Vercel / Netlify 的一鍵部署按鈕見對應平台教學。

| 平台 | 部署方式 | 定時清理 | 詳細教學 |
|---|---|---|---|
| **Cloudflare**（推薦） | Worker + D1 | 平台 cron | [CLOUDFLARE.md](./CLOUDFLARE.md) |
| Vercel | Edge Function + Turso | 平台 cron | [VERCEL.md](./VERCEL.md) |
| Deno Deploy | Deno 原生 + Turso | Deno.cron | [DENO.md](./DENO.md) |
| Netlify | Functions v2 + Turso | Scheduled Function | [NETLIFY.md](./NETLIFY.md) |
| 騰訊 EdgeOne Makers | Functions + Turso | 外部 cron | [EDGEONE.md](./EDGEONE.md) |
| Fly.io / Railway / VPS | Docker（Node 22）+ Turso/本機 SQLite | 處理程序內建 | [NODE.md](./NODE.md) |

> 每個平台目錄**完全自包含**（程式碼 + schema + 獨立文件，零 npm 依賴、無需建置），點上表「詳細教學」即可按步驟部署。功能與資料表結構全平台一致，可隨時互相遷移。
> 平台比較與通用準備（Turso 資料庫）見 [PLATFORMS.md](./PLATFORMS.md)。

### 各平台執行階段差異（部署前先看一下）

業務程式碼六平台逐位元組一致，但**執行階段的逾時/背景工作/定時器**能力不同，必要時用環境變數調整：

| 平台 | 函式逾時 | 背景通知 | 定時清理 | 建議 |
|---|---|---|---|---|
| Cloudflare | 無固定實際時間上限（CPU 受限） | `ctx.waitUntil` 回應後繼續 | 平台 cron | 預設設定即可 |
| Vercel Edge | 單次請求約 25 秒上限 | 於回應前以行內方式完成 | 平台 cron | `WAIT_MAX_SECONDS=20` |
| Netlify Functions | 60s（各方案一致） | 於回應前以行內方式完成 | scheduled function | 入口預設 `WAIT_MAX_SECONDS=8` |
| Deno Deploy | 視方案 | 於回應前以行內方式完成 | 需外部觸發 | 外部 cron 呼叫 `/api/cron?token=` |
| EdgeOne Makers | 視方案 | 於回應前以行內方式完成 | 需外部觸發 | `WAIT_MAX_SECONDS` 依方案調低 |
| Node / Docker | 自訂 | 於回應前以行內方式完成 | 需外部觸發 | 本機 SQLite 需 Node ≥ 22.13 |

> - **長輪詢**：前端對失敗自動**指數退避**（2→30s），並在頁面重新可見時立即補拉，平台強制終止請求也不會灌爆函式。
> - **通知轉發**：Cloudflare 走 `waitUntil`；其餘平台為「回應前把通知發完」（單一渠道 10s 逾時），因此設定很多慢速渠道時會略為增加端點延遲。
> - **定時清理**：無平台 cron 的部署，用任意定時器請求 `GET /api/cron?token=<RECEIVE_TOKEN>` 即可。

---

## 手機端與多平台串接

所有平台把訊息推進同一個網頁：手機簡訊走 `/api/receive`（安卓 SmsForwarder），其餘一切通知走通用端點 `/api/push`。

分步設定（每平台附可直接複製的指令/指令碼）：**[多平台串接部署指南](../../../docs/多平台接入部署指南.md)**

**通用推播端點速覽**（詳細欄位見串接指南）：

```
POST https://<你的域名>/api/push?token=<RECEIVE_TOKEN>
{"source":"notify","sender":"demo","content":"hello from anywhere"}
```

回傳 `{"success":true,"device_id":17,"duplicated":false}` 即寫入資料庫；完全相同的重複推送回傳 `duplicated:true`。

## 環境變數（各平台通用）

| 變數 | 必填 | 說明 |
|---|---|---|
| `RECEIVE_TOKEN` | 是 | 推送驗證金鑰，自行編一個足夠長的隨機字串 |
| `ENABLE_AUTH` | 否 | `"true"` 管理頁需登入（**安全考量強烈建議開啟**，見下方安全建議）；預設免登入 |
| `ADMIN_PASSWORD` | 否 | 登入密碼（`ENABLE_AUTH="true"` 時設定；漏設定時管理端點一律拒絕存取並輸出警示——設定缺失不放行） |
| `RETENTION_DAYS` | 否 | 資料保留天數，預設 30 |
| `WAIT_MAX_SECONDS` | 否 | 長輪詢 `/api/wait` 最長掛起秒數，預設 25（範圍 3–25）。部署在 **Netlify Functions**（預設 10s 上限）或其他短逾時平台時設成 `8`，避免請求被平台強制終止 |
| `PHONE_AREA_ENABLED` / `PHONE_AREA_API` | 否 | 號碼歸屬地：預設開啟（360 免費 API、無需 key、後端快取 24 小時，僅查 11 位手機號碼）；設 `false` 關閉；自訂來源用 `PHONE_AREA_API`（URL 含 `{number}` 預留位置） |
| 通知渠道變數 | 否 | `FEISHU_WEBHOOK`（飛書）/ `WECOM_WEBHOOK`（企微）/ `DINGTALK_WEBHOOK`（釘釘，選配 `DINGTALK_SECRET` 加簽）/ `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY`（選配 `BARK_URL`）/ `NTFY_URL`（選配 `NTFY_TOKEN`）/ `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO`（郵件，選配 `MAIL_FROM`）/ `GENERIC_WEBHOOKS`（通用 Webhook，選配 `GENERIC_WEBHOOK_TEMPLATE` 請求主體 / `GENERIC_WEBHOOK_HEADERS` 請求標頭）。設定哪個轉發哪個，全部未設定則不轉發；通知依內容自動三態渲染（🔐 驗證碼 / 💬 簡訊 / 🔔 通知） |
| `SITE_NAME` / `SITE_ICON` | 否 | 網站名稱 / 圖示 URL，未設定則用預設值 |
| `NOTIFY_LINK` | 否 | 管理頁首頁網址；設定後所有通知渠道附上「開啟管理頁」入口（按鈕/連結/click），未設定自動省略 |
| `SESSION_SECRET` | 開啟登入時必須 | 登入工作階段簽章金鑰：**高熵隨機值（建議 ≥32 位隨機字串），與管理密碼完全獨立**，Cloudflare 與 EdgeOne（及各平台）須分別設定獨立值；嚴禁提交到 Git 或重複使用密碼。缺失時登入與驗證**安全失敗（fail-closed）**：登入回傳 500、管理端點一律 401，不回退為密碼衍生。輪替（更換值）後所有舊工作階段立即失效，需重新登入。工作階段有效期 30 分鐘；登出僅清除瀏覽器 Cookie，已複製的工作階段 Token 在 TTL 內（最長 30 分鐘）仍可能有效 |

Cloudflare 平台額外需要 `DB`（D1 綁定）；其餘平台需要 `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`（Turso 資料庫，見各平台教學）；Node 自架另支援 `SQLITE_PATH` 本機 SQLite 模式（見 [NODE.md](./NODE.md)）。

> **安全強烈建議**
> 1. **開啟管理頁登入**（`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`）：管理頁承載簡訊驗證碼等敏感內容，預設免登入意味著知道網域的人都能查看全部訊息並刪除資料。登入端點已內建速率限制（同 IP 連續失敗 5 次鎖定 10 分鐘）；`/api/receive`、`/api/push` 另有每 IP 每分鐘 120 次的寫入速率限制（超限回傳 429）。
> 2. **推送 token 走 URL query 的取捨**：為相容 SmsForwarder 等用戶端，`/api/receive`、`/api/push` 支援 `?token=` 查詢參數傳驗證——token 會出現在 URL 中，可能進入平台存取日誌、瀏覽器歷史。若在意的話請改用 POST + 請求標頭 `Authorization: Bearer <RECEIVE_TOKEN>` 傳遞（兩種方式都支援）。

## 常見問題（通用）

- **標籤顯示 `{{XXX}}` 字面值** → 不會發生：閘道偵測到 `{{` 字面值會自動置空，標籤回退顯示 `sim`；標籤名請在範本 `name` 欄位直接填自訂名稱
- **端點回應 401/403** → 檢查 URL 裡 `token=` 與 `RECEIVE_TOKEN` 是否一致；`/api/receive`、`/api/push` 不受登入開關影響
- **端點回應 429** → 觸發寫入速率限制（每 IP 每分鐘 120 次），等 1 分鐘自動恢復；正常使用不會碰到，若出現代表 token 可能已洩漏或有程式在灌寫資料庫
- **超長訊息** → 單則內文最多儲存 8000 字元，超出部分自動截斷
- **裝置標籤改名** → 標籤名由訊息範本 `name` 欄位決定，改 `name` 會產生新標籤；在網頁上點標籤後的「✎」可重新命名、「⇄」可把該標籤的訊息合併到另一裝置，無訊息的標籤可直接「×」刪除
- **從舊版升級（新增欄位）** → 舊資料庫需執行：`ALTER TABLE messages ADD COLUMN deleted_at TEXT;`、`ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;`、`ALTER TABLE messages ADD COLUMN read_at TEXT;`（新資料庫建表時已包含；node 本機 SQLite 啟動時自動補欄位）

## 開發說明

- `src/worker.js`：核心原始碼（Cloudflare Worker 形態）
- `platforms/gen_app.py`：從 `src/worker.js` 產生平台無關的 `app.js` 同步到五個移植平台，並同步 Cloudflare 獨立副本 `worker.js`（確保六平台業務程式碼逐位元組一致）；同時把 31 項環境變數白名單（ENV_KEYS，含驗證項）同步到六個平台入口，防止各平台透傳漂移（node 的 db.js 為 Turso+本機 SQLite 雙介接，獨立維護不參與同步）
- `platforms/*/`：各平台自包含部署目錄（入口 + app.js + db.js 介接層 + schema.sql + 本平台教學）
- `docs/i18n/en/`：英語文件集（部署/API/架構/資料庫）；其他語言見 `docs/i18n/<lang>/`，導覽見 [docs/i18n/README.md](../README.md)
- `tests/run.mjs`：零依賴測試套件（需 Node 22.13+，204 項測試）：`node tests/run.mjs`
- 修改核心程式碼後：`python platforms/gen_app.py` 重新同步全部平台，再執行 `node tests/run.mjs`；CI 會校驗同步零漂移 + 語法 + 測試

## License

[MIT](../../../LICENSE) © 2026 [左立方](https://cbm.im/)