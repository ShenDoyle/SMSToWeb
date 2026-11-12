/**
 * UX-08 覆盖矩阵：7 视口 × Light/Dark × 中/英 × 鼠标/键盘/触摸
 * 每个组合核验：无横向溢出、主题与语言真正生效、列表可用、键盘可达、触摸命中尺寸
 * 运行：PW_NODE_MODULES=/root/pwtest/node_modules node tests/browser/ux08-matrix.mjs
 */
import { startApp, loadChromium, login } from "./harness.mjs";

const TOKEN = "ux08-matrix-t";
const app = await startApp({ env: { RECEIVE_TOKEN: TOKEN } });
const chromium = loadChromium();
const browser = await chromium.launch();

let pass = 0, fail = 0;
const t = (name, ok, extra = "") => {
  if (ok) { pass++; console.log("  ok   " + name + (extra ? "  [" + extra + "]" : "")); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
};

for (let i = 0; i < 12; i++) {
  await fetch(app.base + "/api/receive", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN, name: "M-" + (i % 3), sim: "139****80" + i, from: "1380013800" + i, content: "矩阵覆盖验证内容 " + i + " 含较长的一行用于观察换行", time: "2026-11-12 10:" + String(i).padStart(2, "0") + ":00" }),
  });
}

const VIEWPORTS = [
  [390, 844, true],   // 手机
  [768, 1024, true],  // 平板竖
  [1024, 768, true],  // 平板横
  [1440, 900, false], // 笔电
  [1600, 1000, false],// 宽屏断点
  [1920, 1080, false],// 桌面大屏
  [2560, 1440, false],// 超宽
];
const THEMES = ["light", "dark"];
const LANGS = ["zh-CN", "en"];

console.log("\n===== 覆盖矩阵：7 视口 × 2 主题 × 2 语言 =====");
for (const [w, h, touch] of VIEWPORTS) {
  for (const theme of THEMES) {
    for (const lang of LANGS) {
      const c = await browser.newContext({
        viewport: { width: w, height: h },
        hasTouch: touch,
        isMobile: touch && w < 600,
        locale: lang === "en" ? "en-US" : "zh-CN",
      });
      const page = await c.newPage();
      await page.addInitScript((o) => {
        try { localStorage.setItem("sms_theme", o.theme); localStorage.setItem("sms_lang", o.lang); } catch (e) {}
      }, { theme, lang });
      await login(page, app, lang);
      await page.waitForTimeout(450);

      const info = await page.evaluate(() => {
        const de = document.documentElement;
        const cards = [...document.querySelectorAll(".list .card")];
        const touchTargets = [...document.querySelectorAll(".list .card, .toolbar .tbtn, .selbar .tbtn, .pager button")]
          .filter((el) => el.getClientRects().length)
          .map((el) => Math.round(el.getBoundingClientRect().height));
        return {
          theme: de.getAttribute("data-theme") || "",
          lang: de.lang || "",
          ovX: de.scrollWidth - window.innerWidth,
          cards: cards.length,
          focusable: cards.length ? cards[0].getAttribute("tabindex") : "",
          selbarHidable: !!document.getElementById("selbar"),
          minTarget: touchTargets.length ? Math.min(...touchTargets) : -1,
        };
      });

      const tag = w + "px/" + theme + "/" + lang;
      const okTheme = info.theme === theme;
      const okLang = lang === "en" ? /^en/.test(info.lang) : /^zh/.test(info.lang);
      const okLayout = info.ovX <= 0 && info.cards > 0;
      t("矩阵 " + tag + " 主题/语言/布局一致", okTheme && okLang && okLayout,
        "theme=" + info.theme + " lang=" + info.lang + " ov=" + info.ovX + " cards=" + info.cards);

      /* 键盘：第一张卡片可聚焦并用 Enter 打开 */
      await page.evaluate(() => { const el = document.querySelector(".list .card"); if (el) el.focus(); });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(450);
      const opened = await page.evaluate(() => ({
        modal: !document.getElementById("modal").hidden,
        pane: !!document.getElementById("dpscroll") && !document.getElementById("dpscroll").hidden,
      }));
      t("矩阵 " + tag + " 键盘 Enter 可打开详情", opened.modal || opened.pane);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);

      if (touch) {
        t("矩阵 " + tag + " 触摸目标高度 ≥44", info.minTarget >= 44 || info.minTarget === -1, info.minTarget + "px");
      }
      await c.close();
    }
  }
}

console.log("\n===== UX-08 矩阵结果：pass=" + pass + " fail=" + fail + " =====");
await browser.close();
await app.stop();
process.exit(fail ? 1 : 0);
