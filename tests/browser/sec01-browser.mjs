/**
 * FEAD-SEC-01 · 敏感字段三态（留空保留 / 输入覆盖 / 勾选清除）浏览器回归
 *
 * 运行：node tests/browser/sec01-browser.mjs
 *
 * 只在隔离实例里跑：临时 SQLite + 127.0.0.1 假地址，不发任何真实通知。
 * 凭据为运行时随机虚构串，报告与日志只输出布尔结论与长度，不打印明文。
 */
import { randomBytes } from "node:crypto";
import { loadChromium, startApp, newPage, login, openSettings, gotoTab, saveSettings, readStatus, reporter, noPageErrors } from "./harness.mjs";

const chromium = loadChromium();
const R = reporter("sec01-browser");
const app = await startApp();
const browser = await chromium.launch({ args: ["--no-sandbox"] });
let ctx, page, consoleErrors, pageErrors;

/* 运行时随机虚构凭据：不落盘、不打印。
   该渠道的敏感字段是回调地址，服务端按 URL 校验，所以用 127.0.0.1 假地址 + 随机尾串，
   尾串即「凭据指纹」，断言只看末四位是否匹配。 */
const TOK = {
  A: randomBytes(6).toString("hex"),
  B: randomBytes(6).toString("hex"),
  C: randomBytes(6).toString("hex"),
};
const CRED = {
  A: "http://127.0.0.1:9/hook-" + TOK.A,
  B: "http://127.0.0.1:9/hook-" + TOK.B,
  C: "http://127.0.0.1:9/hook-" + TOK.C,
};
const ALL = [CRED.A, CRED.B, CRED.C];
const leak = [];   /* 记录的接口响应文本，事后统一断言不含明文 */

async function fresh() {
  if (ctx) await ctx.close().catch(() => {});
  ({ ctx, page, consoleErrors, pageErrors } = await newPage(browser, { viewport: { width: 1440, height: 900 } }));
  page.on("response", async (res) => {
    const u = res.url();
    if (u.indexOf("/api/settings") === -1) return;
    try { leak.push(await res.text()); } catch (e) { /* 已释放 */ }
  });
  await login(page, app);
}

async function seedTargetWith(value) {
  await page.evaluate(async (v) => {
    const st = await (await fetch("/api/settings")).json();
    await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      revision: st.revision,
      notify: { targets: [{ channel: "generic", name: "SEC-目标", enabled: true, types: ["notify"],
        fields: { urls: "", template: "", headers: "" },
        sensitive: { urls: { op: "set", value: v } } }] },
    }) });
  }, value);
}

const readTarget = () => page.evaluate(async () => {
  const d = await (await fetch("/api/settings")).json();
  const t = ((d.notify && d.notify.targets) || [])[0];
  if (!t) return null;
  return { id: t.id, name: t.name, configured: t.configured, urls: t.fields.urls };
});

async function openEditor() {
  if (await page.evaluate(() => document.getElementById("modal").hidden)) await openSettings(page);
  await gotoTab(page, "notify");
  await page.click('[data-tgact="edit"]');
  await page.waitForSelector("#pushmodal:not([hidden])", { timeout: 12000 });
  await page.waitForTimeout(120);
}

async function saveEditorAndSettings() {
  await page.click('[data-pushact="save"]');
  await page.waitForTimeout(180);
  await saveSettings(page, app);
}

const editorState = () => page.evaluate(() => {
  const inp = document.getElementById("pf_generic_urls");
  const box = inp.closest(".sc-credwrap");
  const cb = box.querySelector("[data-pfclr]");
  return {
    value: inp.value,
    placeholder: inp.placeholder,
    status: box.querySelector(".ds-help") ? box.querySelector(".ds-help").innerText.trim() : "",
    hasClear: !!cb,
    clearChecked: cb ? cb.checked : null,
  };
});

