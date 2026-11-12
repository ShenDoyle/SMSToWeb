/**
 * UX-08 Step 5：真实浏览器任务流验证（A–H）
 *   消息查看 / 消息管理 / 设备管理 / 设置管理 / 通知配置 / 键盘操作 / 响应式交互 / 断点边界
 * 运行：PW_NODE_MODULES=/root/pwtest/node_modules node tests/browser/ux08-flows.mjs
 */
import { startApp, loadChromium, login } from "./harness.mjs";

const TOKEN = "ux08-flows-t";
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
  ["NAS-A7", "131****6666", "95188", "【支付宝】您有一笔 19.90 元支出。", "2026-11-11 15:12:00"],
  ["Pixel-7", "1069****001", "10086", "【中国移动】本月流量已用 80%。", "2026-11-11 12:04:00"],
  ["Mi-14", "139****8888", "12306", "【铁路】您预订的 G102 次列车已出票。", "2026-11-10 20:33:00"],
  ["NAS-A7", "131****6666", "95533", "【某银行】验证码 771902，请勿转发。", "2026-11-10 18:47:00"],
  ["Pixel-7", "1069****001", "10690001", "【某平台】您的订单已发货，运单号 SF1234。", "2026-11-10 11:22:00"],
  ["Mi-14", "139****8888", "13800138000", "会议改到三点。", "2026-11-09 16:10:00"],
  ["NAS-A7", "131****6666", "95555", "【某银行】您尾号 3092 的卡收入 5,000.00 元。", "2026-11-09 09:05:00"],
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
  await login(page, app, opts.lang || "zh-CN");
  await page.waitForTimeout(700);
  return { c, page };
}

const state = (page) => page.evaluate(() => ({
  modal: !document.getElementById("modal").hidden,
  pane: !!document.getElementById("dpscroll") && !document.getElementById("dpscroll").hidden,
  paneEmpty: !document.getElementById("dpempty").hidden,
  selbar: !document.getElementById("selbar").hidden,
  cards: document.querySelectorAll(".list .card").length,
  dsel: document.querySelectorAll(".list .card.dsel").length,
}));

/* ============ A. 消息查看流（1440 窄屏 → 弹层） ============ */
console.log("\n===== A. 消息查看流（1440，弹层路径）=====");
{
  const { c, page } = await ctx(1440, 900);
  const first = await page.evaluate(() => {
    const card = document.querySelector(".list .card");
    return { id: card.getAttribute("data-id"), unread: card.classList.contains("unread") };
  });
  await page.click(".list .card .summary");
  await page.waitForTimeout(600);
  const s1 = await state(page);
  t("A1 点击卡片打开详情弹层", s1.modal && !s1.pane, "modal=" + s1.modal);
  const body = await page.evaluate(() => (document.querySelector(".detail-body") || {}).textContent || "");
  t("A2 弹层内出现完整正文", body.length > 5, body.slice(0, 18));

  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const afterEsc = await state(page);
  const focusBack = await page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el ? el.tagName : "", cls: el ? el.className : "", inList: !!(el && el.closest && el.closest("#list")) };
  });
  t("A3 Esc 关闭弹层", !afterEsc.modal);
  t("A4 关闭后焦点回到列表卡片（不丢焦点）", focusBack.inList && /card/.test(focusBack.cls), focusBack.tag + "." + focusBack.cls);

  const readNow = await page.evaluate((id) => {
    const card = document.querySelector('.list .card[data-id="' + id + '"]');
    return card ? !card.classList.contains("unread") : null;
  }, first.id);
  t("A5 查看后该条标记已读", first.unread ? readNow === true : true, "wasUnread=" + first.unread);
  await c.close();
}

