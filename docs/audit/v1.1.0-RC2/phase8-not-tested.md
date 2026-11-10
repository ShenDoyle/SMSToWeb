# SMSToWeb v1.1.0 · RC2 · 阶段8 生产发布限制与 NOT TESTED 登记

> 阶段8目标：明确登记**未真实部署验证**的项目。RC2 受约束（不部署、不连生产、不连生产凭据、不发送真实通知），以下项目均未取得真实运行时证据，须照实登记，禁止以静态/隔离/模拟证据替代生产验证。Cloudflare 与 EdgeOne **分别**登记（不合并）。

## 验证层级对照（发布说明口径）

| 层级 | 含义 | v1.1.0 覆盖 |
|---|---|---|
| 已实现（Implemented） | 代码已落地 | 全部 v1.1.0 功能（DISABLE_RECEIVE_TOKEN 纳入 33 项 ENV_KEYS、星标集合投影优化、大 offset 分页加速、1180px 仪表盘、多目标通知、PWA 等） |
| 本地验证（Locally verified） | 隔离/本地可执行证据 | `tests/run.mjs` 850/0、`tests/p1-auth.mjs` 23/0、`:memory:` SQLite 性能基准（10k/100k）、Node SIGTERM 优雅 drain（WSL2 Docker 真实取证 32/0）、Edge headless 静态多视口渲染无溢出 |
| 未真实部署验证（NOT TESTED） | 真实生产运行时未取得证据 | 见下表 1–7 |

## NOT TESTED 登记（生产发布限制）

| # | 项目 | 状态 | 说明 |
|---|---|---|---|
| 1 | **六平台真实部署**（Cloudflare/Vercel/Netlify/Deno/EdgeOne/Node 生产环境启动·自愈·通知链路） | ⛔ NOT TESTED | 受约束未部署；仅生成器字节一致性 + 各平台适配层代码审查支撑 |
| 2 | **Turso 性能**（真实 Turso/libsql 远端 vs 本地 `:memory:` SQLite 基准） | ⛔ NOT TESTED | 性能基准在隔离 `:memory:` SQLite 完成；真实远端延迟/吞吐未测 |
| 3 | **动态 UI 端到端**（真实后端：登录→列表→详情→设置→导出→设备管理→PWA 安装） | ⛔ NOT TESTED | 仅单测覆盖业务分支 + 静态渲染覆盖响应式；真实浏览器 e2e 需运行后端 |
| 4 | **真实通知投递**（Feishu/WeCom/DingTalk/Telegram/ServerChan/PushPlus/Bark/ntfy/Gotify/Email/Webhook 真实到达） | ⛔ NOT TESTED | 受约束未发送真实通知；仅 `AbortSignal.timeout` 超时行为 + 失败隔离在单测中验证 |
| 5 | **容器/服务停止宽限**（各平台 ≥90s 停止宽限真实行为） | ⚠️ 部分 | Node SIGTERM 优雅 drain 已在 RC1 WSL2 Docker 真实取证（32/0）；**各平台生产容器宽限未逐一实测** |
| 6 | **Cloudflare 真实部署验证**（单独登记） | ⛔ NOT TESTED | 真实 Cloudflare Workers + D1 部署与首请求自愈、通知链路未实测；一键按钮本身 RC1 已标注"已验证创建/绑定"但部署后运行时未测 |
| 7 | **EdgeOne 真实部署验证**（单独登记） | ⛔ NOT TESTED | 真实 EdgeOne Pages + 函数 + Turso 部署与运行时未实测；RC1 已标注官方一键按钮"未验证、未随船发布" |

## 已诚实记录在文档的能力边界（非缺陷）

- 通知转发为 **best-effort**（单 failing target 不阻断其余、超时经 `AbortSignal.timeout` 真实终止底层请求）；跨实例/跨重启后台任务恢复不支持——架构边界，已在文档说明。
- `gen --check` **仅**校验 `SCHEMA_SQL` 内嵌块与 SQL 引用，不比对副本、不校验 `ENV_KEYS`——字节一致性须以文件指纹为准（已做）。
- Deno Deploy / EdgeOne 官方一键按钮：RC1 已标注"未验证、未随船发布"（README L70）。

## 发布前建议（关闭 NOT TESTED 的最小动作，超出 RC2 静态范围）

- 对**单一平台**（建议 Node 自托管或 Cloudflare 预览）做一次真实浏览器 smoke test，覆盖 #3 动态 UI 流程。
- 在目标平台真实部署后，验证 #1/#6/#7 的启动·自愈·通知链路。
- 若目标用 Turso，补充 #2 真实远端性能采样。

## 结论
阶段8闭合：NOT TESTED 项已逐项登记，Cloudflare 与 EdgeOne 分别单列；所有"未真实部署验证"均照实标注，无任何以静态/隔离证据冒充生产验证的情况。
