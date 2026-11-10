# SMSToWeb — SMS & Notification Cloud Gateway

**English** | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

SMSToWeb collects messages from any channel — SMS forwarders, app notifications, scripts, webhooks and custom integrations — through one shared HTTP API and message format, and shows them on a single web page for reading, searching and forwarding.

- **Multi-platform support**: Cloudflare Workers / Vercel / Deno Deploy / Netlify / Tencent EdgeOne Makers / Docker self-hosted — choose whichever platform fits your setup.
- **Real-time receiving**: webhook push lands in the database in seconds; the web page refreshes itself, no manual work
- **Universal push**: any device that can send an HTTP request (Linux / Windows / macOS / iOS / NAS / scripts) can push notifications into the same page
- **Sources & filters**: filter dynamically by source (SMS / notifications and custom sources auto-aggregated), stacked with keyword search and Today / Last 7 days / Last 30 days ranges; adjustable page size
- **Message list**: 10 per page by default; two-line summary (up to 120 codepoints, Unicode-safe); full text in a detail dialog; cursor-based **Load more**; opening a message marks it read with rollback on failure
- **Verification code**: server-side detection (Chinese / English / mixed, 4–8 digits, separated and alphanumeric forms, noise stripped) with a one-tap copy button in the card header; Clipboard API + fallback, explicit failure feedback
- **Multi-channel forwarding**: new messages can be auto-forwarded to Feishu / WeCom / DingTalk / Telegram / ServerChan / PushPlus / Bark / ntfy / Gotify / Email / generic Webhook; **multiple independent targets per channel** with per-target enable/rename/delete/test, and legacy environment variables as fallback
- **Optional security**: admin login toggle, multi-format OTP code extraction (code-first / keyword-first / segmented / mixed, false-positive resistant) with one-tap copy, dark mode
- **Data & alerts**: export CSV / JSON by current filter; toast / optional sound / floating pill for new messages while visible, browser notification + unread title while hidden; long messages auto-collapsed
- **Number recognition**: built-in directory of common institutional numbers (carriers / banks / couriers / government) auto-labeled; optional carrier-region lookup for unknown mobile numbers (on by default, can be disabled)
- **9 languages**: the admin and login pages ship with zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR built in; switch from **Settings → Language** on the admin page (browser-scoped, `?lang=` deep link supported, choice remembered locally); dates, relative times and directory labels switch along
- **Mobile friendly**: `viewport-fit` safe-area support for notches and gesture bars, 16px inputs to prevent iOS auto-zoom, larger touch targets, bottom-sheet dialogs, PWA add-to-home-screen
- **Bulk & undo**: checkboxes / bulk bar hidden until right-click or long-press; batch mark-read, delete, clear-by-filter and CSV/JSON export; 5-second undo after deletion (soft delete); dark mode with auto / light / dark
- **Starred / unread / stats**: star to pin, starred-only / unread-only views, stats panel (source breakdown + last 7 days); custom number labels; search highlight and history; do-not-disturb and sound in settings; PWA

```
[SMS] Android(SmsForwarder) ──POST /api/receive──┐
                                                 ├─→ cloud gateway (any platform) ─→ database
[notify] scripts / shortcuts ──POST /api/push────┘        │
                                                browser ◀── web admin (embedded in gateway)
```

**Deploy to Cloudflare**:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

The button clones the public repository into your own account, creates and binds the D1 database and other platform resources, and sets up build/CI. Tables are created by the application on its first request; secrets are filled in on the settings page. See the [deployment capability matrix](../../guide/10-部署能力矩阵.md).

| Platform | Deployment | Scheduled cleanup | Guide |
|---|---|---|---|
| **Cloudflare** (recommended) | Worker + D1 | platform cron | [platforms/cloudflare/README.md](../../../platforms/cloudflare/README.md) |
| Vercel | Edge Function + Turso | platform cron | [platforms/vercel/README.md](../../../platforms/vercel/README.md) |
| Deno Deploy | Deno native + Turso | Deno.cron | [platforms/deno/README.md](../../../platforms/deno/README.md) |
| Netlify | Functions v2 + Turso | Scheduled Function | [platforms/netlify/README.md](../../../platforms/netlify/README.md) |
| Tencent EdgeOne Makers | Functions + Turso | external cron | [platforms/edgeone/README.md](../../../platforms/edgeone/README.md) |
| Fly.io / Railway / VPS | Docker (Node 22) + Turso / local SQLite | in-process | [platforms/node/README.md](../../../platforms/node/README.md) |

