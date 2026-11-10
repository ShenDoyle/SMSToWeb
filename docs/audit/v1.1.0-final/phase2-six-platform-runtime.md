# SMSToWeb v1.1.0 · 阶段2：六个平台真实运行验证

> 执行时间：2026-11-10 15:43–15:49 (GMT+8)，精确 UTC 时间戳见 `evidence/node-smoke-output.json` 的 `testTime`
> **核心原则**：真实运行证据优先于静态推断，但**绝不把本地模拟冒充真实运行、绝不把源码兼容性冒充生产运行成功**。
> 本阶段未创建/修改任何部署项目、未触发部署、未连接生产库、未发送任何短信或通知。

---

## 2.0 证据等级定义（全程严格遵守）

| 等级 | 名称 | 本阶段是否取得 |
|---|---|---|
| 1 | 静态源码检查（入口存在、import、配置、ENV_KEYS、哈希） | ✅ 六平台全部取得 |
| 2 | 本地适配器测试（`tests/run.mjs` 直接 import `app.js` 的 `fetchApp`） | ✅ RC2 已取得（850/0），本轮阶段7重跑 |
| 3 | 本地模拟测试（模拟平台事件对象调用 handler） | ❌ 本轮**未做**，避免与等级4混淆 |
| 4 | **真实平台运行测试** | ⚠️ 仅取得"本地 Node 真实 HTTP 进程"这一**本地形态**；**六个云平台/容器运行 0/6 取得** |
| 5 | 真实远程数据库测试（Turso / D1） | ❌ 未取得 |
| 6 | 生产环境证据 | ❌ 未取得 |

> **不得升级**：`tests/run.mjs` 的 850/0 是等级2；`node-smoke.mjs` 是等级4 的**本地**形态。二者都不能写成"六平台已真实运行通过"。

---

## 2.1 可测试环境逐平台确认（§6.1）

本机环境实测：`node v22.22.2`、`python 3.13.12`、`curl`、`npx`、`sqlite3`(Android SDK) 可用；**`deno` / `wrangler` / `vercel` / `netlify` / `docker` 全部 NOT AVAILABLE**。

环境变量存在性检查（**只检测是否设置，从不输出值**）：`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` / `RECEIVE_TOKEN` / `ADMIN_PASSWORD` / `SESSION_SECRET` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` —— **全部 NOT SET**。

部署实例证据：`grep -rInE '(project_id|account_id|https://…workers.dev|vercel.app|deno.dev|netlify.app|edgeone|pages.dev)'` 在 `wrangler.toml` / `vercel.json` / `netlify.toml` / `deno.json*` 中**零命中**；仓库内出现的 `xxx.vercel.app` / `xxx.netlify.app` 全是**部署文档里的占位示例**，不是实例地址。Cloudflare 仅有 `.dev.vars.example`（模板），**无真实 `.dev.vars`**。

| 平台 | 已有部署实例 | 可访问测试地址 | 已授权测试环境 | 可安全只读 Smoke | 需DB访问 | 需第三方服务 | 副作用风险 | 本轮可验证上限 |
|---|---|---|---|---|---|---|---|---|
| 1 Cloudflare Workers + D1 | ❌ 无 | ❌ 无 | ❌ 无 | ❌ | D1 绑定 | 无 | 有（若写 D1） | 等级1 静态 |
| 2 Vercel + Turso | ❌ 无 | ❌ 无 | ❌ 无 | ❌ | Turso | Turso | 有 | 等级1 静态 |
| 3 Deno Deploy + Turso | ❌ 无 | ❌ 无 | ❌ 无 | ❌ | Turso | Turso + Deno | 有 | 等级1 静态 |
| 4 Netlify Functions + Turso | ❌ 无 | ❌ 无 | ❌ 无 | ❌ | Turso | Turso | 有 | 等级1 静态 |
| 5 EdgeOne Makers + Turso | ❌ 无 | ❌ 无 | ❌ 无 | ❌ | Turso | Turso | 有 | 等级1 静态 |
| 6 Node.js + Docker + Turso/SQLite | ⚠️ 无部署实例，但可本地启动 | `http://127.0.0.1:18787/18788`（本地） | ✅ 本机隔离临时库 | ✅ 是 | 本地 SQLite | 无 | 无（白名单净化） | **等级4 本地真实运行** |