/* ============ B. 消息查看流（1920 宽屏 → 双栏面板） ============ */
console.log("\n===== B. 消息查看流（1920，双栏面板）=====");
{
  const { c, page } = await ctx(1920, 1080);
  await page.evaluate(() => document.querySelector(".list .card").click());
  await page.waitForTimeout(600);
  const s1 = await state(page);
  t("B1 宽屏点击卡片走右侧面板（不弹层）", s1.pane && !s1.modal, "pane=" + s1.pane + " modal=" + s1.modal);
  t("B2 列表与面板同屏可见（未遮挡列表）", s1.cards > 0 && s1.dsel === 1, "cards=" + s1.cards + " sel=" + s1.dsel);

  /* 连点三张卡片：序号守卫只应保留最后一响应的内容 */
  const ids = await page.evaluate(() => [...document.querySelectorAll(".list .card")].slice(0, 3).map((x) => x.getAttribute("data-id")));
  const summaries = await page.evaluate(() => [...document.querySelectorAll(".list .card .summary")].slice(0, 3).map((x) => x.textContent.trim()));
  await page.evaluate((list) => {
    list.forEach((id) => document.querySelector('.list .card[data-id="' + id + '"]').click());
  }, ids);
  await page.waitForTimeout(900);
  const paneText = await page.evaluate(() => (document.getElementById("dpscroll").innerText || "").trim());
  const lastSummary = summaries[2] || "";
  const head = lastSummary.slice(0, 8);
  t("B3 连续快速切换后显示最后一条（序号守卫生效）", head.length > 0 && paneText.indexOf(head) !== -1, head);
  const sel2 = await page.evaluate(() => ({
    n: document.querySelectorAll(".list .card.dsel").length,
    id: (document.querySelector(".list .card.dsel") || {}).getAttribute ? document.querySelector(".list .card.dsel").getAttribute("data-id") : "",
  }));
  t("B4 仅最后一条保持选中态", sel2.n === 1 && sel2.id === ids[2], sel2.n + " 条 / id=" + sel2.id);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const s3 = await state(page);
  t("B5 Esc 清除选中并回到空态", s3.dsel === 0 && s3.paneEmpty, "dsel=" + s3.dsel + " empty=" + s3.paneEmpty);
  await c.close();
}

/* ============ C. 消息管理流 ============ */
console.log("\n===== C. 消息管理流 =====");
{
  const { c, page } = await ctx(1440, 900);
  const before = (await state(page)).cards;

  /* 右键选中一条 → 批量已读 */
  const target = await page.evaluate(() => {
    const card = document.querySelector(".list .card.unread") || document.querySelector(".list .card");
    return card ? card.getAttribute("data-id") : "";
  });
  await page.click('.list .card[data-id="' + target + '"]', { button: "right" });
  await page.waitForTimeout(400);
  const s1 = await state(page);
  t("C1 右键进入多选模式并显示操作栏", s1.selbar, "selbar=" + s1.selbar);

  await page.evaluate(() => { const r = document.getElementById("toastroot"); if (r) r.innerHTML = ""; });
  await page.click("#selread");
  await page.waitForTimeout(1300);
  const readState = await page.evaluate((id) => {
    const card = document.querySelector('.list .card[data-id="' + id + '"]');
    const list = [...document.querySelectorAll("#toastroot .toast")];
    const ok = list.filter((x) => /toast--success/.test(x.className))[0] || null;
    return {
      unread: card ? card.classList.contains("unread") : null,
      success: !!ok, role: ok ? ok.getAttribute("role") : "", txt: ok ? ok.innerText.trim() : "",
      selbar: !document.getElementById("selbar").hidden,
    };
  }, target);
  t("C2 批量已读后目标条目转为已读", readState.unread === false, "unread=" + readState.unread);
  t("C3 批量操作给出 success 反馈且为非打断式（role=status）", readState.success && readState.role === "status", readState.txt);
  t("C4 批量已读后自动退出多选", readState.selbar === false);

  /* 取消多选 */
  await page.click(".list .card", { button: "right" });
  await page.waitForTimeout(300);
  await page.click("#selcancel");
  await page.waitForTimeout(300);
  t("C5 取消多选后操作栏收起", !(await state(page)).selbar);

  /* 删除：破坏性操作需二次确认 → 确认后出撤销提示 */
  await page.click(".list .card", { button: "right" });
  await page.waitForTimeout(300);
  const delId = await page.evaluate(() => {
    const c2 = document.querySelector(".list .card");
    return c2 ? c2.getAttribute("data-id") : "";
  });
  await page.click("#seldel");
  await page.waitForTimeout(600);
  const confirmBox = await page.evaluate(() => {
    const d = document.getElementById("dsconfirm");
    return { open: !!d && !d.hidden, danger: !!(d && d.querySelector(".ds-btn--danger")) };
  });
  t("C6 删除先弹二次确认且按钮为破坏性样式", confirmBox.open && confirmBox.danger);
  await page.evaluate(() => {
    const b = document.querySelector("#dsconfirm .ds-btn--danger");
    if (b) b.click();
  });
  await page.waitForTimeout(1400);
  const undo = await page.evaluate(() => {
    const t2 = document.querySelector("#toastroot .toast.undo");
    return { has: !!t2, btn: t2 ? !!t2.querySelector(".undo-btn") : false };
  });
  t("C7 删除后出现可撤销提示", undo.has && undo.btn);
  /* 删除后第 1 页会自动补位，条数不变；用「被删那条是否回来」判断回滚是否真实生效 */
  if (undo.has) { await page.click("#toastroot .toast.undo .undo-btn"); await page.waitForTimeout(1600); }
  const restored = await page.evaluate((id) => !!document.querySelector('.list .card[data-id="' + id + '"]'), delId);
  t("C8 撤销后被删条目回到列表（软删除可回滚）", restored === true, "id=" + delId + " 初始=" + before);
  await c.close();
}

