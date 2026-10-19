/**
 * 数据库适配层（零依赖）——双模式：
 *   1. Turso 模式（默认）：纯 fetch 实现 libsql HTTP v2 /pipeline 接口，Node 18+ 可用；
 *   2. 本地 SQLite 模式：设置环境变量 SQLITE_PATH 后启用，使用 Node 内置 node:sqlite
 *      （需 Node 22.13+），首次启动自动执行同目录 schema.sql 建表，适合 VPS 离线自托管。
 *
 * 对上层提供与 Cloudflare D1 一致的最小接口（本项目 app.js 实际用到的全部方法）：
 *   env.DB.prepare(sql).bind(...args) → { all(), first(), run() }
 *     all()   → { results: [行对象] }         行对象按列名取值
 *     first() → 行对象（无行时为 null）
 *     run()   → { meta: { changes, last_row_id } }
 *
 * 使用的环境变量：
 *   SQLITE_PATH        — 本地 SQLite 数据库文件路径（设置后优先生效，忽略 Turso）
 *   TURSO_DATABASE_URL — 形如 libsql://<库名>-<组织>.turso.io（https:// 开头亦可）
 *   TURSO_AUTH_TOKEN   — Turso 数据库访问令牌
 *
 * 绑定参数类型映射（与 D1 行为一致）：
 *   null / undefined → NULL；string → text；整数 number / bigint → integer；
 *   小数 number → float；boolean → integer（1/0）；其余类型直接报错。
 * 结果值映射：integer / float → number；text → string；null → null。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/* JS 值 → libsql v2 pipeline 参数对象 */
function encodeValue(v) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? { type: "integer", value: String(v) }
      : { type: "float", value: String(v) };
  }
  if (typeof v === "bigint") return { type: "integer", value: v.toString() };
  if (typeof v === "string") return { type: "text", value: v };
  throw new Error("不支持的 SQL 绑定参数类型: " + typeof v);
}

/* libsql v2 值对象 → JS 值 */
function decodeValue(cell) {
  if (!cell || cell.type === "null") return null;
  if (cell.type === "integer" || cell.type === "float") return Number(cell.value);
  if (cell.type === "text") return cell.value;
  if (cell.type === "blob") return cell.base64 || ""; /* 本项目无 blob 列，仅兜底透传 base64 */
  return null;
}

/* 单条语句：D1 风格链式接口（bind 可省略，可重复调用以覆盖参数） */
class TursoStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async all() {
    const r = await this.db.execute(this.sql, this.args);
    return { results: r.rows };
  }
  async first() {
    const r = await this.db.execute(this.sql, this.args);
    return r.rows.length ? r.rows[0] : null;
  }
  async run() {
    const r = await this.db.execute(this.sql, this.args);
    return { meta: { changes: r.changes, last_row_id: r.lastRowId } };
  }
}

export class TursoDatabase {
  constructor(url, token) {
    if (!url || !token) {
      throw new Error("缺少 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN 环境变量（Turso 控制台创建数据库后可获取）");
    }
    /* libsql:// 统一转为 https://，再拼接 v2 pipeline 端点 */
    const httpsUrl = String(url).trim().replace(/^libsql:\/\//i, "https://");
    if (!/^https:\/\/.+$/i.test(httpsUrl)) {
      throw new Error("TURSO_DATABASE_URL 格式不正确，应为 libsql://<库名>-<组织>.turso.io");
    }
    this.endpoint = httpsUrl.replace(/\/+$/, "") + "/v2/pipeline";
    this.token = String(token).trim();
  }

  prepare(sql) {
    return new TursoStatement(this, String(sql));
  }

  /* 执行单条语句：每次独立 pipeline（execute + close）；本项目无事务/批量需求 */
  async execute(sql, args) {
    let resp;
    try {
      resp = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + this.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requests: [
            { type: "execute", stmt: { sql: sql, args: args.map(encodeValue) } },
            { type: "close" },
          ],
        }),
      });
    } catch (e) {
      throw new Error("Turso 网络请求失败: " + (e && e.message));
    }
    if (!resp.ok) {
      const text = await resp.text().catch(function () { return ""; });
      throw new Error("Turso HTTP " + resp.status + ": " + text.slice(0, 300));
    }
    const data = await resp.json();
    const first = data && data.results && data.results[0];
    if (!first) throw new Error("Turso 响应缺少 results");
    if (first.type === "error") throw new Error("Turso 语句执行失败: " + (first.error || "unknown"));
    const result = first.response && first.response.result;
    if (!result) throw new Error("Turso 响应缺少 result");
    const cols = (result.cols || []).map(function (c) { return c && c.name; });
    const rows = (result.rows || []).map(function (row) {
      const obj = {};
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = decodeValue(row[i]);
      return obj;
    });
    return {
      rows: rows,
      changes: result.affected_row_count || 0,
      lastRowId: result.last_insert_rowid != null ? Number(result.last_insert_rowid) : 0,
    };
  }
}

/* 便捷工厂：从 env 风格对象（键值均为字符串）创建 Turso 数据库实例 */
export function createTursoDb(env) {
  return new TursoDatabase(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN);
}

/* ---------------- 本地 SQLite 适配层（node:sqlite，Node 22.13+） ---------------- */

/* JS 值 → node:sqlite 绑定参数（布尔转 1/0，与 Turso 适配层行为一致） */
function encodeLocalValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" || typeof v === "string") return v;
  throw new Error("不支持的 SQL 绑定参数类型: " + typeof v);
}

export class LocalDatabase {
  constructor(path) {
    /* node:sqlite 自 Node 22.5 起提供（22.13+ 免实验标志）；Turso 模式不受影响，
     * 故用 createRequire 惰性加载，避免旧 Node 上模块导入即报错 */
    const require = createRequire(import.meta.url);
    let DatabaseSync;
    try {
      ({ DatabaseSync } = require("node:sqlite"));
    } catch (e) {
      throw new Error("本地 SQLite 模式需要 Node 22.13+（当前 " + process.version + "）；或改用 Turso 模式");
    }
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA journal_mode = WAL;");
    this.sqlite.exec("PRAGMA busy_timeout = 5000;");
    /* 首次启动自动建表：执行同目录 schema.sql（全部 IF NOT EXISTS，幂等） */
    const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
    this.sqlite.exec(schema);
    /* 旧库兼容：新库建表已含 deleted_at，旧库在此补列（已存在则忽略错误） */
    try { this.sqlite.exec("ALTER TABLE messages ADD COLUMN deleted_at TEXT"); } catch (e) {}
    this.stmts = new Map(); /* sql → StatementSync 缓存 */
  }

  prepare(sql) {
    return new LocalStatement(this, String(sql));
  }

  statement(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.sqlite.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }
}

class LocalStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async all() {
    const rows = this.db.statement(this.sql).all(...this.args.map(encodeLocalValue));
    return { results: rows };
  }
  async first() {
    const rows = this.db.statement(this.sql).all(...this.args.map(encodeLocalValue));
    return rows.length ? rows[0] : null;
  }
  async run() {
    const r = this.db.statement(this.sql).run(...this.args.map(encodeLocalValue));
    return { meta: { changes: Number(r.changes) || 0, last_row_id: Number(r.lastInsertRowid) || 0 } };
  }
}

/* 统一入口工厂：设置 SQLITE_PATH 用本地 SQLite，否则用 Turso */
export function createDb(env) {
  if (env.SQLITE_PATH) return new LocalDatabase(env.SQLITE_PATH);
  return new TursoDatabase(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN);
}
