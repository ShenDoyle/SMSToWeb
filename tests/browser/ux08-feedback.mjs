/**
 * UX-08 反馈与弹层规范运行时验证
 *   A. Toast 类型 / 时长 / 堆叠 / 无障碍语义
 *   B. Toast 小屏适配 / 深浅主题可读性 / 多语言关闭标签
 *   C. Dialog 行为：遮罩关闭、滚动锁定、多层栈、提交中禁关闭、失败保留输入
 * 运行：PW_NODE_MODULES=/root/pwtest/node_modules node tests/browser/ux08-feedback.mjs
 */
import { startApp, loadChromium, login } from "./harness.mjs";

const TOKEN = "ux08-fb-t";
const app = await startApp({ env: { RECEIVE_TOKEN: TOKEN } });
const chromium = loadChromium();
const browser = await chromium.launch();

let pass = 0, fail = 0;
const t = (name, ok, extra = "") => {
  if (ok) { pass++; console.log("  ok   " + name + (extra ? "  [" + extra + "]" : "")); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
};

for (let i = 0; i < 6; i++) {
  await fetch(app.base + "/api/receive", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN, name: "FB-" + i, sim: "139****90" + i, from: "1380013800" + i, content: "反馈规范验证内容 " + i, time: "2026-11-12 11:0" + i + ":00" }),
  });
}

async function ctx(w, h, opts = {}) {
  const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: !!opts.touch, isMobile: !!opts.touch && w < 600, locale: "zh-CN" });
  const page = await c.newPage();
  await page.addInitScript((o) => {
    try { localStorage.setItem("sms_theme", o.theme || "light"); localStorage.setItem("sms_lang", o.lang || "zh-CN"); } catch (e) {}
  }, { theme: opts.theme, lang: opts.lang });
  await login(page, app, opts.lang || "zh-CN");
  await page.waitForTimeout(600);
  return { c, page };
}

/* 打开设置中心 → 显示分区（该分区保存是本浏览器偏好，不需要密码，最省事的「真实提示源」） */
async function openDisplay(page) {
  const vw = page.viewportSize().width;
  if (vw <= 560) { await page.click("#morebtn"); await page.click("#mnuset"); }
  else await page.click("#setbtn");
  await page.waitForSelector("#scbody .sc-group", { timeout: 20000 });
  await page.click('[data-sc-tab="display"]');
  await page.waitForTimeout(220);
}

const toastInfo = (page) => page.evaluate(() => {
  const list = [...document.querySelectorAll("#toastroot .toast")];
  return list.map((el) => {
    const cs = getComputedStyle(el);
    const dot = el.querySelector(".toast-dot");
    const close = el.querySelector(".toast-close");
    return {
      cls: el.className,
      type: (el.className.match(/toast--(\w+)/) || [])[1] || "",
      role: el.getAttribute("role") || "",
      aria: el.querySelector(".toast-txt") ? el.querySelector(".toast-txt").textContent : "",
      bg: cs.backgroundColor,
      fg: cs.color,
      dotColor: dot ? getComputedStyle(dot).backgroundColor : "",
      closeLabel: close ? (close.getAttribute("aria-label") || "") : "",
      rect: el.getBoundingClientRect().toJSON(),
      visible: !!(el.getBoundingClientRect().width && cs.opacity !== "0"),
    };
  });
});

