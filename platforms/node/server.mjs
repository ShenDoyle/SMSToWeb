/**
 * SMSToWeb — Node.js 自托管入口（Node 18+，零 npm 依赖）
 * 适用：Fly.io / Railway / 任意 VPS / 本地调试。
 * 本目录自包含：app.js（核心应用）与 db.js（数据库适配层）均为本目录内独立副本，
 * 配合同目录 Dockerfile 可直接部署（见 platforms/README.md「Fly.io / Railway」）。
 *   Turso 模式：TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... RECEIVE_TOKEN=... node server.mjs
 *   本地 SQLite 模式（免外部数据库，需 Node 22.13+）：
 *     SQLITE_PATH=./data.db RECEIVE_TOKEN=... node server.mjs
 *
 * 说明：
 *  - 内置每日清理：UTC 17:00（北京 01:00）自动执行；
 *  - 也可用平台调度器（Fly Machines Cron / Railway Cron）
 *    GET /api/cron?token=<RECEIVE_TOKEN>。
 */
import http from "node:http";
import { Readable } from "node:stream";
import { fetchApp, runCron, handleCronRequest } from "./app.js";
import { createDb } from "./db.js";
import { createBackgroundTaskRegistry, createShutdownCoordinator, deriveShutdownBudgets, defaultLifecycleLog } from "./lifecycle.mjs";

let cachedDb = null;

/* ==== ENV_KEYS BEGIN（由 platforms/gen_app.py 同步，勿手工修改）==== */
const ENV_KEYS = [
  "RECEIVE_TOKEN",
  "DISABLE_RECEIVE_TOKEN",
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
];
/* ==== ENV_KEYS END ==== */

/* 环境变量 → 核心应用 env 对象（白名单循环透传；数据库实例在进程内缓存复用） */
function buildEnv() {
  if (!cachedDb) {
    cachedDb = createDb({
      SQLITE_PATH: process.env.SQLITE_PATH || "",
      TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL || "",
      TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN || "",
    });
  }
  const env = { DB: cachedDb };
  for (const k of ENV_KEYS) env[k] = process.env[k] || "";
  env.PLATFORM = "node"; /* 日志 platform 字段标识（非环境变量，不走白名单） */
  return env;
}

/* Node IncomingMessage → Web Request（零依赖转换） */
function toWebRequest(req) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else if (v != null) {
      headers.set(k, v);
    }
  }
  const method = (req.method || "GET").toUpperCase();
  const host = req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || "http";
  const init = { method: method, headers: headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  return new Request(proto + "://" + host + req.url, init);
}

/* Web Response → Node res（本项目响应体均为小型文本，整体缓冲写入） */
async function writeResponse(res, resp) {
  const headers = {};
  for (const [k, v] of resp.headers) headers[k] = v;
  res.writeHead(resp.status, headers);
  const buf = await resp.arrayBuffer();
  res.end(Buffer.from(buf));
}

const PORT = parseInt(process.env.PORT || "8787", 10);

/* ---------------- 停机时间预算（R1-01 + M-1 / R3-01） ----------------
   四层预算，逐层包含，绝不允许倒挂（详见 lifecycle.mjs deriveShutdownBudgets）：
     ① HTTP 请求等待预算   = WAIT_MAX_SECONDS×1000 + 5s（默认 30s）
        —— /api/wait 与 src/worker.js handleWait 用同样的 3..25s clamp；server.close
           只有在全部在途请求（含 25s 长轮询）结束后才回调。
     ② 后台任务 drain 预算 = (NOTIFY_RETRY_MAX+1)×10s + 5s = 45s
        —— dispatchNotify 多目标/多渠道是 Promise.all 并行（取 max，不相乘），
           但单渠道重试是串行 for+await，每次 fetch 独立 AbortSignal.timeout(10s)，
           retry=3 时最坏 4×10s=40s；任务自身没有统一截止时间。
     ③ 应用整体停机宽限   = ① + ② + 5s 收尾 = 80s（SHUTDOWN_GRACE_MS 只可调大，
        上限 120s，绝不允许低于推导值）；这也是 forceTimer 的唯一触发点。
     ④ 容器停止宽限       = ③ + 10s = 90s，必须由部署方配置（见下方说明）。
   ⚠ 120s 上限足以覆盖 80s 推导值；但旧默认值 30s 与 docker stop 默认 10s
     都不足以覆盖 40s 的后台通知最坏耗时，属 R3-01 必须修正项。 */
