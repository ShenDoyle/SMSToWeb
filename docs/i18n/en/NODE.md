# Self-Hosting Deployment Guide (Fly.io / Railway / VPS / local)

**English** | [简体中文](../../zh-CN/README.md) | [繁體中文](../../zh-TW/README.md) | [日本語](../../ja/README.md) | [한국어](../../ko/README.md) | [Español](../../es/README.md) | [Français](../../fr/README.md) | [Deutsch](../../de/README.md) | [Português (BR)](../../pt-BR/README.md)

> Synced from the English primary where applicable

Self-host SMSToWeb as a Docker container. A resident process with no function duration limits gives the best long-polling real-time performance; suitable for users with an existing server or those who want to deploy to Fly.io / Railway (free tiers covered in "Platform notes" below).

**Files in this directory**: `server.mjs` (zero-dependency entry, Node 18+, with built-in daily cleanup), `app.js` (core app), `db.js` (Turso / local SQLite dual-mode adapter layer), `schema.sql` (table creation), `Dockerfile`, `package.json`.

---

## Preparation

- A Fly.io or Railway account (or any VPS with Docker)
- The database is still Turso (SQLite-compatible); Step 1 below prepares it uniformly

## Step 1: Create the Turso database

1. Open [turso.tech](https://turso.tech), click **Start for free now**, log in with GitHub
2. Enter the console → **Create Database**:
   - Name: `sms-gateway`
   - Location: a region near your server
   - Type: Free
3. After creation, open the database detail page:
   - Note the **Database URL** (shaped like `libsql://sms-gateway-xxxx.turso.io`)
   - Click **Create Token** to create an access token, and **copy and save it immediately** (shown only once)
4. Initialize the schema: database detail page → **Console** → paste the entire content of this directory's `schema.sql` → execute → wait for the success message

> CLI method: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Method A: Fly.io

1. Install flyctl locally ([official install guide](https://fly.io/docs/flyctl/install/)), then `fly auth login`
2. In this directory run:

```bash
cd platforms/node
fly launch                 # follow the prompts to create the app: pick any region; when asked about a database choose No (we use Turso)
fly secrets set TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io TURSO_AUTH_TOKEN=<your-token> RECEIVE_TOKEN=<your-secret>
fly secrets set ENABLE_AUTH=true ADMIN_PASSWORD=<your-password>     # optional
fly deploy
fly status                 # note the assigned domain https://<app>.fly.dev
```

3. Verify: opening `https://<app>.fly.dev` in a browser should show the admin page; push test:

```
curl "https://<app>.fly.dev/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Fly deploy succeeded\"}"
```

4. Custom domain: `fly certs add sms.your-domain.com`, then add DNS as prompted (A record or CNAME)

## Method B: Railway

1. Log in at [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**, and select your forked repository
2. Under service settings **Settings → Root Directory**: `platforms/node` (Railway detects the Dockerfile and builds automatically)
3. Add the environment variables in the **Variables** panel (see the general table below; `PORT` is injected by the platform and the code already adapts to it)
4. **Settings → Public Networking → Generate Domain** to generate a public domain
5. Verify as above (with your Railway domain)

## Method C: Any VPS (Docker)

```bash
# after uploading this directory to the server
cd platforms/node
docker build -t smstoweb .
docker run -d --name smstoweb --restart unless-stopped -p 8787:8787 \
  -e TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io \
  -e TURSO_AUTH_TOKEN=<your-token> \
  -e RECEIVE_TOKEN=<your-secret> \
  smstoweb
# verify
curl "http://127.0.0.1:8787/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"content\":\"VPS deploy succeeded\"}"
```

A Caddy/Nginx reverse proxy with HTTPS is recommended. Without Docker you can also run `node server.mjs` directly (needs Node 18+, zero npm dependencies; the local SQLite mode needs Node 22.13+).

## Environment variables (common to all three methods)

| Name | Value | Description |
|---|---|---|
| `SQLITE_PATH` (optional) | e.g. `/data/data.db` | **local SQLite mode**: once set, no external database is needed and data is stored in a local file (requires Node 22.13+, tables created automatically on first start; mutually exclusive with Turso, and takes priority once set) |
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | Turso mode: the URL noted in Step 1 |
| `TURSO_AUTH_TOKEN` | (the token from Step 1) | Turso mode: the one shown only once |
| `RECEIVE_TOKEN` | a long random string you make up | push auth; do not use example values |
| `ENABLE_AUTH` | `false` | change to `true` to require login (**strongly recommended for security**: the admin page holds sensitive content such as SMS OTP codes; default no-login means anyone who knows the domain can read every message) |
| `ADMIN_PASSWORD` | a password you make up | only needed when `ENABLE_AUTH="true"` |
| `SESSION_SECRET` | high-entropy random value (≥32 random characters) | only needed when `ENABLE_AUTH="true"`; independent from the password; if missing, login/auth fail closed, and after rotation all old sessions are invalidated |
| `RETENTION_DAYS` | `30` | data retention in days |
| `PORT` | default `8787` | normally no need to set it (Railway injects it automatically) |
| `FEISHU_WEBHOOK` (optional `FEISHU_SECRET`) | (optional) Feishu group bot Webhook | when configured, new messages are auto-forwarded to the Feishu group; when the bot's security setting is "Signature verification", also set `FEISHU_SECRET` |
| `WECOM_WEBHOOK` | (optional) WeCom group bot Webhook | when configured, new messages are auto-forwarded to the WeCom group |
| `DINGTALK_WEBHOOK` | (optional) DingTalk group bot Webhook | the signing security setting requires `DINGTALK_SECRET` as well |
| `SERVERCHAN_SENDKEY` | (optional) ServerChan SendKey | WeChat push |
| `PUSHPLUS_TOKEN` | (optional) PushPlus token | WeChat push |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | (optional) Telegram Bot | both must be configured to take effect |
| `BARK_DEVICE_KEY` | (optional) Bark device Key | set `BARK_URL` for a self-hosted server; official by default |
| `NTFY_URL` (optional `NTFY_TOKEN`) | (optional) ntfy topic URL | full URL, e.g. `https://ntfy.sh/my-sms`; protected topics also need `NTFY_TOKEN` (Token or user:password) |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | (optional) Gotify | server address + application token |
| `RESEND_API_KEY` + `MAIL_TO` | (optional) Email (Resend) | optional `MAIL_FROM`, default `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS` (optional `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`) | (optional) generic webhook | comma-separated multiple URLs; optional template for a custom body; `GENERIC_WEBHOOK_HEADERS` (JSON string) for custom headers |
| `SITE_NAME` / `SITE_ICON` | (optional) | site name / icon URL |
| `NOTIFY_LINK` | (optional) | admin page home URL; when set, every notification channel gets an "Open admin" entry; omitted automatically when unset |

## Ingest the phone client and devices

Follow the [Deployment & Ingestion Guide](./DEPLOYMENT.md) to configure Android SmsForwarder and each device's notification pushes, using your service address as the domain.

## Notes & FAQ

- **Scheduled cleanup**: the process has a built-in daily cleanup at UTC 17:00 (01:00 Beijing time), no configuration needed. You can alternatively use a platform scheduler (Fly Machines Cron / Railway Cron) to call `GET /api/cron?token=<RECEIVE_TOKEN>` — pick one of the two
- **Advantage of a resident process**: no function duration cap; the `/api/wait` long poll matches the Cloudflare Worker experience, with the best real-time performance
- **Free tiers**: Fly.io no longer has a free tier (only a 7-day / 2-VM-hour trial for new accounts; adding a card switches to pay-as-you-go, and light usage costs very little); Railway offers a one-time $5 trial credit (valid 30 days), and the Hobby plan at $5/month includes matching usage credit — for long-term zero cost, the Cloudflare primary is the first choice
- **Data backup**: in Turso mode the data lives in Turso, so switching servers only requires reconfiguring the environment variables with no data loss; in local SQLite mode, periodically back up the `SQLITE_PATH` file
- **Login protection**: the login endpoint is rate-limited — 5 consecutive failures from the same IP lock it for 10 minutes (in-memory state, reset on process restart)
- **Login over http**: LAN IPs / http access without TLS can log in directly (the cookie degrades automatically and does not force Secure), and browsers such as Alook redirect normally after login
- **Log troubleshooting**: `fly logs` / Railway Deployments → Logs / `docker logs smstoweb`
