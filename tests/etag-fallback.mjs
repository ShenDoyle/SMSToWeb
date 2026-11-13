/**
 * ETag / 304 缓存语义与 WebCrypto 降级路径测试（ENG-02-D F1 修复验证）
 *
 * 运行：node tests/etag-fallback.mjs   （退出码 0=全过，1=有失败）
 * 覆盖：正常 SHA-256 路径、304 零字节、WebCrypto 抛错降级仍有 ETag + 304、
 *       降级 warn 日志留痕、内容变化导致 ETag 变化、no-cache/Vary 不被破坏。
 */
import { fetchApp } from "../platforms/node/app.js";
import { LocalDatabase } from "../platforms/node/db.js";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB = join(tmpdir(), "smstoweb_etag_" + process.pid + ".db");
let pass = 0, fail = 0;
const failed = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; failed.push(name); console.log("  FAIL " + name + (detail ? " :: " + detail : "")); }
}
function env(extra) {
  return Object.assign({ DB: db, RECEIVE_TOKEN: "tok", ENABLE_AUTH: "true", ADMIN_PASSWORD: "secret", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30", PLATFORM: "test" }, extra || {});
}
function req(headers) {
  return new Request("http://localhost/", { headers: headers || {} });
}
const db = new LocalDatabase(DB);

async function probe(e) {
  const r1 = await fetchApp(req(), e);
  const etag = r1.headers.get("etag") || "";
  const html = await r1.text();
  const r2 = etag ? await fetchApp(req({ "If-None-Match": etag }), e) : null;
  const r2body = r2 ? await r2.text() : "";
  return {
    etag, html,
    cc: r1.headers.get("cache-control") || "",
    vary: r1.headers.get("vary") || "",
    status2: r2 ? r2.status : 0,
    body2: r2body,
  };
}

async function main() {
  /* A. 正常路径：WebCrypto 可用 */
  const normal = await probe(env());
  check("A1 正常路径返回 ETag（SHA-256 前 16 字节 = 32 hex）", /^"[0-9a-f]{32}"$/.test(normal.etag), normal.etag);
  check("A2 If-None-Match 命中 → 304", normal.status2 === 304, "status=" + normal.status2);
  check("A3 304 响应正文 0 字节", normal.body2.length === 0, "len=" + normal.body2.length);
  check("A4 no-cache + Vary: Cookie 保持", normal.cc === "no-cache" && /cookie/i.test(normal.vary), normal.cc + " / " + normal.vary);

  /* B. 降级路径：模拟平台 WebCrypto 不可用（CF F1 场景） */
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const realWarn = console.warn;
  const warnings = [];
  try {
    Object.defineProperty(globalThis, "crypto", {
      value: { subtle: { digest: async () => { throw new Error("simulated WebCrypto failure"); } } },
      configurable: true, writable: true,
    });
    console.warn = (line) => { warnings.push(String(line)); };
    const fallback = await probe(env());
    check("B1 WebCrypto 抛错时仍返回 ETag（降级 64 位 = 16 hex）", /^"[0-9a-f]{16}"$/.test(fallback.etag), fallback.etag);
    check("B2 降级路径 304 可用", fallback.status2 === 304, "status=" + fallback.status2);
    check("B3 降级路径 304 正文 0 字节", fallback.body2.length === 0, "len=" + fallback.body2.length);
    check("B4 降级路径 no-cache + Vary 保持", fallback.cc === "no-cache" && /cookie/i.test(fallback.vary), fallback.cc + " / " + fallback.vary);
    const warnLine = warnings.find((w) => w.includes("etag_digest_fallback")) || "";
    check("B5 降级输出结构化 warn 日志", warnLine.length > 0);
    check("B6 日志含 error 详情且平台标记正确", warnLine.includes("simulated WebCrypto failure") && warnLine.includes('"platform":"test"'));
    check("B7 降级 ETag 与正常路径不同（算法切换可辨识）", fallback.etag !== normal.etag, normal.etag + " vs " + fallback.etag);
  } finally {
    console.warn = realWarn;
    if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
  }

  /* C. 内容变化 → ETag 变化（站点名属于渲染后 HTML） */
  const other = await probe(env({ SITE_NAME: "另一个站点" }));
  check("C1 站点名变化 → ETag 变化", other.etag !== normal.etag && other.html !== normal.html);
  check("C2 变化后条件请求仍 304（同一指纹自洽）", other.status2 === 304, "status=" + other.status2);

  console.log("\n===== 结果：" + pass + " 通过，" + fail + " 失败 =====");
  if (fail) console.log("失败项：\n - " + failed.join("\n - "));
  try { db.sqlite.close(); } catch (_) {}
  for (const suf of ["", "-wal", "-shm", "-journal"]) { try { rmSync(DB + suf, { force: true }); } catch (_) {} }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("测试异常：", e);
  try { db.sqlite.close(); } catch (_) {}
  for (const suf of ["", "-wal", "-shm", "-journal"]) { try { rmSync(DB + suf, { force: true }); } catch (_) {} }
  process.exit(2);
});
