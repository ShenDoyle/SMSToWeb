/**
 * 设置中心 i18n 完整性测试（九语言键集一致性）
 *
 * 运行：node tests/settings-i18n.mjs   （退出码 0=全过，1=有失败，2=异常）
 *
 * 覆盖：
 *  A. SC_I18N / V2_I18N 两张设置相关文案表，九种语言的键集合完全一致（缺失即失败）。
 *  B. 本轮新增/修改的键在九语言中均存在且非空：scSavedLocal / scReloadLatest /
 *     scReloadConfirm / scPushRequired / scTargetDelConfirm / scRevisionConflict。
 *  C. 冲突提示不再包含「关闭后重新打开」这类已被就地恢复入口取代的旧指引。
 *  D. 语言归一化：pt-BR 必须可被 ?lang= / localStorage 命中（历史缺陷回归防线）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SELF = dirname(fileURLToPath(import.meta.url));
const REPO = join(SELF, "..");
const SRC = readFileSync(join(REPO, "src/worker.js"), "utf8");

const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt-BR"];
let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log("FAIL " + name + (detail ? " :: " + detail : ""));
}

/* 从 `var NAME = {` 起按大括号配对取出整张表 */
function sliceTable(name) {
  const at = SRC.indexOf("var " + name + " = {");
  if (at < 0) return "";
  let i = SRC.indexOf("{", at), depth = 0;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === "{") depth++;
    else if (SRC[j] === "}") {
      depth--;
      if (depth === 0) return SRC.slice(i, j + 1);
    }
  }
  return "";
}
/* 表内按语言切块：`"zh-CN": { ... }` */
function langBlocks(table) {
  const out = {};
  for (const lang of LANGS) {
    /* 两种写法都支持："en": { 与 en: { */
    let at = table.indexOf('"' + lang + '": {');
    if (at < 0) at = table.indexOf("\n    " + lang + ": {");
    if (at < 0) { out[lang] = ""; continue; }
    let i = table.indexOf("{", at), depth = 0, end = -1;
    for (let j = i; j < table.length; j++) {
      if (table[j] === "{") depth++;
      else if (table[j] === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    out[lang] = table.slice(i, end + 1);
  }
  return out;
}
/* 只取 `key: "value"` 形式的字符串条目键名 */
function keysOf(block) {
  const set = new Set();
  const re = /([A-Za-z][A-Za-z0-9_]*)\s*:\s*"/g;
  let m;
  while ((m = re.exec(block))) set.add(m[1]);
  return set;
}

for (const tableName of ["SC_I18N", "V2_I18N"]) {
  const table = sliceTable(tableName);
  t(tableName + " 表存在", table.length > 100);
  const blocks = langBlocks(table);
  const sets = {};
  for (const lang of LANGS) {
    t(tableName + " 含语言 " + lang, blocks[lang].length > 50);
    sets[lang] = keysOf(blocks[lang]);
    t(tableName + "/" + lang + " 键数 > 20", sets[lang].size > 20, "size=" + sets[lang].size);
  }
  const base = sets["zh-CN"];
  for (const lang of LANGS) {
    const miss = [...base].filter((k) => !sets[lang].has(k));
    const extra = [...sets[lang]].filter((k) => !base.has(k));
    t(tableName + "/" + lang + " 键集与 zh-CN 一致", miss.length === 0 && extra.length === 0,
      "missing=" + miss.slice(0, 6).join(",") + " extra=" + extra.slice(0, 6).join(","));
  }
}

/* 本轮涉及的键：九语言均存在且非空 */
const need = ["scSavedLocal", "scReloadLatest", "scReloadConfirm", "scPushRequired", "scTargetDelConfirm", "scRevisionConflict"];
for (const k of need) {
  const hits = SRC.match(new RegExp(k + '\\s*:\\s*"([^"]*)"', "g")) || [];
  t("键 " + k + " 在九语言中都有非空文案", hits.length === 9, "count=" + hits.length);
}

/* 旧指引已移除（九语言都不能再出现「关闭后重新打开」式的矛盾提示） */
const stale = SRC.match(/scRevisionConflict:\s*"[^"]*(关闭后重新打开|關閉後重新開啟|close and reopen|閉じて開き直して|닫았다가 다시 열고)[^"]*"/g) || [];
t("scRevisionConflict 不再要求关闭重开", stale.length === 0, stale.length + " 处残留");

/* pt-BR 归一化回归防线 */
t("pt-BR 语言代码可被归一化命中", /if \(v === "pt" \|\| v === "pt-br"\) return "pt-BR";/.test(SRC));

console.log(`\n设置中心 i18n：pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
