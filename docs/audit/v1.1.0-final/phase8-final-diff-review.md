# SMSToWeb v1.1.0 · 阶段8：最终提交前 Git 变更集审查

> 执行时间：2026-11-10 16:35–16:45 (GMT+8)
> 结论：变更集**无意外删除、无真实凭据泄露、无本地数据库、无实验日志、无重复生成文件、无无关修改、无未分类文件**。
> ⚠️ 如实登记：内容级扫描发现 **8 处历史审计报告含本机个人路径**（非凭据）与 **1 处测试哑值**；RC2 报告"无个人路径混入"的声明不准确，按归档纪律保留原文并登记。

---

## 8.1 Git 变更集实际状态

| 命令 | 结果 |
|---|---|
| `git branch --show-current` | `main` |
| `git rev-parse HEAD` | `7e8fa8d1f5c1e575018e8d5ceb37d32f98773c5c`（**未变**） |
| `git status --short`（折叠） | 53 个 ` M` + 8 个 `??` 目录/文件条目 |
| `git status --porcelain -uall`（展开） | 53 tracked modified + 77+ 本轮新增 untracked |
| `git diff --stat` | **53 files changed, 1604 insertions(+), 304 deletions(-)** |
| `git diff --name-status` | **53 × M**；`D`（删除）= **0**、`A` = 0、`R` = 0 |
| `git diff --check` | **退出 0**（无空白错误） |
| `git diff --cached --stat` / `--name-only` | **空 / 0**（无意外 staged 文件） |
| `git ls-files \| wc -l` | 168 个已跟踪文件 |
| `git ls-files -- runtime/` | **0** |
| `git ls-files \| grep -icE '\.(db\|env\|pem\|key)$'` | **0** |
| `git check-ignore -v` 代表文件 | 3 个均命中 `.gitignore:12:/runtime/` |

> 已知提示：`git` 反复输出 `in the working copy of 'platforms/gen_app.py', CRLF will be replaced by LF the next time Git touches it`（`git check-attr` = `text: auto`）。**阶段0 即存在、非本轮引入**，`git diff --check` 退出 0，登记备查，不做行尾批量转换（避免全量格式化 / 覆盖历史改动）。

---

## 8.2 逐项排查结果（§8 重点清单）

| 排查项 | 结果 | 证据 |
|---|---|---|
| 是否存在意外删除 | ✅ **0 删除** | `git diff --name-status` 全为 M；`runtime/` 2907 文件物理完整（阶段1 验收） |
| 是否存在密钥、令牌、凭据 | ✅ **真实凭据 0** | 见 §8.3 内容级扫描与命中分类 |
| 是否存在本地数据库 | ✅ **0** | 提交清单内 `.db/.db-wal/.db-shm/.db-journal` = 0；`git ls-files` 同类 = 0；`runtime/` 已忽略 |
| 是否存在实验截图和临时日志 | ✅ **0 实验截图 / 0 日志** | 14 张 `.png` **全部**位于 `docs/audit/v1.1.0-RC1/screenshots/`（UI 溢出验收证据，非本地 CDP 截图）；`.log` = 0 |
| 是否存在重复生成文件 | ✅ **0 组完全重复** | 对 `v1.1.0-final/evidence/*` 12 个文件做 SHA256 分组，无重复组；`node-smoke-last-run.json` 已排除（与 output 仅差末尾换行 1 字节） |
| 是否存在与版本目标无关的修改 | ✅ **无** | 见 §8.4 本轮改动范围 |
| 是否存在未分类文件 | ✅ **0** | 阶段5 分类 F = 0；所有清单外文件有明确处理方式（§8.5） |
| 生成文件与源码不一致 | ✅ **无漂移** | 阶段6：CF≡src、5×app.js≡shared、4×db.js≡shared db.js、node/db.js 有意独立 |
| 发布说明中的过度承诺 | ✅ **无** | 阶段4 自检 + 阶段7 复核；唯一"已上线"命中为否定句「不声称 v1.1.0 已上线、已验证或已发布」 |
| 当前事实性文档错误 | ✅ **0** | 阶段3：17 个 Sync-notice 全统一、剩余 `v1.0.4` 全为历史标注；阶段7 重搜一致 |

