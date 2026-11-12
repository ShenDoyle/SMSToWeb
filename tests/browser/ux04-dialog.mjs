/**
 * FEAD-UX-04 · 设置中心 Dialog 可访问性与焦点管理（真实浏览器）
 *
 * 运行：node tests/browser/ux04-dialog.mjs   （退出码 0=全过，1=有失败）
 *
 * 覆盖任务书第二～五阶段：
 *  Dialog 语义（role / aria-modal / 可访问名称 / 隐藏即不可聚焦）
 *  打开时焦点落点、背景 inert 隔离
 *  Tab / Shift+Tab 焦点循环（含容器起点、回卷）
 *  Esc 逐层关闭（主弹层、目标编辑弹层、密码确认弹层）
 *  关闭后焦点返回实际触发元素
 *  状态条 role=status / alert 语义
 *  开关与分区的可访问名称、roving tabindex、focus-visible
 *  三视口 + 双主题
 */
import { loadChromium, startApp, newPage, login, openSettings, gotoTab, saveSettings, readStatus, reporter, noPageErrors } from "./harness.mjs";

const chromium = loadChromium();
const R = reporter("ux04-dialog");
const app = await startApp();
const browser = await chromium.launch({ args: ["--no-sandbox"] });
let page, ctx, consoleErrors, pageErrors;

async function fresh(vp, theme) {
  if (ctx) await ctx.close().catch(() => {});
  ({ ctx, page, consoleErrors, pageErrors } = await newPage(browser, { viewport: vp }));
  await login(page, app);
  if (theme === "dark") {
    await page.evaluate(() => { try { localStorage.setItem("sms_theme", "dark"); } catch (e) {} });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#list", { timeout: 30000 });
    await page.waitForTimeout(200);
  }
}

/* 造一个通知目标，供子弹层测试使用（敏感字段走三态，值指向 127.0.0.1，不会外发） */
async function seedTarget(page) {
  await page.evaluate(async () => {
    const st = await (await fetch("/api/settings")).json();
    const body = {
      revision: st.revision,
      notify: {
        targets: [{
          channel: "generic", name: "UX04-dialog", enabled: true, types: ["notify"],
          fields: { urls: "", template: "", headers: "" },
          sensitive: { urls: { op: "set", value: "http://127.0.0.1:9/ux04-dialog" } },
        }],
      },
    };
    await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  });
}

const activeInfo = () => page.evaluate(() => window.__a11y.active());
const focusables = (sel) => page.evaluate((s) => window.__a11y.focusables(s).length, sel);
const modalState = () => page.evaluate(() => {
  const m = document.getElementById("modal");
  const s = m.querySelector(".sheet");
  const lab = s.getAttribute("aria-labelledby");
  const t = lab ? document.getElementById(lab) : null;
  return {
    hidden: m.hidden, role: s.getAttribute("role"), modal: s.getAttribute("aria-modal"),
    labelledby: lab, labelText: t ? t.innerText.trim() : "",
    wrapInert: document.querySelector(".wrap").inert === true,
    activeInModal: m.contains(document.activeElement),
  };
});

