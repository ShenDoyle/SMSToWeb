# 多平台部署总览

SMSToWeb 的全部六个平台（Cloudflare 主版本 + 五个移植平台）都在本目录。**每个平台子目录完全自包含**：
代码（入口 + 核心应用 + 数据库适配层）+ `schema.sql` + 该平台的详细部署教程（README.md）。

| 平台 | 运行时 | 定时清理 | 详细教程 |
|---|---|---|---|
| **Cloudflare**（主版本） | Worker + D1 | 平台 cron | [cloudflare/README.md](cloudflare/README.md) |
| Vercel | Edge Function | 平台 cron | [vercel/README.md](vercel/README.md) |
| Deno Deploy | Deno 原生 | `Deno.cron`（内置） | [deno/README.md](deno/README.md) |
| Netlify | Functions v2（Node） | Scheduled Function | [netlify/README.md](netlify/README.md) |
| EdgeOne Makers（腾讯） | Functions | 外部 cron 调 /api/cron | [edgeone/README.md](edgeone/README.md) |
| Fly.io / Railway / VPS | Docker（Node 22）+ Turso/本地 SQLite | 进程内置 | [node/README.md](node/README.md) |

六平台（含 Cloudflare）接口路径、鉴权逻辑、消息模型、管理页、多渠道通知转发、每日清理（UTC 17:00）完全一致，
数据表结构相同，可随时互相迁移。

## 平台怎么选

- **想要零成本 + 省心** → Cloudflare 主版本（D1 免费额度大，Worker 无时长问题）
- **想体验多平台** → Deno Deploy（与 Worker 语义最接近，长轮询基本无截断）
- **主要国内访问** → EdgeOne Makers（注意自定义域名需备案）
- **已有服务器 / 想完全自控** → node/（Docker 自托管）

> **长轮询与平台超时**：管理页通过 `GET /api/wait` 挂起等待新消息，默认最长 25 秒，可用环境变量 `WAIT_MAX_SECONDS`（3–25）按平台下调。
> Netlify Functions 默认 10 秒上限 → 设 `8`；Vercel Edge 建议 `20`；Cloudflare / Deno / Node 保持默认即可。
> 前端对失败做**指数退避**（1→30s）并在页面重新可见时立即补拉，即使被平台提前截断也**不会影响功能**，仅新消息提醒稍有延迟。

## 通用准备（所有非 Cloudflare 平台共用）

