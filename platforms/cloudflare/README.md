# Cloudflare 部署教程（主版本，全程网页操作）

这是项目的主版本：手机短信/通知 → Cloudflare Worker → D1 数据库 → 网页管理页。
无需服务器、免费额度充足、全程网页点击即可完成，无需安装任何工具。

本目录**完全自包含**：[`worker.js`](worker.js)（部署源码）+ [`schema.sql`](schema.sql)（建表脚本）+ [`wrangler.toml`](wrangler.toml)（命令行部署可选配置），不依赖仓库其他文件。其余平台见 [平台总览](../README.md)。

---

## 一键部署（推荐新手）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

点上方按钮，Cloudflare 自动完成：克隆代码到你的 GitHub → **自动创建 D1 数据库并执行建表** → 绑定资源 → 配置 CI（之后你仓库每次 push 自动重新部署）→ 上线。过程中按提示填两个密钥：

- `RECEIVE_TOKEN`：推送鉴权密钥，自己编一个足够长的随机字符串（手机端接入 URL 中 `token=` 与之保持一致）
- `ADMIN_PASSWORD`：管理页登录密码（**强烈建议设置**——管理页承载短信验证码等敏感内容；留空则免登录运行并告警）

> 绑自定义域名（如 `sms.example.com`）：部署完成后进入 Worker → 设置 → 域和路由 → 添加自定义域。
> 下方手动教程保留给不想走一键流程、或想逐步理解每一步的用户。

## 准备工作

1. 一个 Cloudflare 账号（[注册入口](https://dash.cloudflare.com/sign-up)，免费，邮箱即可）
2. 本项目代码（本目录的 [`worker.js`](worker.js) 就是要粘贴的全部代码）

## 第一步：创建 D1 数据库

1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com)
2. 左侧菜单 **存储和数据库 → D1 SQL 数据库**
3. 点 **创建数据库**，名称填 `sms-gateway-db`（其他默认），点创建
4. 进入刚建好的数据库 → **控制台** 标签页
5. 把本目录 [`schema.sql`](schema.sql) 的全部内容复制粘贴进输入框，点 **执行**
6. 提示执行成功（会创建 `messages` 和 `devices` 两张表）

## 第二步：创建 Worker 并粘贴代码

1. 左侧菜单 **计算（Workers）→ Workers 和 Pages**
2. 点 **创建应用程序**，选择 **Start with Hello World!**（从 Hello World 模板开始），名称填 `sms-gateway`，点 **部署**（先用默认代码部署成功即可）
3. 点 **编辑代码**，删除编辑器里的全部默认代码
4. 打开本目录的 [`worker.js`](worker.js)，全选复制，粘贴进编辑器
5. 点右上角 **部署**，提示部署成功

## 第三步：绑定 D1 数据库

1. 回到 Worker 概览页 → **Bindings（绑定）** 标签页
2. 点 **添加 → D1 数据库**
3. 变量名称填 `DB`（必须一模一样，大写），选择刚建的 `sms-gateway-db`
4. 点 **部署/保存**

## 第四步：设置变量与密钥

同一位置 **设置 → 变量和机密（Variables and Secrets）**，逐个添加：

1. **添加变量**（类型选「文本」）：
   - 名称 `RETENTION_DAYS`，值 `30`（想保留 90 天就填 `90`）
   - 名称 `ENABLE_AUTH`，值 `false`（**安全强烈建议填 `true` 开启登录**：管理页承载短信验证码等敏感内容，免登录等于对任何知道域名的人开放。若用 Workers Builds 连仓库自动部署，此值以仓库内 `wrangler.toml` 为准——现已默认 `true`）
   - 名称 `SITE_NAME`（可选），值自定义网站名，如 `我的短信站`
   - 名称 `SITE_ICON`（可选），值图标 URL（`http(s)://` 开头）；不填或 URL 失效自动用内置图标
   - 名称 `NOTIFY_LINK`（可选），值管理页首页地址（`http(s)://` 开头）；配置后所有通知渠道附「打开管理页」入口
2. **添加密钥**（类型选「密钥/Secret」）：
   - 名称 `RECEIVE_TOKEN`，值自己编一个足够长的随机字符串（不要使用任何教程示例值，越长越好）
   - 名称 `ADMIN_PASSWORD`，值自己编一个管理页登录密码（仅当 `ENABLE_AUTH="true"` 时才需要）
3. 每次添加后点 **部署/保存**

> 改这些值随时生效，不用重新粘贴代码。修改 `RECEIVE_TOKEN` 后记得同步更新手机端 URL 里的 `token=`。

## 第五步（可选）：配置通知转发渠道

新消息入库后可自动转发到外部渠道，**配置哪个渠道的变量就转发哪个，全部不配置则不转发**。
在同一个「变量和机密」页面添加对应变量即可：