**结论**：受 §3.2 约束（不得擅自部署新版本、不得修改生产环境、不得连接生产库），前五个平台的真实运行验证**无法在本轮完成**，原因明确分类为 `BLOCKED`，不是"已通过"。

---

## 2.2 唯一真实运行证据：Node.js 本地 HTTP 进程（平台 6）

### 执行方式

证据脚本：`docs/audit/v1.1.0-final/evidence/node-smoke.mjs`
原始输出：`docs/audit/v1.1.0-final/evidence/node-smoke-output.json`
退出码：**0**，脚本内部 `errors: []`，stderr 为空。

隔离与零副作用设计：
- 数据库写入 **OS 系统临时目录**（`mkdtempSync(tmpdir())`）新建文件，**不触碰 `runtime/`、不连接任何远程库**；
- 环境变量白名单化：剥离所有 `TURSO_*` / 通知渠道（FEISHU/WECOM/DINGTALK/TELEGRAM/BARK/NTFY/GOTIFY/RESEND/MAIL/GENERIC_WEBHOOK 等）/ 凭据 / 远程库变量，杜绝任何真实外发；
- 认证与令牌全部使用**运行时随机生成的测试哑值**，不写入任何配置文件；
- 只发起只读 GET + 一次空参数/错密码 `POST /api/login`（参数校验，不产生会话）；**不调用 `/api/cron`（避免清理写入）、不调用任何通知或消息写入接口、不发真实短信**；
- 两轮进程均正常启动并正常终止，未修改任何项目文件。

### A. 启动和入口

| 检查 | 实际结果 |
|---|---|
| 入口存在 | `platforms/node/server.mjs`（257 行）✅ |
| 进程启动 | 两轮均输出 `SMSToWeb node server listening on :18787` / `:18788` ✅ |
| 请求进入正确 Handler | `http.createServer` → `toWebRequest` → `fetchApp(webReq, env, bgCtx)`；`/api/cron` 走 `handleCronRequest` ✅ |
| 运行环境加载配置 | `buildEnv()` 白名单透传 33 项 ENV_KEYS，`env.PLATFORM="node"` ✅ |

### B. 健康检查和静态资源（Round 1，默认 `ENABLE_AUTH=false`）

| 端点 | 状态 | Content-Type | Cache-Control | 响应时间(首请求) | 说明 |
|---|---|---|---|---|---|
| `GET /` | **200** | `text/html; charset=utf-8` | `no-store` | 173.1 ms（冷启动含 schema 初始化） | 304,788 字节；**含 `<span class="ver">v1.1.0</span>`** ✅ |
| `GET /manifest.webmanifest` | **200** | `application/manifest+json; charset=utf-8` | `no-cache` | 3.6 ms | 509 字节 ✅ |
| `GET /sw.js` | **200** | `application/javascript; charset=utf-8` | `no-cache` | 1.5 ms | 缓存名 `smstoweb-shell-v2` ✅ |
| `GET /` (Round2, 鉴权开) | **200** | `text/html; charset=utf-8` | `no-store` | 87 ms | 17,495 字节，确认为**登录页** ✅ |

> ⚠️ 版本号 `v1.1.0` 是**本地源码运行**显示的版本，**不是任何线上部署实例的版本**。任务书 §6.2 B 明确禁止把本地源码版本等同线上部署版本。

### C. API 基础行为

| 检查 | 请求 | 实际响应 | 结论 |
|---|---|---|---|
| 消息列表结构 | `GET /api/messages` | 200 `{"success":true,"total":0,"page":1,"limit":10,"pages":1,"list":[],"has_more":false,"next_cursor":null,"slim":false}` | ✅ 结构完整（含游标分页字段） |
| 统计接口 | `GET /api/stats` | 200 `{"success":true,"total":0,"unread":0,"starred":0,"sources":[],"days":[],"schema":{"state":"ok",...}}` | ✅ 且返回 schema 状态 |
| 鉴权状态 | `GET /api/auth-state` | 200 `{"success":true,"required":false}` / Round2 `required:true` | ✅ |
| 导出接口 | `GET /api/export?format=json` | 200 `[]` | ✅ |
| cron 无 token | `GET /api/cron` | **403** `{"success":false,"error":"unauthorized"}` | ✅ 正确拒绝 |
| 未知接口 | `GET /api/does-not-exist` | **404** `{"success":false,"error":"not found"}` | ✅ 统一错误格式 |
| 登录参数校验（关鉴权） | `POST /api/login {}` | **400** `{"success":false,"error":"auth disabled"}` | ✅ 明确拒绝 |
| 错误密码（开鉴权） | `POST /api/login {password:错}` | **403** `{"success":false,"error":"wrong password"}` | ✅ 不泄露敏感值 |