try {
  /* ============ A. 初始：已配置但不回显 ============ */
  R.group("A. 编辑弹层不回显明文");
  await fresh();
  await seedTargetWith(CRED.A);
  await openSettings(page);
  await openEditor();
  let es = await editorState();
  R.ok(es.value === "", "A1 打开编辑时输入框为空（不回显真实值）");
  R.ok(es.status.length > 0, "A2 显示配置状态文案", es.status.slice(0, 12));
  R.ok(es.hasClear && es.clearChecked === false, "A3 已有凭据时提供未勾选的清除项");
  const ph = await page.evaluate(() => document.getElementById("pf_generic_urls").placeholder);
  R.ok(ph.indexOf(CRED.A) === -1 && ph.length > 0, "A4 占位文案不含真实凭据", "placeholderLen=" + ph.length);

  /* ============ B. 输入新值 → 覆盖 ============ */
  R.group("B. 输入新值覆盖");
  await page.fill("#pf_generic_urls", CRED.B);
  await saveEditorAndSettings();
  let st = await readStatus(page);
  R.ok(st && !st.hidden && /sc-status--success/.test(st.cls), "B1 保存反馈成功", st ? st.text.slice(0, 20) : "null");
  let tg = await readTarget();
  R.ok(tg && tg.urls.configured === true, "B2 服务端回读 configured=true");
  R.ok(tg && tg.urls.masked && tg.urls.masked.endsWith(TOK.B.slice(-4)), "B3 掩码末四位与写入值一致（新值已落库）");
  R.ok(tg && tg.urls.masked !== CRED.B, "B4 回读只给脱敏状态，不给明文");

  /* ============ C. 留空 → 保留 ============ */
  R.group("C. 留空保存保留原凭据");
  await openEditor();
  es = await editorState();
  R.ok(es.value === "", "C1 再次打开仍不回显");
  await saveEditorAndSettings();
  const tg2 = await readTarget();
  R.ok(tg2 && tg2.urls.configured === true && tg2.urls.masked === tg.urls.masked, "C2 留空保存后凭据未被清空、掩码未变");

  /* ============ D. 勾选清除 → 删除 ============ */
  R.group("D. 勾选清除");
  await openEditor();
  es = await editorState();
  R.ok(es.hasClear, "D1 清除项存在");
  await page.click("[data-pfclr]");
  const checked = await page.evaluate(() => document.querySelector("[data-pfclr]").checked);
  R.ok(checked === true, "D2 清除项可勾选");
  await saveEditorAndSettings();
  const tg3 = await readTarget();
  R.ok(tg3 && tg3.urls.configured === false, "D3 清除后 configured=false");
  R.ok(tg3 && (tg3.urls.masked || "").length === 0 || tg3.urls.masked === "", "D4 清除后掩码为空");

  /* ============ E. 清除后重新设置 ============ */
  R.group("E. 清除后重新设置");
  await openEditor();
  es = await editorState();
  R.ok(es.hasClear === false, "E1 未配置时不再显示无意义的清除项");
  await page.fill("#pf_generic_urls", CRED.C);
  await saveEditorAndSettings();
  const tg4 = await readTarget();
  R.ok(tg4 && tg4.urls.configured === true && tg4.urls.masked.endsWith(TOK.C.slice(-4)), "E2 重新写入后 configured=true 且掩码匹配新值");

  /* ============ F. revision 冲突下的敏感字段编辑 ============ */
  R.group("F. revision 冲突");
  await openEditor();
  await page.fill("#pf_generic_urls", CRED.A);
  await page.click('[data-pushact="save"]');
  await page.waitForTimeout(180);
  /* 另一路先保存一次，让本页 revision 过期 */
  await page.evaluate(async () => {
    const st = await (await fetch("/api/settings")).json();
    await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: st.revision, notify: { enabled: true } }) });
  });
  await saveSettings(page, app);
  st = await readStatus(page);
  R.ok(st && /sc-status--conflict/.test(st.cls), "F1 旧 revision 保存给出冲突提示", st ? st.text.slice(0, 24) : "null");
  const hasReload = await page.evaluate(() => !!document.getElementById("screload"));
  R.ok(hasReload, "F2 冲突提供重新加载入口");
  const tg5 = await readTarget();
  R.ok(tg5 && tg5.urls.masked.endsWith(TOK.C.slice(-4)), "F3 冲突时被拒请求未部分写入（服务端仍是 C）");
  if (hasReload) {
    await page.click("#screload");
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => ({ conflict: /conflict/.test(document.getElementById("scstatus").className), modalOpen: !document.getElementById("modal").hidden }));
    R.ok(!after.conflict && after.modalOpen, "F4 重载后冲突清除、弹层仍在");
  }
  /* 基于最新 revision 重新提交 */
  await openEditor();
  await page.fill("#pf_generic_urls", CRED.A);
  await saveEditorAndSettings();
  const tg6 = await readTarget();
  R.ok(tg6 && tg6.urls.configured === true && tg6.urls.masked.endsWith(TOK.A.slice(-4)), "F5 重载后可基于最新 revision 成功提交");

  /* ============ G. 脱敏总检查 ============ */
  R.group("G. 响应与日志脱敏");
  const dump = leak.join("\n");
  const hit = ALL.filter((s) => dump.indexOf(s) !== -1);
  R.ok(hit.length === 0, "G1 所有 /api/settings 响应文本均不含任何测试凭据明文", "responses=" + leak.length);
  const serverLog = app.logs.join("");
  R.ok(ALL.every((s) => serverLog.indexOf(s) === -1), "G2 服务端日志不含测试凭据");
  const html = await page.content();
  R.ok(ALL.every((s) => html.indexOf(s) === -1), "G3 页面 DOM 中不含测试凭据（输入框已清空）");
  noPageErrors(R, page, consoleErrors, pageErrors, /409 \(Conflict\)/);

  /* ============ H. 三态在移动端同样可用 ============ */
  R.group("H. 390px 下三态可用");
  if (ctx) await ctx.close().catch(() => {});
  ({ ctx, page, consoleErrors, pageErrors } = await newPage(browser, { viewport: { width: 390, height: 844 } }));
  await login(page, app);
  await seedTargetWith(CRED.B);
  await openSettings(page);
  await gotoTab(page, "notify");
  await page.click('[data-tgact="edit"]');
  await page.waitForSelector("#pushmodal:not([hidden])", { timeout: 12000 });
  const m = await page.evaluate(() => {
    const inp = document.getElementById("pf_generic_urls");
    const box = inp.closest(".sc-credwrap");
    const r = box.getBoundingClientRect();
    const sheet = document.querySelector("#pushmodal .pwdsheet").getBoundingClientRect();
    return {
      empty: inp.value === "",
      hasClear: !!box.querySelector("[data-pfclr]"),
      overflow: box.scrollWidth > box.clientWidth + 1,
      rectH: Math.round(r.height),
      sheetRight: sheet.right, vw: window.innerWidth,
      inputH: Math.round(inp.getBoundingClientRect().height),
    };
  });
  R.ok(m.empty && m.hasClear, "H1 移动端同样不回显且有清除项");
  R.ok(!m.overflow && m.sheetRight <= m.vw + 1, "H2 移动端凭据区无溢出、弹层不超视口");
  R.ok(m.inputH > 0 && m.inputH < 80, "H3 输入框高度正常（单行）", "h=" + m.inputH);
  await page.fill("#pf_generic_urls", CRED.C);
  await page.click('[data-pushact="save"]');
  await page.waitForTimeout(180);
  await saveSettings(page, app);
  const tgM = await readTarget();
  R.ok(tgM && tgM.urls.masked.endsWith(TOK.C.slice(-4)), "H4 移动端覆盖保存同样生效");
  noPageErrors(R, page, consoleErrors, pageErrors);
} catch (e) {
  R.ok(false, "用例执行未抛异常", String((e && e.stack) || e).slice(0, 300));
} finally {
  try { await ctx.close(); } catch (e) { /* 已关闭 */ }
  try { await browser.close(); } catch (e) { /* 已关闭 */ }
  await app.stop();
  R.done();
}
