/**
 * SMSToWeb 零依赖测试套件（需 Node 22.13+，用到内置 node:sqlite）
 * 直接测生成的平台无关核心 platforms/node/app.js 的 fetchApp / runCron / handleCronRequest，
 * 覆盖：收发、去重、列表、来源筛选、长轮询、删除、正文截断、定时清理、cron 鉴权、
 *       登录鉴权、http cookie 降级、防锁死、写入限速、管理页开关 UI、
*       令牌边界（并发重名/轮换审计/前缀不泄漏/节流端到端/开关边界值）、令牌管理与登录限速、
*       令牌有效期与备注（过期 403/格式校验/轮换透传/旧库补列自愈）、页脚版本号、
*       会话时长可配置（settings 表 / GET·PUT /api/settings / 默认回退 / 登录 Max-Age 同步）、
*       浏览器独立会话时长（登录声明 session_ttl_minutes 优先 / 缺省回退全局 / 边界与非法拒绝 / 浏览器隔离）。
 * 运行：node tests/run.mjs   （退出码 0=全过，1=有失败，2=异常）
 */
import { fetchApp, runCron, handleCronRequest, createToken, listTokens, findTokenByHash, revokeToken, rotateToken, touchLastUsed, atomicBatch, AtomicBatchError } from "../platforms/node/app.js";
import { LocalDatabase, TursoDatabase, AtomicBatchError as DbAtomicBatchError } from "../platforms/node/db.js";
import { TursoDatabase as SharedTursoDatabase, AtomicBatchError as SharedAtomicBatchError } from "../platforms/shared/db.js";
import { rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";

const DB = join(tmpdir(), "smstoweb_test_" + process.pid + ".db");
let pass = 0, fail = 0;
const failed = [];
function check(cond, name) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; failed.push(name); console.log("  FAIL " + name); }
}
function group(t) { console.log("\n# " + t); }
function cleanup(stage) {
  let failed = 0;
  for (const suf of ["", "-wal", "-shm", "-journal"]) {
    try { rmSync(DB + suf, { force: true }); }
    catch (e) {
      failed++;
      console.error("[cleanup] " + stage + " 清理失败: path=" + DB + suf + " code=" + (e && e.code) + " message=" + (e && e.message));
    }
  }
  if (failed) console.error("[cleanup] " + stage + " 清理结果=FAILED（" + failed + " 个文件未删除）");
  return failed === 0;
}
function closeMainDb(stage) {
  if (!db || !db.sqlite) return false;
  try { db.sqlite.close(); return true; }
  catch (e) {
    console.error("[cleanup] " + stage + " 关闭主库连接失败: code=" + (e && e.code) + " message=" + (e && e.message));
    return false;
  }
}
function cleanupPath(p) {
  for (const suf of ["", "-wal", "-shm", "-journal"]) { try { rmSync(p + suf, { force: true }); } catch (_) {} }
}
/* 最小 D1 风格包装：包住裸 node:sqlite 库（绕过 LocalDatabase 构造期的自动建表），验证运行时自愈与数据层本身。
   batch 按 D1 官方语义实现：整批即一个事务，任一语句失败整体回滚。 */
function makeD1(raw) {
  return {
    prepare(sql) {
      const stmt = raw.prepare(sql);
      let args = [];
      const st = {
        bind: (...a) => { args = a; return st; },
        all: async () => ({ results: stmt.all(...args) }),
        first: async () => { const rows = stmt.all(...args); return rows.length ? rows[0] : null; },
        run: async () => { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) || 0, last_row_id: Number(r.lastInsertRowid) || 0 } }; },
        /* 仅供 batch 读取（D1 真实实现为内部字段，测试桩显式暴露） */
        _stmt: stmt,
        get _args() { return args; },
      };
      return st;
    },
    batch: async (stmts) => {
      raw.exec("BEGIN");
      try {
        const out = stmts.map(function (st) {
          const r = st._stmt.run(...st._args);
          return { results: [], success: true, meta: { changes: Number(r.changes) || 0, last_row_id: Number(r.lastInsertRowid) || 0 } };
        });
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        try { raw.exec("ROLLBACK"); } catch (_) {}
        throw e;
      }
    },
  };
}

/* 伪 Turso 后端：把 v2 pipeline 请求翻译到真实 node:sqlite 执行（传输层走 fetch Mock）。
   用于既验证适配层编解码，又让契约测试跑在真 SQL 语义上——传输是假的，SQL 行为是真的。 */
