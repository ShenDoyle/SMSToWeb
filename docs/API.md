# API 文档（API）

所有接口均以 `/` 为根，响应为 JSON（`Content-Type: application/json`），支持 CORS。除「公开接口」外，受登录开关保护（安全配置建议见根 README「安全强烈建议」）。

## 鉴权方式

| 接口类型 | 鉴权 |
|---|---|
| 入站推送（`/api/receive`、`/api/push`） | **库内命名令牌优先**（管理接口创建，SHA-256 哈希存储，未吊销且未过期才放行，命中自动记录最近使用时间）；环境变量 `RECEIVE_TOKEN` 兜底（迁移期存量接入继续有效；设 `DISABLE_RECEIVE_TOKEN=true` 后停用兜底、只认库内令牌）。携带方式优先级：`X-Receive-Token` 请求头 > `?token=` query > `Authorization: Bearer` > `body.token`（**推荐用请求头**，避免令牌进 URL/日志）。**不受登录开关影响**；校验失败一律 `403`（与旧版状态码一致，非 401） |
| 管理接口 | Cookie 会话 `sms_auth`（`POST /api/login` 获取；`ENABLE_AUTH=true` 时启用）。会话为**无状态签名 Token**（`nonce.exp.HMAC-SHA256` 三段式，签名密钥 `SESSION_SECRET`），有效期**默认 30 分钟**（管理页「设置 → 会话时长」可调，5 分钟 ~ 30 天）；`SESSION_SECRET` 缺失时安全失败（登录 500、管理接口一律 401，不回退密码派生），配置缺失一律不放行。轮换 `SESSION_SECRET` 后所有旧会话立即失效 |
| 定时清理（`GET /api/cron`） | **仅认环境变量 `RECEIVE_TOKEN`**（`?token=` query 或 `Authorization: Bearer`）——库内命名令牌对 `/api/cron` **无效**（隔离设计：定时清理凭据不随库内令牌的创建/吊销/轮换/过期变化） |

## 1. 入站推送（公开）

### POST/GET `/api/receive` — 短信入库（SmsForwarder 兼容）

参数（JSON body，GET 时走 query）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `token` | 是 | 接入令牌：库内命名令牌（推荐，管理页「接入令牌」创建）或环境变量 `RECEIVE_TOKEN`；四种携带方式见「鉴权方式」 |
| `name` | 否 | 设备名（App 模板 name 字段），默认 `unknown` |
| `sim` | 否 | 收件手机号，原样入库与展示 |
| `from` | 否 | 发件人 |
| `content` | 是 | 短信正文（服务端截断至 8000 字符） |
| `time` | 否 | 客户端时间；缺省用服务端北京时间 |

```bash
curl -X POST "https://<your-site>/api/receive?token=<RECEIVE_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"我的手机","sim":"13800000000","from":"10086","content":"验证码 123456"}'
```

响应：`{ "success": true, "device_id": 1, "duplicated": false }`。同设备+发件人+内容+秒级时间重复推送 → `duplicated: true`（入库跳过且**不转发通知**）。

### POST `/api/push` — 通用推送（任意平台来源接入）

| 字段 | 必填 | 说明 |
|---|---|---|
| `token` | 是 | 接入令牌（库内命名令牌或 `RECEIVE_TOKEN`，query） |
| `content` | 是 | 正文（截断至 8000 字符） |
| `name` / `sender` | 否 | 设备名 / 发件方（App 名、脚本名等） |
| `source` | 否 | 来源分类（默认 `notify`；如 `alert`、`jd`，前端可按来源筛选） |
| `time` | 否 | 客户端时间，缺省服务端当前时间 |

收到消息后同样触发 11 渠道通知转发（三态渲染：无验证码的 push → 🔔 设备通知）。是否转发、转发哪些类型、各渠道启停与失败重试，均受管理页「设置 → 通知设置」控制（数据库优先，旧环境变量兜底）。

## 2. 消息查询与管理（需登录态）

### GET `/api/messages` — 消息列表

Query 参数：

| 参数 | 说明 |
|---|---|
| `q` | 关键词检索（匹配 sender/content） |
| `source` | 来源筛选（如 `sms` / `notify` / 自定义来源） |
| `device_id` | 按设备筛选 |
| `range` | 时间范围：`1d` / `7d` / `30d` |
| `limit` / `page` | 分页（默认 50/页） |
| `starred` | `1` 仅看星标 |

响应：`{ "total": 123, "limit": 50, "page": 1, "list": [ { "id", "device_id", "display_name", "sim_number", "sender", "source", "content", "received_at", "starred", "read_at", "deleted_at" } ] }`

