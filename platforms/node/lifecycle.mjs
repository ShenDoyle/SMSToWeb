/**
 * SMSToWeb — Node 平台「后台任务登记 + 优雅停机」生命周期（M-1 / R3-01）
 *
 * 仅被 platforms/node/server.mjs 引用；不参与 platforms/gen_app.py 的跨平台同步，
 * 不改变 src/worker.js 的 bgRun 语义，也不扩散到 Cloudflare / EdgeOne / Vercel /
 * Netlify / Deno 等由平台运行时托管 waitUntil 的入口。
 *
 * 设计要点：
 *  ① waitUntil(p) 只「登记并观察」，同步返回，绝不 await，因此不阻塞 HTTP 响应；
 *  ② 每个任务有 id / registeredAt / state / outcome，成功、失败、超时都会结束登记并
 *     从集合移除（Map 删除 + WeakSet 去重），不会持续增长；
 *  ③ 所有 rejection 都被 then(_, onRejected) 接住，不产生未处理 Promise rejection；
 *  ④ 超时任务记为 background_task_timeout（error），绝不记为 background_task_completed；
 *  ⑤ 停机顺序：draining → 拒绝新请求 → 等在途 HTTP → 有界 drain 后台任务 → 关 SQLite
 *     → 日志 → exit(0)；任何兜底/异常路径都不提前关 DB，并明确记录 db_close_skipped；
 *  ⑥ 重复 SIGTERM/SIGINT 由状态机幂等拦截，不重复 close / drain / exit。
 *
 * 时间预算来源见 deriveShutdownBudgets()：与 src/worker.js 的
 * NOTIFY_RETRY_MAX(3) / postNotify 单次 10s 超时 / handleWait 25s clamp 对齐。
 */

/* ---- 与业务核心对齐的常量（src/worker.js:668 / :579 / :2039） ---- */
export const NOTIFY_RETRY_MAX = 3;
export const NOTIFY_CHANNEL_TIMEOUT_MS = 10000;
export const MAX_TOTAL_GRACE_MS = 120000;

/**
 * 推导四层预算（纯函数，便于独立测试）：
 *  · HTTP 请求等待预算     = WAIT_MAX_SECONDS×1000 + 5s（长轮询自然返回 + 响应写出余量）
 *  · 后台任务 drain 预算   = (NOTIFY_RETRY_MAX+1)×10s + 5s = 45s（渠道串行重试最坏 40s）
 *  · 应用整体停机宽限      = HTTP 预算 + drain 预算 + 5s 收尾（默认 80s），
 *                            可被 SHUTDOWN_GRACE_MS 调大，上限 120s，但绝不低于推导值
 *  · 容器停止宽限          = 应用宽限 + 10s（由部署方配置，见 recommendedContainerGraceSeconds）
 * 注意：多目标与多渠道在 dispatchNotify 中是 Promise.all 并行，最坏耗时取 max，不相乘。
 */
export function deriveShutdownBudgets(env) {
  const e = env || {};
  /* 与 src/worker.js:2039 及旧 server.mjs 完全相同的 3..25s clamp */
  const waitMaxSeconds = Math.min(25, Math.max(3, parseInt(e.WAIT_MAX_SECONDS, 10) || 25));
  const HTTP_MARGIN_MS = 5000;
  const BG_MARGIN_MS = 5000;
  const FINAL_MARGIN_MS = 5000;
  const httpGraceMs = waitMaxSeconds * 1000 + HTTP_MARGIN_MS;
  const bgWorstMs = (NOTIFY_RETRY_MAX + 1) * NOTIFY_CHANNEL_TIMEOUT_MS;
  const bgDrainMs = bgWorstMs + BG_MARGIN_MS;
  const derivedTotalMs = httpGraceMs + bgDrainMs + FINAL_MARGIN_MS;
  /* 沿用 R2 语义：允许部署方调大，但禁止低于推导值；上限 120s 防误配 */
  const envTotalMs = Math.min(MAX_TOTAL_GRACE_MS, parseInt(e.SHUTDOWN_GRACE_MS, 10) || 0);
  const totalGraceMs = Math.max(derivedTotalMs, envTotalMs);
  return {
    waitMaxSeconds: waitMaxSeconds,
    httpGraceMs: httpGraceMs,
    bgWorstMs: bgWorstMs,
    bgDrainMs: bgDrainMs,
    derivedTotalMs: derivedTotalMs,
    totalGraceMs: totalGraceMs,
    maxTotalMs: MAX_TOTAL_GRACE_MS,
    containerMarginMs: 10000,
    recommendedContainerGraceSeconds: Math.ceil((totalGraceMs + 10000) / 1000),
  };
}

