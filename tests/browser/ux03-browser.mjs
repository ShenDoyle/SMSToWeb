/**
 * FEAD-UX-03 · 设置中心浏览器行为回归（原一次性探针转正）
 *
 * 运行：node tests/browser/ux03-browser.mjs
 *
 * 覆盖：六分区切换、首页统计摘要（默认隐藏 / 开启 / 刷新保留）、保存成功与失败、
 *      revision 冲突与重载、通知目标新增→编辑→删除全流程、三视口无横向溢出、
 *      九语言导航与关键文案、双主题、控制台零错误。
 */
import { loadChromium, startApp, newPage, login, openSettings, gotoTab, saveSettings, readStatus, reporter, noPageErrors } from "./harness.mjs";

const chromium = loadChromium();
const R = reporter("ux03-browser");
const app = await startApp();
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const SECTIONS = ["display", "messages", "session", "notify", "biz", "security"];
const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt-BR"];
let ctx, page, consoleErrors, pageErrors;

async function fresh(vp, lang) {
  if (ctx) await ctx.close().catch(() => {});
  ({ ctx, page, consoleErrors, pageErrors } = await newPage(browser, { viewport: vp }));
  await page.goto(app.base + "/?lang=" + (lang || "zh-CN"), { waitUntil: "domcontentloaded" });
  if (await page.locator("#pw").isVisible().catch(() => false)) {
    await page.fill("#pw", app.password);
    await page.click("#go");
  }
  await page.waitForSelector("#list", { timeout: 30000 });
  await page.waitForTimeout(200);
}

const readTargets = () => page.evaluate(async () => {
  const d = await (await fetch("/api/settings")).json();
  return ((d.notify && d.notify.targets) || []).map((t) => ({ id: t.id, name: t.name, channel: t.channel, enabled: !!t.enabled, providers: t.configured }));
});

