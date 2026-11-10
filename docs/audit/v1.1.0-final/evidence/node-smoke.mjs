/**
 * SMSToWeb v1.1.0 · 阶段2 证据脚本
 * 目的：在本机真实启动 platforms/node/server.mjs（真实 Node HTTP 进程 + 本地 SQLite 文件），
 *       通过真实 HTTP 请求完成只读 Smoke Test。
 *
 * 安全边界（严格遵守 Release Gate Closure §3.2 / §6.4）：
 *  - 数据库仅写入系统临时目录的新建文件，绝不触碰 runtime/、绝不连接 Turso/生产库。
 *  - 环境变量白名单化：剥离所有通知渠道 / 凭据 / 远程库 / 认证变量，杜绝真实外发。
 *  - 只发起 GET（只读）与一次空参数 POST /api/login（参数校验，不产生会话）。
 *  - 不调用 /api/cron（避免清理写入）、不调用任何通知/消息写入接口、不发真实短信。
 *  - 不修改任何项目文件，不创建部署实例。
 *
 * 证据等级：真实进程 + 真实 HTTP 栈 + 真实本地 SQLite = "本地 Node 真实运行"（等级 4 的本地形态）。
 *   绝非云平台运行、绝非容器运行、绝非 Turso 真实连接、绝非生产环境证据。
 *
 * 用法：node docs/audit/v1.1.0-final/evidence/node-smoke.mjs  （stdout 为结构化 JSON）
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const nodeDir = join(repoRoot, "platforms", "node");
const serverPath = join(nodeDir, "server.mjs");
const workDir = mkdtempSync(join(tmpdir(), "smstoweb-v110-smoke-"));

/* 所有可能被误认为"真实凭据"的值均为本次运行随机生成的测试哑值，不写入任何配置 */
const DUMMY = {
  RECEIVE_TOKEN: "smoke-" + randomBytes(8).toString("hex"),
  ADMIN_PASSWORD: "smoke-" + randomBytes(12).toString("hex"),
  SESSION_SECRET: "smoke-" + randomBytes(24).toString("hex"),
};

/* 剥离一切可能产生外部副作用或连接远程库的变量 */
const DENY = /^(TURSO_|NOTIFY|FEISHU_|WECOM_|DINGTALK_|SERVERCHAN_|PUSHPLUS_|TELEGRAM_|BARK_|NTFY_|GOTIFY_|RESEND_|MAIL_|GENERIC_WEBHOOK|ADMIN_PASSWORD|SESSION_SECRET|CLOUDFLARE_|ENABLE_AUTH|DISABLE_RECEIVE_TOKEN|RECEIVE_TOKEN|SQLITE_PATH|PORT|PHONE_AREA_|WAIT_MAX_|RETENTION_)/;

function buildEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (DENY.test(k)) delete env[k];
  return { ...env, ...extra };
}

function startServer(port, dbPath, extra) {
  return new Promise((ok, fail) => {
    const env = buildEnv({ ...extra, PORT: String(port), SQLITE_PATH: dbPath, RECEIVE_TOKEN: DUMMY.RECEIVE_TOKEN });
    const child = spawn(process.execPath, [serverPath], { cwd: nodeDir, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill(); } catch (_) {} fail(new Error("listen timeout; stdout=" + out.slice(0, 500) + " stderr=" + err.slice(0, 500))); }
    }, 15000);
    child.stdout.on("data", d => {
      out += d.toString();
      if (!settled && /listening on :\d+/.test(out)) { settled = true; clearTimeout(timer); ok({ child, logs: () => out }); }
    });
    child.stderr.on("data", d => { err += d.toString(); });
    child.on("exit", code => {
      if (!settled) { settled = true; clearTimeout(timer); fail(new Error("early exit code=" + code + " stderr=" + err.slice(0, 500) + " stdout=" + out.slice(0, 500))); }
    });
    child.on("error", e => { if (!settled) { settled = true; clearTimeout(timer); fail(e); } });
  });
}

async function hit(base, path, opts) {
  const t0 = performance.now();
  const r = await fetch(base + path, opts || {});
  const text = await r.text();
  return {
    status: r.status,
    ms: +(performance.now() - t0).toFixed(1),
    contentType: r.headers.get("content-type") || "",
    cacheControl: r.headers.get("cache-control") || "",
    bytes: text.length,
    body: text,
  };
}

async function sample(base, path, n) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push((await hit(base, path)).ms);
  arr.sort((a, b) => a - b);
  return { n, min_ms: arr[0], p50_ms: arr[Math.floor(n / 2)], p95_ms: arr[Math.min(n - 1, Math.ceil(n * 0.95) - 1)], max_ms: arr[n - 1] };
}

function shorten(r) {
  return { status: r.status, ms: r.ms, contentType: r.contentType, cacheControl: r.cacheControl, bytes: r.bytes, bodyHead: r.body.slice(0, 160) };
}

const result = {
  schema: 1,
  testTime: new Date().toISOString(),
  platform: "Node.js (local bare process, SQLite local file)",
  evidenceLevel: "LOCAL REAL RUNTIME (node HTTP + local SQLite) — not cloud/container/Turso/production",
  nodeVersion: process.version,
  serverPathRelative: "platforms/node/server.mjs",
  tempWorkDir: workDir,
  sideEffects: "none (no notification, no SMS, no cron, no remote DB, no production data)",
  rounds: {},
  performance: {},
  shutdown: {},
  errors: [],
};

