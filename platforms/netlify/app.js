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

/* 安全响应头：nosniff 防 MIME  sniff；X-Frame-Options 防管理页被 iframe 嵌套（点击劫持）；
   Referrer-Policy 不外泄域名路径。合入全部响应（json() 与各 new Response 站点） */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
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
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...CORS },
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

/* 客户端 IP：优先 CF-Connecting-IP（Cloudflare 可信头）；
   否则取 X-Forwarded-For 的**最右一段**——平台边缘把真实对端 IP 追加在末尾，
   左段是客户端自带值、可任意伪造（轮换伪造值可绕过登录锁定与写入限速），不可信 */
function clientIp(request) {
  const cf = (request.headers.get("CF-Connecting-IP") || "").trim();
  if (cf) return cf;
  const parts = (request.headers.get("X-Forwarded-For") || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  if (parts.length) return parts[parts.length - 1];
  return "unknown";
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
      ...SECURITY_HEADERS, ...CORS,
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
      ...SECURITY_HEADERS, ...CORS,
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
/* 通用超时信号：优先 AbortSignal.timeout（Node 17.3+ / V8 10.2+），
   老运行时（部分边缘函数、旧 Node）退化为 AbortController + setTimeout，
   两者都不可用时返回 undefined（退化为无超时，行为等同旧版，不会抛错） */
function timeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      return AbortSignal.timeout(ms);
    }
  } catch (e) { /* 某些运行时存在该方法但他处实现异常，继续走兜底 */ }
  try {
    if (typeof AbortController === "function") {
      const ac = new AbortController();
      const timer = setTimeout(function () { try { ac.abort(); } catch (e) {} }, ms);
      /* Node 下避免定时器把进程吊住（unref 存在时） */
      if (timer && typeof timer.unref === "function") timer.unref();
      return ac.signal;
    }
  } catch (e) {}
  return undefined;
}

