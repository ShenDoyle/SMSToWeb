# Architecture Document (ARCHITECTURE)

**English** | [简体中文](../../zh-CN/README.md) | [繁體中文](../../zh-TW/README.md) | [日本語](../../ja/README.md) | [한국어](../../ko/README.md) | [Español](../../es/README.md) | [Français](../../fr/README.md) | [Deutsch](../../de/README.md) | [Português (BR)](../../pt-BR/README.md)

> Synced from the English primary where applicable

SMSToWeb is a "single core + multi-platform entry" SMS/notification aggregation system: one npm-dependency-free business core (`src/worker.js`) is synced by a generator script into six deployment platforms, each keeping only a thin adapter layer to interface with its own runtime and database.

## 1. Overall topology

```
Phone (SmsForwarder / any script)
   │  POST /api/receive (SMS) or /api/push (universal push) + token
   ▼
┌────────────────────────── deploy on any ONE platform ──────────────────────┐
│  Cloudflare Workers (D1)   Vercel Edge   Deno Deploy                       │
│  Netlify Functions         EdgeOne (Turso)   Node self-hosted (Docker)     │
│                                                                            │
│  Entry layer (thin adapter): receive request → buildEnv passes env vars    │
│                              → fetchApp()                                  │
│  Business core (single-file app.js): auth → store → query → long poll      │
│                                      → notification forwarding             │
└────────────────────────────────────────────────────────────────────────────┘
   │                                  │
   ▼                                  ▼
Admin page (embedded HTML, login auth)      11-channel notification forwarding (Feishu/WeCom/DingTalk/…)
```

Core design principle: **business code is separated from platform entries**. The core logic never changes per deployment platform; only thin adapter layers interface with each platform's runtime and database API; functionality is strictly identical across the six platforms.

## 2. Directory structure

```
src/worker.js                 # the single business source file (Cloudflare Worker shape: export default { fetch, scheduled })
platforms/
  gen_app.py                 # sync/generation script (see §3)
  shared/app.js               # generated artifact: business portion byte-identical with src/worker.js, only the export shape replaced
  cloudflare/                 # CF primary copy + wrangler.toml (maintained statically)
  vercel/  netlify/  deno/    # self-contained per-platform directories: entry + app.js + db.js + schema.sql + README
  edgeone/ node/              # EdgeOne uses Turso; node/db.js is a Turso + local SQLite dual adapter (maintained separately)
tests/run.mjs                 # zero-dependency test suite (node:sqlite, 204 checks)
docs/                         # documentation (this directory)
schema.sql                    # database schema script (single source)
```

Each platform directory is **fully self-contained**: the entry only references the `app.js` / `db.js` inside its own directory, so platforms deploy independently with no cross-dependencies.

## 3. Sync mechanism (platforms/gen_app.py)

`python platforms/gen_app.py` completes the following in one pass (idempotent, re-running produces no drift):

1. Takes `src/worker.js` as the single source, extracts all business code before `export default {`, appends the universal export tail (`fetchApp` / `runCron` / `handleCronRequest`), and writes `platforms/shared/app.js`;
2. Copies the shared copy together with `shared/db.js` and the root `schema.sql` into each platform directory (`node/db.js` excepted, maintained separately);
3. Uses the **ENV_KEYS whitelist** built into the script (a single list containing 31 environment variables) to replace the content between the `/* ==== ENV_KEYS BEGIN ==== */ … /* ==== ENV_KEYS END ==== */` marker blocks in each entry file, guaranteeing that the set of environment variables passed through is identical across the six platforms and preventing drift.

Iron rule: **make every business change only in `src/worker.js` (together with gen_app.py's ENV_KEYS), and always re-run gen_app.py afterwards**; directly hand-editing any generated artifact under platforms/ is forbidden (except node/db.js and wrangler.toml).

## 4. Request lifecycle

Using `POST /api/receive` as an example:

1. **Entry layer**: the platform entry (e.g. `platforms/edgeone/functions/index.js`) receives the request, builds `env = buildEnv(vars)` (passing through whitelist variables + the database credential branch), and calls `fetchApp(request, env[, ctx])`;
2. **Auth**: `/api/receive`, `/api/push`, `/api/login`, `/api/logout`, `/api/cron` and static assets are public paths; all other admin/page endpoints are gated by the login toggle (`ENABLE_AUTH`) — after login a **stateless signed Session** is issued (`nonce.exp.HMAC-SHA256` three-part form, Cookie `sms_auth`, TTL 30 minutes); when `SESSION_SECRET` is missing it fails closed (login 500, admin endpoints always 401, no password-derived fallback) — missing configuration never opens the door;
3. **Ingestion**: validate the token (`safeEqual` against timing attacks) → locate/create the device by device+sim → write into messages (the database unique index is the dedup backstop; duplicate pushes return `duplicated:true` and are not forwarded);
4. **Notification forwarding**: non-duplicate messages enter the background via `bgRun(ctx, dispatchNotify(env, msg))` — Cloudflare passes a real `ctx.waitUntil` so sending continues after the response; on other platforms, when ctx is absent it degrades to an inline `await`, preventing edge functions from cutting background tasks short;
5. **Response**: returns JSON immediately (`success/device_id/duplicated`) without waiting for forwarding to finish (on the CF platform).

## 5. Notification forwarding subsystem

`dispatchNotify(env, msg)` is the single assembly layer for all channels:

- `extractCodeLite(content)`: server-side lightweight code detection (cascade order matches the frontend `extractCode`: code-first takes precedence over keyword-first; phone numbers/dates/times/amounts/order numbers are stripped before detection);
- `buildNotifyInfo(env, msg)`: code detection + reading `NOTIFY_LINK` computed only once for all channels, producing the `verify/sms/notify` three modes and a unified title;
- each channel renderer consumes `info` and renders its own format (Feishu Interactive card / WeCom & DingTalk markdown / Telegram HTML / Bark / ntfy / Gotify / Resend email / generic webhook template, etc.); length caps, signing and escaping are all handled inside the renderers;
- `Promise.allSettled` schedules channels concurrently; a single channel's failure is only logged and does not affect the other channels or the main flow.

## 6. Frontend (embedded admin page)

The admin page HTML is embedded in `src/worker.js` as a `String.raw` template literal (server-rendered, no separate frontend project): the login page and the admin page share the `/` route, with the login toggle deciding which shape renders; it supports nine languages (zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR, embedded `data-i18n` dictionary + direct `?lang=` links, missing keys fall back to en), dark mode, one-tap code copy, long-poll auto refresh (`/api/wait`), source filtering and device management.

## 7. Multi-platform differences at a glance

| Platform | Entry file | Database | cron |
|---|---|---|---|
| Cloudflare | `export default` (worker.js itself) | D1 (`env.DB`) | native `scheduled` + `/api/cron` HTTP |
| Vercel | `api/[[...route]].js` | Turso | Vercel Cron (Bearer `CRON_SECRET`) |
| Netlify | `functions/api.mjs` + `functions/cron.mjs` | Turso | Scheduled Functions |
| Deno | `main.js` (`Deno.serve`) | Turso | external scheduler |
| EdgeOne | `functions/index.js` (the root path must be index.js) | Turso (client cache keyed by credential fingerprint) | external scheduler |
| Node | `server.mjs` (node:http) | Turso / local SQLite (dual adapter) | external scheduler / Docker |

The `/api/cron` HTTP trigger semantics are identical on all platforms: `?token=<RECEIVE_TOKEN>` or `Authorization: Bearer <RECEIVE_TOKEN>`.
