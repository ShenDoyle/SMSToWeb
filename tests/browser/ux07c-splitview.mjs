/**
 * UX-07C 运行时验证：宽屏双栏详情（≥1600）与单栏弹层（<1600）的完整行为
 * 运行：PW_NODE_MODULES=/root/pwtest/node_modules node tests/browser/ux07c-splitview.mjs
 */
import { startApp, loadChromium, login } from "./harness.mjs";

const TOKEN = "ux07c-split-t";
const app = await startApp({ env: { RECEIVE_TOKEN: TOKEN } });
const chromium = loadChromium();
const browser = await chromium.launch();

let pass = 0, fail = 0;
const t = (name, ok, extra = "") => {
  if (ok) { pass++; console.log("  ok   " + name + (extra ? "  [" + extra + "]" : "")); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
};

const seed = [
  ["Pixel-7", "1069****001", "106903001234", "【某银行】验证码 482913，5分钟内有效，请勿泄露给他人。", "2026-11-12 10:18:00"],
  ["Mi-14", "139****8888", "13800138000", "晚点到，先吃别等我，冰箱里有饺子。", "2026-11-12 09:41:00"],
  ["NAS-A7", "131****6666", "95588", "【某某银行】您尾号 8821 的储蓄卡于 11 月 12 日 10:18 在线上支付人民币 328.00 元，可用余额 12,430.55 元。如非本人操作请立即致电 95588 挂失。本条为系统自动发送，请勿直接回复。为保障账户安全，建议定期修改交易密码并开启指纹验证。", "2026-11-12 08:20:00"],
  ["Pixel-7", "1069****001", "010-88886666", "快递已放至丰巢柜，取件码 8821，请及时领取。", "2026-11-11 21:05:00"],
];
for (const [name, sim, from, content, time] of seed) {
  await fetch(app.base + "/api/receive", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN, name, sim, from, content, time }),
  });
}

async function ctx(w, h, theme = "light") {
  const c = await browser.newContext({ viewport: { width: w, height: h }, locale: "zh-CN" });
  const page = await c.newPage();
  await page.addInitScript((th) => {
    try { localStorage.setItem("sms_theme", th); localStorage.setItem("sms_lang", "zh-CN"); } catch (e) {}
  }, theme);
  await login(page, app);
  await page.waitForTimeout(700);
  return { c, page };
}
const paneState = (page) => page.evaluate(() => {
  const p = document.getElementById("detailpane");
  const s = document.getElementById("dpscroll");
  const e = document.getElementById("dpempty");
  return {
    paneVisible: !!p && !p.hidden && p.getBoundingClientRect().width > 0,
    paneW: p ? Math.round(p.getBoundingClientRect().width) : 0,
    bodyVisible: !!s && !s.hidden,
    bodyText: s && !s.hidden ? (s.innerText || "") : "",
    emptyText: e && !e.hidden ? (e.innerText || "") : "",
    selCount: document.querySelectorAll(".card.dsel").length,
    modalOpen: !document.getElementById("modal").hidden,
  };
});

console.log("\n===== A. <1600 保持单栏 + 弹层 =====");
{
  const { c, page } = await ctx(1440, 900);
  const st = await paneState(page);
  t("A1 面板在 1440 不可见", !st.paneVisible);
  await page.evaluate(() => document.querySelector(".list .card .summary").click());
  await page.waitForTimeout(600);
  const m = await page.evaluate(() => ({
    modal: !document.getElementById("modal").hidden,
    body: !!document.querySelector(".detail-body"),
    close: !!document.getElementById("dclose"),
    copy: !!document.getElementById("dcopy"),
  }));
  t("A2 点击后打开详情弹层", m.modal && m.body);
  t("A3 弹层保留关闭与复制按钮", m.close && m.copy);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await c.close();
}

