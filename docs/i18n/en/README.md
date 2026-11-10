# SMSToWeb — SMS & Notification Cloud Gateway

> **Sync notice (2026-11-09) / 同步提示**：This translated mirror may lag behind the English primary `README.md` and the Chinese `docs/` primaries. **Verified current facts**: `tests/run.mjs` = **850 passing assertions** (plus the separate M-1 suite `tests/m1-lifecycle.mjs` = 32); `ENV_KEYS` = **33** variables; **all six platform entries pass a `waitUntil`-style `ctx`** (inline `await` is only a *runtime-capability* fallback, not an entry-point behaviour); Node shutdown grace = **80s** and the container/service stop grace must be **>= 90s** (Docker default 10s SIGKILLs first); `gen_app.py --check` verifies **only** the embedded `SCHEMA_SQL` block and SQL references, **not** platform-copy drift. Any statement in this mirror about "667/814/573 assertions", "31 variables", "other platforms finish notifications before the response", "8-second forced exit", "the deploy button creates the tables", or "one-click and you are live" is **outdated**. Read the [English primary](../../../README.md), [ARCHITECTURE](../../ARCHITECTURE.md), or the [Chinese user guide](../../guide/README.md) instead.
>
> **同步提示（2026-11-09）**：本镜像属滞后翻译，上述事实以英文主版与中文主文档为准；本文件内关于测试数量、环境变量数量、「其他平台响应前发完通知」、8 秒强制退出、按钮自动建表等旧表述均已过时，请勿据此部署或验收。源码版本现为 `v1.1.0`（RC2 候选），目标 `v1.1.0` 尚未正式发布。


**English** | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> Synced from the English primary where applicable

> English is the primary maintained version of this document. Translations live under [`docs/i18n/<lang>/`](../README.md) and may lag behind; when in doubt, refer to this file.

Push SMS and notifications from an Android phone (and any other device) to the cloud in real time, and read them from a web page anywhere. Free to deploy, no server required, about 10 minutes end to end.

- **Multi-platform deployment**: Cloudflare (primary) / Vercel / Deno Deploy / Netlify / Tencent EdgeOne Makers / Docker self-hosted — pick one of six, features fully identical
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

**One-click deploy (Cloudflare primary, ~2 min)**:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

What the button actually does: clones the public repository into your own GitHub/GitLab account, creates and binds the **D1 database** and other Cloudflare-native resources declared in `wrangler.toml`, and sets up build/CI. It does **not** run SQL migrations (the application's `ensureSchema` creates tables on the first request), does **not** create a Turso database and does **not** fill in your secrets — you still type `RECEIVE_TOKEN` (and `ADMIN_PASSWORD` / `SESSION_SECRET` if login is enabled). Honest summary: **one click to create the app + a few fields to fill in**. The button deploys the public `main` branch, which may lag behind this checkout (`v1.1.0` RC2 candidate; formal release `v1.1.0` not published). See the [verified deployment capability matrix](../../guide/10-部署能力矩阵.md).

| Platform | Deployment | Scheduled cleanup | Guide |
|---|---|---|---|
| **Cloudflare** (recommended) | Worker + D1 | platform cron | [platforms/cloudflare/README.md](../../../platforms/cloudflare/README.md) |
| Vercel | Edge Function + Turso | platform cron | [platforms/vercel/README.md](../../../platforms/vercel/README.md) |
| Deno Deploy | Deno native + Turso | Deno.cron | [platforms/deno/README.md](../../../platforms/deno/README.md) |
| Netlify | Functions v2 + Turso | Scheduled Function | [platforms/netlify/README.md](../../../platforms/netlify/README.md) |
| Tencent EdgeOne Makers | Functions + Turso | external cron | [platforms/edgeone/README.md](../../../platforms/edgeone/README.md) |
| Fly.io / Railway / VPS | Docker (Node 22) + Turso / local SQLite | in-process | [platforms/node/README.md](../../../platforms/node/README.md) |

> Every platform directory is **fully self-contained** (code + schema + standalone docs, zero npm dependencies, no build step). Click a guide above and follow the steps. Features and the data schema are identical across platforms; you can migrate between them at any time.
> For platform comparison and common preparation (Turso database), see [platforms/README.md](../../../platforms/README.md).

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
> - **Notification forwarding**: **all six platform entries pass a `ctx`-style object**; the difference is whether the runtime provides `waitUntil`. `bgRun` uses it when present (forwarding continues after the response) and degrades to an inline `await` only when the runtime lacks it (then the response waits). Older revisions claiming the other platforms always finish before the response are wrong; see [ARCHITECTURE §4](../../ARCHITECTURE.md). Per-channel fetch timeout is 10s.
> - **Scheduled cleanup**: on platforms without cron, point any scheduler at `GET /api/cron?token=<RECEIVE_TOKEN>`.

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

## FAQ (general)

- **A label shows a literal `{{XXX}}`** → cannot happen: the gateway blanks labels containing a literal `{{` and falls back to `sim`; set your custom name directly in the template's `name` field
- **API 401/403** → check that `token=` in the URL matches `RECEIVE_TOKEN`; `/api/receive` and `/api/push` are unaffected by the login toggle
- **API 429** → write rate limit hit (120/IP/min); it recovers after a minute — if it happens in normal use, your token may have leaked or something is hammering the API
- **Very long messages** → a single body is capped at 8000 characters, the excess is truncated
- **Renaming a device label** → a label comes from the message template's `name` field; changing `name` creates a new label. Use "✎" next to a label on the web page to rename it, "⇄" to merge its messages into another device, and "×" to delete an empty label directly
- **Upgrading from an older version (new columns)** → run on the old database: `ALTER TABLE messages ADD COLUMN deleted_at TEXT;`, `ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;`, `ALTER TABLE messages ADD COLUMN read_at TEXT;` (fresh databases already include them; node local SQLite auto-adds columns on startup)

## Development

- `src/worker.js`: core source (Cloudflare Worker shape)
- `platforms/gen_app.py`: generates the platform-neutral `app.js` from `src/worker.js` into the five ported platforms and syncs the Cloudflare copy `worker.js` (keeping business code byte-identical across six platforms); also syncs the **33-variable** environment whitelist (`ENV_KEYS`, including auth entries) into the six platform entries to prevent drift (node's db.js is a Turso + local SQLite dual adapter, maintained separately and not synced)
- `platforms/*/`: self-contained deployment directories (entry + app.js + db.js adapter + schema.sql + platform guide)
- `docs/i18n/en/`: English documentation set (deployment/API/architecture/database); other languages under `docs/i18n/<lang>/` — see [docs/i18n/README.md](../README.md)
- `tests/run.mjs`: zero-dependency test suite (needs Node 22.13+, **850 assertions**, all passing): `node tests/run.mjs`. The M-1 lifecycle suite `tests/m1-lifecycle.mjs` (**32 assertions**) runs separately.
- After changing core code: run `python platforms/gen_app.py` (**write mode**) to re-sync all platforms, then `python platforms/gen_app.py --check`, `node tests/run.mjs`, `node --check` and a **byte comparison** of the generated copies. `--check` is read-only but **narrow**: it verifies only the embedded `SCHEMA_SQL` block and SQL references — it does **not** compare the six platform `app.js`/`worker.js` copies and cannot detect drift from editing `src/worker.js`.

## License

[MIT](../../../LICENSE) © 2026 [左立方 (ZuoLifang)](https://cbm.im/)
