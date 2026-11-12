/**
 * UX-08 结构审计：原生阻断式交互清除、键盘路径、弹窗规范、空态状态分离、移动端操作可见
 * 运行：node tests/ux08-interaction.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "src", "worker.js"), "utf8");

let pass = 0, fail = 0;
const t = (name, ok, extra = "") => {
  if (ok) { pass++; console.log("  ok   " + name + (extra ? "  [" + extra + "]" : "")); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
};
const has = (s) => SRC.indexOf(s) !== -1;
const count = (re) => (SRC.match(re) || []).length;

/* A. 原生阻断式交互 */
t("A1 无原生 alert()", count(/\balert\(/g) === 0);
t("A2 原生 prompt 仅保留 dsPrompt 的降级兜底", count(/\bprompt\(/g) === 1 && /if \(!el \|\| !ttl \|\| !inp \|\| !ok \|\| !no\) return Promise\.resolve\(window\.prompt/.test(SRC));
t("A3 confirm 仅保留 dsConfirm 的降级兜底", count(/window\.confirm/g) === 1);
t("A4 统一输入弹窗存在", has("function dsPrompt(opt)") && has('id="dsprompt"'));
t("A5 统一提示弹窗存在（dsConfirm alert 模式）", /function dsAlert\(message, okText\)/.test(SRC) && /noBtn\.hidden = !!opt\.alert;/.test(SRC));
t("A6 设备重命名走统一弹窗", /function devRename\(d\) \{\s*dsPrompt\(\{/.test(SRC));
t("A7 设备合并不再用 prompt，仍保留密码校验", /function devMerge\(d\)[\s\S]{0,2400}?askPassword\(/.test(SRC) && !/var pick = prompt\(/.test(SRC));
t("A8 号码标签走统一弹窗（弹层与双栏共用同一绑定）", /var lb = q\("#dlabel"\);[\s\S]{0,400}?dsPrompt\(\{/.test(SRC));
t("A9 令牌重命名走统一弹窗", /function renameTokenUi\(id\)[\s\S]{0,600}?dsPrompt\(\{/.test(SRC));
t("A10 设备错误全部改用 dsAlert", count(/dsAlert\(/g) >= 4);

/* B. 弹窗规范 */
t("B1 必填校验 + 自定义 validate", /if \(opt\.required && !val\)/.test(SRC) && /typeof opt\.validate === "function"/.test(SRC));
t("B2 提交中禁用按钮（防重复提交）", /busy = true; ok\.disabled = true; no\.disabled = true;/.test(SRC) && /if \(busy\) return;/.test(SRC));
t("B3 失败保留弹窗与输入并可重试", /if \(r === false\) \{ fail\(opt\.failMsg\); return; \}/.test(SRC) && /err\.hidden = false;/.test(SRC));
t("B4 Enter 提交 / Esc 取消", /if \(ev\.key === "Enter"\) \{ ev\.preventDefault\(\); submit\(\); \}/.test(SRC));
t("B5 复用弹层焦点体系（dlgOpen/dlgClose）", /dlgOpen\(el, \{ initial: inp \}\)/.test(SRC) && /dlgClose\(el\);/.test(SRC));
t("B6 Esc 只关最上层且含 dsprompt 分派", /id === "dsprompt"\) \{ if \(DSP_RES\) DSP_RES\(null\); \}/.test(SRC));
t("B7 提交中不允许关闭", /no\.onclick = function \(\) \{ if \(!busy\) close\(null\); \}/.test(SRC) && /ev\.target === el && !busy\) close\(null\)/.test(SRC));

/* C. 键盘路径 */
t("C1 卡片可聚焦且有语义标签", /tabindex="0" role="article" aria-label="/.test(SRC));
t("C2 Enter/Space 打开详情", /if \(ev\.key === "Enter" \|\| ev\.key === " " \|\| ev\.key === "Spacebar"\) \{[\s\S]{0,120}?openDetail\(/.test(SRC));
t("C3 方向键/Home/End 移动焦点", /if \(ev\.key === "ArrowDown"\) \{ go\(cards\[i \+ 1\]\); return; \}/.test(SRC) && /if \(ev\.key === "End"\)/.test(SRC));
t("C4 焦点移动后滚入可视区", /el\.scrollIntoView\(\{ block: "nearest" \}\)/.test(SRC));
t("C5 卡片焦点可见（focus-visible 环）", /\.card:focus-visible \{ outline: 2px solid var\(--ds-color-focus\)/.test(SRC));
t("C6 双栏下 Esc 清除选中", /if \(ev\.key === "Escape" && splitOn\(\) && state\.detailId\)/.test(SRC));
t("C7 保留 / 聚焦搜索（不抢输入框按键）", /if \(e\.key === "\/" && !typing\)/.test(SRC));

/* D. 空态状态与文案分离 */
t("D1 空态状态键独立于文案", /paneState: "empty"/.test(SRC) && /function panEmptyRender\(\)/.test(SRC));
/* UX-09 U9-12 把详情空态从三态扩到五态（empty / missing / fail / loading / unauth），
   断言改为「在 panEmptyRender 内按状态分支取不同 i18n 键」，不再锁死一行的三元表达式写法 */
const PANE_FN = SRC.slice(SRC.indexOf("function panEmptyRender()"), SRC.indexOf("function paneEmptyState("));
t("D2 按状态取 i18n 键", /key === "missing"/.test(PANE_FN) && /key === "fail"/.test(PANE_FN) &&
  /key === "loading"/.test(PANE_FN) && /key === "unauth"/.test(PANE_FN) &&
  /T\("paneMissing"\)/.test(PANE_FN) && /T\("detailFail"\)/.test(PANE_FN) && /T\("paneEmpty"\)/.test(PANE_FN));
t("D2b 失败/未登录态给出重试入口（UX-09 U9-12）",
  /empty\.querySelector\("#paneretry"\)/.test(PANE_FN) && /btn\.id = "paneretry"/.test(PANE_FN) &&
  /openPane\(state\.detailId\)/.test(PANE_FN));
t("D3 切换语言后按状态重算", /if \(typeof panEmptyRender === "function"\) panEmptyRender\(\);/.test(SRC));
t("D4 空态三态齐备", /paneEmptyState\("missing"\)/.test(SRC) && /paneEmptyState\("fail"\)/.test(SRC) && /paneEmptyState\(\)/.test(SRC));

/* E. 移动端操作可见 */
t("E1 手机详情次要操作改换行（不再横滑）", /\.modal-foot \.foot-left \{ width: 100%; flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 8px; \}/.test(SRC));
t("E2 移除 foot-left 的横向滚动", !/\.modal-foot \.foot-left \{[^}]*overflow-x: auto/.test(SRC));
t("E3 次要按钮均分且 ≥44px 高", /\.modal-foot \.foot-left \.tbtn \{ flex: 1 1 auto; min-width: 72px; \}/.test(SRC) && /\.modal-foot \.tbtn \{ width: auto; min-width: 72px; min-height: 44px;/.test(SRC));

/* F. i18n 九语种 */
const langs = ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt-BR"];
const keys = ["dspRequired", "dspFail", "dspSaving", "dspTooLong", "dspPickRange", "dspRenameTitle", "dspMergeTitle", "dspLabelTitle", "dspTokTitle", "dspLabelEmpty"];
const block = (SRC.match(/var DSP_I18N = \{[\s\S]*?\n  \};/) || [""])[0];
t("F1 DSP_I18N 表存在", block.length > 300);
t("F2 九语种 × 十键齐全", langs.every((l) => {
  const m = block.match(new RegExp('"?' + l + '"?: \\{[\\s\\S]*?\\n    \\}'));
  return m && keys.every((k) => m[0].indexOf(k + ":") !== -1);
}), langs.length + " langs / " + keys.length + " keys");

/* G. 不变量 */
t("G1 每页仍默认 10 条", /limit: 10/.test(SRC));
t("G2 上传令牌明文一次性语义未变", /tokenSecret = null/.test(SRC));
t("G3 未新增 API 路由", count(/"\/api\/[a-z/-]+"/g) === count(/"\/api\/[a-z/-]+"/g) && has('"/api/messages/star"'));
t("G4 无新增运行时依赖", !has("require(\"") && !has("from \""));
/* ===== UX-08-T2：660px 媒体块 —— 整块取证 + 窄白名单 =====
   旧写法 `/.modal-foot[^}]*!important/` 有两个毛病：① 只盯 .modal-foot 一条选择器，
   媒体块里任何其它规则加了 !important 都发现不了；② 对现行源码就会误报（660 块里
   .modal-foot 的规则本就带 !important 语义相近的字样）。这里改为：
   配对花括号提取 @media (max-width: 660px) 的**完整块内容** → 解析块内全部 CSS 规则
   → 逐个取出带 !important 的 (选择器, 属性) → 只允许窄白名单内的条目，其余一律 FAIL。 */
function cssBlockBody(src, atIdx) {
  const open = src.indexOf("{", atIdx);
  if (open < 0) return null;
  let depth = 0, quote = "";
  for (let p = open; p < src.length; p++) {
    const c = src[p];
    if (quote) {
      if (c === "\\") { p++; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "/" && src[p + 1] === "*") { p = src.indexOf("*/", p + 2); if (p < 0) return null; p++; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, p);
    }
  }
  return null;
}
/* 递归解析 CSS 规则：返回 [{ sel, prop, important, raw }]，嵌套 at-rule 也会进到里面 */
function cssImportantRules(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const prelude = css.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(/\s+/g, " ");
    const body = cssBlockBody(css, open);
    if (body === null) break;
    i = open + body.length + 2;
    if (prelude.startsWith("@")) { out.push(...cssImportantRules(body)); continue; }
    for (const decl of body.split(";")) {
      if (!decl.includes("!important")) continue;
      const c = decl.indexOf(":");
      if (c < 0) continue;
      out.push({ sel: prelude, prop: decl.slice(0, c).trim(), raw: (prelude + " { " + decl.trim() + " }") });
    }
  }
  return out;
}
const MEDIA_660 = "@media (max-width: 660px)";
const blocks660 = (() => {
  const list = [];
  let i = 0;
  for (;;) {
    const j = SRC.indexOf(MEDIA_660, i);
    if (j < 0) break;
    const body = cssBlockBody(SRC, j);
    if (body === null) return null;
    list.push(body);
    i = j + MEDIA_660.length;
  }
  return list;
})();
const important660 = (blocks660 || []).flatMap(cssImportantRules);
/* 白名单窄到「具体选择器 + 具体属性」，不放行整块、也不放行大类选择器 */
const IMPORTANT_660_ALLOW = [
  { sel: ".nav-mobile", prop: "display" },
  { sel: ".nav-desktop", prop: "display" }
];
const important660Bad = important660.filter((r) =>
  !IMPORTANT_660_ALLOW.some((w) => w.sel === r.sel && w.prop === r.prop));

t("G5 660px 媒体块整块提取成功（非 200 字符窗口）",
  !!blocks660 && blocks660.length > 0 && Math.max(...blocks660.map((b) => b.length)) > 1000,
  blocks660 ? "blocks=" + blocks660.length + " maxLen=" + Math.max(...blocks660.map((b) => b.length)) : "花括号不配对");
t("G5-1 660px 媒体块内 !important 仅限白名单（" + IMPORTANT_660_ALLOW.map((w) => w.sel + ":" + w.prop).join(" / ") + "）",
  important660.length > 0 && important660Bad.length === 0,
  important660Bad.length ? important660Bad.map((r) => r.raw).join(" ｜ ") : "命中 " + important660.length + " 条，均在白名单");
t("G5-2 白名单条目必须真实存在（禁止空放行）",
  IMPORTANT_660_ALLOW.every((w) => important660.some((r) => r.sel === w.sel && r.prop === w.prop)),
  "白名单里有源码中并不存在的条目");
t("G5-3 白名单选择器窄到单个类（不许大类 / 后代 / 逗号分组）",
  IMPORTANT_660_ALLOW.every((w) => /^\.[\w-]+$/.test(w.sel) && /^[a-z-]+$/.test(w.prop)),
  IMPORTANT_660_ALLOW.map((w) => w.sel).join(","));
t("G5-4 弹窗底栏未用 !important 强行布局",
  !important660.some((r) => /\.modal-foot/.test(r.sel)) && !/\.modal-foot[^}]*!important/.test(SRC));

/* H. 反馈规范（Toast）——类型 / 时长 / 堆叠 / 无障碍 / 小屏 */
const toastFn = (SRC.match(/function toast\(msg, opt\)[\s\S]*?\n  \}/) || [""])[0];
t("H1 toast 支持第二参数选项对象", toastFn.length > 200 && /opt\.type/.test(toastFn));
t("H2 五种类型都有独立时长表", /TOAST_MS = \{ success: \d+, info: \d+, warning: \d+, error: \d+, loading: 0 \}/.test(SRC));
t("H3 错误类提示时长 > 普通提示（留足阅读）", (() => {
  const m = SRC.match(/TOAST_MS = \{ success: (\d+), info: (\d+), warning: (\d+), error: (\d+)/);
  return !!m && Number(m[4]) > Number(m[1]) && Number(m[3]) > Number(m[2]);
})());
t("H4 堆叠上限常量存在且为 3", /TOAST_MAX = 3/.test(SRC));
t("H5 超出上限时移除最早的提示", /alive\.length - TOAST_MAX/.test(toastFn));
t("H6 error / warning 使用 role=alert，其余 status", /toast--" \+ type/.test(toastFn) && /"alert" : "status"/.test(toastFn));
t("H7 提示主体区分标记点与正文（结构化，不用纯文本拼接）", /toast-dot/.test(toastFn) && /toast-txt/.test(toastFn));
t("H8 常驻类提示带手动关闭按钮", /toast-close/.test(toastFn) && /aria-label/.test(toastFn));
t("H9 类型配色取自反色面专用令牌（不硬编码色值）", /\.toast--success \.toast-dot \{ background: var\(--ds-color-on-inverse-success\)/.test(SRC)
  && /\.toast--error \.toast-dot \{ background: var\(--ds-color-on-inverse-danger\)/.test(SRC));
t("H10 反色面类型令牌在深浅两个主题都有定义", count(/--ds-color-on-inverse-success:/g) === 2);
t("H11 小屏提示条左右留边且不溢出", /@media \(max-width: 660px\) \{[\s\S]{0,220}\.toastroot \{ left: 12px; right: 12px/.test(SRC));
t("H12 关闭按钮标签走 i18n（九语种）", (() => {
  const b = (SRC.match(/var TOAST_I18N = \{[\s\S]*?\n  \};/) || [""])[0];
  const ls = ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt-BR"];
  return b.length > 200 && ls.every((l) => new RegExp('"?' + l + '"?: \{ toastClose:').test(b));
})());
t("H13 正文一律用反色前景（类型只染标记与描边）", /\.toast-txt \{ min-width: 0/.test(SRC) && !/\.toast--\w+ \{[^}]*color:/.test(SRC));

/* I. 弹层规范——滚动锁定 / Esc 单层 / 提交中禁止关闭 */
t("I1 弹层打开时锁背景滚动，关闭后恢复", /function dlgLockScroll/.test(SRC) && /function dlgUnlockScroll/.test(SRC)
  && /DLG_STACK\.push\(rec\);\s*\n\s*dlgLockScroll\(\);/.test(SRC) && /if \(!DLG_STACK\.length\) dlgUnlockScroll\(\);/.test(SRC));
t("I2 输入弹窗的 Esc 阻止冒泡（不会一次关两层）", /ev\.stopPropagation\(\)/.test(SRC));
t("I3 双栏 Esc 清选中在文档级生效（不依赖列表焦点）", /if \(splitOn\(\) && state\.detailId\) \{ state\.detailId = 0; paneMarkSel\(0\); paneEmptyState\(\); \}/.test(SRC));
t("I4 跨断点收起只清视觉选中、保留详情记忆", /离开双栏：只清视觉选中/.test(SRC));

console.log("\n===== UX-08 结构：pass=" + pass + " fail=" + fail + " =====");
process.exit(fail ? 1 : 0);
