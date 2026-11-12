# FEAD-ENG-02 · 01-runtime-matrix 六平台 Runtime 能力矩阵

证据等级：E0=静态检查 / E1=模拟 / E2=本机真实 Runtime / E3=平台真实部署 / E4=真实浏览器+真实部署全链路。
审计对象：各平台入口适配层实际代码（platforms/*/）+ src/worker.js 业务源码。

## G1 平台 API 兼容性矩阵

| 能力 | 业务源码使用 | Cloudflare | Vercel | Netlify | Deno | EdgeOne | Node.js |
|---|---|---|---|---|---|---|---|
| Request/Response (fetch 语义) | 全部 API | E0✔(原生) | E0✔ | E0✔ | E0✔ | E0✔ | E2✔(server.mjs 适配) |
| Headers | 全部 API | E0✔ | E0✔ | E0✔ | E0✔ | E0✔ | E2✔ |
| URL/URLSearchParams | 路由/查询 | E0✔ | E0✔ | E0✔ | E0✔ | E0✔ | E2✔ |
| Cookie 解析(getCookie) | 会话 | E0✔ | E0✔ | E0✔ | E0✔ | E0✔ | E2✔ |
| crypto.subtle (OPT-1 ETag/签名) | serveHtml/sessionParse | E0✔(原生) | E0✔ | E0✔ | E0✔ | E0✔ | E2✔(v18/v22 实测) |
| TextEncoder/Decoder | ETag/JSON | E0✔ | E0✔ | E0✔ | E0✔ | E0✔ | E2✔ |
| ReadableStream | 响应体 | E0 | E0 | E0 | E0 | E0 | E2✔(Readable 转换) |
| 定时/调度 | 每日清理 | E0✔(crons) | E0(平台 cron) | E0 | E0 | E0 | E2✔(内置定时) |
| 环境变量/Secrets | ENV_KEYS 白名单 | E0✔(vars+secrets) | E0✔ | E0✔ | E0✔ | E0✔ | E2✔ |
| DB 绑定 | db.js | E0✔(D1) | E0(Turso) | E0(Turso) | E0(Turso) | E0(Turso) | E2✔(node:sqlite/Turso) |

- 关键静态发现：serveHtml（OPT-1）依赖 `crypto.subtle` 与 `TextEncoder`——六平台均为 Web 标准全局，E0 层无平台缺口；已包 try/catch 安全退化。
- node/server.mjs 有独立的 Readable/Cookie 透传逻辑（E2 实测通过），是唯一需要逐平台核对的非共享适配层。

## E2 实测记录（Node.js 平台，2026-11-12，WSL node v22.20，SQLITE 模式）

- 登录/会话 Cookie：E2 PASS（p1-auth + sec01-browser + d1 验收）
- serveHtml ETag/304：E2 PASS（19/19，见 02-http-cache.md）
- 定时清理：E2 PASS（m1-lifecycle）
- DB 并发/锁：E2 PASS（m1-lifecycle + UX-09 RV DB_LOCKED 提示验证）

## 其余五平台

当前均为 E0（静态源码检查通过：逐字节同源业务码 + 标准全局 API）。**不得据此宣称平台兼容通过**——真实部署验证计划见 09-test-plan.md。
