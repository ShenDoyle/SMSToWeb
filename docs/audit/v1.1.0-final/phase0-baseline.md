# SMSToWeb v1.1.0 · 正式版提交前最终闭环 · 阶段0：完整基线重建

> 采集时间：2026-11-10 15:07–15:41 (GMT+8)
> 采集方式：**只读**（`git status` / `git diff` / `git ls-files` / `find` / `sha256sum` / `grep`）。
> 本阶段唯一写入为阶段0交付物本身（`docs/audit/v1.1.0-final/` 下的基线报告与清单附件），**未修改任何项目文件、未执行任何 git 写操作**。

---

## 0.1 Git 与版本基线

| 项 | 实际值 | 采集命令 |
|---|---|---|
| 分支 | `main` | `git branch --show-current` |
| HEAD | `7e8fa8d1f5c1e575018e8d5ceb37d32f98773c5c` | `git rev-parse HEAD` |
| APP_VERSION | `v1.1.0` | `src/worker.js:73` `const APP_VERSION = "v1.1.0";` |
| 已暂存（staged） | **0** | `git diff --cached --stat` = 空 |
| 已提交增量 | 无（HEAD 与 RC2 结束时一致） | `git rev-parse HEAD` |
| `git diff --stat` | **52 files changed, 1597 insertions(+), 303 deletions(-)** | `git diff --stat` |

**与任务书基线一致性核对**：分支 `main`、HEAD `7e8fa8d1…`、`src/worker.js` 已为 `v1.1.0` —— 三项均与任务书 §二 一致，基线有效，未发生提交或分支切换。

⚠️ 采集过程中 git 输出一条提示：`in the working copy of 'platforms/gen_app.py', CRLF will be replaced by LF the next time Git touches it`（`git check-attr` 结果为 `text: auto`）。这是既有行尾归一化提示，**非本轮引入**，登记备查，阶段8再确认不影响 diff 内容。

---

## 0.2 工作区文件数量（两种口径必须区分）

| 口径 | 命令 | 结果 |
|---|---|---|
| **折叠口径**（目录算 1 条） | `git status --short` | `??` **8 条** + ` M` 52 条 = 60 行 |
| **展开口径**（逐文件） | `git status --porcelain --untracked-files=all` | `??` **2922 个文件** + ` M` **52 个文件** = 2974 行 |

任务书 §二 记录的 RC2 "2917 untracked" 属**展开口径**（`-uall`），与本报告口径一致，可直接比较。
若只看 `git status --short` 的 8 条，会严重低估未跟踪文件规模——**这是本轮最容易出错的口径陷阱**，阶段5/8 一律采用展开口径。

### 状态分类明细（展开口径）

| 状态 | 数量 |
|---|---|
| tracked modified (` M`) | 52 |
| staged modified (`M `) | 0 |
| added (`A `) | 0 |
| deleted (` D`) | 0 |
| renamed (`R `) | 0 |
| untracked (`??`) | 2922 |
| **合计** | **2974** |

### 8 条折叠未跟踪条目（对应 2922 个文件）

| 折叠条目 | 说明 |
|---|---|
| `?? docs/audit/` | RC1/RC2 审计报告、证据截图、历史底稿（均未被跟踪） |
| `?? docs/deploy-templates/` | 3 个部署模板 |
| `?? docs/guide/` | 用户指南 README + 01–10 |
| `?? docs/i18n/en/QUICKSTART.md` | 新增翻译镜像 |
| `?? platforms/node/lifecycle.mjs` | Node 生命周期模块 |
| `?? runtime/` | **本地实验目录（2907 文件 / 875 MB）** |
| `?? tests/m1-lifecycle.mjs` | 新增测试 |
| `?? tests/p1-auth.mjs` | 新增测试 |

展开后顶层分组：`runtime/` 2857 条被 `git status` 列为未跟踪（另有 50 条因既有 `*.log` / `*.pyc` 规则已被隐式忽略），非 runtime 未跟踪 **65 条**，合计 2922。

---

## 0.3 runtime/ 实际结构

| 项 | 值 |
|---|---|
| 物理文件总数（`find runtime -type f`） | **2907** |
| 目录总大小（`du -sh runtime`） | **875 MB** |
| 被 git 跟踪的文件（`git ls-files runtime/`） | **0** |
| `git status --porcelain runtime/` | 1 条（目录折叠） |

