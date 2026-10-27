# Tencent EdgeOne Makers Deployment Guide

**English** | [简体中文](../../zh-CN/README.md) | [繁體中文](../../zh-TW/README.md) | [日本語](../../ja/README.md) | [한국어](../../ko/README.md) | [Español](../../es/README.md) | [Français](../../fr/README.md) | [Deutsch](../../de/README.md) | [Português (BR)](../../pt-BR/README.md)

> Synced from the English primary where applicable

Deploy SMSToWeb to Tencent EdgeOne Makers (formerly EdgeOne Pages; Functions + Turso database). Good experience for mainland China access; about 15 minutes end to end.

**Files in this directory**: `functions/index.js` (dedicated entry for the root path `/`, the single source of all logic and the ENV_KEYS whitelist), `functions/[[default]].js` (fallback catching all other routes; it only re-exports index.js and needs no separate maintenance), `app.js` (core app), `db.js` (Turso adapter layer), `schema.sql` (table creation).

---

## Preparation

1. A Tencent Cloud account ([sign-up](https://cloud.tencent.com), real-name verification required)
2. A GitHub account (EdgeOne Makers supports deploying from a Git repository)

## Step 1: Prepare the code repository

Open the project's GitHub repository and click **Fork** at the top right (or use your own already-pushed repository).

## Step 2: Create the Turso database

Turso provides a SQLite-compatible database (free tier: 100 databases, 5GB storage, 500 million row reads per month). EdgeOne Functions reach external databases without restriction.

1. Open [turso.tech](https://turso.tech), click **Start for free now**, log in with GitHub
2. Enter the console → **Create Database**:
   - Name: `sms-gateway`
   - Location: Singapore / Hong Kong recommended (low latency from mainland China)
   - Type: Free
3. After creation, open the database detail page:
   - Note the **Database URL** (shaped like `libsql://sms-gateway-xxxx.turso.io`)
   - Click **Create Token** to create an access token, and **copy and save it immediately** (shown only once)
4. Initialize the schema: database detail page → **Console** → paste the entire content of this directory's [`schema.sql`](../../../platforms/edgeone/schema.sql) → execute → wait for the success message

> The Turso CLI also works: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Step 3: Create the project in EdgeOne Makers

1. Log in to the Tencent Cloud console → search **EdgeOne Makers** (formerly "EdgeOne Pages", or visit [console.cloud.tencent.com/edgeone/pages](https://console.cloud.tencent.com/edgeone/pages))
2. Click **Create project** → choose **import from a Git repository** → authorize GitHub and select your forked repository
3. Build configuration:
   - **Root directory**: `platforms/edgeone`
   - Framework preset: choose "No framework / Other" or leave it empty (pure Functions need no build)
4. Add the variables in the environment variable section first (see Step 4), then start the deployment
5. Wait for the deployment to finish (about 1 minute) and note the assigned default domain (e.g. `*.edgeone.app`)

## Step 4: Configure environment variables

Add them one by one under the project's **Settings → Environment variables** (Functions read them via the `env` parameter of `onRequest`):

| Name | Value | Description |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | the URL noted in Step 2 |
| `TURSO_AUTH_TOKEN` | (the token from Step 2) | the one shown only once |
| `RECEIVE_TOKEN` | a long random string you make up | push auth; do not use example values |
| `ENABLE_AUTH` | `false` | change to `true` to require login |
| `ADMIN_PASSWORD` | a password you make up | only needed when `ENABLE_AUTH="true"` |
| `SESSION_SECRET` | high-entropy random value (≥32 random characters) | only needed when `ENABLE_AUTH="true"`; independent from the password; configure an independent value separately from other platforms; if missing, login/auth fail closed, and after rotation all old sessions are invalidated |
| `RETENTION_DAYS` | `30` | data retention in days |
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

After saving, redeploy for the changes to take effect.

## Step 5: Verify the deployment

1. Open the assigned domain in a browser; you should see the admin page (default "SMS Gateway"; with login enabled, the login page appears first)
2. Verify the push endpoint:

```
curl "https://<domain>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"EdgeOne deploy succeeded\"}"
```

A `{"success":true,...}` response means it works, and the message should appear on the web page immediately.

## Step 6: Bind a custom domain (recommended for mainland China access)

1. Project **Settings → Custom domains** → add your domain (e.g. `sms.your-domain.com`)
2. Add a CNAME record in the domain's DNS pointing to the address EdgeOne assigned, as prompted
3. The domain must have completed ICP filing (a requirement of Tencent Cloud's mainland nodes); unfiled domains are refused resolution

## Step 7: Configure scheduled cleanup (external cron)

EdgeOne Makers has no native scheduled tasks yet; use any free external cron service to call the cleanup endpoint once a day:

1. Open [cron-job.org](https://cron-job.org), sign up, and **Create cronjob**:
   - URL: `https://<your-domain>/api/cron?token=<your RECEIVE_TOKEN>`
   - Schedule: daily (e.g. 01:00 Beijing time, i.e. UTC 17:00)
2. Save and enable it. When the time comes, the gateway automatically deletes data older than `RETENTION_DAYS` days

## Ingest the phone client and devices

Follow the [Deployment & Ingestion Guide](./DEPLOYMENT.md) to configure Android SmsForwarder and each device's notification pushes, using your EdgeOne domain.

## Notes & FAQ

- **Root path 404 (important, verified in practice 2026-10)**: in EdgeOne Makers' Functions routing rules, the `[[default]].js` fallback only matches non-root paths such as `/foo` and `/api/xxx`; **the root path `/` only recognizes `functions/index.js`** — without that file, opening the home page hits the platform's default 404 page (while the API endpoints still work). This directory ships `functions/index.js` to solve it (the single source of the logic and the ENV_KEYS whitelist; `[[default]].js` only re-exports it, so nothing needs maintaining twice)
- **Long polling**: the Functions execution duration cap is rather tight, so `/api/wait` (hanging 25 seconds) may be truncated early — the frontend retries automatically and functionality is unaffected
- **Deployment failure troubleshooting**: the root directory must be `platforms/edgeone`; missing `TURSO_*` environment variables yield 500 with a "config error"
- **Updating code**: push to the GitHub repository and it redeploys automatically