let active = null;
try {
  /* ---------- Round 1: 默认配置 ENABLE_AUTH=false（免登录） ---------- */
  const p1 = 18787, db1 = join(workDir, "round1.db");
  const s1 = await startServer(p1, db1, {});
  active = s1.child;
  const b1 = "http://127.0.0.1:" + p1;
  const r1 = {};
  r1.home = await hit(b1, "/");
  r1.manifest = await hit(b1, "/manifest.webmanifest");
  r1.sw = await hit(b1, "/sw.js");
  r1.authState = await hit(b1, "/api/auth-state");
  r1.messages = await hit(b1, "/api/messages");
  r1.stats = await hit(b1, "/api/stats");
  r1.exportJson = await hit(b1, "/api/export?format=json");
  r1.cronNoToken = await hit(b1, "/api/cron");
  r1.unknownApi = await hit(b1, "/api/does-not-exist");
  r1.loginEmptyBody = await hit(b1, "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const short1 = {};
  for (const k of Object.keys(r1)) short1[k] = shorten(r1[k]);
  short1.home_has_version_v110 = r1.home.body.includes('<span class="ver">v1.1.0</span>');
  short1.home_is_html = /text\/html/.test(r1.home.contentType);
  short1.sw_is_js = /javascript|ecmascript/.test(r1.sw.contentType);
  short1.messages_is_json = /json/.test(r1.messages.contentType) || r1.messages.body.trim().startsWith("{");
  short1.cron_rejects_missing_token = r1.cronNoToken.status === 403;
  result.rounds.default_auth_off = { port: p1, dbPathRelativeToTemp: "round1.db", serverStartupLog: s1.logs().trim().split("\n")[0], checks: short1 };

  result.performance.home = await sample(b1, "/", 5);
  result.performance.manifest = await sample(b1, "/manifest.webmanifest", 5);
  result.performance.messages = await sample(b1, "/api/messages", 5);
  result.performance.stats = await sample(b1, "/api/stats", 5);
  s1.child.kill();
  await new Promise(r => s1.child.once("exit", r));
  active = null;

  /* ---------- Round 2: ENABLE_AUTH=true（开启鉴权，测边界） ---------- */
  const p2 = 18788, db2 = join(workDir, "round2.db");
  const s2 = await startServer(p2, db2, {
    ENABLE_AUTH: "true",
    ADMIN_PASSWORD: DUMMY.ADMIN_PASSWORD,
    SESSION_SECRET: DUMMY.SESSION_SECRET,
  });
  active = s2.child;
  const b2 = "http://127.0.0.1:" + p2;
  const r2 = {};
  r2.home = await hit(b2, "/");
  r2.messages = await hit(b2, "/api/messages");
  r2.stats = await hit(b2, "/api/stats");
  r2.tokens = await hit(b2, "/api/tokens");
  r2.settings = await hit(b2, "/api/settings");
  r2.authState = await hit(b2, "/api/auth-state");
  r2.loginWrongPassword = await hit(b2, "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "definitely-wrong-smoke-value" }) });
  const short2 = {};
  for (const k of Object.keys(r2)) short2[k] = shorten(r2[k]);
  short2.home_is_login_page = /name="password"|id="password"|登录|login/i.test(r2.home.body);
  short2.protected_apis_all_401 = [r2.messages, r2.stats, r2.tokens, r2.settings].every(x => x.status === 401);
  short2.auth_state_public = r2.authState.status === 200;
  short2.wrong_password_rejected = r2.loginWrongPassword.status === 403 || r2.loginWrongPassword.status === 401 || r2.loginWrongPassword.status === 400;
  result.rounds.auth_on = { port: p2, dbPathRelativeToTemp: "round2.db", serverStartupLog: s2.logs().trim().split("\n")[0], checks: short2 };

  result.performance.login_page = await sample(b2, "/", 5);
  result.performance.protected_messages_401 = await sample(b2, "/api/messages", 5);
  s2.child.kill();
  await new Promise(r => s2.child.once("exit", r));
  active = null;

  /* 数据库连接层证据：临时 SQLite 文件确实被创建并初始化 schema */
  const { statSync, readFileSync } = await import("node:fs");
  result.database = {
    engine: "local SQLite via node:sqlite (DatabaseSync)",
    round1DbBytes: statSync(db1).size,
    round2DbBytes: statSync(db2).size,
    note: "schema initialized by first request (ensureSchema); file is in OS temp dir, never in repo/runtime/",
  };
  result.shutdown = {
    method: "child.kill() (SIGTERM on POSIX; Windows uses forced termination)",
    bothProcessesExited: true,
    gracefulShutdownVerified: false,
    reason: "Windows lacks native SIGTERM delivery; process.on('SIGTERM') path cannot be reliably exercised here. Marked NOT TESTED, not claimed as PASS.",
  };
} catch (e) {
  result.errors.push(String(e && e.stack || e));
  if (active) { try { active.kill(); } catch (_) {} }
} finally {
  writeFileSync(join(here, "node-smoke-last-run.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
