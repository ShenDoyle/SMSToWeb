# SMSToWeb — 短信/通知上云网关

> **Sync notice (2026-11-09) / 同步提示**：This translated mirror may lag behind the English primary `README.md` and the Chinese `docs/` primaries. **Verified current facts**: `tests/run.mjs` = **850 passing assertions** (plus the separate M-1 suite `tests/m1-lifecycle.mjs` = 32); `ENV_KEYS` = **33** variables; **all six platform entries pass a `waitUntil`-style `ctx`** (inline `await` is only a *runtime-capability* fallback, not an entry-point behaviour); Node shutdown grace = **80s** and the container/service stop grace must be **>= 90s** (Docker default 10s SIGKILLs first); `gen_app.py --check` verifies **only** the embedded `SCHEMA_SQL` block and SQL references, **not** platform-copy drift. Any statement in this mirror about "667/814/573 assertions", "31 variables", "other platforms finish notifications before the response", "8-second forced exit", "the deploy button creates the tables", or "one-click and you are live" is **outdated**. Read the [English primary](../../../README.md), [ARCHITECTURE](../../ARCHITECTURE.md), or the [Chinese user guide](../../guide/README.md) instead.
>
> **同步提示（2026-11-09）**：本镜像属滞后翻译，上述事实以英文主版与中文主文档为准；本文件内关于测试数量、环境变量数量、「其他平台响应前发完通知」、8 秒强制退出、按钮自动建表等旧表述均已过时，请勿据此部署或验收。源码 `v1.1.0` 已固化至 `main`（`43aaecf`）；未创建 GitHub Release、未打 tag、未部署。


[English](../../../README.md) | **简体中文** | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 本仓库文档以英语为主维护版本；本中文版与其它语言译文存放于 `docs/i18n/`，可能滞后于英语主版。

把 Android 手机的短信和各类设备的通知实时推送到云端，通过网页随时查看。

- **多平台部署**：Cloudflare（主版本）/ Vercel / Deno Deploy / Netlify / 腾讯 EdgeOne Makers / Docker 自托管，六选一，功能完全一致
- **实时接收**：Webhook 秒级入库，网页自动刷新，无需手动操作
- **通用推送**：任何能发 HTTP 请求的设备（Linux / Windows / macOS / iOS / NAS / 脚本）都能把通知推进同一个页面
- **来源与筛选**：按来源动态筛选（自动聚合短信 / 通知及自定义来源），叠加关键词搜索与今天 / 近 7 天 / 近 30 天时间范围，分页条数可调
- **消息列表**：默认 **10 条/页**；卡片显示两行摘要（最多 120 码位，Unicode 安全），点击打开全文；「加载更多」按游标渐进加载；打开详情自动标记已读，失败会回滚并提示
- **验证码**：服务端识别中文 / 英文 / 中英混合语境（4–8 位、分隔码、字母数字混合，剥离手机号/订单号/金额/日期干扰），卡片顶部右侧显示验证码并支持一键复制；Clipboard 失败时回退 `execCommand`，两者都失败会明确报错，不假报成功
- **多渠道通知**：新消息可自动转发到飞书 / 企微 / 钉钉 / Telegram / Server酱 / PushPlus / Bark / ntfy / Gotify / 邮件 / 自定义 Webhook；每个渠道支持**多个独立目标**，逐目标启停/重命名/删除/测试，单个目标失败不影响其他目标；旧环境变量仍作兼容回退
- **安全可选**：管理页登录开关、多格式验证码识别（码前/码后/分隔式/混合码，防误报）与一键复制、暗色模式
- **数据与提醒**：按当前筛选一键导出 CSV / JSON；页面可见时新消息有 toast / 可选提示音 / 悬浮提醒，后台时浏览器通知 + 标题未读；超长消息自动折叠
- **号码识别**：内置常见机构号码库（运营商 / 银行 / 快递 / 政务等）自动标注；未知手机号可选显示归属地（默认开启，可关）
- **九语言**：管理页与登录页内置简体中文 / 繁體中文 / English / 日本語 / 한국어 / Español / Français / Deutsch / Português (BR)，管理页在**设置中心 → 界面语言**切换（按浏览器保存，`?lang=` 可直连，选择记在本地）；日期、相对时间、号码机构名同步切换
- **移动端友好**：`viewport-fit` 安全区适配刘海屏与手势条、输入框 16px 防 iOS 自动放大、触控目标加大、底部抽屉式弹层、PWA 可添加到主屏幕
- **批量与撤销**：复选框与批量栏默认隐藏，右键/长按消息进入多选；批量已读、删除、按筛选清空、CSV/JSON 导出；删除后 5 秒内可撤销（软删除）；暗色模式支持自动 / 浅色 / 深色三态
- **收藏 / 未读 / 统计**：星标置顶、只看收藏 / 未读、统计面板（来源分布 + 近 7 天）；自定义号码标签；搜索高亮与历史；设置里可配免打扰与提示音；可添加到主屏幕（PWA）

