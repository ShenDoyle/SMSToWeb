/**
 * Netlify Scheduled Function：每天 UTC 17:00（北京 01:00）清理过期数据
 * 与 Cloudflare Worker 版 [triggers] crons = ["0 17 * * *"] 行为一致。
 * 也可改用外部 cron 调用 GET /api/cron?token=<RECEIVE_TOKEN>，二者取其一即可。
 */
import { runCron } from "../app.js";
import { createTursoDb } from "../db.js";

export const config = { schedule: "0 17 * * *" };

let cachedDb = null;

/* ==== ENV_KEYS BEGIN（由 platforms/gen_app.py 同步，勿手工修改）==== */
const ENV_KEYS = [
  "RECEIVE_TOKEN",
  "ENABLE_AUTH",
  "ADMIN_PASSWORD",
  "RETENTION_DAYS",
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

/* 环境变量 → 核心应用 env 对象（白名单循环透传；Turso 连接实例在进程内缓存复用） */
function buildEnv() {
  if (!cachedDb) {
    cachedDb = createTursoDb({
      TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL || "",
      TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN || "",
    });
  }
  const env = { DB: cachedDb };
  for (const k of ENV_KEYS) env[k] = process.env[k] || "";
  return env;
}

export default async function scheduledHandler() {
  await runCron(buildEnv());
  return new Response(JSON.stringify({ success: true }), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
