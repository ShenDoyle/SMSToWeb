# 架构文档（ARCHITECTURE）

SMSToWeb 是一个「单核心 + 多平台入口」的短信/通知聚合系统：一份零 npm 依赖的业务核心（`src/worker.js`），通过生成脚本同步到六个部署平台，各平台仅保留薄适配层对接自家运行时与数据库。

## 1. 总体拓扑

```
手机（SmsForwarder / 任意脚本）
   │  POST /api/receive（短信）或 /api/push（通用推送）+ token
   ▼
┌─────────────────────────── 任选一个平台部署 ────────────────────────────┐
│  Cloudflare Workers (D1)   Vercel Edge   Deno Deploy                     │
│  Netlify Functions         EdgeOne (Turso)   Node 自托管 (Docker)         │
│                                                                           │
│  入口层（薄适配）：接收请求 → buildEnv 透传环境变量 → fetchApp()          │
│  业务核心（单文件 app.js）：鉴权 → 入库 → 查询 → 长轮询 → 通知转发        │
└──────────────────────────────────────────────────────────────────────────┘
   │                                  │
   ▼                                  ▼
管理页（内嵌 HTML，登录鉴权）      11 渠道通知转发（飞书/企微/钉钉/…）
```

核心设计原则：**业务代码与平台入口分离**。核心逻辑不随部署平台修改，仅通过薄适配层对接各平台的运行时与数据库接口；六平台功能严格一致。

## 2. 目录结构

```
src/worker.js                 # 唯一业务源文件（Cloudflare Worker 形态：export default { fetch, scheduled }）
platforms/
  gen_app.py                 # 同步生成脚本（见 §3）
  shared/app.js               # 生成产物：与 src/worker.js 业务部分逐字节一致，仅替换导出形态
  cloudflare/                 # CF 主版本副本 + wrangler.toml（静态维护）
  vercel/  netlify/  deno/    # 各平台自包含目录：入口 + app.js + db.js + schema.sql + README
  edgeone/ node/              # EdgeOne 走 Turso；node/db.js 为 Turso + 本地 SQLite 双适配（独立维护）
tests/run.mjs                 # 零依赖测试套件（node:sqlite，204 项）
docs/                         # 文档（本目录）
schema.sql                    # 数据库建表脚本（单一来源）
```

各平台目录**完全自包含**：入口只引用本目录内的 `app.js` / `db.js`，可独立部署、互不依赖。

## 3. 同步机制（platforms/gen_app.py）

`python platforms/gen_app.py` 一键完成（幂等，重跑无漂移）：

1. 以 `src/worker.js` 为唯一源，截取 `export default {` 之前的全部业务代码，拼接生成通用导出尾巴（`fetchApp` / `runCron` / `handleCronRequest`），写入 `platforms/shared/app.js`；
2. 将 shared 副本与 `shared/db.js`、根 `schema.sql` 复制到各平台目录（`node/db.js` 除外，独立维护）；
3. 用脚本内 **ENV_KEYS 白名单**（单一清单，含 31 个环境变量）替换各入口文件 `/* ==== ENV_KEYS BEGIN ==== */ … /* ==== ENV_KEYS END ==== */` 标记块之间的内容，保证六平台透传的环境变量集合一致，防漂移。

铁律：**任何业务改动只改 `src/worker.js`（与 gen_app.py 的 ENV_KEYS），改完必须重跑 gen_app.py**；禁止直接手改任何 platforms/ 下的生成产物（除 node/db.js 与 wrangler.toml）。

## 4. 请求生命周期

以 `POST /api/receive` 为例：

1. **入口层**：平台入口（如 `platforms/edgeone/functions/index.js`）接收请求，构造 `env = buildEnv(vars)`（透传白名单变量 + 数据库凭据分支），调用 `fetchApp(request, env[, ctx])`；
2. **鉴权**：`/api/receive`、`/api/push`、`/api/login`、`/api/logout`、`/api/cron`、静态资源为公开路径；其余管理与页面接口受登录开关（`ENABLE_AUTH`）控制——登录后签发**无状态签名 Session**（`nonce.exp.HMAC-SHA256` 三段式，Cookie `sms_auth`，TTL 30 分钟），`SESSION_SECRET` 缺失时安全失败（登录 500、管理接口一律 401，不回退密码派生），配置缺失一律不放行；
3. **入库**：校验 token（`safeEqual` 防时序攻击）→ 按 device+sim 定位/创建设备 → 写入 messages（数据库唯一索引兜底去重，重复推送返回 `duplicated:true` 且不转发）；
4. **通知转发**：非重复消息经 `bgRun(ctx, dispatchNotify(env, msg))` 进入后台——Cloudflare 传真实 `ctx.waitUntil` 保证响应后继续发送；其他平台 ctx 缺省时退化为内联 `await`，避免边缘函数提前截断后台任务；
5. **响应**：立即返回 JSON（`success/device_id/duplicated`），不等转发完成（CF 平台）。

## 5. 通知转发子系统

`dispatchNotify(env, msg)` 是全渠道唯一组装层：

- `extractCodeLite(content)`：服务端轻量验证码检测（级联顺序与前端 `extractCode` 一致，码在前先于关键词在前；检测前剥离手机号/日期/时间/金额/单号）；
- `buildNotifyInfo(env, msg)`：验证码检测 + `NOTIFY_LINK` 读取全渠道只算一次，产出 `verify/sms/notify` 三态与统一标题；
- 各渠道 renderer 消费 `info` 渲染自家格式（飞书 Interactive 卡片 / 企微钉钉 markdown / Telegram HTML / Bark / ntfy / Gotify / Resend 邮件 / 通用 Webhook 模板等），长度上限、加签、转义均在 renderer 内处理；
- `Promise.allSettled` 并发调度，单渠道失败仅记录日志，不影响其他渠道与主流程。

## 6. 前端（内嵌管理页）

管理页 HTML 以 `String.raw` 模板字面量内嵌于 `src/worker.js`（服务端渲染，无独立前端工程）：登录页与管理页共用路由 `/`，由登录开关决定渲染形态；支持九语言（zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR，`data-i18n` 内嵌字典 + `?lang=` 直连，缺失键兜底 en）、暗色模式、验证码自动复制、长轮询自动刷新（`/api/wait`）、来源筛选、设备管理。

## 7. 多平台差异速览

| 平台 | 入口文件 | 数据库 | cron |
|---|---|---|---|
| Cloudflare | `export default`（worker.js 本体） | D1（`env.DB`） | 原生 `scheduled` + `/api/cron` HTTP |
| Vercel | `api/[[...route]].js` | Turso | Vercel Cron（Bearer `CRON_SECRET`） |
| Netlify | `functions/api.mjs` + `functions/cron.mjs` | Turso | Scheduled Functions |
| Deno | `main.js`（`Deno.serve`） | Turso | 外部调度器 |
| EdgeOne | `functions/index.js`（根路径必须 index.js） | Turso（客户端按凭据指纹键控缓存） | 外部调度器 |
| Node | `server.mjs`（node:http） | Turso / 本地 SQLite（双适配） | 外部调度器 / Docker |

所有平台的 `/api/cron` HTTP 触发语义一致：`?token=<RECEIVE_TOKEN>` 或 `Authorization: Bearer <RECEIVE_TOKEN>`。