**数据库统一用 [Turso](https://turso.tech)**（SQLite 兼容，免费额度：100 个数据库、5GB 存储、每月 5 亿行读取）：

1. 打开 [turso.tech](https://turso.tech)，用 GitHub 登录
2. **Create Database**：名称 `sms-gateway`，区域选 Singapore / Hong Kong，类型 Free
3. 数据库详情页记下 **Database URL**（`libsql://sms-gateway-xxxx.turso.io`）；点 **Create Token** 创建令牌并立即保存（只显示一次）
4. 初始化表结构：详情页 **Console** 中粘贴各平台目录内 `schema.sql` 全部内容执行（与仓库根目录 `schema.sql` 相同）

CLI 等价命令：

```bash
turso auth login
turso db create sms-gateway          # 创建数据库
turso db show sms-gateway --url      # 查看 URL
turso db tokens create sms-gateway   # 创建令牌
turso db shell sms-gateway < schema.sql   # 建表
```

**环境变量**（各平台设置面板配置，完整说明见各平台教程）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `TURSO_DATABASE_URL` | 是 | `libsql://sms-gateway-<组织>.turso.io` |
| `TURSO_AUTH_TOKEN` | 是 | 数据库访问令牌 |
| `RECEIVE_TOKEN` | 是 | 推送鉴权密钥（与接入端 URL 中 `token=` 一致） |
| `ENABLE_AUTH` | 否 | `"true"` 管理页需登录（**安全强烈建议开启**，见下方安全建议）；默认免登录 |
| `ADMIN_PASSWORD` | 否 | 登录密码（`ENABLE_AUTH="true"` 时配置；漏配不会锁死——按免登录运行并告警） |
| `RETENTION_DAYS` | 否 | 数据保留天数，默认 30 |
| `WAIT_MAX_SECONDS` | 否 | 长轮询挂起秒数（3–25，默认 25）；Netlify 设 `8`、Vercel Edge 设 `20` |
| 通知渠道变量 | 否 | `FEISHU_WEBHOOK`（飞书）/ `WECOM_WEBHOOK`（企微）/ `DINGTALK_WEBHOOK`（钉钉，可选 `DINGTALK_SECRET` 加签）/ `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY`（可选 `BARK_URL`）/ `NTFY_URL`（可选 `NTFY_TOKEN`）/ `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO`（邮件，可选 `MAIL_FROM`）/ `GENERIC_WEBHOOKS`（通用 Webhook，可选 `GENERIC_WEBHOOK_TEMPLATE` 请求体 / `GENERIC_WEBHOOK_HEADERS` 请求头）。配置哪个转发哪个，全部不配置则不转发 |
| `SITE_NAME` / `SITE_ICON` | 否 | 网站名 / 图标 URL，未设置用默认值 |
| `CRON_SECRET`（仅 Vercel） | 否 | 设为与 `RECEIVE_TOKEN` 相同值，供 Vercel Cron 调 /api/cron |
| `SQLITE_PATH`（仅 node 自托管） | 否 | 本地 SQLite 模式：设置后免外部数据库（需 Node 22.13+，见 node/README.md） |

> **安全强烈建议**
> 1. **开启管理页登录**（`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`）：管理页承载短信验证码等敏感内容，默认免登录意味着知道域名的人都能查看全部消息并删除数据。登录接口已内置限速（同 IP 连续失败 5 次锁定 10 分钟）；`/api/receive`、`/api/push` 另有每 IP 每分钟 120 次的写入限速（超限返回 429）。
> 2. **推送 token 走 URL query 的取舍**：为兼容 SmsForwarder 等客户端，`/api/receive`、`/api/push` 支持 `?token=` 查询参数传鉴权——token 会出现在 URL 中，可能进入平台访问日志、浏览器历史。介意的话请改用 POST + 请求头 `Authorization: Bearer <RECEIVE_TOKEN>` 传递（两种方式都支持）。

## 目录结构

```
platforms/
├── cloudflare/ # 主版本：worker.js + schema.sql + wrangler.toml + README.md（自包含）
├── vercel/     # api/[[...route]].js + app.js + db.js + schema.sql + vercel.json + README.md
├── netlify/    # functions/{api,cron}.mjs + app.js + db.js + schema.sql + netlify.toml + README.md
├── deno/       # main.js + app.js + db.js + schema.sql + README.md
├── edgeone/    # functions/{[[default]].js,index.js} + app.js + db.js + schema.sql + README.md
├── node/       # server.mjs + app.js + db.js + schema.sql + Dockerfile + package.json + README.md
├── shared/     # app.js / db.js 唯一源（gen_app.py 由此同步到各平台目录）
└── gen_app.py  # 生成器：从 ../src/worker.js 生成 app.js 并同步全部平台（含 cloudflare 独立副本）
```

每个平台目录可单独作为部署根目录（Git 部署时把平台 Root Directory 指到对应子目录即可），
零 npm 依赖、无需构建。`src/worker.js` 有更新后执行 `python platforms/gen_app.py` 一键同步全部平台（CI 校验零漂移，`node tests/run.mjs` 覆盖 26 项功能断言）。

## 从 Cloudflare Worker 迁移到其他平台

1. 按上文准备 Turso 库并建表
2. （可选）迁移历史数据：CF Dashboard 导出 D1 数据（SQLite 文件）→ `turso db import` 导入（见官方 CLI 文档）
3. 按目标平台 README 部署，验证管理页与 /api/push 正常
4. 把手机端与各推送脚本的 Webhook 域名换到新平台
5. 观察一两天无异常后停用旧 Worker

## 通用说明

- API 路径全平台一致：`/api/receive`、`/api/push`、`/api/messages`（支持 `device_id`/`source`/`range`/`q`/`limit`/`page`/`starred`/`unread`）、`/api/messages/star`、`/api/messages/read`、`/api/messages/remove`、`/api/messages/restore`、`/api/messages/clear`、`/api/export`（CSV/JSON）、`/api/sources`、`/api/stats`、`/api/phone`（归属地）、`/api/devices`、`/api/devices/alias`、`/api/devices/merge`、`/api/wait`、`/api/login`、`/api/logout`、`/api/cron`；另有公开的 `/manifest.webmanifest`、`/sw.js`
- `/api/cron` 供外部调度器触发清理，鉴权：`?token=<RECEIVE_TOKEN>` 或 `Authorization: Bearer <RECEIVE_TOKEN>`
- `/api/receive` 与 `/api/push` 不受登录开关影响
