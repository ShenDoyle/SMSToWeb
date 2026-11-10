# Node / Docker 自托管部署指南

> 适合**已经有服务器**、想完全自己控制的用户。这是六个平台里**唯一没有一键部署**的方式，全程手动。
> 完整技术版：[platforms/node/README.md](../../../platforms/node/README.md)。

## 部署入口（没有按钮，从这里开始）

在自己的服务器上准备 Node 22 或 Docker，然后按下面操作。**开始之前必须先做停止宽限配置**。

## ⚠ 第零步（必做）：设置 90 秒停止宽限

Docker 默认只给容器 **10 秒** 就强杀，而本应用停机最多需要 **80 秒** 收尾。不设置会导致升级/重启时后台通知丢失。

→ **[停止宽限与部署配置](../07-停止宽限与部署配置.md)**（按你的部署方式四选一，只做一种）

## 点击/执行步骤

1. 在服务器准备代码：`git clone https://github.com/ShenDoyle/SMSToWeb.git` 后进入 `platforms/node/`（该目录自包含）。
2. 选择数据库（二选一）：
   - **本地 SQLite**（最省事）：设 `SQLITE_PATH=/data/data.db`，并把 `/data` 挂成持久卷；首次启动自动建表。
   - **Turso**：按 [平台部署总览](README.md) 建库，设 `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`。
3. 构建镜像：`docker build -t smstoweb .`
4. 启动（**必须带 `--stop-timeout=90`**）：

```bash
docker run -d --name smstoweb --restart unless-stopped --stop-timeout=90 -p 8787:8787 \
  -e RECEIVE_TOKEN=你的密钥 \
  -e SQLITE_PATH=/data/data.db \
  -v sms-data:/data \
  smstoweb
```

5. （建议）用 Caddy / Nginx 反代加 HTTPS，绑定自己的域名。
6. 打开 `http://服务器IP:8787`（或你的域名）。

> 不用 Docker 也可以直接 `node server.mjs`（Turso 模式 Node 18+；本地 SQLite 模式需 **Node 22.13+**）。此时没有容器宽限这一层，但 **systemd / supervisor 仍必须给 ≥90 秒**。

## 需要填写的内容

| 字段 | 示例 | 说明 |
|---|---|---|
| `RECEIVE_TOKEN` | `tK8mQ2xV7pL...` | 必填，推送鉴权 |
| `SQLITE_PATH` | `/data/data.db` | 本地 SQLite 模式；与 Turso 二选一，设置后优先 |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Turso 的两项 | 不用本地 SQLite 时必填 |
| `ENABLE_AUTH` / `ADMIN_PASSWORD` / `SESSION_SECRET` | 见 [快速开始](../02-快速开始.md) | **强烈建议**开启登录 |
| `SHUTDOWN_GRACE_MS` | 默认 `80000` | 应用内部宽限，可调到 `120000`，**不能低于 80000**，且**不能替代容器宽限** |
| `PORT` | 默认 `8787` | 一般无需设置 |

## 成功标志

- `docker logs smstoweb` 里出现 `shutdown_grace=80s`；
- 打开地址能看到管理页；发一条测试消息后页面出现数据；
- 停机演练时容器退出码是 **0** 而不是 **137**（137 = 被 SIGKILL，说明宽限没生效）。

## 常见错误及解决办法

| 现象 | 先试这个 |
|---|---|
| 重启后通知丢失 / 退出码 137 | 停止宽限没配好，回 [第零步](#️-第零步必做设置-90-秒停止宽限)；`docker inspect smstoweb --format '{{.Config.StopTimeout}}'` 应为 90 |
| 容器起不来 / 报 `node:sqlite` 错误 | 本地 SQLite 模式需 Node **22.13+**；确认用的是 `node:22-alpine` 镜像 |
| 数据重启后没了 | `-v` 卷没挂或 `SQLITE_PATH` 指到了容器内部临时路径 |
| 页面无数据 | 确认数据库凭据 / 首次启动已自动建表；看 `docker logs` |
| 想用 Fly.io / Railway | 本仓库**未核实**这两个平台能否把停机宽限设为 90s；请先查平台文档，无法设置则要接受重启时通知可能丢失 |

## 验证性质（别混淆）

- **本地已验证**：WSL2 + Docker 真实 `docker stop` 五场景（长轮询、后台通知、SIGTERM 后 SQLite 读取、超时记录、并发任务），证据在仓库外 `M1-fix/`。
- **生产未配置**：仓库里**没有**生产 Compose / systemd 单元，本轮也**没有**创建或改动任何生产编排文件；[三个模板](../../deploy-templates/)只是可复制的示例。生产侧配置必须由你执行。

## 版本提示

源码 `v1.1.0` 已固化至 `main`（`43aaecf`），未创建 GitHub Release / 未部署；以管理页页脚版本号为准。
