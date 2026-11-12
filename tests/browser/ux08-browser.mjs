/**
 * UX-08 运行时验证：键盘路径、统一弹窗行为、空态多语言、移动端操作可见性
 * 运行：PW_NODE_MODULES=/root/pwtest/node_modules node tests/browser/ux08-browser.mjs
 */
import { startApp, loadChromium, login } from "./harness.mjs";

const TOKEN = "ux08-t";
const app = await startApp({ env: { RECEIVE_TOKEN: TOKEN } });
const chromium = loadChromium();
const browser = await chromium.launch();

let pass = 0, fail = 0;
const t = (name, ok, extra = "") => {
  if (ok) { pass++; console.log("  ok   " + name + (extra ? "  [" + extra + "]" : "")); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
};

const seed = [
  ["Pixel-7", "1069****001", "106903001234", "【验证码】您的登录验证码为 482913，5 分钟内有效。", "2026-11-12 10:18:00"],
  ["Mi-14", "139****8888", "13800138000", "晚点到，先吃别等我。", "2026-11-12 09:41:00"],
  ["NAS-A7", "131****6666", "95588", "【某银行】您尾号 8821 的卡支付 328.00 元。", "2026-11-12 08:20:00"],
  ["Pixel-7", "1069****001", "010-88886666", "快递已放至丰巢柜，取件码 8821。", "2026-11-11 21:05:00"],
  ["Mi-14", "139****8888", "13800138000", "明天记得带报表。", "2026-11-11 19:30:00"],
];
for (const [name, sim, from, content, time] of seed) {
  await fetch(app.base + "/api/receive", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN, name, sim, from, content, time }),
  });
}

async function ctx(w, h, opts = {}) {
  const c = await browser.newContext({
    viewport: { width: w, height: h },
    hasTouch: !!opts.touch,
    isMobile: !!opts.touch && w < 600,
    locale: "zh-CN",
  });
  const page = await c.newPage();
  await page.addInitScript((o) => {
    try { localStorage.setItem("sms_theme", o.theme || "light"); localStorage.setItem("sms_lang", o.lang || "zh-CN"); } catch (e) {}
  }, { theme: opts.theme, lang: opts.lang });
  /* login() 会把 ?lang= 拼进 URL，而 ?lang= 的优先级高于 localStorage，必须一并传入，否则英文上下文被冲成中文 */
  await login(page, app, opts.lang || "zh-CN");
  await page.waitForTimeout(700);
  return { c, page };
}

console.log("\n===== A. 键盘路径（1440，窄屏弹层）=====");
{
  const { c, page } = await ctx(1440, 900);
  /* 卡片可聚焦 + 焦点可见 */
  const focusInfo = await page.evaluate(() => {
    const card = document.querySelector(".list .card");
    card.focus();
    const cs = getComputedStyle(card);
    return {
      isFocused: document.activeElement === card,
      tabindex: card.getAttribute("tabindex"),
      role: card.getAttribute("role"),
      aria: card.getAttribute("aria-label") || "",
      outlineW: cs.outlineWidth,
      outlineStyle: cs.outlineStyle,
    };
  });
  t("A1 卡片可通过键盘聚焦", focusInfo.isFocused && focusInfo.tabindex === "0");
  t("A2 卡片有语义角色与可读标签", focusInfo.role === "article" && focusInfo.aria.length > 3, focusInfo.aria.slice(0, 24));
  t("A3 键盘焦点有可见轮廓", focusInfo.outlineStyle !== "none" && parseFloat(focusInfo.outlineW) >= 2, focusInfo.outlineW + " " + focusInfo.outlineStyle);

  /* 方向键移动 */
  await page.keyboard.press("ArrowDown");
  const moved = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".list .card")];
    return { idx: cards.indexOf(document.activeElement) };
  });
  t("A4 ArrowDown 焦点移动到下一条", moved.idx === 1, "idx=" + moved.idx);

  /* Enter 打开详情 */
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  const opened = await page.evaluate(() => ({
    modal: !document.getElementById("modal").hidden,
    body: !!document.querySelector(".detail-body"),
    focusInModal: document.getElementById("modal").contains(document.activeElement),
  }));
  t("A5 Enter 打开详情弹层", opened.modal && opened.body);
  t("A6 打开后焦点进入弹层内", opened.focusInModal);

  /* Esc 关闭 + 焦点返回 */
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const closed = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".list .card")];
    return {
      modalClosed: document.getElementById("modal").hidden,
      activeIdx: cards.indexOf(document.activeElement),
    };
  });
  t("A7 Esc 关闭弹层", closed.modalClosed);
  t("A8 关闭后焦点返回触发卡片", closed.activeIdx === 1, "idx=" + closed.activeIdx);

  /* / 聚焦搜索 */
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press("/");
  await page.waitForTimeout(200);
  const slash = await page.evaluate(() => document.activeElement === document.getElementById("q"));
  t("A9 / 键聚焦搜索框", slash);
  /* 输入框内按 / 不应被劫持 */
  await page.type("#q", "a/");
  const val = await page.inputValue("#q");
  t("A10 输入框内 / 不被劫持（可正常输入）", val.indexOf("/") !== -1, val);
  await c.close();
}

