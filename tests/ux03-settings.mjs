/**
 * UX-03 设置中心体验重构：结构与契约测试（不依赖浏览器，可在 CI 直接跑）
 *
 * 运行：node tests/ux03-settings.mjs   （退出码 0=全过，1=有失败，2=异常）
 *
 * 覆盖：
 *  A. 六个分区与短标签导航（九语种齐全，导航不依赖横向滚动）。
 *  B. 设置项盘点：每一项都有明确去向，未被删除（首页统计摘要迁到「界面与显示」）。
 *  C. 行式设置项与分组结构（不再逐项套卡片）、作用域说明。
 *  D. 加载骨架 / 错误重试 / 保存状态条（pending / success / error / conflict）。
 *  E. 通知：11 个渠道一览、多目标行内操作、目标 id 与启停语义不变。
 *  F. 契约护栏：API 请求结构、revision、去抖、敏感字段逻辑均未被改动。
 *  G. 可访问性：aria-labelledby、tablist 键盘导航、focus-visible。
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
const slice = (a, b) => {
  const i = SRC.indexOf(a), j = SRC.indexOf(b);
  return i >= 0 && j > i ? SRC.slice(i, j) : "";
};
const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt-BR"];

/* ---------- A. 分区与导航 ---------- */
const NAV_KEYS = ["scNavDisplay", "scNavMessages", "scNavSession", "scNavNotify", "scNavBiz", "scNavSecurity"];
const SEC_KEYS = ["scTabDisplay", "scTabMessages", "scTabSession", "scTabNotify", "scTabBiz", "scTabSec"];
const SEC_HELP = ["scSecDisplayHelp", "scSecMessagesHelp", "scSecSessionHelp",
  "scSecNotifyHelp", "scSecBizHelp", "scSecSecurityHelp"];
const NEW_KEYS = NAV_KEYS.concat(SEC_KEYS, SEC_HELP, ["scHomeStatsScope", "scRetryLoad", "scSaving",
  "scSavedOk", "scChGridTitle", "scChGridHelp", "scConfiguredN", "scUiGroup", "scDndGroup", "scDndFrom", "scDndTo"]);

