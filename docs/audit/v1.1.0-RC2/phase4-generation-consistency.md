# SMSToWeb v1.1.0 · RC2 · 阶段4 六平台生成产物一致性

> 阶段4目标：验证 `gen_app.py` 生成的六平台产物与单源 `src/worker.js` 严格一致；独立重新生成确认差异仅来自版本同步。

## 8.1 生成器检查（gen --check）

```
$ python platforms/gen_app.py --check
[ok] SCHEMA_SQL 内嵌块与根 schema.sql 一致
[ok] schema 引用校验通过（表 devices, messages, settings, tokens）
EXIT_CODE=0
```

> 说明：`gen --check` 仅校验 `SCHEMA_SQL` 内嵌块与 SQL 引用，**不比对副本、不校验 ENV_KEYS**（与 RC1 结论一致）。字节一致性须以文件指纹为准（见 8.2/8.3）。

## 8.2 字节一致性检查

| 比对 | 结果 |
|---|---|
| `platforms/shared/app.js` ≡ `platforms/vercel/app.js` | ✅ OK |
| `platforms/shared/app.js` ≡ `platforms/deno/app.js` | ✅ OK |
| `platforms/shared/app.js` ≡ `platforms/netlify/app.js` | ✅ OK |
| `platforms/shared/app.js` ≡ `platforms/edgeone/app.js` | ✅ OK |
| `platforms/shared/app.js` ≡ `platforms/node/app.js` | ✅ OK |
| `src/worker.js` ≡ `platforms/cloudflare/worker.js` | ✅ OK |
| `platforms/node/db.js` SHA | `388cd2e9…`（与阶段0基线一致，未变） |

→ 五平台 `app.js` 全部 ≡ `shared`；Cloudflare `worker.js` ≡ 单源 `src`；`node/db.js` 独立维护不受影响。

## 8.3 独立生成验证（仓库外临时副本，写盘模式）

1. 将 `src/`、`platforms/`、`schema.sql` 复制到仓库外临时目录 `/d/rc2-gen-verify/`。
2. 在临时副本中运行 `python platforms/gen_app.py`（写盘模式），`GEN_EXIT=0`。
3. 将重新生成的 `platforms/` 与当前仓库 `platforms/` 逐字节比对：

```
$ diff -rq platforms /d/OpenClaw/SMSToWeb/platforms
NO DIFF (regenerated == repo, byte-identical)
```

→ 重新生成产物与仓库文件**逐字节一致**，证明仓库内六平台产物确由生成器产出、无任何手工漂移或意外修改。

**版本同步唯一性佐证**（来自阶段2 pass-through 验证）：将 `src/worker.js:73` 临时回退为 `v1.0.4` 并重跑生成器，测得关键文件 SHA **精确等于阶段0基线**（src/cloudflare=`d8c32aa2…`、shared/五平台=`1a78e27c…`、node/db.js=`388cd2e9…`）。即：除 APP_VERSION 由 v1.0.4→v1.1.0 外，生成器未引入任何非版本差异。

## 结论

阶段4闭合：六平台产物与单源逐字节一致；独立重生成零漂移；差异确认仅来自版本同步。六平台核心应用版本全部 = v1.1.0。