## 界面截图

**消息中心总览** — 1180px 仪表盘：左侧消息列表，右侧为真实数据侧栏（设备与最近接收时间、设置概览、快捷统计）。筛选与搜索收在一条工具栏里；每页条数、免打扰与语言都放进设置中心。

![消息中心总览](../../../docs/images/overview.png)

**按需多选** — 复选框和批量栏默认隐藏。对任意消息右键（触屏长按）进入多选，行内批量栏提供全选、批量已读、删除、按筛选清空与 CSV/JSON 导出。

![按需多选](../../../docs/images/multi-select.png)

**消息详情** — 单行元信息（号码 · 类型 · 时间 · 设备 · 状态，有星标才追加 ★），底部操作整合为一行：左侧复制 / 星标 / 拨号 / 号码标签 / 删除，右侧关闭 / 已读切换；不显示消息 ID，也没有多余的信息网格。

![消息详情](../../../docs/images/detail.png)

**设置中心** — 四个分组（登录与会话 / 通知 / 数据与业务 / 安全）。界面语言、分页、消息开关与免打扰均为本浏览器作用域，统一走保存 / 取消 / 恢复默认；凭据只显示脱敏末位。

![设置中心](../../../docs/images/settings.png)

**通知多目标** — 每个渠道可配置多个目标（例如两个飞书群），支持逐目标启用、重命名、删除与测试；单个目标失败不影响其他目标。

![通知多目标](../../../docs/images/notification-targets.png)

**移动端布局** — 侧栏折叠到列表下方，弹层改为底部抽屉；默认隐藏的批量栏在 390px 宽度下仍不产生横向溢出。

![移动端布局](../../../docs/images/mobile.png)

```
【短信】Android(SmsForwarder) ──POST /api/receive──┐
                                                   ├─→ 云端网关（任选一平台）─→ 数据库
【通知】各平台脚本/快捷指令 ──POST /api/push────────┘         │
                                                  浏览器 ◀── 网页管理页（网关内嵌）
```

**一键部署（Cloudflare 主版本，约 2 分钟）**：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

按钮实际做的事：把公开仓库克隆到你自己的 GitHub/GitLab → **自动创建并绑定 D1 数据库**及 `wrangler.toml` 声明的平台原生资源 → 配置构建/CI。按钮**不会执行建表 SQL**（由应用的 `ensureSchema` 在首次请求自动建表）、**不会创建 Turso 数据库**、也**不会替你填密钥**，仍需在设置页手工填 `RECEIVE_TOKEN`（开启登录时还要 `ADMIN_PASSWORD` / `SESSION_SECRET`）。准确说法是**「一键创建应用 + 填几项配置」**，不是「点一下就上线」。按钮部署的是公开仓库 `main` 分支，当前已固化 `v1.1.0`（`43aaecf`）；但尚未创建 GitHub Release、未打 tag、未部署。完整能力矩阵见 [部署能力矩阵](../../guide/10-部署能力矩阵.md)。

