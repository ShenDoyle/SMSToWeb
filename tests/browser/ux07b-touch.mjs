/**
 * UX-07B 运行时验证：触屏命中区、首屏密度、遮罩、平板/桌面工具栏布局
 * 运行：PW_NODE_MODULES=/root/pwtest/node_modules node tests/browser/ux07b-touch.mjs
 */
import { startApp, loadChromium, login } from "./harness.mjs";

const app = await startApp({ env: { RECEIVE_TOKEN: "ux07b-touch-t" } });
const chromium = loadChromium();
const browser = await chromium.launch();

let pass = 0, fail = 0;
const t = (name, ok, extra = "") => {
  if (ok) { pass++; console.log("  ok   " + name + (extra ? "  [" + extra + "]" : "")); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
};

for (const [name, sim, from, content, time] of [
  ["Pixel-7", "1069****001", "106903001234", "【某银行】验证码 482913，5分钟内有效，请勿泄露。", "2026-11-12 10:18:00"],
  ["Mi-14", "139****8888", "13800138000", "晚点到，先吃别等我。", "2026-11-12 08:41:00"],
]) {
  await fetch(app.base + "/api/receive", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "ux07b-touch-t", name, sim, from, content, time }),
  });
}

async function touchCtx(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: w < 600, locale: "zh-CN" });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem("sms_theme", "light"); localStorage.setItem("sms_lang", "zh-CN"); } catch (e) {} });
  await login(page, app);
  await page.waitForTimeout(700);
  return { ctx, page };
}
const measure = (page, sel) => page.evaluate((sel) => {
  const el = [...document.querySelectorAll(sel)].find((n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { w: Math.round(b.width), h: Math.round(b.height) };
}, sel);

console.log("\n===== UX-07B 触屏（390×844）=====");
{
  const { ctx, page } = await touchCtx(390, 844);
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  t("A1 无横向溢出", ov === 0, "overflowX=" + ov);
  const top = await page.evaluate(() => {
    const c = document.querySelector(".list .card");
    return c ? Math.round(c.getBoundingClientRect().top / window.innerHeight * 100) : null;
  });
  t("A2 首条消息在视口 30% 以内出现", top !== null && top <= 30, top + "%");
  for (const [sel, label, min] of [
    [".filter-tabs .chip", "视图标签", 44],
    ["#filterbtn", "筛选按钮", 44],
    ["#q", "搜索框", 44],
    [".msg-actions .star", "收藏", 44],
    [".msg-actions .del", "删除", 44],
    [".code-chip .copy", "复制验证码", 44],
    [".pages button", "分页按钮", 44],
    ["#jump", "页码输入", 44],
    ["#gojump", "跳转", 44],
    ["#themebtn", "主题切换", 44],
  ]) {
    const m = await measure(page, sel);
    t("B " + label + " 命中区 ≥" + min, m && m.w >= min && m.h >= min, m ? m.w + "×" + m.h : "缺失");
  }
  const rowCount = await page.evaluate(() => {
    const els = [".filter-tabs", ".filter-row"].map((s) => document.querySelector(s)).filter(Boolean);
    return new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size;
  });
  t("C1 手机端筛选区纵向两行（不挤压）", rowCount === 2, "行数=" + rowCount);
  await ctx.close();
}

console.log("\n===== UX-07B 平板（768×1024，触屏）=====");
{
  const { ctx, page } = await touchCtx(768, 1024);
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  t("D1 无横向溢出", ov === 0, "overflowX=" + ov);
  const geo = await page.evaluate(() => {
    const tabs = document.querySelector(".filter-tabs").getBoundingClientRect();
    const ref = document.querySelector(".toolbar-refresh").getBoundingClientRect();
    const row = document.querySelector(".filter-row").getBoundingClientRect();
    return { sameRow: Math.abs(tabs.top - ref.top) < 12, rowBelow: row.top > tabs.bottom - 4, refRight: ref.right > tabs.right };
  });
  t("D2 刷新与视图标签同行", geo.sameRow);
  t("D3 搜索与筛选在下一行", geo.rowBelow);
  t("D4 刷新靠右", geo.refRight);
  const m = await measure(page, ".filter-tabs .chip");
  t("D5 平板触屏标签 44", m && m.h >= 44, m ? m.w + "×" + m.h : "缺失");
  await ctx.close();
}

console.log("\n===== UX-07B 桌面（1440×900）=====");
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem("sms_theme", "light"); localStorage.setItem("sms_lang", "zh-CN"); } catch (e) {} });
  await login(page, app);
  await page.waitForTimeout(700);
  const geo = await page.evaluate(() => {
    const tabs = document.querySelector(".filter-tabs").getBoundingClientRect();
    const ref = document.querySelector(".toolbar-refresh").getBoundingClientRect();
    const tb = document.querySelector(".toolbar").getBoundingClientRect();
    return { sameRow: Math.abs(tabs.top - ref.top) < 12, toolbarH: Math.round(tb.height) };
  });
  t("E1 桌面工具栏单行（标签与刷新同行）", geo.sameRow);
  t("E2 桌面工具栏高度 ≤60px（原两行约 96px）", geo.toolbarH <= 60, "toolbarH=" + geo.toolbarH);
  const top = await page.evaluate(() => Math.round(document.querySelector(".list .card").getBoundingClientRect().top / window.innerHeight * 100));
  t("E3 首条消息在视口 25% 以内", top <= 25, top + "%");
  await ctx.close();
}

console.log("\n===== UX-07B 遮罩（详情弹层）=====");
for (const theme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, locale: "zh-CN" });
  const page = await ctx.newPage();
  await page.addInitScript((th) => { try { localStorage.setItem("sms_theme", th); localStorage.setItem("sms_lang", "zh-CN"); } catch (e) {} }, theme);
  await login(page, app);
  await page.waitForTimeout(600);
  await page.click(".card .content");
  await page.waitForTimeout(500);
  const alpha = await page.evaluate(() => {
    const bg = getComputedStyle(document.querySelector(".modal")).backgroundColor;
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(",").map((x) => parseFloat(x.trim()));
    return parts.length === 4 ? parts[3] : 1;
  });
  t("F " + theme + " 遮罩为半透明且来自令牌", alpha !== null && alpha > 0.3 && alpha < 0.8, "alpha=" + alpha);
  await ctx.close();
}

console.log("\n===== UX-07B 结果：pass=" + pass + " fail=" + fail + " =====");
await browser.close();
await app.stop();
process.exit(fail ? 1 : 0);
