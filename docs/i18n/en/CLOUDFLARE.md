# Cloudflare Deployment Guide (primary version, fully browser-based)

**English** | [简体中文](../../zh-CN/README.md) | [繁體中文](../../zh-TW/README.md) | [日本語](../../ja/README.md) | [한국어](../../ko/README.md) | [Español](../../es/README.md) | [Français](../../fr/README.md) | [Deutsch](../../de/README.md) | [Português (BR)](../../pt-BR/README.md)

> Synced from the English primary where applicable

This is the project's primary version: phone SMS/notifications → Cloudflare Worker → D1 database → web admin page.
No server required, generous free tier, and everything can be done by clicking through web pages — no tools to install.

This directory is **fully self-contained**: [`worker.js`](../../../platforms/cloudflare/worker.js) (deployment source) + [`schema.sql`](../../../platforms/cloudflare/schema.sql) (table creation script) + [`wrangler.toml`](../../../platforms/cloudflare/wrangler.toml) (optional config for CLI deployment), with no dependency on other repo files. For the other platforms, see the [platform overview](../../../platforms/README.md).

---

## One-click deploy (recommended for beginners)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

Clicking the button above, Cloudflare automatically: clones the code into your GitHub → **creates the D1 database and runs the table creation automatically** → binds resources → sets up CI (every future push to your repo redeploys automatically) → goes live. Along the way it prompts for two secrets:

- `RECEIVE_TOKEN`: push auth secret; make up a sufficiently long random string (`token=` in the device ingestion URLs must match it)
- `ADMIN_PASSWORD`: admin page login password (**strongly recommended to set** — the admin page holds sensitive content such as SMS OTP codes; when `ENABLE_AUTH="true"` but this is missing, admin APIs refuse access rather than opening the door login-free)
- `SESSION_SECRET`: login session signing secret, **required when login is enabled** — a high-entropy random value (≥32 random characters, e.g. generated with `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`), fully independent from the password; if missing, login and auth fail closed (login 500, admin APIs 401) with no password-derived fallback; after rotation all old sessions are invalidated immediately

> To bind a custom domain (e.g. `sms.example.com`): after deployment, open the Worker → Settings → Domains & Routes → Add custom domain.
> The manual tutorial below is kept for those who do not want the one-click flow, or want to understand every step.

## Preparation