---

## 8.3 内容级凭据扫描与 9 个命中的逐项分类

扫描对象：正式提交清单 **121 个文件全文**（UTF-8 可读）+ `git diff --unified=0` 的 **1604 行新增内容**。
模式：PEM 私钥块、`ghp_/gho_/github_pat_`、`xox[baprs]-`、`AKIA…`、`AIza…`、`sk-…`、显式 `password/secret/auth_token/api_key/private_key` 赋值、本机个人路径、`.env` 文件。

| 结果 | 数量 |
|---|---|
| `git diff` 新增行敏感命中 | **0** |
| `.env` 文件（文件名） | **0** |
| PEM / GitHub / Slack / AWS / Google / OpenAI 令牌 | **0** |
| 提交清单全文命中 | **9**（全部可解释，见下） |

### 命中分类表

| # | 文件:行 | 模式 | 分类 | 处理结论 |
|---|---|---|---|---|
| 1 | `docs/audit/P1-最终补证与发布门禁报告.md:6` | 个人路径 | **历史报告原文**（仓库外证据归档路径 `C:\Users\<用户名>\WorkBuddy\…\P1-fix\raw\`） | 保留，见 §8.3.1 |
| 2 | `docs/audit/P1-鉴权与后台通知可靠性闭环报告.md:6` | 个人路径 | 同上 | 保留 |
| 3 | `docs/audit/v1.1.0-RC1-发布候选验收报告.md:5` | 个人路径 | 同上 | 保留 |
| 4 | `docs/audit/v1.1.0-RC1-发布候选验收报告.md:263` | 个人路径 | 同上（证据路径说明） | 保留 |
| 5 | `docs/audit/v1.1.0-RC1-补充验收报告.md:238` | 个人路径 | 同上 | 保留 |
| 6 | `docs/audit/v1.1.0-RC1/README.md:16` | 个人路径 | 同上（`RC1-raw\`） | 保留 |
| 7 | `docs/audit/v1.1.0-RC2-发布候选文件清单.md:51` | 个人路径 | **否定句**：「无 `C:/Users/<用户名>` 个人路径混入」 | 保留（见 §8.3.1 不准确声明） |
| 8 | `docs/audit/v1.1.0-RC2/phase7-security.md:16` | 个人路径 | **否定句**：「无个人路径（`C:/Users/<用户名>`）」 | 保留 |
| 9 | `docs/audit/v1.1.0-final/evidence/node-smoke.mjs:158` | `SECRET_ASSIGNMENT` | **测试哑值**：`password: "definitely-wrong-smoke-value"`（故意错误密码，用于验证 403 拒绝） | 非凭据，保留；脚本中所有凭据均为运行时随机生成，不写入配置 |

**判定：真实密钥/令牌/凭据 = 0。** 文档中出现的 `RECEIVE_TOKEN`、`ADMIN_PASSWORD`、`SESSION_SECRET` 等均为**环境变量名**（正常文档内容），非其值。

### 8.3.1 关于历史报告中的个人路径（诚实登记）

- 第 1–6 项是 RC1 / P1 历史报告中引用**本机仓库外证据归档目录**的路径，**不是密钥、不是令牌、不含任何凭据值**；属于个人工作区路径。
- 按 §3.2「不得删除历史审计报告」与 §7.2 A「不应篡改历史记录」，**本轮一字未改**。
- ⚠️ **发现 RC2 的不准确声明**：`v1.1.0-RC2-发布候选文件清单.md:51` 与 `phase7-security.md:16` 声称"无个人路径混入"，但本轮用**反斜杠形式** `C:\Users\<用户名>` 扫描确有命中（RC2 当时大概率只匹配了正斜杠 `C:/Users/…` 形式而漏检）。这是历史报告的表述不精确，**按归档纪律保留原文**，在此如实登记，不追改历史。
- **风险定性**：非阻断（不含凭据，公开仓库暴露本机用户名/工作区目录名，属整洁度/隐私偏好问题）。
- **若审核方要求"公开仓库零个人路径"**：需另开**独立批准批次**修订这 6 份历史报告（并同步修正 RC2 两份不准确声明），或把这 8 份含路径的报告改列为"不随仓库提交"。本轮**不擅自修改、不擅自排除**。

---

## 8.4 本轮改动范围（确认无无关修改）

按 mtime（≥ 2026-11-10 15:00）区分 53 个 tracked modified：

| 类别 | 数量 | 文件 |
|---|---|---|
| **本轮实际修改** | **19** | `.gitignore`；`docs/UPGRADE.md`；17 个 i18n 镜像（`docs/i18n/{de,en,es,fr,ja,ko,pt-BR}/{ARCHITECTURE,README}.md`、`zh-CN/README.md`、`zh-TW/{ARCHITECTURE,README}.md`） |
| **纯历史改动**（本轮未动） | **34** | 其余源码 / 平台入口 / DDL / 生成器 / 测试 / README / docs 主版 |

19 个本轮修改全部直接服务于 v1.1.0 目标（Git 忽略闭环、发布说明入口、i18n 当前事实修正）。34 个历史改动为 RC1/RC2 累积的有效工作树修订，按 §9.2 全部保护、全部纳入提交清单。**未发现任何与版本目标无关的修改**。

`git diff --numstat` 对本轮改动区域（`.gitignore`、`docs/UPGRADE.md`、`docs/i18n/`）累计 added 154 / deleted 13（含历史编辑），**无大段删除、无二进制文件**。

---

## 8.5 清单外未跟踪文件的处理方式（逐类明确）

| 类别 | 数量 | 处理方式 | 是否会误入提交 |
|---|---|---|---|
| `runtime/`（2907 文件 / 875MB） | 2907 | 阶段1 `/runtime/` 规则忽略；零删除、零移动 | ❌ 已被忽略 |
| 10 份 D2 历史审计底稿 | 10 | **需用户确认**，默认不纳入；保留原文不删除 | ❌ 不在路径集 |
| 2 份 E 类（重复留存副本、空 stderr） | 2 | 明确排除，保留在工作区 | ❌ 不在路径集 |
| 阶段6/7/8/9 新落盘报告与证据 | 若干 | **阶段9 刷新清单**时纳入 D1 | ✅ 刷新后纳入 |
| `platforms/__pycache__/*.pyc` | 1 | 既有 `*.pyc` 规则忽略 | ❌ 已忽略 |
| OS 临时目录 `smstoweb-v110-smoke-*` | 2 个临时库 | 位于系统 temp，不在仓库内 | ❌ 不在仓库 |

> **不使用 `git add .` / `-A`**；提交必须走 `GIT_LITERAL_PATHSPECS=1 git add --pathspec-from-file=<最终路径集>`。

---

## 8.6 阶段8结论

| 项 | 结果 |
|---|---|
| 正式提交清单每个文件可解释 | ✅ 121 项均有分类/状态/原因/验证证据（TSV 附件 7 列） |
| 清单外每个未跟踪文件有明确处理 | ✅ 见 §8.5，无未分类文件 |
| 意外删除 / staged / 生成漂移 / 无关修改 | ✅ 全部 0 |
| 真实凭据泄露 | ✅ 0（9 个命中均为历史个人路径或测试哑值，已逐项分类） |
| 历史工作区改动完整保留 | ✅ 53 个 tracked modified 一个未丢，`runtime/` 零删除 |
| 无 commit / push / tag / deploy | ✅ HEAD `7e8fa8d1…`、staged 0 |

**遗留登记（非阻断）**：8 处历史报告中的本机个人路径 + RC2 两份"无个人路径"不准确声明；若要求清理，需独立批准批次。该事项连同 `platforms/node/package.json` 的 `1.0.3` 与 m1-lifecycle 环境要求，一并进入阶段9 §剩余风险。