try {
  /* ============ A. 主弹层语义 ============ */
  R.group("A. 主弹层 Dialog 语义");
  await fresh({ width: 1440, height: 900 });
  await page.click("#setbtn");
  await page.waitForSelector("#scbody .sc-group", { timeout: 20000 });
  let ms = await modalState();
  R.ok(ms.role === "dialog", "A1 主弹层 role=dialog", ms.role);
  R.ok(ms.modal === "true", "A2 主弹层 aria-modal=true", ms.modal);
  R.ok(!!ms.labelledby && ms.labelText.length > 0, "A3 aria-labelledby 指向存在的标题并取到文本", ms.labelledby + " → " + ms.labelText.slice(0, 24));
  R.ok(ms.activeInModal, "A4 打开后焦点落在弹层内部", JSON.stringify(await activeInfo()));
  R.ok(!ms.hidden, "A5 打开时弹层可见");

  /* ============ B. 背景隔离 ============ */
  R.group("B. 背景焦点隔离");
  R.ok(ms.wrapInert, "B1 背景 .wrap 被设为 inert");
  const bgReachable = await page.evaluate(() => {
    const a = document.activeElement;
    return a ? !!a.closest(".wrap") : false;
  });
  R.ok(!bgReachable, "B2 焦点此刻不在背景页面内");
  const pushHidden = await page.evaluate(() => document.getElementById("pushmodal").hidden && document.getElementById("pwdmodal").hidden);
  R.ok(pushHidden, "B3 未打开的子弹层保持 hidden");

  /* ============ C. Tab / Shift+Tab 循环 ============ */
  R.group("C. Tab 焦点循环");
  const n1 = await focusables("#modal .sheet");
  R.ok(n1 > 5, "C1 弹层内可聚焦元素被正确识别（>5）", "count=" + n1);
  /* 焦点停在容器上时，Tab 应进入第一个可聚焦元素 */
  await page.evaluate(() => document.querySelector("#modal .sheet").focus());
  await page.keyboard.press("Tab");
  let a1 = await page.evaluate(() => {
    const f = window.__a11y.focusables("#modal .sheet");
    return { isFirst: document.activeElement === f[0], id: document.activeElement.id };
  });
  R.ok(a1.isFirst, "C2 容器上按 Tab 进入首个可聚焦元素", a1.id);
  /* 第一个再 Shift+Tab 应回卷到最后一个 */
  await page.keyboard.press("Shift+Tab");
  let a2 = await page.evaluate(() => {
    const f = window.__a11y.focusables("#modal .sheet");
    return { isLast: document.activeElement === f[f.length - 1], id: document.activeElement.id };
  });
  R.ok(a2.isLast, "C3 首个元素 Shift+Tab 回卷到最后一个", a2.id);
  /* 最后一个 Tab 回卷到第一个 */
  await page.keyboard.press("Tab");
  let a3 = await page.evaluate(() => {
    const f = window.__a11y.focusables("#modal .sheet");
    return { isFirst: document.activeElement === f[0], id: document.activeElement.id };
  });
  R.ok(a3.isFirst, "C4 最后一个 Tab 回卷到第一个", a3.id);
  /* 连续 Tab 20 次，焦点始终不越界 */
  let escaped = 0, visited = new Set();
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    const st = await page.evaluate(() => {
      const m = document.getElementById("modal");
      return { inside: m.contains(document.activeElement), id: document.activeElement.id || document.activeElement.tagName };
    });
    if (!st.inside) escaped++;
    visited.add(st.id);
  }
  R.ok(escaped === 0, "C5 连续 20 次 Tab 焦点未逃出弹层", "visited=" + visited.size);
  /* 反向同理 */
  let escapedBack = 0;
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Shift+Tab");
    if (!(await page.evaluate(() => document.getElementById("modal").contains(document.activeElement)))) escapedBack++;
  }
  R.ok(escapedBack === 0, "C6 连续 12 次 Shift+Tab 焦点未逃出弹层");

  /* ============ D. Esc 关闭与焦点返回 ============ */
  R.group("D. Esc 关闭主弹层");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  let afterEsc = await page.evaluate(() => ({
    hidden: document.getElementById("modal").hidden,
    activeId: document.activeElement.id || document.activeElement.tagName,
    wrapInert: document.querySelector(".wrap").inert === true,
  }));
  R.ok(afterEsc.hidden, "D1 Esc 关闭主弹层");
  R.ok(afterEsc.activeId === "setbtn", "D2 关闭后焦点返回触发按钮 #setbtn", afterEsc.activeId);
  R.ok(!afterEsc.wrapInert, "D3 关闭后背景 inert 已解除");

  /* 关闭后隐藏弹层不参与焦点顺序 */
  const reach = await page.evaluate(() => {
    const m = document.getElementById("modal");
    const cs = getComputedStyle(m);
    return { hidden: m.hidden, display: cs.display };
  });
  R.ok(reach.hidden && reach.display === "none", "D4 关闭后弹层 display:none（不在可访问树）", reach.display);
  let hitModal = false;
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => document.getElementById("modal").contains(document.activeElement))) hitModal = true;
  }
  R.ok(!hitModal, "D5 弹层关闭后 Tab 不会进入其内部控件");
  await page.evaluate(() => document.getElementById("setbtn").focus());

  /* ============ E. 子弹层：通知目标编辑 ============ */
  R.group("E. 子弹层焦点与改道");
  await seedTarget(page);
  await page.click("#setbtn");
  await page.waitForSelector("#scbody .sc-group", { timeout: 20000 });
  await gotoTab(page, "notify");
  await page.waitForSelector('[data-tgact="edit"]', { timeout: 15000 });
  await page.click('[data-tgact="edit"]');
  await page.waitForSelector("#pushmodal:not([hidden])", { timeout: 10000 });
  await page.waitForTimeout(150);
  const pushSt = await page.evaluate(() => {
    const pm = document.getElementById("pushmodal");
    const sheet = pm.querySelector('[role="dialog"]');
    return {
      hidden: pm.hidden, activeInPush: pm.contains(document.activeElement),
      modalInert: document.getElementById("modal").inert === true,
      role: sheet.getAttribute("role"), modal: sheet.getAttribute("aria-modal"),
      labelText: (document.getElementById(sheet.getAttribute("aria-labelledby")) || {}).innerText || "",
    };
  });
  R.ok(pushSt.role === "dialog" && pushSt.modal === "true", "E1 子弹层具备 dialog + aria-modal");
  R.ok(pushSt.labelText.trim().length > 0, "E2 子弹层可访问名称非空", pushSt.labelText.trim().slice(0, 20));
  R.ok(pushSt.activeInPush, "E3 子弹层打开后焦点进入其内部");
  R.ok(pushSt.modalInert, "E4 子弹层打开时下层的设置弹层被 inert");
  /* 子弹层内 Tab 不越界 */
  let pushEscape = 0;
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press("Tab");
    if (!(await page.evaluate(() => document.getElementById("pushmodal").contains(document.activeElement)))) pushEscape++;
  }
  R.ok(pushEscape === 0, "E5 子弹层内 Tab 未越界到下层或背景");
  /* Esc 只关子弹层 */
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const afterPushEsc = await page.evaluate(() => ({
    pushHidden: document.getElementById("pushmodal").hidden,
    modalOpen: !document.getElementById("modal").hidden,
    activeId: document.activeElement.id,
    inModal: document.getElementById("modal").contains(document.activeElement),
  }));
  R.ok(afterPushEsc.pushHidden, "E6 Esc 关闭目标编辑弹层");
  R.ok(afterPushEsc.modalOpen, "E7 主弹层仍保持打开（未被连带关闭）");
  R.ok(afterPushEsc.inModal, "E8 关闭后焦点回到主弹层内（原触发按钮）", afterPushEsc.activeId);
  /* 连续第二次 Esc 才关主弹层 */
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  const afterSecond = await page.evaluate(() => ({
    modalHidden: document.getElementById("modal").hidden,
    activeId: document.activeElement.id || document.activeElement.tagName,
  }));
  R.ok(afterSecond.modalHidden, "E9 第二次 Esc 才关闭主弹层");
  R.ok(afterSecond.activeId === "setbtn", "E10 主弹层关闭后焦点仍回到 #setbtn", afterSecond.activeId);

  /* ============ F. 密码确认弹层 ============ */
  R.group("F. 密码确认弹层");
  await page.click("#setbtn");
  await page.waitForSelector("#scbody .sc-group", { timeout: 20000 });
  await gotoTab(page, "notify");
  await page.evaluate(() => { document.getElementById("scbody").dispatchEvent(new Event("change", { bubbles: true })); });
  await page.click("#scrsave");
  await page.waitForSelector("#pwdmodal:not([hidden])", { timeout: 10000 });
  const pwdSt = await page.evaluate(() => ({
    activeId: document.activeElement.id,
    inPwd: document.getElementById("pwdmodal").contains(document.activeElement),
    modalInert: document.getElementById("modal").inert === true,
  }));
  R.ok(pwdSt.inPwd && pwdSt.activeId === "pwdinput", "F1 密码弹层打开后焦点落在密码输入框", pwdSt.activeId);
  R.ok(pwdSt.modalInert, "F2 密码弹层打开时设置弹层被 inert");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const afterPwdEsc = await page.evaluate(() => ({
    pwdHidden: document.getElementById("pwdmodal").hidden,
    modalOpen: !document.getElementById("modal").hidden,
    inModal: document.getElementById("modal").contains(document.activeElement),
    activeId: document.activeElement.id,
  }));
  R.ok(afterPwdEsc.pwdHidden, "F3 Esc 关闭密码弹层");
  R.ok(afterPwdEsc.modalOpen, "F4 设置弹层未被连带关闭");
  R.ok(afterPwdEsc.inModal && afterPwdEsc.activeId === "scrsave", "F5 关闭后焦点回到保存按钮", afterPwdEsc.activeId);

  /* 关闭按钮 + 遮罩点击：焦点同样返回 */
  await page.click("#modalx");
  await page.waitForTimeout(200);
  const afterX = await page.evaluate(() => ({ hidden: document.getElementById("modal").hidden, activeId: document.activeElement.id }));
  R.ok(afterX.hidden && afterX.activeId === "setbtn", "F6 点关闭按钮关闭且焦点返回入口", afterX.activeId);
  await page.click("#setbtn");
  await page.waitForSelector("#scbody .sc-group", { timeout: 20000 });
  await page.mouse.click(6, 6); /* 左上角遮罩区域 */
  await page.waitForTimeout(250);
  const afterMask = await page.evaluate(() => ({ hidden: document.getElementById("modal").hidden, activeId: document.activeElement.id }));
  R.ok(afterMask.hidden, "F7 点击遮罩可关闭弹层");
  R.ok(afterMask.activeId === "setbtn", "F8 遮罩关闭后焦点回到入口", afterMask.activeId);

  /* ============ G. 辅助技术语义 ============ */
  R.group("G. 辅助技术语义");
  await page.click("#setbtn");
  await page.waitForSelector("#scbody .sc-group", { timeout: 20000 });
  const tabsInfo = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    return {
      count: tabs.length,
      selected: tabs.filter((t) => t.getAttribute("aria-selected") === "true").length,
      roving: tabs.filter((t) => t.getAttribute("tabindex") === "0").length,
      controls: tabs.every((t) => !!document.getElementById(t.getAttribute("aria-controls"))),
      label: document.getElementById("sctabs").getAttribute("aria-label") || "",
    };
  });
  R.ok(tabsInfo.count === 6, "G1 六个分区 tab 全部带 role=tab", "count=" + tabsInfo.count);
  R.ok(tabsInfo.selected === 1, "G2 只有一个分区 aria-selected=true", "selected=" + tabsInfo.selected);
  R.ok(tabsInfo.roving === 1, "G3 roving tabindex：只有一个 Tab 停靠点", "roving=" + tabsInfo.roving);
  R.ok(tabsInfo.controls, "G4 aria-controls 指向存在的内容容器");
  /* 首个开关有可访问名称与状态 */
  const sw = await page.evaluate(() => {
    const box = document.getElementById("scbody");
    const cbs = [...box.querySelectorAll('input[type="checkbox"]')];
    if (!cbs.length) return null;
    const c = cbs[0];
    const lb = c.getAttribute("aria-labelledby");
    const t = lb ? document.getElementById(lb) : null;
    const wrapLabel = c.closest("label");
    return {
      id: c.id, named: !!(t && t.innerText.trim().length > 0) || !!c.getAttribute("aria-label") || !!wrapLabel,
      role: c.getAttribute("role") || "checkbox", hasChecked: typeof c.checked === "boolean",
      text: (t ? t.innerText : (wrapLabel ? wrapLabel.innerText : "")).trim().slice(0, 24),
    };
  });
  R.ok(!!sw && sw.named, "G5 开关有可访问名称", sw ? sw.id + " → " + sw.text : "no checkbox");
  R.ok(!!sw && sw.hasChecked, "G6 开关暴露选中状态（checkbox.checked）");
  /* 分区切换后焦点仍留在 tablist 内 */
  await page.evaluate(() => document.querySelector('[data-sc-tab="display"]').focus());
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(180);
  const afterArrow = await page.evaluate(() => ({
    activeTab: document.activeElement.getAttribute("data-sc-tab"),
    selected: document.querySelector('[role="tab"][aria-selected="true"]').getAttribute("data-sc-tab"),
    inModal: document.getElementById("modal").contains(document.activeElement),
  }));
  R.ok(afterArrow.activeTab === afterArrow.selected && afterArrow.inModal, "G7 方向键切换分区后焦点跟随且仍在弹层内", afterArrow.activeTab);
  /* focus-visible 轮廓真实存在 */
  const outline = await page.evaluate(() => {
    const t = document.querySelector('[data-sc-tab="display"]');
    t.focus();
    const cs = getComputedStyle(t);
    return { w: cs.outlineWidth, style: cs.outlineStyle };
  });
  R.ok(outline.style !== "none" && parseFloat(outline.w) > 0, "G8 键盘聚焦有可见 focus-visible 轮廓", outline.style + " " + outline.w);

  /* 状态条语义：成功=status/polite，失败=alert/assertive */
  await gotoTab(page, "display");
  /* 制造一次真实变更（首页统计摘要开关），否则保存会走「无改动」分支不产生状态条 */
  await page.evaluate(() => {
    const c = document.getElementById("schomestats");
    c.checked = !c.checked;
    c.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await saveSettings(page, app);
  const stOk = await readStatus(page);
  R.ok(stOk && !stOk.hidden && stOk.role === "status", "G9 保存成功状态条 role=status", stOk ? stOk.role + "/" + stOk.text : "null");
  R.ok(stOk && stOk.live === "polite", "G10 保存成功用 polite 播报", stOk ? stOk.live : "");

  await page.evaluate(() => {
    /* 注入一次失败：让下一个 PUT 返回 500，验证错误态语义 */
    const of = window.fetch;
    window.__restoreFetch = () => { window.fetch = of; };
    window.fetch = function (u, o) {
      if (typeof u === "string" && u.indexOf("/api/settings") !== -1 && o && o.method === "PUT") {
        window.fetch = of;
        return Promise.resolve(new Response(JSON.stringify({ success: false, error: "E_INTERNAL" }), { status: 500, headers: { "Content-Type": "application/json" } }));
      }
      return of.apply(this, arguments);
    };
  });
  await gotoTab(page, "notify");
  await page.evaluate(() => { document.getElementById("scbody").dispatchEvent(new Event("change", { bubbles: true })); });
  await page.click("#scrsave");
  if (await page.locator("#pwdmodal").isVisible().catch(() => false)) {
    await page.fill("#pwdinput", app.password);
    await page.press("#pwdinput", "Enter");
  }
  await page.waitForTimeout(900);
  const stErr = await readStatus(page);
  R.ok(stErr && stErr.role === "alert", "G11 保存失败状态条 role=alert", stErr ? stErr.role + "/" + stErr.text.slice(0, 30) : "null");
  R.ok(stErr && stErr.live === "assertive", "G12 保存失败用 assertive 播报", stErr ? stErr.live : "");
  await page.evaluate(() => { if (window.__restoreFetch) window.__restoreFetch(); });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  noPageErrors(R, page, consoleErrors, pageErrors, /E_INTERNAL|500 \(Internal Server Error\)/);

  /* ============ H. 移动端 ============ */
  R.group("H. 移动端 390×844");
  await fresh({ width: 390, height: 844 });
  await page.click("#morebtn");
  await page.click("#mnuset");
  await page.waitForSelector("#scbody .sc-group", { timeout: 20000 });
  const m390 = await page.evaluate(() => {
    const m = document.getElementById("modal");
    const sheet = m.querySelector(".sheet");
    const r = sheet.getBoundingClientRect();
    return {
      activeInModal: m.contains(document.activeElement),
      inViewport: r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
      scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
      activeRect: (() => { const b = document.activeElement.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; })(),
    };
  });
  R.ok(m390.activeInModal, "H1 移动端打开后焦点在弹层内");
  R.ok(m390.inViewport, "H2 移动端弹层不超出视口");
  R.ok(m390.scrollW <= m390.innerW + 1, "H3 移动端无横向溢出", m390.scrollW + "/" + m390.innerW);
  R.ok(m390.activeRect.top >= -1 && m390.activeRect.bottom <= 844 + 1, "H4 初始焦点在可视区域内");
  /* 连续 Tab 焦点不会跑到屏幕外 */
  let offscreen = 0;
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const b = document.activeElement.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, inModal: document.getElementById("modal").contains(document.activeElement) };
    });
    if (!r.inModal) offscreen++;
    if (r.bottom < 0 || r.top > 844) offscreen++;
  }
  R.ok(offscreen === 0, "H5 移动端连续 Tab 焦点始终在弹层内且不落到屏幕外");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const mAfter = await page.evaluate(() => ({ hidden: document.getElementById("modal").hidden, activeId: document.activeElement.id }));
  R.ok(mAfter.hidden, "H6 移动端 Esc 关闭弹层");
  R.ok(mAfter.activeId === "morebtn", "H7 移动端关闭后焦点回到「更多」按钮（触发菜单项已收起时的回退）", mAfter.activeId);

  /* ============ I. 平板 + 深色 ============ */
  R.group("I. 768 与深色主题");
  await fresh({ width: 768, height: 1024 }, "dark");
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.click("#setbtn");
  await page.waitForSelector("#scbody .sc-group", { timeout: 20000 });
  const d768 = await page.evaluate(() => {
    const sheet = document.querySelector("#modal .sheet");
    const r = sheet.getBoundingClientRect();
    return {
      inModal: document.getElementById("modal").contains(document.activeElement),
      inViewport: r.left >= -1 && r.right <= window.innerWidth + 1,
      role: sheet.getAttribute("role"),
    };
  });
  R.ok(d768.role === "dialog" && d768.inModal, "I1 768 宽下语义与焦点一致");
  R.ok(d768.inViewport, "I2 768 宽下弹层不超出视口");
  R.ok(await page.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark") || /rgb\(2[0-9], 2[0-9], 3[0-9]\)/.test(darkBg),
    "I3 深色主题已生效", darkBg);
  /* 深色下 Esc 与焦点返回同样成立 */
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const dAfter = await page.evaluate(() => ({ hidden: document.getElementById("modal").hidden, activeId: document.activeElement.id }));
  R.ok(dAfter.hidden && dAfter.activeId === "setbtn", "I4 深色下 Esc 与焦点返回一致", dAfter.activeId);

  noPageErrors(R, page, consoleErrors, pageErrors, /E_INTERNAL/);
} catch (e) {
  R.ok(false, "用例执行未抛异常", String((e && e.stack) || e).slice(0, 300));
} finally {
  try { await ctx.close(); } catch (e) { /* 已关闭 */ }
  try { await browser.close(); } catch (e) { /* 已关闭 */ }
  await app.stop();
  R.done();
}