### 消息操作

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/messages/remove` | 软删除（body: `{ ids: [..] }`，写入 deleted_at） |
| POST | `/api/messages/restore` | 恢复软删除（body: `{ ids: [..] }`） |
| POST | `/api/messages/clear` | 清空回收站/全部（body: `{ scope: "trash" \| "all" }`） |
| POST | `/api/messages/star` | 星标切换（body: `{ id, starred }`） |
| POST | `/api/messages/read` | 标记已读（body: `{ id }`） |
| DELETE | `/api/messages/{id}` | 物理删除单条 |

### GET `/api/export?format=csv|json` — 导出

支持同列表的筛选参数；CSV 带 BOM 与 `attachment` 下载头，公式注入防护（`=/+-@` 开头的单元格前置单引号）。

### GET `/api/stats` — 统计

今日/总数/设备数等汇总。GET `/api/sources` — 来源清单（`[{ source, count }]`）。

## 3. 设备管理（需登录态）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/devices` | 设备清单（含 `display_name`：别名 > 设备名、消息计数） |
| POST | `/api/devices/alias` | 设置别名（body: `{ id, alias }`；空串清除） |
| POST | `/api/devices/merge` | 合并设备（body: `{ from, to }`，迁移全部消息后删除源设备；源→自身返回 400） |
| DELETE | `/api/devices/{id}` | 删除设备（有消息时返回 `has messages` 拒绝） |

## 4. 接入令牌管理与服务端设置（需登录态）

多命名接入令牌的创建 / 列表 / 吊销 / 轮换（管理页「设置 → 接入令牌」即此组接口）。**全部需要登录会话**（Cookie `sms_auth`）；写接口均强制 `Content-Type: application/json`（CSRF 防护：简单请求不可伪造该头）并受写入限速（120 次/IP/分）。安全原则：库内只存 SHA-256 哈希；**明文仅创建/轮换成功时返回一次**，列表永不返回明文与哈希；吊销写 `revoked_at` 保留审计行、不物理删除；**过期令牌软失效**（接入 403 但不写 `revoked_at`，保留审计）。

### POST `/api/tokens` — 创建令牌

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 令牌名称：仅字母/数字/_/-，最长 64，活跃令牌名唯一 |
| `note` | 否 | 备注，最长 200 字（便于区分令牌用途，如「主力机接入」） |
| `expires_in_days` | 否 | 有效期天数（正整数 1~36500，自当前 UTC 起算）；与 `expires_at` 同传时本字段优先 |
| `expires_at` | 否 | 到期时间：`YYYY-MM-DD`（视为**当日 UTC 23:59:59** 到期，即北京时间**次日 07:59:59**）或 `YYYY-MM-DD HH:MM:SS`（UTC 时刻）；两者都不传 = 永久 |

```bash
curl -X POST "https://<your-site>/api/tokens" \
  -H "Content-Type: application/json" \
  -H "Cookie: sms_auth=<会话>" \
  -d '{"name":"my-phone","note":"主力机接入","expires_in_days":30}'
```

响应：`{ "success": true, "id", "name", "token_prefix", "expires_at", "token" }`。`token` 为一次性明文（`smsw_` 前缀 + 64 位十六进制），关闭弹窗后无法再次查看。

### GET `/api/tokens` — 列表

响应：`{ "success": true, "now", "list": [ { "id", "name", "token_prefix", "created_at", "last_used_at", "revoked_at", "expires_at", "note" } ] }`。

活跃令牌在前，其余按创建时间倒序；`now` 为服务端 UTC 时间（客户端时钟不可信，前端以它判定「已过期」）；`expires_at` 为 `null` 表示永久。

### POST `/api/tokens/revoke` — 吊销

body: `{ "id" }`。不存在 → 404 `NOT_FOUND`（防粘错 id 误判成功）；重复吊销 → 幂等成功（`{ "revoked": false, "already_revoked": true }`）。吊销后使用该令牌的接入**立即 403**。

### POST `/api/tokens/rotate` — 轮换

body: `{ "id" }`。吊销旧令牌并生成**同名**新令牌，返回新明文（一次）与新 `id`；新令牌**沿用原备注与有效期**（轮换不偷偷续期，需要续期请吊销后重建）。不存在 → 404。泄露止血场景首选。

### 错误码约定

