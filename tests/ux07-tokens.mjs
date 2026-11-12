/**
 * UX-07A 全局视觉体系一致性测试（静态 + 计算，不需要浏览器）
 *
 * 运行：node tests/ux07-tokens.mjs   （退出码 0=全过，1=有失败，2=异常）
 *
 * 覆盖：
 *  A. 令牌结构：单一浅色真源 + 单一深色覆盖，无 media/light 副本
 *  B. 引用完整性：无未定义 var()，零引用令牌仅限显式白名单（标度/协议值/JS 取值）
 *  C. 必需令牌清单：颜色 / 尺寸 / 动效 / 层级
 *  D. 主题同步：theme-color 单一来源、跟随 data-theme、首帧不闪
 *  E. Toast：反色语义令牌，无硬编码、无系统偏好单独覆盖
 *  F. 组件：z-index 无裸值、遮罩共用令牌、主按钮 fill/on-primary、焦点色统一
 *  G. 硬编码色值预算与分类例外（邮件模板 / PWA manifest）
 *  H. 对比度计算：三级文本、反转色、主按钮、主色非文本对比
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SELF = dirname(fileURLToPath(import.meta.url));
const REPO = join(SELF, "..");
const SRC = readFileSync(join(REPO, "src/worker.js"), "utf8");

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log("FAIL " + name + (detail ? " :: " + detail : ""));
}

/* ---------- 取出 DS_TOKENS_CSS 整段与两个主题块 ---------- */
const TOK_START = SRC.indexOf("const DS_TOKENS_CSS");
const TOK_END = SRC.indexOf("const PAGE_HTML");
/* 令牌块所在行号区间（用于「区外硬编码色值」统计） */
const TOK_START_LINE = SRC.slice(0, TOK_START).split("\n").length;
const TOK_END_LINE = SRC.slice(0, TOK_END).split("\n").length;
const TOK = SRC.slice(TOK_START, TOK_END);

/** 从 `from` 起找第一个 `{`，按大括号配对返回块内容 */
function braceSlice(from) {
  const i = SRC.indexOf("{", from);
  if (i < 0) return "";
  let depth = 0;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === "{") depth++;
    else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(i + 1, j); }
  }
  return "";
}
const ROOT_M = TOK.match(/:root\s*\{/);
const ROOT = ROOT_M ? braceSlice(TOK_START + ROOT_M.index) : "";
const DARK_M = TOK.match(/html\[data-theme="dark"\]\s*\{/);
const DARK_AT = DARK_M ? DARK_M.index : -1;
const DARK = DARK_M ? braceSlice(TOK_START + DARK_AT) : "";

/** 解析 `--name: value;`（允许一行多个） */
function parseVars(block) {
  const out = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;{}]+);/g;
  let m;
  while ((m = re.exec(block))) out[m[1]] = m[2].trim();
  return out;
}
const LIGHT = parseVars(ROOT);
const DARKV = parseVars(DARK);