| 平台 | 部署方式 | 定时清理 | 详细教程 |
|---|---|---|---|
| **Cloudflare**（推荐） | Worker + D1 | 平台 cron | [platforms/cloudflare/README.md](../../../platforms/cloudflare/README.md) |
| Vercel | Edge Function + Turso | 平台 cron | [platforms/vercel/README.md](../../../platforms/vercel/README.md) |
| Deno Deploy | Deno 原生 + Turso | Deno.cron | [platforms/deno/README.md](../../../platforms/deno/README.md) |
| Netlify | Functions v2 + Turso | Scheduled Function | [platforms/netlify/README.md](../../../platforms/netlify/README.md) |
| 腾讯 EdgeOne Makers | Functions + Turso | 外部 cron | [platforms/edgeone/README.md](../../../platforms/edgeone/README.md) |
| Fly.io / Railway / VPS | Docker（Node 22）+ Turso/本地 SQLite | 进程内置 | [platforms/node/README.md](../../../platforms/node/README.md) |

> 每个平台目录**完全自包含**（代码 + schema + 独立文档，零 npm 依赖、无需构建），点上表「详细教程」即可按步骤部署。功能与数据表结构全平台一致，可随时互相迁移。
> 平台对比与通用准备（Turso 数据库）见 [platforms/README.md](../../../platforms/README.md)。

### 各平台运行时差异（部署前看一眼）

业务代码六平台逐字节一致，但**运行时的超时/后台任务/定时器**能力不同，必要时用环境变量适配：

| 平台 | 函数超时 | 后台通知 | 定时清理 | 建议 |
|---|---|---|---|---|
| Cloudflare | 无固定墙钟（CPU 受限） | `ctx.waitUntil` 响应后继续 | 平台 cron | 默认配置即可 |
| Vercel Edge | 单次请求约 25 秒上限 | 响应前内联完成 | 平台 cron | `WAIT_MAX_SECONDS=20` |
| Netlify Functions | 60s（全计划一致） | 响应前内联完成 | scheduled function | 入口默认 `WAIT_MAX_SECONDS=8` |
| Deno Deploy | 视套餐 | 响应前内联完成 | 需外部触发 | 外部 cron 调 `/api/cron?token=` |
| EdgeOne Makers | 视套餐 | 响应前内联完成 | 需外部触发 | `WAIT_MAX_SECONDS` 按套餐下调 |
| Node / Docker | 自定 | 响应前内联完成 | 需外部触发 | 本地 SQLite 需 Node ≥ 22.13 |

> - **长轮询**：前端对失败自动**指数退避**（2→30s），并在页面重新可见时立即补拉，平台强杀请求也不会打爆函数。
> - **通知转发**：**六个平台入口都传 `waitUntil` 型 `ctx`**，差别只在运行时是否真的提供 `waitUntil`：提供则响应后继续发送；缺失时 `bgRun` 才回退内联 `await`（响应会等待）。旧版「其余平台响应前把通知发完」的说法不准确，见 [ARCHITECTURE §4](../../ARCHITECTURE.md)。单渠道 fetch 超时 10s。
> - **定时清理**：无平台 cron 的部署，用任意定时器请求 `GET /api/cron?token=<RECEIVE_TOKEN>` 即可。

---

## 手机端与多平台接入

所有平台把消息推进同一个网页：手机短信走 `/api/receive`（安卓 SmsForwarder），其余一切通知走通用接口 `/api/push`。