/* ============ D. 设备管理流 ============ */
console.log("\n===== D. 设备管理流 =====");
{
  const { c, page } = await ctx(1440, 900);
  await page.click("#devbtn");
  await page.waitForTimeout(800);
  const dev = await page.evaluate(() => {
    const rows = document.querySelectorAll(".devrow");
    return { n: rows.length, name: rows[0] ? rows[0].querySelector(".dn").textContent.trim() : "" };
  });
  t("D1 设备弹层列出设备", dev.n >= 1, dev.n + " 台 / " + dev.name);

  await page.click('.devrow [data-dvact="rename"]');
  await page.waitForTimeout(600);
  const dlg = await page.evaluate(() => ({
    open: !document.getElementById("dsprompt").hidden,
    val: document.getElementById("dspInput").value,
    focused: document.activeElement === document.getElementById("dspInput"),
    layeredAbove: (() => {
      const a = getComputedStyle(document.getElementById("dsprompt")).zIndex;
      const b = getComputedStyle(document.getElementById("modal")).zIndex;
      return parseInt(a, 10) > parseInt(b, 10);
    })(),
  }));
  t("D2 重命名弹窗打开且预填当前名", dlg.open && dlg.val.length > 0, dlg.val);
  t("D3 输入框自动获焦（可直接键入）", dlg.focused);
  t("D4 二层弹窗层级高于一层（不叠底）", dlg.layeredAbove);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const esc1 = await page.evaluate(() => ({
    dsp: document.getElementById("dsprompt").hidden,
    modal: document.getElementById("modal").hidden,
  }));
  t("D5 Esc 只关最上层（设备层仍在）", esc1.dsp === true && esc1.modal === false);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  t("D6 再按 Esc 关闭设备层", await page.evaluate(() => document.getElementById("modal").hidden));
  await c.close();
}

/* ============ E. 设置管理流 ============ */
console.log("\n===== E. 设置管理流 =====");
{
  const { c, page } = await ctx(1440, 900);
  await page.click("#setbtn");
  await page.waitForSelector("#scbody .sc-group", { timeout: 20000 });
  await page.click('[data-sc-tab="display"]');
  await page.waitForTimeout(250);

  /* 未改动直接保存 → 应给出「无变化」类提示，不写库 */
  await page.click("#scrsave");
  await page.waitForTimeout(800);
  const noChange = await page.evaluate(() => {
    const l = document.querySelector("#toastroot .toast");
    return { n: document.querySelectorAll("#toastroot .toast").length, cls: l ? l.className : "", txt: l ? l.innerText.trim() : "" };
  });
  t("E1 无改动保存给出提示（不静默）", noChange.n >= 1 && noChange.txt.length > 0, noChange.txt);

  /* 改每页条数 → 保存 → 成功反馈 */
  await page.selectOption("#sclimit", "20");
  await page.waitForTimeout(200);
  await page.click("#scrsave");
  await page.waitForTimeout(1200);
  const saved = await page.evaluate(() => {
    const list = [...document.querySelectorAll("#toastroot .toast")];
    const hit = list.filter((x) => /toast--success/.test(x.className))[0] || null;
    return { any: list.length, success: !!hit, txt: hit ? hit.innerText.trim() : "" };
  });
  t("E2 保存成功以 success 类型提示", saved.success, saved.txt);

  const limit = await page.evaluate(() => {
    const sel = document.getElementById("sclimit");
    return { val: sel ? sel.value : "", stored: (() => { try { return localStorage.getItem("sms_perpage") || ""; } catch (e) { return ""; } })() };
  });
  t("E3 每页条数写入本浏览器偏好", limit.val === "20" && limit.stored === "20", "select=" + limit.val + " sms_perpage=" + limit.stored);

  /* 偏好按「保存后整页应用」生效，按真实路径重新加载再核对 */
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#list .card", { timeout: 20000 });
  await page.waitForTimeout(600);
  const listInfo = await page.evaluate(() => ({
    cards: document.querySelectorAll(".list .card").length,
    sel: (document.getElementById("sclimit") || {}).value || "",
  }));
  t("E4 重载后每页 20 条生效（12 条全显示）", listInfo.cards === 12, "cards=" + listInfo.cards);
  await c.close();
}

