# API Documentation (API)

**English** | [简体中文](../../zh-CN/README.md) | [繁體中文](../../zh-TW/README.md) | [日本語](../../ja/README.md) | [한국어](../../ko/README.md) | [Español](../../es/README.md) | [Français](../../fr/README.md) | [Deutsch](../../de/README.md) | [Português (BR)](../../pt-BR/README.md)

> Synced from the English primary where applicable

All endpoints are rooted at `/`, respond with JSON (`Content-Type: application/json`), and support CORS. Except for the "public endpoints", they are protected by the login toggle (for security configuration recommendations, see the "Security recommendations" section of the README).

## Auth methods

| Endpoint type | Auth |
|---|---|
| Inbound push (`/api/receive`, `/api/push`) | `?token=<RECEIVE_TOKEN>` (query or form field), **unaffected by the login toggle** |
| Admin endpoints | Cookie session `sms_auth` (obtained via `POST /api/login`; active when `ENABLE_AUTH=true`). The session is a **stateless signed token** (`nonce.exp.HMAC-SHA256` three-part form, signing key `SESSION_SECRET`), valid for 30 minutes; when `SESSION_SECRET` is missing it fails closed (login 500, admin endpoints always 401, no password-derived fallback) — missing configuration never opens the door. Rotating `SESSION_SECRET` immediately invalidates all old sessions |
| Scheduled cleanup (`GET /api/cron`) | `?token=<RECEIVE_TOKEN>` or `Authorization: Bearer <RECEIVE_TOKEN>` |

## 1. Inbound push (public)

### POST/GET `/api/receive` — SMS ingestion (SmsForwarder-compatible)

Parameters (JSON body; GET uses the query):

| Field | Required | Description |
|---|---|---|
| `token` | yes | RECEIVE_TOKEN (may also go in the query) |
| `name` | no | device name (the app template's `name` field), default `unknown` |
| `sim` | no | receiving phone number, stored and displayed as-is |
| `from` | no | sender |
| `content` | yes | SMS body (truncated to 8000 characters server-side) |
| `time` | no | client time; server Beijing time by default |

```bash
curl -X POST "https://<your-site>/api/receive?token=<RECEIVE_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Phone","sim":"13800000000","from":"10086","content":"code 123456"}'
```

Response: `{ "success": true, "device_id": 1, "duplicated": false }`. Re-pushing the same device + sender + content + second-level time → `duplicated: true` (ingestion is skipped and **no notification is forwarded**).

### POST `/api/push` — universal push (ingestion from any platform)

| Field | Required | Description |
|---|---|---|
| `token` | yes | RECEIVE_TOKEN (query) |
| `content` | yes | body (truncated to 8000 characters) |
| `name` / `sender` | no | device name / sender (app name, script name, etc.) |
| `source` | no | source category (default `notify`; e.g. `alert`, `jd`; the frontend can filter by source) |
| `time` | no | client time; server current time by default |

Received messages likewise trigger forwarding to the 11 notification channels (three-mode rendering: a push without a code → 🔔 device notification).

## 2. Message queries & management (login required)

### GET `/api/messages` — message list

Query parameters:

| Parameter | Description |
|---|---|
| `q` | keyword search (matches sender/content) |
| `source` | source filter (e.g. `sms` / `notify` / custom sources) |
| `device_id` | filter by device |
| `range` | time range: `1d` / `7d` / `30d` |
| `limit` / `page` | pagination (default 50/page) |
| `starred` | `1` = starred only |

Response: `{ "total": 123, "limit": 50, "page": 1, "list": [ { "id", "device_id", "display_name", "sim_number", "sender", "source", "content", "received_at", "starred", "read_at", "deleted_at" } ] }`

### Message operations

| Method | Path | Description |
|---|---|---|
| POST | `/api/messages/remove` | soft delete (body: `{ ids: [..] }`, writes deleted_at) |
| POST | `/api/messages/restore` | restore soft-deleted (body: `{ ids: [..] }`) |
| POST | `/api/messages/clear` | empty trash / all (body: `{ scope: "trash" \| "all" }`) |
| POST | `/api/messages/star` | toggle star (body: `{ id, starred }`) |
| POST | `/api/messages/read` | mark read (body: `{ id }`) |
| DELETE | `/api/messages/{id}` | physically delete a single message |

### GET `/api/export?format=csv|json` — export

Accepts the same filter parameters as the list; CSV includes a BOM and an `attachment` download header, with formula-injection protection (cells starting with `=/+-@` get a leading single quote).

### GET `/api/stats` — stats

Today/total/device-count summaries. GET `/api/sources` — source list (`[{ source, count }]`).

## 3. Device management (login required)

| Method | Path | Description |
|---|---|---|
| GET | `/api/devices` | device list (with `display_name`: alias > device name, and message counts) |
| POST | `/api/devices/alias` | set alias (body: `{ id, alias }`; an empty string clears it) |
| POST | `/api/devices/merge` | merge devices (body: `{ from, to }`; migrates all messages, then deletes the source device; source→itself returns 400) |
| DELETE | `/api/devices/{id}` | delete a device (rejected with `has messages` when messages exist) |

## 4. Real-time & utilities

| Method | Path | Description |
|---|---|---|
| GET | `/api/wait?last_id=N` | long poll: returns `{ changed: true }` immediately when a message newer than N exists, otherwise hangs (default 25s, tunable via `WAIT_MAX_SECONDS`) |
| GET | `/api/phone?number=` | carrier-region lookup (disable via `PHONE_AREA_ENABLED=false`; rate-limited upstream proxy with its own 120/min bucket) |
| POST | `/api/login` | login (body: `{ password }` → `Set-Cookie: sms_auth=<signed session>`, stateless HMAC-SHA256 three-part token, TTL 30 minutes, HttpOnly + SameSite=Lax; 5 failures lock for 10 minutes; wrong password 403, missing `SESSION_SECRET` 500 configuration error) |
| POST | `/api/logout` | logout |
| GET | `/api/cron?token=` | trigger scheduled cleanup (deletes messages older than `RETENTION_DAYS`) |
| GET | `/` `/manifest.webmanifest` `/sw.js` | admin page / PWA manifest / Service Worker |

## 5. Generic webhook forwarding format (outbound)

With `GENERIC_WEBHOOKS` configured, every message POSTs the default JSON:

```json
{
  "title": "🔐 Code 726418 · Gitee",
  "content": "Your verification code is 726418, valid for 5 minutes",
  "time": "2026-10-27 14:23:45",
  "source": "sms",
  "sender": "Gitee",
  "device": "My Phone",
  "type": "verify",
  "code": "726418"
}
```

`type` ∈ `verify | sms | notify`; `code` is the verification code detected by the server's lightweight check (empty string if none detected). With `GENERIC_WEBHOOK_TEMPLATE` set, the body renders from the template (placeholders `{{title}} {{content}} {{time}} {{source}} {{sender}} {{device}} {{type}} {{code}}`); if it parses as JSON it is sent as JSON, otherwise as plain text; `GENERIC_WEBHOOK_HEADERS` can set custom headers (a JSON object string).