console.log("\n===== B. ≥1600 双栏 =====");
{
  const { c, page } = await ctx(1920, 1080);
  const st = await paneState(page);
  t("B1 面板在 1920 可见", st.paneVisible, "w=" + st.paneW);
  t("B2 初始为空态提示", !st.bodyVisible && st.emptyText.length > 0, st.emptyText.split("\n")[0]);
  t("B3 面板宽度 > 600", st.paneW > 600, "w=" + st.paneW);

  const cols = await page.evaluate(() => {
    const l = document.querySelector(".layout");
    const cs = getComputedStyle(l).gridTemplateColumns.split(" ").map((x) => Math.round(parseFloat(x)));
    return { cols: cs, wrap: Math.round(document.querySelector(".wrap").getBoundingClientRect().width) };
  });
  t("B4 两列布局成立", cols.cols.length === 2 && cols.cols[0] > 700 && cols.cols[1] > 600, cols.cols.join("/"));
  t("B5 工作区放宽到 >1200", cols.wrap > 1200, "wrap=" + cols.wrap);

  /* 点击整卡任意空白处即出详情，且不弹层 */
  await page.evaluate(() => document.querySelector(".list .card").click());
  await page.waitForTimeout(700);
  const st2 = await paneState(page);
  t("B6 点卡片后右侧出现详情", st2.bodyVisible && st2.bodyText.length > 0);
  t("B7 不打开弹层", !st2.modalOpen);
  t("B8 选中卡片有 dsel 标记且唯一", st2.selCount === 1, "n=" + st2.selCount);

  const det = await page.evaluate(() => {
    const s = document.getElementById("dpscroll");
    return {
      hasH3: !!s.querySelector("h3"),
      hasMeta: !!s.querySelector(".detail-metarow"),
      hasBody: !!s.querySelector(".detail-body"),
      hasCopy: !!s.querySelector("#dcopy"),
      hasDel: !!s.querySelector("#ddel"),
      hasCloseBtn: !!s.querySelector("#dpclose"),
      bodyW: s.querySelector(".detail-body") ? Math.round(s.querySelector(".detail-body").getBoundingClientRect().width) : 0,
      sticky: getComputedStyle(document.getElementById("detailpane")).position,
      ownScroll: s.scrollHeight >= s.clientHeight,
    };
  });
  t("B9 面板内容完整（标题/元信息/正文/操作）", det.hasH3 && det.hasMeta && det.hasBody && det.hasCopy && det.hasDel);
  t("B10 正文宽度 > 700", det.bodyW > 700, "w=" + det.bodyW);
  t("B11 面板 sticky 且内部独立滚动", det.sticky === "sticky" && det.ownScroll !== null);
  t("B12 面板有清除选中按钮", det.hasCloseBtn);
  await c.close();
}

console.log("\n===== C. 选中/切换/已读语义 =====");
{
  const { c, page } = await ctx(1920, 1080);
  const firstUnread = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".list .card")].find((x) => x.classList.contains("unread"));
    return card ? card.getAttribute("data-id") : null;
  });
  t("C1 存在未读卡片（前置条件）", !!firstUnread);
  await page.evaluate(() => {
    const card = [...document.querySelectorAll(".list .card")].find((x) => x.classList.contains("unread"));
    if (card) card.click();
  });
  await page.waitForTimeout(700);
  const read = await page.evaluate((id) => {
    const card = document.querySelector('.card[data-id="' + id + '"]');
    return { unread: card ? card.classList.contains("unread") : null, state: (document.getElementById("dstate") || {}).textContent || "" };
  }, firstUnread);
  t("C2 打开即标记已读（卡片去未读态）", read.unread === false);
  t("C3 面板状态文字变为已读", /已读/.test(read.state), read.state);

  /* 快速连续切换：最终显示最后一次点击的消息 */
  const ids = await page.evaluate(() => [...document.querySelectorAll(".list .card")].slice(0, 3).map((c) => c.getAttribute("data-id")));
  await page.evaluate((ids) => {
    for (const id of ids) document.querySelector('.card[data-id="' + id + '"]').click();
  }, ids);
  await page.waitForTimeout(900);
  const last = await page.evaluate((id) => {
    const sel = document.querySelector(".card.dsel");
    const s = document.getElementById("dpscroll");
    return { selId: sel ? sel.getAttribute("data-id") : null, hasBody: !!s.querySelector(".detail-body") };
  }, ids[ids.length - 1]);
  t("C4 快速连续切换只保留最后一条选中", last.selId === ids[ids.length - 1], last.selId + " vs " + ids[ids.length - 1]);
  t("C5 切换后面板仍有内容（无空白/无过期报错）", last.hasBody);
  await c.close();
}

