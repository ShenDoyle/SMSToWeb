# SMSToWeb — SMS & Notification Cloud Gateway

**English** | [简体中文](docs/i18n/zh-CN/README.md) | [繁體中文](docs/i18n/zh-TW/README.md) | [日本語](docs/i18n/ja/README.md) | [한국어](docs/i18n/ko/README.md) | [Español](docs/i18n/es/README.md) | [Français](docs/i18n/fr/README.md) | [Deutsch](docs/i18n/de/README.md) | [Português (BR)](docs/i18n/pt-BR/README.md)

> English is the primary maintained version of this document. Translations live under [`docs/i18n/<lang>/`](docs/i18n/README.md) and may lag behind; when in doubt, refer to this file.

Push SMS and notifications from an Android phone (and any other device) to the cloud in real time, and read them from a web page anywhere. Free to deploy, no server required, about 10 minutes end to end.

- **Multi-platform deployment**: Cloudflare (primary) / Vercel / Deno Deploy / Netlify / Tencent EdgeOne Makers / Docker self-hosted — pick one of six, features fully identical
- **Real-time receiving**: webhook push lands in the database in seconds; the web page refreshes itself, no manual work
- **Universal push**: any device that can send an HTTP request (Linux / Windows / macOS / iOS / NAS / scripts) can push notifications into the same page
- **Sources & filters**: filter dynamically by source (SMS / notifications and custom sources auto-aggregated), stacked with keyword search and Today / Last 7 days / Last 30 days ranges; adjustable page size
- **Multi-channel forwarding**: new messages can be auto-forwarded to Feishu / WeCom / DingTalk / Telegram / ServerChan / PushPlus / Bark / ntfy / Gotify / Email / generic Webhook — configure only what you use (optional)
- **Optional security**: admin login toggle, multi-format OTP code extraction (code-first / keyword-first / segmented / mixed, false-positive resistant) with one-tap copy, dark mode
- **Data & alerts**: export CSV / JSON by current filter; toast / optional sound / floating pill for new messages while visible, browser notification + unread title while hidden; long messages auto-collapsed
- **Number recognition**: built-in directory of common institutional numbers (carriers / banks / couriers / government) auto-labeled; optional carrier-region lookup for unknown mobile numbers (on by default, can be disabled)
- **9 languages**: the admin and login pages ship with zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR built in; switch from the header 🌐 menu (`?lang=` deep link supported, choice remembered locally); dates, relative times and directory labels switch along
- **Mobile friendly**: `viewport-fit` safe-area support for notches and gesture bars, 16px inputs to prevent iOS auto-zoom, larger touch targets, bottom-sheet dialogs, PWA add-to-home-screen
- **Bulk & undo**: multi-select delete, clear-by-filter in one tap; 5-second undo after deletion (soft delete); dark mode with auto / light / dark
- **Starred / unread / stats**: star to pin, starred-only / unread-only views, stats panel (source breakdown + last 7 days); custom number labels; search highlight and history; do-not-disturb and sound in settings; PWA

```
[SMS] Android(SmsForwarder) ──POST /api/receive──┐
                                                 ├─→ cloud gateway (any platform) ─→ database
[notify] scripts / shortcuts ──POST /api/push────┘        │
                                                browser ◀── web admin (embedded in gateway)
```

**One-click deploy (Cloudflare primary, ~2 min)**:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

The button creates the database and tables, binds resources and sets up CI automatically; fill in `RECEIVE_TOKEN` (push auth secret) when prompted and you are live. One-click buttons for Vercel / Netlify are in their platform guides.

| Platform | Deployment | Scheduled cleanup | Guide |
|---|---|---|---|
| **Cloudflare** (recommended) | Worker + D1 | platform cron | [platforms/cloudflare/README.md](platforms/cloudflare/README.md) |
| Vercel | Edge Function + Turso | platform cron | [platforms/vercel/README.md](platforms/vercel/README.md) |
| Deno Deploy | Deno native + Turso | Deno.cron | [platforms/deno/README.md](platforms/deno/README.md) |
| Netlify | Functions v2 + Turso | Scheduled Function | [platforms/netlify/README.md](platforms/netlify/README.md) |
| Tencent EdgeOne Makers | Functions + Turso | external cron | [platforms/edgeone/README.md](platforms/edgeone/README.md) |
| Fly.io / Railway / VPS | Docker (Node 22) + Turso / local SQLite | in-process | [platforms/node/README.md](platforms/node/README.md) |

> Every platform directory is **fully self-contained** (code + schema + standalone docs, zero npm dependencies, no build step). Click a guide above and follow the steps. Features and the data schema are identical across platforms; you can migrate between them at any time.
> For platform comparison and common preparation (Turso database), see [platforms/README.md](platforms/README.md).

### Runtime differences (read before deploying)

Business code is byte-identical across the six platforms, but **timeouts / background tasks / timers** differ at runtime. Adapt via environment variables when needed:

