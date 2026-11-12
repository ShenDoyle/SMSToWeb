/**
 * 浏览器回归测试公共脚手架（FEAD-UX-04）
 *
 * 职责：
 *  1. 起一个完全隔离的应用实例（临时 SQLite + 随机端口 + 随机密码/令牌），跑完即清理；
 *  2. 起 Chromium（Playwright），注入可访问性辅助函数；
 *  3. 统一的断言/统计/退出码约定。
 *
 * 隔离约束：
 *  - 数据库落在 os.tmpdir()，进程结束删除（含 -wal / -shm / -journal）；
 *  - 端口由系统分配，不占用固定端口，可多文件并行；
 *  - 不读取任何生产凭据，不连接生产库，不发送真实通知（测试里不发通知）。
 *
 * Playwright 解析顺序：常规 require → PW_NODE_MODULES（可多个，用路径分隔符分隔）。
 *  CI 里用 `npm i --no-save playwright@<pin>` 安装到本仓库 node_modules，版本固定。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
const require = createRequire(import.meta.url);

/** 载入 Playwright 的 chromium；找不到时给出可执行的修复提示 */
export function loadChromium() {
  for (const name of ["playwright", "playwright-core"]) {
    try { return require(name).chromium; } catch (e) { /* 继续找 */ }
  }
  const dirs = String(process.env.PW_NODE_MODULES || "").split(delimiter).filter(Boolean);
  for (const d of dirs) {
    try { return require(join(d, "playwright")).chromium; } catch (e) { /* 继续找 */ }
  }
  throw new Error(
    "未找到 playwright。请执行：npm i --no-save playwright@1.65.0 && npx playwright install chromium\n" +
    "或设置 PW_NODE_MODULES 指向已安装 playwright 的 node_modules 目录。"
  );
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

/**
 * 启动隔离应用实例。
 * @param {{password?: string, env?: Record<string,string>}} [opts]
 */
export async function startApp(opts = {}) {
  const port = await freePort();
  const stamp = process.pid + "_" + Math.random().toString(36).slice(2, 8);
  const dbPath = join(tmpdir(), "smstoweb_ux_" + stamp + ".db");
  const password = opts.password || "ux-" + stamp;
  const env = {
    ...process.env,
    PORT: String(port),
    SQLITE_PATH: dbPath,
    RECEIVE_TOKEN: "recv-" + stamp,
    ENABLE_AUTH: "true",
    ADMIN_PASSWORD: password,
    SESSION_SECRET: "sess-" + stamp,
    RETENTION_DAYS: "7",
    ...(opts.env || {}),
  };
  const child = spawn(process.execPath, [join(ROOT, "platforms", "node", "server.mjs")], {
    cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));

  const base = "http://127.0.0.1:" + port;
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("服务启动失败：\n" + logs.join("").slice(0, 1200));
    try {
      const r = await fetch(base + "/api/auth-state");
      if (r.ok) { ready = true; break; }
    } catch (e) { /* 还没监听 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (!ready) throw new Error("服务 30s 内未就绪：\n" + logs.join("").slice(0, 1200));

  return {
    base, password, logs, dbPath,
    /** 停服务 + 删临时库（含 sqlite 旁路文件） */
    async stop() {
      try { if (child.exitCode === null) child.kill(); } catch (e) { /* 已退出 */ }
      await new Promise((r) => {
        if (child.exitCode !== null) return r();
        child.once("exit", r);
        setTimeout(r, 4000);
      });
      for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm", dbPath + "-journal"]) {
        try { rmSync(f, { force: true }); } catch (e) { /* 忽略 */ }
      }
    },
  };
}

/**
 * 新建页面上下文，注入 __a11y 辅助（可聚焦元素识别 / activeElement 定位）。
 */
