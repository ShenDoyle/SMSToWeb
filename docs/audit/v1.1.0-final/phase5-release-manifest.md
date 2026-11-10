# SMSToWeb v1.1.0 · 阶段5：正式版文件清单与 Git 提交范围

> 采集时点：2026-11-10 16:10 (GMT+8)，`git status --porcelain --untracked-files=all`（展开口径）
> 基线：分支 `main`，HEAD `7e8fa8d1…`，**0 staged**、**0 commit**、**0 push**、**0 tag**、**0 deploy**
> 工作区：**53 tracked modified + 77 untracked = 130 项**；加上采集后落盘的阶段5 自身附件，清单共 **133 行**
> **本轮不执行 `git add` / `commit` / `push` / `tag`，不使用 `git add .` / `-A`。**

---

## 5.1 分类方法与统计（§9.1）

逐文件（**非按文件名批量**）依据 `git status`、文件用途、RC1/RC2 报告、当前源码、已完成测试与 mtime 判定。机器可读的**逐文件 7 列属性表**：

**`docs/audit/v1.1.0-final/evidence/phase5-file-inventory.tsv`**
列：`path | git_state | category | in_release | has_historical_change | reason | verification_evidence`

| 类别 | 含义 | 行数 | 纳入正式提交 |
|---|---|---|---|
| **A** 正式源码/配置 | `src/`、`platforms/`、`schema.sql`、`.gitignore` | **29** | 29 |
| **B** 正式测试 | `tests/` | **3** | 3 |
| **C** 正式文档 | README、docs 主版、guide、i18n、deploy-templates、releases | **46** | 46 |
| **D1** 正式审计材料 | RC1→RC2→Final 验收证据链 + 本轮阶段报告与原始证据 | **43** | 43 |
| **D2** 历史审计底稿 | 10 份带时效性勘误的归档原文 | **10** | 0（需用户确认） |
| **E** 本地/重复/空证据 | 重复留存副本、空 stderr | **2** | 0（明确排除） |
| **F** 其他未分类 | — | **0** | 0 |
| **合计** | | **133** | **121** |

> **F = 0**：不存在无法解释的文件。所有排除项均有明确原因（见 §5.4）。

---

## 5.2 历史未提交改动保护（§9.2）

| 事实 | 说明 |
|---|---|
| 53 个 tracked modified | 全部是 RC1/RC2 周期累积的**有效工作树修订**（源码、六平台入口/DDL、生成器、测试、README、docs 主版、i18n 各语言镜像），**不是本轮新增**。本轮仅在其上叠加 `.gitignore`、版本/i18n/发布说明修订。**一个都没有被排除或丢弃** |
| 77 个 untracked | 含 `docs/guide/` 17 篇、`docs/deploy-templates/` 3 个、`docs/audit/` 52 项、RC1 截图 14 张、新增测试 2 个、`lifecycle.mjs`、`QUICKSTART.md`、发布说明及本轮阶段报告 —— 均按实际用途逐项归类，未因"不是本轮新改动"而排除 |
| `runtime/` 2907 文件 | 本地实验/基准/备份，**零删除、零移动、零清理**；通过阶段1 的 `/runtime/` 规则使其不再进入 Git 视野 |

判定依据：RC2 发布候选文件清单（A–J 分类）、RC1 补充验收报告、本轮阶段0–4 实测、文件实际内容与 mtime。

---

## 5.3 验证证据映射（§9.3「对应验证证据」）

| 类别 | 验证证据 |
|---|---|
| A | `python platforms/gen_app.py --check`、SHA256 字节一致性、`tests/run.mjs`、阶段2 Node 本地真实 HTTP 运行 |
| B | `node tests/run.mjs` / `tests/p1-auth.mjs` / `tests/m1-lifecycle.mjs` 本轮实际执行结果 |
| C | 阶段3 全仓事实扫描、阶段4 过度承诺自检、版本/链接/路径检查 |
| D1 | 本轮各阶段报告原始输出（phase0–9）+ RC1/RC2 归档结论 |
| D2 | RC1 补充验收报告「28 处」清单、RC2 发布候选文件清单 F 类定位 |
| E | 字节数/内容比对、空文件检查 |

---

## 5.4 五个清单（§9.3 要求）

### 清单 1 · 正式提交文件完整列表（121 项）

> 精确路径集同时固化为 **`docs/audit/v1.1.0-final/evidence/phase5-git-add-paths.txt`**（121 行，每行一个路径）。

#### A. 正式源码 / 配置（29）

