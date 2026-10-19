#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 src/worker.js 生成多平台核心 app.js，并同步独立副本到各平台目录（保证六平台功能一致）。

产出：
  1. platforms/shared/app.js  — 唯一源：业务代码与 src/worker.js 逐字节一致，
                                仅把 Worker 专属的 export default 替换为通用导出
                                fetchApp / runCron / handleCronRequest
  2. platforms/<平台>/app.js  — 各平台独立副本（vercel / netlify / deno / edgeone / node）
  3. platforms/<平台>/db.js   — 各平台独立副本（源：platforms/shared/db.js；
                                node 除外——node/db.js 为 Turso + 本地 SQLite 双适配，独立维护）
  4. platforms/<平台>/schema.sql — 建表脚本副本（源：仓库根 schema.sql）
  5. platforms/cloudflare/{worker.js, schema.sql} — Cloudflare 主版本独立副本
     （worker.js 与 src/worker.js 逐字节一致；wrangler.toml 为本目录静态文件，不参与同步）
  6. 各平台入口文件内的 ENV_KEYS 白名单块 — 渠道/站点环境变量统一清单，
     由本脚本的 ENV_KEYS 列表生成（保证六平台透传的变量集合一致，防漂移）

各平台目录因此完全自包含：入口文件只引用本目录内的 app.js / db.js，可独立部署、
互不依赖。src/worker.js、shared/db.js、根 schema.sql 或本脚本 ENV_KEYS 有更新后
重新执行本脚本即可全量同步。

用法：python platforms/gen_app.py
"""
from pathlib import Path
import shutil
import sys

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src" / "worker.js"
SHARED_DIR = REPO_ROOT / "platforms" / "shared"
SHARED_APP = SHARED_DIR / "app.js"
PLATFORM_DIRS = ["vercel", "netlify", "deno", "edgeone", "node"]
# node/db.js 为 Turso + 本地 SQLite 双适配（独立维护），不从 shared/db.js 同步
DB_SYNC_DIRS = ["vercel", "netlify", "deno", "edgeone"]

# 入口文件清单：相对 platforms/ 的路径（netlify 有 api 与 cron 两个入口，均需 ENV_KEYS）
ENTRY_FILES = [
    "vercel/api/[[...route]].js",
    "netlify/functions/api.mjs",
    "netlify/functions/cron.mjs",
    "deno/main.js",
    "edgeone/functions/index.js",  # EdgeOne 根路径 / 只认 index.js；[[default]].js 仅 re-export 本文件 onRequest，无需同步 ENV_KEYS
    "node/server.mjs",
]

# 渠道/站点环境变量白名单（唯一清单）：与 src/worker.js 实际读取的变量一一对应。
# 数据库层变量（TURSO_DATABASE_URL / TURSO_AUTH_TOKEN / SQLITE_PATH）不在此列，
# 由各入口 buildEnv 的数据库分支单独处理。
ENV_KEYS = [
    "RECEIVE_TOKEN",
    "ENABLE_AUTH",
    "ADMIN_PASSWORD",
    "RETENTION_DAYS",
    "WAIT_MAX_SECONDS",
    "PHONE_AREA_ENABLED",
    "PHONE_AREA_API",
    "SITE_NAME",
    "SITE_ICON",
    "FEISHU_WEBHOOK",
    "FEISHU_SECRET",
    "WECOM_WEBHOOK",
    "DINGTALK_WEBHOOK",
    "DINGTALK_SECRET",
    "SERVERCHAN_SENDKEY",
    "PUSHPLUS_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "BARK_DEVICE_KEY",
    "BARK_URL",
    "NTFY_URL",
    "NTFY_TOKEN",
    "GOTIFY_URL",
    "GOTIFY_TOKEN",
    "RESEND_API_KEY",
    "MAIL_TO",
    "MAIL_FROM",
    "GENERIC_WEBHOOKS",
    "GENERIC_WEBHOOK_TEMPLATE",
    "GENERIC_WEBHOOK_HEADERS",
]

ENV_BEGIN = "/* ==== ENV_KEYS BEGIN（由 platforms/gen_app.py 同步，勿手工修改）==== */"
ENV_END = "/* ==== ENV_KEYS END ==== */"

FETCH_SIG = "async fetch(request, env, ctx) {"
SCHED_SIG = "async scheduled(event, env) {"

NEW_TAIL = """/* ---------------- 通用入口导出（本段由 platforms/gen_app.py 生成，勿手工修改） ----------------
 * 以上业务代码与 src/worker.js 逐字节一致；仅将 Worker 专属的 export default 替换为：
 *   fetchApp(request, env[, ctx])   — 请求处理主入口（ctx 可省略；省略时后台任务经 bgRun 内联执行）
 *   runCron(env)                    — 定时清理入口，供各平台原生 cron 调用
 *   handleCronRequest(request, env) — cron 的 HTTP 触发入口（GET /api/cron，token 鉴权）
 */

