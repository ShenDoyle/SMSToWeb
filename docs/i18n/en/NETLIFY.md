# Netlify Deployment Guide

**English** | [简体中文](../../zh-CN/README.md) | [繁體中文](../../zh-TW/README.md) | [日本語](../../ja/README.md) | [한국어](../../ko/README.md) | [Español](../../es/README.md) | [Français](../../fr/README.md) | [Deutsch](../../de/README.md) | [Português (BR)](../../pt-BR/README.md)

> Synced from the English primary where applicable

Deploy SMSToWeb to Netlify (Functions v2 + Turso database). About 15 minutes end to end.

**Files in this directory**: `functions/api.mjs` (entry, `path: "/*"` catches all routes), `functions/cron.mjs` (scheduled cleanup Scheduled Function), `app.js` (core app), `db.js` (Turso adapter layer), `schema.sql` (table creation), `netlify.toml` (site configuration).

---

## One-click deploy (recommended)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/ShenDoyle/SMSToWeb)

Clicking the button clones the repository into your GitHub and enters the creation wizard. Two things to note:

1. **In the build configuration, put `platforms/netlify` into Base directory** (this platform's `netlify.toml` lives in that subdirectory; once set correctly, the build commands etc. take over automatically); leave everything else default
2. It is recommended to first complete Step 2 below (create the Turso database) to obtain the connection info; after creation, fill in `RECEIVE_TOKEN` / `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` under **Site configuration → Environment variables** and redeploy; finally run the table creation SQL of Step 3 (Netlify cannot create tables automatically)

---

## Preparation

1. A GitHub account
2. A Netlify account ([sign-up](https://app.netlify.com/signup), just log in with GitHub)

## Step 1: Prepare the code repository

Open the project's GitHub repository and click **Fork** at the top right (or use your own already-pushed repository).

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
4. Initialize the schema: database detail page → **Console** → paste the entire content of this directory's [`schema.sql`](../../../platforms/netlify/schema.sql) → execute → wait for the success message

> The Turso CLI also works: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Step 3: Import the repository into Netlify

1. Log in at [app.netlify.com](https://app.netlify.com) → **Add new project → Import an existing project**
2. Choose **Deploy with GitHub**, authorize, then pick your forked repository from the list
3. On the deployment configuration page (Site settings for…):
   - **Base directory**: put `platforms/netlify`
   - Build command / Publish directory: keep the defaults (`netlify.toml` is in the directory and takes effect automatically)
4. Expand **Show advanced → New variable** below, add the environment variables first (see Step 4), then click **Deploy**

## Step 4: Configure environment variables

Add them in the deployment configuration page's advanced options (they can also be changed later in **Project configuration → Environment variables**):

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

Click **Deploy** and wait about 1 minute for the deployment to finish.

## Step 5: Verify the deployment

1. Once the deployment finishes, note the site domain (shaped like `https://xxx.netlify.app`)
2. Open the domain in a browser; you should see the admin page (default "SMS Gateway"; with login enabled, the login page appears first)
3. Verify the push endpoint:

```
curl "https://<domain>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Netlify deploy succeeded\"}"
```

A `{"success":true,...}` response means it works, and the message should appear on the web page immediately.

## Step 6: Ingest the phone client and devices

Follow the [Deployment & Ingestion Guide](./DEPLOYMENT.md) to configure Android SmsForwarder and each device's notification pushes, using your `xxx.netlify.app` domain.

Custom domain: **Project configuration → Change site name** (change the subdomain) or **Domain management → Add a domain** (your own domain; add DNS as prompted).

## Notes & FAQ

- **Scheduled cleanup**: `functions/cron.mjs` is a Netlify Scheduled Function and registers automatically after deployment (daily at UTC 17:00 = 01:00 Beijing time), with no extra configuration. To verify: the site's **Functions** page shows the `cron` function and its schedule status
- **Function duration & real-time performance**: the default function execution cap is now 60 seconds (identical across plans), so the admin page's `/api/wait` long poll (hanging 25 seconds) can wait in full and real-time performance is good; if you need extreme real-time performance, the Cloudflare / self-hosted versions are still the better pick
- **Free tier**: starting 2025-09, new accounts use credit-based billing (the Free plan includes 300 credits per month, with function usage counted in GB-hours), enough for small personal traffic; older accounts can stay on their original plan
- **Deployment failure troubleshooting**: Base directory must be `platforms/netlify`; missing `TURSO_*` environment variables yield 500 with a "config error"; check the site's **Functions → api → logs** for details
- **Updating code**: push to the GitHub repository and it redeploys automatically