| 渠道 | 变量 | 说明 |
|---|---|---|
| 飞书群机器人 | `FEISHU_WEBHOOK`（可选 `FEISHU_SECRET`） | 群机器人 Webhook 地址；安全设置选「签名校验」时另配 `FEISHU_SECRET` |
| 企业微信群机器人 | `WECOM_WEBHOOK` | 群机器人 Webhook 地址 |
| 钉钉群机器人 | `DINGTALK_WEBHOOK`（可选 `DINGTALK_SECRET`） | 加签安全设置时需配 `DINGTALK_SECRET` |
| Server酱 | `SERVERCHAN_SENDKEY` | SendKey（微信推送） |
| PushPlus | `PUSHPLUS_TOKEN` | 令牌（微信推送） |
| Telegram Bot | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Bot 令牌 + 会话/群 ID |
| Bark | `BARK_DEVICE_KEY`（可选 `BARK_URL`） | 自建服务器时配 `BARK_URL`，默认官方 |
| ntfy | `NTFY_URL`（可选 `NTFY_TOKEN`） | 完整主题 URL，如 `https://ntfy.sh/my-sms`；受保护主题另配 `NTFY_TOKEN`（Token 或 user:password） |
| Gotify | `GOTIFY_URL` + `GOTIFY_TOKEN` | 服务器地址（不含 `/message`）+ 应用令牌 |
| 邮件（Resend） | `RESEND_API_KEY` + `MAIL_TO`（可选 `MAIL_FROM`） | `MAIL_FROM` 默认 `onboarding@resend.dev` |
| 通用 Webhook | `GENERIC_WEBHOOKS`（可选 `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`） | 逗号分隔多个 URL；模板自定义请求体、请求头 JSON，第三方 API（短信网关等）由此接入 |

各渠道的申请与获取步骤、请求体格式，见 [多平台接入部署指南 · 通知转发渠道](../../docs/多平台接入部署指南.md)。
多渠道并发转发、单渠道失败不影响其他渠道与消息入库；重复消息（`duplicated`）不会重复转发。
通知按内容自动分三态渲染（🔐 验证码提醒 / 💬 新短信 / 🔔 设备通知）：验证码自动进标题并触发各平台增强能力（Bark 通知一点即复制、Bark/ntfy 提升优先级、飞书 violet 卡头等）。

## 第六步：设置定时清理任务

1. Worker → **设置 → 触发器（Triggers）→ Cron 触发器**
2. 点 **添加 Cron 触发器**，填 `0 17 * * *`，保存
3. 含义：每天 UTC 17:00（北京时间凌晨 1 点）自动删除超过保留天数的数据

## 第七步：绑定域名（可选，推荐）

1. Worker → **设置 → 域和路由**
2. 点 **添加 → 自定义域**，填一个子域名（如 `sms.你的域名.com`）
3. Cloudflare 自动创建 DNS 记录并签发 HTTPS 证书，几分钟内生效
4. 之后浏览器直接访问 `https://sms.你的域名.com` 即为管理页

> 没有域名也可用默认的 `https://sms-gateway.<你的子域>.workers.dev` 地址。

## 第八步：验证部署

浏览器打开管理页应看到你的网站名页面（默认「短信网关」，可用 `SITE_NAME` 改；若开了登录则先见登录页）。再验证接收接口（把 `<域名>` 和 `<密钥>` 换成你的）：

```
curl "https://<域名>/api/receive?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"name\":\"test\",\"sim\":\"13800138000\",\"from\":\"10086\",\"content\":\"部署测试\"}"
```

返回 `{"success":true,...}` 即通。这条测试短信可在网页上删除。

## 接入手机端与各设备

按 [多平台接入部署指南](../../docs/多平台接入部署指南.md) 配置安卓 SmsForwarder 与各设备通知推送，把接口域名换成你的 Worker 地址即可。

## 命令行部署（备选，会装 wrangler 的人用）

在本目录（含 `wrangler.toml`，`main` 已指向本目录 `worker.js`）执行：

```bash
npm install wrangler        # 官方推荐项目内安装；全局 npm install -g wrangler 亦可
npx wrangler login
npx wrangler d1 execute sms-gateway-db --file=schema.sql --remote
npx wrangler secret put RECEIVE_TOKEN
npx wrangler secret put ADMIN_PASSWORD   # 仅开登录时需要
npx wrangler deploy
```

## 注意事项与常见问题

- **收不到转发短信**：依次排查 ① SmsForwarder 通用设置「转发短信广播」总开关（最容易漏，关了会静默丢弃且通道测试全绿）→ ② 转发规则的 token/URL 是否与 Worker 密钥一致 → ③ Worker 实时日志看请求是否到达
- **通知渠道没收到**：确认对应渠道变量已配置且值正确；看 Worker 实时日志有无 `notify forward failed:`；`duplicated:true` 的消息不会转发
- **Worker 免费额度**：每天 10 万次请求，个人使用绰绰有余；D1 免费额度每天 500 万行读取
- **长轮询**：管理页 `/api/wait` 挂起最长 25 秒等待新消息，Workers 无请求时长问题，实时性最好
- **数据迁移**：从其他平台迁回 CF 时，导出 Turso 数据再导入 D1 即可（表结构完全一致）
