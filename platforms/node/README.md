# 自托管部署教程（Fly.io / Railway / VPS / 本地）

把 SMSToWeb 以 Docker 容器方式自托管。进程常驻、无函数时长限制，长轮询实时性最佳，适合有现成服务器或想部署到 Fly.io / Railway 的用户（免费额度情况见下文「平台说明」）。

**本目录文件**：`server.mjs`（零依赖入口，含内置每日清理）、`lifecycle.mjs`（**Node 专属**：后台任务登记 + 停机编排，M-1）、`app.js`（核心应用）、`db.js`（Turso / 本地 SQLite 双模式适配层）、`schema.sql`（建表）、`Dockerfile`、`package.json`。

> 运行环境：`Dockerfile` 基于 `node:22-alpine`；直接 `node server.mjs` 时，Turso 模式需 Node 18+，**本地 SQLite 模式需 Node 22.13+**（内置 `node:sqlite`）。

---

## 第零步（必做）：把「停止宽限」设为 90 秒

**先做这一步，再开始部署。** Docker 默认只给容器 **10 秒** 就强制杀掉进程，而本应用最多需要 **80 秒** 才能把正在处理的请求和后台通知收尾。不配置会出现「消息已经收到、但通知没发出去」「重启时正在处理的请求被掐断」。

> 这一步**只能由你（部署者）在自己的服务器或平台上设置**，项目代码和 `Dockerfile` 里的说明都**不能**替你设置。请按你实际使用的方式，**只做对应的一种**，不需要四种全做。

| 你的部署方式 | 在哪里设置 | 直接复制的配置 |
|---|---|---|
| 用 `docker run` 启动 | 启动命令 | `docker run --stop-timeout=90 ...`（下方方式 C 已含） |
| 手动停止容器 | 每次停止的命令 | `docker stop --timeout 90 smstoweb` |
| Docker Compose | `compose.yaml` 对应服务下 | `stop_grace_period: 90s` |
| systemd 服务 | `.service` 的 `[Service]` 段 | `TimeoutStopSec=90s` |
| Fly.io / Railway | 平台控制台 | 本仓库**未验证**这两个平台能否把停机宽限设为 90s，请先查阅平台当前文档；不能设置时请理解「后台通知可能在重启时丢失」这一后果 |

可复制的示例模板：[compose.example.yaml](../../docs/deploy-templates/compose.example.yaml) · [smstoweb.service.example](../../docs/deploy-templates/smstoweb.service.example) · [docker-run.example.sh](../../docs/deploy-templates/docker-run.example.sh)。它们是**示例模板**，不是仓库内已生效的生产配置。

**完成标志**：容器启动日志打印 `shutdown_grace=80s`，并且你能在自己的部署方式里确认停止宽限 ≥ 90s。

> **本地验证 ≠ 生产已配置**：本项目在 WSL2 + Docker **本地环境**用真实 `docker stop --timeout 90` 验证过退出码 0、后台通知完成、SQLite 在任务完成后才关闭（证据在仓库外 `M1-fix/`）。这不等于你的生产环境已配置好，生产侧仍须由你执行上表配置。

应用内部时间预算（**无需你设置**）：HTTP 在途 30s + 后台任务 drain 45s + 收尾 5s = **80s**；`SHUTDOWN_GRACE_MS` 可调大到 `120000`，但不能低于 `80000`。

---

## 准备工作

- Fly.io / Railway 账号，或任意装了 Docker 的 VPS（**并完成上面的第零步**）
- 数据库用 Turso（SQLite 兼容），下面第一步统一准备；也可选本地 SQLite（`SQLITE_PATH`），则不需要 Turso

## 第一步：创建 Turso 数据库

