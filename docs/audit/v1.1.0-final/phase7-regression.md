# SMSToWeb v1.1.0 · 阶段7：本轮回归验证

> 执行时间：2026-11-10 16:20–16:35 (GMT+8)
> 原则：**报告本轮实际执行结果**，不引用 RC2 的 850/0、23/0 作为本轮结论；不删除失败测试、不降低断言、不修改测试预期。
> 结论：**全部测试在正确环境下通过**。唯一一次失败（`m1-lifecycle` 在 Windows 本机 13/19）经三重证据确认为**测试前置环境不满足**，非本轮回归；在规定的 Linux/WSL2 环境复跑取得 **32/0**。

---

## 7.1 命令、退出码、测试数量、结果（逐条）

| # | 命令 | 环境 | 退出码 | 数量 / 结果 |
|---|---|---|---|---|
| 1 | `node tests/run.mjs` | Windows / Node 22.22.2 | **0** | **850 通过 / 0 失败** |
| 2 | `node tests/p1-auth.mjs` | Windows / Node 22.22.2 | **0** | **23 通过 / 0 失败** |
| 3 | `node tests/m1-lifecycle.mjs` | Windows / Node 22.22.2 | **1** | **13 通过 / 19 失败**（环境前置不满足，见 §7.2） |
| 3b | `node tests/m1-lifecycle.mjs` | WSL2 系统 Node 18.19.1 | **2** | 异常退出：`node:sqlite` 不存在（Node < 22.13） |
| 3c | `/tmp/node22/bin/node tests/m1-lifecycle.mjs` | **WSL2 + 便携 Node 22.22.2（Linux 原生 SIGTERM）** | **0** | **32 通过 / 0 失败** ✅ 正式结论 |
| 4 | `python platforms/gen_app.py --check` | Windows / Python 3.13 | **0** | SCHEMA_SQL 一致 + SQL 引用校验通过；**只读无写盘**（阶段6 SHA 前后一致） |
| 5 | JS/MJS 语法检查（`node --check` / `--input-type=module --check`） | Windows / Node 22.22.2 | **0** | **25 文件 / 0 失败** |
| 6 | Git 忽略规则验证 | Windows | **0** | 见 §7.3 |
| 7 | 正式文件清单验证 | Windows | **0** | 121 路径全部存在、0 缺失、0 清单内路径不在 status |
| 8 | 版本一致性检查 | Windows | **0** | `APP_VERSION=v1.1.0`、CF≡src、5×app.js≡shared |
| 9 | 文档链接 / 过期事实 / 过度承诺检查 | Windows | **0** | 7 个相对链接 0 断链，见 §7.4 |
| 10 | `git diff --check` | Windows | **0** | 无空白错误 |

原始输出证据（均在 `docs/audit/v1.1.0-final/evidence/`）：
`phase7-run-mjs.txt`、`phase7-p1-auth.txt`、`phase7-m1-lifecycle.txt`（Windows 失败原文）、`phase7-m1-lifecycle-wsl22.txt`（WSL2 通过原文）、`phase7-gen-check.txt`。

---

## 7.2 `m1-lifecycle.mjs` 失败的三重定性（**不是回归**）

### 事实

`tests/m1-lifecycle.mjs` **文件头第 5–6 行明确写明运行前置条件**：

```
⚠ 必须在 Linux / WSL2 / Docker 容器内运行：本套件用真实 POSIX SIGTERM
  （child.kill("SIGTERM")）驱动停机，不用 process.emit("SIGTERM") 模拟。
```

C 组标题为「**真实 HTTP 服务 / 真实 SIGTERM / 真实 SQLite**」，每个用例都调用 `h.child.kill("SIGTERM")`。

### Windows 本机 13/19 的失败形态

