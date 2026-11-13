# SMSToWeb — SMS & Notification Cloud Gateway

**English** | [简体中文](docs/i18n/zh-CN/README.md) | [繁體中文](docs/i18n/zh-TW/README.md) | [日本語](docs/i18n/ja/README.md) | [한국어](docs/i18n/ko/README.md) | [Español](docs/i18n/es/README.md) | [Français](docs/i18n/fr/README.md) | [Deutsch](docs/i18n/de/README.md) | [Português (BR)](docs/i18n/pt-BR/README.md)

**New here?** → [Quick start](docs/i18n/en/QUICKSTART.md) · [Chinese user guide](docs/guide/README.md) · [FAQ (Chinese)](docs/guide/05-常见问题.md).

SMSToWeb collects messages from any channel — SMS forwarders, app notifications, scripts, webhooks and custom integrations — through one shared HTTP API and message format, and shows them on a single web page for reading, searching and forwarding.

- **Multi-platform support**: Cloudflare Workers / Vercel / Deno Deploy / Netlify / Tencent EdgeOne Makers / Docker self-hosted — choose whichever platform fits your setup.
- **Real-time receiving**: webhook push lands in the database in seconds; the web page refreshes itself, no manual work
- **Universal push**: any device that can send an HTTP request (Linux / Windows / macOS / iOS / NAS / scripts) can push notifications into the same page
- **Sources & filters**: filter dynamically by source (SMS / notifications and custom sources auto-aggregated), stacked with keyword search and Today / Last 7 days / Last 30 days ranges; adjustable page size
- **Message list**: **10 messages per page by default**; each card shows a **two-line summary (up to 120 codepoints, Unicode-safe)** and opens the full text in a detail dialog; a **Load more** button appends older messages progressively (cursor pagination, no full-history fetch); opening a message marks it read (failure rolls back and reports instead of faking success)
- **Verification code**: codes are detected server-side (Chinese / English / mixed, 4–8 digits, separator and alphanumeric forms, phone/order/amount/date noise stripped) and shown in a highlighted chip at the bottom-right of each card with a one-tap copy button; the detail dialog always offers a **Copy code** action regardless of that setting; copy uses the Clipboard API with an `execCommand` fallback and reports failure instead of faking success
- **Pagination consistency**: the cursor carries a **SHA-256 fingerprint of the starred ID set**; if starring changes mid-session, the server rejects the stale cursor with `409 CURSOR_STALE` and the page reloads from the top, so messages are never skipped or duplicated (list order is pinned → time → id; starring no longer affects ordering)
- **Multi-channel forwarding**: new messages can be auto-forwarded to Feishu / WeCom / DingTalk / Telegram / ServerChan / PushPlus / Bark / ntfy / Gotify / Email / generic Webhook — configured in the admin **Settings → Alerts** page (stored in your database, per-channel enable/disable, **multiple independent targets per channel**, credential update, per-target test send); one failing target does not block the others, and legacy environment variables are still honoured when no database value exists
- **Optional security**: admin login toggle, multi-format OTP code extraction (code-first / keyword-first / segmented / mixed, false-positive resistant) with one-tap copy, dark mode
- **Data & alerts**: export CSV / JSON by current filter; toast / optional sound / floating pill for new messages while visible, browser notification + unread title while hidden; long messages show a short summary and open the full text in a detail dialog
- **Number recognition**: built-in directory of common institutional numbers (carriers / banks / couriers / government) auto-labeled; optional carrier-region lookup for unknown mobile numbers (on by default, can be disabled)
- **9 languages**: the admin and login pages ship with zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR built in; switch from **Settings → Language** on the admin page (browser-scoped, `?lang=` deep link supported, choice remembered locally); dates, relative times and directory labels switch along
- **Mobile friendly**: `viewport-fit` safe-area support for notches and gesture bars, 16px inputs to prevent iOS auto-zoom, larger touch targets, bottom-sheet dialogs, PWA add-to-home-screen
- **Bulk & undo**: a **Multi-select** toolbar button, right-click or long-press reveals the checkboxes and bulk bar; batch mark-read, delete, clear-by-filter and CSV/JSON export for the current filter; 5-second undo after deletion (soft delete); dark mode with auto / light / dark
- **Starred / pinned / unread / stats**: bookmark and pin are independent actions with their own buttons and filters; starred-only / pinned-only / unread-only views, stats panel (source breakdown + last 7 days); custom number labels; search highlight and history; do-not-disturb and sound in settings; PWA

## Screenshots

> Screenshots show the **English UI with sample data** (v1.1.5). Change the interface language under **Settings → Display → Language**.

**Message center overview**

![Message center overview](docs/images/overview.png)

**Multi-select on demand**

![Multi-select](docs/images/multi-select.png)

**Message detail**

![Message detail](docs/images/detail.png)

**Settings center**

![Settings center](docs/images/settings.png)

**Notification multi-target**

![Notification multi-target](docs/images/notification-targets.png)

**Mobile layout**

![Mobile layout](docs/images/mobile.png)

