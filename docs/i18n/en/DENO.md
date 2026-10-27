# Deno Deploy Deployment Guide

**English** | [简体中文](../../zh-CN/README.md) | [繁體中文](../../zh-TW/README.md) | [日本語](../../ja/README.md) | [한국어](../../ko/README.md) | [Español](../../es/README.md) | [Français](../../fr/README.md) | [Deutsch](../../de/README.md) | [Português (BR)](../../pt-BR/README.md)

> Synced from the English primary where applicable

Deploy SMSToWeb to Deno Deploy (Deno native runtime + Turso database). Semantically the closest to a Cloudflare Worker; the free tier is 1 million requests per month; about 15 minutes end to end.

> Platform note: Deno Deploy has been upgraded to a new-generation platform with the console at [console.deno.com](https://console.deno.com) (the old dash.deno.com has been shut down), using a CI-like Git build model.

**Files in this directory**: `main.js` (entry, with `Deno.serve` and the built-in `Deno.cron` scheduled cleanup), `app.js` (core app), `db.js` (Turso adapter layer), `schema.sql` (table creation).

---

## Preparation

1. A GitHub account
2. A Deno Deploy account ([sign-up](https://console.deno.com), just log in with GitHub)

## Step 1: Prepare the code repository

1. Open the project's GitHub repository and click **Fork** at the top right (or use your own already-pushed repository)

## Step 2: Create the Turso database

Turso provides a SQLite-compatible database (free tier: 100 databases, 5GB storage, 500 million row reads per month).

1. Open [turso.tech](https://turso.tech), click **Start for free now**, log in with GitHub
2. Enter the console → **Create Database**:
   - Name: `sms-gateway`
   - Location: a region near you (e.g. Singapore / Hong Kong)
   - Type: Free
3. After creation, open the database detail page:
   - Note the **Database URL** (shaped like `libsql://sms-gateway-xxxx.turso.io`)
   - Click **Create Token** to create an access token, and **copy and save it immediately** (shown only once)
4. Initialize the schema: database detail page → **Console** → paste the entire content of this directory's [`schema.sql`](../../../platforms/deno/schema.sql) → execute → wait for the success message

> The Turso CLI also works: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Step 3: Create the app in Deno Deploy and link the repository

1. Log in at [console.deno.com](https://console.deno.com) → click **+ New App**
2. Choose **deploy from a GitHub repository**, authorize, and select your forked repository
3. Configure the build (Build Configuration):
   - **Runtime working directory**: `platforms/deno`
   - **Entrypoint**: `main.js`
4. Add the environment variables first (see Step 4), then trigger the first deployment
5. Once deployed, pushing to the GitHub repository rebuilds automatically

## Step 4: Configure environment variables

Add them one by one under the app's **Settings → Environment Variables** (they can also be added on the configuration page while creating the app):

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

After saving, wait for the automatic redeployment to take effect.

## Step 5: Verify the deployment

1. Note the assigned domain (shaped like `https://<app-name>.<org-name>.deno.net`)
2. Open the domain in a browser; you should see the admin page (default "SMS Gateway"; with login enabled, the login page appears first)
3. Verify the push endpoint:

```
curl "https://<domain>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Deno Deploy succeeded\"}"
```

A `{"success":true,...}` response means it works, and the message should appear on the web page immediately.

## Step 6: Ingest the phone client and devices

Follow the [Deployment & Ingestion Guide](./DEPLOYMENT.md) to configure Android SmsForwarder and each device's notification pushes, using your `xxx.deno.net` domain.

Custom domain: add the domain under your organization's **Domains** tab and assign it to your app, then add a CNAME (or A record) plus the verification record in the domain's DNS as prompted; the HTTPS certificate is issued automatically.

## Notes & FAQ

- **Scheduled cleanup**: `Deno.cron` registers automatically at deployment (daily at UTC 17:00 = 01:00 Beijing time); no extra configuration is needed, and it cannot be triggered manually for testing — verify by watching the Turso data shrink on schedule
- **Free tier**: 1 million requests per month, 10 hours of Active CPU, 20GiB outbound traffic — more than enough for personal use
- **Long polling**: Deno Deploy has no strict per-request duration cap, so the 25-second `/api/wait` long poll works well; idle instances may be recycled and restarted by the platform (interrupted long polls are retried automatically by the frontend), and real-time performance is essentially the same as the Worker version
- **Deployment failure troubleshooting**: the Entrypoint must be `main.js` and the runtime working directory must be `platforms/deno`; missing `TURSO_*` environment variables yield 500 with a "config error"
- **Updating code**: push to the GitHub repository and it redeploys automatically