> Every platform directory is **fully self-contained** (code + schema + standalone docs, zero npm dependencies, no build step). Click a guide above and follow the steps.
> For platform comparison and common preparation (Turso database), see [platforms/README.md](../../../platforms/README.md).

---

## Phone Setup & Multi-device Ingestion

All platforms deliver messages into the same web page: phone SMS goes through `/api/receive` (Android SmsForwarder), everything else uses the universal `/api/push`.

Step-by-step configuration (copy-paste commands/scripts per platform): **[Deployment & Ingestion Guide](./DEPLOYMENT.md)**

**Universal push quick reference** (full fields in the guide):

```
POST https://<your-domain>/api/push?token=<RECEIVE_TOKEN>
{"source":"notify","sender":"demo","content":"hello from anywhere"}
```

A `{"success":true,...}` response means it is stored; pushing the exact same payload again returns `duplicated:true`.

## Environment Variables (all platforms)

| Variable | Required | Description |
|---|---|---|
| `RECEIVE_TOKEN` | yes | push auth secret; pick a long random string |
| `ENABLE_AUTH` | no | `"true"` requires login for the admin page (**strongly recommended**, see security notes below); default is no login |
| `ADMIN_PASSWORD` | no | login password (set when `ENABLE_AUTH="true"`; if missing, admin APIs refuse access and log an alert — missing config never opens the door) |
| `RETENTION_DAYS` | no | data retention in days, default 30 |
| `WAIT_MAX_SECONDS` | no | max seconds `/api/wait` long polling may hang, default 25 (range 3–25). On **Netlify Functions** (10s cap) or other short-timeout platforms set `8` so requests are not killed by the platform |
| `PHONE_AREA_ENABLED` / `PHONE_AREA_API` | no | carrier-region lookup: on by default (free 360 API, no key, 24h backend cache, 11-digit mobile numbers only); set `false` to disable; custom source via `PHONE_AREA_API` (URL with `{number}` placeholder) |
| Notification channel variables | no | `FEISHU_WEBHOOK` (Feishu) / `WECOM_WEBHOOK` (WeCom) / `DINGTALK_WEBHOOK` (DingTalk, optional `DINGTALK_SECRET` signing) / `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY` (optional `BARK_URL`) / `NTFY_URL` (optional `NTFY_TOKEN`) / `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO` (email, optional `MAIL_FROM`) / `GENERIC_WEBHOOKS` (generic webhook, optional `GENERIC_WEBHOOK_TEMPLATE` body / `GENERIC_WEBHOOK_HEADERS` headers). Configure only what you use; with none set nothing is forwarded. Notifications auto-render in three modes by content (🔐 OTP / 💬 SMS / 🔔 notification) |
| `SITE_NAME` / `SITE_ICON` | no | site name / icon URL; defaults apply when unset |
| `NOTIFY_LINK` | no | admin page home URL; when set, every notification channel gets an "Open admin" entry (button/link/click); omitted automatically when unset |
| `SESSION_SECRET` | required when login is on | session signing secret: **high-entropy random value (≥32 random characters recommended), fully independent from the admin password**; Cloudflare and EdgeOne (and every other platform) must each have their own value; never commit it to Git or reuse the password. If missing, login and auth **fail closed** (login returns 500, admin APIs return 401, no password-derived fallback). Rotating the value invalidates all existing sessions immediately. Sessions last 30 minutes; logout only clears the browser cookie — a copied session token remains valid within its TTL (up to 30 minutes) |

Cloudflare additionally needs the `DB` (D1 binding); other platforms need `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (Turso database, see each platform guide); Node self-hosting also supports `SQLITE_PATH` local SQLite mode (see [platforms/node/README.md](../../../platforms/node/README.md)).

> **Security recommendations**
> 1. **Turn on admin login** (`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`): the admin page holds sensitive content such as SMS OTP codes; without login, anyone who knows the domain can read every message and delete data. The login endpoint is rate-limited (5 consecutive failures per IP locks it for 10 minutes); `/api/receive` and `/api/push` are rate-limited to 120 writes per IP per minute (429 beyond that).
> 2. **Trade-off of `?token=` in URLs**: for compatibility with SmsForwarder and similar clients, `/api/receive` and `/api/push` accept auth via the `?token=` query parameter — the token may appear in platform access logs and browser history. If that concerns you, switch to POST with the `Authorization: Bearer <RECEIVE_TOKEN>` header (both are supported).

## License

[MIT](../../../LICENSE) © 2026 [左立方 (ZuoLifang)](https://cbm.im/)
