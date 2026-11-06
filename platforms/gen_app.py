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
  7. src/worker.js 内的 SCHEMA_SQL 内嵌块 — 由根 schema.sql 同步（运行时幂等自愈
     ensureSchema 的唯一事实源；schema.sql 更新后重跑本脚本即自动内嵌）
  8. schema 引用校验 — 代码中 SQL 引用的表/限定列必须存在于根 schema.sql，
     缺失即报错退出（CI 与本地均执行；--check 模式只校验不写盘）

各平台目录因此完全自包含：入口文件只引用本目录内的 app.js / db.js，可独立部署、
互不依赖。src/worker.js、shared/db.js、根 schema.sql 或本脚本 ENV_KEYS 有更新后
重新执行本脚本即可全量同步。

用法：python platforms/gen_app.py          # 全量同步 + 全部校验
      python platforms/gen_app.py --check # 只校验（同步状态 + 引用完整性），不写盘
"""
from pathlib import Path
import re
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
    "SESSION_SECRET",
    "RETENTION_DAYS",
    "WAIT_MAX_SECONDS",
    "PHONE_AREA_ENABLED",
    "PHONE_AREA_API",
    "SITE_NAME",
    "SITE_ICON",
    "NOTIFY_LINK",
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

SCHEMA_BEGIN = "/* ==== SCHEMA_SQL BEGIN（由 platforms/gen_app.py 从根 schema.sql 同步，勿手工修改）==== */"
SCHEMA_END = "/* ==== SCHEMA_SQL END ==== */"

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

/* ---------------- 接入令牌数据层导出（供测试与第 3 步管理 API 复用） ---------------- */

export {
  createToken,
  listTokens,
  findTokenByHash,
  revokeToken,
  rotateToken,
  touchLastUsed,
  atomicBatch,
  AtomicBatchError,
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


def schema_block() -> str:
    """生成 src/worker.js 内的 SCHEMA_SQL 内嵌块（含首尾标记）。

    运行时 ensureSchema 以此为唯一事实源做幂等自愈，故 schema.sql 内容会被内嵌为
    JS 模板字面量——反引号与 ${ 会破坏字面量/生成过程，出现即报错拒绝。"""
    schema = (REPO_ROOT / "schema.sql").read_text(encoding="utf-8")
    for bad in ("`", "${"):
        if bad in schema:
            print("schema.sql 含 %r，无法安全内嵌 worker.js（请改写该字符）" % bad, file=sys.stderr)
            sys.exit(1)
    return "%s\nconst SCHEMA_SQL = `\n%s\n`;\n%s" % (SCHEMA_BEGIN, schema.rstrip("\n"), SCHEMA_END)


def sync_schema_block() -> None:
    """把根 schema.sql 同步进 src/worker.js 的 SCHEMA_SQL 标记块（缺失标记块即报错）。"""
    text = SRC.read_text(encoding="utf-8")
    if SCHEMA_BEGIN not in text or SCHEMA_END not in text:
        print("SCHEMA_SQL 标记块缺失: src/worker.js", file=sys.stderr)
        sys.exit(1)
    if text.count(SCHEMA_BEGIN) != 1 or text.count(SCHEMA_END) != 1:
        print("SCHEMA_SQL 标记块重复: src/worker.js", file=sys.stderr)
        sys.exit(1)
    b0 = text.index(SCHEMA_BEGIN)
    b1 = text.index(SCHEMA_END) + len(SCHEMA_END)
    out = text[:b0] + schema_block() + text[b1:]
    SRC.write_text(out, encoding="utf-8", newline="\n")
    if SRC.read_text(encoding="utf-8") != out:
        print("SCHEMA_SQL 同步校验失败: src/worker.js", file=sys.stderr)
        sys.exit(1)
    print("[ok] 同步 SCHEMA_SQL 内嵌块 src/worker.js")


def parse_schema_tables(schema_text: str) -> dict:
    """解析 schema.sql → { 表名: {列名集合} }（取 CREATE TABLE IF NOT EXISTS 语句）。"""
    tables = {}
    for m in re.finditer(r"CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\)\s*;", schema_text):
        cols = set()
        for line in m.group(2).splitlines():
            t = re.sub(r"--.*$", "", line).strip().rstrip(",").strip()
            if not t:
                continue
            first = t.split()[0]
            if first.upper() in ("PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT"):
                continue
            cols.add(first)
        tables[m.group(1)] = cols
    return tables


def check_schema_refs() -> None:
    """schema 引用校验：代码中 SQL 引用的表与限定列（表.列）必须存在于根 schema.sql。

    覆盖方式为关键字清单 + 正则（零依赖，非完整 SQL 解析）：
      - 仅匹配大写 SQL 关键字上下文，与本项目「SQL 关键字一律大写」的书写约定一致；
      - 扫描前剥掉注释（/* */ 与 //），避免文档注释里的 SQL 示例误报；
      - 跳过 SQL 语法噪音词（SET/OR/ADD 等），兼容 upsert（DO UPDATE SET）与
        UPDATE OR IGNORE 等冲突子句写法；
      - 限定列校验覆盖 `表.列` 字面引用（别名引用如 m.col 不在本检查范围内，
        由 CI 的测试套件与运行时自愈兜底）。"""
    schema_text = (REPO_ROOT / "schema.sql").read_text(encoding="utf-8")
    tables = parse_schema_tables(schema_text)
    code = SRC.read_text(encoding="utf-8")
    # 仅用于扫描的副本：剥掉块注释、行注释与行内 //（URL 会被误删，但扫描不受影响）
    scan = re.sub(r"/\*[\s\S]*?\*/", " ", code)
    scan = re.sub(r"//[^\n]*", " ", scan)
    noise = {"SELECT", "SET", "OR", "AND", "NOT", "NULL", "INTO", "VALUES", "ADD", "COLUMN",
             "TABLE", "IF", "EXISTS", "DEFAULT", "IGNORE", "REPLACE", "DO", "ON", "CONFLICT",
             "RETURNING", "WHERE", "KEY", "CASE", "WHEN", "THEN", "ELSE", "END",
             # SQLite 内置系统表：运行时恒存在，不属于应用 schema（结构探针会查询 sqlite_master）
             "SQLITE_MASTER", "SQLITE_SCHEMA", "SQLITE_SEQUENCE"}
    problems = []

    table_ctx = re.finditer(
        r"\b(?:FROM|JOIN|INSERT INTO|UPDATE(?:\s+OR\s+\w+)?|ALTER TABLE)\s+`?(\w+)`?", scan)
    for m in table_ctx:
        t = m.group(1)
        if t.upper() in noise:
            continue
        if t not in tables:
            problems.append("引用了 schema.sql 中不存在的表: %s（第 %d 行附近）" % (t, scan[:m.start()].count("\n") + 1))

    for m in re.finditer(r"\b(\w+)\.(\w+)\b", scan):
        t, c = m.group(1), m.group(2)
        if t in tables and c not in tables[t]:
            problems.append("引用了 %s 表中不存在的列: %s.%s（第 %d 行附近）" % (t, t, c, scan[:m.start()].count("\n") + 1))

    if problems:
        for p in problems:
            print("schema 引用校验失败: %s" % p, file=sys.stderr)
        sys.exit(1)
    print("[ok] schema 引用校验通过（表 %s）" % ", ".join(sorted(tables)))


def check_sync_state() -> None:
    """--check 模式：只校验不写盘——SCHEMA_SQL 内嵌块与根 schema.sql 一致。"""
    text = SRC.read_text(encoding="utf-8")
    if SCHEMA_BEGIN not in text or SCHEMA_END not in text:
        print("SCHEMA_SQL 标记块缺失: src/worker.js", file=sys.stderr)
        sys.exit(1)
    b0 = text.index(SCHEMA_BEGIN)
    b1 = text.index(SCHEMA_END) + len(SCHEMA_END)
    if text[b0:b1] != schema_block():
        print("SCHEMA_SQL 内嵌块与根 schema.sql 不一致：请运行 python platforms/gen_app.py", file=sys.stderr)
        sys.exit(1)
    print("[ok] SCHEMA_SQL 内嵌块与根 schema.sql 一致")


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
    if "--check" in sys.argv[1:]:
        check_sync_state()
        check_schema_refs()
        return 0
    sync_schema_block()
    text = SRC.read_text(encoding="utf-8")
    shared_app_text = generate_shared_app(text)
    db_text = (SHARED_DIR / "db.js").read_text(encoding="utf-8")
    sync_platforms(shared_app_text, db_text)
    sync_cloudflare((REPO_ROOT / "schema.sql").read_text(encoding="utf-8"))
    sync_entry_env_keys()
    check_schema_refs()
    return 0


if __name__ == "__main__":
    sys.exit(main())
