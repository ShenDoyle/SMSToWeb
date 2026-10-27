# Multi-Platform Deployment Overview

**English** | [简体中文](../../zh-CN/README.md) | [繁體中文](../../zh-TW/README.md) | [日本語](../../ja/README.md) | [한국어](../../ko/README.md) | [Español](../../es/README.md) | [Français](../../fr/README.md) | [Deutsch](../../de/README.md) | [Português (BR)](../../pt-BR/README.md)

> Synced from the English primary where applicable

All six SMSToWeb platforms (the Cloudflare primary + five ported platforms) live in this directory. **Each platform subdirectory is fully self-contained**:
code (entry + core app + database adapter layer) + `schema.sql` + a detailed platform-specific deployment guide (README.md).

| Platform | Runtime | Scheduled cleanup | Guide |
|---|---|---|---|
| **Cloudflare** (primary) | Worker + D1 | platform cron | [cloudflare/README.md](./CLOUDFLARE.md) |
| Vercel | Edge Function | platform cron | [vercel/README.md](./VERCEL.md) |
| Deno Deploy | Deno native | `Deno.cron` (built-in) | [deno/README.md](./DENO.md) |
| Netlify | Functions v2 (Node) | Scheduled Function | [netlify/README.md](./NETLIFY.md) |
| EdgeOne Makers (Tencent) | Functions | external cron calling /api/cron | [edgeone/README.md](./EDGEONE.md) |
| Fly.io / Railway / VPS | Docker (Node 22) + Turso/local SQLite | in-process | [node/README.md](./NODE.md) |

Across the six platforms (Cloudflare included), API paths, auth logic, the message model, the admin page, multi-channel notification forwarding, and daily cleanup (UTC 17:00) are fully identical.
The table schema is the same, so you can migrate between them at any time.

> **One-click deploy**: the Cloudflare / Vercel / Netlify guides each start with an official one-click deploy button (the Cloudflare button even creates the database and tables automatically).
> Deno Deploy, EdgeOne and Docker self-hosting have no official button yet — just follow each platform guide.

## How to choose a platform

- **Zero cost + zero fuss** → the Cloudflare primary (generous D1 free tier, Workers have no wall-clock issues)
- **Want to try multiple platforms** → Deno Deploy (semantically closest to Workers; long polling is essentially untruncated)
- **Mainland China access** → EdgeOne Makers (note: custom domains require ICP filing)
- **Already have a server / want full control** → node/ (Docker self-hosting)

> **Long polling and platform timeouts**: the admin page hangs on `GET /api/wait` waiting for new messages, up to 25 seconds by default, tunable per platform via the `WAIT_MAX_SECONDS` environment variable (3–25).
> Netlify Functions' current cap is 60 seconds (the entry defaults to `WAIT_MAX_SECONDS=8` as a conservative fit; raise it if needed); Vercel Edge recommends `20`; Cloudflare / Deno / Node keep the default.
> The frontend retries failures with **exponential backoff** (2→30s) and re-pulls immediately when the page becomes visible again, so even requests truncated early by the platform **do not break functionality** — only new-message alerts may arrive slightly later.

## Common preparation (shared by all non-Cloudflare platforms)