分步配置（每平台附可直接复制的命令/脚本）：**[docs/多平台接入部署指南.md](../../../docs/多平台接入部署指南.md)**

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
| `ADMIN_PASSWORD` | 否 | 登录密码（`ENABLE_AUTH="true"` 时配置；漏配时管理接口一律拒绝访问并告警——配置缺失不放行） |
| `RETENTION_DAYS` | 否 | 数据保留天数，默认 30 |
| `WAIT_MAX_SECONDS` | 否 | 长轮询 `/api/wait` 最长挂起秒数，默认 25（范围 3–25）。部署在 **Netlify Functions**（默认 10s 上限）或其它短超时平台时设成 `8`，避免请求被平台强杀 |
| `PHONE_AREA_ENABLED` / `PHONE_AREA_API` | 否 | 号码归属地：默认开启（360 免费接口、无 key、后端缓存 24h，仅查 11 位手机号）；设 `false` 关闭；自定义源用 `PHONE_AREA_API`（URL 含 `{number}` 占位） |
| 通知渠道变量 | 否 | `FEISHU_WEBHOOK`（飞书）/ `WECOM_WEBHOOK`（企微）/ `DINGTALK_WEBHOOK`（钉钉，可选 `DINGTALK_SECRET` 加签）/ `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY`（可选 `BARK_URL`）/ `NTFY_URL`（可选 `NTFY_TOKEN`）/ `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO`（邮件，可选 `MAIL_FROM`）/ `GENERIC_WEBHOOKS`（通用 Webhook，可选 `GENERIC_WEBHOOK_TEMPLATE` 请求体 / `GENERIC_WEBHOOK_HEADERS` 请求头）。配置哪个转发哪个，全部不配置则不转发；通知按内容自动三态渲染（🔐 验证码 / 💬 短信 / 🔔 通知） |
| `SITE_NAME` / `SITE_ICON` | 否 | 网站名 / 图标 URL，未设置用默认值 |
| `NOTIFY_LINK` | 否 | 管理页首页地址；配置后所有通知渠道附「打开管理页」入口（按钮/链接/click），未配置自动省略 |
| `SESSION_SECRET` | 开启登录时必须 | 登录会话签名密钥：**高熵随机值（建议 ≥32 位随机字符串），与管理密码完全独立**，Cloudflare 与 EdgeOne（及各平台）须分别配置独立值；严禁提交到 Git 或复用密码。缺失时登录与鉴权**安全失败**（登录返回 500、管理接口一律 401，不回退密码派生）。轮换（更换值）后所有旧会话立即失效，需重新登录。会话有效期 30 分钟；退出登录仅清除浏览器 Cookie，已复制的会话 Token 在 TTL 内（最长 30 分钟）仍可能有效 |

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
- **从旧版本升级（新增列）** → 旧库需执行：`ALTER TABLE messages ADD COLUMN deleted_at TEXT;`、`ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;`、`ALTER TABLE messages ADD COLUMN read_at TEXT;`（新库建表已包含；node 本地 SQLite 启动时自动补列）

## 开发说明

- `src/worker.js`：核心源码（Cloudflare Worker 形态）
- `platforms/gen_app.py`：从 `src/worker.js` 生成平台无关的 `app.js` 同步到五个移植平台，并同步 Cloudflare 独立副本 `worker.js`（保证六平台业务代码逐字节一致）；同时把 31 项环境变量白名单（ENV_KEYS，含鉴权项）同步到六个平台入口，防各平台透传漂移（node 的 db.js 为 Turso+本地 SQLite 双适配，独立维护不参与同步）
- `platforms/*/`：各平台自包含部署目录（入口 + app.js + db.js 适配层 + schema.sql + 本平台教程）
- `docs/i18n/en/`：英语文档集（部署/API/架构/数据库）；其它语言见 `docs/i18n/<lang>/`，导航见 [docs/i18n/README.md](../README.md)
- `tests/run.mjs`：零依赖测试套件（需 Node 22.13+，**850 项断言全通过**）：`node tests/run.mjs`；另有 M-1 专项 `tests/m1-lifecycle.mjs`（**32 项**，独立运行）
- 修改核心代码后：`python platforms/gen_app.py`（**写入模式**）重新同步全部平台，再依次跑 `--check`、`node tests/run.mjs`、语法检查与**六平台字节比对**。注意 `--check` 只校验 `SCHEMA_SQL` 内嵌块与 SQL 引用，**不校验副本一致性**，不能单独用来证明零漂移

## License

[MIT](../../../LICENSE) © 2026 [左立方](https://cbm.im/)