console.log("\n===== B. 键盘路径（1920，双栏面板）=====");
{
  const { c, page } = await ctx(1920, 1080);
  await page.evaluate(() => document.querySelector(".list .card").focus());
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  const st = await page.evaluate(() => ({
    paneBody: !!document.querySelector("#dpscroll .detail-body"),
    modal: !document.getElementById("modal").hidden,
    sel: document.querySelectorAll(".card.dsel").length,
  }));
  t("B1 Enter 在双栏下打开右侧面板而非弹层", st.paneBody && !st.modal && st.sel === 1);
  await page.evaluate(() => document.querySelector(".list .card").focus());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const cleared = await page.evaluate(() => ({
    sel: document.querySelectorAll(".card.dsel").length,
    empty: !document.getElementById("dpempty").hidden,
    focusStillOnCard: document.activeElement.classList.contains("card"),
  }));
  t("B2 Esc 清除双栏选中并回到空态", cleared.sel === 0 && cleared.empty);
  t("B3 Esc 不把焦点踢出列表", cleared.focusStillOnCard);
  await c.close();
}

console.log("\n===== C. 统一输入弹窗（号码标签 / 设备重命名）=====");
{
  const { c, page } = await ctx(1440, 900);
  await page.evaluate(() => document.querySelector(".list .card .summary").click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById("dlabel").click());
  await page.waitForTimeout(400);
  const dlg = await page.evaluate(() => {
    const d = document.getElementById("dsprompt");
    return {
      open: !d.hidden,
      title: (document.getElementById("dspTitle") || {}).textContent || "",
      focused: d.contains(document.activeElement),
      hasInput: !!document.getElementById("dspInput"),
    };
  });
  t("C1 号码标签打开统一输入弹窗（非原生 prompt）", dlg.open && dlg.hasInput);
  t("C2 弹窗有标题且焦点在输入框", dlg.title.length > 0 && dlg.focused, dlg.title);

  /* 输入并确认 → 弹窗关闭，标签生效 */
  await page.fill("#dspInput", "银行客服");
  await page.evaluate(() => document.getElementById("dspOk").click());
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => ({
    closed: document.getElementById("dsprompt").hidden,
    label: (() => { try { return JSON.parse(localStorage.getItem("sms_labels") || "{}"); } catch (e) { return {}; } })(),
    modalClosed: document.getElementById("modal").hidden,
  }));
  t("C3 确认后弹窗关闭并写入标签", after.closed && Object.values(after.label).indexOf("银行客服") !== -1);
  t("C4 保存后详情弹层一并关闭（焦点不落 body）", after.modalClosed);

  /* 取消不改变值 */
  await page.evaluate(() => document.querySelector(".list .card .summary").click());
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById("dlabel").click());
  await page.waitForTimeout(300);
  const before = await page.inputValue("#dspInput");
  await page.fill("#dspInput", "不该保存");
  await page.evaluate(() => document.getElementById("dspCancel").click());
  await page.waitForTimeout(400);
  const cancelState = await page.evaluate(() => ({
    closed: document.getElementById("dsprompt").hidden,
    labels: JSON.parse(localStorage.getItem("sms_labels") || "{}"),
  }));
  t("C5 取消不写入任何值", cancelState.closed && Object.values(cancelState.labels).indexOf("不该保存") === -1, "before=" + before);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await c.close();
}

