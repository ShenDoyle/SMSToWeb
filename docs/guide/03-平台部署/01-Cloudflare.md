# Cloudflare Workers 部署指南（推荐新手）

> 免费、不用服务器、不用买域名。六个平台里需要你填的东西最少。
> 完整技术版：[platforms/cloudflare/README.md](../../../platforms/cloudflare/README.md)。

## 部署入口（点哪里）

打开 [根 README](../../../README.md) 或 [平台 README](../../../platforms/cloudflare/README.md)，点这个按钮：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

按钮地址：`https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare`

## 点击步骤

1. 点按钮 → 登录 Cloudflare 账号（没有就先注册，免费、无需信用卡）。
2. 授权 GitHub / GitLab，选择「把仓库克隆到我自己的账号」。
3. 进入 **设置页**：确认仓库名、Worker 名（可用默认值）。
4. 在设置页按提示填写下面的密钥。
5. 点 **Create / Deploy**，等构建完成（通常 1–2 分钟）。
6. 打开分配给你的 `https://<Worker名>.<子域>.workers.dev` 地址。

## 需要填写的内容

| 字段 | 在哪填 | 填什么 / 示例 | 去哪里拿 |
|---|---|---|---|
| `RECEIVE_TOKEN` | 按钮设置页 / Worker → Settings → Variables and Secrets | 32 位以上随机串，如 `tK8mQ2xV7pL...` | 自己用密码管理器生成 |
| `ENABLE_AUTH` | 同上（可选但**强烈建议**） | `true` | 直接填 |
| `ADMIN_PASSWORD` | 同上（开启登录时必填） | 自己编的管理密码 | 密码管理器生成 |
| `SESSION_SECRET` | 同上（开启登录时必填） | **另一个**独立随机串，≥32 位，**不能与密码相同** | 另生成一个 |

> 按钮**不会替你填**这些值；开启登录时后两项缺一不可，漏配时系统会拒绝登录（安全设计，不是故障）。

## 按钮自动做了什么 / 没做什么

| 自动做 ✅ | 没做 ❌ |
|---|---|
| 克隆公开仓库到你的账号 | **不执行建表 SQL**（应用 `ensureSchema` 首次请求自动建） |
| **创建并绑定 D1 数据库**（回写 `database_id`） | 不创建 Turso 数据库（本平台用 D1） |
| 绑定 `wrangler.toml` 声明的平台原生资源 | 不填你的密钥 |
| 配置构建/CI（之后 push 自动重新部署） | 不绑自定义域名 |

## 成功标志

- 部署平台显示一次成功的构建/部署；
- 浏览器打开 `*.workers.dev` 能看到管理页（空列表也算成功）；
- 按 [快速开始](../02-快速开始.md) 第 4 步发一条测试消息，页面出现这条消息。

## 常见错误及解决办法

| 现象 | 先试这个 |
|---|---|
| 按钮点了没反应 / 报仓库错误 | 确认用的是 public GitHub/GitLab 仓库；按钮只支持 Workers、不支持 Pages；monorepo 支持不完整 |
| 页面打不开 | 看 Workers Builds 日志；确认 `RECEIVE_TOKEN` 已填 |
| 推送返回 error 1010 / 请求根本没进日志 | `workers.dev` 默认开启浏览器完整性检查，默认 `User-Agent` 的客户端会被拦；让推送端带描述性 `User-Agent`，或绑自定义域名 |
| 打开后要登录但不知道密码 | 密码是你自己在 `ADMIN_PASSWORD` 里设的；漏配时管理接口一律拒绝访问，请回设置页补齐 |
| 页面能开、发消息却没数据 | 等首次请求触发 `ensureSchema`；仍无数据再看管理页「设置 → 统计」里的「库结构自愈」状态 |
| 升级/换版本后还是旧界面 | 按钮部署的是公开仓库 `main` 分支，可能落后；以页脚版本号为准 |

## 版本与验证提示

- 仓库 `ShenDoyle/SMSToWeb` 公开存在、默认分支 `main`（2026-11-09 核实），但**远端内容可能落后于本地工作区**。
- 本轮**没有**对 Cloudflare 做真实部署验证；上述流程依据平台官方文档与项目配置，不是实测结果。
- 官方依据见 [部署能力矩阵](../10-部署能力矩阵.md) 第 3 节。
