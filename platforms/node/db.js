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
 *   env.DB.batchAtomic(statements) → { results: [{ changes, last_row_id, rows }] }（原子事务，见下）
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

/* ---------------- 原子事务基础设施（第一提交点） ----------------
 * AtomicBatchError —— 结构化原子批处理错误。两个字段决定调用方行为，不可混淆：
 *   code = "FAILED"  → 数据轴确定「本次事务未提交」（NOT_COMMITTED），调用方可安全重试；
 *   code = "UNKNOWN" → 数据轴无法证明（可能已提交 / 未提交），调用方不得重试、不得对外报成功；
 *   phase            → "prepare"|"begin"|"execute"|"commit"|"rollback"|"conn"|"guard"，用于日志定位；
 *   retryable        → 仅 FAILED 为 true；effectUnproven → 仅 UNKNOWN 为 true。
 * 成功时绝不返回部分结果；失败时绝不伪装成功。
 */
export class AtomicBatchError extends Error {
  constructor(code, phase, detail, cause) {
    super("atomic batch " + (code === "UNKNOWN" ? "状态未知" : "已失败") + "（" + String(phase || "-") + "）: " + String(detail || "-"));
    this.name = "AtomicBatchError";
    this.code = code === "UNKNOWN" ? "UNKNOWN" : "FAILED";
    this.phase = String(phase || "-");
    this.detail = String(detail || "");
    this.retryable = this.code === "FAILED";
    this.effectUnproven = this.code === "UNKNOWN";
    if (cause !== undefined) { try { this.cause = cause; } catch (_) { /* 只读宿主忽略 */ } }
  }
}

/* 入参规范化（Turso）：非数组/缺 sql/args 非数组 → 在「发出任何请求之前」失败（prepare 阶段，FAILED） */
function atomicStatementList(statements) {
  if (!Array.isArray(statements)) throw new AtomicBatchError("FAILED", "prepare", "statements 必须是数组");
  return statements.map(function (s, i) {
    if (!s || typeof s.sql !== "string" || !s.sql) throw new AtomicBatchError("FAILED", "prepare", "第 " + (i + 1) + " 条语句缺少 sql");
    const args = s.args === undefined || s.args === null ? [] : s.args;
    if (!Array.isArray(args)) throw new AtomicBatchError("FAILED", "prepare", "第 " + (i + 1) + " 条语句 args 必须是数组");
    try {
      return { sql: s.sql, args: args.map(encodeValue) }; /* 提前编码：非法绑定类型绝不进入事务 */
    } catch (e) {
      throw new AtomicBatchError("FAILED", "prepare", "第 " + (i + 1) + " 条语句参数无法编码: " + String((e && e.message) || e), e);
    }
  });
}

/* 入参规范化（本地 SQLite）：结构校验 + 参数预编码校验；实际编码仍在执行时进行 */
function localStatementList(statements) {
  if (!Array.isArray(statements)) throw new AtomicBatchError("FAILED", "prepare", "statements 必须是数组");
  return statements.map(function (s, i) {
    if (!s || typeof s.sql !== "string" || !s.sql) throw new AtomicBatchError("FAILED", "prepare", "第 " + (i + 1) + " 条语句缺少 sql");
    const args = s.args === undefined || s.args === null ? [] : s.args;
    if (!Array.isArray(args)) throw new AtomicBatchError("FAILED", "prepare", "第 " + (i + 1) + " 条语句 args 必须是数组");
    try {
      args.forEach(encodeLocalValue);
    } catch (e) {
      throw new AtomicBatchError("FAILED", "prepare", "第 " + (i + 1) + " 条语句参数无法编码: " + String((e && e.message) || e), e);
    }
    return { sql: s.sql, args: args };
  });
}

/* 结果种类判定：兼容规范形态（{type:"ok", response:{type:"execute", result}}）与旧形态（直接带 response.result） */
function streamResultKind(item) {
  if (!item || typeof item !== "object") return "bad";
  if (item.type === "error") return "error";
  if (item.type === "ok") {
    const resp = item.response;
    if (resp && resp.type === "error") return "error";
    return "ok";
  }
  if (item.type === "execute") {
    const resp = item.response || {};
    if (resp.type === "error") return "error";
    return resp.result ? "ok" : "bad";
  }
  return "bad";
}