console.log("\n===== D. 设备管理弹窗（重命名走统一弹窗）=====");
{
  const { c, page } = await ctx(1440, 900);
  await page.evaluate(() => document.getElementById("devbtn").click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('[data-dvact="rename"]').click());
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({
    open: !document.getElementById("dsprompt").hidden,
    title: document.getElementById("dspTitle").textContent,
    value: document.getElementById("dspInput").value,
  }));
  t("D1 设备重命名打开统一弹窗并预填当前名", r.open && r.value.length > 0, r.title);

  /* UX-09 U9-05：重命名留空语义为「恢复默认名」，不再被必填拦截（旧断言已失效） */
  const beforeName = await page.evaluate(() => {
    const o = document.querySelector("#dev option:not([value=''])");
    return o ? o.textContent.replace(/\s*\(\d+\)\s*$/, "").trim() : "";
  });
  await page.fill("#dspInput", "   ");
  await page.evaluate(() => document.getElementById("dspOk").click());
  await page.waitForTimeout(1200);
  const emptyCheck = await page.evaluate(() => ({
    dlgClosed: document.getElementById("dsprompt").hidden,
    options: [...document.querySelectorAll("#dev option")].map((o) => o.textContent.trim()),
  }));
  t("D2 留空提交不再被必填拦截，且恢复默认名", emptyCheck.dlgClosed &&
    emptyCheck.options.some((x) => x.indexOf(beforeName) === 0),
    "before=" + beforeName + " / " + JSON.stringify(emptyCheck.options));

  /* 合法值保存成功（重新打开弹窗） */
  await page.evaluate(() => document.getElementById("devbtn").click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('[data-dvact="rename"]').click());
  await page.waitForTimeout(400);
  await page.fill("#dspInput", "客厅手机");
  await page.evaluate(() => document.getElementById("dspOk").click());
  await page.waitForTimeout(1000);
  const saved = await page.evaluate(() => ({
    dlgClosed: document.getElementById("dsprompt").hidden,
    modalClosed: document.getElementById("modal").hidden,
    hasName: (document.body.innerText || "").indexOf("客厅手机") !== -1,
  }));
  t("D3 合法值保存成功并关闭两层弹窗", saved.dlgClosed && saved.modalClosed);
  t("D4 列表/筛选中出现新设备名", saved.hasName);
  await c.close();
}

