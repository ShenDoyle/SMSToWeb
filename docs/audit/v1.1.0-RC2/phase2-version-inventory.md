# SMSToWeb v1.1.0 · RC2 · 阶段2 版本引用盘点与同步证据

> 阶段2目标：将 `APP_VERSION` 由 `v1.0.4` 升级为 `v1.1.0`，并用现有生成器 `platforms/gen_app.py` 同步六平台产物；确认除版本同步外无任何意外源码/产物改动（生成器为纯 pass-through）。

## 1. 版本引用全量盘点（结论）

经全仓只读搜索 + 生成器源码核读，版本号的"真实定义源"与"展示/副本/历史"分布如下：

| 类别 | 位置 | 处理后状态 |
|---|---|---|
| **唯一运行时版本定义源** | `src/worker.js:73` `const APP_VERSION = "v1.1.0"` | ✅ 已改为 v1.1.0 |
| 经 `__APP_VERSION__` 占位符注入的页脚展示 | 所有页面页脚 `<span class="ver">v1.1.0</span>` | ✅ 随源自动同步 |
| 六平台生成副本（5×app.js ≡ shared；cloudflare/worker.js ≡ src） | `platforms/{shared,vercel,deno,netlify,edgeone,node}/app.js`、`platforms/cloudflare/worker.js` | ✅ 经生成器写盘同步为 v1.1.0 |
| `node/db.js` | 独立维护，不含版本串 | ✅ 不受影响（SHA 不变） |
| package.json / Dockerfile / *.toml / *.yml 版本串 | 不存在 | N/A |
| API 版本端点 | 不存在 | N/A |
| PWA / Service Worker 缓存名 | `smstoweb-shell-v2`（**版本无关**，network-first，无旧缓存复用风险） | ✅ 无需改 |

## 2. 生成器 pass-through 验证（关键排错）

运行 `python platforms/gen_app.py`（写盘模式）后初看 diff 很大（src/worker.js +五平台 app.js 各 +115 行、tests/run.mjs +398、且生成器回写 src/worker.js 自身），疑似引入业务代码改动。

**诊断**：回读 `gen_app.py` 源码确认生成器读工作树 `src/worker.js` 全量同步、为纯 pass-through；将 `src/worker.js:73` 临时回退为 `v1.0.4` 重跑生成器，测得关键文件 SHA **精确等于阶段0基线**（`d8c32aa2…`/`1a78e27c…`/`388cd2e9…`）。证明大 diff 实为 P1/M-2/M-3 阶段**既有未提交工作树修改**经生成器重新传播，非生成器或版本编辑引入。恢复 v1.1.0 重跑得最终 SHA。

## 3. 阶段0基线 → 阶段2后 关键文件 SHA-256

| 文件 | 阶段0基线（v1.0.4 工作树） | 阶段2后（v1.1.0） |
|---|---|---|
| `src/worker.js` | `d8c32aa2…` | `083d8e68…` |
| `platforms/cloudflare/worker.js` | `d8c32aa2…` | `083d8e68…`（≡ src） |
| `platforms/shared/app.js` | `1a78e27c…` | `cfcff639…` |
| 五平台 `app.js`（vercel/deno/netlify/edgeone/node） | `1a78e27c…` | `cfcff639…`（≡ shared） |
| `platforms/node/db.js` | `388cd2e9…` | `388cd2e9…`（不变） |

> 仅版本同步引起差异；cloudflare ≡ src、五平台 app.js ≡ shared 的字节一致性保持。

## 4. 本轮修改的版本相关文档/测试清单

| 文件 | 改动 |
|---|---|
| `src/worker.js:73` | `v1.0.4` → `v1.1.0`（唯一真实版本定义源） |
| `platforms/{shared,vercel,deno,netlify,edgeone,node}/app.js`、`cloudflare/worker.js` | 经生成器同步（版本串 v1.1.0） |
| `tests/run.mjs:814/817/820` | 页脚版本断言 `v1.0.4` → `v1.1.0`（§6.4 要求：测试中的当前版本断言已正确更新） |
| 主版用户文档（README.md、guide/*.md、i18n/README.md 索引、platforms/cloudflare/README.md、UPGRADE.md） | "当前源码版本 v1.0.4" → "v1.1.0（RC2 候选）"；保留"v1.1.0 尚未正式发布"诚实声明 |
| `docs/i18n/en/README.md` | 内部一致性：L3「Verified current facts」`ENV_KEYS = 32` → `33`；L5 源码版本 `v1.0.4` → `v1.1.0`（RC2 候选） |

## 5. 刻意未改（RC1 既定"已知待办"，RC2 不越界）

- **16 个 i18n 翻译镜像的 Sync-notice 块**（zh-CN/zh-TW/ja/ko/es/fr/de/pt-BR 的 README + ARCHITECTURE，共 16 处）仍写 `ENV_KEYS = 32` / `源码版本仍为 v1.0.4`：RC1 补充验收报告已将其列为"建议后续批次修正"，并受"不得大规模重写文档 / 不得覆盖 M-2/M-3 交付物"约束，本轮不动。
- **10 份历史审计底稿**（`docs/audit/*`）的 `32` 计数：归档原文（M-2/M-3 已加"时效性勘误"、约定"原文一字未删"），本轮不动。
- **历史报告**（RC1 报告/补充报告等）中的 `v1.0.4`：按纪律"历史报告中的 v1.0.4 不得修改"，未动。

## 6. 结论

阶段2闭合：版本正确升级至 v1.1.0；六平台核心应用版本一致（cloudflare ≡ src、五平台 ≡ shared）；无意外漂移；测试版本断言已同步。文档一致性按纪律分级处理，已知残留如实记录。
