# 11 · F1（CF ETag 缺失）根因定位与修复闭环

- 日期：2026-11-13 13:42–13:55 (UTC+8)
- 版本：v1.1.3（commit `8bdcacb`），CF/EO 自动部署完成（CF ~25s，EO ~50s）
- 结论：**F1 根因 = Cloudflare 边缘/Zone 层剥离 ETag 响应头，不是应用代码缺陷**。代码侧已闭环；平台侧需 CF 控制台操作。

## 一、已执行的代码修复（保留，有独立价值）

`serveHtml()` 原先在 `crypto.subtle.digest` 抛错时**静默吞异常且完全不设 ETag**（10-live-cf-eo-analysis.md 的 F1 即此现象）。v1.1.3 改为：

1. 主路径仍为 SHA-256 前 16 字节（EO 行为零变化）；
2. 异常时降级为纯 JS 双 32 位 FNV-1a 内容指纹（`jsEtag`），**ETag 与 304 链路照常工作**；
3. 降级输出结构化 warn 日志 `etag_digest_fallback`（含 error 详情、platform、phase），消除观测盲区；
4. `no-cache` + `Vary: Cookie` 未动，认证隔离语义不变。

新增 `tests/etag-fallback.mjs` 13 项（正常路径 / 304 零字节 / 降级路径 ETag+304+日志 / 内容变化→ETag 变化 / 头语义保持），纳入 `package.json test:node` 与 CI。

验证：`gen_app.py --check` 零漂移；全量回归 **1107 项全绿**（851+23+64+58+47+51+13）。

## 二、线上验证（v1.1.3）

| 项 | CF | EO |
|---|---|---|
| 页脚版本 | v1.1.3 ✓ | v1.1.3 ✓ |
| 响应头 ETag | **仍为无** | `"900f0d58e0762f98d927fc1d617f4bc6"` ✓ |
| 条件请求（用响应头 ETag） | 不可测 | 304 / 0 字节 ✓ |
| no-cache / Vary: Cookie | ✓ / ✓ | ✓ / ✓ |

即：代码降级路径并未让 CF 出现 ETag → 说明 CF 上 **WebCrypto 根本没抛错**，另有问题。

## 三、决定性诊断（零发版）

方法：ETag 就是「最终渲染 HTML」的 SHA-256 前 16 字节，页面可由 curl 完整取得 → 本地复算指纹 → 直接作为 `If-None-Match` 发条件请求。先用 EO 校准（本地算出的值 = EO 响应头 ETag，且 304 ✓），证明方法有效。

| 站点 | 响应头 ETag | 本地 SHA-256 指纹 | 用本地指纹条件请求 | 用降级指纹条件请求 |
|---|---|---|---|---|
| EO | `"900f0d58..."` | `"900f0d58..."`（一致） | **304 / 0 字节** | 200 |
| CF | 无 | `"242499daa0b256c9389929154d508bff"` | **304 / 0 字节** | 200 |

推断链：
- CF 对本地 SHA-256 指纹返回 **304** → 服务端**确实算出了正确的 SHA-256 ETag，且 304 判断逻辑完全正常**；
- CF 对降级指纹返回 200 → CF 走的是主路径，`jsEtag` 降级未触发（WebCrypto 在 CF 可用）；
- 响应头却无 ETag，且 `Vary: Cookie`、`X-Frame-Options` 等头均正常透传，无 `Content-Encoding`（未压缩/改写 body），CF/EO 页面字节差 18 = 仅站点名差异（body 未被边缘改写）；
- ⇒ **Cloudflare 在响应返回客户端之前单独移除了 ETag 头**（Zone 配置 / Transform Rules / 边缘规则层）。

## 四、影响与判定

| 维度 | 判定 |
|---|---|
| 功能 | 无损，页面正常 200 |
| 安全 | 无损，no-cache 强制回源 + Vary: Cookie 认证隔离仍在 |
| 省流 | CF 上失效：浏览器首次拿不到 ETag → 永远无法发起条件请求 → 每次 200 全量 ~28KB |
| 服务端 304 能力 | 其实可用（诊断已证明），缺的只是「把指纹告诉浏览器」这一步 |

**F1 改判**：从「应用代码缺陷」改判为「平台配置差异（CF 边缘剥离 ETag）」。代码侧修复闭环完成（健壮性 + 可观测性），平台侧不再由代码改动解决。

## 五、平台侧待办（需 CF 控制台权限，外部动作留给用户）

按顺序排查：

1. **一锤定音的对照实验**：用该 Worker 的 `*.workers.dev` 子域直接访问（绕过 Zone 的边缘规则）。若 workers.dev 响应**有 ETag** → 实锤是 Zone 规则剥离，改规则即可。
2. **Rules → Transform Rules → Modify Response Header**：检查是否存在 `Remove / Set ETag` 规则（最可能）。
3. **Rules → Cache Rules / Caching → Configuration**：Browser Cache TTL、Origin Cache Control 相关设置。
4. **Speed → Optimization**：Auto Minify (HTML)、Brotli、Mirage、Rocket Loader 等内容变换开关（本例 body 未变，但仍值得确认）。
5. **Workers Routes**：确认没有前置代理 Worker 复制响应头时漏掉 ETag。

按用户指示，U1-U10 全套真实评测推迟到 **2.0.0 正式版**再做；F1 平台侧排查可一并在 2.0.0 前处理，当前不影响线上业务。