```
[SMS] Android(SmsForwarder) ──POST /api/receive──┐
                                                 ├─→ cloud gateway (any platform) ─→ database
[notify] scripts / shortcuts ──POST /api/push────┘        │
                                                browser ◀── web admin (embedded in gateway)
```

**Deploy to Cloudflare (recommended for beginners):**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

The button clones the public repository into your own account, creates and binds the D1 database and other platform resources, and sets up build/CI. Tables are created by the application on its first request; secrets are filled in on the settings page. See the [Cloudflare deployment guide](docs/guide/03-平台部署/01-Cloudflare.md).

> Deploy buttons and availability per platform: see the [deployment capability matrix](docs/guide/10-部署能力矩阵.md).

| Platform | Deployment | Scheduled cleanup | Guide |
|---|---|---|---|
| **Cloudflare** (recommended) | Worker + D1 | platform cron | [platforms/cloudflare/README.md](platforms/cloudflare/README.md) |
| Vercel | Edge Function + Turso | platform cron | [platforms/vercel/README.md](platforms/vercel/README.md) |
| Deno Deploy | Deno native + Turso | Deno.cron | [platforms/deno/README.md](platforms/deno/README.md) |
| Netlify | Functions v2 + Turso | Scheduled Function | [platforms/netlify/README.md](platforms/netlify/README.md) |
| Tencent EdgeOne Makers | Functions + Turso | external cron | [platforms/edgeone/README.md](platforms/edgeone/README.md) |
| Fly.io / Railway / VPS | Docker (Node 22) + Turso / local SQLite | in-process | [platforms/node/README.md](platforms/node/README.md) |

> Every platform directory is **fully self-contained** (code + schema + standalone docs, zero npm dependencies, no build step). Click a guide above and follow the steps.
> For platform comparison and common preparation (Turso database), see [platforms/README.md](platforms/README.md).

---

## Phone Setup & Multi-device Ingestion

All platforms deliver messages into the same web page: phone SMS goes through `/api/receive` (Android SmsForwarder), everything else uses the universal `/api/push`.

Step-by-step configuration (copy-paste commands/scripts per platform): **[Deployment & Ingestion Guide](docs/i18n/en/DEPLOYMENT.md)**

Android background-survival settings (battery optimisation, autostart, vendor restrictions, lock-screen/reboot checks, per-model guidance): **[Android SmsForwarder Keep-Alive Guide](docs/安卓SF保活指南.md)** (Chinese; ask the AI assistant with your exact phone model for a tailored path).

**Universal push quick reference** (full fields in the guide):

```
POST https://<your-domain>/api/push?token=<RECEIVE_TOKEN>
{"source":"notify","sender":"demo","content":"hello from anywhere"}
```

A `{"success":true,...}` response means it is stored; pushing the exact same payload again returns `duplicated:true`.

## Environment Variables (all platforms)

| Variable | Required | Description |
|---|---|---|
| `RECEIVE_TOKEN` | yes | push auth secret; pick a long random string. Works as the **fallback** ingest credential: named tokens created in the admin page take priority |
| `DISABLE_RECEIVE_TOKEN` | no | set `"true"` (case/whitespace-insensitive) to **disable the `RECEIVE_TOKEN` fallback** so only hashed named tokens can push; unset = fallback enabled (migration-friendly default). Does not affect `/api/cron`, which always uses the env var. Default (unset) keeps the fallback enabled; only the string `"true"` (case/whitespace-insensitive) disables it. |
| `ENABLE_AUTH` | no | `"true"` requires login for the admin page (**strongly recommended**, see security notes below); default is no login |
| `ADMIN_PASSWORD` | no | login password (set when `ENABLE_AUTH="true"`; if missing, admin APIs refuse access and log an alert — missing config never opens the door) |
| `RETENTION_DAYS` | no | data retention in days, default 30. Editable in **Settings → Data & operations** (the database value wins; this variable is only the fallback when no database value exists) |
| `WAIT_MAX_SECONDS` | no | max seconds `/api/wait` long polling may hang; the core clamps to **3–25** and defaults to **25**. Some entries ship safer defaults (Vercel `20`, Netlify `8`, EdgeOne `20`); an explicit env value always wins. Check your platform's *own* function-duration limit and lower it if requests are killed. |
| `PHONE_AREA_ENABLED` / `PHONE_AREA_API` | no | legacy fallback for carrier-region lookup: on by default (free 360 API, no key, 24h backend cache, 11-digit mobile numbers only); set `false` to disable; custom source via `PHONE_AREA_API` (URL with `{number}` placeholder). Prefer **Settings → Data & operations**, which stores the same values in the database and takes precedence |
| Notification channel variables | no | **Legacy fallback only.** Configure channels in **Settings → Notifications** (database-backed, with per-channel enable/disable, credential update, masked display and a test-send button). These variables still work when the corresponding database key does not exist, which keeps existing deployments running after an upgrade: `FEISHU_WEBHOOK` (Feishu) / `WECOM_WEBHOOK` (WeCom) / `DINGTALK_WEBHOOK` (DingTalk, optional `DINGTALK_SECRET` signing) / `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY` (optional `BARK_URL`) / `NTFY_URL` (optional `NTFY_TOKEN`) / `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO` (email, optional `MAIL_FROM`) / `GENERIC_WEBHOOKS` (generic webhook, optional `GENERIC_WEBHOOK_TEMPLATE` body / `GENERIC_WEBHOOK_HEADERS` headers). With nothing configured nothing is forwarded. Notifications auto-render in three modes by content (🔐 OTP / 💬 SMS / 🔔 notification) |
| `SITE_NAME` / `SITE_ICON` | no | site name / icon URL; defaults apply when unset |
| `NOTIFY_LINK` | no | legacy fallback for the admin page home URL; when set, every notification channel gets an "Open admin" entry (button/link/click). Editable in **Settings → Notifications** (database value wins; leaving the field empty there is an explicit clear that also hides this variable) |
| `SESSION_SECRET` | required when login is on | session signing secret: **high-entropy random value (≥32 random characters recommended), fully independent from the admin password**; Cloudflare and EdgeOne (and every other platform) must each have their own value; never commit it to Git or reuse the password. If missing, login and auth **fail closed** (login returns 500, admin APIs return 401, no password-derived fallback). Rotating the value invalidates all existing sessions immediately. Sessions last 30 minutes; logout only clears the browser cookie — a copied session token remains valid within its TTL (up to 30 minutes) |
| `SHUTDOWN_GRACE_MS` | no (Node self-hosting only) | overall **application** shutdown grace in milliseconds. It is derived, not fixed: `HTTP 30s + background drain 45s + 5s = 80000`. You may raise it (ceiling `120000`), but a value below the derived `80000` is ignored. This is **not** the container/systemd stop grace — that one is set by the deployer and must be ≥ 90s (see below) |

