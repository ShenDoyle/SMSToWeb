# Netlify 部署教程

把 SMSToWeb 部署到 Netlify（Functions v2 + Turso 数据库）。全程约 15 分钟。

**本目录文件**：`functions/api.mjs`（入口，`path: "/*"` 捕获全部路由）、`functions/cron.mjs`（定时清理 Scheduled Function）、`app.js`（核心应用）、`db.js`（Turso 适配层）、`schema.sql`（建表）、`netlify.toml`（站点配置）。

---

## 一键部署（推荐）

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/ShenDoyle/SMSToWeb)

点按钮把仓库克隆到你的 GitHub 并进入创建向导，两处注意：

1. **构建配置里把 Base directory 填 `platforms/netlify`**（本平台的 `netlify.toml` 在该子目录，填对后构建命令等自动接管）；其余保持默认
2. 建议先完成下方第二步（建 Turso 库）拿到连接信息，创建后在 **Site configuration → Environment variables** 填 `RECEIVE_TOKEN` / `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` 并重新部署；最后执行第三步建表 SQL（Netlify 无法自动建表）

---

## 准备工作

1. 一个 GitHub 账号
2. 一个 Netlify 账号（[注册入口](https://app.netlify.com/signup)，直接用 GitHub 登录）

## 第一步：准备代码仓库

打开项目 GitHub 仓库，点右上角 **Fork**（或用你自己已 Push 的仓库）。

## 第二步：创建 Turso 数据库

Turso 提供 SQLite 兼容数据库（免费额度：100 个数据库、5GB 存储、每月 5 亿行读取）。

1. 打开 [turso.tech](https://turso.tech)，点 **Start for free now**，用 GitHub 登录
2. 进入控制台 → **Create Database**：
   - Name：`sms-gateway`
   - Location：选离你近的区域（如 Singapore / Hong Kong）
   - Type：Free
3. 创建后进入数据库详情页：
   - 记下 **Database URL**（形如 `libsql://sms-gateway-xxxx.turso.io`）
   - 点 **Create Token** 创建访问令牌，**立即复制保存**（只显示一次）
4. 初始化表结构：数据库详情页 → **Console** → 把本目录 [`schema.sql`](schema.sql) 全部内容粘贴进去 → 执行 → 提示成功

> 也可用 Turso CLI：`turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`。

## 第三步：导入仓库到 Netlify

1. 登录 [app.netlify.com](https://app.netlify.com) → **Add new project → Import an existing project**
2. 选择 **Deploy with GitHub**，授权后在列表选你 Fork 的仓库
3. 部署配置页（Site settings for…）：
   - **Base directory**（根目录）：填 `platforms/netlify`
   - Build command / Publish directory：保持默认即可（`netlify.toml` 已在目录内，自动生效）
4. 展开下方 **Show advanced → New variable**，先添加环境变量（见第四步），再点 **Deploy**

## 第四步：配置环境变量

部署配置页高级选项中添加（后续也可在 **Project configuration → Environment variables** 里改）：

| 名称 | 值 | 说明 |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | 第二步记下的 URL |
| `TURSO_AUTH_TOKEN` | （第二步的令牌） | 只显示一次的那个 |
| `RECEIVE_TOKEN` | 自己编的长随机串 | 推送鉴权，勿用示例值 |
| `ENABLE_AUTH` | `false` | 要登录改 `true` |
| `ADMIN_PASSWORD` | 自己编的密码 | 仅 `ENABLE_AUTH="true"` 时需要 |
| `SESSION_SECRET` | 高熵随机值（≥32 位随机字符串） | 仅 `ENABLE_AUTH="true"` 时需要；与密码独立，与其他平台分别配置独立值；缺失时登录/鉴权安全失败，轮换后旧会话全部失效 |
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

点 **Deploy**，等待约 1 分钟部署完成。

## 第五步：验证部署

1. 部署完成，记下站点域名（形如 `https://xxx.netlify.app`）
2. 浏览器打开该域名，应看到管理页（默认「短信网关」；开了登录则先见登录页）
3. 验证推送接口：

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Netlify 部署成功\"}"
```

返回 `{"success":true,...}` 即通，网页应立刻出现这条消息。

## 第六步：接入手机端与设备

按 [多平台接入部署指南](../../docs/多平台接入部署指南.md) 配置安卓 SmsForwarder 与各设备通知推送，域名用你的 `xxx.netlify.app`。

自定义域名：**Project configuration → Change site name**（改子域名）或 **Domain management → Add a domain**（自有域名，按提示加 DNS）。

## 注意事项与常见问题

- **定时清理**：`functions/cron.mjs` 是 Netlify Scheduled Function，部署后自动注册（每天 UTC 17:00 = 北京 01:00），无需额外配置。验证：站点 **Functions** 页可看到 `cron` 函数及其调度状态
- **函数时长与实时性**：函数默认执行上限现为 60 秒（各计划一致），管理页长轮询 `/api/wait`（挂起 25 秒）可完整等待，实时性良好；实时性要求极高仍建议选 Cloudflare / 自托管版本
- **免费额度**：2025-09 起新账号采用信用点计费（Free 计划每月 300 信用点，函数用量按 GB-小时计入），个人小流量足够；老账号可留在原套餐
- **部署失败排查**：Base directory 必须是 `platforms/netlify`；缺 `TURSO_*` 环境变量会 500 报 "config error"；可在站点 **Functions → api → 日志** 查看报错详情
- **更新代码**：push 到 GitHub 仓库自动重新部署
