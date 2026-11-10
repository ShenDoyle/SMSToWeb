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

配置分层：登录密码与会话签名密钥只走环境变量（安全边界）；通知渠道、业务参数与设置修订号存于 `settings` 表，管理页可改，旧环境变量作为兼容兜底。

## 2. 目录结构

```
src/worker.js                 # 唯一业务源文件（Cloudflare Worker 形态：export default { fetch, scheduled }）
platforms/
  gen_app.py                 # 同步生成脚本（见 §3）
  shared/app.js               # 生成产物：与 src/worker.js 业务部分逐字节一致，仅替换导出形态
  cloudflare/                 # CF 主版本副本 + wrangler.toml（静态维护）
  vercel/  netlify/  deno/    # 各平台自包含目录：入口 + app.js + db.js + schema.sql + README
  edgeone/ node/              # EdgeOne 走 Turso；node/db.js 为 Turso + 本地 SQLite 双适配（独立维护）
tests/run.mjs                 # 零依赖测试套件（node:sqlite，850 项）
tests/m1-lifecycle.mjs        # Node 后台任务生命周期专项（32 项，独立运行）
platforms/node/lifecycle.mjs  # Node 专属：后台任务登记 + 停机编排（M-1）
docs/                         # 文档（本目录）
schema.sql                    # 数据库建表脚本（单一来源）
```

各平台目录**完全自包含**：入口只引用本目录内的 `app.js` / `db.js`，可独立部署、互不依赖。

## 3. 同步机制（platforms/gen_app.py）

`python platforms/gen_app.py` 一键完成（幂等，重跑无漂移）：

1. 以 `src/worker.js` 为唯一源，截取 `export default {` 之前的全部业务代码，拼接生成通用导出尾巴（`fetchApp` / `runCron` / `handleCronRequest`），写入 `platforms/shared/app.js`；
2. 将 shared 副本与 `shared/db.js`、根 `schema.sql` 复制到各平台目录（`node/db.js` 除外，独立维护）；
3. 用脚本内 **ENV_KEYS 白名单**（单一清单，含 **33** 个环境变量）替换各入口文件 `/* ==== ENV_KEYS BEGIN ==== */ … /* ==== ENV_KEYS END ==== */` 标记块之间的内容，保证六平台透传的环境变量集合一致，防漂移。

铁律：**任何业务改动只改 `src/worker.js`（与 gen_app.py 的 ENV_KEYS），改完必须重跑 gen_app.py**；禁止直接手改任何 platforms/ 下的生成产物（除 node/db.js 与 wrangler.toml）。

> **`--check` 的真实检查范围（勿夸大）**：`python platforms/gen_app.py --check` 只调用 `check_sync_state()`（校验 `src/worker.js` 内嵌 `SCHEMA_SQL` 块与根 `schema.sql` 一致）与 `check_schema_refs()`（校验 SQL 表/列引用有效）。它**不**比对六平台 `app.js` / `worker.js` 副本、**不**校验 `ENV_KEYS` 标记块、**不**能发现「改了 src 却没重跑生成器」造成的漂移。要证明「六平台业务代码逐字节一致」必须直接做字节比对（M-1 / M-2 审计材料留有 23 项只读比对记录）。CI 若只跑 `--check`，这类漂移会静默通过。

## 4. 请求生命周期

以 `POST /api/receive` 为例：

1. **入口层**：平台入口（如 `platforms/edgeone/functions/index.js`）接收请求，构造 `env = buildEnv(vars)`（透传白名单变量 + 数据库凭据分支），调用 `fetchApp(request, env[, ctx])`；
2. **鉴权**：`/api/receive`、`/api/push`、`/api/login`、`/api/logout`、`/api/cron`、静态资源为公开路径；其余管理与页面接口受登录开关（`ENABLE_AUTH`）控制——登录后签发**无状态签名 Session**（`nonce.exp.HMAC-SHA256` 三段式，Cookie `sms_auth`，TTL 默认 30 分钟，管理页「设置 → 会话时长」可调 5~43200 分钟），`SESSION_SECRET` 缺失时安全失败（登录 500、管理接口一律 401，不回退密码派生），配置缺失一律不放行；设置类接口（`/api/settings*`）全部在登录之后，并强制 JSON Content-Type 与写入限速；
3. **入库**：校验 token（`safeEqual` 防时序攻击）→ 按 device+sim 定位/创建设备 → 写入 messages（数据库唯一索引兜底去重，重复推送返回 `duplicated:true` 且不转发）；
4. **通知转发**：非重复消息经 `bgRun(ctx, dispatchNotify(env, msg))` 进入后台。**六个平台入口都构造并向 `fetchApp` 传入带 `waitUntil` 的 `ctx`**：Cloudflare 原生 `ctx.waitUntil`；EdgeOne `onRequest(context)` 透传 `EventContext.waitUntil`；Vercel / Netlify 入口特性探测 `context.waitUntil`；Deno 探测 `EdgeRuntime.waitUntil`；Node 自研 `bgCtx.waitUntil`。`bgRun` 只判定**运行时是否真的提供 `waitUntil`**：提供则后台执行（响应不被阻塞），缺失才退化为内联 `await`（响应会等待通知发完）。旧版此处写「其他平台 ctx 缺省」不准确——缺省的是**运行时能力**，不是入口传参。
   - 能力差异：Cloudflare `waitUntil` 响应后上限 30s；Netlify 仅对 2025-03-20 及之后部署的函数提供；Deno 官方 Runtime 文档未记载 `EdgeRuntime.waitUntil`；Vercel 官方已标记 `context` deprecated，本项目受零依赖约束不引入 `@vercel/functions`，保持特性探测 + 回退。
   - **Node（M-1）**：`bgCtx.waitUntil` 把任务登记进 `platforms/node/lifecycle.mjs` 的登记表（Map + 同 Promise 去重，成功/失败/超时均移除），响应**不**被阻塞；停机时先等在途 HTTP，再有界等待（45s）全部已登记任务，超时记 `background_task_timeout` / `background_tasks_unfinished`（绝不记为成功），**之后**才关闭 SQLite 并 `exit(0)`。详见 §8。