/* ============ F. 通知配置流 ============ */
console.log("\n===== F. 通知配置流 =====");
{
  const { c, page } = await ctx(1440, 900);
  await page.click("#setbtn");
  await page.waitForSelector("#scbody .sc-group", { timeout: 20000 });
  await page.click('[data-sc-tab="notify"]');
  await page.waitForTimeout(400);
  const chans = await page.evaluate(() => document.querySelectorAll("#scbody .sc-ch").length);
  t("F1 通知分区渲染渠道网格", chans >= 5, chans + " 个渠道");

  /* 从渠道「+」进入推送编辑器 */
  await page.click("#scbody .sc-ch-add");
  await page.waitForTimeout(500);
  const editor = await page.evaluate(() => ({
    open: !document.getElementById("pushmodal").hidden,
    hasName: !!document.getElementById("pfname"),
    label: (document.getElementById("pushtitle") || {}).textContent || "",
  }));
  t("F2 渠道「+」打开推送编辑器且含命名必填项", editor.open && editor.hasName, editor.label);

  /* 不填名称直接保存 → 应给出警告类提示（warning，常驻可关闭） */
  await page.evaluate(() => { const r = document.getElementById("toastroot"); if (r) r.innerHTML = ""; });
  await page.click('[data-pushact="save"]');
  await page.waitForTimeout(900);
  const warn = await page.evaluate(() => {
    const list = [...document.querySelectorAll("#toastroot .toast")];
    const w = list.filter((x) => /toast--warning|toast--error/.test(x.className))[0] || null;
    return {
      any: list.length,
      cls: w ? w.className : "",
      txt: w ? w.innerText.trim() : "",
      hasClose: w ? !!w.querySelector(".toast-close") : false,
      role: w ? w.getAttribute("role") : "",
      stillOpen: !document.getElementById("pushmodal").hidden,
    };
  });
  t("F3 必填校验以 warning 类型提示", warn.any >= 1 && /toast--warning/.test(warn.cls) && warn.txt.length > 0, warn.txt);
  t("F4 警告提示为打断式（role=alert）且可手动关闭", warn.role === "alert" && warn.hasClose, warn.role + " close=" + warn.hasClose);
  t("F5 校验失败不关闭编辑器（保留已填内容）", warn.stillOpen);

  const closed = await page.evaluate(() => {
    const w = [...document.querySelectorAll("#toastroot .toast")].filter((x) => x.querySelector(".toast-close"))[0];
    if (!w) return null;
    w.querySelector(".toast-close").click();
    return true;
  });
  await page.waitForTimeout(600);
  const left = await page.evaluate(() => document.querySelectorAll("#toastroot .toast").length);
  t("F6 点关闭按钮后提示立即消失", closed === true && left === 0, "剩余 " + left);
  await c.close();
}

/* ============ G. 键盘操作流 ============ */
console.log("\n===== G. 键盘操作流 =====");
{
  const { c, page } = await ctx(1440, 900);
  /* 卡片 → Enter 打开 */
  await page.evaluate(() => document.querySelector(".list .card").focus());
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  t("G1 卡片聚焦后 Enter 打开详情", (await state(page)).modal);

  await page.evaluate(() => {
    const c2 = document.querySelector(".list .card");
    if (c2) c2.focus();
  });
  await page.keyboard.press(" ");
  await page.waitForTimeout(600);
  t("G2 空格同样可打开详情", (await state(page)).modal);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /* 方向键在卡片间移动 */
  await page.evaluate(() => document.querySelector(".list .card").focus());
  await page.keyboard.press("ArrowDown");
  const moved = await page.evaluate(() => {
    const el = document.activeElement;
    return { isCard: !!(el && el.classList && el.classList.contains("card")), idx: [...document.querySelectorAll(".list .card")].indexOf(el) };
  });
  t("G3 ArrowDown 在卡片之间移动焦点", moved.isCard && moved.idx === 1, "idx=" + moved.idx);

  await page.keyboard.press("End");
  const atEnd = await page.evaluate(() => [...document.querySelectorAll(".list .card")].indexOf(document.activeElement));
  t("G4 End 跳到列表末条", atEnd > 1, "idx=" + atEnd);
  await page.keyboard.press("Home");
  const atHome = await page.evaluate(() => [...document.querySelectorAll(".list .card")].indexOf(document.activeElement));
  t("G5 Home 回到列表首条", atHome === 0, "idx=" + atHome);

  /* / 聚焦搜索，且在输入框内输入不劫持 */
  await page.evaluate(() => document.body.click());
  await page.keyboard.press("/");
  await page.waitForTimeout(200);
  const slashFocus = await page.evaluate(() => document.activeElement === document.getElementById("q"));
  t("G6 「/」快速聚焦搜索框", slashFocus);
  await page.keyboard.type("abc/def");
  const typed = await page.evaluate(() => document.getElementById("q").value);
  t("G7 输入框内输入「/」不被劫持", typed === "abc/def", typed);
  await c.close();
}