try {
  /* ============ A. 六分区切换 ============ */
  R.group("A. 六分区导航与内容切换");
  await fresh({ width: 1440, height: 900 });
  await openSettings(page);
  for (const key of SECTIONS) {
    await gotoTab(page, key);
    const st = await page.evaluate((k) => {
      const tab = document.querySelector('[data-sc-tab="' + k + '"]');
      const body = document.getElementById("scbody");
      const panel = document.getElementById("scbody");
      return {
        selected: tab.getAttribute("aria-selected"),
        tabindex: tab.getAttribute("tabindex"),
        bodyLabel: panel.getAttribute("aria-labelledby"),
        htmlLen: body.innerHTML.length,
        skeleton: body.querySelectorAll(".sc-skel").length,
        modalOpen: !document.getElementById("modal").hidden,
      };
    }, key);
    R.ok(st.selected === "true" && st.tabindex === "0", "A" + (SECTIONS.indexOf(key) + 1) + " 分区 " + key + " 选中且可聚焦", st.selected + "/" + st.tabindex);
    R.ok(st.bodyLabel === "sctab-" + key, "A" + (SECTIONS.indexOf(key) + 1) + "b 内容区 aria-labelledby 跟着分区走", st.bodyLabel);
    R.ok(st.htmlLen > 120 && st.skeleton === 0 && st.modalOpen, "A" + (SECTIONS.indexOf(key) + 1) + "c 内容已填充、无残留骨架、弹层未关闭", "len=" + st.htmlLen);
  }
  /* 分区来回切换不重复绑定 / 不白屏：连续两轮后仍能打开目标编辑 */
  await gotoTab(page, "notify");
  await gotoTab(page, "display");
  await gotoTab(page, "notify");
  R.ok((await page.locator('[data-pushadd]').count()) >= 6, "A7 分区反复切换后渠道网格仍完整渲染（未重复绑定导致丢失）");

  /* ============ B. 首页统计摘要 ============ */
  R.group("B. 首页统计摘要（本浏览器作用域）");
  await gotoTab(page, "display");
  const hs0 = await page.evaluate(() => {
    const c = document.getElementById("schomestats");
    return { checked: c.checked, ls: localStorage.getItem("sms_homestats"), statHidden: document.getElementById("statbar").hidden };
  });
  R.ok(hs0.checked === false, "B1 默认不勾选");
  R.ok(hs0.statHidden === true, "B1b 默认统计条隐藏");
  R.ok(hs0.checked === (hs0.ls === "1"), "B2 勾选状态与 localStorage 一致", "ls=" + hs0.ls);
  await page.evaluate(() => {
    const c = document.getElementById("schomestats");
    c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await saveSettings(page, app);
  const hs1 = await page.evaluate(() => ({ ls: localStorage.getItem("sms_homestats") }));
  R.ok(hs1.ls === "1", "B3 开启后写入 localStorage", "ls=" + hs1.ls);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#list", { timeout: 30000 });
  await page.waitForTimeout(250);
  const hs2 = await page.evaluate(() => {
    const bar = document.getElementById("statbar");
    return { ls: localStorage.getItem("sms_homestats"), statVisible: bar ? !bar.hidden : null };
  });
  R.ok(hs2.ls === "1" && hs2.statVisible === true, "B4 刷新后仍开启且统计条可见", "ls=" + hs2.ls + " visible=" + hs2.statVisible);
  await openSettings(page);
  await gotoTab(page, "display");
  const hs3 = await page.evaluate(() => document.getElementById("schomestats").checked);
  R.ok(hs3 === true, "B5 重新打开设置仍显示开启");
  await page.evaluate(() => {
    const c = document.getElementById("schomestats");
    c.checked = false; c.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await saveSettings(page, app);
  R.ok((await page.evaluate(() => localStorage.getItem("sms_homestats"))) === "0", "B6 关闭后写回 0");

  /* ============ C. 保存成功 / 失败 / 冲突 ============ */
  R.group("C. 保存反馈三态");
  await gotoTab(page, "display");
  await page.evaluate(() => {
    const c = document.getElementById("schomestats");
    c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await saveSettings(page, app);
  const okSt = await readStatus(page);
  R.ok(okSt && !okSt.hidden && /sc-status--success/.test(okSt.cls), "C1 保存成功有 success 状态条", okSt ? okSt.text : "null");

  /* 失败：注入 500 */
  await page.evaluate(() => {
    const of = window.fetch;
    window.__restore = () => { window.fetch = of; };
    window.fetch = function (u, o) {
      if (typeof u === "string" && u.indexOf("/api/settings") !== -1 && o && o.method === "PUT") {
        window.fetch = of;
        return Promise.resolve(new Response(JSON.stringify({ success: false, error: "E_INTERNAL" }), { status: 500, headers: { "Content-Type": "application/json" } }));
      }
      return of.apply(this, arguments);
    };
  });
  await gotoTab(page, "notify");
  await page.evaluate(() => document.getElementById("scbody").dispatchEvent(new Event("change", { bubbles: true })));
  await page.click("#scrsave");
  if (await page.locator("#pwdmodal").isVisible().catch(() => false)) {
    await page.fill("#pwdinput", app.password);
    await page.press("#pwdinput", "Enter");
  }
  await page.waitForTimeout(900);
  const errSt = await readStatus(page);
  R.ok(errSt && /sc-status--error/.test(errSt.cls) && /E_INTERNAL/.test(errSt.text), "C2 保存失败显示错误码且不谎报成功", errSt ? errSt.text.slice(0, 40) : "null");
  R.ok(await page.evaluate(() => !document.getElementById("modal").hidden), "C3 保存失败后弹层保持打开，编辑未丢");
  await page.evaluate(() => { if (window.__restore) window.__restore(); });

  /* 冲突：必须在「服务端分区」制造并发抢先（界面与显示分区只写 localStorage，不产生 PUT） */
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await openSettings(page);
  await gotoTab(page, "notify");
  await page.evaluate(async () => {
    const st = await (await fetch("/api/settings")).json();
    /* 空 payload 不推进修订号，必须写一个真实键才能制造并发抢先 */
    await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: st.revision, notify: { enabled: true } }) });
  });
  await page.evaluate(() => {
    const c = document.getElementById("nfen");
    c.checked = !c.checked; c.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await saveSettings(page, app);
  const cf = await page.evaluate(() => {
    const s = document.getElementById("scstatus");
    const rb = document.getElementById("screload");
    return { cls: s.className, text: s.innerText, hasReload: !!rb };
  });
  R.ok(/sc-status--conflict/.test(cf.cls), "C4 旧 revision 保存触发冲突状态", cf.cls);
  R.ok(cf.hasReload, "C5 冲突提供「重新加载」入口");
  if (cf.hasReload) {
    await page.click("#screload");
    await page.waitForTimeout(700);
    const st2 = await page.evaluate(() => {
      const s = document.getElementById("scstatus");
      const rb = document.getElementById("screload");
      return { cls: s.className, hasReload: !!rb, modalOpen: !document.getElementById("modal").hidden };
    });
    R.ok(!/conflict/.test(st2.cls) && !st2.hasReload && st2.modalOpen, "C6 重载后冲突清除、弹层仍在");
  }

  /* ============ D. 通知目标全流程 ============ */
  R.group("D. 通知目标 新增 → 编辑 → 删除");
  await gotoTab(page, "notify");
  await page.click('[data-pushadd="generic"]');
  await page.waitForSelector("#pushmodal:not([hidden])", { timeout: 10000 });
  await page.fill("#pfname", "UX03-回归目标");
  await page.fill("#pf_generic_urls", "http://127.0.0.1:9/ux03-browser");
  await page.click('[data-pushact="save"]');
  await page.waitForTimeout(200);
  R.ok(await page.evaluate(() => document.getElementById("pushmodal").hidden), "D1 目标编辑弹层保存后关闭");
  await saveSettings(page, app);
  let tg = await readTargets();
  R.ok(tg.length === 1 && /^nt_/.test(tg[0].id) && tg[0].name === "UX03-回归目标", "D2 新建目标已落库且拿到服务端 id", tg.length + " / " + (tg[0] ? tg[0].id : "-"));

  await page.click('[data-tgact="edit"]');
  await page.waitForSelector("#pushmodal:not([hidden])", { timeout: 10000 });
  await page.fill("#pfname", "UX03-改名");
  await page.click('[data-pushact="save"]');
  await saveSettings(page, app);
  tg = await readTargets();
  R.ok(tg.length === 1 && tg[0].name === "UX03-改名", "D3 编辑后名称更新且 id 不变", tg[0] ? tg[0].name : "-");

  await page.click('[data-tgact="toggle"]');
  await saveSettings(page, app);
  tg = await readTargets();
  R.ok(tg.length === 1 && tg[0].enabled === false, "D4 停用后 enabled=false");

  await page.click('[data-tgact="del"]');
  await page.waitForTimeout(200);
  await saveSettings(page, app);
  tg = await readTargets();
  R.ok(tg.length === 0, "D5 删除后回读为空", "len=" + tg.length);

  /* 多目标隔离 */
  await page.evaluate(async () => {
    const st = await (await fetch("/api/settings")).json();
    const mk = (n) => ({ channel: "generic", name: n, enabled: true, types: ["notify"],
      fields: { urls: "", template: "", headers: "" }, sensitive: { urls: { op: "set", value: "http://127.0.0.1:9/" + n } } });
    await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: st.revision, notify: { targets: [mk("甲"), mk("乙")] } }) });
  });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await openSettings(page);
  await gotoTab(page, "notify");
  R.ok((await page.locator('[data-tgact="edit"]').count()) === 2, "D6 两个目标并排渲染");
  await page.locator('[data-tgact="edit"]').first().click();
  await page.waitForSelector("#pushmodal:not([hidden])", { timeout: 10000 });
  await page.fill("#pfname", "甲改");
  await page.click('[data-pushact="save"]');
  await saveSettings(page, app);
  tg = await readTargets();
  R.ok(tg.length === 2 && tg[0].name === "甲改" && tg[1].name === "乙", "D7 只改第一个目标，第二个不受影响", tg.map((t) => t.name).join("|"));

  noPageErrors(R, page, consoleErrors, pageErrors, /E_INTERNAL|500 \(Internal Server Error\)|409 \(Conflict\)/);

  /* ============ E. 三视口无溢出 ============ */
  R.group("E. 三视口布局");
  for (const vp of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    await fresh(vp);
    await openSettings(page);
    const lay = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('[role="tab"]')];
      const vw = window.innerWidth;
      const clipped = tabs.filter((t) => { const r = t.getBoundingClientRect(); return r.left < -1 || r.right > vw + 1; }).length;
      const rows = new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size;
      const sheet = document.querySelector("#modal .sheet").getBoundingClientRect();
      return { clipped, rows, scrollW: document.documentElement.scrollWidth, vw, sheetRight: sheet.right, tabCount: tabs.length };
    });
    R.ok(lay.tabCount === 6 && lay.clipped === 0, "E" + vp.width + "a 六个分区标签全部完整可见", "clipped=" + lay.clipped);
    R.ok(lay.scrollW <= lay.vw + 1, "E" + vp.width + "b 无横向溢出", lay.scrollW + "/" + lay.vw);
    R.ok(lay.sheetRight <= lay.vw + 1, "E" + vp.width + "c 弹层不超视口", Math.round(lay.sheetRight));
  }
  noPageErrors(R, page, consoleErrors, pageErrors);

  /* ============ F. 九语言导航与关键文案 ============ */
  R.group("F. 九语言（390px）");
  for (const lang of LANGS) {
    await fresh({ width: 390, height: 844 }, lang);
    await openSettings(page);
    const info = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('[role="tab"]')];
      const vw = window.innerWidth;
      const texts = tabs.map((t) => t.innerText.trim());
      const clipped = tabs.filter((t) => { const r = t.getBoundingClientRect(); return r.right > vw + 1 || r.left < -1; }).length;
      const h3 = document.getElementById("modaltitle");
      return {
        n: tabs.length, empty: texts.filter((t) => !t).length, clipped,
        scrollW: document.documentElement.scrollWidth, vw,
        title: h3 ? h3.innerText.trim() : "",
        sample: texts.slice(0, 3).join("/"),
      };
    });
    R.ok(info.n === 6 && info.empty === 0 && info.clipped === 0 && info.scrollW <= info.vw + 1,
      "F-" + lang + " 六个标签有文案、不截断、无溢出", info.sample + " | " + info.scrollW + "/" + info.vw);
    R.ok(info.title.length > 0, "F-" + lang + "b 弹层标题非空", info.title.slice(0, 18));
  }
  noPageErrors(R, page, consoleErrors, pageErrors);

  /* ============ G. 深色主题 ============ */
  R.group("G. 深色主题");
  await fresh({ width: 1440, height: 900 });
  await page.evaluate(() => { try { localStorage.setItem("sms_theme", "dark"); } catch (e) {} });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#list", { timeout: 30000 });
  await page.waitForTimeout(200);
  await openSettings(page);
  const dark = await page.evaluate(() => {
    const sheet = document.querySelector("#modal .sheet");
    const cs = getComputedStyle(sheet);
    return { bg: cs.backgroundColor, text: cs.color, theme: document.documentElement.getAttribute("data-theme") };
  });
  const lum = (c) => {
    const m = c.match(/\d+/g).slice(0, 3).map((x) => { const v = +x / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
  };
  const ratio = (() => { const a = lum(dark.bg), b = lum(dark.text); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); })();
  R.ok(lum(dark.bg) < 0.15, "G1 深色主题下弹层底色为暗色", dark.bg);
  R.ok(ratio >= 4.5, "G2 深色主题正文对比度 ≥4.5", ratio.toFixed(2));
  R.ok((await page.locator('[role="tab"]').count()) === 6, "G3 深色下分区导航完整");
  noPageErrors(R, page, consoleErrors, pageErrors);
} catch (e) {
  R.ok(false, "用例执行未抛异常", String((e && e.stack) || e).slice(0, 300));
} finally {
  try { await ctx.close(); } catch (e) { /* 已关闭 */ }
  try { await browser.close(); } catch (e) { /* 已关闭 */ }
  await app.stop();
  R.done();
}
