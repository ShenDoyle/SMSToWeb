# SMSToWeb — 短信/通知上云网关

把 Android 手机的短信和各类设备的通知实时推送到云端，通过网页随时查看。免费部署、无需服务器、约 10 分钟完成。

- **多平台部署**：Cloudflare（主版本）/ Vercel / Deno Deploy / Netlify / 腾讯 EdgeOne Makers / Docker 自托管，六选一，功能完全一致
- **实时接收**：Webhook 秒级入库，网页自动刷新，无需手动操作
- **通用推送**：任何能发 HTTP 请求的设备（Linux / Windows / macOS / iOS / NAS / 脚本）都能把通知推进同一个页面
- **来源与筛选**：按来源动态筛选（自动聚合短信 / 通知及自定义来源），叠加关键词搜索与今天 / 近 7 天 / 近 30 天时间范围，分页条数可调
- **多渠道通知**：新消息可自动转发到飞书 / 企微 / 钉钉 / Telegram / Server酱 / PushPlus / Bark / ntfy / Gotify / 邮件 / 自定义 Webhook，配置哪个转发哪个（可选）
- **安全可选**：管理页登录开关、多格式验证码识别（码前/码后/分隔式/混合码，防误报）与一键复制、暗色模式
- **数据与提醒**：按当前筛选一键导出 CSV / JSON；页面可见时新消息有 toast / 可选提示音 / 悬浮提醒，后台时浏览器通知 + 标题未读；超长消息自动折叠

```
【短信】Android(SmsForwarder) ──POST /api/receive──┐
                                                   ├─→ 云端网关（任选一平台）─→ 数据库
【通知】各平台脚本/快捷指令 ──POST /api/push────────┘         │
                                                  浏览器 ◀── 网页管理页（网关内嵌）
```

| 平台 | 部署方式 | 定时清理 | 详细教程 |
|---|---|---|---|
| **Cloudflare**（推荐） | Worker + D1 | 平台 cron | [platforms/cloudflare/README.md](platforms/cloudflare/README.md) |
| Vercel | Edge Function + Turso | 平台 cron | [platforms/vercel/README.md](platforms/vercel/README.md) |
| Deno Deploy | Deno 原生 + Turso | Deno.cron | [platforms/deno/README.md](platforms/deno/README.md) |
| Netlify | Functions v2 + Turso | Scheduled Function | [platforms/netlify/README.md](platforms/netlify/README.md) |
| 腾讯 EdgeOne Makers | Functions + Turso | 外部 cron | [platforms/edgeone/README.md](platforms/edgeone/README.md) |
| Fly.io / Railway / VPS | Docker（Node 22）+ Turso/本地 SQLite | 进程内置 | [platforms/node/README.md](platforms/node/README.md) |

> 每个平台目录**完全自包含**（代码 + schema + 独立文档，零 npm 依赖、无需构建），点上表「详细教程」即可按步骤部署。功能与数据表结构全平台一致，可随时互相迁移。
> 平台对比与通用准备（Turso 数据库）见 [platforms/README.md](platforms/README.md)。

---

## 手机端与多平台接入

所有平台把消息推进同一个网页：手机短信走 `/api/receive`（安卓 SmsForwarder），其余一切通知走通用接口 `/api/push`。

分步配置（每平台附可直接复制的命令/脚本）：**[docs/多平台接入部署指南.md](docs/多平台接入部署指南.md)**

**通用推送接口速览**（详细字段见接入指南）：

```
POST https://<你的域名>/api/push?token=<RECEIVE_TOKEN>
{"source":"notify","sender":"demo","content":"hello from anywhere"}
```

返回 `{"success":true,...}` 即入库；完全相同的重复推送返回 `duplicated:true`。

## 环境变量（各平台通用）

