/**
 * M-1 / R3-01：Node 平台「后台任务登记 + 优雅停机」正式测试套件
 *
 * 运行：node tests/m1-lifecycle.mjs   （退出码 0=全过，1=有失败，2=异常）
 * ⚠ 必须在 Linux / WSL2 / Docker 容器内运行：本套件用真实 POSIX SIGTERM
 *   （child.kill("SIGTERM")）驱动停机，不用 process.emit("SIGTERM") 模拟。
 *
 * 与 R1-05 的区别：R1-05 的 waitUntil 是「收集 Promise 并主动 await」的替身，
 * 永远不会暴露停机风险。本套件使用**真实**的 lifecycle.mjs 登记机制、真实的
 * http.Server、真实的 createShutdownCoordinator、真实的 LocalDatabase，并通过
 * 真实 HTTP 响应与真实信号证明「响应与后台任务生命周期确实分离」。
 *
 * 结构：
 *   · 无参数      → 父进程测试模式
 *   · --child     → 子进程（真实 HTTP 服务 + 真实停机流程）模式
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBackgroundTaskRegistry,
  createShutdownCoordinator,
  deriveShutdownBudgets,
} from "../platforms/node/lifecycle.mjs";
import { LocalDatabase } from "../platforms/node/db.js";

const SELF = fileURLToPath(import.meta.url);
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

/* ==================== 子进程：真实 HTTP 服务 + 真实停机流程 ==================== */
async function childMain() {
  const env = process.env;
  const scenario = String(env.M1_SCENARIO || "normal");
  const taskMs = Number(env.M1_TASK_MS || 1200);
  const taskCount = Number(env.M1_TASKS || 1);
  const dbPath = join(tmpdir(), "m1_lifecycle_" + process.pid + ".db");
  const db = new LocalDatabase(dbPath);

  function clog(level, event, fields) {
    let line;
    try {
      line = JSON.stringify(Object.assign({ ts: new Date().toISOString(), level: level, event: event, side: "child" }, fields || {}));
    } catch (_) { line = JSON.stringify({ ts: new Date().toISOString(), event: "child_log_failed", side: "child" }); }
    try { console.log(line); } catch (_) {}
  }

  const registry = createBackgroundTaskRegistry({ log: clog });
  const budgets = Object.assign(deriveShutdownBudgets({}), {
    httpGraceMs: Number(env.M1_HTTP_GRACE_MS || 3000),
    bgDrainMs: Number(env.M1_BG_DRAIN_MS || 6000),
    totalGraceMs: Number(env.M1_TOTAL_GRACE_MS || 20000),
  });

  /* 停机期间新业务请求必须被拒绝（与 server.mjs handler 同语义） */
  let draining = false;
  const server = http.createServer(async function (req, res) {
    if (draining) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Connection": "close" });
      res.end(JSON.stringify({ success: false, error: "shutting down" }));
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/hang") {
      /* 故意制造在途 HTTP 请求，用于验证 http_close_timeout 兜底路径 */
      await sleep(Number(env.M1_HANG_MS || 10000));
      res.end(JSON.stringify({ success: true, hung: true }));
      return;
    }
    if (url.pathname === "/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ pending: registry.size(), stats: registry.stats() }));
      return;
    }
    if (url.pathname === "/trigger") {
      const n = scenario === "none" ? 0 : taskCount;
      for (let i = 0; i < n; i++) {
        const index = i;
        /* 真实后台任务体：延时 → 可选真实 SQLite 读 → 可选失败 → 完成 */
        const p = (async function () {
          await sleep(taskMs + index * 250);
          if (env.M1_DB_READ === "1") {
            const row = await db.prepare("SELECT COUNT(*) AS n FROM messages").first();
            clog("info", "background_db_read_ok", { task: index, rows: row && row.n, note: "SIGTERM 后仍成功读取真实 SQLite" });
          }
          if (env.M1_REJECT === "1") throw new Error("m1 intentional background failure");
          clog("info", "background_body_done", { task: index });
          return index;
        })();
        registry.waitUntil(p);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, registered: n, pending: registry.size() }));
      return;
    }
    res.writeHead(404); res.end("{}");
  });

  /* 仅测试注入：延迟真实 server.close 的调用，制造「draining=true 但端口仍可连接」
     的窗口，用于验证 handler 层「拒绝新业务请求 503」这条防御路径确实生效。
     生产 server.mjs 直接传真实 server，不存在该延迟。 */
  const closeDelayMs = Number(env.M1_DELAY_CLOSE_MS || 0);
  const coordServer = closeDelayMs > 0 ? {
    close: function (cb) { setTimeout(function () { server.close(cb); }, closeDelayMs); },
    closeIdleConnections: function () { /* 窗口内保持可连接，便于断言 handler 503 */ },
  } : server;
  const coordinator = createShutdownCoordinator({
    server: coordServer,
    registry: registry,
    budgets: budgets,
    log: clog,
    closeDb: function () {
      /* 真实 LocalDatabase.close()：置 _closed，使后续访问 fail-fast */
      const ok = db.close();
      clog("info", "db_closed", { ok: ok, note: "SQLite 仅在后台任务收敛后关闭" });
      return ok;
    },
    onDraining: function () { draining = true; },
    exit: function (code) {
      clog("info", "child_exiting", { exit_code: code });
      /* 留一拍让 stdout 落盘，再真实退出 */
      setTimeout(function () { process.exit(code); }, 30);
    },
  });

  server.listen(0, "127.0.0.1", function () {
    const port = server.address().port;
    clog("info", "child_ready", { port: port, scenario: scenario, budgets: budgets, db_path: dbPath });
  });
  process.on("SIGTERM", function () { coordinator.shutdown("SIGTERM"); });
  process.on("SIGINT", function () { coordinator.shutdown("SIGINT"); });
  /* 真实信号处理器已注册；不捕 SIGTERM 的 unhandled rejection，让问题暴露 */
}

