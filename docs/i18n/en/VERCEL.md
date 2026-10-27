# Vercel Deployment Guide

**English** | [简体中文](../../zh-CN/README.md) | [繁體中文](../../zh-TW/README.md) | [日本語](../../ja/README.md) | [한국어](../../ko/README.md) | [Español](../../es/README.md) | [Français](../../fr/README.md) | [Deutsch](../../de/README.md) | [Português (BR)](../../pt-BR/README.md)

> Synced from the English primary where applicable

Deploy SMSToWeb to Vercel (Edge Function + Turso database). The free tier is enough for personal use; about 15 minutes end to end.

**Files in this directory**: `api/[[...route]].js` (entry), `app.js` (core app), `db.js` (Turso adapter layer), `schema.sql` (table creation), `vercel.json` (includes the scheduled task configuration).

---

## One-click deploy (recommended)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb%2Ftree%2Fmain%2Fplatforms%2Fvercel&env=RECEIVE_TOKEN%2CTURSO_DATABASE_URL%2CTURSO_AUTH_TOKEN&project-name=sms-gateway&envDescription=%E6%8E%A8%E9%80%81%E9%89%B4%E6%9D%83%E5%AF%86%E9%92%A5%E4%B8%8E%20Turso%20%E6%95%B0%E6%8D%AE%E5%BA%93%E8%BF%9E%E6%8E%A5%E4%BF%A1%E6%81%AF&envLink=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb)

It is recommended to **first complete Step 2 below (create the Turso database) to obtain the connection info**, then click the button: Vercel will clone this platform's subdirectory into your repository and create the project; fill in `RECEIVE_TOKEN` (push auth secret, a long random string you make up) and the Turso URL / Token as prompted to deploy. After a successful deployment, **be sure to run the table creation SQL of Step 3 once** (Vercel cannot create tables automatically), otherwise the page opens with no data.

---

## Preparation

1. A GitHub account (Vercel deploys via a GitHub repository)
2. A Vercel account ([sign-up](https://vercel.com/signup), just log in with GitHub)

## Step 1: Prepare the code repository

1. Open the project's GitHub repository and click **Fork** at the top right (or use your own already-pushed repository)
2. Once forked, you have a copy of the project you can freely modify

## Step 2: Create the Turso database

Turso provides a SQLite-compatible database (free tier: 100 databases, 5GB storage, 500 million row reads per month).

1. Open [turso.tech](https://turso.tech), click **Start for free now**, log in with GitHub
2. Enter the console → **Create Database**:
   - Name: `sms-gateway`
   - Location: a region near you (e.g. Singapore / Hong Kong)
   - Type: Free
3. After creation, open the database detail page:
   - Note the **Database URL** (shaped like `libsql://sms-gateway-xxxx.turso.io`)
   - Click **Create Token** (or Turso Platform Tokens) to create an access token, and **copy and save it immediately** (shown only once)
4. Initialize the schema: database detail page → **Console** (web SQL console) → paste the entire content of this directory's [`schema.sql`](../../../platforms/vercel/schema.sql) → execute → wait for the success message (it creates the two tables `messages` and `devices`)

> The Turso CLI also works: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Step 3: Import the repository into Vercel

1. Log in at [vercel.com](https://vercel.com) → **Add New → Project**
2. Find your forked repository in the **Import Git Repository** list and click **Import**
3. On the configuration page, expand **Root Directory** and select `platforms/vercel`
   — Vercel automatically recognizes the `vercel.json` and `api/` directory inside, no other configuration needed
4. Do not click Deploy yet; first do the environment variable configuration of Step 4 (add them in the **Environment Variables** section on the same page)

## Step 4: Configure environment variables

Add them one by one in the deployment configuration page's **Environment Variables** (they can also be changed later in Project → Settings):

| Name | Value | Description |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | the URL noted in Step 2 |
| `TURSO_AUTH_TOKEN` | (the token from Step 2) | the one shown only once |
| `RECEIVE_TOKEN` | a long random string you make up | push auth; do not use example values |
| `ENABLE_AUTH` | `false` | change to `true` to require login |
| `ADMIN_PASSWORD` | a password you make up | only needed when `ENABLE_AUTH="true"` |
| `SESSION_SECRET` | high-entropy random value (≥32 random characters) | only needed when `ENABLE_AUTH="true"`; independent from the password; configure an independent value separately from other platforms; if missing, login/auth fail closed, and after rotation all old sessions are invalidated |
| `RETENTION_DAYS` | `30` | data retention in days |
| `CRON_SECRET` | **the same value as RECEIVE_TOKEN** | Vercel Cron automatically attaches `Bearer $CRON_SECRET` when calling /api/cron |
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

Once everything is filled in, click **Deploy** and wait about 1 minute for the deployment to finish.

## Step 5: Verify the deployment

1. On the deployment-finished page, click **Continue to Dashboard** and note the assigned domain at the top (shaped like `https://xxx.vercel.app`)
2. Open the domain in a browser; you should see the admin page (default "SMS Gateway"; with login enabled, the login page appears first)
3. Verify the push endpoint (replace `<domain>` and `<secret>` with yours):

```
curl "https://<domain>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Vercel deploy succeeded\"}"
```

A `{"success":true,...}` response means it works, and the message should appear on the web page immediately.

## Step 6: Ingest the phone client and devices

Follow the [Deployment & Ingestion Guide](./DEPLOYMENT.md) to configure Android SmsForwarder (SMS via `/api/receive`) and each device's notification pushes (via `/api/push`), using your `xxx.vercel.app` domain (or a bound custom domain).

To bind a custom domain: Project → **Settings → Domains** → Add, then add a CNAME record in your domain's DNS as prompted — the target value follows what the Domains page displays (Vercel assigns each project a dedicated `xxxxxx.vercel-dns.com` address).

## Notes & FAQ

- **Scheduled cleanup**: `vercel.json` is configured to call `/api/cron` daily at UTC 17:00 (01:00 Beijing time) to clean up expired data. Vercel Cron automatically attaches `Authorization: Bearer $CRON_SECRET`, so `CRON_SECRET` must match `RECEIVE_TOKEN`
- **Hobby (free) plan limits**: cron supports only once per day (this project runs exactly once a day, so it fits; the actual trigger moment may drift within the configured hour, which is normal); Edge functions must **start returning a response within 25 seconds** (afterwards they can keep streaming for 300 seconds); the admin page's `/api/wait` long poll hangs for exactly 25 seconds, right at the boundary — if it is truncated early, the frontend polling loop retries automatically, **functionality is unaffected**, only new-message alerts may be slightly delayed
- **Edge Runtime**: the entry declares `runtime = "edge"`, giving fast cold starts and execution on global edge nodes
- **Deployment failure troubleshooting**: most often a missed environment variable — missing `TURSO_*` yields 500 with a "config error"; check that Root Directory is set to `platforms/vercel`
- **Updating code**: push to your forked repository and Vercel redeploys automatically
