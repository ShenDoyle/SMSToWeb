# Vercel 部署教程

把 SMSToWeb 部署到 Vercel（Edge Function + Turso 数据库）。免费额度足够个人使用，全程约 15 分钟。

**本目录文件**：`api/[[...route]].js`（入口）、`app.js`（核心应用）、`db.js`（Turso 适配层）、`schema.sql`（建表）、`vercel.json`（含定时任务配置）。

---

## 一键部署（推荐）

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb%2Ftree%2Fmain%2Fplatforms%2Fvercel&env=RECEIVE_TOKEN%2CTURSO_DATABASE_URL%2CTURSO_AUTH_TOKEN&project-name=sms-gateway&envDescription=%E6%8E%A8%E9%80%81%E9%89%B4%E6%9D%83%E5%AF%86%E9%92%A5%E4%B8%8E%20Turso%20%E6%95%B0%E6%8D%AE%E5%BA%93%E8%BF%9E%E6%8E%A5%E4%BF%A1%E6%81%AF&envLink=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb)

建议**先完成下方第二步（建 Turso 库）拿到连接信息**，再点按钮：Vercel 会把本平台子目录克隆为你的仓库并创建项目，按提示填 `RECEIVE_TOKEN`（推送鉴权密钥，自编长随机串）与 Turso 的 URL / Token 即可部署。部署成功后**务必执行一次第三步的建表 SQL**（Vercel 无法自动建表），否则页面打开无数据。

---

## 准备工作

1. 一个 GitHub 账号（Vercel 通过 GitHub 仓库部署）
2. 一个 Vercel 账号（[注册入口](https://vercel.com/signup)，直接用 GitHub 登录）

## 第一步：准备代码仓库

1. 打开项目 GitHub 仓库，点右上角 **Fork**（或用你自己已 Push 的仓库）
2. Fork 完成，你就有了一份可自由修改的项目副本

## 第二步：创建 Turso 数据库

Turso 提供 SQLite 兼容数据库（免费额度：100 个数据库、5GB 存储、每月 5 亿行读取）。

1. 打开 [turso.tech](https://turso.tech)，点 **Start for free now**，用 GitHub 登录
2. 进入控制台 → **Create Database**（创建数据库）：
   - Name：`sms-gateway`
   - Location：选离你近的区域（如 Singapore / Hong Kong）
   - Type：Free
3. 创建后进入数据库详情页：
   - 记下 **Database URL**（形如 `libsql://sms-gateway-xxxx.turso.io`）
   - 点 **Create Token**（或 Turso Platform Tokens）创建访问令牌，**立即复制保存**（只显示一次）
4. 初始化表结构：数据库详情页 → **Console**（网页版 SQL 控制台）→ 把本目录 [`schema.sql`](schema.sql) 全部内容粘贴进去 → 执行 → 提示成功（创建 `messages` 和 `devices` 两张表）

> 也可用 Turso CLI：`turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`。

## 第三步：导入仓库到 Vercel

1. 登录 [vercel.com](https://vercel.com) → **Add New → Project**
2. 在 **Import Git Repository** 列表找到你 Fork 的仓库，点 **Import**
3. 在配置页展开 **Root Directory**（根目录），选择 `platforms/vercel`
   ——Vercel 会自动识别目录内的 `vercel.json` 和 `api/` 目录，无需其他配置
4. 先不要急着点 Deploy，先做第四步的环境变量配置（在同一页面 **Environment Variables** 区添加）

## 第四步：配置环境变量

在部署配置页的 **Environment Variables** 中逐个添加（后续也可在 Project → Settings 里改）：

| 名称 | 值 | 说明 |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | 第二步记下的 URL |
| `TURSO_AUTH_TOKEN` | （第二步的令牌） | 只显示一次的那个 |
| `RECEIVE_TOKEN` | 自己编的长随机串 | 推送鉴权，勿用示例值 |
| `ENABLE_AUTH` | `false` | 要登录改 `true` |
| `ADMIN_PASSWORD` | 自己编的密码 | 仅 `ENABLE_AUTH="true"` 时需要 |
| `SESSION_SECRET` | 高熵随机值（≥32 位随机字符串） | 仅 `ENABLE_AUTH="true"` 时需要；与密码独立，与其他平台分别配置独立值；缺失时登录/鉴权安全失败，轮换后旧会话全部失效 |
| `RETENTION_DAYS` | `30` | 数据保留天数 |
| `CRON_SECRET` | **与 RECEIVE_TOKEN 相同的值** | Vercel Cron 调 /api/cron 时自动附带 `Bearer $CRON_SECRET` |
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

全部填完点 **Deploy**，等待约 1 分钟部署完成。

## 第五步：验证部署

1. 部署完成页点 **Continue to Dashboard**，记下顶部分配的域名（形如 `https://xxx.vercel.app`）
2. 浏览器打开该域名，应看到管理页（默认「短信网关」；开了登录则先见登录页）
3. 验证推送接口（把 `<域名>` 和 `<密钥>` 换成你的）：

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Vercel 部署成功\"}"
```

返回 `{"success":true,...}` 即通，网页应立刻出现这条消息。

## 第六步：接入手机端与设备

按 [多平台接入部署指南](../../docs/多平台接入部署指南.md) 配置安卓 SmsForwarder（短信走 `/api/receive`）和各设备通知推送（走 `/api/push`），域名用你的 `xxx.vercel.app`（或绑定自定义域名）。

绑定自定义域名：Project → **Settings → Domains** → Add，按提示在域名 DNS 加一条 CNAME 记录——目标值以 Domains 页面显示的为准（Vercel 为每个项目分配专属的 `xxxxxx.vercel-dns.com` 地址）。

## 注意事项与常见问题

- **定时清理**：`vercel.json` 已配置每天 UTC 17:00（北京 01:00）调用 `/api/cron` 清理过期数据。Vercel Cron 会自动带 `Authorization: Bearer $CRON_SECRET`，所以 `CRON_SECRET` 必须与 `RECEIVE_TOKEN` 一致
- **Hobby（免费）版限制**：cron 仅支持每天一次（本项目正好一天一次，满足；实际触发时刻可能在设定小时内浮动，属正常现象）；Edge 函数须在 **25 秒内开始返回响应**（之后可持续流式 300 秒），管理页长轮询 `/api/wait` 恰好挂起 25 秒处于边界——若被提前截断，前端轮询循环会自动重试，**不影响功能**，仅新消息提醒稍不及时
- **Edge Runtime**：入口已声明 `runtime = "edge"`，冷启动快、全球边缘节点执行
- **部署失败排查**：多为环境变量漏填——缺 `TURSO_*` 会 500 且报 "config error"；检查 Root Directory 是否选对 `platforms/vercel`
- **更新代码**：推送（push）到你 Fork 的仓库，Vercel 自动重新部署