/* ==================== 父进程：测试框架 ==================== */
let pass = 0, fail = 0;
const failed = [];
function check(cond, name, detail) {
  if (cond) { pass++; console.log("  ok   " + name + (detail ? "  [" + detail + "]" : "")); }
  else { fail++; failed.push(name); console.log("  FAIL " + name + (detail ? "  [" + detail + "]" : "")); }
}
function group(t) { console.log("\n# " + t); }

function spawnChild(opts) {
  const o = opts || {};
  return new Promise(function (resolve, reject) {
    const env = Object.assign({}, process.env, {
      M1_SCENARIO: String(o.scenario || "normal"),
      M1_TASK_MS: String(o.taskMs == null ? 1200 : o.taskMs),
      M1_TASKS: String(o.tasks == null ? 1 : o.tasks),
      M1_HTTP_GRACE_MS: String(o.httpGraceMs == null ? 3000 : o.httpGraceMs),
      M1_BG_DRAIN_MS: String(o.bgDrainMs == null ? 6000 : o.bgDrainMs),
      M1_TOTAL_GRACE_MS: String(o.totalGraceMs == null ? 20000 : o.totalGraceMs),
      M1_HANG_MS: String(o.hangMs == null ? 10000 : o.hangMs),
      M1_DELAY_CLOSE_MS: String(o.delayCloseMs == null ? 0 : o.delayCloseMs),
      M1_DB_READ: o.dbRead ? "1" : "",
      M1_REJECT: o.reject ? "1" : "",
    });
    const child = spawn(process.execPath, [SELF, "--child"], { env: env, stdio: ["ignore", "pipe", "pipe"] });
    const lines = [];
    let stdoutAll = "", stderrAll = "", buf = "", ready = false;
    const to = setTimeout(function () { if (!ready) reject(new Error("child_ready timeout")); }, 12000);
    child.stdout.on("data", function (d) {
      const s = String(d);
      stdoutAll += s; buf += s;
      const arr = buf.split("\n"); buf = arr.pop();
      for (const line of arr) {
        if (!line.trim()) continue;
        lines.push(line);
        if (ready) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.event === "child_ready") {
            ready = true; clearTimeout(to);
            resolve({ child: child, port: obj.port, lines: lines, dbPath: obj.db_path,
              stdout: function () { return stdoutAll; }, stderr: function () { return stderrAll; } });
          }
        } catch (_) {}
      }
    });
    child.stderr.on("data", function (d) { stderrAll += String(d); });
    child.on("error", reject);
    child.on("exit", function (code, signal) {
      if (!ready) { clearTimeout(to); reject(new Error("child exited before ready: code=" + code + " signal=" + signal + " stderr=" + stderrAll)); }
    });
  });
}