1. A Cloudflare account ([sign-up](https://dash.cloudflare.com/sign-up), free, an email is enough)
2. The project code (the [`worker.js`](../../../platforms/cloudflare/worker.js) in this directory is the entire code to paste)

## Step 1: Create the D1 database

1. Log in at [dash.cloudflare.com](https://dash.cloudflare.com)
2. Left menu **Storage & Databases → D1 SQL Database**
3. Click **Create Database**, name it `sms-gateway-db` (leave everything else default), click create
4. Open the newly created database → the **Console** tab
5. Copy-paste the entire content of this directory's [`schema.sql`](../../../platforms/cloudflare/schema.sql) into the input box and click **Execute**
6. Wait for the success message (it creates the two tables `messages` and `devices`)

## Step 2: Create the Worker and paste the code

1. Left menu **Compute (Workers) → Workers & Pages**
2. Click **Create application**, choose **Start with Hello World!** (start from the Hello World template), name it `sms-gateway`, click **Deploy** (deploying the default code successfully first is fine)
3. Click **Edit code** and delete all the default code in the editor
4. Open this directory's [`worker.js`](../../../platforms/cloudflare/worker.js), select all and copy, paste it into the editor
5. Click **Deploy** at the top right; wait for the deployment success message

## Step 3: Bind the D1 database

1. Back on the Worker overview page → the **Bindings** tab
2. Click **Add → D1 database**
3. Put `DB` into the variable name (must be exactly this, uppercase), and select the `sms-gateway-db` you just created
4. Click **Deploy/Save**

## Step 4: Set variables and secrets

In the same place, **Settings → Variables and Secrets**, add them one by one:

1. **Add variable** (type "Text"):
   - Name `RETENTION_DAYS`, value `30` (to keep 90 days, put `90`)
   - Name `ENABLE_AUTH`, value `false` (**strongly recommended to put `true` and enable login**: the admin page holds sensitive content such as SMS OTP codes; no login is open to anyone who knows the domain. If you deploy automatically from the repo via Workers Builds, this value follows the `wrangler.toml` in the repo — currently `true` by default)
   - Name `SITE_NAME` (optional), value a custom site name, e.g. `My SMS Site`
   - Name `SITE_ICON` (optional), value an icon URL (starting with `http(s)://`); if unset or the URL is dead, the built-in icon is used automatically
   - Name `NOTIFY_LINK` (optional), value the admin page home URL (starting with `http(s)://`); when set, every notification channel gets an "Open admin" entry
2. **Add secret** (type "Secret"):
   - Name `RECEIVE_TOKEN`, value a sufficiently long random string you make up yourself (do not use any tutorial example value; the longer the better)
   - Name `ADMIN_PASSWORD`, value an admin page login password you make up yourself (only needed when `ENABLE_AUTH="true"`)
   - Name `SESSION_SECRET`, value a high-entropy random string (≥32 random characters, independent from the password; only needed when `ENABLE_AUTH="true"`)
3. Click **Deploy/Save** after each addition

> Changing these values takes effect immediately, no need to re-paste the code. After changing `RECEIVE_TOKEN`, remember to update `token=` in the device-side URLs accordingly.

## Step 5 (optional): Configure notification forwarding channels

After new messages are stored, they can be auto-forwarded to external channels; **whichever channel's variable you configure is the one that forwards; with none configured nothing is forwarded**.
Just add the corresponding variables on the same "Variables and Secrets" page:

| Channel | Variable | Description |
|---|---|---|
| Feishu group bot | `FEISHU_WEBHOOK` (optional `FEISHU_SECRET`) | group bot Webhook URL; when the bot's security setting is "Signature verification", also set `FEISHU_SECRET` |
| WeCom group bot | `WECOM_WEBHOOK` | group bot Webhook URL |
| DingTalk group bot | `DINGTALK_WEBHOOK` (optional `DINGTALK_SECRET`) | the signing security setting requires `DINGTALK_SECRET` |
| ServerChan | `SERVERCHAN_SENDKEY` | SendKey (WeChat push) |
| PushPlus | `PUSHPLUS_TOKEN` | token (WeChat push) |
| Telegram Bot | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Bot token + chat/group ID |
| Bark | `BARK_DEVICE_KEY` (optional `BARK_URL`) | set `BARK_URL` for a self-hosted server; official by default |
| ntfy | `NTFY_URL` (optional `NTFY_TOKEN`) | full topic URL, e.g. `https://ntfy.sh/my-sms`; protected topics also need `NTFY_TOKEN` (Token or user:password) |
| Gotify | `GOTIFY_URL` + `GOTIFY_TOKEN` | server address (without `/message`) + application token |
| Email (Resend) | `RESEND_API_KEY` + `MAIL_TO` (optional `MAIL_FROM`) | `MAIL_FROM` defaults to `onboarding@resend.dev` |
| Generic webhook | `GENERIC_WEBHOOKS` (optional `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`) | comma-separated multiple URLs; template for a custom body, headers as JSON — third-party APIs (SMS gateways, etc.) integrate this way |

For each channel's application/acquisition steps and body formats, see [Deployment & Ingestion Guide · Notification forwarding channels](./DEPLOYMENT.md).
Channels forward concurrently; a single channel's failure does not affect the others or message ingestion; duplicate messages (`duplicated`) are not forwarded again.
Notifications auto-render in three modes by content (🔐 code reminder / 💬 new SMS / 🔔 device notification): detected codes go into the title automatically and trigger per-platform enhancements (Bark copies the code on tap, Bark/ntfy raise priority, Feishu violet card header, etc.).

## Step 6: Set up the scheduled cleanup task

1. Worker → **Settings → Triggers → Cron Triggers**
2. Click **Add Cron Trigger**, put in `0 17 * * *`, save
3. Meaning: every day at UTC 17:00 (1:00 AM Beijing time), automatically delete data older than the retention days

## Step 7: Bind a domain (optional, recommended)

1. Worker → **Settings → Domains & Routes**
2. Click **Add → Custom domain**, put in a subdomain (e.g. `sms.your-domain.com`)
3. Cloudflare automatically creates the DNS record and issues an HTTPS certificate; it takes effect within a few minutes
4. From then on, visiting `https://sms.your-domain.com` in a browser is the admin page

> Without a domain, the default `https://sms-gateway.<your-subdomain>.workers.dev` address works too.

## Step 8: Verify the deployment

Opening the admin page in a browser should show your site name page (default "SMS Gateway", changeable via `SITE_NAME`; if login is enabled, the login page appears first). Then verify the ingestion endpoint (replace `<domain>` and `<secret>` with yours):

```
curl "https://<domain>/api/receive?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"name\":\"test\",\"sim\":\"13800138000\",\"from\":\"10086\",\"content\":\"deploy test\"}"
```

A `{"success":true,...}` response means it works. You can delete this test SMS on the web page.

## Ingest the phone client and devices

Follow the [Deployment & Ingestion Guide](./DEPLOYMENT.md) to configure Android SmsForwarder and each device's notification pushes; just replace the API domain with your Worker address.

## CLI deployment (alternative, for those comfortable installing wrangler)

Run in this directory (contains `wrangler.toml`, with `main` already pointing at this directory's `worker.js`):

```bash
npm install wrangler        # officially recommended to install within the project; global npm install -g wrangler also works
npx wrangler login
npx wrangler d1 execute sms-gateway-db --file=schema.sql --remote
npx wrangler secret put RECEIVE_TOKEN
npx wrangler secret put ADMIN_PASSWORD   # only needed when login is enabled
npx wrangler secret put SESSION_SECRET   # only needed when login is enabled (high-entropy random value, independent from the password)
npx wrangler deploy
```

## Notes & FAQ

- **Forwarded SMS not arriving**: troubleshoot in order — ① the SmsForwarder general setting's "forward SMS broadcast" master switch (the easiest to miss; when off it silently drops messages while all channel tests stay green) → ② whether the forwarding rule's token/URL matches the Worker secret → ③ the Worker's live logs for whether requests arrive
- **Notification channel received nothing**: confirm the corresponding channel variables are configured and correct; check the Worker live logs for `notify forward failed:`; messages with `duplicated:true` are not forwarded
- **Worker free tier**: 100,000 requests per day, more than enough for personal use; D1 free tier is 5 million row reads per day
- **Long polling**: the admin page's `/api/wait` hangs up to 25 seconds waiting for new messages; Workers have no request-duration issues, so real-time performance is the best
- **Data migration**: when migrating back to CF from another platform, just export the Turso data and import it into D1 (the table schemas are fully identical)
