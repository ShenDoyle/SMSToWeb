# 腾讯 EdgeOne Makers 部署教程

把 SMSToWeb 部署到腾讯 EdgeOne Makers（原 EdgeOne Pages，Functions + Turso 数据库）。国内访问体验好，全程约 15 分钟。

**本目录文件**：`functions/index.js`（根路径 `/` 专用入口，全部逻辑与 ENV_KEYS 白名单的单一来源）、`functions/[[default]].js`（兜底捕获其余路由，仅 re-export index.js，无需单独维护）、`app.js`（核心应用）、`db.js`（Turso 适配层）、`schema.sql`（建表）。

---

## 准备工作

1. 一个腾讯云账号（[注册入口](https://cloud.tencent.com)，需实名认证）
2. 一个 GitHub 账号（EdgeOne Makers 支持从 Git 仓库部署）

## 第一步：准备代码仓库

打开项目 GitHub 仓库，点右上角 **Fork**（或用你自己已 Push 的仓库）。

## 第二步：创建 Turso 数据库

Turso 提供 SQLite 兼容数据库（免费额度：100 个数据库、5GB 存储、每月 5 亿行读取）。EdgeOne Functions 内访问外网数据库畅通。

1. 打开 [turso.tech](https://turso.tech)，点 **Start for free now**，用 GitHub 登录
2. 进入控制台 → **Create Database**：
   - Name：`sms-gateway`
   - Location：建议选 Singapore / Hong Kong（国内访问延迟低）
   - Type：Free
3. 创建后进入数据库详情页：
   - 记下 **Database URL**（形如 `libsql://sms-gateway-xxxx.turso.io`）
   - 点 **Create Token** 创建访问令牌，**立即复制保存**（只显示一次）
4. 初始化表结构：数据库详情页 → **Console** → 把本目录 [`schema.sql`](schema.sql) 全部内容粘贴进去 → 执行 → 提示成功

> 也可用 Turso CLI：`turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`。

## 第三步：在 EdgeOne Makers 创建项目

1. 登录腾讯云控制台 → 搜索 **EdgeOne Makers**（原「EdgeOne Pages」，或访问 [console.cloud.tencent.com/edgeone/pages](https://console.cloud.tencent.com/edgeone/pages)）
2. 点 **创建项目** → 选择 **从 Git 仓库导入** → 授权 GitHub 后选择你 Fork 的仓库
3. 构建配置：
   - **根目录**：`platforms/edgeone`
   - 框架预设：选「无框架 / Other」或留空（纯 Functions 无需构建）
4. 在环境变量配置区先添加变量（见第四步），再点开始部署
5. 等待部署完成（约 1 分钟），记下分配的默认域名（如 `*.edgeone.app`）

## 第四步：配置环境变量

项目 **设置 → 环境变量** 中逐个添加（Functions 通过 `onRequest` 的 `env` 参数读取）：

| 名称 | 值 | 说明 |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | 第二步记下的 URL |
| `TURSO_AUTH_TOKEN` | （第二步的令牌） | 只显示一次的那个 |
| `RECEIVE_TOKEN` | 自己编的长随机串 | 推送鉴权，勿用示例值 |
| `ENABLE_AUTH` | `false` | 要登录改 `true` |
| `ADMIN_PASSWORD` | 自己编的密码 | 仅 `ENABLE_AUTH="true"` 时需要 |
| `RETENTION_DAYS` | `30` | 数据保留天数 |
| `FEISHU_WEBHOOK`（可选 `FEISHU_SECRET`） | （可选）飞书群机器人 Webhook | 配置后新消息自动转发飞书群；机器人安全设置选「签名校验」时另配 `FEISHU_SECRET` |
| `WECOM_WEBHOOK` | （可选）企业微信群机器人 Webhook | 配置后新消息自动转发企微群 |
| `DINGTALK_WEBHOOK` | （可选）钉钉群机器人 Webhook | 加签安全设置需另配 `DINGTALK_SECRET` |
| `SERVERCHAN_SENDKEY` | （可选）Server酱 SendKey | 微信推送 |
| `PUSHPLUS_TOKEN` | （可选）PushPlus 令牌 | 微信推送 |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | （可选）Telegram Bot | 两者都配置才生效 |
| `BARK_DEVICE_KEY` | （可选）Bark 设备 Key | 自建服务器另配 `BARK_URL`，默认官方 |
| `NTFY_URL`（可选 `NTFY_TOKEN`） | （可选）ntfy 主题 URL | 完整 URL，如 `https://ntfy.sh/my-sms`；受保护主题另配 `NTFY_TOKEN`（Token 或 user:password） |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | （可选）Gotify | 服务器地址 + 应用令牌 |
| `RESEND_API_KEY` + `MAIL_TO` | （可选）邮件（Resend） | 可选 `MAIL_FROM`，默认 `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS`（可选 `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`） | （可选）通用 Webhook | 逗号分隔多个 URL；可选模板自定义请求体，`GENERIC_WEBHOOK_HEADERS`（JSON 字符串）自定义请求头 |
| `SITE_NAME` / `SITE_ICON` | （可选） | 网站名 / 图标 URL |
| `NOTIFY_LINK` | （可选） | 管理页首页地址；配置后所有通知渠道附「打开管理页」入口，未配置自动省略 |

保存后重新部署生效。

## 第五步：验证部署

1. 浏览器打开分配的域名，应看到管理页（默认「短信网关」；开了登录则先见登录页）
2. 验证推送接口：

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"EdgeOne 部署成功\"}"
```

返回 `{"success":true,...}` 即通，网页应立刻出现这条消息。

## 第六步：绑定自定义域名（国内访问建议）

1. 项目 **设置 → 自定义域名** → 添加你的域名（如 `sms.你的域名.com`）
2. 按提示在域名 DNS 加 CNAME 记录指向 EdgeOne 分配的地址
3. 域名需已完成 ICP 备案（腾讯云国内节点的要求）；未备案域名会被拒绝解析

## 第七步：配置定时清理（外部 cron）

EdgeOne Makers 暂无原生定时任务，用任一免费外部 cron 服务每天调一次清理接口：

1. 打开 [cron-job.org](https://cron-job.org) 注册并 **Create cronjob**：
   - URL：`https://<你的域名>/api/cron?token=<你的RECEIVE_TOKEN>`
   - Schedule：每天（如北京时间 01:00，即 UTC 17:00）
2. 保存并启用。到点后网关自动删除超过 `RETENTION_DAYS` 天的数据

## 接入手机端与设备

按 [多平台接入部署指南](../../docs/多平台接入部署指南.md) 配置安卓 SmsForwarder 与各设备通知推送，域名用你的 EdgeOne 域名。

## 注意事项与常见问题

- **根路径 404（重要，2026-10 实测）**：EdgeOne Makers 的 Functions 路由规则中，`[[default]].js` 兜底只匹配 `/foo`、`/api/xxx` 等非根路径，**根路径 `/` 只认 `functions/index.js`**——缺少该文件时打开首页会直接命中平台默认 404 页（API 接口却正常）。本目录已内置 `functions/index.js` 解决（逻辑与 ENV_KEYS 白名单的单一来源，`[[default]].js` 仅 re-export 它，无需两处维护）
- **长轮询**：Functions 执行时长上限较紧，`/api/wait`（挂起 25 秒）可能被提前截断——前端自动重试，功能不受影响
- **部署失败排查**：根目录必须是 `platforms/edgeone`；缺 `TURSO_*` 环境变量会 500 报 "config error"
- **更新代码**：push 到 GitHub 仓库自动重新部署