Cloudflare additionally needs the `DB` (D1 binding); other platforms need `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (Turso database, see each platform guide); Node self-hosting also supports `SQLITE_PATH` local SQLite mode (see platforms/node/README.md).

> **Node self-hosting — stop grace:** the container or service manager must allow at least 90s for shutdown (Docker's default 10s is too short). Use `--stop-timeout=90`, `stop_grace_period: 90s` or `TimeoutStopSec=90s` as appropriate. See [stop-grace configuration](docs/guide/07-停止宽限与部署配置.md).

> **Security recommendations**
> 1. **Turn on admin login** (`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`): the admin page holds sensitive content such as SMS OTP codes; without login, anyone who knows the domain can read every message and delete data. The login endpoint is rate-limited (5 consecutive failures per IP locks it for 10 minutes); `/api/receive` and `/api/push` are rate-limited to 120 writes per IP per minute (429 beyond that).
> 2. **Token in URLs — recommended: header, query for compatibility only**: `/api/receive` and `/api/push` accept the token via (in priority order) the `X-Receive-Token` header → `?token=` query → `Authorization: Bearer` → `token` in the JSON body. **The `X-Receive-Token` header is the recommended way** (never lands in access logs, browser history or referrers); the `?token=` query exists only for compatibility with SmsForwarder-style clients. You can create named tokens in the admin page (Settings → Access tokens), where they are stored hashed (SHA-256) and can be revoked or rotated per device instantly; each token can carry a **note** (to tell devices apart) and an **expiry** (permanent / preset days / custom date — expired tokens are rejected with 403 automatically, without losing the audit row); the deploy-time `RECEIVE_TOKEN` env var keeps working as a fallback until you set `DISABLE_RECEIVE_TOKEN="true"`.
> 3. **Notification credentials are stored as plaintext** in your own `settings` table: whoever can read the database — including a backup, snapshot or copied SQLite file — can read the Webhook URLs and tokens. Protect database access and backups accordingly; the admin API only returns "configured + last-4 mask" and logs redact URLs.

## Settings Page (admin)

Open the admin page → **Settings**. Everything below requires a login session when `ENABLE_AUTH="true"`.

| Group | What you can do | Scope / Stored in |
|---|---|---|
| Sign-in & session | **Sign-in validity (this browser)**: 5–43200 minutes for **new sign-ins in this browser only** (localStorage, sent with each login); **Sign-in validity (global default)**: the fallback used when a browser has no own value (also the compat path for old clients) | This browser (localStorage) / Global (`settings` table) |
| Notifications | global on/off, which message types to forward (`verify` / `sms` / `notify`), retry count (0–3), admin link, per-channel enable/disable, credentials, **test send**, **import from environment variables** | Global (`settings` table, `notify.*`) |
| Data & operations | data retention days (1–3650), carrier-region lookup on/off and custom API URL | Global (`settings` table) |
| Security | entry to access-token management (create / revoke / rotate, plaintext shown once) + sign-in protection notes | Global (`tokens` table) |

Every row carries a **scope badge** (Global / This browser), so it is clear whether a change affects the whole service or only this browser. Save / Cancel / Restore-defaults apply **per group**; any unsaved change shows an “unsaved” badge, and switching groups or closing the dialog asks for confirmation.

See the [Settings Center](docs/SETTINGS.md) for the full rules.

## License

[MIT](LICENSE) © 2026 [左立方 (ZuoLifang)](https://cbm.im/)