console.log("\n===== E. 双栏空态多语言（状态与文案分离）=====");
{
  const { c, page } = await ctx(1920, 1080, { lang: "zh-CN" });
  await page.evaluate(() => document.querySelector(".list .card").click());
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const q = document.getElementById("q");
    q.value = "zzz-不存在-zzz";
    q.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  const zh = await page.evaluate(() => (document.getElementById("dpempty").innerText || "").trim());
  t("E1 筛选排除后显示 missing 文案（中文）", /筛选/.test(zh), zh.split("\n")[0]);
  await c.close();

  const en = await ctx(1920, 1080, { lang: "en" });
  await en.page.evaluate(() => document.querySelector(".list .card").click());
  await en.page.waitForTimeout(600);
  await en.page.evaluate(() => {
    const q = document.getElementById("q");
    q.value = "zzz-nothing-zzz";
    q.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await en.page.waitForTimeout(1200);
  const txt = await en.page.evaluate(() => (document.getElementById("dpempty").innerText || "").trim());
  const enLang = await en.page.evaluate(() => ({
    html: document.documentElement.getAttribute("lang") || "",
    paneEmptyLabel: (document.querySelector("#dpempty b") || {}).textContent || "",
  }));
  t("E2 英文上下文真正生效（?lang= 未被测试框架覆盖）", /^en/.test(enLang.html), enLang.html);
  t("E3 英文下 missing 文案正确（未被冲成默认空态）", /filter/i.test(txt) && !/Select a message/i.test(txt), txt.split("\n")[0]);
  await en.c.close();
}

console.log("\n===== E2. 空态多语言矩阵（状态语义键 + 九语种文案）=====");
{
  /* 产品切换语言路径 = 写入偏好后整页 reload，因此这里用 ?lang= 等价覆盖语言上下文，
     验证「状态键（missing）不变、文案随语言重算」这一核心要求。 */
  const cases = [
    ["en", /filter/i, /Select a message/i],
    ["ja", /絞り込み/, /左のメッセージを選ぶと/],
    ["de", /Filterergebnis/, /Nachricht auswählen/],
    ["pt-BR", /filtro atual/, /Selecione uma mensagem/],
  ];
  for (const [code, want, bad] of cases) {
    const { c, page } = await ctx(1920, 1080, { lang: code });
    await page.evaluate(() => document.querySelector(".list .card").click());
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const q = document.getElementById("q");
      q.value = "zzz-nothing-zzz";
      q.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(1000);
    const got = await page.evaluate(() => ({
      text: (document.getElementById("dpempty").innerText || "").trim(),
      htmlLang: document.documentElement.getAttribute("lang") || "",
      stage: (window.__st && window.__st.paneState) || "",
    }));
    const okLang = got.htmlLang.toLowerCase().indexOf(code.toLowerCase().split("-")[0]) === 0;
    t("E-" + code + " 语言上下文生效且空态为 missing 文案",
      okLang && want.test(got.text) && !bad.test(got.text), got.text.split("\n")[0]);
    await c.close();
  }
}

console.log("\n===== F. 移动端详情操作可见性（390 触摸）=====");
{
  const { c, page } = await ctx(390, 844, { touch: true });
  await page.evaluate(() => document.querySelector(".list .card .summary").click());
  await page.waitForTimeout(700);
  const m = await page.evaluate(() => {
    const foot = document.querySelector(".modal-foot");
    const rg = document.querySelector(".modal-foot .foot-right");
    const btns = [...document.querySelectorAll(".modal-foot .tbtn")];
    const vw = window.innerWidth, vh = window.innerHeight;
    const offscreen = btns.filter((b) => {
      const r = b.getBoundingClientRect();
      return r.right > vw + 1 || r.left < -1 || r.bottom > vh + 1 || r.top < 0;
    }).map((b) => b.textContent.trim());
    return {
      hScroll: foot.scrollWidth - foot.clientWidth,
      navScroll: rg ? rg.scrollWidth - rg.clientWidth : 0,
      btnCount: btns.length,
      offscreen,
      small: btns.filter((b) => { const r = b.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).map((b) => b.textContent.trim() + ":" + Math.round(b.getBoundingClientRect().height)),
      closeVisible: !!document.getElementById("dclose") && (() => { const r = document.getElementById("dclose").getBoundingClientRect(); return r.top >= 0 && r.bottom <= vh; })(),
    };
  });
  t("F1 底部按钮无横向滚动（不再是横滑方案）", m.hScroll <= 0, "scroll=" + m.hScroll);
  t("F2 所有操作按钮都在视口内可见", m.offscreen.length === 0, m.offscreen.join(",") || m.btnCount + " btns");
  t("F3 主操作「关闭」直接可见", m.closeVisible);
  t("F4 触控命中 ≥44px", m.small.length === 0, m.small.join(",") || "all ok");
  await c.close();
}

console.log("\n===== G. 七视口无横向溢出回归 =====");
for (const [w, h] of [[390, 844], [768, 1024], [1024, 768], [1440, 900], [1600, 900], [1920, 1080], [2560, 1440]]) {
  const { c, page } = await ctx(w, h, { touch: w < 900 });
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  t("G " + w + " 无横向溢出", ov === 0, "ovX=" + ov);
  await c.close();
}

console.log("\n===== UX-08 运行时结果：pass=" + pass + " fail=" + fail + " =====");
await browser.close();
await app.stop();
process.exit(fail ? 1 : 0);
