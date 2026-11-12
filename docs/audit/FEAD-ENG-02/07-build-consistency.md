# FEAD-ENG-02 · 07-build-consistency 构建与产物一致性（G7）

## 单源分发链

```
src/worker.js（唯一业务源）
  ├─ platforms/gen_app.py 逐字节同步
  ├─ platforms/shared/app.js（规范副本）
  ├─ platforms/{vercel,netlify,deno,edgeone,node}/app.js（独立副本，逐字节一致）
  └─ platforms/cloudflare/worker.js（= src/worker.js 逐字节一致）
```

## 实测（本轮 gen_app.py --check，2026-11-12）

- 六平台 app.js/worker.js 逐字节一致 ✔
- SCHEMA_SQL 内嵌块与根 schema.sql 一致 ✔
- schema 引用校验（devices/messages/settings/tokens）✔
- ENV_KEYS 白名单同步 node/server.mjs ✔
- gen_app.py 行为：仅做「export default → 具名导出」的头部替换 + 独立副本，不改业务逻辑（生成器源码审查，E0）✔

## 平台独有包装层清单（逐个审查，E0）

| 平台 | 包装 | 独有行为 | 风险 |
|---|---|---|---|
| node | server.mjs：http→Request/Response 适配 | Readable 流转换、lifecycle 关停协调 | E2 已验证 |
| vercel | api/*.js 函数导出 | 无额外头处理 | D 阶段核对 Set-Cookie/ETag 透传 |
| netlify | functions/ + netlify.toml + public/ | public/ 静态目录（仅 README 级资产） | 同上 |
| edgeone | functions/（Pages 约定） | 无独立 toml | 同上 |
| deno | main.js | 无 | E0 简单 |
| cloudflare | wrangler.toml | crons、vars | E0 清晰 |

## 结论

- 产物一致性：本轮全绿（含 ENG-01-D 改动后重生成）。
- 未同步修改检查：git status 中 platforms/ 的 M 项全部来自 gen_app.py 重生成，无手工漂移。
- 平台独有 Headers/Cookie/重定向逻辑：适配层均未过滤 SECURITY_HEADERS/Cache-Control/ETag（E0 逐个确认）；D 阶段以真实部署响应头验证收口。
