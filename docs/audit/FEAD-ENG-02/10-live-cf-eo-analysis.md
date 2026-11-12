# 10 · 线上实测：Cloudflare 与 EdgeOne 双平台分析（v1.1.2）

- 日期：2026-11-12 23:09–23:21 (UTC+8)
- 版本：v1.1.2（commit d30c252，push 后数分钟内两站自动部署完成）
- 站点：`sms.5311314.xyz`（Cloudflare）· `sms.46cbm.top`（EdgeOne，Server: edgeone makers）
- 方法：curl 实测响应头 / 条件请求 / API 探测 + 与仓库 v1.1.2 源码逐项比对

## 一、部署状态

| 项 | Cloudflare | EdgeOne |
|---|---|---|
| 页脚版本号 | v1.1.2 | v1.1.2 |
| 部署时机 | push 后 ≤3 分钟（15:15 首测仍见旧响应，15:18 已切换） | 同上（15:15 首测见旧实例 18732 字节 no-store 响应，15:18 已切换） |
| 部署方式 | 自动（仓库 push 触发；ci.yml 本身无 deploy job，走平台 Git 集成） | 自动（EdgeOne makers Git 集成） |

**结论：Git push → 双平台自动部署链路真实可用**，ENG-02-D 的「五平台隔离部署」在 CF/EO 两家已具备真实生产环境。

## 二、serveHtml（OPT-1）语义逐项比对

| 语义项 | 仓库 v1.1.2 期望 | CF 实测 | EO 实测 |
|---|---|---|---|
| HTML Cache-Control | `no-cache` | `no-cache` ✓ | `no-cache` ✓ |
| Vary: Cookie | 有 | 有 ✓ | 有 ✓ |
| ETag（SHA-256 截 128bit） | 有 | **缺失（3/3 稳定）** | `"efec056a21d22ee16c99c43404f505f9"` ✓ |
| If-None-Match 命中 → 304 | 304 零字节 | 不可测（无 ETag，恒 200） | **304 实测通过** ✓ |
| 传输方式 | — | chunked | Content-Length 精确 |

页面内容 diff：仅站点名 3 处不同（CF「短信网关」/ EO「四十六短信站」= SITE_NAME 环境变量），字节数差 18 = 2 汉字 ×3 处 ×UTF-8，**无代码分叉**。

## 三、API 面语义比对

| 语义项 | CF | EO |
|---|---|---|
| GET /api/settings 未登录 | 401 + `no-store` + 完整安全头 + CORS ✓ | 401 + `no-store` + 完整安全头 + CORS ✓ |
| POST /api/receive 无令牌 | 403 ✓ | 403 ✓ |
| POST /api/login 空体 | — | 403 `{"success":false,"error":"wrong password"}` ✓（不泄露账号是否存在） |

两家 API 响应头集合逐行一致（除平台自有头 X-NWS-LOG-UUID / CF-RAY / Report-To）。

## 四、发现与登记

| 编号 | 级别 | 现象 | 判断与建议 |
|---|---|---|---|
| F1 | P2 | CF 稳定无 ETag：serveHtml 走 catch 退化分支（`crypto.subtle.digest` 异常）或 CF 运行时行为差异 | 功能无损（no-cache 仍强制回源验证），仅省流优化失效。建议：① CF 控制台确认 Worker 部署版本；② serveHtml catch 分支补一条 `logEvent("warn","etag_digest_failed",…)`——当前 catch 静默，正是日志通道该覆盖的点 |
| F2 | 信息 | 部署切换窗口内（≤3 分钟）两站均短暂返回旧实例响应 | 平台滚动发布的正常过渡，无需处理 |
| F3 | 信息 | EO 304 链路全绿 → OPT-1 的真实生产验证在 EO 完成 | ENG-02-D 的 HTTP 缓存项在 EO 平台可标「已真实验证」，CF 平台待 F1 排查后补测 |

## 五、日志开发者模式（真实评测观测通道）

`logEvent()` 输出结构化 JSON（timestamp/level/event/requestId/platform/phase），敏感字段经 `logSafeValue` 统一脱敏（Token/手机号/密钥 → `***`，正文 >64 字截断）——R1-05-09f 测试项覆盖。

| 平台 | 观测方式 |
|---|---|
| Cloudflare | 控制台 Workers & Pages → 该 Worker → Logs（实时日志/历史）；或 `wrangler tail` |
| EdgeOne | EdgeOne 控制台 → 边缘函数（Edge Functions）→ 运行日志 |
| Node/Vercel/Netlify/Deno | 平台 stdout 日志面板 |

## 六、下一步（ENG-02-D 收口建议)

1. EO 侧：直接以生产环境跑 U1-U10 用例（日志面板留证据）——此前「部署权限不足」的卡点已被 Git 自动部署打通。
2. CF 侧：先排查 F1（ETag 缺失），补一条 catch 日志后重发版，观察 Workers Logs。
3. Vercel/Netlify/Deno 三家：仓库 push 若未触发自动部署，再评估补测路径。