function streamErrorText(item) {
  const e = (item && item.error) || ((item && item.response) || {}).error;
  if (!e) return "unknown";
  if (typeof e === "string") return e;
  return String(e.message || e.code || "unknown");
}

function mapExecuteResult(item) {
  const resp = item && item.type === "execute" ? item : ((item && item.response) || {});
  const result = resp.result || {};
  const cols = (result.cols || []).map(function (c) { return c && c.name; });
  const rows = (result.rows || []).map(function (row) {
    const obj = {};
    for (let i = 0; i < cols.length; i++) obj[cols[i]] = decodeValue(row[i]);
    return obj;
  });
  return {
    changes: result.affected_row_count || 0,
    last_row_id: result.last_insert_rowid != null ? Number(result.last_insert_rowid) : 0,
    rows: rows,
  };
}

/* 发送失败描述（用于错误 detail；不含任何凭据） */
function describeSendFailure(r) {
  if (r.kind === "http") return "HTTP " + r.status + (r.text ? ": " + r.text : "");
  if (r.kind === "network") return "网络请求失败: " + String((r.error && r.error.message) || r.error);
  return "响应不可解析: " + String((r.error && r.error.message) || r.error);
}

/* base_url 是「基地址」语义（Hrana over HTTP v2）：已含 /v2/pipeline 则直接用，否则按绝对路径拼端点。
   证据等级：协议原文只规定「非 null 时后续请求改用该绝对 URL」，拼装方式为设计推断，待 L3 真库验证。 */
function resolveStreamUrl(baseUrl, currentUrl) {
  if (!baseUrl) return currentUrl;
  try {
    const base = new URL(String(baseUrl), currentUrl);
    if (/\/v2\/pipeline$/.test(base.pathname)) return base.toString();
    return new URL("/v2/pipeline", base).toString();
  } catch (_) {
    return currentUrl;
  }
}

/* COMMIT SQL error 的保守分类正则：
   - COMMIT_NO_TXN_RE：引擎明确答复「已无事务」⇒ 事务已被回滚，NOT_COMMITTED 可确认；
   - COMMIT_BUSY_RE：锁竞争（事务仍可操作）⇒ C-2α，允许同 baton 发一次 ROLLBACK 求确认；
   - 其余一律 C-2γ（UNKNOWN），不复用 baton。 */
