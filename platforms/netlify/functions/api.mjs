/**
 * SMSToWeb — Netlify Functions v2 入口（path "/*" 捕获全部路由）
 * 本目录自包含：app.js（核心应用）与 db.js（Turso 适配层）均为本目录内独立副本，
 * 直接把 netlify/ 作为 base 目录部署即可（见 platforms/README.md「Netlify」）。
 *
 * 说明：
 *  - 运行于 Node 且原生支持 Web 标准 Request/Response，与核心应用零转换；
 *  - 长轮询 /api/wait：免费版函数执行上限约 10s，本入口默认把 WAIT_MAX_SECONDS 设为 8，
 *    避免请求被平台强杀；如需更短/更长可在环境变量里显式覆盖（3–25）；
 *  - 定时清理：functions/cron.mjs 为 Netlify Scheduled Function（每天 UTC 17:00）；
 *    也可用外部 cron 调用 GET /api/cron?token=<RECEIVE_TOKEN>。
 */
import { fetchApp, handleCronRequest } from "../app.js";
import { createTursoDb } from "../db.js";

/* 捕获所有路径，统一交给核心应用路由处理 */
export const config = { path: "/*" };

let cachedDb = null;
let cachedDbKey = "";

/* ==== ENV_KEYS BEGIN（由 platforms/gen_app.py 同步，勿手工修改）==== */
const ENV_KEYS = [
  "RECEIVE_TOKEN",
  "ENABLE_AUTH",
  "ADMIN_PASSWORD",
  "RETENTION_DAYS",
  "WAIT_MAX_SECONDS",
  "PHONE_AREA_ENABLED",
  "PHONE_AREA_API",
  "SITE_NAME",
  "SITE_ICON",
  "FEISHU_WEBHOOK",
  "FEISHU_SECRET",
  "WECOM_WEBHOOK",
  "DINGTALK_WEBHOOK",
  "DINGTALK_SECRET",
  "SERVERCHAN_SENDKEY",
  "PUSHPLUS_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "BARK_DEVICE_KEY",
  "BARK_URL",
  "NTFY_URL",
  "NTFY_TOKEN",
  "GOTIFY_URL",
  "GOTIFY_TOKEN",
  "RESEND_API_KEY",
  "MAIL_TO",
  "MAIL_FROM",
  "GENERIC_WEBHOOKS",
  "GENERIC_WEBHOOK_TEMPLATE",
  "GENERIC_WEBHOOK_HEADERS",
];
/* ==== ENV_KEYS END ==== */

/* 环境变量 → 核心应用 env 对象（白名单循环透传；Turso 客户端按凭据指纹键控缓存，环境变量变更自动重建） */
function buildEnv() {
  const dbUrl = process.env.TURSO_DATABASE_URL || "";
  const dbToken = process.env.TURSO_AUTH_TOKEN || "";
  const dbKey = dbUrl + "\u0000" + dbToken;
  if (!cachedDb || cachedDbKey !== dbKey) {
    cachedDb = createTursoDb({
      TURSO_DATABASE_URL: dbUrl,
      TURSO_AUTH_TOKEN: dbToken,
    });
    cachedDbKey = dbKey;
  }
  const env = { DB: cachedDb };
  for (const k of ENV_KEYS) env[k] = process.env[k] || "";
  /* Netlify Functions 默认 10s 执行上限：长轮询默认降到 8s，避免请求被平台强杀
     （显式配置 WAIT_MAX_SECONDS 时以配置为准） */
  if (!env.WAIT_MAX_SECONDS) env.WAIT_MAX_SECONDS = "8";
  return env;
}

function configError(e) {
  return new Response(JSON.stringify({ success: false, error: "config error: " + (e && e.message) }), {
    status: 500,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async function handler(request) {
  let env;
  try {
    env = buildEnv();
  } catch (e) {
    return configError(e);
  }
  const url = new URL(request.url);
  if (url.pathname.replace(/\/+$/, "") === "/api/cron") {
    return handleCronRequest(request, env);
  }
  return fetchApp(request, env);
}
