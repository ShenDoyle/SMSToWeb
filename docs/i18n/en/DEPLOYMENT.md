# SMSToWeb Multi-Platform Deployment & Ingestion Guide

**English** | [简体中文](../../zh-CN/README.md) | [繁體中文](../../zh-TW/README.md) | [日本語](../../ja/README.md) | [한국어](../../ko/README.md) | [Español](../../es/README.md) | [Français](../../fr/README.md) | [Deutsch](../../de/README.md) | [Português (BR)](../../pt-BR/README.md)

> Synced from the English primary where applicable

This system consists of two parts: **ingestion clients** (push clients on each device) + **cloud gateway** (choose one of six platforms: Cloudflare / Vercel / Deno / Netlify / EdgeOne Makers / Docker self-hosted — see [platforms/README.md](../../../platforms/README.md); the ingestion method is identical across them).
SMS is only one ingestion path — any device or script that can send an HTTP request can push notifications into the same web page.

```
Android (SmsForwarder)──┐  SMS + app notifications
iOS (Shortcuts)─────────┤
Linux (curl/ntfy)───────┼──→ POST /api/receive (SMS) or /api/push (universal notifications)
Windows (PowerShell)────┤         │
macOS (Shortcuts)───────┘         ▼
                        Cloudflare Worker ──→ D1 storage ──→ unified web page (source filter)
                              │
                              └──(optional) multi-channel notifications → Feishu/WeCom/DingTalk/TG/Bark/Email…
```

---

## Part 1: Cloud Configuration (Cloudflare Side)

### 1. Variables & secrets

After deploying the Worker, configure them in **Workers & Pages → sms-gateway → Settings → Variables and Secrets**:

| Name | Type | Required | Description |
|---|---|---|---|
| `RECEIVE_TOKEN` | Secret | yes | push auth token; make up your own random string (do not use the example value) |
| `ADMIN_PASSWORD` | Secret | when login is enabled | admin page login password, strong password recommended; if missing, admin APIs refuse access (missing config never opens the door) and an alert is logged |
| `ENABLE_AUTH` | Text | no | `"true"` enables login (**strongly recommended for security**: the admin page holds sensitive content such as SMS OTP codes; default no-login is open to anyone who knows the domain); `"false"` or unset means no login |
| `FEISHU_WEBHOOK` | Text | no | Feishu group bot Webhook; when configured, new messages are auto-forwarded to the Feishu group (for signature verification also set `FEISHU_SECRET`) |
| `FEISHU_SECRET` | Secret | no | only when the Feishu bot security setting is "Signature verification"; the program computes the signature automatically |
| `WECOM_WEBHOOK` | Text | no | WeCom group bot Webhook |
| `DINGTALK_WEBHOOK` | Text | no | DingTalk group bot Webhook (the signing security setting requires `DINGTALK_SECRET` as well) |
| `SERVERCHAN_SENDKEY` | Text | no | ServerChan SendKey (WeChat push) |
| `PUSHPLUS_TOKEN` | Text | no | PushPlus token (WeChat push) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Text | no | Telegram Bot token + chat/group ID |
| `BARK_DEVICE_KEY` | Text | no | Bark device Key (for a self-hosted server also set `BARK_URL`; official by default) |
| `NTFY_URL` | Text | no | full ntfy topic URL, e.g. `https://ntfy.sh/my-sms` (protected topics also need `NTFY_TOKEN`) |
| `NTFY_TOKEN` | Text | no | access token for a protected ntfy topic: enter the Access Token directly (uses Bearer); on self-hosted servers use `user:password` (uses Basic) |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | Text | no | Gotify server address (without `/message`) + application token |
| `RESEND_API_KEY` + `MAIL_TO` | Text | no | email (Resend API); optional `MAIL_FROM`, default `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS` | Text | no | generic webhook, comma-separated multiple URLs; optional `GENERIC_WEBHOOK_TEMPLATE` for a custom body and `GENERIC_WEBHOOK_HEADERS` for custom headers |
| `GENERIC_WEBHOOK_HEADERS` | Text | no | generic webhook custom headers as a JSON object string, e.g. `{"Authorization":"Bearer xxx"}` |
| `NOTIFY_LINK` | Text | no | admin page home URL; when set, every notification channel gets an "Open admin" entry (Feishu button, per-channel link line, Bark url, ntfy click, etc.); omitted automatically when unset |
| `SESSION_SECRET` | Secret | required when login is enabled | login session signing secret: **high-entropy random value (≥32 random characters recommended), fully independent from the admin password**; Cloudflare and EdgeOne (and every other platform) must each be configured with their own value; never commit it to Git or reuse the password. If missing, login and auth fail closed (login 500, admin APIs 401) with no password-derived fallback. After rotation all old sessions are invalidated immediately and re-login is required; sessions last 30 minutes — logout only clears the browser cookie, and a copied token remains valid within its TTL |
| `RETENTION_DAYS` | Text | no | data retention in days, default 30; changes take effect immediately |
| `WAIT_MAX_SECONDS` | Text | no | max seconds the `/api/wait` long poll may hang, default 25 (3–25). **Netlify Functions has a default 10s cap → recommended `8`**; Vercel Edge recommends `20`. The frontend backs off exponentially on failure and will not flood the function |

