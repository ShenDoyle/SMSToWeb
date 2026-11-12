# FEAD-ENG-02 · 09-test-plan D 阶段逐平台真实 Runtime 测试计划

前置：A/B/C 终审通过并获得 D 阶段授权；每平台独立执行、独立记录（请求/响应/日志/截图/耗时）。

## 通用准备

- 隔离数据集：独立 RECEIVE_TOKEN + 独立 DB（D1/Turso 各建测试库），不与任何真实数据混用。
- 固定用例集（每平台相同脚本，参数化 base URL）：
  U1 冷启动页面 200 / U2 登录→主页面 / U3 If-None-Match→304(0 字节) / U4 登出→旧 ETag→200 登录页 /
  U5 播种 500 条→分页/游标连续性 / U6 批量已读/删除（含部分失败）/ U7 通知多目标一成一败 /
  U8 断网/超时恢复 / U9 401 过期→重载 / U10 响应头完整（SECURITY_HEADERS + CC + ETag + Set-Cookie）。
- 证据：HAR + 响应头截图 + 关键页面截图 + 耗时表；每条标注证据等级。

## 逐平台

| 顺序 | 平台 | 部署方式 | 特有验证项 |
|---|---|---|---|
| 1 | Node.js | 本机（已完成 E2 基线，D 阶段补 Docker 镜像内运行） | Docker 网络下 lifecycle 关停 |
| 2 | Cloudflare | wrangler deploy（D1 测试库） | crons 触发 /api/cron；D1 游标分页；Workers 304 透传；**与 EdgeOne 分别出独立报告** |
| 3 | EdgeOne Pages | 控制台部署 functions | Turso 连通；CDN 对 no-cache+ETag+Vary 的处理；函数层响应头透传 |
| 4 | Vercel | vercel CLI 或 Git 集成 | api 函数冷启动耗时；Turso；vercel.json 路由与头透传 |
| 5 | Netlify | netlify CLI | functions 层 Set-Cookie/ETag 透传；public/ 静态资产 |
| 6 | Deno Deploy | GitHub 直连 | main.js 入口；Turso；边缘 304 |
| 7 | E4 全链路 | 真实 Chrome + Firefox + 真机（Android） | 浏览器 304/200 实测、-webkit-line-clamp、触摸、safe-area |

## 判定

- 每平台独立 PASS/FAIL（U1-U10）；任一平台 FAIL 不阻断其他平台记录，但必须进入 08-risk-register 并给修复方案。
- 全部完成后出 FINAL-VERDICT.md（终版需六平台 × U1-U10 证据矩阵 + E4 抽样）。