/* 默认结构化日志：单行 JSON，只记录任务 id / 耗时 / 数量 / 信号名等业务无关字段 */
export function defaultLifecycleLog(level, event, fields) {
  let line;
  try {
    line = JSON.stringify(Object.assign({
      ts: new Date().toISOString(),
      level: String(level || "info"),
      event: String(event || "-"),
      platform: "node",
    }, fields || {}));
  } catch (_) {
    line = JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "lifecycle_log_serialize_failed", platform: "node" });
  }
  try {
    if (level === "error") console.error(line);
    else console.log(line);
  } catch (_) { /* 日志输出失败绝不影响停机流程 */ }
}

function safeMsg(e) {
  try { return String((e && e.message) || e || "unknown").slice(0, 200); } catch (_) { return "unknown"; }
}

/**
 * 后台任务登记表。
 * waitUntil 的调用方是 src/worker.js bgRun，传入的是「已被 .catch 包装」的 Promise，
 * 业务失败由 bgRun 的 logEvent("background_task_failed") 记录；本登记表负责的是
 * 生命周期（pending → done/timeout）与停机可见性，二者互不替代、互不改变。
 */
export function createBackgroundTaskRegistry(opts) {
  const o = opts || {};
  const log = typeof o.log === "function" ? o.log : defaultLifecycleLog;
  const now = typeof o.now === "function" ? o.now : function () { return Date.now(); };
  const tasks = new Map();       /* id → record；结束后立即 delete */
  const seen = new WeakSet();    /* Promise 对象去重；不阻止 GC */
  let seq = 0;
  let completed = 0, rejected = 0, timedOut = 0, duplicates = 0;

  function emit(level, event, fields) { try { log(level, event, fields); } catch (_) {} }

  /* 任务自然结束：只有 pending 才能转为 done；超时任务不会再被记为成功 */
  function finish(rec, outcome, err) {
    if (!rec || rec.state !== "pending") {
      if (rec && rec.state === "timed_out") {
        emit("warn", "background_task_late_settled", { task: rec.id, note: "任务在超时后才结束，仍不记为成功" });
      }
      return;
    }
    rec.state = "done";
    rec.outcome = outcome;
    rec.finishedAt = now();
    tasks.delete(rec.id);
    if (outcome === "rejected") {
      rejected++;
      emit("error", "background_task_rejected", {
        task: rec.id, elapsed_ms: rec.finishedAt - rec.registeredAt, message: safeMsg(err), pending: tasks.size,
      });
    } else {
      completed++;
      emit("info", "background_task_completed", {
        task: rec.id, elapsed_ms: rec.finishedAt - rec.registeredAt, pending: tasks.size,
      });
    }
    try { if (typeof o.onSettled === "function") o.onSettled(rec); } catch (_) {}
  }

  /* 明确放弃：绝不记成功；同时保留观察链，避免迟到的 rejection 变成未处理 rejection */
  function abandon(rec, reason) {
    if (!rec || rec.state !== "pending") return false;
    rec.state = "timed_out";
    rec.outcome = "timeout";
    rec.finishedAt = now();
    tasks.delete(rec.id);
    timedOut++;
    emit("error", "background_task_timeout", {
      task: rec.id,
      elapsed_ms: rec.finishedAt - rec.registeredAt,
      reason: String(reason || "deadline_exceeded"),
      note: "后台任务未能在停机窗口内完成，通知可能未送达；不计为成功",
      pending: tasks.size,
    });
    return true;
  }

  /**
   * 登记（不执行、不等待、不阻塞）。
   * 关键：函数体全程同步，末尾不返回 Promise，调用方无从 await。
   */
  function waitUntil(p) {
    if (p && (typeof p === "object" || typeof p === "function") && seen.has(p)) {
      duplicates++;
      emit("warn", "background_task_duplicate_ignored", { note: "同一 Promise 重复登记已忽略，任务不会重复执行", pending: tasks.size });
      return;
    }
    if (p && (typeof p === "object" || typeof p === "function")) seen.add(p);
    const id = "bg-" + (++seq);
    const rec = { id: id, promise: p, registeredAt: now(), state: "pending", outcome: null, finishedAt: null };
    tasks.set(id, rec);
    emit("info", "background_task_registered", { task: id, pending: tasks.size });
    /* 只接观察链，不重新执行任务；两个分支都提供，杜绝未处理 rejection */
    Promise.resolve(p).then(
      function () { finish(rec, "resolved"); },
      function (e) { finish(rec, "rejected", e); }
    );
  }

  /* 有界等待：直到集合为空或到达绝对截止时间；期间新登记的任务也会纳入 */
  async function drain(dopts) {
    const d = dopts || {};
    const logFn = typeof d.log === "function" ? d.log : log;
    const nowFn = typeof d.now === "function" ? d.now : now;
    const deadlineAt = d.deadlineAt == null ? nowFn() + 45000 : d.deadlineAt;
    const t0 = nowFn();
    const c0 = completed, r0 = rejected;
    while (tasks.size > 0) {
      const remaining = deadlineAt - nowFn();
      if (remaining <= 0) break;
      const current = Array.from(tasks.values());
      const all = Promise.all(current.map(function (rec) {
        return Promise.resolve(rec.promise).catch(function () {});
      }));
      let timer = null;
      const timerP = new Promise(function (resolve) { timer = setTimeout(resolve, remaining); });
      await Promise.race([all, timerP]);
      if (timer) clearTimeout(timer);
      /* 循环：若等待期间又有新任务登记，继续纳入；集合为空则退出 */
    }
    /* 截止时间到，剩余任务一律可观测地超时，不伪装成功 */
    const left = Array.from(tasks.values());
    for (const rec of left) abandon(rec, d.reason || "drain_deadline_exceeded");
    const res = {
      finished: (completed - c0) + (rejected - r0),
      timedOut: left.length,
      waitedMs: nowFn() - t0,
      /* 超时任务也已从登记集合移除，因此这里恒为 0；保留真实值供测试断言集合确已清空 */
      remaining: tasks.size,
    };
    try { logFn("info", "background_task_drain_finished", {
      waited_ms: res.waitedMs, finished: res.finished, timed_out: res.timedOut, remaining: res.remaining,
    }); } catch (_) {}
    return res;
  }

  function abandonAll(reason) {
    const left = Array.from(tasks.values());
    for (const rec of left) abandon(rec, reason || "shutdown_aborted");
    return left.length;
  }

  function snapshot() {
    return Array.from(tasks.values()).map(function (r) {
      return { id: r.id, state: r.state, outcome: r.outcome, registeredAt: r.registeredAt, elapsed_ms: now() - r.registeredAt };
    });
  }

  function stats() {
    return { pending: tasks.size, completed: completed, rejected: rejected, timedOut: timedOut, duplicates: duplicates };
  }

  return {
    waitUntil: waitUntil,
    drain: drain,
    abandonAll: abandonAll,
    snapshot: snapshot,
    stats: stats,
    size: function () { return tasks.size; },
  };
}