export async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 1440, height: 900 },
    locale: "zh-CN",
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
  page.on("dialog", (d) => d.accept().catch(() => {}));
  /* UX-05：危险操作的原生 confirm 已统一为站内弹层（#dsconfirm）。这里做与上一行「自动接受」等价的处理，
     使既有用例「弹层会被接受」的语义保持不变；需要验证「取消」分支时先把 window.__AUTOCONFIRM 置 false。 */
  await page.addInitScript(() => {
    const accept = () => {
      if (window.__AUTOCONFIRM === false) return;
      const el = document.getElementById("dsconfirm");
      if (!el || el.hidden) return;
      const ok = document.getElementById("dscfok");
      if (ok) ok.click();
    };
    const boot = () => {
      new MutationObserver(accept).observe(document.body, {
        attributes: true, subtree: true, attributeFilter: ["hidden"],
      });
    };
    if (document.body) boot(); else document.addEventListener("DOMContentLoaded", boot);
  });
  await page.addInitScript(() => {
    /* 与源码 dlgFocusables 同口径：排除 disabled / hidden / display:none / visibility:hidden / tabindex=-1 */
    window.__a11y = {
      focusables(sel) {
        const root = typeof sel === "string" ? document.querySelector(sel) : sel;
        if (!root) return [];
        const out = [];
        for (const el of root.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')) {
          if (el.disabled || el.type === "hidden") continue;
          if (el.getAttribute("tabindex") === "-1") continue;
          if (el.closest("[hidden]")) continue;
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          if (!el.getClientRects().length) continue;
          out.push(el);
        }
        return out;
      },
      active() {
        const a = document.activeElement;
        if (!a) return null;
        return {
          id: a.id || "", tag: a.tagName, cls: String(a.className || ""),
          inModal: !!(a.closest && a.closest("#modal")),
          inPush: !!(a.closest && a.closest("#pushmodal")),
          inPwd: !!(a.closest && a.closest("#pwdmodal")),
          inBody: a === document.body,
        };
      },
      head() {
        const els = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')];
        return els.length;
      },
    };
  });
  return {
    ctx, page, consoleErrors, pageErrors,
    close: () => ctx.close(),
  };
}

/** 登录并等到消息列表就绪 */
export async function login(page, app, lang = "zh-CN") {
  await page.goto(app.base + "/?lang=" + lang, { waitUntil: "domcontentloaded" });
  if (await page.locator("#pw").isVisible().catch(() => false)) {
    await page.fill("#pw", app.password);
    await page.click("#go");
  }
  await page.waitForSelector("#list", { timeout: 30000 });
  await page.waitForTimeout(200);
}

/** 打开设置中心（按视口走桌面按钮或移动端「更多」菜单） */
export async function openSettings(page) {
  const vw = page.viewportSize().width;
  if (vw <= 560) {
    await page.click("#morebtn");
    await page.click("#mnuset");
  } else {
    await page.click("#setbtn");
  }
  await page.waitForSelector("#scbody .sc-group", { timeout: 20000 });
}

/** 切到某个设置分区 */
export async function gotoTab(page, key) {
  await page.click('[data-sc-tab="' + key + '"]');
  await page.waitForTimeout(180);
}

/** 点保存并走完密码确认（通知分区需要密码） */
export async function saveSettings(page, app) {
  await page.click("#scrsave");
  const pwd = page.locator("#pwdmodal");
  if (await pwd.isVisible().catch(() => false)) {
    await page.fill("#pwdinput", app.password);
    await page.press("#pwdinput", "Enter");
    await page.waitForTimeout(260);
  }
  await page.waitForTimeout(700);
}

/** 读取设置状态条 */
export async function readStatus(page) {
  return await page.evaluate(() => {
    const s = document.getElementById("scstatus");
    if (!s) return null;
    return { text: s.innerText, cls: s.className, hidden: s.hidden, role: s.getAttribute("role"), live: s.getAttribute("aria-live") };
  });
}

/** 统一的断言器：pass/fail 计数 + 失败清单 + 退出码 */
export function reporter(tag) {
  const R = { tag, pass: 0, fail: 0, failed: [], checks: [] };
  R.ok = (cond, name, detail) => {
    R.checks.push({ name, ok: !!cond });
    if (cond) R.pass++;
    else { R.fail++; R.failed.push(name); }
    const d = detail === undefined || detail === null || detail === "" ? "" : "  [" + detail + "]";
    console.log((cond ? "  ok   " : "  FAIL ") + name + d);
  };
  R.group = (t) => console.log("\n# " + t);
  R.done = () => {
    console.log("\n== " + tag + " 结果：pass=" + R.pass + " fail=" + R.fail);
    if (R.fail) console.log("失败项：" + R.failed.join(" | "));
    process.exitCode = R.fail ? 1 : 0;
  };
  return R;
}

/** 断言控制台/页面错误为空（可传入允许的噪声正则） */
export function noPageErrors(R, page, consoleErrors, pageErrors, allow) {
  const allowRe = allow instanceof RegExp ? allow : null;
  const ce = consoleErrors.filter((t) => !(allowRe && allowRe.test(t)));
  R.ok(ce.length === 0, "浏览器控制台无 error", ce.slice(0, 3).join(" ; ").slice(0, 200));
  R.ok(pageErrors.length === 0, "无未捕获页面异常", pageErrors.slice(0, 3).join(" ; ").slice(0, 200));
}
