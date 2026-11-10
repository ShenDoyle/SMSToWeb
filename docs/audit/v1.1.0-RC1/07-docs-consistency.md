# 附件 B · Phase 7 文档与发布材料一致性

## 一致项（PASS）

- **版本框架诚实**：`src/worker.js:73` `APP_VERSION="v1.0.4"`；README L11 写「Current version: v1.0.4」一致；README L68 明确「v1.1.0 尚未发布、本 checkout 为 v1.0.4 + 未提交修复」——RC 未被描述为已发布。未发现任何用户面向文档声称 v1.1.0 已发布。
- **9 语言**：管理页/登录页内置 zh-CN/zh-TW/en/ja/ko/es/fr/de/pt-BR（9 种），`src/worker.js` 9/9 键齐全；`docs/i18n/` 镜像目录 9 个，一致。
- **测试数量**：README 称 `tests/run.mjs` 850 项、`m1-lifecycle.mjs` 32 项；`node tests/run.mjs` 实测 **850/0**，一致。
- **`gen --check` 边界**：README L191 准确说明其仅校验 SCHEMA_SQL 与 SQL 引用、不比对副本、不校验 ENV_KEYS、检测不到改 src 的漂移——与 Phase 3/主报告 §6 实测一致。
- **能力诚实度**：README 如实标注 Deno/EdgeOne 一键按钮「未验证」、Node 自托管「无一键部署」、WSL2 Docker 局部验证「非生产」；无过度承诺。
- **六平台列表**：README 表与 `platforms/` 实际目录（cloudflare/vercel/deno/netlify/edgeone/node = 6）一致。

## 不一致项（P3）

| 文件 | 行 | 现状 | 应改为 | 说明 |
|---|---|---|---|---|
| `README.md` | L190 | 「**32-variable** environment whitelist」 | 33 | 与 L126「32→33-entry」及源码 gen_app.py ENV_KEYS=33 矛盾 |
| `docs/ARCHITECTURE.md` | L52 | 「含 **32** 个环境变量」 | 33 | 同上 |

> 根因：P1-1 向 `ENV_KEYS` 白名单新增 `DISABLE_RECEIVE_TOKEN`（32→33），源码与 README L126 已更新，但 README L190 与 ARCHITECTURE L52 遗漏。属纯文案修正，不影响运行时（白名单以 gen_app.py 为准，已确认 33 项六平台同步）。

## 最小修复方案（待审批）

- 将 `README.md` L190 的 `32-variable` 改为 `33-variable`。
- 将 `docs/ARCHITECTURE.md` L52 的「32 个环境变量」改为「33 个环境变量」。
- 两处均不改代码、不改生成器、不动 `APP_VERSION`。
