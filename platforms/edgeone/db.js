/**
 * Turso 数据库适配层（零依赖，纯 fetch 实现 libsql HTTP v2 /pipeline 接口）
 *
 * 对上层提供与 Cloudflare D1 一致的最小接口（本项目 worker.js 实际用到的全部方法）：
 *   env.DB.prepare(sql).bind(...args) → { all(), first(), run() }
 *     all()   → { results: [行对象] }         行对象按列名取值
 *     first() → 行对象（无行时为 null）
 *     run()   → { meta: { changes, last_row_id } }
 *   env.DB.batchAtomic(statements) → { results: [{ changes, last_row_id, rows }] }（原子事务，见文末）
 *
 * 使用的环境变量：
 *   TURSO_DATABASE_URL — 形如 libsql://<库名>-<组织>.turso.io（https:// 开头亦可）
 *   TURSO_AUTH_TOKEN   — Turso 数据库访问令牌
 *
 * 绑定参数类型映射（与 D1 行为一致）：
 *   null / undefined → NULL；string → text；整数 number / bigint → integer；
 *   小数 number → float；boolean → integer（1/0）；其余类型直接报错。
 * 结果值映射：integer / float → number；text → string；null → null；
 *   blob → base64 字符串（本项目无 blob 列，仅兜底透传）。
 */

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
 *   phase            → "prepare"|"begin"|"execute"|"commit"|"rollback"|"verify"，用于日志定位；
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

/* 入参规范化：非数组/缺 sql/args 非数组 → 在「发出任何请求之前」失败（prepare 阶段，FAILED） */
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
   证据等级：协议原文只规定「非 null 时后续请求改用该绝对 URL」，具体拼装方式为设计推断，待 L3 真库验证。 */
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
      /* 三态分离：①协议原文——HTTP 错误后流已失效；②「事务未提交」仅为本地结构性判断
         （COMMIT 从未发出，非服务端答复）；③未执行 ROLLBACK，回滚未直接确认 ⇒ 保留 FAILED */
      throw new AtomicBatchError("FAILED", "execute", describeSendFailure(r));
    }
    if (r.kind === "protocol") {
      /* 200 但响应不可解析：零观测——写语句是否已执行、流与事务状态均无从确认；
         本地仅能结构性确认 COMMIT 尚未发出，不据此断言事务已回滚 ⇒ 状态不可证明（3D-1 #6） */
      throw new AtomicBatchError("UNKNOWN", "execute", describeSendFailure(r));
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
      if (!writeBaton) throw new AtomicBatchError("FAILED", "execute", detail + "（流已关闭；COMMIT 未发出 ⇒ 未提交为结构性判断，回滚未直接确认）");
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