| 状态码 | `error` | 场景 |
|---|---|---|
| 400 | `INVALID_NAME` | 名称非法（字符集/超 64 字） |
| 400 | `NAME_TAKEN` | 活跃令牌重名（部分唯一索引） |
| 400 | `INVALID_NOTE` | 备注超 200 字 |
| 400 | `INVALID_EXPIRY` | 有效期非法（非正整数天数 / 格式错 / 不存在日期如 `2026-02-30`） |
| 404 | `NOT_FOUND` | 吊销/轮换的 id 不存在 |
| 400 | `INVALID_TTL` | 会话时长非法（非整数 / 不在 5~43200 分钟范围内） |
| 400 | `INVALID_SETTING` | 未知设置键 / 值类型或范围非法（响应带 `setting`） |
| 400 | `RESERVED_KEY` | 试图写入或清除保留键 `schema_meta` / `settings_rev` |
| 401 | — | 未登录（会话缺失或过期） |
| 409 | `REVISION_CONFLICT` | 携带的 `revision` 与当前修订号不符（并发保存），响应带最新 `revision` |
| 429 | — | 触发写入限速 |
| 500 | `SETTINGS_READ_FAILED` | 设置读取失败（明确报错，不返回默认值冒充成功） |
| 500 | `SETTINGS_SAVE_FAILED` | 写入失败（整批回滚） |
| 500 | `SETTINGS_VERIFY_FAILED` | 写入后回读校验不符 |

### GET `/api/settings` — 读取设置

响应（敏感值只返回配置状态与脱敏结果，永不返回明文）：

```json
{
  "success": true,
  "revision": 3,
  "session_ttl_minutes": 30,
  "retention_days": 30,
  "phone_area_enabled": true,
  "phone_area_api": "",
  "notify": {
    "enabled": true,
    "types": ["verify", "sms", "notify"],
    "retry": 0,
    "link": "",
    "channels": {
      "feishu": {
        "label": "飞书", "enabled": true, "configured": true, "source": "db",
        "fields": {
          "webhook": { "sensitive": true, "configured": true, "masked": "••••f456" },
          "secret": { "sensitive": true, "configured": true, "masked": "••••" }
        }
      }
    }
  },
  "notify_schema": { "types": ["verify", "sms", "notify"], "retry_max": 3, "channels": [ { "key": "feishu", "label": "飞书", "fields": [ { "key": "webhook", "sensitive": true } ] } ] }
}
```

- `revision`：设置修订号，用于并发保存校验。
- `notify.channels.<渠道>.source`：`db` = 值来自数据库，`env` = 回退旧环境变量；`configured=false` 表示未配置。
- 非敏感字段返回 `value`；敏感字段只返回 `configured` + `masked`（末 4 位，长度 ≤4 时仅 `••••`）。
- `notify_schema` 供设置页动态渲染渠道与字段，不包含任何值。
- `schema_meta`（结构指纹保留键）永不返回。
- 数据库读取失败返回 500 `SETTINGS_READ_FAILED`。

### PUT `/api/settings` — 修改设置

请求（所有字段可选，至少一个才会写库）：

```json
{
  "revision": 3,
  "session_ttl_minutes": 480,
  "retention_days": 90,
  "phone_area_enabled": false,
  "phone_area_api": "https://area.example.com/api?n={number}",
  "settings": { "notify.retry": 2 },
  "notify": {
    "enabled": true,
    "types": ["sms"],
    "retry": 2,
    "link": "https://example.com/",
    "channels": { "feishu": { "enabled": true, "webhook": "https://open.feishu.cn/...", "secret": "..." } }
  },
  "clear": ["notify.feishu.secret", "notify.link"]
}
```

语义：

- **敏感字段传空值 = 不修改**（避免误清空）；要清除必须放进 `clear`。
- `clear` 中：**渠道字段**写空串（同时遮蔽同名旧环境变量）；**渠道开关 / 全局规则 / 普通标量**删除键（回退环境变量或默认值）。
- `settings` 接受与 `notify` 等价的扁平键名（如 `notify.retry`），便于脚本调用。
- `revision` 可选；携带时必须等于当前修订号，否则 409 `REVISION_CONFLICT`，整批不写。
- 无实际改动时返回 200、当前 `revision`、`saved=0`。

校验：`session_ttl_minutes` 5~43200 整数（越界保持旧错误码 `INVALID_TTL`）；`retention_days` 1~3650 整数；`phone_area_enabled` / `notify.enabled` / `notify.<渠道>.enabled` 布尔；`phone_area_api` / `notify.link` 为 http(s)、≤500 字符、可空；`notify.types` 必须是非空的 `verify/sms/notify` 子集；`notify.retry` 0~3 整数；Webhook/URL 字段 http(s) 且限长；`GENERIC_WEBHOOKS` 等价字段为逗号分隔 http(s)；请求头字段必须是 JSON 对象。