1. 打开 [turso.tech](https://turso.tech)，点 **Start for free now**，用 GitHub 登录
2. 进入控制台 → **Create Database**：
   - Name：`sms-gateway`
   - Location：选离服务器近的区域
   - Type：Free
3. 创建后进入数据库详情页：
   - 记下 **Database URL**（形如 `libsql://sms-gateway-xxxx.turso.io`）
   - 点 **Create Token** 创建访问令牌，**立即复制保存**（只显示一次）
4. 初始化表结构：数据库详情页 → **Console** → 把本目录 [`schema.sql`](schema.sql) 全部内容粘贴进去 → 执行 → 提示成功

> CLI 方式：`turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`。

## 方式 A：Fly.io

1. 本地安装 flyctl（[官方安装指引](https://fly.io/docs/flyctl/install/)）后 `fly auth login`
2. 在本目录执行：

```bash
cd platforms/node
fly launch                 # 按提示创建应用：区域自选；询问数据库时选 No（我们用 Turso）
fly secrets set TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io TURSO_AUTH_TOKEN=<你的令牌> RECEIVE_TOKEN=<你的密钥>
fly secrets set ENABLE_AUTH=true ADMIN_PASSWORD=<你的密码>     # 可选
fly deploy
fly status                 # 记下分配的域名 https://<app>.fly.dev
```

3. 验证：浏览器打开 `https://<app>.fly.dev` 应看到管理页；推送测试：

```
curl "https://<app>.fly.dev/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Fly 部署成功\"}"
```

4. 自定义域名：`fly certs add sms.你的域名.com`，按提示加 DNS（A 记录或 CNAME）

## 方式 B：Railway

1. 登录 [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**，选择你 Fork 的仓库
2. 服务设置 **Settings → Root Directory**：`platforms/node`（Railway 自动识别 Dockerfile 并构建）
3. **Variables** 面板添加环境变量（见下方通用表；`PORT` 平台自动注入，代码已适配）
4. **Settings → Public Networking → Generate Domain** 生成公网域名
5. 验证同上（换成你的 Railway 域名）

## 方式 C：任意 VPS（Docker）

```bash
# 上传本目录到服务器后
cd platforms/node
docker build -t smstoweb .
docker run -d --name smstoweb --restart unless-stopped --stop-timeout=90 -p 8787:8787 \
  -e TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io \
  -e TURSO_AUTH_TOKEN=<你的令牌> \
  -e RECEIVE_TOKEN=<你的密钥> \
  smstoweb
# 验证
curl "http://127.0.0.1:8787/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"content\":\"VPS 部署成功\"}"
```

建议用 Caddy/Nginx 反代加 HTTPS。不用 Docker 也可以直接 `node server.mjs`（Turso 模式 Node 18+；本地 SQLite 模式 Node 22.13+；零 npm 依赖）。直接运行时没有「容器宽限」这一层，但**进程管理器**（systemd / supervisor）仍必须给 ≥90s 停止宽限，否则同样会被提前杀掉。

## 环境变量（三种方式通用）

| 名称 | 值 | 说明 |
|---|---|---|
| `SQLITE_PATH`（可选） | 如 `/data/data.db` | **本地 SQLite 模式**：设置后免外部数据库，数据存本地文件（需 Node 22.13+，首次启动自动建表；与 Turso 二选一，设置后优先） |
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | Turso 模式：第一步记下的 URL |
| `TURSO_AUTH_TOKEN` | （第一步的令牌） | Turso 模式：只显示一次的那个 |
| `RECEIVE_TOKEN` | 自己编的长随机串 | 推送鉴权，勿用示例值 |
| `ENABLE_AUTH` | `false` | 要登录改 `true`（**安全强烈建议开启**：管理页承载短信验证码等敏感内容，默认免登录意味着知道域名即可查看全部消息） |
| `ADMIN_PASSWORD` | 自己编的密码 | 仅 `ENABLE_AUTH="true"` 时需要 |
| `SESSION_SECRET` | 高熵随机值（≥32 位随机字符串） | 仅 `ENABLE_AUTH="true"` 时需要；与密码独立；缺失时登录/鉴权安全失败，轮换后旧会话全部失效 |
| `RETENTION_DAYS` | `30` | 数据保留天数；可在管理页「业务设置」修改（数据库优先，本变量为兼容兜底） |
| `PORT` | 默认 `8787` | 一般无需设置（Railway 自动注入） |
| `SHUTDOWN_GRACE_MS` | 默认 `80000` | **应用内部**停机总宽限（毫秒）。可设 `90000`~`120000`；低于 `80000` 会被忽略。它**不能替代**容器/进程管理器的停止宽限，后者仍须按第零步设为 ≥90s |
| `FEISHU_WEBHOOK`（可选 `FEISHU_SECRET`） | （可选）飞书群机器人 Webhook | **推荐在管理页「设置 → 通知设置」配置（数据库优先）**；以下通知变量均为旧版兼容兜底。机器人安全设置选「签名校验」时另配 `FEISHU_SECRET` |
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

## 接入手机端与设备

按 [多平台接入部署指南](../../docs/多平台接入部署指南.md) 配置安卓 SmsForwarder 与各设备通知推送，域名用你的服务地址。

## 注意事项与常见问题

- **定时清理**：进程内置每天 UTC 17:00（北京 01:00）自动清理，无需配置。也可改用平台调度器（Fly Machines Cron / Railway Cron）调 `GET /api/cron?token=<RECEIVE_TOKEN>`，二选一
- **常驻进程优势**：无函数时长上限，`/api/wait` 长轮询与 Cloudflare Worker 体验一致，实时性最好
- **免费额度**：Fly.io 已无免费额度（仅新账号 7 天 / 2 VM 小时试用，绑卡即转按量计费，微用量费用很低）；Railway 提供一次性 $5 试用额度（30 天有效），Hobby 计划 $5/月含等额使用额度——长期零成本首选 Cloudflare 主版本
- **数据备份**：Turso 模式下数据都在 Turso，换服务器只需重新配好环境变量，数据无损；本地 SQLite 模式定期备份 `SQLITE_PATH` 文件即可
- **登录保护**：登录接口已内置限速——同一 IP 连续失败 5 次锁定 10 分钟（内存态，进程重启即清零）
- **http 部署登录**：局域网 IP / 无 TLS 的 http 访问可直接登录（cookie 自动降级，不强制 Secure），Alook 等浏览器登录后跳转正常
- **日志排查**：`fly logs` / Railway Deployments → Logs / `docker logs smstoweb`
