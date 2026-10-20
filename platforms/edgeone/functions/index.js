/**
 * SMSToWeb — 腾讯 EdgeOne Makers Functions 根路径入口（index.js 专门承接 GET /）
 *
 * 背景：EdgeOne Makers 的 Functions 路由规则中，[[default]].js 兜底只匹配
 * /foo、/api/xxx 等非根路径，根路径 / 只认 index.js（官方文档：index.js -> example.com/）。
 * 缺少本文件时访问 / 会命中平台默认 404 页面。
 *
 * 本文件是 EdgeOne 侧唯一逻辑入口：[[default]].js 仅 re-export 本文件的 onRequest，
 * 全部逻辑与 ENV_KEYS 白名单以本文件为单一来源（ENV_KEYS 块由 platforms/gen_app.py 同步）。
 */
import { fetchApp, handleCronRequest } from "../app.js";
import { createTursoDb } from "../db.js";

let cachedDb = null;

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

/* EdgeOne 环境变量通过 onRequest 的 env 参数注入（对象形式，白名单循环透传） */
function buildEnv(vars) {
  const g = function (k) {
    return vars && vars[k] != null ? String(vars[k]) : "";
  };
  if (!cachedDb) {
    cachedDb = createTursoDb({
      TURSO_DATABASE_URL: g("TURSO_DATABASE_URL"),
      TURSO_AUTH_TOKEN: g("TURSO_AUTH_TOKEN"),
    });
  }
  const e = { DB: cachedDb };
  for (const k of ENV_KEYS) e[k] = g(k);
  /* 边缘函数执行时长比 Worker 紧：长轮询默认 20s，可用 WAIT_MAX_SECONDS 覆盖（3–25） */
  if (!e.WAIT_MAX_SECONDS) e.WAIT_MAX_SECONDS = "20";
  return e;
}

function configError(e) {
  return new Response(JSON.stringify({ success: false, error: "config error: " + (e && e.message) }), {
    status: 500,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function onRequest({ request, env }) {
  let e;
  try {
    e = buildEnv(env);
  } catch (err) {
    return configError(err);
  }
  const url = new URL(request.url);
  if (url.pathname.replace(/\/+$/, "") === "/api/cron") {
    return handleCronRequest(request, e);
  }
  return fetchApp(request, e);
}
