# Vercel 部署指南

> 适合已有 Vercel 账号的用户。需要先准备 Turso 数据库（见 [平台部署总览](README.md#通用准备除-cloudflare-外都要先建-turso-数据库)）。
> 完整技术版：[platforms/vercel/README.md](../../../platforms/vercel/README.md)。

## 部署入口（点哪里）

[platforms/vercel/README.md](../../../platforms/vercel/README.md) 顶部的 **Deploy with Vercel** 按钮，地址格式：

```
https://vercel.com/new/clone?repository-url=<编码后的仓库URL>&env=RECEIVE_TOKEN,TURSO_DATABASE_URL,TURSO_AUTH_TOKEN
```

也可以不用按钮：Vercel Dashboard → **New Project → Import Git Repository**。

## 点击步骤

1. **先建好 Turso 库**并记下 URL / Token（[总览](README.md) 的通用准备三步）。
2. 点部署按钮 → 登录 Vercel（用 GitHub 登录最快）→ 授权并把仓库克隆到你的账号。
3. 创建项目时，Framework Preset 选 **Other**、Build Command **留空**（本项目零构建）。
4. 在 **Environment Variables** 页填下面 3 项（按钮的 `env` 参数只列出名称，**值必须你填**）。
5. 点 **Deploy**，等构建完成。
6. 打开自动分配的 `*.vercel.app` 地址。
7. **执行建表**：把 `platforms/vercel/schema.sql` 粘进 Turso Console 执行（Vercel 不会自动建表）；或依赖应用首次请求自愈。

## 需要填写的内容

| 字段 | 示例 | 去哪里拿 |
|---|---|---|
| `RECEIVE_TOKEN` | `tK8mQ2xV7pL...` | 自己生成 |
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | Turso 数据库详情页 |
| `TURSO_AUTH_TOKEN` | `eyJ...` | Turso → Create Token（只显示一次） |
| `ENABLE_AUTH` / `ADMIN_PASSWORD` / `SESSION_SECRET` | 见 [快速开始](../02-快速开始.md) 第 3 步 | 建议一并开启登录 |
| `WAIT_MAX_SECONDS`（可选） | 入口默认 `20` | 若长轮询被平台截断就调低 |

> 按钮 URL **不能**携带密钥值（官方明确禁止，URL 会进浏览器历史）。官方也提醒 `envDefaults` 只能放非敏感默认值。

## 成功标志

- Vercel 显示一次成功部署；打开 `*.vercel.app` 能看到管理页；
- 按 [快速开始](../02-快速开始.md) 发一条测试消息，页面出现数据。

## 常见错误及解决办法

| 现象 | 先试这个 |
|---|---|
| 构建失败 | Framework Preset 选 `Other`、Build Command 留空；确认 Root Directory 指到 `platforms/vercel` |
| 页面打开但无数据 / 报数据库错误 | 检查 3 个环境变量值有没有抄错（Token 只显示一次）；确认已执行建表 SQL |
| 环境变量改了不生效 | Vercel 需要**重新部署**才会应用新的环境变量 |
| 长轮询频繁断开 | 调低 `WAIT_MAX_SECONDS`；前端有指数退避，不影响功能，只影响提醒延迟 |
| Hobby 计划被限 | 官方 Hobby 明确限定**非商业、个人用途**；超额需升级 Pro |

## 版本与验证提示

按钮部署公开仓库 `main` 分支；以管理页页脚版本号为准。官方能力与免费额度依据见 [部署能力矩阵](../10-部署能力矩阵.md)。
