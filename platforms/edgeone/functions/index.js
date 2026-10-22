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

/* EdgeOne 环境变量通过 onRequest 的 env 参数注入（对象形式，白名单循环透传） */
function buildEnv(vars) {
  const g = function (k) {
    return vars && vars[k] != null ? String(vars[k]) : "";
  };
  /* Turso 客户端按凭据指纹键控缓存：环境变量变更后自动重建，无需重新部署 */
  const dbUrl = g("TURSO_DATABASE_URL");
  const dbToken = g("TURSO_AUTH_TOKEN");
  const dbKey = dbUrl + "\u0000" + dbToken;
  if (!cachedDb || cachedDbKey !== dbKey) {
    cachedDb = createTursoDb({
      TURSO_DATABASE_URL: dbUrl,
      TURSO_AUTH_TOKEN: dbToken,
    });
    cachedDbKey = dbKey;
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
  /* ==== 临时诊断接口（排障用，确认后移除）：/api/debug-db?key=<ADMIN_PASSWORD> ==== */
  if (url.pathname.replace(/\/+$/, "") === "/api/debug-db") {
    const key = url.searchParams.get("key") || "";
    if (!e.ADMIN_PASSWORD || key !== e.ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ success: false, error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    const rawUrl = (env && env.TURSO_DATABASE_URL != null ? String(env.TURSO_DATABASE_URL) : "").trim();
    const rawToken = (env && env.TURSO_AUTH_TOKEN != null ? String(env.TURSO_AUTH_TOKEN) : "").trim();
    let kind = "空";
    try {
      const parts = rawToken.split(".");
      if (rawToken && parts.length !== 3) kind = "格式异常(段数=" + parts.length + ")";
      else if (rawToken) {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        if (payload && payload.kid) kind = "db-token(kid=" + String(payload.kid).slice(0, 6) + "…)";
        else if (payload && payload.org_id != null) kind = "org-token(组织级,错误类型)";
        else kind = "unknown(" + Object.keys(payload || {}).join(",") + ")";
      }
    } catch (kerr) {
      kind = "解析失败: " + (kerr && kerr.message);
    }
    const diag = {
      url_present: !!rawUrl,
      url_host: rawUrl ? (rawUrl.replace(/^libsql:\/\//, "https://").split("/")[2] || "?") : null,
      token_len: rawToken.length,
      token_kind: kind,
      eo_fetch_status: null,
      eo_fetch_error: null,
      eo_body_sample: null,
    };
    if (rawUrl && rawToken) {
      const ep = rawUrl.replace(/^libsql:\/\//, "https://") + "/v2/pipeline";
      try {
        const r = await fetch(ep, {
          method: "POST",
          headers: { Authorization: "Bearer " + rawToken, "Content-Type": "application/json" },
          body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql: "SELECT 1" } }, { type: "close" }] }),
        });
        diag.eo_fetch_status = r.status;
        diag.eo_body_sample = (await r.text()).slice(0, 240);
      } catch (ferr) {
        diag.eo_fetch_error = String((ferr && ferr.message) || ferr);
      }
    }
    return new Response(JSON.stringify(diag, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  /* ==== 临时诊断接口结束 ==== */
  if (url.pathname.replace(/\/+$/, "") === "/api/cron") {
    return handleCronRequest(request, e);
  }
  return fetchApp(request, e);
}
