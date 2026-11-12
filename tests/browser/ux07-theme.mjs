/**
 * UX-07A 主题同步浏览器回归（四种「系统主题 × 用户选择」组合）
 *
 * 运行：node tests/browser/ux07-theme.mjs   （需要 playwright；PW_NODE_MODULES 可指向安装目录）
 *
 * 覆盖：
 *  1. html[data-theme] 永远等于解析后的具体主题（不再依赖 media 查询）
 *  2. 页面底色跟随用户选择，而不是系统偏好
 *  3. Toast 使用反色令牌且对比度 ≥4.5，且不随系统偏好反向
 *  4. <meta name="theme-color"> 等于当前主题的 --ds-color-chrome
 *  5. 表单控件在深色下与卡片有可见层次
 *  6. 弹层表面使用 raised 表面
 *  7. 刷新后主题保持不变；切换主题后色带与 Toast 同步变化
 */
import { startApp, loadChromium, login, reporter, noPageErrors } from "./harness.mjs";

const app = await startApp({ env: { RECEIVE_TOKEN: "ux07-theme" } });
const R = reporter("UX-07A 主题同步");
const chromium = loadChromium();
const browser = await chromium.launch();
const results = [];

/* 一条带验证码的消息：让「验证码胶囊」等主色填充面出现在页面上 */
await fetch(app.base + "/api/receive", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: "ux07-theme", name: "Pixel-7", sim: "1069",
    from: "106903001234", content: "【测试】验证码 482913，5 分钟内有效。",
    time: "2026-11-12 10:20:00",
  }),
});

const lum = (c) => {
  const m = String(c).match(/[\d.]+/g).slice(0, 3).map(Number).map((x) => {
    const v = x / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
};
const contrast = (a, b) => {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** 打开一个组合上下文并采集主题相关计算值 */
async function probe(sysScheme, userTheme) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: sysScheme,
    locale: "zh-CN",
  });
  const page = await ctx.newPage();
  const consoleErrors = [], pageErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
  await page.addInitScript((t) => {
    try { localStorage.setItem("sms_theme", t); localStorage.setItem("sms_lang", "zh-CN"); } catch (e) {}
  }, userTheme);
  await login(page, app);
  await page.waitForTimeout(300);

  const m = await page.evaluate(() => {
    const root = document.documentElement;
    const tok = (n) => getComputedStyle(root).getPropertyValue(n).trim();
    /* 用真实 class 造一个 Toast 节点读取计算样式（不触发业务逻辑） */
    const t = document.createElement("div");
    t.className = "toast show";
    t.textContent = "提示";
    document.body.appendChild(t);
    const tcs = getComputedStyle(t);
    const toast = { bg: tcs.backgroundColor, fg: tcs.color };
    t.remove();
    const input = document.querySelector(".filters select") || document.querySelector(".ds-input");
    const ics = input ? getComputedStyle(input) : null;
    const meta = document.querySelector('meta[name="theme-color"]');
    return {
      attr: root.getAttribute("data-theme"),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      surface: tok("--ds-color-bg-surface"),
      chrome: tok("--ds-color-chrome"),
      meta: meta ? meta.getAttribute("content") : null,
      toast,
      field: ics ? { bg: ics.backgroundColor, border: ics.borderTopColor } : null,
      inverseBg: tok("--ds-color-inverse-bg"),
      inverseFg: tok("--ds-color-inverse-fg"),
    };
  });

  /* 打开设置中心，读弹层表面色 */
  await page.click("#setbtn");
  await page.waitForSelector("#scbody .sc-group", { timeout: 20000 });
  const sheetBg = await page.evaluate(() => getComputedStyle(document.querySelector("#modal .sheet")).backgroundColor);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  /* 刷新一次：主题必须保持不变 */
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#list", { timeout: 20000 });
  await page.waitForTimeout(300);
  const afterReload = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute("data-theme"),
    meta: (document.querySelector('meta[name="theme-color"]') || {}).getAttribute
      ? document.querySelector('meta[name="theme-color"]').getAttribute("content") : null,
  }));

  await ctx.close();
  return { m, sheetBg, afterReload, consoleErrors, pageErrors };
}