**The database is uniformly [Turso](https://turso.tech)** (SQLite-compatible; free tier: 100 databases, 5GB storage, 500 million row reads per month):

1. Open [turso.tech](https://turso.tech), log in with GitHub
2. **Create Database**: name `sms-gateway`, region Singapore / Hong Kong, type Free
3. On the database detail page note the **Database URL** (`libsql://sms-gateway-xxxx.turso.io`); click **Create Token** to create a token and save it immediately (shown only once)
4. Initialize the schema: paste the entire `schema.sql` from the platform directory into the detail page **Console** and execute (identical to the repo-root `schema.sql`)

CLI equivalent:

```bash
turso auth login
turso db create sms-gateway          # create the database
turso db show sms-gateway --url      # show the URL
turso db tokens create sms-gateway   # create a token
turso db shell sms-gateway < schema.sql   # create tables
```

**Environment variables** (set in each platform's settings panel; full details in each platform guide):

| Variable | Required | Description |
|---|---|---|
| `TURSO_DATABASE_URL` | yes | `libsql://sms-gateway-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | yes | database access token |
| `RECEIVE_TOKEN` | yes | push auth secret (must match `token=` in the client URL) |
| `ENABLE_AUTH` | no | `"true"` requires login for the admin page (**strongly recommended for security**, see the security notes below); default is no login |
| `ADMIN_PASSWORD` | no | login password (set when `ENABLE_AUTH="true"`; if missing, admin APIs refuse access and log an alert — missing config never opens the door) |
| `SESSION_SECRET` | required when login is on | login session signing secret: high-entropy random value (≥32 random characters, fully independent from the admin password); each platform must be configured with its own independent value; if missing, login and auth fail closed (login 500, admin APIs 401) with no password-derived fallback; after rotation all old sessions are invalidated and re-login is required |
| `RETENTION_DAYS` | no | data retention in days, default 30 |
| `WAIT_MAX_SECONDS` | no | long-poll hang seconds (3–25, default 25); Netlify set `8`, Vercel Edge set `20` |
| Notification channel variables | no | `FEISHU_WEBHOOK` (Feishu) / `WECOM_WEBHOOK` (WeCom) / `DINGTALK_WEBHOOK` (DingTalk, optional `DINGTALK_SECRET` signing) / `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY` (optional `BARK_URL`) / `NTFY_URL` (optional `NTFY_TOKEN`) / `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO` (email, optional `MAIL_FROM`) / `GENERIC_WEBHOOKS` (generic webhook, optional `GENERIC_WEBHOOK_TEMPLATE` body / `GENERIC_WEBHOOK_HEADERS` headers). Configure only what you use; with none set nothing is forwarded; notifications auto-render in three modes by content (🔐 code / 💬 SMS / 🔔 notification) |
| `SITE_NAME` / `SITE_ICON` | no | site name / icon URL; defaults apply when unset |
| `NOTIFY_LINK` | no | admin page home URL; when set, every notification channel gets an "Open admin" entry (button/link/click); omitted automatically when unset |
| `CRON_SECRET` (Vercel only) | no | set to the same value as `RECEIVE_TOKEN` so Vercel Cron can call /api/cron |
| `SQLITE_PATH` (node self-hosting only) | no | local SQLite mode: once set, no external database is needed (requires Node 22.13+, see [node/README.md](./NODE.md)) |

> **Strongly recommended security practices**
> 1. **Turn on admin login** (`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`): the admin page holds sensitive content such as SMS OTP codes; no login by default means anyone who knows the domain can read every message and delete data. The login endpoint is rate-limited (5 consecutive failures per IP locks it for 10 minutes); `/api/receive` and `/api/push` are additionally rate-limited to 120 writes per IP per minute (429 beyond that).
> 2. **Trade-off of the push token in the URL query**: for compatibility with SmsForwarder and similar clients, `/api/receive` and `/api/push` accept auth via the `?token=` query parameter — the token appears in the URL and may enter platform access logs and browser history. If that concerns you, switch to POST with the `Authorization: Bearer <RECEIVE_TOKEN>` header (both are supported).

## Directory structure

```
platforms/
├── cloudflare/ # primary: worker.js + schema.sql + wrangler.toml + README.md (self-contained)
├── vercel/     # api/[[...route]].js + app.js + db.js + schema.sql + vercel.json + README.md
├── netlify/    # functions/{api,cron}.mjs + app.js + db.js + schema.sql + netlify.toml + README.md
├── deno/       # main.js + app.js + db.js + schema.sql + README.md
├── edgeone/    # functions/{[[default]].js,index.js} + app.js + db.js + schema.sql + README.md
├── node/       # server.mjs + app.js + db.js + schema.sql + Dockerfile + package.json + README.md
├── shared/     # single source of app.js / db.js (gen_app.py syncs from here into each platform directory)
└── gen_app.py  # generator: builds app.js from ../src/worker.js and syncs all platforms (including the standalone cloudflare copy)
```

Each platform directory can serve alone as a deployment root (for Git deploys, point the platform Root Directory at the matching subdirectory);
zero npm dependencies, no build step. After `src/worker.js` changes, run `python platforms/gen_app.py` to re-sync all platforms in one step (CI verifies zero drift; `node tests/run.mjs` covers 204 test assertions).

## Migrating from a Cloudflare Worker to other platforms

1. Prepare the Turso database and tables as described above
2. (Optional) migrate historical data: export the D1 data (SQLite file) from the CF Dashboard → import with `turso db import` (see the official CLI docs)
3. Deploy per the target platform README; verify the admin page and /api/push work
4. Point the phone client and all push scripts' webhook domains at the new platform
5. After observing a day or two without anomalies, retire the old Worker

## Common notes

- API paths are identical on all platforms: `/api/receive`, `/api/push`, `/api/messages` (supports `device_id`/`source`/`range`/`q`/`limit`/`page`/`starred`/`unread`), `/api/messages/star`, `/api/messages/read`, `/api/messages/remove`, `/api/messages/restore`, `/api/messages/clear`, `/api/export` (CSV/JSON), `/api/sources`, `/api/stats`, `/api/phone` (carrier region), `/api/devices`, `/api/devices/alias`, `/api/devices/merge`, `/api/wait`, `/api/login`, `/api/logout`, `/api/cron`; plus the public `/manifest.webmanifest` and `/sw.js`
- `/api/cron` lets external schedulers trigger cleanup; auth: `?token=<RECEIVE_TOKEN>` or `Authorization: Bearer <RECEIVE_TOKEN>`
- `/api/receive` and `/api/push` are unaffected by the login toggle
