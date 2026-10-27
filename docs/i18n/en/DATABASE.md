# Database Document (DATABASE)

**English** | [简体中文](../../zh-CN/README.md) | [繁體中文](../../zh-TW/README.md) | [日本語](../../ja/README.md) | [한국어](../../ko/README.md) | [Español](../../es/README.md) | [Français](../../fr/README.md) | [Deutsch](../../de/README.md) | [Português (BR)](../../pt-BR/README.md)

> Synced from the English primary where applicable

SMSToWeb smooths over three storage backends with a single unified database adapter layer (the four methods `prepare/bind/first/all/run`, fully matching the Cloudflare D1 API); business code carries zero SQL dialect differences.

## 1. Backend matrix

| Platform | Database | Credential variable | Adapter file |
|---|---|---|---|
| Cloudflare | D1 | console binding (`env.DB`), configured in wrangler.toml | native, no adapter |
| Vercel / Netlify / Deno / EdgeOne | Turso (libsql) | `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | `platforms/shared/db.js` |
| Node self-hosted | Turso **or** local SQLite | with the Turso variables set, Turso is used; otherwise `SQLITE_PATH` (default `./data/smstoweb.db`, node:sqlite) | `platforms/node/db.js` (dual adapter, maintained separately) |

The cross-platform adapter is implemented in pure `fetch` (Turso HTTP /v2/pipeline), with no npm dependencies.

## 2. Schema (schema.sql is the single source)

### devices — device table

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | auto-increment |
| `device` | TEXT | device name (the app template's `name` field, default `unknown`) |
| `sim` | TEXT | receiving number (stored and displayed as-is, no mapping) |
| `alias` | TEXT | optional alias (admin page display priority: alias > device) |
| `created_at` | TEXT | insertion time |

Unique index `idx_devices_key(device, sim)`: the same device + the same receiving number is unique.

### messages — message table (10 columns)

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | auto-increment |
| `device_id` | INTEGER FK | → devices.id |
| `sender` | TEXT | sender |
| `content` | TEXT | body (truncated to 8000 characters before insertion) |
| `received_at` | TEXT | Beijing time (second precision) |
| `source` | TEXT | source: `sms` / `notify` / custom (e.g. `alert`) |
| `created_at` | TEXT | insertion time |
| `deleted_at` | TEXT NULL | soft-delete timestamp (NULL = normal) |
| `starred` | INTEGER | star 0/1 |
| `read_at` | TEXT NULL | read timestamp |

Indexes: `idx_messages_device_time(device_id, received_at DESC)`, `idx_messages_time(received_at)`, `idx_messages_source(source, received_at DESC)`, plus the **dedup unique index** `idx_messages_dedup(device_id, sender, content, received_at)` — duplicate pushes are rejected at the database layer as a backstop, and the code catches the unique conflict and returns `duplicated:true`.

## 3. Migration iron rule (important)

**Every schema.sql change must come with a reminder/execution of the database migration on all deployed platforms** (lesson from the 2026-10-22 production incident: code was deployed ahead of the schema; the old Turso database lacked the `starred` column, and every list endpoint returned 500).

- Fresh deployments: run the root `schema.sql` directly (idempotent, `CREATE TABLE IF NOT EXISTS`);
- Upgrading old databases: add the new columns via `ALTER TABLE messages ADD COLUMN deleted_at TEXT;` / `ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;` / `ADD COLUMN read_at TEXT;` (noted at the tail of schema.sql);
- Already-covered production databases: CF D1 (sms-gateway-db, 10 columns verified) and EdgeOne Turso (sms-gateway, already migrated) need no further changes.

## 4. Data retention & cleanup

- Scheduled cleanup (cron): deletes messages whose `received_at` is older than `RETENTION_DAYS` (default 30 days);
- Triggers: platform-native cron (CF scheduled / Vercel Cron / Netlify Scheduled) or any scheduler calling `GET /api/cron?token=<RECEIVE_TOKEN>`.

## 5. Turso usage notes (troubleshooting experience)

- **Token type**: an organization-level API Token (JWT payload carries only org_id) ≠ a database token (payload carries `a:"rw"`). Database tokens are generated at: Turso console → database detail → Tokens tab; using the wrong type against /v2/pipeline reports `invalid JWT token` → all DB endpoints return 500 "internal error" (the login page does not query the database, so it works fine).
- **Client cache**: the Turso client cache is keyed by credential fingerprint (automatically rebuilt when dbUrl+dbToken change), so swapping the token in the console requires no redeployment.
- **Quick diagnosis**: hit `POST https://<db-url>/v2/pipeline` directly with a database token (body: `{"requests":[{"type":"execute","stmt":{"sql":"SELECT 1"}},{"type":"close"}]}`).