const COMMIT_NO_TXN_RE = /no transaction is active|not in a transaction/i;
const COMMIT_BUSY_RE = /busy|locked/i;

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

  /* 单次 pipeline 请求（不抛异常，返回判别式结果，供状态机分类） */
  async _pipeline(url, payload) {
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + this.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return { kind: "network", error: e };
    }
    if (!resp.ok) {
      let text = "";
      try { text = String(await resp.text()).slice(0, 200); } catch (_) { /* 读取失败忽略 */ }
      return { kind: "http", status: resp.status, text: text };
    }
    let data;
    try {
      data = await resp.json();
    } catch (e) {
      return { kind: "protocol", error: e };
    }
    if (!data || !Array.isArray(data.results)) {
      return { kind: "protocol", error: new Error("Turso 响应缺少 results") };
    }
    return { kind: "ok", data: data };
  }

  /* ---------------- 原子批处理（3 个 RTT 的显式事务） ----------------
   * 阶段划分严格遵循 Hrana over HTTP v2：
   *   R1 BEGIN      独占管道（「服务器总是执行所有请求，即使其中一些返回错误」⇒ BEGIN 绝不与写语句同管道）
   *   R2 写语句     一次请求承载全部语句；逐条检查结果（任一 error ⇒ 事务仍打开 ⇒ 同 baton 发 ROLLBACK）
   *   R3 COMMIT     独占管道；只有 200 + 成功结果才能确认已提交（T2）
   * 不发送 close：因为 close 同样「即使 COMMIT 出错也会执行」，会抢在 ROLLBACK 之前关闭流、剥夺可确认性；
   *   成功后的流由服务端按空闲期自行回收（协议原文）。 */
  async batchAtomic(statements) {
    const stmts = atomicStatementList(statements);
    if (!stmts.length) return { results: [] };

    let url = this.endpoint;
    let baton = null;

    /* ---- R1：BEGIN ---- */
    let r = await this._pipeline(url, { baton: null, requests: [{ type: "execute", stmt: { sql: "BEGIN", args: [] } }] });
    if (r.kind !== "ok") {
      /* 写语句尚未发出 ⇒ 提交不可能发生（T1）；连接轴丢弃（baton 未取得或不可信） */
      throw new AtomicBatchError("FAILED", "begin", describeSendFailure(r));
    }
    if (streamResultKind(r.data.results[0]) !== "ok") {
      throw new AtomicBatchError("FAILED", "begin", "BEGIN 失败: " + streamErrorText(r.data.results[0]));
    }
    if (r.data.baton === null || r.data.baton === undefined) {
      /* BEGIN 成功但服务端已关闭流：事务不再存在，写语句无从执行 */
      throw new AtomicBatchError("FAILED", "begin", "BEGIN 成功后未返回 baton（流已关闭）");
    }
    baton = r.data.baton;
    url = resolveStreamUrl(r.data.base_url, url);

    /* ---- R2：写语句 ---- */
    r = await this._pipeline(url, {
      baton: baton,
      requests: stmts.map(function (s) { return { type: "execute", stmt: { sql: s.sql, args: s.args } }; }),
    });
    if (r.kind === "network") {
      /* 无观测：写语句可能已落在未提交事务里。绝不重试、绝不报成功 */
      throw new AtomicBatchError("UNKNOWN", "execute", describeSendFailure(r));
    }
    if (r.kind === "http") {
      /* 4xx/5xx ⇒ 服务端内部错误、流已失效 ⇒ 不会残留未提交事务；且 COMMIT 尚未发出 ⇒ 未提交（T1/T3） */
      throw new AtomicBatchError("FAILED", "execute", describeSendFailure(r));
    }
    if (r.kind === "protocol") {
      /* 200 但响应不可解析：同样未发 COMMIT ⇒ 数据轴确定未提交（T1）；通道丢弃（baton 不可信） */
      throw new AtomicBatchError("FAILED", "execute", describeSendFailure(r));
    }
    let badIdx = -1;
    for (let i = 0; i < stmts.length; i++) {
      const item = r.data.results[i];
      if (streamResultKind(item) !== "ok") { badIdx = i; break; }
    }
    const writeResults = stmts.map(function (s, i) { return mapExecuteResult(r.data.results[i]); });
    const writeBaton = r.data.baton === null || r.data.baton === undefined ? null : r.data.baton;
    const writeUrl = resolveStreamUrl(r.data.base_url, url);
    if (badIdx >= 0) {
      const detail = "第 " + (badIdx + 1) + " 条语句执行失败: " + streamErrorText(r.data.results[badIdx]);
      if (!writeBaton) throw new AtomicBatchError("FAILED", "execute", detail + "（流已关闭，服务端已回滚）");
      throw await this._rollback(writeUrl, writeBaton, "execute", detail);
    }
    if (!writeBaton) {
      /* 写语句全部成功但流被关闭：关闭时未提交事务的处置协议未规定 ⇒ 不得声称成功，也不得声称失败 */
      throw new AtomicBatchError("UNKNOWN", "execute", "写语句成功后服务端关闭流，提交状态无法证明");
    }

    /* ---- R3：COMMIT ---- */
    r = await this._pipeline(writeUrl, { baton: writeBaton, requests: [{ type: "execute", stmt: { sql: "COMMIT", args: [] } }] });
    if (r.kind === "network") {
      /* COMMIT 已发出但完全无观测：一律 UNKNOWN（T2） */
      throw new AtomicBatchError("UNKNOWN", "commit", describeSendFailure(r));
    }
    if (r.kind === "http") {
      /* 协议未规定 HTTP 错误时请求是否已执行 ⇒ UNKNOWN（C-4/C-5） */
      throw new AtomicBatchError("UNKNOWN", "commit", describeSendFailure(r));
    }
    if (r.kind === "protocol") {
      /* 收到 200 却读不懂结果 ⇒ 无法证明 COMMIT 生效 ⇒ UNKNOWN（T2） */
      throw new AtomicBatchError("UNKNOWN", "commit", describeSendFailure(r));
    }
    const commitItem = r.data.results[0];
    if (streamResultKind(commitItem) === "ok") {
      /* 唯一可确认「本次事务已提交」的证据（T2） */
      return { results: writeResults };
    }
    /* COMMIT 返回 SQL error：按第四轮四分类处置（C-2α/β/γ/δ） */
    const msg = streamErrorText(commitItem);
    if (COMMIT_NO_TXN_RE.test(msg)) {
      /* 服务端明确答复事务已不存在 ⇒ 已被回滚 ⇒ NOT_COMMITTED（确定失败） */
      throw new AtomicBatchError("FAILED", "commit", "COMMIT 失败（事务已结束，未提交）: " + msg);
    }
    if (COMMIT_BUSY_RE.test(msg)) {
      /* C-2α：明确失败且事务仍可操作（锁竞争）⇒ 同 baton 发一次 ROLLBACK 以确认回滚 */
      const rbBaton = r.data.baton === null || r.data.baton === undefined ? null : r.data.baton;
      if (!rbBaton) throw new AtomicBatchError("UNKNOWN", "commit", "COMMIT 失败（锁竞争）且 baton 已失效: " + msg);
      throw await this._rollback(resolveStreamUrl(r.data.base_url, writeUrl), rbBaton, "commit", "COMMIT 失败（锁竞争）: " + msg);
    }
    /* C-2γ：失败但状态无法确认 ⇒ UNKNOWN，不复用该 baton */
    throw new AtomicBatchError("UNKNOWN", "commit", "COMMIT 失败且状态无法确认: " + msg);
  }

  /* ROLLBACK 处置（C-2α → C-2β，C-2δ）：仅在「事务仍可能打开」且 baton 可信时调用 */
  async _rollback(url, baton, phase, detail) {
    const r = await this._pipeline(url, { baton: baton, requests: [{ type: "execute", stmt: { sql: "ROLLBACK", args: [] } }] });
    if (r.kind === "ok" && streamResultKind(r.data.results[0]) === "ok") {
      return new AtomicBatchError("FAILED", phase, detail + "（已 ROLLBACK，确认未提交）");
    }
    const why = r.kind === "ok" ? "ROLLBACK 失败: " + streamErrorText(r.data.results[0]) : describeSendFailure(r);
    /* ROLLBACK 失败/无观测 ⇒ 状态不可证明，且不复用该 baton/连接（C-2γ/C-2δ） */
    return new AtomicBatchError("UNKNOWN", "rollback", detail + "；" + why);
  }
}