const COMBOS = [
  { sys: "light", user: "light", expect: "light" },
  { sys: "light", user: "dark", expect: "dark" },
  { sys: "dark", user: "dark", expect: "dark" },
  { sys: "dark", user: "light", expect: "light" },
];
for (const c of COMBOS) {
  R.group(`系统=${c.sys} 用户=${c.user} → 期望 ${c.expect}`);
  const { m, sheetBg, afterReload, consoleErrors, pageErrors } = await probe(c.sys, c.user);
  results.push({ combo: c.sys + "/" + c.user, ...m, sheetBg });
  const tag = `${c.sys}/${c.user}`;

  R.ok(m.attr === c.expect, `A data-theme 解析为 ${c.expect}`, m.attr);
  const wantBg = c.expect === "dark" ? "rgb(15, 18, 22)" : "rgb(242, 244, 246)";
  R.ok(m.bodyBg === wantBg, "B 页面底色与所选主题一致（系统偏好不覆盖）", m.bodyBg);
  R.ok(m.toast.bg === (c.expect === "dark" ? "rgb(233, 236, 239)" : "rgb(17, 24, 39)"),
    "C Toast 配色跟随所选主题（非系统偏好）", m.toast.bg);
  const tc = contrast(m.toast.fg, m.toast.bg);
  R.ok(tc >= 4.5, "D Toast 文字对比度 ≥4.5", tc.toFixed(2));
  R.ok(String(m.meta).toLowerCase() === String(m.chrome).toLowerCase(),
    "E theme-color 等于当前主题 --ds-color-chrome", m.meta + " vs " + m.chrome);
  R.ok(m.field && m.field.bg !== "", "F 表单控件有独立底面", m.field && m.field.bg);
  if (c.expect === "dark") {
    R.ok(m.field && m.field.bg !== m.surface, "G 深色下输入框与卡片不同色（可见）", m.field && m.field.bg);
  }
  R.ok(sheetBg === (c.expect === "dark" ? "rgb(29, 35, 41)" : "rgb(255, 255, 255)"),
    "H 弹层表面使用 raised 表面", sheetBg);
  R.ok(afterReload.attr === c.expect, "I 刷新后主题保持", afterReload.attr);
  R.ok(String(afterReload.meta).toLowerCase() === String(m.chrome).toLowerCase(),
    "J 刷新后 theme-color 仍与令牌一致", afterReload.meta);
  noPageErrors(R, { ok: R.ok }, consoleErrors, pageErrors);
}

/* 切换主题：色带与 Toast 同步 */
R.group("切换主题后同步");
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", locale: "zh-CN" });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem("sms_theme", "light"); } catch (e) {} });
  await login(page, app);
  const before = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute("data-theme"),
    meta: document.querySelector('meta[name="theme-color"]').getAttribute("content"),
  }));
  await page.click("#themebtn");
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => {
    const t = document.createElement("div");
    t.className = "toast show"; document.body.appendChild(t);
    const bg = getComputedStyle(t).backgroundColor; t.remove();
    return {
      attr: document.documentElement.getAttribute("data-theme"),
      meta: document.querySelector('meta[name="theme-color"]').getAttribute("content"),
      toast: bg,
      body: getComputedStyle(document.body).backgroundColor,
    };
  });
  R.ok(before.attr === "light" && after.attr === "dark", "K 点击主题按钮完成 light→dark", before.attr + "→" + after.attr);
  R.ok(after.body === "rgb(15, 18, 22)", "L 切换后页面立即变深", after.body);
  R.ok(after.meta === "#0f1216", "M 切换后 theme-color 同步为深色", after.meta);
  R.ok(after.toast === "rgb(233, 236, 239)", "N 切换后 Toast 同步反色", after.toast);
  await ctx.close();
}

console.log("\n组合汇总：" + JSON.stringify(results.map((r) => ({
  combo: r.combo, attr: r.attr, bodyBg: r.bodyBg, meta: r.meta, toast: r.toast.bg, sheet: r.sheetBg,
}))));

await browser.close();
await app.stop();
R.done();
