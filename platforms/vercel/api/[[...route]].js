/**
 * SMSToWeb — Vercel Edge Function 入口（catch-all：捕获全部路径）
 * 本目录自包含：app.js（核心应用）与 db.js（Turso 适配层）均为本目录内独立副本，
 * 直接把 vercel/ 作为项目根目录部署即可（见 platforms/README.md「Vercel」）。
 *
 * 说明：
 *  - runtime=edge：直接使用 Web 标准 Request/Response，与核心应用零转换；
 *  - 长轮询 /api/wait 最长挂起 25s：若执行上限被提前截断，前端轮询循环会自动重试，不影响使用；
 *  - 定时清理：vercel.json 已配置 crons 调用 /api/cron；
 *    Vercel Cron 会自动附带 Authorization: Bearer $CRON_SECRET，
 *    请把环境变量 CRON_SECRET 设为与 RECEIVE_TOKEN 相同的值。
 */
import { fetchApp, handleCronRequest } from "../app.js";
import { createTursoDb } from "../db.js";

export const config = { runtime: "edge" };

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
  "NOTIFY_LINK",
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
  /* Vercel Edge 单次请求约 25s 上限：长轮询默认 20s，留出响应头写出的余量
     （显式配置 WAIT_MAX_SECONDS 时以配置为准） */
  if (!env.WAIT_MAX_SECONDS) env.WAIT_MAX_SECONDS = "20";
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
