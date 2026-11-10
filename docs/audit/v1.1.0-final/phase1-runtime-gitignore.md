# SMSToWeb v1.1.0 · 阶段1：彻底解决 runtime/ Git 忽略问题

> 执行时间：2026-11-10 15:41–15:47 (GMT+8)
> 结论：**闭环完成**。新增 1 条根目录限定规则 `/runtime/`，零删除、零误伤、零 tracked 文件被隐藏。

---

## 1.1 变更前的实际结构

### `.gitignore` 原文（72 字节，mtime 2026-10-17）

```
node_modules/
.wrangler/
.dev.vars
__pycache__/
*.pyc
*.log
.workbuddy/
```

**无任何 `runtime` / `*.db` / `backup` / `bench` 规则**。仅 `*.log` 隐式忽略了 runtime 下 48 个日志文件；`git check-ignore -v runtime/bench` 返回空（NOT ignored）。`git status --short` 将整个目录折叠为 `?? runtime/` 一条，掩盖了 2857 个待跟踪文件。

### runtime/ 物理结构

| 项 | 值 |
|---|---|
| 物理文件总数 | **2907** |
| 磁盘占用 | **875 MB** |
| 被 Git 跟踪 | **0**（`git ls-files runtime/` = 空） |
| `git status -uall -- runtime/` | 2857 条（其余 50 条被既有 `*.log`/`*.pyc` 等规则排除） |

| 子目录 / 位置 | 文件数 | 内容判定 |
|---|---|---|
| `runtime/bench/` | 2784 | 性能基准库 `bench-*.db` / `.db-wal` / `.db-shm` / `.v3.bak`、`cdp-*.png` 截图、**Edge 浏览器 profile 缓存**（`edge-profile-320/768/1440/...`）、`baseline.mjs` 等本地脚本 |
| `runtime/backup/` | 69 | 两个时点快照 `20261109-145441-before-perf/`、`20261109-152407-before-statsfix/`，内含 `platforms__*.js`、`src__worker.js`、`schema.sql` 等**改名前备份副本** |
| `runtime/sms_ui_security/` | 51 | 安全实验产物：`cdp-i18n.mjs`、`cdp-msglist.mjs`、`cdp-paging.mjs`、`baseline.md`、截图 |
| `runtime/` 根级 | 3 | `ui-v2.db` (4 KB)、`ui-v2.db-shm` (32 KB)、`ui-v2.db-wal` (482 KB) —— 本地 SQLite 实验库 |

### "看起来像正式源码"文件的归属核查

runtime 内共 **1105** 个 `.js/.mjs/.py/.sql/.md/.json/.html/.css/.toml/.yaml` 文件，按子目录分组：

| 子目录 | 数量 | 判定 |
|---|---|---|
| `backup` | 65 | 历史备份副本（**非项目正式源码**） |
| `bench` | 1025 | Edge 浏览器 profile 的 `*.json` / `*.js` 缓存 + 基准脚本 |
| `sms_ui_security` | 15 | 本地安全/CDP 实验脚本与记录 |

逐一确认**项目正式文件均在仓库原位存在**（不依赖 runtime 内的副本）：

| 正式路径 | 状态 |
|---|---|
| `src/worker.js` | EXISTS |
| `platforms/gen_app.py` | EXISTS |
| `platforms/node/db.js` | EXISTS |
| `platforms/node/server.mjs` | EXISTS |
| `schema.sql` | EXISTS |
| `README.md` | EXISTS |
| `tests/run.mjs` | EXISTS |

### ⚠️ 隐私 / 凭据风险（本轮新发现，必须登记）

`runtime/backup/20261109-152407-before-statsfix/platforms/cloudflare/.wrangler/cache/wrangler-account.json` 实际内容：

```json
{ "account": { "id": "<32 位账户 ID 已脱敏>", "name": "<个人邮箱已脱敏>'s Account" } }
```

含 **Cloudflare 账户 ID 与个人邮箱**。另有 23 个名称命中 `*token*/*secret*/*credential*/wrangler-account.json` 的文件，多为 Edge profile 的 `Trust Tokens`、`Vpn Tokens`、`Edge Wallet` 缓存（浏览器本地数据，非项目密钥，但同样不应入库）。

> 这说明 `runtime/` 的忽略不仅是"减小提交体积"，更是**防止个人身份信息进入公开仓库 GitHub `ShenDoyle/SMSToWeb`** 的必要措施。RC2 报告仅登记了"误提交风险"，本轮补充了隐私维度。

**结论**：`runtime/` 内**不存在必须纳入 Git 的正式源码、配置或测试文件**，全部为本地运行数据 / 性能基准 / 备份 / UI 实验 / 安全实验 / 浏览器 profile 缓存。因此可以安全地忽略整个根目录。

---

## 1.2 采用的规则（最小、根限定）

在 `.gitignore` 末尾追加：