**鉴权边界（Round 2，`ENABLE_AUTH=true`）**：`GET /api/messages`、`/api/stats`、`/api/tokens`、`/api/settings` 未登录 **全部 401** `{"success":false,"error":"unauthorized"}`；`GET /api/auth-state` 作为 public API 仍 200。✅ 四项全通过。
> 未使用任何真实用户凭据做登录实验；仅验证"错误密码被拒绝"与"未登录被拒绝"。

### D. 数据库适配（本地 SQLite）

| 检查 | 证据 |
|---|---|
| 连接初始化 | `createDb({SQLITE_PATH, TURSO_DATABASE_URL:"", TURSO_AUTH_TOKEN:""})` → `node:sqlite` `DatabaseSync` ✅ |
| schema 初始化 | `/api/stats` 返回 `"schema":{"state":"ok",...}` ✅ |
| 实际建表 | `sqlite3 <临时库> .tables` → **`devices  messages  settings  tokens`** ✅ 四张表真实存在 |
| 查询接口运行 | `/api/messages`、`/api/stats`、`/api/export` 均返回 200 且结构正确 ✅ |
| 临时库文件 | `round1.db` / `round2.db` 各 4096 字节，位于 OS temp，**从未进入仓库或 runtime/** ✅ |
| 参数绑定/事务语义 | 由 `tests/run.mjs`（等级2 本地适配器测试）覆盖，本轮阶段7重跑；**不升级为真实平台 DB 证据** |
| 错误分类/连接异常 | 本地 SQLite 路径未触发异常分支；Turso 连接异常处理 **NOT TESTED**（无凭据） |

> **明确边界**：本地 SQLite 测试结果**不能**作为 Turso 真实连接成功的证据，也不能作为 Cloudflare D1 绑定成功的证据。

### E. Node/Docker 平台特有问题

| 检查 | 结果 |
|---|---|
| Node 启动 | ✅ 真实通过 |
| 容器配置（Dockerfile） | 等级1 静态存在；`platforms/node/Dockerfile` 已修改但未构建 |
| 健康检查 | ✅ HTTP 层通过（无容器内 healthcheck 实测） |
| 数据库初始化 | ✅ 本地 SQLite 通过 |
| **容器真实运行** | ❌ **NOT TESTED** —— 本机 `docker` NOT AVAILABLE，未构建镜像、未启动容器。**不把静态配置检查描述成容器真实运行通过** |
| **Turso 模式** | ❌ **NOT TESTED** —— 无 `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`，未发起任何远程连接 |
| 进程退出与优雅关闭 | ⚠️ **NOT TESTED** —— Windows 无原生 SIGTERM 投递，`child.kill()` 为强制终止，`process.on('SIGTERM')` 的优雅关闭链路无法在此环境可靠验证；两进程均已退出，但**不声称优雅关闭 PASS** |

---

## 2.3 Cloudflare 与 EdgeOne 独立验证（§6.3）

**两者是独立部署项目，均监听 GitHub `main`，但部署目录与运行环境不同；本轮对二者分别独立登记，绝不互相替代证据。**

| 记录项 | Cloudflare Workers + D1 | EdgeOne Makers + Turso |
|---|---|---|
| 部署项目 | 独立项目（`platforms/cloudflare/`，入口 `worker.js` 9021 行） | 独立项目（`platforms/edgeone/`，入口 `functions/index.js` 104 行） |
| 实际访问地址 | **N/A — 未发现任何已部署实例地址** | **N/A — 未发现任何已部署实例地址** |
| 响应状态 | **N/A（未发起请求）** | **N/A（未发起请求）** |
| 响应时间 | **N/A（未测量）** | **N/A（未测量）** |
| 部署版本证据 | **无**（`wrangler.toml` 无 project_id；仅 `.dev.vars.example`） | **无**（无部署配置/实例标识） |
| 数据库运行证据 | **无**（D1 绑定未验证，无 wrangler/miniflare） | **无**（Turso 未连接，无凭据） |
| 测试时间 | 2026-11-10 15:43–15:49 GMT+8（仅环境探测与静态检查） | 2026-11-10 15:43–15:49 GMT+8（仅环境探测与静态检查） |
| 独立结论 | **BLOCKED** | **BLOCKED** |

> 未使用任何一方的响应/日志去证明另一方运行正常。二者均**未取得真实运行证据**。

**EdgeOne 历史性能问题（§6.5）**：历史记录指向 `fetchApp()` 中 `ensureSchema()` 的串行数据库往返。本轮**无 EdgeOne 实例、无 Turso 凭据**，因此**无法取得任何实测延迟**；本报告**不引用、不采信**历史估算作为当前实测结果，也不做任何性能改善结论。该问题需在具备 EdgeOne 实例后单独实测。

---

## 2.4 其余四个平台分别登记（平台 2/3/4）

| 平台 | 入口（等级1 静态） | ENV_KEYS | DB 适配（静态） | 真实运行证据 | 结论 |
|---|---|---|---|---|---|
| Vercel + Turso | `platforms/vercel/api/[[...route]].js` 104 行，`export default async function handler(request, context)` → `fetchApp(request, env, ctx)`；`import { createTursoDb } from "../db.js"` | 33 ✅ | `createTursoDb`，**未连接** | 无（无 vercel CLI、无实例、无 Turso 凭据） | **BLOCKED** |
| Deno Deploy + Turso | `platforms/deno/main.js` 106 行，`Deno.serve(async function (request){…})` → `fetchApp`；`import { createTursoDb } from "./db.js"` | 33 ✅ | `createTursoDb`，**未连接** | 无（**Deno 运行时不可用**、无实例、无凭据） | **BLOCKED** |
| Netlify Functions + Turso | `platforms/netlify/functions/api.mjs` 105 行，`export default async function handler(request, context)` → `fetchApp`；`import { createTursoDb } from "../db.js"` | 33 ✅ | `createTursoDb`，**未连接** | 无（无 netlify CLI、无实例、无凭据） | **BLOCKED** |
| EdgeOne Makers + Turso | `platforms/edgeone/functions/index.js` 104 行，`export async function onRequest(context)` → `fetchApp(request, e, ctx)`；`import { createTursoDb } from "../db.js"` | 33 ✅ | `createTursoDb`，**未连接** | 无（无实例、无凭据） | **BLOCKED** |
| Cloudflare Workers + D1 | `platforms/cloudflare/worker.js` 9021 行，单文件 Worker ≡ `src/worker.js`（SHA 一致）；`wrangler.toml` 存在但无 project_id | 由 Worker 内部直接读 env | D1 绑定**未验证** | 无（无 wrangler、无 `.dev.vars`、无实例） | **BLOCKED** |

> 平台 1（Cloudflare）使用单文件 `worker.js`，**不存在** `platforms/cloudflare/app.js`，这是设计如此，不是缺失。

---

## 2.5 业务副作用限制（§6.4）

| 禁止项 | 本轮是否执行 |
|---|---|
| 发送真实短信 | ❌ 未执行 |
| 触发真实通知 | ❌ 未执行（且环境变量已剥离全部通知渠道） |
| 创建/删除/修改真实用户数据 | ❌ 未执行（仅 OS temp 新建库，schema 初始化） |
| 修改生产设置 | ❌ 未执行 |
| 执行数据库迁移 | ❌ 未执行（仅首次 schema 初始化于临时库） |
| 清理消息或用户数据 | ❌ 未执行（未调用 `/api/cron`） |
| 接口返回成功代替真实送达 | ❌ 未作此声称；真实短信/通知送达一律标记 **NOT TESTED** |

---

## 2.6 性能记录（§6.5，明确不作为性能结论）

测试环境：本机 Windows，Node v22.22.2，`127.0.0.1` 回环，本地临时 SQLite，数据集为空（0 条消息），每端点 **5 次**采样。

| 端点 | n | min | P50 | P95 | max |
|---|---|---|---|---|---|
| `/`（管理页，免登录） | 5 | 5.1 ms | 5.4 ms | 6.7 ms | 6.7 ms |
| `/manifest.webmanifest` | 5 | 0.5 ms | 0.6 ms | 1.0 ms | 1.0 ms |
| `/api/messages` | 5 | 0.7 ms | 0.8 ms | 0.9 ms | 0.9 ms |
| `/api/stats` | 5 | 0.6 ms | 0.7 ms | 0.8 ms | 0.8 ms |
| `/`（登录页，开鉴权） | 5 | 0.8 ms | 1.3 ms | 1.5 ms | 1.5 ms |
| `/api/messages` 401 | 5 | 0.5 ms | 0.6 ms | 0.8 ms | 0.8 ms |

**限定声明（必须随数据一起阅读）**：
- 冷启动首请求 `/` 为 173.1 ms（含首次 schema 初始化），**单次值不作为性能结论**；
- 测试区域：本机回环（非跨区域、非 CDN 边缘）；样本 n=5，**不足以形成 P95 统计结论**；
- 数据集：0 条消息，**不代表有数据规模**；
- **是否真实远程数据库：否**（本地 SQLite 临时文件）；
- 这些数据**不可**用于宣称 Turso / D1 / 六平台 / 生产环境性能；**不可**与 RC1 的历史 EdgeOne 估算混用。

---

## 2.7 平台结论矩阵（§6.6）

| # | 平台 | 证据等级 | 结论 | 尚未验证 |
|---|---|---|---|---|
| 1 | Cloudflare Workers + D1 | 1（静态） | **BLOCKED** | Worker 实际启动、D1 绑定与查询、静态资源线上投递、缓存头、真实 DB |
| 2 | Vercel + Turso | 1（静态） | **BLOCKED** | Functions 生命周期、环境变量注入、Turso 真实连接、请求延迟 |
| 3 | Deno Deploy + Turso | 1（静态） | **BLOCKED** | Deno 运行时兼容/权限/模块加载、Turso 真实连接 |
| 4 | Netlify Functions + Turso | 1（静态） | **BLOCKED** | Functions 入口适配、环境变量、Turso 真实连接 |
| 5 | EdgeOne Makers + Turso | 1（静态） | **BLOCKED** | 独立入口、请求生命周期、Turso 真实连接、缓存头、**延迟实测（含 ensureSchema 问题）** |
| 6 | Node.js + Docker + Turso/SQLite | **4（本地真实 HTTP）** | **CONDITIONAL PASS** | Docker 容器运行、Turso 模式、优雅关闭(SIGTERM)、生产实例 |

**汇总**：真实平台运行 `PASS` = **0 / 6**；`CONDITIONAL PASS`（本地 Node）= 1 / 6；`BLOCKED` = 5 / 6。
**FAIL = 0**（未发现实际运行故障，五个平台是"无法验证"而非"验证失败"）。

> ⚠️ 这一结果直接影响最终判定：任务书 §十四 明确"如果六个平台是 v1.1.0 的正式支持承诺，则每个平台至少必须有真实运行 PASS 证据；不能因为其他五个平台通过，就默认第六个平台通过"，且"Cloudflare 和 EdgeOne 独立验证"要求无法满足。本轮**不擅自把六平台正式支持降级为六平台理论兼容**，详见阶段9最终判定。

## 2.8 本阶段产物

| 文件 | 用途 |
|---|---|
| `evidence/node-smoke.mjs` | 可复核的零副作用本地真实运行脚本 |
| `evidence/node-smoke-output.json` | 完整结构化原始结果（含全部响应头/正文摘要/时间） |
| `evidence/node-smoke-last-run.json` | 脚本自动留存的同一份结果 |
| `evidence/node-smoke-stderr.txt` | stderr（空，证明无异常输出） |
| `phase2-six-platform-runtime.md` | 本报告 |

> 临时 SQLite 库位于 OS 系统临时目录 `smstoweb-v110-smoke-*`，**不在仓库内**；本阶段**未删除任何现存文件**（含该临时目录），符合 §3.3。