/* 便捷工厂：从 env 风格对象（键值均为字符串）创建 Turso 数据库实例 */
export function createTursoDb(env) {
  return new TursoDatabase(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN);
}

/* ---------------- 本地 SQLite 适配层（node:sqlite，Node 22.13+） ----------------
 * 连接模型（第一提交点）：单连接 + 连接级 FIFO 队列。
 *   ① 全部运行期 SQL（all/first/run/batchAtomic）统一经 _enqueue 排队，杜绝语句交错；
 *   ② 事务体走事务内专用直连通道 _execDirect，不排队（否则自锁死锁）；事务体全程同步、无 await；
 *   ③ _inTx 不变量：_execDirect 仅允许 _inTx=true 时调用，事务重入一律抛错；
 *   ④ 连接不可用（重建失败）时队列任务「立即 reject」，不挂起；
 *   ⑤ ROLLBACK 失败 → 连接重建（fail-closed）：仅当全部关联语句已显式 finalize 且旧连接
 *      close() 未抛错，才允许重开并置 ready；无法证明关闭 ⇒ _connState="failed"，此后 fail-fast。
 *      判据依据：Node 的 database.close() 是 sqlite3_close_v2() 包装，未 finalize 语句时
 *      只把连接置为 zombie（返回成功但事务/锁未释放），故 close() 不抛异常 ≠ 已释放。
 */

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
    this.path = path;
    this.sqlite = null;
    this.stmts = new Map();   /* sql → StatementSync 缓存（连接重建时必须整体丢弃） */
    this._queue = Promise.resolve(); /* 队列链尾：每个任务都接在链尾之后，保证 FIFO */
    this._inTx = false;       /* 事务不变量：true 期间只允许 _execDirect */
    this._connState = "ready"; /* ready | rebuilding | failed（failed ⇒ 入队即 reject，fail-fast） */
    this._closed = false;
    this._initError = null;    /* 最近一次建连/初始化失败诊断（含半初始化连接清理结果） */
    this._rebuildError = null; /* 最近一次重建失败诊断（关闭不可证明 / 重开失败） */
    this._open();
  }

  /* 建连 + 连接级 PRAGMA + schema 幂等自愈（首次构造与重建共用；幂等，可重复执行）。
   * 初始化任一步失败 ⇒ 明确清理路径：尽最大可能关闭半初始化连接；清理结果与原因写入
   * this._initError 后抛出。清理失败也不得声称资源已释放；半初始化连接绝不进入可用状态。 */
  _open() {
    /* node:sqlite 自 Node 22.5 起提供（22.13+ 免实验标志）；Turso 模式不受影响，
     * 故用 createRequire 惰性加载，避免旧 Node 上模块导入即报错 */
    const require = createRequire(import.meta.url);
    let DatabaseSync;
    try {
      ({ DatabaseSync } = require("node:sqlite"));
    } catch (e) {
      throw new Error("本地 SQLite 模式需要 Node 22.13+（当前 " + process.version + "）；或改用 Turso 模式");
    }
    let conn = null;
    try {
      conn = new DatabaseSync(this.path);
      this._initConn(conn);
      this.sqlite = conn;      /* 只有初始化全部成功才交给 this.sqlite（不允许半初始化连接被当成可用） */
      this._initError = null;
      return;
    } catch (e) {
      let cleanup = conn ? "ok" : "n/a（连接未创建）";
      if (conn) {
        try { conn.close(); } catch (e2) { cleanup = "close 失败: " + String((e2 && e2.message) || e2); }
      }
      this.sqlite = null;      /* 半初始化连接不得被对象状态误认为可用连接 */
      this._initError = String(this.path) + " 初始化失败（半初始化连接清理: " + cleanup + "）: " + String((e && e.message) || e);
      throw e;
    }
  }

  /* 连接级初始化步骤（独立方法，失败可定位；只接收 conn，不读写 this.sqlite） */
  _initConn(conn) {
    conn.exec("PRAGMA journal_mode = WAL;");
    conn.exec("PRAGMA busy_timeout = 5000;");
    /* 首次启动自动建表：执行同目录 schema.sql（全部 IF NOT EXISTS，幂等） */
    const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
    conn.exec(schema);
    /* 旧库兼容：新库建表已含 deleted_at，旧库在此补列（已存在则忽略错误） */
    try { conn.exec("ALTER TABLE messages ADD COLUMN deleted_at TEXT"); } catch (e) {}
    try { conn.exec("ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
    try { conn.exec("ALTER TABLE messages ADD COLUMN read_at TEXT"); } catch (e) {}
  }

  /* 连接重建（ROLLBACK 失败后唯一的恢复尝试；fail-closed，不做任何自动重试；全程同步，队列任务无法插入）：
   *   1 标记 rebuilding（新入队任务会看到非 ready）  2 取出缓存语句并清空缓存（只解除引用，不等于 finalize）
   *   3 逐条显式 finalize：任一语句无 close() 或 finalize 抛错 ⇒ 关闭不可证明
   *   4 尽力关闭旧连接：成功/抛错都不构成"已释放"证明（close() 是 sqlite3_close_v2 包装）
   *   5 仅当「全部语句已 finalize 且 close() 未抛」才允许 _open() 与 ready，否则 failed（不创建同文件新连接）
   *   6 _open() 失败 ⇒ failed（半初始化连接由 _open 自身清理）
   * failed 后：所有入队任务立即 reject，普通 SQL 不得再触碰连接，需进程重启恢复。 */
  _rebuild() {
    this._connState = "rebuilding";
    const old = this.sqlite;
    this.sqlite = null;
    const cached = Array.from(this.stmts.values());
    this.stmts.clear();

    let proof = "";   /* 非空 ⇒ 旧连接关闭不可证明 */
    for (const s of cached) {
      if (typeof s.close !== "function") {
        proof = "缓存语句无 close()，关联语句无法 finalize（" + cached.length + " 条，Node " + process.version + "）";
        break;
      }
      try { s.close(); } catch (e) {
        proof = "StatementSync.close() 失败: " + String((e && e.message) || e);
        break;
      }
    }

    let closeNote = "ok";
    if (old) {
      try { old.close(); } catch (e) { closeNote = "close() 抛错: " + String((e && e.message) || e); }
    }

    if (proof || closeNote !== "ok") {
      this._connState = "failed";
      this._inTx = false;
      this._rebuildError = [proof, closeNote !== "ok" ? closeNote : ""].filter(Boolean).join("；") || "未知原因";
      return false;
    }

    try {
      this._open();
      this._connState = "ready";
      this._inTx = false;
      this._rebuildError = null;
      return true;
    } catch (e) {
      this._connState = "failed";
      this._inTx = false;
      this._rebuildError = "重开连接失败: " + String((e && e.message) || e) + (this._initError ? "；" + this._initError : "");
      return false;
    }
  }

  /* M-1 / R3-01：显式关闭入口。必须在后台任务全部收敛后由 server.mjs 调用。
     置 _closed=true 让下面 _enqueue 的 fail-fast 真正生效：关闭后若仍有后台任务
     尝试访问 DB（dispatchNotify → loadNotifyRows），会拿到明确的 AtomicBatchError，
     并留下 db_access_after_close 日志，而不是在已关闭连接上抛原生错误后被
     loadNotifyRows 的 catch → return null 静默降级成「配置回退到环境变量」。 */
  close() {
    if (this._closed) return false;
    this._closed = true;
    const conn = this.sqlite;
    this.sqlite = null;
    try {
      /* 先显式 finalize 缓存语句，避免 sqlite3_close_v2 留下 zombie 连接 */
      for (const s of this.stmts.values()) {
        try { if (s && typeof s.close === "function") s.close(); } catch (_) {}
      }
      this.stmts.clear();
      if (conn) conn.close();
      return true;
    } catch (e) {
      this._connState = "failed";
      this._rebuildError = "close() 失败: " + String((e && e.message) || e);
      try { console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "db_close_failed", message: this._rebuildError })); } catch (_) {}
      return false;
    }
  }

  /* 队列入口：所有运行期 SQL 的唯一调度点（FIFO；连接不可用时立即 reject） */
  _enqueue(task) {
    if (this._closed) {
      try { console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "db_access_after_close", note: "后台任务在数据库关闭后仍尝试访问" })); } catch (_) {}
      return Promise.reject(new AtomicBatchError("FAILED", "conn", "数据库已关闭"));
    }
    if (this._connState === "failed") return Promise.reject(new AtomicBatchError("FAILED", "conn", "本地 SQLite 连接不可用（" + (this._rebuildError || this._initError || "连接重建失败") + "）；需进程重启恢复"));
    const run = this._queue.then(() => this._runTask(task));
    /* 链尾接住 rejection：单个任务失败不得污染后续任务的调度链 */
    this._queue = run.then(function () {}, function () {});
    return run;
  }

  _runTask(task) {
    if (this._connState !== "ready") throw new AtomicBatchError("FAILED", "conn", "连接不可用（" + this._connState + "）");
    return task();
  }

  /* 事务内专用直连通道：不排队（避免与队列链自锁）；仅 _inTx=true 时可用（不变量） */
  _execDirect(sql, args) {
    if (!this._inTx) throw new AtomicBatchError("FAILED", "guard", "_execDirect 仅允许在事务体内调用（_inTx 不变量）");
    if (this._connState !== "ready" || !this.sqlite) throw new AtomicBatchError("FAILED", "conn", "连接不可用（" + this._connState + "）");
    const r = this.statement(sql).run(...(args || []).map(encodeLocalValue));
    return { changes: Number(r.changes) || 0, last_row_id: Number(r.lastInsertRowid) || 0 };
  }

  prepare(sql) {
    return new LocalStatement(this, String(sql));
  }

  statement(sql) {
    /* 连接态非 ready 时禁止任何访问（失败后不得绕过状态触碰旧连接/半初始化连接） */
    if (this._connState !== "ready") throw new AtomicBatchError("FAILED", "conn", "连接不可用（" + this._connState + "），需进程重启恢复");
    let s = this.stmts.get(sql);

    if (!s) {
      if (!this.sqlite) throw new AtomicBatchError("FAILED", "conn", "连接不可用");
      s = this.sqlite.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /* 原子批处理：BEGIN → 逐条执行 → COMMIT；失败则 ROLLBACK（失败再走连接重建八步） */
  async batchAtomic(statements) {
    const stmts = localStatementList(statements);
    if (!stmts.length) return { results: [] };
    return this._enqueue(() => this._runAtomic(stmts));
  }

  _runAtomic(stmts) {
    /* 只在队列任务内调用；事务体全程同步（无 await），因此任何其他队列任务都不可能插入 */
    if (this._inTx) throw new AtomicBatchError("FAILED", "guard", "检测到事务重入（_inTx 已为 true）");
    this._inTx = true;
    let begun = false;
    const results = [];
    try {
      this._execDirect("BEGIN", []);
      begun = true;
      for (const s of stmts) {
        const r = this._execDirect(s.sql, s.args);
        results.push({ changes: r.changes, last_row_id: r.last_row_id, rows: [] });
      }
      this._execDirect("COMMIT", []);
      return { results: results };
    } catch (e) {
      const detail = String((e && e.message) || e);
      if (!begun) throw new AtomicBatchError("FAILED", "begin", detail, e);
      /* 失败路径：尽量确认回滚 */
      let rollbackErr = null;
      try {
        this._execDirect("ROLLBACK", []);
      } catch (e2) {
        rollbackErr = e2;
      }
      if (!rollbackErr) throw new AtomicBatchError("FAILED", "execute", detail + "（已 ROLLBACK，确认未提交）", e);
      /* ROLLBACK 失败 ⇒ 事务结果不可判定 ⇒ 连接重建（fail-closed）；数据面统一按 UNKNOWN 门控（第四轮 C-2δ 裁定） */
      const rebuilt = this._rebuild();
      throw new AtomicBatchError("UNKNOWN", "rollback", detail + "；ROLLBACK 失败: " + String((rollbackErr && rollbackErr.message) || rollbackErr) + (rebuilt
        ? "（事务提交状态未知；连接重建完成且旧连接关闭可证明，但不得据此推断事务结果）"
        : "（事务结果未知；本地 SQLite 连接无法证明已安全重建，已进入不可用状态，后续任务 fail-fast，需进程重启恢复；原因: " + (this._rebuildError || "未知") + "）"), e);
    } finally {
      this._inTx = false;
    }
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
    return this.db._enqueue(() => {
      const rows = this.db.statement(this.sql).all(...this.args.map(encodeLocalValue));
      return { results: rows };
    });
  }
  async first() {
    return this.db._enqueue(() => {
      const rows = this.db.statement(this.sql).all(...this.args.map(encodeLocalValue));
      return rows.length ? rows[0] : null;
    });
  }
  async run() {
    return this.db._enqueue(() => {
      const r = this.db.statement(this.sql).run(...this.args.map(encodeLocalValue));
      return { meta: { changes: Number(r.changes) || 0, last_row_id: Number(r.lastInsertRowid) || 0 } };
    });
  }
}

/* 统一入口工厂：设置 SQLITE_PATH 用本地 SQLite，否则用 Turso */
export function createDb(env) {
  if (env.SQLITE_PATH) return new LocalDatabase(env.SQLITE_PATH);
  return new TursoDatabase(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN);
}
