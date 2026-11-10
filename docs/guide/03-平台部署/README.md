# 平台部署指南（选一篇看）

> 每篇都按「点哪里 → 填什么 → 怎么算成功 → 出错怎么办」写，不需要看源码。

| 平台 | 适合谁 | 部署入口 | 指南 |
|---|---|---|---|
| **Cloudflare Workers** | 第一次用、想最省事、零成本 | 官方 Deploy to Cloudflare 按钮 | [01-Cloudflare](01-Cloudflare.md) |
| Vercel | 已有 Vercel 账号 | 官方 Deploy Button | [02-Vercel](02-Vercel.md) |
| Netlify | 已有 Netlify 账号 | 官方 Deploy to Netlify 按钮 | [03-Netlify](03-Netlify.md) |
| Deno Deploy | 想用 Deno 原生运行时 | Git 导入（官方按钮本项目未提供） | [04-DenoDeploy](04-DenoDeploy.md) |
| 腾讯 EdgeOne Makers | 主要国内访问 | Git 导入（官方按钮本项目未提供） | [05-EdgeOne](05-EdgeOne.md) |
| Node / Docker 自托管 | 已有服务器、想完全自控 | 无一键部署，全部手动 | [06-Node自托管](06-Node自托管.md) |

> **不确定选哪个就选 Cloudflare**：它是六个平台里唯一「按钮会自动创建并绑定数据库」的，需要你填的东西最少。

---

## 六篇指南共同的阅读方式

1. **部署入口**：告诉你去哪个页面、点哪个按钮（或哪个菜单）。
2. **点击步骤**：按序操作，不跳步。
3. **需要填写的内容**：一张表，给出每个字段的名称、示例值、去哪里拿。
4. **成功标志**：看到什么才算完成，不要凭感觉。
5. **常见错误**：按现象查，先试最简单的那条。
6. **详细教程**：链接到仓库里更完整的技术向平台 README（可选阅读）。

---

## 通用准备：除 Cloudflare 外都要先建 Turso 数据库

Vercel / Netlify / Deno Deploy / EdgeOne 用的是外部数据库 [Turso](https://turso.tech)（SQLite 兼容），**平台的部署按钮不会替你创建它**。请先做这三步：

1. 打开 [turso.tech](https://turso.tech) → 用 GitHub 登录 → **Create Database**：名称填 `sms-gateway`，区域选离你近的，类型 Free。
2. 在数据库详情页记下 **Database URL**（形如 `libsql://sms-gateway-xxxx.turso.io`）；点 **Create Token**，**立即复制保存**（只显示一次）。
3. 初始化表结构：把对应平台目录里的 `schema.sql` 全部内容粘进数据库 **Console** 执行；或者依赖应用首次请求自动建表（`ensureSchema`）。**建议手动执行一次更稳妥**，尤其是首次部署。

> 命令行等价做法：`turso db create sms-gateway` → `turso db show sms-gateway --url` → `turso db tokens create sms-gateway` → `turso db shell sms-gateway < schema.sql`。

---

## 三个必须先说清楚的事实

1. **按钮 ≠ 全部完成**。五个 Serverless 平台的按钮都属于「模板部署」：帮你把代码变成运行中的应用，但密钥（以及外部数据库）仍要你自己填。
2. **Cloudflare 按钮会自动创建并绑定 D1 数据库，但不会执行建表 SQL**；表是应用 `ensureSchema` 在首次请求自动建的。把它说成「按钮连建表都做了」是不准确的。
3. **按钮部署的是公开仓库 `main` 分支**。以管理页页脚版本号为准。

完整核实依据（官方 URL、核实日期 2026-11-09、免费额度与地区限制）见 [部署能力矩阵](../10-部署能力矩阵.md)。

---

## Node 自托管用户：还有一个必做步骤

应用停机时最多需要 **80 秒** 收尾，而 Docker 默认只给 **10 秒**。**部署前必须把停止宽限设为 ≥90 秒**，否则升级/重启时后台通知会被强杀。见 [停止宽限与部署配置](../07-停止宽限与部署配置.md)。
