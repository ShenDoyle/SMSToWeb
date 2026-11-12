# FEAD-ENG-02 · 08-risk-register 缺陷与风险登记

分级：P0 认证绕过/跨用户泄露/数据损坏；P1 关键流程失败/平台不可用；P2 部分异常/可恢复体验；P3 非关键差异。
归因区分：产品 / 平台 / 部署配置 / 测试工具 / 外部服务。

| 编号 | 级别 | 描述 | 归因 | 证据等级 | 状态 |
|---|---|---|---|---|---|
| R-1 | P2 | 登出后 TTL 内旧 Token 可重放（共享设备场景） | 产品（既有文档化设计） | E2 复现 | 待 D 阶段后设计修复（session_epoch 建议），未经批准不改会话语义 |
| R-2 | P2 | `Vary: Cookie`/`no-cache` 在五平台 CDN 的实际处理未验证；若某 CDN 忽略 no-cache 存在理论共享缓存面 | 平台 | E0 | D 阶段逐平台实测；不达标平台允许保留 no-store |
| R-3 | P2 | vercel/netlify/deno/edgeone 调度依赖平台 cron 或手动 /api/cron，未配置则保留期清理不执行 | 部署配置 | E0 | D 阶段核对各平台 README 引导；必要时补部署文档 |
| R-4 | P3 | Playwright Chromium 不执行 HTTP 缓存再验证，本机无法测浏览器 304 | 测试工具 | E2（隔离实验） | E4/D 阶段真实浏览器验证 |
| R-5 | P3 | Turso/D1 下游标分页 SQL 大数据量行为未实测 | 平台 | E0 | D 阶段真实数据量验证 |
| R-6 | P3 | Firefox/Safari 的 -webkit-line-clamp（markClipped 依赖）未真机验证 | 平台（浏览器） | E0 | E4 阶段覆盖 |
| R-7 | P2 | N-1 390px 筛选总数裁切 | 产品 | E2 | 遗留清单，UX 小屏专项处理 |
| R-8 | P2 | N-2 窄屏站点名截断 | 产品 | E2 | 遗留清单，Header 专项 |
| R-9 | — | 未发现 P0/P1：认证无绕过路径、无私有数据进可缓存响应、业务数据一致性在 E2 层全部通过 | — | E2/E0 | — |

诚实声明：五平台（Cloudflare/Vercel/Netlify/Deno/EdgeOne）当前**全部为 E0 静态证据**，不得视为平台兼容性通过；E2 证据仅覆盖 Node.js 平台与共享业务逻辑。