t("A1 分区表为六个分区且顺序固定",
  /var SET_SECTIONS = \[[\s\S]{0,700}?key: "display"[\s\S]*?key: "messages"[\s\S]*?key: "session"[\s\S]*?key: "notify"[\s\S]*?key: "biz"[\s\S]*?key: "security"/.test(SRC));
t("A2 每个分区都有短标签 / 标题 / 作用域说明三件套",
  SEC_KEYS.every((k) => SRC.includes('"' + k + '"')) && SEC_HELP.every((k) => SRC.includes('"' + k + '"')));
const navMissing = NEW_KEYS.filter((k) => (SRC.match(new RegExp("\\b" + k + ":", "g")) || []).length < 9);
t("A3 新增文案九语种全覆盖（" + NEW_KEYS.length + " 键各 9 处）",
  navMissing.length === 0, "缺：" + navMissing.join(","));
t("A4 分区标签用短标签渲染，桌面自动换行、不再横向滚动",
  has('class="sc-tab"') && /\.ds-tabs \{ display: flex; flex-wrap: wrap; gap: 6px;/.test(SRC)
  && !/\.ds-tabs \{[^}]*overflow-x: auto/.test(SRC));
/* UX-07B：触屏命中区提高到 44px（原 38px），断言改为「不小于 44」 */
t("A5 窄屏分区导航为三列网格（触控可见、不截断）",
  /\.ds-tabs \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/.test(SRC)
  && /\.sc-tab \{ min-height: (4[4-9]|[5-9]\d)px;/.test(SRC));
t("A6 分区标签具备 tablist / aria-selected / roving tabindex",
  has('role="tablist"') && has('aria-selected="') && /tabindex="' \+ \(on \? "0" : "-1"\)/.test(SRC));
t("A7 键盘方向键可在分区之间移动",
  /ev\.key === "ArrowRight"/.test(SRC) && /ev\.key === "End"/.test(SRC) && /scSetSection\(keys\[to\], true\)/.test(SRC));
t("A8 切换分区只重绘正文，不重建整个弹层", /function scSetSection\(next, focusTab\)/.test(SRC)
  && !/SC\.section = next;\s*scRenderShell\(\);/.test(SRC));

/* ---------- B. 设置项盘点与迁移 ---------- */
const bodyDisplay = slice("function scBodyDisplay", "function scBodyMessages");
const bodyMessages = slice("function scBodyMessages", "function scBodySession");
const bodySession = slice("function scBodySession", "function scBodyNotify");
const bodyNotify = slice("function scBodyNotify", "var PUSH = null;");
const bodyBiz = slice("function scBodyBiz", "function scBodySecurity");
const bodySec = slice("function scBodySecurity", "function scReset");

t("B1 界面与显示：语言 / 每页条数 / 首页统计摘要",
  bodyDisplay.includes('id="sclang"') && bodyDisplay.includes('id="sclimit"')
  && bodyDisplay.includes('scSwitch("schomestats"'));
t("B2 首页统计摘要已迁出「登录与会话」", bodyDisplay.includes("schomestats") && !bodySession.includes("schomestats"));
t("B3 首页统计摘要带浏览器作用域说明", bodyDisplay.includes('T("scHomeStatsScope")'));
t("B4 消息与提醒：自动复制 / 复制按钮 / 后台通知 / 提示音 / 免打扰+时段",
  ["scautocopy", "scodecopy", "scnotifyon", "scsoundon", "scdndon", "scdnds", "scdnde"]
    .every((id) => bodyMessages.includes('"' + id + '"')));
t("B5 登录与会话：本浏览器时长 + 全局默认时长", bodySession.includes('id="scbttl"')
  && bodySession.includes('id="scbttlmin"') && bodySession.includes('id="scgttl"'));
t("B6 通知分区：规则 / 渠道一览 / 目标列表 / 环境变量 / 同步环境变量",
  ["nfen", "data-nftype", "nfretry", "nflink", "pushadd", "nfimport"].every((k) => bodyNotify.includes(k))
  && bodyNotify.includes("sc-chgrid") && bodyNotify.includes("scEnvChannels"));
t("B7 数据与业务：保留天数 / 归属地开关 / 接口地址",
  bodyBiz.includes('id="sysdays"') && bodyBiz.includes('scSwitch("sysarea"') && bodyBiz.includes('id="sysareaapi"'));
t("B8 安全：接入令牌入口 + 登录防护说明",
  bodySec.includes('id="sctokbtn"') && bodySec.includes('T("scLoginGuard")'));
t("B9 原有设置项无删除（全局默认时长 / 语言 / 分页 / 保留 / 归属地 等键仍在用）",
  has('T("scTtlGlobal")') && has('T("scPerPage")') && has('T("scDays")') && has('T("scAreaApi")'));

/* ---------- C. 结构：不再逐项套卡片 ---------- */
t("C1 行式设置项结构：名称 + 说明 + 控件", /function scItem\(label, desc, ctl, opts\)/.test(SRC)
  && has('class="sc-item-main"') && has('class="sc-ictl'));
t("C2 分组为标题 + 说明 + 条目，无嵌套卡片容器", /function scGroup\(title, badge, desc, inner\)/.test(SRC)
  && has('class="sc-group"') && !/\.setgrp \{/.test(SRC));
t("C3 分区标题含一句作用域说明", /function scHead\(\)/.test(SRC) && has('class="sc-head"') && has('T(x.desc)'));
t("C4 作用域在分区说明与分组徽章中统一解释，未逐项重复徽章",
  /scGroup\(T\("scUiGroup"\), "browser"/.test(SRC) && /scGroup\(T\("scSessionGlobal"\), "global"/.test(SRC)
  && (SRC.match(/scBadge\(/g) || []).length <= 6);

/* ---------- D. 加载与状态反馈 ---------- */
t("D1 打开即渲染外壳与骨架，不等网络", /scRenderShell\(\);\s*\n\s*scLoad\(\);/.test(SRC)
  && /if \(SC\.loading\) \{ body\.innerHTML = scSkeleton\(\); return; \}/.test(SRC));
t("D2 读取失败给出错误态与重试入口", has('id="scretry"') && /T\("scRetryLoad"\)/.test(SRC)
  && /SC\.loadError/.test(SRC));
t("D3 保存状态条存在且 aria-live", has('id="scstatus"') && has('aria-live="polite"')
  && /function scStatus\(kind, msg\)/.test(SRC));
t("D4 五种状态齐全：pending / success / error / conflict",
  ["pending", "success", "error", "conflict"].every((k) => SRC.includes("sc-status--" + k)));
t("D5 保存中提示、成功后回读、失败给出具体信息",
  /scStatus\("pending", T\("scSaving"\)\)/.test(SRC) && /scStatus\("success", T\("scSavedOk"\)\)/.test(SRC)
  && /scStatus\("error", msg\)/.test(SRC) && /scStatus\("conflict", T\("scRevisionConflict"\)\)/.test(SRC));
t("D6 冲突仍提供就地「重新加载最新配置」", /function scShowConflict\(serverRev\)/.test(SRC)
  && has('id="screload"') && /scReloadConfirm/.test(SRC));
t("D7 重复点击 / 请求在途保护保留", /if \(SC\.saving\) return;/.test(SRC)
  && /Date\.now\(\) - SC\.lastSaveAt < 800/.test(SRC));
t("D8 加载未完成时不允许提交", /if \(SC\.loading \|\| SC\.loadError \|\| !SC\.d\) return;/.test(SRC));

/* ---------- E. 通知渠道与多目标 ---------- */
t("E1 11 个通知渠道名称表完整", ["feishu", "wecom", "dingtalk", "serverchan", "pushplus",
  "telegram", "bark", "ntfy", "gotify", "resend", "generic"].every((k) => SRC.includes(k + ": \"")));
t("E2 渠道一览按 schema 渲染并可直达新增该渠道目标",
  /data-pushadd="' \+ esc\(ch\.key\)/.test(SRC) && /function openPushEditor\(t, presetChannel\)/.test(SRC));
t("E3 多目标行保留 编辑 / 测试 / 启停 / 删除 四个常驻操作",
  ["edit", "test", "toggle", "del"].every((a) => SRC.includes('data-tgact="' + a + '"')));
t("E4 target_id 稳定性：编辑保留原 id，新增不伪造 id",
  /if \(!tg\._new && tg\.id\) out\.id = tg\.id;/.test(SRC));
t("E5 单个目标测试使用 target_id 定位、失败不阻断其它目标（语义未改）",
  /target_id: t\.id/.test(SRC) && /t\._new \|\| !t\.id/.test(SRC));

/* ---------- F. 契约护栏 ---------- */
t("F1 设置读写仍走 GET/PUT /api/settings（未新增接口）",
  /fetch\("\/api\/settings"\)/.test(SRC) && /method: "PUT"/.test(SRC)
  && !/\/api\/settings\/ux/.test(SRC) && !/\/api\/stats\/summary/.test(SRC));
t("F2 revision 乐观锁语义未改", /revision: SC\.d\.revision/.test(SRC) && /REVISION_CONFLICT/.test(SRC));
t("F3 保存去抖与 lastSaveAt 保留", /SC\.lastSaveAt = Date\.now\(\)/.test(SRC));
/* FEAD-SEC-01 起，敏感字段改走显式三态：明文只出现在 set 操作里，不回传普通字段通道 */
t("F4 敏感字段改用显式三态操作（keep / set / clear），普通字段恒为空串",
  /if \(v\.clear\) sensitive\[f\.key\] = \{ op: "clear" \};/.test(SRC)
  && /else if \(v\.value\) sensitive\[f\.key\] = \{ op: "set", value: v\.value \};/.test(SRC)
  && /else sensitive\[f\.key\] = \{ op: "keep" \};/.test(SRC)
  && /fields\[f\.key\] = "";/.test(SRC));
t("F4b 服务端对三态做白名单校验（未知字段 / 非法操作 / 空值 set 一律拒绝）",
  /NOTIFY_SENSITIVE_OPS = \["keep", "set", "clear"\]/.test(SRC)
  && /SENSITIVE_UNKNOWN_FIELD/.test(SRC) && /SENSITIVE_BAD_OP/.test(SRC)
  && /SENSITIVE_EMPTY_SET/.test(SRC) && /SENSITIVE_NOT_SENSITIVE/.test(SRC));
t("F5 首页统计摘要仍为本地偏好（无服务端写入、无 schema 变更）",
  /localStorage\.setItem\("sms_homestats"/.test(SRC) && !/homestats.*\/api\/settings/.test(SRC));
t("F6 未引入新依赖（单文件内联模板，无外部脚本 / 前端框架）",
  !/<script[^>]+src=/.test(SRC) && !/from "react"/.test(SRC) && !/Vue\.createApp/.test(SRC)
  && !/@latest\/dist/.test(SRC));

/* ---------- G. 可访问性 ---------- */
t("G1 开关为原生 checkbox 且有 aria-labelledby", /function scSwitch\(id, on, labelledBy, extra\)/.test(SRC)
  && /aria-labelledby="' \+ labelledBy/.test(SRC));
t("G2 开关焦点可见（focus-visible 描边）", /\.sc-switch input:focus-visible \+ \.sc-knob/.test(SRC));
t("G3 开关触控命中区足够（48×28）", /\.sc-switch \{ position: relative; flex: none; width: 48px; height: 28px;/.test(SRC));
t("G4 尊重减少动效偏好", /@media \(prefers-reduced-motion: reduce\)/.test(SRC) && /\.sc-skel-bar \{ animation: none/.test(SRC));
t("G5 分区标题与正文有关联（aria-labelledby 指向当前标签）",
  /body\.setAttribute\("aria-labelledby", "sctab-" \+ next\)/.test(SRC));
t("G6 骨架屏提供读屏文案", has('class="sr-only"') && /\.sr-only \{/.test(SRC));

/* ---------- 汇总 ---------- */
console.log("\n===== UX-03 设置中心结构测试：pass=" + pass + " fail=" + fail + " =====");
process.exit(fail === 0 ? 0 : 1);
