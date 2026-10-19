/**
 * SMSToWeb 零依赖测试套件（需 Node 22.13+，用到内置 node:sqlite）
 * 直接测生成的平台无关核心 platforms/node/app.js 的 fetchApp / runCron / handleCronRequest，
 * 覆盖：收发、去重、列表、来源筛选、长轮询、删除、正文截断、定时清理、cron 鉴权、
 *       登录鉴权、http cookie 降级、防锁死、写入限速、管理页开关 UI。
 * 运行：node tests/run.mjs   （退出码 0=全过，1=有失败，2=异常）
 */
import { fetchApp, runCron, handleCronRequest } from "../platforms/node/app.js";
import { LocalDatabase } from "../platforms/node/db.js";
import { rmSync } from "node:fs";
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
  return Object.assign({ DB: db, RECEIVE_TOKEN: "tok", ENABLE_AUTH: "", ADMIN_PASSWORD: "", RETENTION_DAYS: "30" }, extra || {});
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
  check(r.status === 200, "ENABLE_AUTH=true 但未设密码 → 免登录可访问（不锁死）");

  group("写入接口限速");
  let saw429 = false, allowed = 0;
  for (let i = 0; i < 260 && !saw429; i++) {
    const rr = await call("POST", "/api/push?token=tok", e0, { body: { content: "burst " + i } });
    if (rr.status === 429) saw429 = true; else if (rr.status === 200) allowed++;
  }
  check(saw429 && allowed >= 1 && allowed < 260, "限速生效：放行一批后开始返回 429");

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
