/**
 * FEAD-SEC-01 · 通知目标敏感字段保存链路安全测试（零依赖，Node 22.13+）
 *
 * 覆盖：三态语义（keep / set / clear）、字段级合并、revision 原子性、
 *       API 回读与错误响应脱敏、日志脱敏、通知发送实际读取新凭据、旧请求兼容。
 *
 * 隔离要求：
 *   - 独立 SQLite 文件（本进程 PID 命名，结束后清理）
 *   - 通知出站全部指向 127.0.0.1 本地 Mock，禁止触达任何真实服务
 *   - 测试凭据为运行时随机生成的虚构值，报告只输出「匹配 / 保留 / 清除」结论，不打印凭据
 *
 * 运行：node tests/notify-sensitive-fields.mjs   （退出码 0=全过，1=有失败，2=异常）
 */
import { fetchApp } from "../platforms/node/app.js";
import { LocalDatabase } from "../platforms/node/db.js";
import { rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB = join(tmpdir(), "smstoweb_sec_" + process.pid + ".db");
let pass = 0, fail = 0;
const failed = [];
function check(cond, name, detail) {
  if (cond) { pass++; console.log("  ok   " + name + (detail ? "  [" + detail + "]" : "")); }
  else { fail++; failed.push(name); console.log("  FAIL " + name + (detail ? "  [" + detail + "]" : "")); }
}
function group(t) { console.log("\n# " + t); }

/* 运行时随机虚构凭据：不落盘、不打印，只在断言里比对 */
const SENS = {
  A: "TSTONLY-" + randomBytes(9).toString("hex"),
  B: "TSTONLY-" + randomBytes(9).toString("hex"),
  C: "TSTONLY-" + randomBytes(9).toString("hex"),
  H: "HDR-" + randomBytes(6).toString("hex"),
};
const SECRETS = [SENS.A, SENS.B, SENS.C, SENS.H];

/* 捕获 worker 的结构化日志（JSON 行），用于「日志不含凭据」断言；其余输出照常打印 */
const logged = [];
function captureLogs() {
  for (const level of ["log", "warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = function (...args) {
      const line = args.map(String).join(" ");
      if (line.startsWith("{\"timestamp\"")) { logged.push(line); return; }
      orig(...args);
    };
  }
}
function logsLeak() {
  const all = logged.join("\n");
  return SECRETS.some(function (s) { return all.indexOf(s) !== -1; });
}

function cleanup() {
  for (const suf of ["", "-wal", "-shm", "-journal"]) { try { rmSync(DB + suf, { force: true }); } catch (_) {} }
}

const db = new LocalDatabase(DB);
const E = {
  DB: db, RECEIVE_TOKEN: "tok", ENABLE_AUTH: "true", ADMIN_PASSWORD: "secret",
  SESSION_SECRET: "sec-test-session-secret-0123456789abcd",
  RETENTION_DAYS: "30", PLATFORM: "test",
};
let ipSeq = 10;
function nextIp() { ipSeq += 1; return "198.51.100." + ipSeq; }
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
async function call(method, path, opts) {
  const r = await fetchApp(R(method, path, opts), E);
  let data = null;
  const text = await r.text();
  try { data = JSON.parse(text); } catch (_) {}
  return { status: r.status, data: data, text: text, setCookie: r.headers.get("Set-Cookie") || "" };
}

let CK = "";
async function login() {
  const r = await call("POST", "/api/login", { headers: { "X-Forwarded-For": nextIp() }, body: { password: "secret" } });
  CK = "sms_auth=" + ((r.setCookie.match(/sms_auth=([^;]*)/) || [])[1] || "");
}
function H() { return { "X-Forwarded-For": nextIp() }; }
async function getSettings() { return (await call("GET", "/api/settings", { headers: H(), cookie: CK })).data; }
async function put(body) { return await call("PUT", "/api/settings", { headers: H(), cookie: CK, body: body }); }
/* 直读持久层：只用于断言，不打印值 */
function storedTargets() {
  const row = db.sqlite.prepare("SELECT value FROM settings WHERE key = 'notify.targets'").get();
  if (!row) return [];
  try { return JSON.parse(String(row.value)); } catch (_) { return []; }
}
function fieldOf(tg, key) {
  return tg && tg.fields && tg.fields[key] !== undefined ? String(tg.fields[key]) : "";
}
function matches(v, secret) { return v === secret; }

/* 本地 Mock：接住 generic 渠道的出站请求（URL + Header 都用来验证凭据是否真的更新） */
const hits = [];
let mockPort = 0;
const mock = createServer(function (req, res) {
  hits.push({ url: req.url, header: String(req.headers["x-test-cred"] || ""), method: req.method, rawKeys: Object.keys(req.headers) });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("{\"code\":0}");
});

async function main() {
  await new Promise(function (res) { mock.listen(0, "127.0.0.1", res); });
  mockPort = mock.address().port;
  const urlA = "http://127.0.0.1:" + mockPort + "/hook-a";
  const urlB = "http://127.0.0.1:" + mockPort + "/hook-b";
  const urlC = "http://127.0.0.1:" + mockPort + "/hook-c";

  await login();
  check(CK.length > 8, "隔离环境登录成功（后续所有写操作带会话）");

  /* ========== A. 新建目标 ========== */
  group("A · 新建目标：敏感字段写入");
  let st = await getSettings();
  let rev = st.revision;
  let r = await put({ revision: rev, notify: { targets: [{
    channel: "generic", name: "SEC新建", enabled: true,
    fields: { urls: "", template: "{\"t\":\"{{text}}\"}", headers: "" },
    sensitive: { urls: { op: "set", value: urlA }, headers: { op: "set", value: "{\"X-Test-Cred\":\"" + SENS.H + "\"}" } },
  }] } });
  check(r.status === 200 && r.data.success, "A1 新建目标带敏感值 → 200");
  st = await getSettings();
  let tg = st.notify.targets[0];
  const idA = tg.id;
  check(tg.fields.urls.configured === true && tg.configured === true, "A2 新建后回读 configured=true");
  check(matches(fieldOf(storedTargets()[0], "urls"), urlA), "A3 持久化命中：urls 与提交值一致（匹配，不打印）");
  check(matches(fieldOf(storedTargets()[0], "headers"), "{\"X-Test-Cred\":\"" + SENS.H + "\"}"), "A4 持久化命中：headers 与提交值一致（匹配，不打印）");

  rev = st.revision;
  r = await put({ revision: rev, notify: { targets: [{
    channel: "bark", name: "SEC无凭据", enabled: false, fields: { device_key: "", url: "" },
    sensitive: { device_key: { op: "keep" } },
  }, { id: idA, channel: "generic", name: "SEC新建", enabled: true,
    fields: { urls: "", template: "{\"t\":\"{{text}}\"}", headers: "" },
    sensitive: { urls: { op: "keep" }, headers: { op: "keep" } } }] } });
  check(r.status === 200, "A5 新建目标不设置敏感字段（keep）→ 200");
  st = await getSettings();
  const bark = st.notify.targets.filter(function (x) { return x.channel === "bark"; })[0];
  check(bark && bark.fields.device_key.configured === false && bark.configured === false, "A6 未设置凭据 → configured=false");

  rev = st.revision;
  r = await put({ revision: rev, notify: { targets: [{
    channel: "pushplus", name: "SEC空值", enabled: true, fields: { token: "" },
    sensitive: { token: { op: "set", value: "" } },
  }] } });
  check(r.status === 400 && r.data.reason === "SENSITIVE_EMPTY_SET", "A7 新建目标 set 空字符串 → 400 SENSITIVE_EMPTY_SET");

  r = await put({ revision: rev, notify: { targets: [{
    channel: "pushplus", name: "SEC未知", enabled: true, fields: { token: "" },
    sensitive: { nope: { op: "set", value: SENS.A } },
  }] } });
  check(r.status === 400 && r.data.reason === "SENSITIVE_UNKNOWN_FIELD", "A8 未知敏感字段 → 400 SENSITIVE_UNKNOWN_FIELD");

  r = await put({ revision: rev, notify: { targets: [{
    channel: "generic", name: "SEC伪装", enabled: true, fields: { urls: "", template: "" },
    sensitive: { template: { op: "set", value: "x" } },
  }] } });
  check(r.status === 400 && r.data.reason === "SENSITIVE_NOT_SENSITIVE", "A9 普通字段伪装成敏感字段 → 400 SENSITIVE_NOT_SENSITIVE");

  r = await put({ revision: rev, notify: { targets: [{
    channel: "generic", name: "SEC坏操作", enabled: true, fields: { urls: "" },
    sensitive: { urls: { op: "delete" } },
  }] } });
  check(r.status === 400 && r.data.reason === "SENSITIVE_BAD_OP", "A10 非法操作类型 → 400 SENSITIVE_BAD_OP");

  /* ========== B. 编辑已有目标 ========== */
  group("B · 编辑已有目标：留空 / 覆盖 / 清除 / 多字段");
  st = await getSettings();
  rev = st.revision;
  const baseTarget = function (extra) {
    return Object.assign({ id: idA, channel: "generic", name: "SEC新建", enabled: true,
      fields: { urls: "", template: "{\"t\":\"{{text}}\"}", headers: "" } }, extra || {});
  };

  r = await put({ revision: rev, notify: { targets: [baseTarget({ sensitive: { urls: { op: "keep" }, headers: { op: "keep" } } })] } });
  check(r.status === 200, "B1 编辑留空（keep）→ 200");
  check(matches(fieldOf(storedTargets()[0], "urls"), urlA), "B2 留空后原凭据保留（命中 A，未覆盖）");

  st = await getSettings();
  rev = st.revision;
  r = await put({ revision: rev, notify: { targets: [baseTarget({ sensitive: { urls: { op: "set", value: urlB } } })] } });
  check(r.status === 200 && matches(fieldOf(storedTargets()[0], "urls"), urlB), "B3 覆盖单个敏感字段 → 持久化为新值（命中 B）");
  check(matches(fieldOf(storedTargets()[0], "headers"), "{\"X-Test-Cred\":\"" + SENS.H + "\"}"), "B4 未提交的另一个敏感字段不被清空（headers 仍为原值）");

  st = await getSettings();
  rev = st.revision;
  r = await put({ revision: rev, notify: { targets: [baseTarget({ sensitive: {
    urls: { op: "set", value: urlB }, headers: { op: "set", value: "{\"X-Test-Cred\":\"" + SENS.B + "\"}" } } })] } });
  check(r.status === 200, "B5 同时更新多个敏感字段 → 200");
  let t0 = storedTargets()[0];
  check(matches(fieldOf(t0, "urls"), urlB) && matches(fieldOf(t0, "headers"), "{\"X-Test-Cred\":\"" + SENS.B + "\"}"), "B6 多字段同时覆盖生效");

  st = await getSettings();
  rev = st.revision;
  r = await put({ revision: rev, notify: { targets: [baseTarget({ fields: { urls: "", template: "{\"t\":\"{{text}}\"}", headers: "" },
    sensitive: { urls: { op: "keep" }, headers: { op: "keep" } } })] } });
  check(r.status === 200, "B7 改普通字段前先确认 200");

  st = await getSettings();
  rev = st.revision;
  r = await put({ revision: rev, notify: { targets: [baseTarget({ name: "SEC改名", fields: { urls: "", template: "{\"t\":\"X{{text}}\"}", headers: "" },
    sensitive: { urls: { op: "keep" }, headers: { op: "keep" } } })] } });
  t0 = storedTargets()[0];
  check(r.status === 200 && t0.name === "SEC改名" && fieldOf(t0, "template") === "{\"t\":\"X{{text}}\"}"
    && matches(fieldOf(t0, "urls"), urlB), "B8 只改普通字段：普通字段生效、敏感字段保持不变");

  st = await getSettings();
  rev = st.revision;
  const beforeClear = storedTargets()[0];
  r = await put({ revision: rev, notify: { targets: [baseTarget({ name: "SEC改名", fields: { urls: "", template: "{\"t\":\"X{{text}}\"}", headers: "" },
    sensitive: { headers: { op: "clear" } } })] } });
  t0 = storedTargets()[0];
  check(r.status === 200 && fieldOf(t0, "headers") === "", "B9 清除单个敏感字段 → 该字段为空");
  check(matches(fieldOf(t0, "urls"), fieldOf(beforeClear, "urls")), "B10 清除一个字段不影响另一个字段（urls 保留）");
  st = await getSettings();
  const viewAfterClear = st.notify.targets.filter(function (x) { return x.id === idA; })[0];
  check(viewAfterClear.fields.headers.configured === false && viewAfterClear.configured === true, "B11 清除后回读 headers 未配置（urls 仍配置）");

  st = await getSettings();
  rev = st.revision;
  r = await put({ revision: rev, notify: { targets: [baseTarget({ name: "SEC改名", fields: { urls: "", template: "{\"t\":\"X{{text}}\"}", headers: "" },
    sensitive: { urls: { op: "set", value: urlC }, headers: { op: "set", value: "{\"X-Test-Cred\":\"" + SENS.C + "\"}" } } })] } });
  t0 = storedTargets()[0];
  check(r.status === 200 && matches(fieldOf(t0, "urls"), urlC) && matches(fieldOf(t0, "headers"), "{\"X-Test-Cred\":\"" + SENS.C + "\"}"),
    "B12 清除后重新设置 → 新值生效（命中 C）");

  /* ========== C. 安全：回读 / 响应 / 日志脱敏 ========== */
  group("C · 敏感值不回读、不进响应、不进日志");
  st = await getSettings();
  const stText = JSON.stringify(st);
  check(!SECRETS.some(function (s) { return stText.indexOf(s) !== -1; }), "C1 GET /api/settings 不含任何敏感明文");
  check(!!st.notify.targets[0].fields.urls.masked && st.notify.targets[0].fields.urls.masked.length <= 8, "C2 回读只给脱敏标记（长度受控）");
  const okBody = JSON.stringify((await put({ revision: st.revision, notify: { targets: [baseTarget({
    name: "SEC改名", fields: { urls: "", template: "{\"t\":\"X{{text}}\"}", headers: "" },
    sensitive: { urls: { op: "keep" }, headers: { op: "keep" } } })] } })).data || {});
  check(!SECRETS.some(function (s) { return okBody.indexOf(s) !== -1; }), "C3 保存成功响应不含敏感明文");

  const stNow = await getSettings();
  const conflict = await put({ revision: stNow.revision - 1, notify: { targets: [baseTarget({
    name: "SEC改名", fields: { urls: "", template: "{\"t\":\"X{{text}}\"}", headers: "" },
    sensitive: { urls: { op: "set", value: urlA } } })] } });
  check(conflict.status === 409, "C4a 冲突请求返回 409", "status=" + conflict.status + " err=" + (conflict.data && conflict.data.error));
  check(!JSON.stringify(conflict.data).includes(SENS.A) && !conflict.text.includes(SENS.A), "C4b 409 响应不含提交的敏感明文", "keys=" + Object.keys(conflict.data || {}).join(","));
  check(matches(fieldOf(storedTargets()[0], "urls"), urlC), "C5 冲突时没有任何部分写入（仍为 C）");

  const badReq = await put({ revision: stNow.revision, notify: { targets: [{
    channel: "generic", name: "SEC非法", enabled: true, fields: { urls: "", template: "" },
    sensitive: { urls: { op: "set", value: "not-a-url-" + SENS.A } } }] } });
  check(badReq.status === 400 && badReq.data.reason === "INVALID_FIELD_VALUE", "C6 非法敏感值 → 400（字段名可回传）");
  check(!JSON.stringify(badReq.data).includes(SENS.A), "C7 400 错误响应不含敏感明文");

  let sawNotifyLog = logged.some(function (l) { return l.indexOf("notify") !== -1; });
  check(!logsLeak(), "C8 结构化日志不含任何测试凭据", sawNotifyLog ? "已包含 notify 相关日志" : "无 notify 日志（同样不泄漏）");

  /* ========== D. revision 与原子性 ========== */
  group("D · revision 乐观锁与原子性");
  const stD = await getSettings();
  const revD = stD.revision;
  const d1 = await put({ revision: revD, notify: { targets: [baseTarget({
    name: "SEC改名", fields: { urls: "", template: "{\"t\":\"X{{text}}\"}", headers: "" },
    sensitive: { urls: { op: "keep" }, headers: { op: "keep" } } })] } });
  check(d1.status === 200 && d1.data.revision === revD + 1, "D1 正常保存：revision 单调 +1");
  const d2 = await put({ revision: revD, notify: { targets: [] } });
  check(d2.status === 409 && d2.data.error === "REVISION_CONFLICT", "D2 旧 revision 保存被拒绝（409）");
  check(storedTargets().length === 1, "D3 被拒绝的请求没有删除目标（无部分写入）");

  const stD3 = await getSettings();
  const d3 = await put({ revision: stD3.revision, notify: { targets: [baseTarget({
    name: "SEC二次", fields: { urls: "", template: "{\"t\":\"X{{text}}\"}", headers: "" },
    sensitive: { urls: { op: "set", value: urlB }, headers: { op: "keep" } } })] } });
  check(d3.status === 200 && matches(fieldOf(storedTargets()[0], "urls"), urlB), "D4 冲突后基于最新 revision 重新提交 → 成功生效（命中 B）");

  const stD4 = await getSettings();
  const d4 = await put({ revision: stD4.revision, notify: { targets: [
    baseTarget({ name: "SEC二次", fields: { urls: "", template: "{\"t\":\"X{{text}}\"}", headers: "" },
      sensitive: { urls: { op: "keep" }, headers: { op: "keep" } } }),
    { channel: "bark", name: "SEC另一个", enabled: true, fields: { device_key: "", url: "https://example.com/b" },
      sensitive: { device_key: { op: "set", value: SENS.A } } },
  ] } });
  const arr = storedTargets();
  check(d4.status === 200 && arr.length === 2 && matches(fieldOf(arr[0], "urls"), urlB)
    && matches(fieldOf(arr[1], "device_key"), SENS.A), "D5 两个不同 target_id 的修改互不影响");

  /* ========== E. 通知发送实际读取新凭据（本地 Mock） ========== */
  group("E · 通知发送路径真实读取新凭据（127.0.0.1 Mock，无真实出站）");
  const stE = await getSettings();
  const tgId = stE.notify.targets.filter(function (x) { return x.channel === "generic"; })[0].id;
  async function testSend() {
    hits.length = 0;
    const res = await call("POST", "/api/settings/notify/test", { headers: H(), cookie: CK, body: { channel: "generic", target_id: tgId } });
    await new Promise(function (r) { setTimeout(r, 60); });
    return { status: res.status, data: res.data, hits: hits.slice() };
  }
  let send = await testSend();
  check(send.status === 200 && send.hits.length === 1 && send.hits[0].url === "/hook-b", "E1 发送路径使用当前凭据（命中 /hook-b）");
  /* headers 是 JSON 配置：出站时只取其中的 X-Test-Cred 值，比对的是该值本身 */
  check(send.hits.length === 1 && send.hits[0].header === SENS.C,
    "E2 敏感 Header 使用当前值（命中 C，未沿用旧值）",
    "hits=" + send.hits.length + " hdrLen=" + (send.hits[0] ? send.hits[0].header.length : -1));

  let stE2 = await getSettings();
  const e3 = await put({ revision: stE2.revision, notify: { targets: [
    { id: tgId, channel: "generic", name: "SEC改名2", enabled: true,
      fields: { urls: "", template: "{\"t\":\"X{{text}}\"}", headers: "" },
      sensitive: { urls: { op: "keep" }, headers: { op: "keep" } } },
    { id: stE2.notify.targets.filter(function (x) { return x.channel === "bark"; })[0].id, channel: "bark",
      name: "SEC另一个", enabled: false, fields: { device_key: "", url: "https://example.com/b" },
      sensitive: { device_key: { op: "keep" } } },
  ] } });
  send = await testSend();
  check(e3.status === 200 && send.hits.length === 1 && send.hits[0].url === "/hook-b", "E3 留空保存普通字段后，发送仍用原凭据（保留）");

  let stE3 = await getSettings();
  const e4 = await put({ revision: stE3.revision, notify: { targets: [
    { id: tgId, channel: "generic", name: "SEC改名2", enabled: true,
      fields: { urls: "", template: "{\"t\":\"X{{text}}\"}", headers: "" },
      sensitive: { urls: { op: "clear" }, headers: { op: "keep" } } },
    { id: stE3.notify.targets.filter(function (x) { return x.channel === "bark"; })[0].id, channel: "bark",
      name: "SEC另一个", enabled: false, fields: { device_key: "", url: "https://example.com/b" },
      sensitive: { device_key: { op: "keep" } } },
  ] } });
  send = await testSend();
  const cleared = storedTargets().filter(function (x) { return x.id === tgId; })[0];
  check(e4.status === 200 && fieldOf(cleared, "urls") === "", "E4 显式清除后持久化为空");
  check(send.hits.length === 0, "E5 清除后发送路径不再使用旧凭据（0 次出站）");

  let stE4 = await getSettings();
  const e6 = await put({ revision: stE4.revision, notify: { targets: [
    { id: tgId, channel: "generic", name: "SEC改名2", enabled: true,
      fields: { urls: "", template: "{\"t\":\"X{{text}}\"}", headers: "" },
      sensitive: { urls: { op: "set", value: urlC }, headers: { op: "keep" } } },
    { id: stE4.notify.targets.filter(function (x) { return x.channel === "bark"; })[0].id, channel: "bark",
      name: "SEC另一个", enabled: false, fields: { device_key: "", url: "https://example.com/b" },
      sensitive: { device_key: { op: "keep" } } },
  ] } });
  send = await testSend();
  check(e6.status === 200 && send.hits.length === 1 && send.hits[0].url === "/hook-c", "E6 清除后重新写入 → 发送路径使用新凭据（命中 /hook-c）");
  check(send.hits.length === 1 && send.hits[0].header === SENS.C, "E7 未更新的另一个敏感字段继续保留（Header 仍为 C）");

  /* ========== F. 兼容性与边界 ========== */
  group("F · 旧请求兼容与边界");
  const stF = await getSettings();
  const f1 = await put({ revision: stF.revision, notify: { targets: [
    { id: tgId, channel: "generic", name: "SEC兼容", enabled: true,
      fields: { urls: urlA, template: "{\"t\":\"{{text}}\"}", headers: "" } },
    { id: stF.notify.targets.filter(function (x) { return x.channel === "bark"; })[0].id, channel: "bark",
      name: "SEC另一个", enabled: false, fields: { device_key: "", url: "https://example.com/b" },
      sensitive: { device_key: { op: "keep" } } },
  ] } });
  check(f1.status === 200 && matches(fieldOf(storedTargets()[0], "urls"), urlA), "F1 旧客户端（fields 直传敏感值、无 sensitive 键）继续生效");

  const stF2 = await getSettings();
  const f2 = await put({ revision: stF2.revision, notify: { targets: [
    { id: tgId, channel: "generic", name: "SEC兼容", enabled: true,
      fields: { urls: "", template: "{\"t\":\"{{text}}\"}", headers: "" } },
    { id: stF2.notify.targets.filter(function (x) { return x.channel === "bark"; })[0].id, channel: "bark",
      name: "SEC另一个", enabled: false, fields: { device_key: "", url: "https://example.com/b" },
      sensitive: { device_key: { op: "keep" } } },
  ] } });
  check(f2.status === 200 && matches(fieldOf(storedTargets()[0], "urls"), urlA), "F2 旧客户端留空 → 敏感字段沿用旧值（兼容语义不变）");

  const stF3 = await getSettings();
  const f3 = await put({ revision: stF3.revision, notify: { targets: [
    { id: tgId, channel: "generic", name: "SEC兼容", enabled: true,
      fields: { urls: "ftp://bad", template: "" },
      sensitive: { urls: { op: "keep" } } },
  ] } });
  check(f3.status === 400, "F3 普通字段类型校验仍生效（非法 urls → 400）");

  const stF4 = await getSettings();
  const f4 = await put({ revision: stF4.revision, notify: { targets: [
    { id: "nt_not_exist_0000", channel: "generic", name: "SEC幽灵", enabled: true, fields: { urls: "" },
      sensitive: { urls: { op: "set", value: urlA } } },
  ] } });
  check(f4.status === 200 && storedTargets().length === 1 && storedTargets()[0].id === "nt_not_exist_0000",
    "F4 不存在的 target_id 按新建处理（不覆盖其他目标）");

  const stF5 = await getSettings();
  const f5 = await put({ revision: stF5.revision, notify: { targets: [
    { id: "nt_not_exist_0000", channel: "generic", name: "SEC超长", enabled: true, fields: { urls: "" },
      sensitive: { urls: { op: "set", value: "http://" + "a".repeat(4200) } } },
  ] } });
  check(f5.status === 400, "F5 超长敏感值被拒绝（长度上限仍生效）");

  const stF6 = await getSettings();
  const f6 = await put({ revision: stF6.revision, notify: { targets: [
    { id: "nt_not_exist_0000", channel: "generic", name: "SEC超长", enabled: true, fields: { urls: "" },
      sensitive: [] },
  ] } });
  check(f6.status === 400 && f6.data.reason === "SENSITIVE_NOT_OBJECT", "F6 sensitive 不是对象 → 400（结构校验）");

  check(!logsLeak(), "F7 全流程结束后日志仍不含任何测试凭据");

  console.log("\n===== 通知敏感字段安全测试：pass=" + pass + " fail=" + fail + " =====");
  if (fail) console.log("失败项：" + failed.join(" | "));
  return fail === 0 ? 0 : 1;
}

captureLogs();
let code = 2;
try {
  code = await main();
} catch (e) {
  console.error("[FATAL] " + String((e && e.message) || e));
  code = 2;
} finally {
  try { mock.close(); } catch (_) {}
  try { db.sqlite.close(); } catch (_) {}
  cleanup();
}
process.exit(code);