function evs(h) {
  return h.lines.map(function (l) { try { return JSON.parse(l); } catch (_) { return null; } }).filter(function (x) { return !!x; });
}
function byEvent(h, name) { return evs(h).filter(function (e) { return e.event === name; }); }
function first(h, name) { return byEvent(h, name)[0] || null; }
function waitExit(h) {
  return new Promise(function (resolve) {
    if (h.child.exitCode !== null || h.child.signalCode !== null) {
      return resolve({ code: h.child.exitCode, signal: h.child.signalCode });
    }
    h.child.once("exit", function (code, signal) { resolve({ code: code, signal: signal }); });
  });
}
function t(e) { return e ? Date.parse(e.ts) : NaN; }
function cleanupDb(p) {
  if (!p) return;
  for (const suf of ["", "-wal", "-shm", "-journal"]) { try { rmSync(p + suf, { force: true }); } catch (_) {} }
}

async function testMain() {
  /* ---------- 组 A：时间预算真值表 ---------- */
  group("A · 四层时间预算推导（deriveShutdownBudgets）");
  const b0 = deriveShutdownBudgets({});
  check(b0.waitMaxSeconds === 25 && b0.httpGraceMs === 30000,
    "M1-B01 默认长轮询 25s → HTTP 预算 30s", "http=" + b0.httpGraceMs);
  check(b0.bgWorstMs === 40000 && b0.bgDrainMs === 45000,
    "M1-B02 后台最坏 40s（4×10s 串行重试）→ drain 预算 45s", "drain=" + b0.bgDrainMs);
  check(b0.derivedTotalMs === 80000 && b0.totalGraceMs === 80000 && b0.recommendedContainerGraceSeconds === 90,
    "M1-B03 应用整体宽限 80s，容器建议 90s（四层不倒挂）", "total=" + b0.totalGraceMs);
  const bLow = deriveShutdownBudgets({ WAIT_MAX_SECONDS: "25", SHUTDOWN_GRACE_MS: "1000" });
  check(bLow.totalGraceMs === 80000, "M1-B04 SHUTDOWN_GRACE_MS 低于推导值被钳回 80s（禁止静默截断）");
  const bHigh = deriveShutdownBudgets({ SHUTDOWN_GRACE_MS: "200000" });
  check(bHigh.totalGraceMs === 120000 && bHigh.recommendedContainerGraceSeconds === 130,
    "M1-B05 调大值受 120s 上限约束，容器建议同步升到 130s");

  /* ---------- 组 B：真实登记机制（同进程，精确状态断言） ---------- */
  group("B · 真实登记机制状态机（非「收集+主动 await」替身）");
  {
    const logs = [];
    const unhandled = [];
    const onUnhandled = function (e) { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    const reg = createBackgroundTaskRegistry({ log: function (l, e, f) { logs.push({ l, e, f }); } });
    let ran = 0;
    const p = new Promise(function (r) { setTimeout(function () { ran++; r("ok"); }, 40); });
    reg.waitUntil(p);
    check(reg.size() === 1, "M1-B06 waitUntil 登记后集合 size=1", "size=" + reg.size());
    reg.waitUntil(p);
    check(reg.size() === 1 && logs.some(function (x) { return x.e === "background_task_duplicate_ignored"; }),
      "M1-B08 同一任务不重复登记、不重复执行（§四.6 设计要求）");
    await sleep(90);
    check(ran === 1 && reg.size() === 0 && logs.some(function (x) { return x.e === "background_task_completed"; }),
      "M1-02 后台任务完成后自动移除登记", "ran=" + ran + " size=" + reg.size());
    const before = unhandled.length;
    reg.waitUntil(Promise.reject(new Error("m1 rejection")));
    await sleep(30);
    check(reg.size() === 0 && logs.some(function (x) { return x.e === "background_task_rejected"; }) && unhandled.length === before,
      "M1-03 rejection 后正确记录并移除，无未处理 Promise rejection");
    /* 超时任务：明确放弃，不伪装成功 */
    const reg2 = createBackgroundTaskRegistry({ log: function (l, e, f) { logs.push({ l, e, f, tag: "reg2" }); } });
    let late = false;
    const slowP = new Promise(function (r) { setTimeout(function () { late = true; r(); }, 60); });
    reg2.waitUntil(slowP);
    const dr = await reg2.drain({ deadlineAt: Date.now() + 15, log: function () {}, now: Date.now });
    const tagged = logs.filter(function (x) { return x.tag === "reg2"; });
    check(dr.timedOut === 1 && tagged.some(function (x) { return x.e === "background_task_timeout"; }) &&
      !tagged.some(function (x) { return x.e === "background_task_completed"; }),
      "M1-08 超时任务记为 background_task_timeout，绝不记为成功");
    await sleep(90);
    check(late === true && !tagged.some(function (x) { return x.e === "background_task_completed"; }) && unhandled.length === before,
      "M1-B07 超时后迟到的 settle 不改写结果，也不产生未处理 rejection");
    process.removeListener("unhandledRejection", onUnhandled);
  }

  /* ---------- 组 C：真实进程 + 真实 POSIX SIGTERM ---------- */
  group("C · 真实 HTTP 服务 / 真实 SIGTERM / 真实 SQLite");

  /* C1：登记不阻塞响应 + SIGTERM 等待 + DB 关闭顺序 */
  {
    const h = await spawnChild({ scenario: "normal", taskMs: 1400, tasks: 1,
      httpGraceMs: 3000, bgDrainMs: 6000, totalGraceMs: 20000 });
    const tResp0 = Date.now();
    const resp = await fetch("http://127.0.0.1:" + h.port + "/trigger");
    const body = await resp.json();
    const respMs = Date.now() - tResp0;
    const respAt = Date.now();
    h.child.kill("SIGTERM");
    const ex = await waitExit(h);
    const started = first(h, "shutdown_started");
    const completed = first(h, "background_task_completed");
    const bodyDone = first(h, "background_body_done");
    const dbClosed = first(h, "db_closed");
    const done = first(h, "shutdown_complete");
    check(resp.status === 200 && body.success === true && respMs < 900 && body.pending === 1,
      "M1-01 waitUntil 登记任务不阻塞 HTTP 响应", "resp_ms=" + respMs + " pending=" + body.pending);
    check(!!completed && t(completed) > t(started) && respAt > 0,
      "M1-04 收到 SIGTERM 后仍在等待已登记后台任务（完成时间晚于停机开始）",
      "delta=" + (completed ? t(completed) - t(started) : "n/a") + "ms");
    check(!!dbClosed && !!completed && t(completed) < t(dbClosed) && dbClosed.ok === true,
      "M1-06 后台任务完成后 SQLite 才关闭", "order=completed<db_closed");
    check(!!done && done.db_closed === true && done.bg_finished >= 1 && done.bg_timed_out === 0 && ex.code === 0,
      "M1-04b 停机正常完成：db_closed=true / bg_finished>=1 / exit 0", "exit=" + ex.code);
    check(!!bodyDone && !/UnhandledPromiseRejection|unhandledRejection/i.test(h.stderr()),
      "M1-12 正常运行期间后台任务不影响响应，无未处理 rejection");
    cleanupDb(h.dbPath);
  }

  /* C2：SIGTERM 后仍执行一次真实 SQLite 读，证明 DB 未提前关闭 */
  {
    const h = await spawnChild({ scenario: "db", taskMs: 900, tasks: 1, dbRead: true,
      httpGraceMs: 3000, bgDrainMs: 6000, totalGraceMs: 20000 });
    await fetch("http://127.0.0.1:" + h.port + "/trigger");
    await sleep(60);
    h.child.kill("SIGTERM");
    const ex = await waitExit(h);
    const started = first(h, "shutdown_started");
    const dbRead = first(h, "background_db_read_ok");
    const dbClosed = first(h, "db_closed");
    check(!!dbRead && !!started && t(dbRead) > t(started),
      "M1-05 等待期间 SQLite 保持可用：后台任务在 SIGTERM 之后完成真实 SQLite 读",
      "delta=" + (dbRead && started ? t(dbRead) - t(started) : "n/a") + "ms");
    check(!!dbRead && !!dbClosed && t(dbRead) < t(dbClosed) && ex.code === 0,
      "M1-05b DB 读成功（非 db_access_after_close）且随后才关闭", "rows=" + (dbRead && dbRead.rows));
    check(!byEvent(h, "db_access_after_close").length,
      "M1-05c 无「关闭后访问」错误");
    cleanupDb(h.dbPath);
  }

  /* C3：任务超过 drain 截止时间 → 明确超时记录，不报成功 */
  {
    const h = await spawnChild({ scenario: "slow", taskMs: 5000, tasks: 1,
      httpGraceMs: 2500, bgDrainMs: 700, totalGraceMs: 8000 });
    await fetch("http://127.0.0.1:" + h.port + "/trigger");
    await sleep(50);
    h.child.kill("SIGTERM");
    const ex = await waitExit(h);
    const timeouts = byEvent(h, "background_task_timeout");
    const completed = byEvent(h, "background_task_completed");
    const unfinished = first(h, "background_tasks_unfinished");
    const done = first(h, "shutdown_complete");
    check(timeouts.length === 1 && !!unfinished && unfinished.count === 1,
      "M1-07 超过截止时间产生明确 background_task_timeout / unfinished 记录", "timeouts=" + timeouts.length);
    check(completed.length === 0 && !!done && done.bg_timed_out === 1 && done.bg_finished === 0,
      "M1-08b 超时任务在停机统计中不记为成功", "bg_finished=" + (done && done.bg_finished));
    check(ex.code === 0 && !!done && done.db_closed === true,
      "M1-07b 有界等待结束后按设计正常退出（exit 0，非强制兜底）", "exit=" + ex.code);
    cleanupDb(h.dbPath);
  }

  /* C4：重复信号幂等 */
  {
    const h = await spawnChild({ scenario: "normal", taskMs: 900, tasks: 1,
      httpGraceMs: 3000, bgDrainMs: 6000, totalGraceMs: 20000 });
    await fetch("http://127.0.0.1:" + h.port + "/trigger");
    h.child.kill("SIGTERM");
    await sleep(120);
    try { h.child.kill("SIGTERM"); } catch (_) {}
    const ex = await waitExit(h);
    const ignored = byEvent(h, "shutdown_signal_ignored");
    const done = byEvent(h, "shutdown_complete");
    const exits = byEvent(h, "child_exiting");
    check(ignored.length >= 1, "M1-09 第二次 SIGTERM 被幂等拦截并留下 shutdown_signal_ignored", "count=" + ignored.length);
    check(done.length === 1 && exits.length === 1 && ex.code === 0,
      "M1-09b 不重复执行关闭流程（shutdown_complete / exit 各 1 次）",
      "complete=" + done.length + " exits=" + exits.length);
    cleanupDb(h.dbPath);
  }

  /* C5：无后台任务时快速关闭 */
  {
    const h = await spawnChild({ scenario: "none", tasks: 0,
      httpGraceMs: 3000, bgDrainMs: 6000, totalGraceMs: 20000 });
    const t0 = Date.now();
    h.child.kill("SIGTERM");
    const ex = await waitExit(h);
    const elapsed = Date.now() - t0;
    const done = first(h, "shutdown_complete");
    check(!!done && done.bg_finished === 0 && done.bg_timed_out === 0 && elapsed < 3000 && ex.code === 0,
      "M1-10 没有后台任务时仍能正常快速关闭", "elapsed=" + elapsed + "ms exit=" + ex.code);
    cleanupDb(h.dbPath);
  }

  /* C6：多任务并发，全部完成后才关 DB */
  {
    const h = await spawnChild({ scenario: "multi", taskMs: 700, tasks: 3,
      httpGraceMs: 3000, bgDrainMs: 6000, totalGraceMs: 20000 });
    await fetch("http://127.0.0.1:" + h.port + "/trigger");
    await sleep(40);
    h.child.kill("SIGTERM");
    const ex = await waitExit(h);
    const registered = byEvent(h, "background_task_registered");
    const completed = byEvent(h, "background_task_completed");
    const bodies = byEvent(h, "background_body_done");
    const dbClosed = first(h, "db_closed");
    const done = first(h, "shutdown_complete");
    check(registered.length === 3 && bodies.length === 3 && completed.length === 3,
      "M1-11 多个后台任务并发执行：3 个登记 / 3 个完成", "registered=" + registered.length + " completed=" + completed.length);
    check(!!dbClosed && completed.every(function (e) { return t(e) < t(dbClosed); }) &&
      !!done && done.bg_finished >= 3 && done.db_closed === true && ex.code === 0,
      "M1-11b 全部完成后才关闭数据库，停机统计 bg_finished>=3", "bg_finished=" + (done && done.bg_finished));
    cleanupDb(h.dbPath);
  }

  /* C7：后台任务失败不影响 HTTP 响应 */
  {
    const h = await spawnChild({ scenario: "reject", taskMs: 300, tasks: 1, reject: true,
      httpGraceMs: 3000, bgDrainMs: 6000, totalGraceMs: 20000 });
    const resp = await fetch("http://127.0.0.1:" + h.port + "/trigger");
    const body = await resp.json();
    /* SIGTERM 在后台任务完成之前发出：让 rejection 发生在停机等待窗口内，证据更强 */
    h.child.kill("SIGTERM");
    const ex = await waitExit(h);
    const rejected = byEvent(h, "background_task_rejected");
    const drainDone = first(h, "background_task_drain_finished");
    const started = first(h, "shutdown_started");
    check(resp.status === 200 && body.success === true && ex.code === 0,
      "M1-12b 后台任务 rejection 不影响 HTTP 响应与停机退出码", "status=" + resp.status + " exit=" + ex.code);
    check(rejected.length === 1 && !!drainDone && drainDone.remaining === 0 &&
      !!started && t(rejected[0]) > t(started) && !/UnhandledPromiseRejection/i.test(h.stderr()),
      "M1-03b 失败任务在停机窗口内被记录并从登记集合移除（remaining=0）");
    cleanupDb(h.dbPath);
  }

  /* C8：HTTP 阶段卡住 → 兜底路径，不提前关 DB */
  {
    const h = await spawnChild({ scenario: "hang", tasks: 0,
      httpGraceMs: 700, bgDrainMs: 3000, totalGraceMs: 10000, hangMs: 9000 });
    const hangP = fetch("http://127.0.0.1:" + h.port + "/hang").then(function (r) { return r.status; }).catch(function () { return 0; });
    await sleep(120);
    h.child.kill("SIGTERM");
    const ex = await waitExit(h);
    await hangP;
    const aborted = first(h, "shutdown_aborted");
    const skipped = first(h, "db_close_skipped");
    const dbClosed = byEvent(h, "db_closed");
    check(!!aborted && aborted.reason === "http_close_timeout" && ex.code === 1,
      "M1-13 HTTP 未收敛时仅走兜底路径：shutdown_aborted / exit 1", "reason=" + (aborted && aborted.reason));
    check(!!skipped && dbClosed.length === 0,
      "M1-13b 兜底路径明确记录 db_close_skipped，绝不提前关闭数据库");
    cleanupDb(h.dbPath);
  }

  /* C9：draining 期间新业务请求被拒绝 */
  {
    const h = await spawnChild({ scenario: "normal", taskMs: 1600, tasks: 1,
      httpGraceMs: 3000, bgDrainMs: 6000, totalGraceMs: 20000, delayCloseMs: 600 });
    await fetch("http://127.0.0.1:" + h.port + "/trigger");
    h.child.kill("SIGTERM");
    await sleep(120);
    let code = 0, text = "";
    try {
      const r = await fetch("http://127.0.0.1:" + h.port + "/stats");
      code = r.status; text = await r.text();
    } catch (_) { code = -1; }
    await waitExit(h);
    check(code === 503 && text.indexOf("shutting down") !== -1,
      "M1-14 draining 状态拒绝新业务请求（handler 503 shutting down）", "status=" + code);
    cleanupDb(h.dbPath);
  }

  console.log("\n===== 结果：" + pass + " 通过，" + fail + " 失败 =====");
  if (fail) console.log("失败项：\n - " + failed.join("\n - "));
  process.exit(fail ? 1 : 0);
}

if (process.argv.indexOf("--child") !== -1) {
  childMain().catch(function (e) { console.error("M1 child fatal:", e); process.exit(2); });
} else {
  testMain().catch(function (e) { console.error("M1 test fatal:", e); process.exit(2); });
}
