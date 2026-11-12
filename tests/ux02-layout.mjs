/**
 * UX-02A/02B 结构与文案测试（不依赖浏览器，可在 CI 直接跑）
 *
 * 运行：node tests/ux02-layout.mjs   （退出码 0=全过，1=有失败，2=异常）
 *
 * 覆盖：
 *  A. 侧栏移除、单栏布局、失效选择器清理。
 *  B. 设备筛选迁移到筛选区 + 设备管理弹层仍保留全部动作（接口语义不变）。
 *  C. 顶栏入口（统计 / 设备 / 设置 / 退出 + 移动端 ⋯ 菜单）。
 *  D. 首页统计摘要默认隐藏、可开关、可持久化，且不新增 API / 不改口径。
 *  E. 消息卡三行结构、设备标签分组去重、操作常驻可发现。
 *  F. 列表契约（device_id / starred / unread / read / range / q / 游标）未被改动。
 *  G. 新增九语言文案齐全且非空。
 *  H. 对比度相关：元信息不再使用 11px + faint。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SELF = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(SELF, "..", "src/worker.js"), "utf8");

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log("FAIL " + name + (detail ? " :: " + detail : ""));
}
const has = (s) => SRC.includes(s);

/**
 * 按配对花括号从源码中提取具名函数体的完整文本（UX-08-T1）。
 *
 * 为什么不用「固定字符窗口」：窗口长度一旦小于函数体长度就会溢出到同级函数，
 * 导致「删掉本函数的密码校验」仍能命中隔壁函数的 askPassword 而误判为通过。
 * 这里改为先定位 `function <name>(` 的左花括号，再用配对计数找到它自己的右花括号，
 * 计数时跳过字符串 / 模板串 / 注释，避免字面量里的花括号破坏配对。
 *
 * 返回 null 表示函数不存在或花括号不配对（调用方必须判 FAIL，不得回退到宽松匹配）。
 */