响应：`{ "success": true, "revision": 4, "saved": 5, "session_ttl_minutes": 480 }`（`saved` 为写入/删除的键数）。改动**仅影响之后新签发的会话**（无状态 Token，存量会话不变）。

> **会话时长优先级（v1.0.4 起）**：`session_ttl_minutes` 在此处为**全局默认值**（兼容回退策略）；若登录请求体携带 `session_ttl_minutes`（浏览器独立配置，存于浏览器 localStorage），则以请求声明为准。管理页「会话时长（本浏览器）」面板读写浏览器本地配置，不再修改此全局值。

### POST `/api/settings/notify/test` — 测试通知

body: `{ "channel": "feishu" }`。只测试指定渠道，绕过总开关、类型规则与该渠道启停（便于启用前验证）。

| 状态码 | 说明 |
|---|---|
| 200 | `{ "success": true, "channel": "feishu" }` |
| 400 | `INVALID_CHANNEL`（渠道不存在，带 `channels` 列表）/ `NOT_CONFIGURED`（该渠道必填字段未配置） |
| 502 | `SEND_FAILED`，`message` 为**脱敏后**的上游错误（URL 已替换为 `[url]`，且不含完整凭据） |

### POST `/api/settings/notify/import-env` — 从环境变量迁移通知配置

body: `{}`。只导入「数据库键不存在且环境变量非空」的字段，**不覆盖已有值**，逐项校验。

- 200：`{ "success": true, "imported": 12, "revision": 5 }`
- 400 `INVALID_ENV_VALUE`（带 `setting`，环境变量值非法，未写入任何键）
- 409 `REVISION_CONFLICT` / 500 `SETTINGS_READ_FAILED` / `SETTINGS_SAVE_FAILED` / `SETTINGS_VERIFY_FAILED`

迁移与回退：删除对应 `notify.*` 键即回退到旧环境变量；登录密码与会话签名密钥（`ADMIN_PASSWORD`、`SESSION_SECRET`）始终只走环境变量，不在此接口范围内。

## 5. 实时与辅助

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/wait?last_id=N` | 长轮询：有比 N 更新的消息立即返回 `{ changed: true }`，否则挂起（默认 25s，`WAIT_MAX_SECONDS` 可调） |
| GET | `/api/phone?number=` | 号码归属地查询（管理页「业务设置」可开关与换接口，数据库值优先；旧环境变量 `PHONE_AREA_ENABLED=false` 仍兼容；上游限速代理，独立 120 次/分桶） |
| POST | `/api/login` | 登录（body: `{ password, session_ttl_minutes? }` → `Set-Cookie: sms_auth=<签名会话>`，无状态 HMAC-SHA256 三段式 Token、HttpOnly + SameSite=Lax；会话时长优先级：请求声明（浏览器独立配置，管理页面板写入浏览器 localStorage）> settings 全局默认 > 内置 30 分钟；声明非法 400 `INVALID_TTL` 不签发会话，每 Token exp 签发时独立确定、不可延长；失败 5 次锁 10 分钟；密码错 403，`SESSION_SECRET` 缺失 500 配置错误） |
| POST | `/api/logout` | 登出 |
| GET | `/api/cron?token=` | 触发定时清理（删除超过保留天数的旧消息；保留天数在管理页「业务设置」配置，数据库值优先，旧环境变量 `RETENTION_DAYS` 兜底，默认 30） |
| GET | `/` `/manifest.webmanifest` `/sw.js` | 管理页 / PWA 清单 / Service Worker |

## 6. 通用 Webhook 转发格式（出站）

在管理页「设置 → 通知设置 → 通用 Webhook」填写地址（或保留旧环境变量 `GENERIC_WEBHOOKS`，数据库键优先）后，每条消息 POST 默认 JSON：

```json
{
  "title": "🔐 验证码 726418 · Gitee",
  "content": "您的验证码是726418，5分钟内有效",
  "time": "2026-10-27 14:23:45",
  "source": "sms",
  "sender": "Gitee",
  "device": "我的手机",
  "type": "verify",
  "code": "726418"
}
```

`type` ∈ `verify | sms | notify`；`code` 为服务端轻量检测出的验证码（未检出为空串）。配 `GENERIC_WEBHOOK_TEMPLATE` 后按模板渲染（占位符 `{{title}} {{content}} {{time}} {{source}} {{sender}} {{device}} {{type}} {{code}}`），可解析为 JSON 则按 JSON 发送，否则按纯文本；`GENERIC_WEBHOOK_HEADERS` 可自定义请求头（JSON 对象字符串）。