/* 等待 server.close 回调（全部在途 HTTP 结束）；超时返回 closed:false 由上层兜底 */
function waitHttpClose(server, budgetMs, ctx) {
  return new Promise(function (resolve) {
    const t0 = ctx.now();
    let settled = false;
    let timer = null;
    function done(closed, err) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) ctx.log("error", "http_close_error", { message: safeMsg(err) });
      resolve({ closed: !!closed, ms: ctx.now() - t0 });
    }
    try {
      server.close(function (err) { done(!err, err); });
    } catch (e) {
      ctx.log("error", "http_close_threw", { message: safeMsg(e) });
      done(false, e);
    }
    try {
      /* Node 18.2+：主动关闭空闲 keep-alive 连接，否则 server.close 要等 keep-alive 超时 */
      if (server && typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    } catch (_) {}
    timer = setTimeout(function () {
      ctx.log("error", "http_close_timeout", { budget_ms: budgetMs, note: "在途 HTTP 未在预算内结束，进入兜底路径" });
      done(false, new Error("http_close_timeout"));
    }, Math.max(1, budgetMs));
  });
}

/**
 * 停机协调器（状态机：running → draining → closed / aborted）。
 * 重复信号只记日志、不重复执行关闭流程；exit 可注入以便测试。
 */
