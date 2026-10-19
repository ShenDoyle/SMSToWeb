/**
 * SMS Gateway (SMSToWeb) — Cloudflare Worker
 * 接收 SmsForwarder(短信转发器) Webhook 推送的短信，存入 D1，提供 JSON API 与 Web 管理页。
 * 设备标签（网页标签展示值）由 App 消息模板的 name 字段提供（自定义名称）；sim 填收件手机号，
 * 在卡片右下角展示，双击可复制。
 *
 * 除短信外，任何平台（Linux/Windows/macOS/iOS/安卓等）均可通过通用推送接口
 * POST /api/push 提交通知类消息，与短信一起在管理页按「来源」筛选查看。
 *
 * 可配置项（部署时在 Variables / wrangler.toml [vars] 设置）：
 *   RETENTION_DAYS   — 数据保留天数，默认 30（每天 UTC 17:00 定时清理）
 *   ENABLE_AUTH      — 管理页登录开关："true" 需密码登录，"false" 免登录（默认）
 *   通知转发（可选，多渠道并发；配置哪个渠道变量就转发哪个，全部未配置则不转发）：
 *     FEISHU_WEBHOOK(+可选 FEISHU_SECRET 签名校验) / WECOM_WEBHOOK / DINGTALK_WEBHOOK(+DINGTALK_SECRET 加签)
 *       — 飞书 / 企业微信 / 钉钉群机器人
 *     SERVERCHAN_SENDKEY / PUSHPLUS_TOKEN — Server酱 / PushPlus
 *     TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID — Telegram Bot
 *     BARK_DEVICE_KEY(+BARK_URL，默认官方) / NTFY_URL(+NTFY_TOKEN 受保护主题) / GOTIFY_URL + GOTIFY_TOKEN
 *       — Bark / ntfy / Gotify
 *     RESEND_API_KEY + MAIL_TO(+MAIL_FROM) — 邮件（Resend）
 *     GENERIC_WEBHOOKS（逗号分隔多 URL，可选 GENERIC_WEBHOOK_TEMPLATE 自定义请求体、
 *       GENERIC_WEBHOOK_HEADERS 自定义请求头 JSON，如 {"Authorization":"Bearer xxx"}）— 通用 Webhook，
 *     第三方 API（短信网关等）均由此接入
 *   SITE_NAME        — 网站名（可选）：管理页标题/页头，默认「短信网关」
 *   SITE_ICON        — 网站图标 URL（可选）：默认 jsdelivr favicon；设置了但加载失败自动回退默认
 *   （Secret）RECEIVE_TOKEN   — 推送鉴权（/api/receive 与 /api/push 共用）
 *   （Secret）ADMIN_PASSWORD  — 登录密码（仅 ENABLE_AUTH="true" 时需要；登录连续失败 5 次锁 10 分钟）
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Receive-Token, Authorization",
  "Access-Control-Max-Age": "86400",
};

const DEFAULT_RETENTION_DAYS = 30;
/* 单条消息正文字数上限：超出截断，防止超大载荷撑爆存储 */
const MAX_CONTENT = 8000;

/* 站名与图标：可用变量 SITE_NAME / SITE_ICON 覆盖；图标设置了但加载失败时前端自动回退默认 */
const DEFAULT_SITE_NAME = "短信网关";
const DEFAULT_SITE_ICON = "https://cdn.jsdelivr.net/gh/ShenDoyle/ShenDoyle.github.io@main/img/site/favicon.ico";

function siteName(env) {
  return (String(env.SITE_NAME || "").trim() || DEFAULT_SITE_NAME).slice(0, 40);
}
function siteIcon(env) {
  const v = String(env.SITE_ICON || "").trim();
  return /^https?:\/\/\S+$/i.test(v) ? v : DEFAULT_SITE_ICON;
}
function escAttr(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
/* 注入 JS 字符串字面量：JSON 转义并把 < 转 unicode，防止值里出现 </script> 提前闭合 */
function jsStr(s) {
  return JSON.stringify(s).replace(/</g, "\\u003c");
}
/* 把页面模板中的占位标记替换为实际配置值（用函数替换器，避免值里含 $& 等特殊序列被误解释） */
function renderHtml(html, env) {
  return html
    .replace(/__SITE_NAME__/g, function () { return escAttr(siteName(env)); })
    .replace(/__SITE_NAME_JSON__/g, function () { return jsStr(siteName(env)); })
    .replace(/__SITE_ICON__/g, function () { return escAttr(siteIcon(env)); })
    .replace(/__DEFAULT_ICON_JSON__/g, function () { return jsStr(DEFAULT_SITE_ICON); });
}

/* 设备标签（网页标签展示值）由 App 消息模板的 name 字段提供，自定义命名；
   sim 填收件手机号，展示在卡片右下角（双击复制）。未渲染的 {{变量}} 字面量在接收时被置空。 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS },
  });
}

function nowUTC() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** 时序安全的 token 比较（避免 timing 泄露） */
function safeEqual(a, b) {
  const ba = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

/* 后台任务调度：Cloudflare 传真实 ctx，用 ctx.waitUntil（响应即时返回、后台续跑）；
   其他平台不传 ctx（undefined），退化为内联 await，确保通知在响应前完成、不被平台截断 */
function bgRun(ctx, p) {
  if (ctx && typeof ctx.waitUntil === "function") { ctx.waitUntil(p); return; }
  return p;
}

/* ---------------- 管理页登录（可选，由 ENABLE_AUTH 开关控制） ---------------- */

const AUTH_COOKIE = "sms_auth";

/* 开关是否处于开启状态（仅字符串 "true" 视为开启）。
   开启但未设 ADMIN_PASSWORD 时按免登录处理并告警一次——避免"开了登录却忘设密码"把自己锁死在登录页外 */
let warnedAuthNoPw = false;
function authEnabled(env) {
  if (String(env.ENABLE_AUTH || "").trim().toLowerCase() !== "true") return false;
  if (!String(env.ADMIN_PASSWORD || "")) {
    if (!warnedAuthNoPw) {
      warnedAuthNoPw = true;
      console.warn("ENABLE_AUTH=true 但未设置 ADMIN_PASSWORD：已按免登录处理，设置密码后即启用登录");
    }
    return false;
  }
  return true;
}

/* 无状态登录凭证：SHA-256("sms-gateway-auth-v1|" + 密码)，密码不变则凭证稳定，无需存储 */
async function authCookieValue(password) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("sms-gateway-auth-v1|" + password)
  );
  return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

/* 是否 HTTPS：据此决定 cookie 是否带 Secure。局域网 IP / 无 TLS 的 http 自托管若强制 Secure，
   浏览器会拒存 cookie，导致输入密码后刷新又跳回登录页（安卓第三方浏览器尤明显）*/
function isHttps(request) {
  const xf = (request.headers.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
  if (xf) return xf === "https";
  try { return new URL(request.url).protocol === "https:"; } catch (e) { return false; }
}
/* 登录/登出 cookie 头：HTTPS 下带 Secure，http 下降级（保证明文部署也能正常登录） */
function authCookieHeader(request, value, maxAge) {
  return AUTH_COOKIE + "=" + value + "; Path=/; HttpOnly; " +
    (isHttps(request) ? "Secure; " : "") + "SameSite=Lax; Max-Age=" + maxAge;
}

function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

/* 管理接口/页面统一鉴权：开关关闭直接放行；开启则校验登录 cookie */
async function isAuthed(request, env) {
  if (!authEnabled(env)) return true;
  if (!env.ADMIN_PASSWORD) return false; /* 开启登录但未设密码 → 一律拒绝（安全默认） */
  return getCookie(request, AUTH_COOKIE) === (await authCookieValue(env.ADMIN_PASSWORD));
}

/* 登录限速（简单内存态，实例重启即清零；Serverless 多实例下为尽力而为的软限制）：
 * 同一 IP 连续失败 LOGIN_FAIL_LIMIT 次后，锁定 LOGIN_LOCK_MS 时长内拒绝登录尝试 */
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const loginFails = new Map(); /* ip -> { count, lockedUntil } */

function clientIp(request) {
  return (request.headers.get("CF-Connecting-IP")
    || (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim()
    || "unknown");
}

function loginLocked(request) {
  const ip = clientIp(request);
  const rec = loginFails.get(ip);
  if (!rec) return false;
  if (rec.lockedUntil > Date.now()) return true;
  if (rec.lockedUntil) loginFails.delete(ip); /* 仅在曾锁定且已过期时清零重来（未锁定记录保留计数） */
  return false;
}

function recordLoginFail(request) {
  const ip = clientIp(request);
  const rec = loginFails.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_FAIL_LIMIT) {
    rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
    rec.count = 0;
  }
  loginFails.set(ip, rec);
  if (loginFails.size > 1000) { /* 防 Map 无限膨胀：清理已过期条目 */
    const now = Date.now();
    for (const [k, v] of loginFails) if (v.lockedUntil <= now) loginFails.delete(k);
  }
}

async function handleLogin(request, env) {
  if (!authEnabled(env) || !env.ADMIN_PASSWORD) return json({ success: false, error: "auth disabled" }, 400);
  if (loginLocked(request)) return json({ success: false, error: "too many attempts" }, 429);
  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: "invalid json" }, 400); }
  const pw = body && body.password !== undefined ? String(body.password) : "";
  if (!pw || !safeEqual(pw, env.ADMIN_PASSWORD)) {
    recordLoginFail(request);
    return json({ success: false, error: "wrong password" }, 403);
  }
  clearLoginFail(request);
  const token = await authCookieValue(env.ADMIN_PASSWORD);
  return new Response(JSON.stringify({ success: true }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": authCookieHeader(request, token, 604800),
      ...CORS,
    },
  });
}