```gitignore
# 本地运行/基准/备份/安全实验产物（含本地 SQLite 库与浏览器 profile 缓存）。
# 该目录从未被 Git 跟踪（git ls-files runtime/ 为空），且内含个人账户标识等
# 不应入库的数据；使用根目录限定规则，避免影响其他位置的同名目录。
/runtime/
```

选择依据：
- **`/runtime/` 带前导 `/`**：仅匹配仓库根的 `runtime/`，不会误伤 `platforms/*/runtime/` 或未来其他同名子目录，符合任务书"优先采用明确的根目录限定规则"。
- **未采用** `*.db` / `*.db-wal` / `*.db-shm` / `backup/` / `bench/` 等宽泛规则：这些会误伤仓库其他位置（含 `docs/` 下的合法示例与未来正式资源），且与"最小忽略规则"相悖。
- **未删除、未移动、未清理任何 runtime 文件**；既有 7 条规则一字未改。

---

## 1.3 验收证据（全部实际执行）

### ① `git check-ignore -v` 代表性文件

```
.gitignore:12:/runtime/	runtime/ui-v2.db
.gitignore:12:/runtime/	runtime/ui-v2.db-wal
.gitignore:12:/runtime/	runtime/backup/20261109-145441-before-perf/README.md
.gitignore:12:/runtime/	runtime/bench/bench-100.db
.gitignore:12:/runtime/	runtime/sms_ui_security/cdp-i18n.mjs
.gitignore:12:/runtime/	runtime/backup/20261109-152407-before-statsfix/platforms/cloudflare/.wrangler/cache/wrangler-account.json
```

覆盖：根级 SQLite 库 + WAL、备份副本、基准库、安全实验脚本、含个人账户信息的缓存文件 —— 全部命中新规则。

### ② 全部 runtime 文件均被忽略（两条独立命令均为 0）

| 命令 | 输出行数 |
|---|---|
| `git status --porcelain --untracked-files=all -- runtime/` | **0** |
| `git ls-files --others --exclude-standard -- runtime/` | **0** |

### ③ 无已跟踪文件被新规则隐藏

`git ls-files -- runtime/` = **0**。规则生效前后均为 0，不存在"因忽略规则而看不见的已跟踪文件"，无需强制移除跟踪。

### ④ 无误伤正式文件

对 9 个代表性正式路径执行 `git check-ignore -v`，**全部返回"未被忽略"**：

`src/worker.js`、`schema.sql`、`README.md`、`tests/run.mjs`、`platforms/node/db.js`、`platforms/gen_app.py`、`docs/guide/README.md`、`docs/audit/v1.1.0-RC2/phase0-baseline.md`、`.gitignore`

另以完整 `git status` 集合核对：规则生效后 untracked 由 **2922 → 67**（67 = 原有 65 个非 runtime 未跟踪文件 + 本轮阶段0 的 2 个 `v1.1.0-final/` 交付物），减少的 2855 行**全部为 runtime 路径**，非 runtime 文件集合未减少。

### ⑤ `git status` 不再出现 runtime

| 指标 | 变更前 | 变更后 |
|---|---|---|
| untracked（展开口径） | 2922 | **67** |
| `status` 中含 `runtime/` 的行 | 2857 | **0** |
| tracked modified | 52 | **53**（+1 即 `.gitignore` 本身） |
| staged | 0 | 0 |

`git status --short` 现在只剩 8 条折叠条目，`runtime/` 已消失。

### ⑥ 零删除证明

| 指标 | 变更前 | 变更后 |
|---|---|---|
| `find runtime -type f` | 2907 | **2907** |
| `du -sh runtime` | 875M | **875M** |

**未删除、未移动、未清理任何 runtime 文件**，完全符合 §3.2 与 §3.3。

---

## 1.4 验收清单

| 验收项 | 结果 |
|---|---|
| 所有应忽略的 runtime 本地文件均被忽略 | ✅ 两条独立命令均返回 0 |
| 不存在误忽略正式文件 | ✅ 9 个代表路径 + 全集合核对通过 |
| 不存在意外删除 | ✅ 2907 文件 / 875MB 完全不变 |
| `git check-ignore` 证据完整 | ✅ 6 类代表文件均记录规则行号 `:12:/runtime/` |
| `git ls-files` 结果经过检查 | ✅ 0 个已跟踪文件，规则生效前后一致 |

## 1.5 对后续阶段的影响

- 阶段5/8 的正式提交清单不再需要逐条排除 2857 个 runtime 路径，但**仍须在报告中显式声明排除**，且提交命令不得使用 `git add .` / `-A`。
- `.gitignore` 成为本轮**唯一新增的 tracked 修改**（53 = 52 + 1），属于正式提交范围。
- 隐私发现需在阶段8 凭据扫描中再次确认：个人账户信息仅存在于被忽略的 `runtime/` 内，正式提交清单中不含此类文件。
