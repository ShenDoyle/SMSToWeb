# SMSToWeb v1.1.0 · 阶段6：版本与生成文件一致性

> 执行时间：2026-11-10 16:12–16:18 (GMT+8)
> 结论：**无生成漂移，`gen --check` 退出 0，六平台产物字节一致**。本轮**未运行生成器写盘**、未覆盖任何历史改动。
> ⚠️ 如实登记 1 处已知版本串残留：`platforms/node/package.json` `"version": "1.0.3"`（RC1 明确列为"需批准后同步"的待批准项，本轮不擅自修改）。

---

## 6.1 五种统计口径（严格分开，不得混用）

RC2 报告曾写"7 个版本条目"却列出 8 个文件路径。本轮重新实测，**逐口径分列**：

| # | 口径 | 数量 | 明细 |
|---|---|---|---|
| 1 | **版本源文件（唯一权威定义）** | **1** | `src/worker.js:73` `const APP_VERSION = "v1.1.0"` |
| 1b | **含 `APP_VERSION` 定义的文件**（1 源 + 生成副本） | **8** | `src/worker.js`、`platforms/shared/app.js`、`platforms/{vercel,deno,netlify,edgeone,node}/app.js`、`platforms/cloudflare/worker.js`。每个文件**恰好 1 处**定义（实测 `grep -rc`，无重复、无遗漏） |
| 2 | **含运行时版本字符串 `v1.1.0` 的代码/测试文件** | **9** | 上述 8 个 + `tests/run.mjs`（测试断言） |
| 2b | **`v1.1.0` 字面量出现次数** | **13 次 / 11 行** | 8 次定义 + `tests/run.mjs` 5 次字面量（3 行：L814 注释 1 次、L817 2 次、L820 2 次）。**行数口径 11 ≠ 字面量口径 13**，二者不可混用 |
| 3 | **仅用于测试断言的文件** | **1** | `tests/run.mjs`（L814 注释 + L817/L820 页脚版本断言）。`tests/p1-auth.mjs`、`tests/m1-lifecycle.mjs` **不含版本串** |
| 4 | **文档中引用 `v1.1.0` 的文件** | **61** | 产品文档 **30** + 审计文档 **31** |
| 5 | **平台生成副本数量** | **7**（或按平台产物计 **6**） | `shared/app.js` + 5 平台 `app.js` + `cloudflare/worker.js` = 7 个生成副本；若不含 `shared/`（中间产物）而按"六平台交付产物"计 = 5 `app.js` + 1 `worker.js` = 6 |
| 5b | **数据库适配器副本** | **5** | `shared/db.js` + 4 平台 `db.js`（`vercel/deno/netlify/edgeone` 逐字节 ≡ shared）+ `node/db.js`（**有意独立**） |

> **概念区分**：`APP_VERSION` 定义文件数（8）≠ 含版本串文件数（9）≠ 版本字面量次数（13）≠ 平台产物数（6/7）≠ 唯一版本源数（1）。RC2 的"7 个版本条目"是把"平台产物数"与"定义文件数"混用所致，本轮以实测 8 / 6 / 1 分列纠正。

### 30 份引用 v1.1.0 的产品文档（清单）

`README.md`、`docs/UPGRADE.md`、`docs/releases/v1.1.0.md`、`docs/i18n/README.md`、`docs/i18n/en/QUICKSTART.md`、`docs/i18n/{de,en,es,fr,ja,ko,pt-BR}/ARCHITECTURE.md` 与 `README.md`（14）、`docs/i18n/zh-CN/README.md`、`docs/i18n/zh-TW/{ARCHITECTURE,README}.md`、`docs/guide/{README,02-快速开始,05-常见问题,09-更新与维护,03-平台部署/README,03-平台部署/06-Node自托管}.md`（6）、`platforms/README.md`、`platforms/cloudflare/README.md`。

---

## 6.2 `gen --check` 执行与无写盘验证

```
$ python platforms/gen_app.py --check
[ok] SCHEMA_SQL 内嵌块与根 schema.sql 一致
[ok] schema 引用校验通过（表 devices, messages, settings, tokens）
退出码：0
```

