# SMSToWeb v1.1.0 · RC2 · 阶段6 完整回归与发布候选验证

> 阶段6目标：完整回归（测试 / gen --check / 六平台字节比较 / 语法检查 / 文档检查 / 性能优化保护）。

## 10.1 功能回归

| 套件 | 命令 | 结果 |
|---|---|---|
| 全量功能回归 | `node tests/run.mjs` | **850 通过 / 0 失败**，退出 0 |
| P1 鉴权与后台通知可靠性 | `node tests/p1-auth.mjs` | **23 通过 / 0 失败**，退出 0（含 `ENV_KEYS = 33` 断言、六入口 ENV_KEYS 块一致、verifyInboundToken 行为矩阵） |

> 页脚版本断言已随阶段2升级同步为 `v1.1.0`（tests/run.mjs:817/820），回归全绿证明版本同步未破坏任何功能。

## 10.2 生成器检查
`python platforms/gen_app.py --check` → 退出 **0**（`SCHEMA_SQL` 内嵌块 ≡ 根 schema.sql；表引用校验通过）。

## 10.3 六平台字节比较（重跑）
- `platforms/shared/app.js` ≡ `platforms/{vercel,deno,netlify,edgeone,node}/app.js`：✅ 全部 OK
- `src/worker.js` ≡ `platforms/cloudflare/worker.js`：✅ OK

## 10.4 语法检查
- JS/MJS（`find` 全仓排除 node_modules、runtime）：**25 文件，0 语法失败**
- Python：`python -m py_compile platforms/gen_app.py` → OK

## 10.5 文档检查
- 主版（README / guide/* / UPGRADE / i18n 索引 / cloudflare README / en/README）"当前源码版本"均更新为 `v1.1.0`（RC2 候选），且保留"尚未正式发布"诚实声明；`ENV_KEYS` 计数在主版均为 33。
- 残留 `v1.0.4` / `ENV_KEYS=32` 仅存在于 **16 个 i18n 滞后翻译镜像的 Sync-notice 块**——此为 RC1 补充验收报告明确"建议后续批次修正"、受"不得大规模重写 / 不得覆盖 M-2/M-3 交付物"约束而刻意保留的已知待办（非本次缺陷）。详细见阶段5 文件清单与 RC2 报告 §已知文档债。
- 通知机制描述在主版均为 best-effort（"一个失败目标不阻断其余"、超时经 `AbortSignal.timeout` 真实终止），无 exactly-once / 跨重启恢复等夸大表述。

## 10.6 既有性能优化保护
- 源文件 `src/worker.js` 性能优化标记（`optimizedPage` / `STAR_PROJECTION` / `Promise.all` 并行分发 / `bgRun` 多目标）**完整保留**（grep 命中 7 处）；版本升级仅改动 L73 `APP_VERSION`，未触及任何优化代码路径。
- 经生成器写盘同步后，六平台副本同样保留优化（字节一致性已验证）。
- 性能收益（大 offset 分页 ~66× 加速）为 RC1 在隔离 `:memory:` SQLite 数据集上的**本地验证**结论，代码路径在本轮未被改动，回归套件（star 投影相关分支由 run.mjs 覆盖）全绿。

## 结论
阶段6闭合：功能回归全绿、生成器与六平台一致、语法全过、文档主版自洽、性能优化保留。无回归、无意外源码修改。