> **Two security notes**
> 1. Admin page login (`ENABLE_AUTH="true"`) is strongly recommended together with a strong `ADMIN_PASSWORD`; the login endpoint is rate-limited (5 consecutive failures per IP locks it for 10 minutes), and `/api/receive` and `/api/push` return 429 beyond 120 writes per IP per minute (recovering automatically shortly after).
> 2. Push token via `?token=` in the URL (SmsForwarder compatibility): the token appears in the URL and may end up in platform access logs; if that concerns you, switch to POST + the `Authorization: Bearer <RECEIVE_TOKEN>` header — both methods are supported.

### 2. Notification forwarding channels (optional; configure only what you use)

Add the corresponding variable on the deployment platform's "Environment variables / Variables" page to enable a channel; **with none set nothing is forwarded, and message ingestion and web viewing are unaffected**.
Channels forward concurrently; a single channel's failure does not affect the others; duplicate messages (`duplicated:true`) are not forwarded again.

Notifications auto-render in **three modes** by content (identical across all channels): a detected code → **code reminder** (the code goes into the title/card large text; a Bark notification copies the code on tap, and Bark and ntfy raise priority); an SMS without a code → **new SMS**; app/device pushes → **device notification**. With the optional `NOTIFY_LINK` variable set, every channel automatically gets an "Open admin" entry; it is omitted when unset.

The generic webhook default body is JSON and includes the new `type` (`verify`/`sms`/`notify`) and `code` (detected code, empty string if none) fields; the `GENERIC_WEBHOOK_TEMPLATE` placeholders support `{{type}}`/`{{code}}` accordingly.

Application steps per channel:

**Feishu group bot** — `FEISHU_WEBHOOK` (optional `FEISHU_SECRET`)
1. In the target Feishu group → Settings → Group bots → Add bot → **Custom bot**
2. Copy the Webhook URL, shaped like `https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx`, into the variable
3. For the security setting choose one of three: **custom keyword** (recommended: just fill in a keyword such as `SMS`, no other configuration needed); **signature verification** (put the secret into `FEISHU_SECRET`, the program computes the signature); IP allowlist (Worker egress IPs are not fixed — do not choose it)

**WeCom group bot** — `WECOM_WEBHOOK`
1. In the target WeCom group → group settings at the top right → Group bots → Add bot → Create
2. Copy the Webhook URL, shaped like `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx`, into the variable

**DingTalk group bot** — `DINGTALK_WEBHOOK` (optional `DINGTALK_SECRET`)
1. In the target DingTalk group → Group settings → Smart group assistant → Add bot → **Custom** (Webhook integration)
2. For the security setting choose **signing** (recommended): put the displayed secret (starts with SEC) into `DINGTALK_SECRET`; if unset it connects directly without a signature
3. Copy the Webhook URL (shaped like `https://oapi.dingtalk.com/robot/send?access_token=xxxx`) into `DINGTALK_WEBHOOK`