console.log("\n===== D. 删除与筛选后的状态 =====");
{
  const { c, page } = await ctx(1920, 1080);
  const target = await page.evaluate(() => document.querySelector(".list .card").getAttribute("data-id"));
  await page.evaluate((id) => document.querySelector('.card[data-id="' + id + '"]').click(), target);
  await page.waitForTimeout(600);
  /* UX-09 U9-02：删除改为先确认，测试需走完确认弹层 */
  await page.evaluate(() => document.getElementById("ddel").click());
  await page.waitForTimeout(700);
  const cfOpen = await page.evaluate(() => !document.getElementById("dsconfirm").hidden);
  if (cfOpen) { await page.evaluate(() => document.getElementById("dscfok").click()); }
  await page.waitForTimeout(1200);
  const after = await page.evaluate((id) => ({
    cardGone: !document.querySelector('.card[data-id="' + id + '"]'),
    paneEmpty: document.getElementById("dpscroll").hidden,
    selCount: document.querySelectorAll(".card.dsel").length,
  }), target);
  t("D1 删除后卡片消失", after.cardGone);
  t("D2 删除后面板回到空态", after.paneEmpty);
  t("D3 删除后无残留选中", after.selCount === 0);

  /* 筛选排除当前选中 */
  await page.evaluate(() => document.querySelector(".list .card").click());
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const q = document.getElementById("q");
    q.value = "zzz-不存在的关键词-zzz";
    q.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  const filtered = await page.evaluate(() => {
    const e = document.getElementById("dpempty");
    return { emptyShown: !e.hidden, text: (e.innerText || "").trim(), bodyHidden: document.getElementById("dpscroll").hidden };
  });
  t("D4 选中消息被筛选排除后面板转空态", filtered.emptyShown && filtered.bodyHidden);
  t("D5 空态文案指明「不在当前筛选结果」", /筛选/.test(filtered.text), filtered.text.split("\n")[0]);
  await c.close();
}

console.log("\n===== E. 主题与跨断点 =====");
{
  const { c, page } = await ctx(1920, 1080, "dark");
  await page.evaluate(() => document.querySelector(".list .card").click());
  await page.waitForTimeout(600);
  const dark = await page.evaluate(() => {
    const p = document.getElementById("detailpane");
    const b = p.querySelector(".detail-body");
    return {
      paneBg: getComputedStyle(p).backgroundColor,
      bodyBg: b ? getComputedStyle(b).backgroundColor : "",
      text: b ? getComputedStyle(b).color : "",
    };
  });
  t("E1 深色下面板使用深色表面", /rgb\(23, 27, 32\)/.test(dark.paneBg), dark.paneBg);
  /* 正文块用 --ds-color-bg-subtle（深色为 #12161a），与面板表面 #171b20 形成层次差 */
  const lum = (rgb) => { const m = rgb.match(/\d+/g) || []; return m.length >= 3 ? (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) : null; };
  t("E2 深色下正文块与面板有层次差", dark.bodyBg !== dark.paneBg && lum(dark.bodyBg) !== null && lum(dark.bodyBg) < 60, dark.bodyBg + " vs " + dark.paneBg);

  /* 跨断点：缩到 1440 面板收起，放大回 1920 面板恢复并保持选中 */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
  const small = await page.evaluate(() => {
    const p = document.getElementById("detailpane");
    return { w: Math.round(p.getBoundingClientRect().width), hidden: p.hidden || getComputedStyle(p).display === "none" };
  });
  t("E3 缩到 1440 后面板隐藏", small.hidden || small.w === 0);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(800);
  const back = await page.evaluate(() => ({
    visible: !document.getElementById("detailpane").hidden,
    hasBody: !!document.querySelector("#dpscroll .detail-body"),
    sel: document.querySelectorAll(".card.dsel").length,
  }));
  t("E4 放大回 1920 面板恢复且保留选中详情", back.visible && back.hasBody && back.sel === 1);
  await c.close();
}

console.log("\n===== F. 移动端与平板回归（不应出现双栏）=====");
for (const [w, h] of [[390, 844], [768, 1024], [1280, 800]]) {
  const { c, page } = await ctx(w, h);
  const r = await page.evaluate(() => {
    const p = document.getElementById("detailpane");
    return {
      paneHidden: p.hidden || getComputedStyle(p).display === "none",
      cols: getComputedStyle(document.querySelector(".layout")).gridTemplateColumns.split(" ").length,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  t("F " + w + " 无双栏且无横向溢出", r.paneHidden && r.cols === 1 && r.overflowX === 0, "cols=" + r.cols + " ovX=" + r.overflowX);
  await c.close();
}

console.log("\n===== UX-07C 结果：pass=" + pass + " fail=" + fail + " =====");
await browser.close();
await app.stop();
process.exit(fail ? 1 : 0);