| 子目录 | 文件数 | 用途判断（待阶段1逐类核实） |
|---|---|---|
| `runtime/bench/` | 2784 | 性能基准库 `*.db`、`cdp-*.png` 截图、Edge 性能剖面 —— 本地实验 |
| `runtime/backup/` | 69 | 本地备份 |
| `runtime/sms_ui_security/` | 51 | 安全测试产物 |
| `runtime/` 根级文件 | 3 | `ui-v2.db` 及 `-wal` / `-shm` 伴随文件 |

⚠️ **既有 `.gitignore` 已隐式忽略 runtime 下 48 个 `*.log`**（规则 `*.log`），但目录主体未被覆盖；`git check-ignore -v runtime/bench` 返回空（NOT ignored）。这是阶段1必须闭环的风险。

### 当前 `.gitignore` 全文（72 字节，mtime 2026-10-17）

```
node_modules/
.wrangler/
.dev.vars
__pycache__/
*.pyc
*.log
.workbuddy/
```

**确认：无任何 `runtime` / `*.db` / `backup` / `bench` 规则**，与 RC2 阶段5 报告 §⚠️ 的发现一致。

---

## 0.4 六平台生成文件当前哈希（SHA256）

| 文件 | SHA256 | 说明 |
|---|---|---|
| `src/worker.js` | `083d8e68b56babf2e87aca50a63105a0224963dfcf113798d8a95970658ccdcf` | 唯一版本定义源 |
| `platforms/shared/app.js` | `cfcff639d3cd7893640fa700c654305f00504b2e31f2b74609771b6640874785` | 共享生成副本 |
| `platforms/vercel/app.js` | `cfcff639…4785` | 五平台副本 |
| `platforms/deno/app.js` | `cfcff639…4785` | 五平台副本 |
| `platforms/netlify/app.js` | `cfcff639…4785` | 五平台副本 |
| `platforms/edgeone/app.js` | `cfcff639…4785` | 五平台副本 |
| `platforms/node/app.js` | `cfcff639…4785` | 五平台副本 |
| `platforms/cloudflare/app.js` | **不存在** | Cloudflare 采用单文件 `worker.js`，非异常 |
| `platforms/cloudflare/worker.js` | `083d8e68…dccf` | 与 `src/worker.js` **逐字节一致** |
| `platforms/node/db.js` | `388cd2e9ec004606478a42ba4424857e96a80678d47ec5248cccb6a5f289855d` | Node SQLite 适配器，**有意差异** |

结论：5 平台 `app.js` ≡ `shared/app.js`，Cloudflare `worker.js` ≡ `src/worker.js`，与 RC2 阶段4 记录一致，**当前无生成漂移**。阶段6 将用 `gen --check` 与独立重生成再验一次。

---

## 0.5 RC2 交付物存在性

| 文件 | 存在 | mtime |
|---|---|---|
| `docs/audit/v1.1.0-RC2/phase0-baseline.md` | ✅ | 13:15 |
| `docs/audit/v1.1.0-RC2/phase2-version-inventory.md` | ✅ | 13:49 |
| `docs/audit/v1.1.0-RC2/phase4-generation-consistency.md` | ✅ | 13:51 |
| `docs/audit/v1.1.0-RC2/phase6-regression.md` | ✅ | 13:59 |
| `docs/audit/v1.1.0-RC2/phase7-security.md` | ✅ | 14:00 |
| `docs/audit/v1.1.0-RC2/phase8-not-tested.md` | ✅ | 14:01 |
| `docs/audit/v1.1.0-RC2-发布候选文件清单.md` | ✅ | 13:56 |
| `docs/audit/v1.1.0-RC2-发布候选整理报告.md` | ✅ | 14:03 |

**RC1 材料亦完整保留**（`docs/audit/v1.1.0-RC1/`、`v1.1.0-RC1-补充/`、`v1.1.0-RC1-*.md`、10 份历史底稿、`screenshots/` 截图），全部未被跟踪，按 §3.3 保护，不删除、不覆盖。

---

## 0.6 与 RC2 基线的差异（文件集合级核对）

任务书要求：**不能仅凭数量相同就认定文件集合没有变化**，且需解释历史 2914 → 2917 的变化。

### 差异事实

| 时点 | 展开口径 untracked | 来源 |
|---|---|---|
| RC2 阶段0 | 2914 | `v1.1.0-RC2/phase0-baseline.md` |
| RC2 阶段5 | **2917** | `v1.1.0-RC2-发布候选文件清单.md` §9.1（含自述"较阶段0增加 3"） |
| **本轮阶段0（当前）** | **2922** | 本次实测 |

两次差值合计 **+8**，均为 RC2 周期内审计附件落盘，**无源码/配置增删**：