/* ============ A. Toast 类型 / 时长 / 堆叠 ============ */
console.log("\n===== A. Toast 类型 / 时长 / 堆叠 =====");
{
  const { c, page } = await ctx(1440, 900);
  await openDisplay(page);
  await page.evaluate(() => { const r = document.getElementById("toastroot"); if (r) r.innerHTML = ""; });

  /* 无改动保存 → warning（常驻 3600ms，可手动关闭） */
  await page.click("#scrsave");
  await page.waitForTimeout(400);
  let list = await toastInfo(page);
  t("A1 警告类提示带类型类名", list.length === 1 && list[0].type === "warning", list[0] ? list[0].cls : "none");
  t("A2 警告提示为打断式播报（role=alert）", list[0] && list[0].role === "alert", list[0] ? list[0].role : "");
  t("A3 警告提示常驻可手动关闭", !!(list[0] && list[0].closeLabel), list[0] ? list[0].closeLabel : "");
  t("A4 提示条有类型标记点与正文", !!(list[0] && list[0].dotColor && list[0].aria.length > 0), list[0] ? list[0].aria : "");

  /* 时长：3600ms 自动消失（2.2s 仍在，4.2s 已消失） */
  await page.waitForTimeout(1800);
  const alive22 = (await toastInfo(page)).length;
  await page.waitForTimeout(2000);
  const alive42 = (await toastInfo(page)).length;
  t("A5 警告提示在 2.2s 仍可见", alive22 === 1, "n=" + alive22);
  t("A6 警告提示约 3.6s 后自动消失", alive42 === 0, "n=" + alive42);

  /* 堆叠：连点 5 次保存，最多保留 3 条 */
  await page.evaluate(() => { const r = document.getElementById("toastroot"); if (r) r.innerHTML = ""; });
  for (let i = 0; i < 5; i++) { await page.click("#scrsave"); await page.waitForTimeout(80); }
  await page.waitForTimeout(350);
  const stacked = await toastInfo(page);
  t("A7 堆叠上限为 3 条（小屏不被提示条盖满）", stacked.length === 3, "n=" + stacked.length);
  const order = await page.evaluate(() => {
    const list = [...document.querySelectorAll("#toastroot .toast")];
    const ys = list.map((el) => Math.round(el.getBoundingClientRect().top));
    return { ys, sortedDesc: ys.every((y, i) => i === 0 || y >= ys[i - 1]) };
  });
  t("A8 最新提示靠近底部、旧提示向上堆叠", order.sortedDesc, order.ys.join(","));
  await c.close();
}