| 组别 | 内容 | 结果 |
|---|---|---|
| A 组 | 四层时间预算推导（纯函数） | **5/5 通过** |
| B 组 | 真实登记机制状态机（纯内存） | **6/6 通过** |
| C 组 | 真实进程 + 真实 POSIX SIGTERM + 真实 SQLite | **2/21 通过，19 失败** |

19 项失败的观测值全部是 **`exit=null`、`delta=n/a`、`status=-1`、`bg_finished=null`、`registered=3 completed=0`** —— 即"子进程未按预期运行 / 信号未送达 / 停机日志缺失"，**没有任何一项是业务断言被推翻**。这与阶段2 已记录的「Windows 无原生 SIGTERM 投递，`child.kill()` 为强制终止，`process.on('SIGTERM')` 链路无法可靠验证」完全一致。

### 三次执行的交叉验证

| 环境 | Node | POSIX SIGTERM | `node:sqlite` | 结果 |
|---|---|---|---|---|
| Windows 本机 | 22.22.2 ✅ | ❌ 无 | ✅ | 13/19（C 组全败） |
| WSL2 系统 Node | 18.19.1 ❌ | ✅ | ❌ | 退出码 2，`db.js:451` `node:sqlite` 不可用 |
| **WSL2 + 便携 Node 22.22.2** | ✅ | ✅ | ✅ | **32/0，退出码 0** |

**复现方式（可复核，未改动任何项目文件）**：在 WSL2 `/tmp` 解压官方便携 `node-v22.22.2-linux-x64.tar.xz`（不安装到系统、不改 PATH、不写项目目录），于 `/mnt/d/OpenClaw/SMSToWeb` 下执行 `/tmp/node22/bin/node tests/m1-lifecycle.mjs`。该环境同时满足 Linux 原生 SIGTERM 与 Node 22.13+ 的 `node:sqlite`，正是测试文件要求的环境，也是 RC1「WSL2 Docker 真实取证 32/0」的等价条件（本轮本机 Docker 客户端仅在 WSL 内存在、Windows 侧不可用，故采用便携 Node 而非容器）。

### 排除"本轮引入回归"的证据

| 依据 | 说明 |
|---|---|
| 源码/生成产物 SHA 未变 | 阶段0 = 阶段6 = `src/worker.js 083d8e68…`、`shared/app.js cfcff639…`、`node/db.js 388cd2e9…` |
| 本轮未改任何核心源码、生成器、Schema、测试 | 本轮修改范围仅 `.gitignore`、文档（`.md`）、发布说明、审计附件 |
| `tests/m1-lifecycle.mjs` 未被修改 | untracked 原文件，本轮只读执行 |
| 同一测试在正确环境 32/0 | 证明逻辑、断言、实现均正常 |

**处置**：**未删除任何失败测试、未降低任何断言、未修改测试预期**；保留 Windows 失败原文作为诚实证据，并以正确环境结果作为正式回归结论。该失败**不计入回归缺陷**，但作为「测试环境要求」在阶段9 登记为非阻断限制与部署前注意事项。

---

## 7.3 受本轮改动影响部分的重新验证

| 本轮改动 | 重新验证动作 | 结果 |
|---|---|---|
| `.gitignore`（+`/runtime/`） | `git check-ignore -v` 3 个代表文件；`git status -uall -- runtime/`；`git ls-files --others --exclude-standard -- runtime/`；`git ls-files -- runtime/` | 全部命中 `.gitignore:12:/runtime/`；四项计数 **0 / 0 / 0 / 0** ✅ |
| 16 个 i18n 同步提示 + 5 处正文修订 | 阶段3 全仓事实扫描（`phase3-fact-scan.txt`）+ 本阶段重搜 | Sync-notice 含 `v1.0.4` = **0**；17 块统一；剩余 `v1.0.4` 全为历史标注 ✅ |
| `docs/releases/v1.1.0.md` 新建 | 版本/链接/路径检查 + 过度承诺自检 | 版本 v1.1.0；`NOT TESTED` 出现 13 次；唯一"已上线"命中为**否定句**「不声称 v1.1.0 已上线、已验证或已发布」 ✅ |
| `docs/UPGRADE.md` 修订（L3 + L4 链接） | 相对链接检查 | 链接目标存在 ✅ |
| 阶段0–6 审计报告 | 相对链接批处理 | 7 个相对链接 **0 断链** ✅ |
| 源码 / 生成文件（未改） | 完整 `run.mjs` 850/0、`p1-auth` 23/0、`m1-lifecycle` 32/0、`gen --check` 0、字节一致性 | 全绿 ✅ |
| 平台适配代码（未改） | 阶段2 Node 本地真实 HTTP 运行 + 5 平台 `app.js` 字节一致 | 通过（证据等级见阶段2） ✅ |