function cellV(v) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "bigint") return { type: "integer", value: v.toString() };
  if (typeof v === "number") return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: String(v) };
  if (typeof v === "string") return { type: "text", value: v };
  if (v instanceof Uint8Array) return { type: "blob", base64: Buffer.from(v).toString("base64") };
  return { type: "text", value: String(v) };
}
function makeFakeTurso(dbPath) {
  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA journal_mode = WAL;");
  const streams = new Map();      /* 有效 baton → true（Hrana 流会话） */
  let seq = 0;
  const fake = {
    raw: raw,
    requests: [],                 /* 每次请求的 { url, baton, sqls }，供协议形状断言 */
    emitBaseUrl: null,            /* 设置后：首个响应返回该 base_url（验证粘性路由） */
    closeAfter: null,             /* 设置数字 N：第 N 个响应返回 baton=null（模拟服务端关流） */
    fetch: async function (url, opts) {
      let payload;
      try { payload = JSON.parse(String(opts.body)); } catch (_) {
        return new Response(JSON.stringify({ results: [{ type: "error", error: "bad json body" }] }), { status: 200 });
      }
      const reqBaton = payload.baton === undefined || payload.baton === null ? null : String(payload.baton);
      let baton = reqBaton;
      if (baton === null) {
        baton = "b" + (++seq);
        streams.set(baton, true);
      } else if (!streams.has(baton)) {
        /* 未知/过期 baton：服务端关流并报错（协议语义） */
        return new Response(JSON.stringify({ baton: null, base_url: null, results: [{ type: "error", error: "baton expired" }] }), { status: 200 });
      }
      fake.requests.push({ url: String(url), baton: reqBaton, sqls: (payload.requests || []).map(function (r) { return r.type === "execute" ? String((r.stmt || {}).sql) : r.type; }) });
      const out = [];
      for (const req of payload.requests || []) {
        if (req.type === "close") { streams.delete(baton); out.push({ type: "ok", response: { type: "close" } }); continue; }
        if (req.type !== "execute") { out.push({ type: "ok", response: { type: req.type } }); continue; }
        const stmt = req.stmt || {};
        try {
          const args = (stmt.args || []).map(function (a) {
            if (!a || a.type === "null") return null;
            if (a.type === "integer") return Number(a.value);
            if (a.type === "float") return Number(a.value);
            if (a.type === "text") return a.value;
            if (a.type === "blob") return Buffer.from(a.base64 || "", "base64");
            return null;
          });
          const s = raw.prepare(stmt.sql);
          const stripped = String(stmt.sql).replace(/--[^\n]*\n?/g, "").trim();
          const isReader = /^(select|pragma|with|values)/i.test(stripped) || /\breturning\b/i.test(stripped);
          if (isReader) {
            const rows = s.all(...args);
            const cols = rows.length ? Object.keys(rows[0]) : [];
            out.push({ type: "ok", response: { type: "execute", result: {
              cols: cols.map(function (n) { return { name: n }; }),
              rows: rows.map(function (r) { return cols.map(function (n) { return cellV(r[n]); }); }),
              affected_row_count: 0, last_insert_rowid: 0 } } });
          } else {
            const r = s.run(...args);
            out.push({ type: "ok", response: { type: "execute", result: {
              cols: [], rows: [], affected_row_count: Number(r.changes) || 0,
              last_insert_rowid: Number(r.lastInsertRowid) || 0 } } });
          }
        } catch (e) {
          /* 语句级错误按协议形态返回（其余语句仍会被服务端执行） */
          out.push({ type: "error", error: String((e && e.message) || e) });
        }
      }
      let respBaton = baton;
      let baseUrl = null;
      if (fake.emitBaseUrl && fake.requests.length === 1) baseUrl = fake.emitBaseUrl;
      if (fake.closeAfter !== null && fake.requests.length >= fake.closeAfter) { streams.delete(baton); respBaton = null; }
      else if (streams.has(baton)) {
        /* 协议要求：响应 baton 必须与请求 baton 不同 */
        streams.delete(baton);
        respBaton = "b" + (++seq);
        streams.set(respBaton, true);
      } else {
        respBaton = null;
      }
      return new Response(JSON.stringify({ baton: respBaton, base_url: baseUrl, results: out }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  };
  return fake;
}

/* TEST-DB-001 启动预清理：实例化前仅删除本 PID 主库精确路径及其 -wal/-shm/-journal 配套文件（防 PID 复用污染历史数据） */
if (!cleanup("启动预清理")) {
  console.error("[TEST-DB-001] 启动预清理失败，拒绝打开测试数据库，测试终止");
  process.exit(1);
}
const db = new LocalDatabase(DB);
function env(extra) {
  return Object.assign({ DB: db, RECEIVE_TOKEN: "tok", ENABLE_AUTH: "", ADMIN_PASSWORD: "", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30", PLATFORM: "test" }, extra || {});
}
function R(method, path, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  const init = { method: method, headers: headers };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  }
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  return new Request("http://localhost" + path, init);
}
async function call(method, path, e, opts) {
  const r = await fetchApp(R(method, path, opts), e);
  let data = null;
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data: data, setCookie: r.headers.get("Set-Cookie") || "" };
}

async function main() {
  const e0 = env();

  /* ===== 第 0 步组：schema 幂等自愈 ===== */
  group("schema 幂等自愈（旧库缺列 → 运行时自动补列，不再 500）");
  {
    const legacyPath = join(tmpdir(), "smstoweb_legacy_" + process.pid + ".db");
    cleanupPath(legacyPath);
    /* 复刻 2026-10-22 故障现场：messages 表无 deleted_at/starred/read_at（软删除功能上线前的旧库） */
    const raw = new DatabaseSync(legacyPath);
    raw.exec(`CREATE TABLE devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device TEXT NOT NULL DEFAULT 'unknown',
      sim TEXT NOT NULL DEFAULT '',
      alias TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    raw.exec("CREATE UNIQUE INDEX idx_devices_key ON devices(device, sim)");
    raw.exec(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL REFERENCES devices(id),
      sender TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'sms',
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    raw.exec("INSERT INTO devices(device, sim) VALUES ('旧手机','13800000000')");
    raw.exec("INSERT INTO messages(device_id, sender, content, received_at, source) VALUES (1,'10086','旧库验证码 654321','2026-11-01 10:00:00','sms')");
    const colsBefore = raw.prepare("PRAGMA table_info(messages)").all().map(c => String(c.name));
    /* 最小 D1 风格包装：直接包住裸库（绕过 LocalDatabase 构造期的自动建表），验证 worker.js 的 ensureSchema 本身 */
    const legacyDb = {
      prepare(sql) {
        const stmt = raw.prepare(sql);
        let args = [];
        const st = {
          bind: (...a) => { args = a; return st; },
          all: async () => ({ results: stmt.all(...args) }),
          first: async () => { const rows = stmt.all(...args); return rows.length ? rows[0] : null; },
          run: async () => { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) || 0, last_row_id: Number(r.lastInsertRowid) || 0 } }; },
        };
        return st;
      },
    };
    const envL = { DB: legacyDb, RECEIVE_TOKEN: "tok", ENABLE_AUTH: "", ADMIN_PASSWORD: "", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30" };
    check(!colsBefore.includes("starred") && !colsBefore.includes("deleted_at") && !colsBefore.includes("read_at"), "自愈前旧库确无 starred/deleted_at/read_at 列（故障现场成立）");
    const r1 = await call("GET", "/api/messages", envL);
    check(r1.status === 200 && r1.data && Array.isArray(r1.data.list), "缺列旧库列表接口 → 200（自愈生效，不再 500）");
    const colsAfter = raw.prepare("PRAGMA table_info(messages)").all().map(c => String(c.name));
    check(colsAfter.includes("deleted_at") && colsAfter.includes("starred") && colsAfter.includes("read_at"), "缺失列已被自动补齐（PRAGMA table_info 前后对比）");
    const r2 = await call("GET", "/api/messages", envL);
    check(r2.status === 200 && r2.data && r2.data.list.length >= 1 && r2.data.list.some(m => m.content === "旧库验证码 654321"), "自愈后二次请求幂等 → 200 且旧数据可读");
    try { raw.close(); } catch (_) {}
    cleanupPath(legacyPath);
  }

  /* ===== 第 4 步组：旧库 + 新代码端到端 ===== */
  group("旧库 + 新代码端到端（第 4 步：legacy 无 tokens 表 → 首请求自愈 → 令牌全链路可用）");
  {
    const upPath = join(tmpdir(), "smstoweb_upgrade_" + process.pid + ".db");
    cleanupPath(upPath);
    /* 复刻存量用户现场：老版本建的库（devices + messages，无 tokens 表，含一条历史数据） */
    const raw = new DatabaseSync(upPath);
    raw.exec(`CREATE TABLE devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device TEXT NOT NULL DEFAULT 'unknown',
      sim TEXT NOT NULL DEFAULT '',
      alias TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    raw.exec("CREATE UNIQUE INDEX idx_devices_key ON devices(device, sim)");
    raw.exec(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL REFERENCES devices(id),
      sender TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'sms',
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    raw.exec("INSERT INTO devices(device, sim) VALUES ('老手机','13900000000')");
    raw.exec("INSERT INTO messages(device_id, sender, content, received_at, source) VALUES (1,'10086','升级前历史短信','2026-11-01 09:00:00','sms')");
    check(raw.prepare("PRAGMA table_info(tokens)").all().length === 0, "升级前现场成立：旧库无 tokens 表");
    /* 独立 XFF 桶：本组含 receive 写调用，避开与其他组共用的默认 IP 限速桶 */
    const XFFU = { "X-Forwarded-For": "203.0.113.88, 10.0.0.8" };
    const legacyDb = {
      prepare(sql) {
        const stmt = raw.prepare(sql);
        let args = [];
        const st = {
          bind: (...a) => { args = a; return st; },
          all: async () => ({ results: stmt.all(...args) }),
          first: async () => { const rows = stmt.all(...args); return rows.length ? rows[0] : null; },
          run: async () => { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) || 0, last_row_id: Number(r.lastInsertRowid) || 0 } }; },
        };
        return st;
      },
    };
    const envU = { DB: legacyDb, RECEIVE_TOKEN: "legacy-env-tok", ENABLE_AUTH: "true", ADMIN_PASSWORD: "secret", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30" };
    const HU = (extra) => Object.assign({}, XFFU, extra || {});

    /* 1) 升级动作 = 仅换代码：首个请求触发 ensureSchema 自动建表/建索引 */
    let r = await call("POST", "/api/login", envU, { headers: HU(), body: { password: "secret" } });
    check(r.status === 200 && /sms_auth=/.test(r.setCookie), "旧库登录 → 200（入口 ensureSchema 自愈已随首请求完成）");
    const ckU = "sms_auth=" + ((r.setCookie.match(/sms_auth=([^;]*)/) || [])[1] || "");
    const tokCols = raw.prepare("PRAGMA table_info(tokens)").all().map(c => String(c.name));
    check(tokCols.join(",") === "id,name,token_hash,token_prefix,created_at,last_used_at,revoked_at,expires_at,note", "首请求后 tokens 表自动建齐（9 列，含 expires_at/note，无明文列）");
    const idxU = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tokens'").all().map(i => String(i.name));
    check(idxU.includes("idx_tokens_hash") && idxU.includes("idx_tokens_name_active") && idxU.includes("idx_tokens_revoked"), "tokens 三索引自动建齐");

    /* 2) 管理与接入链路「能用」（不只不 500）：建令牌 → 收发 → 吊销 → 403 */
    r = await call("POST", "/api/tokens", envU, { headers: HU(), body: { name: "legacy-phone" }, cookie: ckU });
    check(r.status === 200 && r.data.success && typeof r.data.token === "string", "旧库上创建命名令牌 → 200 返回一次性明文");
    const upTok = r.data.token, upId = r.data.id;
    r = await call("POST", "/api/receive", envU, { headers: HU({ "X-Receive-Token": upTok }), body: { name: "老手机", sim: "13900000000", from: "10086", content: "升级后第一条短信", time: "2026-11-02 12:00:00" } });
    check(r.status === 200, "库内令牌 /api/receive → 200（升级后接入链路可用）");
    r = await call("POST", "/api/receive", envU, { headers: HU({ "X-Receive-Token": "legacy-env-tok" }), body: { name: "老手机", sim: "13900000000", from: "10086", content: "环境变量兜底短信", time: "2026-11-02 12:01:00" } });
    check(r.status === 200, "环境变量兜底令牌 → 200（升级不破坏存量接入）");
    r = await call("POST", "/api/tokens/revoke", envU, { headers: HU(), body: { id: upId }, cookie: ckU });
    check(r.status === 200 && r.data.revoked === true, "吊销 → 200（泄露止血能力在旧库上可用）");
    r = await call("POST", "/api/receive", envU, { headers: HU({ "X-Receive-Token": upTok }), body: { name: "老手机", sim: "13900000000", from: "10086", content: "吊销后", time: "2026-11-02 12:02:00" } });
    check(r.status === 403, "吊销后同令牌 → 403（状态码分布同旧版）");
    r = await call("GET", "/api/messages", envU, { headers: HU(), cookie: ckU });
    check(r.status === 200 && r.data.list.some(m => m.content === "升级后第一条短信") && r.data.list.some(m => m.content === "升级前历史短信"), "升级后新旧消息共存可读");

    /* 3) 升级可观测：stats 响应含最近一次 schema 自愈结果 */
    r = await call("GET", "/api/stats", envU, { headers: HU(), cookie: ckU });
    check(r.status === 200 && r.data.schema && r.data.schema.state === "ok" && typeof r.data.schema.at === "string" && r.data.schema.at.length >= 16, "stats 响应含 schema 自愈结果（state=ok + 时间，升级自检落点）");

    try { raw.close(); } catch (_) {}
    cleanupPath(upPath);
  }

  /* ===== 第 1 步组：令牌数据层 ===== */
  group("令牌数据层（tokens 表 + 哈希存储 + 吊销/轮换/节流，零鉴权行为变更）");
  {
    const tokPath = join(tmpdir(), "smstoweb_tokens_" + process.pid + ".db");
    cleanupPath(tokPath);
    const rawT = new DatabaseSync(tokPath);   // 裸空库：连 devices/messages 都没有，靠 ensureSchema 自愈建全
    const tokDb = makeD1(rawT);
    const envT = { DB: tokDb, RECEIVE_TOKEN: "tok", ENABLE_AUTH: "", ADMIN_PASSWORD: "", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30" };
    const toHex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, "0")).join("");

    /* 空库幂等（补第 0 步判据 2 遗留）：ensureSchema 建出 tokens 表与全部索引 */
    let rr = await call("GET", "/api/messages", envT);
    check(rr.status === 200, "空库首请求 → 200（ensureSchema 建全三表）");
    const tcols = rawT.prepare("PRAGMA table_info(tokens)").all().map(c => String(c.name));
    check(tcols.join(",") === "id,name,token_hash,token_prefix,created_at,last_used_at,revoked_at,expires_at,note", "tokens 表 9 列齐全（含 expires_at/note）且无明文列（PRAGMA table_info）");
    const idxs = rawT.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='tokens'").all();
    const idxMap = Object.fromEntries(idxs.map(i => [String(i.name), String(i.sql || "").toUpperCase()]));
    check(!!idxMap["idx_tokens_hash"] && idxMap["idx_tokens_hash"].includes("UNIQUE"), "idx_tokens_hash 为唯一索引（鉴权主路径）");
    check(!!idxMap["idx_tokens_name_active"] && idxMap["idx_tokens_name_active"].includes("UNIQUE") && idxMap["idx_tokens_name_active"].includes("WHERE"), "idx_tokens_name_active 为部分唯一索引（活跃命名唯一）");
    check(!!idxMap["idx_tokens_revoked"], "idx_tokens_revoked 普通索引存在");
    rr = await call("GET", "/api/messages", envT);
    check(rr.status === 200, "空库二次请求幂等 → 200");

    /* 创建 + 哈希正确性 */
    const c1 = await createToken(envT, "phone-main");
    check(c1.ok === true && typeof c1.token === "string" && c1.token.startsWith("smsw_") && c1.id, "createToken 返回一次性明文（smsw_ 前缀）与 id");
    const wantHash = await toHex(c1.token);
    const found = await findTokenByHash(envT, wantHash);
    check(!!found && found.token_hash === wantHash && found.name === "phone-main" && found.id === c1.id && found.revoked_at === null, "SHA-256(明文) 精确命中库内 token_hash（哈希正确性，行含 revoked_at）");

    /* 列表：永不返回明文与哈希 */
    const lt = await listTokens(envT);
    const ltStr = JSON.stringify(lt);
    check(lt.length === 1 && ltStr.indexOf(c1.token) === -1 && ltStr.indexOf(wantHash) === -1 && !("token_hash" in lt[0]), "listTokens 无明文、无哈希、无 token_hash 字段");
    check(lt[0].token_prefix === c1.token.slice(0, 12), "token_prefix 为明文前 12 位（后台辨识用，不含完整明文）");

    /* 命名边界与重名拒绝 */
    check((await createToken(envT, "phone-main")).error === "NAME_TAKEN", "活跃重名创建 → NAME_TAKEN");
    check((await createToken(envT, "")).error === "INVALID_NAME", "空名 → INVALID_NAME");
    check((await createToken(envT, "bad name!")).error === "INVALID_NAME", "非法字符名 → INVALID_NAME（白名单 A-Za-z0-9_-）");
    check((await createToken(envT, "x".repeat(65))).error === "INVALID_NAME", "超长名(>64) → INVALID_NAME");

    /* last_used_at 节流（写放大控制，阈值 60s） */
    await touchLastUsed(envT, c1.id);
    const t1 = rawT.prepare("SELECT last_used_at FROM tokens WHERE id = ?").all(c1.id)[0].last_used_at;
    await touchLastUsed(envT, c1.id);
    const t2 = rawT.prepare("SELECT last_used_at FROM tokens WHERE id = ?").all(c1.id)[0].last_used_at;
    check(!!t1 && t1 === t2, "touchLastUsed 节流生效（60 秒内重复调用不产生第二次写）");

    /* 吊销 */
    const rv = await revokeToken(envT, c1.id);
    check(rv.ok === true && rv.revoked === true, "revokeToken → revoked:true");
    const foundR = await findTokenByHash(envT, wantHash);
    check(!!foundR && foundR.revoked_at !== null, "吊销后 findTokenByHash 返回行带 revoked_at（第 2 步鉴权据此拒绝）");
    check((await revokeToken(envT, c1.id)).revoked === false, "重复吊销幂等 → revoked:false");

    /* 吊销让出命名：同名可重建（审计行保留） */
    const c2 = await createToken(envT, "phone-main");
    check(c2.ok === true && c2.id && c2.id !== c1.id, "吊销后同名可重建（部分唯一索引只约束活跃行）");

    /* 轮换 = 吊销旧 + 建新同名 */
    const c3 = await createToken(envT, "nas-script");
    const rot = await rotateToken(envT, c3.id);
    check(rot.ok === true && typeof rot.token === "string" && rot.id && rot.id !== c3.id, "rotateToken 返回新明文与新 id");
    const oldRow = await findTokenByHash(envT, await toHex(c3.token));
    check(!!oldRow && oldRow.revoked_at !== null, "轮换后旧明文的哈希行已带 revoked_at");
    const newRow = await findTokenByHash(envT, await toHex(rot.token));
    check(!!newRow && newRow.revoked_at === null && newRow.id === rot.id && newRow.name === "nas-script", "轮换后新明文命中活跃行且保留原命名");
    check((await rotateToken(envT, "nonexistent")).ok === false, "轮换不存在的 id → 失败（NOT_FOUND）");
    const c4 = await createToken(envT, "nas-script");
    check(c4.ok === false && c4.error === "NAME_TAKEN", "轮换后原命名仍被新令牌占用 → NAME_TAKEN");

    /* 别名场景运行时用例（补第 0 步偏差 2 技术债） */
    const aliasRow = await tokDb.prepare("SELECT t.token_hash FROM tokens t WHERE t.token_hash = ?").bind(await toHex(rot.token)).first();
    check(!!aliasRow && aliasRow.token_hash === await toHex(rot.token), "别名查询（SELECT t.token_hash FROM tokens t WHERE t.token_hash=?）运行时可跑");

    rawT.close();
    cleanupPath(tokPath);
  }

  /* ===== 第 2 步组：接入鉴权 ===== */
  group("接入鉴权（库内令牌优先 + 环境变量兜底 + DISABLE_RECEIVE_TOKEN + fail-closed）");
  {
    const auPath = join(tmpdir(), "smstoweb_auth_" + process.pid + ".db");
    cleanupPath(auPath);
    const rawA = new DatabaseSync(auPath);   // 裸空库：靠 ensureSchema 自愈建全
    const auDb = makeD1(rawA);
    const baseEnv = { DB: auDb, RECEIVE_TOKEN: "tok", ENABLE_AUTH: "", ADMIN_PASSWORD: "", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30" };

    /* fail-closed：空库 + 无任何有效令牌，任意携带方式一律拒绝 */
    let ra = await call("POST", "/api/push?token=anything", baseEnv, { body: { content: "x" } });
    check(ra.status === 403, "空库无令牌 → push 403（fail-closed，状态码同旧版）");
    ra = await call("GET", "/api/receive?name=d&content=c&token=anything", baseEnv);
    check(ra.status === 403, "空库无令牌 → receive 403（fail-closed，状态码同旧版）");
    ra = await call("POST", "/api/push", baseEnv, { body: { content: "x", token: "anything" } });
    check(ra.status === 403, "仅 body.token 且不匹配 → push 403");

    /* 环境变量兜底（迁移期）：RECEIVE_TOKEN 匹配即放行，四种携带方式 */
    ra = await call("POST", "/api/push?token=tok", baseEnv, { body: { content: "via query", time: "2026-11-02 10:00:00" } });
    check(ra.status === 200 && ra.data && ra.data.success === true, "兜底：query ?token=tok → 200");
    ra = await call("POST", "/api/push", baseEnv, { headers: { "X-Receive-Token": "tok" }, body: { content: "via header", time: "2026-11-02 10:01:00" } });
    check(ra.status === 200, "兜底：X-Receive-Token 头 → 200");
    ra = await call("POST", "/api/push", baseEnv, { headers: { "Authorization": "Bearer tok" }, body: { content: "via bearer", time: "2026-11-02 10:02:00" } });
    check(ra.status === 200, "兜底：Authorization Bearer → 200");
    ra = await call("POST", "/api/push", baseEnv, { body: { content: "via body", token: "tok", time: "2026-11-02 10:03:00" } });
    check(ra.status === 200, "兜底：body.token → 200");

    /* 库内令牌：哈希精确命中放行 + last_used_at 记录 + 错字符拒绝 */
    const ca = await createToken(baseEnv, "auth-dev");
    check(ca.ok === true && ca.token, "createToken（鉴权组库内令牌）");
    ra = await call("POST", "/api/push", baseEnv, { headers: { "X-Receive-Token": ca.token }, body: { content: "db token", time: "2026-11-02 10:04:00" } });
    check(ra.status === 200, "库内令牌：X-Receive-Token 头 → 200");
    ra = await call("POST", "/api/receive?token=" + encodeURIComponent(ca.token), baseEnv, { body: { name: "db手机", sim: "13900000000", from: "10086", content: "db短信", time: "2026-11-02 10:05:00" } });
    check(ra.status === 200 && ra.data && ra.data.success === true, "库内令牌：receive query → 200");
    const lrow = await listTokens(baseEnv);
    check(lrow.length === 1 && lrow[0].last_used_at !== null, "库内令牌命中后 last_used_at 已记录");
    const wrong = ca.token.slice(0, -1) + (ca.token.endsWith("0") ? "1" : "0");
    ra = await call("POST", "/api/push", baseEnv, { body: { content: "wrong", token: wrong } });
    check(ra.status === 403, "库内令牌错一个字符 → 403（哈希精确匹配，状态码同旧版）");

    /* 吊销即拒绝 */
    await revokeToken(baseEnv, ca.id);
    ra = await call("POST", "/api/push", baseEnv, { headers: { "X-Receive-Token": ca.token }, body: { content: "revoked", time: "2026-11-02 10:06:00" } });
    check(ra.status === 403, "库内令牌吊销后 → 403（fail-closed，状态码同旧版）");

    /* DISABLE_RECEIVE_TOKEN="true"：停用环境变量兜底，只认库内令牌（拍板点 2：默认未设 = 兜底启用） */
    const disEnv = Object.assign({}, baseEnv, { DISABLE_RECEIVE_TOKEN: "true" });
    ra = await call("POST", "/api/push?token=tok", disEnv, { body: { content: "no fallback", time: "2026-11-02 10:07:00" } });
    check(ra.status === 403, "开关开启：环境变量兜底停用 → 403（fail-closed，状态码同旧版）");
    const cb = await createToken(baseEnv, "only-db");
    ra = await call("POST", "/api/push", disEnv, { headers: { "Authorization": "Bearer " + cb.token }, body: { content: "db only", time: "2026-11-02 10:08:00" } });
    check(ra.status === 200, "开关开启：库内令牌仍放行 → 200");
    ra = await call("POST", "/api/push?token=tok", baseEnv, { body: { content: "fallback again", time: "2026-11-02 10:09:00" } });
    check(ra.status === 200, "开关未设（默认）：兜底启用 → 200");
    ra = await call("POST", "/api/push?token=tok", Object.assign({}, baseEnv, { DISABLE_RECEIVE_TOKEN: "TRUE " }), { body: { content: "case", time: "2026-11-02 10:10:00" } });
    check(ra.status === 403, "开关取值容忍大小写/空白：\"TRUE \" 亦视为停用 → 403");

    /* /api/cron 不纳入库内令牌（拍板点 1）：库内令牌无效，环境变量行为不变 */
    ra = await handleCronRequest(R("GET", "/api/cron?token=" + encodeURIComponent(cb.token), {}), baseEnv);
    check(ra.status === 403, "/api/cron 库内令牌 → 403（不纳入库内令牌）");
    ra = await handleCronRequest(R("GET", "/api/cron?token=tok", {}), baseEnv);
    check(ra.status === 200, "/api/cron 环境变量 → 200（行为不变）");

    rawA.close();
    cleanupPath(auPath);
  }

  /* ===== 第 3 步组：令牌管理 API ===== */
  group("令牌管理 API + CSRF + 收发联动（第 3 步）");
  {
    const mtPath = join(tmpdir(), "smstoweb_mtok_" + process.pid + ".db");
    cleanupPath(mtPath);
    const rawM = new DatabaseSync(mtPath);
    const mDb = makeD1(rawM);
    const eM = { DB: mDb, RECEIVE_TOKEN: "tok", ENABLE_AUTH: "true", ADMIN_PASSWORD: "secret", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30" };
    /* 独立 XFF 桶（clientIp 取最右段）：本组写调用较多，避开与其他组共用的默认 IP 限速桶 */
    const XFF = { "X-Forwarded-For": "203.0.113.77, 10.0.0.7" };
    const H = (extra) => Object.assign({}, XFF, extra || {});

    /* 1) 未登录访问四个令牌管理接口 → 401 逐个验（不在 isPublicApi 白名单 → 路由层统一鉴权） */
    let rm = await call("GET", "/api/tokens", eM, { headers: H() });
    check(rm.status === 401, "未登录 GET /api/tokens → 401");
    rm = await call("POST", "/api/tokens", eM, { headers: H(), body: { name: "x" } });
    check(rm.status === 401, "未登录 POST /api/tokens → 401");
    rm = await call("POST", "/api/tokens/revoke", eM, { headers: H(), body: { id: "x" } });
    check(rm.status === 401, "未登录 POST /api/tokens/revoke → 401");
    rm = await call("POST", "/api/tokens/rotate", eM, { headers: H(), body: { id: "x" } });
    check(rm.status === 401, "未登录 POST /api/tokens/rotate → 401");

    /* 登录拿会话 */
    rm = await call("POST", "/api/login", eM, { headers: H(), body: { password: "secret" } });
    check(rm.status === 200 && /sms_auth=/.test(rm.setCookie), "登录 → 200 且下发会话 cookie");
    const ckM = "sms_auth=" + ((rm.setCookie.match(/sms_auth=([^;]*)/) || [])[1] || "");

    /* 2) CSRF 防护（选型：强制 Content-Type: application/json，简单请求不可伪造） */
    rm = await call("POST", "/api/tokens", eM, { headers: H({ "Content-Type": "text/plain" }), body: '{"name":"csrf"}', cookie: ckM });
    check(rm.status === 400, "CSRF：Content-Type: text/plain 写请求 → 400（简单请求被拒）");
    rm = await call("POST", "/api/tokens/revoke", eM, { headers: H({ "Content-Type": "application/x-www-form-urlencoded" }), body: "id=x", cookie: ckM });
    check(rm.status === 400, "CSRF：表单 Content-Type 写请求 → 400");

    /* 3) 登录后 CRUD：创建（明文一次）+ 列表（无明文无哈希） */
    rm = await call("POST", "/api/tokens", eM, { headers: H(), body: { name: "ui-phone" }, cookie: ckM });
    check(rm.status === 200 && rm.data.success && typeof rm.data.token === "string" && rm.data.token.startsWith("smsw_"), "创建令牌 → 200 返回一次性明文（smsw_ 前缀）");
    check(rm.data.token_prefix === rm.data.token.slice(0, 12) && rm.data.name === "ui-phone", "创建响应含 token_prefix（前 12 位）与 name");
    const mtok1 = rm.data.token, mid1 = rm.data.id;
    rm = await call("GET", "/api/tokens", eM, { headers: H(), cookie: ckM });
    const listStr = JSON.stringify(rm.data);
    check(rm.status === 200 && rm.data.success && rm.data.list.length === 1, "登录后 GET /api/tokens → 200 且 1 条");
    check(listStr.indexOf(mtok1) === -1 && listStr.indexOf("token_hash") === -1 && !("token" in rm.data.list[0]), "GET 响应体无明文、无 token_hash 字段（前端从源头就没有）");
    check(rm.data.list[0].revoked_at === null && rm.data.list[0].name === "ui-phone", "列表行含 revoked_at（活跃行 null）与 name");

    /* 4) 错误码：NAME_TAKEN / INVALID_NAME → 400；吊销/轮换不存在 → 404 */
    rm = await call("POST", "/api/tokens", eM, { headers: H(), body: { name: "ui-phone" }, cookie: ckM });
    check(rm.status === 400 && rm.data.error === "NAME_TAKEN", "创建重名 → 400 NAME_TAKEN");
    rm = await call("POST", "/api/tokens", eM, { headers: H(), body: { name: "bad name!" }, cookie: ckM });
    check(rm.status === 400 && rm.data.error === "INVALID_NAME", "创建非法名 → 400 INVALID_NAME");
    rm = await call("POST", "/api/tokens/revoke", eM, { headers: H(), body: { id: "nonexistent" }, cookie: ckM });
    check(rm.status === 404 && rm.data.error === "NOT_FOUND", "吊销不存在 id → 404 NOT_FOUND");
    rm = await call("POST", "/api/tokens/rotate", eM, { headers: H(), body: { id: "nonexistent" }, cookie: ckM });
    check(rm.status === 404 && rm.data.error === "NOT_FOUND", "轮换不存在 id → 404 NOT_FOUND");
    rm = await call("POST", "/api/tokens", eM, { headers: H(), body: "not json", cookie: ckM });
    check(rm.status === 400, "创建坏 JSON → 400 invalid json");

    /* 5) 轮换联动：旧明文 403、新明文 200（/api/push 走第 2 步鉴权） */
    rm = await call("POST", "/api/push", eM, { headers: H({ "X-Receive-Token": mtok1 }), body: { content: "before rotate", time: "2026-11-02 11:00:00" } });
    check(rm.status === 200, "轮换前：库内令牌推送 → 200");
    rm = await call("POST", "/api/tokens/rotate", eM, { headers: H(), body: { id: mid1 }, cookie: ckM });
    check(rm.status === 200 && rm.data.success && typeof rm.data.token === "string" && rm.data.id && rm.data.id !== mid1, "轮换 → 200 返回新明文与新 id（各一次）");
    const mtok2 = rm.data.token, mid2 = rm.data.id;
    rm = await call("POST", "/api/push", eM, { headers: H({ "X-Receive-Token": mtok1 }), body: { content: "after rotate", time: "2026-11-02 11:01:00" } });
    check(rm.status === 403, "轮换后：旧明文推送 → 403");
    rm = await call("POST", "/api/push", eM, { headers: H({ "X-Receive-Token": mtok2 }), body: { content: "new token", time: "2026-11-02 11:02:00" } });
    check(rm.status === 200, "轮换后：新明文推送 → 200");

    /* 6) 吊销联动 + 幂等 + 审计痕迹（/api/receive 联动第 2 步） */
    rm = await call("POST", "/api/tokens/revoke", eM, { headers: H(), body: { id: mid2 }, cookie: ckM });
    check(rm.status === 200 && rm.data.revoked === true, "吊销 → 200 revoked:true");
    rm = await call("POST", "/api/receive", eM, { headers: H({ "X-Receive-Token": mtok2 }), body: { name: "手机", sim: "13900000000", from: "10086", content: "revoked", time: "2026-11-02 11:03:00" } });
    check(rm.status === 403, "吊销后：/api/receive 用该令牌 → 403（联动第 2 步）");
    rm = await call("POST", "/api/tokens/revoke", eM, { headers: H(), body: { id: mid2 }, cookie: ckM });
    check(rm.status === 200 && rm.data.revoked === false && rm.data.already_revoked === true, "重复吊销已吊销 id → 幂等成功（revoked:false）");
    rm = await call("GET", "/api/tokens", eM, { headers: H(), cookie: ckM });
    check(rm.data.list.length === 2 && rm.data.list.every(t => t.revoked_at !== null), "列表 2 条且均已吊销（审计行保留，活跃在前排序反转）");
    const listStr2 = JSON.stringify(rm.data);
    check(listStr2.indexOf(mtok1) === -1 && listStr2.indexOf(mtok2) === -1 && listStr2.indexOf("token_hash") === -1, "吊销后列表仍无明文无哈希");

    rawM.close();
    cleanupPath(mtPath);
  }

  /* ===== 第 5 步组：令牌边界补钉（并发重名 / 轮换审计 / 前缀不泄漏 / 节流端到端 / 开关边界值）===== */
  group("第 5 步 · 令牌边界补钉（并发/审计/前缀/节流/开关边界）");
  {
    const b5Path = join(tmpdir(), "smstoweb_b5tok_" + process.pid + ".db");
    cleanupPath(b5Path);
    const rawB5 = new DatabaseSync(b5Path);
    const bDb = makeD1(rawB5);
    const eB5 = { DB: bDb, RECEIVE_TOKEN: "tok", ENABLE_AUTH: "true", ADMIN_PASSWORD: "secret", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30" };
    const XB = { "X-Forwarded-For": "203.0.113.61, 10.0.0.61" };
    const HB = (extra) => Object.assign({}, XB, extra || {});

    /* 登录拿会话（本组写调用共 16 次，远低于 120/分，同桶安全） */
    let rb = await call("POST", "/api/login", eB5, { headers: HB(), body: { password: "secret" } });
    check(rb.status === 200, "边界组：登录 → 200");
    const ckB = "sms_auth=" + ((rb.setCookie.match(/sms_auth=([^;]*)/) || [])[1] || "");

    /* 1) 同名并发创建：Promise.all 同事件循环背靠背两次 → 恰好一次成功、一次 NAME_TAKEN（部分唯一索引真实时序生效） */
    const cc = await Promise.all([
      call("POST", "/api/tokens", eB5, { headers: HB(), body: { name: "race-dev" }, cookie: ckB }),
      call("POST", "/api/tokens", eB5, { headers: HB(), body: { name: "race-dev" }, cookie: ckB }),
    ]);
    const okCnt = cc.filter(x => x.status === 200).length;
    const takenCnt = cc.filter(x => x.status === 400 && x.data && x.data.error === "NAME_TAKEN").length;
    check(okCnt === 1 && takenCnt === 1, "同名并发创建两次 → 恰好 1 次成功 + 1 次 NAME_TAKEN（部分唯一索引时序生效）");
    const raceOk = cc.find(x => x.status === 200);
    check(!!raceOk && typeof raceOk.data.token === "string" && raceOk.data.token_prefix === raceOk.data.token.slice(0, 12), "并发成功方返回一次性明文与一致前缀");

    /* 2) 轮换后审计完整性 + token_prefix 不泄漏：列表 2 行（旧行 revoked_at 非空 + 新行活跃同名），响应体 grep 无明文 */
    rb = await call("POST", "/api/tokens", eB5, { headers: HB(), body: { name: "audit-dev" }, cookie: ckB });
    const atok = rb.data.token, aid1 = rb.data.id;
    check(typeof rb.data.token_prefix === "string" && rb.data.token_prefix.length === 12 && rb.data.token_prefix !== rb.data.token, "token_prefix 固定 12 位且不等于完整明文");
    rb = await call("POST", "/api/tokens/rotate", eB5, { headers: HB(), body: { id: aid1 }, cookie: ckB });
    check(rb.status === 200, "轮换 audit-dev → 200");
    const aid2 = rb.data.id, atok2 = rb.data.token;
    rb = await call("GET", "/api/tokens", eB5, { headers: HB(), cookie: ckB });
    const rows = rb.data.list.filter(t => t.name === "audit-dev");
    const oldRow = rows.find(t => t.id === aid1), newRow = rows.find(t => t.id === aid2);
    check(rows.length === 2, "轮换后列表含 audit-dev 2 行（旧行保留审计）");
    check(!!oldRow && !!newRow && oldRow.revoked_at !== null && newRow.revoked_at === null, "旧行 revoked_at 非空 + 新行活跃（审计完整性）");
    check(!!oldRow && !!newRow && oldRow.name === newRow.name, "旧行与新行 name 相同（部分唯一索引让出命名在 API 层成立）");
    const auditStr = JSON.stringify(rb.data);
    check(auditStr.indexOf(atok) === -1 && auditStr.indexOf(atok2) === -1, "轮换后列表响应不含任何明文（grep 全响应体）");
    check(rows.every(t => (t.token_prefix || "").length === 12), "列表行 token_prefix 长度固定 12");

    /* 3) last_used_at 节流端到端：真实 /api/receive 路径，60s 窗口内第二次接收不产生第二次写（哨兵时间戳法，确定性判定） */
    rb = await call("POST", "/api/receive", eB5, { headers: HB({ "X-Receive-Token": atok2 }), body: { name: "节流机", sim: "13900000001", from: "10086", content: "throttle-1", time: "2026-11-02 12:00:00" } });
    check(rb.status === 200, "节流：第 1 次 /api/receive（库内令牌）→ 200");
    await bDb.prepare("UPDATE tokens SET last_used_at = '2099-01-01 00:00:00' WHERE id = ?").bind(aid2).run();
    rb = await call("POST", "/api/receive", eB5, { headers: HB({ "X-Receive-Token": atok2 }), body: { name: "节流机", sim: "13900000001", from: "10086", content: "throttle-2", time: "2026-11-02 12:01:00" } });
    check(rb.status === 200, "节流：第 2 次 /api/receive → 200");
    let tu = await bDb.prepare("SELECT last_used_at FROM tokens WHERE id = ?").bind(aid2).first();
    check(!!tu && tu.last_used_at === "2099-01-01 00:00:00", "60s 窗口内第二次接收未产生第二次写（哨兵时间未被覆盖）");
    await bDb.prepare("UPDATE tokens SET last_used_at = '2000-01-01 00:00:00' WHERE id = ?").bind(aid2).run();
    rb = await call("POST", "/api/receive", eB5, { headers: HB({ "X-Receive-Token": atok2 }), body: { name: "节流机", sim: "13900000001", from: "10086", content: "throttle-3", time: "2026-11-02 12:02:00" } });
    tu = await bDb.prepare("SELECT last_used_at FROM tokens WHERE id = ?").bind(aid2).first();
    check(rb.status === 200 && !!tu && tu.last_used_at !== "2000-01-01 00:00:00", "窗口过期后接收恢复写 last_used_at（节流双侧边界）");

    /* 4) DISABLE_RECEIVE_TOKEN 边界值矩阵：仅 trim+lowercase 后等于 "true" 停用；"1"/"yes"/""/未设 不停用 */
    const disCases = [
      ["true", 403], ["TRUE", 403], [" true ", 403],
      ["1", 200], ["yes", 200], ["", 200], [undefined, 200],
    ];
    for (const dc of disCases) {
      const ev = Object.assign({}, eB5);
      if (dc[0] === undefined) delete ev.DISABLE_RECEIVE_TOKEN; else ev.DISABLE_RECEIVE_TOKEN = dc[0];
      const rr = await call("POST", "/api/push?token=tok", ev, { headers: HB(), body: { content: "dis-" + String(dc[0]), time: "2026-11-02 12:03:00" } });
      check(rr.status === dc[1], "开关边界值 DISABLE_RECEIVE_TOKEN=" + JSON.stringify(dc[0] === undefined ? "未设" : dc[0]) + " → " + dc[1] + (dc[1] === 403 ? "（停用兜底）" : "（兜底启用）"));
    }

    rawB5.close();
    cleanupPath(b5Path);
  }

  /* ===== 第 5 步组：限速回归补钉（receive 429 / 令牌管理写接口 429 / 登录锁定，各用独立 XFF 桶）===== */
  group("第 5 步 · 限速回归补钉（receive/令牌管理/登录）");
  {
    /* 1) /api/receive 写入限速 120/IP/min：恰好第 121 次 → 429 */
    const r5Path = join(tmpdir(), "smstoweb_r5recv_" + process.pid + ".db");
    cleanupPath(r5Path);
    const rawR5 = new DatabaseSync(r5Path);
    const eR5 = { DB: makeD1(rawR5), RECEIVE_TOKEN: "tok", ENABLE_AUTH: "", ADMIN_PASSWORD: "", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30" };
    const XR = { "X-Forwarded-For": "203.0.113.62, 10.0.0.62" };
    const rStatuses = [];
    for (let i = 0; i < 125; i++) {
      const rr = await call("POST", "/api/receive?token=tok", eR5, { headers: XR, body: { name: "限速机", sim: "13800000062", from: "10086", content: "rl-" + i, time: "2026-11-02 12:10:00" } });
      rStatuses.push(rr.status);
    }
    check(rStatuses.slice(0, 120).every(s => s === 200), "receive 限速：前 120 次全部 200");
    check(rStatuses[120] === 429, "receive 限速：第 121 次 → 429");
    check(rStatuses.slice(121).every(s => s === 429), "receive 限速：窗口内后续请求持续 429");
    rawR5.close();
    cleanupPath(r5Path);

    /* 2) 令牌管理写接口复用 allowWrite：POST /api/tokens 第 121 次 → 429，同桶耗尽后 revoke/rotate 亦 429 */
    const t5Path = join(tmpdir(), "smstoweb_r5tok_" + process.pid + ".db");
    cleanupPath(t5Path);
    const rawT5 = new DatabaseSync(t5Path);
    const eT5 = { DB: makeD1(rawT5), RECEIVE_TOKEN: "tok", ENABLE_AUTH: "true", ADMIN_PASSWORD: "secret", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30" };
    const XT = { "X-Forwarded-For": "203.0.113.63, 10.0.0.63" };
    let rt = await call("POST", "/api/login", eT5, { headers: XT, body: { password: "secret" } });
    const ckT = "sms_auth=" + ((rt.setCookie.match(/sms_auth=([^;]*)/) || [])[1] || "");
    const tStatuses = [];
    for (let i = 0; i < 122; i++) {
      const rr = await call("POST", "/api/tokens", eT5, { headers: XT, body: { name: "rl-" + i }, cookie: ckT });
      tStatuses.push(rr.status);
    }
    check(tStatuses.slice(0, 120).every(s => s === 200), "令牌管理限速：POST /api/tokens 前 120 次（唯一名）全部 200");
    check(tStatuses[120] === 429, "令牌管理限速：POST /api/tokens 第 121 次 → 429（复用 allowWrite）");
    check(tStatuses[121] === 429, "令牌管理限速：第 122 次持续 429");
    rt = await call("POST", "/api/tokens/revoke", eT5, { headers: XT, body: { id: "x" }, cookie: ckT });
    check(rt.status === 429, "令牌管理限速：同桶耗尽后 revoke → 429（写接口共用限速）");
    rt = await call("POST", "/api/tokens/rotate", eT5, { headers: XT, body: { id: "x" }, cookie: ckT });
    check(rt.status === 429, "令牌管理限速：同桶耗尽后 rotate → 429（写接口共用限速）");
    rawT5.close();
    cleanupPath(t5Path);

    /* 3) 登录限速：同 IP 连续失败 5 次锁定 10 分钟——第 6 次即使密码正确也 429 */
    const l5Path = join(tmpdir(), "smstoweb_r5login_" + process.pid + ".db");
    cleanupPath(l5Path);
    const rawL5 = new DatabaseSync(l5Path);
    const eL5 = { DB: makeD1(rawL5), RECEIVE_TOKEN: "tok", ENABLE_AUTH: "true", ADMIN_PASSWORD: "secret", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30" };
    const XL = { "X-Forwarded-For": "203.0.113.64, 10.0.0.64" };
    for (let i = 0; i < 5; i++) {
      const rr = await call("POST", "/api/login", eL5, { headers: XL, body: { password: "wrong-" + i } });
      check(rr.status === 403, "登录限速：第 " + (i + 1) + " 次错误密码 → 403（尚未锁定）");
    }
    const r6 = await call("POST", "/api/login", eL5, { headers: XL, body: { password: "secret" } });
    check(r6.status === 429, "登录限速：5 次失败后第 6 次即使密码正确 → 429（锁 10 分钟）");
    rawL5.close();
    cleanupPath(l5Path);
  }

  /* ===== 插队组：令牌有效期与备注 + 页脚版本号 ===== */
  group("插队组 · 令牌有效期与备注（创建回显/格式校验/过期 403/软失效审计/轮换透传/旧库补列自愈）+ 页脚版本号");
  {
    const exPath = join(tmpdir(), "smstoweb_exp_" + process.pid + ".db");
    cleanupPath(exPath);
    const rawE = new DatabaseSync(exPath);
    const eE = { DB: makeD1(rawE), RECEIVE_TOKEN: "tok", ENABLE_AUTH: "true", ADMIN_PASSWORD: "secret", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30" };
    const XE = { "X-Forwarded-For": "203.0.113.71, 10.0.0.71" };
    const HE = (extra) => Object.assign({}, XE, extra || {});

    let re = await call("POST", "/api/login", eE, { headers: HE(), body: { password: "secret" } });
    check(re.status === 200, "有效期组：登录 → 200");
    const ckE = "sms_auth=" + ((re.setCookie.match(/sms_auth=([^;]*)/) || [])[1] || "");

    /* 1) 带备注 + 天数有效期创建：创建响应含规范化 expires_at；列表回显 note/expires_at 与服务端 now */
    re = await call("POST", "/api/tokens", eE, { headers: HE(), body: { name: "note-dev", note: "主力机接入", expires_in_days: 7 }, cookie: ckE });
    check(re.status === 200 && re.data.success && typeof re.data.expires_at === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(re.data.expires_at), "创建带备注+7天有效期 → 200 且响应含 UTC expires_at");
    const noteDevTok = re.data.token;
    re = await call("GET", "/api/tokens", eE, { headers: HE(), cookie: ckE });
    const noteDevRow = (re.data.list || []).filter(t => t.name === "note-dev")[0];
    check(re.data.success && typeof re.data.now === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(re.data.now), "列表响应含服务端 UTC now（前端过期判定依据，客户端时钟不可信）");
    check(!!noteDevRow && noteDevRow.note === "主力机接入" && typeof noteDevRow.expires_at === "string" && noteDevRow.expires_at > re.data.now, "列表行回显备注与未来有效期（7 天）");
    const listStrE = JSON.stringify(re.data);
    check(listStrE.indexOf(noteDevTok) === -1 && listStrE.indexOf("token_hash") === -1, "含备注的列表响应仍无明文无哈希");

    /* 2) 自定义到期日：YYYY-MM-DD 规范化为当日 UTC 23:59:59（当日全天有效） */
    re = await call("POST", "/api/tokens", eE, { headers: HE(), body: { name: "date-dev", expires_at: "2026-11-10" }, cookie: ckE });
    check(re.status === 200 && re.data.expires_at === "2026-11-10 23:59:59", "自定义到期日 2026-11-10 → 规范化为 2026-11-10 23:59:59（UTC 当日末）");

    /* 3) 过期令牌接入：软失效 403（不写 revoked_at，保留审计）；未过期令牌 200 */
    re = await call("POST", "/api/tokens", eE, { headers: HE(), body: { name: "exp-dev", expires_at: "2000-01-01 00:00:00" }, cookie: ckE });
    check(re.status === 200 && re.data.success, "创建过去时间的令牌 → 200（格式合法即入库，由鉴权判失效）");
    const expTok = re.data.token, expId = re.data.id;
    re = await call("POST", "/api/push", eE, { headers: HE({ "X-Receive-Token": expTok }), body: { content: "expired try", time: "2026-11-02 13:00:00" } });
    check(re.status === 403, "过期令牌 /api/push → 403（视同无效，状态码同吊销）");
    const expRow = rawE.prepare("SELECT revoked_at, expires_at FROM tokens WHERE id = ?").get(expId);
    check(!!expRow && expRow.revoked_at === null && expRow.expires_at === "2000-01-01 00:00:00", "过期拒绝后 revoked_at 仍为 null（软失效不吊销，保留审计痕迹）");
    re = await call("POST", "/api/push", eE, { headers: HE({ "X-Receive-Token": noteDevTok }), body: { content: "fresh token", time: "2026-11-02 13:01:00" } });
    check(re.status === 200, "未过期令牌（7 天）→ 200（有效期不影响有效令牌接入）");

    /* 4) 参数校验：INVALID_EXPIRY / INVALID_NOTE → 400（含不存在日期 2026-02-30 的 ISO 严格解析拒绝） */
    re = await call("POST", "/api/tokens", eE, { headers: HE(), body: { name: "bad-1", expires_in_days: 0 }, cookie: ckE });
    check(re.status === 400 && re.data.error === "INVALID_EXPIRY", "expires_in_days=0 → 400 INVALID_EXPIRY");
    re = await call("POST", "/api/tokens", eE, { headers: HE(), body: { name: "bad-2", expires_in_days: 1.5 }, cookie: ckE });
    check(re.status === 400 && re.data.error === "INVALID_EXPIRY", "expires_in_days=1.5（非整数）→ 400 INVALID_EXPIRY");
    re = await call("POST", "/api/tokens", eE, { headers: HE(), body: { name: "bad-3", expires_at: "2026-02-30" }, cookie: ckE });
    check(re.status === 400 && re.data.error === "INVALID_EXPIRY", "expires_at=2026-02-30（不存在日期）→ 400 INVALID_EXPIRY");
    re = await call("POST", "/api/tokens", eE, { headers: HE(), body: { name: "bad-4", expires_at: "next week" }, cookie: ckE });
    check(re.status === 400 && re.data.error === "INVALID_EXPIRY", "expires_at 非法格式 → 400 INVALID_EXPIRY");
    re = await call("POST", "/api/tokens", eE, { headers: HE(), body: { name: "bad-5", note: "x".repeat(201) }, cookie: ckE });
    check(re.status === 400 && re.data.error === "INVALID_NOTE", "备注 201 字 → 400 INVALID_NOTE");

    /* 5) 轮换透传：新令牌沿用原备注与有效期，旧行吊销（轮换不偷偷续期） */
    re = await call("POST", "/api/tokens", eE, { headers: HE(), body: { name: "rot-exp", note: "轮换透传验证", expires_in_days: 30 }, cookie: ckE });
    const rotId = re.data.id, rotExp = re.data.expires_at;
    re = await call("POST", "/api/tokens/rotate", eE, { headers: HE(), body: { id: rotId }, cookie: ckE });
    check(re.status === 200 && typeof re.data.expires_at === "string", "轮换 → 200 且响应含沿用后的 expires_at");
    re = await call("GET", "/api/tokens", eE, { headers: HE(), cookie: ckE });
    const rotRows = re.data.list.filter(t => t.name === "rot-exp");
    const rotOld = rotRows.find(t => t.id === rotId), rotNew = rotRows.find(t => t.id !== rotId);
    check(!!rotOld && !!rotNew && rotOld.revoked_at !== null && rotNew.revoked_at === null, "轮换后旧行吊销、新行活跃");
    check(!!rotNew && rotNew.note === "轮换透传验证" && rotNew.expires_at === rotExp, "新行沿用原备注与有效期（不偷偷续期）");

    /* 6) 旧库补列自愈：旧版 7 列 tokens 表 → 首请求自动补 expires_at/note → 带有效期创建可用 */
    const lgPath = join(tmpdir(), "smstoweb_exp_legacy_" + process.pid + ".db");
    cleanupPath(lgPath);
    const rawL = new DatabaseSync(lgPath);
    rawL.exec("CREATE TABLE tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, token_prefix TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, revoked_at TEXT)");
    rawL.exec("CREATE UNIQUE INDEX idx_tokens_name_active ON tokens(name) WHERE revoked_at IS NULL");
    rawL.exec("CREATE UNIQUE INDEX idx_tokens_hash ON tokens(token_hash)");
    rawL.exec("CREATE INDEX idx_tokens_revoked ON tokens(revoked_at)");
    const eL = { DB: makeD1(rawL), RECEIVE_TOKEN: "tok", ENABLE_AUTH: "true", ADMIN_PASSWORD: "secret", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30" };
    const XLG = { "X-Forwarded-For": "203.0.113.72, 10.0.0.72" };
    const colsBefore2 = rawL.prepare("PRAGMA table_info(tokens)").all().map(c => String(c.name));
    check(!colsBefore2.includes("expires_at") && !colsBefore2.includes("note"), "补列自愈：旧 tokens 表确无 expires_at/note 列（现场成立）");
    let rl = await call("POST", "/api/login", eL, { headers: XLG, body: { password: "secret" } });
    check(rl.status === 200, "旧 7 列 tokens 表登录 → 200（首请求触发补列自愈，不 500）");
    const colsAfter2 = rawL.prepare("PRAGMA table_info(tokens)").all().map(c => String(c.name));
    check(colsAfter2.includes("expires_at") && colsAfter2.includes("note"), "旧表自动补齐 expires_at/note 列（PRAGMA 前后对比）");
    rl = await call("POST", "/api/tokens", eL, { headers: XLG, body: { name: "up-exp", note: "旧库带备注", expires_in_days: 30 }, cookie: "sms_auth=" + ((rl.setCookie.match(/sms_auth=([^;]*)/) || [])[1] || "") });
    check(rl.status === 200 && rl.data.success && typeof rl.data.expires_at === "string", "旧库补列后创建带备注+有效期令牌 → 200");

    /* 7) 页脚版本号：管理页与登录页底部均展示 v1.0.4 */
    const pg = await fetchApp(R("GET", "/", { cookie: ckE }), eE);
    const pgHtml = await pg.text();
    check(pg.status === 200 && pgHtml.includes('<span class="ver">v1.0.4</span>'), "管理页页脚含版本号 v1.0.4");
    const lg = await fetchApp(R("GET", "/", {}), eE);
    const lgHtml = await lg.text();
    check(lg.status === 200 && lgHtml.includes('<span class="ver">v1.0.4</span>'), "登录页页脚含版本号 v1.0.4");
    check(pgHtml.includes('id="msesttl"') && pgHtml.includes("会话时长"), "设置菜单含会话时长入口");
    check(pgHtml.includes("sms_ttl_min") && pgHtml.includes("会话时长（本浏览器）"), "管理页会话时长面板为本浏览器独立配置（localStorage 键 sms_ttl_min）");
    check(lgHtml.includes("sms_ttl_min"), "登录页随请求声明本地会话时长（localStorage 键 sms_ttl_min）");

    rawE.close();
    cleanupPath(exPath);
    try { rawL.close(); } catch (_) {}
    cleanupPath(lgPath);
  }

  /* ===== 组：会话时长可配置（settings 表 + /api/settings + 登录 TTL 同步） ===== */
  group("会话时长可配置（GET·PUT /api/settings / 默认 30 分钟 / 校验拒绝 / 登录 Max-Age 同步 / 旧库自愈建表）");
  {
    const stPath = join(tmpdir(), "smstoweb_sessttl_" + process.pid + ".db");
    cleanupPath(stPath);
    const rawS = new DatabaseSync(stPath);
    const eS2 = { DB: makeD1(rawS), RECEIVE_TOKEN: "tok", ENABLE_AUTH: "true", ADMIN_PASSWORD: "secret", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30" };
    const XS = { "X-Forwarded-For": "203.0.113.80, 10.0.0.80" };
    const HS = (extra) => Object.assign({}, XS, extra || {});

    /* 0) 未登录拒绝：GET / PUT 均不在公开白名单 → 401 */
    let rs = await call("GET", "/api/settings", eS2, { headers: HS() });
    check(rs.status === 401, "会话时长：未登录 GET /api/settings → 401");
    rs = await call("PUT", "/api/settings", eS2, { headers: HS(), body: { session_ttl_minutes: 60 } });
    check(rs.status === 401, "会话时长：未登录 PUT /api/settings → 401");

    /* 1) 默认值：登录 Max-Age=1800；GET 回读 30 */
    rs = await call("POST", "/api/login", eS2, { headers: HS(), body: { password: "secret" } });
    check(rs.status === 200, "会话时长组：登录 → 200");
    check((rs.setCookie.match(/Max-Age=(\d+)/) || [])[1] === "1800", "未设置时登录 Cookie Max-Age=1800（默认 30 分钟）");
    const ckS = "sms_auth=" + ((rs.setCookie.match(/sms_auth=([^;]*)/) || [])[1] || "");
    rs = await call("GET", "/api/settings", eS2, { headers: HS(), cookie: ckS });
    check(rs.status === 200 && rs.data.success && rs.data.session_ttl_minutes === 30, "GET /api/settings → 默认 30 分钟");

    /* 2) 修改为 480（8 小时）→ 200；重新登录 Max-Age=28800 且 token exp 同步 */
    rs = await call("PUT", "/api/settings", eS2, { headers: HS(), cookie: ckS, body: { session_ttl_minutes: 480 } });
    check(rs.status === 200 && rs.data.success && rs.data.session_ttl_minutes === 480, "PUT 480 → 200 且响应回显 480");
    rs = await call("POST", "/api/login", eS2, { headers: HS(), body: { password: "secret" } });
    check((rs.setCookie.match(/Max-Age=(\d+)/) || [])[1] === "28800", "设置 480 后登录 Cookie Max-Age=28800（8 小时）");
    const tokS = rs.setCookie.split("sms_auth=")[1].split(";")[0];
    const expS = Number(tokS.split(".")[1]);
    check(Math.abs(expS - Date.now() - 480 * 60000) < 5000, "会话 token 内嵌 exp 与 480 分钟一致（±5s）");
    const ckS2 = "sms_auth=" + tokS;

    /* 3) 持久化：GET 回读 480；再登录仍 28800（每次登录现查，改动即时生效） */
    rs = await call("GET", "/api/settings", eS2, { headers: HS(), cookie: ckS2 });
    check(rs.status === 200 && rs.data.session_ttl_minutes === 480, "设置持久化：GET 回读 480");
    rs = await call("POST", "/api/login", eS2, { headers: HS(), body: { password: "secret" } });
    check((rs.setCookie.match(/Max-Age=(\d+)/) || [])[1] === "28800", "重新登录仍按 480 分钟签发");

    /* 4) 参数校验：非整数 / 越界 / 非法类型 / 非 JSON 内容类型 → 拒绝 */
    rs = await call("PUT", "/api/settings", eS2, { headers: HS(), cookie: ckS2, body: { session_ttl_minutes: 4 } });
    check(rs.status === 400 && rs.data.error === "INVALID_TTL", "PUT 4（低于下限）→ 400 INVALID_TTL");
    rs = await call("PUT", "/api/settings", eS2, { headers: HS(), cookie: ckS2, body: { session_ttl_minutes: 43201 } });
    check(rs.status === 400 && rs.data.error === "INVALID_TTL", "PUT 43201（高于上限）→ 400 INVALID_TTL");
    rs = await call("PUT", "/api/settings", eS2, { headers: HS(), cookie: ckS2, body: { session_ttl_minutes: 1.5 } });
    check(rs.status === 400 && rs.data.error === "INVALID_TTL", "PUT 1.5（非整数）→ 400 INVALID_TTL");
    rs = await call("PUT", "/api/settings", eS2, { headers: HS(), cookie: ckS2, body: { session_ttl_minutes: "abc" } });
    check(rs.status === 400 && rs.data.error === "INVALID_TTL", "PUT \"abc\" → 400 INVALID_TTL");
    rs = await call("PUT", "/api/settings", eS2, { headers: Object.assign({}, XS, { "Content-Type": "text/plain" }), cookie: ckS2, body: JSON.stringify({ session_ttl_minutes: 60 }) });
    check(rs.status === 400 && rs.data.error === "invalid content type", "PUT 非 application/json → 400（CSRF 闸门）");
    /* 5) 边界值放行：5 与 43200 */
    rs = await call("PUT", "/api/settings", eS2, { headers: HS(), cookie: ckS2, body: { session_ttl_minutes: 43200 } });
    check(rs.status === 200, "PUT 43200（30 天上限）→ 200");
    rs = await call("PUT", "/api/settings", eS2, { headers: HS(), cookie: ckS2, body: { session_ttl_minutes: 5 } });
    check(rs.status === 200 && (await call("POST", "/api/login", eS2, { headers: HS(), body: { password: "secret" } })).setCookie.includes("Max-Age=300"), "PUT 5（下限）→ 200 且登录 Max-Age=300");

    /* 6) 旧库无 settings 表：首请求自愈建表 → 读默认/写生效 */
    const lgSPath = join(tmpdir(), "smstoweb_sessttl_legacy_" + process.pid + ".db");
    cleanupPath(lgSPath);
    const rawSL = new DatabaseSync(lgSPath);
    rawSL.exec(`CREATE TABLE devices (id INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT NOT NULL DEFAULT 'unknown', sim TEXT NOT NULL DEFAULT '', alias TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    rawSL.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER NOT NULL REFERENCES devices(id), sender TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', received_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    const eSL = { DB: makeD1(rawSL), RECEIVE_TOKEN: "tok", ENABLE_AUTH: "true", ADMIN_PASSWORD: "secret", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30" };
    const XSL = { "X-Forwarded-For": "203.0.113.81, 10.0.0.81" };
    check(!rawSL.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get(), "旧库现场成立：无 settings 表");
    let rl2 = await call("POST", "/api/login", eSL, { headers: XSL, body: { password: "secret" } });
    check(rl2.status === 200, "旧库（无 settings 表）登录 → 200（首请求自愈建表，不 500）");
    check(!!rawSL.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get(), "settings 表已自动创建");
    check((rl2.setCookie.match(/Max-Age=(\d+)/) || [])[1] === "1800", "旧库首登 Max-Age=1800（缺行回退默认）");
    rl2 = await call("PUT", "/api/settings", eSL, { headers: XSL, cookie: "sms_auth=" + ((rl2.setCookie.match(/sms_auth=([^;]*)/) || [])[1] || ""), body: { session_ttl_minutes: 1440 } });
    check(rl2.status === 200 && rl2.data.session_ttl_minutes === 1440, "旧库自愈后 PUT 1440 → 200");
    rl2 = await call("POST", "/api/login", eSL, { headers: XSL, body: { password: "secret" } });
    check((rl2.setCookie.match(/Max-Age=(\d+)/) || [])[1] === "86400", "旧库设置 1440 后登录 Max-Age=86400（24 小时）");

    rawS.close();
    cleanupPath(stPath);
    try { rawSL.close(); } catch (_) {}
    cleanupPath(lgSPath);
  }

  /* ===== 组：浏览器独立会话时长（登录请求声明 session_ttl_minutes > settings 全局默认 > 内置默认） ===== */
  group("浏览器独立会话时长（声明优先 / 边界与非法拒绝 / 缺省回退全局 / 独立性 / 存量会话不延长）");
  {
    const btPath = join(tmpdir(), "smstoweb_browserttl_" + process.pid + ".db");
    cleanupPath(btPath);
    const rawB = new DatabaseSync(btPath);
    const eB = { DB: makeD1(rawB), RECEIVE_TOKEN: "tok", ENABLE_AUTH: "true", ADMIN_PASSWORD: "secret", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30" };
    /* 不同 XFF 桶模拟不同浏览器（登录限速互不干扰，也验证"改一个浏览器不影响其他"） */
    const XA = { "X-Forwarded-For": "203.0.113.90, 10.0.0.90" }; /* 浏览器 A：声明独立 TTL */
    const XB = { "X-Forwarded-For": "203.0.113.91, 10.0.0.91" }; /* 浏览器 B：不声明（跟随全局） */
    const HA = (extra) => Object.assign({}, XA, extra || {});
    const HB = (extra) => Object.assign({}, XB, extra || {});

    /* 0) 先设全局默认 480：作为「全局默认策略/兼容回退」的对照组 */
    let rb = await call("POST", "/api/login", eB, { headers: HB(), body: { password: "secret" } });
    check(rb.status === 200, "浏览器TTL组：B 浏览器先登录 → 200（全局未设置，内置默认 30）");
    check((rb.setCookie.match(/Max-Age=(\d+)/) || [])[1] === "1800", "B 未声明且未设全局 → Max-Age=1800（内置默认 30 分钟）");
    const ckB0 = "sms_auth=" + ((rb.setCookie.match(/sms_auth=([^;]*)/) || [])[1] || "");
    rb = await call("PUT", "/api/settings", eB, { headers: HB(), cookie: ckB0, body: { session_ttl_minutes: 480 } });
    check(rb.status === 200 && rb.data.session_ttl_minutes === 480, "全局默认设为 480（8 小时）");

    /* 1) 声明优先：A 声明 30 → Max-Age=1800，而非全局 28800；exp 与 30 分钟一致 */
    rb = await call("POST", "/api/login", eB, { headers: HA(), body: { password: "secret", session_ttl_minutes: 30 } });
    check(rb.status === 200 && (rb.setCookie.match(/Max-Age=(\d+)/) || [])[1] === "1800", "A 声明 30 → Max-Age=1800（优先于全局 480）");
    const tokA = rb.setCookie.split("sms_auth=")[1].split(";")[0];
    check(Math.abs(Number(tokA.split(".")[1]) - Date.now() - 30 * 60000) < 5000, "A 声明 30 → token exp 与 30 分钟一致（±5s）");
    const ckA = "sms_auth=" + tokA;

    /* 2) 缺省回退：B 不声明 → 按全局 480 签发（浏览器隔离成立：A 的声明不影响 B） */
    rb = await call("POST", "/api/login", eB, { headers: HB(), body: { password: "secret" } });
    check((rb.setCookie.match(/Max-Age=(\d+)/) || [])[1] === "28800", "B 不声明 → 回退全局 480（Max-Age=28800），不受 A 影响");
    const tokB = rb.setCookie.split("sms_auth=")[1].split(";")[0];
    check(Math.abs(Number(tokB.split(".")[1]) - Date.now() - 480 * 60000) < 5000, "B token exp 与全局 480 分钟一致（±5s）");

    /* 3) null 声明等同缺省 → 回退全局 */
    rb = await call("POST", "/api/login", eB, { headers: HA(), body: { password: "secret", session_ttl_minutes: null } });
    check(rb.status === 200 && (rb.setCookie.match(/Max-Age=(\d+)/) || [])[1] === "28800", "声明 null → 视同缺省回退全局 480");

    /* 4) 边界放行：5 / 43200 */
    rb = await call("POST", "/api/login", eB, { headers: HA(), body: { password: "secret", session_ttl_minutes: 5 } });
    check(rb.status === 200 && (rb.setCookie.match(/Max-Age=(\d+)/) || [])[1] === "300", "A 声明 5（下限）→ 200 且 Max-Age=300");
    rb = await call("POST", "/api/login", eB, { headers: HA(), body: { password: "secret", session_ttl_minutes: 43200 } });
    check(rb.status === 200 && (rb.setCookie.match(/Max-Age=(\d+)/) || [])[1] === "2592000", "A 声明 43200（30 天上限）→ 200 且 Max-Age=2592000");

    /* 5) 非法声明 → 400 INVALID_TTL，不签发会话；类型严格（字符串/小数/越界全拒） */
    rb = await call("POST", "/api/login", eB, { headers: HA(), body: { password: "secret", session_ttl_minutes: 4 } });
    check(rb.status === 400 && rb.data.error === "INVALID_TTL" && !rb.setCookie.includes("sms_auth="), "A 声明 4（低于下限）→ 400 INVALID_TTL 且无会话 Cookie");
    rb = await call("POST", "/api/login", eB, { headers: HA(), body: { password: "secret", session_ttl_minutes: 43201 } });
    check(rb.status === 400 && rb.data.error === "INVALID_TTL", "A 声明 43201（高于上限）→ 400 INVALID_TTL");
    rb = await call("POST", "/api/login", eB, { headers: HA(), body: { password: "secret", session_ttl_minutes: "30" } });
    check(rb.status === 400 && rb.data.error === "INVALID_TTL", "A 声明 \"30\"（字符串）→ 400 INVALID_TTL");
    rb = await call("POST", "/api/login", eB, { headers: HA(), body: { password: "secret", session_ttl_minutes: 1.5 } });
    check(rb.status === 400 && rb.data.error === "INVALID_TTL", "A 声明 1.5（非整数）→ 400 INVALID_TTL");

    /* 6) 密码错误优先：非法 TTL + 错误密码 → 403 wrong password（不泄露 TTL 校验顺序） */
    rb = await call("POST", "/api/login", eB, { headers: HA(), body: { password: "bad", session_ttl_minutes: 4 } });
    check(rb.status === 403 && rb.data.error === "wrong password", "错误密码 + 非法声明 → 403 wrong password");

    /* 7) 已签发会话不受非法声明影响（exp 签发时确定、不可延长/缩短） */
    rb = await call("GET", "/api/settings", eB, { headers: HA(), cookie: ckA });
    check(rb.status === 200 && rb.data.session_ttl_minutes === 480, "非法声明 400 后，A 此前签发的会话仍有效且全局默认仍为 480");

    rawB.close();
    cleanupPath(btPath);
  }

  /* ===== 基线组（第 0 步前既有）：收发核心 ===== */
  group("收发 / 去重 / 列表 / 筛选 / 长轮询 / 删除 / 截断（免登录）");
  let r = await call("POST", "/api/push", e0, { body: { content: "no token here" } });
  check(r.status === 403, "push 无 token → 403（未命中库内与环境变量，fail-closed，状态码同旧版）");

  const body1 = { source: "notify", sender: "web-01", content: "hello 1", time: "2026-10-17 12:00:00" };
  r = await call("POST", "/api/push?token=tok", e0, { body: body1 });
  check(r.status === 200 && r.data && r.data.success === true && r.data.duplicated === false, "push 带 token → 入库成功");
  r = await call("POST", "/api/push?token=tok", e0, { body: body1 });
  check(r.data && r.data.duplicated === true, "相同内容+时间重推 → duplicated:true");

  r = await call("POST", "/api/receive?token=tok", e0, { body: { name: "我的手机", sim: "13800000000", from: "10086", content: "验证码 123456", time: "2026-10-17 10:00:00" } });
  check(r.status === 200 && r.data && r.data.success === true, "receive 短信 → 入库成功");

  r = await call("GET", "/api/messages", e0);
  check(r.status === 200 && r.data && r.data.total >= 2, "列表 total>=2");
  check(r.data && r.data.list.some(m => m.content === "hello 1"), "列表含 push 的消息");
  check(r.data && r.data.list.every(m => typeof m.sim_number === "string"), "每行带 sim_number 字段");

  r = await call("GET", "/api/messages?source=sms", e0);
  check(r.data && r.data.list.length === 1 && r.data.list[0].source === "sms", "来源筛选 source=sms 仅 1 条");

  r = await call("GET", "/api/wait?last_id=0", e0);
  check(r.data && r.data.changed === true, "长轮询 last_id=0 有更新 → changed:true 立即返回");

  const list = (await call("GET", "/api/messages", e0)).data.list;
  r = await call("DELETE", "/api/messages/" + list[list.length - 1].id, e0);
  check(r.data && r.data.success === true && r.data.deleted === 1, "删除单条消息成功");

  r = await call("POST", "/api/push?token=tok", e0, { body: { sender: "big", content: "x".repeat(10000) } });
  check(r.status === 200, "超长正文 push 仍成功（截断而非报错）");
  const big = (await call("GET", "/api/messages?q=xxxxx&limit=100", e0)).data.list.filter(m => m.sender === "big");
  check(big.length === 1 && big[0].content.length === 8000, "超长正文被截断到 8000 字");

  const home = await fetchApp(R("GET", "/", {}), e0);
  const homeHtml = await home.text();
  check(home.status === 200 && /class="switch"/.test(homeHtml) && /自动复制验证码/.test(homeHtml), "管理页渲染且含新开关 UI");

  /* ===== 基线组（第 0 步前既有）：定时清理 ===== */
  group("定时清理 runCron / cron HTTP 鉴权");
  await db.prepare("INSERT INTO messages(device_id, sender, content, received_at, source) SELECT id,'old','old msg xyz','2000-01-01 00:00:00','sms' FROM devices LIMIT 1").run();
  const before = (await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE content='old msg xyz'").first()).n;
  await runCron(env({ RETENTION_DAYS: "1" }));
  const after = (await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE content='old msg xyz'").first()).n;
  check(before === 1 && after === 0, "超过保留期的旧消息被 cron 清理");
  r = await handleCronRequest(R("GET", "/api/cron", {}), e0);
  check(r.status === 403, "/api/cron 无 token → 403");
  r = await handleCronRequest(R("GET", "/api/cron?token=tok", {}), e0);
  check(r.status === 200, "/api/cron 带 token → 200");

  /* ===== 基线组（第 0 步前既有）：设备别名 ===== */
  group("设备别名 / 合并 / 动态来源");
  await call("POST", "/api/push?token=tok", e0, { body: { name: "手机A", content: "a-one", time: "2026-10-18 09:00:00" } });
  await call("POST", "/api/push?token=tok", e0, { body: { name: "手机B", content: "b-one", time: "2026-10-18 09:01:00" } });
  await call("POST", "/api/push?token=tok", e0, { body: { name: "手机A", source: "alert", content: "a-two", time: "2026-10-18 09:02:00" } });
  let devs = (await call("GET", "/api/devices", e0)).data.list;
  const devA = devs.find(d => d.display_name === "手机A");
  const devB = devs.find(d => d.display_name === "手机B");
  check(!!devA && !!devB, "创建两个设备标签");

  r = await call("POST", "/api/devices/alias", e0, { body: { id: devB.id, alias: "备用机" } });
  check(r.data && r.data.success === true, "设置设备别名成功");
  devs = (await call("GET", "/api/devices", e0)).data.list;
  check(devs.find(d => d.id === devB.id).display_name === "备用机", "别名生效（display_name 变为备用机）");

  r = await call("GET", "/api/sources", e0);
  check(r.data && r.data.list.some(s => s.source === "alert" && s.count >= 1), "来源清单含自定义来源 alert");
  r = await call("GET", "/api/messages?source=alert", e0);
  check(r.data && r.data.list.length === 1 && r.data.list[0].source === "alert", "自定义来源 alert 可单独筛选");

  const aBefore = (await call("GET", "/api/messages?device_id=" + devA.id, e0)).data.total;
  const bBefore = (await call("GET", "/api/messages?device_id=" + devB.id, e0)).data.total;
  r = await call("POST", "/api/devices/merge", e0, { body: { from: devA.id, to: devB.id } });
  check(r.data && r.data.success === true && r.data.moved === aBefore, "合并设备成功，迁移条数一致");
  const bAfter = (await call("GET", "/api/messages?device_id=" + devB.id, e0)).data.total;
  check(bAfter === bBefore + aBefore, "合并后目标设备消息数 = 原B + 原A");
  devs = (await call("GET", "/api/devices", e0)).data.list;
  check(!devs.some(d => d.id === devA.id), "合并后源设备标签已删除");
  r = await call("POST", "/api/devices/merge", e0, { body: { from: devB.id, to: devB.id } });
  check(r.status === 400, "合并到自身 → 400");

  /* ===== 基线组（第 0 步前既有）：时间范围 ===== */
  group("时间范围 / 分页 / 导出");
  await db.prepare("INSERT INTO messages(device_id, sender, content, received_at, source) SELECT id,'oldsender','range-old','2000-01-01 00:00:00','sms' FROM devices LIMIT 1").run();
  r = await call("GET", "/api/messages?range=1d&limit=100", e0);
  check(r.data && !r.data.list.some(m => m.content === "range-old"), "range=1d 排除极旧消息");
  r = await call("GET", "/api/messages?range=7d&limit=100", e0);
  check(r.data && !r.data.list.some(m => m.content === "range-old") && r.data.list.length >= 1, "range=7d 排除极旧、保留近期");

  r = await call("GET", "/api/messages?limit=2&page=1", e0);
  check(r.data && r.data.limit === 2 && r.data.list.length <= 2, "limit=2 生效且返回不超过 2 条");

  const er = await fetchApp(R("GET", "/api/export?format=csv", {}), e0);
  const csv = await er.text();
  check(er.status === 200 && /text\/csv/.test(er.headers.get("Content-Type") || ""), "导出 CSV 响应类型正确");
  check(/id,time,device,sim,sender,source,content/.test(csv), "CSV 含表头");
  check(/attachment; filename="smstoweb-/.test(er.headers.get("Content-Disposition") || ""), "CSV 带附件下载头");

  const jr = await fetchApp(R("GET", "/api/export?format=json", {}), e0);
  const jdata = await jr.json();
  check(Array.isArray(jdata) && jdata.length >= 1, "导出 JSON 为数组且有数据");

  await call("POST", "/api/push?token=tok", e0, { body: { content: "=1+1", time: "2026-10-18 10:00:00" } });
  const er2 = await fetchApp(R("GET", "/api/export?format=csv&q=%3D1%2B1", {}), e0);
  const csv2 = await er2.text();
  check(/'=1\+1/.test(csv2), "CSV 公式注入被前置单引号防护");

  /* ===== 基线组（第 0 步前既有）：号码归属地 ===== */
  group("号码归属地 / 内置号码库");
  r = await call("GET", "/api/phone?number=13800138000", env({ PHONE_AREA_ENABLED: "false" }));
  check(r.data && r.data.found === false && r.data.disabled === true, "PHONE_AREA_ENABLED=false → 不外呼、返回 disabled");
  r = await call("GET", "/api/phone?number=abc", e0);
  check(r.data && r.data.found === false, "非法号码 → found:false");
  r = await call("GET", "/api/phone?number=10086", e0);
  check(r.data && r.data.found === false, "非手机号（短号）→ 不查询归属地");
  /* /api/phone 上游限速：自定义不可达 API（127.0.0.1:1 立即拒连），独立 XFF 桶，超 120/分→429 */
  const ePhone = env({ PHONE_AREA_API: "http://127.0.0.1:1/{number}" });
  let sawPhone429 = false;
  for (let i = 0; i < 140 && !sawPhone429; i++) {
    const rr = await call("GET", "/api/phone?number=138" + String(10000000 + i), ePhone, { headers: { "X-Forwarded-For": "198.51.100.7" } });
    if (rr.status === 429) sawPhone429 = true;
  }
  check(sawPhone429, "/api/phone 上游查询限速生效（120 次/分，超限 429）");
  const page2 = await (await fetchApp(R("GET", "/", {}), e0)).text();
  check(/NUM_LABELS/.test(page2) && /fillAreas/.test(page2), "管理页内置号码库与归属地填充逻辑存在");

  /* ===== 基线组（第 0 步前既有）：批量软删除 ===== */
  group("批量删除 / 恢复 / 清空（软删除）");
  await call("POST", "/api/push?token=tok", e0, { body: { name: "批量设备", content: "batch-1", time: "2026-10-19 08:00:00" } });
  await call("POST", "/api/push?token=tok", e0, { body: { name: "批量设备", content: "batch-2", time: "2026-10-19 08:01:00" } });
  const batchMsgs = (await call("GET", "/api/messages?q=batch-&limit=100", e0)).data.list;
  const batchIds = batchMsgs.map(function (m) { return m.id; });
  check(batchIds.length === 2, "准备两条批量消息");
  r = await call("POST", "/api/messages/remove", e0, { body: { ids: batchIds } });
  check(r.data && r.data.success && r.data.removed === 2, "批量软删除 2 条");
  r = await call("GET", "/api/messages?q=batch-&limit=100", e0);
  check(r.data && r.data.list.length === 0, "软删除后列表不再返回");
  r = await call("POST", "/api/messages/restore", e0, { body: { ids: batchIds } });
  check(r.data && r.data.restored === 2, "恢复 2 条");
  r = await call("GET", "/api/messages?q=batch-&limit=100", e0);
  check(r.data && r.data.list.length === 2, "恢复后重新可见");
  const devBatch = (await call("GET", "/api/devices", e0)).data.list.find(function (d) { return d.display_name === "批量设备"; });
  r = await call("POST", "/api/messages/clear", e0, { body: { device_id: devBatch.id } });
  check(r.data && r.data.success && r.data.removed === 2, "按设备清空 2 条");
  r = await call("GET", "/api/messages?device_id=" + devBatch.id, e0);
  check(r.data && r.data.total === 0, "清空后该设备无消息");
  /* P1 回归：设备消息全部软删后，msg_count 应归零（不含软删记录，否则 × 删除按钮被隐藏） */
  const devAfterClear = (await call("GET", "/api/devices", e0)).data.list.find(function (d) { return d.id === devBatch.id; });
  check(devAfterClear && devAfterClear.msg_count === 0, "设备消息全部软删后 msg_count=0（不含软删记录）");
  r = await call("DELETE", "/api/devices/" + devBatch.id, e0);
  check(r.data && r.data.success === true && r.data.deleted === 1, "软删全部消息后可直接删除设备标签（UI × 有出现条件）");

  /* ===== 基线组（第 0 步前既有）：收藏/统计/PWA ===== */
  group("收藏 / 已读 / 统计 / PWA");
  const mlist = (await call("GET", "/api/messages?limit=100", e0)).data.list;
  const mid = mlist[0].id;
  r = await call("POST", "/api/messages/star", e0, { body: { id: mid, starred: true } });
  check(r.data && r.data.success && r.data.starred === 1, "收藏消息");
  r = await call("GET", "/api/messages?starred=1&limit=100", e0);
  check(r.data && r.data.list.some(function (m) { return m.id === mid; }), "只看收藏包含该消息");
  r = await call("POST", "/api/messages/star", e0, { body: { id: mid, starred: false } });
  check(r.data && r.data.starred === 0, "取消收藏");
  r = await call("POST", "/api/messages/read", e0, { body: { id: mid, read: true } });
  check(r.data && r.data.success && r.data.read === true, "标为已读");
  r = await call("GET", "/api/messages?unread=1&limit=100", e0);
  check(r.data && !r.data.list.some(function (m) { return m.id === mid; }), "只看未读排除已读消息");
  r = await call("POST", "/api/messages/read", e0, { body: { id: mid, read: false } });
  check(r.data && r.data.read === false, "标为未读");
  r = await call("GET", "/api/stats", e0);
  check(r.data && r.data.success && typeof r.data.total === "number" && Array.isArray(r.data.sources) && Array.isArray(r.data.days), "统计接口返回");
  const mf = await fetchApp(R("GET", "/manifest.webmanifest", {}), e0);
  check(mf.status === 200 && /manifest/.test(mf.headers.get("Content-Type") || ""), "manifest 可访问");
  const swr = await fetchApp(R("GET", "/sw.js", {}), e0);
  check(swr.status === 200 && /addEventListener/.test(await swr.text()), "service worker 可访问");

  /* ===== 基线组（第 0 步前既有）：登录鉴权 ===== */
  group("登录鉴权 / http cookie 降级 / 防锁死");
  const eAuth = env({ ENABLE_AUTH: "true", ADMIN_PASSWORD: "secret" });
  r = await call("GET", "/api/messages", eAuth);
  check(r.status === 401, "开登录后无 cookie → 401");
  r = await call("POST", "/api/login", eAuth, { body: { password: "wrong" } });
  check(r.status === 403, "登录密码错误 → 403");
  r = await call("POST", "/api/login", eAuth, { body: { password: "secret" } });
  check(r.status === 200 && r.data && r.data.success === true, "登录密码正确 → 200");
  check(/sms_auth=/.test(r.setCookie), "登录下发 sms_auth cookie");
  check(!/Secure/i.test(r.setCookie), "http 下 cookie 不带 Secure（降级，修复 Alook 登录）");
  const cookie = (r.setCookie.match(/sms_auth=([^;]*)/) || [])[1] || "";
  r = await call("GET", "/api/messages", eAuth, { cookie: "sms_auth=" + cookie });
  check(r.status === 200, "带登录 cookie → 200");
  const page = await (await fetchApp(R("GET", "/", {}), eAuth)).text();
  check(/登 录/.test(page), "无 cookie 访问 / → 返回登录页");
  r = await call("POST", "/api/push?token=tok", eAuth, { body: { content: "still works under auth" } });
  check(r.status === 200, "开登录后 /api/push 仍可推送（公开接口）");
  r = await call("GET", "/api/messages", env({ ENABLE_AUTH: "true", ADMIN_PASSWORD: "" }));
  check(r.status === 401, "ENABLE_AUTH=true 但密码为空 → 受保护接口 401（不放行，安全默认）");

  /* ===== 基线组（第 0 步前既有）：写入限速 ===== */
  group("写入接口限速");
  let saw429 = false, allowed = 0;
  for (let i = 0; i < 260 && !saw429; i++) {
    const rr = await call("POST", "/api/push?token=tok", e0, { body: { content: "burst " + i } });
    if (rr.status === 429) saw429 = true; else if (rr.status === 200) allowed++;
  }
  check(saw429 && allowed >= 1 && allowed < 260, "限速生效：放行一批后开始返回 429");

  /* ===== 基线组（第 0 步前既有）：安全响应头 ===== */
  group("安全响应头 / /api/cron HTTP 触发（CF 入口）/ XFF 防伪造");
  const homeR = await fetchApp(R("GET", "/", {}), e0);
  check(homeR.status === 200 && homeR.headers.get("X-Content-Type-Options") === "nosniff", "管理页响应带 X-Content-Type-Options: nosniff");
  check(homeR.headers.get("X-Frame-Options") === "DENY", "管理页响应带 X-Frame-Options: DENY（防 iframe 点击劫持）");
  check(homeR.headers.get("Referrer-Policy") === "no-referrer", "管理页响应带 Referrer-Policy: no-referrer");
  const apiR = await fetchApp(R("GET", "/api/messages", {}), e0);
  check(apiR.headers.get("X-Content-Type-Options") === "nosniff" && apiR.headers.get("X-Frame-Options") === "DENY", "API 响应同样带安全响应头");
  /* /api/cron：Cloudflare 入口（fetchApp 内路由）与移植平台入口行为一致 */
  r = await fetchApp(R("GET", "/api/cron", {}), e0);
  check(r.status === 403, "fetchApp /api/cron 无 token → 403");
  r = await fetchApp(R("GET", "/api/cron?token=tok", {}), e0);
  check(r.status === 200, "fetchApp /api/cron 带 token → 200（CF 侧外部 cron 可用）");
  /* XFF 左段可伪造：轮换伪造左段但保持末段不变，限速桶不应被绕过 */
  let saw429xff = false;
  for (let i = 0; i < 260 && !saw429xff; i++) {
    const rr = await call("POST", "/api/push?token=tok", e0, {
      headers: { "X-Forwarded-For": "10.9." + (i % 250) + "." + ((i * 7) % 250) + ", 203.0.113.9" },
      body: { content: "xff-spoof " + i },
    });
    if (rr.status === 429) saw429xff = true;
  }
  check(saw429xff, "XFF 左段伪造不绕过写入限速（clientIp 取末段）");

  /* ===== 基线组（第 0 步前既有）：多语言/兼容 ===== */
  group("中英双语 / 移动端 / 平台兼容");
  const coreSrc = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  /* 取出 I18N 字面量求值，检查中英字典键集完全一致（防漏翻） */
  const i18nAt = coreSrc.indexOf("var I18N = {");
  const i18nClose = coreSrc.indexOf("};", i18nAt);
  const i18nLit = coreSrc.slice(coreSrc.indexOf("{", i18nAt), i18nClose + 1);
  let I18N = null;
  try { I18N = new Function("return " + i18nLit + ";")(); } catch (e) { I18N = null; }
  const CORE_LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt-BR"];
  check(!!I18N && CORE_LANGS.every(function (l) { return I18N[l]; }), "管理页内置九语言字典（zh-CN/zh-TW/en/ja/ko/es/fr/de/pt-BR）");
  if (I18N && I18N["zh-CN"] && I18N.en) {
    const has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
    const zk = Object.keys(I18N["zh-CN"]).sort();
    /* 1) 九语言键集与 zh-CN 完全一致（防漏翻） */
    let keyMismatch = "";
    for (const L of CORE_LANGS) {
      if (!I18N[L]) continue;
      const lk = Object.keys(I18N[L]).sort();
      const missing = zk.filter(function (k) { return !has(I18N[L], k); });
      const extra = lk.filter(function (k) { return !has(I18N["zh-CN"], k); });
      if (missing.length || extra.length) keyMismatch += L + "(缺:" + missing.join(",") + " 多:" + extra.join(",") + "); ";
    }
    check(!keyMismatch, "九语言键集一致（zh-CN " + zk.length + " 项；差异：" + (keyMismatch || "无") + "）");
    /* 2) 带变量的文案保留占位符 */
    let phMissing = "";
    for (const L of CORE_LANGS) {
      if (!I18N[L]) continue;
      if (String(I18N[L].total).indexOf("{n}") < 0 || String(I18N[L].pageOf).indexOf("{a}") < 0) phMissing += L + " ";
    }
    check(!phMissing, "九语言 total/pageOf 保留 {n}/{a} 占位符（违例：" + (phMissing || "无") + "）");
    /* 3) 空值守护：任何语言的任何键不得为空串 */
    let empties = "";
    for (const L of CORE_LANGS) {
      if (!I18N[L]) continue;
      for (const k of zk) if (String(I18N[L][k] == null ? "" : I18N[L][k]).trim() === "") empties += L + "." + k + " ";
    }
    check(!empties, "九语言无空值（空：" + (empties || "无") + "）");
    /* 4) 值语言守护（键集一致不防值互换/静默回退）：
       zh-CN 值须含中文；en/es/fr/de/pt-BR 值不得含任何 CJK（汉字/假名/谚文）；
       ja 至少一键含假名、ko 至少一键含谚文；langBtn 为 🌐 符号，白名单放行 */
    const cjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
    const langSafe = { langBtn: 1 };
    let badLang = "";
    for (const L of CORE_LANGS) {
      if (!I18N[L]) continue;
      if (L === "zh-CN") {
        const bad = zk.filter(function (k) { return !langSafe[k] && !/[\u4e00-\u9fff]/.test(String(I18N[L][k])); });
        if (bad.length) badLang += L + ":" + bad.join(",") + "; ";
      } else if (L === "zh-TW") {
        /* 繁体抽查：特征键须为台湾用语（简体字回退即失败） */
        const twProbe = { devices: "裝置", settings: "設定", del: "刪除", save: "儲存", loading: "載入" };
        const bad = Object.keys(twProbe).filter(function (k) { return String(I18N[L][k]).indexOf(twProbe[k]) < 0; });
        if (bad.length) badLang += L + ":" + bad.join(",") + "; ";
      } else if (L === "ja") {
        /* 日语大量使用纯汉字词（設定/削除/統計），不能按"含假名"逐键校验；
           改用日语特征词抽查：設/削/コ 等字形在简体中文里不会出现，可防误用简体中文 */
        const jaProbe = { settings: "設定", del: "削除", copy: "コピー", save: "保存" };
        const bad = Object.keys(jaProbe).filter(function (k) { return String(I18N[L][k]).indexOf(jaProbe[k]) < 0; });
        if (bad.length) badLang += L + ":" + bad.join(",") + "; ";
      } else if (L === "ko") {
        const anyHangul = zk.some(function (k) { return /[\uac00-\ud7af]/.test(String(I18N[L][k])); });
        if (!anyHangul) badLang += L + "(谚文缺失); ";
      } else { /* en / es / fr / de / pt-BR */
        const bad = zk.filter(function (k) { return !langSafe[k] && cjk.test(String(I18N[L][k])); });
        if (bad.length) badLang += L + ":" + bad.join(",") + "; ";
      }
    }
    check(!badLang, "值语言守护（zh 系含中文、拉丁系无 CJK、ja 含假名、ko 含谚文；违例：" + (badLang || "无") + "）");
    /* 5) 拉丁系与 en 复制检测：多数键值不得与 en 完全相同（纯符号/品牌词键白名单外抽样容差） */
    const latin = ["es", "fr", "de", "pt-BR"];
    let copied = "";
    for (const L of latin) {
      if (!I18N[L]) continue;
      const same = zk.filter(function (k) { return String(I18N[L][k]) === String(I18N.en[k]); });
      if (same.length > zk.length * 0.5) copied += L + "(" + same.length + "项同en) ";
    }
    check(!copied, "拉丁系译文非 en 原样复制（违例：" + (copied || "无") + "）");
  }
  const pageHtml = await (await fetchApp(R("GET", "/", {}), e0)).text();
  check(/data-i18n="stats"/.test(pageHtml) && /data-i18n-ph="searchPh"/.test(pageHtml),
    "管理页静态文案带 data-i18n 标注");
  check(/id="langbtn"/.test(pageHtml) && /sms_lang/.test(pageHtml), "头部语言切换按钮与本地记忆");
  check(/function applyI18n/.test(pageHtml) && /function T\(key, vars\)/.test(pageHtml), "i18n 运行时（T / applyI18n）已注入");
  check(/r\.status === 401/.test(pageHtml) && /location\.reload/.test(pageHtml),
    "登录过期 401 → 整页重载到登录页（不停在加载失败）");
  check(/setAttribute\("data-dev"/.test(pageHtml) && /function markActiveTabs/.test(pageHtml) && !/renderTabs/.test(pageHtml),
    "设备 tab 切换仅更新激活态（不再重复拉 /api/devices）");
  check(/viewport-fit=cover/.test(pageHtml) && /apple-mobile-web-app-capable/.test(pageHtml),
    "移动端 viewport 安全区 / PWA meta 就位");
  check(/format-detection" content="telephone=no/.test(pageHtml), "禁用 iOS 号码自动识别，避免吞掉发件号");
  const eLogin = env({ ENABLE_AUTH: "true", ADMIN_PASSWORD: "secret" });
  const loginHtml = await (await fetchApp(R("GET", "/", {}), eLogin)).text();
  check(/loginPw/.test(loginHtml) && /Sign in/.test(loginHtml) && /id="langbtn"/.test(loginHtml),
    "登录页同样支持多语言切换");
  check(/ログイン/.test(loginHtml) && /Anmelden/.test(loginHtml) && /Entrar/.test(loginHtml) && /Se connecter/.test(loginHtml),
    "登录页 D 字典含九语言文案（ja/de/pt-BR/fr 抽查）");
  const mani = await (await fetchApp(R("GET", "/manifest.webmanifest", {}), e0)).json();
  check(mani && mani.lang && mani.scope === "/" && Array.isArray(mani.display_override),
    "manifest 含 lang / scope / display_override");
  check(mani && Array.isArray(mani.icons) && mani.icons.length === 1 && mani.icons[0].sizes === "any",
    "manifest 图标尺寸如实标注（.ico 用 sizes:any，不再虚标 192/512）");
  const swTxt = await (await fetchApp(R("GET", "/sw.js", {}), e0)).text();
  check(/caches\.open/.test(swTxt) && /indexOf\('\/api\/'\)===0/.test(swTxt),
    "Service Worker 缓存页面壳且跳过 /api/");
  /* 长轮询时长可配：WAIT_MAX_SECONDS=3 应在 ~3s 内返回（适配 Netlify 10s 函数超时） */
  const t0 = Date.now();
  const w = await call("GET", "/api/wait?last_id=999999", env({ WAIT_MAX_SECONDS: "3" }));
  const elapsed = Date.now() - t0;
  check(w.data && w.data.changed === false && elapsed >= 2500 && elapsed < 6000,
    "WAIT_MAX_SECONDS 生效（实测 " + elapsed + "ms）");

  /* 在沙箱里求值页面内的 i18n + 日期函数，验证中英实际输出（不依赖浏览器） */
  const sliceStart = coreSrc.indexOf("var MONTHS =");
  const sliceEnd = coreSrc.indexOf("/* 验证码提取");
  let mkI18n = null;
  if (sliceStart > 0 && sliceEnd > sliceStart) {
    try {
      const body = coreSrc.slice(sliceStart, sliceEnd) + "\nreturn { T: T, fmtTime: fmtTime, relTime: relTime, dayLabel: dayLabel };";
      const noopEl = { setAttribute: function () {}, textContent: "" };
      const fakeDoc = { documentElement: {}, querySelectorAll: function () { return []; }, getElementById: function () { return null; } };
      mkI18n = function (lang) {
        return new Function("LANG", "document", "window", "location", "localStorage", "$", "esc", body)(
          lang, fakeDoc, {}, {}, { getItem: function () { return null; }, setItem: function () {} },
          function () { return null; }, function (s) { return String(s == null ? "" : s); }
        );
      };
    } catch (e) { mkI18n = null; }
  }
  check(!!mkI18n, "i18n / 日期函数可在沙箱中求值");
  if (mkI18n) {
    const z = mkI18n("zh-CN"), en = mkI18n("en");
    check(z.T("total", { n: 3 }) === "共 3 条" && en.T("total", { n: 3 }) === "3 messages",
      "文案插值按语言输出（共 3 条 / 3 messages）");
    check(z.T("pageOf", { a: 1, b: 4 }) === "第 1 / 4 页" && en.T("pageOf", { a: 1, b: 4 }) === "Page 1 of 4",
      "分页文案按语言输出");
    check(z.T("noSuchKey") === "noSuchKey", "缺失键回退为键名（不抛错）");
    /* 旧值兼容：T 兜底链为 I18N[LANG] → I18N.en，绝不静默回退中文 */
    check(en.T("devices") === "Devices" && mkI18n("zh-TW").T("devices") === "裝置標籤",
      "zh-TW 字典生效（繁体输出）");
    check(mkI18n("fr").T("del") === "Supprimer" && mkI18n("de").T("save") === "Speichern",
      "fr / de 字典生效");
    const t = "2026-10-19 10:30:00"; /* UTC → 北京 18:30 */
    check(z.fmtTime(t) === "2026年10月19日 18:30:00", "中文完整时间格式（不变）");
    check(zhTW_fmtTime(mkI18n, t), "zh-TW / ja 年月日完整时间格式");
    check(/Oct\s*19.*18:30/.test(en.fmtTime(t)) && /2026/.test(en.fmtTime(t)),
      "英文完整时间格式走 Intl（含 Oct 19 / 2026 / 18:30）");
    const nowMs = Date.now();
    const nowUtc = new Date(nowMs).toISOString().replace("T", " ").slice(0, 19);
    check(z.dayLabel(nowUtc) === "今天" && en.dayLabel(nowUtc) === "Today", "日期分组标签按语言输出");
    check(mkI18n("ja").dayLabel(nowUtc) === "今日" && mkI18n("ko").dayLabel(nowUtc) === "오늘"
      && mkI18n("es").dayLabel(nowUtc) === "Hoy" && mkI18n("de").dayLabel(nowUtc) === "Heute",
      "ja/ko/es/de 日期分组标签输出");
    check(en.relTime(new Date(nowMs - 5 * 60000).toISOString().replace("T", " ").slice(0, 19)) === "5 min ago",
      "英文相对时间（5 min ago）");
    check(z.relTime(new Date(nowMs - 5 * 60000).toISOString().replace("T", " ").slice(0, 19)) === "5 分钟前",
      "中文相对时间（5 分钟前）");
    check(mkI18n("ja").relTime(new Date(nowMs - 5 * 60000).toISOString().replace("T", " ").slice(0, 19)) === "5 分前"
      && mkI18n("ko").relTime(new Date(nowMs - 5 * 60000).toISOString().replace("T", " ").slice(0, 19)) === "5분 전",
      "ja/ko 相对时间输出");
  }

  /* 语言探测归一化：旧值 zh/en 兼容、变体映射、探测失败回退 en（绝不回退中文） */
  {
    const probeStart = coreSrc.indexOf("var LANGS = [");
    const probeEnd = coreSrc.indexOf("var MONTHS =");
    let probe = null;
    if (probeStart > 0 && probeEnd > probeStart) {
      try {
        const body = coreSrc.slice(probeStart, probeEnd) + "\nreturn LANG;";
        probe = function (opts) {
          const o = opts || {};
          return new Function("location", "localStorage", "navigator", body)(
            { search: o.qs ? "?lang=" + o.qs : "" },
            { getItem: function () { return o.ls === undefined ? null : o.ls; }, setItem: function () {} },
            { languages: o.navs, language: o.nav || "" }
          );
        };
      } catch (e) { probe = null; }
    }
    check(!!probe, "语言探测段可在沙箱中求值");
    if (probe) {
      check(probe({ qs: "zh" }) === "zh-CN" && probe({ ls: "zh" }) === "zh-CN", "旧值 zh → zh-CN 归一化（?lang 与 localStorage 双通道）");
      check(probe({ qs: "zh-TW" }) === "zh-TW" && probe({ qs: "zh_HK" }) === "zh-TW", "繁体变体归一化 zh-TW");
      check(probe({ qs: "pt" }) === "pt-BR" && probe({ ls: "pt" }) === "pt-BR", "pt → pt-BR 归一化");
      check(probe({ qs: "fr" }) === "fr" && probe({ ls: "ja" }) === "ja" && probe({ ls: "ko" }) === "ko", "九语言代码直通");
      check(probe({ qs: "xx", ls: "de" }) === "de", "?lang 非法时回退 localStorage");
      check(probe({ navs: ["pt", "en"] }) === "pt-BR" && probe({ navs: ["zh_HK", "en"] }) === "zh-TW",
        "navigator.languages 逐个匹配（含变体）");
      check(probe({}) === "en", "探测全空回退 en（不回退中文）");
    }
  }

  /* zh-TW/ja 完整时间格式（年月日模板）——独立 helper 便于失败定位 */
  function zhTW_fmtTime(mk, t) {
    try {
      const tw = mk("zh-TW").fmtTime(t), ja = mk("ja").fmtTime(t);
      return tw === "2026年10月19日 18:30:00" && ja === "2026年10月19日 18:30:00";
    } catch (e) { return false; }
  }

  /* 验证码提取七级级联回归：码在前（①②）必须先于关键词在前（③④）——关键词在前模式
     允许跨短 gap，曾把「123456是您的验证码，您有2000积分待领取」里的 2000 误当验证码 */
  /* ===== 基线组（第 0 步前既有）：验证码提取 ===== */
  group("验证码提取（七级级联回归）");
  {
    const ecStart = coreSrc.indexOf("function extractCode(");  /* 带括号避免命中后端 extractCodeLite */
    const ecEnd = coreSrc.indexOf("/* 内容链接化");
    let extractCode = null;
    try { extractCode = new Function(coreSrc.slice(ecStart, ecEnd) + "\nreturn extractCode;")(); } catch (e) { extractCode = null; }
    check(!!extractCode, "extractCode 可在沙箱中求值");
    if (extractCode) {
      const cases = [
        ["您的验证码是482910，10分钟内有效", "482910", "②关键词在前+纯数字"],
        ["取件码 8-2-307，请至丰巢柜取件", "82307", "①关键词在前+分隔码"],
        ["验证码 1234 5678，请分别输入", "12345678", "①分隔码不被截断"],
        ["123456是您的验证码，10分钟内输入", "123456", "③码在前+纯数字"],
        ["123456是您的验证码，您有2000积分待领取", "123456", "③码在前优先于后续数字（回归：不得取 2000）"],
        ["8-2-307 是您的取件码", "82307", "③码在前+分隔式（回归）"],
        ["G-383838 是您的 Google 验证码", "383838", "④Google 风格"],
        ["您的登录码 a1b2c3 请勿泄露", "a1b2c3", "⑤字母数字混合"],
        ["验证码 482910，请勿告知 13812345678", "482910", "剥离手机号"],
        ["【某App】您的订单20261020123456已发出", "", "无验证码关键词不提取"],
        ["1234567890是您的验证码", "", "超长数字串不从内部截取"],
      ];
      for (const c of cases) {
        let got = "";
        try { got = extractCode(c[0]); } catch (e) { got = "<throw:" + e.message + ">"; }
        check(got === c[1], c[2] + "：" + JSON.stringify(c[0]) + " → " + JSON.stringify(got));
      }
    }
  }

  /* 服务端轻量验证码检测（extractCodeLite，供 11 渠道通知三态渲染共用）：
     与前端 extractCode 同级联顺序铁律——码在前先于关键词在前，检测前剥离手机号/日期/时间/金额/单号 */
  /* ===== 基线组（第 0 步前既有）：extractCodeLite ===== */
  group("服务端轻量验证码检测 extractCodeLite");
  {
    const eclStart = coreSrc.indexOf("function extractCodeLite");
    const eclEnd = coreSrc.indexOf("function buildNotifyInfo");
    let extractCodeLite = null;
    try { extractCodeLite = new Function(coreSrc.slice(eclStart, eclEnd) + "\nreturn extractCodeLite;")(); } catch (e) { extractCodeLite = null; }
    check(!!extractCodeLite, "extractCodeLite 可在沙箱中求值");
    if (extractCodeLite) {
      const cases = [
        ["123456是您的验证码", "123456", "码在前"],
        ["123456是您的验证码，您有2000积分待领取", "123456", "码在前优先于后续数字（回归）"],
        ["您的验证码是482910，10分钟内有效", "482910", "关键词在前"],
        ["验证码 1234 5678，请分别输入", "12345678", "分隔码先于纯数字"],
        ["G-383838 是您的 Google 验证码", "383838", "Google 风格"],
        ["验证码 482910，请勿告知 13812345678", "482910", "剥离手机号"],
        ["您消费2000元，验证码是482910", "482910", "剥离金额（回归：不得取 2000）"],
        ["2026-10-27 发出，验证码482910", "482910", "剥离日期"],
        ["【某App】您的订单20261020123456已发出", "", "无验证码关键词不提取"],
        ["1234567890是您的验证码", "", "超长数字串不从内部截取"],
      ];
      for (const c of cases) {
        let got;
        try { got = extractCodeLite(c[0]); } catch (e) { got = "<throw:" + e.message + ">"; }
        check(got === c[1], c[2] + "：" + JSON.stringify(c[0]) + " → " + JSON.stringify(got));
      }
    }
  }

  /* 11 渠道通知渲染 E2E：fetch 桩拦截 postNotify 出站请求，断言各渠道 payload。
     node 平台 bgRun 无 ctx → dispatchNotify 内联 await，响应返回前转发已完成 */
  /* ===== 基线组（第 0 步前既有）：通知渲染 ===== */
  group("11 渠道通知渲染（fetch 桩 E2E）");
  {
    const realFetch = globalThis.fetch;
    const hits = [];
    globalThis.fetch = async function (url, opts) {
      hits.push({ url: String(url), headers: (opts && opts.headers) || {}, body: (opts && typeof opts.body === "string" ? opts.body : "") });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
      const eN = env({
        NOTIFY_LINK: "https://sms.example.com",
        FEISHU_WEBHOOK: "https://open.feishu.cn/open-apis/bot/v2/hook/x",
        WECOM_WEBHOOK: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x",
        DINGTALK_WEBHOOK: "https://oapi.dingtalk.com/robot/send?access_token=x",
        SERVERCHAN_SENDKEY: "sct-x",
        PUSHPLUS_TOKEN: "pp-x",
        TELEGRAM_BOT_TOKEN: "tg-tok",
        TELEGRAM_CHAT_ID: "12345",
        BARK_DEVICE_KEY: "bark-key",
        BARK_URL: "https://bark.example.com",
        NTFY_URL: "https://ntfy.sh/sms-topic",
        GOTIFY_URL: "https://gotify.example.com",
        GOTIFY_TOKEN: "g-tok",
        RESEND_API_KEY: "re-x",
        MAIL_TO: "a@example.com",
        MAIL_FROM: "s@example.com",
        GENERIC_WEBHOOKS: "https://gw.example.com/hook",
      });
      const T = "🔐 验证码 726418 · Gitee";
      const hit = (kw) => hits.find(h => h.url.indexOf(kw) !== -1);
      const J = (h) => JSON.parse(h.body);

      /* 回合 1：含验证码短信 → verify 态，11 渠道各 1 次。
         独立 XFF 桶：套件前段写入限速测试已耗尽默认 IP 的 120 次/分配额，换 IP 避开 429 */
      const XFF = { "X-Forwarded-For": "203.0.113.77" };
      let rr = await call("POST", "/api/receive?token=tok", eN, { body: { name: "主力机", sim: "13800000000", from: "Gitee", content: "您的验证码是726418，5分钟内有效", time: "2026-10-27 14:23:45" }, headers: XFF });
      check(rr.status === 200 && rr.data && rr.data.duplicated === false, "verify 态 receive 入库成功");
      check(hits.length === 11, "配置 11 渠道 → 转发 11 次（got " + hits.length + "）");

      const fh = J(hit("open.feishu.cn"));
      check(fh.msg_type === "interactive" && fh.card.header.template === "violet" && fh.card.header.title.content === "🔐 验证码提醒", "飞书：interactive + violet 卡头");
      check(JSON.stringify(fh.card.elements).indexOf("726418") !== -1 && JSON.stringify(fh.card.elements).indexOf("https://sms.example.com") !== -1, "飞书：码入卡片 + 打开管理页按钮");

      const wc = J(hit("qyapi.weixin.qq.com")).markdown.content;
      check(wc.indexOf("> `726418`") !== -1 && wc.indexOf("[打开管理页](https://sms.example.com)") !== -1, "企微：引用块放码 + 链接行");

      const dd = J(hit("oapi.dingtalk.com")).markdown;
      check(dd.title === T && dd.text.indexOf("### 🔐 验证码提醒") === 0 && dd.text.indexOf("**726418**") !== -1, "钉钉：title 进会话列表 + ### 标题");

      const sc = new URLSearchParams(hit("sctapi.ftqq.com").body);
      check(sc.get("title") === T && sc.get("desp").indexOf("**726418**") !== -1, "Server酱：title ≤32 + desp markdown");

      const pp = J(hit("pushplus.plus"));
      check(pp.title === T && pp.template === "markdown" && pp.content.indexOf("**726418**") !== -1, "PushPlus：markdown 模板");

      const tg = J(hit("api.telegram.org"));
      check(tg.parse_mode === "HTML" && tg.link_preview_options.is_disabled === true && tg.text.indexOf("<blockquote><b>726418</b>") !== -1 && tg.text.indexOf("来源：<b>Gitee</b>") !== -1, "Telegram：HTML + blockquote 放码");

      const bk = J(hit("bark.example.com"));
      check(bk.title === T && bk.copy === "726418" && bk.autoCopy === 1 && bk.level === "timeSensitive" && bk.group === "sms" && bk.url === "https://sms.example.com", "Bark：码进 title + copy 自动复制 + timeSensitive + url");

      const nf = J(hit("ntfy.sh"));
      check(nf.topic === "sms-topic" && nf.tags[0] === "lock" && nf.priority === 4 && nf.click === "https://sms.example.com", "ntfy：lock tag + priority 4 + click");

      const gt = J(hit("gotify.example.com"));
      check(gt.priority === 8 && gt.extras["client::display"].contentType === "text/markdown" && gt.message.indexOf("**726418**") !== -1, "Gotify：extras markdown + priority 8");

      const rs = J(hit("api.resend.com"));
      check(rs.subject === T && rs.html.indexOf("726418") !== -1 && rs.html.indexOf("border:2px dashed") !== -1 && rs.text.indexOf("【🔐 验证码提醒】726418") !== -1, "Resend：HTML 模板 + 纯文本降级");

      const gw = J(hit("gw.example.com"));
      check(gw.type === "verify" && gw.code === "726418" && gw.sender === "Gitee", "通用 Webhook：payload 含 type/code");

      /* 回合 2：无验证码 push（notify）→ 三态切换与可选字段省略 */
      hits.length = 0;
      rr = await call("POST", "/api/push?token=tok", eN, { body: { source: "notify", sender: "NAS-Download", name: "家庭NAS", content: "qBittorrent：镜像下载完成（5.2 GB）", time: "2026-10-27 15:00:00" }, headers: XFF });
      check(rr.status === 200, "notify 态 push 入库成功");
      check(hits.length === 11, "notify 态仍转发 11 次");
      check(J(hit("open.feishu.cn")).card.header.template === "turquoise", "飞书：notify 态 turquoise 卡头");
      const bk2 = J(hit("bark.example.com"));
      check(bk2.copy === undefined && bk2.autoCopy === undefined && bk2.level === "active" && bk2.group === "notify", "Bark：无码省略 copy + active");
      const nf2 = J(hit("ntfy.sh"));
      check(nf2.priority === 3 && nf2.tags === undefined, "ntfy：无码 priority 3 且无 tags");
      check(J(hit("gotify.example.com")).priority === 5, "Gotify：无码 priority 5");
      const gw2 = J(hit("gw.example.com"));
      check(gw2.type === "notify" && gw2.code === "", "通用 Webhook：notify 态 type/code");

      /* 回合 3：无验证码短信 → sms 态 + Telegram HTML 转义 */
      hits.length = 0;
      rr = await call("POST", "/api/receive?token=tok", eN, { body: { name: "主力机", sim: "13800000000", from: "中国联通", content: "话费余额<10元，请及时充值", time: "2026-10-27 15:10:00" }, headers: XFF });
      check(rr.status === 200, "sms 态 receive 入库成功");
      check(J(hit("open.feishu.cn")).card.header.template === "blue", "飞书：sms 态 blue 卡头");
      check(J(hit("api.telegram.org")).text.indexOf("话费余额&lt;10元") !== -1, "Telegram：HTML 转义 <");
      check(J(hit("gw.example.com")).type === "sms", "通用 Webhook：sms 态 type");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  /* ===== 基线组（第 0 步前既有）：会话安全 ===== */
  group("会话安全（无状态随机 Session / 签名 / TTL / 密钥策略）");
  {
    const eS = env({ ENABLE_AUTH: "true", ADMIN_PASSWORD: "sesspw" });
    const sessAt = coreSrc.indexOf("const SESSION_TTL_MS");
    const sessEnd = coreSrc.indexOf("/* 是否 HTTPS", sessAt);
    check(sessAt !== -1 && sessEnd > sessAt, "会话：核心含无状态 Session 实现区");
    /* 沙箱工厂：每次调用生成相互独立的"实例"（独立闭包状态），等效多实例夹具 */
    const makeInstance = (secret) => new Function("safeEqual",
      coreSrc.slice(sessAt, sessEnd) + "\nreturn { sessionSign: sessionSign, sessionParse: sessionParse };"
    )((a, b) => a === b);
    const instA = makeInstance("test-session-secret-0123456789abcdef");
    const instB = makeInstance("test-session-secret-0123456789abcdef"); /* 与 A 同密钥、状态独立 */
    const instX = makeInstance("another-rotated-secret-fedcba9876543210"); /* 不同密钥 */
    const eEnv = (secret) => ({ ADMIN_PASSWORD: "sesspw", SESSION_SECRET: secret });

    /* 1 错误密码拒绝 */
    r = await call("POST", "/api/login", eS, { body: { password: "wrong" } });
    check(r.status === 403, "会话：错误密码 → 403");

    /* 2 正确密码 + Cookie 属性（http 环境） */
    r = await call("POST", "/api/login", eS, { body: { password: "sesspw" } });
    const sc1 = r.setCookie;
    check(r.status === 200 && sc1.indexOf("sms_auth=") === 0, "会话：正确密码 → 200 + Set-Cookie");
    check(sc1.indexOf("HttpOnly") !== -1, "会话：Cookie 含 HttpOnly");
    check(sc1.indexOf("SameSite=Lax") !== -1, "会话：Cookie 含 SameSite=Lax");
    check(sc1.indexOf("Path=/") !== -1, "会话：Cookie 含 Path=/");
    check(sc1.indexOf("Max-Age=1800") !== -1, "会话：Cookie Max-Age=1800（TTL 30 分钟）");
    check(sc1.indexOf("Secure") === -1, "会话：http 环境 Cookie 不带 Secure（自动降级）");
    const tok1 = sc1.split("sms_auth=")[1].split(";")[0];

    /* 3 https 环境 Secure 属性 */
    const rHttps = await fetchApp(new Request("https://localhost/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "sesspw" }),
    }), eS);
    check((rHttps.headers.get("Set-Cookie") || "").indexOf("Secure") !== -1, "会话：https 环境 Cookie 含 Secure");
    await rHttps.text();

    /* 4 随机性：两次登录不同 + 不再是 sha256(password) 确定性派生 */
    r = await call("POST", "/api/login", eS, { body: { password: "sesspw" } });
    const tok2 = r.setCookie.split("sms_auth=")[1].split(";")[0];
    check(tok1 !== tok2, "会话：两次登录产生不同随机 Session");
    const oldDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("sms-gateway-auth-v1|sesspw"));
    const oldDerived = Array.from(new Uint8Array(oldDigest)).map(b => b.toString(16).padStart(2, "0")).join("");
    check(tok1 !== oldDerived && tok1.split(".").length === 3 && tok1.split(".")[0].length === 32,
      "会话：Session 为 nonce.exp.sig 三段随机 token，非密码哈希");

    /* 5/6/7 鉴权访问：带 Cookie 可访问 / 无 Cookie 拒绝 / 篡改签名拒绝 */
    r = await call("GET", "/api/messages", eS, { cookie: "sms_auth=" + tok1 });
    check(r.status === 200, "会话：登录 Cookie 可访问管理 API");
    r = await call("GET", "/api/messages", eS);
    check(r.status === 401, "会话：无 Cookie → 401");
    r = await call("GET", "/api/messages", eS, { cookie: "sms_auth=" + tok1.slice(0, -3) + "aaa" });
    check(r.status === 401, "会话：篡改签名 → 401");

    /* 8/9 篡改 nonce / 篡改过期时间（签名不匹配）→ 拒绝 */
    const [n1, e1, s1] = tok1.split(".");
    const flip = (hex) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
    r = await call("GET", "/api/messages", eS, { cookie: "sms_auth=" + flip(n1) + "." + e1 + "." + s1 });
    check(r.status === 401, "会话：篡改 nonce → 401");
    r = await call("GET", "/api/messages", eS, { cookie: "sms_auth=" + n1 + "." + (Number(e1) + 600000) + "." + s1 });
    check(r.status === 401, "会话：篡改过期时间 → 401");

    /* 10 过期：同 nonce 重签过去 exp（合法签名）→ 401 */
    const expiredTok = n1 + "." + (Date.now() - 1000) + "." + (await instA.sessionSign(eEnv("test-session-secret-0123456789abcdef"), n1, String(Date.now() - 1000)));
    r = await call("GET", "/api/messages", eS, { cookie: "sms_auth=" + expiredTok });
    check(r.status === 401, "会话：Session 过期 → 401");

    /* 11 随机伪造（错误密钥签发的"合法格式"token）→ 拒绝 */
    const forged = "deadbeefdeadbeefdeadbeefdeadbeef." + (Date.now() + 60000) + "." + (await instX.sessionSign(eEnv("another-rotated-secret-fedcba9876543210"), "deadbeefdeadbeefdeadbeefdeadbeef", String(Date.now() + 60000)));
    r = await call("GET", "/api/messages", eS, { cookie: "sms_auth=" + forged });
    check(r.status === 401, "会话：错误密钥伪造 token → 401");

    /* 12/13/14 多实例等效验证：独立实例同密钥互验；新实例无内存状态也可验证（无状态证明） */
    const parsed1 = await instB.sessionParse(eEnv("test-session-secret-0123456789abcdef"), tok1);
    check(!!parsed1 && parsed1.exp > Date.now(), "会话：独立实例 B（同密钥）验证实例 A 签发的 token 通过");
    const parsedX = await instX.sessionParse(eEnv("another-rotated-secret-fedcba9876543210"), tok1);
    check(parsedX === null, "会话：不同密钥实例验证同一 token 失败（密钥轮换即失效）");
    r = await call("GET", "/api/messages", eS, { cookie: "sms_auth=" + tok2 });
    check(r.status === 200, "会话：签发后未做任何实例登记，验签直接通过（无状态）");

    /* 15/16 logout 无状态语义：清 Cookie；浏览器不再携带即失效；旧 Token TTL 内可重放（显式记录的限制） */
    r = await call("POST", "/api/logout", eS, { cookie: "sms_auth=" + tok2 });
    check(r.status === 200 && (r.setCookie.indexOf("Max-Age=0") !== -1 || r.setCookie.indexOf("Expires=Thu, 01 Jan 1970") !== -1),
      "会话：logout → 200 + 清除 Cookie");
    r = await call("GET", "/api/messages", eS);
    check(r.status === 401, "会话：logout 后浏览器不携带 Cookie → 无法访问");
    r = await call("GET", "/api/messages", eS, { cookie: "sms_auth=" + tok2 });
    check(r.status === 200, "会话：logout 前复制的 Token 在 TTL 内仍可重放（无状态限制，显式记录）");
    const parsedAfterLogout = await instB.sessionParse(eEnv("test-session-secret-0123456789abcdef"), tok2);
    check(!!parsedAfterLogout, "会话：logout 不做跨实例吊销（独立实例验证仍通过，TTL 内有效）");

    /* 17/18 密钥缺失：安全失败（登录 500、鉴权 401），无密码派生回退路径；日志不含密钥 */
    const eNoSec = env({ ENABLE_AUTH: "true", ADMIN_PASSWORD: "sesspw", SESSION_SECRET: "" });
    let warned = "";
    const realWarn = console.warn;
    console.warn = (...a) => { warned += a.join(" "); };
    try {
      r = await call("POST", "/api/login", eNoSec, { body: { password: "sesspw" } });
    } finally { console.warn = realWarn; }
    check(r.status === 500, "会话：SESSION_SECRET 缺失 → 登录 500（安全失败）");
    check(!JSON.stringify(r.data).match(/sesspw|secret value/i), "会话：缺失密钥错误信息不含密码或密钥值");
    r = await call("GET", "/api/messages", eNoSec, { cookie: "sms_auth=" + tok1 });
    check(r.status === 401, "会话：SESSION_SECRET 缺失 → 鉴权一律 401（不开放管理接口）");
    check(!warned.match(/test-session-secret|sesspw/), "会话：告警日志不含密钥值与密码");

    /* 19 密钥轮换：换 SESSION_SECRET 后旧 Token 立即失效 */
    const eRot = env({ ENABLE_AUTH: "true", ADMIN_PASSWORD: "sesspw", SESSION_SECRET: "rotated-secret-9876543210abcdefgh" });
    r = await call("GET", "/api/messages", eRot, { cookie: "sms_auth=" + tok1 });
    check(r.status === 401, "会话：轮换 SESSION_SECRET 后旧 Token 失效");
    r = await call("POST", "/api/login", eRot, { body: { password: "sesspw" } });
    check(r.status === 200, "会话：轮换后新密钥登录正常");

    /* 20 Session 不经 URL 传递：登录响应体不含 token */
    check(JSON.stringify(r.data || {}).indexOf("token") === -1, "会话：登录响应体不含 token（不经 URL/正文传递）");
  }

  /* ===== 基线组（第 0 步前既有）：鉴权配置矩阵 ===== */
  group("鉴权配置矩阵（配置缺失一律不放行，配置错误区别于密码错误）");
  {
    /* 1 密码缺失 + 密钥存在：受保护接口拒绝、登录页拦截，不得免登录放行 */
    const eNoPw = env({ ENABLE_AUTH: "true", ADMIN_PASSWORD: "", SESSION_SECRET: "matrix-secret-0123456789abcdef" });
    r = await call("GET", "/api/messages", eNoPw);
    check(r.status === 401, "矩阵：开登录+密码缺失 → 受保护接口 401");
    const noPwPage = await (await fetchApp(R("GET", "/", {}), eNoPw)).text();
    check(/登 录/.test(noPwPage), "矩阵：开登录+密码缺失 → 访问 / 返回登录页（不放行管理页）");

    /* 2 密码为空串与缺失行为一致 */
    r = await call("GET", "/api/messages", env({ ENABLE_AUTH: "true", ADMIN_PASSWORD: "", SESSION_SECRET: "matrix-secret-0123456789abcdef" }));
    check(r.status === 401, "矩阵：密码空串与缺失行为一致 → 401");

    /* 3 登录接口返回明确的服务端配置错误（非密码错误 403），响应不泄露敏感值 */
    r = await call("POST", "/api/login", eNoPw, { body: { password: "anything" } });
    check(r.status === 500 && JSON.stringify(r.data).indexOf("not configured") !== -1,
      "矩阵：密码缺失登录 → 500 server auth not configured（配置错误非 403）");
    check(!JSON.stringify(r.data).match(/matrix-secret|anything/), "矩阵：配置错误响应不含密钥值或提交的密码");

    /* 4 密码存在 + SESSION_SECRET 缺失：登录安全失败、受保护接口拒绝 */
    const eNoSec = env({ ENABLE_AUTH: "true", ADMIN_PASSWORD: "matrixpw", SESSION_SECRET: "" });
    r = await call("POST", "/api/login", eNoSec, { body: { password: "matrixpw" } });
    check(r.status === 500, "矩阵：密钥缺失登录 → 500（安全失败，不签发 Session）");
    r = await call("GET", "/api/messages", eNoSec);
    check(r.status === 401, "矩阵：密钥缺失 → 受保护接口 401");

    /* 5 双缺失：受保护接口仍拒绝（配置缺失不得解释为关闭鉴权） */
    r = await call("GET", "/api/messages", env({ ENABLE_AUTH: "true", ADMIN_PASSWORD: "", SESSION_SECRET: "" }));
    check(r.status === 401, "矩阵：密码+密钥双缺失 → 受保护接口 401");

    /* 6 未启用开关：原有公开模式保持不变 */
    const eOff = env({ ENABLE_AUTH: "false", ADMIN_PASSWORD: "matrixpw", SESSION_SECRET: "matrix-secret-0123456789abcdef" });
    r = await call("GET", "/api/messages", eOff);
    check(r.status === 200, "矩阵：ENABLE_AUTH=false → 公开模式不受影响");
    r = await call("POST", "/api/login", eOff, { body: { password: "matrixpw" } });
    check(r.status === 400, "矩阵：ENABLE_AUTH=false 登录接口 → 400 auth disabled（原行为）");
  }

  /* ===== 阶段 1 组：数据库适配层——Turso fetch Mock 分支覆盖 ===== */
  group("阶段 1 组：Turso 适配层 fetch Mock（请求编码/响应解码/异常分支）");
  {
    const realFetch = globalThis.fetch;
    const captured = [];
    function okResult(cols, rows, changes, lastId) {
      return new Response(JSON.stringify({
        results: [{ type: "execute", response: { result: {
          cols: cols.map(function (n) { return { name: n }; }),
          rows: rows, affected_row_count: changes, last_insert_rowid: lastId } } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    function errResp(msg) {
      return new Response(JSON.stringify({ results: [{ type: "error", error: msg }] }), { status: 200 });
    }
    async function p(f) { try { await f(); return null; } catch (e) { return String((e && e.message) || e); } }

    let responder = function () { return okResult([], [], 0, 0); };
    globalThis.fetch = async function (url, opts) {
      captured.push({ url: String(url), opts: opts });
      return responder(String(url), opts);
    };
    try {
      /* 0 构造校验 */
      let msg = await p(async function () { new TursoDatabase("", "tok"); });
      check(/缺少 TURSO_DATABASE_URL/.test(msg || ""), "构造：缺 URL 抛「缺少 TURSO_DATABASE_URL」");
      msg = await p(async function () { new TursoDatabase("ftp://bad.example/db", "tok"); });
      check(/格式不正确/.test(msg || ""), "构造：非 https/libsql URL 抛「格式不正确」");
      const u = new TursoDatabase("libsql://probe-db-org.turso.io", "test-token");
      check(u.endpoint === "https://probe-db-org.turso.io/v2/pipeline", "构造：libsql:// 改写为 https:// 并拼 /v2/pipeline 端点");

      /* 1 请求编码：单次 POST、端点、鉴权头、参数类型映射 */
      captured.length = 0;
      responder = function () { return okResult([], [], 1, 7); };
      const rr = await u.prepare("INSERT INTO t VALUES (?,?,?,?)").bind(true, 1.5, "文本", null).run();
      check(captured.length === 1 && captured[0].opts.method === "POST", "编码：execute 为单次 POST");
      check(captured[0].url === "https://probe-db-org.turso.io/v2/pipeline", "编码：请求 URL 与 endpoint 一致");
      const h = captured[0].opts.headers;
      check(h["Authorization"] === "Bearer test-token" && h["Content-Type"] === "application/json", "编码：Bearer 鉴权 + JSON 头");
      const body = JSON.parse(captured[0].opts.body);
      check(body.requests.length === 2 && body.requests[0].type === "execute" && body.requests[1].type === "close", "编码：pipeline 请求体 = execute + close 两段");
      const enc = body.requests[0].stmt.args;
      check(enc[0].type === "integer" && enc[0].value === "1", "编码：boolean true → integer \"1\"");
      check(enc[1].type === "float" && enc[1].value === "1.5", "编码：小数 → float");
      check(enc[2].type === "text" && enc[2].value === "文本", "编码：中文字符串 → text 原样透传");
      check(enc[3].type === "null", "编码：null → null");
      check(JSON.stringify(rr.meta) === JSON.stringify({ changes: 1, last_row_id: 7 }), "解码：affected_row_count/last_insert_rowid → meta");
      captured.length = 0;
      await u.prepare("SELECT 1").bind(9007199254740993n).all();
      check(JSON.parse(captured[0].opts.body).requests[0].stmt.args[0].type === "integer", "编码：bigint → integer 文本（无精度丢失）");

      /* 2 响应解码：类型矩阵 + 空结果 */
      captured.length = 0;
      responder = function () {
        return new Response(JSON.stringify({
          results: [{ type: "execute", response: { result: {
            cols: [{ name: "i" }, { name: "f" }, { name: "s" }, { name: "n" }, { name: "u" }, { name: "b" }],
            rows: [[{ type: "integer", value: "42" }, { type: "float", value: "2.5" }, { type: "text", value: "中文🚀" },
                    { type: "null" }, { type: "weird" }, { type: "blob", base64: "YWJj" }]],
            affected_row_count: 0, last_insert_rowid: 0 } } }],
        }), { status: 200 });
      };
      const one = await u.prepare("SELECT * FROM probe").first();
      check(one.i === 42 && one.f === 2.5 && one.s === "中文🚀" && one.n === null, "解码：integer/float/text/null 正确");
      check(one.u === null, "解码：未知单元格类型静默 → null（现状行为留档）");
      check(one.b === "YWJj", "解码：blob → base64 字符串");
      responder = function () { return okResult([], [], 0, 0); };
      check((await u.prepare("SELECT 0 WHERE 0").all()).results.length === 0, "解码：空结果 all() → []");
      check((await u.prepare("SELECT 0 WHERE 0").first()) === null, "解码：空结果 first() → null");

      /* 3 HTTP / 网络 / 响应结构异常分支 */
      responder = function () { return new Response("denied", { status: 401 }); };
      msg = await p(function () { return u.prepare("X").all(); });
      check(/Turso HTTP 401/.test(msg || ""), "异常：HTTP 401 → 「Turso HTTP 401」");
      responder = function () { return new Response("bad", { status: 400 }); };
      msg = await p(function () { return u.prepare("X").all(); });
      check(/Turso HTTP 400/.test(msg || ""), "异常：HTTP 400 → 「Turso HTTP 400」");
      responder = function () { return new Response("boom", { status: 500 }); };
      msg = await p(function () { return u.prepare("X").all(); });
      check(/Turso HTTP 500/.test(msg || ""), "异常：HTTP 500 → 「Turso HTTP 500」");
      responder = function () { throw new Error("ECONNRESET"); };
      msg = await p(function () { return u.prepare("X").all(); });
      check(/Turso 网络请求失败/.test(msg || "") && /ECONNRESET/.test(msg || ""), "异常：fetch reject → 「Turso 网络请求失败」并带原因");
      responder = function () { return new Response("not-json", { status: 200 }); };
      msg = await p(function () { return u.prepare("X").all(); });
      check(!!msg && /Unexpected|JSON|token/i.test(msg), "异常：响应体非 JSON → 拒绝（现状为裸 SyntaxError 穿透）");
      responder = function () { return new Response("{}", { status: 200 }); };
      msg = await p(function () { return u.prepare("X").all(); });
      check(/缺少 results/.test(msg || ""), "异常：缺 results → 「缺少 results」");
      responder = function () { return errResp("no such table: ghost"); };
      msg = await p(function () { return u.prepare("SELECT * FROM ghost").all(); });
      check(/语句执行失败/.test(msg || "") && /ghost/.test(msg || ""), "异常：SQL 执行错误 → 「语句执行失败」并带引擎信息");
      responder = function () { return new Response(JSON.stringify({ results: [{ type: "execute", response: {} }] }), { status: 200 }); };
      msg = await p(function () { return u.prepare("X").all(); });
      check(/缺少 result/.test(msg || ""), "异常：缺 result → 「缺少 result」");

      /* 4 参数边界：非法类型 / NaN */
      responder = function () { return okResult([], [], 0, 0); };
      msg = await p(function () { return u.prepare("X").bind({ a: 1 }).all(); });
      check(/不支持的 SQL 绑定参数类型/.test(msg || ""), "边界：对象参数 → 「不支持的 SQL 绑定参数类型」");
      captured.length = 0;
      await u.prepare("X").bind(NaN).all();
      check(JSON.parse(captured[0].opts.body).requests[0].stmt.args[0].type === "float", "边界：NaN 编码为 float \"NaN\"（真库是否拒收列入必验项）");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  /* ===== 阶段 2 组：同一契约分别跑 LocalDatabase 与 TursoDatabase ===== */
  group("阶段 2 组：Local/Turso 双适配契约（插入/更新/删除/绑定/排序分页/事务失败回滚）");
  {
    async function contractSuite(tbl, dbx) {
      const out = [];
      await dbx.prepare("CREATE TABLE " + tbl + " (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, num INTEGER, note TEXT)").run();
      /* 参数绑定：中文/双引号/单引号/分号/emoji/null */
      await dbx.prepare("INSERT INTO " + tbl + " (name, num, note) VALUES (?,?,?)").bind('中文 "双引号" \'单引号\';--🚀', 42, null).run();
      await dbx.prepare("INSERT INTO " + tbl + " (name, num, note) VALUES (?,?,?)").bind("ascii", 7, "note-7").run();
      await dbx.prepare("INSERT INTO " + tbl + " (name, num, note) VALUES (?,?,?)").bind("第三", 7, "note-3").run();
      /* 插入后读取 */
      const r1 = await dbx.prepare("SELECT name, num, note FROM " + tbl + " ORDER BY num DESC, id").all();
      out.push(r1.results);
      /* 更新后读取 */
      const u1 = await dbx.prepare("UPDATE " + tbl + " SET num = ? WHERE num = ?").bind(100, 7).run();
      out.push({ changes: u1.meta.changes });
      out.push(await dbx.prepare("SELECT num FROM " + tbl + " WHERE name = ?").bind("ascii").first());
      /* 排序分页 */
      const pg = await dbx.prepare("SELECT id, name FROM " + tbl + " ORDER BY num ASC, id LIMIT 2 OFFSET 1").all();
      out.push(pg.results.map(function (r) { return { id: r.id, name: r.name }; }));
      /* 删除后读取 */
      const d1 = await dbx.prepare("DELETE FROM " + tbl + " WHERE name = ?").bind("第三").run();
      out.push({ changes: d1.meta.changes });
      out.push(await dbx.prepare("SELECT COUNT(*) AS c FROM " + tbl).first());
      out.push(await dbx.prepare("SELECT id FROM " + tbl + " WHERE name = ?").bind("不存在").first());
      /* 事务失败后的状态：BEGIN → INSERT → 违约失败 → ROLLBACK → 半状态不得残留 */
      await dbx.prepare("BEGIN").run();
      await dbx.prepare("INSERT INTO " + tbl + " (name, num, note) VALUES (?,?,?)").bind("tx", 1, null).run();
      let threw = false;
      try { await dbx.prepare("INSERT INTO " + tbl + " (name) VALUES (NULL)").run(); } catch (_) { threw = true; }
      out.push({ threw: threw });
      await dbx.prepare("ROLLBACK").run();
      out.push(await dbx.prepare("SELECT COUNT(*) AS c FROM " + tbl + " WHERE name = ?").bind("tx").first());
      /* 布尔绑定 */
      await dbx.prepare("INSERT INTO " + tbl + " (name, num, note) VALUES (?,?,?)").bind("bool", true, "x").run();
      out.push(await dbx.prepare("SELECT num FROM " + tbl + " WHERE name = ?").bind("bool").first());
      return out;
    }

    const localPath = join(tmpdir(), "smstoweb_contract_l_" + process.pid + ".db");
    const tursoPath = join(tmpdir(), "smstoweb_contract_t_" + process.pid + ".db");
    cleanupPath(localPath); cleanupPath(tursoPath);
    const ldb = new LocalDatabase(localPath);
    const fake = makeFakeTurso(tursoPath);
    const realFetch = globalThis.fetch;
    globalThis.fetch = fake.fetch;
    const tdb = new TursoDatabase("https://contract-db-org.turso.io/probe", "tok");
    let outL = null, outT = null, suiteErr = null;
    try {
      outL = await contractSuite("ct_local", ldb);
      outT = await contractSuite("ct_turso", tdb);
    } catch (e) { suiteErr = String((e && e.stack) || e); }
    finally {
      globalThis.fetch = realFetch;
    }
    check(!suiteErr, "契约：双适配套件无异常" + (suiteErr ? "（" + suiteErr + "）" : ""));
    if (!suiteErr) {
      check(outL.length === 10 && outT.length === 10, "契约：双适配步骤数一致（各 10 步）");
      const same = JSON.stringify(outL) === JSON.stringify(outT);
      check(same, "契约：同一 SQL 序列 10 步输出逐字段一致（Local vs Turso）" + (same ? "" : "\n    L=" + JSON.stringify(outL).slice(0, 400) + "\n    T=" + JSON.stringify(outT).slice(0, 400)));
      check(outL[0].length === 3 && outL[0][0].name.indexOf("🚀") !== -1 && outL[0][0].name.indexOf("--") !== -1, "契约：中文+引号+分号+emoji 参数原样写入读回");
      check(outL[0][0].note === null && outL[0][0].num === 42, "契约：null 参数 → null，整数 42 原值");
      check(outL[1].changes === 2, "契约：批量 UPDATE changes=2");
      check(outL[2] && outL[2].num === 100, "契约：更新后读取生效");
      check(outL[3].length === 2 && outL[3][0].name === "ascii", "契约：ORDER BY + LIMIT/OFFSET 分页结果一致");
      check(outL[4].changes === 1 && outL[5].c === 2, "契约：删除后读取 changes=1、COUNT=2");
      check(outL[6] === null, "契约：无匹配行 first() → null");
      check(outL[7].threw === true, "契约：事务内违约语句双适配均抛错");
      check(outL[8].c === 0, "契约：ROLLBACK 后失败事务写入不残留");
      check(outL[9].num === 1, "契约：boolean 绑定 true → 整数 1");
    }
    cleanupPath(localPath); cleanupPath(tursoPath);
  }

  /* ===== 阶段 3 组：ensureSchema 经 Turso 适配层迁移裸库 ===== */
  group("阶段 3 组：ensureSchema × Turso（bare 库经 fetch Mock 真 SQL 迁移）");
  {
    const p8 = join(tmpdir(), "smstoweb_scheema_turso_" + process.pid + ".db");
    cleanupPath(p8);
    const fake = makeFakeTurso(p8);
    const realFetch = globalThis.fetch;
    globalThis.fetch = fake.fetch;
    let err = null;
    try {
      const tdb = new TursoDatabase("https://bare-db-org.turso.io/probe", "tok");
      const e8 = env({ DB: tdb });
      const r1 = await call("GET", "/api/messages", e8);
      check(r1.status === 200, "迁移：裸库首请求 → 200（自愈经 Turso 适配层完成）");
      const tables = fake.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(function (r) { return r.name; });
      check(tables.indexOf("devices") !== -1 && tables.indexOf("messages") !== -1 && tables.indexOf("tokens") !== -1 && tables.indexOf("settings") !== -1, "迁移：四表建齐（devices/messages/tokens/settings）");
      const cols = fake.raw.prepare("PRAGMA table_info(tokens)").all().map(function (r) { return r.name; }).join(",");
      check(cols === "id,name,token_hash,token_prefix,created_at,last_used_at,revoked_at,expires_at,note", "迁移：tokens 表 9 列（幂等补列路径）");
      const idxCount = fake.raw.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all()[0].c;
      check(idxCount >= 8, "迁移：8 个业务索引建齐（实际 " + idxCount + "）");
      const st = await call("GET", "/api/stats", e8);
      check(st.status === 200 && st.data && st.data.schema && st.data.schema.state === "ok", "迁移：stats schema.state=ok");
      const r2 = await call("GET", "/api/messages", e8);
      check(r2.status === 200, "迁移：第二次请求幂等 200（WeakSet 生效，不再重跑）");
    } catch (e) { err = String((e && e.stack) || e); }
    finally { globalThis.fetch = realFetch; }
    if (err) check(false, "迁移：套件异常（" + err + "）");
    cleanupPath(p8);
  }

  /* ===== 阶段 1-3 · 第一提交点：原子事务基础设施（L1/L2） ===== */
  group("第一提交点 A：D1 batchAtomic（原子语义 / 异常分类）");
  {
    const pA = join(tmpdir(), "smstoweb_atomic_d1_" + process.pid + ".db");
    cleanupPath(pA);
    const raw = new DatabaseSync(pA);
    raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL UNIQUE)");
    const d1 = makeD1(raw);
    const p = async function (f) { try { await f(); return null; } catch (e) { return e; } };

    const r0 = await atomicBatch(d1, []);
    check(r0.results.length === 0, "A1 空批：不发请求，直接返回 results=[]");

    const r1 = await atomicBatch(d1, [
      { sql: "INSERT INTO t (v) VALUES (?)", args: ["a"] },
      { sql: "INSERT INTO t (v) VALUES (?)", args: ["b"] },
    ]);
    check(r1.results.length === 2 && r1.results[0].changes === 1 && r1.results[1].changes === 1, "A2 成功：逐语句 changes 与入参一一对应");
    check(raw.prepare("SELECT COUNT(*) AS c FROM t").all()[0].c === 2, "A2 成功：两条均已提交");

    const e3 = await p(function () {
      return atomicBatch(d1, [
        { sql: "INSERT INTO t (v) VALUES (?)", args: ["c"] },
        { sql: "INSERT INTO t (v) VALUES (?)", args: ["a"] },
      ]);
    });
    check(!!e3 && e3.code === "FAILED" && e3.phase === "execute" && e3.retryable === true, "A3 语句级失败：code=FAILED / retryable=true");
    check(raw.prepare("SELECT COUNT(*) AS c FROM t").all()[0].c === 2, "A3 语句级失败：整批回滚（无部分落地，c 仍为 2）");

    const d1boom = { prepare: d1.prepare.bind(d1), batch: async function () { throw new Error("network connection lost"); } };
    const e4 = await p(function () { return atomicBatch(d1boom, [{ sql: "INSERT INTO t (v) VALUES (?)", args: ["z"] }]); });
    check(!!e4 && e4.code === "UNKNOWN" && e4.phase === "execute" && e4.retryable === false && e4.effectUnproven === true, "A4 无响应：code=UNKNOWN / retryable=false / effectUnproven=true");

    let batchCalls = 0;
    const d1prep = { prepare: function () { return { bind: function () { throw new Error("bad bind"); } }; }, batch: async function () { batchCalls++; return []; } };
    const e5 = await p(function () { return atomicBatch(d1prep, [{ sql: "X", args: [] }]); });
    check(!!e5 && e5.code === "FAILED" && e5.phase === "prepare" && batchCalls === 0, "A5 准备阶段失败：FAILED/prepare 且未调用 batch（零执行）");

    const e6 = await p(function () { return atomicBatch({ prepare: function () { return {}; } }, [{ sql: "X", args: [] }]); });
    check(!!e6 && e6.code === "FAILED" && /既不支持/.test(e6.detail), "A6 无 batch/batchAtomic 能力：FAILED/prepare（明确拒绝而非静默降级）");

    const e7 = await p(function () { return atomicBatch(d1, [{ sql: "", args: [] }]); });
    check(!!e7 && e7.code === "FAILED" && e7.phase === "prepare", "A7 空 sql：FAILED/prepare（脏语句绝不进入批次）");

    check(AtomicBatchError.prototype instanceof Error, "A8 worker 侧 AtomicBatchError 继承 Error（可被全局错误路径统一捕获）");
    raw.close();
    cleanupPath(pA);
  }

  group("第一提交点 B：Turso batchAtomic 协议形状（3-RTT / baton / 真 SQL 原子性）");
  {
    const pB = join(tmpdir(), "smstoweb_atomic_turso_" + process.pid + ".db");
    cleanupPath(pB);
    const fake = makeFakeTurso(pB);
    fake.raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL UNIQUE)");
    const realFetch = globalThis.fetch;
    globalThis.fetch = fake.fetch;
    const tdb = new TursoDatabase("libsql://probe-db-org.turso.io", "tok");
    const p = async function (f) { try { await f(); return null; } catch (e) { return e; } };
    let err = null;
    try {
      const rb = await tdb.batchAtomic([
        { sql: "INSERT INTO t (v) VALUES (?)", args: ["a"] },
        { sql: "INSERT INTO t (v) VALUES (?)", args: ["b"] },
      ]);
      check(fake.requests.length === 3, "B1 成功：恰好 3 个 RTT（BEGIN / 写 / COMMIT），实际 " + fake.requests.length);
      check(fake.requests[0].sqls.length === 1 && fake.requests[0].sqls[0] === "BEGIN", "B1 R1：BEGIN 独占管道（不与写语句同请求）");
      check(fake.requests[1].sqls.length === 2 && /^INSERT/i.test(fake.requests[1].sqls[0]) && /^INSERT/i.test(fake.requests[1].sqls[1]), "B1 R2：写语句一次请求承载 2 条");
      check(fake.requests[2].sqls.length === 1 && fake.requests[2].sqls[0] === "COMMIT", "B1 R3：COMMIT 独占管道");
      check(fake.requests[0].baton === null, "B1 baton：R1 用 null 开新流");
      check(fake.requests[1].baton !== null && fake.requests[2].baton !== null, "B1 baton：R2/R3 均携带服务端返回的 baton");
      check(fake.requests[2].baton !== fake.requests[1].baton, "B1 baton：响应 baton 与请求 baton 不同（协议要求串行换手）");
      check(fake.requests.every(function (r) { return r.url === "https://probe-db-org.turso.io/v2/pipeline"; }), "B1 URL：无 base_url 时三次请求均打原端点");
      check(rb.results.length === 2 && rb.results[0].changes === 1 && rb.results[1].last_row_id === 2, "B1 结果：changes/last_row_id 逐条映射正确");
      check(fake.raw.prepare("SELECT COUNT(*) AS c FROM t").all()[0].c === 2, "B1 数据：事务已提交（真 SQL 语义，非 Mock 计数）");

      /* B2 base_url：R1 返回粘性地址 ⇒ R2/R3 必须改投 */
      fake.requests.length = 0;
      fake.emitBaseUrl = "https://sticky-node-7.turso.io";
      await tdb.batchAtomic([{ sql: "INSERT INTO t (v) VALUES (?)", args: ["c"] }]);
      check(fake.requests[0].url === "https://probe-db-org.turso.io/v2/pipeline", "B2 base_url：R1 仍打原端点");
      check(fake.requests[1].url === "https://sticky-node-7.turso.io/v2/pipeline" && fake.requests[2].url === "https://sticky-node-7.turso.io/v2/pipeline", "B2 base_url：R2/R3 改投粘性地址（基地址 + /v2/pipeline）");
      fake.emitBaseUrl = null;

      /* B3 写语句失败 ⇒ 同 baton ROLLBACK ⇒ FAILED + 真 SQL 回滚 */
      fake.raw.exec("CREATE TABLE u (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT UNIQUE)");
      fake.raw.exec("INSERT INTO u (v) VALUES ('dup')");
      fake.requests.length = 0;
      err = await p(function () {
        return tdb.batchAtomic([
          { sql: "INSERT INTO u (v) VALUES (?)", args: ["ok1"] },
          { sql: "INSERT INTO u (v) VALUES (?)", args: ["dup"] },
        ]);
      });
      check(!!err && err.code === "FAILED" && err.phase === "execute" && err.retryable === true, "B3 写语句 SQL error：FAILED/execute（ROLLBACK 已确认）");
      check(fake.requests.length === 3 && fake.requests[2].sqls[0] === "ROLLBACK", "B3 写语句 SQL error：第 3 个请求为 ROLLBACK（同 baton 链路；BEGIN→写→ROLLBACK）");
      check(fake.raw.prepare("SELECT COUNT(*) AS c FROM u").all()[0].c === 1, "B3 写语句 SQL error：整事务回滚（仅预置 dup 一行）");

      /* B4 写语句全部成功但服务端关流（baton=null）⇒ UNKNOWN，不报成功 */
      fake.requests.length = 0;
      fake.closeAfter = 2;
      err = await p(function () { return tdb.batchAtomic([{ sql: "INSERT INTO t (v) VALUES (?)", args: ["d"] }]); });
      check(!!err && err.code === "UNKNOWN" && err.phase === "execute" && err.effectUnproven === true, "B4 写成功后流被关闭：UNKNOWN/execute（不声称成功）");
      check(fake.requests.length === 2, "B4 写成功后流被关闭：无第 3 个请求（未发 COMMIT）");
      /* 测试桩清理：fake 单连接仍持有未提交事务，显式回滚以免污染后续用例 */
      try { fake.raw.exec("ROLLBACK"); } catch (_) {}
      fake.closeAfter = null;
    } catch (e) {
      check(false, "B 组异常：" + String((e && e.stack) || e));
    } finally {
      globalThis.fetch = realFetch;
    }
    fake.raw.close();
    cleanupPath(pB);
  }

  group("第一提交点 C：Turso 故障注入矩阵（分类逐类对齐第四轮状态机）");
  {
    const realFetch = globalThis.fetch;
    const tdb = new TursoDatabase("libsql://probe-db-org.turso.io", "tok");
    const okItem = { type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: 1, last_insert_rowid: 0 } } };
    function pipe(baton, items) {
      return new Response(JSON.stringify({ baton: baton, base_url: null, results: items }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    function errItem(msg) { return { type: "error", error: msg }; }
    let calls = [];
    function plan(steps) {
      calls = [];
      let i = 0;
      globalThis.fetch = async function (url, opts) {
        calls.push({ url: String(url), body: JSON.parse(String(opts.body)) });
        const step = steps[i++];
        if (!step) throw new Error("意外多出的请求 #" + i);
        return step({ url: String(url), body: calls[calls.length - 1].body });
      };
    }
    const p = async function (f) { try { await f(); return null; } catch (e) { return e; } };
    const two = [{ sql: "INSERT INTO t (v) VALUES (?)", args: ["x"] }, { sql: "INSERT INTO t (v) VALUES (?)", args: ["y"] }];
    try {
      /* C1 BEGIN 网络失败 */
      plan([function () { throw new Error("ECONNRESET at begin"); }]);
      let e = await p(function () { return tdb.batchAtomic(two); });
      check(!!e && e.code === "FAILED" && e.phase === "begin" && e.retryable === true, "C1 BEGIN 网络失败：FAILED/begin（写语句从未发出 ⇒ 未提交）");
      check(calls.length === 1, "C1 BEGIN 网络失败：只发了 1 个请求（不重试、不发写语句）");

      /* C2 BEGIN HTTP 503 */
      plan([function () { return new Response("upstream down", { status: 503 }); }]);
      e = await p(function () { return tdb.batchAtomic(two); });
      check(!!e && e.code === "FAILED" && e.phase === "begin" && /503/.test(e.detail), "C2 BEGIN HTTP 503：FAILED/begin（流失效且数据未动）");

      /* C3 BEGIN 语句错误 */
      plan([function () { return pipe("A", [errItem("cannot start a transaction within a transaction")]); }]);
      e = await p(function () { return tdb.batchAtomic(two); });
      check(!!e && e.code === "FAILED" && e.phase === "begin", "C3 BEGIN SQL error：FAILED/begin");

      /* C4 BEGIN 成功但 baton=null */
      plan([function () { return pipe(null, [okItem]); }]);
      e = await p(function () { return tdb.batchAtomic(two); });
      check(!!e && e.code === "FAILED" && e.phase === "begin" && /流已关闭/.test(e.detail), "C4 BEGIN 成功但流关闭：FAILED/begin（事务不存在）");

      /* C5 写阶段网络失败 ⇒ UNKNOWN，且绝不发 ROLLBACK/COMMIT */
      plan([function () { return pipe("A", [okItem]); }, function () { throw new Error("timeout after write"); }]);
      e = await p(function () { return tdb.batchAtomic(two); });
      check(!!e && e.code === "UNKNOWN" && e.phase === "execute" && e.retryable === false, "C5 写阶段无响应：UNKNOWN/execute（不得重试、不得报成功）");
      check(calls.length === 2, "C5 写阶段无响应：仅 2 个请求（无 ROLLBACK、无 COMMIT）");

      /* C6 写阶段 HTTP 500 ⇒ 流失效 ⇒ FAILED（无残留未提交事务） */
      plan([function () { return pipe("A", [okItem]); }, function () { return new Response("boom", { status: 500 }); }]);
      e = await p(function () { return tdb.batchAtomic(two); });
      check(!!e && e.code === "FAILED" && e.phase === "execute" && /500/.test(e.detail), "C6 写阶段 HTTP 500：FAILED/execute（T3：流失效 ⇒ 无挂起事务，且未发 COMMIT）");

      /* C7 写阶段 200 但不可解析 */
      plan([function () { return pipe("A", [okItem]); }, function () { return new Response("not-json", { status: 200 }); }]);
      e = await p(function () { return tdb.batchAtomic(two); });
      check(!!e && e.code === "FAILED" && e.phase === "execute", "C7 写阶段响应不可解析：FAILED/execute（未发 COMMIT ⇒ 数据轴未提交）");

      /* C8 COMMIT 网络失败 ⇒ UNKNOWN，且绝不自动重试 */
      plan([function () { return pipe("A", [okItem]); }, function () { return pipe("B", [okItem, okItem]); }, function () { throw new Error("timeout at commit"); }]);
      e = await p(function () { return tdb.batchAtomic(two); });
      check(!!e && e.code === "UNKNOWN" && e.phase === "commit" && e.effectUnproven === true, "C8 COMMIT 无响应：UNKNOWN/commit（T2）");
      check(calls.length === 3, "C8 COMMIT 无响应：无第 4 个请求（S1 保守变体：零内部重试）");

      /* C9 COMMIT HTTP 500 ⇒ UNKNOWN */
      plan([function () { return pipe("A", [okItem]); }, function () { return pipe("B", [okItem, okItem]); }, function () { return new Response("bad gateway", { status: 502 }); }]);
      e = await p(function () { return tdb.batchAtomic(two); });
      check(!!e && e.code === "UNKNOWN" && e.phase === "commit" && /502/.test(e.detail), "C9 COMMIT HTTP 502：UNKNOWN/commit（协议未规定是否已执行）");

      /* C10 COMMIT 200 但不可解析 ⇒ UNKNOWN */
      plan([function () { return pipe("A", [okItem]); }, function () { return pipe("B", [okItem, okItem]); }, function () { return new Response("garbage", { status: 200 }); }]);
      e = await p(function () { return tdb.batchAtomic(two); });
      check(!!e && e.code === "UNKNOWN" && e.phase === "commit", "C10 COMMIT 响应不可解析：UNKNOWN/commit");

      /* C11 COMMIT 锁竞争（C-2α）⇒ 同 baton ROLLBACK 成功（C-2β）⇒ FAILED */
      plan([
        function () { return pipe("A", [okItem]); },
        function () { return pipe("B", [okItem, okItem]); },
        function () { return pipe("C", [errItem("database is locked")]); },
        function () { return pipe("D", [okItem]); },
      ]);
      e = await p(function () { return tdb.batchAtomic(two); });
      check(!!e && e.code === "FAILED" && e.phase === "commit" && e.retryable === true, "C11 COMMIT 锁竞争 + ROLLBACK 成功：FAILED/commit（C-2α→C-2β，确认未提交）");
      check(calls.length === 4 && calls[3].body.requests[0].stmt.sql === "ROLLBACK", "C11 COMMIT 锁竞争：第 4 个请求为 ROLLBACK（复用成功响应中的 baton）");
      check(calls[3].body.baton === "C", "C11 COMMIT 锁竞争：ROLLBACK 使用 COMMIT 响应返回的 baton（不是旧 baton）");

      /* C12 COMMIT 明确「已无事务」（C-2 终止态）⇒ FAILED，不发 ROLLBACK */
      plan([function () { return pipe("A", [okItem]); }, function () { return pipe("B", [okItem, okItem]); }, function () { return pipe("C", [errItem("cannot commit - no transaction is active")]); }]);
      e = await p(function () { return tdb.batchAtomic(two); });
      check(!!e && e.code === "FAILED" && e.phase === "commit" && e.retryable === true, "C12 COMMIT「无事务」：FAILED/commit（引擎明确已回滚）");
      check(calls.length === 3, "C12 COMMIT「无事务」：不发 ROLLBACK（没有可回滚的事务）");

      /* C13 COMMIT 其他 SQL error（C-2γ）⇒ UNKNOWN，不发 ROLLBACK、不复用 baton */
      plan([function () { return pipe("A", [okItem]); }, function () { return pipe("B", [okItem, okItem]); }, function () { return pipe("C", [errItem("disk I/O error")]); }]);
      e = await p(function () { return tdb.batchAtomic(two); });
      check(!!e && e.code === "UNKNOWN" && e.phase === "commit", "C13 COMMIT 其他 SQL error：UNKNOWN/commit（C-2γ，保守不判定）");
      check(calls.length === 3, "C13 COMMIT 其他 SQL error：不发 ROLLBACK（状态不明不复用 baton）");

      /* C14 COMMIT 锁竞争 + ROLLBACK 无响应（C-2δ）⇒ UNKNOWN */
      plan([
        function () { return pipe("A", [okItem]); },
        function () { return pipe("B", [okItem, okItem]); },
        function () { return pipe("C", [errItem("database is locked")]); },
        function () { throw new Error("timeout at rollback"); },
      ]);
      e = await p(function () { return tdb.batchAtomic(two); });
      check(!!e && e.code === "UNKNOWN" && e.phase === "rollback", "C14 COMMIT 锁竞争 + ROLLBACK 无响应：UNKNOWN/rollback（C-2δ）");

      /* C15 baton 过期（R2 返回 error + baton=null）⇒ FAILED，且不发 ROLLBACK */
      plan([function () { return pipe("A", [okItem]); }, function () { return pipe(null, [errItem("baton expired")]); }]);
      e = await p(function () { return tdb.batchAtomic(two); });
      check(!!e && e.code === "FAILED" && e.phase === "execute" && /流已关闭/.test(e.detail), "C15 baton 过期：FAILED/execute（流已关闭 ⇒ 服务端已回滚）");
      check(calls.length === 2, "C15 baton 过期：不发 ROLLBACK（无可用 baton）");

      /* C16 预处理边界：零请求 */
      plan([]);
      e = await p(function () { return tdb.batchAtomic("not-an-array"); });
      check(!!e && e.code === "FAILED" && e.phase === "prepare" && calls.length === 0, "C16 入参非数组：FAILED/prepare（零请求）");
      e = await p(function () { return tdb.batchAtomic([{ args: [] }]); });
      check(!!e && e.code === "FAILED" && e.phase === "prepare" && calls.length === 0, "C16 缺 sql：FAILED/prepare（零请求）");
      e = await p(function () { return tdb.batchAtomic([{ sql: "INSERT INTO t VALUES (?)", args: [{ bad: 1 }] }]); });
      check(!!e && e.code === "FAILED" && e.phase === "prepare" && calls.length === 0, "C16 非法绑定类型：FAILED/prepare（提前编码，脏参数绝不进事务）");

      /* C17 适配层错误类一致性 */
      check(DbAtomicBatchError.prototype instanceof Error && AtomicBatchError !== DbAtomicBatchError, "C17 适配层与 worker 侧错误类各自独立但同为 Error 子类（调用方只认 code/phase）");
    } catch (e) {
      check(false, "C 组异常：" + String((e && e.stack) || e));
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  /* ===== 阶段 3D-2：shared/db.js（EdgeOne/vercel/netlify/deno db.js 的唯一源）失败分类语义修正 =====
   * 3D-1 补审裁定的最小修正验证：
   *   E1 R2 protocol（200 不可解析）由 FAILED 改为 UNKNOWN（零观测不冒充确定性）；
   *   E2/E3 R2 HTTP 4xx/5xx 与 R2 SQL error+baton=null 保留 FAILED，但 detail/注释三态分离
   *       （不再出现「服务端已回滚」这类未经直接观测的事实性表述）；
   *   E4/E5/E6 ROLLBACK ok→FAILED、ROLLBACK 失败→UNKNOWN、COMMIT 网络异常→UNKNOWN 不变；
   *   E7 retryable/effectUnproven 由 code 派生、互斥；E8 两种分类对外同为同一 500 结构。
   * 注：本组直接测源文件 shared/db.js；node/db.js 为独立维护副本（不参与生成同步），其 C 组测试保持原样。 */
  group("阶段 3D-2：shared/db.js Turso 失败分类（R2 protocol→UNKNOWN + FAILED 出口三态分离）");
  {
    const realFetch = globalThis.fetch;
    const sdb = new SharedTursoDatabase("libsql://probe-db-org.turso.io", "tok");
    const okItem = { type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: 1, last_insert_rowid: 0 } } };
    function pipe(baton, items) {
      return new Response(JSON.stringify({ baton: baton, base_url: null, results: items }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    function errItem(msg) { return { type: "error", error: msg }; }
    let calls = [];
    function plan(steps) {
      calls = [];
      let i = 0;
      globalThis.fetch = async function (url, opts) {
        calls.push({ url: String(url), body: JSON.parse(String(opts.body)) });
        const step = steps[i++];
        if (!step) throw new Error("意外多出的请求 #" + i);
        return step({ url: String(url), body: calls[calls.length - 1].body });
      };
    }
    const p = async function (f) { try { await f(); return null; } catch (e) { return e; } }
    const two = [{ sql: "INSERT INTO t (v) VALUES (?)", args: ["x"] }, { sql: "INSERT INTO t (v) VALUES (?)", args: ["y"] }];
    try {
      /* E1 R2 protocol（200 但响应不可解析）→ UNKNOWN（3D-1 #6：FAILED → UNKNOWN） */
      plan([function () { return pipe("A", [okItem]); }, function () { return new Response("not-json", { status: 200 }); }]);
      let e = await p(function () { return sdb.batchAtomic(two); });
      check(!!e && e.code === "UNKNOWN" && e.phase === "execute" && e.retryable === false && e.effectUnproven === true,
        "E1 R2 响应不可解析：UNKNOWN/execute（零观测不冒充确定性；retryable=false / effectUnproven=true）");
      check(calls.length === 2, "E1 仅 2 个请求（不发 ROLLBACK、不发 COMMIT、零重试）");

      /* E2 R2 HTTP 4xx/5xx → FAILED 保留（结构性判断，不冒充回滚确认） */
      plan([function () { return pipe("A", [okItem]); }, function () { return new Response("boom", { status: 500 }); }]);
      e = await p(function () { return sdb.batchAtomic(two); });
      check(!!e && e.code === "FAILED" && e.phase === "execute" && e.retryable === true && e.effectUnproven === false && /500/.test(e.detail),
        "E2 R2 HTTP 500：FAILED/execute 保留（retryable=true / effectUnproven=false，detail 含 500）");
      check(!/已回滚/.test(e.detail), "E2 detail 无「已回滚」类未经直接观测的事实性表述");

      /* E3 R2 SQL error + baton=null → FAILED 保留（删除「服务端已回滚」表述） */
      plan([function () { return pipe("A", [okItem]); }, function () { return pipe(null, [errItem("UNIQUE constraint failed: t.v")]); }]);
      e = await p(function () { return sdb.batchAtomic(two); });
      check(!!e && e.code === "FAILED" && e.phase === "execute" && e.retryable === true && /流已关闭/.test(e.detail),
        "E3 R2 语句失败且 baton=null：FAILED/execute（流已关闭；COMMIT 未发出 ⇒ 未提交为结构性判断）");
      check(!/服务端已回滚/.test(e.detail), "E3 detail 不含「服务端已回滚」（回滚未直接确认）");
      check(calls.length === 2, "E3 不发 ROLLBACK（无可用 baton）");

      /* E4 R2 SQL error + 同 baton → ROLLBACK 成功 → FAILED（唯一「确认回滚」出口） */
      plan([
        function () { return pipe("A", [okItem]); },
        function () { return pipe("B", [okItem, errItem("UNIQUE constraint failed: t.v")]); },
        function () { return pipe("C", [okItem]); },
      ]);
      e = await p(function () { return sdb.batchAtomic(two); });
      check(!!e && e.code === "FAILED" && e.phase === "execute" && e.retryable === true && e.effectUnproven === false,
        "E4 ROLLBACK 成功：FAILED/execute（已 ROLLBACK，确认未提交）");
      check(calls.length === 3 && calls[2].body.requests[0].stmt.sql === "ROLLBACK" && calls[2].body.baton === "B",
        "E4 第 3 个请求为 ROLLBACK，使用 R2 响应返回的 baton");

      /* E5 R2 SQL error → ROLLBACK 失败（200 + SQL error）→ UNKNOWN */
      plan([
        function () { return pipe("A", [okItem]); },
        function () { return pipe("B", [okItem, errItem("UNIQUE constraint failed: t.v")]); },
        function () { return pipe("C", [errItem("cannot rollback - no transaction is active")]); },
      ]);
      e = await p(function () { return sdb.batchAtomic(two); });
      check(!!e && e.code === "UNKNOWN" && e.phase === "rollback" && e.retryable === false && e.effectUnproven === true,
        "E5 ROLLBACK 失败：UNKNOWN/rollback（状态不可证明，不复用 baton）");
      check(calls.length === 3, "E5 仅 3 个请求（ROLLBACK 失败后不重试、不发 COMMIT）");

      /* E6 COMMIT 网络异常 → UNKNOWN，零自动重试 */
      plan([
        function () { return pipe("A", [okItem]); },
        function () { return pipe("B", [okItem, okItem]); },
        function () { throw new Error("timeout at commit"); },
      ]);
      e = await p(function () { return sdb.batchAtomic(two); });
      check(!!e && e.code === "UNKNOWN" && e.phase === "commit" && e.retryable === false && e.effectUnproven === true,
        "E6 COMMIT 网络异常：UNKNOWN/commit（T2，无观测）");
      check(calls.length === 3, "E6 仅 3 个请求（无第 4 个请求：零内部重试）");

      /* E7 retryable/effectUnproven 与错误分类一致（由 code 派生、互斥） */
      const eF = new SharedAtomicBatchError("FAILED", "execute", "t");
      const eU = new SharedAtomicBatchError("UNKNOWN", "execute", "t");
      check(eF.retryable === true && eF.effectUnproven === false && eU.retryable === false && eU.effectUnproven === true,
        "E7 分类一致性：retryable ⇔ FAILED、effectUnproven ⇔ UNKNOWN（互斥，由 code 派生）");
      check(AtomicBatchError.prototype.isPrototypeOf(SharedAtomicBatchError) === false && SharedAtomicBatchError.prototype instanceof Error,
        "E7 shared 适配层错误类独立于 worker 侧类但同为 Error 子类（调用方只认 code/phase）");

      /* E8 FAILED 与 UNKNOWN 两种分类经 handler 全局 catch 对外均为同一 500 结构 */
      const mkFake = function (err) {
        return {
          prepare: db.prepare.bind(db),
          batchAtomic: async function () { throw err; },
        };
      };
      const eFail = env({ DB: mkFake(new SharedAtomicBatchError("FAILED", "execute", "injected failed")) });
      const eUnk = env({ DB: mkFake(new SharedAtomicBatchError("UNKNOWN", "execute", "injected unknown")) });
      const rF = await call("DELETE", "/api/devices/1", eFail);
      const rU = await call("DELETE", "/api/devices/1", eUnk);
      check(rF.status === 500 && rU.status === 500 && rF.data && rU.data, "E8 FAILED/UNKNOWN 两种分类对外均为 500（均走全局错误路径）");
      check(JSON.stringify(rF.data) === JSON.stringify(rU.data) && rF.data.error === "internal error" && rF.data.success === false,
        "E8 两种分类响应结构完全一致：{\"success\":false,\"error\":\"internal error\"}（不泄露 code/phase/detail）");
    } catch (e) {
      check(false, "3D-2 组异常：" + String((e && e.stack) || e));
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  group("第一提交点 D：Node 连接级 FIFO 队列 / 事务不变量 / 连接重建八步");
  {
    const pD = join(tmpdir(), "smstoweb_atomic_local_" + process.pid + ".db");
    cleanupPath(pD);
    const ldb = new LocalDatabase(pD);
    const p = async function (f) { try { await f(); return null; } catch (e) { return e; } };
    let err = null;
    try {
      await ldb.prepare("CREATE TABLE q (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL)").run();
      /* D0 调用缝：handler 将来调用的是 worker 侧 atomicBatch(env.DB, …)，必须能正确委派到适配层 */
      const rSeam = await atomicBatch(ldb, [{ sql: "INSERT INTO q (v) VALUES (?)", args: ["seam"] }]);
      check(rSeam.results.length === 1 && rSeam.results[0].changes === 1, "D0 委派：atomicBatch(env.DB, …) 正确路由到适配层 batchAtomic（真实调用缝已验证）");
      const r1 = await ldb.batchAtomic([
        { sql: "INSERT INTO q (v) VALUES (?)", args: ["a"] },
        { sql: "INSERT INTO q (v) VALUES (?)", args: ["b"] },
      ]);
      check(r1.results.length === 2 && r1.results[0].changes === 1 && r1.results[1].last_row_id === 3, "D1 成功：逐语句 changes/last_row_id 正确");
      check(ldb._inTx === false, "D1 成功：事务结束后 _inTx 复位为 false");

      err = await p(function () {
        return ldb.batchAtomic([
          { sql: "INSERT INTO q (v) VALUES (?)", args: ["c"] },
          { sql: "INSERT INTO q (v) VALUES (NULL)", args: [] },
        ]);
      });
      check(!!err && err.code === "FAILED" && err.phase === "execute" && err.retryable === true, "D2 语句失败：FAILED/execute（ROLLBACK 成功确认）");
      check(ldb._inTx === false, "D2 语句失败：异常后 _inTx 复位（不污染后续任务）");
      const c2 = (await ldb.prepare("SELECT COUNT(*) AS c FROM q").first()).c;
      check(c2 === 3, "D2 语句失败：整体回滚（c 仍为 3：seam+a+b）");

      /* D3 并发 30 个任务（10 个事务批 + 20 个单条写）经同一队列串行执行，无丢失/无交错 */
      const jobs = [];
      for (let i = 0; i < 10; i++) {
        jobs.push(ldb.batchAtomic([
          { sql: "INSERT INTO q (v) VALUES (?)", args: ["p" + i + "-1"] },
          { sql: "INSERT INTO q (v) VALUES (?)", args: ["p" + i + "-2"] },
        ]));
      }
      for (let i = 0; i < 20; i++) jobs.push(ldb.prepare("INSERT INTO q (v) VALUES (?)").bind("s" + i).run());
      await Promise.all(jobs);
      const c3 = (await ldb.prepare("SELECT COUNT(*) AS c FROM q").first()).c;
      check(c3 === 43, "D3 队列：30 个并发任务全部落地（3+10×2+20=43，实际 " + c3 + "）");
      check(ldb._queue instanceof Promise && ldb._connState === "ready", "D3 队列：链尾保持 Promise 且连接态 ready（调度链未被 rejection 污染）");

      /* D4 事务内专用通道的不变量：事务外调用必须直接抛错 */
      err = await p(async function () { ldb._execDirect("SELECT 1", []); });
      check(!!err && err.code === "FAILED" && err.phase === "guard", "D4 _execDirect 事务外调用：guard 拒绝（_inTx 不变量生效）");

      /* D5 重入保护：伪造 _inTx=true 后调用 batchAtomic 必须拒绝（不嵌套事务） */
      ldb._inTx = true;
      err = await p(function () { return ldb.batchAtomic([{ sql: "INSERT INTO q (v) VALUES ('r')", args: [] }]); });
      ldb._inTx = false;
      check(!!err && err.code === "FAILED" && err.phase === "guard", "D5 事务重入：batchAtomic 被 guard 拒绝");

      /* ===== D6 关闭证明：fail-closed =====
       * 判据：Node 的 database.close() 是 sqlite3_close_v2 包装，未 finalize 语句时只置 zombie；
       * 因此"close() 未抛错"不是释放证明。以下 Mock 只验证控制流，不宣称已证明连接释放/事务回滚。 */
      const hasStmtClose = typeof StatementSync.prototype.close === "function";

      /* D6a：模拟「缓存语句无 close()」⇒ 不得重开、不得创建同文件新连接、必须 failed */
      const pA = join(tmpdir(), "smstoweb_atomic_local_noclose_" + process.pid + ".db");
      cleanupPath(pA);
      const dbA = new LocalDatabase(pA);
      await dbA.prepare("CREATE TABLE z (id INTEGER PRIMARY KEY, v TEXT)").run();
      const origStmtA = dbA.statement.bind(dbA);
      dbA.statement = function (sql) {
        if (sql === "ROLLBACK") throw new Error("simulated: rollback failed");
        const s = origStmtA(sql);
        /* 显式去掉 close()，模拟无法 finalize（与 v24.19.0 真实能力一致） */
        return { run: s.run.bind(s), all: s.all.bind(s), get: s.get.bind(s), iterate: s.iterate.bind(s) };
      };
      let openCallsA = 0;
      const origOpenA = dbA._open.bind(dbA);
      dbA._open = function () { openCallsA++; return origOpenA(); };
      err = await p(function () {
        return dbA.batchAtomic([
          { sql: "INSERT INTO z (id, v) VALUES (?, ?)", args: [1, "a"] },
          { sql: "INSERT INTO z (id, v) VALUES (?, ?)", args: [1, "b"] },
        ]);
      });
      check(!!err && err.code === "UNKNOWN" && err.phase === "rollback", "D6a 无 close()：事务结果仍为 UNKNOWN/rollback（不改写成 FAILED）");
      check(dbA._connState === "failed" && dbA._inTx === false, "D6a 无 close()：_connState=failed 且 _inTx 复位");
      check(openCallsA === 0 && dbA.sqlite === null, "D6a 无 close()：未调用 _open()，未创建同文件新连接（open 次数 " + openCallsA + "）");
      check(dbA.stmts.size === 0, "D6a 无 close()：语句缓存已清空（但不作为 finalize 证明）");
      check(!!err && /需进程重启恢复/.test(String(err.message)), "D6a 无 close()：错误信息明确表达连接不可用且需进程重启");
      const racedA = await Promise.race([
        dbA.prepare("SELECT COUNT(*) AS c FROM z").all().then(function () { return "resolved"; }, function (e) { return "rejected:" + (e && e.code) + ":" + (e && e.phase); }),
        new Promise(function (r) { setTimeout(function () { r("HANG"); }, 200); }),
      ]);
      check(/^rejected:FAILED:conn/.test(racedA), "D6a 无 close()：后续队列任务立即 reject（fail-fast；实际 " + racedA + "）");
      let stmtGuardA = null;
      try { dbA.statement("SELECT 1"); } catch (e) { stmtGuardA = e; }
      check(!!stmtGuardA && stmtGuardA.code === "FAILED" && stmtGuardA.phase === "conn", "D6a 无 close()：普通 SQL 无法绕过失败态访问连接（statement 守卫）");
      cleanupPath(pA);

      /* D6b：模拟「某 StatementSync.close() 抛错」⇒ 同样 fail-closed，且不得调用 _open() */
      const pB = join(tmpdir(), "smstoweb_atomic_local_closethrow_" + process.pid + ".db");
      cleanupPath(pB);
      const dbB = new LocalDatabase(pB);
      await dbB.prepare("CREATE TABLE z (id INTEGER PRIMARY KEY, v TEXT)").run();
      const origStmtB = dbB.statement.bind(dbB);
      dbB.statement = function (sql) {
        if (sql === "ROLLBACK") throw new Error("simulated: rollback failed");
        const s = origStmtB(sql);
        return {
          run: s.run.bind(s), all: s.all.bind(s), get: s.get.bind(s), iterate: s.iterate.bind(s),
          close: function () { throw new Error("simulated: finalize failed"); },
        };
      };
      let openCallsB = 0;
      const origOpenB = dbB._open.bind(dbB);
      dbB._open = function () { openCallsB++; return origOpenB(); };
      err = await p(function () {
        return dbB.batchAtomic([
          { sql: "INSERT INTO z (id, v) VALUES (?, ?)", args: [1, "a"] },
          { sql: "INSERT INTO z (id, v) VALUES (?, ?)", args: [1, "b"] },
        ]);
      });
      check(!!err && err.code === "UNKNOWN" && err.phase === "rollback", "D6b finalize 抛错：仍为 UNKNOWN/rollback");
      check(dbB._connState === "failed" && openCallsB === 0 && dbB.sqlite === null, "D6b finalize 抛错：failed、未调用 _open()、无新连接");
      check(/finalize|close\(\)/.test(String(dbB._rebuildError)), "D6b finalize 抛错：诊断保留真实原因（" + String(dbB._rebuildError) + "）");
      const racedB = await Promise.race([
        dbB.prepare("SELECT COUNT(*) AS c FROM z").all().then(function () { return "resolved"; }, function (e) { return "rejected:" + (e && e.code) + ":" + (e && e.phase); }),
        new Promise(function (r) { setTimeout(function () { r("HANG"); }, 200); }),
      ]);
      check(/^rejected:FAILED:conn/.test(racedB), "D6b finalize 抛错：后续任务 fail-fast（实际 " + racedB + "）");
      cleanupPath(pB);

      /* D6c：不 Mock finalize 能力，按当前运行时真实能力决策（仅控制流，不对释放做任何断言） */
      const pC = join(tmpdir(), "smstoweb_atomic_local_realcap_" + process.pid + ".db");
      cleanupPath(pC);
      const dbC = new LocalDatabase(pC);
      await dbC.prepare("CREATE TABLE z2 (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)").run();
      const origStmtC = dbC.statement.bind(dbC);
      dbC.statement = function (sql) {
        if (sql === "ROLLBACK") throw new Error("simulated: rollback failed");
        return origStmtC(sql);
      };
      let openCallsC = 0;
      const origOpenC = dbC._open.bind(dbC);
      dbC._open = function () { openCallsC++; return origOpenC(); };
      err = await p(function () {
        return dbC.batchAtomic([
          { sql: "INSERT INTO z2 (v) VALUES (?)", args: ["c1"] },
          { sql: "INSERT INTO z2 (id) VALUES (?)", args: [1] },
        ]);
      });
      dbC.statement = origStmtC;
      check(!!err && err.code === "UNKNOWN" && err.phase === "rollback", "D6c 真实能力（StatementSync.close=" + hasStmtClose + "）：数据面仍为 UNKNOWN/rollback");
      check(dbC._connState === (hasStmtClose ? "ready" : "failed"), "D6c 真实能力：连接决策与能力一致（期望 " + (hasStmtClose ? "ready" : "failed") + "，实际 " + dbC._connState + "）");
      if (hasStmtClose) {
        const capWrite = await p(function () { return dbC.prepare("INSERT INTO z2 (v) VALUES ('after-rebuild')").run(); });
        check(!capWrite, "D6c 能力可用分支：重开后真实写入成功（真机可写性验证，非 Mock 推断）");
      } else {
        check(openCallsC === 0 && dbC.sqlite === null, "D6c 无 finalize 能力：fail-closed，open 次数 0 且无可用连接（不宣称已释放）");
        const racedC = await Promise.race([
          dbC.prepare("SELECT COUNT(*) AS c FROM z2").all().then(function () { return "resolved"; }, function (e) { return "rejected:" + (e && e.code) + ":" + (e && e.phase); }),
          new Promise(function (r) { setTimeout(function () { r("HANG"); }, 200); }),
        ]);
        check(/^rejected:FAILED:conn/.test(racedC), "D6c 无 finalize 能力：后续任务 fail-fast（实际 " + racedC + "）");
      }
      cleanupPath(pC);

      /* ===== D7 _open() 初始化失败封口 ===== */
      /* D7a：初始化中途抛错 ⇒ 清理路径执行、半初始化连接被关闭、不得进入可用状态 */
      const pD2 = join(tmpdir(), "smstoweb_atomic_local_openfail_" + process.pid + ".db");
      cleanupPath(pD2);
      const dbD2 = new LocalDatabase(pD2);
      const realInit = dbD2._initConn.bind(dbD2);
      const keepConnD = dbD2.sqlite;
      let probeConn = null;
      dbD2._initConn = function (conn) {
        probeConn = conn;
        throw new Error("simulated: init failed after connect");
      };
      let initErr = null;
      try { dbD2._open(); } catch (e) { initErr = e; }
      dbD2._initConn = realInit;
      check(!!initErr, "D7a _open 中途失败：抛出原始错误（" + String(initErr && initErr.message) + "）");
      check(dbD2.sqlite === null, "D7a _open 中途失败：半初始化连接未被当成可用连接（sqlite=null）");
      check(/清理: ok/.test(String(dbD2._initError)), "D7a _open 中途失败：清理路径被执行且记录成功（" + String(dbD2._initError) + "）");
      check(!!probeConn && probeConn.isOpen === false, "D7a _open 中途失败：半初始化连接已被真实关闭（isOpen=false，node:sqlite 实语义）");
      probeConn = null;
      try { keepConnD.close(); } catch (_) {}
      cleanupPath(pD2);

      /* D7b：清理本身失败（close 抛错）⇒ 不得声称已释放、不得恢复 ready、需为 failed */
      const pE = join(tmpdir(), "smstoweb_atomic_local_cleanupfail_" + process.pid + ".db");
      cleanupPath(pE);
      const dbE = new LocalDatabase(pE);
      const protoE = Object.getPrototypeOf(dbE.sqlite);
      const origCloseE = protoE.close;
      let closeSeq = 0;   /* 第 1 次=旧连接，第 2 次=半初始化新连接的清理 */
      protoE.close = function () {
        closeSeq++;
        if (closeSeq === 2) throw new Error("simulated: cleanup close failed");
        return origCloseE.call(this);
      };
      let rebuildOkE = null;
      try {
        dbE._initConn = function () { throw new Error("simulated: init failed after connect"); };
        dbE.stmts.clear();       /* 空缓存：finalize 门槛通过，才会走到 _open() */
        rebuildOkE = dbE._rebuild();
      } finally {
        protoE.close = origCloseE;
      }
      check(rebuildOkE === false, "D7b 清理失败：_rebuild 返回 false（不重开）");
      check(dbE._connState === "failed" && dbE.sqlite === null, "D7b 清理失败：_connState=failed 且无可用的半初始化连接");
      check(/close 失败/.test(String(dbE._initError)) && /重开连接失败/.test(String(dbE._rebuildError)), "D7b 清理失败：诊断如实记录清理失败，未声称已释放（" + String(dbE._initError) + "）");
      const racedE = await Promise.race([
        dbE.prepare("SELECT COUNT(*) AS c FROM sqlite_master").all().then(function () { return "resolved"; }, function (e) { return "rejected:" + (e && e.code) + ":" + (e && e.phase); }),
        new Promise(function (r) { setTimeout(function () { r("HANG"); }, 200); }),
      ]);
      check(/^rejected:FAILED:conn/.test(racedE), "D7b 清理失败：后续任务 fail-fast（" + racedE + "）");
      let stmtGuardE = null;
      try { dbE.statement("SELECT 1"); } catch (e) { stmtGuardE = e; }
      check(!!stmtGuardE && stmtGuardE.code === "FAILED" && stmtGuardE.phase === "conn", "D7b 清理失败：普通 SQL 无法绕过失败态访问半初始化连接");
      cleanupPath(pE);
    } catch (e) {
      check(false, "D 组异常：" + String((e && e.stack) || e));
    } finally {
      try { ldb.sqlite.close(); } catch (_) {}
    }
    cleanupPath(pD);
  }

  /* ===== 阶段 5 组：结构化日志 ===== */
  group("阶段 5 组：结构化日志（字段/服务端 requestId/脱敏/安全响应/降级）");
  {
    const realE = console.error, realW = console.warn, realL = console.log;
    const lines = [];
    const grab = function () { lines.push([].join.call(arguments, " ")); };
    console.error = grab; console.warn = grab; console.log = grab;
    let r1 = null, r2 = null;
    try {
      /* 1 全局异常入口：DB 连续抛错（message/stack 为 getter，内容含手机号与 bearer 令牌） */
      const boom = {
        get name() { return "BoomError"; },
        get message() { return "upstream failed for 13812345678, bearer abcdef123456"; },
        get stack() { return "BoomError: x\n    at handleList (worker.js:100:9)\n    at fetch (worker.js:200:1)"; },
      };
      const eBoom = env({ DB: { prepare: function () { throw boom; } } });
      r1 = await call("GET", "/api/messages", eBoom, { headers: { "X-Request-Id": "client-forged-rid" } });
      /* 2 name/stack getter 自身抛错的降级：日志失败不得破坏业务响应 */
      const boom2 = {
        get name() { throw new Error("name getter boom"); },
        get message() { return "boom2"; },
        get stack() { throw new Error("stack getter boom"); },
      };
      const eBoom2 = env({ DB: { prepare: function () { throw boom2; } } });
      r2 = await call("GET", "/api/messages", eBoom2);
      /* 3 脱敏补充场景（独立短消息，避开 message 内容键 64 字符截断） */
      const boom3 = {
        get name() { return "BoomError"; },
        get message() { return "Authorization: Bearer zzz888777 failed"; },
        get stack() { return "BoomError: x\n    at handleList (worker.js:100:9)"; },
      };
      await call("GET", "/api/messages", env({ DB: { prepare: function () { throw boom3; } } }));
      const boom4 = {
        get name() { return "BoomError"; },
        get message() { return "Cookie: sms_auth=deadbeef1234 access_token=qqq555666"; },
        get stack() { return "BoomError: x\n    at handleList (worker.js:100:9)"; },
      };
      await call("GET", "/api/messages", env({ DB: { prepare: function () { throw boom4; } } }));
    } finally {
      console.error = realE; console.warn = realW; console.log = realL;
    }
    check(r1 && r1.status === 500 && r1.data && r1.data.error === "internal error", "日志：DB 连续抛错 → 500 + 仅安全文案");
    check(!JSON.stringify(r1 && r1.data).match(/BoomError|worker\.js|stack|handleList/), "日志：错误响应不含类名/堆栈（堆栈只留服务端）");
    const recs = lines.map(function (l) { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const rec = recs.find(function (x) { return x.event === "request_error"; });
    check(!!rec, "日志：全局异常入口输出可解析单行 JSON（捕获 " + lines.length + " 行，可解析 " + recs.length + "）");
    if (rec) {
      check(/^\d{4}-\d{2}-\d{2}T/.test(rec.timestamp) && rec.level === "error" && rec.phase === "request", "日志：timestamp/level/phase 字段格式正确");
      check(rec.platform === "test", "日志：platform 字段取自入口注入");
      check(!!rec.requestId && rec.requestId !== "client-forged-rid" && rec.requestId !== "-", "日志：requestId 服务端生成，不采信客户端 X-Request-Id（防伪造）");
      check(rec.requestId.indexOf("rid-") === 0 || /^[0-9a-f-]{36}$/.test(rec.requestId), "日志：requestId 为 UUID 或降级格式");
      check(rec.error && rec.error.name === "BoomError" && rec.error.stack && rec.error.stack.indexOf("handleList") !== -1, "日志：error 对象含 name/message/stack 且服务端保留堆栈");
      check(String(rec.error.message).indexOf("13812345678") === -1 && String(rec.error.message).indexOf("138****5678") !== -1, "日志：错误信息中的手机号已脱敏");
      check(String(rec.error.message).indexOf("abcdef123456") === -1 && String(rec.error.message).indexOf("***") !== -1, "日志：错误信息中的 bearer 令牌已脱敏");
      const rec3 = recs.find(function (x) { return x.event === "request_error" && String(x.error && x.error.message).indexOf("Authorization") !== -1; });
      check(!!rec3 && String(rec3.error.message).indexOf("zzz888777") === -1 && String(rec3.error.message).indexOf("Authorization: Bearer ***") !== -1, "日志：Authorization: Bearer 整串脱敏（不残留真令牌）");
      const rec4 = recs.find(function (x) { return x.event === "request_error" && String(x.error && x.error.message).indexOf("Cookie") !== -1; });
      check(!!rec4 && String(rec4.error.message).indexOf("deadbeef1234") === -1 && String(rec4.error.message).indexOf("qqq555666") === -1 && String(rec4.error.message).indexOf("Cookie: ***") !== -1 && String(rec4.error.message).indexOf("access_token=***") !== -1, "日志：Cookie 值与裸 access_token= 已脱敏");
    }
    const sch = recs.find(function (x) { return x.event === "schema_heal_failed"; });
    check(!!sch && sch.phase === "schema" && sch.requestId === (rec && rec.requestId), "日志：ensureSchema 失败走结构化告警且沿用同一 requestId");
    check(r2 && r2.status === 500 && r2.data && r2.data.error === "internal error", "日志：name/stack getter 抛错时业务仍返回 500（日志降级不破坏响应）");

    /* 3 cron 清理结构化日志 */
    const lines2 = [];
    console.log = function () { lines2.push([].join.call(arguments, " ")); };
    try { await runCron(env()); } finally { console.log = realL; }
    const crecs = lines2.map(function (l) { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const crec = crecs.find(function (x) { return x.event === "cron_cleanup"; });
    check(!!crec && crec.phase === "cron" && crec.level === "info" && typeof crec.cleaned_old === "number" && typeof crec.purged_deleted === "number",
      "日志：cron 清理输出结构化 info 行（cleaned/purged 数值化）");
    if (crec) check(crec.retention_days === 30 && !!crec.requestId, "日志：cron 字段 retention_days/requestId 齐备");
  }

  /* ===== 阶段 1-3 第二提交点组：设备删除 / 合并 → 原子事务 =====
   * 证据等级：L2（本机真实 node:sqlite 本地库 + 真实 BEGIN/COMMIT/ROLLBACK）。
   * 故障注入仅替换 _execDirect 制造"某条语句执行失败"或"ROLLBACK 失败"，事务本身仍是真实 SQLite 事务；
   * 不模拟 D1 / Turso 的真实服务端行为（那属 L3，未在本轮执行）。 */
  group("阶段 1-3 第二提交点：设备删除/合并原子事务（守卫入事务 + 回滚 + fail-closed）");
  {
    const mkDev = async function (name, sim) {
      await db.prepare("INSERT INTO devices (device, sim) VALUES (?1, ?2)").bind(name, sim || "").run();
      const row = await db.prepare("SELECT id FROM devices WHERE device = ?1 AND sim = ?2").bind(name, sim || "").first();
      return row.id;
    };
    const mkMsg = async function (devId, sender, content, time, deletedAt) {
      await db.prepare("INSERT INTO messages (device_id, sender, content, received_at, source, deleted_at) VALUES (?1, ?2, ?3, ?4, 'sms', ?5)")
        .bind(devId, sender, content, time, deletedAt || null).run();
    };
    const countMsgs = async function (devId, activeOnly) {
      const sql = activeOnly
        ? "SELECT COUNT(*) AS n FROM messages WHERE device_id = ?1 AND deleted_at IS NULL"
        : "SELECT COUNT(*) AS n FROM messages WHERE device_id = ?1";
      return (await db.prepare(sql).bind(devId).first()).n;
    };
    const devExists = async function (id) {
      return !!(await db.prepare("SELECT id FROM devices WHERE id = ?1").bind(id).first());
    };

    /* T1 删除成功（无活跃消息；软删记录一并物理删除） */
    const d1 = await mkDev("cp2-删-成功");
    await mkMsg(d1, "s", "cp2-del-soft", "2026-10-19 11:00:00", "2026-10-19 12:00:00");
    r = await call("DELETE", "/api/devices/" + d1, e0);
    check(r.status === 200 && r.data && r.data.success === true && r.data.deleted === 1, "T1 删除成功：无活跃消息（含软删一并删除，deleted=1）");
    check(!(await devExists(d1)) && (await countMsgs(d1)) === 0, "T1 删除成功：设备记录与全部消息均无残留");

    /* T2 删除不存在设备：保持原语义 success=true / deleted=0 */
    r = await call("DELETE", "/api/devices/999999", e0);
    check(r.status === 200 && r.data && r.data.success === true && r.data.deleted === 0, "T2 删除不存在设备：保持原语义（success=true, deleted=0）");

    /* T3 存在活跃消息：维持原拒绝行为，且事务内守卫保证零删除 */
    const d3 = await mkDev("cp2-删-有活跃");
    await mkMsg(d3, "s", "cp2-del-active", "2026-10-19 13:00:00", null);
    r = await call("DELETE", "/api/devices/" + d3, e0);
    check(r.status === 400 && r.data && r.data.error === "has messages", "T3 存在活跃消息：仍拒绝（400 has messages）");
    check((await devExists(d3)) && (await countMsgs(d3)) === 1, "T3 拒绝后设备与活跃消息均未受影响（守卫在事务内生效）");

    /* T4 删除事务中途失败 → 真实 ROLLBACK，整体回滚 */
    const d4 = await mkDev("cp2-删-回滚");
    await mkMsg(d4, "s", "cp2-del-rb", "2026-10-19 14:00:00", "2026-10-19 14:30:00");
    const delSeq = [];
    const realExec = db._execDirect.bind(db);
    db._execDirect = function (sql, args) {
      delSeq.push(sql);
      if (/^DELETE FROM devices/.test(sql)) throw new Error("injected: delete devices failed");
      return realExec(sql, args);
    };
    try { r = await call("DELETE", "/api/devices/" + d4, e0); } finally { db._execDirect = realExec; }
    check(r.status === 500 && r.data && r.data.error === "internal error", "T4 删除事务中途失败：走全局错误路径（500，不误报成功）");
    check(delSeq.filter(function (s) { return s === "BEGIN"; }).length === 1 && delSeq.filter(function (s) { return s === "ROLLBACK"; }).length === 1,
      "T4 删除事务中途失败：BEGIN 1 次 + ROLLBACK 1 次（真实回滚）");
    check((await devExists(d4)) && (await countMsgs(d4)) === 1, "T4 删除事务中途失败：整体回滚（设备仍在、软删消息未被删）");

    /* T5 / T8 / T9 合并成功：M1~M6（唯一索引冲突 + 源软删清理） */
    const mFrom = await mkDev("cp2-合并-源");
    const mTo = await mkDev("cp2-合并-目标");
    await mkMsg(mTo, "s", "cp2-merge-dup", "2026-10-19 18:00:00", null);
    await mkMsg(mFrom, "s", "cp2-merge-a1", "2026-10-19 18:10:00", null);
    await mkMsg(mFrom, "s", "cp2-merge-dup", "2026-10-19 18:00:00", null);      /* 与目标唯一键冲突 → 不迁移 */
    await mkMsg(mFrom, "s", "cp2-merge-soft", "2026-10-19 18:20:00", "2026-10-19 18:30:00"); /* 源软删 → 清理 */
    const toBefore5 = await countMsgs(mTo, true);
    const fromActiveBefore5 = await countMsgs(mFrom, true);
    const fromSoftBefore5 = (await countMsgs(mFrom, false)) - fromActiveBefore5;
    r = await call("POST", "/api/devices/merge", e0, { body: { from: mFrom, to: mTo } });
    const M1 = r.data && r.data.moved;
    check(r.status === 200 && r.data && r.data.success === true, "T5 合并成功：返回 success=true");
    check(M1 === 1, "T5 M1 活跃迁移数 = 1（仅无冲突的活跃消息被迁移）");
    check(M1 === fromActiveBefore5 - 1, "T8 M2 唯一索引冲突未迁移的活跃数 = 1（守卫/OR IGNORE 语义保留）");
    check(fromSoftBefore5 === 1, "T9 合并前源设备含 1 条软删消息（M3 前置条件成立）");
    check((await countMsgs(mFrom, false)) === 0 && !(await devExists(mFrom)), "T5 M4/M5 源消息（软删+冲突）实际清空，源设备记录无残留");
    check((await countMsgs(mTo, true)) === toBefore5 + M1, "T5 M6 目标活跃消息数 = 迁移前 + M1（" + toBefore5 + " + " + M1 + "）");
    check((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE device_id = ?1 AND content = 'cp2-merge-dup'").bind(mTo).first()).n === 1,
      "T8 冲突记录未被重复迁移（目标同键消息仍只有 1 条）");
    /* 说明：本组只断言 M1~M6 与目标/源码各自的计数，不断言全局消息总数守恒 */

    /* T6 源设备不存在 → 404，且目标无写入 */
    const t6To = await mkDev("cp2-合并-T6目标");
    await mkMsg(t6To, "s", "cp2-t6-to", "2026-10-19 20:00:00", null);
    const t6Before = await countMsgs(t6To, true);
    r = await call("POST", "/api/devices/merge", e0, { body: { from: 999999, to: t6To } });
    check(r.status === 404 && r.data && r.data.error === "device not found", "T6 合并源设备不存在：404 device not found");
    check((await countMsgs(t6To, true)) === t6Before, "T6 源不存在：事务内守卫拦截，目标消息数不变");

    /* T7 目标设备不存在 → 404，且源无写入 */
    const t7From = await mkDev("cp2-合并-T7源");
    await mkMsg(t7From, "s", "cp2-t7-from", "2026-10-19 20:10:00", null);
    const t7Before = await countMsgs(t7From, true);
    r = await call("POST", "/api/devices/merge", e0, { body: { from: t7From, to: 999999 } });
    check(r.status === 404 && r.data && r.data.error === "device not found", "T7 合并目标设备不存在：404 device not found");
    check((await countMsgs(t7From, true)) === t7Before && (await devExists(t7From)), "T7 目标不存在：事务内守卫拦截，源消息与设备原样保留");

    /* T10 合并各阶段失败 → 真实 ROLLBACK，整体回滚（迁移阶段 / 收尾阶段各注入一次） */
    const rbFrom = await mkDev("cp2-合并-回滚-源");
    const rbTo = await mkDev("cp2-合并-回滚-目标");
    await mkMsg(rbFrom, "s", "cp2-rb-a", "2026-10-19 21:00:00", null);
    await mkMsg(rbFrom, "s", "cp2-rb-soft", "2026-10-19 21:10:00", "2026-10-19 21:20:00");
    const rbToBefore = await countMsgs(rbTo, true);
    const rbSeq = [];
    db._execDirect = function (sql, args) {
      rbSeq.push(sql);
      if (/^UPDATE OR IGNORE messages/.test(sql)) throw new Error("injected: migrate failed");
      return realExec(sql, args);
    };
    try { r = await call("POST", "/api/devices/merge", e0, { body: { from: rbFrom, to: rbTo } }); } finally { db._execDirect = realExec; }
    check(r.status === 500, "T10 迁移阶段失败：500（走全局错误路径）");
    check(rbSeq.filter(function (s) { return s === "ROLLBACK"; }).length === 1, "T10 迁移阶段失败：执行了真实 ROLLBACK");
    check((await countMsgs(rbFrom, false)) === 2 && (await devExists(rbFrom)) && (await countMsgs(rbTo, true)) === rbToBefore,
      "T10 迁移阶段失败：源消息/源设备/目标计数全部回滚原样");
    const rb2Seq = [];
    db._execDirect = function (sql, args) {
      rb2Seq.push(sql);
      if (/^DELETE FROM devices/.test(sql)) throw new Error("injected: delete source device failed");
      return realExec(sql, args);
    };
    try { r = await call("POST", "/api/devices/merge", e0, { body: { from: rbFrom, to: rbTo } }); } finally { db._execDirect = realExec; }
    check(r.status === 500, "T10 收尾阶段失败：500（不误报成功）");
    check((await countMsgs(rbFrom, false)) === 2 && (await devExists(rbFrom)) && (await countMsgs(rbTo, true)) === rbToBefore,
      "T10 收尾阶段失败：已迁移与已清理效果整体回滚（源消息/设备/目标均原样）");

    /* T11 / T12 UNKNOWN 不自动重试 + v24.19.0 下 ROLLBACK 失败仍 P0 fail-closed（独立库，避免污染共享 db） */
    const pP0 = join(tmpdir(), "smstoweb_cp2_p0_" + process.pid + ".db");
    cleanupPath(pP0);
    const dbP0 = new LocalDatabase(pP0);
    const eP0 = env({ DB: dbP0, ENABLE_AUTH: "" });
    await dbP0.prepare("INSERT INTO devices (device, sim) VALUES ('cp2-p0', '')").run();
    const devP0 = (await dbP0.prepare("SELECT id FROM devices WHERE device = 'cp2-p0'").first()).id;
    await dbP0.prepare("INSERT INTO messages (device_id, sender, content, received_at, deleted_at) VALUES (?1, 's', 'cp2-p0-soft', '2026-10-19 19:00:00', '2026-10-19 19:10:00')").bind(devP0).run();
    let baCalls = 0;
    const p0Seq = [];
    const origBA = dbP0.batchAtomic.bind(dbP0);
    const p0Exec = dbP0._execDirect.bind(dbP0);
    dbP0.batchAtomic = function (stmts) { baCalls++; return origBA(stmts); };
    dbP0._execDirect = function (sql, args) {
      p0Seq.push(sql);
      if (sql === "ROLLBACK") throw new Error("injected: rollback failed");
      if (/^DELETE FROM devices/.test(sql)) throw new Error("injected: delete devices failed");
      return p0Exec(sql, args);
    };
    try { r = await call("DELETE", "/api/devices/" + devP0, eP0); } finally { dbP0._execDirect = p0Exec; dbP0.batchAtomic = origBA; }
    check(r.status === 500, "T12 ROLLBACK 失败：UNKNOWN 走全局错误路径（500，不报成功）");
    check(baCalls === 1 && p0Seq.filter(function (s) { return s === "BEGIN"; }).length === 1, "T11 UNKNOWN：batchAtomic 仅调用 1 次、BEGIN 仅 1 次（不自动重试原事务）");
    check(dbP0._connState === "failed", "T12 v24.19.0 无 StatementSync.close()：连接重建 fail-closed（_connState=failed）");
    const rAfterP0 = await call("DELETE", "/api/devices/" + devP0, eP0);
    check(rAfterP0.status === 500 && rAfterP0.data && rAfterP0.data.error === "internal error", "T12 fail-closed 后：后续请求立即失败（fail-fast，不重试、不误报）");
    cleanupPath(pP0);

    /* T13 并发守卫与写入顺序：守卫必须在事务内 */
    /* T13a 成功删除的语句顺序：BEGIN → 存在性 → 守卫删除消息 → 守卫删除设备 → COMMIT */
    const d13a = await mkDev("cp2-并发-顺序");
    await mkMsg(d13a, "s", "cp2-conc-order", "2026-10-19 23:00:00", "2026-10-19 23:10:00");
    const ordSeq = [];
    db._execDirect = function (sql, args) { ordSeq.push(sql); return realExec(sql, args); };
    try { r = await call("DELETE", "/api/devices/" + d13a, e0); } finally { db._execDirect = realExec; }
    check(ordSeq.length === 5 && ordSeq[0] === "BEGIN" && /^UPDATE devices SET id = id/.test(ordSeq[1])
      && /^DELETE FROM messages/.test(ordSeq[2]) && /^DELETE FROM devices/.test(ordSeq[3]) && ordSeq[4] === "COMMIT",
      "T13a 写入顺序：BEGIN → 存在性 → 消息删除 → 设备删除 → COMMIT（无跨事务窗口）");
    check(/deleted_at IS NULL/.test(ordSeq[2]) && /NOT EXISTS \(SELECT 1 FROM messages/.test(ordSeq[3]),
      "T13a 守卫条件直接内嵌在事务语句中（非事务外预检）");

    /* T13b 并发删除（有活跃消息）：全部拒绝，设备与消息零变化 */
    const d13b = await mkDev("cp2-并发-活跃");
    await mkMsg(d13b, "s", "cp2-conc-active", "2026-10-19 23:20:00", null);
    const conc1 = await Promise.all(Array.from({ length: 8 }, function () { return call("DELETE", "/api/devices/" + d13b, e0); }));
    check(conc1.every(function (x) { return x.status === 400 && x.data && x.data.error === "has messages"; }), "T13b 并发删除（有活跃消息）：8 次全部 400（守卫在事务内逐次生效）");
    check((await devExists(d13b)) && (await countMsgs(d13b)) === 1, "T13b 并发后：设备仍在、活跃消息未丢");

    /* T13c 并发删除（仅软删消息）：FIFO 串行下恰好一次成功删除，其余 deleted=0 */
    const d13c = await mkDev("cp2-并发-软删");
    await mkMsg(d13c, "s", "cp2-conc-soft", "2026-10-19 23:30:00", "2026-10-19 23:40:00");
    const conc2 = await Promise.all(Array.from({ length: 8 }, function () { return call("DELETE", "/api/devices/" + d13c, e0); }));
    const delSum = conc2.reduce(function (a, x) { return a + ((x.data && x.data.deleted) || 0); }, 0);
    const oneShot = conc2.filter(function (x) { return x.data && x.data.success === true && x.data.deleted === 1; }).length;
    check(delSum === 1 && oneShot === 1 && !(await devExists(d13c)), "T13c 并发删除（仅软删）：总删除数恰为 1、设备最终不存在（无重复/无残留）");
  }

  /* TEST-DB-001 退出顺序：关主库连接 → 清文件 → 输出结果 → 退出；关闭后不再访问 db */
  closeMainDb("退出清理");
  cleanup("退出清理");
  console.log("\n===== 结果：" + pass + " 通过，" + fail + " 失败 =====");
  if (fail) console.log("失败项：\n - " + failed.join("\n - "));
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  closeMainDb("退出清理");
  cleanup("退出清理");
  console.error("测试异常：", e);
  process.exit(2);
});