export function createShutdownCoordinator(opts) {
  const o = opts || {};
  const log = typeof o.log === "function" ? o.log : defaultLifecycleLog;
  const now = typeof o.now === "function" ? o.now : function () { return Date.now(); };
  const exit = typeof o.exit === "function" ? o.exit : function (code) { process.exit(code); };
  const budgets = o.budgets || deriveShutdownBudgets({});
  const registry = o.registry;
  const server = o.server;
  const closeDb = typeof o.closeDb === "function" ? o.closeDb : function () { return true; };
  const onDraining = typeof o.onDraining === "function" ? o.onDraining : function () {};

  let state = "running";
  let signalCount = 0;
  let forceTimer = null;
  let runPromise = null;
  const stats = {
    firstSignal: null, signalCount: 0, httpClosed: false, httpCloseMs: null,
    bgFinished: 0, bgTimedOut: 0, dbClosed: false, dbCloseSkipped: false,
    forced: false, exitCode: null, totalMs: null, reason: null,
  };

  function emit(level, event, fields) { try { log(level, event, fields); } catch (_) {} }

  function getStats() {
    return Object.assign({}, stats, { state: state, signalCount: signalCount });
  }

  /* 兜底/异常路径：绝不提前关闭 DB（无法证明后台任务已停止访问），明确记录跳过 */
  function fatal(reason) {
    if (state === "closed" || state === "aborted") return getStats();
    state = "aborted";
    if (forceTimer) { clearTimeout(forceTimer); forceTimer = null; }
    const abandoned = registry ? registry.abandonAll(reason) : 0;
    stats.bgTimedOut += abandoned;
    stats.forced = true;
    stats.reason = reason;
    stats.dbCloseSkipped = true;
    stats.exitCode = 1;
    emit("error", "shutdown_aborted", { reason: reason, abandoned: abandoned, signal: stats.firstSignal });
    emit("warn", "db_close_skipped", { reason: "in-flight work not proven finished; refusing to close db early" });
    exit(1);
    return getStats();
  }

  function shutdown(signal) {
    signalCount++;
    stats.signalCount = signalCount;
    if (state !== "running") {
      emit("info", "shutdown_signal_ignored", {
        signal: String(signal), repeated: signalCount, state: state,
        note: "重复信号：不重复 close / drain / exit",
      });
      return runPromise || Promise.resolve(getStats());
    }
    state = "draining";
    stats.firstSignal = String(signal);
    const t0 = now();
    onDraining();
    emit("info", "shutdown_started", {
      signal: String(signal),
      wait_max_seconds: budgets.waitMaxSeconds,
      http_grace_ms: budgets.httpGraceMs,
      bg_worst_ms: budgets.bgWorstMs,
      bg_drain_ms: budgets.bgDrainMs,
      total_grace_ms: budgets.totalGraceMs,
      recommended_container_grace_s: budgets.recommendedContainerGraceSeconds,
    });

    /* 最终兜底：仅在正常流程无法完成时触发 */
    forceTimer = setTimeout(function () { fatal("total_grace_exceeded"); }, budgets.totalGraceMs);

    runPromise = (async function () {
      /* 1) 停止新连接（新业务请求由 server.mjs handler 依据 isDraining() 返回 503）
         2) 等待已经进入处理流程的 HTTP 请求结束 */
      const httpRes = await waitHttpClose(server, budgets.httpGraceMs, { now: now, log: log });
      stats.httpCloseMs = httpRes.ms;
      stats.httpClosed = httpRes.closed;
      emit("info", "http_drained", { closed: httpRes.closed, elapsed_ms: httpRes.ms });
      if (state === "aborted" || state === "closed") return getStats();
      if (!httpRes.closed) { fatal("http_close_timeout"); return getStats(); }

      /* 3) 有界等待已登记后台任务；4) 到点可观测超时，不记成功 */
      const drainRes = await (registry
        ? registry.drain({ deadlineAt: now() + budgets.bgDrainMs, now: now, log: log })
        : Promise.resolve({ finished: 0, timedOut: 0, waitedMs: 0 }));
      if (state === "aborted" || state === "closed") return getStats();
      stats.bgFinished = drainRes.finished;
      stats.bgTimedOut = drainRes.timedOut;
      if (drainRes.timedOut > 0) {
        emit("warn", "background_tasks_unfinished", {
          count: drainRes.timedOut, note: "通知可能未送达；已逐条记录 background_task_timeout，未记为成功",
        });
      }

      /* 5) 所有可等待任务结束后才关闭 SQLite */
      let dbOk = false;
      try { dbOk = !!closeDb(); }
      catch (e) { emit("error", "db_close_failed", { message: safeMsg(e) }); }
      stats.dbClosed = dbOk;
      if (!dbOk) emit("error", "db_close_failed_final", { note: "数据库关闭未成功，明确记录，不伪装成功" });

      /* 6) 完成日志并正常退出；兜底定时器只在此清除 */
      if (forceTimer) { clearTimeout(forceTimer); forceTimer = null; }
      stats.totalMs = now() - t0;
      state = "closed";
      stats.exitCode = 0;
      emit("info", "shutdown_complete", {
        http_close_ms: stats.httpCloseMs,
        bg_finished: stats.bgFinished,
        bg_timed_out: stats.bgTimedOut,
        db_closed: stats.dbClosed,
        total_ms: stats.totalMs,
        exit_code: 0,
      });
      exit(0);
      return getStats();
    })();
    return runPromise;
  }

  return {
    shutdown: shutdown,
    isDraining: function () { return state !== "running"; },
    getState: function () { return state; },
    getStats: getStats,
    getBudgets: function () { return Object.assign({}, budgets); },
  };
}