| Platform | Function timeout | Background notify | Scheduled cleanup | Suggestion |
|---|---|---|---|---|
| Cloudflare | no wall-clock limit (CPU-limited) | `ctx.waitUntil` continues after response | platform cron | defaults work |
| Vercel Edge | ~25s cap per request | completed inline before response | platform cron | `WAIT_MAX_SECONDS=20` |
| Netlify Functions | 60s (all plans) | completed inline before response | scheduled function | entry defaults to `WAIT_MAX_SECONDS=8` |
| Deno Deploy | plan-dependent | completed inline before response | needs external trigger | external cron calling `/api/cron?token=` |
| EdgeOne Makers | plan-dependent | completed inline before response | needs external trigger | lower `WAIT_MAX_SECONDS` per plan |
| Node / Docker | your choice | completed inline before response | needs external trigger | local SQLite needs Node ≥ 22.13 |

> - **Long polling**: the frontend retries failures with **exponential backoff** (2→30s) and re-polls immediately when the page becomes visible; platform-killed requests never flood the function.
> - **Notification forwarding**: Cloudflare uses `waitUntil`; other platforms finish sending notifications before the response (10s timeout per channel), so many slow channels add a little latency.
> - **Scheduled cleanup**: on platforms without cron, point any scheduler at `GET /api/cron?token=<RECEIVE_TOKEN>`.

---

## Phone Setup & Multi-device Ingestion

All platforms deliver messages into the same web page: phone SMS goes through `/api/receive` (Android SmsForwarder), everything else uses the universal `/api/push`.

Step-by-step configuration (copy-paste commands/scripts per platform): **[Deployment & Ingestion Guide](docs/i18n/en/DEPLOYMENT.md)**

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

Cloudflare additionally needs the `DB` (D1 binding); other platforms need `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (Turso database, see each platform guide); Node self-hosting also supports `SQLITE_PATH` local SQLite mode (see platforms/node/README.md).

> **Security recommendations**
> 1. **Turn on admin login** (`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`): the admin page holds sensitive content such as SMS OTP codes; without login, anyone who knows the domain can read every message and delete data. The login endpoint is rate-limited (5 consecutive failures per IP locks it for 10 minutes); `/api/receive` and `/api/push` are rate-limited to 120 writes per IP per minute (429 beyond that).
> 2. **Trade-off of `?token=` in URLs**: for compatibility with SmsForwarder and similar clients, `/api/receive` and `/api/push` accept auth via the `?token=` query parameter — the token may appear in platform access logs and browser history. If that concerns you, switch to POST with the `Authorization: Bearer <RECEIVE_TOKEN>` header (both are supported).

## FAQ (general)

- **A label shows a literal `{{XXX}}`** → cannot happen: the gateway blanks labels containing a literal `{{` and falls back to `sim`; set your custom name directly in the template's `name` field
- **API 401/403** → check that `token=` in the URL matches `RECEIVE_TOKEN`; `/api/receive` and `/api/push` are unaffected by the login toggle
- **API 429** → write rate limit hit (120/IP/min); it recovers after a minute — if it happens in normal use, your token may have leaked or something is hammering the API
- **Very long messages** → a single body is capped at 8000 characters, the excess is truncated
- **Renaming a device label** → a label comes from the message template's `name` field; changing `name` creates a new label. Use "✎" next to a label on the web page to rename it, "⇄" to merge its messages into another device, and "×" to delete an empty label directly
- **Upgrading from an older version (new columns)** → run on the old database: `ALTER TABLE messages ADD COLUMN deleted_at TEXT;`, `ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;`, `ALTER TABLE messages ADD COLUMN read_at TEXT;` (fresh databases already include them; node local SQLite auto-adds columns on startup)

## Development

- `src/worker.js`: core source (Cloudflare Worker shape)
- `platforms/gen_app.py`: generates the platform-neutral `app.js` from `src/worker.js` into the five ported platforms and syncs the Cloudflare copy `worker.js` (keeping business code byte-identical across six platforms); also syncs the 31-variable environment whitelist (ENV_KEYS, including auth entries) into the six platform entries to prevent drift (node's db.js is a Turso + local SQLite dual adapter, maintained separately and not synced)
- `platforms/*/`: self-contained deployment directories (entry + app.js + db.js adapter + schema.sql + platform guide)
- `docs/i18n/en/`: English documentation set (deployment/API/architecture/database); other languages under `docs/i18n/<lang>/` — see [docs/i18n/README.md](docs/i18n/README.md)
- `tests/run.mjs`: zero-dependency test suite (needs Node 22.13+): `node tests/run.mjs`
- After changing core code: run `python platforms/gen_app.py` to re-sync all platforms, then `node tests/run.mjs`; CI verifies zero sync drift + syntax + tests

## License

[MIT](LICENSE) © 2026 [左立方 (ZuoLifang)](https://cbm.im/)
