/**
 * UX-07B 结构与回归静态测试（不改运行时，只读 src/worker.js 源码文本）
 * 运行：node tests/ux07b-layout.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "src", "worker.js"), "utf8");
/* 去掉 CSS 注释后再做「不得硬编码」类断言，避免注释里引用的旧值造成误判 */
const SRC_NC = SRC.replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0, fail = 0;
const t = (name, ok, extra = "") => {
  if (ok) { pass++; console.log("  ok   " + name + (extra ? "  [" + extra + "]" : "")); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  [" + extra + "]" : "")); }
};
const has = (s) => SRC.includes(s);

console.log("\n===== UX-07B 结构与回归 =====");

/* A. 首页工具栏：一行结构，去掉重复标题行 */
t("A1 首页不再有独立标题行 .toolbar-top", !has('class="toolbar-top"') && !/\.toolbar-top \{/.test(SRC));
t("A2 刷新按钮与筛选区同属一个工具栏", /<div class="toolbar">[\s\S]{0,2400}?id="refreshbtn"/.test(SRC));
t("A3 「短信列表」文案降为读屏专用", /<span class="sr-only" data-i18n="listTitle">/.test(SRC));
t("A4 条数紧贴视图标签", /<span class="toolbar-title">[\s\S]{0,160}?<span id="stat"><\/span>/.test(SRC));
t("A5 桌面端工具栏单行 flex", /\.toolbar \{ display: flex; align-items: center; gap: 10px; padding: 11px 20px;/.test(SRC));

/* B. 触屏命中区 */
t("B1 存在 pointer: coarse 命中区规则块", /@media \(pointer: coarse\) \{/.test(SRC));
const coarseBlock = (() => {
  const at = SRC.indexOf("@media (pointer: coarse)");
  if (at < 0) return "";
  let depth = 0;
  for (let i = SRC.indexOf("{", at); i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) return SRC.slice(at, i + 1); }
  }
  return "";
})();
t("B2 视图标签/筛选按钮 44 命中区", /\.filter-tabs \.chip, \.filter-row \.filterbtn \{ min-height: 44px; \}/.test(coarseBlock));
t("B3 搜索框与下拉 44 命中区", /\.filters \.searchwrap input, \.filter-row select \{ min-height: 44px; \}/.test(coarseBlock));
t("B4 收藏/删除操作 44 命中区", /\.msg-actions \.star, \.msg-actions \.del, \.msg-actions \.more \{ min-width: 44px; min-height: 44px; \}/.test(coarseBlock));
t("B5 分页与跳转 44 命中区", /\.pages button, \.jumpwrap input, \.jumpwrap button \{ min-height: 44px; \}/.test(coarseBlock));
t("B6 弹层关闭按钮 44 命中区", /\.mx \{ width: 44px; height: 44px; top: 8px; right: 8px; \}/.test(coarseBlock));
t("B7 设置控件与分区标签 44 命中区", /\.sc-ictl \.ds-select, \.sc-ictl \.ds-input \{ min-height: 44px; \}/.test(coarseBlock) && /\.sc-tab, \.sc-ch \{ min-height: 44px; \}/.test(coarseBlock));
t("B8 设备行操作 44 命中区", /\.devrow \.dacts button \{ min-width: 44px; min-height: 44px; \}/.test(coarseBlock));
t("B9 触屏规则写在基础规则之后（覆盖顺序正确）", SRC.lastIndexOf("@media (pointer: coarse)") > SRC.indexOf(".devrow .dacts button { min-width: 32px"));

/* C. 平板区间布局 */
t("C1 661–900 区间用网格排两行", /@media \(min-width: 661px\) and \(max-width: 900px\) \{[\s\S]{0,400}?\.toolbar \{ display: grid;/.test(SRC));
/* UX-09 U9-03 在工具栏新增「多选」入口后，平板区间右侧变成两列（多选 | 刷新），
   本意仍是「刷新固定第一行最右」，因此列号放宽到 2 或 3，并新增一条入口同排断言 */
t("C2 平板下刷新固定在第一行右侧", /\.toolbar-refresh \{ grid-column: (2|3); grid-row: 1; justify-self: end; \}/.test(SRC));
t("C2b 平板下多选入口与刷新同排", /\.toolbar-sel \{ grid-column: 2; grid-row: 1; justify-self: end; \}/.test(SRC));
t("C3 平板下 .filters 用 display: contents 透传", /\.filters \{ display: contents; \}/.test(SRC));

/* D. 深色遮罩裁定 */
t("D1 弹层遮罩不再硬编码 rgba(12,18,26", !SRC_NC.includes("rgba(12,18,26"));
t("D2 弹层遮罩统一走令牌", /\.modal \{ background: var\(--ds-color-overlay\);/.test(SRC));
t("D3 深色遮罩单独一档 .62", /html\[data-theme="dark"\][\s\S]{0,600}?--ds-color-overlay: rgba\(0, 0, 0, \.62\);/.test(SRC));
t("D4 浅色遮罩 .48", /--ds-color-overlay: rgba\(15, 23, 32, \.48\);/.test(SRC));

/* E. 列表与未读标线 */
t("E1 未读标线随 --list-pad 计算，不再固定 -20px", /\.card\.unread::before \{ content: ""; position: absolute; left: calc\(8px - var\(--list-pad, 16px\)\)/.test(SRC));
t("E2 窄屏不再单独覆盖未读标线位置", !/\.card\.unread::before \{ left: -14px/.test(SRC));
t("E3 日期分隔线间距收紧到 12px", /\.daysep \{[^}]*margin: 12px 0 2px;/.test(SRC));

/* F. 详情弹层 */
t("F1 详情正文 15px + 令牌行高", /\.detail-body \{[^}]*line-height: var\(--ds-line-height-relaxed\); font-size: 15px;/.test(SRC));
t("F2 详情正文内边距与最大高度上调", /\.detail-body \{[^}]*padding: 16px 18px;[^}]*max-height: 48vh;/.test(SRC));
/* UX-07C：详情 HTML 抽成 detailHTML(m, mode) 共用，弹层与宽屏面板不再各写一套。
   断言改为校验拼接结构而非字面顺序，语义仍是「危险操作与主操作同组右侧、关闭排最后」。 */
t("F3 危险操作与主操作同组右侧", /var actsEnd =\s*'<button class="tbtn tbtn--danger" id="ddel">/.test(SRC) && /'<div class="foot-right">' \+ actsEnd/.test(SRC));
t("F4 关闭仍是 foot-right 最后一个按钮", /actsEnd \+\s*'<button class="tbtn tbtn--primary" id="dclose">/.test(SRC));

/* G. 统计弹层 */
t("G1 统计分区标题不再用行内 style", !has('style="font-size:13px;margin:'));
t("G2 统计分区使用 .stat-sec / h5", /\.stat-sec h5 \{/.test(SRC) && has('class="stat-sec"'));
t("G3 统计空态有占位", /\.stat-empty \{/.test(SRC) && has("stat-empty"));

/* H. 不破坏既有语义 */
t("H1 搜索结果 tab 与筛选行结构仍在", has('class="filter-tabs"') && has('class="filter-row"'));
t("H2 关键 id 未被改名", ["#q", "#dev", "#src", "#range", "#filterbtn", "#refreshbtn", "#list", "#stat"].every((s) => {
  const id = s.slice(1);
  return SRC.includes('id="' + id + '"');
}));
t("H3 分页默认每页 10 条未变", /limit:\s*10/.test(SRC) || /state\.limit\s*=\s*10/.test(SRC) || has("10 条/页") || /\[10, 20, 50, 100\]/.test(SRC));
t("H4 首页统计摘要默认隐藏未变", has("homeStats"));
t("H5 未新增运行时依赖", !/^import .* from "(?!node:)/m.test(SRC.replace(/\$\{[^}]*\}/g, "")));

console.log("\n===== UX-07B 结果：pass=" + pass + " fail=" + fail + " =====");
process.exit(fail ? 1 : 0);