**执行前后关键文件 SHA256 完全一致**（证明 `--check` 为只读、未写盘、未覆盖历史改动）：

| 文件 | 执行前（阶段0 基线） | 执行后 | 一致 |
|---|---|---|---|
| `src/worker.js` | `083d8e68…dccf` | `083d8e68…dccf` | ✅ |
| `platforms/shared/app.js` | `cfcff639…4785` | `cfcff639…4785` | ✅ |
| `platforms/cloudflare/worker.js` | `083d8e68…dccf` | `083d8e68…dccf` | ✅ |
| `platforms/node/db.js` | `388cd2e9…855d` | `388cd2e9…855d` | ✅ |

> ⚠️ `gen --check` **仅**校验内嵌 `SCHEMA_SQL` 块与根 `schema.sql`、以及 SQL 表/列引用；**不**比对六平台 `app.js`/`worker.js` 副本、**不**校验 `ENV_KEYS` 块（RC1 已明确，且 `gen_app.py` 源码注释一致）。因此必须以下节**独立字节比对**作为产物一致性的证据，不能只凭 `--check` 通过下结论。

---

## 6.3 独立字节级 / SHA256 比对

### ① 五个平台 `app.js` ≡ `platforms/shared/app.js`

`cmp -s` 逐字节比对全部 **IDENTICAL**：

```
platforms/vercel/app.js   == platforms/shared/app.js   ✅
platforms/deno/app.js     == platforms/shared/app.js   ✅
platforms/netlify/app.js  == platforms/shared/app.js   ✅
platforms/edgeone/app.js  == platforms/shared/app.js   ✅
platforms/node/app.js     == platforms/shared/app.js   ✅
```
统一 SHA256：`cfcff639d3cd7893640fa700c654305f00504b2e31f2b74609771b6640874785`

### ② Cloudflare Worker ≡ 共享源码

```
platforms/cloudflare/worker.js == src/worker.js   ✅（cmp -s IDENTICAL）
```
统一 SHA256：`083d8e68b56babf2e87aca50a63105a0224963dfcf113798d8a95970658ccdcf`

> **两条一致性关系不同，不可混淆**：`cloudflare/worker.js` 与 **`src/worker.js`** 逐字节一致（Cloudflare 用单文件 Worker）；`shared/app.js` 是 `src/worker.js` 经生成器加 export 包装后的平台无关版本（9021 行 → 9061 行），**二者本就不应字节相同**。实测 `cmp` 为 DIFFERENT，符合设计预期。
> `platforms/cloudflare/app.js` **不存在**，这是设计如此，不是缺失。

### ③ 数据库适配器（Node 差异为有意）

| 文件 | SHA256 前缀 | 与 `shared/db.js` |
|---|---|---|
| `platforms/shared/db.js` | `219aea66…` | 基准 |
| `platforms/vercel/db.js` | `219aea66…` | ✅ IDENTICAL |
| `platforms/deno/db.js` | `219aea66…` | ✅ IDENTICAL |
| `platforms/netlify/db.js` | `219aea66…` | ✅ IDENTICAL |
| `platforms/edgeone/db.js` | `219aea66…` | ✅ IDENTICAL |
| `platforms/node/db.js` | `388cd2e9…` | **DIFFERENT（有意）** |

**源码依据**（非推测）：`platforms/gen_app.py:11-12, 40-41`：
```
3. platforms/<平台>/db.js — 各平台独立副本（源：platforms/shared/db.js；
                             node 除外——node/db.js 为 Turso + 本地 SQLite 双适配，独立维护）
DB_SYNC_DIRS = ["vercel", "netlify", "deno", "edgeone"]   # 不含 node
```
生成器代码 `:325-326, :329-330, :334` 也只对 `DB_SYNC_DIRS` 写入/回读 `db.js`，并对 node 输出 `{app.js,schema.sql}（db.js 独立维护）`。阶段2 的本地 Node 真实运行进一步实证该双适配器可用（本地 SQLite 建出 4 张表）。

### ④ 生成漂移结论

