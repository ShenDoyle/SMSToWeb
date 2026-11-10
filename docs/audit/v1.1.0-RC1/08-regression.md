# 附件 C · Phase 8 完整回归证据

## 1. 功能回归

- `node tests/run.mjs` → **850 通过 / 0 失败**（REG_EXIT=0）。原始输出落盘：`RC1-raw/02-regression.txt`。
- `node tests/p1-auth.mjs`（23 用例，P1 鉴权闭环）历史通过（P1 报告）。
- `rc1-star-projection.mjs`（隔离 5000 行 `node:sqlite`）→ `STAR_PROJECTION: pass=5310 fail=0 RESULT=PASS`。

## 2. 性能回归

- `rc1-perf.mjs`（`:memory:` 本地 SQLite，10k/100k，隔离数据集）→ `RESULT=PASS`。
- N=100,000 关键 p50：default10=0.041ms、default100=0.09ms、largeOffset=1.015ms、search=0.1ms、sourceFilter=0.122ms、unreadFilter=0.105ms、starredFilter=0.096ms、stats=4.035ms、detail=0.008ms；**OLD_largeOffset=66.78ms**（优化 ~66×）。
- 原始输出：`RC1-raw/rc1-perf.txt`。

## 3. 生成器与平台一致性

- `python platforms/gen_app.py --check` → 退出 0；SCHEMA_SQL ≡ 根 schema.sql；表 devices/messages/settings/tokens 引用校验通过（`RC1-raw/03-gen-check.txt`）。
- Phase 3 临时副本 diff 真实仓库 10 文件 → `DRIFT_COUNT=0`。

## 4. 工作区零漂移（基线指纹重算）

Phase 8 重算 `RC1-raw/00-baseline.md` 记录的 12 关键文件 SHA-256，全部逐字节匹配（`ALL_BASELINE_HASHES_MATCH`）：
gen_app.py、src/worker.js、cloudflare/worker.js（≡src）、shared/app.js、vercel/netlify/deno/edgeone/node 五入口、tests/run.mjs、tests/p1-auth.mjs、schema.sql。

## 5. 语法检查

- 全仓 182 个 `.js`/`.mjs`（排除 node_modules）经 `node --check` → **ALL_JS_SYNTAX_OK**。
- `platforms/gen_app.py` 可解析并执行 `--check` → OK。

## 6. 多语言与链接

- 9 语言键齐备（主报告 §10）。
- README 相对链接指向存在的文档与平台目录（人工核对）。
