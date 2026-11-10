# Netlify 部署指南

> 适合已有 Netlify 账号的用户。需要先准备 Turso 数据库（见 [平台部署总览](README.md)）。
> 完整技术版：[platforms/netlify/README.md](../../../platforms/netlify/README.md)。

## 部署入口（点哪里）

[platforms/netlify/README.md](../../../platforms/netlify/README.md) 顶部的 **Deploy to Netlify** 按钮：

```
https://app.netlify.com/start/deploy?repository=https://github.com/ShenDoyle/SMSToWeb
```

也可以不用按钮：Netlify → **Add new project → Deploy from Git**。

## 点击步骤

1. **先建好 Turso 库**并记下 URL / Token。
2. 点按钮 → 登录 Netlify → 授权、把仓库克隆到你的 Git 账号。
3. 在创建向导的构建配置里，把 **Base directory 填 `platforms/netlify`**（本平台的 `netlify.toml` 在这个子目录）。
4. 创建站点后进入 **Site configuration → Environment variables**，填下面几项。
5. **重新部署一次**（环境变量改动只影响新部署）。
6. **执行建表**：把 `platforms/netlify/schema.sql` 粘进 Turso Console 执行（Netlify 不会自动建表）。
7. 打开 `*.netlify.app` 地址。

## 需要填写的内容

| 字段 | 示例 | 说明 |
|---|---|---|
| Base directory | `platforms/netlify` | 填错会找不到 `netlify.toml` |
| `RECEIVE_TOKEN` | `tK8mQ2xV7pL...` | 自己生成 |
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | Turso 详情页 |
| `TURSO_AUTH_TOKEN` | `eyJ...` | Turso → Create Token |
| `ENABLE_AUTH` / `ADMIN_PASSWORD` / `SESSION_SECRET` | 见 [快速开始](../02-快速开始.md) | 建议开启登录 |
| `WAIT_MAX_SECONDS`（可选） | 入口默认 `8` | 若请求被平台提前截断可再下调；平台时长限制请以官方文档为准 |

> 官方明确：**不要把密钥写进 `netlify.toml`**（会提交进仓库，且 Functions 运行时读不到）。`[template.environment]` 只能放提示标签，不能放值。

## 成功标志

- 站点部署成功；打开 `*.netlify.app` 能看到管理页；
- 发一条测试消息后页面出现数据（[快速开始](../02-快速开始.md) 第 4 步）。

## 常见错误及解决办法

| 现象 | 先试这个 |
|---|---|
| 构建找不到配置 / 函数 404 | Base directory 必须是 `platforms/netlify` |
| 页面无数据 | 确认 3 个环境变量值正确；已执行建表 SQL；改过变量后**重新部署** |
| 首次构建因扩展失败 | 若按官方 Turso 扩展指南操作，扩展要在站点创建后安装，首次构建可能失败，装完重新部署即可 |
| 站点突然打不开 | 现行 credit-based Free 每月 300 credits，用完后暂停到下个计费周期；看控制台用量概览 |
| 长轮询被截断 | 调低 `WAIT_MAX_SECONDS`；前端有指数退避，功能不受影响 |

## 版本与验证提示

按钮部署公开仓库 `main` 分支，可能落后于本地工作区。本轮**未对 Netlify 做真实部署验证**；官方能力与免费额度依据见 [部署能力矩阵](../10-部署能力矩阵.md)。
