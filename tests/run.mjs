/**
 * SMSToWeb 零依赖测试套件（需 Node 22.13+，用到内置 node:sqlite）
 * 直接测生成的平台无关核心 platforms/node/app.js 的 fetchApp / runCron / handleCronRequest，
 * 覆盖：收发、去重、列表、来源筛选、长轮询、删除、正文截断、定时清理、cron 鉴权、
 *       登录鉴权、http cookie 降级、防锁死、写入限速、管理页开关 UI。
 * 运行：node tests/run.mjs   （退出码 0=全过，1=有失败，2=异常）
 */
import { fetchApp, runCron, handleCronRequest } from "../platforms/node/app.js";
import { LocalDatabase } from "../platforms/node/db.js";
import { rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB = join(tmpdir(), "smstoweb_test_" + process.pid + ".db");
let pass = 0, fail = 0;
const failed = [];
function check(cond, name) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; failed.push(name); console.log("  FAIL " + name); }
}
function group(t) { console.log("\n# " + t); }
function cleanup() {
  for (const suf of ["", "-wal", "-shm", "-journal"]) { try { rmSync(DB + suf, { force: true }); } catch (_) {} }
}

const db = new LocalDatabase(DB);
function env(extra) {
  return Object.assign({ DB: db, RECEIVE_TOKEN: "tok", ENABLE_AUTH: "", ADMIN_PASSWORD: "", SESSION_SECRET: "test-session-secret-0123456789abcdef", RETENTION_DAYS: "30" }, extra || {});
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

  group("收发 / 去重 / 列表 / 筛选 / 长轮询 / 删除 / 截断（免登录）");
  let r = await call("POST", "/api/push", e0, { body: { content: "no token here" } });
  check(r.status === 403, "push 无 token → 403");

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

  group("写入接口限速");
  let saw429 = false, allowed = 0;
  for (let i = 0; i < 260 && !saw429; i++) {
    const rr = await call("POST", "/api/push?token=tok", e0, { body: { content: "burst " + i } });
    if (rr.status === 429) saw429 = true; else if (rr.status === 200) allowed++;
  }
  check(saw429 && allowed >= 1 && allowed < 260, "限速生效：放行一批后开始返回 429");

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

  console.log("\n===== 结果：" + pass + " 通过，" + fail + " 失败 =====");
  if (fail) console.log("失败项：\n - " + failed.join("\n - "));
  cleanup();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error("测试异常：", e);
  cleanup();
  process.exit(2);
});