**① 2914 → 2917（+3，RC2 阶段0→阶段5）**，RC2 报告自述 + mtime 交叉验证：

| # | 新增路径 | mtime |
|---|---|---|
| 1 | `docs/audit/v1.1.0-RC2/phase0-baseline.md` | 13:15 |
| 2 | `docs/audit/v1.1.0-RC2/phase2-version-inventory.md` | 13:49 |
| 3 | `docs/audit/v1.1.0-RC2/phase4-generation-consistency.md` | 13:51 |

**② 2917 → 2922（+5，RC2 阶段5 统计之后）**：RC2 阶段5 的 2917 是在写清单文件**之前**采集，此后依次落盘 5 个文件（mtime 全部晚于 13:56:29）：

| # | 新增路径 | mtime |
|---|---|---|
| 1 | `docs/audit/v1.1.0-RC2-发布候选文件清单.md` | 13:56 |
| 2 | `docs/audit/v1.1.0-RC2/phase6-regression.md` | 13:59 |
| 3 | `docs/audit/v1.1.0-RC2/phase7-security.md` | 14:00 |
| 4 | `docs/audit/v1.1.0-RC2/phase8-not-tested.md` | 14:01 |
| 5 | `docs/audit/v1.1.0-RC2-发布候选整理报告.md` | 14:03 |

> 同期另有 `platforms/__pycache__/gen_app.cpython-313.pyc`（13:57）生成，但被既有 `*.pyc` 规则忽略，**不计入 untracked**，因此不影响差值。

### 集合级核对的诚实边界

- RC2 **未保存完整的逐路径清单附件**（仅报告中的数量与分类），因此无法做严格 `diff` 意义上的两个集合相减。
- 本报告采用的可复核替代方案：① 固化**当前完整 2922 路径集合**为附件 `phase0-untracked-files.txt`；② 用文件 mtime 与 RC2 报告自述交叉定位新增路径；③ 核对 `runtime/` 物理文件数（2907）与 RC2 记录的 2857 之差来自 `*.log` 等既有忽略规则造成的计数口径，而非文件被删。
- **核实结论**：RC2 → 当前，**未发现任何路径消失、改名或历史文件被删除**；差异全部为审计附件新增。`runtime/` 目录结构（bench/backup/sms_ui_security/ui-v2.db）与 RC2 记录一致，文件数由 2857 → 2907 属统计口径差（`git status -uall` 计数 2857 vs `find -type f` 计数 2907，差额为已被 `*.log`/`*.pyc`/`*.db?` 等既有规则排除的文件），非本轮新增实验产物。

---

## 0.7 需要保护的历史未提交工作（§3.3 保护清单）

| 类别 | 数量 | 说明 |
|---|---|---|
| tracked modified（52） | 52 | RC1/RC2 累积的有效修订：源码、六平台入口/DDL、生成器、测试、README、docs 主版、i18n 主版与各语言 ARCHITECTURE/README。**一个都不能丢弃或覆盖** |
| 非 runtime 未跟踪（65） | 65 | RC1/RC2 审计报告与截图、`docs/guide/` 11 篇指南、3 个部署模板、`QUICKSTART.md`、4 个新增测试/生命周期模块 |
| runtime/ 本地文件（2907 / 875MB） | 2907 | 全部为未跟踪本地实验/基准/备份/安全产物，**禁止删除、移动、清理**；仅通过 `.gitignore` 规则使其不进入提交视野 |

完整逐路径清单见附件：**`docs/audit/v1.1.0-final/phase0-untracked-files.txt`**（2922 行，UTF-8 真实中文路径，以 `core.quotepath=false` 生成）。
> 附件自身是阶段0产出，在采集快照时点之后写入，故不计入 2922 基线；后续阶段计数须显式说明是否包含 `v1.1.0-final/` 交付物。

---

## 0.8 阶段0结论

- 基线有效：分支、HEAD、版本与目标一致，**无提交、无暂存、无分支切换、无删除**。
- 工作区实际规模：52 modified + 2922 untracked（展开口径），`runtime/` 2907 文件 / 875MB。
- `runtime/` **确实未被 Git 忽略**（0 tracked，但目录主体暴露在 untracked 中）→ 阶段1 硬性任务成立。
- 六平台生成文件当前无漂移，但**哈希一致 ≠ 真实运行通过**，阶段2 必须独立验证。
- RC1/RC2 历史材料完整，差异仅为审计附件新增，历史工作无损失。
- 未修改任何项目文件（阶段0 只读要求满足）。