---

## 7.4 其余检查明细

### Git 忽略规则

```
.gitignore:12:/runtime/  runtime/ui-v2.db
.gitignore:12:/runtime/  runtime/bench/bench-100.db
.gitignore:12:/runtime/  runtime/backup/20261109-145441-before-perf/README.md
status --porcelain -uall -- runtime/           = 0
ls-files --others --exclude-standard -- runtime/ = 0
ls-files -- runtime/                            = 0
```

### 正式文件清单

| 检查 | 结果 |
|---|---|
| `phase5-git-add-paths.txt` 路径数 | **121** |
| 路径不存在（MISSING） | **0** |
| 清单内路径不在 `git status`（除本阶段刚落盘的报告本身） | **0** |
| `git status` 中不在清单的路径 | **17**（构成见下） |

17 项构成，逐项可解释、**无未分类文件**：
- **10** 份 D2 历史审计底稿（阶段5「需用户确认」，默认不纳入）；
- **2** 份 E 类排除（重复留存副本、空 stderr）；
- **5** 份阶段6/7 新落盘产物，将在**阶段9 刷新清单**时纳入：`phase6-version-generation.md`、`phase7-regression.md`、4 个 `phase7-*.txt` 证据（连同本阶段新增的 `phase7-m1-lifecycle-wsl22.txt` 与后续最终报告一并刷新）。

### 版本一致性 / diff / 仓库状态

```
src/worker.js:73  const APP_VERSION = "v1.1.0";
platforms/cloudflare/worker.js == src/worker.js      ✅
5 × platforms/*/app.js == platforms/shared/app.js    ✅
git diff --check                                    退出 0
staged 文件                                         = 0
HEAD                                                7e8fa8d1f5c1e575018e8d5ceb37d32f98773c5c（未变）
```

> 已知提示：`git` 输出 `in the working copy of 'platforms/gen_app.py', CRLF will be replaced by LF the next time Git touches it`（`text: auto`）。**变更前后均存在、非本轮引入**，`git diff --check` 退出 0，登记备查。

---

## 7.5 阶段7结论

| 验收项 | 结果 |
|---|---|
| 完整回归（三套测试） | ✅ 850/0 + 23/0 + **32/0（WSL2 正确环境）** |
| 生成器检查 | ✅ 退出 0，只读 |
| JS/MJS 语法 | ✅ 25/0 |
| Git 忽略规则 | ✅ 全绿 |
| 正式文件清单 | ✅ 121 路径全部有效、无未分类文件 |
| 版本一致性 | ✅ |
| 文档链接 / 过期事实 / 过度承诺 | ✅ 0 断链、0 当前事实错误、否定句核对无误 |
| `git diff --check` | ✅ 退出 0 |
| 未执行 commit / push / tag / deploy | ✅ HEAD 与 staged 均未变 |

**唯一需注意**：`m1-lifecycle.mjs` 必须在 Linux/WSL2/Docker + Node ≥22.13 环境运行；Windows 本机直接执行会报 19 项环境性失败。此限制不影响代码正确性，但须写入发布说明与部署前注意事项（阶段9 登记）。