const BUDGETS = deriveShutdownBudgets(process.env);
const WAIT_MAX_SECONDS = BUDGETS.waitMaxSeconds;
const SHUTDOWN_GRACE_MS = BUDGETS.totalGraceMs;

/* M-1：后台任务登记表。waitUntil 只登记、不等待、不阻塞 HTTP 响应；
   任务成功 / 失败 / 超时都会结束登记并从集合移除。
   src/worker.js bgRun 传入的是已 .catch 包装的 Promise，业务异常仍由
   bgRun 的 logEvent("background_task_failed") 记录，此处只负责生命周期。 */
const bgTasks = createBackgroundTaskRegistry({ log: defaultLifecycleLog });
const bgCtx = {
  waitUntil: function (p) { bgTasks.waitUntil(p); },
};
/* draining 标志：信号到达后 handler 立即拒绝新业务请求（503），
   不影响已进入处理流程的在途请求（由 server.close 等待其结束）。 */
let draining = false;

const server = http.createServer(async function (req, res) {
  /* M-1 停机顺序 ②：进入 draining 后拒绝新业务请求，避免停机窗口内再产生
     新的后台通知/DB 访问；已在途请求不受影响，由 server.close 等待其结束。 */
  if (draining) {
    if (!res.headersSent) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Connection": "close" });
    }
    res.end(JSON.stringify({ success: false, error: "shutting down" }));
    return;
  }
  try {
    const webReq = toWebRequest(req);
    const url = new URL(webReq.url);
    const env = buildEnv();
    const resp = url.pathname.replace(/\/+$/, "") === "/api/cron"
      ? await handleCronRequest(webReq, env)
      : await fetchApp(webReq, env, bgCtx);
    await writeResponse(res, resp);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ success: false, error: "internal error: " + (e && e.message) }));
  }
});

server.listen(PORT, function () {
  console.log("SMSToWeb node server listening on :" + PORT);
  console.log("SMSToWeb wait_max=" + WAIT_MAX_SECONDS + "s shutdown_grace=" +
    (SHUTDOWN_GRACE_MS / 1000) + "s (container stop grace must be >= this)");
  console.log("SMSToWeb budgets http=" + (BUDGETS.httpGraceMs / 1000) + "s bg_worst=" +
    (BUDGETS.bgWorstMs / 1000) + "s bg_drain=" + (BUDGETS.bgDrainMs / 1000) +
    "s total=" + (BUDGETS.totalGraceMs / 1000) + "s container>=" +
    BUDGETS.recommendedContainerGraceSeconds + "s");
});

/* ---------------- 内置每日清理（UTC 17:00 = 北京 01:00，与 Worker 版 cron 一致） ---------------- */

let lastCronDay = "";
setInterval(function () {
  const d = new Date();
  if (d.getUTCHours() === 17 && d.getUTCMinutes() === 0) {
    const day = d.toISOString().slice(0, 10);
    if (day !== lastCronDay) {
      lastCronDay = day;
      runCron(buildEnv()).catch(function (e) {
        console.error("cron cleanup failed:", e && e.message);
      });
    }
  }
}, 30 * 1000).unref();