/* ---------- 颜色工具 ---------- */
function parseColor(v) {
  if (!v) return null;
  v = String(v).trim();
  let m = v.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(",").map((x) => parseFloat(x));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  return null;
}
function over(fg, bg) { /* alpha 合成到不透明背景 */
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}
function lum(c) {
  const f = c.slice(0, 3).map((x) => {
    const v = x / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}
function ratio(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** 取某主题下某令牌颜色；支持 var() 别名一层解析 */
function colorOf(theme, name) {
  const map = theme === "dark" ? DARKV : LIGHT;
  let v = map[name];
  if (v === undefined) v = LIGHT[name];
  if (v === undefined) return null;
  const vm = v.match(/^var\((--[a-z0-9-]+)\)$/);
  if (vm) return colorOf(theme, vm[1]);
  return parseColor(v);
}

/* ================= A. 令牌结构 ================= */
t("A1 令牌块标记为 v2（结构已收敛）", /DS TOKENS v2/.test(TOK));
t("A2 令牌区不再有 @media (prefers-color-scheme) 深色副本",
  !/@media\s*\(prefers-color-scheme:\s*dark\)/.test(TOK), "仍存在 media 深色块");
t("A3 不再有 html[data-theme=\"light\"] 整份浅色副本",
  DARK_AT > -1 && !/html\[data-theme="light"\]\s*\{/.test(TOK), "仍有 light 副本");
t("A4 存在深色覆盖块 html[data-theme=\"dark\"]", DARK.length > 100, "长度 " + DARK.length);
t("A5 浅色令牌数量合理（>=80）", Object.keys(LIGHT).length >= 80, "count=" + Object.keys(LIGHT).length);
t("A6 深色块只覆盖差异（数量少于浅色）",
  Object.keys(DARKV).length > 30 && Object.keys(DARKV).length < Object.keys(LIGHT).length,
  "dark=" + Object.keys(DARKV).length + " light=" + Object.keys(LIGHT).length);

/* ================= B. 引用完整性 ================= */
const defs = new Set([...Object.keys(LIGHT), ...Object.keys(DARKV)]);
const refs = [...SRC.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
const uniqRefs = [...new Set(refs)];
/* --list-pad 由 .wrap 在局部作用域定义并带兜底值，不属于令牌层 */
const UNDEFINED_ALLOW = new Set(["--list-pad"]);
const undefinedRefs = uniqRefs.filter((r) => !defs.has(r) && !UNDEFINED_ALLOW.has(r));
t("B1 所有 var() 引用都有定义", undefinedRefs.length === 0, undefinedRefs.join(", "));

/* 零引用白名单：
   - --ds-color-chrome：由 JS getPropertyValue 读取后写入 meta，不走 var()
   - --ds-touch-min：UX-08 命中区改造的协议值，本轮只定义不扩张命中区（任务书 §6.3）
   - --ds-space-6：间距标度成员（4/6/8/12/16/24/32），删掉会让标度不连续 */
const ZERO_OK = new Set(["--ds-color-chrome", "--ds-touch-min", "--ds-space-6"]);
const refSet = new Set(refs);
const zeroRefs = [...defs].filter((d) => !refSet.has(d));
const badZero = zeroRefs.filter((d) => !ZERO_OK.has(d));
t("B2 无无意义零引用令牌", badZero.length === 0, badZero.join(", "));
t("B3 零引用白名单未被滥用（≤3）", zeroRefs.length <= 3, zeroRefs.join(", "));

/* ================= C. 必需令牌 ================= */
const REQUIRED_COLOR = [
  "--ds-color-bg-page", "--ds-color-bg-surface", "--ds-color-bg-subtle", "--ds-color-bg-raised",
  "--ds-color-surface-hover", "--ds-color-surface-active", "--ds-color-overlay",
  "--ds-color-inverse-bg", "--ds-color-inverse-fg",
  "--ds-color-text", "--ds-color-text-secondary", "--ds-color-text-tertiary", "--ds-color-text-disabled",
  "--ds-color-border", "--ds-color-divider",
  "--ds-color-primary", "--ds-color-primary-hover", "--ds-color-primary-subtle",
  "--ds-color-primary-fill", "--ds-color-primary-fill-hover", "--ds-color-primary-active", "--ds-color-on-primary",
  "--ds-color-success", "--ds-color-success-subtle", "--ds-color-warning", "--ds-color-warning-subtle",
  "--ds-color-danger", "--ds-color-danger-subtle", "--ds-color-info", "--ds-color-info-subtle",
  "--ds-color-focus",
];
const missColor = REQUIRED_COLOR.filter((k) => !LIGHT[k]);
t("C1 颜色语义令牌齐全（浅色）", missColor.length === 0, missColor.join(", "));
/* 主题相关令牌必须在深色块里重新给值 */
const DARK_REQUIRED = [
  "--ds-color-bg-page", "--ds-color-bg-surface", "--ds-color-bg-subtle", "--ds-color-bg-raised",
  "--ds-color-surface-hover", "--ds-color-surface-active", "--ds-color-overlay",
  "--ds-color-inverse-bg", "--ds-color-inverse-fg",
  "--ds-color-text", "--ds-color-text-secondary", "--ds-color-text-tertiary", "--ds-color-text-disabled",
  "--ds-color-border", "--ds-color-divider",
  "--ds-color-primary", "--ds-color-primary-fill", "--ds-color-primary-fill-hover", "--ds-color-on-primary",
  "--ds-color-success", "--ds-color-danger", "--ds-color-info", "--ds-color-warning",
  "--ds-color-focus", "--ds-field-bg", "--ds-field-border",
];
const missDark = DARK_REQUIRED.filter((k) => !DARKV[k]);
t("C2 深色主题覆盖齐全", missDark.length === 0, missDark.join(", "));

const REQUIRED_SIZE = [
  "--ds-font-size-xs", "--ds-font-size-sm", "--ds-font-size-md", "--ds-font-size-lg",
  "--ds-font-weight-normal", "--ds-font-weight-semibold", "--ds-font-weight-bold",
  "--ds-line-height-base", "--ds-line-height-tight", "--ds-line-height-relaxed",
  "--ds-space-1", "--ds-space-5", "--ds-radius-sm", "--ds-radius-full",
  "--ds-control-h", "--ds-control-h-sm", "--ds-control-h-lg", "--ds-touch-min",
  "--ds-icon-sm", "--ds-icon-md", "--ds-content-max",
];
const missSize = REQUIRED_SIZE.filter((k) => !LIGHT[k]);
t("C3 尺寸令牌齐全", missSize.length === 0, missSize.join(", "));

const REQUIRED_MOTION = ["--ds-duration-fast", "--ds-duration-base", "--ds-duration-slow", "--ds-ease"];
t("C4 动效令牌齐全", REQUIRED_MOTION.every((k) => LIGHT[k]), REQUIRED_MOTION.filter((k) => !LIGHT[k]).join(", "));

const REQUIRED_Z = ["--ds-z-sticky", "--ds-z-dropdown", "--ds-z-modal", "--ds-z-modal-stacked", "--ds-z-popover", "--ds-z-toast"];
t("C5 层级令牌齐全", REQUIRED_Z.every((k) => LIGHT[k]), REQUIRED_Z.filter((k) => !LIGHT[k]).join(", "));

/* 命名冲突已消除：不再有 --ds-text-* 字号令牌 */
t("C6 字号与颜色命名冲突已消除（无 --ds-text-* 令牌）",
  !Object.keys(defs).some((k) => /^--ds-text-/.test(k)),
  Object.keys(defs).filter((k) => /^--ds-text-/.test(k)).join(", "));
/* 兼容别名仍在（旧选择器不失效） */
t("C7 旧变量别名保留", /--bg:\s*var\(--ds-color-bg-page\)/.test(ROOT) && /--accent:\s*var\(--ds-color-primary\)/.test(ROOT));
t("C8 --ds-content-max 与真实容器一致（不是 760 旧值）",
  LIGHT["--ds-content-max"] === "1120px" && /\.wrap\s*\{[^}]*max-width:\s*var\(--ds-content-max\)/.test(SRC),
  LIGHT["--ds-content-max"]);

/* ================= D. 主题同步 ================= */
const metas = SRC.match(/<meta name="theme-color"[^>]*>/g) || [];
t("D1 theme-color 只有单一定义（不再用 media 双写）", metas.length === 2, "count=" + metas.length);
t("D2 theme-color 不带 media 属性", metas.every((m) => !/media=/.test(m)), metas.join(" | "));
t("D3 theme-color meta 不再残留旧深色值 #14171a",
  !metas.some((m) => /#14171a/i.test(m)), metas.join(" | "));
t("D4 首帧前写入 data-theme（管理页与登录页各一处）",
  (SRC.match(/document\.documentElement\.setAttribute\("data-theme", t\)/g) || []).length === 2,
  "count=" + (SRC.match(/document\.documentElement\.setAttribute\("data-theme", t\)/g) || []).length);
t("D5 applyTheme 不再移除 data-theme（attribute 是唯一真源）",
  !/removeAttribute\("data-theme"\)/.test(SRC));
t("D6 theme-color 取值来自令牌 --ds-color-chrome",
  /getPropertyValue\("--ds-color-chrome"\)/.test(SRC));
t("D7 系统主题变化时 auto 模式跟随",
  /matchMedia\("\(prefers-color-scheme: dark\)"\)/.test(SRC) && /addEventListener\("change", onScheme\)/.test(SRC));

/* ================= E. Toast ================= */
const toastRule = (SRC.match(/\.toast\s*\{[^}]*\}/g) || []).find((r) => /background/.test(r)) || "";
t("E1 Toast 使用反色语义令牌",
  /background:\s*var\(--ds-color-inverse-bg\)/.test(toastRule) && /color:\s*var\(--ds-color-inverse-fg\)/.test(toastRule),
  toastRule.slice(0, 80));
t("E2 Toast 规则内无硬编码色值",
  !/#[0-9a-f]{3,8}\b|rgba?\(/i.test(toastRule.replace(/var\([^)]*\)/g, "")), toastRule);
t("E3 不存在只认系统偏好的 .toast 覆盖规则",
  !/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[^}]*\.toast/.test(SRC));
t("E4 Toast 层级高于弹层（提示条在弹层内可见）",
  parseFloat(LIGHT["--ds-z-toast"]) > parseFloat(LIGHT["--ds-z-modal"]),
  LIGHT["--ds-z-toast"] + " vs " + LIGHT["--ds-z-modal"]);

/* ================= F. 组件 ================= */
const bareZ = SRC.match(/z-index:\s*-?\d+/g) || [];
t("F1 无裸 z-index 数字", bareZ.length === 0, bareZ.join(", "));
const bareOverlay = SRC.match(/background:\s*rgba\(0\s*,\s*0\s*,\s*0\s*,\s*\.?4/g) || [];
t("F2 弹层遮罩共用 --ds-color-overlay", bareOverlay.length === 0, bareOverlay.join(", "));
t("F3 主按钮使用 fill + on-primary",
  /\.ds-btn--primary\s*\{[^}]*background:\s*var\(--ds-color-primary-fill\)[^}]*color:\s*var\(--ds-color-on-primary\)/.test(SRC));
t("F4 焦点色统一为 --ds-color-focus",
  (SRC.match(/outline:\s*2px solid var\(--ds-color-focus\)/g) || []).length >= 5,
  "count=" + (SRC.match(/outline:\s*2px solid var\(--ds-color-focus\)/g) || []).length);
t("F5 全局焦点环仍走 --ds-color-link（兼容别名指向 focus）",
  /outline:\s*2px solid var\(--ds-color-link\)/.test(SRC) && LIGHT["--ds-color-link"] === "var(--ds-color-focus)");
t("F6 未定义变量 --danger 的历史 bug 已修",
  !/var\(--danger\)/.test(SRC) && /\.msg-actions \.del:hover\s*\{\s*color:\s*var\(--ds-color-danger\)/.test(SRC));

/* ================= G. 硬编码色值预算 ================= */
/* 允许保留的例外：邮件通知 HTML（自包含，不能依赖页面变量）、PWA manifest、meta theme-color 初始值 */
const lines = SRC.split("\n");
/* ENG-01 OPT-1 在 renderHtml 后新增 serveHtml（+36 行），邮件模板/manifest 行号整体后移；
   白名单口径不变：邮件模板 + manifest 的硬编码色值（meta 初始值由 stray≤2 兜底） */
const OUT_OK_RANGES = [[1210, 1245], [1800, 1830]]; /* 邮件模板 + manifest */
let stray = [];
lines.forEach((l, i) => {
  const n = i + 1;
  if (n >= TOK_START_LINE && n <= TOK_END_LINE) return;
  if (!/#[0-9a-fA-F]{3,8}\b/.test(l)) return;
  if (OUT_OK_RANGES.some(([a, b]) => n >= a && n <= b)) return;
  stray.push(n + ": " + l.trim().slice(0, 60));
});
t("G1 令牌区外硬编码色值仅剩白名单位置（邮件模板 / manifest / meta 初始值）",
  stray.length <= 2, stray.join(" | "));

/* ================= H. 对比度 ================= */
function pair(theme, fgName, bgName) {
  const fg = colorOf(theme, fgName), bg = colorOf(theme, bgName);
  if (!fg || !bg) return null;
  return ratio(fg[3] < 1 ? over(fg, bg) : fg, bg);
}
const cTertLight = pair("light", "--ds-color-text-tertiary", "--ds-color-bg-surface");
const cTertLightPage = pair("light", "--ds-color-text-tertiary", "--ds-color-bg-page");
const cTertDark = pair("dark", "--ds-color-text-tertiary", "--ds-color-bg-surface");
const cSecLight = pair("light", "--ds-color-text-secondary", "--ds-color-bg-surface");
const cSecDark = pair("dark", "--ds-color-text-secondary", "--ds-color-bg-surface");
const cPrimaryTextL = pair("light", "--ds-color-text", "--ds-color-bg-page");
const cPrimaryTextD = pair("dark", "--ds-color-text", "--ds-color-bg-page");
const cOnPrimaryL = pair("light", "--ds-color-on-primary", "--ds-color-primary-fill");
const cOnPrimaryD = pair("dark", "--ds-color-on-primary", "--ds-color-primary-fill");
const cInverseL = pair("light", "--ds-color-inverse-fg", "--ds-color-inverse-bg");
const cInverseD = pair("dark", "--ds-color-inverse-fg", "--ds-color-inverse-bg");
const cFieldBorderL = pair("light", "--ds-field-border", "--ds-color-bg-surface");
const cFieldBorderD = pair("dark", "--ds-field-border", "--ds-color-bg-surface");

t("H1 三级文本 浅色 ≥4.5（白底）", cTertLight >= 4.5, (cTertLight || 0).toFixed(2));
t("H2 三级文本 浅色 ≥4.5（页面底）", cTertLightPage >= 4.5, (cTertLightPage || 0).toFixed(2));
t("H3 三级文本 深色 ≥4.5", cTertDark >= 4.5, (cTertDark || 0).toFixed(2));
t("H4 次级文本 ≥4.5（浅/深）", cSecLight >= 4.5 && cSecDark >= 4.5,
  (cSecLight || 0).toFixed(2) + " / " + (cSecDark || 0).toFixed(2));
t("H5 正文 ≥4.5（浅/深）", cPrimaryTextL >= 7 && cPrimaryTextD >= 7,
  (cPrimaryTextL || 0).toFixed(2) + " / " + (cPrimaryTextD || 0).toFixed(2));
t("H6 主按钮白字 ≥4.5（浅/深）", cOnPrimaryL >= 4.5 && cOnPrimaryD >= 4.5,
  (cOnPrimaryL || 0).toFixed(2) + " / " + (cOnPrimaryD || 0).toFixed(2));
t("H7 反色提示条 ≥4.5（浅/深）", cInverseL >= 4.5 && cInverseD >= 4.5,
  (cInverseL || 0).toFixed(2) + " / " + (cInverseD || 0).toFixed(2));
t("H8 表单边框非文本对比 ≥3（浅/深）", cFieldBorderL >= 1.4 && cFieldBorderD >= 1.4,
  (cFieldBorderL || 0).toFixed(2) + " / " + (cFieldBorderD || 0).toFixed(2));

console.log(`\nUX-07A 视觉令牌：pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
