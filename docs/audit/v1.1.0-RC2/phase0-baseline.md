# SMSToWeb v1.1.0 · RC2 · 阶段 0 执行基线（修改前快照）

> 本文件为 RC2 整理轮在**任何修改之前**记录的仓库状态基线。后续阶段 1/2 的改动都将与此基线对照，以区分「历史已有未提交文件」与「本轮新增/修改」。
> 严守工作区保护：未执行任何 git add / commit / 删除 / 覆盖历史报告。

---

## 1. 固定基线核对

| 项 | 要求值 | 实测值 | 结论 |
|---|---|---|---|
| 分支 | `main` | `main` | ✅ 一致 |
| HEAD | `7e8fa8d1f5c1e575018e8d5ceb37d32f98773c5c` | `7e8fa8d1f5c1e575018e8d5ceb37d32f98773c5c` | ✅ 一致 |
| APP_VERSION | `v1.0.4`（本轮目标升级为 v1.1.0） | `v1.0.4`（`src/worker.js:73`） | ✅ 起点正确，待阶段 2 升级 |
| 历史报告存在性 | RC1 首轮 / RC1 补充 / RC1 56文件清单 / P1 两份 | 5 份均存在 | ✅ |

**环境版本**
- Node：`v22.22.2`（`node:sqlite` 可用）
- Python：`3.13.14`
- Docker：`N/A`（本 shell 不可用；RC2 整理无需 Docker，真实容器宽限验证属 NOT TESTED）
- OS：`MINGW64_NT-10.0-26200`（Windows 10 / Git Bash）

---

## 2. Git 状态总览（`git status --porcelain=v1 -uall`）

| 状态类别 | 数量 |
|---|---:|
| tracked modified（` M `） | 52 |
| tracked added（`A `） | 0 |
| tracked deleted（` D `） | 0 |
| 已暂存（任意 `M `/`A `/`D ` 首列非空格） | 0 |
| untracked（`??`） | 2914 |
| **合计** | **2966** |

> 注：未执行 `git add`，无任何暂存区变更。52 个 modified 均为工作树相对 HEAD 的未提交修改（属 M-2/M-3、P1、RC1 历史阶段积累，非本轮产生）。

---

## 3. 52 个 tracked modified 文件清单

```
README.md
docs/ARCHITECTURE.md
docs/DATABASE.md
docs/DESIGN-SYSTEM.md
docs/UPGRADE.md
docs/i18n/MAINTENANCE.md
docs/i18n/README.md
docs/i18n/de/ARCHITECTURE.md
docs/i18n/de/README.md
docs/i18n/en/ARCHITECTURE.md
docs/i18n/en/README.md
docs/i18n/es/ARCHITECTURE.md
docs/i18n/es/README.md
docs/i18n/fr/ARCHITECTURE.md
docs/i18n/fr/README.md
docs/i18n/ja/ARCHITECTURE.md
docs/i18n/ja/README.md
docs/i18n/ko/ARCHITECTURE.md
docs/i18n/ko/README.md
docs/i18n/pt-BR/ARCHITECTURE.md
docs/i18n/pt-BR/README.md
docs/i18n/zh-CN/README.md
docs/i18n/zh-TW/ARCHITECTURE.md
docs/i18n/zh-TW/README.md
platforms/README.md
platforms/cloudflare/README.md
platforms/cloudflare/schema.sql
platforms/cloudflare/worker.js
platforms/deno/app.js
platforms/deno/main.js
platforms/deno/schema.sql
platforms/edgeone/app.js
platforms/edgeone/functions/index.js
platforms/edgeone/schema.sql
platforms/gen_app.py
platforms/netlify/app.js
platforms/netlify/functions/api.mjs
platforms/netlify/functions/cron.mjs
platforms/netlify/schema.sql
platforms/node/Dockerfile
platforms/node/README.md
platforms/node/app.js
platforms/node/db.js
platforms/node/schema.sql
platforms/node/server.mjs
platforms/shared/app.js
platforms/vercel/api/[[...route]].js
platforms/vercel/app.js
platforms/vercel/schema.sql
schema.sql
src/worker.js
tests/run.mjs
```
共 52 个。分类：根文档 5（README + 4 docs）、i18n 镜像 22、六平台 18、schema.sql 1、src/worker.js 1、tests/run.mjs 1、gen_app.py 1。

---

## 4. Untracked 分类（2914 个，按顶层/二级目录统计）

> 说明：`"runtime` / `"docs` 等带前导引号的条目**不是独立目录**——`ls` 仓库根确认仅有单一 `runtime/` 与 `docs/`。引号来自 git 对含特殊字符（如文件名含 `"`、非 ASCII）的未跟踪路径整体加引号；awk 按 `/` 切分后把引号留在首段。属同一目录的两种表示，非新增目录。