function fnBody(name) {
  const head = new RegExp("function\\s+" + name.replace(/\$/g, "\\$") + "\\s*\\(");
  const m = head.exec(SRC);
  if (!m) return null;
  let i = SRC.indexOf("{", m.index + m[0].length - 1);
  if (i < 0) return null;
  let depth = 0;
  let quote = "";
  for (let p = i; p < SRC.length; p++) {
    const c = SRC[p], prev = SRC[p - 1];
    if (quote) {
      if (c === "\\") { p++; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "/" && SRC[p + 1] === "/") { p = SRC.indexOf("\n", p); if (p < 0) return null; continue; }
    if (c === "/" && SRC[p + 1] === "*") { p = SRC.indexOf("*/", p + 2); if (p < 0) return null; p++; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return SRC.slice(i, p + 1);
    }
    void prev;
  }
  return null;
}

/* ---------- A. 布局 ---------- */
t("A1 侧栏 DOM 已移除", !/class="sidebar"/.test(SRC) && !/side-card/.test(SRC) && !/side-title/.test(SRC));
t("A2 侧栏相关 JS 入口已清理",
  !/sideSetBtn|sideNotifyBtn|sideStatsBtn|markActiveTabs|loadSideSettings/.test(SRC));
t("A3 布局改为单栏", /\.layout \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/.test(SRC));
t("A4 未残留旧侧栏断点样式", !/\.sidebar \{/.test(SRC));

/* ---------- B. 设备筛选与管理 ---------- */
t("B1 筛选区含设备下拉", /<select id="dev"/.test(SRC));
t("B2 设备下拉由 /api/devices 填充并保留全部设备项",
  /function loadDevices\(\)/.test(SRC) && /<option value="0">/.test(SRC) && /T\("tabAll"\)/.test(SRC));
t("B3 切换设备仍走 state.device（device_id 语义）",
  /\$\("dev"\)\.onchange = function \(\) \{ state\.device = parseInt\(\$\("dev"\)\.value, 10\) \|\| 0;/.test(SRC));
t("B4 设备管理仍有重命名 / 合并 / 删除",
  /function devRename/.test(SRC) && /function devMerge/.test(SRC) && /function devDelete/.test(SRC) &&
  has("/api/devices/alias") && has("/api/devices/merge") && /fetch\("\/api\/devices\/" \+ d\.id, \{ method: "DELETE" \}/.test(SRC));
/* UX-08-T1：改用「函数体精确提取 + 逐项语义断言」，替代原先的固定字符窗口正则。
   原写法 `[\s\S]{0,2200}` 比 devMerge 函数体（约 1.7k 字符）还长，会溢出到 devDelete，
   删掉 devMerge 里的密码校验仍能在窗口内命中 devDelete 的 askPassword 而误判通过。
   语义（UX-02 起未变）：合并 = 选目标 → dsConfirm 二次确认 → askPassword → 调接口；
                        删除 = dsConfirm 确认 → askPassword → 调接口。 */
const fMerge = fnBody("devMerge");
const fDelete = fnBody("devDelete");
function assertFnBody(nm, body, fnName) {
  t("B5 前置：能精确提取 " + fnName + " 函数体", !!body,
    nm + " 提取失败（函数不存在或花括号不配对），按契约判 FAIL");
  if (!body) return;
  /* 提取物必须是「这一个」函数体：不得把后面的同级函数一起吞进来 */
  t("B5 前置：" + fnName + " 函数体未溢出到同级函数",
    !/\n {2}function [A-Za-z_$][\w$]*\s*\(/.test(body),
    "提取到的文本里出现了同级 function 声明，说明配对花括号定位错误");
  void nm;
}
assertFnBody("merge-missing", fMerge, "devMerge");
assertFnBody("delete-missing", fDelete, "devDelete");

t("B5-A devMerge 内部有 askPassword 密码校验",
  !!fMerge && fMerge.includes("askPassword("),
  fMerge ? "devMerge 函数体内未调用 askPassword：" + fMerge.slice(0, 120).replace(/\s+/g, " ") : "函数体未取到");

t("B5-B devMerge 内部先 dsConfirm 二次确认再 askPassword（顺序不可颠倒）",
  !!fMerge && fMerge.includes('dsConfirm({ message: T("mergeConfirm"') &&
    fMerge.indexOf('dsConfirm({ message: T("mergeConfirm"') < fMerge.indexOf("askPassword("),
  fMerge ? "devMerge 缺少合并确认，或密码校验排到了确认之前" : "函数体未取到");

t("B5-C devDelete 内部有 askPassword 密码校验",
  !!fDelete && fDelete.includes("askPassword("),
  fDelete ? "devDelete 函数体内未调用 askPassword" : "函数体未取到");

t("B5-D devDelete 内部先 dsConfirm(delDevConfirm) 再 askPassword（顺序不可颠倒）",
  !!fDelete && fDelete.includes('dsConfirm({ message: T("delDevConfirm")') &&
    fDelete.indexOf('dsConfirm({ message: T("delDevConfirm")') < fDelete.indexOf("askPassword("),
  fDelete ? "devDelete 缺少删除确认，或密码校验排到了确认之前" : "函数体未取到");
t("B6 危险操作不再使用原生 confirm（仅保留 dsConfirm 的降级兜底）",
  (SRC.match(/window\.confirm/g) || []).length === 1 &&
  /if \(!el \|\| !msg \|\| !okBtn \|\| !noBtn\) return Promise\.resolve\(window\.confirm\(/.test(SRC) &&
  /function dsConfirm\(opt\)/.test(SRC));

/* ---------- C. 导航 ---------- */
t("C1 顶栏含统计 / 设备 / 设置 / 退出",
  has('id="statsbtn"') && has('id="devbtn"') && has('id="setbtn"') && has('id="logoutbtn"'));
t("C2 移动端 ⋯ 菜单含四项且与桌面入口同源",
  has('id="morebtn"') && has('id="navmenu"') && has('id="mnustats"') && has('id="mnudev"') &&
  has('id="mnuset"') && has('id="mnulogout"'));
t("C3 移动端菜单可关闭（点外部收起）",
  /document\.addEventListener\("click", function \(ev\) \{[\s\S]{0,260}?close\(\);\s*\}\);/.test(SRC) &&
  /function close\(\) \{ menu\.hidden = true;/.test(SRC));
t("C4 统计详情仍由 openStats 打开", /\$\("statsbtn"\)\.onclick = openStats/.test(SRC) && has('id="stdetail"'));

/* ---------- D. 首页统计摘要 ---------- */
t("D1 统计条默认带 hidden（不占位）", /<div class="statbar" id="statbar" hidden>/.test(SRC));
t("D2 隐藏时不显示（零占位）", /\.statbar\[hidden\] \{ display: none; \}/.test(SRC));
t("D3 本地偏好键与默认值（默认关闭）",
  /localStorage\.getItem\("sms_homestats"\) === "1"/.test(SRC));
/* UX-03：开关从「登录与会话」迁到「界面与显示 → 首页」，语义与存储键不变 */
const scDisplayBody = SRC.slice(SRC.indexOf("function scBodyDisplay"), SRC.indexOf("function scBodyMessages"));
t("D4 设置中心「界面与显示 → 首页统计摘要」开关",
  scDisplayBody.includes('scSwitch("schomestats"') && /T\("scHomeStats"\)/.test(scDisplayBody)
  && /T\("scHomeStatsScope"\)/.test(scDisplayBody) && !/schomestats/.test(SRC.slice(SRC.indexOf("function scBodySession"), SRC.indexOf("function scBodyNotify"))));
t("D5 保存设置时写回本地偏好并立即生效",
  /localStorage\.setItem\("sms_homestats"/.test(SRC) && /hsChanged/.test(SRC) && /applyHomeStats\(\)/.test(SRC));
t("D6 关闭时不发请求、不占高度", /if \(!state\.homeStats\) \{ bar\.hidden = true; return Promise\.resolve\(\); \}/.test(SRC));
t("D7 统计口径未变（仍读 /api/stats，未新增接口）",
  /function fillStatBar/.test(SRC) && !/\/api\/stats\/summary/.test(SRC));
t("D8 今天数按本地日期精确匹配，不用最后一条兜底", /days\[i\]\.d === key/.test(SRC));

/* ---------- E. 消息卡 ---------- */
t("E1 三行结构（msg-top / content / msg-foot）",
  /class="msg-top"/.test(SRC) && /class="content summary"/.test(SRC) && /class="msg-foot"/.test(SRC));
t("E2 旧的设备/元信息行已移除", !/class="msg-bottom"/.test(SRC) && !/class="msg-meta"/.test(SRC));
t("E3 未读用圆点、不再堆「未读」徽章与默认来源标签",
  /class="undot"/.test(SRC) && !/class="tag unread-tag"/.test(SRC) && !/class="tag type"/.test(SRC));
t("E4 收藏 / 删除常驻可见，全文仅在截断时出现",
  /\.msg-actions \.del \{ color: var\(--muted\); \}/.test(SRC) && /\.msg-actions \.more\[hidden\] \{ display: none; \}/.test(SRC));
t("E5 设备标签只在设备分组切换处出现一次",
  /var showDev = !state\.device && dv !== lastDev;/.test(SRC) && /var devChip = showDev && m\.device_name/.test(SRC));
t("E6 详情保留设备 + SIM（信息不丢失）",
  /var recv = m\.sim_number \|\| m\.sim \|\| "";/.test(SRC) && /esc\(m\.device_name\) \+ \(recv \? ' · ' \+ esc\(recv\)/.test(SRC));
t("E7 纯号码发件人不画头像噪声", /var showAvatar = !\(isSms && !lbl/.test(SRC));
/* UX-09 U9-02：行内删除在原有「删除→撤销」回路外包了一层二次确认，
   断言从「紧邻调用」放宽为「同一处理链路内仍有 undoToast」，并新增确认点断言确保没有被改成静默删除 */
t("E8 删除仍走既有撤销回路（未改成静默删除）",
  /function undoToast/.test(SRC) &&
  /closest\("\.del"\)[\s\S]{0,600}?undoToast\(\[parseInt\(id, 10\)\]\)/.test(SRC));
t("E8b 行内删除先经二次确认再执行（UX-09 U9-02）",
  /closest\("\.del"\)[\s\S]{0,260}?confirmDelOne\(\)\.then\(function \(go\) \{[\s\S]{0,260}?if \(!go\) return;/.test(SRC));

/* ---------- F. 列表契约不变 ---------- */
t("F1 device_id 过滤参数仍在", /p\.set\("device_id", state\.device\)/.test(SRC) || /device_id=\?/.test(SRC) || /where\.push\("m\.device_id = \?"\)/.test(SRC));
t("F2 收藏 / 未读 / 已读 / 时间 / 关键词参数仍在",
  /p\.set\("starred", "1"\)/.test(SRC) && /p\.set\("unread", "1"\)/.test(SRC) &&
  /p\.set\("read", "1"\)/.test(SRC) && /p\.set\("range", state\.range\)/.test(SRC) && /p\.set\("q", state\.q\)/.test(SRC));
t("F3 游标分页与 loadSeq 竞态保护仍在",
  /state\.cursor = res\.next_cursor/.test(SRC) && /if \(seq !== loadSeq\) return;/.test(SRC));
t("F4 分页上限裁剪只作用于单页模式（游标后不丢历史）",
  /function trimToLimitIfSinglePage\(listEl\) \{ if \(!state\.cursor\) trimToLimit\(listEl\); \}/.test(SRC));
t("F5 统计接口口径未改（total/unread/starred/sources/days）",
  /days: \(days\.results \|\| \[\]\)\.map/.test(SRC) && /starred/.test(SRC));

/* ---------- G. 九语言新文案 ---------- */
const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt-BR"];
const KEYS = ["filterBtn", "navDevices", "navMore", "scHomeDisplay", "scHomeStats", "scHomeStatsHelp"];
function sliceTable(name) {
  const at = SRC.indexOf("var " + name + " = {");
  if (at < 0) return "";
  let depth = 0;
  for (let j = SRC.indexOf("{", at); j < SRC.length; j++) {
    if (SRC[j] === "{") depth++;
    else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(SRC.indexOf("{", at), j + 1); }
  }
  return "";
}
const tables = [sliceTable("I18N"), sliceTable("SC_I18N")].join("\n");
for (const k of KEYS) {
  const re = new RegExp("\\b" + k + ':\\s*"([^"]*)"', "g");
  const hits = tables.match(re) || [];
  t("G1 " + k + " 在九语言中齐全", hits.length >= LANGS.length, "命中 " + hits.length);
  t("G2 " + k + " 均为非空文案", hits.every((h) => h.split('"')[1].trim().length > 0));
}

/* ---------- H. 可读性 ---------- */
t("H1 时间/元信息不再用 11px + faint",
  /\.msg-time \{ margin-left: auto; color: var\(--muted\); font-size: 12px;/.test(SRC) &&
  !/\.msg-time \{[^}]*var\(--faint\)/.test(SRC));
t("H2 正文 14px（长文本可读，不缩短）", /\.content\.summary \{ margin: 0; font-size: 14px; line-height: 1\.65;/.test(SRC));
/* UX-07B：标题行已并入筛选行（.toolbar-top 不再是 DOM 结构），旧断言改为校验新结构 */
t("H3 移动端筛选默认折叠、⋯ 菜单替代低频按钮",
  !SRC.includes('class="toolbar-top"') &&
  /@media \(max-width: 660px\)[\s\S]{0,900}?\.filters \{[^}]*flex-direction: column;/.test(SRC) &&
  /\.filter-row select \{ display: none;/.test(SRC) &&
  /\.filters\.adv \.filter-row select \{ display: block; \}/.test(SRC));

console.log("\n===== UX-02 结构测试：pass=" + pass + " fail=" + fail + " =====");
process.exit(fail ? 1 : 0);
