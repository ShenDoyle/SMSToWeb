/**
 * P1-1：DISABLE_RECEIVE_TOKEN 六平台透传一致性 + 核心校验函数行为测试
 *
 * 运行：node tests/p1-auth.mjs   （退出码 0=全过，1=有失败，2=异常）
 *
 * 覆盖：
 *  A. 静态：六个移植入口的 ENV_KEYS 白名单块均包含 DISABLE_RECEIVE_TOKEN，
 *     且各入口 buildEnv 均按 ENV_KEYS 循环透传（证明六个平台统一的「传参」前提）。
 *  B. 功能：核心 verifyInboundToken 在「未设置 / 启用兜底(禁用=false) / 禁用(=true, 大小写不敏感)」
 *     三种情况下行为正确，且与 RECEIVE_TOKEN 兜底、库内令牌优先级协同；
 *     六个平台共用同一份 src/worker.js（经生成器逐字节同步），故核心逻辑六平台一致。
 *  C. 安全：默认（未设置）仍启用兜底、显式 "false" 不误关、库内令牌优先级高于兜底开关、
 *     未授权请求一律拒绝（fail-closed）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verifyInboundToken } from "../platforms/shared/app.js";

const SELF = dirname(fileURLToPath(import.meta.url));
const REPO = join(SELF, "..");

const ENTRY_FILES = [
  "platforms/vercel/api/[[...route]].js",
  "platforms/netlify/functions/api.mjs",
  "platforms/netlify/functions/cron.mjs",
  "platforms/deno/main.js",
  "platforms/edgeone/functions/index.js",
  "platforms/node/server.mjs",
];

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; fails.push(name + (detail ? " :: " + detail : "")); console.log("  FAIL " + name + (detail ? " :: " + detail : "")); }
}

/* ---------------- A. 静态：六平台 ENV_KEYS 白名单 + buildEnv 透传 ---------------- */
console.log("== A. 六平台 ENV_KEYS 白名单与 buildEnv 透传 ==");
const blocks = [];
for (const rel of ENTRY_FILES) {
  const text = readFileSync(join(REPO, rel), "utf-8");
  const b = text.indexOf("/* ==== ENV_KEYS BEGIN");
  const e = text.indexOf("/* ==== ENV_KEYS END ====");
  const block = b >= 0 && e > b ? text.slice(b, e) : "";
  blocks.push(block);
  ok(block.includes('"DISABLE_RECEIVE_TOKEN"'),
    "ENV_KEYS 含 DISABLE_RECEIVE_TOKEN [" + rel + "]", "block 长度=" + block.length);
  /* 各入口必须存在按 ENV_KEYS 循环透传的语句（白名单唯一的传参路径） */
  const forwards = /for\s*\(const\s+k\s+of\s+ENV_KEYS\)\s*env\[k\]\s*=/.test(text)
    || /for\s*\(const\s+k\s+of\s+ENV_KEYS\)\s*e\[k\]\s*=/.test(text)
    || /for\s*\(const\s+k\s+of\s+ENV_KEYS\)\s*env\[k\]\s*=\s*Deno\.env\.get/.test(text)
    || /for\s*\(const\s+k\s+of\s+ENV_KEYS\)\s*e\[k\]\s*=\s*g\(k\)/.test(text);
  ok(forwards, "buildEnv 按 ENV_KEYS 循环透传 [" + rel + "]");
}
/* 六入口白名单块必须完全一致（生成器单一来源，防漂移） */
ok(blocks.every(function (x) { return x === blocks[0]; }), "六入口 ENV_KEYS 块完全一致");
ok(blocks[0].split("\n").filter(function (l) { return l.includes('"'); }).length === 33,
  "ENV_KEYS 现含 33 项 (32 + DISABLE_RECEIVE_TOKEN)", "实际=" + blocks[0].split("\n").filter(function (l) { return l.includes('"'); }).length);

/* ---------------- B/C. 功能：verifyInboundToken 行为矩阵 ---------------- */
console.log("== B/C. 核心 verifyInboundToken 行为矩阵 ==");

function makeReq(token) {
  const u = "https://example.com/api/receive" + (token ? "?token=" + encodeURIComponent(token) : "");
  return new Request(u, { headers: {} });
}
function makeEnv(opts) {
  const o = opts || {};
  let dbReturnsToken = !!o.dbToken;
  return {
    RECEIVE_TOKEN: o.receiveToken || "",
    DISABLE_RECEIVE_TOKEN: o.disable || "",
    DB: {
      prepare: function () {
        return {
          bind: function () {
            return {
              first: async function () {
                return dbReturnsToken ? { id: "t1", revoked_at: null, expires_at: null } : null;
              },
              run: async function () { return { meta: { changes: 1 } }; },
            };
          },
        };
      },
    },
  };
}

async function check(name, opts, expected) {
  const env = makeEnv(opts);
  const req = makeReq(opts.provided);
  const url = new URL(req.url);
  const res = await verifyInboundToken(req, env, url, undefined);
  ok(res === expected, name, "got=" + res + " expected=" + expected);
}

/* 未设置（默认）：兜底启用 */
await check("未设置 + RECEIVE_TOKEN 正确 → 放行(兜底生效)", { receiveToken: "SEC", provided: "SEC", disable: "" }, true);
await check("未设置 + RECEIVE_TOKEN 错误 → 拒绝", { receiveToken: "SEC", provided: "WRONG", disable: "" }, false);
/* 显式禁用 = "true" */
await check("DISABLE=true + RECEIVE_TOKEN 正确 → 拒绝(兜底停用)", { receiveToken: "SEC", provided: "SEC", disable: "true" }, false);
await check("DISABLE=true + 无 RECEIVE_TOKEN → 拒绝", { receiveToken: "", provided: "X", disable: "true" }, false);
/* 显式 "false" 不应误关兜底（保持默认安全语义） */
await check("DISABLE=false + RECEIVE_TOKEN 正确 → 放行", { receiveToken: "SEC", provided: "SEC", disable: "false" }, true);
/* 大小写不敏感 */
await check("DISABLE=TRUE(大写) + RECEIVE_TOKEN 正确 → 拒绝", { receiveToken: "SEC", provided: "SEC", disable: "TRUE" }, false);
/* 空白/无关值不视为停用 */
await check("DISABLE=yes(非 true) + RECEIVE_TOKEN 正确 → 放行", { receiveToken: "SEC", provided: "SEC", disable: "yes" }, true);
/* 空 token → 拒绝 */
await check("未提供 token → 拒绝", { receiveToken: "SEC", provided: "", disable: "" }, false);
/* 库内令牌优先级高于兜底开关：即便 DISABLE=true，库内命中仍放行 */
await check("库内令牌命中 + DISABLE=true → 仍放行(优先级)", { receiveToken: "SEC", provided: "ANY", disable: "true", dbToken: true }, true);

/* ---------------- 汇总 ---------------- */
console.log("");
console.log("===== P1-1 鉴权测试：pass=" + pass + " fail=" + fail + " =====");
if (fail > 0) {
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