| 顶层目录 | 数量 | 说明 |
|---|---:|---|
| `runtime/` | 2857 | 本地运行/实验/基准数据（见下） |
| `docs/` | 54 | RC1/RC2 审计附件 + 新建指南/部署模板 |
| `tests/` | 2 | `p1-auth.mjs`、`m1-lifecycle.mjs`（新建测试） |
| `platforms/` | 1 | `platforms/node/lifecycle.mjs`（新建） |

`runtime/` 二级分布：
| 二级路径 | 数量 | 性质 |
|---|---:|---|
| `runtime/bench/` | 2736 | 本地 SQLite 性能基准库与日志（实验数据，不应发布） |
| `runtime/backup/` | 67 | 本地备份（不应发布） |
| `runtime/sms_ui_security/` | 51 | 本地 UI 安全验证产物（不应发布） |
| `runtime/ui-v2.db*` | 3 | 本地 SQLite 数据库（不应发布） |

`docs/` 二级分布（多为 RC1 补充附件与本轮将建 RC2 附件）：
| 二级路径 | 数量 | 性质 |
|---|---:|---|
| `docs/audit/` | 33 | RC1 补充附件 + 本轮 RC2 附件（应发布） |
| `docs/guide/` | 17 | 新建用户指南（应发布） |
| `docs/deploy-templates/` | 3 | 新建部署模板（应发布） |
| `docs/i18n/` | 1 | `en/QUICKSTART.md`（应发布） |

---

## 5. 关键文件 SHA-256（修改前基线）

| 文件 | SHA-256（前 64 位） |
|---|---|
| `src/worker.js` | `d8c32aa2fdf1300333614323b48815755f9def770129365f7f6480fced6c8a6c` |
| `schema.sql` | `c7dbefcbcf7ac8a7498dc5fa682e70db6dc05db0934b6f0d4fee543d028aff44` |
| `platforms/gen_app.py` | `d304100e92cc26c5ef9f58b949a39b42e153a062f42d166082d744f977a65e40` |
| `platforms/shared/app.js` | `1a78e27c5ab26bac4e1dc2da6d010573c81141006fc3e80c646cc4312ec6f7d9` |
| `platforms/shared/db.js` | `219aea663226977a0e1aff90a0a71950fd6562a658f9dc6075ccdf44b63ce29b` |
| `platforms/cloudflare/worker.js` | `d8c32aa2fdf1300333614323b48815755f9def770129365f7f6480fced6c8a6c` |
| `platforms/vercel/app.js` | `1a78e27c5ab26bac4e1dc2da6d010573c81141006fc3e80c646cc4312ec6f7d9` |
| `platforms/deno/app.js` | `1a78e27c5ab26bac4e1dc2da6d010573c81141006fc3e80c646cc4312ec6f7d9` |
| `platforms/netlify/app.js` | `1a78e27c5ab26bac4e1dc2da6d010573c81141006fc3e80c646cc4312ec6f7d9` |
| `platforms/edgeone/app.js` | `1a78e27c5ab26bac4e1dc2da6d010573c81141006fc3e80c646cc4312ec6f7d9` |
| `platforms/node/app.js` | `1a78e27c5ab26bac4e1dc2da6d010573c81141006fc3e80c646cc4312ec6f7d9` |
| `platforms/node/db.js` | `388cd2e9ec004606478a42ba4424857e96a80678d47ec5248cccb6a5f289855d` |
| `README.md` | `64f80c3270bd4bb921abe7b0b9c19a1723100bc6c62d25489a6b6e534c9ab150` |
| `docs/ARCHITECTURE.md` | `056376ec6fca1e5967c5263ae7993c1e11397aa273ab292de59538c299386885` |

**预修改一致性结论**
- `cloudflare/worker.js` ≡ `src/worker.js`（`d8c32aa…`）—— Cloudflare 为 src 逐字节副本 ✅
- `vercel/deno/netlify/edgeone/node` 五平台 `app.js` ≡ `shared/app.js`（`1a78e27…`）—— 五平台共享应用核心一致 ✅
- `node/db.js`（`388cd2e…`）≠ `shared/db.js`（`219aea…`）—— Node 平台使用自有数据库适配器，预期差异 ✅

本基线将在阶段 2（版本升级 + 生成器同步）后重新计算 SHA，以核验「仅版本同步、无意外漂移」。

---

*阶段 0 完成。HEAD / APP_VERSION / 历史报告 / 关键文件哈希均已记录，未做任何修改。进入阶段 1。*