async function postNotify(url, headers, body) {
  const opts = {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    body: body,
  };
  /* 单渠道 10s 超时：避免慢/挂起的第三方把内联 await 的响应拖死（无 waitUntil 的平台） */
  const sig = timeoutSignal(10000);
  if (sig) opts.signal = sig;
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
  const range = (url.searchParams.get("range") || "").trim();
  const rangeDays = { "1d": 1, "7d": 7, "30d": 30 }[range] || 0;
  const starredOnly = url.searchParams.get("starred") === "1";
  const unreadOnly = url.searchParams.get("unread") === "1";

  const where = ["m.deleted_at IS NULL"];
  const params = [];
  if (Number.isInteger(deviceId) && deviceId > 0) {
    where.push("m.device_id = ?");
    params.push(deviceId);
  }
  if (source) {
    where.push("m.source = ?");
    params.push(source);
  }
  if (rangeDays) {
    where.push("m.received_at >= ?");
    params.push(new Date(Date.now() - rangeDays * 86400000).toISOString().replace("T", " ").slice(0, 19));
  }
  if (q) {
    where.push("(m.content LIKE ? OR m.sender LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (starredOnly) where.push("m.starred = 1");
  if (unreadOnly) where.push("m.read_at IS NULL");
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages m ${whereSql}`
  ).bind(...params).first();
  const total = totalRow ? totalRow.n : 0;

  const list = await env.DB.prepare(
    `SELECT m.id, m.sender, m.content, m.received_at, m.device_id, m.source,
            m.starred, m.read_at,
            COALESCE(NULLIF(d.alias, ''), d.device) AS device_name, d.sim, d.device
     FROM messages m JOIN devices d ON d.id = m.device_id
     ${whereSql}
     ORDER BY m.starred DESC, m.received_at DESC, m.id DESC
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

/* ---------------- 导出（CSV / JSON） ----------------
 * 按当前筛选条件（device_id / source / range / q）导出全部匹配消息，供备份与离线分析。
 * 最多 EXPORT_MAX 条；CSV 带 BOM 便于 Excel 识别 UTF-8，并做公式注入防护。 */
const EXPORT_MAX = 20000;

function csvCell(v) {
  let s = String(v === null || v === undefined ? "" : v);
  /* CSV 公式注入防护：以 = + - @ 或制表/回车开头的单元格前置单引号 */
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/* UTC "YYYY-MM-DD HH:MM:SS" → 北京时间串 */
function bjTimeStr(utc) {
  const d = new Date(String(utc || "").replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return String(utc || "");
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

async function handleExport(url, env) {
  const deviceId = parseInt(url.searchParams.get("device_id") || "", 10);
  const q = (url.searchParams.get("q") || "").trim();
  const source = (url.searchParams.get("source") || "").trim();
  const range = (url.searchParams.get("range") || "").trim();
  const rangeDays = { "1d": 1, "7d": 7, "30d": 30 }[range] || 0;
  const format = (url.searchParams.get("format") || "csv").toLowerCase() === "json" ? "json" : "csv";

  const where = ["m.deleted_at IS NULL"];
  const params = [];
  if (Number.isInteger(deviceId) && deviceId > 0) { where.push("m.device_id = ?"); params.push(deviceId); }
  if (source) { where.push("m.source = ?"); params.push(source); }
  if (rangeDays) {
    where.push("m.received_at >= ?");
    params.push(new Date(Date.now() - rangeDays * 86400000).toISOString().replace("T", " ").slice(0, 19));
  }
  if (q) { where.push("(m.content LIKE ? OR m.sender LIKE ?)"); params.push("%" + q + "%", "%" + q + "%"); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  const rows = (await env.DB.prepare(
    `SELECT m.id, m.sender, m.content, m.received_at, m.source,
            COALESCE(NULLIF(d.alias, ''), d.device) AS device_name, d.sim
     FROM messages m JOIN devices d ON d.id = m.device_id
     ${whereSql}
     ORDER BY m.received_at DESC, m.id DESC
     LIMIT ${EXPORT_MAX}`
  ).bind(...params).all()).results || [];

  const stamp = nowUTC().slice(0, 10);
  if (format === "json") {
    const out = rows.map(function (r) {
      return { id: r.id, time: bjTimeStr(r.received_at), device: r.device_name, sim: r.sim || "", sender: r.sender, source: r.source, content: r.content };
    });
    return new Response(JSON.stringify(out, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="smstoweb-' + stamp + '.json"',
        "Cache-Control": "no-store", ...SECURITY_HEADERS, ...CORS,
      },
    });
  }
  const header = "id,time,device,sim,sender,source,content";
  const lines = rows.map(function (r) {
    return [r.id, bjTimeStr(r.received_at), r.device_name, r.sim || "", r.sender, r.source, r.content].map(csvCell).join(",");
  });
  const csv = "\uFEFF" + header + "\n" + lines.join("\n") + "\n";
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="smstoweb-' + stamp + '.csv"',
      "Cache-Control": "no-store", ...SECURITY_HEADERS, ...CORS,
    },
  });
}

/* 删除改为软删除（置 deleted_at），7 天内可通过 restore 撤销；cron 会清理超期软删记录 */
async function handleDeleteMessage(idParam, env) {
  const id = parseInt(idParam, 10);
  if (!Number.isInteger(id) || id <= 0) return json({ success: false, error: "invalid id" }, 400);
  const res = await env.DB.prepare("UPDATE messages SET deleted_at = datetime('now') WHERE id = ?1 AND deleted_at IS NULL").bind(id).run();
  return json({ success: true, deleted: res.meta ? res.meta.changes : 0 });
}

/* 批量软删除 / 恢复：ids 上限 500，IN 占位符均为 ?，无注入面 */
function parseIds(body) {
  if (!body || !Array.isArray(body.ids)) return [];
  const out = [];
  for (const v of body.ids) { const n = parseInt(v, 10); if (Number.isInteger(n) && n > 0) out.push(n); }
  return out.slice(0, 500);
}
async function handleRemoveMessages(request, env) {
  let body; try { body = await request.json(); } catch { return json({ success: false, error: "invalid json" }, 400); }
  const ids = parseIds(body);
  if (!ids.length) return json({ success: false, error: "no ids" }, 400);
  const ph = ids.map(function () { return "?"; }).join(",");
  const res = await env.DB.prepare("UPDATE messages SET deleted_at = datetime('now') WHERE id IN (" + ph + ") AND deleted_at IS NULL").bind(...ids).run();
  return json({ success: true, removed: res.meta ? res.meta.changes : 0, ids: ids });
}
async function handleRestoreMessages(request, env) {
  let body; try { body = await request.json(); } catch { return json({ success: false, error: "invalid json" }, 400); }
  const ids = parseIds(body);
  if (!ids.length) return json({ success: false, error: "no ids" }, 400);
  const ph = ids.map(function () { return "?"; }).join(",");
  const res = await env.DB.prepare("UPDATE messages SET deleted_at = NULL WHERE id IN (" + ph + ") AND deleted_at IS NOT NULL").bind(...ids).run();
  return json({ success: true, restored: res.meta ? res.meta.changes : 0 });
}
/* 清空当前筛选结果（软删除）；range 与列表一致用 UTC 截止时间戳 */
async function handleClearMessages(request, env) {
  let body; try { body = await request.json(); } catch { return json({ success: false, error: "invalid json" }, 400); }
  const deviceId = parseInt(body && body.device_id, 10);
  const source = String((body && body.source) || "").trim();
  const range = String((body && body.range) || "").trim();
  const q = String((body && body.q) || "").trim();
  const rangeDays = { "1d": 1, "7d": 7, "30d": 30 }[range] || 0;
  const where = ["deleted_at IS NULL"];
  const params = [];
  if (Number.isInteger(deviceId) && deviceId > 0) { where.push("device_id = ?"); params.push(deviceId); }
  if (source) { where.push("source = ?"); params.push(source); }
  if (rangeDays) { where.push("received_at >= ?"); params.push(new Date(Date.now() - rangeDays * 86400000).toISOString().replace("T", " ").slice(0, 19)); }
  if (q) { where.push("(content LIKE ? OR sender LIKE ?)"); params.push("%" + q + "%", "%" + q + "%"); }
  const res = await env.DB.prepare("UPDATE messages SET deleted_at = datetime('now') WHERE " + where.join(" AND ")).bind(...params).run();
  return json({ success: true, removed: res.meta ? res.meta.changes : 0 });
}

/* 收藏 / 已读（幂等，可取消） */
async function handleStarMessage(request, env) {
  let body; try { body = await request.json(); } catch { return json({ success: false, error: "invalid json" }, 400); }
  const id = parseInt(body && body.id, 10);
  if (!Number.isInteger(id) || id <= 0) return json({ success: false, error: "invalid id" }, 400);
  const starred = body && (body.starred === true || body.starred === 1 || body.starred === "1") ? 1 : 0;
  await env.DB.prepare("UPDATE messages SET starred = ?1 WHERE id = ?2").bind(starred, id).run();
  return json({ success: true, starred: starred });
}
async function handleReadMessage(request, env) {
  let body; try { body = await request.json(); } catch { return json({ success: false, error: "invalid json" }, 400); }
  const id = parseInt(body && body.id, 10);
  if (!Number.isInteger(id) || id <= 0) return json({ success: false, error: "invalid id" }, 400);
  const read = body && (body.read === true || body.read === 1 || body.read === "1");
  if (read) await env.DB.prepare("UPDATE messages SET read_at = datetime('now') WHERE id = ?1").bind(id).run();
  else await env.DB.prepare("UPDATE messages SET read_at = NULL WHERE id = ?1").bind(id).run();
  return json({ success: true, read: read });
}
/* 统计：总量 / 未读 / 收藏 / 来源分布 / 近 7 天（按北京日期） */
async function handleStats(env) {
  const base = "FROM messages WHERE deleted_at IS NULL";
  const tot = await env.DB.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread, " +
    "SUM(CASE WHEN starred = 1 THEN 1 ELSE 0 END) AS starred " + base
  ).first();
  const sources = await env.DB.prepare(
    "SELECT source, COUNT(*) AS n " + base + " GROUP BY source ORDER BY n DESC"
  ).all();
  const days = await env.DB.prepare(
    "SELECT date(datetime(received_at, '+8 hours')) AS d, COUNT(*) AS n " + base +
    " AND received_at >= datetime('now', '-7 days') GROUP BY d ORDER BY d"
  ).all();
  return json({
    success: true,
    total: (tot && tot.total) || 0,
    unread: (tot && tot.unread) || 0,
    starred: (tot && tot.starred) || 0,
    sources: sources.results || [],
    days: (days.results || []).map(function (r) { return { d: r.d, n: r.n }; }),
  });
}
/* PWA：manifest 与 service worker（公开路由，不受登录影响） */
function handleManifest(env) {
  const name = siteName(env);
  const icon = siteIcon(env);
  const m = {
    name: name, short_name: name,
    description: "SMS / notification gateway — browse messages from any device.",
    start_url: "/", scope: "/", display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any", lang: "zh-CN", dir: "ltr",
    background_color: "#f5f6f7", theme_color: "#15803d",
    categories: ["utilities", "productivity"],
    icons: [
      { src: icon, sizes: "192x192", type: "image/x-icon", purpose: "any" },
      { src: icon, sizes: "512x512", type: "image/x-icon", purpose: "any" }
    ]
  };
  return new Response(JSON.stringify(m), {
    headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-cache", ...SECURITY_HEADERS, ...CORS },
  });
}
/* Service Worker：静态壳缓存优先、接口永不缓存；离线时回落到缓存的管理页 */
function handleSW() {
  const js = "var C='smstoweb-shell-v2';" +
    "self.addEventListener('install',function(e){self.skipWaiting();});" +
    "self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});" +
    "self.addEventListener('fetch',function(e){" +
      "var r=e.request;if(r.method!=='GET')return;" +
      "var u=new URL(r.url);if(u.origin!==location.origin)return;" +
      "if(u.pathname.indexOf('/api/')===0)return;" +
      "e.respondWith(fetch(r).then(function(res){" +
        "if(res&&res.ok&&(u.pathname==='/'||u.pathname.indexOf('/index.html')===0)){" +
          "var cp=res.clone();caches.open(C).then(function(c){c.put(r,cp);});}" +
        "return res;" +
      "}).catch(function(){return caches.match(r).then(function(m){return m||caches.match('/');});}));" +
    "});";
  return new Response(js, {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache", ...SECURITY_HEADERS, ...CORS },
  });
}

async function handleListDevices(env) {
  const list = await env.DB.prepare(
    `SELECT d.id, d.device, d.sim, d.alias,
            COALESCE(NULLIF(d.alias, ''), d.device) AS display_name,
            COUNT(m.id) AS msg_count, MAX(m.received_at) AS last_at
     FROM devices d LEFT JOIN messages m ON m.device_id = d.id AND m.deleted_at IS NULL
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
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE device_id = ?1 AND deleted_at IS NULL").bind(id).first();
  if (cnt && cnt.n > 0) return json({ success: false, error: "has messages" }, 400);
  await env.DB.prepare("DELETE FROM messages WHERE device_id = ?1").bind(id).run();
  const res = await env.DB.prepare("DELETE FROM devices WHERE id = ?1").bind(id).run();
  return json({ success: true, deleted: res.meta ? res.meta.changes : 0 });
}

/* 来源清单：聚合 messages.source 及条数，供管理页动态生成「来源筛选」下拉（替代写死的三项） */
async function handleListSources(env) {
  const rows = await env.DB.prepare(
    "SELECT source, COUNT(*) AS n FROM messages WHERE deleted_at IS NULL GROUP BY source ORDER BY n DESC"
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
  const moved = await env.DB.prepare("UPDATE OR IGNORE messages SET device_id = ?1 WHERE device_id = ?2 AND deleted_at IS NULL").bind(to, from).run();
  await env.DB.prepare("DELETE FROM messages WHERE device_id = ?1").bind(from).run();
  await env.DB.prepare("DELETE FROM devices WHERE id = ?1").bind(from).run();
  return json({ success: true, moved: moved.meta ? moved.meta.changes : 0 });
}

/* ---------------- 号码归属地（免费、无 key） ----------------
 * 仅对 11 位手机号查询；默认走 360 公开接口（无 key），结果内存缓存 24h。
 * 外部接口失败静默降级（不显示归属地，不影响页面）。
 * 关闭方式：PHONE_AREA_ENABLED=false；自定义源：PHONE_AREA_API（URL 模板，用 {number} 占位）。 */
const AREA_CACHE = new Map();
const AREA_TTL = 24 * 3600 * 1000;
const AREA_DEFAULT_API = "https://cx.shouji.360.cn/phonearea.php?number={number}";

async function handlePhoneArea(url, env) {
  const num = String(url.searchParams.get("number") || "").replace(/\D/g, "");
  if (!/^1[3-9]\d{9}$/.test(num)) return json({ success: true, found: false });
  const flag = String(env.PHONE_AREA_ENABLED || "true").trim().toLowerCase();
  if (flag === "false" || flag === "0" || flag === "off") return json({ success: true, found: false, disabled: true });

  const cached = AREA_CACHE.get(num);
  if (cached && Date.now() - cached.t < AREA_TTL) return json(Object.assign({ success: true }, cached.v));

  let out = { found: false };
  try {
    const tpl = String(env.PHONE_AREA_API || "").trim() || AREA_DEFAULT_API;
    const target = tpl.indexOf("{number}") !== -1 ? tpl.replace("{number}", encodeURIComponent(num)) : tpl + encodeURIComponent(num);
    const opts = {};
    const sig = timeoutSignal(4000);
    if (sig) opts.signal = sig;
    const resp = await fetch(target, opts);
    if (resp.ok) {
      const d = await resp.json();
      const data = d && d.data;
      if (d && d.code === 0 && data) {
        const province = String(data.province || "").trim();
        const city = String(data.city || "").trim();
        const sp = String(data.sp || "").trim();
        if (province || sp) out = { found: true, province: province, city: city, sp: sp };
      }
    }
  } catch (e) {
    /* 外部接口异常：静默降级 */
  }
  if (out.found) {
    AREA_CACHE.set(num, { v: out, t: Date.now() });
    if (AREA_CACHE.size > 5000) {
      const now = Date.now();
      for (const [k, v] of AREA_CACHE) if (now - v.t > AREA_TTL) AREA_CACHE.delete(k);
    }
  }
  return json(Object.assign({ success: true }, out));
}

/* 长轮询：最多挂起 25s，期间每 2s 查一次是否有比 last_id 更新的消息；
   有则立即返回 changed=true（前端收到后刷新列表），实现推送式自动刷新 */
async function handleWait(url, env) {
  const lastId = parseInt(url.searchParams.get("last_id") || "0", 10) || 0;
  const deviceId = parseInt(url.searchParams.get("device_id") || "", 10);
  const filter = Number.isInteger(deviceId) && deviceId > 0;
  /* 挂起时长可配：Netlify Functions 默认 10s 超时、部分平台更短，
     部署在这些平台时把 WAIT_MAX_SECONDS 调到 8~10，避免请求被平台强杀导致前端反复重连 */
  const waitSec = Math.min(25, Math.max(3, parseInt(env.WAIT_MAX_SECONDS, 10) || 25));
  const deadline = Date.now() + waitSec * 1000;
  const tick = Math.min(2000, Math.max(500, waitSec * 1000 / 5));
  for (;;) {
    const sql = filter
      ? "SELECT MAX(id) AS n FROM messages WHERE device_id = ?1 AND deleted_at IS NULL"
      : "SELECT MAX(id) AS n FROM messages WHERE deleted_at IS NULL";
    const row = await (filter ? env.DB.prepare(sql).bind(deviceId) : env.DB.prepare(sql)).first();
    if (row && row.n > lastId) return json({ success: true, changed: true, id: row.n });
    if (Date.now() > deadline) return json({ success: true, changed: false });
    await new Promise(function (r) { setTimeout(r, Math.min(tick, Math.max(0, deadline - Date.now()))); });
  }
}

/* ---------------- Web 管理界面（登录开关 ENABLE_AUTH 控制） ---------------- */

/* String.raw：内嵌前端源码按原文下发，防止模板字面量把 \b \d \s \/ 当转义序列吃掉 */
const PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="format-detection" content="telephone=no,email=no,address=no">
<meta name="color-scheme" content="light dark">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="__SITE_NAME__">
<link rel="apple-touch-icon" href="__SITE_ICON__">
<link rel="icon" href="__SITE_ICON__">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#15803d" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#14171a" media="(prefers-color-scheme: dark)">
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
  .toolbar, .opts, .pager { flex-wrap: wrap; }
  .searchwrap { position: relative; flex: 1; display: flex; min-width: 140px; }
  .searchwrap input { width: 100%; }
  .clr { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); border: none; background: none;
         color: var(--faint); font-size: 16px; cursor: pointer; padding: 0 4px; line-height: 1; }
  .clr:hover { color: var(--text); }
  .tbtn { border: 1px solid var(--border); background: var(--card); color: var(--text); border-radius: 8px;
          padding: 5px 10px; font-size: 12px; cursor: pointer; }
  .tbtn:hover { border-color: var(--accent); color: var(--accent); }
  .spacer { flex: 1; }
  .content.fold { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .more { border: none; background: none; color: var(--link); cursor: pointer; font-size: 12px; padding: 2px 0; }
  .more:hover { text-decoration: underline; }
  .card.flash { animation: slidein .25s ease-out, flash 1.6s ease-out; }
  @keyframes flash { 0% { background: var(--accent-bg); } 100% { background: var(--card); } }
  .skc { height: 62px; border-radius: 10px; background: var(--row-border); margin-bottom: 8px; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
  .newpill { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); background: var(--accent);
             color: #fff; border: none; border-radius: 999px; padding: 8px 16px; font-size: 13px; font-weight: 600;
             cursor: pointer; z-index: 98; }
  .newpill:hover { background: var(--accent-deep); }
  .nlabel { flex: none; font-size: 11px; font-weight: 700; color: var(--accent); background: var(--badge-bg); border-radius: 5px; padding: 1px 6px; }
  .area { color: var(--faint); font-size: 12px; }
  .pager input, .pager select { padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; background: var(--card); color: var(--text); }
  #jump { width: 64px; }
  /* 主题三态（data-theme 覆盖系统偏好） */
  html[data-theme="dark"] {
    --bg: #14171a; --card: #1d2126; --text: #e6e9ec; --muted: #9aa3ab; --faint: #6b7480;
    --border: #33393f; --card-border: #2a3036; --row-border: #262c31;
    --accent: #22a04f; --accent-deep: #1a8a41;
    --badge-bg: #12351f; --sender: #4fd1a5; --link: #6ea8ff;
    --code-bg: #3a2f14; --code-border: #6b5518; --code-text: #fbd46d; --code-hover: #4a3c1a;
    --del: #6b7480; --del-hover: #f87171; --tabx: #8a4a4a; --sw-off: #3a424a;
  }
  html[data-theme="light"] {
    --bg: #f5f6f7; --card: #fff; --text: #20242a; --muted: #6b7280; --faint: #9aa3ab;
    --border: #d8dce0; --card-border: #e3e6e9; --row-border: #eef1f3;
    --accent: #15803d; --accent-deep: #116632;
    --badge-bg: #e7f4ec; --sender: #0f766e; --link: #2563eb;
    --code-bg: #fef3c7; --code-border: #fcd34d; --code-text: #92400e; --code-hover: #fde68a;
    --del: #9aa3ab; --del-hover: #b91c1c; --tabx: #e8b4b4; --sw-off: #c7ced4;
  }
  /* 头部 */
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 0 12px; }
  .head h1 { margin: 0; }
  /* 批量选择 */
  .card { position: relative; }
  .selwrap { display: none; }
  body.selecting .selwrap { display: block; position: absolute; top: 11px; left: 10px; }
  body.selecting .card { padding-left: 36px; }
  .selwrap input { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; }
  .selbar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
            background: var(--card); border: 1px solid var(--border); border-radius: 999px; padding: 8px 12px; z-index: 97; }
  .selbar span { font-size: 13px; color: var(--muted); }
  /* 来源徽章配色 */
  .srctag.s-notify { background: #2563eb; color: #fff; }
  .srctag.s-alert { background: #b45309; color: #fff; }
  .srctag.s-cron { background: #7c3aed; color: #fff; }
  .srctag.s-other { background: #475569; color: #fff; }
  /* Toast 堆叠 */
  .toastroot { position: fixed; left: 50%; bottom: 48px; transform: translateX(-50%); display: flex; flex-direction: column-reverse;
               gap: 8px; align-items: center; z-index: 99; pointer-events: none; }
  .toastroot .toast { position: static; transform: translateY(12px); opacity: 0; pointer-events: auto; }
  .toastroot .toast.show { opacity: 1; transform: none; }
  .undo-btn { margin-left: 8px; border: 1px solid currentColor; background: none; color: inherit; border-radius: 6px; padding: 2px 8px; font-size: 12px; cursor: pointer; }
  @media (prefers-reduced-motion: reduce) {
    .card, .card.flash, .toast, .tab, .switch, .switch::after { animation: none !important; transition: none !important; }
  }
  .headacts { display: flex; gap: 6px; flex: none; }
  .selbar[hidden] { display: none; }
  /* 弹层 */
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,.42); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 16px; }
  .modal[hidden] { display: none; }
  .sheet { position: relative; background: var(--card); color: var(--text); border-radius: 14px; width: 100%; max-width: 560px; max-height: 86vh; overflow: auto; padding: 18px 18px 22px; border: 1px solid var(--border); }
  .mx { position: absolute; top: 8px; right: 10px; border: none; background: none; color: var(--muted); font-size: 22px; line-height: 1; cursor: pointer; }
  .mx:hover { color: var(--text); }
  .sheet h3 { font-size: 16px; margin: 0 20px 10px 0; }
  .drow { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--row-border); font-size: 13px; }
  .drow span:first-child { color: var(--muted); flex: none; }
  .drow span:last-child { text-align: right; word-break: break-all; }
  .detail-content { margin-top: 10px; white-space: pre-wrap; word-break: break-word; line-height: 1.7; }
  .detail-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  /* 收藏 / 未读 */
  .star { border: none; background: none; color: var(--faint); cursor: pointer; font-size: 15px; padding: 0 2px; margin-left: 2px; }
  .star.on { color: #d97706; }
  .undot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); margin-left: 6px; vertical-align: middle; }
  .tbtn.on { border-color: var(--accent); color: var(--accent); background: var(--badge-bg); }
  mark { background: var(--code-bg); color: var(--code-text); border-radius: 3px; padding: 0 2px; }
  /* 统计 */
  .statgrid { display: flex; gap: 10px; margin: 6px 0 14px; }
  .statbox { flex: 1; background: var(--bg); border-radius: 10px; padding: 10px; text-align: center; }
  .statbox b { display: block; font-size: 20px; }
  .statbox span { font-size: 12px; color: var(--muted); }
  .barrow { display: flex; align-items: center; gap: 8px; font-size: 12px; margin: 4px 0; }
  .barrow .bl { width: 64px; color: var(--muted); flex: none; text-align: right; }
  .barrow .bt { flex: 1; background: var(--row-border); border-radius: 4px; height: 10px; overflow: hidden; }
  .barrow .bf { height: 100%; background: var(--accent); border-radius: 4px; }
  .barrow .bn { width: 34px; text-align: right; color: var(--muted); flex: none; }
  /* ---------- 移动端体验与浏览器兼容 ---------- */
  html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  body { padding-bottom: calc(40px + env(safe-area-inset-bottom, 0px));
         -webkit-tap-highlight-color: transparent; }
  .wrap { padding-left: max(16px, env(safe-area-inset-left, 0px));
          padding-right: max(16px, env(safe-area-inset-right, 0px)); }
  /* 触控：去掉移动端 300ms 点击延迟 */
  button, select, .tab, .opt, .tbtn, .clr, .mx, .star, .del, .tabop, .tabx, .newpill, .undo-btn { touch-action: manipulation; }
  /* iOS Safari 输入框字号 < 16px 会触发自动放大，统一 16px；桌面端仍用紧凑字号 */
  input[type=search], input[type=number], input[type=password], select, textarea { font-size: 16px; }
  .tabs { -webkit-overflow-scrolling: touch; scrollbar-width: thin; }
  .tabs::-webkit-scrollbar { height: 3px; }
  .sheet { -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
  .toastroot { padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px);
               bottom: calc(48px + env(safe-area-inset-bottom, 0px)); }
  .selbar { bottom: calc(16px + env(safe-area-inset-bottom, 0px)); }
  .newpill { bottom: calc(16px + env(safe-area-inset-bottom, 0px)); }
  @media (min-width: 561px) {
    input[type=search], input[type=number], select { font-size: 14px; }
  }
  @media (max-width: 560px) {
    .gh { top: 10px; right: 10px; opacity: .5; }
    .modal { align-items: flex-end; padding: 0; }
    .sheet { border-radius: 18px 18px 0 0; max-height: 88vh; max-height: 88dvh;
             padding-bottom: calc(22px + env(safe-area-inset-bottom, 0px)); }
    /* 窄屏放大可点区域，降低误触 */
    .tbtn, .pager button { padding: 8px 12px; font-size: 13px; min-height: 36px; }
    .tab { padding: 7px 13px; }
    .tabop, .tabx { padding: 2px 5px; }
    .star, .del { padding: 4px 6px; }
    .opts { gap: 14px; }
    .selbar { width: calc(100% - 24px); justify-content: space-between; border-radius: 14px; }
    .barrow .bl { width: 54px; }
  }
  /* 无精确指针（手机/平板）：开关加大到 44x26，便于拇指操作 */
  @media (hover: none) {
    .opt .switch { width: 44px; height: 26px; }
    .opt .switch::after { width: 20px; height: 20px; }
    .opt input:checked + .switch::after { transform: translateX(18px); }
  }
</style>
</head>
<body>
<a class="gh" href="https://github.com/ShenDoyle/SMSToWeb" target="_blank" rel="noopener noreferrer" data-i18n-title="ghRepo" title="GitHub 仓库" data-i18n-aria="ghRepo" aria-label="GitHub 仓库">
  <svg viewBox="0 0 16 16" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
</a>
<div class="wrap">
  <div class="head">
    <h1>__SITE_NAME__</h1>
    <span class="headacts">
      <button class="tbtn" id="statsbtn" data-i18n-title="stats" data-i18n="stats">统计</button>
      <button class="tbtn" id="setbtn" data-i18n-title="settings" data-i18n="settings">设置</button>
      <button class="tbtn" id="themebtn" data-i18n-title="themeTip">自动</button>
      <button class="tbtn" id="langbtn" data-i18n-title="langTip">EN</button>
    </span>
  </div>
  <div class="tabs" id="tabs" role="tablist" data-i18n-aria="devices" aria-label="设备标签"></div>
  <div class="toolbar">
    <div class="searchwrap">
      <input type="search" id="q" list="qhist" data-i18n-ph="searchPh" placeholder="搜索发件人或内容…" autocomplete="off">
      <button class="clr" id="clearq" hidden data-i18n-title="clearSearch" data-i18n-aria="clearSearch" title="清除搜索" aria-label="清除搜索">×</button>
    </div>
    <datalist id="qhist"></datalist>
    <select id="src" data-i18n-title="srcTip" title="按来源筛选">
      <option value="" data-i18n="allSources">全部来源</option>
      <option value="sms" data-i18n="srcSms">短信</option>
      <option value="notify" data-i18n="srcNotify">通知</option>
    </select>
    <select id="range" data-i18n-title="rangeTip" title="按时间筛选">
      <option value="" data-i18n="allTime">全部时间</option>
      <option value="1d" data-i18n="today">今天</option>
      <option value="7d" data-i18n="d7">近 7 天</option>
      <option value="30d" data-i18n="d30">近 30 天</option>
    </select>
  </div>
  <div class="opts">
    <label class="opt"><input type="checkbox" id="autocopy"><span class="switch"></span><span data-i18n="autoCopy">自动复制验证码</span></label>
    <label class="opt"><input type="checkbox" id="notifyon"><span class="switch"></span><span data-i18n="notifyOn">后台通知</span></label>
    <label class="opt"><input type="checkbox" id="soundon"><span class="switch"></span><span data-i18n="soundOn">提示音</span></label>
    <span class="spacer"></span>
    <button class="tbtn" id="staronly" data-i18n-title="starTip" data-i18n="starOnly" title="只看收藏">★ 收藏</button>
    <button class="tbtn" id="unreadonly" data-i18n-title="unreadTip" data-i18n="unreadOnly" title="只看未读">● 未读</button>
    <button class="tbtn" id="selectbtn" data-i18n-title="selectTip" data-i18n="select" title="进入批量选择">选择</button>
    <button class="tbtn" id="clearbtn" data-i18n-title="clearTip" data-i18n="clear" title="清空当前筛选结果（软删除）">清空</button>
    <button class="tbtn" id="exportcsv" data-i18n-title="exportCsvTip" data-i18n="exportCsv" title="按当前筛选导出 CSV">导出 CSV</button>
    <button class="tbtn" id="exportjson" data-i18n-title="exportJsonTip" data-i18n="exportJson" title="按当前筛选导出 JSON">导出 JSON</button>
  </div>
  <div class="meta"><span id="stat"></span><span id="pageinfo"></span></div>
  <div class="list" id="list"><div class="sk"><div class="skc"></div><div class="skc"></div><div class="skc"></div></div></div>
  <div class="pager">
    <button id="prev" data-i18n="prev">上一页</button>
    <span id="pagenum"></span>
    <button id="next" data-i18n="next">下一页</button>
    <select id="perpage" data-i18n-title="perPageTip" title="每页条数"></select>
    <input id="jump" type="number" min="1" inputmode="numeric" data-i18n-ph="jumpPh" data-i18n-title="jumpTip" placeholder="页码" title="输入页码后回车跳转">
    <button id="gojump" data-i18n="go">跳转</button>
  </div>
</div>
<button class="newpill" id="newpill" hidden></button>
<div class="selbar" id="selbar" hidden>
  <span id="selcount">已选 0 条</span>
  <button class="tbtn" id="selall" data-i18n="selAll">全选本页</button>
  <button class="tbtn" id="seldel" disabled data-i18n="del">删除</button>
  <button class="tbtn" id="selcancel" data-i18n="cancel">取消</button>
</div>
<div class="modal" id="modal" hidden>
  <div class="sheet">
    <button class="mx" id="modalx" type="button" data-i18n-aria="modalClose" aria-label="关闭">×</button>
    <div id="modalbody"></div>
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
    inited: false, unread: 0, limit: 20, range: "", notifiedId: 0,
    selectMode: false, selected: {}, lastQ: "", starOnly: false, unreadOnly: false, lastList: [],
    labels: (function () { try { return JSON.parse(localStorage.getItem("sms_labels") || "{}") || {}; } catch (e) { return {}; } })(),
    autoCopy: (function () { try { return localStorage.getItem("sms_autocopy") !== "0"; } catch (e) { return true; } })(),
    notify: (function () { try { return localStorage.getItem("sms_notify") !== "0"; } catch (e) { return true; } })(),
    sound: (function () { try { return localStorage.getItem("sms_sound") === "1"; } catch (e) { return false; } })()
  };
  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- 中英双语（i18n） ----------------
     语言优先级：?lang=zh|en > localStorage(sms_lang) > 浏览器语言(zh* → 中文, 其它 → 英文)
     静态节点标注：data-i18n(文本) / data-i18n-ph(placeholder) / data-i18n-title(title) / data-i18n-aria(aria-label)
     动态文案：T("key") 或 T("key", {n: 1})，占位符写作 {n}。
     切换语言后整页 reload：避免半渲染状态，且本地缓存过滤条件不受影响。 */
  var LANG = (function () {
    var v = "";
    try { v = String(new URLSearchParams(location.search).get("lang") || "").toLowerCase(); } catch (e) {}
    if (v !== "zh" && v !== "en") { try { v = String(localStorage.getItem("sms_lang") || "").toLowerCase(); } catch (e) { v = ""; } }
    if (v !== "zh" && v !== "en") {
      var nav = String(navigator.language || navigator.userLanguage || navigator.browserLanguage || "").toLowerCase();
      v = nav.indexOf("zh") === 0 ? "zh" : (nav ? "en" : "zh");
    }
    try { localStorage.setItem("sms_lang", v); } catch (e) {}
    return v;
  })();
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var I18N = {
    zh: {
      langBtn: "EN", langTip: "Switch to English",
      ghRepo: "GitHub repository", modalClose: "Close", devices: "Devices",
      jumpTip: "Enter a page number and press Enter", perPageTip: "Items per page",
      stats: "统计", settings: "设置",
      themeAuto: "自动", themeLight: "浅色", themeDark: "深色",
      themeTip: "切换主题（自动 / 浅色 / 深色）",
      tabAll: "全部", tabRename: "重命名设备", tabMerge: "合并到其他设备", tabDel: "删除该设备标签",
      searchPh: "搜索发件人或内容…", clearSearch: "清除搜索",
      srcTip: "按来源筛选", allSources: "全部来源", srcSms: "短信", srcNotify: "通知",
      rangeTip: "按时间筛选", allTime: "全部时间", d7: "近 7 天", d30: "近 30 天",
      autoCopy: "自动复制验证码", notifyOn: "后台通知", soundOn: "提示音",
      starOnly: "★ 收藏", unreadOnly: "● 未读", starTip: "只看收藏", unreadTip: "只看未读",
      select: "选择", selectTip: "进入批量选择", done: "完成",
      clear: "清空", clearTip: "清空当前筛选结果（软删除）",
      exportCsv: "导出 CSV", exportJson: "导出 JSON",
      exportCsvTip: "按当前筛选导出 CSV", exportJsonTip: "按当前筛选导出 JSON",
      total: "共 {n} 条", pageOf: "第 {a} / {b} 页",
      prev: "上一页", next: "下一页", perPage: "{n} 条/页", jumpPh: "页码", go: "跳转",
      loading: "加载中…", emptyFilter: "没有符合条件的消息",
      emptyAll: "还没有收到消息", emptyHint: "在手机端配置 SmsForwarder，或调用 /api/push 推送一条试试",
      loadFail: "加载失败：{m}", retry: "重试",
      del: "删除", unknownNum: "未知号码", codeLabel: "验证码：", copy: "复制", copied: "已复制",
      more: "展开全文", less: "收起", unread: "未读",
      starItemTip: "收藏/置顶", recvTip: "双击复制收件号", selTip: "选择",
      numLibTip: "常见号码库（仅供参考）", areaTip: "号码归属地",
      deletedOne: "已删除", deletedN: "已删除 {n} 条", undo: "撤销",
      newPill: "↑ {n} 条新消息", gotNew: "收到 {n} 条新消息", codeCopied: "验证码 {c} 已复制",
      recvCopied: "收件号已复制", newSms: "新短信",
      selCount: "已选 {n} 条", selAll: "全选本页", cancel: "取消",
      dSource: "来源", dDevice: "设备标签", dRecv: "收件号", dTime: "时间", dLabel: "号码标签", dStatus: "状态",
      notSet: "（未设置）", read: "已读", starredPrefix: "★ 收藏 · ",
      star: "收藏置顶", unstar: "取消收藏", markUnread: "标为未读", copyAll: "复制全文",
      call: "拨号", setLabel: "号码标签",
      labelPrompt: "给 {n} 设置标签（留空清除）",
      sTheme: "主题", sSound: "新消息提示音", sDnd: "免打扰", sDndRange: "免打扰时段",
      to: "至", hourSuffix: "点", save: "保存", saved: "设置已保存",
      statTitle: "统计", statFail: "统计加载失败", statTotal: "总消息", statUnread: "未读", statStarred: "收藏",
      statSources: "来源分布", statDays: "近 7 天",
      autoCopyOn: "已开启验证码自动复制", autoCopyOff: "已关闭验证码自动复制",
      notifyOnMsg: "已开启后台通知", notifyOffMsg: "已关闭后台通知",
      soundOnMsg: "已开启新消息提示音", soundOffMsg: "已关闭新消息提示音",
      clearedN: "已清空 {n} 条",
      confirmDelN: "确认删除选中的 {n} 条？",
      scopeDevice: "当前设备", scopeFilter: "当前筛选结果", scopeAll: "全部消息",
      confirmClear: "确认清空{scope}？将软删除匹配的所有消息（此操作不可撤销）。",
      confirmClear2: "再次确认：真的要清空{scope}吗？",
      renamePrompt: "重命名设备「{name}」\n留空则恢复默认名", renameFail: "重命名失败",
      noOthers: "没有可合并的其他设备",
      mergePrompt: "把「{a}」的全部消息合并到哪台设备？\n{list}\n输入序号：",
      invalidIdx: "序号无效",
      mergeConfirm: "确认把「{a}」的全部消息合并到「{b}」？\n合并后本标签将被删除。",
      targetMissing: "目标设备不存在", mergeFail: "合并失败",
      delDevConfirm: "删除该设备标签？（须先清空其全部短信）",
      hasMessages: "该设备仍有短信，请先删除全部短信", delFail: "删除失败",
      devCount: "（{n} 条）",
      justNow: "刚刚", minAgo: "{n} 分钟前", hourAgo: "{n} 小时前", today: "今天", yesterday: "昨天",
      unnamed: "未命名设备", unknownErr: "操作失败"
    },
    en: {
      langBtn: "中文", langTip: "切换到中文",
      ghRepo: "GitHub 仓库", modalClose: "关闭", devices: "设备标签",
      jumpTip: "输入页码后回车跳转", perPageTip: "每页条数",
      stats: "Stats", settings: "Settings",
      themeAuto: "Auto", themeLight: "Light", themeDark: "Dark",
      themeTip: "Theme: auto / light / dark",
      tabAll: "All", tabRename: "Rename device", tabMerge: "Merge into another device", tabDel: "Delete this device",
      searchPh: "Search sender or content…", clearSearch: "Clear search",
      srcTip: "Filter by source", allSources: "All sources", srcSms: "SMS", srcNotify: "Notification",
      rangeTip: "Filter by time", allTime: "All time", d7: "Last 7 days", d30: "Last 30 days",
      autoCopy: "Auto-copy codes", notifyOn: "Background alerts", soundOn: "Sound",
      starOnly: "★ Starred", unreadOnly: "● Unread", starTip: "Starred only", unreadTip: "Unread only",
      select: "Select", selectTip: "Enter multi-select", done: "Done",
      clear: "Clear", clearTip: "Clear current filter (soft delete)",
      exportCsv: "Export CSV", exportJson: "Export JSON",
      exportCsvTip: "Export current filter as CSV", exportJsonTip: "Export current filter as JSON",
      total: "{n} messages", pageOf: "Page {a} of {b}",
      prev: "Prev", next: "Next", perPage: "{n} per page", jumpPh: "Page", go: "Go",
      loading: "Loading…", emptyFilter: "No matching messages",
      emptyAll: "No messages yet", emptyHint: "Set up SmsForwarder on your phone, or POST to /api/push to try it out",
      loadFail: "Failed to load: {m}", retry: "Retry",
      del: "Delete", unknownNum: "Unknown", codeLabel: "Code:", copy: "Copy", copied: "Copied",
      more: "Show more", less: "Show less", unread: "Unread",
      starItemTip: "Star / pin", recvTip: "Double-tap to copy", selTip: "Select",
      numLibTip: "Built-in number directory (reference only)", areaTip: "Number location",
      deletedOne: "Deleted", deletedN: "{n} deleted", undo: "Undo",
      newPill: "↑ {n} new", gotNew: "{n} new message(s)", codeCopied: "Code {c} copied",
      recvCopied: "Recipient number copied", newSms: "New message",
      selCount: "{n} selected", selAll: "Select page", cancel: "Cancel",
      dSource: "Source", dDevice: "Device", dRecv: "Recipient", dTime: "Time", dLabel: "Number label", dStatus: "Status",
      notSet: "(not set)", read: "Read", starredPrefix: "★ Starred · ",
      star: "Star & pin", unstar: "Unstar", markUnread: "Mark unread", copyAll: "Copy text",
      call: "Call", setLabel: "Number label",
      labelPrompt: "Label for {n} (leave empty to clear)",
      sTheme: "Theme", sSound: "New message sound", sDnd: "Do not disturb", sDndRange: "Quiet hours",
      to: "to", hourSuffix: "", save: "Save", saved: "Settings saved",
      statTitle: "Statistics", statFail: "Failed to load stats", statTotal: "Total", statUnread: "Unread", statStarred: "Starred",
      statSources: "By source", statDays: "Last 7 days",
      autoCopyOn: "Auto-copy enabled", autoCopyOff: "Auto-copy disabled",
      notifyOnMsg: "Background alerts enabled", notifyOffMsg: "Background alerts disabled",
      soundOnMsg: "Sound enabled", soundOffMsg: "Sound disabled",
      clearedN: "Cleared {n}",
      confirmDelN: "Delete {n} selected message(s)?",
      scopeDevice: "this device", scopeFilter: "the current filter", scopeAll: "all messages",
      confirmClear: "Clear {scope}? All matching messages will be soft-deleted (cannot be undone).",
      confirmClear2: "Really clear {scope}?",
      renamePrompt: "Rename device \"{name}\"\nLeave empty to restore the default name", renameFail: "Rename failed",
      noOthers: "No other devices to merge into",
      mergePrompt: "Merge all messages of \"{a}\" into which device?\n{list}\nEnter number:",
      invalidIdx: "Invalid number",
      mergeConfirm: "Merge all messages of \"{a}\" into \"{b}\"?\nThe \"{a}\" tag will be removed.",
      targetMissing: "Target device not found", mergeFail: "Merge failed",
      delDevConfirm: "Delete this device tag? (all messages must be cleared first)",
      hasMessages: "This device still has messages — delete them first", delFail: "Delete failed",
      devCount: "({n})",
      justNow: "just now", minAgo: "{n} min ago", hourAgo: "{n} h ago", today: "Today", yesterday: "Yesterday",
      unnamed: "Unnamed device", unknownErr: "Operation failed"
    }
  };
  function T(key, vars) {
    var m = I18N[LANG] || I18N.zh;
    var s = m[key];
    if (s === undefined) s = I18N.zh[key];
    if (s === undefined) return key;
    if (vars) {
      for (var k in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, k)) s = s.split("{" + k + "}").join(vars[k]);
      }
    }
    return s;
  }
  /* 静态节点翻译（在首屏渲染前调用，避免中英文闪烁） */
  function applyI18n() {
    document.documentElement.lang = LANG === "zh" ? "zh-CN" : "en";
    var each = function (sel, attr, fn) {
      var ns = document.querySelectorAll("[" + attr + "]");
      for (var i = 0; i < ns.length; i++) fn(ns[i], T(ns[i].getAttribute(attr)));
    };
    each("data-i18n", "data-i18n", function (el, v) { el.textContent = v; });
    each("data-i18n-ph", "data-i18n-ph", function (el, v) { el.setAttribute("placeholder", v); });
    each("data-i18n-title", "data-i18n-title", function (el, v) { el.setAttribute("title", v); });
    each("data-i18n-aria", "data-i18n-aria", function (el, v) { el.setAttribute("aria-label", v); });
    var lb = $("langbtn");
    if (lb) { lb.textContent = T("langBtn"); lb.title = T("langTip"); }
    var tb = $("themebtn");
    if (tb) tb.setAttribute("title", T("themeTip"));
  }
  /* 每页条数下拉（含本地化文案） */
  function buildPerPage() {
    var sel = $("perpage");
    if (!sel) return;
    var nums = [20, 50, 100], html = "";
    for (var i = 0; i < nums.length; i++) html += '<option value="' + nums[i] + '">' + esc(T("perPage", { n: nums[i] })) + '</option>';
    sel.innerHTML = html;
  }
  /* 语言切换：写入 localStorage 后整页重载（避免半渲染状态；筛选条件不落盘，重载即回到默认视图） */
  function initLang() {
    var b = $("langbtn");
    if (!b) return;
    b.onclick = function () {
      var next = LANG === "zh" ? "en" : "zh";
      try { localStorage.setItem("sms_lang", next); } catch (e) {}
      try {
        var u = new URL(location.href);
        u.searchParams.set("lang", next);
        location.replace(u.toString());
        return;
      } catch (e) { location.reload(); }
    };
  }
  applyI18n();
  buildPerPage();
  initLang();
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function parseUTC(utc) {
    var d = new Date(String(utc).replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? null : d;
  }
  var LOCALE = LANG === "zh" ? "zh-CN" : "en-US";
  function pad2(s) { s = String(s); return s.length < 2 ? "0" + s : s; }
  /* 取北京时间字段：优先 Intl（Asia/Shanghai 固定时区）；无 Intl / 无时区数据的旧环境按 UTC+8 手算 */
  function partsOf(d) {
    var v = {}, ok = false, i;
    try {
      var base = { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric",
                   hour: "2-digit", minute: "2-digit", second: "2-digit" };
      var parts;
      try { parts = new Intl.DateTimeFormat(LOCALE, Object.assign({ hourCycle: "h23" }, base)).formatToParts(d); }
      catch (e1) { parts = new Intl.DateTimeFormat(LOCALE, Object.assign({ hour12: false }, base)).formatToParts(d); }
      for (i = 0; i < parts.length; i++) if (parts[i].type) v[parts[i].type] = parts[i].value;
      ok = !!(v.year && v.month && v.day && v.hour !== undefined);
    } catch (e2) { ok = false; }
    if (!ok) {
      var t = new Date(d.getTime() + 8 * 3600 * 1000);
      v = { year: String(t.getUTCFullYear()), month: String(t.getUTCMonth() + 1), day: String(t.getUTCDate()),
            hour: pad2(t.getUTCHours()), minute: pad2(t.getUTCMinutes()), second: pad2(t.getUTCSeconds()) };
    }
    v.pmonth = pad2(v.month); v.pday = pad2(v.day);
    v.phour = pad2(v.hour); v.pminute = pad2(v.minute); v.psecond = pad2(v.second);
    return v;
  }
  function fmtTime(utc) {
    var d = parseUTC(utc);
    if (!d) return String(utc || "");
    var v = partsOf(d);
    if (LANG === "zh") return v.year + "年" + v.pmonth + "月" + v.pday + "日 " + v.phour + ":" + v.pminute + ":" + v.psecond;
    return MONTHS[Number(v.month) - 1] + " " + Number(v.day) + ", " + v.year + " " + v.phour + ":" + v.pminute + ":" + v.psecond;
  }
  /* 相对时间：刚刚 / N 分钟前 / N 小时前 / 更早显示短日期；悬停卡片可看完整时间 */
  function relTime(utc) {
    var d = parseUTC(utc);
    if (!d) return String(utc || "");
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return T("justNow");
    if (diff < 3600) return T("minAgo", { n: Math.floor(diff / 60) });
    if (diff < 86400) return T("hourAgo", { n: Math.floor(diff / 3600) });
    var v = partsOf(d), now = partsOf(new Date());
    if (LANG === "zh") {
      var yr = v.year === now.year ? "" : v.year + "年";
      return yr + Number(v.pmonth) + "月" + Number(v.pday) + "日 " + v.phour + ":" + v.pminute;
    }
    var yr2 = v.year === now.year ? "" : ", " + v.year;
    return MONTHS[Number(v.month) - 1] + " " + Number(v.day) + yr2 + " " + v.phour + ":" + v.pminute;
  }
  /* 日期分组标签：今天 / 昨天 / M月D日（跨年带年份） */
  function dayLabel(utc) {
    var d = parseUTC(utc);
    if (!d) return "";
    var v = partsOf(d), now = partsOf(new Date());
    if (v.year === now.year && v.pmonth === now.pmonth) {
      var dd = Number(v.pday), nd = Number(now.pday);
      if (dd === nd) return T("today");
      if (nd - dd === 1) return T("yesterday");
    }
    if (LANG === "zh") {
      var yr = v.year === now.year ? "" : v.year + "年";
      return yr + Number(v.pmonth) + "月" + Number(v.pday) + "日";
    }
    var yr2 = v.year === now.year ? "" : ", " + v.year;
    return MONTHS[Number(v.month) - 1] + " " + Number(v.day) + yr2;
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
  /* 链接识别：支持 http(s)://、www. 前缀与常见裸域名；大小写不敏感；
     自动剥掉句末标点、不吞右括号；邮箱内的域名不链接；裸域名补 https:// */
  var LINK_RE = /(?:https?:\/\/[^\s<>"'，。；！？、（）【】「」《》…)\]}]+|www\.[^\s<>"'，。；！？、（）【】「」《》…)\]}]+|\b(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|co|me|app|dev|xyz|top|info|biz|cc|tv|ai|gov|edu|shop|site|link|vip|ltd|tech|online|wang|xin|cloud|store|club|fun|space|website|press|news|blog|pro|live|art|design|hk|tw|mo|sg|jp|kr|uk|us|de|fr|ru|in|au|ca|nl|it|es|se|no|dk|fi|pl|be|at|cz|gr|pt|ie|nz|za|mx|ar|my|th|vn|id|ph|tr|ae)(?![a-z0-9-])(?:\/[^\s<>"'，。；！？、（）【】「」《》…)\]}]*)?)/gi;
  function linkify(escaped) {
    return String(escaped || "").replace(LINK_RE, function (m, offset, str) {
      var trail = "";
      var core = m.replace(/[.,:!?]+$/, function (t) { trail = t; return ""; });
      if (!core) return m;
      if (!/^https?:\/\//i.test(core) && offset > 0 && str.charAt(offset - 1) === "@") return m;
      var href = /^https?:\/\//i.test(core) ? core : "https://" + core;
      return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + core + '</a>' + trail;
    });
  }
  /* 内置常见机构号码库（离线、仅供参考）；匹配前剥离 +86/空格等非数字 */
  var NUM_LABELS = {
    "10086": "中国移动", "10010": "中国联通", "10000": "中国电信", "10099": "中国广电",
    "95588": "工商银行", "95533": "建设银行", "95599": "农业银行", "95566": "中国银行",
    "95555": "招商银行", "95559": "交通银行", "95561": "兴业银行", "95528": "浦发银行",
    "95577": "华夏银行", "95568": "民生银行", "95508": "广发银行", "95595": "光大银行",
    "95558": "中信银行", "95580": "邮储银行", "95511": "平安",
    "95338": "顺丰速运", "95543": "申通快递", "95554": "圆通速递", "95546": "韵达快递",
    "95311": "中通快递", "95353": "德邦快递", "11183": "中国邮政", "950616": "京东物流",
    "12345": "政务服务", "12315": "消费者投诉", "12333": "社保热线", "12329": "公积金",
    "12306": "中国铁路", "96110": "反诈专线", "12321": "不良信息举报", "95598": "国家电网",
    "95188": "支付宝"
  };
  /* 内置机构号码库英文名（与上面一一对应；界面语言为英文时使用） */
  var NUM_LABELS_EN = {
    "10086": "China Mobile", "10010": "China Unicom", "10000": "China Telecom", "10099": "China Broadnet",
    "95588": "ICBC", "95533": "CCB", "95599": "ABC", "95566": "Bank of China",
    "95555": "China Merchants Bank", "95559": "Bank of Communications", "95561": "Industrial Bank", "95528": "SPD Bank",
    "95577": "Hua Xia Bank", "95568": "China Minsheng Bank", "95508": "Guangfa Bank", "95595": "CEB",
    "95558": "CITIC Bank", "95580": "PSBC", "95511": "Ping An",
    "95338": "SF Express", "95543": "STO Express", "95554": "YTO Express", "95546": "Yunda Express",
    "95311": "ZTO Express", "95353": "Deppon", "11183": "China Post", "950616": "JD Logistics",
    "12345": "Gov. Hotline", "12315": "Consumer Complaint", "12333": "Social Security", "12329": "Housing Fund",
    "12306": "China Railway", "96110": "Anti-fraud Hotline", "12321": "Spam Report", "95598": "State Grid",
    "95188": "Alipay"
  };
  function normalizeNum(s) {
    var d = String(s || "").replace(/\D/g, "");
    if (d.length > 11 && d.indexOf("86") === 0) d = d.slice(2);
    return d;
  }
  function numLabel(s) {
    var d = normalizeNum(s);
    if (!d) return "";
    return state.labels[d] || (LANG === "zh" ? NUM_LABELS[d] : NUM_LABELS_EN[d]) || "";
  }
  /* 归属地：仅对 11 位手机号按需查后端 /api/phone；前端按号码缓存，最多 3 并发 */
  var areaCache = {};
  function fillAreas() {
    var els = $("list").querySelectorAll(".area[data-num]");
    var todo = {}, i;
    for (i = 0; i < els.length; i++) {
      var n = els[i].getAttribute("data-num");
      if (areaCache[n] === undefined) { todo[n] = 1; }
      else { els[i].textContent = areaCache[n] ? " · " + areaCache[n] : ""; }
    }
    var nums = Object.keys(todo), running = 0, idx = 0;
    function paint(num) {
      var es = $("list").querySelectorAll('.area[data-num="' + num + '"]');
      for (var j = 0; j < es.length; j++) es[j].textContent = areaCache[num] ? " · " + areaCache[num] : "";
    }
    function pump() {
      while (running < 3 && idx < nums.length) {
        (function (num) {
          running++;
          fetch("/api/phone?number=" + encodeURIComponent(num))
            .then(function (r) { return r.json(); })
            .then(function (d) { areaCache[num] = (d && d.found) ? ((d.province || "") + (d.sp || "")) : ""; })
            .catch(function () { areaCache[num] = ""; })
            .then(function () { running--; paint(num); pump(); });
        })(nums[idx++]);
      }
    }
    pump();
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
      btn.textContent = T("copied");
      btn.disabled = true;
      setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  /* 轻提示：统一放进堆叠容器，多条不重叠；2.6s 自动消失 */
  function toastRoot() {
    var r = document.getElementById("toastroot");
    if (!r) { r = document.createElement("div"); r.id = "toastroot"; r.className = "toastroot"; document.body.appendChild(r); }
    return r;
  }
  function toast(msg) {
    var t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    toastRoot().appendChild(t);
    setTimeout(function () { t.classList.add("show"); }, 10);
    setTimeout(function () {
      t.classList.remove("show");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 2600);
  }
  /* 删除后 5 秒内可撤销（软删除 → restore） */
  function undoToast(ids) {
    var t = document.createElement("div");
    t.className = "toast undo";
    var span = document.createElement("span");
    span.textContent = ids.length > 1 ? T("deletedN", { n: ids.length }) : T("deletedOne");
    var btn = document.createElement("button");
    btn.className = "undo-btn"; btn.type = "button"; btn.textContent = T("undo");
    t.appendChild(span); t.appendChild(btn);
    toastRoot().appendChild(t);
    setTimeout(function () { t.classList.add("show"); }, 10);
    var done = function () { t.classList.remove("show"); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300); };
    var timer = setTimeout(done, 5000);
    btn.onclick = function () {
      clearTimeout(timer); done();
      fetch("/api/messages/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: ids }) })
        .then(function (r) { return r.json(); })
        .then(function () { load(); });
    };
  }
  /* 提示音：短促正弦波；首次调用在用户手势（开关切换）内，规避浏览器自动播放限制 */
  var audioCtx = null;
  function beep(freq) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === "suspended") audioCtx.resume();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.type = "sine"; o.frequency.value = freq || 800;
      var t0 = audioCtx.currentTime;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      o.start(t0); o.stop(t0 + 0.22);
    } catch (e) {}
  }
  /* 悬浮「N 条新消息」胶囊：用户在下方浏览时提示新消息 */
  var pillN = 0, pillTimer = null;
  function showNewPill(n) {
    pillN += (n || 1);
    var el = $("newpill");
    el.textContent = T("newPill", { n: pillN });
    el.hidden = false;
    clearTimeout(pillTimer);
    pillTimer = setTimeout(function () { el.hidden = true; pillN = 0; }, 8000);
  }
  /* 新消息处理：验证码自动复制 + 页面可见时 toast/提示音/胶囊 + 隐藏时标题未读与系统通知 */
  function notifyNew(fresh) {
    var latest = fresh[0];
    var code = extractCode(latest.content);
    if (code && state.autoCopy) {
      var fin = function () { toast(T("codeCopied", { c: code })); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(fin, function () { fallbackCopy(code); fin(); });
      } else { fallbackCopy(code); fin(); }
    }
    if (document.hidden) {
      state.unread += fresh.length;
      document.title = "(" + state.unread + ") " + SITE_NAME;
      if (state.notify && !isDND() && window.Notification && Notification.permission === "granted") {
        var body = (code ? T("codeLabel") + " " + code + "  " : "") + String(latest.content || "");
        try {
          new Notification(String(latest.sender || T("newSms")), { body: body.slice(0, 140), tag: "sms-" + latest.id });
        } catch (e) {}
      }
    } else {
      if (!(code && state.autoCopy)) toast(T("gotNew", { n: fresh.length }));
      if (state.sound && !isDND()) beep(code ? 960 : 760);
      if (window.scrollY > 260) showNewPill(fresh.length);
    }
  }
  function qs() {
    var p = new URLSearchParams();
    if (state.device) p.set("device_id", state.device);
    if (state.src) p.set("source", state.src);
    if (state.range) p.set("range", state.range);
    if (state.q) p.set("q", state.q);
    if (state.starOnly) p.set("starred", "1");
    if (state.unreadOnly) p.set("unread", "1");
    p.set("page", state.page);
    p.set("limit", state.limit);
    return p.toString();
  }
  function loadDevices() {
    return fetch("/api/devices").then(function (r) { return r.json(); }).then(function (res) {
      var tabs = $("tabs");
      tabs.innerHTML = "";
      var mk = function (label, id, extra) {
        var el = document.createElement("div");
        el.className = "tab" + (state.device === id ? " active" : "");
        el.setAttribute("role", "tab");
        el.setAttribute("aria-selected", state.device === id ? "true" : "false");
        el.tabIndex = 0;
        el.textContent = label + (extra ? " " + extra : "");
        el.onclick = function () { state.device = id; state.page = 1; renderTabs(res.list || []); load(); };
        return el;
      };
      tabs.appendChild(mk(T("tabAll"), 0, "(" + (res.list || []).reduce(function (s, d) { return s + d.msg_count; }, 0) + ")"));
      (res.list || []).forEach(function (d) {
        var el = mk(d.display_name, d.id, T("devCount", { n: d.msg_count }));
        /* 设备标签操作：✎ 重命名（设别名）、⇄ 合并到其他设备（后端 /api/devices/alias、/api/devices/merge） */
        if (d.id) {
          var ed = document.createElement("span");
          ed.className = "tabop"; ed.textContent = "✎"; ed.title = T("tabRename");
          ed.onclick = function (ev) {
            ev.stopPropagation();
            var nm = prompt(T("renamePrompt", { name: d.display_name }), d.alias || d.display_name);
            if (nm === null) return;
            fetch("/api/devices/alias", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: d.id, alias: String(nm).trim() }) })
              .then(function (r) { return r.json(); })
              .then(function (res2) { if (!res2.success) { alert(res2.error || T("renameFail")); return; } refreshAll(); });
          };
          el.appendChild(ed);
          var mg = document.createElement("span");
          mg.className = "tabop"; mg.textContent = "⇄"; mg.title = T("tabMerge");
          mg.onclick = function (ev) {
            ev.stopPropagation();
            var others = (res.list || []).filter(function (x) { return x.id && x.id !== d.id; });
            if (!others.length) { alert(T("noOthers")); return; }
            var lines = others.map(function (x, i) { return (i + 1) + ". " + x.display_name + " " + T("devCount", { n: x.msg_count }); });
            var pick = prompt(T("mergePrompt", { a: d.display_name, list: lines.join("\n") }));
            if (pick === null) return;
            var idx = parseInt(pick, 10);
            if (!(idx >= 1 && idx <= others.length)) { alert(T("invalidIdx")); return; }
            var target = others[idx - 1];
            if (!confirm(T("mergeConfirm", { a: d.display_name, b: target.display_name }))) return;
            fetch("/api/devices/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: d.id, to: target.id }) })
              .then(function (r) { return r.json(); })
              .then(function (res2) {
                if (!res2.success) { alert(res2.error === "device not found" ? T("targetMissing") : (res2.error || T("mergeFail"))); return; }
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
          x.title = T("tabDel");
          x.onclick = function (ev) {
            ev.stopPropagation();
            if (!confirm(T("delDevConfirm"))) return;
            fetch("/api/devices/" + d.id, { method: "DELETE" })
              .then(function (r) { return r.json(); })
              .then(function (res2) {
                if (!res2.success) {
                  alert(res2.error === "has messages" ? T("hasMessages") : (res2.error || T("delFail")));
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
  function updateMeta(res) {
    $("stat").textContent = T("total", { n: res.total });
    $("pageinfo").textContent = res.pages > 1 ? T("pageOf", { a: res.page, b: res.pages }) : "";
    $("pagenum").textContent = res.pages > 1 ? res.page + " / " + res.pages : "";
    $("prev").disabled = res.page <= 1;
    $("next").disabled = res.page >= res.pages;
  }
  function updateSelBar() {
    var n = Object.keys(state.selected).length;
    if ($("selcount")) $("selcount").textContent = T("selCount", { n: n });
    if ($("seldel")) $("seldel").disabled = n === 0;
  }
  function srcClass(s) {
    s = String(s || "").toLowerCase();
    if (s === "sms") return "s-sms";
    if (s === "notify") return "s-notify";
    if (s === "alert") return "s-alert";
    if (s === "cron") return "s-cron";
    return "s-other";
  }
  function cardHtml(m, isFresh) {
    var code = extractCode(m.content);
    var isSms = (m.source || "sms") === "sms";
    var recv = m.sim_number || m.sim || "";
    var needFold = String(m.content || "").length > 220;
    var lbl = isSms ? numLabel(m.sender) : "";
    var snum = isSms ? normalizeNum(m.sender) : "";
    var undot = m.read_at ? "" : '<span class="undot" title="' + esc(T("unread")) + '"></span>';
    var senderHtml = isSms
      ? '<span class="sender">' + esc(m.sender || T("unknownNum")) + '</span>' +
        (lbl ? '<span class="nlabel" title="' + esc(T("numLibTip")) + '">' + esc(lbl) + '</span>' : '') +
        (!lbl && /^1[3-9]\d{9}$/.test(snum) ? '<span class="area" data-num="' + snum + '"></span>' : '') + undot
      : '<span class="srctag ' + srcClass(m.source) + '">' + esc(m.source || T("srcNotify")) + '</span><span class="sender">' + esc(m.sender || m.device_name || T("srcNotify")) + '</span>' + undot;
    return '<div class="card' + (isFresh ? " flash" : "") + '" data-id="' + m.id + '" data-day="' + esc(dayLabel(m.received_at)) + '">' +
      '<label class="selwrap" title="' + esc(T("selTip")) + '"><input type="checkbox" class="selbox" data-id="' + m.id + '"></label>' +
      '<div class="row1">' + senderHtml +
        '<button class="star' + (m.starred ? " on" : "") + '" data-id="' + m.id + '" title="' + esc(T("starItemTip")) + '">' + (m.starred ? "★" : "☆") + '</button>' +
        '<button class="del" data-id="' + m.id + '">' + esc(T("del")) + '</button>' +
      '</div>' +
      (code ? '<div class="code-line">' + esc(T("codeLabel")) + ' <b>' + esc(code) + '</b><button class="copy" data-code="' + esc(code) + '">' + esc(T("copy")) + '</button></div>' : '') +
      '<div class="line"><span class="content' + (needFold ? " fold" : "") + '">' + linkify(highlight(esc(m.content), state.q)) + '</span>' +
        (needFold ? '<button class="more" type="button">' + esc(T("more")) + '</button>' : '') + '</div>' +
      '<div class="line foot-line"><span class="time-line" title="' + esc(fmtTime(m.received_at)) + '">' + esc(relTime(m.received_at)) + '</span>' +
        (isSms && recv ? '<span class="recv" title="' + esc(T("recvTip")) + '">' + esc(recv) + '</span>' : '') +
      '</div>' +
    '</div>';
  }
  function syncSelBoxes() {
    if (!state.selectMode) return;
    var boxes = $("list").querySelectorAll(".selbox");
    var present = {}, i;
    for (i = 0; i < boxes.length; i++) {
      var id = boxes[i].getAttribute("data-id");
      present[id] = true;
      boxes[i].checked = !!state.selected[id];
    }
    for (var k in state.selected) if (!present[k]) delete state.selected[k];
    updateSelBar();
  }
  function renderFull(list, freshSet, res) {
    updateMeta(res);
    if (!list.length) {
      var hasFilter = state.device || state.src || state.range || state.q;
      $("list").innerHTML = '<div class="empty">' + (hasFilter ? esc(T("emptyFilter")) : esc(T("emptyAll")) + '<br><small>' + esc(T("emptyHint")) + '</small>') + '</div>';
      return;
    }
    var html = "", lastDay = "";
    list.forEach(function (m) {
      var day = dayLabel(m.received_at);
      if (day !== lastDay) { html += '<div class="daysep">' + esc(day) + '</div>'; lastDay = day; }
      html += cardHtml(m, freshSet[m.id]);
    });
    $("list").innerHTML = html;
    fillAreas();
    syncSelBoxes();
  }
  function trimToLimit(listEl) {
    var limit = state.limit || 20;
    while (listEl.querySelectorAll(".card").length > limit) {
      var cards = listEl.querySelectorAll(".card");
      var last = cards[cards.length - 1];
      var prev = last.previousElementSibling;
      last.parentNode.removeChild(last);
      if (prev && prev.classList && prev.classList.contains("daysep") && !prev.nextElementSibling) prev.parentNode.removeChild(prev);
    }
  }
  /* 增量：仅同日新消息时 prepend，避免整页重绘导致滚动跳动；跨天/异常回退全量 */
  function prependFresh(fresh, res) {
    var listEl = $("list");
    var top = listEl.querySelector(".card");
    if (!top) return false;
    var oldDay = top.getAttribute("data-day") || "";
    var newestDay = dayLabel(fresh[0].received_at);
    var oldestDay = dayLabel(fresh[fresh.length - 1].received_at);
    if (newestDay !== oldestDay) return false;
    var block = "", lastDay = null;
    fresh.forEach(function (m) {
      var d = dayLabel(m.received_at);
      if (d !== lastDay) { block += '<div class="daysep">' + esc(d) + '</div>'; lastDay = d; }
      block += cardHtml(m, true);
    });
    if (oldDay && oldestDay === oldDay) {
      block = block.replace(/^<div class="daysep">.*?<\/div>/, "");
      var firstSep = listEl.querySelector(".daysep");
      if (firstSep) firstSep.insertAdjacentHTML("afterend", block);
      else listEl.insertAdjacentHTML("afterbegin", block);
    } else {
      listEl.insertAdjacentHTML("afterbegin", block);
    }
    trimToLimit(listEl);
    updateMeta(res);
    fillAreas();
    syncSelBoxes();
    return true;
  }
  function showRetry(e) {
    $("list").innerHTML = '<div class="empty">' + esc(T("loadFail", { m: (e && e.message) || "" })) + '<br><button class="tbtn" id="retrybtn" type="button">' + esc(T("retry")) + '</button></div>';
    var b = $("retrybtn");
    if (b) b.onclick = function () { load(); };
  }
  /* 搜索高亮：在已转义文本上包裹 <mark>（关键词转义正则特殊字符） */
  function highlight(escaped, q) {
    var s = String(escaped || "");
    if (!q) return s;
    var safe = String(q).replace(/[.*+?^{}$()|[\]\\]/g, "\\$&");
    try { return s.replace(new RegExp("(" + safe + ")", "gi"), "<mark>$1</mark>"); } catch (e) { return s; }
  }
  /* 搜索历史（localStorage，最多 6 条） */
  function loadQHist() {
    var arr = [];
    try { arr = JSON.parse(localStorage.getItem("sms_qhist") || "[]") || []; } catch (e) { arr = []; }
    var dl = $("qhist");
    if (dl) dl.innerHTML = arr.map(function (x) { return '<option value="' + esc(x) + '"></option>'; }).join("");
  }
  function pushQHist(q) {
    if (!q || q.length < 2) return;
    var arr = [];
    try { arr = JSON.parse(localStorage.getItem("sms_qhist") || "[]") || []; } catch (e) { arr = []; }
    arr = [q].concat(arr.filter(function (x) { return x !== q; })).slice(0, 6);
    try { localStorage.setItem("sms_qhist", JSON.stringify(arr)); } catch (e) {}
    loadQHist();
  }
  /* 通用弹层 */
  function openModal(html) { $("modalbody").innerHTML = html; $("modal").hidden = false; }
  function closeModal() { $("modal").hidden = true; $("modalbody").innerHTML = ""; }
  function drow(label, val) {
    return '<div class="drow"><span>' + esc(label) + '</span><span>' + esc(val == null ? "" : val) + '</span></div>';
  }
  function msgById(id) {
    var list = state.lastList || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function toggleStar(id, starred) {
    return fetch("/api/messages/star", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id, starred: starred }) })
      .then(function (r) { return r.json(); }).then(function () { load(); });
  }
  function toggleRead(id, read) {
    return fetch("/api/messages/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id, read: read }) })
      .then(function (r) { return r.json(); }).then(function () { load(); });
  }
  function doDelete(ids) {
    fetch("/api/messages/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: ids }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.success) { undoToast(ids); load(); } });
  }
  function saveLabel(num, label) {
    num = normalizeNum(num);
    if (!num) return;
    if (label) state.labels[num] = label; else delete state.labels[num];
    try { localStorage.setItem("sms_labels", JSON.stringify(state.labels)); } catch (e) {}
  }
  function openDetail(id) {
    var m = msgById(id);
    if (!m) return;
    var isSms = (m.source || "sms") === "sms";
    var code = extractCode(m.content);
    var snum = normalizeNum(m.sender);
    var wasRead = !!m.read_at;
    var html = '<h3>' + esc(isSms ? (m.sender || T("unknownNum")) : (m.sender || m.device_name || T("srcNotify"))) + '</h3>' +
      '<div class="dl">' +
        drow(T("dSource"), isSms ? T("srcSms") : (m.source || T("srcNotify"))) +
        drow(T("dDevice"), m.device_name || "") +
        (isSms ? drow(T("dRecv"), m.sim_number || m.sim || "") : "") +
        drow(T("dTime"), fmtTime(m.received_at)) +
        drow(T("dLabel"), numLabel(m.sender) || T("notSet")) +
        drow(T("dStatus"), (m.starred ? T("starredPrefix") : "") + (wasRead ? T("read") : T("unread"))) +
      '</div>' +
      (code ? '<div class="code-line">' + esc(T("codeLabel")) + ' <b>' + esc(code) + '</b><button class="copy" data-code="' + esc(code) + '">' + esc(T("copy")) + '</button></div>' : '') +
      '<div class="detail-content">' + linkify(esc(m.content)) + '</div>' +
      '<div class="detail-actions">' +
        '<button class="tbtn" id="dstar">' + esc(m.starred ? T("unstar") : T("star")) + '</button>' +
        '<button class="tbtn" id="dread">' + esc(T("markUnread")) + '</button>' +
        '<button class="tbtn" id="dcopy">' + esc(T("copyAll")) + '</button>' +
        (isSms && snum ? '<a class="tbtn" href="tel:' + esc(snum) + '">' + esc(T("call")) + '</a>' : '') +
        (isSms && snum ? '<button class="tbtn" id="dlabel">' + esc(T("setLabel")) + '</button>' : '') +
        '<button class="tbtn" id="ddel">' + esc(T("del")) + '</button>' +
      '</div>';
    openModal(html);
    if (!wasRead) {
      m.read_at = "now";
      fetch("/api/messages/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: m.id, read: true }) }).catch(function () {});
      var card = $("list").querySelector('.card[data-id="' + m.id + '"]');
      if (card) { var dot = card.querySelector(".undot"); if (dot) dot.parentNode.removeChild(dot); }
    }
    $("dstar").onclick = function () { toggleStar(m.id, !m.starred).then(closeModal); };
    $("dread").onclick = function () { toggleRead(m.id, false).then(closeModal); };
    $("dcopy").onclick = function () { doCopy(m.content, $("dcopy")); };
    $("ddel").onclick = function () { closeModal(); doDelete([m.id]); };
    var lb = $("dlabel");
    if (lb) lb.onclick = function () {
      var cur = state.labels[snum] || "";
      var nm = prompt(T("labelPrompt", { n: snum }), cur);
      if (nm === null) return;
      saveLabel(snum, String(nm).trim());
      closeModal(); load();
    };
  }
  /* 免打扰：sms_dnd = {on,start,end}（小时，支持跨夜） */
  function getDND() {
    try { var d = JSON.parse(localStorage.getItem("sms_dnd") || ""); if (d && typeof d === "object") return d; } catch (e) {}
    return { on: false, start: 22, end: 8 };
  }
  function isDND() {
    var d = getDND();
    if (!d.on) return false;
    var h = new Date().getHours();
    var s = parseInt(d.start, 10) || 0, e = parseInt(d.end, 10) || 0;
    if (s === e) return false;
    return s < e ? (h >= s && h < e) : (h >= s || h < e);
  }
  function openSettings() {
    var d = getDND();
    var html = '<h3>' + esc(T("settings")) + '</h3>' +
      '<div class="dl">' +
        '<div class="drow"><span>' + esc(T("sTheme")) + '</span><span><button class="tbtn" id="thauto">' + esc(T("themeAuto")) + '</button> <button class="tbtn" id="thlight">' + esc(T("themeLight")) + '</button> <button class="tbtn" id="thdark">' + esc(T("themeDark")) + '</button></span></div>' +
        '<div class="drow"><span>' + esc(T("sSound")) + '</span><span><input type="checkbox" id="stsound"' + (state.sound ? " checked" : "") + '></span></div>' +
        '<div class="drow"><span>' + esc(T("sDnd")) + '</span><span><input type="checkbox" id="stdnd"' + (d.on ? " checked" : "") + '></span></div>' +
        '<div class="drow"><span>' + esc(T("sDndRange")) + '</span><span><input type="number" id="dnds" min="0" max="23" value="' + (parseInt(d.start, 10) || 0) + '" style="width:56px"> ' + esc(T("to")) + ' <input type="number" id="dnde" min="0" max="23" value="' + (parseInt(d.end, 10) || 0) + '" style="width:56px"> ' + esc(T("hourSuffix")) + '</span></div>' +
      '</div>' +
      '<div class="detail-actions"><button class="tbtn" id="dsave">' + esc(T("save")) + '</button></div>';
    openModal(html);
    $("thauto").onclick = function () { try { localStorage.setItem("sms_theme", "auto"); } catch (e) {} applyTheme("auto"); };
    $("thlight").onclick = function () { try { localStorage.setItem("sms_theme", "light"); } catch (e) {} applyTheme("light"); };
    $("thdark").onclick = function () { try { localStorage.setItem("sms_theme", "dark"); } catch (e) {} applyTheme("dark"); };
    $("dsave").onclick = function () {
      var on = $("stdnd").checked;
      var start = Math.min(23, Math.max(0, parseInt($("dnds").value, 10) || 0));
      var end = Math.min(23, Math.max(0, parseInt($("dnde").value, 10) || 0));
      try { localStorage.setItem("sms_dnd", JSON.stringify({ on: on, start: start, end: end })); } catch (e) {}
      state.sound = $("stsound").checked;
      try { localStorage.setItem("sms_sound", state.sound ? "1" : "0"); } catch (e) {}
      if ($("soundon")) $("soundon").checked = state.sound;
      closeModal(); toast(T("saved"));
    };
  }
  function openStats() {
    openModal('<h3>' + esc(T("statTitle")) + '</h3><div id="statbody">' + esc(T("loading")) + '</div>');
    fetch("/api/stats").then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.success) { $("statbody").textContent = T("statFail"); return; }
      var maxS = 1, maxD = 1;
      (d.sources || []).forEach(function (x) { if (x.n > maxS) maxS = x.n; });
      (d.days || []).forEach(function (x) { if (x.n > maxD) maxD = x.n; });
      var html = '<div class="statgrid">' +
        '<div class="statbox"><b>' + d.total + '</b><span>' + esc(T("statTotal")) + '</span></div>' +
        '<div class="statbox"><b>' + d.unread + '</b><span>' + esc(T("statUnread")) + '</span></div>' +
        '<div class="statbox"><b>' + d.starred + '</b><span>' + esc(T("statStarred")) + '</span></div></div>';
      html += '<h3 style="font-size:13px;margin:6px 0">' + esc(T("statSources")) + '</h3>';
      (d.sources || []).forEach(function (x) {
        html += '<div class="barrow"><span class="bl">' + esc(srcLabel(x.source) || x.source) + '</span><span class="bt"><span class="bf" style="width:' + Math.round(x.n / maxS * 100) + '%"></span></span><span class="bn">' + x.n + '</span></div>';
      });
      html += '<h3 style="font-size:13px;margin:12px 0 6px">' + esc(T("statDays")) + '</h3>';
      (d.days || []).forEach(function (x) {
        html += '<div class="barrow"><span class="bl">' + esc(String(x.d || "").slice(5)) + '</span><span class="bt"><span class="bf" style="width:' + Math.round(x.n / maxD * 100) + '%"></span></span><span class="bn">' + x.n + '</span></div>';
      });
      $("statbody").innerHTML = html;
    }).catch(function () { var b = $("statbody"); if (b) b.textContent = T("statFail"); });
  }
  function registerSW() {
    try { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {}); } catch (e) {}
  }
  function load(incremental) {
    var q = qs();
    return fetch("/api/messages?" + q)
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.success) throw new Error(res.error || "load failed");
        state.total = res.total; state.pages = res.pages;
        var list = res.list || [];
        state.lastList = list;
        var freshSet = {};
        /* 新消息识别：lastId 为轮询游标（防忙循环），notifiedId 为已通知基线 */
        if (!state.inited) {
          state.inited = true;
          if (list.length) {
            state.lastId = Math.max(state.lastId, list[0].id);
            state.notifiedId = Math.max(state.notifiedId, list[0].id);
          }
          renderFull(list, freshSet, res);
          state.lastQ = q;
          return;
        }
        var fresh = list.filter(function (m) { return m.id > state.notifiedId; });
        if (fresh.length) {
          state.notifiedId = fresh[0].id;
          fresh.forEach(function (m) { freshSet[m.id] = true; });
          notifyNew(fresh);
        }
        if (list.length) state.lastId = Math.max(state.lastId, list[0].id);
        if (incremental && fresh.length && state.page === 1 && !state.q && q === state.lastQ && prependFresh(fresh, res)) {
          state.lastQ = q;
          return;
        }
        renderFull(list, freshSet, res);
        state.lastQ = q;
      })
      .catch(function (e) { showRetry(e); });
  }
  /* 来源下拉：从 /api/sources 动态聚合所有来源（含自定义 cron/alert 等），替代原先写死的三项 */
  function srcLabel(s) {
    if (s === "sms") return T("srcSms");
    if (s === "notify") return T("srcNotify");
    return s;
  }
  function loadSources() {
    return fetch("/api/sources").then(function (r) { return r.json(); }).then(function (res) {
      var sel = $("src"), cur = state.src || "", list = (res && res.list) || [], seen = {};
      var html = '<option value="">' + esc(T("allSources")) + '</option>';
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
  function syncClear() { $("clearq").hidden = !$("q").value; }
  $("q").addEventListener("input", function () {
    syncClear();
    clearTimeout(state.deb);
    state.deb = setTimeout(function () { state.q = $("q").value.trim(); state.page = 1; pushQHist(state.q); load(); }, 300);
  });
  $("clearq").onclick = function () { $("q").value = ""; state.q = ""; state.page = 1; syncClear(); load(); $("q").focus(); };
  $("prev").onclick = function () { if (state.page > 1) { state.page--; load(); } };
  $("next").onclick = function () { if (state.page < state.pages) { state.page++; load(); } };
  $("src").onchange = function () { state.src = $("src").value; state.page = 1; load(); };
  $("range").onchange = function () { state.range = $("range").value; state.page = 1; load(); };
  $("perpage").onchange = function () { state.limit = parseInt($("perpage").value, 10) || 20; state.page = 1; load(); };
  function doJump() {
    var n = parseInt($("jump").value, 10);
    if (!Number.isInteger(n)) return;
    n = Math.min(Math.max(1, n), state.pages || 1);
    state.page = n; $("jump").value = ""; load();
  }
  $("gojump").onclick = doJump;
  $("jump").addEventListener("keydown", function (e) { if (e.key === "Enter") doJump(); });
  state.range = $("range").value = "";
  state.limit = parseInt($("perpage").value, 10) || 20;
  /* 导出：按当前筛选条件下载 CSV / JSON（附件下载，不跳转页面） */
  function exportUrl(fmt) {
    var p = new URLSearchParams();
    if (state.device) p.set("device_id", state.device);
    if (state.src) p.set("source", state.src);
    if (state.range) p.set("range", state.range);
    if (state.q) p.set("q", state.q);
    p.set("format", fmt);
    return "/api/export?" + p.toString();
  }
  function download(url) {
    var a = document.createElement("a");
    a.href = url; a.download = "";
    document.body.appendChild(a); a.click();
    setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 100);
  }
  $("exportcsv").onclick = function () { download(exportUrl("csv")); };
  $("exportjson").onclick = function () { download(exportUrl("json")); };
  /* 悬浮新消息胶囊：点击回到首页顶部 */
  $("newpill").onclick = function () {
    $("newpill").hidden = true; pillN = 0;
    state.page = 1;
    window.scrollTo({ top: 0, behavior: "smooth" });
    load();
  };
  window.addEventListener("scroll", function () {
    if (window.scrollY < 260) { var el = $("newpill"); if (el && !el.hidden) { el.hidden = true; pillN = 0; } }
  });
  /* 推送式自动刷新：长轮询 /api/wait；第 1 页收到新消息即刷新，其他页只弹胶囊避免打断阅读。
     失败（平台函数超时 / 断网）时指数退避，避免在 Netlify 等 10s 函数上限的平台形成忙循环。 */
  var pollErr = 0;
  function pollLoop(delay) {
    setTimeout(function () {
      if (state.q) {
        load().then(function () { pollLoop(5000); }, function () { pollLoop(5000); });
        return;
      }
      var p = "last_id=" + (state.lastId || 0);
      if (state.device) p += "&device_id=" + state.device;
      var t0 = Date.now();
      fetch("/api/wait?" + p)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          pollErr = 0;
          if (d && d.changed) {
            if (d.id) state.lastId = Math.max(state.lastId, d.id);
            if (state.page === 1) { load(true); } else { showNewPill(); }
          }
        })
        .catch(function () { pollErr = Math.min(pollErr + 1, 5); })
        .then(function () {
          if (pollErr) { pollLoop(Math.min(30000, 1000 * Math.pow(2, pollErr))); return; }
          /* 平台若不支持长轮询会立刻返回，这里兜底最小间隔，避免高频空转 */
          pollLoop(Math.max(0, 1500 - (Date.now() - t0)));
        });
    }, delay || 0);
  }
  pollLoop();
  /* 开关初始化与记忆（localStorage） */
  var acb = $("autocopy"), nb = $("notifyon"), sb = $("soundon");
  acb.checked = state.autoCopy;
  nb.checked = state.notify;
  sb.checked = state.sound;
  acb.onchange = function () {
    state.autoCopy = acb.checked;
    try { localStorage.setItem("sms_autocopy", state.autoCopy ? "1" : "0"); } catch (e) {}
    toast(state.autoCopy ? T("autoCopyOn") : T("autoCopyOff"));
  };
  nb.onchange = function () {
    state.notify = nb.checked;
    try { localStorage.setItem("sms_notify", state.notify ? "1" : "0"); } catch (e) {}
    if (state.notify && window.Notification && Notification.permission === "default") {
      Notification.requestPermission();
    }
    toast(state.notify ? T("notifyOnMsg") : T("notifyOffMsg"));
  };
  sb.onchange = function () {
    state.sound = sb.checked;
    try { localStorage.setItem("sms_sound", state.sound ? "1" : "0"); } catch (e) {}
    if (state.sound) beep();
    toast(state.sound ? T("soundOnMsg") : T("soundOffMsg"));
  };
  /* 回到页面即清零未读数、恢复标题，并立刻补拉一次（移动端切后台常被冻结，长轮询可能已断） */
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      state.unread = 0;
      document.title = SITE_NAME;
      pollErr = 0;
      load(true);
    }
  });
  $("list").addEventListener("click", function (ev) {
    var starBtn = ev.target.closest ? ev.target.closest(".star") : null;
    if (starBtn) {
      var sid = parseInt(starBtn.getAttribute("data-id"), 10);
      var sm = msgById(sid);
      if (sm) toggleStar(sid, !sm.starred);
      return;
    }
    var senderEl = ev.target.closest ? ev.target.closest(".sender") : null;
    if (senderEl) {
      var sc = senderEl.closest(".card");
      if (sc) { openDetail(parseInt(sc.getAttribute("data-id"), 10)); return; }
    }
    var moreBtn = ev.target.closest ? ev.target.closest(".more") : null;
    if (moreBtn) {
      var card = moreBtn.closest(".card");
      var c = card ? card.querySelector(".content") : null;
      if (c) { var folded = c.classList.toggle("fold"); moreBtn.textContent = folded ? T("more") : T("less"); }
      return;
    }
    var copyBtn = ev.target.closest ? ev.target.closest(".copy") : null;
    if (copyBtn) { doCopy(copyBtn.getAttribute("data-code"), copyBtn); return; }
    var btn = ev.target.closest ? ev.target.closest(".del") : null;
    if (!btn) return;
    var id = btn.getAttribute("data-id");
    fetch("/api/messages/" + id, { method: "DELETE" })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.success) { undoToast([parseInt(id, 10)]); load(); } });
  });
  /* 双击收件号直接复制 */
  $("list").addEventListener("dblclick", function (ev) {
    var el = ev.target.closest ? ev.target.closest(".recv") : null;
    if (!el) return;
    var text = el.textContent;
    var fin = function () { toast(T("recvCopied")); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(fin, function () { fallbackCopy(text); fin(); });
    } else { fallbackCopy(text); fin(); }
  });
  /* ---------- 批量选择 / 清空 / 主题 / 无障碍 ---------- */
  function setSelectMode(on) {
    state.selectMode = !!on;
    document.body.classList.toggle("selecting", state.selectMode);
    $("selbar").hidden = !state.selectMode;
    $("selectbtn").textContent = state.selectMode ? T("done") : T("select");
    if (!state.selectMode) state.selected = {};
    syncSelBoxes();
    updateSelBar();
  }
  $("selectbtn").onclick = function () { setSelectMode(!state.selectMode); };
  $("selcancel").onclick = function () { setSelectMode(false); };
  $("selall").onclick = function () {
    var boxes = $("list").querySelectorAll(".selbox");
    var allOn = boxes.length > 0, i;
    for (i = 0; i < boxes.length; i++) if (!boxes[i].checked) { allOn = false; break; }
    for (i = 0; i < boxes.length; i++) {
      boxes[i].checked = !allOn;
      var id = boxes[i].getAttribute("data-id");
      if (!allOn) state.selected[id] = true; else delete state.selected[id];
    }
    updateSelBar();
  };
  $("seldel").onclick = function () {
    var ids = Object.keys(state.selected).map(function (k) { return parseInt(k, 10); }).filter(function (n) { return n > 0; });
    if (!ids.length) return;
    if (!confirm(T("confirmDelN", { n: ids.length }))) return;
    fetch("/api/messages/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: ids }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.success) { setSelectMode(false); undoToast(ids); load(); } });
  };
  $("list").addEventListener("change", function (ev) {
    var box = ev.target.closest ? ev.target.closest(".selbox") : null;
    if (!box) return;
    var id = box.getAttribute("data-id");
    if (box.checked) state.selected[id] = true; else delete state.selected[id];
    updateSelBar();
  });
  $("clearbtn").onclick = function () {
    var scope = state.device ? T("scopeDevice") : (state.src || state.range || state.q ? T("scopeFilter") : T("scopeAll"));
    if (!confirm(T("confirmClear", { scope: scope }))) return;
    if (!confirm(T("confirmClear2", { scope: scope }))) return;
    fetch("/api/messages/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: state.device, source: state.src, range: state.range, q: state.q }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.success) { toast(T("clearedN", { n: d.removed })); state.selected = {}; load(); } });
  };
  /* 主题三态：auto → light → dark */
  var THEMES = ["auto", "light", "dark"];
  function currentTheme() { try { return localStorage.getItem("sms_theme") || "auto"; } catch (e) { return "auto"; } }
  function applyTheme(t) {
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    $("themebtn").textContent = t === "auto" ? T("themeAuto") : (t === "light" ? T("themeLight") : T("themeDark"));
  }
  (function initTheme() {
    var t = currentTheme(); if (THEMES.indexOf(t) === -1) t = "auto";
    applyTheme(t);
    $("themebtn").onclick = function () {
      var cur = currentTheme(); if (THEMES.indexOf(cur) === -1) cur = "auto";
      var next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
      try { localStorage.setItem("sms_theme", next); } catch (e) {}
      applyTheme(next);
    };
  })();
  /* 键盘：/ 聚焦搜索；Esc 退出批量选择 */
  document.addEventListener("keydown", function (e) {
    var tag = (e.target && e.target.tagName) || "";
    var typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if (e.key === "/" && !typing) { e.preventDefault(); $("q").focus(); }
    if (e.key === "Escape" && state.selectMode) { setSelectMode(false); }
  });
  /* 收藏 / 未读筛选 + 头部按钮 + 弹层 + PWA + 搜索历史 */
  $("staronly").onclick = function () { state.starOnly = !state.starOnly; $("staronly").classList.toggle("on", state.starOnly); state.page = 1; load(); };
  $("unreadonly").onclick = function () { state.unreadOnly = !state.unreadOnly; $("unreadonly").classList.toggle("on", state.unreadOnly); state.page = 1; load(); };
  $("statsbtn").onclick = openStats;
  $("setbtn").onclick = openSettings;
  $("modalx").onclick = closeModal;
  $("modal").addEventListener("click", function (ev) { if (ev.target === $("modal")) closeModal(); });
  loadQHist();
  registerSW();
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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="format-detection" content="telephone=no">
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
         justify-content: center; min-height: 100vh; min-height: 100dvh;
         padding: calc(16px + env(safe-area-inset-top, 0px)) 16px calc(16px + env(safe-area-inset-bottom, 0px));
         -webkit-text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; }
  .box { background: var(--card); border: 1px solid var(--border); border-radius: 12px;
         padding: 28px 24px; width: 100%; max-width: 320px; text-align: center; position: relative; }
  h1 { font-size: 17px; margin-bottom: 16px; word-break: break-word; }
  input { width: 100%; padding: 11px 12px; border: 1px solid var(--input-border); border-radius: 8px;
          font-size: 16px; margin-bottom: 10px; background: var(--card); color: var(--text); }
  button#go { width: 100%; padding: 11px 0; border: none; border-radius: 8px; background: #15803d;
           color: #fff; font-size: 15px; cursor: pointer; touch-action: manipulation; }
  button#go:hover { background: #116632; }
  button#go:disabled { opacity: .6; }
  .err { color: #b91c1c; font-size: 12px; min-height: 18px; margin-top: 8px; }
  .langbtn { position: absolute; top: 8px; right: 10px; border: 1px solid var(--border); background: none;
             color: var(--muted, #6b7280); border-radius: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer; }
  .foot { color: var(--faint, #9aa3ab); font-size: 12px; margin-top: 14px; }
  .foot a { color: var(--faint, #9aa3ab); }
</style>
</head>
<body>
<div class="box">
  <button class="langbtn" id="langbtn" type="button">EN</button>
  <h1>__SITE_NAME__</h1>
  <input type="password" id="pw" data-i18n-ph="loginPw" placeholder="管理密码" autofocus autocomplete="current-password">
  <button id="go" data-i18n="loginBtn">登 录</button>
  <div class="err" id="err"></div>
  <div class="foot">© 2026 <a href="https://cbm.im/" target="_blank" rel="noopener noreferrer">左立方</a> · <a href="https://github.com/ShenDoyle/SMSToWeb" target="_blank" rel="noopener noreferrer">SMSToWeb</a></div>
</div>
<script>
(function () {
  /* 登录页中英双语：语言探测与主页面一致（?lang > localStorage > 浏览器语言） */
  var LANG = (function () {
    var v = "";
    try { v = String(new URLSearchParams(location.search).get("lang") || "").toLowerCase(); } catch (e) {}
    if (v !== "zh" && v !== "en") { try { v = String(localStorage.getItem("sms_lang") || "").toLowerCase(); } catch (e) { v = ""; } }
    if (v !== "zh" && v !== "en") {
      var nav = String(navigator.language || navigator.userLanguage || "").toLowerCase();
      v = nav.indexOf("zh") === 0 ? "zh" : (nav ? "en" : "zh");
    }
    try { localStorage.setItem("sms_lang", v); } catch (e) {}
    return v;
  })();
  var D = {
    zh: { loginPw: "管理密码", loginBtn: "登 录", wrongPw: "密码错误",
          tooMany: "尝试次数过多，请 10 分钟后再试", loginFail: "登录失败", netErr: "网络错误",
          title: " - 登录", btnLang: "EN", tipLang: "Switch to English" },
    en: { loginPw: "Admin password", loginBtn: "Sign in", wrongPw: "Wrong password",
          tooMany: "Too many attempts. Try again in 10 minutes.", loginFail: "Sign-in failed", netErr: "Network error",
          title: " - Sign in", btnLang: "中文", tipLang: "切换到中文" }
  };
  function T(k) { return (D[LANG] && D[LANG][k]) || D.zh[k] || k; }
  function apply() {
    document.documentElement.lang = LANG === "zh" ? "zh-CN" : "en";
    document.title = __SITE_NAME_JSON__ + T("title");
    var ns = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < ns.length; i++) ns[i].textContent = T(ns[i].getAttribute("data-i18n"));
    var ps = document.querySelectorAll("[data-i18n-ph]");
    for (var j = 0; j < ps.length; j++) ps[j].setAttribute("placeholder", T(ps[j].getAttribute("data-i18n-ph")));
    var lb = document.getElementById("langbtn");
    if (lb) { lb.textContent = T("btnLang"); lb.title = T("tipLang"); }
  }
  apply();
  /* 图标回退：SITE_ICON 设置了但加载失败时，自动换回默认图标 */
  (function () {
    var l = document.querySelector('link[rel="icon"]'); if (!l) return;
    var def = __DEFAULT_ICON_JSON__;
    if (!def || l.getAttribute("href") === def) return;
    var img = new Image();
    img.onerror = function () { l.href = def; };
    img.src = l.getAttribute("href");
  })();
  (function () {
    var b = document.getElementById("langbtn");
    if (b) b.onclick = function () {
      var next = LANG === "zh" ? "en" : "zh";
      try { localStorage.setItem("sms_lang", next); } catch (e) {}
      try {
        var u = new URL(location.href);
        u.searchParams.set("lang", next);
        location.replace(u.toString());
      } catch (e) { location.reload(); }
    };
  })();
  var pw = document.getElementById("pw");
  var err = document.getElementById("err");
  var go = document.getElementById("go");
  var busy = false;
  function tryLogin() {
    if (busy) return;
    busy = true; go.disabled = true; err.textContent = "";
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw.value })
    }).then(function (r) { return r.json(); }).then(function (d) {
      busy = false; go.disabled = false;
      if (d && d.success) { location.reload(); return; }
      err.textContent = d && d.error === "wrong password" ? T("wrongPw")
        : d && d.error === "too many attempts" ? T("tooMany")
        : T("loginFail");
    }).catch(function () { busy = false; go.disabled = false; err.textContent = T("netErr"); });
  }
  go.onclick = tryLogin;
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
  const purged = await env.DB.prepare(
    `DELETE FROM messages WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-7 days')`
  ).run();
  console.log(`[cron] cleaned ${res.meta ? res.meta.changes : 0} old, purged ${purged.meta ? purged.meta.changes : 0} deleted`);
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

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...CORS } });

    try {
      /* 登录开关：开启后，除推送接口与登录/登出外，页面与管理 API 均需登录 */
      const isPage = path === "/" || path === "/index.html";
      const isPublicApi = path === "/api/receive" || path === "/api/push" || path === "/api/login" || path === "/api/logout" ||
        path === "/manifest.webmanifest" || path === "/sw.js";
      if (!isPublicApi && !(await isAuthed(request, env))) {
        if (isPage && request.method === "GET") {
          return new Response(renderHtml(LOGIN_HTML, env), {
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS },
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
      /* 定时清理 HTTP 触发（与移植平台入口级 /api/cron 行为一致）：
         Cloudflare 平台 cron 之外，也允许外部调度器调 GET /api/cron?token=<RECEIVE_TOKEN> 触发 */
      if (path === "/api/cron" && request.method === "GET") {
        const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
        const provided = url.searchParams.get("token") || bearer;
        if (!env.RECEIVE_TOKEN || !provided || !safeEqual(provided, env.RECEIVE_TOKEN)) {
          return json({ success: false, error: "unauthorized" }, 403);
        }
        await handleCron(env);
        return json({ success: true });
      }
      if (path === "/api/messages" && request.method === "GET") {
        return await handleListMessages(url, env);
      }
      if (path === "/api/export" && request.method === "GET") {
        return await handleExport(url, env);
      }
      if (path === "/api/messages/remove" && request.method === "POST") {
        return await handleRemoveMessages(request, env);
      }
      if (path === "/api/messages/restore" && request.method === "POST") {
        return await handleRestoreMessages(request, env);
      }
      if (path === "/api/messages/clear" && request.method === "POST") {
        return await handleClearMessages(request, env);
      }
      if (path === "/api/messages/star" && request.method === "POST") {
        return await handleStarMessage(request, env);
      }
      if (path === "/api/messages/read" && request.method === "POST") {
        return await handleReadMessage(request, env);
      }
      if (path === "/api/stats" && request.method === "GET") {
        return await handleStats(env);
      }
      if (path === "/manifest.webmanifest" && request.method === "GET") {
        return handleManifest(env);
      }
      if (path === "/sw.js" && request.method === "GET") {
        return handleSW();
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
      if (path === "/api/phone" && request.method === "GET") {
        return await handlePhoneArea(url, env);
      }
      if ((path === "/" || path === "/index.html") && request.method === "GET") {
        return new Response(renderHtml(PAGE_HTML, env), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS },
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