| 检查 | 结果 |
|---|---|
| 与阶段0 基线的 SHA 对比 | 完全一致，**零漂移** |
| 是否需要重新生成 | ❌ **不需要**。本轮未改 `src/worker.js` / `gen_app.py` / `schema.sql`，无写盘理由 |
| 是否覆盖历史改动 | ❌ 否。`--check` 只读；未运行生成器写盘 |
| RC2 仓库外独立重生成证据 | 仍有效且未受本轮改动影响（`v1.1.0-RC2/phase4-generation-consistency.md` 记录逐字节零差异），按 §十五 引用，不重复测试 |

---

## 6.4 版本字符串作用域（不参与逻辑）

`src/worker.js` 中 `APP_VERSION` 的全部引用：

| 行 | 用途 |
|---|---|
| `:73` | `const APP_VERSION = "v1.1.0";` 定义 |
| `:82` | `.replace(/__APP_VERSION__/g, () => escAttr(APP_VERSION))` —— 模板占位符替换 |
| `:2960` / `:7551` | `<span class="ver">__APP_VERSION__</span>` —— 管理页 / 登录页**页脚纯展示** |

**结论**：版本串**不参与任何鉴权、加密、分支或数据库逻辑**；PWA 缓存名固定 `smstoweb-shell-v2`（版本无关，network-first），升级版本无需改动。阶段2 本地真实运行已实证首页 200 且含 `<span class="ver">v1.1.0</span>`。

---

## 6.5 版本串残留（如实登记，不擅自修改）

全仓配置/CI 版本串扫描（`package.json` / `Dockerfile` / `*.toml` / `*.yml` / `*.yaml` / `docs/deploy-templates/*`）**仅 1 处命中**：

| 文件 | 内容 | Git 状态 | 运行时影响 |
|---|---|---|---|
| `platforms/node/package.json:3` | `"version": "1.0.3"` | **tracked、未修改** | 无。`server.mjs` 为零 npm 依赖的 ESM 入口，`Dockerfile` 仅 `COPY package.json`；版本展示与鉴权均由 `APP_VERSION` 决定 |

**历史依据**：`docs/audit/文档一致性审计报告.md:43` 已记录该项：
> `platforms/node/package.json` `"version": "1.0.3"` … **未改**：版本相关文本属本轮保护范围，需批准后同步；已列入最终报告「待批准」。

**本轮处置**：**不修改**，理由：
1. RC1 明确标注"需批准后同步"，本轮任务书未授予修改 Node 包元数据版本字段的授权；
2. 修改会新增一个 tracked modified 文件，扩大提交范围，与 §3.3「不覆盖任何历史改动」的保守边界相悖；
3. 它既不是版本源、也不参与运行时，不影响功能、测试或页脚显示。

**登记为**：非阻断限制 + **需用户确认**。若审核方要求"全仓版本串零不一致"，需单独授权把该字段同步为 `"1.1.0"`，并重新执行阶段6/7 的一致性核验。详见阶段9 §剩余风险。

其余配置文件（`platforms/package.json`、`platforms/cloudflare/package.json`、`platforms/vercel/package.json`、`wrangler.toml`、`netlify.toml`、`vercel.json`、`.github/workflows/ci.yml`、Dockerfile、部署模板）**均无版本字段或版本串**。

---

## 6.6 阶段6结论

| 验收项 | 结果 |
|---|---|
| APP_VERSION = v1.1.0 | ✅ `src/worker.js:73` |
| 版本源与生成副本一致 | ✅ 8 个定义文件、逐字节关系符合设计 |
| 版本统计口径清晰 | ✅ 5 类口径分列，纠正 RC2 "7 vs 8" 混用 |
| `gen --check` | ✅ 退出 0，只读无写盘 |
| 独立字节比对 | ✅ 5×`app.js` ≡ shared、CF `worker.js` ≡ src、4×`db.js` ≡ shared |
| Node 适配器差异 | ✅ 有意（`gen_app.py` 源码依据 + 阶段2 实证） |
| 生成漂移 | ✅ 无；未重生成、未覆盖历史改动 |
| 版本串残留 | ⚠️ 1 处已知待批准项（node/package.json 1.0.3），已登记、需用户确认 |
