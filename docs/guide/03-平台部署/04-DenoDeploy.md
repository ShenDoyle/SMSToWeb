# Deno Deploy 部署指南

> 与 Cloudflare Worker 语义最接近。需要先准备 Turso 数据库（见 [平台部署总览](README.md)）。
> 完整技术版：[platforms/deno/README.md](../../../platforms/deno/README.md)。

## 部署入口（点哪里）

**本项目目前没有提供 Deno 的一键按钮。** 最短路径是 Git 导入：

1. 打开 [console.deno.com](https://console.deno.com) → 用 GitHub 登录。
2. 点 **+ New App** → 选你 Fork 的仓库（或填写仓库 URL）。
3. 构建配置里把入口指向 `platforms/deno/main.js`。

> 平台官方**确实有** Deploy Button（`https://console.deno.com/new?clone=<仓库URL>`），但本项目**未提供、也未在真实平台验证**，所以不把它写成「可用的一键部署」。见 [部署能力矩阵](../10-部署能力矩阵.md)。

## 点击步骤

1. **先建好 Turso 库**并记下 URL / Token。
2. Fork / 导入仓库到你的 GitHub 账号。
3. 控制台 **+ New App** → 选仓库 → 确认 Build config（framework / install / build / 入口文件）。
4. 在 **Environment Variables** 里手工填下面几项 —— **官方 Deploy Button 没有 env 参数，这一步一定得手工做**。
5. 点部署，等待完成。
6. **执行建表**：把 `platforms/deno/schema.sql` 粘进 Turso Console 执行，或依赖应用首次请求自愈。
7. 打开 `*.deno.net` 地址。

## 需要填写的内容

| 字段 | 示例 | 说明 |
|---|---|---|
| `RECEIVE_TOKEN` | `tK8mQ2xV7pL...` | 自己生成 |
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | Turso 详情页 |
| `TURSO_AUTH_TOKEN` | `eyJ...` | Turso → Create Token |
| `ENABLE_AUTH` / `ADMIN_PASSWORD` / `SESSION_SECRET` | 见 [快速开始](../02-快速开始.md) | 建议开启登录 |

> 控制台支持 Production / Development / Build 三种上下文，以及 secret 类型（创建后界面不可见）。变量名 ≤128 字节、值 ≤128kB。

## 成功标志

- 部署详情页状态成功；打开 `*.deno.net` 能看到管理页；
- 发一条测试消息后页面出现数据。

## 常见错误及解决办法

| 现象 | 先试这个 |
|---|---|
| 找不到入口 / 404 | 确认 Build config 的入口是 `platforms/deno/main.js` |
| 页面无数据 | 检查环境变量是否填在**Production** 上下文；确认 Turso 已建表 |
| 环境变量不生效 | 变量改动需要新部署；Build 上下文的变量仅构建期可见 |
| 连接被中断 | 官方说明 eviction 可能中断长连接，前端有指数退避会自动补拉 |
| 引用了旧版 `deno.land/deploy/docs` | **Deno Deploy Classic 已于 2026-07-20 关停**，请以 `docs.deno.com/deploy/` 现行文档为准 |

## 版本与验证提示

本轮**未对 Deno Deploy 做真实部署验证**；免费额度（1M 请求/月、20GiB egress、10hr CPU，以官方 pricing 页为准）与官方来源见 [部署能力矩阵](../10-部署能力矩阵.md)。