/* ---------------- 优雅关闭（M-1 / R3-01；Docker / systemd / Fly.io / Railway 停机均发 SIGTERM） ----------------
   R3-01 修复：旧实现中 bgCtx.waitUntil 只 .catch 而不登记，server.close 回调里立即
   closeLocalDb() + process.exit(0)，停机时未完成的后台通知被静默丢弃；且后台任务体的
   loadNotifyRows 可能访问已关闭的 SQLite（被 catch→return null 静默降级）。现改为：

     ① draining：handler 拒绝新业务请求（503），server.close 停止新连接并关闭空闲 keep-alive
     ② 等 server.close 回调 —— 全部在途 HTTP（含默认 25s 长轮询）结束后才继续
     ③ 有界等待 bgTasks 中所有已登记后台任务（默认 45s；并发任务全部等待）
     ④ 到点仍有任务 → 逐条记 background_task_timeout，明确「通知可能未送达」，绝不记成功
     ⑤ 所有可等待任务结束后才关闭 SQLite（LocalDatabase.close() 置 _closed，fail-fast 生效）
     ⑥ 记 shutdown_complete → exit(0)
     ⑦ 仅当上述流程卡住（HTTP 未收敛 / 总宽限耗尽）才走兜底：不关 DB、记
        db_close_skipped 与 shutdown_aborted → exit(1)，绝不提前关闭仍有任务访问的 DB
   重复 SIGTERM/SIGINT 由 coordinator 状态机幂等拦截，不重复 close / drain / exit。

   ⚠ 容器/进程管理器必须配套，本仓库无法自行保证（M-3 仍待部署方落实）：
     · docker stop 默认宽限仅 10s，会先于应用宽限 SIGKILL；
     · 部署时须设置「容器停止宽限 >= 应用整体宽限 + 10s」，当前默认推导为 90s：
         docker run --stop-timeout=90 ...        /  docker stop --timeout 90 <container>
         compose: services.<svc>.stop_grace_period: 90s
         systemd unit: TimeoutStopSec=90s
     · 若把 SHUTDOWN_GRACE_MS 调大（上限 120s），容器宽限须同步 >= 该值 + 10s；
       Dockerfile 的 STOPSIGNAL 只能改信号类型、不能改宽限。

   Cloudflare / EdgeOne / Vercel / Netlify / Deno 的 waitUntil 由各自平台运行时托管，
   本文件的登记/停机机制只在 Node 自托管入口生效，未改变任何其他平台的后台语义。 */
function closeLocalDb() {
  try {
    /* Turso 模式为无状态 HTTP 适配层（无 close 方法），无需关闭 */
    if (!cachedDb) return true;
    if (typeof cachedDb.close !== "function") {
      console.log("SMSToWeb db close skipped (remote/no local sqlite)");
      return true;
    }
    const ok = cachedDb.close();
    console.log("SMSToWeb local sqlite closed");
    if (!ok) console.error("SMSToWeb db close failed: close() returned false");
    return ok;
  } catch (e) {
    /* 关闭失败明确记录，不伪装成功 */
    console.error("SMSToWeb db close failed:", e && e.message);
    return false;
  }
}

function nodeLifecycleLog(level, event, fields) {
  defaultLifecycleLog(level, event, fields);
  /* 兼容既有运维/验证脚本的人类可读标记行（结构化事件仍为唯一事实源） */
  try {
    if (event === "shutdown_started") {
      console.log("SMSToWeb received " + (fields && fields.signal) + ", shutting down gracefully (grace=" +
        (SHUTDOWN_GRACE_MS / 1000) + "s, wait_max=" + WAIT_MAX_SECONDS + "s)");
    } else if (event === "shutdown_complete") {
      console.log("SMSToWeb shutdown complete");
    }
  } catch (_) {}
}

const coordinator = createShutdownCoordinator({
  server: server,
  registry: bgTasks,
  budgets: BUDGETS,
  closeDb: closeLocalDb,
  log: nodeLifecycleLog,
  onDraining: function () { draining = true; },
});
process.on("SIGTERM", function () { coordinator.shutdown("SIGTERM"); });
process.on("SIGINT", function () { coordinator.shutdown("SIGINT"); });
