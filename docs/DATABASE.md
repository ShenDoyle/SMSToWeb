# 数据库文档（DATABASE）

SMSToWeb 通过一个统一的数据库适配层（`prepare/bind/first/all/run` 四个方法，与 Cloudflare D1 API 完全一致）抹平三种存储后端，业务代码零 SQL 方言差异。

## 1. 后端矩阵

| 平台 | 数据库 | 凭据变量 | 适配文件 |
|---|---|---|---|
| Cloudflare | D1 | 控制台绑定（`env.DB`），wrangler.toml 配置 | 原生，无适配 |
| Vercel / Netlify / Deno / EdgeOne | Turso（libsql） | `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | `platforms/shared/db.js` |
| Node 自托管 | Turso **或** 本地 SQLite | 配了 Turso 变量用 Turso；否则 `SQLITE_PATH`（默认 `./data/smstoweb.db`，node:sqlite） | `platforms/node/db.js`（双适配，独立维护） |

跨平台适配用纯 `fetch` 实现（Turso HTTP /v2/pipeline），无 npm 依赖。

## 2. 表结构（schema.sql 单一来源）

### devices — 设备表

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增 |
| `device` | TEXT | 设备名（App 模板 name 字段，默认 `unknown`） |
| `sim` | TEXT | 收件号（原样入库与展示，不做映射） |
| `alias` | TEXT | 可选别名（管理页显示优先级：alias > device） |
| `created_at` | TEXT | 入库时间 |

唯一索引 `idx_devices_key(device, sim)`：同设备+同收件号唯一。

### messages — 消息表（10 列）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增 |
| `device_id` | INTEGER FK | → devices.id |
| `sender` | TEXT | 发件人 |
| `content` | TEXT | 正文（入库前截断至 8000 字符） |
| `received_at` | TEXT | 北京时间（秒级） |
| `source` | TEXT | 来源：`sms` / `notify` / 自定义（如 `alert`） |
| `created_at` | TEXT | 入库时间 |
| `deleted_at` | TEXT NULL | 软删除时间戳（NULL=正常） |
| `starred` | INTEGER | 星标 0/1 |
| `read_at` | TEXT NULL | 已读时间戳 |

索引：`idx_messages_device_time(device_id, received_at DESC)`、`idx_messages_time(received_at)`、`idx_messages_source(source, received_at DESC)`，以及**去重唯一索引** `idx_messages_dedup(device_id, sender, content, received_at)`——重复推送由数据库层兜底拒绝，代码捕获唯一冲突后返回 `duplicated:true`。

## 3. 迁移铁律（重要）

**每次修改 schema.sql，必须同步提醒/执行所有已部署平台的库迁移**（2026-10-22 线上故障教训：代码先于 schema 部署，Turso 旧库缺 `starred` 列导致全列表接口 500）。

- 新部署：直接执行根 `schema.sql`（幂等，`CREATE TABLE IF NOT EXISTS`）；
- 旧库升级：为新列执行 `ALTER TABLE messages ADD COLUMN deleted_at TEXT;` / `ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;` / `ADD COLUMN read_at TEXT;`（schema.sql 尾部有备注）；
- 已覆盖的线上库：CF D1（sms-gateway-db，10 列已验证）与 EO Turso（sms-gateway，已迁移）无需再动。

## 4. 数据保留与清理

- 定时清理（cron）：删除 `received_at` 早于 `RETENTION_DAYS`（默认 30 天）的 messages；
- 触发方式：平台原生 cron（CF scheduled / Vercel Cron / Netlify Scheduled）或任意调度器 `GET /api/cron?token=<RECEIVE_TOKEN>`。

## 5. Turso 使用注意（排障经验）

- **令牌类型**：组织级 API Token（JWT 载荷仅 org_id）≠ 数据库令牌（载荷带 `a:"rw"`）。数据库令牌生成位置：Turso 控制台 → 数据库详情 → Tokens 标签；拿错类型访问 /v2/pipeline 报 `invalid JWT token` → 全部 DB 接口 500「internal error」（登录页不查库所以正常）。
- **客户端缓存**：Turso 客户端按凭据指纹键控缓存（dbUrl+dbToken 变更自动重建），控制台换令牌后无需重新部署。
- **快速诊断**：用数据库令牌直打 `POST https://<db-url>/v2/pipeline`（body: `{"requests":[{"type":"execute","stmt":{"sql":"SELECT 1"}},{"type":"close"}]}`）。
