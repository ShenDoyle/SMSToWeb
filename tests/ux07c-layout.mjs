/**
 * UX-07C 结构审计：宽屏双栏的布局规则、渲染复用、状态边界与不变量
 * 运行：node tests/ux07c-layout.mjs
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

/**
 * 按配对花括号提取具名函数体（UX-08-T3）。
 * 计数时跳过字符串 / 模板串 / 注释，避免字面量里的花括号破坏配对；返回 null 表示提取失败。
 */
function fnBody(name) {
  const head = new RegExp("function\\s+" + name + "\\s*\\(");
  const m = head.exec(SRC);
  if (!m) return null;
  const open = SRC.indexOf("{", m.index + m[0].length - 1);
  if (open < 0) return null;
  let depth = 0, quote = "";
  for (let p = open; p < SRC.length; p++) {
    const c = SRC[p];
    if (quote) {
      if (c === "\\") { p++; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "/" && SRC[p + 1] === "/") { p = SRC.indexOf("\n", p); if (p < 0) return null; continue; }
    if (c === "/" && SRC[p + 1] === "*") { p = SRC.indexOf("*/", p + 2); if (p < 0) return null; p++; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return SRC.slice(open, p + 1); }
  }
  return null;
}
/* 从「key === "x" ? T("k") : ... : T("fallback")」里解出 状态键 → 文案键 的映射 */
function stateTextMap(expr) {
  if (!expr) return null;
  const overrides = {};
  const re = /key\s*===\s*"([\w-]+)"\s*\?\s*T\("([\w-]+)"\)/g;
  let m;
  while ((m = re.exec(expr))) overrides[m[1]] = m[2];
  const all = [...expr.matchAll(/T\("([\w-]+)"\)/g)];
  const fallback = all.length ? all[all.length - 1][1] : null;
  return { overrides: overrides, keys: Object.keys(overrides).sort(), fallback: fallback };
}

/* A. 布局结构 */
t("A1 双栏面板 DOM 存在且默认隐藏", /<aside class="detailpane" id="detailpane" hidden/.test(SRC) && has('id="dpscroll"') && has('id="dpempty"'));
t("A2 断点为 1600px 且只在此宽度启用两列", /@media \(min-width: 1600px\) \{[\s\S]{0,2600}?\.layout \{ grid-template-columns: minmax\(0, 55fr\) minmax\(0, 45fr\)/.test(SRC));
t("A3 ≥1920 切换为 54fr/46fr", /@media \(min-width: 1920px\) \{\s*\.layout \{ grid-template-columns: minmax\(0, 54fr\) minmax\(0, 46fr\)/.test(SRC));
t("A4 双栏下工作区放宽且有上限", /\.wrap \{ max-width: min\(1760px, 96vw\)/.test(SRC));
t("A5 面板 sticky + 视口高度 + 内部滚动", /\.detailpane \{[^}]*position: sticky[^}]*min-height: calc\(100vh - 32px\)/.test(SRC) && /\.dp-scroll \{[^}]*overflow: auto/.test(SRC));
t("A6 面板 [hidden] 不被 display:flex 覆盖", has(".detailpane[hidden] { display: none; }"));
t("A7 选中态与未读左标线不冲突（内描边方案）", /\.card\.dsel::after \{[^}]*inset: 0[^}]*box-shadow: inset 0 0 0 1px var\(--ds-color-primary\)/.test(SRC));

/* B. 工具栏在窄列表列下仍单行 */
t("B1 双栏下刷新降为纯图标", /@media \(min-width: 1600px\)[\s\S]{0,1200}?\.toolbar-refresh \.rf-txt \{ display: none; \}/.test(SRC) && has('class="rf-ico"') && has('class="rf-txt"'));
t("B2 双栏下拉限宽 + 芯片收内边距", /\.filter-row select \{ max-width: 92px; \}/.test(SRC) && /\.filter-tabs \.chip \{ padding: 0 9px; \}/.test(SRC));
t("B3 条数隐藏后并入分页行（信息不丢）", has("条数并入分页行") && /if \(splitOn\(\)\) \$\("pageinfo"\)\.textContent/.test(SRC));

/* C. 渲染复用 */
t("C1 详情 HTML 抽成 detailHTML(m, mode)", /function detailHTML\(m, mode\)/.test(SRC));
t("C2 弹层与面板共用同一份 HTML", /openModal\(detailHTML\(m, "modal"\)\)/.test(SRC) && /scroll\.innerHTML = detailHTML\(res\.item, "pane"\)/.test(SRC));
t("C3 操作绑定共用 bindDetail", /function bindDetail\(m, root, mode\)/.test(SRC) && /bindDetail\(res\.item, scroll, "pane"\)/.test(SRC) && /bindDetail\(m, root, "modal"\)/.test(SRC));
t("C4 已读标记共用 markDetailRead", /function markDetailRead\(m, root\)/.test(SRC) && has("markDetailRead(res.item, scroll)") && has("markDetailRead(m, root)"));
t("C5 openDetail 按断点分流到面板", /if \(splitOn\(\) && \$\("detailpane"\)\) \{ openPane\(id\); return; \}/.test(SRC));

/* D. 状态边界 */
t("D1 快速切换丢弃过期响应（序号守卫）", /if \(seq !== paneSeq\) return;/.test(SRC));
t("D2 列表重绘后同步选中态", /function syncPaneAfterLoad\(\)/.test(SRC) && /syncPaneAfterLoad\(\);/.test(SRC));
/* UX-08：空态改为「状态键 + i18n 文案」分离。
   UX-08-T3：不能只验 `paneEmptyState("missing")` 这个字符串存在——那只能证明有人调过这个键，
   证明不了「missing 这个键真的渲染成 paneMissing 文案」。改为解析 panEmptyRender 的赋值表达式，
   还原「状态键 → 文案键」映射并逐项核对。 */
const fRender = fnBody("panEmptyRender");
const bExpr = fRender && (fRender.match(/b\.textContent\s*=\s*([^;]+);/) || [])[1];
const sExpr = fRender && (fRender.match(/s\.textContent\s*=\s*([^;]+);/) || [])[1];
const bMap = stateTextMap(bExpr);
const sMap = stateTextMap(sExpr);

t("D3 空态渲染函数体可精确提取", !!fRender && !!bExpr && !!sExpr,
  fRender ? "b/s 文案赋值均已定位" : "panEmptyRender 提取失败（函数不存在或花括号不配对）");

t("D3-1 正文文案映射：missing → paneMissing", !!bMap && bMap.overrides.missing === "paneMissing",
  bMap ? "missing=" + bMap.overrides.missing : "映射未解出");
t("D3-2 正文文案映射：fail → detailFail", !!bMap && bMap.overrides.fail === "detailFail",
  bMap ? "fail=" + bMap.overrides.fail : "映射未解出");
/* UX-09 U9-11/U9-12：空态从三态扩到五态（missing / fail / loading / unauth / empty 默认），
   断言覆盖新增的 loading 与 unauth，仍逐键核对「状态 → 文案键」而不是只验字符串存在 */
t("D3-3 正文文案映射：empty → paneEmpty（默认分支，不被任何键抢走）",
  !!bMap && bMap.fallback === "paneEmpty" && bMap.keys.join(",") === "fail,loading,missing,unauth",
  bMap ? "fallback=" + bMap.fallback + " overrides=" + bMap.keys.join(",") : "映射未解出");
t("D3-3b 正文文案映射：loading → paneLoading / unauth → errUnauth",
  !!bMap && bMap.overrides.loading === "paneLoading" && bMap.overrides.unauth === "errUnauth",
  bMap ? "loading=" + bMap.overrides.loading + " unauth=" + bMap.overrides.unauth : "映射未解出");
t("D3-4 副文案映射：empty → paneEmptySub、fail → detailFailSub，其余不带副文案",
  !!sMap && sMap.overrides.empty === "paneEmptySub" && sMap.overrides.fail === "detailFailSub" &&
    sMap.keys.join(",") === "empty,fail",
  sMap ? "overrides=" + sMap.keys.join(",") + " / " + (sExpr || "") : "映射未解出");
t("D3-5 状态键仍由 syncPaneAfterLoad 在选中项消失时写入", /paneEmptyState\("missing"\)/.test(SRC));
t("D4 跨断点切换自动收起/恢复面板", /SPLIT_MQ\.addEventListener\("change", sync\)/.test(SRC) || /SPLIT_MQ\.addListener\(sync\)/.test(SRC));
t("D5 选中状态不持久化（无 storage 写入）", !/localStorage\.setItem\([^)]*detailId/.test(SRC) && !/sessionStorage\.setItem\([^)]*detailId/.test(SRC));
t("D6 面板可清除选中", has('id="dpclose"'));

/* E. i18n 九语种 */
const PANE = ["paneEmpty", "paneEmptySub", "paneMissing", "paneAria", "paneClose"];
const langs = ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt-BR"];
const paneBlock = (SRC.match(/var PANE_I18N = \{[\s\S]*?\n  \};/) || [""])[0];
t("E1 PANE_I18N 表存在", paneBlock.length > 200);
t("E2 九语种均齐全", langs.every((l) => {
  const m = paneBlock.match(new RegExp('"?' + l + '"?: \\{[\\s\\S]*?\\n    \\}'));
  return m && PANE.every((k) => m[0].indexOf(k + ":") !== -1);
}), langs.length + " langs");
t("E3 空态文案由 i18n 驱动（非写死）", has('data-i18n="paneEmpty"'));

/* F. 不变量 */
t("F1 每页仍默认 10 条", /limit: 10/.test(SRC));
t("F2 未新增 API 路由/数据库字段", !/detailId[\s\S]{0,40}body: JSON\.stringify/.test(SRC));
t("F3 详情弹层未被移除（窄屏仍可用）", has('id="dclose"') && has("function renderDetail(m)"));
t("F4 统计摘要默认隐藏未变", /homeStats: \(function \(\) \{ try \{ return localStorage\.getItem\("sms_homestats"\) === "1"/.test(SRC));
const splitBlock = (SRC.match(/@media \(min-width: 1600px\) \{[\s\S]*?\n  \}/) || [""])[0];
t("F5 双栏规则未用 !important（靠选择器顺序覆盖）", splitBlock.length > 100 && splitBlock.indexOf("!important") === -1, "block=" + splitBlock.length);
t("F6 面板只出现在 index 骨架一处", (SRC.match(/class="detailpane"/g) || []).length === 1);

console.log("\n===== UX-07C 结构：pass=" + pass + " fail=" + fail + " =====");
process.exit(fail ? 1 : 0);
