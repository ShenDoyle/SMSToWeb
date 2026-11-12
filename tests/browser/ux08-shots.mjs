/**
 * UX-08 证据截图（仓库外）：D:\OpenClaw\_ux08\shots
 * 运行：PW_NODE_MODULES=/root/pwtest/node_modules node tests/browser/ux08-shots.mjs
 */
import { mkdirSync } from "node:fs";
import { startApp, loadChromium, login } from "./harness.mjs";

const OUT = "/mnt/d/OpenClaw/_ux08/shots";
mkdirSync(OUT, { recursive: true });

const TOKEN = "ux08-shots-t";
const app = await startApp({ env: { RECEIVE_TOKEN: TOKEN } });
const chromium = loadChromium();
const browser = await chromium.launch();

for (let i = 0; i < 14; i++) {
  await fetch(app.base + "/api/receive", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN, name: ["Pixel-7", "Mi-14", "NAS-A7"][i % 3], sim: "139****70" + i, from: "1380013800" + i, content: "【验证码】您的登录验证码为 " + (100000 + i) + "，5 分钟内有效。", time: "2026-11-12 10:" + String(i).padStart(2, "0") + ":00" }),
  });
}

async function ctx(w, h, opts = {}) {
  const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: !!opts.touch, isMobile: !!opts.touch && w < 600, locale: "zh-CN", deviceScaleFactor: 1 });
  const page = await c.newPage();
  await page.addInitScript((o) => {
    try { localStorage.setItem("sms_theme", o.theme || "light"); localStorage.setItem("sms_lang", o.lang || "zh-CN"); } catch (e) {}
  }, { theme: opts.theme, lang: opts.lang });
  await login(page, app, opts.lang || "zh-CN");
  await page.waitForTimeout(600);
  return { c, page };
}

async function shot(page, name) {
  await page.screenshot({ path: OUT + "/" + name + ".png" });
  console.log("  shot " + name);
}

/* 1. 双栏 1920 选中态 */
{
  const { c, page } = await ctx(1920, 1080);
  await page.evaluate(() => document.querySelector(".list .card").click());
  await page.waitForTimeout(600);
  await shot(page, "01-split-1920-selected");
  await c.close();
}

/* 2. 1600 边界 */
{
  const { c, page } = await ctx(1600, 1000);
  await page.evaluate(() => document.querySelectorAll(".list .card")[2].click());
  await page.waitForTimeout(600);
  await shot(page, "02-split-1600");
  await c.close();
}

/* 3/4. Toast 三种类型（浅色 / 深色） */
for (const theme of ["light", "dark"]) {
  const { c, page } = await ctx(1440, 900, { theme });
  await page.click("#setbtn");
  await page.waitForSelector("#scbody .sc-group", { timeout: 20000 });
  await page.click('[data-sc-tab="display"]');
  await page.waitForTimeout(250);
  await page.evaluate(() => { const r = document.getElementById("toastroot"); if (r) r.innerHTML = ""; });
  await page.evaluate(() => { for (let i = 0; i < 4; i++) document.getElementById("scrsave").click(); });
  await page.waitForTimeout(500);
  await shot(page, "03-toast-stack-" + theme);
  await page.waitForTimeout(4200);
  await c.close();
}

/* 5. 输入弹窗（含校验失败就地回显） */
{
  const { c, page } = await ctx(1440, 900);
  await page.route("**/api/devices/alias", async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: false, error: "ALIAS_INVALID" }) });
  });
  await page.click("#devbtn");
  await page.waitForTimeout(600);
  await page.click('.devrow [data-dvact="rename"]');
  await page.waitForTimeout(400);
  await page.fill("#dspInput", "客厅手机");
  await page.evaluate(() => document.getElementById("dspOk").click());
  await page.waitForTimeout(900);
  await shot(page, "04-dsprompt-fail-inline");
  await c.close();
}

/* 6. 键盘焦点环 */
{
  const { c, page } = await ctx(1440, 900);
  await page.evaluate(() => document.querySelectorAll(".list .card")[1].focus());
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(250);
  await shot(page, "05-keyboard-focus-ring");
  await c.close();
}

/* 7. 移动端详情底部按钮（换行均分） */
{
  const { c, page } = await ctx(390, 844, { touch: true });
  await page.evaluate(() => document.querySelector(".list .card .summary").click());
  await page.waitForTimeout(700);
  await shot(page, "06-mobile-detail-actions");
  await page.waitForTimeout(3000);
  await c.close();
}

/* 8. 移动端提示条（不溢出） */
{
  const { c, page } = await ctx(390, 844, { touch: true });
  await page.click("#morebtn");
  await page.click("#mnuset");
  await page.waitForSelector("#scbody .sc-group", { timeout: 20000 });
  await page.click('[data-sc-tab="display"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => { const r = document.getElementById("toastroot"); if (r) r.innerHTML = ""; });
  await page.evaluate(() => { for (let i = 0; i < 3; i++) document.getElementById("scrsave").click(); });
  await page.waitForTimeout(450);
  await shot(page, "07-mobile-toast");
  await page.waitForTimeout(4200);
  await c.close();
}

await browser.close();
await app.stop();
console.log("done → " + OUT);
process.exit(0);
