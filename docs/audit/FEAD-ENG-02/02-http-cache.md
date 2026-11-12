# FEAD-ENG-02 · 02-http-cache HTTP / ETag / 304 / CDN 审计（G2 重点专项）

## 源站行为（业务源码，E0 + Node E2）

- HTML 文档（登录页/主页面）：`Cache-Control: no-cache` + 稳定 SHA-256 ETag + `Vary: Cookie`；命中 If-None-Match → 304（0 字节，带 ETag/CC 头）。—— E2 PASS（ENG-01-D d1 验收 19/19）
- manifest.webmanifest / sw.js：`no-cache`（无 ETag）—— E0
- 全部 /api/*（私有数据）：`no-store` —— E0 + E2 PASS

## 三层缓存区分验证状态

| 层 | 验证状态 | 证据 |
|---|---|---|
| 源站响应语义 | ✅ E2 | 304/0 字节/ETag 隔离实测（Node） |
| 平台边缘（CDN） | ⚠️ 未验证 | 五平台无本机 Runtime；`Vary: Cookie` 在各 CDN 的实际处理是 D 阶段重点 |
| 浏览器原生缓存 | ⚠️ 受限于测试工具 | Playwright Chromium 不执行再验证（隔离实验证实与响应头无关）；需真实浏览器（E4） |

## 已识别风险与平台策略建议

| 编号 | 风险 | 等级 | 建议 |
|---|---|---|---|
| HC-1 | `Vary: Cookie` 在部分 CDN（如部分 EdgeOne/Netlify 边缘策略）可能被按「不缓存」处理，304 收益归零（安全无虞，仅收益损失） | P3 | D 阶段逐平台实测；若不生效可接受现状（语义仍安全） |
| HC-2 | `Vary: Cookie` 若被某 CDN 忽略并共享缓存，理论上仍安全（no-cache 强制回源），但需确认该 CDN 尊重 no-cache | P2 | D 阶段验证每平台 304/200 行为；不通过的平台按任务书允许保留原 no-store 策略 |
| HC-3 | 登录页与主页 ETag 隔离依赖「未登录/已登录返回不同 HTML」——已 E2 证明；五平台同源代码，E0 推定一致 | — | D 阶段抽样复验 |

## 版本更新语义

APP_VERSION 内嵌于 HTML → 发版内容变 → ETag 变 → 全员 200。E2 已验证（不同配置→不同 ETag）。E0：六平台同源。