function clearLoginFail(request) { loginFails.delete(clientIp(request)); }

/* 写入接口（/api/receive、/api/push）限速：每 IP 每分钟 WRITE_RATE_LIMIT 次，超出返回 429。
   内存态、实例重启清零，Serverless 多实例下为尽力而为的软限制；用于遏制 token 泄露后被网页/脚本刷库 */
const WRITE_RATE_LIMIT = 120;
const WRITE_RATE_WINDOW_MS = 60 * 1000;
const writeRate = new Map(); /* ip -> { count, reset } */
function allowWrite(request) {
  const ip = clientIp(request);
  const now = Date.now();
  let rec = writeRate.get(ip);
  if (!rec || now >= rec.reset) { rec = { count: 0, reset: now + WRITE_RATE_WINDOW_MS }; writeRate.set(ip, rec); }
  rec.count += 1;
  if (writeRate.size > 5000) { for (const [k, v] of writeRate) if (now >= v.reset) writeRate.delete(k); }
  return rec.count <= WRITE_RATE_LIMIT;
}

function handleLogout(request) {
  return new Response(JSON.stringify({ success: true }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": authCookieHeader(request, "", 0),
      ...CORS,
    },
  });
}

/**
 * 解析 SmsForwarder webhook 请求为统一结构
 * 兼容：JSON / 表单 / 纯文本 / query 参数；字段名多别名兼容（含中文模板变量名）
 */