export async function fetchApp(request, env, ctx) {
  /* ctx 由调用方传入：Cloudflare 传真实 ctx（waitUntil 后台续跑）；其他平台不传（undefined），
     业务代码经 bgRun() 退化为内联 await，确保后台通知不被平台截断 */
__BODY__
}

/* ---------------- 定时清理：供各平台 cron 定时器调用 ---------------- */

export async function runCron(env) {
  await handleCron(env);
}

/* ---------------- cron HTTP 触发入口：GET /api/cron ----------------
 * 鉴权：?token=<RECEIVE_TOKEN> 或 Authorization: Bearer <RECEIVE_TOKEN>
 * （Vercel Cron 自动附带 Bearer 头，需把环境变量 CRON_SECRET 设为与 RECEIVE_TOKEN 相同值）
 */

export async function handleCronRequest(request, env) {
  const url = new URL(request.url);
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\\s+/i, "").trim();
  const provided = url.searchParams.get("token") || bearer;
  if (!env.RECEIVE_TOKEN || !provided || !safeEqual(provided, env.RECEIVE_TOKEN)) {
    return json({ success: false, error: "unauthorized" }, 403);
  }
  await runCron(env);
  return json({ success: true });
}
"""


def generate_shared_app(text: str) -> str:
    pos = text.index("export default {")
    head, tail = text[:pos], text[pos:]

    # 提取 fetch 方法体（从签名后到「  },」收尾之间，逐字节保留）
    b0 = tail.index(FETCH_SIG) + len(FETCH_SIG)
    s0 = tail.index(SCHED_SIG)
    close = tail.rindex("\n  },", b0, s0)
    body = tail[b0:close]

    out = head + NEW_TAIL.replace("__BODY__", body)

    # 自检：模板与字面量特征必须与源文件完全一致（未被生成过程触碰）
    checks = {
        "String.raw 数量": (text.count("String.raw`"), out.count("String.raw`")),
        "反引号总数": (text.count("`"), out.count("`")),
        "${ 出现次数": (text.count("${"), out.count("${")),
    }
    bad = {k: v for k, v in checks.items() if v[0] != v[1]}
    if bad:
        for k, (a, b) in bad.items():
            print("自检失败 %s: 源=%d 生成=%d" % (k, a, b), file=sys.stderr)
        sys.exit(1)
    assert head in out, "head 丢失"
    assert body in out, "fetch 方法体丢失"

    SHARED_DIR.mkdir(parents=True, exist_ok=True)
    SHARED_APP.write_text(out, encoding="utf-8", newline="\n")
    print("[ok] 生成唯一源 %s（%d 行）" % (SHARED_APP, out.count("\n") + 1))
    return out


def env_keys_block() -> str:
    """生成入口文件内的 ENV_KEYS 白名单代码块（含首尾标记）。"""
    items = "\n".join('  "%s",' % k for k in ENV_KEYS)
    return "%s\nconst ENV_KEYS = [\n%s\n];\n%s" % (ENV_BEGIN, items, ENV_END)


def sync_entry_env_keys() -> None:
    """把 ENV_KEYS 白名单同步到各平台入口文件的标记块内（缺失标记块即报错）。"""
    block = env_keys_block()
    for rel in ENTRY_FILES:
        path = REPO_ROOT / "platforms" / rel
        text = path.read_text(encoding="utf-8")
        if ENV_BEGIN not in text or ENV_END not in text:
            print("ENV_KEYS 标记块缺失: %s" % rel, file=sys.stderr)
            sys.exit(1)
        b0 = text.index(ENV_BEGIN)
        b1 = text.index(ENV_END) + len(ENV_END)
        out = text[:b0] + block + text[b1:]
        path.write_text(out, encoding="utf-8", newline="\n")
        ok = (path.read_text(encoding="utf-8") == out) and (out.count("const ENV_KEYS = [") == 1)
        if not ok:
            print("ENV_KEYS 同步校验失败: %s" % rel, file=sys.stderr)
            sys.exit(1)
        print("[ok] 同步 ENV_KEYS 白名单 %s" % rel)


def sync_platforms(shared_app_text: str, db_text: str) -> None:
    """把唯一源同步为各平台目录内的独立副本（各平台目录因此自包含）。"""
    schema_text = (REPO_ROOT / "schema.sql").read_text(encoding="utf-8")
    for name in PLATFORM_DIRS:
        d = REPO_ROOT / "platforms" / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "app.js").write_text(shared_app_text, encoding="utf-8", newline="\n")
        (d / "schema.sql").write_text(schema_text, encoding="utf-8", newline="\n")
        if name in DB_SYNC_DIRS:
            (d / "db.js").write_text(db_text, encoding="utf-8", newline="\n")
        ok = (d / "app.js").read_text(encoding="utf-8") == shared_app_text and \
             (d / "schema.sql").read_text(encoding="utf-8") == schema_text
        if name in DB_SYNC_DIRS:
            ok = ok and (d / "db.js").read_text(encoding="utf-8") == db_text
        if not ok:
            print("同步校验失败: %s" % name, file=sys.stderr)
            sys.exit(1)
        db_note = "{app.js,db.js,schema.sql}" if name in DB_SYNC_DIRS else "{app.js,schema.sql}（db.js 独立维护）"
        print("[ok] 同步独立副本 %s/%s" % (name, db_note))


def sync_cloudflare(schema_text: str) -> None:
    """同步 Cloudflare 主版本独立副本：worker.js（逐字节）+ schema.sql。"""
    d = REPO_ROOT / "platforms" / "cloudflare"
    d.mkdir(parents=True, exist_ok=True)
    worker_text = SRC.read_text(encoding="utf-8")
    (d / "worker.js").write_text(worker_text, encoding="utf-8", newline="\n")
    (d / "schema.sql").write_text(schema_text, encoding="utf-8", newline="\n")
    ok = (d / "worker.js").read_text(encoding="utf-8") == worker_text and \
         (d / "schema.sql").read_text(encoding="utf-8") == schema_text
    if not ok:
        print("同步校验失败: cloudflare", file=sys.stderr)
        sys.exit(1)
    print("[ok] 同步独立副本 cloudflare/{worker.js,schema.sql}")


def main() -> int:
    text = SRC.read_text(encoding="utf-8")
    shared_app_text = generate_shared_app(text)
    db_text = (SHARED_DIR / "db.js").read_text(encoding="utf-8")
    sync_platforms(shared_app_text, db_text)
    sync_cloudflare((REPO_ROOT / "schema.sql").read_text(encoding="utf-8"))
    sync_entry_env_keys()
    return 0


if __name__ == "__main__":
    sys.exit(main())