**ServerChan (WeChat push)** — `SERVERCHAN_SENDKEY`
1. Open [sct.ftqq.com](https://sct.ftqq.com) and log in by scanning a WeChat QR code
2. Copy the **SendKey** from the home page (shaped like `SCTxxxxxxxxxxxx`) into the variable; messages are pushed to your WeChat "Fangtang" service account

**PushPlus (WeChat push)** — `PUSHPLUS_TOKEN`
1. Open [pushplus.plus](https://www.pushplus.plus) and log in by scanning a WeChat QR code
2. Copy the **token** from the home page into the variable; after following the official account, pushes arrive in WeChat

**Telegram Bot** — `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (both must be configured to take effect)
1. In TG, find [@BotFather](https://t.me/BotFather) → `/newbot` and follow the prompts → you get a Bot Token (shaped like `123456:ABC-xxx`)
2. Get the `chat_id`: send your Bot a message first, then open `https://api.telegram.org/bot<your-token>/getUpdates` in a browser and find `chat.id` in the returned JSON (for group chats, add the Bot to the group and send a message, then the group ID shows up the same way)
3. Put the two values into `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`

**Bark (iOS push)** — `BARK_DEVICE_KEY` (optional `BARK_URL`)
1. Install [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865) from the App Store, open the app and copy the Key part of the sample URL (`https://api.day.app/<this-is-the-Key>/...`)
2. Put the Key into `BARK_DEVICE_KEY`; for a self-hosted server also set `BARK_URL` (official `https://api.day.app` by default)

**ntfy (Android/iOS/web subscribe)** — `NTFY_URL` (optional `NTFY_TOKEN`)
1. Install the ntfy app on the phone (or use the [ntfy.sh](https://ntfy.sh) web app) and subscribe to a custom topic name, e.g. `my-sms-9f2k` (the more random the name, the more private)
2. Put the full topic URL into `NTFY_URL`: `https://ntfy.sh/my-sms-9f2k` (for a self-hosted server use your own address; reverse-proxy subpath deployment is supported)
3. When the topic has access control enabled, set `NTFY_TOKEN`: enter the Access Token (starts with `tk_`) directly; on a self-hosted server use the `username:password` format

**Gotify (self-hosted push service)** — `GOTIFY_URL` + `GOTIFY_TOKEN`
1. If you already self-host Gotify: log in on the web → **Apps** → create an app → copy the **Token**
2. Put the server address into `GOTIFY_URL` (e.g. `https://push.example.com`, **without** `/message`) and the Token into `GOTIFY_TOKEN`

**Email (Resend API)** — `RESEND_API_KEY` + `MAIL_TO` (optional `MAIL_FROM`)
1. Open [resend.com](https://resend.com) and sign up (free tier: 100 emails per day, 3000 per month)
2. **API Keys** → Create API Key, copy it into `RESEND_API_KEY`
3. Put the recipient address into `MAIL_TO` (comma-separate multiple addresses); when `MAIL_FROM` is unset the default is `onboarding@resend.dev` (that default sender can only send to the email you registered with Resend; to send to arbitrary addresses, verify your own domain in Resend and set `MAIL_FROM`)

**Generic webhook / third-party API** — `GENERIC_WEBHOOKS` (optional `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`)
1. Put one or more URLs into `GENERIC_WEBHOOKS` (**comma-separated**). Default POST JSON:

```json
{"title":"[SMS] 13800138000 ← 10086","content":"Body…","time":"2026-10-14 12:30:00 (Beijing time)","source":"sms","sender":"1069012345678","device":"My Phone"}
```

2. When the other end needs a specific format, set `GENERIC_WEBHOOK_TEMPLATE` and use the placeholders `{{title}}` / `{{content}}` / `{{time}}` / `{{source}}` / `{{sender}}` / `{{device}}` to customize the request body; if the template can be parsed as JSON it is sent as JSON, otherwise as plain text. Example:

```
{"phone":"13800138000","msg":"{{content}}","at":"{{time}}"}
```

3. When the other end needs auth headers (keep the secret out of the URL), set `GENERIC_WEBHOOK_HEADERS` to a JSON object string, e.g.:

```json
{"Authorization":"Bearer sk-xxx","X-Api-Key":"yyy"}
```

If this value is not valid JSON it is ignored and does not affect default forwarding. SMS gateways, Home Assistant, n8n, self-built scripts — any third-party API can integrate via this template. The variable names and configuration locations for each channel are in the "Variables & secrets" table above; Cloudflare configures them on the Worker's "Variables and Secrets" page, while the other platforms configure them in the environment variables section of each platform guide.

### 3. Database

The D1 `messages` table needs the `source` (distinguishes SMS/notifications) and `deleted_at` (soft delete/undo) columns. For fresh deployments run [schema.sql](../../../schema.sql) directly; for upgrading an old database run:

```sql
ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'sms';
ALTER TABLE messages ADD COLUMN deleted_at TEXT;
ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN read_at TEXT;
```

---

## Part 2: Push API Specification

The two public endpoints share `RECEIVE_TOKEN` auth (the token may go in the query or the body):

### 1. SMS ingestion `POST /api/receive` (dedicated to the Android app)

```
POST https://<your-domain>/api/receive?token=<RECEIVE_TOKEN>
Content-Type: application/json

{
  "name": "My Phone",
  "sim": "13800138000",
  "from": "1069012345678",
  "content": "Your code is 734752, valid for 5 minutes",
  "time": "2026-10-14 12:29:59"
}
```

### 2. Universal push `POST /api/push` (device notifications)

```
POST https://<your-domain>/api/push
Content-Type: application/json

{
  "token": "<RECEIVE_TOKEN>",
  "source": "notify",
  "sender": "backup-script",
  "name": "Notify Gateway",
  "content": "Database backup finished in 3m12s",
  "time": "2026-10-14 03:00:00"
}
```

| Field | Required | Description |
|---|---|---|
| `token` | yes | auth token |
| `content` | yes | message body (`text`/`message`/`msg` are also accepted) |
| `source` | no | source label, default `notify`; used by the web page's "source filter", customizable (e.g. `cron`, `alert`) |
| `sender` | no | source title (hostname/app name/script name) |
| `name` | no | device label name (custom naming), default "Notify Gateway", shown alongside SMS labels |
| `time` | no | event time; the server's current time by default; accepts a timestamp or `YYYY-MM-DD HH:MM:SS` text |

Response: `{"success":true,"device_id":17,"duplicated":false}` (`duplicated=true` means the duplicate message was ignored and will not be forwarded to the notification channels again)

---

## Part 3: Ingestion per Device

### Android (SMS + app notifications) — SmsForwarder

1. Install the open-source app "SMS Forwarder" ([pppscn/SmsForwarder](https://github.com/pppscn/SmsForwarder))
2. In the general settings, **turn on the master switch "forward SMS broadcast"**
3. Create a "Webhook channel": put `/api/receive?token=<RECEIVE_TOKEN>` into the URL, with the message template:

```json
{"name":"My Phone","sim":"13800138000","from":"{{FROM}}","content":"{{SMS}}","time":"{{DATE}}"}
```

> Key points: `name` is your custom device name (the web page label shows it; renaming generates a new label); `sim` is the phone number, filled in directly (shown at the card's bottom-right, double-tap to copy); `content` must use the `{{SMS}}` variable.
> App notification forwarding: add an "App notification" forwarding rule, with `sender` using `{{APP_NAME}}` and `content` using `{{MSG}}` in the template, and switch the target to `/api/push`.

### iOS — Shortcuts

1. Shortcuts → Automation → New "Personal Automation" → choose "Message received"
2. Add action → "Get contents of URL":
   - URL: `https://<your-domain>/api/push`
   - Method: POST, JSON body:

```json
{"token":"<RECEIVE_TOKEN>","source":"sms","sender":"iPhone","name":"Notify Gateway","content":"[message body variable]"}
```

3. Turn off "Ask Before Running" for full automation. Timed notifications (battery, Focus mode) work the same way — pick the matching trigger.

### Linux — curl / scripts / systemd

The simplest one-liner:

```bash
curl -s -X POST https://<your-domain>/api/push \
  -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"web-01","content":"Nginx restarted"}'
```

Scheduled/event notification example (`/usr/local/bin/notify.sh`):

```bash
#!/bin/bash
curl -s -X POST https://<your-domain>/api/push \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"<RECEIVE_TOKEN>\",\"sender\":\"$(hostname)\",\"source\":\"cron\",\"content\":\"$1\"}"
```

Invoke it with a systemd timer or cron: `notify.sh "daily backup done"`.

Advanced optional: self-host [ntfy](https://ntfy.sh) (single binary/Docker), have multiple machines subscribe to the same event stream, then forward ntfy messages to this gateway with a small bridge script.

### Windows — PowerShell / Task Scheduler

`C:\Tools\notify.ps1`:

```powershell
param([string]$Message = "Notification")
$body = @{
  token  = "<RECEIVE_TOKEN>"
  sender = $env:COMPUTERNAME
  source = "notify"
  content = $Message
} | ConvertTo-Json
Invoke-RestMethod -Uri "https://<your-domain>/api/push" -Method Post -ContentType "application/json" -Body $body
```

Invoke: `powershell -File C:\Tools\notify.ps1 -Message "disk cleanup done"`; in Task Scheduler you can hook it to events such as before-shutdown or after-backup.

### macOS — Shortcuts / launchd

- Shortcuts: the same as iOS (swap the automation trigger for "specific time", "file change", etc.)
- Scheduled script + launchd (`~/Library/LaunchAgents/local.notify.plist`):

```bash
curl -s -X POST https://<your-domain>/api/push -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"MacBook","content":"Time Machine backup finished"}'
```

- To receive iPhone SMS on a Mac: poll the Messages.app SQLite store for increments with AppleScript and push (advanced)

### Servers/containers — Apprise (optional aggregation layer)

[Apprise](https://github.com/caronc/apprise) supports 100+ notification targets; you can use this gateway as one of its custom webhooks to manage multi-target pushes uniformly.

---

## Part 4: Verification Checklist

| Check | Method |
|---|---|
| API auth | A request without a token should return 403 unauthorized |
| Universal push | Send one with any example above; it should be visible under the "notify" source on the web page, and configured notification channels should receive it too |
| SMS path | Send a real SMS from the phone → visible under the "sms" source on the web page + code recognition + channel forwarding |
| Source filter | Switch the "source filter" dropdown in the admin page toolbar: All / SMS / Notifications and custom sources |
| Nine-language switch | The admin page and login page include nine built-in languages (简体中文 / 繁體中文 / English / 日本語 / 한국어 / Español / Français / Deutsch / Português (BR)); pick one from the "🌐" menu at the top right and the whole page switches, with the choice remembered locally in the browser; you can also visit `https://your-domain/?lang=ja` etc. directly. Old links `?lang=zh` / `?lang=en` remain compatible (auto-normalized to zh-CN / en) |
| Export & filter | Click "Export CSV / JSON" to download the current filter result; switching "Last 7 days" or "50 per page" updates the list and the export accordingly |
| Duplicate blocking | Re-send the same content within the same second → response `duplicated:true`, and the notification channels are not pushed again |

## Part 5: FAQ

- **Pushed a message but the web page did not refresh?** The admin page refreshes via long polling (hangs up to 25 seconds by default, tunable via `WAIT_MAX_SECONDS`); switching back to the page triggers an immediate re-pull; you can also toggle the source filter manually to trigger a load.
- **Cramped UI / zoomed-in login box on a mobile browser?** It is already mobile-adapted (safe areas, 16px inputs to prevent iOS auto-zoom, larger touch targets); if it still misbehaves, clear that site's cache and retry.
- **Long polling always errors on Netlify?** Set `WAIT_MAX_SECONDS` to `8` (below the Functions 10s cap).
- **Notification channel received nothing?** Check that the corresponding channel variables are configured and correct (paired variables like Telegram/Gotify need all of them set); check the deployment platform logs for `notify forward failed:`; messages with `duplicated:true` are not forwarded.
- **Want to rename a label?** Click "✎" next to a device label to rename it (sets an alias), or click "⇄" to merge that label's messages into another device; labels without messages can be deleted directly with "×".
- **How long is data kept?** Controlled by `RETENTION_DAYS`, default 30 days; cleanup runs automatically every day at UTC 17:00 (1:00 AM Beijing time).