```
.gitignore
schema.sql
src/worker.js
platforms/README.md
platforms/gen_app.py
platforms/shared/app.js
platforms/cloudflare/README.md
platforms/cloudflare/schema.sql
platforms/cloudflare/worker.js
platforms/vercel/app.js
platforms/vercel/schema.sql
platforms/vercel/api/[[...route]].js
platforms/deno/app.js
platforms/deno/main.js
platforms/deno/schema.sql
platforms/netlify/app.js
platforms/netlify/schema.sql
platforms/netlify/functions/api.mjs
platforms/netlify/functions/cron.mjs
platforms/edgeone/app.js
platforms/edgeone/schema.sql
platforms/edgeone/functions/index.js
platforms/node/app.js
platforms/node/db.js
platforms/node/schema.sql
platforms/node/server.mjs
platforms/node/Dockerfile
platforms/node/README.md
platforms/node/lifecycle.mjs
```

#### B. 正式测试（3）

```
tests/run.mjs
tests/m1-lifecycle.mjs
tests/p1-auth.mjs
```

#### C. 正式文档（46）

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
docs/i18n/en/QUICKSTART.md
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
docs/deploy-templates/compose.example.yaml
docs/deploy-templates/docker-run.example.sh
docs/deploy-templates/smstoweb.service.example
docs/guide/README.md
docs/guide/01-项目介绍.md
docs/guide/02-快速开始.md
docs/guide/03-平台部署/README.md
docs/guide/03-平台部署/01-Cloudflare.md
docs/guide/03-平台部署/02-Vercel.md
docs/guide/03-平台部署/03-Netlify.md
docs/guide/03-平台部署/04-DenoDeploy.md
docs/guide/03-平台部署/05-EdgeOne.md
docs/guide/03-平台部署/06-Node自托管.md
docs/guide/04-使用指南.md
docs/guide/05-常见问题.md
docs/guide/06-验收场景.md
docs/guide/07-停止宽限与部署配置.md
docs/guide/08-界面交互问题清单.md
docs/guide/09-更新与维护.md
docs/guide/10-部署能力矩阵.md
docs/releases/v1.1.0.md
```

#### D1. 正式审计材料（43）

P1 / RC1 / RC2 验收链（27）：

```
docs/audit/P1-最终补证与发布门禁报告.md
docs/audit/P1-鉴权与后台通知可靠性闭环报告.md
docs/audit/v1.1.0-RC1-发布候选验收报告.md
docs/audit/v1.1.0-RC1-补充验收报告.md
docs/audit/v1.1.0-RC1-补充/56文件逐项完整性清单.md
docs/audit/v1.1.0-RC1/README.md
docs/audit/v1.1.0-RC1/06-ui-overflow-evidence.md
docs/audit/v1.1.0-RC1/07-docs-consistency.md
docs/audit/v1.1.0-RC1/08-regression.md
docs/audit/v1.1.0-RC1/screenshots/host_login_320.png
docs/audit/v1.1.0-RC1/screenshots/host_login_390.png
docs/audit/v1.1.0-RC1/screenshots/host_page_320.png
docs/audit/v1.1.0-RC1/screenshots/host_page_390.png
docs/audit/v1.1.0-RC1/screenshots/login-1366.png
docs/audit/v1.1.0-RC1/screenshots/login-1920.png
docs/audit/v1.1.0-RC1/screenshots/login-320.png
docs/audit/v1.1.0-RC1/screenshots/login-390.png
docs/audit/v1.1.0-RC1/screenshots/login-768.png
docs/audit/v1.1.0-RC1/screenshots/page-1366.png
docs/audit/v1.1.0-RC1/screenshots/page-1920.png
docs/audit/v1.1.0-RC1/screenshots/page-320.png
docs/audit/v1.1.0-RC1/screenshots/page-390.png
docs/audit/v1.1.0-RC1/screenshots/page-768.png
docs/audit/v1.1.0-RC2-发布候选整理报告.md
docs/audit/v1.1.0-RC2-发布候选文件清单.md
docs/audit/v1.1.0-RC2/phase0-baseline.md
docs/audit/v1.1.0-RC2/phase2-version-inventory.md
docs/audit/v1.1.0-RC2/phase4-generation-consistency.md
docs/audit/v1.1.0-RC2/phase6-regression.md
docs/audit/v1.1.0-RC2/phase7-security.md
docs/audit/v1.1.0-RC2/phase8-not-tested.md
```

> 上面 RC1/RC2 共 **31** 项；D1 总数 43 = 31 + 本轮 `v1.1.0-final/` 12 项（下列）。

本轮 `v1.1.0-final/`（12 + 后续阶段报告，阶段9 刷新）：

```
docs/audit/v1.1.0-final/phase0-baseline.md
docs/audit/v1.1.0-final/phase0-untracked-files.txt
docs/audit/v1.1.0-final/phase1-runtime-gitignore.md
docs/audit/v1.1.0-final/phase2-six-platform-runtime.md
docs/audit/v1.1.0-final/phase3-i18n-review.md
docs/audit/v1.1.0-final/phase4-release-notes.md
docs/audit/v1.1.0-final/phase5-release-manifest.md
docs/audit/v1.1.0-final/evidence/node-smoke.mjs
docs/audit/v1.1.0-final/evidence/node-smoke-output.json
docs/audit/v1.1.0-final/evidence/phase3-fact-scan.txt
docs/audit/v1.1.0-final/evidence/phase5-file-inventory.tsv
docs/audit/v1.1.0-final/evidence/phase5-git-add-paths.txt
```

> 完整 121 行以 `phase5-git-add-paths.txt` 为准；本清单在**阶段9 完成后刷新**，纳入 phase6/7/9 报告与最终报告。

### 清单 2 · 明确排除文件（2）

| 路径 | 分类 | 排除原因 |
|---|---|---|
| `docs/audit/v1.1.0-final/evidence/node-smoke-last-run.json` | E | 与 `node-smoke-output.json` 为同一份结果的自动留存副本（7851 vs 7852 字节，仅末尾换行差），保留一份即可 |
| `docs/audit/v1.1.0-final/evidence/node-smoke-stderr.txt` | E | **空文件（0 字节）**；"stderr 为空"结论已写入阶段2报告 |

> 二者保留在工作区，**不删除**；仅不纳入正式提交。

### 清单 3 · 本地文件与实验材料（不进入提交）

| 项 | 数量 / 大小 | 处理方式 |
|---|---|---|
| `runtime/` 全部 | **2907 文件 / 875 MB** | 阶段1 已由 `/runtime/` 规则忽略；`git status -uall -- runtime/` = 0、`git ls-files --others --exclude-standard -- runtime/` = 0。**零删除** |
| ├ `runtime/bench/` | 2784 | 本地性能基准库、CDP 截图、Edge 浏览器 profile 缓存 |
| ├ `runtime/backup/` | 69 | 历史备份副本（含 `wrangler-account.json` 个人账户 ID/邮箱 —— 隐私风险来源） |
| ├ `runtime/sms_ui_security/` | 51 | 安全/CDP 实验产物 |
| └ `runtime/` 根级 | 3 | `ui-v2.db` + `-shm` + `-wal` 本地 SQLite |
| `runtime/**/*.log` | 48 | 变更前后均被既有 `*.log` 规则忽略 |
| `platforms/__pycache__/*.pyc` | 1 | 既有 `*.pyc` 规则忽略 |
| OS 临时目录 `smstoweb-v110-smoke-*` | 2 个临时 SQLite 库 | 位于系统 temp，**不在仓库内**，与 runtime/ 无关；未删除 |

### 清单 4 · 尚未分类文件

**0 项**（F = 0）。所有 133 行均已归类并给出原因。

### 清单 5 · 需要用户确认的文件（10）

均为 `docs/audit/` 下**带 2026-11-09 时效性勘误**的历史审计底稿。逐份核验其头部均含「时效性勘误 / 历史时点 / **不得作为当前发布依据** / 源码仍为 v1.0.4」：

```
docs/audit/01-功能现状矩阵.md
docs/audit/02-性能基线报告.md
docs/audit/03-平台能力对照.md
docs/audit/HTML与多终端交互体验审计.md
docs/audit/全项目性能与体验优化最终报告.md
docs/audit/六平台官方能力与最佳实践对照.md
docs/audit/功能现状矩阵.md
docs/audit/实施批次与改造记录.md
docs/audit/性能基线报告.md
docs/audit/文档一致性审计报告.md
```

**默认处理：不纳入正式提交**（可选随附），依据：
- 这些底稿自述"数字与描述只代表当时状态，不得作为当前发布依据"，且含 `ENV_KEYS=32`、旧测试数、`v1.0.4` 等过时事实；
- RC2 发布候选文件清单 F 类已定位为"可选随附、非运行时必需、不导入运行时"；
- 任务书 §9.1 D「不能把所有临时审计草稿自动纳入」、§3.2「不得删除历史审计报告」—— **保留在工作区、原文一字不改**，只是不进提交。

**需用户决策**：是否作为归档材料随仓库一并提交。若决定纳入，需把这 10 行追加到 `phase5-git-add-paths.txt` 并重新核对；本轮**不擅自纳入**。

---

## 5.5 提交范围检查（§9.4）

### 禁止项（均未使用）

| 命令 | 状态 |
|---|---|
| `git add .` | ❌ 未使用 |
| `git add -A` | ❌ 未使用 |
| `git add docs/`（目录级笼统纳入） | ❌ 未使用 |
| `git commit` / `push` / `tag` / `fetch` / `pull` / `reset` / `clean` | ❌ 全部未执行 |

### 精确路径级提交命令建议（**本轮不执行**）

本机 `git version 2.55.0.windows.3`，支持 `--pathspec-from-file`。因清单含 `platforms/vercel/api/[[...route]].js`（`[` 为 pathspec 通配字符）与中文/空格路径，建议使用字面路径解析：

```bash
GIT_LITERAL_PATHSPECS=1 git add --pathspec-from-file=docs/audit/v1.1.0-final/evidence/phase5-git-add-paths.txt
```

等价的显式形式（121 个双引号包裹的字面路径，过长故不在正文展开）：

```bash
git add "src/worker.js" "schema.sql" "platforms/vercel/api/[[...route]].js" ... # 共 121 项，见路径集文件
```

**前置检查（执行前必做）**：
1. `git status --porcelain --untracked-files=all` 复核与清单一致；
2. `wc -l phase5-git-add-paths.txt` 应为最终清单行数（阶段9 刷新后为准）；
3. 确认 10 份 D2 底稿的用户决策已落地；
4. `git diff --cached --stat` 复核暂存内容与清单逐项一致，**不含 runtime/**、不含 2 个排除文件、不含未分类文件。

### 当前状态

| 项 | 值 |
|---|---|
| staged 文件 | **0** |
| 已 commit | **否** |
| 已 push | **否** |
| 已 tag | **否** |
| 已部署 | **否** |

---

## 5.6 提交清单敏感性与扩展名核对（§8/§9 前置）

对 118 条（采集时点）提交路径做文件名敏感模式扫描（`\.env` / `\.pem` / `\.key` / `credential` / `secret` / `token.json` / `*.db` / `*.db-wal` / `*.db-shm` / `*.log` / `C:\Users` / `Administrator` / `cdp-` / `runtime/`）：

**命中 0**。扩展名分布：`.md` 68、`.js` 12、`.mjs` 8、`.sql` 7、`.png` 14、`.txt` 2、`.json` 1、`.yaml` 1、`.sh` 1、`.example` 1、无扩展名 2。
14 张 `.png` 全部为 `docs/audit/v1.1.0-RC1/screenshots/` 的 **UI 溢出验收证据**（非本地实验截图），有长期可审查价值，属 D1。

> 含个人账户 ID/邮箱的 `wrangler-account.json` 位于被忽略的 `runtime/backup/`，**不在提交清单内**。

---

## 5.7 与 RC2 发布候选清单的差异

| 项 | RC2 | 本轮 | 原因 |
|---|---|---|---|
| 工作区规模 | 52 modified + 2917 untracked | 53 modified + 77 untracked（展开） | `runtime/` 2857 条已被 `/runtime/` 规则忽略；+1 为 `.gitignore` |
| 清单性质 | "建议纳入"的粗粒度目录（A–J 分类） | **逐文件路径级**（133 行 7 列属性表 + 121 行精确 add 路径集） | 任务书 §9「不允许根据文件名批量纳入」 |
| 审计材料 | 一律"可选随附" | 拆为 D1（43，纳入）/ D2（10，需确认）/ E（2，排除） | 逐项判断，不自动纳入 |
| Release Notes | 无 | `docs/releases/v1.1.0.md` 纳入 C 类 | 阶段4 新建 |
| 证据文件 | 无 | `v1.1.0-final/evidence/*` 纳入 D1 | 阶段2/3/5 原始证据 |

---

## 5.8 清单刷新约定

本清单为**阶段5 时点快照**。阶段6/7/9 还会新增：
`phase6-version-generation.md`、`phase7-regression.md`、最终闭环报告、以及可能补充的证据附件。

**阶段9 完成后将重新运行同一分类逻辑刷新**：
- `evidence/phase5-file-inventory.tsv`（7 列）
- `evidence/phase5-git-add-paths.txt`（最终精确路径集）
- 本报告 §5.4 清单 1 的 `v1.1.0-final/` 分组与统计数字

最终提交清单以**阶段9 刷新后的路径集**为准。在此之前，任何 `git add` 都不得执行。