| 变量 | 必填 | 说明 |
|---|---|---|
| `RECEIVE_TOKEN` | 是 | 推送鉴权密钥，自己编一个足够长的随机字符串 |
| `ENABLE_AUTH` | 否 | `"true"` 管理页需登录（**安全强烈建议开启**，见下方安全建议）；默认免登录 |
| `ADMIN_PASSWORD` | 否 | 登录密码（`ENABLE_AUTH="true"` 时配置；漏配不会锁死——按免登录运行并告警） |
| `RETENTION_DAYS` | 否 | 数据保留天数，默认 30 |
| 通知渠道变量 | 否 | `FEISHU_WEBHOOK`（飞书）/ `WECOM_WEBHOOK`（企微）/ `DINGTALK_WEBHOOK`（钉钉，可选 `DINGTALK_SECRET` 加签）/ `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY`（可选 `BARK_URL`）/ `NTFY_URL`（可选 `NTFY_TOKEN`）/ `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO`（邮件，可选 `MAIL_FROM`）/ `GENERIC_WEBHOOKS`（通用 Webhook，可选 `GENERIC_WEBHOOK_TEMPLATE` 请求体 / `GENERIC_WEBHOOK_HEADERS` 请求头）。配置哪个转发哪个，全部不配置则不转发 |
| `SITE_NAME` / `SITE_ICON` | 否 | 网站名 / 图标 URL，未设置用默认值 |

Cloudflare 平台额外需要 `DB`（D1 绑定）；其余平台需要 `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`（Turso 数据库，见各平台教程）；Node 自托管另支持 `SQLITE_PATH` 本地 SQLite 模式（见 platforms/node/README.md）。

> **安全强烈建议**
> 1. **开启管理页登录**（`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`）：管理页承载短信验证码等敏感内容，默认免登录意味着知道域名的人都能查看全部消息并删除数据。登录接口已内置限速（同 IP 连续失败 5 次锁定 10 分钟）；`/api/receive`、`/api/push` 另有每 IP 每分钟 120 次的写入限速（超限返回 429）。
> 2. **推送 token 走 URL query 的取舍**：为兼容 SmsForwarder 等客户端，`/api/receive`、`/api/push` 支持 `?token=` 查询参数传鉴权——token 会出现在 URL 中，可能进入平台访问日志、浏览器历史。介意的话请改用 POST + 请求头 `Authorization: Bearer <RECEIVE_TOKEN>` 传递（两种方式都支持）。

## 常见问题（通用）

- **标签显示 `{{XXX}}` 字面量** → 不会发生：网关检测到 `{{` 字面量会自动置空，标签回退显示 `sim`；标签名请在模板 `name` 字段直接填自定义名
- **接口 401/403** → 检查 URL 里 `token=` 与 `RECEIVE_TOKEN` 是否一致；`/api/receive`、`/api/push` 不受登录开关影响
- **接口 429** → 触发写入限速（每 IP 每分钟 120 次），等 1 分钟自动恢复；正常使用不会碰到，出现说明 token 可能已泄露或被脚本刷库
- **超长消息** → 单条正文最多保存 8000 字符，超出部分自动截断
- **设备标签改名** → 标签名由消息模板 `name` 字段决定，改 `name` 会生成新标签；网页上点标签后的「✎」可重命名、「⇄」可把该标签的消息合并到另一设备，无消息的标签可直接「×」删除

## 开发说明

- `src/worker.js`：核心源码（Cloudflare Worker 形态）
- `platforms/gen_app.py`：从 `src/worker.js` 生成平台无关的 `app.js` 同步到五个移植平台，并同步 Cloudflare 独立副本 `worker.js`（保证六平台业务代码逐字节一致）；同时把 27 个渠道/站点环境变量白名单（ENV_KEYS）同步到六个平台入口，防各平台透传漂移（node 的 db.js 为 Turso+本地 SQLite 双适配，独立维护不参与同步）
- `platforms/*/`：各平台自包含部署目录（入口 + app.js + db.js 适配层 + schema.sql + 本平台教程）
- `docs/多平台接入部署指南.md`：接收端配置文档
- `tests/run.mjs`：零依赖测试套件（需 Node 22.13+）：`node tests/run.mjs`
- 修改核心代码后：`python platforms/gen_app.py` 重新同步全部平台，再跑 `node tests/run.mjs`；CI 会校验同步零漂移 + 语法 + 测试

## License

[MIT](LICENSE) © 2026 [左立方](https://cbm.im/)
