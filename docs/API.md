# API 文档（API）

所有接口均以 `/` 为根，响应为 JSON（`Content-Type: application/json`），支持 CORS。除「公开接口」外，受登录开关保护（安全配置建议见根 README「安全强烈建议」）。

## 鉴权方式

| 接口类型 | 鉴权 |
|---|---|
| 入站推送（`/api/receive`、`/api/push`） | `?token=<RECEIVE_TOKEN>`（query 或表单字段），**不受登录开关影响** |
| 管理接口 | Cookie 会话 `sms_auth`（`POST /api/login` 获取；`ENABLE_AUTH=true` 时启用）。会话为**无状态签名 Token**（`nonce.exp.HMAC-SHA256` 三段式，签名密钥 `SESSION_SECRET`），有效期 30 分钟；`SESSION_SECRET` 缺失时安全失败（登录 500、管理接口一律 401，不回退密码派生），配置缺失一律不放行。轮换 `SESSION_SECRET` 后所有旧会话立即失效 |
| 定时清理（`GET /api/cron`） | `?token=<RECEIVE_TOKEN>` 或 `Authorization: Bearer <RECEIVE_TOKEN>` |

## 1. 入站推送（公开）

### POST/GET `/api/receive` — 短信入库（SmsForwarder 兼容）

参数（JSON body，GET 时走 query）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `token` | 是 | RECEIVE_TOKEN（亦可放 query） |
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
| `token` | 是 | RECEIVE_TOKEN（query） |
| `content` | 是 | 正文（截断至 8000 字符） |
| `name` / `sender` | 否 | 设备名 / 发件方（App 名、脚本名等） |
| `source` | 否 | 来源分类（默认 `notify`；如 `alert`、`jd`，前端可按来源筛选） |
| `time` | 否 | 客户端时间，缺省服务端当前时间 |

收到消息后同样触发 11 渠道通知转发（三态渲染：无验证码的 push → 🔔 设备通知）。

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

## 4. 实时与辅助

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/wait?last_id=N` | 长轮询：有比 N 更新的消息立即返回 `{ changed: true }`，否则挂起（默认 25s，`WAIT_MAX_SECONDS` 可调） |
| GET | `/api/phone?number=` | 号码归属地查询（`PHONE_AREA_ENABLED=false` 关闭；上游限速代理，独立 120 次/分桶） |
| POST | `/api/login` | 登录（body: `{ password }` → `Set-Cookie: sms_auth=<签名会话>`，无状态 HMAC-SHA256 三段式 Token、TTL 30 分钟、HttpOnly + SameSite=Lax；失败 5 次锁 10 分钟；密码错 403，`SESSION_SECRET` 缺失 500 配置错误） |
| POST | `/api/logout` | 登出 |
| GET | `/api/cron?token=` | 触发定时清理（删除超 `RETENTION_DAYS` 的旧消息） |
| GET | `/` `/manifest.webmanifest` `/sw.js` | 管理页 / PWA 清单 / Service Worker |

## 5. 通用 Webhook 转发格式（出站）

配置 `GENERIC_WEBHOOKS` 后，每条消息 POST 默认 JSON：

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