5. **响应**：提供 `waitUntil` 的运行时立即返回 JSON（`success/device_id/duplicated`），不等转发完成；回退到内联 `await` 的运行时会等通知发完再返回。

## 5. 通知转发子系统

`dispatchNotify(env, msg)` 是全渠道唯一组装层：

- `loadNotifyConfig(env)`：一次范围查询 `settings` 中全部 `notify.*` 键（1 条 SQL），得到全局开关、转发类型、重试次数、跳转链接与 11 个渠道的字段值；数据库键缺失时逐字段回退旧环境变量，空串表示“已明确清除”不再回退；
- `extractCodeLite(content)`：服务端轻量验证码检测（级联顺序与前端 `extractCode` 一致，码在前先于关键词在前；检测前剥离手机号/日期/时间/金额/单号）；
- `buildNotifyInfo(cfg, msg)`：验证码检测 + 跳转链接只算一次，产出 `verify/sms/notify` 三态与统一标题；
- 全局规则先过滤：总开关关闭、消息类型不在 `notify.types`、渠道 `enabled=false` 的渠道直接跳过（测试通知可只测指定渠道并绕过规则）；
- 各渠道 renderer 消费 `info` 渲染自家格式（飞书 Interactive 卡片 / 企微钉钉 markdown / Telegram HTML / Bark / ntfy / Gotify / Resend 邮件 / 通用 Webhook 模板等），长度上限、加签、转义均在 renderer 内处理；
- 发送失败按 `notify.retry`（0~3）重试；并发调度用 `Promise.all` + 逐 job 隔离，单渠道失败仅记录**脱敏后**的日志（URL 替换为 `[url]`），不影响其他渠道与主流程。

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

## 8. Node 停机与后台任务生命周期（M-1，R3-01 修复）

仅 Node 自托管适用；Cloudflare / EdgeOne 等无服务器平台的 `waitUntil` 语义**未改变**。实现位于 `platforms/node/lifecycle.mjs` + `platforms/node/server.mjs`。

| 层 | 预算 | 默认值 | 推导依据 |
|---|---|---|---|
| ① HTTP 在途请求 | `WAIT_MAX_SECONDS×1000 + 5s` | 30s | `handleWait` 的 3–25s clamp（`src/worker.js:2039`）；`server.close` 等全部在途请求结束 |
| ② 后台任务 drain | `(NOTIFY_RETRY_MAX+1)×10s + 5s` | 45s | 单渠道 `AbortSignal.timeout(10s)`、串行重试最多 4 次；多目标 / 多渠道均 `Promise.all` **并行取最大值，不相乘** |
| ③ 应用整体宽限 | ①+②+5s | **80s** | `SHUTDOWN_GRACE_MS`：可调大至 `120000`，**禁止低于 `80000`**；强制退出仅作最终兜底 |
| ④ 容器/服务停止宽限 | ③+10s | **≥90s** | 由部署者设置：`--stop-timeout=90` / `docker stop --timeout 90` / `stop_grace_period: 90s` / `TimeoutStopSec=90s` |

顺序：`running → draining`（新业务请求 503）→ 等 HTTP 收敛 → 有界等待已登记后台任务 → 到点逐条记超时 / 未完成 → `closeLocalDb()`（真实 `LocalDatabase.close()`，置 `_closed` 使关闭后访问 fail-fast）→ `shutdown_complete` → `exit(0)`。`process.exit` 永远在数据库关闭之后；兜底路径记 `shutdown_aborted` + `db_close_skipped` + `exit(1)`，明确**不关库**。重复 SIGTERM / SIGINT 幂等。

边界（不得夸大）：后台通知任务**没有任务级统一 deadline**，有界性完全由 45s drain 提供；超时任务**不取消、不补偿**——消息已入库，但通知可能遗漏；Turso 模式的 DB 读无超时。Docker 默认停止宽限 10s 会先 SIGKILL，部署侧必须配 ≥90s，否则本机制被抵消。真实 WSL2 Docker 五场景验证见仓库外 `M1-fix/`（场景 A 使用未经修改的生产入口），**属本地验证，不代表生产配置已落地**。