/* ============ B. 小屏 / 主题 / 多语言 ============ */
console.log("\n===== B. Toast 小屏 / 主题 / 多语言 =====");
{
  /* B1 小屏不溢出、不贴边 */
  const small = await ctx(390, 844, { touch: true });
  await openDisplay(small.page);
  await small.page.evaluate(() => { const r = document.getElementById("toastroot"); if (r) r.innerHTML = ""; });
  await small.page.evaluate(() => { for (let i = 0; i < 4; i++) document.getElementById("scrsave").click(); });
  await small.page.waitForTimeout(500);
  const sm = await toastInfo(small.page);
  const inView = sm.every((x) => x.rect.left >= 0 && x.rect.right <= 390.5 && x.rect.bottom <= 844.5);
  const noOverflow = await small.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  t("B1 小屏提示条全部落在视口内", inView && sm.length > 0, sm.length ? "left=" + Math.round(sm[0].rect.left) + " right=" + Math.round(sm[0].rect.right) : "none");
  t("B2 小屏提示条不产生横向溢出", noOverflow <= 0, "ov=" + noOverflow);
  await small.c.close();

  /* B3 深色主题下类型标记在反色底上可读（对比度 ≥ 3:1） */
  const lum = (rgb) => {
    const m = rgb.match(/\d+/g).map(Number).slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
  for (const theme of ["light", "dark"]) {
    const t1 = await ctx(1440, 900, { theme });
    await openDisplay(t1.page);
    await t1.page.evaluate(() => { const r = document.getElementById("toastroot"); if (r) r.innerHTML = ""; });
    await t1.page.click("#scrsave");
    await t1.page.waitForTimeout(400);
    const one = (await toastInfo(t1.page))[0];
    const dotC = one ? ratio(one.dotColor, one.bg) : 0;
    const txtC = one ? ratio(one.fg, one.bg) : 0;
    t("B3 " + theme + " 主题：正文对提示底色对比 ≥ 4.5", txtC >= 4.5, txtC.toFixed(2));
    t("B4 " + theme + " 主题：类型标记可辨（≥ 3:1）", dotC >= 3, dotC.toFixed(2));
    await t1.c.close();
  }

  /* B5 多语言关闭标签 */
  const en = await ctx(1440, 900, { lang: "en" });
  await openDisplay(en.page);
  await en.page.evaluate(() => { const r = document.getElementById("toastroot"); if (r) r.innerHTML = ""; });
  await en.page.click("#scrsave");
  await en.page.waitForTimeout(400);
  const enToast = (await toastInfo(en.page))[0];
  t("B5 英文下关闭按钮标签为本地化文案", !!enToast && enToast.closeLabel === "Close", enToast ? enToast.closeLabel : "");
  await en.c.close();
}

/* ============ C. Dialog 行为规范 ============ */
console.log("\n===== C. Dialog 行为规范 =====");
{
  const { c, page } = await ctx(1440, 900);

  /* C1/C2 遮罩点击关闭 + 背景滚动锁定 */
  await page.click("#devbtn");
  await page.waitForTimeout(700);
  const locked = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).overflow,
    body: getComputedStyle(document.body).overflow,
    scrollY: window.scrollY,
  }));
  t("C1 弹层打开时锁住背景滚动", locked.html === "hidden" && locked.body === "hidden", locked.html + "/" + locked.body);

  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  const afterWheel = await page.evaluate(() => window.scrollY);
  t("C2 弹层期间滚轮不带动背景", Math.abs(afterWheel - locked.scrollY) < 4, "Δ=" + (afterWheel - locked.scrollY));

  await page.mouse.click(20, 400); /* 遮罩空白处 */
  await page.waitForTimeout(400);
  const afterMask = await page.evaluate(() => ({
    modal: document.getElementById("modal").hidden,
    html: getComputedStyle(document.documentElement).overflow,
  }));
  t("C3 点遮罩空白处关闭弹层", afterMask.modal === true);
  t("C4 关闭后恢复背景滚动", afterMask.html !== "hidden", afterMask.html);

  /* C5 提交中禁止关闭 + C6 失败保留输入 */
  await page.route("**/api/devices/alias", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: false, error: "ALIAS_INVALID" }) });
  });
  await page.click("#devbtn");
  await page.waitForTimeout(600);
  await page.click('.devrow [data-dvact="rename"]');
  await page.waitForTimeout(400);
  await page.fill("#dspInput", "客厅手机-改名");
  await page.evaluate(() => document.getElementById("dspOk").click());
  await page.waitForTimeout(300);
  const busy = await page.evaluate(() => ({
    okDisabled: document.getElementById("dspOk").disabled,
    cancelDisabled: document.getElementById("dspCancel").disabled,
    open: !document.getElementById("dsprompt").hidden,
  }));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const stillOpen = await page.evaluate(() => !document.getElementById("dsprompt").hidden);
  t("C5 提交中禁用主按钮与取消按钮", busy.okDisabled && busy.cancelDisabled);
  t("C6 提交中按 Esc 不关闭弹窗（不中断请求）", stillOpen === true);

  await page.waitForTimeout(1600);
  const failed = await page.evaluate(() => ({
    open: !document.getElementById("dsprompt").hidden,
    val: document.getElementById("dspInput").value,
    err: (document.getElementById("dspErr") || {}).textContent || "",
    errHidden: document.getElementById("dspErr").hidden,
    okEnabled: !document.getElementById("dspOk").disabled,
  }));
  t("C7 失败后弹窗保留且可重试", failed.open && failed.okEnabled);
  t("C8 失败后保留用户已输入内容", failed.val === "客厅手机-改名", failed.val);
  t("C9 失败原因就地回显（不靠 toast 甩锅）", !failed.errHidden && failed.err.length > 0, failed.err);
  await c.close();
}

console.log("\n===== UX-08 反馈/弹层结果：pass=" + pass + " fail=" + fail + " =====");
await browser.close();
await app.stop();
process.exit(fail ? 1 : 0);