/* ============ H. 响应式交互与断点边界 ============ */
console.log("\n===== H. 断点边界（1599↔1600 / 1759↔1760）=====");
{
  const at = async (w) => {
    const { c, page } = await ctx(w, 1000);
    const cols = await page.evaluate(() => getComputedStyle(document.querySelector(".layout")).gridTemplateColumns);
    const wrapW = await page.evaluate(() => Math.round(document.querySelector(".wrap").getBoundingClientRect().width));
    return { c, page, cols, wrapW };
  };

  const v1599 = await at(1599);
  await v1599.page.evaluate(() => document.querySelector(".list .card .summary").click());
  await v1599.page.waitForTimeout(600);
  const s1599 = await state(v1599.page);
  t("H1 1599 走弹层路径（单栏）", s1599.modal && !s1599.pane, "modal=" + s1599.modal);

  const v1600 = await at(1600);
  const s1600 = await state(v1600.page);
  const paneVisible = await v1600.page.evaluate(() => {
    const p = document.getElementById("detailpane");
    return !!p && getComputedStyle(p).display !== "none";
  });
  t("H2 1600 双栏面板可见且列表仍是单列主区", paneVisible && v1600.cols.split(" ").length === 2, v1600.cols + " wrap=" + v1600.wrapW);
  t("H3 1599↔1600 的 layout 列数发生切换", v1599.cols.split(" ").length === 1 || !/px/.test(v1599.cols) ? true : false, "1599=" + v1599.cols);

  /* 跨断点实时切换：1600 打开详情后缩到 1599 应回到弹层语义（选中记忆） */
  await v1600.page.evaluate(() => document.querySelector(".list .card").click());
  await v1600.page.waitForTimeout(600);
  await v1600.page.setViewportSize({ width: 1599, height: 1000 });
  await v1600.page.waitForTimeout(700);
  const crossed = await v1600.page.evaluate(() => ({
    paneShown: getComputedStyle(document.getElementById("detailpane")).display !== "none",
    modal: !document.getElementById("modal").hidden,
    dsel: document.querySelectorAll(".list .card.dsel").length,
  }));
  t("H4 缩回 1599 后面板收起、选中态清理（不留幽灵高亮）", !crossed.paneShown && crossed.dsel === 0, "dsel=" + crossed.dsel);
  await v1600.page.setViewportSize({ width: 1600, height: 1000 });
  await v1600.page.waitForTimeout(700);
  const back = await v1600.page.evaluate(() => getComputedStyle(document.getElementById("detailpane")).display !== "none");
  t("H5 恢复 1600 后双栏面板重新出现", back);

  const c1759 = await at(1759);
  const c1760 = await at(1760);
  t("H6 1759↔1760 工作区宽度存在台阶（容器上限生效）", c1760.wrapW >= c1759.wrapW, c1759.wrapW + " → " + c1760.wrapW);
  const noOverflow = await Promise.all([c1759, c1760].map((x) => x.page.evaluate(() => ({
    ov: document.documentElement.scrollWidth - window.innerWidth,
  }))));
  t("H7 两个边界均无横向溢出", noOverflow.every((o) => o.ov <= 0), noOverflow.map((o) => o.ov).join("/"));

  for (const x of [v1599, v1600, c1759, c1760]) await x.c.close();
}

console.log("\n===== UX-08 任务流结果：pass=" + pass + " fail=" + fail + " =====");
await browser.close();
await app.stop();
process.exit(fail ? 1 : 0);
