# 测试与浏览器回归

本仓库的应用本体（`src/worker.js` 与 `platforms/*`）**零 npm 运行时依赖**。
`package.json` 里的 devDependency 只服务于浏览器回归测试。

## 一、分层

| 层 | 命令 | 依赖 | 说明 |
|---|---|---|---|
| 核心与集成 | `node tests/run.mjs` | 无 | 850 项，含数据库/生命周期/通知分发 |
| 结构契约 | `node tests/p1-auth.mjs` / `settings-i18n.mjs` / `ux02-layout.mjs` / `ux03-settings.mjs` | 无 | 直接读源码做结构与契约断言，秒级 |
| 敏感字段安全 | `node tests/notify-sensitive-fields.mjs` | 无 | 进程内 `fetchApp` + 临时 SQLite + `127.0.0.1` Mock 出站 |
| 浏览器回归 | `npm run test:browser` | Playwright | 真实 Chromium，覆盖焦点/键盘/三态/九语言/三视口/双主题 |

一次性全跑：`npm run test:all`。

## 二、浏览器回归

```
 npm install            # 安装 playwright（版本在 package.json 中精确固定）
 npm run pw:install     # 下载对应 Chromium
 npm run test:browser
```

三个套件串行执行，任一失败即非零退出：

| 文件 | 覆盖 | 本地耗时 |
|---|---|---|
| `tests/browser/ux04-dialog.mjs` | Dialog 语义、焦点栈、Tab/Shift+Tab 循环、Esc 逐层关闭、焦点返回、状态条播报、a11y 语义、三视口 + 深色 | ~14s |
| `tests/browser/ux03-browser.mjs` | 六分区切换、首页统计摘要、保存成功/失败/冲突、目标增删改、三视口、九语言、深色 | ~28s |
| `tests/browser/sec01-browser.mjs` | 敏感字段三态（留空/覆盖/清除）、冲突不部分写入、响应与日志脱敏、390px | ~18s |

### 隔离模型（`tests/browser/harness.mjs`）

- 每个套件起一个独立实例：`platforms/node/server.mjs` + 临时 SQLite（`os.tmpdir()`，结束删除含 `-wal/-shm/-journal`）
- 端口由系统分配；随机 `ADMIN_PASSWORD` / `SESSION_SECRET` / `RECEIVE_TOKEN`
- 不读生产凭据、不连生产库、不发真实通知；敏感字段只写 `http://127.0.0.1:9/...` 假地址
- 测试凭据运行时随机生成，报告只输出布尔结论与长度，不打印明文
- 断言失败打印具体项名，`process.exitCode=1`

### Playwright 解析顺序

`require("playwright")` → `PW_NODE_MODULES`（可多个，用系统路径分隔符分隔）。
在没有 `node_modules` 的环境（例如已装好 Playwright 的 WSL）可直接：

```bash
PW_NODE_MODULES=/root/pwtest/node_modules node tests/browser/ux04-dialog.mjs
```

## 三、CI

`.github/workflows/ci.yml` 两个 Job：

- `check`：六平台零漂移 → `gen_app.py --check` → 语法检查 → `tests/run.mjs` → 其余 Node 套件
- `browser`：生成六平台产物 → `npm install`（Playwright 版本固定）→ `npx playwright install --with-deps chromium` → 依次跑三个浏览器套件

浏览器版本由 `package.json` 中的精确版本决定（Chromium 构建号随 Playwright 版本绑定），CI 不做浮动升级。
任一浏览器套件失败都会让 Job 失败并阻断，不使用 `|| true`。
