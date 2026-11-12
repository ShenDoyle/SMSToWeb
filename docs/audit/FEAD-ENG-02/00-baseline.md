# FEAD-ENG-02 · 00-baseline 基线、工作区状态、平台清单

## 基线（ENG-02-A 启动时实测）

- HEAD=ea19433 / main / v1.1.1 / APP_VERSION=v1.1.1
- staged=0；`git diff --check` CLEAN；工作区 32 项（10 M + 22 ??）
- 32 项构成：UX-09 修复（src/worker.js + platforms/ 产物 + tests/ 5 个测试文件断言对齐）+ ENG-01-D 成果（serveHtml 缓存层、markClipped 批量化、ux07-tokens 行号白名单平移）+ 证据目录（仓库外）
- 六平台产物一致性：`gen_app.py --check` 通过（逐字节副本 + SCHEMA_SQL 内嵌块一致）
- 遗留清单：N-1（390 筛选总数裁切，P2）、N-2（窄屏站点名截断，P2）、B-发现-1 已修（L9619 保存失败 toast error）

## 平台清单（从仓库事实读取，非记忆）

| # | 平台 | 目录 | 入口 | 部署配置 | 运行时依赖 |
|---|---|---|---|---|---|
| 1 | Cloudflare Workers | platforms/cloudflare | worker.js（fetch + scheduled） | wrangler.toml（crons 0 17 * * *） | D1/KV 绑定（db.js 适配层） |
| 2 | Vercel | platforms/vercel | api/ 目录函数 | vercel.json | Turso（libsql） |
| 3 | Netlify | platforms/netlify | functions/ | netlify.toml + public/ | Turso（libsql） |
| 4 | Deno Deploy | platforms/deno | main.js | 无（Deploy 直连） | Turso |
| 5 | EdgeOne Pages | platforms/edgeone | functions/ | 无独立 toml（Pages 函数约定） | Turso |
| 6 | Node.js 自托管 | platforms/node | server.mjs（http 适配 fetchApp） | Dockerfile | SQLite(node:sqlite) / Turso |

- 单源分发：src/worker.js → shared/app.js → 各平台 app.js 逐字节一致（gen_app.py）；
  cloudflare/worker.js 与 src/worker.js 逐字节一致。
- 平台差异点：入口适配层（vercel api/*、netlify functions/*、edgeone functions/*、deno main.js、node server.mjs）；
  数据库适配 db.js（D1 vs node:sqlite vs Turso）；调度（CF crons / node 内置定时 / 其余依赖平台调度或 /api/cron）。

## 与任务书预期表的差异说明

实际清单与任务书预期六平台完全一致，无增减。

## 本机测试能力（ENG-02-C 输入）

| 平台 | 本机可运行 | 等级上限 | 缺口 |
|---|---|---|---|
| Node.js | 是（v22.20 WSL / v18 Windows，SQLITE 模式） | E2 | — |
| Cloudflare | 否（无 wrangler/网络隔离） | E0 | 需真实部署或 miniflare |
| Vercel / Netlify / EdgeOne / Deno | 否（无 CLI 账号） | E0 | 需真实部署 |