async function parseIncoming(request, url) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  let raw = {};
  if (ct.includes("application/json")) {
    try { raw = await request.json(); } catch { return null; }
  } else if (ct.includes("urlencoded") || ct.includes("form-data")) {
    try {
      const form = await request.formData();
      for (const [k, v] of form.entries()) raw[k] = v;
    } catch { return null; }
  } else {
    const text = await request.text();
    try { raw = JSON.parse(text); } catch { raw = { content: text }; }
  }
  // query 参数兜底（SmsForwarder GET 转发场景）
  for (const k of ["token", "name", "device", "sim", "from", "content", "time"]) {
    if (raw[k] === undefined && url.searchParams.get(k) !== null) {
      raw[k] = url.searchParams.get(k);
    }
  }
  const pick = (...keys) => {
    for (const k of keys) {
      const v = raw[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
    return "";
  };
  return {
    token: pick("token", "access_token", "key"),
    name: pick("name", "device", "device_name", "设备名", "设备信息", "sim_info"),
    sim: pick("sim", "sim_slot", "卡槽信息", "card"),
    from: pick("from", "sender", "phone", "发送号码", "mobile", "address"),
    content: pick("content", "text", "body", "短信内容", "message", "msg"),
    time: pick("time", "timestamp", "date", "接收时间", "received_time"),
  };
}

/**
 * 时间标准化：统一为 UTC "YYYY-MM-DD HH:MM:SS"
 * 秒/毫秒时间戳 -> 精确解析；无时区的文本时间按北京时间(+08:00)解析
 */
function normalizeTime(t) {
  if (!t) return nowUTC();
  const s = String(t).trim();
  const toStr = (d) => d.toISOString().replace("T", " ").slice(0, 19);
  if (/^\d{10}$/.test(s)) return toStr(new Date(Number(s) * 1000));
  if (/^\d{13}$/.test(s)) return toStr(new Date(Number(s)));
  const withTZ = /Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s.replace(" ", "T") : s.replace(" ", "T") + "+08:00";
  const d = new Date(withTZ);
  return isNaN(d.getTime()) ? nowUTC() : toStr(d);
}

/* ---------------- 多渠道通知转发（可选：配置哪个渠道变量就转发到哪个渠道） ----------------
 * 新消息入库成功后并发转发到全部已配置渠道；单个渠道失败只记日志，不影响其他渠道与主流程；
 * 全部渠道变量未配置时不发任何请求。渠道与变量清单一览：
 *   飞书        FEISHU_WEBHOOK
 *   企业微信    WECOM_WEBHOOK
 *   钉钉        DINGTALK_WEBHOOK（可选 DINGTALK_SECRET 加签）
 *   Server酱    SERVERCHAN_SENDKEY
 *   PushPlus    PUSHPLUS_TOKEN
 *   Telegram    TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *   Bark        BARK_DEVICE_KEY（可选 BARK_URL，默认官方 https://api.day.app）
 *   ntfy        NTFY_URL（完整主题 URL，如 https://ntfy.sh/my-sms；JSON 发布支持中文标题；
 *               受保护主题可选 NTFY_TOKEN：值含「:」按 Basic user:password 发送，否则按 Access Token 走 Bearer）
 *   Gotify      GOTIFY_URL + GOTIFY_TOKEN
 *   邮件        RESEND_API_KEY + MAIL_TO（可选 MAIL_FROM，默认 onboarding@resend.dev）
 *   通用        GENERIC_WEBHOOKS（逗号分隔多个 URL；可选 GENERIC_WEBHOOK_TEMPLATE 自定义请求体，
 *               占位符 {{title}}/{{content}}/{{time}}/{{source}}/{{sender}}/{{device}}；
 *               可选 GENERIC_WEBHOOK_HEADERS 自定义请求头，JSON 对象字符串，
 *               如 {"Authorization":"Bearer xxx","X-Api-Key":"yyy"}）
 */

/* UTC 时间串 → 北京时间串（用于通知消息展示） */
function bjTime(utcStr) {
  const d = new Date(String(utcStr || "").replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return String(utcStr || "");
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + "（北京时间）";
}

function trimEnv(v) {
  return String(v === undefined || v === null ? "" : v).trim();
}

/* 通知渠道通用 POST；非 2xx 抛错由调用方记日志（不抛出影响主流程） */
async function postNotify(url, headers, body) {
  const opts = {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    body: body,
  };
  /* 单渠道 10s 超时：避免慢/挂起的第三方把内联 await 的响应拖死（无 waitUntil 的平台） */
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    opts.signal = AbortSignal.timeout(10000);
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error("HTTP " + res.status);
}

/* HMAC-SHA256 → base64（钉钉加签） */
async function hmacSha256Base64(secret, payload) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * 把一条已入库消息转发到全部已配置的通知渠道。
 * msg: { title, content, time, source, sender, device }
 * 返回 Promise（配合 ctx.waitUntil 保证 Worker 响应后仍在后台完成发送）。
 */
function dispatchNotify(env, msg) {
  const text = msg.title + "\n" + String(msg.content || "") + (msg.time ? "\n" + msg.time : "");
  const jobs = [];
  const t = trimEnv;

  const feishu = t(env.FEISHU_WEBHOOK);
  if (feishu) jobs.push(async function () {
    const payload = { msg_type: "text", content: { text: text } };
    const feishuSecret = t(env.FEISHU_SECRET);
    if (feishuSecret) {
      /* 飞书签名校验（机器人安全设置选「签名校验」时必配）：
         sign = base64(HMAC-SHA256(key = timestamp + "\n" + secret, message = ""))，timestamp 为秒级 */
      const ts = Math.floor(Date.now() / 1000);
      payload.timestamp = String(ts);
      payload.sign = await hmacSha256Base64(ts + "\n" + feishuSecret, "");
    }
    await postNotify(feishu, null, JSON.stringify(payload));
  });

  const wecom = t(env.WECOM_WEBHOOK);
  if (wecom) jobs.push(async function () {
    await postNotify(wecom, null, JSON.stringify({ msgtype: "text", text: { content: text } }));
  });

  const dingtalk = t(env.DINGTALK_WEBHOOK);
  if (dingtalk) jobs.push(async function () {
    let url = dingtalk;
    const secret = t(env.DINGTALK_SECRET);
    if (secret) {
      const ts = Date.now();
      const sign = await hmacSha256Base64(secret, ts + "\n" + secret);
      url += (url.indexOf("?") === -1 ? "?" : "&") + "timestamp=" + ts + "&sign=" + encodeURIComponent(sign);
    }
    await postNotify(url, null, JSON.stringify({ msgtype: "text", text: { content: text } }));
  });

  const serverchan = t(env.SERVERCHAN_SENDKEY);
  if (serverchan) jobs.push(async function () {
    const desp = String(msg.content || "") + (msg.time ? "\n\n" + msg.time : "");
    await postNotify(
      "https://sctapi.ftqq.com/" + encodeURIComponent(serverchan) + ".send",
      { "Content-Type": "application/x-www-form-urlencoded" },
      new URLSearchParams({ title: msg.title, desp: desp }).toString()
    );
  });

  const pushplus = t(env.PUSHPLUS_TOKEN);
  if (pushplus) jobs.push(async function () {
    await postNotify("https://www.pushplus.plus/send", null,
      JSON.stringify({ token: pushplus, title: msg.title, content: text, template: "txt" }));
  });

  const tgBot = t(env.TELEGRAM_BOT_TOKEN), tgChat = t(env.TELEGRAM_CHAT_ID);
  if (tgBot && tgChat) jobs.push(async function () {
    await postNotify("https://api.telegram.org/bot" + tgBot + "/sendMessage", null,
      JSON.stringify({ chat_id: tgChat, text: text }));
  });

  const barkKey = t(env.BARK_DEVICE_KEY);
  if (barkKey) jobs.push(async function () {
    const server = (t(env.BARK_URL) || "https://api.day.app").replace(/\/+$/, "");
    await postNotify(server + "/push", null,
      JSON.stringify({ device_key: barkKey, title: msg.title, body: text, group: "SMSToWeb" }));
  });

  const ntfy = t(env.NTFY_URL);
  if (ntfy) jobs.push(async function () {
    /* ntfy 用 JSON 发布模式（HTTP 头值仅限 Latin1，中文标题走 Title 头会被 fetch 拒绝）。
       NTFY_URL 为完整主题 URL：topic 取路径最后一段，POST 到其父目录（兼容根路径与反代子路径部署）；
       受保护主题可选 NTFY_TOKEN：值含「:」视为 user:password 走 Basic，否则按 Access Token 走 Bearer */
    const u = new URL(ntfy);
    const path = u.pathname.replace(/\/+$/, "");
    const slash = path.lastIndexOf("/");
    const topic = decodeURIComponent(path.slice(slash + 1));
    if (!topic) throw new Error("NTFY_URL 需为完整主题 URL（如 https://ntfy.sh/my-topic）");
    const ntfyHeaders = { "Content-Type": "application/json" };
    const ntfyTok = t(env.NTFY_TOKEN);
    if (ntfyTok) {
      ntfyHeaders.Authorization = ntfyTok.indexOf(":") !== -1 ? "Basic " + btoa(ntfyTok) : "Bearer " + ntfyTok;
    }
    await postNotify(u.origin + path.slice(0, slash + 1), ntfyHeaders,
      JSON.stringify({ topic: topic, title: msg.title, message: text }));
  });

  const gotifyUrl = t(env.GOTIFY_URL), gotifyToken = t(env.GOTIFY_TOKEN);
  if (gotifyUrl && gotifyToken) jobs.push(async function () {
    await postNotify(gotifyUrl.replace(/\/+$/, "") + "/message?token=" + encodeURIComponent(gotifyToken), null,
      JSON.stringify({ title: msg.title, message: text, priority: 5 }));
  });

  const resendKey = t(env.RESEND_API_KEY), mailTo = t(env.MAIL_TO);
  if (resendKey && mailTo) jobs.push(async function () {
    const to = mailTo.split(/[,;，；]/).map(function (s) { return s.trim(); }).filter(Boolean);
    await postNotify("https://api.resend.com/emails",
      { Authorization: "Bearer " + resendKey },
      JSON.stringify({
        from: t(env.MAIL_FROM) || "onboarding@resend.dev",
        to: to,
        subject: msg.title,
        text: text,
      }));
  });

  /* 通用 Webhook：默认 POST JSON {title,content,time,source,sender,device}；
     配置 GENERIC_WEBHOOK_TEMPLATE 后按模板渲染请求体（可解析为 JSON 则按 JSON 发送，否则按纯文本），
     第三方 API（短信网关、自建系统等）由此接入 */
  const genericUrls = String(env.GENERIC_WEBHOOKS || "").split(",").map(function (s) { return s.trim(); })
    .filter(function (u) { return /^https?:\/\//i.test(u); });
  if (genericUrls.length) {
    const payload = {
      title: msg.title, content: String(msg.content || ""), time: msg.time || "",
      source: msg.source || "", sender: msg.sender || "", device: msg.device || "",
    };
    let genericBody = JSON.stringify(payload);
    let genericCt = "application/json";
    const tpl = t(env.GENERIC_WEBHOOK_TEMPLATE);
    if (tpl) {
      genericBody = tpl;
      for (const k of Object.keys(payload)) {
        genericBody = genericBody.split("{{" + k + "}}").join(String(payload[k]));
      }
      try { JSON.parse(genericBody); } catch (e) { genericCt = "text/plain"; }
    }
    /* 可选自定义请求头：GENERIC_WEBHOOK_HEADERS 为 JSON 对象字符串，如 {"Authorization":"Bearer xxx"}；
       解析失败忽略该配置（仅用默认头），不影响转发。显式指定的 Content-Type 优先于默认值 */
    const genericHeaders = { "Content-Type": genericCt };
    const hdrRaw = t(env.GENERIC_WEBHOOK_HEADERS);
    if (hdrRaw) {
      try {
        const parsed = JSON.parse(hdrRaw);
        for (const k of Object.keys(parsed)) genericHeaders[k] = String(parsed[k]);
      } catch (e) {
        console.error("GENERIC_WEBHOOK_HEADERS 需为 JSON 对象字符串，解析失败已忽略:", e && e.message);
      }
    }
    for (const u of genericUrls) {
      jobs.push(async function () { await postNotify(u, genericHeaders, genericBody); });
    }
  }

  if (!jobs.length) return Promise.resolve();
  return Promise.allSettled(jobs.map(function (job) {
    return job().catch(function (e) {
      console.error("notify forward failed:", e && e.message);
    });
  }));
}

/* ---------------- 接收（短信：SmsForwarder 等 App Webhook） ---------------- */

async function handleReceive(request, env, url, ctx) {
  if (!allowWrite(request)) return json({ success: false, error: "too many requests" }, 429);
  const data = await parseIncoming(request, url);
  if (!data) return json({ success: false, error: "invalid body" }, 400);

  // 鉴权：token 可在 query 或 body，与 Secret 比对
  const provided = url.searchParams.get("token") || data.token;
  if (!env.RECEIVE_TOKEN || !provided || !safeEqual(provided, env.RECEIVE_TOKEN)) {
    return json({ success: false, error: "unauthorized" }, 403);
  }
  if (!data.content) return json({ success: false, error: "empty content" }, 400);
  data.content = String(data.content).slice(0, MAX_CONTENT);

  // App 变量未渲染时值为 {{XXX}} 字面量：置空避免产生脏标签（标签名请在 App 模板中直接填自定义名称）
  if (String(data.name).indexOf("{{") !== -1) data.name = "";
  if (String(data.sim).indexOf("{{") !== -1) data.sim = "";

  // 设备注册/复用：name + sim 唯一（devices.device 列存 App 模板的 name 字段；改 name 会生成新标签）
  const dev = await env.DB.prepare(
    "INSERT INTO devices(device, sim) VALUES(?1, ?2) " +
    "ON CONFLICT(device, sim) DO UPDATE SET device = excluded.device RETURNING id"
  ).bind(data.name, data.sim).first();
  if (!dev || dev.id === undefined) return json({ success: false, error: "device upsert failed" }, 500);

  // 去重：同设备+发件人+内容+秒级时间 视为重复（SmsForwarder 重试场景）；重复不重复转发
  const receivedAt = normalizeTime(data.time);
  const ins = await env.DB.prepare(
    "INSERT OR IGNORE INTO messages(device_id, sender, content, received_at, source) VALUES(?1, ?2, ?3, ?4, 'sms')"
  ).bind(dev.id, data.from, data.content, receivedAt).run();
  const duplicated = ins.meta && ins.meta.changes === 0;

  if (!duplicated) {
    const head = "【短信】" + (data.sim || "未知收件号") + (data.from ? " ← " + data.from : "");
    await bgRun(ctx, dispatchNotify(env, {
      title: head,
      content: data.content,
      time: bjTime(receivedAt),
      source: "sms",
      sender: data.from,
      device: data.name || data.sim,
    }));
  }

  return json({
    success: true,
    device_id: dev.id,
    duplicated,
  });
}

/* ---------------- 通用推送（多平台接入）：POST /api/push ----------------
 * body(JSON): { token, source, sender/title, content, time, name }
 *   source — 来源标识，默认 "notify"（管理页来源筛选用，如 notify/sms/自定义）
 *   sender — 来源标题（如主机名、App 名、脚本名），可空
 *   name   — 设备标签名（与短信标签并列展示），默认「通知网关」；兼容旧字段 device
 */
async function handlePush(request, env, url, ctx) {
  if (!allowWrite(request)) return json({ success: false, error: "too many requests" }, 429);
  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: "invalid json" }, 400); }
  if (!body || typeof body !== "object") return json({ success: false, error: "invalid body" }, 400);

  const provided = url.searchParams.get("token") || body.token;
  if (!env.RECEIVE_TOKEN || !provided || !safeEqual(provided, env.RECEIVE_TOKEN)) {
    return json({ success: false, error: "unauthorized" }, 403);
  }
  let content = String(body.content || body.text || body.message || body.msg || "").trim();
  if (!content) return json({ success: false, error: "empty content" }, 400);
  content = content.slice(0, MAX_CONTENT);

  const source = (String(body.source || "notify").trim() || "notify").slice(0, 20);
  const sender = String(body.sender || body.title || body.from || "").trim().slice(0, 100);
  const deviceName = (String(body.name || body.device || "通知网关").trim() || "通知网关").slice(0, 50);

  const dev = await env.DB.prepare(
    "INSERT INTO devices(device, sim) VALUES(?1, '') " +
    "ON CONFLICT(device, sim) DO UPDATE SET device = excluded.device RETURNING id"
  ).bind(deviceName).first();
  if (!dev || dev.id === undefined) return json({ success: false, error: "device upsert failed" }, 500);

  const receivedAt = normalizeTime(body.time);
  const ins = await env.DB.prepare(
    "INSERT OR IGNORE INTO messages(device_id, sender, content, received_at, source) VALUES(?1, ?2, ?3, ?4, ?5)"
  ).bind(dev.id, sender, content, receivedAt, source).run();
  const duplicated = ins.meta && ins.meta.changes === 0;

  if (!duplicated) {
    const head = "【" + source + "】" + (sender ? sender + " · " : "") + deviceName;
    await bgRun(ctx, dispatchNotify(env, {
      title: head,
      content: content,
      time: bjTime(receivedAt),
      source: source,
      sender: sender,
      device: deviceName,
    }));
  }

  return json({ success: true, device_id: dev.id, duplicated });
}

/* ---------------- 查询 / 管理 API ---------------- */

async function handleListMessages(url, env) {
  const deviceId = parseInt(url.searchParams.get("device_id") || "", 10);
  const q = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20));

  const source = (url.searchParams.get("source") || "").trim();

  const where = [];
  const params = [];
  if (Number.isInteger(deviceId) && deviceId > 0) {
    where.push("m.device_id = ?");
    params.push(deviceId);
  }
  if (source) {
    where.push("m.source = ?");
    params.push(source);
  }
  if (q) {
    where.push("(m.content LIKE ? OR m.sender LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages m ${whereSql}`
  ).bind(...params).first();
  const total = totalRow ? totalRow.n : 0;

  const list = await env.DB.prepare(
    `SELECT m.id, m.sender, m.content, m.received_at, m.device_id, m.source,
            COALESCE(NULLIF(d.alias, ''), d.device) AS device_name, d.sim, d.device
     FROM messages m JOIN devices d ON d.id = m.device_id
     ${whereSql}
     ORDER BY m.received_at DESC, m.id DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, limit, (page - 1) * limit).all();

  const rows = list.results || [];
  for (const r of rows) r.sim_number = r.sim || "";

  return json({
    success: true,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    list: rows,
  });
}

async function handleDeleteMessage(idParam, env) {
  const id = parseInt(idParam, 10);
  if (!Number.isInteger(id) || id <= 0) return json({ success: false, error: "invalid id" }, 400);
  const res = await env.DB.prepare("DELETE FROM messages WHERE id = ?1").bind(id).run();
  return json({ success: true, deleted: res.meta ? res.meta.changes : 0 });
}

async function handleListDevices(env) {
  const list = await env.DB.prepare(
    `SELECT d.id, d.device, d.sim, d.alias,
            COALESCE(NULLIF(d.alias, ''), d.device) AS display_name,
            COUNT(m.id) AS msg_count, MAX(m.received_at) AS last_at
     FROM devices d LEFT JOIN messages m ON m.device_id = d.id
     GROUP BY d.id
     ORDER BY last_at DESC`
  ).all();
  // 标签显示优先级：别名 > 设备名（App 模板 name 字段，自定义） > 收件号（sim） > 未命名设备
  const rows = (list.results || []).map(function (r) {
    if (!r.alias) r.display_name = r.device || r.sim || "未命名设备";
    return r;
  });
  return json({ success: true, list: rows });
}

async function handleSetAlias(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: "invalid json" }, 400); }
  const id = parseInt(body && body.id, 10);
  const alias = body && body.alias !== undefined ? String(body.alias).trim().slice(0, 50) : null;
  if (!Number.isInteger(id) || id <= 0) return json({ success: false, error: "invalid device id" }, 400);
  await env.DB.prepare("UPDATE devices SET alias = ?1 WHERE id = ?2").bind(alias, id).run();
  return json({ success: true });
}

/* 删除设备（tag）：仅在无短信时可删，防止误删有数据的记录 */
async function handleDeleteDevice(idParam, env) {
  const id = parseInt(idParam, 10);
  if (!Number.isInteger(id) || id <= 0) return json({ success: false, error: "invalid id" }, 400);
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE device_id = ?1").bind(id).first();
  if (cnt && cnt.n > 0) return json({ success: false, error: "has messages" }, 400);
  const res = await env.DB.prepare("DELETE FROM devices WHERE id = ?1").bind(id).run();
  return json({ success: true, deleted: res.meta ? res.meta.changes : 0 });
}

/* 来源清单：聚合 messages.source 及条数，供管理页动态生成「来源筛选」下拉（替代写死的三项） */
async function handleListSources(env) {
  const rows = await env.DB.prepare(
    "SELECT source, COUNT(*) AS n FROM messages GROUP BY source ORDER BY n DESC"
  ).all();
  return json({ success: true, list: (rows.results || []).map(function (r) {
    return { source: r.source, count: r.n };
  }) });
}

/* 合并设备标签：把 from 的全部消息迁移到 to，成功后删除 from。
   目标已有同（设备+发件人+正文+时间）的重复消息时，UPDATE OR IGNORE 跳过，随后清掉残留（去重索引约束），不报错 */
async function handleMergeDevices(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: "invalid json" }, 400); }
  const from = parseInt(body && body.from, 10);
  const to = parseInt(body && body.to, 10);
  if (!Number.isInteger(from) || from <= 0 || !Number.isInteger(to) || to <= 0 || from === to) {
    return json({ success: false, error: "invalid device ids" }, 400);
  }
  const devs = await env.DB.prepare("SELECT id FROM devices WHERE id IN (?1, ?2)").bind(from, to).all();
  const ids = (devs.results || []).map(function (r) { return r.id; });
  if (ids.indexOf(from) === -1 || ids.indexOf(to) === -1) {
    return json({ success: false, error: "device not found" }, 404);
  }
  const moved = await env.DB.prepare("UPDATE OR IGNORE messages SET device_id = ?1 WHERE device_id = ?2").bind(to, from).run();
  await env.DB.prepare("DELETE FROM messages WHERE device_id = ?1").bind(from).run();
  await env.DB.prepare("DELETE FROM devices WHERE id = ?1").bind(from).run();
  return json({ success: true, moved: moved.meta ? moved.meta.changes : 0 });
}

/* 长轮询：最多挂起 25s，期间每 2s 查一次是否有比 last_id 更新的消息；
   有则立即返回 changed=true（前端收到后刷新列表），实现推送式自动刷新 */
async function handleWait(url, env) {
  const lastId = parseInt(url.searchParams.get("last_id") || "0", 10) || 0;
  const deviceId = parseInt(url.searchParams.get("device_id") || "", 10);
  const filter = Number.isInteger(deviceId) && deviceId > 0;
  const deadline = Date.now() + 25000;
  for (;;) {
    const sql = filter
      ? "SELECT MAX(id) AS n FROM messages WHERE device_id = ?1"
      : "SELECT MAX(id) AS n FROM messages";
    const row = await (filter ? env.DB.prepare(sql).bind(deviceId) : env.DB.prepare(sql)).first();
    if (row && row.n > lastId) return json({ success: true, changed: true });
    if (Date.now() > deadline) return json({ success: true, changed: false });
    await new Promise(function (r) { setTimeout(r, 2000); });
  }
}

/* ---------------- Web 管理界面（登录开关 ENABLE_AUTH 控制） ---------------- */

/* String.raw：内嵌前端源码按原文下发，防止模板字面量把 \b \d \s \/ 当转义序列吃掉 */
const PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="__SITE_ICON__">
<title>__SITE_NAME__</title>
<style>
  :root {
    --bg: #f5f6f7; --card: #fff; --text: #20242a; --muted: #6b7280; --faint: #9aa3ab;
    --border: #d8dce0; --card-border: #e3e6e9; --row-border: #eef1f3;
    --accent: #15803d; --accent-deep: #116632;
    --badge-bg: #e7f4ec; --sender: #0f766e; --link: #2563eb;
    --code-bg: #fef3c7; --code-border: #fcd34d; --code-text: #92400e; --code-hover: #fde68a;
    --del: #9aa3ab; --del-hover: #b91c1c; --tabx: #e8b4b4; --sw-off: #c7ced4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14171a; --card: #1d2126; --text: #e6e9ec; --muted: #9aa3ab; --faint: #6b7480;
      --border: #33393f; --card-border: #2a3036; --row-border: #262c31;
      --accent: #22a04f; --accent-deep: #1a8a41;
      --badge-bg: #12351f; --sender: #4fd1a5; --link: #6ea8ff;
      --code-bg: #3a2f14; --code-border: #6b5518; --code-text: #fbd46d; --code-hover: #4a3c1a;
      --del: #6b7480; --del-hover: #f87171; --tabx: #8a4a4a; --sw-off: #3a424a;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: var(--bg); color: var(--text); padding: 0 0 40px; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 18px; margin: 8px 0 12px; }
  .tabs { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 8px; margin-bottom: 8px; }
  .tab { flex: none; padding: 5px 12px; border: 1px solid var(--border); border-radius: 999px;
         background: var(--card); cursor: pointer; font-size: 13px; color: var(--text); white-space: nowrap; }
  .tab.active { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 8px; }
  .toolbar input[type=search] { flex: 1; padding: 8px 12px; border: 1px solid var(--border);
         border-radius: 8px; font-size: 14px; background: var(--card); color: var(--text); }
  .toolbar select { padding: 8px 8px; border: 1px solid var(--border); border-radius: 8px;
         font-size: 13px; background: var(--card); color: var(--text); }
  .opts { display: flex; gap: 22px; margin: 0 0 12px; font-size: 13px; color: var(--muted); }
  .opt { position: relative; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  .opt input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
  .opt .switch { position: relative; flex: none; width: 40px; height: 22px; border-radius: 999px;
                 background: var(--sw-off); border: 1px solid var(--border);
                 transition: background .2s ease, border-color .2s ease; }
  .opt .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
                        border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.28);
                        transition: transform .2s ease; }
  .opt input:checked + .switch { background: var(--accent); border-color: var(--accent); }
  .opt input:checked + .switch::after { transform: translateX(18px); }
  .opt input:focus-visible + .switch { outline: 2px solid var(--link); outline-offset: 2px; }
  .meta { display: flex; justify-content: space-between; align-items: center;
          color: var(--muted); font-size: 12px; margin-bottom: 8px; }
  .list { display: flex; flex-direction: column; gap: 8px; }
  .daysep { font-size: 12px; color: var(--faint); font-weight: 600; margin: 10px 4px 0; }
  .card { background: var(--card); border: 1px solid var(--card-border); border-radius: 10px; padding: 10px 12px;
          animation: slidein .25s ease-out; }
  @keyframes slidein { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .row1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-bottom: 6px; margin-bottom: 6px; border-bottom: 1px solid var(--row-border); }
  .sender { font-weight: 700; font-size: 16px; color: var(--sender); }
  .del { margin-left: auto; border: none; background: none; color: var(--del); cursor: pointer; font-size: 12px; padding: 2px 4px; }
  .del:hover { color: var(--del-hover); }
  .srctag { flex: none; font-size: 11px; font-weight: 700; color: var(--badge-bg); background: var(--accent);
            border-radius: 5px; padding: 1px 7px; }
  .code-line { margin: 6px 0 2px; color: var(--code-text); }
  .code-line b { font-size: 17px; letter-spacing: 1px; margin-right: 8px;
                 font-family: ui-monospace, Consolas, monospace; background: var(--code-bg);
                 padding: 0 6px; border-radius: 5px; }
  .copy { border: 1px solid var(--code-border); background: var(--code-bg); color: var(--code-text);
          border-radius: 6px; padding: 1px 10px; cursor: pointer; font-size: 12px; }
  .copy:hover { background: var(--code-hover); }
  .line { margin-top: 4px; }
  .content { word-break: break-word; white-space: pre-wrap; }
  .content a { color: var(--link); word-break: break-all; }
  .time-line { color: var(--faint); font-size: 12px; cursor: default; }
  .foot-line { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .recv { flex: none; font-weight: 600; font-size: 12px; color: var(--muted); cursor: pointer; user-select: none; }
  .recv:hover { color: var(--text); }
  .empty { text-align: center; color: var(--faint); padding: 40px 0; }
  .pager { display: flex; gap: 8px; justify-content: center; align-items: center; margin-top: 16px; }
  .pager button { padding: 6px 14px; border: 1px solid var(--border); border-radius: 8px;
                  background: var(--card); color: var(--text); cursor: pointer; font-size: 13px; }
  .pager button:disabled { opacity: .4; cursor: default; }
  .tabx { margin-left: 2px; color: var(--tabx); font-weight: 700; padding: 0 2px; }
  .tabx:hover { color: var(--del-hover); }
  .tabop { margin-left: 2px; color: var(--faint); font-weight: 700; padding: 0 2px; font-size: 12px; }
  .tabop:hover { color: var(--accent); }
  .toast { position: fixed; left: 50%; bottom: 48px; transform: translate(-50%, 12px);
           background: #111827; color: #fff; padding: 9px 18px; border-radius: 999px;
           font-size: 13px; opacity: 0; pointer-events: none; transition: all .25s ease; z-index: 99; }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
  .foot { text-align: center; font-size: 12px; margin-top: 28px; color: var(--faint); }
  .foot a { color: var(--faint); }
  .gh { position: fixed; top: 14px; right: 14px; color: var(--faint); opacity: .75;
        transition: opacity .2s, color .2s; z-index: 50; }
  .gh:hover { opacity: 1; color: var(--text); }
  @media (prefers-color-scheme: dark) {
    .toast { background: #e6e9ec; color: #14171a; }
  }
</style>
</head>
<body>
<a class="gh" href="https://github.com/ShenDoyle/SMSToWeb" target="_blank" rel="noopener noreferrer" title="GitHub 仓库" aria-label="GitHub 仓库">
  <svg viewBox="0 0 16 16" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
</a>
<div class="wrap">
  <h1>__SITE_NAME__</h1>
  <div class="tabs" id="tabs"></div>
  <div class="toolbar">
    <input type="search" id="q" placeholder="搜索发件人或内容…">
    <select id="src" title="按来源筛选">
      <option value="">全部来源</option>
      <option value="sms">短信</option>
      <option value="notify">通知</option>
    </select>
  </div>
  <div class="opts">
    <label class="opt"><input type="checkbox" id="autocopy"><span class="switch"></span><span>自动复制验证码</span></label>
    <label class="opt"><input type="checkbox" id="notifyon"><span class="switch"></span><span>后台通知</span></label>
  </div>
  <div class="meta"><span id="stat"></span><span id="pageinfo"></span></div>
  <div class="list" id="list"><div class="empty">加载中…</div></div>
  <div class="pager">
    <button id="prev">上一页</button>
    <span id="pagenum"></span>
    <button id="next">下一页</button>
  </div>
</div>
<footer class="foot">© 2026 <a href="https://cbm.im/" target="_blank" rel="noopener noreferrer">左立方</a> · <a href="https://github.com/ShenDoyle/SMSToWeb" target="_blank" rel="noopener noreferrer">SMSToWeb</a></footer>
<script>
(function () {
  var SITE_NAME = __SITE_NAME_JSON__;
  /* 图标回退：SITE_ICON 设置了但加载失败时，自动换回默认图标 */
  (function () {
    var l = document.querySelector('link[rel="icon"]'); if (!l) return;
    var def = __DEFAULT_ICON_JSON__;
    if (!def || l.getAttribute("href") === def) return;
    var img = new Image();
    img.onerror = function () { l.href = def; };
    img.src = l.getAttribute("href");
  })();
  var state = {
    device: 0, src: "", q: "", page: 1, pages: 1, total: 0, lastId: 0, deb: null,
    inited: false, unread: 0,
    autoCopy: (function () { try { return localStorage.getItem("sms_autocopy") !== "0"; } catch (e) { return true; } })(),
    notify: (function () { try { return localStorage.getItem("sms_notify") !== "0"; } catch (e) { return true; } })()
  };
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function parseUTC(utc) {
    var d = new Date(String(utc).replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? null : d;
  }
  function partsOf(d) {
    var parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(d);
    var v = {};
    for (var i = 0; i < parts.length; i++) v[parts[i].type] = parts[i].value;
    var pad = function (s) { s = String(s); return s.length < 2 ? "0" + s : s; };
    v.pmonth = pad(v.month); v.pday = pad(v.day);
    v.phour = pad(v.hour); v.pminute = pad(v.minute); v.psecond = pad(v.second);
    return v;
  }
  function fmtTime(utc) {
    var d = parseUTC(utc);
    if (!d) return String(utc || "");
    var v = partsOf(d);
    return v.year + "年" + v.pmonth + "月" + v.pday + "日 " + v.phour + ":" + v.pminute + ":" + v.psecond;
  }
  /* 相对时间：刚刚 / N 分钟前 / N 小时前 / 更早显示短日期；悬停卡片可看完整时间 */
  function relTime(utc) {
    var d = parseUTC(utc);
    if (!d) return String(utc || "");
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    var v = partsOf(d), now = partsOf(new Date());
    var yr = v.year === now.year ? "" : v.year + "年";
    return yr + Number(v.pmonth) + "月" + Number(v.pday) + "日 " + v.phour + ":" + v.pminute;
  }
  /* 日期分组标签：今天 / 昨天 / M月D日（跨年带年份） */
  function dayLabel(utc) {
    var d = parseUTC(utc);
    if (!d) return "";
    var v = partsOf(d), now = partsOf(new Date());
    if (v.year === now.year && v.pmonth === now.pmonth) {
      var dd = Number(v.pday), nd = Number(now.pday);
      if (dd === nd) return "今天";
      if (nd - dd === 1) return "昨天";
    }
    var yr = v.year === now.year ? "" : v.year + "年";
    return yr + Number(v.pmonth) + "月" + Number(v.pday) + "日";
  }
  /* 验证码提取（级联策略，借鉴 SmsForwarder 关键词集 / otp-message-extractor 防误报 / expo-sms-listener 级联）：
     ① 关键词在前+分隔码(123-456/取件码) → ② 关键词在前+数字码 → ③ 码在前(123456是您的验证码)
     → ④ Google 风格(G-123456) → ⑤ 字母数字混合码 → ⑥ 全文唯一数字组兜底。
     匹配前剥离手机号/日期/时间/金额/单号等干扰数字；仅当短信含验证码类关键词才提取。 */
  function extractCode(text) {
    var s = String(text || "").replace(/\s+/g, " ");
    var kw = "验证码|校验码|检验码|确认码|激活码|动态码|动态密码|动态口令|授权码|安全码|随机码|认证码|取件码|提货码|登录码|驗證碼|校驗碼|認證碼|verification code|security code|confirmation code|access code|auth code|login code|one[- ]time code|passcode|pass code|2fa|otp|code";
    if (!new RegExp("(?:" + kw + ")", "i").test(s)) return "";
    /* 剥离干扰数字：手机号 / 日期 / 时间 / 金额 / 各类编号，防止误报 */
    var t = s
      .replace(/1[3-9][0-9]{9}/g, " ")
      .replace(/[0-9]{4}[-/年.][0-9]{1,2}[-/月.][0-9]{1,2}日?/g, " ")
      .replace(/[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?/g, " ")
      .replace(/(?:[¥￥$]|EUR|USD)\s*[0-9]+(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?\s*(?:元|块钱|人民币)/g, " ")
      .replace(/(?:订单|工单|账单|流水号|交易号|单号|卡号|尾号|工号|房号|编号|合同号|批次号|快递单号)[:：号\s]*[0-9]+/g, " ");
    /* 捕获组左右两侧不得紧贴数字（避免从长数字串内部截取） */
    function hit(re) {
      var r = re.exec(t);
      if (!r) return null;
      var a = r.index + r[0].length - r[1].length;
      var b = a + r[1].length;
      if (a > 0 && /[0-9]/.test(t.charAt(a - 1))) return null;
      if (b < t.length && /[0-9]/.test(t.charAt(b))) return null;
      return r[1];
    }
    var m;
    /* ① 关键词在前 + 分隔式数字：123-456 / 1234 5678 / 8-2-307 取件码风格（先于纯数字，防被截断） */
    m = hit(new RegExp("(?:" + kw + ")[^0-9]{0,12}([0-9]{1,4}(?:[- ][0-9]{1,4}){1,2})", "i"));
    if (m) return m.replace(/[- ]/g, "");
    /* ② 关键词在前 + 纯数字 4-8 位 */
    m = hit(new RegExp("(?:" + kw + ")[^0-9]{0,12}([0-9]{4,8})", "i"));
    if (m) return m;
    /* ③ 码在前：123456是您的验证码 / 123456 为动态口令（限 8 字内衔接，防跨句误报） */
    m = hit(new RegExp("([0-9]{4,8})[^0-9]{0,8}(?:您的|你的)?(?:" + kw + ")", "i"));
    if (m) return m;
    /* ④ Google 风格：G-383838 是您的 Google 验证码 */
    m = hit(new RegExp("([A-Za-z]{1,3}-[0-9]{4,8})", "i"));
    if (m) return m.split("-")[1];
    /* ⑤ 字母数字混合 4-8 位（须同时含字母与数字；右侧不得紧贴字母数字） */
    m = new RegExp("(?:" + kw + ")[^0-9A-Za-z]{0,4}([0-9A-Za-z]{4,8})", "i").exec(t);
    if (m) {
      var b5 = m.index + m[0].length;
      if (b5 >= t.length || !/[0-9A-Za-z]/.test(t.charAt(b5))) {
        if (/[0-9]/.test(m[1]) && /[A-Za-z]/.test(m[1])) return m[1];
      }
    }
    /* ⑥ 兜底：剥离后全文恰好只有一组独立 4-8 位数字时才取（唯一性保证不误报） */
    var re6 = /[0-9]{4,8}/g;
    var lone = null, cnt = 0, r6;
    while ((r6 = re6.exec(t))) {
      var a6 = r6.index, b6 = a6 + r6[0].length;
      if (a6 > 0 && /[0-9]/.test(t.charAt(a6 - 1))) continue;
      if (b6 < t.length && /[0-9]/.test(t.charAt(b6))) continue;
      cnt++; lone = r6[0];
    }
    return cnt === 1 ? lone : "";
  }
  /* 内容链接化：注意入参必须已经过 esc() 转义 */
  function linkify(escaped) {
    return String(escaped || "").replace(/https?:\/\/[^\s<>"'，。；！？、）【】]+/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>';
    });
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }
  function doCopy(text, btn) {
    var done = function () {
      var old = btn.textContent;
      btn.textContent = "已复制";
      btn.disabled = true;
      setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  /* 轻提示（底部浮现，2.6 秒后消失） */
  function toast(msg) {
    var t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add("show"); }, 10);
    setTimeout(function () {
      t.classList.remove("show");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 2600);
  }
  /* 新消息处理：验证码自动复制 + 标题未读数 + 后台系统通知 */
  function notifyNew(fresh) {
    var latest = fresh[0];
    var code = extractCode(latest.content);
    if (code && state.autoCopy) {
      var fin = function () { toast("验证码 " + code + " 已复制"); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(fin, function () { fallbackCopy(code); fin(); });
      } else { fallbackCopy(code); fin(); }
    }
    if (document.hidden) {
      state.unread += fresh.length;
      document.title = "(" + state.unread + ") " + SITE_NAME;
      if (state.notify && window.Notification && Notification.permission === "granted") {
        var body = (code ? "验证码 " + code + "  " : "") + String(latest.content || "");
        try {
          new Notification(String(latest.sender || "新短信"), { body: body.slice(0, 140), tag: "sms-" + latest.id });
        } catch (e) {}
      }
    }
  }
  function qs() {
    var p = new URLSearchParams();
    if (state.device) p.set("device_id", state.device);
    if (state.src) p.set("source", state.src);
    if (state.q) p.set("q", state.q);
    p.set("page", state.page);
    return p.toString();
  }
  function loadDevices() {
    return fetch("/api/devices").then(function (r) { return r.json(); }).then(function (res) {
      var tabs = $("tabs");
      tabs.innerHTML = "";
      var mk = function (label, id, extra) {
        var el = document.createElement("div");
        el.className = "tab" + (state.device === id ? " active" : "");
        el.textContent = label + (extra ? " " + extra : "");
        el.onclick = function () { state.device = id; state.page = 1; renderTabs(res.list || []); load(); };
        return el;
      };
      tabs.appendChild(mk("全部", 0, "(" + (res.list || []).reduce(function (s, d) { return s + d.msg_count; }, 0) + ")"));
      (res.list || []).forEach(function (d) {
        var el = mk(d.display_name, d.id, "(" + d.msg_count + ")");
        /* 设备标签操作：✎ 重命名（设别名）、⇄ 合并到其他设备（后端 /api/devices/alias、/api/devices/merge） */
        if (d.id) {
          var ed = document.createElement("span");
          ed.className = "tabop"; ed.textContent = "✎"; ed.title = "重命名设备";
          ed.onclick = function (ev) {
            ev.stopPropagation();
            var nm = prompt("重命名设备「" + d.display_name + "」\n留空则恢复默认名", d.alias || d.display_name);
            if (nm === null) return;
            fetch("/api/devices/alias", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: d.id, alias: String(nm).trim() }) })
              .then(function (r) { return r.json(); })
              .then(function (res2) { if (!res2.success) { alert(res2.error || "重命名失败"); return; } refreshAll(); });
          };
          el.appendChild(ed);
          var mg = document.createElement("span");
          mg.className = "tabop"; mg.textContent = "⇄"; mg.title = "合并到其他设备";
          mg.onclick = function (ev) {
            ev.stopPropagation();
            var others = (res.list || []).filter(function (x) { return x.id && x.id !== d.id; });
            if (!others.length) { alert("没有可合并的其他设备"); return; }
            var lines = others.map(function (x, i) { return (i + 1) + ". " + x.display_name + "（" + x.msg_count + " 条）"; });
            var pick = prompt("把「" + d.display_name + "」的全部消息合并到哪台设备？\n" + lines.join("\n") + "\n输入序号：");
            if (pick === null) return;
            var idx = parseInt(pick, 10);
            if (!(idx >= 1 && idx <= others.length)) { alert("序号无效"); return; }
            var target = others[idx - 1];
            if (!confirm("确认把「" + d.display_name + "」的全部消息合并到「" + target.display_name + "」？\n合并后本标签将被删除。")) return;
            fetch("/api/devices/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: d.id, to: target.id }) })
              .then(function (r) { return r.json(); })
              .then(function (res2) {
                if (!res2.success) { alert(res2.error === "device not found" ? "目标设备不存在" : (res2.error || "合并失败")); return; }
                if (state.device === d.id) { state.device = target.id; }
                refreshAll();
              });
          };
          el.appendChild(mg);
        }
        /* 无短信的设备标签显示 × 可手动删除；有短信时后端拒绝删除 */
        if (!d.msg_count && d.id) {
          var x = document.createElement("span");
          x.className = "tabx";
          x.textContent = "×";
          x.title = "删除该设备标签";
          x.onclick = function (ev) {
            ev.stopPropagation();
            if (!confirm("删除该设备标签？（须先清空其全部短信）")) return;
            fetch("/api/devices/" + d.id, { method: "DELETE" })
              .then(function (r) { return r.json(); })
              .then(function (res2) {
                if (!res2.success) {
                  alert(res2.error === "has messages" ? "该设备仍有短信，请先删除全部短信" : (res2.error || "删除失败"));
                  return;
                }
                if (state.device === d.id) { state.device = 0; state.page = 1; }
                refreshAll();
              });
          };
          el.appendChild(x);
        }
        tabs.appendChild(el);
      });
    });
  }
  function renderTabs(list) { loadDevices(); }
  function load() {
    return fetch("/api/messages?" + qs())
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.success) throw new Error(res.error || "load failed");
        state.total = res.total; state.pages = res.pages;
        var list = res.list || [];
        /* 新消息识别：首次加载建立基线；之后把比 lastId 新的交给 notifyNew（自动复制/通知/未读数） */
        if (!state.inited) {
          state.inited = true;
          if (list.length) state.lastId = list[0].id;
        } else {
          var fresh = list.filter(function (m) { return m.id > state.lastId; });
          if (fresh.length) { state.lastId = fresh[0].id; notifyNew(fresh); }
        }
        $("stat").textContent = "共 " + res.total + " 条";
        $("pageinfo").textContent = res.pages > 1 ? "第 " + res.page + " / " + res.pages + " 页" : "";
        $("pagenum").textContent = res.pages > 1 ? res.page + " / " + res.pages : "";
        $("prev").disabled = res.page <= 1;
        $("next").disabled = res.page >= res.pages;
        if (!list.length) { $("list").innerHTML = '<div class="empty">暂无短信</div>'; return; }
        /* 按日期分组渲染：今天 / 昨天 / M月D日 分隔行；来源徽章区分短信与通知 */
        var html = "", lastDay = "";
        list.forEach(function (m) {
          var day = dayLabel(m.received_at);
          if (day !== lastDay) { html += '<div class="daysep">' + esc(day) + '</div>'; lastDay = day; }
          var code = extractCode(m.content);
          var isSms = (m.source || "sms") === "sms";
          var recv = m.sim_number || m.sim || "";
          html += '<div class="card">' +
            '<div class="row1">' +
              (isSms
                ? '<span class="sender">' + esc(m.sender || "未知号码") + '</span>'
                : '<span class="srctag">' + esc(m.source || "通知") + '</span><span class="sender">' + esc(m.sender || m.device_name || "通知") + '</span>') +
              '<button class="del" data-id="' + m.id + '">删除</button>' +
            '</div>' +
            (code ? '<div class="code-line">验证码：<b>' + esc(code) + '</b><button class="copy" data-code="' + esc(code) + '">复制</button></div>' : '') +
            '<div class="line"><span class="content">' + linkify(esc(m.content)) + '</span></div>' +
            '<div class="line foot-line"><span class="time-line" title="' + esc(fmtTime(m.received_at)) + '">' + esc(relTime(m.received_at)) + '</span>' +
              (isSms && recv ? '<span class="recv" title="双击复制收件号">' + esc(recv) + '</span>' : '') +
            '</div>' +
          '</div>';
        });
        $("list").innerHTML = html;
      })
      .catch(function (e) { $("list").innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; });
  }
  /* 来源下拉：从 /api/sources 动态聚合所有来源（含自定义 cron/alert 等），替代原先写死的三项 */
  function srcLabel(s) {
    if (s === "sms") return "短信";
    if (s === "notify") return "通知";
    return s;
  }
  function loadSources() {
    return fetch("/api/sources").then(function (r) { return r.json(); }).then(function (res) {
      var sel = $("src"), cur = state.src || "", list = (res && res.list) || [], seen = {};
      var html = '<option value="">全部来源</option>';
      list.forEach(function (it) {
        seen[it.source] = true;
        html += '<option value="' + esc(it.source) + '">' + esc(srcLabel(it.source)) + " (" + it.count + ")</option>";
      });
      if (cur && !seen[cur]) html += '<option value="' + esc(cur) + '">' + esc(srcLabel(cur)) + "</option>";
      sel.innerHTML = html;
      sel.value = cur;
    }).catch(function () {});
  }
  function refreshAll() { return Promise.all([loadSources(), loadDevices()]).then(load); }
  $("q").addEventListener("input", function () {
    clearTimeout(state.deb);
    state.deb = setTimeout(function () { state.q = $("q").value.trim(); state.page = 1; load(); }, 300);
  });
  $("prev").onclick = function () { if (state.page > 1) { state.page--; load(); } };
  $("next").onclick = function () { if (state.page < state.pages) { state.page++; load(); } };
  $("src").onchange = function () { state.src = $("src").value; state.page = 1; load(); };
  /* 推送式自动刷新：长轮询 /api/wait，有新消息立即加载；搜索模式下退化为 5s 轮询 */
  function pollLoop() {
    if (state.q) {
      setTimeout(function () { load().then(pollLoop); }, 5000);
      return;
    }
    var p = "last_id=" + (state.lastId || 0);
    if (state.device) p += "&device_id=" + state.device;
    fetch("/api/wait?" + p)
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.changed) load(); })
      .catch(function () {})
      .finally(pollLoop);
  }
  pollLoop();
  /* 开关初始化与记忆（localStorage） */
  var acb = $("autocopy"), nb = $("notifyon");
  acb.checked = state.autoCopy;
  nb.checked = state.notify;
  acb.onchange = function () {
    state.autoCopy = acb.checked;
    try { localStorage.setItem("sms_autocopy", state.autoCopy ? "1" : "0"); } catch (e) {}
    toast(state.autoCopy ? "已开启验证码自动复制" : "已关闭验证码自动复制");
  };
  nb.onchange = function () {
    state.notify = nb.checked;
    try { localStorage.setItem("sms_notify", state.notify ? "1" : "0"); } catch (e) {}
    if (state.notify && window.Notification && Notification.permission === "default") {
      Notification.requestPermission();
    }
    toast(state.notify ? "已开启后台通知" : "已关闭后台通知");
  };
  /* 回到页面即清零未读数、恢复标题 */
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { state.unread = 0; document.title = SITE_NAME; }
  });
  $("list").addEventListener("click", function (ev) {
    var copyBtn = ev.target.closest ? ev.target.closest(".copy") : null;
    if (copyBtn) { doCopy(copyBtn.getAttribute("data-code"), copyBtn); return; }
    var btn = ev.target.closest ? ev.target.closest(".del") : null;
    if (!btn) return;
    var id = btn.getAttribute("data-id");
    if (!confirm("确认删除这条短信？")) return;
    fetch("/api/messages/" + id, { method: "DELETE" }).then(load);
  });
  /* 双击收件号直接复制 */
  $("list").addEventListener("dblclick", function (ev) {
    var el = ev.target.closest ? ev.target.closest(".recv") : null;
    if (!el) return;
    var text = el.textContent;
    var fin = function () { toast("收件号已复制"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(fin, function () { fallbackCopy(text); fin(); });
    } else { fallbackCopy(text); fin(); }
  });
  refreshAll();
})();
</script>
</body>
</html>`;

/* 登录页（仅 ENABLE_AUTH="true" 时对未登录访问下发） */
const LOGIN_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="__SITE_ICON__">
<title>__SITE_NAME__ - 登录</title>
<style>
  :root { --bg: #f5f6f7; --card: #fff; --text: #20242a; --border: #e3e6e9; --input-border: #d8dce0; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14171a; --card: #1d2126; --text: #e6e9ec; --border: #2a3036; --input-border: #33393f; }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: var(--bg); color: var(--text); display: flex; align-items: center;
         justify-content: center; min-height: 100vh; }
  .box { background: var(--card); border: 1px solid var(--border); border-radius: 12px;
         padding: 28px 24px; width: 300px; text-align: center; }
  h1 { font-size: 17px; margin-bottom: 16px; }
  input { width: 100%; padding: 9px 12px; border: 1px solid var(--input-border); border-radius: 8px;
          font-size: 14px; margin-bottom: 10px; background: var(--card); color: var(--text); }
  button { width: 100%; padding: 9px 0; border: none; border-radius: 8px; background: #15803d;
           color: #fff; font-size: 14px; cursor: pointer; }
  button:hover { background: #116632; }
  .err { color: #b91c1c; font-size: 12px; min-height: 18px; margin-top: 8px; }
  .foot { color: var(--faint); font-size: 12px; margin-top: 14px; }
  .foot a { color: var(--faint); }
</style>
</head>
<body>
<div class="box">
  <h1>__SITE_NAME__</h1>
  <input type="password" id="pw" placeholder="管理密码" autofocus>
  <button id="go">登 录</button>
  <div class="err" id="err"></div>
  <div class="foot">© 2026 <a href="https://cbm.im/" target="_blank" rel="noopener noreferrer">左立方</a> · <a href="https://github.com/ShenDoyle/SMSToWeb" target="_blank" rel="noopener noreferrer">SMSToWeb</a></div>
</div>
<script>
(function () {
  /* 图标回退：SITE_ICON 设置了但加载失败时，自动换回默认图标 */
  (function () {
    var l = document.querySelector('link[rel="icon"]'); if (!l) return;
    var def = __DEFAULT_ICON_JSON__;
    if (!def || l.getAttribute("href") === def) return;
    var img = new Image();
    img.onerror = function () { l.href = def; };
    img.src = l.getAttribute("href");
  })();
  var pw = document.getElementById("pw");
  var err = document.getElementById("err");
  function tryLogin() {
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw.value })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.success) { location.reload(); return; }
      err.textContent = d && d.error === "wrong password" ? "密码错误"
        : d && d.error === "too many attempts" ? "尝试次数过多，请 10 分钟后再试"
        : "登录失败";
    }).catch(function () { err.textContent = "网络错误"; });
  }
  document.getElementById("go").onclick = tryLogin;
  pw.addEventListener("keydown", function (e) { if (e.key === "Enter") tryLogin(); });
})();
</script>
</body>
</html>`;

/* ---------------- 定时清理：保留天数由变量 RETENTION_DAYS 控制（默认 30） ---------------- */

async function handleCron(env) {
  const days = Math.max(1, parseInt(env.RETENTION_DAYS, 10) || DEFAULT_RETENTION_DAYS);
  const res = await env.DB.prepare(
    `DELETE FROM messages WHERE received_at < datetime('now', ?1)`
  ).bind(`-${days} days`).run();
  console.log(`[cron] cleaned ${res.meta ? res.meta.changes : 0} messages older than ${days} days`);
}

/* ---------------- 路由 ---------------- */

/* ---------------- 通用入口导出（本段由 platforms/gen_app.py 生成，勿手工修改） ----------------
 * 以上业务代码与 src/worker.js 逐字节一致；仅将 Worker 专属的 export default 替换为：
 *   fetchApp(request, env[, ctx])   — 请求处理主入口（ctx 可省略；省略时后台任务经 bgRun 内联执行）
 *   runCron(env)                    — 定时清理入口，供各平台原生 cron 调用
 *   handleCronRequest(request, env) — cron 的 HTTP 触发入口（GET /api/cron，token 鉴权）
 */

export async function fetchApp(request, env, ctx) {
  /* ctx 由调用方传入：Cloudflare 传真实 ctx（waitUntil 后台续跑）；其他平台不传（undefined），
     业务代码经 bgRun() 退化为内联 await，确保后台通知不被平台截断 */

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      /* 登录开关：开启后，除推送接口与登录/登出外，页面与管理 API 均需登录 */
      const isPage = path === "/" || path === "/index.html";
      const isPublicApi = path === "/api/receive" || path === "/api/push" || path === "/api/login" || path === "/api/logout";
      if (!isPublicApi && !(await isAuthed(request, env))) {
        if (isPage && request.method === "GET") {
          return new Response(renderHtml(LOGIN_HTML, env), {
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          });
        }
        return json({ success: false, error: "unauthorized" }, 401);
      }

      if (path === "/api/receive" && (request.method === "POST" || request.method === "GET")) {
        return await handleReceive(request, env, url, ctx);
      }
      if (path === "/api/push" && request.method === "POST") {
        return await handlePush(request, env, url, ctx);
      }
      if (path === "/api/login" && request.method === "POST") {
        return await handleLogin(request, env);
      }
      if (path === "/api/logout" && request.method === "POST") {
        return handleLogout(request);
      }
      if (path === "/api/messages" && request.method === "GET") {
        return await handleListMessages(url, env);
      }
      const msgMatch = path.match(/^\/api\/messages\/(\d+)$/);
      if (msgMatch && request.method === "DELETE") {
        return await handleDeleteMessage(msgMatch[1], env);
      }
      if (path === "/api/devices" && request.method === "GET") {
        return await handleListDevices(env);
      }
      const devMatch = path.match(/^\/api\/devices\/(\d+)$/);
      if (devMatch && request.method === "DELETE") {
        return await handleDeleteDevice(devMatch[1], env);
      }
      if (path === "/api/wait" && request.method === "GET") {
        return await handleWait(url, env);
      }
      if (path === "/api/devices/alias" && request.method === "POST") {
        return await handleSetAlias(request, env);
      }
      if (path === "/api/devices/merge" && request.method === "POST") {
        return await handleMergeDevices(request, env);
      }
      if (path === "/api/sources" && request.method === "GET") {
        return await handleListSources(env);
      }
      if ((path === "/" || path === "/index.html") && request.method === "GET") {
        return new Response(renderHtml(PAGE_HTML, env), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      return json({ success: false, error: "not found" }, 404);
    } catch (err) {
      console.error("worker error:", err && err.message);
      return json({ success: false, error: "internal error" }, 500);
    }
}

/* ---------------- 定时清理：供各平台 cron 定时器调用 ---------------- */

export async function runCron(env) {
  await handleCron(env);
}

/* ---------------- cron HTTP 触发入口：GET /api/cron ----------------
 * 鉴权：?token=<RECEIVE_TOKEN> 或 Authorization: Bearer <RECEIVE_TOKEN>
 * （Vercel Cron 自动附带 Bearer 头，需把环境变量 CRON_SECRET 设为与 RECEIVE_TOKEN 相同值）
 */

export async function handleCronRequest(request, env) {
  const url = new URL(request.url);
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const provided = url.searchParams.get("token") || bearer;
  if (!env.RECEIVE_TOKEN || !provided || !safeEqual(provided, env.RECEIVE_TOKEN)) {
    return json({ success: false, error: "unauthorized" }, 403);
  }
  await runCron(env);
  return json({ success: true });
}
