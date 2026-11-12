# FEAD-ENG-02 · 03-auth-session 认证与会话兼容性（G3）

## 现状覆盖（既有测试证据，全部 Node E2）

| 场景 | 证据 | 结果 |
|---|---|---|
| 登录成功/失败/限速 | p1-auth.mjs（51+ 断言）+ sec01-browser | E2 PASS |
| 密码错误清空+回焦 | UX-09 U9-16 专项（fix4-verify） | E2 PASS |
| Token exp 过期 → 401 → 重载登录页 | p1-auth + UX-09 U9-07 RV | E2 PASS |
| Cookie Max-Age / 丢失 / 篡改签名 | p1-auth（sessionParse 验签） | E2 PASS |
| 登出清 Cookie | d1 验收 A5a（Max-Age=0） | E2 PASS |
| 认证态与页面缓存交互 | d1 验收 A3/A5b/A6（ETag 隔离） | E2 PASS |
| 并发请求会话隔离 | sec01-browser + m1-lifecycle | E2 PASS |

## 专项：登出后旧 Token 可重放（既有语义，独立安全评估）

- 事实（worker.js L483-493 注释明确）：登出仅清除浏览器 Cookie，服务端无会话黑名单；已签发 Token 在 TTL 内（默认 30 分钟，可配至 30 天）重放仍通过 isAuthed。
- 实测复现（E2，d1 验收阶段）：登出后以旧 Cookie 调 `/` → 仍返回主页面（200）。
- 影响评估：
  - 威胁场景=共享/受控设备「登出即走」：同机攻击者从内存/磁盘读取旧 Cookie 重放 → 在 TTL 内可见消息。隐私应用场景下属**中风险**（P2）。
  - 缓解已存在：换 SESSION_SECRET / ADMIN_PASSWORD 立即全量失效；Token TTL 可调短。
  - 与 OPT-1 缓存的关系：无交互——缓存层每次强制回源验证，不会放大重放面。
- 修复建议（供 D 阶段后设计，本轮未实施）：服务端会话版本号（settings 表存 session_epoch，登出 +1，验签时比对）——改动小、语义向后兼容；或维持现状并在文档标注风险。
- 五平台差异：无（会话逻辑在共享业务源码，E0 同源；node:sqlite 与 D1/Turso 的 settings 读写已在各 db.js 适配）。

## 五平台 E0 结论

认证/会话逻辑逐字节同源 → E0 层无平台分叉点；D 阶段需在真实平台复验 Cookie 的 Set-Cookie 透传（Netlify/Vercel 函数包装层是唯一可能丢头的位置，E0 已检查包装代码无过滤）。
