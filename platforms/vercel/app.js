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
 *   （Secret）RECEIVE_TOKEN   — 推送鉴权兜底（/api/receive 与 /api/push 共用；库内令牌优先，
 *       迁移期环境变量继续有效；DISABLE_RECEIVE_TOKEN="true" 停用兜底、只认库内令牌）
 *   （Secret）ADMIN_PASSWORD  — 登录密码（仅 ENABLE_AUTH="true" 时需要；登录连续失败 5 次锁 10 分钟）
 *   （Secret）SESSION_SECRET  — 登录会话签名密钥（高熵随机值，与密码独立；ENABLE_AUTH="true" 时
 *       必须配置，缺失则登录与鉴权安全失败；轮换即全部会话失效重新登录）
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
/* 应用版本号：正式版发布固定版号，非正式版一般以小版本号递增升级；管理页/登录页底部页脚展示 */
const APP_VERSION = "v1.0.4";

/* 把页面模板中的占位标记替换为实际配置值（用函数替换器，避免值里含 $& 等特殊序列被误解释） */
function renderHtml(html, env) {
  return html
    .replace(/__SITE_NAME__/g, function () { return escAttr(siteName(env)); })
    .replace(/__SITE_NAME_JSON__/g, function () { return jsStr(siteName(env)); })
    .replace(/__SITE_ICON__/g, function () { return escAttr(siteIcon(env)); })
    .replace(/__DEFAULT_ICON_JSON__/g, function () { return jsStr(DEFAULT_SITE_ICON); })
    .replace(/__APP_VERSION__/g, function () { return escAttr(APP_VERSION); });
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

/* ---------------- 结构化日志（阶段 1-2 MVP） ----------------
   单行 JSON，固定字段：timestamp / level / event / requestId / platform / phase（阶段），
   按需附 error{name,message,stack} 等附加字段。原则：
   ① requestId 由服务端生成，绝不读取客户端同名请求头；
   ② 堆栈只进服务端日志，绝不进错误响应；
   ③ 手机号、令牌、Cookie、Authorization、短信内容在写日志前脱敏；
   ④ 序列化或输出的任何失败都吞掉，绝不影响业务。 */
function newRequestId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  } catch (_) { /* 退化到时间戳+随机数 */ }
  return "rid-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
const LOG_PHONE_RE = /(^|\D)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g;
const LOG_TOKEN_TEXT_RE = /(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._-]+|(bearer\s+)[A-Za-z0-9._-]+|\b(token|secret|password|authorization)\b(\s*[:=]\s*|\s+)[A-Za-z0-9._@/-]{4,}|(cookie\s*[:=]\s*)[^\s;,]+|((?:access_)?token=)[^&\s]+/gi;
const LOG_SENSITIVE_KEY_RE = /(token|cookie|authorization|secret|password|api.?key)/i;
const LOG_CONTENT_KEY_RE = /^(content|text|body|msg|message)$/i;
function logMaskText(s) {
  return String(s)
    .replace(LOG_PHONE_RE, "$1$2****$3")
    .replace(LOG_TOKEN_TEXT_RE, function (m, authBearer, bearer, kw, sep, cookie, qs) { return (authBearer || bearer || cookie || qs || (kw ? kw + sep : "")) + "***"; });
}
function logSafeValue(value, key, depth) {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (key && LOG_SENSITIVE_KEY_RE.test(String(key))) return "***";
  if (typeof value === "object") {
    if (depth > 3) return "[deep]";
    const out = {}; let n = 0;
    for (const k of Object.keys(value)) { if (++n > 32) break; out[k] = logSafeValue(value[k], k, (depth || 0) + 1); }
    return out;
  }
  let s = logMaskText(String(value));
  if (key && LOG_CONTENT_KEY_RE.test(String(key)) && s.length > 64) s = s.slice(0, 64) + "…";
  return s;
}
function logErrorInfo(err) {
  /* 只做结构提取与堆栈截断，不在此脱敏——logEvent 的 logSafeValue 会对每个字段统一脱敏一次，
     重复脱敏会把 "Authorization: Bearer ***" 二次破坏成 "Authorization: *** ***" */
  const info = {};
  try { info.name = String((err && err.name) || "Error"); } catch (_) { info.name = "Error"; }
  try { info.message = String((err && err.message !== undefined) ? err.message : err); } catch (_) { info.message = "(unreadable)"; }
  try { if (err && err.stack) info.stack = String(err.stack).split("\n").slice(0, 8).join("\n"); } catch (_) { /* 堆栈读取失败忽略 */ }
  return info;
}
function logEvent(level, event, phase, env, requestId, fields) {
  try {
    const rec = {
      timestamp: new Date().toISOString(),
      level: String(level || "info"),
      event: String(event || "-"),
      requestId: String(requestId || "-"),
      platform: String((env && env.PLATFORM) || "cloudflare"),
      phase: String(phase || "-"),
    };
    if (fields) { let n = 0; for (const k of Object.keys(fields)) { if (++n > 32) break; rec[k] = logSafeValue(fields[k], k, 0); } }
    let line;
    try { line = JSON.stringify(rec); }
    catch (_) {
      try { line = JSON.stringify({ timestamp: rec.timestamp, level: rec.level, event: rec.event, requestId: rec.requestId, platform: rec.platform, phase: rec.phase, logError: "serialize failed" }); }
      catch (_) { return; }
    }
    try {
      if (rec.level === "error") console.error(line);
      else if (rec.level === "warn") console.warn(line);
      else console.log(line);
    } catch (_) { /* 输出失败不影响业务 */ }
  } catch (_) {
    try { console.error("log_event_failed:" + event); } catch (_) { /* 彻底放弃 */ }
  }
}

/* 开关是否处于开启状态（仅字符串 "true" 视为开启）。
   安全策略：开关开启即视为鉴权生效——ADMIN_PASSWORD 缺失/为空时不免登录放行，
   受保护接口一律拒绝（isAuthed）、登录接口返回服务端配置错误（handleLogin），
   仅输出不含敏感值的一次性告警；避免"配置缺失被解释为关闭鉴权"的放行风险 */
let warnedAuthNoPw = false;
function authEnabled(env) {
  if (String(env.ENABLE_AUTH || "").trim().toLowerCase() !== "true") return false;
  if (!String(env.ADMIN_PASSWORD || "")) {
    if (!warnedAuthNoPw) {
      warnedAuthNoPw = true;
      logEvent("warn", "auth_config_incomplete", "config", env, "-", { message: "ENABLE_AUTH=true 但未设置 ADMIN_PASSWORD：管理接口已全部拒绝访问，配置密码并配置 SESSION_SECRET 后恢复登录" });
    }
  }
  return true;
}

/* 无状态签名 Session：nonce(128 位 CSPRNG) + exp + HMAC-SHA256 签名。
   - 验证只依赖 Token 内容、密钥与当前时间，任何 Worker 实例/节点/冷启动后均可独立验证，
     无进程内会话状态，多实例/边缘部署天然一致；
   - HMAC 密钥来自独立高熵环境变量 SESSION_SECRET（与登录密码完全解耦）；
   - SESSION_SECRET 未配置时安全失败：拒绝签发与验证（登录返回 500、鉴权一律 401），
     绝不静默回退到 ADMIN_PASSWORD 派生——防止"密码即密钥"的离线爆破面；
   - 退出为无状态语义：/api/logout 仅清除浏览器 Cookie；已复制的有效 Token 在 TTL 内
     （默认 30 分钟；浏览器可独立设置，全局设置为回退默认，最长 30 天）仍可重放；
     更换 SESSION_SECRET 或 ADMIN_PASSWORD 前者使旧签名立即失效 */
const SESSION_TTL_MS = 30 * 60 * 1000;

/* 会话时长（分钟）：优先级为 登录请求声明（浏览器独立配置，存浏览器 localStorage）>
   settings 表全局默认（键 session_ttl_minutes，作为回退/兼容策略）> 内置默认 30。
   合法范围 5 ~ 43200（30 天）；全局缺表/缺行/库异常/非法值一律回退默认（登录低频，每次现查不加缓存）。
   每 Token exp 按签发时确定独立生效：改一个浏览器的配置不影响其他浏览器，也不会延长已签发会话。 */
const SESSION_TTL_DEFAULT_MIN = 30;
const SESSION_TTL_MIN_MIN = 5;
const SESSION_TTL_MAX_MIN = 43200;
async function getSessionTtlMinutes(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'session_ttl_minutes'").first();
    const n = Number(row && row.value);
    /* 兼容旧部署把 3600（秒）当成分钟保存：按默认 30 分钟生效 */
    if (n === 3600) return SESSION_TTL_DEFAULT_MIN;
    if (Number.isInteger(n) && n >= SESSION_TTL_MIN_MIN && n <= SESSION_TTL_MAX_MIN) return n;
  } catch (e) { /* 缺表或库异常 → 回退默认值 */ }
  return SESSION_TTL_DEFAULT_MIN;
}

let sessionKeyCache = null, sessionKeyRaw = null;
/* 派生 HMAC 密钥；SESSION_SECRET 缺失 → 返回 null（调用方安全失败）。缓存按密钥指纹键控，轮换即生效 */
async function sessionHmacKey(env) {
  const secret = String(env.SESSION_SECRET || "").trim();
  if (!secret) return null;
  if (!sessionKeyCache || sessionKeyRaw !== secret) {
    sessionKeyCache = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    sessionKeyRaw = secret;
  }
  return sessionKeyCache;
}

async function sessionSign(env, nonce, exp) {
  const key = await sessionHmacKey(env);
  if (!key) return ""; /* 无密钥 → 空签名，签发/验证双方都会安全失败 */
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(nonce + "." + exp));
  let s = "";
  for (const b of new Uint8Array(sig)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* 严格结构 + 签名校验：返回 { nonce, exp } 或 null（篡改/格式错/密钥不符一律 null） */
async function sessionParse(env, token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const nonce = parts[0], expStr = parts[1], sig = parts[2];
  if (!/^[0-9a-f]{32}$/.test(nonce) || !/^\d{10,15}$/.test(expStr)) return null;
  const expect = await sessionSign(env, nonce, expStr);
  if (!expect || !safeEqual(sig, expect)) return null;
  return { nonce: nonce, exp: Number(expStr) };
}

/* 登录成功签发：随机 nonce + 过期时间 + HMAC 签名（无任何服务端登记）。
   ttlMs：会话时长毫秒数，由登录入口按 settings 表现查传入；非法/缺省回退默认 30 分钟 */
async function createSession(env, ttlMs) {
  const key = await sessionHmacKey(env);
  if (!key) return null; /* SESSION_SECRET 未配置 → 安全失败，拒绝签发 */
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let nonce = "";
  for (const b of bytes) nonce += b.toString(16).padStart(2, "0");
  const exp = Date.now() + (typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : SESSION_TTL_MS);
  return nonce + "." + exp + "." + (await sessionSign(env, nonce, String(exp)));
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

/* 管理接口/页面统一鉴权：开关关闭直接放行；开启则无状态校验随机 Session（严格验签 + 过期） */
async function isAuthed(request, env) {
  if (!authEnabled(env)) return true;
  if (!env.ADMIN_PASSWORD) return false; /* 开启登录但未设密码 → 一律拒绝（安全默认） */
  const sess = await sessionParse(env, getCookie(request, AUTH_COOKIE));
  if (!sess) return false; /* 缺失/篡改/签名不符/密钥未配置 */
  return sess.exp > Date.now(); /* 过期 → 重新登录 */
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
  rec.at = Date.now();
  if (rec.count >= LOGIN_FAIL_LIMIT) {
    rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
    rec.count = 0;
  }
  loginFails.set(ip, rec);
  if (loginFails.size > 1000) { /* 防 Map 无限膨胀：只清过期锁与陈旧计数 */
    const now = Date.now();
    /* lockedUntil<=now 会把未锁定记录（lockedUntil=0）一并误删，导致高基数 IP 池下
       当前 IP 的失败计数被反复清零、永远无法触发锁定 */
    for (const [k, v] of loginFails) {
      if (v.lockedUntil && v.lockedUntil <= now) loginFails.delete(k);
      else if (!v.lockedUntil && now - (v.at || 0) > LOGIN_LOCK_MS) loginFails.delete(k);
    }
  }
}

async function handleLogin(request, env) {
  if (!authEnabled(env)) return json({ success: false, error: "auth disabled" }, 400);
  if (!env.ADMIN_PASSWORD) {
    /* 开关开启但密码未配置：服务端配置错误（区别于普通密码错误 403），不泄露敏感值，不记失败限流 */
    return json({ success: false, error: "server auth not configured" }, 500);
  }
  if (loginLocked(request)) return json({ success: false, error: "too many attempts" }, 429);
  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: "invalid json" }, 400); }
  const pw = body && body.password !== undefined ? String(body.password) : "";
  if (!pw || !safeEqual(pw, env.ADMIN_PASSWORD)) {
    recordLoginFail(request);
    return json({ success: false, error: "wrong password" }, 403);
  }
  clearLoginFail(request);
  /* 会话时长优先级：登录请求声明（浏览器独立配置）> settings 表全局默认 > 内置默认 30 分钟。
     请求声明了非法值 → 400 INVALID_TTL 不签发会话（已签发会话不受影响）；未声明/为 null → 现查 settings 回退。
     每 Token exp 独立确定、不可延长：修改某浏览器配置只影响该浏览器之后的登录。 */
  let ttlMin;
  if (body && body.session_ttl_minutes !== undefined && body.session_ttl_minutes !== null) {
    const declared = body.session_ttl_minutes;
    if (!Number.isInteger(declared) || declared < SESSION_TTL_MIN_MIN || declared > SESSION_TTL_MAX_MIN) {
      return json({ success: false, error: "INVALID_TTL" }, 400);
    }
    ttlMin = declared;
  } else {
    ttlMin = await getSessionTtlMinutes(env);
  }
  const ttlMs = ttlMin * 60 * 1000;
  const token = await createSession(env, ttlMs);
  if (!token) return json({ success: false, error: "session secret not configured" }, 500);
  return new Response(JSON.stringify({ success: true }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": authCookieHeader(request, token, ttlMs / 1000),
      ...SECURITY_HEADERS, ...CORS,
    },
  });
}

function clearLoginFail(request) { loginFails.delete(clientIp(request)); }

/* 登录态探测（公开接口）：前端据此决定重要操作是否需要密码确认。
   只返回布尔，不泄露密码是否存在以外的任何配置 */
function handleAuthState(env) {
  return json({ success: true, required: authEnabled(env) && !!env.ADMIN_PASSWORD }, 200);
}

/* 重要操作密码确认：校验输入是否为登录密码（复用登录失败限流，防在线爆破）。
   只做确认，不签发/延长会话；未开启登录时直接放行（required:false） */
async function handleVerifyPassword(request, env) {
  if (!authEnabled(env)) return json({ success: true, required: false }, 200);
  if (!env.ADMIN_PASSWORD) return json({ success: false, error: "server auth not configured" }, 500);
  if (loginLocked(request)) return json({ success: false, error: "too many attempts" }, 429);
  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: "invalid json" }, 400); }
  const pw = body && body.password !== undefined ? String(body.password) : "";
  if (!pw || !safeEqual(pw, env.ADMIN_PASSWORD)) {
    recordLoginFail(request);
    return json({ success: false, error: "wrong password" }, 403);
  }
  clearLoginFail(request);
  return json({ success: true, required: true }, 200);
}

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

async function handleLogout(request, env) {
  /* 无状态退出：仅清除浏览器 Cookie；已签发 Token 在 TTL（默认 30 分钟，浏览器独立设置/全局默认可调，最长 30 天）内仍可重放，
     更换 SESSION_SECRET / ADMIN_PASSWORD 可立即使旧 Token 验签失败 */
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
 * 全部渠道变量未配置时不发任何请求。消息按「验证码/短信/通知」三态渲染（各渠道样式经统一设计，
 * 服务端共用一次精简验证码检测）。渠道与变量清单一览：
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
 *               占位符 {{title}}/{{content}}/{{time}}/{{source}}/{{sender}}/{{device}}/{{type}}/{{code}}；
 *               可选 GENERIC_WEBHOOK_HEADERS 自定义请求头，JSON 对象字符串，
 *               如 {"Authorization":"Bearer xxx","X-Api-Key":"yyy"}）
 *   跳转        NOTIFY_LINK（可选：站点首页地址；配置后各渠道卡片/消息附「打开管理页」入口，
 *               未配置则各渠道自动省略对应元素）
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

/* 服务端精简验证码检测（与前端 extractCode 的七级级联合同语义，供列表卡片 code 字段与通知三态共用）：
 * ① 码在前（必须先于关键词在前——防「123456是您的验证码，您有2000积分」取 2000）
 * ② 关键词在前：a.分隔码（防 1234 5678 被截断成 1234） b.紧邻数字（非数字间隔 ≤8）
 * ③ Google 风格 G-123456；④ 字母数字混合码；⑤ 剥离干扰后唯一数字兜底。
 * 中文 / 英文 / 中英混合关键词同一套规则；检测前剥离手机号/日期/时间/金额/单号等干扰串。
 * 说明：列表中 slim 模式不回传正文，前端只能依赖本函数返回的 code，因此规则必须与前端
 * extractCode 保持同级联顺序（本轮仅把前端已有的英文关键词与边界规则移植过来，未改算法结构）。 */
function extractCodeLite(content) {
  const s0 = String(content || "");
  if (!s0) return "";
  const KW = "验证码|校验码|检验码|确认码|激活码|动态码|动态密码|动态口令|授权码|安全码|随机码|认证码|取件码|提货码|登录码|驗證碼|校驗碼|認證碼|verification\\s*code|security\\s*code|confirmation\\s*code|access\\s*code|auth(?:entication)?\\s*code|login\\s*code|one[-\\s]?time\\s*(?:code|password)|pass\\s*code|passcode|2fa|otp";
  let s = String(s0 || "").replace(/\s+/g, " ");
  if (!new RegExp("(?:" + KW + ")", "i").test(s)) return "";
  s = s
    .replace(/\+?\d[\d-]{7,11}\d/g, " ")                                    /* 手机号/座机（9~13 位数字串） */
    .replace(/\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?/g, " ")                  /* 日期（2026-10-27 / 2026年10月27日） */
    .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, " ")                             /* 日期（10/27/2026） */
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, " ")                              /* 时间 */
    .replace(/[¥￥$€£]\s*\d+(?:\.\d+)?\s*(?:元|USD|EUR)?/gi, " ")            /* 金额（¥2000 / $20.00） */
    .replace(/\d+(?:\.\d+)?\s*(?:元|块钱|人民币)/g, " ")                     /* 金额（2000元） */
    .replace(/(?:订单|工单|账单|流水|参考|凭证|编号)[号码]?[:：#]?\s*[A-Za-z0-9-]{4,}/g, " ")
    .replace(/(?:快递|运单|取件)[号码]?[:：#]?\s*[A-Za-z0-9-]{6,}/g, " ")
    .replace(/(?:order|invoice|reference|ref|transaction|txn|ticket)\s*(?:no\.?|number|#|id)?\s*[:：#]?\s*[A-Za-z0-9-]{4,}/gi, " ")
    .replace(/(?:tracking|waybill)\s*(?:no\.?|number|#|id)?\s*[:：#]?\s*[A-Za-z0-9-]{6,}/gi, " ")
    /* 明确非验证码语境的数字：错误码/状态码、时长/年份、客服热线 */
    .replace(/(?:错误|失败|状态|响应|业务|故障|返回)[代码号]*\s*[:：]?\s*\d{4,8}/g, " ")
    .replace(/(?:error|status|response|result|failure)\s*code\s*[:#]?\s*\d{4,8}/gi, " ")
    .replace(/\d{4,8}\s*(?:秒|分钟|小时|天|年|个月|周)/g, " ")
    .replace(/(?:拨打|致电|客服电话|客服|热线|电话)\s*[:：]?\s*\d{4,8}/g, " ");
  let m;
  /* ① 码在前（中文）：123456…验证码 */
  m = s.match(/(?:^|[^0-9A-Za-z])(\d{4,8})(?![0-9])[^\dA-Za-z]{0,4}(?:是您?的|是你?的|为你?的|的)?(?:登录|注册|支付|校验|身份)?(?:验证码|校验码|检验码|确认码|认证码|激活码|动态密码|动态码|授权码|安全码)/);
  if (m) return m[1];
  /* ① 码在前（英文）：918204 is your verification code / 483920 as your OTP */
  m = s.match(/(?:^|[^0-9A-Za-z])(\d{4,8})(?![0-9])[^\dA-Za-z]{0,8}(?:is\s+|as\s+)?(?:your\s+|the\s+)?(?:verification|security|confirmation|access|auth(?:entication)?|login|one[-\s]?time|otp|2fa)\s*(?:code|password)?/i);
  if (m) return m[1];
  /* ②a 关键词在前 + 分隔码：验证码 1234 5678 / 取件码 8-2-307（2~3 段） */
  m = new RegExp("(?:" + KW + ")[^\\d]{0,10}?(\\d{1,4}(?:[ -]\\d{1,4}){1,2})(?![0-9])", "i").exec(s);
  if (m) return m[1].replace(/[- ]/g, "");
  /* ②a2 关键词在前 + 两段码（兼容仅两段的分隔写法） */
  m = new RegExp("(?:" + KW + ")[^\\d]{0,10}?(\\d{3,4})[ -](\\d{3,4})(?![0-9])", "i").exec(s);
  if (m) return m[1] + m[2];
  /* ②b 关键词在前 + 紧邻数字：验证码…123456 / verification code is 918204 */
  m = new RegExp("(?:" + KW + ")[^\\d]{0,12}?(?:is\\s+)?(?:\\d{3,4}[ -])?(\\d{4,8})(?![0-9])", "i").exec(s);
  if (m) return m[1];
  /* ③ Google 风格：G-123456 */
  m = s.match(/[Gg]-(\d{3,8})(?![0-9])/);
  if (m) return m[1];
  /* ④ 字母数字混合（须同时含字母与数字；右侧不得紧贴字母数字） */
  m = new RegExp("(?:" + KW + ")[^0-9A-Za-z]{0,4}([0-9A-Za-z]{4,8})(?![0-9A-Za-z])", "i").exec(s);
  if (m && /[0-9]/.test(m[1]) && /[A-Za-z]/.test(m[1])) return m[1];
  /* ⑤ 无法确定 → 空串。正文里出现验证码关键词但没有任何“码在前/码在后”的关联时，
     孤立的 4–8 位数字可能是错误代码、订单号、年份、时长等，不能当作验证码返回。 */
  return "";
}

/* ---------------- 通知配置中心（PERF25：settings 表持久化，环境变量仅作旧配置兜底） ----------------
   键设计：全部通知配置使用 `notify.` 前缀，一次前缀范围查询即可取回整组配置；
   `notify.enabled` / `notify.types` / `notify.retry` / `notify.link` 为全局规则，
   `notify.<渠道>.<字段>` 为渠道配置，`notify.<渠道>.enabled` 为渠道开关。

   旧配置兼容：数据库无该键 → 回退环境变量（当前部署行为不变）；数据库存在该键（含空串）
   → 以数据库为准，空串即「已明确清除」，不再回退环境变量。登录密码、鉴权密钥等安全凭据
   继续只走环境变量，不迁入数据库。

   敏感字段（Webhook URL / Token / Secret / 自定义请求头等）只在管理 API 返回「是否已配置 +
   末 4 位脱敏」，日志与错误信息不打印完整值。 */
const NOTIFY_KEY_PREFIX = "notify.";
/* ASCII '.'(46) < '/'(47)：范围查询 [notify., notify/) 覆盖全部 notify.* 键且不含其他键 */
const NOTIFY_KEY_END = "notify/";
const NOTIFY_TYPES = ["verify", "sms", "notify"];
const NOTIFY_RETRY_MAX = 3;
/* 接收类型规范化：去重并按固定顺序返回；无有效项 → null（调用方决定拒绝或回退默认） */
function normalizeNotifyTypeList(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw === undefined || raw === null ? "" : raw).split(",");
  const list = arr.map(function (s) { return String(s).trim(); })
    .filter(function (t) { return NOTIFY_TYPES.indexOf(t) !== -1; });
  const uniq = NOTIFY_TYPES.filter(function (t) { return list.indexOf(t) !== -1; });
  return uniq.length ? uniq : null;
}

/* 渠道定义：字段 → 旧环境变量名 / 是否敏感；need 为「已配置」判定所需字段 */
const NOTIFY_CHANNELS = {
  feishu: { label: "飞书", need: ["webhook"], fields: {
    webhook: { env: "FEISHU_WEBHOOK", sensitive: true },
    secret: { env: "FEISHU_SECRET", sensitive: true },
  } },
  wecom: { label: "企业微信", need: ["webhook"], fields: {
    webhook: { env: "WECOM_WEBHOOK", sensitive: true },
  } },
  dingtalk: { label: "钉钉", need: ["webhook"], fields: {
    webhook: { env: "DINGTALK_WEBHOOK", sensitive: true },
    secret: { env: "DINGTALK_SECRET", sensitive: true },
  } },
  serverchan: { label: "Server酱", need: ["sendkey"], fields: {
    sendkey: { env: "SERVERCHAN_SENDKEY", sensitive: true },
  } },
  pushplus: { label: "PushPlus", need: ["token"], fields: {
    token: { env: "PUSHPLUS_TOKEN", sensitive: true },
  } },
  telegram: { label: "Telegram", need: ["bot_token", "chat_id"], fields: {
    bot_token: { env: "TELEGRAM_BOT_TOKEN", sensitive: true },
    chat_id: { env: "TELEGRAM_CHAT_ID" },
  } },
  bark: { label: "Bark", need: ["device_key"], fields: {
    device_key: { env: "BARK_DEVICE_KEY", sensitive: true },
    url: { env: "BARK_URL" },
  } },
  ntfy: { label: "ntfy", need: ["url"], fields: {
    /* ntfy 主题 URL 本身即凭据（知道主题即可订阅/发布）→ 按敏感字段脱敏 */
    url: { env: "NTFY_URL", sensitive: true },
    token: { env: "NTFY_TOKEN", sensitive: true },
  } },
  gotify: { label: "Gotify", need: ["url", "token"], fields: {
    url: { env: "GOTIFY_URL" },
    token: { env: "GOTIFY_TOKEN", sensitive: true },
  } },
  resend: { label: "邮件（Resend）", need: ["api_key", "mail_to"], fields: {
    api_key: { env: "RESEND_API_KEY", sensitive: true },
    mail_to: { env: "MAIL_TO" },
    mail_from: { env: "MAIL_FROM" },
  } },
  generic: { label: "通用 Webhook", need: ["urls"], fields: {
    urls: { env: "GENERIC_WEBHOOKS", sensitive: true },
    template: { env: "GENERIC_WEBHOOK_TEMPLATE" },
    headers: { env: "GENERIC_WEBHOOK_HEADERS", sensitive: true },
  } },
};

function parseSettingBool(v, def) {
  const s = String(v === undefined || v === null ? "" : v).trim().toLowerCase();
  if (!s) return def;
  if (s === "true" || s === "1" || s === "on" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "off" || s === "no") return false;
  return def;
}
function notifyFieldKey(channel, field) { return NOTIFY_KEY_PREFIX + channel + "." + field; }
function isNotifyKey(k) { return String(k).indexOf(NOTIFY_KEY_PREFIX) === 0; }
function isReservedSettingsKey(k) { return k === "schema_meta" || k === "settings_rev"; }

/* 单次前缀范围读取（缺表/库异常 → null，调用方全量回退环境变量） */
async function loadNotifyRows(env) {
  try {
    const res = await env.DB.prepare("SELECT key, value FROM settings WHERE key >= ?1 AND key < ?2")
      .bind(NOTIFY_KEY_PREFIX, NOTIFY_KEY_END).all();
    const out = {};
    const rows = (res && res.results) || [];
    for (const r of rows) {
      if (r && r.key !== undefined && r.key !== null) {
        out[String(r.key)] = String(r.value === undefined || r.value === null ? "" : r.value);
      }
    }
    return out;
  } catch (e) { return null; }
}

/* rows → 生效配置（环境变量优先、设置次之；未配置时使用默认值） */
function resolveNotifyConfig(env, rows) {
  const cfg = { enabled: true, types: NOTIFY_TYPES.slice(), retry: 0, link: "", channels: {}, rowsLoaded: !!rows };
  if (rows) {
    if (rows["notify.enabled"] !== undefined) cfg.enabled = parseSettingBool(rows["notify.enabled"], true);
    if (rows["notify.types"] !== undefined) {
      const list = normalizeNotifyTypeList(rows["notify.types"]);
      if (list) cfg.types = list;
    }
    if (rows["notify.retry"] !== undefined) {
      const n = parseInt(rows["notify.retry"], 10);
      if (Number.isInteger(n)) cfg.retry = Math.min(NOTIFY_RETRY_MAX, Math.max(0, n));
    }
    if (rows["notify.link"] !== undefined) cfg.link = String(rows["notify.link"]).trim();
  }
  /* 环境变量与设置同时存在时，环境变量优先（设置作为较低优先级的补充） */
  const envLink = trimEnv(env && env.NOTIFY_LINK);
  if (envLink) cfg.link = envLink;
  for (const name of Object.keys(NOTIFY_CHANNELS)) {
    const spec = NOTIFY_CHANNELS[name];
    const ch = { enabled: true, fields: {}, fromDb: false, fromEnv: false, configured: false };
    if (rows && rows[notifyFieldKey(name, "enabled")] !== undefined) {
      ch.enabled = parseSettingBool(rows[notifyFieldKey(name, "enabled")], true);
    }
    for (const f of Object.keys(spec.fields)) {
      const k = notifyFieldKey(name, f);
      const envVal = trimEnv(env && env[spec.fields[f].env]);
      /* 环境变量优先：同一项两边都有值时以环境变量为准；否则读取设置 */
      if (envVal) {
        ch.fields[f] = envVal;
        ch.fromEnv = true;
      } else if (rows && rows[k] !== undefined) {
        ch.fields[f] = String(rows[k]);
        ch.fromDb = true;
      } else {
        ch.fields[f] = "";
      }
    }
    ch.configured = spec.need.every(function (f) { return !!ch.fields[f]; });
    cfg.channels[name] = ch;
  }
  /* 多目标：notify.targets（JSON 数组，每项 {id,channel,name,enabled,fields}）优先于单目标字段 */
  cfg.targets = [];
  if (rows && rows["notify.targets"] !== undefined) {
    try {
      const arr = JSON.parse(rows["notify.targets"]);
      if (Array.isArray(arr)) {
        cfg.targets = arr.filter(function (t) { return t && NOTIFY_CHANNELS[t.channel]; }).map(function (t) {
          const spec = NOTIFY_CHANNELS[t.channel];
          const fields = {};
          for (const f of Object.keys(spec.fields)) {
            fields[f] = String((t.fields && t.fields[f]) === undefined || (t.fields && t.fields[f]) === null ? "" : t.fields[f]);
          }
          return { id: String(t.id || ""), channel: t.channel, name: String(t.name || "").slice(0, TOKEN_NAME_MAX), enabled: t.enabled !== false,
            /* 旧记录无 types → 默认接收全部类型（向后兼容） */
            types: normalizeNotifyTypeList(t.types) || NOTIFY_TYPES.slice(), fields: fields };
        });
      }
    } catch (e) { cfg.targets = []; }
  }
  return cfg;
}

async function loadNotifyConfig(env) {
  return resolveNotifyConfig(env, await loadNotifyRows(env));
}

/* 错误文本脱敏：绝不把完整 URL（可能含 Token）写进日志或 API 响应 */
function safeNotifyError(e) {
  let s = "";
  try { s = String((e && e.message) || e || "unknown"); } catch (_) { s = "unknown"; }
  s = s.replace(/https?:\/\/\S+/gi, "[url]");
  return s.slice(0, 120);
}

/* 通知失败重试：notify.retry 为额外重试次数（0~3），默认 0 保持既有行为 */
async function postNotifyRetry(cfg, url, headers, body) {
  const retry = Math.min(NOTIFY_RETRY_MAX, Math.max(0, parseInt(cfg && cfg.retry, 10) || 0));
  let last = null;
  for (let i = 0; i <= retry; i++) {
    try { return await postNotify(url, headers, body); }
    catch (e) { last = e; }
  }
  throw last;
}

/* 转发消息归一化：一次验证码检测 + 三态标题，全部渠道共享结果。
 * title 策略（通知栏只显示 title 的渠道与邮件主题共用）：
 *   验证码 → 「🔐 验证码 <码> · <发件方>」；短信 → 「💬 短信 · <发件人>」；通知 → 「🔔 通知 · <应用名>」 */
function buildNotifyInfo(env, msg) {
  const code = extractCodeLite(msg.content);
  const isSms = msg.source === "sms";
  const sender = String(msg.sender || "");
  const info = {
    code: code,
    type: code ? "verify" : (isSms ? "sms" : "notify"),
    link: trimEnv(env && env.NOTIFY_LINK),
    sender: sender,
    device: String(msg.device || ""),
    content: String(msg.content || ""),
    time: String(msg.time || ""),
    source: msg.source || "notify",
    title: "",
  };
  info.title = code
    ? "🔐 验证码 " + code + (sender ? " · " + sender : "")
    : (isSms ? "💬 短信" + (sender ? " · " + sender : "")
             : "🔔 通知" + (sender ? " · " + sender : ""));
  return info;
}

/* 渠道卡片头部文案与配色（三态）：飞书 template / 各渠道标题统一走这里 */
function notifyStyle(info) {
  if (info.type === "verify") return { title: "🔐 验证码提醒", tpl: "violet", label: "验证码提醒" };
  if (info.type === "sms") return { title: "💬 新短信", tpl: "blue", label: "新短信" };
  return { title: "🔔 设备通知", tpl: "turquoise", label: "设备通知" };
}

/* HTML 转义（Telegram / 邮件等 HTML 渠道共用）：只处理 & < > 三个字符 */
function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* 统一纯文本版式（设计稿兜底规范）：HTML/Markdown 不可用或需降级时的统一版式 */
function plainBody(info) {
  const L = [];
  if (info.code) {
    L.push("【" + notifyStyle(info).title + "】" + info.code + "（5 分钟内有效）");
    L.push("来源：" + (info.sender || "-") + (info.device ? " · " + info.device : ""));
  } else {
    L.push(info.title);
    L.push(info.content || "（空内容）");
  }
  L.push("────────────────");
  L.push("🕐 " + (info.time || "-") + (info.device ? " · " + info.device : ""));
  if (info.link) L.push("打开管理页：" + info.link);
  return L.join("\n");
}

/**
 * 把一条已入库消息转发到全部已配置的通知渠道。
 * msg: { title, content, time, source, sender, device }
 * 返回 Promise（配合 ctx.waitUntil 保证 Worker 响应后仍在后台完成发送）。
 */
async function dispatchNotify(env, msg, opts) {
  const mode = opts || {};
  const only = String(mode.only || "");
  const jobs = [];
  const t = trimEnv;
  const info = buildNotifyInfo(env, msg);  /* 验证码检测与跳转链接全渠道只算一次 */
  /* 通知配置只在本函数（消息到达 / 主动推送 / 测试通知）读取：普通请求不加载敏感配置 */
  const cfg = mode.config || await loadNotifyConfig(env);
  /* cfg.link 已是最终生效值：数据库空串表示「已明确清除」，不得再回退环境变量 NOTIFY_LINK */
  info.link = cfg.link;
  if (!only) {
    if (!cfg.enabled) return mode.collect ? [] : undefined;
    if (cfg.types.indexOf(info.type) === -1) return mode.collect ? [] : undefined;
  }
  /* 多目标模式：逐个目标独立发送（单个失败不影响其他目标），复用下面的渠道渲染逻辑。
     多目标只覆盖「自己所属的渠道」：未被目标覆盖的已启用单目标渠道并入同一列表继续发送，
     避免「配了一个多目标就把 Telegram / 企微等单目标渠道整体静默」。 */
  if (cfg.targets && cfg.targets.length && !mode._single) {
    let list = cfg.targets;
    if (only) list = list.filter(function (x) { return x.channel === only; });
    if (mode.target_id) list = list.filter(function (x) { return x.id === String(mode.target_id); });
    if (!mode.target_id) {
      const covered = {};
      list.forEach(function (x) { covered[x.channel] = true; });
      Object.keys(NOTIFY_CHANNELS).forEach(function (nm) {
        const ch = cfg.channels[nm];
        const allowed = only ? only === nm : !!(ch && ch.enabled);
        if (covered[nm] || !allowed) return;
        list = list.concat([{ id: "", channel: nm, name: "", enabled: true, fields: Object.assign({}, ch.fields) }]);
      });
    }
    if (!list.length) return mode.collect ? [] : undefined;
    /* 卡片级接收类型：在全局类型规则之后再按各推送自己的类型过滤（取交集）；
       测试发送（mode._test）绕过规则，便于启用前验证配置 */
    if (!mode._test) list = list.filter(function (x) { return !x.types || x.types.indexOf(info.type) !== -1; });
    if (!list.length) return mode.collect ? [] : undefined;
    const out = [];
    for (const tg of list) {
      const clone = { enabled: true, types: NOTIFY_TYPES.slice(), retry: cfg.retry, link: cfg.link, channels: {}, targets: [] };
      /* 内层按目标自己的类型再判定一次，保证单目标通道复用同一逻辑 */
      if (Array.isArray(tg.types) && tg.types.length) clone.types = tg.types.slice();
      for (const nm of Object.keys(NOTIFY_CHANNELS)) clone.channels[nm] = { enabled: false, fields: {}, fromDb: true, configured: false };
      const spec = NOTIFY_CHANNELS[tg.channel];
      clone.channels[tg.channel] = {
        enabled: !!tg.enabled,
        fields: Object.assign({}, tg.fields),
        fromDb: true,
        configured: spec.need.every(function (f) { return !!tg.fields[f]; }),
      };
      const r = await dispatchNotify(env, msg, Object.assign({}, mode, { config: clone, _single: true, target_id: "" })).catch(function (e) {
        /* 单个目标的意外异常不得中断后续目标；仅记录并转为该目标失败结果 */
        logEvent("error", "notify_forward_failed", "notify", env, "-", { message: safeNotifyError(e) });
        return mode.collect ? [{ channel: tg.channel, ok: false, error: safeNotifyError(e) }] : undefined;
      });
      if (mode.collect && Array.isArray(r)) {
        out.push.apply(out, r.map(function (x) {
          return Object.assign({}, x, { target_id: tg.id, target_name: tg.name, channel: tg.channel });
        }));
      }
    }
    return mode.collect ? out : undefined;
  }
  /* 仅测试指定渠道时可绕过开关，便于启用前验证配置是否可用 */
  const active = function (name) {
    if (only && only === name) return true;
    const ch = cfg.channels[name];
    return !!ch && ch.enabled;
  };
  const push = function (name, fn) {
    if (!only || only === name) jobs.push({ name: name, fn: fn });
  };

  const feishu = t(cfg.channels.feishu.fields.webhook);
  if (feishu && active("feishu")) push("feishu", async function () {
    /* Interactive 卡片三态渲染（violet 验证码 / blue 短信 / turquoise 通知） */
    const st = notifyStyle(info);
    const els = [];
    const headLine = (info.type === "notify" ? "来源 " : "发件人 ")
      + "**" + (info.sender || "-") + "**" + (info.device ? " · " + info.device : "");
    els.push({ tag: "div", text: { tag: "lark_md", content: headLine } });
    if (info.code) {
      els.push({ tag: "div", text: { tag: "lark_md", content: "**" + info.code + "**\n5 分钟内有效，泄露有风险，请勿转发" } });
    } else {
      els.push({ tag: "div", text: { tag: "lark_md", content: info.content || "（空内容）" } });
    }
    els.push({ tag: "hr" });
    els.push({ tag: "note", elements: [{ tag: "plain_text",
      content: "🕐 " + (info.time || "-") + " · " + (info.type === "notify" ? "通知" : "短信") + (info.sender ? " · " + info.sender : "") }] });
    if (info.link) {
      els.push({ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "打开管理页" }, type: "primary", url: info.link }] });
    }
    const payload = { msg_type: "interactive", card: {
      config: { wide_screen_mode: true },
      header: { template: st.tpl, title: { tag: "plain_text", content: st.title } },
      elements: els,
    } };
    const feishuSecret = t(cfg.channels.feishu.fields.secret);
    if (feishuSecret) {
      /* 飞书签名校验（机器人安全设置选「签名校验」时必配）：
         sign = base64(HMAC-SHA256(key = timestamp + "\n" + secret, message = ""))，timestamp 为秒级 */
      const ts = Math.floor(Date.now() / 1000);
      payload.timestamp = String(ts);
      payload.sign = await hmacSha256Base64(ts + "\n" + feishuSecret, "");
    }
    await postNotifyRetry(cfg, feishu, null, JSON.stringify(payload));
  });

  const wecom = t(cfg.channels.wecom.fields.webhook);
  if (wecom && active("wecom")) push("wecom", async function () {
    /* 企微群机器人 markdown：不支持 action 按钮 → 链接行；comment 灰字承载体裁元信息；上限 4096 字节 */
    const st = notifyStyle(info);
    let md = "# " + st.title + "\n";
    if (info.code) {
      md += "> `" + info.code + "`\n> 5 分钟内有效，泄露有风险，请勿转发\n\n";
      md += "<font color=\"info\">来源</font> **" + (info.sender || "-") + "**" + (info.device ? " · " + info.device : "") + "\n";
    } else {
      md += info.content + "\n\n";
      md += "<font color=\"comment\">🕐 " + (info.time || "-") + (info.sender ? " · " + info.sender : "") + (info.device ? " · " + info.device : "") + "</font>";
    }
    if (info.link) md += "\n[打开管理页](" + info.link + ")";
    try {
      const enc = new TextEncoder().encode(md);
      if (enc.length > 4096) md = new TextDecoder().decode(enc.slice(0, 4090)) + "…";
    } catch (e) { /* 极老运行时无 TextEncoder 时按原样发送 */ }
    await postNotifyRetry(cfg, wecom, null, JSON.stringify({ msgtype: "markdown", markdown: { content: md } }));
  });

  const dingtalk = t(cfg.channels.dingtalk.fields.webhook);
  if (dingtalk && active("dingtalk")) push("dingtalk", async function () {
    /* 钉钉 markdown：### 标题 + 列表元信息；title 字段（≤32 字）进会话列表预览；加签逻辑不变 */
    const st = notifyStyle(info);
    let md = "### " + st.title + "\n\n";
    if (info.code) md += "**" + info.code + "**（5 分钟内有效，请勿转发）\n\n";
    else md += info.content + "\n\n";
    md += "- 来源：" + (info.sender || "-") + "\n- 设备：" + (info.device || "-") + "\n- 时间：" + (info.time || "-");
    if (info.link) md += "\n\n[打开管理页](" + info.link + ")";
    let url = dingtalk;
    const secret = t(cfg.channels.dingtalk.fields.secret);
    if (secret) {
      const ts = Date.now();
      const sign = await hmacSha256Base64(secret, ts + "\n" + secret);
      url += (url.indexOf("?") === -1 ? "?" : "&") + "timestamp=" + ts + "&sign=" + encodeURIComponent(sign);
    }
    await postNotifyRetry(cfg, url, null, JSON.stringify({ msgtype: "markdown", markdown: { title: info.title.slice(0, 32), text: md } }));
  });

  const serverchan = t(cfg.channels.serverchan.fields.sendkey);
  if (serverchan && active("serverchan")) push("serverchan", async function () {
    /* Server酱：通知栏只显示 title（≤32 字）→ 验证码进 title；desp 走 markdown 详情页 */
    let desp;
    if (info.code) {
      desp = "**" + info.code + "**（5 分钟内有效，请勿转发）\n\n> " + (info.sender || "-") + (info.device ? " · " + info.device : "") + "\n> 🕐 " + (info.time || "-");
    } else {
      desp = info.content + (info.time ? "\n\n> 🕐 " + info.time : "");
    }
    if (info.link) desp += "\n\n[打开管理页](" + info.link + ")";
    const scTitle = info.title.length > 32 ? info.title.slice(0, 31) + "…" : info.title;
    await postNotifyRetry(cfg, 
      "https://sctapi.ftqq.com/" + encodeURIComponent(serverchan) + ".send",
      { "Content-Type": "application/x-www-form-urlencoded" },
      new URLSearchParams({ title: scTitle, desp: desp }).toString()
    );
  });

  const pushplus = t(cfg.channels.pushplus.fields.token);
  if (pushplus && active("pushplus")) push("pushplus", async function () {
    /* PushPlus：template=markdown，title 策略与 Server酱一致 */
    let content;
    if (info.code) {
      content = "**" + info.code + "**（5 分钟内有效，请勿转发）\n\n> " + (info.sender || "-") + (info.device ? " · " + info.device : "") + "\n> 🕐 " + (info.time || "-");
    } else {
      content = info.content + (info.time ? "\n\n> 🕐 " + info.time : "");
    }
    if (info.link) content += "\n\n[打开管理页](" + info.link + ")";
    await postNotifyRetry(cfg, "https://www.pushplus.plus/send", null,
      JSON.stringify({ token: pushplus, title: info.title, content: content, template: "markdown" }));
  });

  const tgBot = t(cfg.channels.telegram.fields.bot_token), tgChat = t(cfg.channels.telegram.fields.chat_id);
  if (tgBot && tgChat && active("telegram")) push("telegram", async function () {
    /* Telegram：parse_mode=HTML（只需转义 & < > 三个字符，比 MarkdownV2 的十余个特殊字符转义稳得多）；
       blockquote 放验证码（Bot API 7.0+）；链接预览关闭保持消息干净。
       sendMessage 上限 4096 字符（超限整条 400 静默失败）：>4000 时去格式降级纯文本版式再截断 */
    const st = notifyStyle(info);
    let html = "<b>" + escHtml(st.title) + "</b>\n";
    if (info.code) {
      html += "<blockquote><b>" + escHtml(info.code) + "</b>（5 分钟内有效，请勿转发）</blockquote>"
        + "来源：<b>" + escHtml(info.sender || "-") + "</b>" + (info.device ? " · " + escHtml(info.device) : "") + "\n"
        + "🕐 " + escHtml(info.time || "-") + " · " + (info.type === "notify" ? "通知" : "短信");
    } else {
      html += escHtml(info.content) + "\n"
        + "🕐 " + escHtml(info.time || "-") + (info.sender ? " · " + escHtml(info.sender) : "") + (info.device ? " · " + escHtml(info.device) : "");
    }
    if (info.link) html += "\n<a href=\"" + escHtml(info.link) + "\">打开管理页 →</a>";
    let tgPayload;
    if (html.length > 4000) {
      tgPayload = { chat_id: tgChat, link_preview_options: { is_disabled: true }, text: (plainBody(info) + "\n…").slice(0, 4096) };
    } else {
      tgPayload = { chat_id: tgChat, parse_mode: "HTML", link_preview_options: { is_disabled: true }, text: html };
    }
    await postNotifyRetry(cfg, "https://api.telegram.org/bot" + tgBot + "/sendMessage", null, JSON.stringify(tgPayload));
  });

  const barkKey = t(cfg.channels.bark.fields.device_key);
  if (barkKey && active("bark")) push("bark", async function () {
    /* Bark 行为参数：验证码进 title 保证锁屏完整可见；copy+autoCopy 通知一点即复制验证码；
       验证码 level=timeSensitive 穿透专注模式（普通消息 active）；group 按 sms/notify 分组；
       url 点击跳管理页（NOTIFY_LINK），icon 复用站点图标 SITE_ICON */
    const server = (t(cfg.channels.bark.fields.url) || "https://api.day.app").replace(/\/+$/, "");
    const bark = {
      device_key: barkKey,
      title: info.title,
      subtitle: info.code
        ? (info.device ? info.device : "") + (info.device && info.sender ? " · " : "") + (info.sender || "")
        : (info.device || ""),
      body: info.code ? "5 分钟内有效，泄露有风险，请勿转发。点击查看完整内容。" : info.content,
      level: info.code ? "timeSensitive" : "active",
      group: info.type === "notify" ? "notify" : "sms",
    };
    if (info.code) { bark.copy = info.code; bark.autoCopy = 1; }
    if (info.link) bark.url = info.link;
    const icon = t(env.SITE_ICON);
    if (icon) bark.icon = icon;
    await postNotifyRetry(cfg, server + "/push", null, JSON.stringify(bark));
  });

  const ntfy = t(cfg.channels.ntfy.fields.url);
  if (ntfy && active("ntfy")) push("ntfy", async function () {
    /* ntfy 用 JSON 发布模式（HTTP 头值仅限 Latin1，中文标题走 Title 头会被 fetch 拒绝）。
       NTFY_URL 为完整主题 URL：topic 取路径最后一段，POST 到其父目录（兼容根路径与反代子路径部署）；
       受保护主题可选 NTFY_TOKEN：值含「:」视为 user:password 走 Basic，否则按 Access Token 走 Bearer */
    const u = new URL(ntfy);
    const path = u.pathname.replace(/\/+$/, "");
    const slash = path.lastIndexOf("/");
    const topic = decodeURIComponent(path.slice(slash + 1));
    if (!topic) throw new Error("NTFY_URL 需为完整主题 URL（如 https://ntfy.sh/my-topic）");
    const ntfyHeaders = { "Content-Type": "application/json" };
    const ntfyTok = t(cfg.channels.ntfy.fields.token);
    if (ntfyTok) {
      ntfyHeaders.Authorization = ntfyTok.indexOf(":") !== -1 ? "Basic " + btoa(ntfyTok) : "Bearer " + ntfyTok;
    }
    const ntfyBody = {
      topic: topic,
      title: info.title,
      message: info.code
        ? (info.sender || "-") + (info.device ? " · " + info.device : "") + " · 5 分钟内有效，泄露有风险，请勿转发"
        : info.content,
      priority: info.code ? 4 : 3,
    };
    if (info.code) ntfyBody.tags = ["lock"];  /* 渲染 🔐 emoji */
    if (info.link) ntfyBody.click = info.link;
    await postNotifyRetry(cfg, u.origin + path.slice(0, slash + 1), ntfyHeaders, JSON.stringify(ntfyBody));
  });

  const gotifyUrl = t(cfg.channels.gotify.fields.url), gotifyToken = t(cfg.channels.gotify.fields.token);
  if (gotifyUrl && gotifyToken && active("gotify")) push("gotify", async function () {
    /* Gotify：extras client::display contentType=text/markdown 让 Android 客户端渲染 markdown；
       验证码 priority 8、普通 5 */
    let md;
    if (info.code) {
      md = "**" + info.code + "**（5 分钟内有效，请勿转发）\n\n> " + (info.sender || "-") + (info.device ? " · " + info.device : "")
        + "\n> 🕐 " + (info.time || "-") + " · " + (info.type === "notify" ? "通知" : "短信");
    } else {
      md = info.content + (info.time ? "\n\n> 🕐 " + info.time : "");
    }
    if (info.link) md += "\n\n[打开管理页](" + info.link + ")";
    await postNotifyRetry(cfg, gotifyUrl.replace(/\/+$/, "") + "/message?token=" + encodeURIComponent(gotifyToken), null,
      JSON.stringify({ title: info.title, message: md, priority: info.code ? 8 : 5,
        extras: { "client::display": { contentType: "text/markdown" } } }));
  });

  const resendKey = t(cfg.channels.resend.fields.api_key), mailTo = t(cfg.channels.resend.fields.mail_to);
  if (resendKey && mailTo && active("resend")) push("resend", async function () {
    /* Resend：完整 HTML 模板（全部内联 CSS，兼容邮件客户端）；subject 复用统一标题策略（验证码进主题）；
       text 附统一纯文本版式，作为不支持 HTML 的客户端的降级 */
    const st = notifyStyle(info);
    const accent = info.type === "verify" ? "#7b45e6" : (info.type === "sms" ? "#2563eb" : "#0d9488");
    const metaRows = [
      ["来源", (info.sender || "-") + "（" + (info.type === "notify" ? "通知" : "短信") + "）"],
      ["设备", info.device || "-"],
      ["时间", info.time || "-"],
    ].map(function (r) {
      return '<tr><td style="padding:6px 12px 6px 0;color:#9ca3af;vertical-align:top;">' + r[0]
        + '</td><td style="padding:6px 0;">' + escHtml(r[1]) + "</td></tr>";
    }).join("");
    const html = '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;max-width:560px;margin:0 auto;padding:24px;">'
      + '<span style="display:inline-block;padding:4px 14px;border-radius:999px;background:' + accent + ';color:#fff;font-size:13px;">' + st.label + "</span>"
      + (info.code
        ? '<div style="margin:20px 0;padding:18px 16px;border:2px dashed ' + accent + ';border-radius:12px;text-align:center;font-size:32px;font-weight:700;letter-spacing:6px;color:' + accent + ';">' + escHtml(info.code) + "</div>"
          + '<p style="margin:0 0 16px;color:#6b7280;font-size:14px;">5 分钟内有效，泄露有风险，请勿转发。</p>'
        : '<p style="margin:16px 0;font-size:15px;line-height:1.7;color:#111827;white-space:pre-wrap;">' + escHtml(info.content || "（空内容）") + "</p>")
      + '<table style="border-collapse:collapse;font-size:14px;color:#374151;margin:0 0 20px;">' + metaRows + "</table>"
      + (info.link ? '<a href="' + escHtml(info.link) + '" style="display:inline-block;padding:10px 28px;background:' + accent + ';color:#fff;border-radius:8px;text-decoration:none;font-size:14px;">打开管理页</a>' : "")
      + '<p style="margin:28px 0 0;padding-top:12px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;">由 SMSToWeb 自动发送 · 请勿回复本邮件</p>'
      + "</div>";
    const to = mailTo.split(/[,;，；]/).map(function (s) { return s.trim(); }).filter(Boolean);
    await postNotifyRetry(cfg, "https://api.resend.com/emails",
      { Authorization: "Bearer " + resendKey },
      JSON.stringify({
        from: t(cfg.channels.resend.fields.mail_from) || "onboarding@resend.dev",
        to: to,
        subject: info.title,
        html: html,
        text: plainBody(info),
      }));
  });

  /* 通用 Webhook：默认 POST JSON {title,content,time,source,sender,device,type,code}
     （type=verify|sms|notify，code=轻量检测出的验证码，未检出为空串）；
     配置 GENERIC_WEBHOOK_TEMPLATE 后按模板渲染请求体（可解析为 JSON 则按 JSON 发送，否则按纯文本），
     第三方 API（短信网关、自建系统等）由此接入 */
  const genericUrls = String(cfg.channels.generic.fields.urls || "").split(",").map(function (s) { return s.trim(); })
    .filter(function (u) { return /^https?:\/\//i.test(u); });
  if (genericUrls.length && active("generic")) {
    const payload = {
      title: msg.title, content: String(msg.content || ""), time: msg.time || "",
      source: msg.source || "", sender: msg.sender || "", device: msg.device || "",
      type: info.type, code: info.code,
    };
    let genericBody = JSON.stringify(payload);
    let genericCt = "application/json";
    const tpl = t(cfg.channels.generic.fields.template);
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
    const hdrRaw = t(cfg.channels.generic.fields.headers);
    if (hdrRaw) {
      try {
        const parsed = JSON.parse(hdrRaw);
        for (const k of Object.keys(parsed)) genericHeaders[k] = String(parsed[k]);
      } catch (e) {
        logEvent("error", "webhook_headers_parse_failed", "notify", env, "-", { message: e && e.message });
      }
    }
    for (const u of genericUrls) {
      push("generic", (function (target) {
        return async function () { await postNotifyRetry(cfg, target, genericHeaders, genericBody); };
      })(u));
    }
  }

  if (!jobs.length) return mode.collect ? [] : undefined;
  const results = await Promise.all(jobs.map(async function (job) {
    try {
      await job.fn();
      return { channel: job.name, ok: true };
    } catch (e) {
      logEvent("error", "notify_forward_failed", "notify", env, "-", { message: safeNotifyError(e) });
      return { channel: job.name, ok: false, error: safeNotifyError(e) };
    }
  }));
  return mode.collect ? results : undefined;
}

/* ---------------- 接收（短信：SmsForwarder 等 App Webhook） ---------------- */

async function handleReceive(request, env, url, ctx) {
  if (!allowWrite(request)) return json({ success: false, error: "too many requests" }, 429);
  const data = await parseIncoming(request, url);
  if (!data) return json({ success: false, error: "invalid body" }, 400);

  // 鉴权：库内令牌优先 + 环境变量兜底（token 可在 header/query/body，统一走单一校验函数）；
  // 失败状态码维持旧行为 403（旧代码对缺 token/错 token 不区分，均为 403；401 仅用于管理 API 未登录）
  if (!(await verifyInboundToken(request, env, url, data.token))) {
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
  // 遗留风险 R-a（阶段 1-3 已记录、本阶段不修复）：上面的 upsert 与下面的 INSERT 是两条独立语句，
  //   若设备在两者之间被并发删除，消息可能以过期 id 落库成为孤儿（列表 JOIN 不可见但计入总数）。
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

  if (!(await verifyInboundToken(request, env, url, body.token))) {
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
  // 遗留风险 R-a（阶段 1-3 已记录、本阶段不修复）：upsert 与 INSERT 两条独立语句，
  //   设备在两者之间被并发删除时，消息可能以过期 id 落库成为孤儿（与 /api/receive 同型）。
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

/* 稳定游标：starred|received_at|id|<sha256>
   末段为「当前筛选条件下星标 ID 集合」的 SHA-256（ID 升序、逗号规范化的确定性摘要），
   可完整区分任意集合差异（不再使用 COUNT/SUM 这类有限统计，避免 {1,4}↔{2,3} 碰撞）。
   旧 3 段游标（无摘要）仍兼容，不做校验。 */
function encodeCursor(row, fpHash) {
  return [row.starred ? 1 : 0, row.received_at, row.id, fpHash].join("|");
}
function decodeCursor(raw) {
  if (!raw) return null;
  const parts = String(raw).split("|");
  if (parts.length === 3) {
    /* 兼容旧游标：不做集合校验 */
    const s0 = parts[0] === "1" ? 1 : (parts[0] === "0" ? 0 : null);
    const id0 = parseInt(parts[2], 10);
    if (s0 === null || !parts[1] || !Number.isInteger(id0) || id0 <= 0) return null;
    return { starred: s0, receivedAt: parts[1], id: id0, legacy: true };
  }
  if (parts.length !== 4) return null;
  const starred = parts[0] === "1" ? 1 : (parts[0] === "0" ? 0 : null);
  const receivedAt = parts[1];
  const id = parseInt(parts[2], 10);
  if (starred === null || !receivedAt || !Number.isInteger(id) || id <= 0) return null;
  if (!/^[0-9a-f]{64}$/.test(parts[3])) return null;
  return { starred, receivedAt, id, hash: parts[3] };
}
/* 星标集合的确定性指纹：ID 升序 → 逗号连接 → SHA-256 十六进制 */
async function starSetHash(idsCsv) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(idsCsv || "")));
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

async function handleListMessages(url, env) {
  const deviceId = parseInt(url.searchParams.get("device_id") || "", 10);
  const q = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  /* 默认每页 10 条（v1.0.4 第二阶段）；上限 100 保持不变 */
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "10", 10) || 10));
  /* slim=1：只返回约 20 字摘要（不传完整正文），详情按 id 单独取；默认行为保持完整正文以兼容既有调用方 */
  const slim = url.searchParams.get("slim") === "1";
  const rawCursor = url.searchParams.get("cursor");
  const cursor = decodeCursor(rawCursor);

  const source = (url.searchParams.get("source") || "").trim();
  const range = (url.searchParams.get("range") || "").trim();
  const rangeDays = { "1d": 1, "7d": 7, "30d": 30 }[range] || 0;
  const starredOnly = url.searchParams.get("starred") === "1";
  const unreadOnly = url.searchParams.get("unread") === "1";
  const readOnly = url.searchParams.get("read") === "1";

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
  if (readOnly) where.push("m.read_at IS NOT NULL");
  if (rawCursor && !cursor) return json({ success: false, error: "INVALID_CURSOR" }, 400);

  /* 游标条件与 ORDER BY (starred DESC, received_at DESC, id DESC) 严格对应 */
  const pageWhere = where.slice();
  const pageParams = params.slice();
  if (cursor) {
    pageWhere.push(
      "(m.starred < ? OR (m.starred = ? AND (m.received_at < ? OR (m.received_at = ? AND m.id < ?))))"
    );
    pageParams.push(cursor.starred, cursor.starred, cursor.receivedAt, cursor.receivedAt, cursor.id);
  }
  const whereSql = pageWhere.length ? "WHERE " + pageWhere.join(" AND ") + "" : "";

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages m ${where.length ? "WHERE " + where.join(" AND ") : ""}`
  ).bind(...params).first();
  const total = totalRow ? totalRow.n : 0;

  /* 星标 ID 集合子查询：与分页数据在**同一条 SQL** 内读取 ⇒ 同一读快照，
     避免「先取指纹、后取数据」之间发生星标修改导致页面与指纹不一致。
     注意：星标集合（5% 星标时已达 20KB+ CSV）绝不能作为列参与全表排序——它会随每一行
     复制进 ORDER BY 的临时 B-Tree（实测 10 万行、page=5000 时 12.8s）。因此先用内层子查询
     完成「过滤 + 排序 + LIMIT/OFFSET」得到当页行，再由外层关联星标集合：CSV 只与当页
     limit+1 行组合，且仍是同一条语句、同一读快照，指纹与分页数据的一致性不变。 */
  const whereAny = where.length ? "WHERE " + where.join(" AND ") : "WHERE 1=1";
  const whereAlias = whereAny.replace(/m\./g, "m2.");
  const starSub = `(SELECT group_concat(x.id, ',') FROM (SELECT m2.id FROM messages m2 ${whereAlias} AND m2.starred = 1 ORDER BY m2.id) x)`;

  const pageCols = "m.id, m.sender, m.content, m.received_at, m.device_id, m.source, m.starred, m.read_at, "
    + "length(m.content) AS content_len, "
    + "COALESCE(NULLIF(d.alias, ''), d.device) AS device_name, d.sim, d.device";
  const cols = "p.id, p.sender, p.content, p.received_at, p.device_id, p.source, p.starred, p.read_at, "
    + "p.content_len, p.device_name, p.sim, p.device";
  /* 多取 1 条用于判断是否还有下一页（不额外发 COUNT）
     绑定顺序必须与 SQL 文本一致：内层 WHERE（基础筛选 + 游标）→ 内层 LIMIT/OFFSET
     → 外层星标集合子查询的基础筛选参数。外层 ORDER BY 只对当页 limit+1 行生效，
     保证输出顺序与原语句逐行一致，而排序缓冲不再复制星标 CSV。 */
  const list = await env.DB.prepare(
    `SELECT ${cols}, s.starids AS _starids
     FROM (
       SELECT ${pageCols}
       FROM messages m JOIN devices d ON d.id = m.device_id
       ${whereSql}
       ORDER BY m.starred DESC, m.received_at DESC, m.id DESC
       LIMIT ? OFFSET ?
     ) p
     CROSS JOIN (SELECT ${starSub} AS starids) s
     ORDER BY p.starred DESC, p.received_at DESC, p.id DESC`
  ).bind(...pageParams, limit + 1, cursor ? 0 : (page - 1) * limit, ...params).all();

  let rows = list.results || [];
  const hasMore = rows.length > limit;
  if (hasMore) rows = rows.slice(0, limit);

  /* 星标集合指纹（与本页数据同一快照）：无数据行时补一条仅取集合的查询 */
  let starIdsCsv = rows.length ? rows[0]._starids : null;
  if (starIdsCsv === null || starIdsCsv === undefined) {
    const fr = await env.DB.prepare(
      `SELECT group_concat(x.id, ',') AS s FROM (SELECT m2.id FROM messages m2 ${whereAlias} AND m2.starred = 1 ORDER BY m2.id) x`
    ).bind(...params).first();
    starIdsCsv = (fr && fr.s) || "";
  }
  const fpHash = await starSetHash(starIdsCsv);
  /* 集合指纹不一致 ⇒ 顺序已漂移，拒绝续页；前端回到首屏重载 */
  if (cursor && cursor.hash && cursor.hash !== fpHash) {
    return json({ success: false, error: "CURSOR_STALE" }, 409);
  }

  for (const r of rows) {
    delete r._starids;
    /* Unicode 安全摘要：按码位截取（emoji/中文不被切断）。
       上限放宽到 120 码位：卡片按 CSS 两行截断，超出才显示「查看全文」；
       仍不回传完整正文（详情按 id 单独取），保持摘要 API 架构不变。 */
    const chars = Array.from(String(r.content || ""));
    r.summary = chars.slice(0, 120).join("");
    r.summary_truncated = chars.length > 120;
    r.code = extractCodeLite(r.content);
    r.sim_number = r.sim || "";
    /* slim：正文不回传前端（摘要/验证码/长度足够渲染卡片），详情按 id 单独取 */
    if (slim) delete r.content;
  }
  const nextCursor = hasMore && rows.length ? encodeCursor(rows[rows.length - 1], fpHash) : null;

  return json({
    success: true,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    list: rows,
    has_more: hasMore,
    next_cursor: nextCursor,
    slim: slim,
  });
}

/* 单条完整消息（详情用）：列表 slim 模式下打开详情时调用 */
async function handleGetMessage(id, env) {
  const row = await env.DB.prepare(
    `SELECT m.id, m.sender, m.content, m.received_at, m.device_id, m.source,
            m.starred, m.read_at,
            COALESCE(NULLIF(d.alias, ''), d.device) AS device_name, d.sim, d.device
     FROM messages m JOIN devices d ON d.id = m.device_id
     WHERE m.id = ?1 AND m.deleted_at IS NULL`
  ).bind(id).first();
  if (!row) return json({ success: false, error: "NOT_FOUND" }, 404);
  row.sim_number = row.sim || "";
  return json({ success: true, item: row });
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
  const starOnly = url.searchParams.get("starred") === "1";
  const unreadOnly = url.searchParams.get("unread") === "1";
  const readOnly = url.searchParams.get("read") === "1";
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
  if (starOnly) where.push("m.starred = 1");
  if (unreadOnly) where.push("m.read_at IS NULL");
  if (readOnly) where.push("m.read_at IS NOT NULL");
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
  const read = body && (body.read === true || body.read === 1 || body.read === "1");
  /* 批量：body.ids = [..]（≤200）→ 逐条执行并返回逐条结果，支持“部分失败”如实上报 */
  if (Array.isArray(body && body.ids)) {
    const ids = body.ids.map(function (x) { return parseInt(x, 10); }).filter(function (n) { return Number.isInteger(n) && n > 0; });
    if (!ids.length) return json({ success: false, error: "no ids" }, 400);
    if (ids.length > 200) return json({ success: false, error: "too many ids" }, 400);
    const okIds = [], failedIds = [];
    for (const id of ids) {
      try {
        const res = read
          ? await env.DB.prepare("UPDATE messages SET read_at = datetime('now') WHERE id = ?1").bind(id).run()
          : await env.DB.prepare("UPDATE messages SET read_at = NULL WHERE id = ?1").bind(id).run();
        const ch = res && res.meta ? res.meta.changes : 0;
        if (ch > 0) okIds.push(id); else failedIds.push(id);
      } catch (e) { failedIds.push(id); }
    }
    let unread = null;
    try {
      const t = await env.DB.prepare("SELECT SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS u FROM messages WHERE deleted_at IS NULL").first();
      unread = (t && t.u) || 0;
    } catch (e) {}
    return json({ success: true, read: read, updated: okIds.length, failed: failedIds.length, failed_ids: failedIds, unread: unread });
  }
  const id = parseInt(body && body.id, 10);
  if (!Number.isInteger(id) || id <= 0) return json({ success: false, error: "invalid id" }, 400);
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
    /* 第 4 步升级可观测：最近一次 schema 自愈结果（正常/失败 + 时间 + 错误摘要） */
    schema: schemaStatus.get(env.DB) || { state: "unknown", at: "", error: "" },
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
    /* 单图标条目：SITE_ICON 通常是 .ico，尺寸不可预设，用 sizes:"any" 如实标注
       （原先虚标 192x192/512x512 与实际图标文件不符，PWA 安装时拿不到期望尺寸） */
    icons: [
      { src: icon, sizes: "any", type: "image/x-icon", purpose: "any" }
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

/* 删除设备（tag）：仅在无活跃（未软删）消息时可删，防止误删有数据的记录。
   存在性、活跃消息守卫与两条 DELETE 全部在同一原子事务内（守卫与写入同批，不存在"守卫通过后
   又产生不一致删除"的跨事务窗口）；响应只依据该事务自身返回的 changes，不做事务后验证读，
   也不把任何事后读出的状态等同于"本次事务已提交"。 */
async function handleDeleteDevice(idParam, env) {
  const id = parseInt(idParam, 10);
  if (!Number.isInteger(id) || id <= 0) return json({ success: false, error: "invalid id" }, 400);
  /* S1 设备存在性（事务内 no-op，changes=匹配行数）；S2 仅在无活跃消息时删除该设备全部消息（含软删）；
     S3 仅在无残留消息时删除设备记录。S2/S3 的守卫条件与写操作同批提交。 */
  const noActive = "NOT EXISTS (SELECT 1 FROM messages WHERE device_id = ?1 AND deleted_at IS NULL)";
  const r = await atomicBatch(env.DB, [
    { sql: "UPDATE devices SET id = id WHERE id = ?1", args: [id] },
    { sql: "DELETE FROM messages WHERE device_id = ?1 AND " + noActive, args: [id] },
    { sql: "DELETE FROM devices WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM messages WHERE device_id = ?1)", args: [id] },
  ]);
  const exists = r.results[0].changes > 0;
  const deleted = r.results[2].changes;
  if (exists && deleted === 0) return json({ success: false, error: "has messages" }, 400);
  return json({ success: true, deleted: deleted });
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
   目标已有同（设备+发件人+正文+时间）的重复消息时，UPDATE OR IGNORE 跳过，随后清掉残留（去重索引约束），不报错。
   设备存在性、迁移、残留清理、源设备删除全部在同一原子事务内；守卫条件与写入同批，
   不在事务外做"先检查再假设不变"的预检。响应只依据事务自身返回的 changes。 */
async function handleMergeDevices(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: "invalid json" }, 400); }
  const from = parseInt(body && body.from, 10);
  const to = parseInt(body && body.to, 10);
  if (!Number.isInteger(from) || from <= 0 || !Number.isInteger(to) || to <= 0 || from === to) {
    return json({ success: false, error: "invalid device ids" }, 400);
  }
  /* M1 = S3.changes（活跃迁移数）；S3/S4 的 bothExist 守卫确保两端设备都存在时才发生任何写入；
     S4 清理源设备残留（软删 + 唯一索引冲突未迁移的活跃记录）；S5 删除源设备记录。
     S1/S2 为事务内存在性探针（no-op UPDATE，changes=匹配行数）。 */
  const bothExist = "EXISTS (SELECT 1 FROM devices WHERE id = ?1) AND EXISTS (SELECT 1 FROM devices WHERE id = ?2)";
  const r = await atomicBatch(env.DB, [
    { sql: "UPDATE devices SET id = id WHERE id = ?1", args: [from] },
    { sql: "UPDATE devices SET id = id WHERE id = ?1", args: [to] },
    { sql: "UPDATE OR IGNORE messages SET device_id = ?2 WHERE device_id = ?1 AND deleted_at IS NULL AND " + bothExist, args: [from, to] },
    { sql: "DELETE FROM messages WHERE device_id = ?1 AND " + bothExist, args: [from, to] },
    { sql: "DELETE FROM devices WHERE id = ?1 AND EXISTS (SELECT 1 FROM devices WHERE id = ?2)", args: [from, to] },
  ]);
  if (r.results[0].changes === 0 || r.results[1].changes === 0) {
    return json({ success: false, error: "device not found" }, 404);
  }
  return json({ success: true, moved: r.results[2].changes });
}

/* ---------------- 业务配置（settings 表；环境变量仅作旧配置兜底） ----------------
   session_ttl_minutes 为全局默认（浏览器可在登录请求中声明独立值，优先级更高），沿用既有读取函数（登录低频、每次现查）；
   retention_days / phone_area_enabled / phone_area_api 在此统一按「数据库优先 → 环境变量 → 默认值」
   解析，只在真正需要该配置的入口读取（定时清理、号码归属地），普通列表请求不触发任何设置查询。 */
const SCALAR_SETTINGS = {
  session_ttl_minutes: { env: "", def: "30", kind: "int", min: 5, max: 43200 },
  retention_days: { env: "RETENTION_DAYS", def: String(DEFAULT_RETENTION_DAYS), kind: "int", min: 1, max: 3650 },
  phone_area_enabled: { env: "PHONE_AREA_ENABLED", def: "true", kind: "bool" },
  phone_area_api: { env: "PHONE_AREA_API", def: "", kind: "url", maxLen: 500, allowEmpty: true },
};

/* 单条 IN 查询批量读取（缺表/库异常 → 空对象，调用方回退环境变量） */
async function readSettingsKeys(env, keys) {
  const out = {};
  if (!keys || !keys.length) return out;
  try {
    const ph = keys.map(function (_, i) { return "?" + (i + 1); }).join(", ");
    const res = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN (" + ph + ")")
      .bind(...keys).all();
    for (const r of (res && res.results) || []) {
      if (r && r.key !== undefined && r.key !== null) {
        out[String(r.key)] = String(r.value === undefined || r.value === null ? "" : r.value);
      }
    }
  } catch (e) { /* 缺表/库异常 → 交由调用方兜底 */ }
  return out;
}

/* 严格类型/范围校验：合法返回规范化字符串，非法返回 null（供保存接口拒绝非法参数） */
function coerceScalar(name, raw) {
  const spec = SCALAR_SETTINGS[name];
  if (!spec) return null;
  const s = String(raw === undefined || raw === null ? "" : raw).trim();
  if (spec.kind === "int") {
    if (!/^-?\d+$/.test(s)) return null;
    const n = parseInt(s, 10);
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) return null;
    return String(n);
  }
  if (spec.kind === "bool") {
    if (!s) return spec.def;
    const low = s.toLowerCase();
    if (low === "true" || low === "1" || low === "on" || low === "yes") return "true";
    if (low === "false" || low === "0" || low === "off" || low === "no") return "false";
    return null;
  }
  if (spec.kind === "url") {
    if (!s) return spec.allowEmpty ? "" : null;
    if (s.length > (spec.maxLen || 500)) return null;
    return /^https?:\/\//i.test(s) ? s : null;
  }
  return null;
}

/* 单项读取：数据库 → 环境变量 → 默认；非法值按默认处理 */
async function getScalarSetting(env, name) {
  const spec = SCALAR_SETTINGS[name];
  if (!spec) return null;
  const map = await readSettingsKeys(env, [name]);
  let raw;
  if (map && map[name] !== undefined) raw = map[name];
  else raw = env && spec.env ? env[spec.env] : "";
  const v = coerceScalar(name, raw);
  return v === null ? spec.def : v;
}

/* 号码归属地：一次读取两个键（开关 + 自定义源），避免每请求两次查询 */
async function getPhoneAreaSettings(env) {
  const map = await readSettingsKeys(env, ["phone_area_enabled", "phone_area_api"]);
  const flagRaw = map.phone_area_enabled !== undefined
    ? map.phone_area_enabled : (env && env.PHONE_AREA_ENABLED);
  const apiRaw = map.phone_area_api !== undefined
    ? map.phone_area_api : (env && env.PHONE_AREA_API);
  const flag = coerceScalar("phone_area_enabled", flagRaw);
  const api = coerceScalar("phone_area_api", apiRaw);
  return {
    enabled: (flag === null ? true : flag === "true"),
    api: (api === null ? (trimEnv(env && env.PHONE_AREA_API) || AREA_DEFAULT_API) : (api || AREA_DEFAULT_API)),
  };
}

/* ---------------- 号码归属地（免费、无 key） ----------------
 * 仅对 11 位手机号查询；默认走 360 公开接口（无 key），结果内存缓存 24h。
 * 外部接口失败静默降级（不显示归属地，不影响页面）。
 * 关闭/自定义源：设置页面「业务设置」写入 settings 表；未设置时回退 PHONE_AREA_ENABLED / PHONE_AREA_API。 */
const AREA_CACHE = new Map();
const AREA_TTL = 24 * 3600 * 1000;
const AREA_DEFAULT_API = "https://cx.shouji.360.cn/phonearea.php?number={number}";

async function handlePhoneArea(request, url, env) {
  const num = String(url.searchParams.get("number") || "").replace(/\D/g, "");
  if (!/^1[3-9]\d{9}$/.test(num)) return json({ success: true, found: false });
  const cfg = await getPhoneAreaSettings(env);
  if (!cfg.enabled) return json({ success: true, found: false, disabled: true });

  const cached = AREA_CACHE.get(num);
  if (cached && Date.now() - cached.t < AREA_TTL) return json(Object.assign({ success: true }, cached.v));

  /* 上游查询限速：与写入接口共用每 IP 120 次/分的软限速桶，遏制把 /api/phone
     当免费代理刷外部归属地接口；缓存命中（含 24h TTL 内重复查询）不消耗配额 */
  if (!allowWrite(request)) return json({ success: false, error: "too many requests" }, 429);

  let out = { found: false };
  try {
    const tpl = cfg.api;
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
  /* 挂起时长可配：函数型平台入口已按保守值内置默认（如 netlify=8），
     其他平台按需把 WAIT_MAX_SECONDS 调低，避免请求被平台强杀导致前端反复重连 */
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
/* ===== DS TOKENS v1：全项目唯一设计令牌源 =====
   管理页与登录页都通过 ${DS_TOKENS_CSS} 注入同一字符串；禁止各页面再复制一套变量。 */
const DS_TOKENS_CSS = String.raw`
  /* ===== DS TOKENS v1（全项目唯一设计令牌源；登录页与后台共用同一套语义变量） =====
     命名规则：--ds-<类别>-<语义>；下方「兼容别名」把既有 --bg/--card/--accent 等映射到令牌，
     旧选择器无需改动即自动继承新体系。新增颜色一律先在此定义语义令牌，不得在页面内写死色值。 */
  :root {
    /* 颜色 · 背景 */
    --ds-color-bg-page: #f5f6f7;
    --ds-color-bg-surface: #fff;
    --ds-color-bg-subtle: #f5f6f7;
    /* 颜色 · 文本 */
    --ds-color-text: #20242a;
    --ds-color-text-secondary: #6b7280;
    --ds-color-text-tertiary: #9aa3ab;
    /* 颜色 · 主色与状态 */
    --ds-color-primary: #15803d;
    --ds-color-primary-hover: #116632;
    --ds-color-primary-subtle: #e7f4ec;
    --ds-color-success: #15803d;
    --ds-color-warning: #ea580c;
    --ds-color-danger: #dc2626;
    --ds-color-info: #2563eb;
    --ds-color-unread: #15803d;
    --ds-color-disabled: #c7ced4;
    /* 颜色 · 边框与分割 */
    --ds-color-border: #d8dce0;
    --ds-color-border-subtle: #e3e6e9;
    --ds-color-divider: #eef1f3;
    --ds-color-link: #2563eb;
    /* 字体 */
    --ds-font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    --ds-font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --ds-text-xs: 12px; --ds-text-sm: 13px; --ds-text-md: 14px;
    --ds-text-lg: 16px; --ds-text-xl: 18px; --ds-text-2xl: 20px;
    --ds-leading: 1.6; --ds-leading-tight: 1.3;
    --ds-weight-normal: 400; --ds-weight-medium: 600; --ds-weight-bold: 700;
    /* 尺寸与间距 */
    --ds-space-1: 4px; --ds-space-2: 6px; --ds-space-3: 8px; --ds-space-4: 12px;
    --ds-space-5: 16px; --ds-space-6: 24px; --ds-space-7: 32px;
    --ds-content-max: 760px;
    --ds-control-h: 36px; --ds-control-h-sm: 32px;
    --ds-radius-sm: 6px; --ds-radius-md: 8px; --ds-radius-lg: 10px;
    --ds-radius-xl: 14px; --ds-radius-pill: 999px;
    --ds-border-w: 1px;
    --ds-shadow-1: 0 1px 3px rgba(0,0,0,.12);
    --ds-shadow-2: 0 8px 24px rgba(0,0,0,.14);
    --ds-shadow-3: 0 10px 28px rgba(15,23,42,.16);
    --ds-focus-ring: 0 0 0 2px var(--ds-color-link);
    /* 组件令牌（保持原语义，供既有选择器直用） */
    --ds-color-sender: #0f766e;
    --ds-code-bg: #e7f4ec; --ds-code-border: #b7dfc6; --ds-code-text: #116632; --ds-code-hover: #d5ebdd;
    /* ---------- 兼容别名（旧变量 → 令牌；迁移期保留，全部走令牌取值） ---------- */
    --bg: var(--ds-color-bg-page); --card: var(--ds-color-bg-surface);
    --text: var(--ds-color-text); --muted: var(--ds-color-text-secondary); --faint: var(--ds-color-text-tertiary);
    --border: var(--ds-color-border); --card-border: var(--ds-color-border-subtle); --row-border: var(--ds-color-divider);
    --accent: var(--ds-color-primary); --accent-deep: var(--ds-color-primary-hover);
    --accent-bg: var(--ds-color-primary-subtle); --badge-bg: var(--ds-color-primary-subtle);
    --sender: var(--ds-color-sender); --link: var(--ds-color-link);
    --code-bg: var(--ds-code-bg); --code-border: var(--ds-code-border); --code-text: var(--ds-code-text); --code-hover: var(--ds-code-hover);
    --del: var(--ds-color-text-tertiary); --del-hover: var(--ds-color-danger);
    --tabx: var(--ds-color-text-tertiary); --sw-off: var(--ds-color-disabled);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ds-color-bg-page: #14171a; --ds-color-bg-surface: #1d2126; --ds-color-bg-subtle: #14171a;
      --ds-color-text: #e6e9ec; --ds-color-text-secondary: #9aa3ab; --ds-color-text-tertiary: #6b7480;
      --ds-color-primary: #22a04f; --ds-color-primary-hover: #1a8a41; --ds-color-primary-subtle: #12351f;
      --ds-color-success: #22a04f; --ds-color-warning: #fb923c; --ds-color-danger: #f87171;
      --ds-color-info: #6ea8ff; --ds-color-unread: #22a04f; --ds-color-disabled: #3a424a;
      --ds-color-border: #33393f; --ds-color-border-subtle: #2a3036; --ds-color-divider: #262c31;
      --ds-color-link: #6ea8ff; --ds-color-sender: #4fd1a5;
      --ds-code-bg: #12351f; --ds-code-border: #2f6a45; --ds-code-text: #86efac; --ds-code-hover: #17452a;
      --tabx: var(--ds-color-text-tertiary);
    }
  }
  /* 主题三态（data-theme 覆盖系统偏好）：只覆盖 DS 令牌，兼容别名自动跟随 */
  html[data-theme="dark"] {
    --ds-color-bg-page: #14171a; --ds-color-bg-surface: #1d2126; --ds-color-bg-subtle: #14171a;
    --ds-color-text: #e6e9ec; --ds-color-text-secondary: #9aa3ab; --ds-color-text-tertiary: #6b7480;
    --ds-color-primary: #22a04f; --ds-color-primary-hover: #1a8a41; --ds-color-primary-subtle: #12351f;
    --ds-color-success: #22a04f; --ds-color-warning: #fb923c; --ds-color-danger: #f87171;
    --ds-color-info: #6ea8ff; --ds-color-unread: #22a04f; --ds-color-disabled: #3a424a;
    --ds-color-border: #33393f; --ds-color-border-subtle: #2a3036; --ds-color-divider: #262c31;
    --ds-color-link: #6ea8ff; --ds-color-sender: #4fd1a5;
    --ds-code-bg: #12351f; --ds-code-border: #2f6a45; --ds-code-text: #86efac; --ds-code-hover: #17452a;
    --tabx: var(--ds-color-text-tertiary);
  }
  html[data-theme="light"] {
    --ds-color-bg-page: #f5f6f7; --ds-color-bg-surface: #fff; --ds-color-bg-subtle: #f5f6f7;
    --ds-color-text: #20242a; --ds-color-text-secondary: #6b7280; --ds-color-text-tertiary: #9aa3ab;
    --ds-color-primary: #15803d; --ds-color-primary-hover: #116632; --ds-color-primary-subtle: #e7f4ec;
    --ds-color-success: #15803d; --ds-color-warning: #ea580c; --ds-color-danger: #dc2626;
    --ds-color-info: #2563eb; --ds-color-unread: #15803d; --ds-color-disabled: #c7ced4;
    --ds-color-border: #d8dce0; --ds-color-border-subtle: #e3e6e9; --ds-color-divider: #eef1f3;
    --ds-color-link: #2563eb; --ds-color-sender: #0f766e;
    --ds-code-bg: #e7f4ec; --ds-code-border: #b7dfc6; --ds-code-text: #116632; --ds-code-hover: #d5ebdd;
    --tabx: var(--ds-color-text-tertiary);
  }
  :root { --input-border: var(--ds-color-border); }
`;

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
  ${DS_TOKENS_CSS}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  [hidden] { display: none !important; }
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
  /* 设置下拉菜单：统计 / 消息开关 / 免打扰 / 筛选 / 操作，全部左对齐 */
  .setwrap { position: relative; display: inline-flex; }
  .setmenu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 70; min-width: 224px;
             max-width: calc(100vw - 32px); max-height: calc(100vh - 96px); overflow-y: auto;
             background: var(--card); border: 1px solid var(--border); border-radius: 12px;
             box-shadow: 0 10px 28px rgba(15, 23, 42, .16); padding: 6px; display: none; }
  .setmenu.open { display: block; }
  .setmenu .grp { font-size: 11px; font-weight: 600; color: var(--faint); padding: 7px 10px 3px; text-align: left; }
  .setmenu .grp:not(:first-child) { border-top: 1px solid var(--row-border); margin-top: 5px; }
  .setmenu .opt { display: flex; width: 100%; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; }
  .setmenu .opt:hover { background: var(--bg); }
  .setmenu .tbtn { display: flex; width: 100%; align-items: center; text-align: left; font-size: 13px;
                   padding: 8px 10px; border-color: transparent; background: none; }
  .setmenu .tbtn:hover { background: var(--bg); border-color: transparent; }
  .setmenu .tbtn.on { border-color: var(--accent); background: var(--badge-bg); color: var(--accent); }
  .setmenu .btnrow { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 10px 6px; }
  .setmenu .btnrow .tbtn { width: auto; flex: none; border-color: var(--border); background: var(--card); color: var(--text); }
  .setmenu .btnrow .tbtn:hover { background: var(--card); border-color: var(--accent); color: var(--accent); }
  .setmenu .btnrow .tbtn.on { border-color: var(--accent); background: var(--badge-bg); color: var(--accent); }
  .setmenu .dndrow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 4px 10px 8px;
                     font-size: 12px; color: var(--muted); }
  .setmenu .dndrow input { width: 52px; padding: 5px 6px; border: 1px solid var(--border); border-radius: 6px;
                           font-size: 13px; background: var(--card); color: var(--text); }
  .setmenu .dndrow .tbtn { width: auto; flex: none; border-color: var(--border); background: var(--card);
                           color: var(--text); padding: 5px 12px; }
  .setmenu .dndrow .tbtn:hover { background: var(--card); border-color: var(--accent); color: var(--accent); }
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
  /* 验证码：与 DS 统一（强调色块 + 等宽字体 + 足够对比度），不改变复制与识别逻辑 */
  .code-line { margin: 6px 0 2px; color: var(--ds-color-text-secondary); font-size: var(--ds-text-xs); }
  .code-line b { font-size: 18px; letter-spacing: 1.5px; margin-right: 8px; display: inline-block;
                 font-family: var(--ds-font-mono); font-weight: var(--ds-weight-bold);
                 color: var(--ds-code-text); background: var(--ds-code-bg);
                 border: 1px solid var(--ds-code-border); padding: 1px 8px; border-radius: var(--ds-radius-sm); }
  .copy { border: 1px solid var(--ds-color-border); background: var(--ds-color-bg-surface); color: var(--ds-color-text-secondary);
          border-radius: var(--ds-radius-sm); padding: 2px 10px; cursor: pointer; font-size: var(--ds-text-xs);
          min-height: 28px; }
  .copy:hover { background: var(--ds-code-bg); border-color: var(--ds-code-border); color: var(--ds-code-text); }
  .copy:focus-visible { outline: 2px solid var(--ds-color-link); outline-offset: 2px; }
  .line { margin-top: 4px; }
  .content { word-break: break-word; white-space: pre-wrap; }
  /* 摘要卡片：固定两行截断；是否显示「查看全文」由 JS 实测溢出决定（不按字数猜） */
  .content.summary { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
                     overflow: hidden; white-space: pre-wrap; }
  .more[hidden] { display: none; }
  /* 单条已读：小尺寸、低干扰，仅未读消息出现 */
  .rbtn { border: 1px solid var(--ds-color-border); background: var(--ds-color-bg-surface);
          color: var(--ds-color-text-secondary); border-radius: var(--ds-radius-sm);
          font-size: 11px; padding: 1px 8px; cursor: pointer; min-height: 24px; line-height: 1.4; }
  .rbtn:hover { border-color: var(--ds-color-primary); color: var(--ds-color-primary); }
  .rbtn:disabled { opacity: .5; cursor: progress; }
  /* 批量操作区（列表页独立，不在设置中心） */
  .bulkbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 4px 0 8px; }
  .bulkbar .bulkmeta { color: var(--ds-color-text-secondary); font-size: 12px; }
  /* 详情弹窗：正文为主体 */
  .detail-body { white-space: pre-wrap; word-break: break-word; line-height: 1.7; font-size: 15px;
                 color: var(--ds-color-text); background: var(--ds-color-bg-subtle);
                 border: 1px solid var(--ds-color-border-subtle); border-radius: var(--ds-radius-lg);
                 padding: 12px; margin: 4px 0 10px; max-height: 46vh; overflow: auto; }
  .detail-body .empty-text { color: var(--ds-color-text-tertiary); font-size: 13px; }
  .detail-meta { border: 1px solid var(--ds-color-border-subtle); border-radius: var(--ds-radius-lg);
                 padding: 2px 12px 6px; margin-bottom: 12px; }
  .detail-sec { font-size: var(--ds-text-xs); color: var(--ds-color-text-tertiary); margin: 8px 0 2px; }
  .detail-actionrow { display: flex; flex-wrap: wrap; gap: 8px; }
  .detail-actionrow + .detail-actionrow { margin-top: 10px; }
  .content a { color: var(--link); word-break: break-all; }
  .time-line { color: var(--faint); font-size: 12px; cursor: default; }
  .foot-line { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .recv { flex: none; font-weight: 600; font-size: 12px; color: var(--muted); cursor: pointer; user-select: none; }
  .recv:hover { color: var(--text); }
  .empty { text-align: center; color: var(--faint); padding: 40px 0; }
  .pager { display: flex; gap: 8px; justify-content: center; align-items: center; margin-top: 16px; }
  /* 未读入口：数量徽章 + 文字（不只靠颜色） */
  .unreadpill { display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; }
  .unreadpill[data-on="1"] { border-color: var(--ds-color-primary); color: var(--ds-color-primary); background: var(--ds-color-primary-subtle); }
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
  .toolbar, .pager { flex-wrap: wrap; }
  .searchwrap { position: relative; flex: 1; display: flex; min-width: 140px; }
  .searchwrap input { width: 100%; }
  .searchwrap .clr { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); border: none; background: none;
         color: var(--faint); font-size: 16px; cursor: pointer; padding: 0 4px; line-height: 1; }
  .clr:hover { color: var(--text); }
  .tbtn { border: 1px solid var(--border); background: var(--card); color: var(--text); border-radius: 8px;
          padding: 5px 10px; font-size: 12px; cursor: pointer; }
  .tbtn:hover { border-color: var(--accent); color: var(--accent); }
  .langmenu { position: fixed; z-index: 200; background: var(--card); border: 1px solid var(--border);
              border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.14); padding: 4px; min-width: 150px; }
  .langitem { padding: 8px 14px; border-radius: 7px; cursor: pointer; font-size: 13px; white-space: nowrap; color: var(--text); }
  .langitem:hover { background: var(--ds-color-bg-subtle); }
  .langitem.cur { color: var(--accent); font-weight: 600; }
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
  /* 主题三态已并入 DS_TOKENS_CSS（见文件顶部 const） */
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
  .srctag.s-alert { background: var(--ds-color-warning); color: #fff; }
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
  .star.on { color: var(--ds-color-warning); }
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
  /* 接入令牌面板（设置菜单入口 → 复用 .modal/.sheet 弹层，移动端自动底部抽屉） */
  .tokrow { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--ds-color-divider); flex-wrap: wrap; }
  .tokmain { flex: 1 1 160px; min-width: 0; }
  .tokname { font-weight: 600; font-size: 14px; word-break: break-all; }
  .tokmeta { font-size: 12px; opacity: .65; margin-top: 2px; }
  .tokrow.revoked .tokname, .tokrow.revoked .tokmeta { opacity: .45; }
  .tokbadge { font-size: var(--ds-text-xs); padding: 1px 8px; border-radius: var(--ds-radius-pill);
              background: var(--ds-color-bg-subtle); color: var(--ds-color-text-secondary); white-space: nowrap; }
  .tokrow.revoked .tokbadge { opacity: .6; }
  .tokacts { display: flex; gap: 6px; }
  .toknote { font-size: 12px; line-height: 1.6; padding: 8px 10px; border-radius: 8px;
             background: var(--ds-color-bg-subtle); border-left: 3px solid var(--ds-color-warning);
             color: var(--ds-color-text-secondary); margin: 0 0 10px; }
  .toknewrow { display: flex; align-items: center; gap: 8px; margin: 12px 0 4px; flex-wrap: wrap; }
  .toknewrow [hidden] { display: none !important; }
  .foot .ver { opacity: .6; }
  .toksecret { font-family: var(--ds-font-mono); font-size: var(--ds-text-sm); word-break: break-all;
               padding: 10px; border-radius: var(--ds-radius-md); background: var(--ds-color-bg-subtle); user-select: all; }
  /* 设置表单（通知设置 / 业务设置）：弹层内可滚动，沿用令牌面板的输入风格 */
  .setform { max-height: 62vh; overflow: auto; padding-right: 4px; }
  .setgrp { padding: 10px 0 6px; border-top: 1px solid var(--ds-color-divider); }
  .setgrp:first-child { border-top: 0; }
  .setgrp h4 { margin: 0 0 6px; font-size: 14px; display: flex; align-items: center; gap: 8px; }
  .setgrp h4 .tokbadge { margin-left: auto; }
  .setrow { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 13px; flex-wrap: wrap; }
  .setrow > label { flex: 0 0 auto; min-width: 76px; color: var(--muted); }
  /* 本浏览器偏好：四项开关固定一行，触屏点整块即可切换 */
  .setrow > label:empty { display: none; }
  .prefgrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 4px 0 10px; }
  .prefitem { display: flex; align-items: center; justify-content: space-between; gap: 6px;
              min-height: 38px; padding: 6px 8px; border: var(--ds-border-w) solid var(--ds-color-border-subtle);
              border-radius: var(--ds-radius-md); background: var(--ds-color-bg-subtle);
              font-size: var(--ds-text-xs); color: var(--ds-color-text-secondary); cursor: pointer; }
  .prefitem span { min-width: 0; line-height: 1.35; overflow-wrap: anywhere; }
  .prefitem input { flex: none; }
  .setrow input[type="text"], .setrow input[type="password"], .setrow input[type="number"], .setrow select,
  .toknewrow input, .toknewrow select {
    flex: 1 1 140px; min-width: 0; min-height: var(--ds-control-h-sm); padding: 6px 8px;
    border: var(--ds-border-w) solid var(--ds-color-border); border-radius: var(--ds-radius-md);
    background: var(--ds-color-bg-surface); color: var(--ds-color-text); font-size: var(--ds-text-sm); }
  .setrow .clr { position: static; right: auto; top: auto; transform: none; flex: 0 0 auto; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; color: var(--muted); white-space: nowrap; }
  .setrow #scdnds, .setrow #scdnde { flex: 0 1 76px; min-width: 60px; }
  .setrow .settest { flex: 0 0 auto; }
  /* 通知推送：已配置列表 / 方案选择 / 第二层编辑弹层 */
  .pushlist { display: flex; flex-direction: column; gap: 8px; margin: 6px 0 4px; }
  .pushcard { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--bg); }
  .pushcard--off { opacity: .62; }
  .pushcard-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pushcard-name { font-weight: 600; font-size: 13.5px; word-break: break-all; }
  .pushbadge { font-size: var(--ds-text-xs); padding: 1px 8px; border-radius: var(--ds-radius-pill);
               background: var(--ds-color-bg-subtle); color: var(--ds-color-text-secondary); white-space: nowrap; }
  .pushbadge.on { background: var(--badge-bg); color: var(--accent); }
  .pushbadge.off { color: var(--muted); }
  .pushcard-meta { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .pushcard-fields { font-size: 11.5px; color: var(--faint); margin-top: 2px; word-break: break-all; }
  .pushcard-acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .pushempty { font-size: 12.5px; color: var(--muted); padding: 10px 0; }
  .pushpicks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 6px 0 4px; }
  .pushpick { border: 1px solid var(--border); background: var(--card); color: var(--text); border-radius: 10px;
              padding: 12px 10px; font-size: 13px; cursor: pointer; min-height: 44px; }
  .pushpick:hover { border-color: var(--accent); color: var(--accent); }
  .pushchan { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 10px;
              background: var(--badge-bg); color: var(--accent); margin-bottom: 6px; }
  .pushmodal { z-index: 140; }
  .pushsheet { max-width: 520px; max-height: 86vh; overflow: auto; }
  .pushsheet .setrow > label { min-width: 72px; }
  .setnote { font-size: 12px; opacity: .65; line-height: 1.6; margin: 4px 0 8px; }
  .tokwarn { color: var(--ds-color-danger); font-size: 13px; font-weight: 600; margin: 10px 0; }
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
    /* 设置菜单内触控目标加大，降低误触 */
    .setmenu .tbtn, .setmenu .opt { min-height: 42px; }
    /* 窄屏：桌面右对齐下拉在矮/窄屏易溢出，改底部抽屉（与 .sheet 弹层同风格），
       贴安全区 + 限高内部滚动，平板小笔记本均不溢出 */
    .setmenu { position: fixed; left: 16px; right: 16px; top: auto; width: auto;
               bottom: calc(16px + env(safe-area-inset-bottom, 0px));
               min-width: 0; max-width: none; max-height: 72vh; }
    .selbar { width: calc(100% - 24px); justify-content: space-between; border-radius: 14px; }
    .barrow .bl { width: 54px; }
  }
  /* 无精确指针（手机/平板）：开关加大到 44x26，便于拇指操作 */
  @media (hover: none) {
    .opt .switch { width: 44px; height: 26px; }
    .opt .switch::after { width: 20px; height: 20px; }
    .opt input:checked + .switch::after { transform: translateX(18px); }
  }
  /* ===== DS COMPONENTS v1（可复用组件层：新页面用 .ds-*，旧页面继续用既有类名，两者同源同视觉） ===== */
  /* 焦点可见：键盘操作统一焦点环，不因视觉简洁而删除 */
  :where(button, .tbtn, .tab, .ds-btn, a, input, select, textarea):focus-visible {
    outline: 2px solid var(--ds-color-link); outline-offset: 2px;
  }
  .ds-btn { border: var(--ds-border-w) solid var(--ds-color-border); background: var(--ds-color-bg-surface);
            color: var(--ds-color-text); border-radius: var(--ds-radius-md); padding: 5px 10px;
            font-size: var(--ds-text-sm); cursor: pointer; min-height: var(--ds-control-h-sm);
            transition: border-color .15s ease, color .15s ease, background .15s ease; }
  .ds-btn:hover:not(:disabled) { border-color: var(--ds-color-primary); color: var(--ds-color-primary); }
  .ds-btn:disabled { opacity: .5; cursor: not-allowed; }
  .ds-btn--primary { background: var(--ds-color-primary); border-color: var(--ds-color-primary); color: #fff; font-weight: var(--ds-weight-medium); }
  .ds-btn--primary:hover:not(:disabled) { background: var(--ds-color-primary-hover); border-color: var(--ds-color-primary-hover); color: #fff; }
  .ds-btn--danger { border-color: var(--ds-color-danger); color: var(--ds-color-danger); }
  .ds-btn--danger:hover:not(:disabled) { background: var(--ds-color-danger); color: #fff; }
  .ds-btn--block { width: 100%; }
  .ds-btn[data-loading="1"] { opacity: .7; cursor: progress; }
  .ds-btn[data-loading="1"]::after { content: ""; display: inline-block; width: 10px; height: 10px;
    margin-left: 6px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
    animation: dsspin .7s linear infinite; vertical-align: -1px; }
  @keyframes dsspin { to { transform: rotate(360deg); } }
  .ds-input, .ds-select { min-height: var(--ds-control-h-sm); padding: 6px 8px;
    border: var(--ds-border-w) solid var(--ds-color-border); border-radius: var(--ds-radius-md);
    background: var(--ds-color-bg-surface); color: var(--ds-color-text); font-size: var(--ds-text-sm); }
  .ds-input::placeholder { color: var(--ds-color-text-tertiary); }
  .ds-input[aria-invalid="true"], .ds-input:invalid { border-color: var(--ds-color-danger); }
  .ds-field { display: flex; flex-direction: column; gap: var(--ds-space-1); margin: var(--ds-space-3) 0; }
  .ds-field > label { font-size: var(--ds-text-sm); font-weight: var(--ds-weight-medium); color: var(--ds-color-text); }
  .ds-help { font-size: var(--ds-text-xs); line-height: var(--ds-leading); color: var(--ds-color-text-secondary); }
  .ds-error-text { font-size: var(--ds-text-xs); color: var(--ds-color-danger); }
  .ds-card { background: var(--ds-color-bg-surface); border: var(--ds-border-w) solid var(--ds-color-border-subtle);
    border-radius: var(--ds-radius-lg); padding: var(--ds-space-4); }
  .ds-group-title { display: flex; align-items: center; gap: var(--ds-space-2);
    font-size: var(--ds-text-md); font-weight: var(--ds-weight-medium); color: var(--ds-color-text);
    margin: var(--ds-space-4) 0 var(--ds-space-2); padding-top: var(--ds-space-3);
    border-top: var(--ds-border-w) solid var(--ds-color-divider); }
  .ds-group-title:first-child { border-top: 0; padding-top: 0; }
  .ds-badge { display: inline-flex; align-items: center; gap: 4px; font-size: var(--ds-text-xs);
    font-weight: var(--ds-weight-medium); padding: 1px 8px; border-radius: var(--ds-radius-pill);
    background: var(--ds-color-bg-subtle); color: var(--ds-color-text-secondary); white-space: nowrap; }
  .ds-badge--success { background: var(--ds-color-primary-subtle); color: var(--ds-color-success); }
  .ds-badge--warning { background: rgba(234,88,12,.12); color: var(--ds-color-warning); }
  .ds-badge--danger { background: rgba(220,38,38,.12); color: var(--ds-color-danger); }
  .ds-badge--info { background: rgba(37,99,235,.12); color: var(--ds-color-info); }
  /* 配置作用域徽章：全局 / 本浏览器（图标+文字，不只依赖颜色） */
  .ds-scope { display: inline-flex; align-items: center; gap: 4px; font-size: var(--ds-text-xs);
    padding: 1px 8px; border-radius: var(--ds-radius-pill); border: var(--ds-border-w) solid var(--ds-color-border); }
  .ds-scope--global { color: var(--ds-color-info); }
  .ds-scope--browser { color: var(--ds-color-warning); }
  .ds-alert { display: block; font-size: var(--ds-text-xs);
    line-height: var(--ds-leading); padding: var(--ds-space-3) var(--ds-space-3);
    border-radius: var(--ds-radius-md); border-left: 3px solid var(--ds-color-info);
    background: var(--ds-color-bg-subtle); color: var(--ds-color-text-secondary); margin: var(--ds-space-3) 0; }
  .ds-alert b { font-weight: 600; color: var(--ds-color-text); }
  .ds-alert--warning { border-left-color: var(--ds-color-warning); }
  .ds-alert--danger { border-left-color: var(--ds-color-danger); color: var(--ds-color-danger); }
  .ds-empty { text-align: center; color: var(--ds-color-text-tertiary); padding: var(--ds-space-7) var(--ds-space-4);
    font-size: var(--ds-text-sm); }
  .ds-switch { position: relative; flex: none; width: 40px; height: 22px; border-radius: var(--ds-radius-pill);
    background: var(--ds-color-disabled); border: var(--ds-border-w) solid var(--ds-color-border);
    transition: background .2s ease, border-color .2s ease; }
  .ds-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
    border-radius: 50%; background: #fff; box-shadow: var(--ds-shadow-1); transition: transform .2s ease; }
  input:checked + .ds-switch { background: var(--ds-color-primary); border-color: var(--ds-color-primary); }
  input:checked + .ds-switch::after { transform: translateX(18px); }
  .ds-check, .ds-radio { width: 16px; height: 16px; accent-color: var(--ds-color-primary); cursor: pointer; }
  /* 重要操作密码确认层（独立于通用弹层，避免覆盖设置中心的未保存内容） */
  .pwdmodal { position: fixed; inset: 0; background: rgba(0,0,0,.42); display: flex; align-items: center;
    justify-content: center; z-index: 130; padding: var(--ds-space-5); }
  .pwdmodal[hidden] { display: none; }
  .pwdsheet { width: 100%; max-width: 380px; background: var(--ds-color-bg-surface); color: var(--ds-color-text);
    border: var(--ds-border-w) solid var(--ds-color-border-subtle); border-radius: var(--ds-radius-lg);
    padding: var(--ds-space-5); box-shadow: 0 12px 32px rgba(0,0,0,.18); }
  .pwdsheet h3 { margin: 0 0 var(--ds-space-2); font-size: var(--ds-text-md); font-weight: var(--ds-weight-medium); }
  .pwdhelp { margin: 0 0 var(--ds-space-3); font-size: var(--ds-text-sm); line-height: var(--ds-leading);
    color: var(--ds-color-text-secondary); }
  .pwderr { margin-top: var(--ds-space-2); font-size: var(--ds-text-xs); color: var(--ds-color-danger); }
  .pwdacts { display: flex; justify-content: flex-end; gap: var(--ds-space-2); margin-top: var(--ds-space-4); }
  .ds-modal { position: fixed; inset: 0; background: rgba(0,0,0,.42); display: flex; align-items: center;
    justify-content: center; z-index: 100; padding: var(--ds-space-5); }
  .ds-modal[hidden] { display: none; }
  .ds-sheet { position: relative; background: var(--ds-color-bg-surface); color: var(--ds-color-text);
    border-radius: var(--ds-radius-xl); width: 100%; max-width: 560px; max-height: 86vh; overflow: auto;
    padding: var(--ds-space-5); border: var(--ds-border-w) solid var(--ds-color-border); }
  .ds-dialog-actions { display: flex; flex-wrap: wrap; gap: var(--ds-space-3); justify-content: flex-end; margin-top: var(--ds-space-4); }
  /* 设置中心：分组标签行（独立胶囊，桌面横向滚动、窄屏两列网格，保证间距清晰可点） */
  .ds-tabs { display: flex; gap: 8px; overflow-x: auto; padding: 2px 0 12px; margin-bottom: 12px;
             border-bottom: 1px solid var(--ds-color-divider);
             -webkit-overflow-scrolling: touch; scrollbar-width: thin; }
  .ds-tabs > .tab { min-height: 32px; padding: 5px 14px; }
  .ds-tabs::-webkit-scrollbar { height: 3px; }
  .ds-inline { display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; font-size: var(--ds-text-sm); }
  /* 设置表单：字段行统一走令牌（标签在上、说明在下，窄屏自动堆叠） */
  .setrow > label { color: var(--ds-color-text-secondary); font-size: var(--ds-text-sm); }
  .setnote, .tokmeta { color: var(--ds-color-text-secondary); }
  .tokwarn { color: var(--ds-color-danger); }
  .srctag.s-notify { background: var(--ds-color-info); }
  .srctag.s-alert { background: var(--ds-color-warning); }
  .srctag.s-other { background: var(--ds-color-text-secondary); }
  .star.on { color: var(--ds-color-warning); }
  /* ===== V2 仪表盘布局：消息中心（与静态原型对齐） ===== */
  body { background: var(--bg); }
  .wrap { max-width: 1180px; padding: 18px 20px 40px; }
  .gh { display: none; }
  .topbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 16px; }
  .brand { display: flex; align-items: center; gap: 11px; }
  .logo { width: 38px; height: 38px; border-radius: 11px; background: var(--accent); color: #fff;
          display: grid; place-items: center; font-weight: 800; font-size: 15px; box-shadow: var(--ds-shadow-1); }
  .top-actions { display: flex; gap: 8px; align-items: center; }
  .top-actions .tbtn { padding: 7px 12px; min-height: 34px; font-size: 13px; border-radius: 8px; }
  .page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin: 0 0 14px; }
  .page-head h1 { font-size: 22px; letter-spacing: -.4px; margin: 0 0 2px; }
  .subtitle { color: var(--muted); font-size: 12px; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 268px; gap: 14px; align-items: start; }
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--ds-shadow-1); }
  .toolbar { display: block; padding: 12px 16px; margin: 0; border-bottom: 1px solid var(--row-border); }
  .toolbar-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
  .toolbar-title { font-size: 15px; font-weight: 700; }
  .toolbar-title #stat { font-size: 12px; color: var(--muted); font-weight: 400; margin-left: 6px; }
  .filters { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .chip { border: 1px solid var(--border); background: var(--card); border-radius: 999px; padding: 5px 11px;
          color: var(--muted); font-size: 12px; min-height: 30px; cursor: pointer; }
  .chip:hover { border-color: var(--accent); color: var(--accent); }
  .chip.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .filters .searchwrap { flex: 1; min-width: 170px; margin-left: auto; }
  .filters .searchwrap input { min-height: 32px; padding: 6px 28px 6px 10px; border-radius: 8px; font-size: 13px; }
  .filters select { min-height: 32px; padding: 5px 8px; border-radius: 8px; font-size: 12px;
                    background: var(--card); color: var(--text); border: 1px solid var(--border); }
  .bulk { display: none; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 16px;
          background: var(--ds-color-bg-subtle); border-bottom: 1px solid var(--row-border); font-size: 12px; color: var(--muted); }
  body.selecting .bulk { display: flex; }
  .bulk[hidden] { display: none; }
  .bulk .count { font-weight: 600; color: var(--accent); }
  .bulk .spacer { flex: 1; }
  .bulk .tbtn { padding: 4px 9px; font-size: 12px; min-height: 28px; }
  .bulk-check { display: flex; align-items: center; gap: 6px; color: var(--muted); }
  .select-hint { font-size: 11px; color: var(--faint); margin-left: 6px; font-weight: 400; }
  .list { display: block; padding: 0 16px; }
  .daysep { font-size: 11px; color: var(--faint); font-weight: 600; margin: 12px 0 2px; }
  .card { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; background: transparent;
          border: 0; border-bottom: 1px solid var(--row-border); border-radius: 6px; padding: 14px 0;
          animation: slidein .25s ease-out; position: relative; -webkit-touch-callout: none;
          -webkit-user-select: none; user-select: none; }
  .card:last-child { border-bottom: 0; }
  .card.selected { background: var(--ds-color-primary-subtle); }
  .card.pressing { background: var(--ds-color-bg-subtle); }
  .device-icon { width: 30px; height: 30px; border-radius: 8px; background: var(--accent-bg); display: grid;
                 place-items: center; color: var(--accent); font-size: 13px; flex: none; }
  .tab .tmain { min-width: 0; flex: 1; display: flex; flex-direction: column; }
  .tab .tsub, .tab .tname { display: block; }
  body.selecting .card { grid-template-columns: 20px minmax(0, 1fr); }
  .card.flash { animation: slidein .25s ease-out, flash 1.6s ease-out; }
  .selwrap { display: none; padding-top: 3px; }
  body.selecting .selwrap { display: block; position: static; }
  .selwrap input { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; }
  .msg-main { min-width: 0; }
  .msg-top { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-bottom: 4px; }
  .avatar-sm { width: 26px; height: 26px; border-radius: 50%; flex: none; display: grid; place-items: center;
               background: var(--accent-bg); color: var(--accent); font-size: 12px; font-weight: 700; }
  .sender { font-size: 14px; font-weight: 700; color: var(--text); }
  .phone { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .tag { font-size: 11px; border-radius: 5px; padding: 1px 7px; background: var(--bg); color: var(--muted); white-space: nowrap; }
  .tag.type { background: rgba(37,99,235,.10); color: var(--ds-color-info); }
  .tag.unread-tag { background: var(--ds-color-primary-subtle); color: var(--ds-color-primary); }
  .tag.star-tag { color: var(--ds-color-warning); background: transparent; }
  .msg-time { margin-left: auto; color: var(--faint); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .content.summary { margin: 0 0 7px; font-size: 13px; line-height: 1.6; color: var(--muted); white-space: pre-wrap; }
  .msg-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .msg-meta { font-size: 11px; color: var(--faint); }
  .msg-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; flex-wrap: wrap; }
  .msg-actions .star, .msg-actions .del { border: 0; background: none; color: var(--faint); cursor: pointer;
                                          font-size: 12px; padding: 4px 5px; border-radius: 6px; margin: 0; }
  .msg-actions .star.on { color: var(--ds-color-warning); }
  .msg-actions .star:hover, .msg-actions .del:hover { background: var(--bg); }
  .msg-actions .del { color: var(--faint); display: none; }
  .msg-actions .del:hover { color: var(--danger); }
  body.selecting .msg-actions .del { display: inline-flex; }
  .msg-actions .rbtn { border: 1px solid var(--accent); background: var(--accent-bg); color: var(--accent);
                       border-radius: 7px; font-size: 12px; padding: 4px 9px; min-height: 28px; cursor: pointer; }
  .msg-actions .more { border: 0; background: none; color: var(--link); font-size: 12px; padding: 4px 5px; }
  .msg-actions .more:hover { background: var(--bg); }
  /* 验证码胶囊：顶部右侧；主色绿（与全局强调色一致），右段为实心复制按钮 */
  .code-chip { display: inline-flex; align-items: stretch; overflow: hidden; font-family: var(--ds-font-mono);
               font-size: 12px; font-weight: 700; color: var(--accent); background: var(--accent-bg);
               border: 1px solid var(--accent); border-radius: 7px; line-height: 1; }
  .code-chip .code-val { display: inline-flex; align-items: center; padding: 2px 7px 2px 8px; letter-spacing: 1px; color: var(--accent); }
  .code-chip .copy { display: inline-flex; align-items: center; justify-content: center; border: 0;
                     border-left: 1px solid var(--accent); background: var(--accent); color: #fff;
                     font-family: var(--ds-font-family); font-size: 11px; font-weight: 600; padding: 2px 9px;
                     min-height: 22px; min-width: 40px; cursor: pointer; transition: background .15s; }
  .code-chip .copy:hover { background: var(--accent-deep); }
  .code-chip .copy:active { background: var(--accent-deep); filter: brightness(.94); }
  .code-chip .copy:disabled { opacity: .75; cursor: default; }
  .code-chip .copy:focus-visible { outline: 2px solid var(--ds-color-link); outline-offset: -2px; }
  .msg-top .code-chip { margin-left: 6px; }
  .plan-hint { color: var(--faint); font-size: 11px; }
  /* 右侧栏 */
  .sidebar { display: flex; flex-direction: column; gap: 12px; }
  .side-card { padding: 14px 16px; }
  .side-title { font-weight: 700; font-size: 13px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .side-title .mini-link { font-size: 12px; font-weight: 500; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; }
  .tabs { display: flex; flex-direction: column; gap: 0; overflow: visible; padding: 0; margin: 0; }
  .tabs > .tab { display: flex; align-items: center; gap: 8px; flex: none; padding: 8px 0; border: 0; border-bottom: 1px solid var(--row-border);
         border-radius: 0; background: none; cursor: pointer; font-size: 12px; color: var(--text); white-space: normal; text-align: left; }
  .tabs > .tab:last-child { border-bottom: 0; }
  .tabs > .tab.active { background: none; color: var(--accent); font-weight: 600; }
  .tabs > .tab .tname { font-weight: 600; }
  .tabs > .tab .tsub { font-size: 11px; color: var(--faint); font-weight: 400; }
  .tabs > .tab .tcount { margin-left: auto; font-size: 11px; color: var(--faint); white-space: nowrap; }
  .tabs > .tab .tabop { margin-left: 0; font-size: 12px; padding: 2px 3px; }
  .settings-rows, .side-rows { display: flex; flex-direction: column; gap: 2px; }
  .settings-mini, .side-row { display: flex; justify-content: space-between; align-items: center; gap: 8px;
                              padding: 7px 0; border-bottom: 1px solid var(--row-border); font-size: 12px; color: var(--muted); }
  .settings-mini:last-child, .side-row:last-child { border-bottom: 0; }
  .settings-mini strong, .side-row strong { color: var(--text); font-size: 12px; font-weight: 600; }
  .scope { font-size: 10px; border: 1px solid var(--border); border-radius: 999px; padding: 0 6px; color: var(--muted); white-space: nowrap; }
  .scope.browser { color: var(--ds-color-warning); border-color: var(--ds-color-warning); }
  .scope.global { color: var(--ds-color-info); border-color: var(--ds-color-info); }
  .pagination { padding: 11px 16px; border-top: 1px solid var(--row-border); display: flex; align-items: center;
                justify-content: space-between; color: var(--faint); font-size: 11px; gap: 8px; flex-wrap: wrap; }
  .pages { display: flex; gap: 4px; align-items: center; }
  .pages button { border: 1px solid var(--border); background: var(--card); border-radius: 6px; padding: 3px 9px; color: var(--muted); font-size: 12px; min-height: 28px; }
  .pages button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .pages button:disabled { opacity: .4; cursor: default; }
  .jumpwrap { display: flex; gap: 6px; align-items: center; }
  .jumpwrap input { width: 64px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px;
                    background: var(--card); color: var(--text); font-size: 12px; min-height: 28px; }
  .jumpwrap button { border: 1px solid var(--border); background: var(--card); color: var(--text); border-radius: 6px;
                     padding: 3px 9px; font-size: 12px; min-height: 28px; cursor: pointer; }
  .selbar { position: static; transform: none; left: auto; bottom: auto; display: flex; align-items: center; gap: 8px;
            background: var(--ds-color-bg-subtle); border: 0; border-bottom: 1px solid var(--row-border); border-radius: 0;
            padding: 8px 16px; z-index: auto; flex-wrap: wrap; }
  .selbar span { font-size: 12px; color: var(--muted); }
  .selbar .tbtn { min-height: 28px; font-size: 12px; padding: 4px 9px; }
  .newpill { bottom: 26px; background: var(--accent); }
  .foot { margin-top: 24px; }
  /* 详情/设置弹层：与原型一致的宽版卡片 */
  .modal { background: rgba(15,25,43,.45); align-items: center; }
  .sheet { max-width: 760px; max-height: 90vh; padding: 0; border-radius: 14px; overflow: auto; }
  .sheet h3 { font-size: 15px; margin: 0 30px 2px 0; }
  .mx { top: 12px; right: 12px; width: 30px; height: 30px; border-radius: 8px; background: var(--bg); font-size: 18px; }
  #modalbody { padding: 16px 18px 12px; }
  .drow { font-size: 12px; }
  .detail-content { font-size: 15px; background: var(--ds-color-bg-subtle); border: 1px solid var(--border);
                    border-radius: 10px; padding: 14px 15px; max-height: 38vh; overflow: auto; }
  .detail-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--row-border); }
  .detail-actions .tbtn { font-size: 12px; min-height: 30px; }
  .setform { max-height: 64vh; }
  .setgrp { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px;
            margin: 0 0 10px; border-top: 1px solid var(--border); }
  .setgrp h4 { font-size: 13px; margin: 0 0 2px; }
  .setgrp .ds-help { margin: 3px 0 3px; display: block; }
  .setrow { padding: 6px 0; margin: 0; }
  .setrow > label { font-size: 12px; }
  .settest { font-size: 12px; }
  /* 详情单行元信息 + 底部一行按钮 */
  .detail-metarow { display: flex; flex-wrap: wrap; align-items: center; gap: 0 6px; font-size: 11.5px;
                    color: var(--muted); line-height: 1.6; margin-bottom: 8px; }
  .detail-metarow .sep { color: var(--faint); }
  .detail-metarow .m-strong { color: var(--text); font-weight: 600; }
  .detail-metarow .m-num { font-variant-numeric: tabular-nums; }
  .detail-metarow .m-star { color: var(--ds-color-warning); font-weight: 700; }
  /* 底部操作统一单行：不换行，空间不足时横向滚动（触屏滑动 / 鼠标滚轮） */
  .modal-foot { display: flex; align-items: center; justify-content: flex-start; gap: 8px; flex-wrap: nowrap;
                overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch;
                padding: 12px 18px 16px; border-top: 1px solid var(--row-border); }
  .modal-foot::-webkit-scrollbar { display: none; }
  .modal-foot .foot-left, .modal-foot .foot-right { display: flex; gap: 6px; align-items: center; flex-wrap: nowrap; flex: 0 0 auto; }
  .modal-foot .foot-right { margin-left: auto; }
  @media (max-width: 960px) { .layout { grid-template-columns: 1fr; } .sidebar { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 660px) {
    .wrap { padding: 14px 12px 30px; }
    .page-head h1 { font-size: 20px; }
    .sidebar { grid-template-columns: 1fr; }
    .list { padding: 0 12px; }
    .card { padding: 12px 0; }
    .msg-time { margin-left: 0; }
    .msg-top .code-chip { margin-left: auto; }
    .msg-bottom { flex-direction: column; align-items: flex-start; gap: 6px; }
    .msg-actions { align-self: flex-end; }
    .code-chip .copy { min-height: 26px; padding: 3px 10px; }
    .filters .searchwrap { width: 100%; margin-left: 0; }
    /* 批量操作条：宽度贴合列表、隐藏冗余提示、按钮等宽三列，避免参差换行 */
    .selbar { width: auto; padding: 10px 12px; gap: 8px; }
    .selbar .select-hint { display: none; }
    .selbar .spacer { display: block; flex: 0 0 100%; height: 0; }
    .selbar .count { margin-left: auto; }
    .selbar .tbtn { flex: 1 1 calc(33.333% - 8px); min-width: 84px; min-height: 34px;
                    display: inline-flex; align-items: center; justify-content: center; text-align: center; }
    /* 设置分组标签：单行横向滑动，避免两行网格占用过多空间 */
    .ds-tabs { display: flex; flex-wrap: nowrap; gap: 8px; overflow-x: auto;
               padding: 0 0 12px; scroll-snap-type: x proximity;
               -webkit-overflow-scrolling: touch; scrollbar-width: none; }
    .ds-tabs::-webkit-scrollbar { display: none; }
    .ds-tabs > .tab { width: auto; flex: 0 0 auto; justify-content: center; text-align: center;
                      min-height: 38px; padding: 7px 14px; white-space: nowrap; scroll-snap-align: start; }
    .modal { align-items: flex-end; padding: 0; }
    .sheet { border-radius: 18px 18px 0 0; max-height: 88dvh; }
    /* 详情弹窗按钮：单行横向滑动，触屏可左右滑，鼠标滚轮可横向滚动 */
    .modal-foot { flex-direction: row; flex-wrap: nowrap; align-items: center; gap: 8px;
                  overflow-x: auto; scroll-snap-type: x proximity; -webkit-overflow-scrolling: touch;
                  scrollbar-width: none; padding: 12px 14px calc(14px + env(safe-area-inset-bottom, 0px)); }
    .modal-foot::-webkit-scrollbar { display: none; }
    .modal-foot .foot-left, .modal-foot .foot-right { width: auto; flex: 0 0 auto;
                  display: flex; flex-wrap: nowrap; gap: 8px; justify-content: flex-start; }
    .modal-foot .tbtn { width: auto; flex: 0 0 auto; min-width: 78px; min-height: 38px;
                        padding: 0 12px; display: inline-flex;
                        align-items: center; justify-content: center; text-align: center;
                        scroll-snap-align: start; }
    /* 设置底部操作：保存整行主按钮，恢复默认/取消并排（取消隐藏时不留空位） */
    .ds-dialog-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-start; margin-top: 14px; }
    .ds-dialog-actions .ds-btn { flex: 0 0 auto; min-height: 38px; }
    .ds-dialog-actions #scrcancel { flex: 1 1 auto; }
    .ds-dialog-actions #scrsave { flex: 1 1 100%; }
    /* 推送卡片操作：一行四等宽，紧凑不换行 */
    .pushcard-acts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
    .pushcard-acts .tbtn { width: 100%; min-height: 34px; padding: 0 4px; font-size: 12px;
                           display: inline-flex; align-items: center; justify-content: center; text-align: center; }
    .pushcard { padding: 10px 12px; }
    .setgrp { padding: 12px; }
    .setrow { gap: 6px; margin: 5px 0; }
    .setrow > label { min-width: 0; flex: 0 0 82px; font-size: 12px; }
    .pushpicks { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .pushsheet { max-width: none; max-height: 88dvh; }
  }
</style>
</head>
<body>
<a class="gh" href="https://github.com/ShenDoyle/SMSToWeb" target="_blank" rel="noopener noreferrer" data-i18n-title="ghRepo" title="GitHub 仓库" data-i18n-aria="ghRepo" aria-label="GitHub 仓库">
  <svg viewBox="0 0 16 16" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
</a>
<div class="wrap">
  <header class="topbar">
    <div class="brand">
      <div class="logo">SMS</div>
    </div>
    <div class="top-actions">
      <button class="tbtn" id="themebtn" data-i18n-title="themeTip">自动</button>
      <button class="tbtn" id="setbtn" data-i18n-title="settings" data-i18n="settings">⚙ 设置</button>
    </div>
  </header>

  <section class="page-head">
    <div>
      <h1>__SITE_NAME__</h1>
      <div class="subtitle" data-i18n="pageSub">集中查看设备短信，快速处理未读消息</div>
    </div>
  </section>

  <div class="layout">
    <main class="panel">
      <div class="toolbar">
        <div class="toolbar-top">
          <div class="toolbar-title"><span data-i18n="listTitle">短信列表</span><span id="stat"></span></div>
          <button class="tbtn" id="refreshbtn" type="button" data-i18n-title="refresh" data-i18n="refresh" title="刷新">↻ 刷新</button>
        </div>
        <div class="filters">
          <button class="chip active" id="fall" type="button" data-i18n="tabAll">全部</button>
          <button class="chip" id="funread" type="button" data-i18n="unread">未读</button>
          <button class="chip" id="fread" type="button" data-i18n="read">已读</button>
          <button class="chip" id="fstar" type="button"><span data-i18n="starOnly">★ 收藏</span></button>
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
      </div>

      <div class="selbar" id="selbar" hidden>
        <label class="bulk-check"><input type="checkbox" id="selall"> <span data-i18n="selAllList">选择当前列表</span></label>
        <span class="count" id="selcount">已选 0 条</span>
        <span class="select-hint" data-i18n="selectHint">右键或长按消息可多选</span>
        <span class="spacer"></span>
        <span class="select-hint" data-i18n="exportHint">导出当前筛选结果</span>
        <button class="tbtn" id="exportcsv" data-i18n-title="exportCsvTip" data-i18n="exportCsv" title="按当前筛选导出 CSV">导出 CSV</button>
        <button class="tbtn" id="exportjson" data-i18n-title="exportJsonTip" data-i18n="exportJson" title="按当前筛选导出 JSON">导出 JSON</button>
        <button class="tbtn" id="selread" data-i18n="markReadSelected">批量已读</button>
        <button class="tbtn" id="seldel" disabled data-i18n="del">删除</button>
        <button class="tbtn" id="clearbtn" data-i18n-title="clearTip" data-i18n="clear" title="清空当前筛选结果（软删除）">清空</button>
        <button class="tbtn" id="selcancel" data-i18n="cancel">取消</button>
      </div>

      <div class="list" id="list"><div class="sk"><div class="skc"></div><div class="skc"></div><div class="skc"></div></div></div>
      <div class="pagination">
        <span id="pageinfo"></span>
        <div class="pages">
          <button id="prev" type="button" data-i18n="prev">‹</button>
          <span id="pagenum"></span>
          <button id="next" type="button" data-i18n="next">›</button>
        </div>
        <div class="jumpwrap">
          <input id="jump" type="number" min="1" inputmode="numeric" data-i18n-ph="jumpPh" data-i18n-title="jumpTip" placeholder="页码" title="输入页码后回车跳转">
          <button id="gojump" type="button" data-i18n="go">跳转</button>
        </div>
      </div>
    </main>

    <aside class="sidebar">
      <section class="panel side-card">
        <div class="side-title"><span data-i18n="devices">设备</span></div>
        <div class="tabs" id="tabs" role="tablist" data-i18n-aria="devices" aria-label="设备标签"></div>
      </section>
      <section class="panel side-card">
        <div class="side-title"><span data-i18n="settingsOverview">设置概览</span><button class="mini-link" id="sideSetBtn" type="button" data-i18n="openSettings">打开设置中心</button></div>
        <div class="settings-rows" id="sideSettings"></div>
      </section>
      <section class="panel side-card">
        <div class="side-title"><span data-i18n="quickOverview">快捷概览</span><button class="mini-link" id="sideStatsBtn" type="button" data-i18n="viewStats">查看统计</button></div>
        <div class="side-rows" id="sideQuick"></div>
        <div class="side-row"><span data-i18n="unread">未读</span><strong><span id="unreadcount">0</span></strong></div>
      </section>
    </aside>
  </div>

  <footer class="foot">© 2026 <a href="https://cbm.im/" target="_blank" rel="noopener noreferrer">左立方</a> · <a href="https://github.com/ShenDoyle/SMSToWeb" target="_blank" rel="noopener noreferrer">SMSToWeb</a> <span class="ver">__APP_VERSION__</span></footer>
</div>
<button class="newpill" id="newpill" hidden></button>
<div class="modal" id="modal" hidden>
  <div class="sheet">
    <button class="mx" id="modalx" type="button" data-i18n-aria="modalClose" aria-label="关闭">×</button>
    <div id="modalbody"></div>
  </div>
</div>
<div class="pwdmodal" id="pwdmodal" hidden>
  <div class="pwdsheet" role="dialog" aria-modal="true" aria-labelledby="pwdtitle">
    <h3 id="pwdtitle"></h3>
    <p class="pwdhelp" id="pwdhelp"></p>
    <input class="ds-input" id="pwdinput" type="password" autocomplete="current-password" style="width:100%">
    <div class="pwderr" id="pwderr" hidden></div>
    <div class="pwdacts">
      <button class="ds-btn" id="pwdcancel" type="button"></button>
      <button class="ds-btn ds-btn--primary" id="pwdok" type="button"></button>
    </div>
  </div>
</div>
<div class="pwdmodal pushmodal" id="pushmodal" hidden>
  <div class="pwdsheet pushsheet" role="dialog" aria-modal="true" aria-labelledby="pushtitle">
    <h3 id="pushtitle"></h3>
    <div id="pushbody"></div>
  </div>
</div>
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
    lastIdByDev: {},
    inited: false, unread: 0, limit: 10, range: "", notifiedId: 0,
    cursor: "", seen: {}, loadMoreDepth: 0,
    selectMode: false, selected: {}, lastQ: "", starOnly: false, unreadOnly: false, readOnly: false, filterMode: "all", lastList: [],
    pwdOn: true,
    labels: (function () { try { return JSON.parse(localStorage.getItem("sms_labels") || "{}") || {}; } catch (e) { return {}; } })(),
    autoCopy: (function () { try { return localStorage.getItem("sms_autocopy") !== "0"; } catch (e) { return true; } })(),
    notify: (function () { try { return localStorage.getItem("sms_notify") !== "0"; } catch (e) { return true; } })(),
    sound: (function () { try { return localStorage.getItem("sms_sound") === "1"; } catch (e) { return false; } })()
  };
  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- 多语言（i18n，九语言） ----------------
     语言优先级：?lang= > localStorage(sms_lang) > 浏览器语言(navigator.languages 逐个匹配)；支持
     九语言 zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR，旧值 zh→zh-CN 自动归一化，探测失败回退 en。
     静态节点标注：data-i18n(文本) / data-i18n-ph(placeholder) / data-i18n-title(title) / data-i18n-aria(aria-label)
     动态文案：T("key") 或 T("key", {n: 1})，占位符写作 {n}。
     切换语言后整页 reload：避免半渲染状态，且本地缓存过滤条件不受影响。 */
  var LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt-BR"];
  var LANG = (function () {
    /* 归一化：兼容旧值 zh/en 及常见变体（zh-CN/zh_Hans/pt 等）；未知值返回空串走下一级探测 */
    function norm(s) {
      var v = String(s || "").toLowerCase().replace(/_/g, "-");
      if (v === "zh" || v === "zh-cn" || v === "zh-hans") return "zh-CN";
      if (v === "zh-tw" || v === "zh-hk" || v === "zh-mo" || v === "zh-hant") return "zh-TW";
      if (v === "pt") return "pt-BR";
      return LANGS.indexOf(v) >= 0 ? v : "";
    }
    var v = "";
    try { v = norm(new URLSearchParams(location.search).get("lang")); } catch (e) {}
    if (!v) { try { v = norm(localStorage.getItem("sms_lang")); } catch (e) {} }
    if (!v) {
      var prefs = [];
      try { prefs = (navigator.languages && navigator.languages.length) ? Array.prototype.slice.call(navigator.languages) : []; } catch (e1) {}
      if (!prefs.length) { try { prefs = [navigator.language || navigator.userLanguage || navigator.browserLanguage || ""]; } catch (e2) { prefs = [""]; } }
      for (var i = 0; i < prefs.length; i++) {
        v = norm(prefs[i]);
        if (!v) {
          var s2 = String(prefs[i] || "").toLowerCase().replace(/_/g, "-");
          if (s2.indexOf("zh") === 0) v = /-(tw|hk|mo|hant)/.test(s2) ? "zh-TW" : "zh-CN";
        }
        if (v) break;
      }
    }
    if (!v) v = "en"; /* 探测失败回退英语，绝不静默回退中文 */
    try { localStorage.setItem("sms_lang", v); } catch (e) {}
    return v;
  })();
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var I18N = {
    "zh-CN": {
      langBtn: "🌐", langTip: "切换语言",
      ghRepo: "GitHub 仓库", modalClose: "关闭", devices: "设备标签",
      jumpTip: "输入页码后回车跳转", perPageTip: "每页条数",
      stats: "统计", settings: "设置",
      grpMsg: "消息开关", grpFilter: "筛选", grpAction: "操作",
      dndStart: "免打扰开始小时", dndEnd: "免打扰结束小时",
      themeAuto: "自动", themeLight: "浅色", themeDark: "深色",
      themeTip: "切换主题（自动 / 浅色 / 深色）",
      tabAll: "全部", tabRename: "重命名设备标签", tabMerge: "合并到其他设备", tabDel: "删除该设备标签",
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
      numLibTip: "常见号码库（仅供参考）",
      deletedOne: "已删除", deletedN: "已删除 {n} 条", undo: "撤销",
      newPill: "↑ {n} 条新消息", gotNew: "收到 {n} 条新消息", codeCopied: "验证码 {c} 已复制",
      recvCopied: "收件号已复制", newSms: "新短信",
      selCount: "已选 {n} 条", selAll: "全选本页", cancel: "取消",
      dSource: "来源", dDevice: "设备标签", dRecv: "收件号", dTime: "时间", dLabel: "号码标签", dStatus: "状态",
      notSet: "（未设置）", read: "已读", starredPrefix: "★ 收藏 · ",
      star: "收藏置顶", unstar: "取消收藏", markUnread: "标为未读", copyAll: "复制全文",
      call: "拨号", setLabel: "号码标签",
      labelPrompt: "给 {n} 设置标签（留空清除）",
      sDnd: "免打扰", sDndRange: "免打扰时段",
      to: "至", save: "保存", saved: "设置已保存",
      statTitle: "统计", statFail: "统计加载失败", statTotal: "总消息", statUnread: "未读", statStarred: "收藏",
      statSources: "来源分布", statDays: "近 7 天",
      autoCopyOn: "已开启验证码自动复制", autoCopyOff: "已关闭验证码自动复制",
      notifyOnMsg: "已开启后台通知", notifyOffMsg: "已关闭后台通知",
      soundOnMsg: "已开启新消息提示音", soundOffMsg: "已关闭新消息提示音",
      clearedN: "已清空 {n} 条",
      confirmDelN: "确认删除选中的 {n} 条？",
    pwdTitle: "验证登录密码",
    pwdHelp: "该操作会修改敏感配置或删除数据，请输入登录密码确认。",
    pwdPh: "登录密码",
    pwdWrong: "密码不正确",
    pwdNeed: "请输入密码",
    pwdTooMany: "尝试次数过多，请稍后再试",
    pwdVerify: "确认",
      scopeDevice: "当前设备的消息", scopeFilter: "当前筛选结果", scopeAll: "全部消息",
      confirmClear: "确认清空{scope}？将软删除匹配的所有消息（此操作不可撤销）。",
      confirmClear2: "再次确认：真的要清空{scope}吗？",
      renamePrompt: "重命名设备标签「{name}」\n留空则恢复默认名", renameFail: "重命名失败",
      noOthers: "没有可合并的其他设备",
      mergePrompt: "把「{a}」的全部消息合并到哪台设备？\n{list}\n输入序号：",
      invalidIdx: "序号无效",
      mergeConfirm: "确认把「{a}」的全部消息合并到「{b}」？\n合并后本标签将被删除。",
      targetMissing: "目标设备不存在", mergeFail: "合并失败",
      delDevConfirm: "删除该设备标签？（须先清空其全部短信）",
      hasMessages: "该设备仍有短信，请先删除全部短信", delFail: "删除失败",
      devCount: "（{n} 条）",
      justNow: "刚刚", minAgo: "{n} 分钟前", hourAgo: "{n} 小时前", today: "今天", yesterday: "昨天",
      unnamed: "未命名设备"
    },
    en: {
      langBtn: "🌐", langTip: "Switch language",
      ghRepo: "GitHub repository", modalClose: "Close", devices: "Devices",
      jumpTip: "Enter a page number and press Enter", perPageTip: "Items per page",
      stats: "Stats", settings: "Settings",
      grpMsg: "Message toggles", grpFilter: "Filter", grpAction: "Actions",
      dndStart: "Quiet hours start", dndEnd: "Quiet hours end",
      themeAuto: "Auto", themeLight: "Light", themeDark: "Dark",
      themeTip: "Theme: auto / light / dark",
      tabAll: "All", tabRename: "Rename device tag", tabMerge: "Merge into another device", tabDel: "Delete this device tag",
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
      numLibTip: "Built-in number directory (reference only)",
      deletedOne: "Deleted", deletedN: "{n} deleted", undo: "Undo",
      newPill: "↑ {n} new", gotNew: "{n} new message(s)", codeCopied: "Code {c} copied",
      recvCopied: "Recipient number copied", newSms: "New message",
      selCount: "{n} selected", selAll: "Select page", cancel: "Cancel",
      dSource: "Source", dDevice: "Device", dRecv: "Recipient", dTime: "Time", dLabel: "Number label", dStatus: "Status",
      notSet: "(not set)", read: "Read", starredPrefix: "★ Starred · ",
      star: "Star & pin", unstar: "Unstar", markUnread: "Mark unread", copyAll: "Copy text",
      call: "Call", setLabel: "Number label",
      labelPrompt: "Label for {n} (leave empty to clear)",
      sDnd: "Do not disturb", sDndRange: "Quiet hours",
      to: "to", save: "Save", saved: "Settings saved",
      statTitle: "Statistics", statFail: "Failed to load stats", statTotal: "Total", statUnread: "Unread", statStarred: "Starred",
      statSources: "By source", statDays: "Last 7 days",
      autoCopyOn: "Auto-copy enabled", autoCopyOff: "Auto-copy disabled",
      notifyOnMsg: "Background alerts enabled", notifyOffMsg: "Background alerts disabled",
      soundOnMsg: "Sound enabled", soundOffMsg: "Sound disabled",
      clearedN: "Cleared {n}",
      confirmDelN: "Delete {n} selected message(s)?",
    pwdTitle: "Verify login password",
    pwdHelp: "This action changes sensitive settings or deletes data. Enter your login password to confirm.",
    pwdPh: "Login password",
    pwdWrong: "Incorrect password",
    pwdNeed: "Password required",
    pwdTooMany: "Too many attempts, try again later",
    pwdVerify: "Confirm",
      scopeDevice: "this device's messages", scopeFilter: "the current filter", scopeAll: "all messages",
      confirmClear: "Clear {scope}? All matching messages will be soft-deleted (cannot be undone).",
      confirmClear2: "Really clear {scope}?",
      renamePrompt: "Rename device tag \"{name}\"\nLeave empty to restore the default name", renameFail: "Rename failed",
      noOthers: "No other devices to merge into",
      mergePrompt: "Merge all messages of \"{a}\" into which device?\n{list}\nEnter number:",
      invalidIdx: "Invalid number",
      mergeConfirm: "Merge all messages of \"{a}\" into \"{b}\"?\nThe \"{a}\" tag will be removed.",
      targetMissing: "Target device not found", mergeFail: "Merge failed",
      delDevConfirm: "Delete this device tag? (all messages must be cleared first)",
      hasMessages: "This device still has messages — delete them first", delFail: "Delete failed",
      devCount: "({n})",
      justNow: "just now", minAgo: "{n} min ago", hourAgo: "{n} hr ago", today: "Today", yesterday: "Yesterday",
      unnamed: "Unnamed device"
    },
    "zh-TW": {
      langBtn: "🌐", langTip: "切換語言",
      ghRepo: "GitHub 儲存庫", modalClose: "關閉", devices: "裝置標籤",
      jumpTip: "輸入頁碼後按 Enter 跳轉", perPageTip: "每頁筆數",
      stats: "統計", settings: "設定",
      grpMsg: "訊息開關", grpFilter: "篩選", grpAction: "操作",
      dndStart: "勿擾開始小時", dndEnd: "勿擾結束小時",
      themeAuto: "自動", themeLight: "淺色", themeDark: "深色",
      themeTip: "切換主題（自動 / 淺色 / 深色）",
      tabAll: "全部", tabRename: "重新命名裝置標籤", tabMerge: "合併到其他裝置", tabDel: "刪除此裝置標籤",
      searchPh: "搜尋寄件人或內容…", clearSearch: "清除搜尋",
      srcTip: "依來源篩選", allSources: "全部來源", srcSms: "簡訊", srcNotify: "通知",
      rangeTip: "依時間篩選", allTime: "全部時間", d7: "近 7 天", d30: "近 30 天",
      autoCopy: "自動複製驗證碼", notifyOn: "背景通知", soundOn: "提示音",
      starOnly: "★ 收藏", unreadOnly: "● 未讀", starTip: "只看收藏", unreadTip: "只看未讀",
      select: "選擇", selectTip: "進入批次選擇", done: "完成",
      clear: "清空", clearTip: "清空目前篩選結果（軟刪除）",
      exportCsv: "匯出 CSV", exportJson: "匯出 JSON",
      exportCsvTip: "依目前篩選匯出 CSV", exportJsonTip: "依目前篩選匯出 JSON",
      total: "共 {n} 則", pageOf: "第 {a} / {b} 頁",
      prev: "上一頁", next: "下一頁", perPage: "{n} 筆/頁", jumpPh: "頁碼", go: "跳轉",
      loading: "載入中…", emptyFilter: "沒有符合條件的訊息",
      emptyAll: "還沒有收到訊息", emptyHint: "在手機端設定 SmsForwarder，或呼叫 /api/push 推送一則試試",
      loadFail: "載入失敗：{m}", retry: "重試",
      del: "刪除", unknownNum: "未知號碼", codeLabel: "驗證碼：", copy: "複製", copied: "已複製",
      more: "展開全文", less: "收合", unread: "未讀",
      starItemTip: "收藏/置頂", recvTip: "雙擊複製收件號", selTip: "選擇",
      numLibTip: "常見號碼庫（僅供參考）",
      deletedOne: "已刪除", deletedN: "已刪除 {n} 則", undo: "復原",
      newPill: "↑ {n} 則新訊息", gotNew: "收到 {n} 則新訊息", codeCopied: "驗證碼 {c} 已複製",
      recvCopied: "收件號已複製", newSms: "新簡訊",
      selCount: "已選 {n} 則", selAll: "全選本頁", cancel: "取消",
      dSource: "來源", dDevice: "裝置標籤", dRecv: "收件號", dTime: "時間", dLabel: "號碼標籤", dStatus: "狀態",
      notSet: "（未設定）", read: "已讀", starredPrefix: "★ 收藏 · ",
      star: "收藏置頂", unstar: "取消收藏", markUnread: "標為未讀", copyAll: "複製全文",
      call: "撥號", setLabel: "號碼標籤",
      labelPrompt: "為 {n} 設定標籤（留空清除）",
      sDnd: "勿擾", sDndRange: "勿擾時段",
      to: "至", save: "儲存", saved: "設定已儲存",
      statTitle: "統計", statFail: "統計載入失敗", statTotal: "總訊息", statUnread: "未讀", statStarred: "收藏",
      statSources: "來源分布", statDays: "近 7 天",
      autoCopyOn: "已開啟驗證碼自動複製", autoCopyOff: "已關閉驗證碼自動複製",
      notifyOnMsg: "已開啟背景通知", notifyOffMsg: "已關閉背景通知",
      soundOnMsg: "已開啟新訊息提示音", soundOffMsg: "已關閉新訊息提示音",
      clearedN: "已清空 {n} 則",
      confirmDelN: "確認刪除選取的 {n} 則？",
    pwdTitle: "驗證登入密碼",
    pwdHelp: "此操作會修改敏感設定或刪除資料，請輸入登入密碼確認。",
    pwdPh: "登入密碼",
    pwdWrong: "密碼不正確",
    pwdNeed: "請輸入密碼",
    pwdTooMany: "嘗試次數過多，請稍後再試",
    pwdVerify: "確認",
      scopeDevice: "此裝置的訊息", scopeFilter: "目前篩選結果", scopeAll: "全部訊息",
      confirmClear: "確認清空{scope}？將軟刪除符合的所有訊息（此操作無法復原）。",
      confirmClear2: "再次確認：真的要清空{scope}嗎？",
      renamePrompt: "重新命名裝置標籤「{name}」\n留空則恢復預設名", renameFail: "重新命名失敗",
      noOthers: "沒有可合併的其他裝置",
      mergePrompt: "把「{a}」的全部訊息合併到哪部裝置？\n{list}\n輸入序號：",
      invalidIdx: "序號無效",
      mergeConfirm: "確認把「{a}」的全部訊息合併到「{b}」？\n合併後此標籤將被刪除。",
      targetMissing: "目標裝置不存在", mergeFail: "合併失敗",
      delDevConfirm: "刪除此裝置標籤？（須先清空其全部簡訊）",
      hasMessages: "此裝置仍有簡訊，請先刪除全部簡訊", delFail: "刪除失敗",
      devCount: "（{n} 則）",
      justNow: "剛剛", minAgo: "{n} 分鐘前", hourAgo: "{n} 小時前", today: "今天", yesterday: "昨天",
      unnamed: "未命名裝置"
    },
    ja: {
      langBtn: "🌐", langTip: "言語切替",
      ghRepo: "GitHub リポジトリ", modalClose: "閉じる", devices: "デバイスラベル",
      jumpTip: "ページ番号を入力して Enter で移動", perPageTip: "1 ページの件数",
      stats: "統計", settings: "設定",
      grpMsg: "メッセージ設定", grpFilter: "絞り込み", grpAction: "操作",
      dndStart: "通知休止の開始時刻（時）", dndEnd: "通知休止の終了時刻（時）",
      themeAuto: "自動", themeLight: "ライト", themeDark: "ダーク",
      themeTip: "テーマ切り替え（自動 / ライト / ダーク）",
      tabAll: "すべて", tabRename: "デバイスラベルを変更", tabMerge: "別のデバイスへ統合", tabDel: "このデバイスラベルを削除",
      searchPh: "送信者や本文を検索…", clearSearch: "検索をクリア",
      srcTip: "送信元で絞り込み", allSources: "すべての送信元", srcSms: "SMS", srcNotify: "通知",
      rangeTip: "期間で絞り込み", allTime: "全期間", d7: "過去 7 日", d30: "過去 30 日",
      autoCopy: "認証コード自動コピー", notifyOn: "バックグラウンド通知", soundOn: "通知音",
      starOnly: "★ スター", unreadOnly: "● 未読", starTip: "スターのみ表示", unreadTip: "未読のみ表示",
      select: "選択", selectTip: "一括選択を開始", done: "完了",
      clear: "消去", clearTip: "現在の絞り込み結果を消去（ソフト削除）",
      exportCsv: "CSV をエクスポート", exportJson: "JSON をエクスポート",
      exportCsvTip: "現在の絞り込みを CSV で出力", exportJsonTip: "現在の絞り込みを JSON で出力",
      total: "全 {n} 件", pageOf: "{a} / {b} ページ",
      prev: "前へ", next: "次へ", perPage: "{n} 件/ページ", jumpPh: "ページ", go: "移動",
      loading: "読み込み中…", emptyFilter: "条件に一致するメッセージはありません",
      emptyAll: "まだメッセージはありません", emptyHint: "スマホで SmsForwarder を設定するか、/api/push に POST して試してください",
      loadFail: "読み込み失敗：{m}", retry: "再試行",
      del: "削除", unknownNum: "不明な番号", codeLabel: "認証コード：", copy: "コピー", copied: "コピーしました",
      more: "全文を表示", less: "折りたたむ", unread: "未読",
      starItemTip: "スター/固定表示", recvTip: "ダブルクリックで宛先番号をコピー", selTip: "選択",
      numLibTip: "よくある番号リスト（参考）",
      deletedOne: "削除しました", deletedN: "{n} 件削除しました", undo: "元に戻す",
      newPill: "↑ 新着 {n} 件", gotNew: "新着 {n} 件を受信", codeCopied: "認証コード {c} をコピーしました",
      recvCopied: "宛先番号をコピーしました", newSms: "新着 SMS",
      selCount: "{n} 件選択中", selAll: "このページを全選択", cancel: "キャンセル",
      dSource: "送信元", dDevice: "デバイスラベル", dRecv: "宛先番号", dTime: "日時", dLabel: "番号ラベル", dStatus: "状態",
      notSet: "（未設定）", read: "既読", starredPrefix: "★ スター · ",
      star: "スターと固定", unstar: "スター解除", markUnread: "未読にする", copyAll: "全文をコピー",
      call: "発信", setLabel: "番号ラベル",
      labelPrompt: "{n} のラベルを設定（空欄で解除）",
      sDnd: "通知休止", sDndRange: "通知休止時間帯",
      to: "〜", save: "保存", saved: "設定を保存しました",
      statTitle: "統計", statFail: "統計の読み込みに失敗しました", statTotal: "総メッセージ", statUnread: "未読", statStarred: "スター",
      statSources: "送信元別", statDays: "過去 7 日",
      autoCopyOn: "認証コード自動コピーを有効にしました", autoCopyOff: "認証コード自動コピーを無効にしました",
      notifyOnMsg: "バックグラウンド通知を有効にしました", notifyOffMsg: "バックグラウンド通知を無効にしました",
      soundOnMsg: "新着通知音を有効にしました", soundOffMsg: "新着通知音を無効にしました",
      clearedN: "{n} 件消去しました",
      confirmDelN: "選択した {n} 件を削除しますか？",
    pwdTitle: "ログインパスワードの確認",
    pwdHelp: "この操作は機密設定の変更やデータ削除を伴います。確認のためログインパスワードを入力してください。",
    pwdPh: "ログインパスワード",
    pwdWrong: "パスワードが正しくありません",
    pwdNeed: "パスワードを入力してください",
    pwdTooMany: "試行回数が多すぎます。しばらくしてから再試行してください",
    pwdVerify: "確認",
      scopeDevice: "このデバイスのメッセージ", scopeFilter: "現在の絞り込み結果", scopeAll: "すべてのメッセージ",
      confirmClear: "{scope}を消去しますか？一致するすべてのメッセージがソフト削除されます（取り消せません）。",
      confirmClear2: "再確認：本当に{scope}を消去しますか？",
      renamePrompt: "デバイスラベル「{name}」を変更\n空欄でデフォルト名に戻ります", renameFail: "名前の変更に失敗しました",
      noOthers: "統合先の他のデバイスがありません",
      mergePrompt: "「{a}」の全メッセージをどのデバイスに統合しますか？\n{list}\n番号を入力：",
      invalidIdx: "番号が無効です",
      mergeConfirm: "「{a}」の全メッセージを「{b}」に統合しますか？\n統合後、このラベルは削除されます。",
      targetMissing: "統合先デバイスが見つかりません", mergeFail: "統合に失敗しました",
      delDevConfirm: "このデバイスラベルを削除しますか？（先に全 SMS を消去する必要があります）",
      hasMessages: "このデバイスにはまだ SMS があります。先にすべて削除してください", delFail: "削除に失敗しました",
      devCount: "（{n} 件）",
      justNow: "たった今", minAgo: "{n} 分前", hourAgo: "{n} 時間前", today: "今日", yesterday: "昨日",
      unnamed: "名前のないデバイス"
    },
    ko: {
      langBtn: "🌐", langTip: "언어 전환",
      ghRepo: "GitHub 저장소", modalClose: "닫기", devices: "기기 라벨",
      jumpTip: "페이지 번호 입력 후 Enter", perPageTip: "페이지당 항목 수",
      stats: "통계", settings: "설정",
      grpMsg: "메시지 설정", grpFilter: "필터", grpAction: "동작",
      dndStart: "방해 금지 시작 시각(시)", dndEnd: "방해 금지 종료 시각(시)",
      themeAuto: "자동", themeLight: "라이트", themeDark: "다크",
      themeTip: "테마 전환(자동 / 라이트 / 다크)",
      tabAll: "전체", tabRename: "기기 라벨 이름 변경", tabMerge: "다른 기기로 병합", tabDel: "이 기기 라벨 삭제",
      searchPh: "발신자 또는 내용 검색…", clearSearch: "검색 지우기",
      srcTip: "발신원별 필터", allSources: "전체 발신원", srcSms: "SMS", srcNotify: "알림",
      rangeTip: "기간별 필터", allTime: "전체 기간", d7: "최근 7일", d30: "최근 30일",
      autoCopy: "인증번호 자동 복사", notifyOn: "백그라운드 알림", soundOn: "알림음",
      starOnly: "★ 즐겨찾기", unreadOnly: "● 읽지 않음", starTip: "즐겨찾기만 보기", unreadTip: "읽지 않은 것만 보기",
      select: "선택", selectTip: "일괄 선택 시작", done: "완료",
      clear: "비우기", clearTip: "현재 필터 결과 비우기(소프트 삭제)",
      exportCsv: "CSV 내보내기", exportJson: "JSON 내보내기",
      exportCsvTip: "현재 필터를 CSV로 내보내기", exportJsonTip: "현재 필터를 JSON으로 내보내기",
      total: "총 {n}건", pageOf: "{a} / {b} 페이지",
      prev: "이전", next: "다음", perPage: "페이지당 {n}건", jumpPh: "페이지", go: "이동",
      loading: "불러오는 중…", emptyFilter: "조건에 맞는 메시지가 없습니다",
      emptyAll: "아직 메시지가 없습니다", emptyHint: "휴대폰에서 SmsForwarder를 설정하거나 /api/push 로 POST 해 보세요",
      loadFail: "불러오기 실패: {m}", retry: "다시 시도",
      del: "삭제", unknownNum: "알 수 없는 번호", codeLabel: "인증번호:", copy: "복사", copied: "복사됨",
      more: "전문 펼치기", less: "접기", unread: "읽지 않음",
      starItemTip: "즐겨찾기/고정", recvTip: "더블클릭으로 수신번호 복사", selTip: "선택",
      numLibTip: "자주 오는 번호 목록(참고용)",
      deletedOne: "삭제됨", deletedN: "{n}건 삭제됨", undo: "실행 취소",
      newPill: "↑ 새 메시지 {n}건", gotNew: "새 메시지 {n}건 수신", codeCopied: "인증번호 {c} 복사됨",
      recvCopied: "수신번호 복사됨", newSms: "새 SMS",
      selCount: "{n}건 선택됨", selAll: "이 페이지 전체 선택", cancel: "취소",
      dSource: "발신원", dDevice: "기기 라벨", dRecv: "수신번호", dTime: "시간", dLabel: "번호 라벨", dStatus: "상태",
      notSet: "(설정 안 됨)", read: "읽음", starredPrefix: "★ 즐겨찾기 · ",
      star: "즐겨찾기 및 고정", unstar: "즐겨찾기 해제", markUnread: "읽지 않음으로 표시", copyAll: "전문 복사",
      call: "전화", setLabel: "번호 라벨",
      labelPrompt: "{n} 의 라벨 설정(비우면 해제)",
      sDnd: "방해 금지", sDndRange: "방해 금지 시간대",
      to: "부터", save: "저장", saved: "설정이 저장되었습니다",
      statTitle: "통계", statFail: "통계 불러오기 실패", statTotal: "전체 메시지", statUnread: "읽지 않음", statStarred: "즐겨찾기",
      statSources: "발신원별", statDays: "최근 7일",
      autoCopyOn: "인증번호 자동 복사 켜짐", autoCopyOff: "인증번호 자동 복사 꺼짐",
      notifyOnMsg: "백그라운드 알림 켜짐", notifyOffMsg: "백그라운드 알림 꺼짐",
      soundOnMsg: "새 메시지 알림음 켜짐", soundOffMsg: "새 메시지 알림음 꺼짐",
      clearedN: "{n}건 비움",
      confirmDelN: "선택한 {n}건을 삭제할까요?",
    pwdTitle: "로그인 비밀번호 확인",
    pwdHelp: "이 작업은 민감한 설정을 변경하거나 데이터를 삭제합니다. 확인하려면 로그인 비밀번호를 입력하세요.",
    pwdPh: "로그인 비밀번호",
    pwdWrong: "비밀번호가 올바르지 않습니다",
    pwdNeed: "비밀번호를 입력하세요",
    pwdTooMany: "시도 횟수가 너무 많습니다. 잠시 후 다시 시도하세요",
    pwdVerify: "확인",
      scopeDevice: "이 기기의 메시지", scopeFilter: "현재 필터 결과", scopeAll: "전체 메시지",
      confirmClear: "{scope}을(를) 비울까요? 일치하는 모든 메시지가 소프트 삭제됩니다(되돌릴 수 없습니다).",
      confirmClear2: "다시 확인: 정말 {scope}을(를) 비울까요?",
      renamePrompt: "기기 라벨 \"{name}\" 이름 변경\n비우면 기본 이름으로 복원됩니다", renameFail: "이름 변경 실패",
      noOthers: "병합할 다른 기기가 없습니다",
      mergePrompt: "\"{a}\"의 모든 메시지를 어느 기기로 병합할까요?\n{list}\n번호 입력:",
      invalidIdx: "잘못된 번호입니다",
      mergeConfirm: "\"{a}\"의 모든 메시지를 \"{b}\"(으)로 병합할까요?\n병합 후 이 라벨은 삭제됩니다.",
      targetMissing: "대상 기기를 찾을 수 없습니다", mergeFail: "병합 실패",
      delDevConfirm: "이 기기 라벨을 삭제할까요?(먼저 모든 SMS를 비워야 합니다)",
      hasMessages: "이 기기에 아직 SMS가 있습니다. 먼저 모두 삭제해 주세요", delFail: "삭제 실패",
      devCount: "({n}건)",
      justNow: "방금", minAgo: "{n}분 전", hourAgo: "{n}시간 전", today: "오늘", yesterday: "어제",
      unnamed: "이름 없는 기기"
    },
    es: {
      langBtn: "🌐", langTip: "Cambiar idioma",
      ghRepo: "Repositorio de GitHub", modalClose: "Cerrar", devices: "Dispositivos",
      jumpTip: "Escribe un número de página y pulsa Enter", perPageTip: "Elementos por página",
      stats: "Estadísticas", settings: "Ajustes",
      grpMsg: "Opciones de mensajes", grpFilter: "Filtros", grpAction: "Acciones",
      dndStart: "Inicio de horario silencioso", dndEnd: "Fin de horario silencioso",
      themeAuto: "Automático", themeLight: "Claro", themeDark: "Oscuro",
      themeTip: "Cambiar tema (automático / claro / oscuro)",
      tabAll: "Todo", tabRename: "Renombrar etiqueta de dispositivo", tabMerge: "Fusionar en otro dispositivo", tabDel: "Eliminar esta etiqueta",
      searchPh: "Buscar remitente o contenido…", clearSearch: "Borrar búsqueda",
      srcTip: "Filtrar por origen", allSources: "Todos los orígenes", srcSms: "SMS", srcNotify: "Notificación",
      rangeTip: "Filtrar por fecha", allTime: "Todo el tiempo", d7: "Últimos 7 días", d30: "Últimos 30 días",
      autoCopy: "Copiar códigos automáticamente", notifyOn: "Alertas en segundo plano", soundOn: "Sonido",
      starOnly: "★ Favoritos", unreadOnly: "● No leídos", starTip: "Solo favoritos", unreadTip: "Solo no leídos",
      select: "Seleccionar", selectTip: "Entrar en selección múltiple", done: "Listo",
      clear: "Vaciar", clearTip: "Vaciar el filtro actual (borrado suave)",
      exportCsv: "Exportar CSV", exportJson: "Exportar JSON",
      exportCsvTip: "Exportar el filtro actual como CSV", exportJsonTip: "Exportar el filtro actual como JSON",
      total: "{n} mensajes", pageOf: "Página {a} de {b}",
      prev: "Anterior", next: "Siguiente", perPage: "{n} por página", jumpPh: "Página", go: "Ir",
      loading: "Cargando…", emptyFilter: "No hay mensajes que coincidan",
      emptyAll: "Aún no hay mensajes", emptyHint: "Configura SmsForwarder en tu teléfono o envía un POST a /api/push para probar",
      loadFail: "Error al cargar: {m}", retry: "Reintentar",
      del: "Eliminar", unknownNum: "Desconocido", codeLabel: "Código:", copy: "Copiar", copied: "Copiado",
      more: "Mostrar más", less: "Mostrar menos", unread: "No leído",
      starItemTip: "Marcar / fijar", recvTip: "Doble toque para copiar", selTip: "Seleccionar",
      numLibTip: "Directorio de números integrado (solo referencia)",
      deletedOne: "Eliminado", deletedN: "{n} eliminados", undo: "Deshacer",
      newPill: "↑ {n} nuevos", gotNew: "{n} mensaje(s) nuevo(s)", codeCopied: "Código {c} copiado",
      recvCopied: "Número de destino copiado", newSms: "Mensaje nuevo",
      selCount: "{n} seleccionados", selAll: "Seleccionar página", cancel: "Cancelar",
      dSource: "Origen", dDevice: "Dispositivo", dRecv: "Destinatario", dTime: "Hora", dLabel: "Etiqueta del número", dStatus: "Estado",
      notSet: "(sin configurar)", read: "Leído", starredPrefix: "★ Favorito · ",
      star: "Marcar y fijar", unstar: "Quitar marca", markUnread: "Marcar como no leído", copyAll: "Copiar texto",
      call: "Llamar", setLabel: "Etiqueta del número",
      labelPrompt: "Etiqueta para {n} (dejar vacío para borrar)",
      sDnd: "No molestar", sDndRange: "Horario silencioso",
      to: "a", save: "Guardar", saved: "Ajustes guardados",
      statTitle: "Estadísticas", statFail: "Error al cargar estadísticas", statTotal: "Total", statUnread: "No leídos", statStarred: "Favoritos",
      statSources: "Por origen", statDays: "Últimos 7 días",
      autoCopyOn: "Copia automática activada", autoCopyOff: "Copia automática desactivada",
      notifyOnMsg: "Alertas en segundo plano activadas", notifyOffMsg: "Alertas en segundo plano desactivadas",
      soundOnMsg: "Sonido activado", soundOffMsg: "Sonido desactivado",
      clearedN: "{n} vaciados",
      confirmDelN: "¿Eliminar los {n} mensajes seleccionados?",
    pwdTitle: "Verificar contraseña de acceso",
    pwdHelp: "Esta acción modifica ajustes sensibles o elimina datos. Introduce la contraseña de acceso para confirmar.",
    pwdPh: "Contraseña de acceso",
    pwdWrong: "Contraseña incorrecta",
    pwdNeed: "Introduce la contraseña",
    pwdTooMany: "Demasiados intentos, inténtalo más tarde",
    pwdVerify: "Confirmar",
      scopeDevice: "los mensajes de este dispositivo", scopeFilter: "el filtro actual", scopeAll: "todos los mensajes",
      confirmClear: "¿Vaciar {scope}? Todos los mensajes que coincidan se borrarán de forma suave (no se puede deshacer).",
      confirmClear2: "Confirmar de nuevo: ¿seguro que quieres vaciar {scope}?",
      renamePrompt: "Renombrar la etiqueta \"{name}\"\nDejar vacío para restaurar el nombre predeterminado", renameFail: "Error al renombrar",
      noOthers: "No hay otros dispositivos para fusionar",
      mergePrompt: "¿Fusionar todos los mensajes de \"{a}\" en qué dispositivo?\n{list}\nEscribe el número:",
      invalidIdx: "Número no válido",
      mergeConfirm: "¿Fusionar todos los mensajes de \"{a}\" en \"{b}\"?\nLa etiqueta \"{a}\" se eliminará.",
      targetMissing: "Dispositivo de destino no encontrado", mergeFail: "Error al fusionar",
      delDevConfirm: "¿Eliminar esta etiqueta de dispositivo? (primero debes vaciar todos sus SMS)",
      hasMessages: "Este dispositivo aún tiene SMS: elimínalos primero", delFail: "Error al eliminar",
      devCount: "({n})",
      justNow: "ahora mismo", minAgo: "hace {n} min", hourAgo: "hace {n} h", today: "Hoy", yesterday: "Ayer",
      unnamed: "Dispositivo sin nombre"
    },
    fr: {
      langBtn: "🌐", langTip: "Changer de langue",
      ghRepo: "Dépôt GitHub", modalClose: "Fermer", devices: "Appareils",
      jumpTip: "Saisissez un numéro de page puis Entrée", perPageTip: "Éléments par page",
      stats: "Statistiques", settings: "Paramètres",
      grpMsg: "Options des messages", grpFilter: "Filtres", grpAction: "Actions",
      dndStart: "Début des heures silencieuses", dndEnd: "Fin des heures silencieuses",
      themeAuto: "Auto", themeLight: "Clair", themeDark: "Sombre",
      themeTip: "Changer de thème (auto / clair / sombre)",
      tabAll: "Tout", tabRename: "Renommer l'étiquette d'appareil", tabMerge: "Fusionner dans un autre appareil", tabDel: "Supprimer cette étiquette",
      searchPh: "Rechercher expéditeur ou contenu…", clearSearch: "Effacer la recherche",
      srcTip: "Filtrer par source", allSources: "Toutes les sources", srcSms: "SMS", srcNotify: "Notification",
      rangeTip: "Filtrer par période", allTime: "Tout", d7: "7 derniers jours", d30: "30 derniers jours",
      autoCopy: "Copie auto des codes", notifyOn: "Alertes en arrière-plan", soundOn: "Son",
      starOnly: "★ Favoris", unreadOnly: "● Non lus", starTip: "Favoris uniquement", unreadTip: "Non lus uniquement",
      select: "Sélectionner", selectTip: "Activer la sélection multiple", done: "Terminé",
      clear: "Vider", clearTip: "Vider le filtre actuel (suppression logique)",
      exportCsv: "Exporter CSV", exportJson: "Exporter JSON",
      exportCsvTip: "Exporter le filtre actuel en CSV", exportJsonTip: "Exporter le filtre actuel en JSON",
      total: "{n} messages", pageOf: "Page {a} sur {b}",
      prev: "Précédent", next: "Suivant", perPage: "{n} par page", jumpPh: "Page", go: "Aller",
      loading: "Chargement…", emptyFilter: "Aucun message correspondant",
      emptyAll: "Aucun message pour l'instant", emptyHint: "Configurez SmsForwarder sur votre téléphone, ou envoyez un POST vers /api/push pour essayer",
      loadFail: "Échec du chargement : {m}", retry: "Réessayer",
      del: "Supprimer", unknownNum: "Inconnu", codeLabel: "Code :", copy: "Copier", copied: "Copié",
      more: "Tout afficher", less: "Réduire", unread: "Non lu",
      starItemTip: "Favori / épingler", recvTip: "Double-clic pour copier", selTip: "Sélectionner",
      numLibTip: "Annuaire intégré (à titre indicatif)",
      deletedOne: "Supprimé", deletedN: "{n} supprimés", undo: "Annuler",
      newPill: "↑ {n} nouveaux", gotNew: "{n} nouveau(x) message(s)", codeCopied: "Code {c} copié",
      recvCopied: "Numéro destinataire copié", newSms: "Nouveau message",
      selCount: "{n} sélectionnés", selAll: "Tout sélectionner (page)", cancel: "Annuler",
      dSource: "Source", dDevice: "Appareil", dRecv: "Destinataire", dTime: "Heure", dLabel: "Étiquette du numéro", dStatus: "Statut",
      notSet: "(non défini)", read: "Lu", starredPrefix: "★ Favori · ",
      star: "Favori et épingler", unstar: "Retirer le favori", markUnread: "Marquer non lu", copyAll: "Copier le texte",
      call: "Appeler", setLabel: "Étiquette du numéro",
      labelPrompt: "Étiquette pour {n} (laisser vide pour effacer)",
      sDnd: "Ne pas déranger", sDndRange: "Heures silencieuses",
      to: "à", save: "Enregistrer", saved: "Paramètres enregistrés",
      statTitle: "Statistiques", statFail: "Échec du chargement des statistiques", statTotal: "Total", statUnread: "Non lus", statStarred: "Favoris",
      statSources: "Par source", statDays: "7 derniers jours",
      autoCopyOn: "Copie auto activée", autoCopyOff: "Copie auto désactivée",
      notifyOnMsg: "Alertes en arrière-plan activées", notifyOffMsg: "Alertes en arrière-plan désactivées",
      soundOnMsg: "Son activé", soundOffMsg: "Son désactivé",
      clearedN: "{n} vidés",
      confirmDelN: "Supprimer les {n} messages sélectionnés ?",
    pwdTitle: "Vérifier le mot de passe de connexion",
    pwdHelp: "Cette action modifie des réglages sensibles ou supprime des données. Saisissez le mot de passe de connexion pour confirmer.",
    pwdPh: "Mot de passe",
    pwdWrong: "Mot de passe incorrect",
    pwdNeed: "Mot de passe requis",
    pwdTooMany: "Trop de tentatives, réessayez plus tard",
    pwdVerify: "Confirmer",
      scopeDevice: "les messages de cet appareil", scopeFilter: "le filtre actuel", scopeAll: "tous les messages",
      confirmClear: "Vider {scope} ? Tous les messages correspondants seront supprimés logiquement (irréversible).",
      confirmClear2: "Confirmer à nouveau : vider vraiment {scope} ?",
      renamePrompt: "Renommer l'étiquette \"{name}\"\nLaisser vide pour restaurer le nom par défaut", renameFail: "Échec du renommage",
      noOthers: "Aucun autre appareil pour la fusion",
      mergePrompt: "Fusionner tous les messages de \"{a}\" vers quel appareil ?\n{list}\nSaisissez le numéro :",
      invalidIdx: "Numéro invalide",
      mergeConfirm: "Fusionner tous les messages de \"{a}\" vers \"{b}\" ?\nL'étiquette \"{a}\" sera supprimée.",
      targetMissing: "Appareil cible introuvable", mergeFail: "Échec de la fusion",
      delDevConfirm: "Supprimer cette étiquette d'appareil ? (videz d'abord tous ses SMS)",
      hasMessages: "Cet appareil contient encore des SMS — supprimez-les d'abord", delFail: "Échec de la suppression",
      devCount: "({n})",
      justNow: "à l'instant", minAgo: "il y a {n} min", hourAgo: "il y a {n} h", today: "Aujourd'hui", yesterday: "Hier",
      unnamed: "Appareil sans nom"
    },
    de: {
      langBtn: "🌐", langTip: "Sprache wechseln",
      ghRepo: "GitHub-Repository", modalClose: "Schließen", devices: "Geräte",
      jumpTip: "Seitennummer eingeben und Enter drücken", perPageTip: "Einträge pro Seite",
      stats: "Statistik", settings: "Einstellungen",
      grpMsg: "Nachrichten-Optionen", grpFilter: "Filter", grpAction: "Aktionen",
      dndStart: "Ruhezeit Beginn", dndEnd: "Ruhezeit Ende",
      themeAuto: "Auto", themeLight: "Hell", themeDark: "Dunkel",
      themeTip: "Design wechseln (auto / hell / dunkel)",
      tabAll: "Alle", tabRename: "Geräte-Label umbenennen", tabMerge: "In anderes Gerät zusammenführen", tabDel: "Dieses Geräte-Label löschen",
      searchPh: "Absender oder Inhalt suchen…", clearSearch: "Suche löschen",
      srcTip: "Nach Quelle filtern", allSources: "Alle Quellen", srcSms: "SMS", srcNotify: "Benachrichtigung",
      rangeTip: "Nach Zeit filtern", allTime: "Gesamter Zeitraum", d7: "Letzte 7 Tage", d30: "Letzte 30 Tage",
      autoCopy: "Codes automatisch kopieren", notifyOn: "Hintergrund-Benachrichtigungen", soundOn: "Ton",
      starOnly: "★ Favoriten", unreadOnly: "● Ungelesen", starTip: "Nur Favoriten", unreadTip: "Nur Ungelesene",
      select: "Auswählen", selectTip: "Mehrfachauswahl starten", done: "Fertig",
      clear: "Leeren", clearTip: "Aktuellen Filter leeren (Soft-Delete)",
      exportCsv: "CSV exportieren", exportJson: "JSON exportieren",
      exportCsvTip: "Aktuellen Filter als CSV exportieren", exportJsonTip: "Aktuellen Filter als JSON exportieren",
      total: "{n} Nachrichten", pageOf: "Seite {a} von {b}",
      prev: "Zurück", next: "Weiter", perPage: "{n} pro Seite", jumpPh: "Seite", go: "Los",
      loading: "Wird geladen…", emptyFilter: "Keine passenden Nachrichten",
      emptyAll: "Noch keine Nachrichten", emptyHint: "Richte SmsForwarder auf dem Handy ein oder sende ein POST an /api/push",
      loadFail: "Laden fehlgeschlagen: {m}", retry: "Erneut versuchen",
      del: "Löschen", unknownNum: "Unbekannt", codeLabel: "Code:", copy: "Kopieren", copied: "Kopiert",
      more: "Mehr anzeigen", less: "Weniger anzeigen", unread: "Ungelesen",
      starItemTip: "Favorit / anheften", recvTip: "Doppeltipp zum Kopieren", selTip: "Auswählen",
      numLibTip: "Integriertes Nummernverzeichnis (nur zur Referenz)",
      deletedOne: "Gelöscht", deletedN: "{n} gelöscht", undo: "Rückgängig",
      newPill: "↑ {n} neue", gotNew: "{n} neue Nachricht(en)", codeCopied: "Code {c} kopiert",
      recvCopied: "Empfängernummer kopiert", newSms: "Neue Nachricht",
      selCount: "{n} ausgewählt", selAll: "Seite auswählen", cancel: "Abbrechen",
      dSource: "Quelle", dDevice: "Gerät", dRecv: "Empfänger", dTime: "Zeit", dLabel: "Nummern-Label", dStatus: "Status",
      notSet: "(nicht gesetzt)", read: "Gelesen", starredPrefix: "★ Favorit · ",
      star: "Favorit & anheften", unstar: "Favorit entfernen", markUnread: "Als ungelesen markieren", copyAll: "Text kopieren",
      call: "Anrufen", setLabel: "Nummern-Label",
      labelPrompt: "Label für {n} (leer lassen zum Entfernen)",
      sDnd: "Nicht stören", sDndRange: "Ruhezeit",
      to: "bis", save: "Speichern", saved: "Einstellungen gespeichert",
      statTitle: "Statistik", statFail: "Statistik konnte nicht geladen werden", statTotal: "Gesamt", statUnread: "Ungelesen", statStarred: "Favoriten",
      statSources: "Nach Quelle", statDays: "Letzte 7 Tage",
      autoCopyOn: "Auto-Kopieren aktiviert", autoCopyOff: "Auto-Kopieren deaktiviert",
      notifyOnMsg: "Hintergrund-Benachrichtigungen aktiviert", notifyOffMsg: "Hintergrund-Benachrichtigungen deaktiviert",
      soundOnMsg: "Ton aktiviert", soundOffMsg: "Ton deaktiviert",
      clearedN: "{n} geleert",
      confirmDelN: "{n} ausgewählte Nachricht(en) löschen?",
    pwdTitle: "Anmeldepasswort bestätigen",
    pwdHelp: "Diese Aktion ändert sensible Einstellungen oder löscht Daten. Zur Bestätigung das Anmeldepasswort eingeben.",
    pwdPh: "Anmeldepasswort",
    pwdWrong: "Falsches Passwort",
    pwdNeed: "Passwort erforderlich",
    pwdTooMany: "Zu viele Versuche, später erneut versuchen",
    pwdVerify: "Bestätigen",
      scopeDevice: "die Nachrichten dieses Geräts", scopeFilter: "den aktuellen Filter", scopeAll: "alle Nachrichten",
      confirmClear: "{scope} leeren? Alle passenden Nachrichten werden soft-gelöscht (kann nicht rückgängig gemacht werden).",
      confirmClear2: "Erneut bestätigen: {scope} wirklich leeren?",
      renamePrompt: "Geräte-Label \"{name}\" umbenennen\nLeer lassen für den Standardnamen", renameFail: "Umbenennen fehlgeschlagen",
      noOthers: "Keine anderen Geräte zum Zusammenführen",
      mergePrompt: "Alle Nachrichten von \"{a}\" in welches Gerät zusammenführen?\n{list}\nNummer eingeben:",
      invalidIdx: "Ungültige Nummer",
      mergeConfirm: "Alle Nachrichten von \"{a}\" nach \"{b}\" zusammenführen?\nDas Label \"{a}\" wird entfernt.",
      targetMissing: "Zielgerät nicht gefunden", mergeFail: "Zusammenführen fehlgeschlagen",
      delDevConfirm: "Dieses Geräte-Label löschen? (zuvor alle SMS leeren)",
      hasMessages: "Dieses Gerät hat noch SMS — bitte zuerst löschen", delFail: "Löschen fehlgeschlagen",
      devCount: "({n})",
      justNow: "gerade eben", minAgo: "vor {n} Min.", hourAgo: "vor {n} Std.", today: "Heute", yesterday: "Gestern",
      unnamed: "Unbenanntes Gerät"
    },
    "pt-BR": {
      langBtn: "🌐", langTip: "Mudar idioma",
      ghRepo: "Repositório do GitHub", modalClose: "Fechar", devices: "Dispositivos",
      jumpTip: "Digite o número da página e pressione Enter", perPageTip: "Itens por página",
      stats: "Estatísticas", settings: "Configurações",
      grpMsg: "Opções de mensagens", grpFilter: "Filtros", grpAction: "Ações",
      dndStart: "Início do horário silencioso", dndEnd: "Fim do horário silencioso",
      themeAuto: "Automático", themeLight: "Claro", themeDark: "Escuro",
      themeTip: "Alternar tema (automático / claro / escuro)",
      tabAll: "Tudo", tabRename: "Renomear etiqueta do dispositivo", tabMerge: "Mesclar em outro dispositivo", tabDel: "Excluir esta etiqueta",
      searchPh: "Pesquisar remetente ou conteúdo…", clearSearch: "Limpar pesquisa",
      srcTip: "Filtrar por origem", allSources: "Todas as origens", srcSms: "SMS", srcNotify: "Notificação",
      rangeTip: "Filtrar por período", allTime: "Todo o período", d7: "Últimos 7 dias", d30: "Últimos 30 dias",
      autoCopy: "Copiar códigos automaticamente", notifyOn: "Alertas em segundo plano", soundOn: "Som",
      starOnly: "★ Favoritos", unreadOnly: "● Não lidas", starTip: "Somente favoritas", unreadTip: "Somente não lidas",
      select: "Selecionar", selectTip: "Entrar na seleção múltipla", done: "Concluído",
      clear: "Limpar", clearTip: "Limpar o filtro atual (exclusão suave)",
      exportCsv: "Exportar CSV", exportJson: "Exportar JSON",
      exportCsvTip: "Exportar o filtro atual como CSV", exportJsonTip: "Exportar o filtro atual como JSON",
      total: "{n} mensagens", pageOf: "Página {a} de {b}",
      prev: "Anterior", next: "Próxima", perPage: "{n} por página", jumpPh: "Página", go: "Ir",
      loading: "Carregando…", emptyFilter: "Nenhuma mensagem correspondente",
      emptyAll: "Nenhuma mensagem ainda", emptyHint: "Configure o SmsForwarder no celular ou envie um POST para /api/push para testar",
      loadFail: "Falha ao carregar: {m}", retry: "Tentar novamente",
      del: "Excluir", unknownNum: "Desconhecido", codeLabel: "Código:", copy: "Copiar", copied: "Copiado",
      more: "Mostrar mais", less: "Mostrar menos", unread: "Não lida",
      starItemTip: "Favoritar / fixar", recvTip: "Toque duplo para copiar", selTip: "Selecionar",
      numLibTip: "Diretório de números integrado (somente referência)",
      deletedOne: "Excluída", deletedN: "{n} excluídas", undo: "Desfazer",
      newPill: "↑ {n} novas", gotNew: "{n} nova(s) mensagem(ns)", codeCopied: "Código {c} copiado",
      recvCopied: "Número do destinatário copiado", newSms: "Nova mensagem",
      selCount: "{n} selecionadas", selAll: "Selecionar página", cancel: "Cancelar",
      dSource: "Origem", dDevice: "Dispositivo", dRecv: "Destinatário", dTime: "Hora", dLabel: "Etiqueta do número", dStatus: "Status",
      notSet: "(não definido)", read: "Lida", starredPrefix: "★ Favorita · ",
      star: "Favoritar e fixar", unstar: "Remover favorito", markUnread: "Marcar como não lida", copyAll: "Copiar texto",
      call: "Ligar", setLabel: "Etiqueta do número",
      labelPrompt: "Etiqueta para {n} (deixe vazio para limpar)",
      sDnd: "Não perturbe", sDndRange: "Horário silencioso",
      to: "até", save: "Salvar", saved: "Configurações salvas",
      statTitle: "Estatísticas", statFail: "Falha ao carregar estatísticas", statTotal: "Total", statUnread: "Não lidas", statStarred: "Favoritas",
      statSources: "Por origem", statDays: "Últimos 7 dias",
      autoCopyOn: "Cópia automática ativada", autoCopyOff: "Cópia automática desativada",
      notifyOnMsg: "Alertas em segundo plano ativados", notifyOffMsg: "Alertas em segundo plano desativados",
      soundOnMsg: "Som ativado", soundOffMsg: "Som desativado",
      clearedN: "{n} limpas",
      confirmDelN: "Excluir as {n} mensagens selecionadas?",
    pwdTitle: "Verificar senha de login",
    pwdHelp: "Esta ação altera configurações sensíveis ou exclui dados. Informe a senha de login para confirmar.",
    pwdPh: "Senha de login",
    pwdWrong: "Senha incorreta",
    pwdNeed: "Informe a senha",
    pwdTooMany: "Muitas tentativas, tente novamente mais tarde",
    pwdVerify: "Confirmar",
      scopeDevice: "as mensagens deste dispositivo", scopeFilter: "o filtro atual", scopeAll: "todas as mensagens",
      confirmClear: "Limpar {scope}? Todas as mensagens correspondentes serão excluídas de forma suave (não pode ser desfeito).",
      confirmClear2: "Confirmar novamente: realmente limpar {scope}?",
      renamePrompt: "Renomear a etiqueta \"{name}\"\nDeixe vazio para restaurar o nome padrão", renameFail: "Falha ao renomear",
      noOthers: "Nenhum outro dispositivo para mesclar",
      mergePrompt: "Mesclar todas as mensagens de \"{a}\" para qual dispositivo?\n{list}\nDigite o número:",
      invalidIdx: "Número inválido",
      mergeConfirm: "Mesclar todas as mensagens de \"{a}\" para \"{b}\"?\nA etiqueta \"{a}\" será removida.",
      targetMissing: "Dispositivo de destino não encontrado", mergeFail: "Falha ao mesclar",
      delDevConfirm: "Excluir esta etiqueta de dispositivo? (primeiro limpe todos os SMS)",
      hasMessages: "Este dispositivo ainda tem SMS — exclua-os primeiro", delFail: "Falha ao excluir",
      devCount: "({n})",
      justNow: "agora mesmo", minAgo: "há {n} min", hourAgo: "há {n} h", today: "Hoje", yesterday: "Ontem",
      unnamed: "Dispositivo sem nome"
    }
  };
  /* 设置中心文案（九语种）。以独立表合并进 I18N，避免改动既有字典结构。 */
  var SC_I18N = {
    "zh-CN": {
    scMenuCenter: "设置中心",
    scMenuTtl: "登录有效期",
    scGrpAccess: "接入",
    scMenuTokens: "接入令牌",
    scTitle: "设置中心",
    scDirty: "未保存",
    scTabSession: "登录与会话",
    scTabNotify: "通知",
    scTabBiz: "数据与业务",
    scTabSec: "安全",
    scReset: "恢复默认",
    scScopeGlobal: "全局",
    scScopeBrowser: "本浏览器",
    scSessionBrowser: "登录有效期（本浏览器）",
    scSessionGlobal: "登录有效期（全局默认）",
    scTtl: "时长",
    scTtlGlobal: "默认时长",
    scFollowGlobal: "跟随全局默认（清除本浏览器设置）",
    scCustom: "自定义分钟数…",
    scEffLocal: "当前浏览器：{v}（已单独设置）",
    scEffGlobal: "当前浏览器：跟随全局默认（{v}）",
    scHelpLocal: "只改这个浏览器的登录时长，不影响其他设备；保存后下次登录生效。选择「跟随全局默认」可恢复。",
    scHelpGlobal: "没有单独设置时长的浏览器都按这里登录。改完对新登录生效，已登录的不会掉线。范围 5 ~ 43200 分钟。",
    scMin30: "30 分钟",
    scHour1: "1 小时",
    scHour8: "8 小时",
    scHour24: "24 小时",
    scDay7: "7 天",
    scDay30: "30 天",
    scNotifyRules: "通知规则",
    scNotifyHelp: "改完点保存即可生效。密钥只保存在服务器，这里只显示「已配置」；留空表示不改动，勾选「清除」才会删除。",
    scNotifyEnabled: "通知总开关",
    scNotifyTypes: "转发类型",
    scTypeVerify: "验证码",
    scTypeSms: "短信",
    scTypeNotify: "通知",
    scRetry: "失败重试",
    scNoRetry: "不重试",
    scRetryN: "{n} 次",
    scRetryHelp: "转发失败后的重试次数上限",
    scLink: "跳转链接",
    scLinkPh: "https://…（可选，附加到通知正文）",
    scConfigured: "已配置",
    scNotConfigured: "未配置",
    scFromDb: "设置",
    scFromEnv: "环境变量",
    scEnable: "启用",
    scTest: "测试",
    scSendTest: "发送测试通知",
    scTestSaved: "请先保存，再发送测试；测试会使用<b>已保存</b>的配置。",
    scTestOk: "测试通知已发送",
    scTestNotCfg: "该渠道尚未配置，请先保存凭据",
    scTestFail: "发送失败",
    scTestFailMsg: "发送失败：{m}",
    scImportEnv: "同步环境变量配置",
    scImported: "已导入 {n} 项环境变量配置",
    scNoImport: "没有可导入的环境变量配置",
    scImportFail: "导入失败",
    scImportFailMsg: "导入失败：{e}",
    scSensitivePhCfg: "已配置 {m}（留空不修改）",
    scSensitivePhNew: "未配置，输入后保存",
    scClear: "清除",
    scRetention: "消息保留",
    scDays: "保留天数",
    scDaysHelp: "超过这个天数的消息会被自动清理，范围 1 ~ 3650 天；调小后清理会加快，删除后无法恢复。",
    scArea: "号码归属地",
    scAreaEnable: "启用查询",
    scAreaApi: "接口地址",
    scAreaApiPh: "留空使用内置免费接口",
    scAreaHelp: "关闭后列表不再显示归属地。自定义接口需要支持 {number} 占位；留空则使用内置免费接口。",
    scTokenTitle: "接入令牌",
    scTokenHelp: "推送端用令牌接入。可以为不同设备或脚本分别创建，随时停用或删除，互不影响。",
    scManage: "管理",
    scOpenTokens: "打开接入令牌管理",
    scTokenAlert: "新令牌只在创建时显示一次，请立即复制保存。",
    scLoginGuard: "登录防护",
    scLoginGuardHelp: "连续输错 5 次密码会锁定 10 分钟；退出登录会清除本浏览器的登录状态。",
    scResetSession: "本浏览器恢复为跟随全局默认（30 分钟）",
    scResetNotify: "通知总开关恢复开启、转发类型全选、重试 0 次、跳转链接清空（渠道凭据不变）",
    scResetBiz: "保留天数恢复 30 天、归属地查询开启、自定义接口清空",
    scResetConfirm: "恢复默认：{what}。确认后需点击「保存」才会写入，是否继续？",
    scResetNoDefault: "该分组无默认值可恢复",
    scResetFilled: "已填入默认值，请点击保存生效",
    scCancelDone: "已恢复为上次保存的设置",
    scNoChanges: "没有需要保存的修改",
    scNoSave: "该分组无需保存",
    scReadFail: "读取设置失败",
    scSaveFail: "保存失败",
    scSaveFailMsg: "保存失败：{e}",
    scRevisionConflict: "设置已被其他会话修改，请关闭后重新打开再保存",
    scSavedTtl: "设置已保存（下次登录生效）",
    scSavedTtlGlobal: "设置已保存（本浏览器时长下次登录生效）",
    scKeepOneType: "至少保留一种转发类型",
    scDaysInvalid: "保留天数须为 1 ~ 3650",
    scApiInvalid: "接口地址须为 http/https 完整地址，或留空",
    scTtlRange: "时长须为 5 ~ 43200 分钟（30 天）",
    scCloseConfirm: "设置有未保存的修改，关闭后这些修改将丢弃。确定关闭？",
    scSwitchConfirm: "当前分组有未保存的修改，切换后将丢弃，继续？",
    nfWebhook: "回调地址",
    nfSecret: "签名密钥",
    nfSendkey: "发送密钥",
    nfToken: "令牌 / 密钥",
    nfBotToken: "机器人令牌",
    nfChatId: "会话标识",
    nfDeviceKey: "设备密钥",
    nfUrl: "服务地址",
    nfApiKey: "接口密钥",
    nfMailTo: "收件人",
    nfMailFrom: "发件人",
    nfUrls: "回调地址",
    nfTemplate: "请求体模板",
    nfHeaders: "自定义请求头"
    },
    "zh-TW": {
    scMenuCenter: "設定中心",
    scMenuTtl: "登入有效期",
    scGrpAccess: "接入",
    scMenuTokens: "接入權杖",
    scTitle: "設定中心",
    scDirty: "未儲存",
    scTabSession: "登入與工作階段",
    scTabNotify: "通知",
    scTabBiz: "資料與業務",
    scTabSec: "安全",
    scReset: "恢復預設",
    scScopeGlobal: "全域",
    scScopeBrowser: "本瀏覽器",
    scSessionBrowser: "登入有效期（本瀏覽器）",
    scSessionGlobal: "登入有效期（全域預設）",
    scTtl: "時長",
    scTtlGlobal: "預設時長",
    scFollowGlobal: "跟隨全域預設（清除本瀏覽器設定）",
    scCustom: "自訂分鐘數…",
    scEffLocal: "本瀏覽器：{v}（已單獨設定，不隨全域變化）",
    scEffGlobal: "本瀏覽器：跟隨全域預設（{v}）",
    scHelpLocal: "只改這個瀏覽器的登入時長，不影響其他裝置；儲存後下次登入生效。選擇「跟隨全域預設」可恢復。",
    scHelpGlobal: "沒有單獨設定時長的瀏覽器都按這裡登入。改完對新登入生效，已登入的不會掉線。範圍 5 ~ 43200 分鐘。",
    scMin30: "30 分鐘",
    scHour1: "1 小時",
    scHour8: "8 小時",
    scHour24: "24 小時",
    scDay7: "7 天",
    scDay30: "30 天",
    scNotifyRules: "通知規則",
    scNotifyHelp: "改完點儲存即可生效。密鑰只保存在伺服器，這裡只顯示「已設定」；留空表示不改動，勾選「清除」才會刪除。",
    scNotifyEnabled: "通知總開關",
    scNotifyTypes: "轉發類型",
    scTypeVerify: "驗證碼",
    scTypeSms: "簡訊",
    scTypeNotify: "通知",
    scRetry: "失敗重試",
    scNoRetry: "不重試",
    scRetryN: "{n} 次",
    scRetryHelp: "轉發失敗後的重試次數上限",
    scLink: "跳轉連結",
    scLinkPh: "https://…（選填，附加到通知內容）",
    scConfigured: "已設定",
    scNotConfigured: "未設定",
    scFromDb: "資料庫",
    scFromEnv: "環境變數",
    scEnable: "啟用",
    scTest: "測試",
    scSendTest: "傳送測試通知",
    scTestSaved: "測試通知使用<b>已儲存</b>的設定：修改憑證後請先儲存再測試。",
    scTestOk: "測試通知已傳送",
    scTestNotCfg: "此管道尚未設定，請先儲存憑證",
    scTestFail: "傳送失敗",
    scTestFailMsg: "傳送失敗：{m}",
    scImportEnv: "從環境變數匯入",
    scImported: "已匯入 {n} 項環境變數設定",
    scNoImport: "沒有可匯入的環境變數設定",
    scImportFail: "匯入失敗",
    scImportFailMsg: "匯入失敗：{e}",
    scSensitivePhCfg: "已設定 {m}（留空不修改）",
    scSensitivePhNew: "未設定，輸入後儲存",
    scClear: "清除",
    scRetention: "訊息保留",
    scDays: "保留天數",
    scDaysHelp: "超過此天數的訊息會被自動清理，範圍 1 ~ 3650 天；調小後清理會加快，刪除後無法復原。",
    scArea: "號碼歸屬地",
    scAreaEnable: "啟用查詢",
    scAreaApi: "介面位址",
    scAreaApiPh: "留空使用內建免費介面",
    scAreaHelp: "關閉後清單不再顯示歸屬地。自訂介面需支援 {number} 佔位；留空則使用內建免費介面。",
    scTokenTitle: "接入權杖",
    scTokenHelp: "推送端用權杖接入。可以為不同裝置或腳本分別建立，隨時停用或刪除，互不影響。",
    scManage: "管理",
    scOpenTokens: "開啟接入權杖管理",
    scTokenAlert: "新權杖只在建立時顯示一次，請立即複製保存。",
    scLoginGuard: "登入防護",
    scLoginGuardHelp: "連續輸入錯誤 5 次密碼會鎖定 10 分鐘；登出會清除本瀏覽器的登入狀態。",
    scResetSession: "本瀏覽器恢復為跟隨全域預設（30 分鐘）",
    scResetNotify: "通知總開關恢復開啟、轉發類型全選、重試 0 次、跳轉連結清空（管道憑證不變）",
    scResetBiz: "保留天數恢復 30 天、歸屬地查詢開啟、自訂介面清空",
    scResetConfirm: "恢復預設：{what}。確認後需點擊「儲存」才會寫入，是否繼續？",
    scResetNoDefault: "此分組無預設值可恢復",
    scResetFilled: "已填入預設值，請點擊儲存生效",
    scCancelDone: "已恢復為上次儲存的設定",
    scNoChanges: "沒有需要儲存的修改",
    scNoSave: "此分組無需儲存",
    scReadFail: "讀取設定失敗",
    scSaveFail: "儲存失敗",
    scSaveFailMsg: "儲存失敗：{e}",
    scRevisionConflict: "設定已被其他工作階段修改，請關閉後重新開啟再儲存",
    scSavedTtl: "設定已儲存（下次登入生效）",
    scSavedTtlGlobal: "設定已儲存（本瀏覽器時長下次登入生效）",
    scKeepOneType: "至少保留一種轉發類型",
    scDaysInvalid: "保留天數須為 1 ~ 3650",
    scApiInvalid: "介面位址須為 http/https 完整位址，或留空",
    scTtlRange: "時長須為 5 ~ 43200 分鐘（30 天）",
    scCloseConfirm: "設定有未儲存的修改，關閉後這些修改將捨棄。確定關閉？",
    scSwitchConfirm: "目前分組有未儲存的修改，切換後將捨棄，繼續？",
    nfWebhook: "回呼位址",
    nfSecret: "簽名金鑰",
    nfSendkey: "傳送金鑰",
    nfToken: "權杖 / 金鑰",
    nfBotToken: "機器人權杖",
    nfChatId: "會話識別碼",
    nfDeviceKey: "裝置金鑰",
    nfUrl: "服務位址",
    nfApiKey: "介面金鑰",
    nfMailTo: "收件人",
    nfMailFrom: "寄件人",
    nfUrls: "回呼位址",
    nfTemplate: "請求內文範本",
    nfHeaders: "自訂請求標頭"
    },
    "en": {
    scMenuCenter: "Settings Center",
    scMenuTtl: "Sign-in validity",
    scGrpAccess: "Access",
    scMenuTokens: "Access tokens",
    scTitle: "Settings Center",
    scDirty: "Unsaved",
    scTabSession: "Sign-in & session",
    scTabNotify: "Notifications",
    scTabBiz: "Data & operations",
    scTabSec: "Security",
    scReset: "Restore defaults",
    scScopeGlobal: "Global",
    scScopeBrowser: "This browser",
    scSessionBrowser: "Sign-in validity (this browser)",
    scSessionGlobal: "Sign-in validity (global default)",
    scTtl: "Duration",
    scTtlGlobal: "Default duration",
    scFollowGlobal: "Follow global default (clear this browser)",
    scCustom: "Custom minutes…",
    scEffLocal: "This browser: {v} (set separately)",
    scEffGlobal: "This browser: following global default ({v})",
    scHelpLocal: "Changes only this browser's sign-in duration; other devices are unaffected. Takes effect next time you sign in. Choose \"Follow global default\" to reset.",
    scHelpGlobal: "Browsers without their own duration follow this value. Changes apply to new sign-ins; existing sessions stay signed in. Range 5–43200 minutes.",
    scMin30: "30 minutes",
    scHour1: "1 hour",
    scHour8: "8 hours",
    scHour24: "24 hours",
    scDay7: "7 days",
    scDay30: "30 days",
    scNotifyRules: "Notification rules",
    scNotifyHelp: "Tap Save to apply. Keys stay on the server; this page only shows whether a channel is configured. Leave blank to keep the current value, tick \"Clear\" to delete.",
    scNotifyEnabled: "Notifications enabled",
    scNotifyTypes: "Forward types",
    scTypeVerify: "Verification codes",
    scTypeSms: "SMS",
    scTypeNotify: "Notifications",
    scRetry: "Retry on failure",
    scNoRetry: "No retry",
    scRetryN: "{n} times",
    scRetryHelp: "Maximum retries after a failed forward",
    scLink: "Action link",
    scLinkPh: "https://… (optional, appended to notifications)",
    scConfigured: "Configured",
    scNotConfigured: "Not configured",
    scFromDb: "Settings",
    scFromEnv: "Env var",
    scEnable: "Enabled",
    scTest: "Test",
    scSendTest: "Send test notification",
    scTestSaved: "Save first, then send a test — the test uses the <b>saved</b> settings.",
    scTestOk: "Test notification sent",
    scTestNotCfg: "This channel is not configured yet — save its credentials first",
    scTestFail: "Send failed",
    scTestFailMsg: "Send failed: {m}",
    scImportEnv: "Sync environment settings",
    scImported: "Imported {n} settings",
    scNoImport: "No importable settings",
    scImportFail: "Import failed",
    scImportFailMsg: "Import failed: {e}",
    scSensitivePhCfg: "Configured {m} (leave empty to keep)",
    scSensitivePhNew: "Not configured — enter a value and save",
    scClear: "Clear",
    scRetention: "Message retention",
    scDays: "Retention days",
    scDaysHelp: "Messages older than this are cleaned up automatically (1–3650 days). A shorter period cleans sooner; deleted messages cannot be recovered.",
    scArea: "Number location",
    scAreaEnable: "Enable lookup",
    scAreaApi: "API endpoint",
    scAreaApiPh: "Leave empty for the built-in free API",
    scAreaHelp: "Turn this off to hide locations in the list. A custom service must accept the {number} placeholder (http/https); leave it empty to use the built-in free service.",
    scTokenTitle: "Access tokens",
    scTokenHelp: "Push clients use tokens to connect. Create a separate token for each device or script, and disable or delete it anytime without affecting the others.",
    scManage: "Manage",
    scOpenTokens: "Open token manager",
    scTokenAlert: "A new token is shown only once when it is created — copy and save it now.",
    scLoginGuard: "Sign-in protection",
    scLoginGuardHelp: "After 5 wrong passwords, sign-in is locked for 10 minutes. Signing out only clears this browser's login state.",
    scResetSession: "reset this browser to follow the global default (30 minutes)",
    scResetNotify: "re-enable notifications, select all types, retry 0, clear the link (channel credentials unchanged)",
    scResetBiz: "retention 30 days, location lookup on, custom endpoint cleared",
    scResetConfirm: "Restore defaults: {what}. Nothing is written until you click Save. Continue?",
    scResetNoDefault: "This group has no defaults to restore",
    scResetFilled: "Defaults filled in — click Save to apply",
    scCancelDone: "Restored to the last saved values",
    scNoChanges: "Nothing to save",
    scNoSave: "This group needs no saving",
    scReadFail: "Failed to load settings",
    scSaveFail: "Save failed",
    scSaveFailMsg: "Save failed: {e}",
    scRevisionConflict: "Settings were changed in another session — close and reopen before saving",
    scSavedTtl: "Saved (applies to your next sign-in)",
    scSavedTtlGlobal: "Saved (this browser's duration applies to your next sign-in)",
    scKeepOneType: "Keep at least one forward type",
    scDaysInvalid: "Retention must be 1–3650 days",
    scApiInvalid: "The endpoint must be a full http/https URL, or empty",
    scTtlRange: "Duration must be 5–43200 minutes (30 days)",
    scCloseConfirm: "Settings have unsaved changes that will be lost. Close anyway?",
    scSwitchConfirm: "This group has unsaved changes that will be discarded. Continue?",
    nfWebhook: "Webhook URL",
    nfSecret: "Signing secret",
    nfSendkey: "SendKey",
    nfToken: "Token / key",
    nfBotToken: "Bot token",
    nfChatId: "Chat ID",
    nfDeviceKey: "Device key",
    nfUrl: "Service URL",
    nfApiKey: "API key",
    nfMailTo: "Recipient",
    nfMailFrom: "Sender",
    nfUrls: "Webhook URL",
    nfTemplate: "Request body template",
    nfHeaders: "Custom headers"
    },
    "ja": {
    scMenuCenter: "設定センター",
    scMenuTtl: "ログイン有効期間",
    scGrpAccess: "接続",
    scMenuTokens: "接続トークン",
    scTitle: "設定センター",
    scDirty: "未保存",
    scTabSession: "ログインとセッション",
    scTabNotify: "通知",
    scTabBiz: "データと運用",
    scTabSec: "セキュリティ",
    scReset: "既定値に戻す",
    scScopeGlobal: "全体",
    scScopeBrowser: "このブラウザー",
    scSessionBrowser: "ログイン有効期間（このブラウザー）",
    scSessionGlobal: "ログイン有効期間（全体の既定値）",
    scTtl: "期間",
    scTtlGlobal: "既定の期間",
    scFollowGlobal: "全体の既定値に従う（このブラウザーの設定を消去）",
    scCustom: "任意の分数…",
    scEffLocal: "このブラウザー：{v}（個別設定、全体の値には従いません）",
    scEffGlobal: "このブラウザー：全体の既定値に従う（{v}）",
    scHelpLocal: "このブラウザーの<b>今後のログイン</b>にのみ影響します。サーバー側の全体既定値は変更されず、他のブラウザーにも影響しません。発行済みセッションの有効期限は変わりません。「全体の既定値に従う」でこのブラウザーの設定を消去できます。",
    scHelpGlobal: "このブラウザーに個別設定がない場合、および期間を送らない旧クライアントのフォールバックとして使用します。範囲は 5～43200 分。変更は今後のログインにのみ影響し、発行済みセッションは変わりません。",
    scMin30: "30 分",
    scHour1: "1 時間",
    scHour8: "8 時間",
    scHour24: "24 時間",
    scDay7: "7 日",
    scDay30: "30 日",
    scNotifyRules: "通知ルール",
    scNotifyHelp: "データベースに保存され即時反映されます。機密項目はサーバー側のみに保存され、画面には設定済みかどうかだけを表示します。空欄のままは変更なし、「清除」を選ぶと保存値が削除されます。",
    scNotifyEnabled: "通知の有効化",
    scNotifyTypes: "転送する種類",
    scTypeVerify: "認証コード",
    scTypeSms: "SMS",
    scTypeNotify: "通知",
    scRetry: "失敗時の再試行",
    scNoRetry: "再試行しない",
    scRetryN: "{n} 回",
    scRetryHelp: "転送失敗後の最大再試行回数",
    scLink: "遷移リンク",
    scLinkPh: "https://…（任意、通知本文に付加）",
    scConfigured: "設定済み",
    scNotConfigured: "未設定",
    scFromDb: "データベース",
    scFromEnv: "環境変数",
    scEnable: "有効",
    scTest: "テスト",
    scSendTest: "テスト通知を送信",
    scTestSaved: "テスト通知は<b>保存済み</b>の設定を使います。認証情報を変更したら先に保存してください。",
    scTestOk: "テスト通知を送信しました",
    scTestNotCfg: "このチャネルは未設定です。先に認証情報を保存してください",
    scTestFail: "送信に失敗しました",
    scTestFailMsg: "送信に失敗しました：{m}",
    scImportEnv: "環境変数から取り込む",
    scImported: "{n} 件の設定を取り込みました",
    scNoImport: "取り込める設定はありません",
    scImportFail: "取り込みに失敗しました",
    scImportFailMsg: "取り込みに失敗しました：{e}",
    scSensitivePhCfg: "設定済み {m}（空欄なら変更なし）",
    scSensitivePhNew: "未設定（入力後に保存）",
    scClear: "消去",
    scRetention: "メッセージ保持",
    scDays: "保持日数",
    scDaysHelp: "定期削除はこの日数を超えたメッセージを削除します（1～3650 日）。短くすると削除が早まり、元に戻せません。",
    scArea: "番号の地域情報",
    scAreaEnable: "照会を有効化",
    scAreaApi: "API エンドポイント",
    scAreaApiPh: "空欄なら内蔵の無料 API を使用",
    scAreaHelp: "独自のエンドポイントは {number} プレースホルダーに対応している必要があります（http/https）。無効にすると一覧に地域情報は表示されません。空欄は内蔵の無料 API です。",
    scTokenTitle: "接続トークン",
    scTokenHelp: "取り込み側は接続トークンで認証します。名前付きトークンは作成・更新・失効が個別にでき、失効後は即座に無効になります。",
    scManage: "管理",
    scOpenTokens: "接続トークン管理を開く",
    scTokenAlert: "トークンの平文は作成時に一度だけ表示されます。このページは値を読み取り・表示しません。",
    scLoginGuard: "ログイン保護",
    scLoginGuardHelp: "パスワードを 5 回間違えると 10 分間ロックされます。セッションは署名付きステートレストークンで、ログアウトは Cookie を消すだけです。ポリシーはデプロイ設定で決まります。",
    scResetSession: "このブラウザーの設定を消去し、全体の既定値を 30 分に戻す",
    scResetNotify: "通知を有効化、全種類を選択、再試行 0、リンクを消去（チャネルの認証情報は変更なし）",
    scResetBiz: "保持 30 日、地域照会を有効、独自エンドポイントを消去",
    scResetConfirm: "既定値に戻します：{what}。「保存」を押すまで書き込みは行われません。続行しますか？",
    scResetNoDefault: "このグループに既定値はありません",
    scResetFilled: "既定値を入力しました。「保存」で反映されます",
    scCancelDone: "最後に保存した値に戻しました",
    scNoChanges: "保存する変更はありません",
    scNoSave: "このグループは保存不要です",
    scReadFail: "設定の読み込みに失敗しました",
    scSaveFail: "保存に失敗しました",
    scSaveFailMsg: "保存に失敗しました：{e}",
    scRevisionConflict: "別のセッションで設定が変更されました。閉じて開き直してから保存してください",
    scSavedTtl: "保存しました（次回ログインから有効）",
    scSavedTtlGlobal: "保存しました（このブラウザーの期間は次回ログインから有効）",
    scKeepOneType: "転送する種類を 1 つ以上選んでください",
    scDaysInvalid: "保持日数は 1～3650 です",
    scApiInvalid: "エンドポイントは http/https の完全な URL か空欄にしてください",
    scTtlRange: "期間は 5～43200 分（30 日）です",
    scCloseConfirm: "未保存の変更があります。閉じると失われます。閉じますか？",
    scSwitchConfirm: "このグループに未保存の変更があり、破棄されます。続行しますか？",
    nfWebhook: "Webhook URL",
    nfSecret: "署名シークレット",
    nfSendkey: "SendKey",
    nfToken: "トークン / キー",
    nfBotToken: "Bot トークン",
    nfChatId: "チャット ID",
    nfDeviceKey: "デバイスキー",
    nfUrl: "サービス URL",
    nfApiKey: "API キー",
    nfMailTo: "宛先",
    nfMailFrom: "差出人",
    nfUrls: "Webhook URL",
    nfTemplate: "リクエスト本文テンプレート",
    nfHeaders: "カスタムヘッダー"
    },
    "ko": {
    scMenuCenter: "설정 센터",
    scMenuTtl: "로그인 유효기간",
    scGrpAccess: "연결",
    scMenuTokens: "접속 토큰",
    scTitle: "설정 센터",
    scDirty: "저장 안 됨",
    scTabSession: "로그인 및 세션",
    scTabNotify: "알림",
    scTabBiz: "데이터 및 운영",
    scTabSec: "보안",
    scReset: "기본값 복원",
    scScopeGlobal: "전역",
    scScopeBrowser: "이 브라우저",
    scSessionBrowser: "로그인 유효기간(이 브라우저)",
    scSessionGlobal: "로그인 유효기간(전역 기본값)",
    scTtl: "기간",
    scTtlGlobal: "기본 기간",
    scFollowGlobal: "전역 기본값 따르기(이 브라우저 설정 지우기)",
    scCustom: "사용자 지정 분…",
    scEffLocal: "이 브라우저: {v}(별도 설정, 전역 값을 따르지 않음)",
    scEffGlobal: "이 브라우저: 전역 기본값 따르는 중({v})",
    scHelpLocal: "이 브라우저의 <b>이후 새 로그인</b>에만 적용됩니다. 서버 전역 기본값을 바꾸지 않으며 다른 브라우저에 영향이 없습니다. 이미 발급된 세션의 만료 시각은 그대로입니다. \"전역 기본값 따르기\"를 선택하면 이 브라우저 설정이 지워집니다.",
    scHelpGlobal: "이 브라우저에 별도 설정이 없을 때, 그리고 기간을 보내지 않는 구형 클라이언트의 대체값으로 사용됩니다. 범위 5~43200분. 변경은 이후 새 로그인에만 적용되며 이미 발급된 세션은 그대로입니다.",
    scMin30: "30분",
    scHour1: "1시간",
    scHour8: "8시간",
    scHour24: "24시간",
    scDay7: "7일",
    scDay30: "30일",
    scNotifyRules: "알림 규칙",
    scNotifyHelp: "데이터베이스에 저장되어 즉시 적용됩니다. 민감 항목은 서버에만 저장되고 화면에는 설정 여부만 표시됩니다. 빈 값은 변경 없음, \"지우기\"를 선택하면 저장값이 삭제됩니다.",
    scNotifyEnabled: "알림 사용",
    scNotifyTypes: "전달 유형",
    scTypeVerify: "인증번호",
    scTypeSms: "SMS",
    scTypeNotify: "알림",
    scRetry: "실패 시 재시도",
    scNoRetry: "재시도 안 함",
    scRetryN: "{n}회",
    scRetryHelp: "전달 실패 후 최대 재시도 횟수",
    scLink: "이동 링크",
    scLinkPh: "https://…(선택, 알림 본문에 추가)",
    scConfigured: "설정됨",
    scNotConfigured: "설정 안 됨",
    scFromDb: "데이터베이스",
    scFromEnv: "환경 변수",
    scEnable: "사용",
    scTest: "테스트",
    scSendTest: "테스트 알림 보내기",
    scTestSaved: "테스트 알림은 <b>저장된</b> 설정을 사용합니다. 자격 증명을 바꾼 뒤 먼저 저장하세요.",
    scTestOk: "테스트 알림을 보냈습니다",
    scTestNotCfg: "이 채널은 아직 설정되지 않았습니다. 먼저 자격 증명을 저장하세요",
    scTestFail: "전송 실패",
    scTestFailMsg: "전송 실패: {m}",
    scImportEnv: "환경 변수에서 가져오기",
    scImported: "설정 {n}개를 가져왔습니다",
    scNoImport: "가져올 설정이 없습니다",
    scImportFail: "가져오기 실패",
    scImportFailMsg: "가져오기 실패: {e}",
    scSensitivePhCfg: "설정됨 {m}(빈 값이면 유지)",
    scSensitivePhNew: "설정 안 됨 — 값을 입력하고 저장",
    scClear: "지우기",
    scRetention: "메시지 보관",
    scDays: "보관 일수",
    scDaysHelp: "예약 정리는 이 일수를 초과한 메시지를 삭제합니다(1~3650일). 줄이면 정리가 빨라지며 되돌릴 수 없습니다.",
    scArea: "번호 지역 정보",
    scAreaEnable: "조회 사용",
    scAreaApi: "API 엔드포인트",
    scAreaApiPh: "빈 값이면 내장 무료 API 사용",
    scAreaHelp: "사용자 지정 엔드포인트는 {number} 자리표시자를 지원해야 합니다(http/https). 끄면 목록에 지역 정보가 표시되지 않습니다. 빈 값은 내장 무료 API입니다.",
    scTokenTitle: "접속 토큰",
    scTokenHelp: "수집 측은 접속 토큰으로 인증합니다. 이름 있는 토큰은 생성·갱신·해지가 가능하며 해지 즉시 무효가 됩니다.",
    scManage: "관리",
    scOpenTokens: "접속 토큰 관리 열기",
    scTokenAlert: "토큰 평문은 생성 시 한 번만 표시됩니다. 이 페이지는 값을 읽거나 표시하지 않습니다.",
    scLoginGuard: "로그인 보호",
    scLoginGuardHelp: "비밀번호를 5회 틀리면 10분간 잠깁니다. 세션은 서명된 무상태 토큰이며 로그아웃은 브라우저 쿠키만 지웁니다. 정책은 배포 설정을 따릅니다.",
    scResetSession: "이 브라우저 설정을 지우고 전역 기본값을 30분으로 되돌립니다",
    scResetNotify: "알림 사용, 모든 유형 선택, 재시도 0, 링크 지우기(채널 자격 증명은 유지)",
    scResetBiz: "보관 30일, 지역 조회 사용, 사용자 지정 엔드포인트 지우기",
    scResetConfirm: "기본값 복원: {what}. \"저장\"을 눌러야 반영됩니다. 계속할까요?",
    scResetNoDefault: "이 그룹은 복원할 기본값이 없습니다",
    scResetFilled: "기본값을 채웠습니다. 저장을 눌러 적용하세요",
    scCancelDone: "마지막으로 저장한 값으로 되돌렸습니다",
    scNoChanges: "저장할 변경이 없습니다",
    scNoSave: "이 그룹은 저장이 필요 없습니다",
    scReadFail: "설정을 불러오지 못했습니다",
    scSaveFail: "저장 실패",
    scSaveFailMsg: "저장 실패: {e}",
    scRevisionConflict: "다른 세션에서 설정이 변경되었습니다. 닫았다가 다시 열고 저장하세요",
    scSavedTtl: "저장했습니다(다음 로그인부터 적용)",
    scSavedTtlGlobal: "저장했습니다(이 브라우저 기간은 다음 로그인부터 적용)",
    scKeepOneType: "전달 유형을 하나 이상 선택하세요",
    scDaysInvalid: "보관 일수는 1~3650입니다",
    scApiInvalid: "엔드포인트는 http/https 전체 URL 또는 빈 값이어야 합니다",
    scTtlRange: "기간은 5~43200분(30일)입니다",
    scCloseConfirm: "저장되지 않은 변경이 있습니다. 닫으면 사라집니다. 닫을까요?",
    scSwitchConfirm: "이 그룹에 저장되지 않은 변경이 있으며 사라집니다. 계속할까요?",
    nfWebhook: "Webhook URL",
    nfSecret: "서명 비밀 키",
    nfSendkey: "SendKey",
    nfToken: "토큰 / 키",
    nfBotToken: "Bot 토큰",
    nfChatId: "채팅 ID",
    nfDeviceKey: "기기 키",
    nfUrl: "서비스 URL",
    nfApiKey: "API 키",
    nfMailTo: "수신자",
    nfMailFrom: "발신자",
    nfUrls: "Webhook URL",
    nfTemplate: "요청 본문 템플릿",
    nfHeaders: "사용자 지정 헤더"
    },
    "es": {
    scMenuCenter: "Centro de ajustes",
    scMenuTtl: "Validez de sesión",
    scGrpAccess: "Acceso",
    scMenuTokens: "Tokens de acceso",
    scTitle: "Centro de ajustes",
    scDirty: "Sin guardar",
    scTabSession: "Acceso y sesión",
    scTabNotify: "Notificaciones",
    scTabBiz: "Datos y operación",
    scTabSec: "Seguridad",
    scReset: "Restaurar valores",
    scScopeGlobal: "Global",
    scScopeBrowser: "Este navegador",
    scSessionBrowser: "Validez de sesión (este navegador)",
    scSessionGlobal: "Validez de sesión (predeterminado global)",
    scTtl: "Duración",
    scTtlGlobal: "Duración predeterminada",
    scFollowGlobal: "Seguir el valor global (borrar ajuste de este navegador)",
    scCustom: "Minutos personalizados…",
    scEffLocal: "Este navegador: {v} (ajuste propio, no sigue el global)",
    scEffGlobal: "Este navegador: sigue el valor global ({v})",
    scHelpLocal: "Solo afecta a <b>nuevos inicios de sesión en este navegador</b>. No cambia el valor global del servidor ni afecta a otros navegadores; las sesiones ya emitidas conservan su caducidad. Elija \"Seguir el valor global\" para borrar este ajuste.",
    scHelpGlobal: "Se usa cuando un navegador no tiene ajuste propio y como respaldo para clientes antiguos que no envían duración. Rango 5–43200 minutos; los cambios solo afectan nuevos inicios de sesión.",
    scMin30: "30 minutos",
    scHour1: "1 hora",
    scHour8: "8 horas",
    scHour24: "24 horas",
    scDay7: "7 días",
    scDay30: "30 días",
    scNotifyRules: "Reglas de notificación",
    scNotifyHelp: "Se guarda en la base de datos y se aplica al instante. Los campos sensibles se guardan solo en el servidor; la página muestra si están configurados. Dejar vacío no cambia nada; marque \"Borrar\" para eliminarlo.",
    scNotifyEnabled: "Notificaciones activas",
    scNotifyTypes: "Tipos reenviados",
    scTypeVerify: "Códigos",
    scTypeSms: "SMS",
    scTypeNotify: "Notificaciones",
    scRetry: "Reintentos",
    scNoRetry: "Sin reintentos",
    scRetryN: "{n} veces",
    scRetryHelp: "Máximo de reintentos tras un fallo",
    scLink: "Enlace de acción",
    scLinkPh: "https://… (opcional, se añade al aviso)",
    scConfigured: "Configurado",
    scNotConfigured: "Sin configurar",
    scFromDb: "Base de datos",
    scFromEnv: "Variable de entorno",
    scEnable: "Activo",
    scTest: "Probar",
    scSendTest: "Enviar aviso de prueba",
    scTestSaved: "El aviso de prueba usa la configuración <b>guardada</b>: guarde antes de probar.",
    scTestOk: "Aviso de prueba enviado",
    scTestNotCfg: "Este canal aún no está configurado: guarde sus credenciales",
    scTestFail: "Error al enviar",
    scTestFailMsg: "Error al enviar: {m}",
    scImportEnv: "Importar desde variables de entorno",
    scImported: "Se importaron {n} ajustes",
    scNoImport: "No hay ajustes importables",
    scImportFail: "Error al importar",
    scImportFailMsg: "Error al importar: {e}",
    scSensitivePhCfg: "Configurado {m} (vacío no cambia)",
    scSensitivePhNew: "Sin configurar: introduzca y guarde",
    scClear: "Borrar",
    scRetention: "Retención de mensajes",
    scDays: "Días de retención",
    scDaysHelp: "La limpieza programada borra mensajes más antiguos, rango 1–3650 días. Reducirlo acelera el borrado y no se puede deshacer.",
    scArea: "Ubicación del número",
    scAreaEnable: "Activar consulta",
    scAreaApi: "Dirección de API",
    scAreaApiPh: "Vacío = API gratuita integrada",
    scAreaHelp: "Un endpoint propio debe admitir el marcador {number} (http/https). Si se desactiva, la lista no muestra ubicaciones. Vacío = API gratuita integrada.",
    scTokenTitle: "Tokens de acceso",
    scTokenHelp: "Los clientes se autentican con tokens. Los tokens con nombre se crean, rotan y revocan por origen; al revocar, dejan de funcionar.",
    scManage: "Gestionar",
    scOpenTokens: "Abrir gestor de tokens",
    scTokenAlert: "El texto del token se muestra solo al crearlo; esta página no lee ni muestra tokens.",
    scLoginGuard: "Protección de acceso",
    scLoginGuardHelp: "Bloqueo de 10 minutos tras 5 contraseñas erróneas. Las sesiones son tokens firmados sin estado; salir solo borra la cookie. Estas políticas vienen de la configuración de despliegue.",
    scResetSession: "borrar el ajuste de este navegador y volver el global a 30 minutos",
    scResetNotify: "reactivar avisos, todos los tipos, 0 reintentos, enlace vacío (credenciales intactas)",
    scResetBiz: "retención 30 días, consulta activada, endpoint vacío",
    scResetConfirm: "Restaurar valores: {what}. No se guarda hasta pulsar Guardar. ¿Continuar?",
    scResetNoDefault: "Este grupo no tiene valores por defecto",
    scResetFilled: "Valores por defecto listos: pulse Guardar",
    scCancelDone: "Restaurado a lo último guardado",
    scNoChanges: "Nada que guardar",
    scNoSave: "Este grupo no requiere guardar",
    scReadFail: "No se pudieron cargar los ajustes",
    scSaveFail: "Error al guardar",
    scSaveFailMsg: "Error al guardar: {e}",
    scRevisionConflict: "Los ajustes cambiaron en otra sesión: cierre y reabra antes de guardar",
    scSavedTtl: "Guardado (se aplica al próximo inicio de sesión)",
    scSavedTtlGlobal: "Guardado (la duración de este navegador se aplica al próximo inicio)",
    scKeepOneType: "Mantenga al menos un tipo",
    scDaysInvalid: "La retención debe ser 1–3650",
    scApiInvalid: "El endpoint debe ser una URL http/https completa o vacío",
    scTtlRange: "La duración debe ser 5–43200 minutos (30 días)",
    scCloseConfirm: "Hay cambios sin guardar que se perderán. ¿Cerrar de todos modos?",
    scSwitchConfirm: "Este grupo tiene cambios sin guardar que se descartarán. ¿Continuar?",
    nfWebhook: "URL de webhook",
    nfSecret: "Secreto de firma",
    nfSendkey: "SendKey",
    nfToken: "Token / clave",
    nfBotToken: "Token del bot",
    nfChatId: "ID de chat",
    nfDeviceKey: "Clave del dispositivo",
    nfUrl: "URL del servicio",
    nfApiKey: "Clave de API",
    nfMailTo: "Destinatario",
    nfMailFrom: "Remitente",
    nfUrls: "URL de webhook",
    nfTemplate: "Plantilla del cuerpo",
    nfHeaders: "Cabeceras personalizadas"
    },
    "fr": {
    scMenuCenter: "Centre de réglages",
    scMenuTtl: "Durée de session",
    scGrpAccess: "Accès",
    scMenuTokens: "Jetons d'accès",
    scTitle: "Centre de réglages",
    scDirty: "Non enregistré",
    scTabSession: "Connexion et session",
    scTabNotify: "Notifications",
    scTabBiz: "Données et exploitation",
    scTabSec: "Sécurité",
    scReset: "Rétablir les valeurs",
    scScopeGlobal: "Global",
    scScopeBrowser: "Ce navigateur",
    scSessionBrowser: "Durée de session (ce navigateur)",
    scSessionGlobal: "Durée de session (valeur globale)",
    scTtl: "Durée",
    scTtlGlobal: "Durée par défaut",
    scFollowGlobal: "Suivre la valeur globale (effacer ce navigateur)",
    scCustom: "Minutes personnalisées…",
    scEffLocal: "Ce navigateur : {v} (valeur propre, ne suit pas le global)",
    scEffGlobal: "Ce navigateur : suit la valeur globale ({v})",
    scHelpLocal: "Ne concerne que les <b>nouvelles connexions de ce navigateur</b>. La valeur globale du serveur n'est pas modifiée et les autres navigateurs ne sont pas affectés ; les sessions déjà émises gardent leur expiration. Choisissez « Suivre la valeur globale » pour effacer ce réglage.",
    scHelpGlobal: "Utilisée si un navigateur n'a pas de valeur propre, et comme repli pour les anciens clients sans durée. Plage 5–43200 minutes ; les changements ne touchent que les nouvelles connexions.",
    scMin30: "30 minutes",
    scHour1: "1 heure",
    scHour8: "8 heures",
    scHour24: "24 heures",
    scDay7: "7 jours",
    scDay30: "30 jours",
    scNotifyRules: "Règles de notification",
    scNotifyHelp: "Enregistré en base et appliqué immédiatement. Les champs sensibles restent côté serveur ; la page indique seulement s'ils sont configurés. Laisser vide ne change rien ; cochez « Effacer » pour supprimer.",
    scNotifyEnabled: "Notifications activées",
    scNotifyTypes: "Types transférés",
    scTypeVerify: "Codes de vérification",
    scTypeSms: "SMS",
    scTypeNotify: "Notifications",
    scRetry: "Nouvelles tentatives",
    scNoRetry: "Aucune",
    scRetryN: "{n} fois",
    scRetryHelp: "Nombre maximal de tentatives après échec",
    scLink: "Lien d'action",
    scLinkPh: "https://… (facultatif, ajouté au message)",
    scConfigured: "Configuré",
    scNotConfigured: "Non configuré",
    scFromDb: "Base de données",
    scFromEnv: "Variable d'environnement",
    scEnable: "Activer",
    scTest: "Tester",
    scSendTest: "Envoyer un test",
    scTestSaved: "Le test utilise la configuration <b>enregistrée</b> : enregistrez avant de tester.",
    scTestOk: "Test envoyé",
    scTestNotCfg: "Ce canal n'est pas encore configuré : enregistrez ses identifiants",
    scTestFail: "Échec de l'envoi",
    scTestFailMsg: "Échec de l'envoi : {m}",
    scImportEnv: "Importer depuis les variables d'environnement",
    scImported: "{n} réglages importés",
    scNoImport: "Aucun réglage à importer",
    scImportFail: "Échec de l'import",
    scImportFailMsg: "Échec de l'import : {e}",
    scSensitivePhCfg: "Configuré {m} (vide = inchangé)",
    scSensitivePhNew: "Non configuré : saisissez puis enregistrez",
    scClear: "Effacer",
    scRetention: "Conservation des messages",
    scDays: "Jours de conservation",
    scDaysHelp: "Le nettoyage planifié supprime les messages plus anciens, plage 1–3650 jours. Réduire accélère la suppression, sans retour possible.",
    scArea: "Localisation du numéro",
    scAreaEnable: "Activer la recherche",
    scAreaApi: "Adresse d'API",
    scAreaApiPh: "Vide = API gratuite intégrée",
    scAreaHelp: "Un point d'accès personnalisé doit gérer le paramètre {number} (http/https). Désactivé, la liste n'affiche plus la localisation. Vide = API gratuite intégrée.",
    scTokenTitle: "Jetons d'accès",
    scTokenHelp: "Les clients s'authentifient par jetons. Les jetons nommés se créent, tournent et révoquent par source ; une révocation est immédiate.",
    scManage: "Gérer",
    scOpenTokens: "Ouvrir la gestion des jetons",
    scTokenAlert: "Le jeton en clair n'est affiché qu'à la création ; cette page ne lit ni n'affiche aucun jeton.",
    scLoginGuard: "Protection de la connexion",
    scLoginGuardHelp: "Verrouillage 10 minutes après 5 mots de passe erronés. Les sessions sont des jetons signés sans état ; la déconnexion ne vide que le cookie. Ces règles viennent du déploiement.",
    scResetSession: "effacer ce navigateur et remettre la valeur globale à 30 minutes",
    scResetNotify: "réactiver les notifications, tous les types, 0 tentative, lien vide (identifiants inchangés)",
    scResetBiz: "conservation 30 jours, localisation activée, endpoint effacé",
    scResetConfirm: "Rétablir les valeurs : {what}. Rien n'est écrit avant « Enregistrer ». Continuer ?",
    scResetNoDefault: "Aucune valeur par défaut dans ce groupe",
    scResetFilled: "Valeurs par défaut remplies : cliquez sur Enregistrer",
    scCancelDone: "Valeurs enregistrées rétablies",
    scNoChanges: "Aucune modification à enregistrer",
    scNoSave: "Ce groupe ne nécessite aucun enregistrement",
    scReadFail: "Échec du chargement des réglages",
    scSaveFail: "Échec de l'enregistrement",
    scSaveFailMsg: "Échec de l'enregistrement : {e}",
    scRevisionConflict: "Réglages modifiés dans une autre session : rouvrez avant d'enregistrer",
    scSavedTtl: "Enregistré (applicable à la prochaine connexion)",
    scSavedTtlGlobal: "Enregistré (la durée de ce navigateur s'applique à la prochaine connexion)",
    scKeepOneType: "Conservez au moins un type",
    scDaysInvalid: "La conservation doit être 1–3650",
    scApiInvalid: "L'adresse doit être une URL http/https complète, ou vide",
    scTtlRange: "La durée doit être 5–43200 minutes (30 jours)",
    scCloseConfirm: "Des modifications non enregistrées seront perdues. Fermer quand même ?",
    scSwitchConfirm: "Des modifications non enregistrées seront abandonnées. Continuer ?",
    nfWebhook: "URL du webhook",
    nfSecret: "Secret de signature",
    nfSendkey: "SendKey",
    nfToken: "Jeton / clé",
    nfBotToken: "Jeton du bot",
    nfChatId: "ID de discussion",
    nfDeviceKey: "Clé de l'appareil",
    nfUrl: "URL du service",
    nfApiKey: "Clé d'API",
    nfMailTo: "Destinataire",
    nfMailFrom: "Expéditeur",
    nfUrls: "URL du webhook",
    nfTemplate: "Modèle de corps",
    nfHeaders: "En-têtes personnalisés"
    },
    "de": {
    scMenuCenter: "Einstellungszentrum",
    scMenuTtl: "Anmeldedauer",
    scGrpAccess: "Zugriff",
    scMenuTokens: "Zugriffstoken",
    scTitle: "Einstellungszentrum",
    scDirty: "Ungespeichert",
    scTabSession: "Anmeldung & Sitzung",
    scTabNotify: "Benachrichtigungen",
    scTabBiz: "Daten & Betrieb",
    scTabSec: "Sicherheit",
    scReset: "Standard wiederherstellen",
    scScopeGlobal: "Global",
    scScopeBrowser: "Dieser Browser",
    scSessionBrowser: "Anmeldedauer (dieser Browser)",
    scSessionGlobal: "Anmeldedauer (globaler Standard)",
    scTtl: "Dauer",
    scTtlGlobal: "Standarddauer",
    scFollowGlobal: "Globalem Standard folgen (diesen Browser zurücksetzen)",
    scCustom: "Individuelle Minuten…",
    scEffLocal: "Dieser Browser: {v} (eigener Wert, folgt nicht global)",
    scEffGlobal: "Dieser Browser: folgt globalem Standard ({v})",
    scHelpLocal: "Wirkt nur auf <b>neue Anmeldungen in diesem Browser</b>. Der serverseitige globale Standard bleibt unverändert, andere Browser sind nicht betroffen; bereits ausgestellte Sitzungen behalten ihr Ablaufdatum. Mit \"Globalem Standard folgen\" wird diese Browsereinstellung gelöscht.",
    scHelpGlobal: "Wird verwendet, wenn ein Browser keinen eigenen Wert hat, und als Rückfall für alte Clients ohne Dauerangabe. Bereich 5–43200 Minuten; Änderungen gelten nur für neue Anmeldungen.",
    scMin30: "30 Minuten",
    scHour1: "1 Stunde",
    scHour8: "8 Stunden",
    scHour24: "24 Stunden",
    scDay7: "7 Tage",
    scDay30: "30 Tage",
    scNotifyRules: "Benachrichtigungsregeln",
    scNotifyHelp: "Wird in der Datenbank gespeichert und sofort wirksam. Sensible Felder liegen nur serverseitig; die Seite zeigt nur, ob sie konfiguriert sind. Leer lassen ändert nichts; \"Löschen\" entfernt den Wert.",
    scNotifyEnabled: "Benachrichtigungen aktiv",
    scNotifyTypes: "Weitergeleitete Typen",
    scTypeVerify: "Bestätigungscodes",
    scTypeSms: "SMS",
    scTypeNotify: "Benachrichtigungen",
    scRetry: "Wiederholen bei Fehler",
    scNoRetry: "Kein Wiederholen",
    scRetryN: "{n} Mal",
    scRetryHelp: "Maximale Wiederholungen nach Fehlschlag",
    scLink: "Aktionslink",
    scLinkPh: "https://… (optional, an Benachrichtigung angehängt)",
    scConfigured: "Konfiguriert",
    scNotConfigured: "Nicht konfiguriert",
    scFromDb: "Datenbank",
    scFromEnv: "Umgebungsvariable",
    scEnable: "Aktiv",
    scTest: "Testen",
    scSendTest: "Testbenachrichtigung senden",
    scTestSaved: "Testbenachrichtigungen nutzen die <b>gespeicherte</b> Konfiguration: erst speichern, dann testen.",
    scTestOk: "Testbenachrichtigung gesendet",
    scTestNotCfg: "Dieser Kanal ist noch nicht konfiguriert – zuerst Zugangsdaten speichern",
    scTestFail: "Senden fehlgeschlagen",
    scTestFailMsg: "Senden fehlgeschlagen: {m}",
    scImportEnv: "Aus Umgebungsvariablen importieren",
    scImported: "{n} Einstellungen importiert",
    scNoImport: "Keine importierbaren Einstellungen",
    scImportFail: "Import fehlgeschlagen",
    scImportFailMsg: "Import fehlgeschlagen: {e}",
    scSensitivePhCfg: "Konfiguriert {m} (leer lassen = unverändert)",
    scSensitivePhNew: "Nicht konfiguriert – eingeben und speichern",
    scClear: "Löschen",
    scRetention: "Nachrichtenaufbewahrung",
    scDays: "Aufbewahrungstage",
    scDaysHelp: "Die geplante Bereinigung löscht ältere Nachrichten, Bereich 1–3650 Tage. Verringern beschleunigt das Löschen und ist nicht umkehrbar.",
    scArea: "Nummernstandort",
    scAreaEnable: "Abfrage aktivieren",
    scAreaApi: "API-Adresse",
    scAreaApiPh: "Leer = integrierte kostenlose API",
    scAreaHelp: "Ein eigener Endpunkt muss den Platzhalter {number} unterstützen (http/https). Deaktiviert zeigt die Liste keinen Standort. Leer = integrierte kostenlose API.",
    scTokenTitle: "Zugriffstoken",
    scTokenHelp: "Aufnahme-Clients authentifizieren sich per Token. Benannte Tokens lassen sich je Quelle anlegen, rotieren und widerrufen; ein Widerruf wirkt sofort.",
    scManage: "Verwalten",
    scOpenTokens: "Token-Verwaltung öffnen",
    scTokenAlert: "Der Token im Klartext wird nur beim Anlegen einmal angezeigt; diese Seite liest oder zeigt keine Tokenwerte.",
    scLoginGuard: "Anmeldeschutz",
    scLoginGuardHelp: "10 Minuten gesperrt nach 5 falschen Passwörtern. Sitzungen sind signierte zustandslose Token; Abmelden löscht nur das Browser-Cookie. Diese Regeln kommen aus der Deployment-Konfiguration.",
    scResetSession: "diesen Browser zurücksetzen und global auf 30 Minuten stellen",
    scResetNotify: "Benachrichtigungen aktiv, alle Typen, 0 Wiederholungen, Link leeren (Zugangsdaten unverändert)",
    scResetBiz: "Aufbewahrung 30 Tage, Standortabfrage an, Endpunkt leeren",
    scResetConfirm: "Standard wiederherstellen: {what}. Erst mit Speichern wird geschrieben. Fortfahren?",
    scResetNoDefault: "Diese Gruppe hat keine Standardwerte",
    scResetFilled: "Standardwerte gesetzt – mit Speichern übernehmen",
    scCancelDone: "Auf zuletzt gespeicherte Werte zurückgesetzt",
    scNoChanges: "Keine Änderungen zu speichern",
    scNoSave: "Diese Gruppe muss nicht gespeichert werden",
    scReadFail: "Einstellungen konnten nicht geladen werden",
    scSaveFail: "Speichern fehlgeschlagen",
    scSaveFailMsg: "Speichern fehlgeschlagen: {e}",
    scRevisionConflict: "Einstellungen wurden in einer anderen Sitzung geändert – schließen und neu öffnen",
    scSavedTtl: "Gespeichert (gilt ab der nächsten Anmeldung)",
    scSavedTtlGlobal: "Gespeichert (Browsergauer gilt ab der nächsten Anmeldung)",
    scKeepOneType: "Mindestens einen Typ behalten",
    scDaysInvalid: "Aufbewahrung muss 1–3650 sein",
    scApiInvalid: "Die Adresse muss eine vollständige http/https-URL sein oder leer bleiben",
    scTtlRange: "Dauer muss 5–43200 Minuten sein (30 Tage)",
    scCloseConfirm: "Ungespeicherte Änderungen gehen verloren. Trotzdem schließen?",
    scSwitchConfirm: "Nicht gespeicherte Änderungen werden verworfen. Fortfahren?",
    nfWebhook: "Webhook-URL",
    nfSecret: "Signaturgeheimnis",
    nfSendkey: "SendKey",
    nfToken: "Token / Schlüssel",
    nfBotToken: "Bot-Token",
    nfChatId: "Chat-ID",
    nfDeviceKey: "Geräteschlüssel",
    nfUrl: "Dienst-URL",
    nfApiKey: "API-Schlüssel",
    nfMailTo: "Empfänger",
    nfMailFrom: "Absender",
    nfUrls: "Webhook-URL",
    nfTemplate: "Anfrage-Body-Vorlage",
    nfHeaders: "Eigene Header"
    },
    "pt-BR": {
    scMenuCenter: "Central de configurações",
    scMenuTtl: "Validade da sessão",
    scGrpAccess: "Acesso",
    scMenuTokens: "Tokens de acesso",
    scTitle: "Central de configurações",
    scDirty: "Não salvo",
    scTabSession: "Login e sessão",
    scTabNotify: "Notificações",
    scTabBiz: "Dados e operação",
    scTabSec: "Segurança",
    scReset: "Restaurar padrões",
    scScopeGlobal: "Global",
    scScopeBrowser: "Este navegador",
    scSessionBrowser: "Validade da sessão (este navegador)",
    scSessionGlobal: "Validade da sessão (padrão global)",
    scTtl: "Duração",
    scTtlGlobal: "Duração padrão",
    scFollowGlobal: "Seguir o padrão global (limpar este navegador)",
    scCustom: "Minutos personalizados…",
    scEffLocal: "Este navegador: {v} (ajuste próprio, não segue o global)",
    scEffGlobal: "Este navegador: seguindo o padrão global ({v})",
    scHelpLocal: "Afeta apenas <b>novos logins neste navegador</b>. Não altera o padrão global do servidor nem afeta outros navegadores; sessões já emitidas mantêm a expiração. Escolha \"Seguir o padrão global\" para limpar este ajuste.",
    scHelpGlobal: "Usado quando um navegador não tem ajuste próprio e como fallback para clientes antigos sem duração. Faixa 5–43200 minutos; mudanças afetam apenas novos logins.",
    scMin30: "30 minutos",
    scHour1: "1 hora",
    scHour8: "8 horas",
    scHour24: "24 horas",
    scDay7: "7 dias",
    scDay30: "30 dias",
    scNotifyRules: "Regras de notificação",
    scNotifyHelp: "Salvo no banco e aplicado na hora. Campos sensíveis ficam só no servidor; a página mostra apenas se estão configurados. Deixar vazio não altera; marque \"Limpar\" para excluir.",
    scNotifyEnabled: "Notificações ativas",
    scNotifyTypes: "Tipos encaminhados",
    scTypeVerify: "Códigos de verificação",
    scTypeSms: "SMS",
    scTypeNotify: "Notificações",
    scRetry: "Repetir em falha",
    scNoRetry: "Sem repetição",
    scRetryN: "{n} vezes",
    scRetryHelp: "Máximo de repetições após falha",
    scLink: "Link de ação",
    scLinkPh: "https://… (opcional, anexado à notificação)",
    scConfigured: "Configurado",
    scNotConfigured: "Não configurado",
    scFromDb: "Banco de dados",
    scFromEnv: "Variável de ambiente",
    scEnable: "Ativo",
    scTest: "Testar",
    scSendTest: "Enviar notificação de teste",
    scTestSaved: "O teste usa a configuração <b>salva</b>: salve antes de testar.",
    scTestOk: "Notificação de teste enviada",
    scTestNotCfg: "Este canal ainda não está configurado: salve as credenciais",
    scTestFail: "Falha ao enviar",
    scTestFailMsg: "Falha ao enviar: {m}",
    scImportEnv: "Importar das variáveis de ambiente",
    scImported: "{n} ajustes importados",
    scNoImport: "Nenhum ajuste importável",
    scImportFail: "Falha ao importar",
    scImportFailMsg: "Falha ao importar: {e}",
    scSensitivePhCfg: "Configurado {m} (vazio mantém)",
    scSensitivePhNew: "Não configurado — insira e salve",
    scClear: "Limpar",
    scRetention: "Retenção de mensagens",
    scDays: "Dias de retenção",
    scDaysHelp: "A limpeza agendada apaga mensagens mais antigas, faixa 1–3650 dias. Reduzir acelera e não pode ser desfeito.",
    scArea: "Localização do número",
    scAreaEnable: "Ativar consulta",
    scAreaApi: "Endereço da API",
    scAreaApiPh: "Vazio = API gratuita integrada",
    scAreaHelp: "Um endpoint próprio deve aceitar o marcador {number} (http/https). Desativado, a lista não mostra localização. Vazio = API gratuita integrada.",
    scTokenTitle: "Tokens de acesso",
    scTokenHelp: "Clientes de ingestão autenticam por token. Tokens nomeados podem ser criados, rotacionados e revogados por origem; a revogação é imediata.",
    scManage: "Gerenciar",
    scOpenTokens: "Abrir gerenciador de tokens",
    scTokenAlert: "O token em texto claro aparece só na criação; esta página não lê nem exibe tokens.",
    scLoginGuard: "Proteção de login",
    scLoginGuardHelp: "Bloqueio de 10 minutos após 5 senhas erradas. Sessões são tokens assinados sem estado; sair apenas limpa o cookie. Essas regras vêm da configuração de implantação.",
    scResetSession: "limpar este navegador e redefinir o global para 30 minutos",
    scResetNotify: "reativar notificações, todos os tipos, 0 repetição, link vazio (credenciais intactas)",
    scResetBiz: "retenção 30 dias, consulta ativa, endpoint limpo",
    scResetConfirm: "Restaurar padrões: {what}. Nada é gravado até salvar. Continuar?",
    scResetNoDefault: "Este grupo não tem padrões",
    scResetFilled: "Padrões preenchidos — clique em Salvar",
    scCancelDone: "Restaurado para os últimos valores salvos",
    scNoChanges: "Nada a salvar",
    scNoSave: "Este grupo não precisa salvar",
    scReadFail: "Falha ao carregar ajustes",
    scSaveFail: "Falha ao salvar",
    scSaveFailMsg: "Falha ao salvar: {e}",
    scRevisionConflict: "Ajustes alterados em outra sessão: feche e reabra antes de salvar",
    scSavedTtl: "Salvo (vale no próximo login)",
    scSavedTtlGlobal: "Salvo (a duração deste navegador vale no próximo login)",
    scKeepOneType: "Mantenha ao menos um tipo",
    scDaysInvalid: "A retenção deve ser 1–3650",
    scApiInvalid: "O endpoint deve ser uma URL http/https completa ou vazio",
    scTtlRange: "A duração deve ser 5–43200 minutos (30 dias)",
    scCloseConfirm: "Há alterações não salvas que serão perdidas. Fechar mesmo assim?",
    scSwitchConfirm: "Este grupo tem alterações não salvas que serão descartadas. Continuar?",
    nfWebhook: "URL do webhook",
    nfSecret: "Segredo de assinatura",
    nfSendkey: "SendKey",
    nfToken: "Token / chave",
    nfBotToken: "Token do bot",
    nfChatId: "ID do chat",
    nfDeviceKey: "Chave do dispositivo",
    nfUrl: "URL do serviço",
    nfApiKey: "Chave de API",
    nfMailTo: "Destinatário",
    nfMailFrom: "Remetente",
    nfUrls: "URL do webhook",
    nfTemplate: "Modelo do corpo",
    nfHeaders: "Cabeçalhos personalizados"
    }
  };
  (function () {
    for (var _l in SC_I18N) {
      if (!I18N[_l]) I18N[_l] = {};
      for (var _k in SC_I18N[_l]) I18N[_l][_k] = SC_I18N[_l][_k];
    }
  })();
  /* 消息列表新增文案（九语种）；与 SC_I18N 同样以独立表合并，不改既有字典结构 */
  var MSG_I18N = {
    "zh-CN": {
    detailBtn: "查看详情",
    detailTip: "点击查看完整内容",
    detailFail: "无法打开消息详情",
    readFail: "标记已读失败"
    },
    "zh-TW": {
    detailBtn: "查看詳情",
    detailTip: "點擊查看完整內容",
    detailFail: "無法開啟訊息詳情",
    readFail: "標記已讀失敗"
    },
    "en": {
    detailBtn: "Details",
    detailTip: "Tap to view the full message",
    detailFail: "Could not open the message",
    readFail: "Failed to mark as read"
    },
    "ja": {
    detailBtn: "詳細",
    detailTip: "タップして全文を表示",
    detailFail: "メッセージを開けませんでした",
    readFail: "既読の更新に失敗しました"
    },
    "ko": {
    detailBtn: "상세 보기",
    detailTip: "탭하여 전체 보기",
    detailFail: "메시지를 열 수 없습니다",
    readFail: "읽음 표시 실패"
    },
    "es": {
    detailBtn: "Ver detalles",
    detailTip: "Toca para ver el mensaje completo",
    detailFail: "No se pudo abrir el mensaje",
    readFail: "No se pudo marcar como leído"
    },
    "fr": {
    detailBtn: "Voir le détail",
    detailTip: "Touchez pour voir le message complet",
    detailFail: "Impossible d'ouvrir le message",
    readFail: "Échec du marquage comme lu"
    },
    "de": {
    detailBtn: "Details",
    detailTip: "Tippen für die vollständige Nachricht",
    detailFail: "Nachricht konnte nicht geöffnet werden",
    readFail: "Als gelesen markieren fehlgeschlagen"
    },
    "pt-BR": {
    detailBtn: "Ver detalhes",
    detailTip: "Toque para ver a mensagem completa",
    detailFail: "Não foi possível abrir a mensagem",
    readFail: "Falha ao marcar como lida"
    }
  };
  (function () {
    for (var _ml in MSG_I18N) {
      if (!I18N[_ml]) I18N[_ml] = {};
      for (var _mk in MSG_I18N[_ml]) I18N[_ml][_mk] = MSG_I18N[_ml][_mk];
    }
  })();
  /* 消息列表/详情新增文案（九语种） */
  var UI2_I18N = {
    "zh-CN": {
    markRead: "标记已读",
    markReadSelected: "批量已读",
    bulkHint: "批量操作只作用于当前列表",
    bulkOk: "已标记 {n} 条为已读",
    bulkPartial: "成功 {ok} 条，失败 {ng} 条",
    bulkFail: "批量操作失败",
    dType: "消息类型",
    dCarrier: "运营商",
    dSender: "发送号码",
    detailInfo: "消息信息",
    detailActions: "操作",
    copyBody: "复制正文",
    emptyBody: "（无正文）"
    },
    "zh-TW": {
    markRead: "標記已讀",
    markReadSelected: "批次已讀",
    bulkHint: "批次操作只作用於目前清單",
    bulkOk: "已標記 {n} 條為已讀",
    bulkPartial: "成功 {ok} 條，失敗 {ng} 條",
    bulkFail: "批次操作失敗",
    dType: "訊息類型",
    dCarrier: "電信業者",
    dSender: "發送號碼",
    detailInfo: "訊息資訊",
    detailActions: "操作",
    copyBody: "複製內文",
    emptyBody: "（無內文）"
    },
    "en": {
    markRead: "Mark read",
    markReadSelected: "Mark selected read",
    bulkHint: "Bulk actions apply to the current list only",
    bulkOk: "Marked {n} as read",
    bulkPartial: "{ok} succeeded, {ng} failed",
    bulkFail: "Bulk action failed",
    dType: "Message type",
    dCarrier: "Carrier",
    dSender: "Sender number",
    detailInfo: "Message details",
    detailActions: "Actions",
    copyBody: "Copy text",
    emptyBody: "(no content)"
    },
    "ja": {
    markRead: "既読にする",
    markReadSelected: "選択を既読",
    bulkHint: "一括操作は現在の一覧のみに適用",
    bulkOk: "{n} 件を既読にしました",
    bulkPartial: "{ok} 件成功、{ng} 件失敗",
    bulkFail: "一括操作に失敗しました",
    dType: "メッセージ種別",
    dCarrier: "通信事業者",
    dSender: "送信元番号",
    detailInfo: "メッセージ情報",
    detailActions: "操作",
    copyBody: "本文をコピー",
    emptyBody: "（本文なし）"
    },
    "ko": {
    markRead: "읽음 표시",
    markReadSelected: "선택 항목 읽음",
    bulkHint: "일괄 작업은 현재 목록에만 적용",
    bulkOk: "{n}개를 읽음으로 표시",
    bulkPartial: "{ok}개 성공, {ng}개 실패",
    bulkFail: "일괄 작업 실패",
    dType: "메시지 유형",
    dCarrier: "통신사",
    dSender: "발신 번호",
    detailInfo: "메시지 정보",
    detailActions: "작업",
    copyBody: "본문 복사",
    emptyBody: "(본문 없음)"
    },
    "es": {
    markRead: "Marcar leído",
    markReadSelected: "Marcar leídos",
    bulkHint: "Las acciones masivas solo afectan la lista actual",
    bulkOk: "{n} marcados como leídos",
    bulkPartial: "{ok} correctos, {ng} fallidos",
    bulkFail: "Error en la acción masiva",
    dType: "Tipo de mensaje",
    dCarrier: "Operador",
    dSender: "Número de origen",
    detailInfo: "Detalles del mensaje",
    detailActions: "Acciones",
    copyBody: "Copiar texto",
    emptyBody: "(sin contenido)"
    },
    "fr": {
    markRead: "Marquer comme lu",
    markReadSelected: "Marquer lus",
    bulkHint: "Les actions groupées ne concernent que la liste affichée",
    bulkOk: "{n} marqués comme lus",
    bulkPartial: "{ok} réussis, {ng} échoués",
    bulkFail: "Échec de l'action groupée",
    dType: "Type de message",
    dCarrier: "Opérateur",
    dSender: "Numéro d'envoi",
    detailInfo: "Détails du message",
    detailActions: "Actions",
    copyBody: "Copier le texte",
    emptyBody: "(aucun contenu)"
    },
    "de": {
    markRead: "Als gelesen",
    markReadSelected: "Auswahl als gelesen",
    bulkHint: "Massenaktionen gelten nur für die aktuelle Liste",
    bulkOk: "{n} als gelesen markiert",
    bulkPartial: "{ok} erfolgreich, {ng} fehlgeschlagen",
    bulkFail: "Massenaktion fehlgeschlagen",
    dType: "Nachrichtentyp",
    dCarrier: "Netzbetreiber",
    dSender: "Absendernummer",
    detailInfo: "Nachrichtendetails",
    detailActions: "Aktionen",
    copyBody: "Text kopieren",
    emptyBody: "(kein Inhalt)"
    },
    "pt-BR": {
    markRead: "Marcar como lida",
    markReadSelected: "Marcar lidas",
    bulkHint: "Ações em massa valem só para a lista atual",
    bulkOk: "{n} marcadas como lidas",
    bulkPartial: "{ok} com sucesso, {ng} com falha",
    bulkFail: "Falha na ação em massa",
    dType: "Tipo de mensagem",
    dCarrier: "Operadora",
    dSender: "Número de origem",
    detailInfo: "Detalhes da mensagem",
    detailActions: "Ações",
    copyBody: "Copiar texto",
    emptyBody: "(sem conteúdo)"
    }
  };
  (function () {
    for (var _u2l in UI2_I18N) {
      if (!I18N[_u2l]) I18N[_u2l] = {};
      for (var _u2k in UI2_I18N[_u2l]) I18N[_u2l][_u2k] = UI2_I18N[_u2l][_u2k];
    }
  })();
  /* 仪表盘新版界面文案（九语种） */
  var V2_I18N = {
    "zh-CN": {
      pageSub: "一驿过一驿，驿骑如星流",
      listTitle: "短信列表", refresh: "刷新", settingsOverview: "设置概览", openSettings: "打开设置中心",
      quickOverview: "快捷概览", viewStats: "查看统计", selectHint: "右键或长按消息可多选",
      selAllList: "选择当前列表", tagVerify: "验证码", allDevices: "全部设备",
      scLanguage: "界面语言", scLang: "语言", scLangHelp: "语言偏好保存在当前浏览器，保存后整页重新加载并应用；不影响其他浏览器。",
      scPageSize: "分页设置", scPerPage: "每页条数", scPageSizeHelp: "每页条数保存在当前浏览器，保存后立即生效。",
      scBrowserPrefs: "本浏览器偏好", scBrowserPrefsHelp: "消息开关与免打扰只影响当前浏览器，与全局通知规则互不影响。",
      scNotifyChannels: "通知渠道", scChannelsN: "已配置 {n} 个", scMinN: "{n} 分钟", scDaysN: "{n} 天", statToday: "今日接收",
      scTargetOff: "停用", scTargetRename: "重命名", scTargetLegacy: "该渠道已启用多目标，上面的单目标字段不再参与发送。",
      scAddTarget: "添加目标", scTargetNamePh: "推送名称（如 值班群）", scTargetAdded: "已添加目标，保存后生效",
      scTargetRemoved: "已移除目标，保存后生效", scTargetSaveFirst: "请先保存目标再发送测试", scMultiTarget: "多目标",
      copyFail: "复制失败，请手动选择", exportHint: "导出当前筛选结果",
      scAddPush: "添加推送", scPushList: "已配置推送",
      scPushListHelp: "这里只显示已创建好的推送；点击「编辑」可修改名称、配置与接收类型。",
      scPushEmpty: "还没有推送，点击「添加推送」创建第一条。",
      scPickChannel: "选择推送方案", scPickChannelHelp: "先选择推送方案，选中后再填写对应的配置信息。",
      scPushName: "推送名称", scPushEditor: "编辑推送", scPushTypes: "接收类型",
      scPushTypesHelp: "只接收勾选的类型，与全局规则同时生效（默认全部接收）。",
      scPushRulesHelp: "未填写的内容按「不修改」处理；已保存的敏感字段只显示脱敏结果。",
      scPushNameRequired: "请填写推送名称", scPushNeedTypes: "请至少选择一种接收类型",
      scPushFieldNeed: "请填写「{f}」", scPushAdded: "已添加推送，保存后生效", scPushUpdated: "已更新推送，保存后生效",
      scEdit: "编辑", scBack: "上一步", scEnvChannels: "其他已配置渠道",
      scEnvChannelsHelp: "这些渠道还没有单独的推送卡片，仍会按全局规则发送；可以在这里停用或测试。",
      scImportEnvHelp: "把部署环境里的通知配置复制到设置页，方便统一查看；已有的项不会覆盖，环境变量始终优先。"
    },
    "zh-TW": {
      pageSub: "一驛過一驛，驛騎如星流",
      listTitle: "簡訊列表", refresh: "重新整理", settingsOverview: "設定概覽", openSettings: "開啟設定中心",
      quickOverview: "快捷概覽", viewStats: "查看統計", selectHint: "右鍵或長按訊息可多選",
      selAllList: "選擇目前清單", tagVerify: "驗證碼", allDevices: "全部裝置",
      scLanguage: "介面語言", scLang: "語言", scLangHelp: "語言偏好儲存在目前瀏覽器，儲存後整頁重新載入並套用；不影響其他瀏覽器。",
      scPageSize: "分頁設定", scPerPage: "每頁筆數", scPageSizeHelp: "每頁筆數儲存在目前瀏覽器，儲存後立即生效。",
      scBrowserPrefs: "本瀏覽器偏好", scBrowserPrefsHelp: "訊息開關與免打擾只影響目前瀏覽器，與全域通知規則互不影響。",
      scNotifyChannels: "通知管道", scChannelsN: "已設定 {n} 個", scMinN: "{n} 分鐘", scDaysN: "{n} 天", statToday: "今日接收",
      scTargetOff: "停用", scTargetRename: "重新命名", scTargetLegacy: "此管道已啟用多目標，上方的單目標欄位不再參與傳送。",
      scAddTarget: "新增目標", scTargetNamePh: "推送名稱（例如 值班群）", scTargetAdded: "已新增目標，儲存後生效",
      scTargetRemoved: "已移除目標，儲存後生效", scTargetSaveFirst: "請先儲存目標再傳送測試", scMultiTarget: "多目標",
      copyFail: "複製失敗，請手動選取", exportHint: "匯出目前篩選結果",
      scAddPush: "新增推送", scPushList: "已設定的推送",
      scPushListHelp: "這裡只顯示已建立好的推送；點「編輯」可修改名稱、設定與接收類型。",
      scPushEmpty: "還沒有推送，點「新增推送」建立第一筆。",
      scPickChannel: "選擇推送方案", scPickChannelHelp: "先選擇推送方案，選取後再填寫對應的設定資訊。",
      scPushName: "推送名稱", scPushEditor: "編輯推送", scPushTypes: "接收類型",
      scPushTypesHelp: "只接收勾選的類型，與全域規則同時生效（預設全部接收）。",
      scPushRulesHelp: "未填寫的內容視為「不修改」；已儲存的機密欄位只顯示去識別化結果。",
      scPushNameRequired: "請填寫推送名稱", scPushNeedTypes: "請至少選擇一種接收類型",
      scPushFieldNeed: "請填寫「{f}」", scPushAdded: "已新增推送，儲存後生效", scPushUpdated: "已更新推送，儲存後生效",
      scEdit: "編輯", scBack: "上一步", scEnvChannels: "其他已設定管道",
      scEnvChannelsHelp: "這些管道還沒有獨立的推送卡片，仍會依全域規則傳送；可以在這裡停用或測試。",
      scImportEnvHelp: "把部署環境裡的通知設定複製到設定頁，方便統一檢視；既有的項目不會覆蓋，環境變數始終優先。"
    },
    en: {
      pageSub: "From post to post, like shooting stars.",
      listTitle: "Messages", refresh: "Refresh", settingsOverview: "Settings overview", openSettings: "Open settings",
      quickOverview: "Quick overview", viewStats: "View stats", selectHint: "Right-click or long-press a message to multi-select",
      selAllList: "Select current list", tagVerify: "Verification code", allDevices: "All devices",
      scLanguage: "Language", scLang: "Language", scLangHelp: "The language preference is stored in this browser and applied after saving with a full reload. Other browsers are unaffected.",
      scPageSize: "Pagination", scPerPage: "Items per page", scPageSizeHelp: "Page size is stored in this browser and takes effect immediately after saving.",
      scBrowserPrefs: "Browser preferences", scBrowserPrefsHelp: "Message toggles and quiet hours only affect this browser; global notification rules are unchanged.",
      scNotifyChannels: "Notification channels", scChannelsN: "{n} configured", scMinN: "{n} min", scDaysN: "{n} days", statToday: "Received today",
      scTargetOff: "Disable", scTargetRename: "Rename", scTargetLegacy: "Multiple targets are enabled; the single-target fields above are no longer used for sending.",
      scAddTarget: "Add target", scTargetNamePh: "Push name (e.g. on-call group)", scTargetAdded: "Target added; save to apply",
      scTargetRemoved: "Target removed; save to apply", scTargetSaveFirst: "Save the target before sending a test", scMultiTarget: "Multi-target",
      copyFail: "Copy failed. Please select it manually", exportHint: "Exports the current filter",
      scAddPush: "Add push", scPushList: "Configured pushes",
      scPushListHelp: "Only created pushes are listed. Click Edit to change the name, configuration or accepted types.",
      scPushEmpty: "No pushes yet. Click \"Add push\" to create one.",
      scPickChannel: "Choose a provider", scPickChannelHelp: "Pick a provider first; its configuration fields appear next.",
      scPushName: "Push name", scPushEditor: "Edit push", scPushTypes: "Accepted types",
      scPushTypesHelp: "Only ticked types are delivered, together with the global rules (all types by default).",
      scPushRulesHelp: "Leave a field empty to keep the current value; stored sensitive fields show a masked value only.",
      scPushNameRequired: "Enter a push name", scPushNeedTypes: "Select at least one accepted type",
      scPushFieldNeed: "Enter \"{f}\"", scPushAdded: "Push added; save to apply", scPushUpdated: "Push updated; save to apply",
      scEdit: "Edit", scBack: "Back", scEnvChannels: "Other configured channels",
      scEnvChannelsHelp: "These channels have no separate push card yet and still follow the global rules. You can disable or test them here.",
      scImportEnvHelp: "Copy notification settings from the deployment environment into this page for easier management. Existing items are not overwritten, and environment variables always take precedence."
    },
    ja: {
      pageSub: "駅から駅へ、星のように駆け流れる",
      listTitle: "メッセージ一覧", refresh: "更新", settingsOverview: "設定の概要", openSettings: "設定センターを開く",
      quickOverview: "クイック概要", viewStats: "統計を見る", selectHint: "右クリックまたは長押しで複数選択",
      selAllList: "現在の一覧を選択", tagVerify: "認証コード", allDevices: "すべての端末",
      scLanguage: "表示言語", scLang: "言語", scLangHelp: "言語設定はこのブラウザに保存され、保存後にページを再読み込みして適用されます。他のブラウザには影響しません。",
      scPageSize: "ページ設定", scPerPage: "1ページの件数", scPageSizeHelp: "1ページの件数はこのブラウザに保存され、保存後すぐに反映されます。",
      scBrowserPrefs: "このブラウザの設定", scBrowserPrefsHelp: "メッセージの切り替えと邪魔しない時間はこのブラウザのみに影響します。",
      scNotifyChannels: "通知チャネル", scChannelsN: "{n} 件設定済み", scMinN: "{n} 分", scDaysN: "{n} 日", statToday: "本日の受信",
      scTargetOff: "無効化", scTargetRename: "名前変更", scTargetLegacy: "このチャネルは複数ターゲットが有効です。上の単一ターゲット項目は送信に使用されません。",
      scAddTarget: "ターゲットを追加", scTargetNamePh: "プッシュ名（例：当番グループ）", scTargetAdded: "ターゲットを追加しました。保存後に有効になります",
      scTargetRemoved: "ターゲットを削除しました。保存後に有効になります", scTargetSaveFirst: "テスト送信の前にターゲットを保存してください", scMultiTarget: "複数ターゲット",
      copyFail: "コピーに失敗しました。手動で選択してください", exportHint: "現在の絞り込み結果を出力",
      scAddPush: "プッシュを追加", scPushList: "設定済みプッシュ",
      scPushListHelp: "作成済みのプッシュのみ表示します。「編集」から名前・設定・受信タイプを変更できます。",
      scPushEmpty: "プッシュはまだありません。「プッシュを追加」から作成してください。",
      scPickChannel: "プッシュ方法を選択", scPickChannelHelp: "先に方法を選択すると、対応する設定項目が表示されます。",
      scPushName: "プッシュ名", scPushEditor: "プッシュを編集", scPushTypes: "受信タイプ",
      scPushTypesHelp: "チェックしたタイプのみ受信します。全体ルールと併用されます（既定はすべて）。",
      scPushRulesHelp: "空欄は「変更なし」として扱われ、保存済みの機密項目は伏字のみ表示します。",
      scPushNameRequired: "プッシュ名を入力してください", scPushNeedTypes: "受信タイプを1つ以上選択してください",
      scPushFieldNeed: "「{f}」を入力してください", scPushAdded: "プッシュを追加しました。保存後に有効になります", scPushUpdated: "プッシュを更新しました。保存後に有効になります",
      scEdit: "編集", scBack: "戻る", scEnvChannels: "その他の設定済みチャネル",
      scEnvChannelsHelp: "これらのチャネルはまだ個別のプッシュカードがなく、全体ルールに従って送信されます。ここで無効化やテストができます。",
      scImportEnvHelp: "デプロイ環境の通知設定をこのページにコピーして管理しやすくします。既存の項目は上書きされず、環境変数が常に優先されます。"
    },
    ko: {
      pageSub: "역에서 역으로, 별처럼 흐르는 발걸음",
      listTitle: "메시지 목록", refresh: "새로고침", settingsOverview: "설정 개요", openSettings: "설정 센터 열기",
      quickOverview: "빠른 개요", viewStats: "통계 보기", selectHint: "마우스 오른쪽 버튼 또는 길게 눌러 여러 개 선택",
      selAllList: "현재 목록 선택", tagVerify: "인증 코드", allDevices: "모든 기기",
      scLanguage: "표시 언어", scLang: "언어", scLangHelp: "언어 설정은 이 브라우저에 저장되며 저장 후 페이지가 새로고침되어 적용됩니다. 다른 브라우저에는 영향이 없습니다.",
      scPageSize: "페이지 설정", scPerPage: "페이지당 항목 수", scPageSizeHelp: "페이지당 항목 수는 이 브라우저에 저장되며 저장 후 즉시 적용됩니다.",
      scBrowserPrefs: "이 브라우저 설정", scBrowserPrefsHelp: "메시지 스위치와 방해 금지 시간은 이 브라우저에만 적용됩니다.",
      scNotifyChannels: "알림 채널", scChannelsN: "{n}개 설정됨", scMinN: "{n}분", scDaysN: "{n}일", statToday: "오늘 수신",
      scTargetOff: "사용 안 함", scTargetRename: "이름 변경", scTargetLegacy: "이 채널은 다중 대상이 활성화되어 위의 단일 대상 필드는 전송에 사용되지 않습니다.",
      scAddTarget: "대상 추가", scTargetNamePh: "푸시 이름(예: 당직 그룹)", scTargetAdded: "대상이 추가되었습니다. 저장 후 적용됩니다",
      scTargetRemoved: "대상이 제거되었습니다. 저장 후 적용됩니다", scTargetSaveFirst: "테스트 전에 대상을 저장하세요", scMultiTarget: "다중 대상",
      copyFail: "복사에 실패했습니다. 직접 선택하세요", exportHint: "현재 필터 결과를 내보냅니다",
      scAddPush: "푸시 추가", scPushList: "설정된 푸시",
      scPushListHelp: "생성된 푸시만 표시합니다. [편집]에서 이름, 설정, 수신 유형을 변경할 수 있습니다.",
      scPushEmpty: "아직 푸시가 없습니다. [푸시 추가]로 첫 번째 푸시를 만드세요.",
      scPickChannel: "푸시 방식 선택", scPickChannelHelp: "먼저 방식을 선택하면 해당 설정 항목이 표시됩니다.",
      scPushName: "푸시 이름", scPushEditor: "푸시 편집", scPushTypes: "수신 유형",
      scPushTypesHelp: "선택한 유형만 수신하며 전역 규칙과 함께 적용됩니다(기본값 전체).",
      scPushRulesHelp: "빈 항목은 변경하지 않음으로 처리되며, 저장된 민감 항목은 마스킹된 값만 표시됩니다.",
      scPushNameRequired: "푸시 이름을 입력하세요", scPushNeedTypes: "수신 유형을 하나 이상 선택하세요",
      scPushFieldNeed: "「{f}」을(를) 입력하세요", scPushAdded: "푸시가 추가되었습니다. 저장 후 적용됩니다", scPushUpdated: "푸시가 업데이트되었습니다. 저장 후 적용됩니다",
      scEdit: "편집", scBack: "이전", scEnvChannels: "기타 설정된 채널",
      scEnvChannelsHelp: "이 채널들은 아직 개별 푸시 카드가 없으며 전역 규칙에 따라 전송됩니다. 여기서 비활성화하거나 테스트할 수 있습니다.",
      scImportEnvHelp: "배포 환경의 알림 설정을 이 페이지로 복사해 관리하기 쉽게 합니다. 기존 항목은 덮어쓰지 않으며 환경 변수가 항상 우선합니다."
    },
    es: {
      pageSub: "De posta en posta, como estrellas fugaces.",
      listTitle: "Mensajes", refresh: "Actualizar", settingsOverview: "Resumen de ajustes", openSettings: "Abrir ajustes",
      quickOverview: "Resumen rápido", viewStats: "Ver estadísticas", selectHint: "Clic derecho o pulsación larga para seleccionar varios",
      selAllList: "Seleccionar lista actual", tagVerify: "Código de verificación", allDevices: "Todos los dispositivos",
      scLanguage: "Idioma", scLang: "Idioma", scLangHelp: "La preferencia de idioma se guarda en este navegador y se aplica tras guardar con una recarga completa. Otros navegadores no se ven afectados.",
      scPageSize: "Paginación", scPerPage: "Elementos por página", scPageSizeHelp: "El tamaño de página se guarda en este navegador y se aplica de inmediato al guardar.",
      scBrowserPrefs: "Preferencias del navegador", scBrowserPrefsHelp: "Los interruptores de mensajes y el horario de silencio solo afectan a este navegador.",
      scNotifyChannels: "Canales de notificación", scChannelsN: "{n} configurados", scMinN: "{n} min", scDaysN: "{n} días", statToday: "Recibidos hoy",
      scTargetOff: "Desactivar", scTargetRename: "Renombrar", scTargetLegacy: "Este canal tiene varios destinos; los campos de destino único de arriba ya no se usan para enviar.",
      scAddTarget: "Añadir destino", scTargetNamePh: "Nombre del envío (p. ej. grupo de guardia)", scTargetAdded: "Destino añadido; guarda para aplicar",
      scTargetRemoved: "Destino eliminado; guarda para aplicar", scTargetSaveFirst: "Guarda el destino antes de enviar una prueba", scMultiTarget: "Multi-destino",
      copyFail: "Error al copiar. Selecciónalo manualmente", exportHint: "Exporta el filtro actual",
      scAddPush: "Añadir envío", scPushList: "Envíos configurados",
      scPushListHelp: "Solo se muestran los envíos creados. Pulsa Editar para cambiar el nombre, la configuración o los tipos aceptados.",
      scPushEmpty: "Aún no hay envíos. Pulsa «Añadir envío» para crear el primero.",
      scPickChannel: "Elige el método de envío", scPickChannelHelp: "Elige primero un método; después aparecerán sus campos de configuración.",
      scPushName: "Nombre del envío", scPushEditor: "Editar envío", scPushTypes: "Tipos aceptados",
      scPushTypesHelp: "Solo se envían los tipos marcados, junto con las reglas globales (todos por defecto).",
      scPushRulesHelp: "Dejar un campo vacío no lo modifica; los campos sensibles guardados solo muestran un valor enmascarado.",
      scPushNameRequired: "Escribe un nombre para el envío", scPushNeedTypes: "Selecciona al menos un tipo",
      scPushFieldNeed: "Escribe «{f}»", scPushAdded: "Envío añadido; guarda para aplicar", scPushUpdated: "Envío actualizado; guarda para aplicar",
      scEdit: "Editar", scBack: "Atrás", scEnvChannels: "Otros canales configurados",
      scEnvChannelsHelp: "Estos canales aún no tienen una tarjeta de envío propia y siguen las reglas globales. Puedes desactivarlos o probarlos aquí.",
      scImportEnvHelp: "Copia la configuración de notificaciones del entorno de despliegue en esta página para gestionarla mejor. Lo existente no se sobrescribe y las variables de entorno siempre tienen prioridad."
    },
    fr: {
      pageSub: "De relais en relais, comme un torrent d'étoiles.",
      listTitle: "Messages", refresh: "Actualiser", settingsOverview: "Aperçu des réglages", openSettings: "Ouvrir les réglages",
      quickOverview: "Aperçu rapide", viewStats: "Voir les statistiques", selectHint: "Clic droit ou appui long pour sélectionner plusieurs messages",
      selAllList: "Sélectionner la liste actuelle", tagVerify: "Code de vérification", allDevices: "Tous les appareils",
      scLanguage: "Langue", scLang: "Langue", scLangHelp: "La langue est enregistrée dans ce navigateur et appliquée après un rechargement complet. Les autres navigateurs ne sont pas affectés.",
      scPageSize: "Pagination", scPerPage: "Éléments par page", scPageSizeHelp: "La taille de page est enregistrée dans ce navigateur et s'applique immédiatement après l'enregistrement.",
      scBrowserPrefs: "Préférences du navigateur", scBrowserPrefsHelp: "Les interrupteurs de messages et les heures calmes n'affectent que ce navigateur.",
      scNotifyChannels: "Canaux de notification", scChannelsN: "{n} configurés", scMinN: "{n} min", scDaysN: "{n} jours", statToday: "Reçus aujourd'hui",
      scTargetOff: "Désactiver", scTargetRename: "Renommer", scTargetLegacy: "Ce canal utilise plusieurs cibles ; les champs de cible unique ci-dessus ne servent plus à l'envoi.",
      scAddTarget: "Ajouter une cible", scTargetNamePh: "Nom de l'envoi (ex. groupe d'astreinte)", scTargetAdded: "Cible ajoutée ; enregistrez pour appliquer",
      scTargetRemoved: "Cible supprimée ; enregistrez pour appliquer", scTargetSaveFirst: "Enregistrez la cible avant d'envoyer un test", scMultiTarget: "Multi-cible",
      copyFail: "Échec de la copie. Sélectionnez-le manuellement", exportHint: "Exporte le filtre actuel",
      scAddPush: "Ajouter un envoi", scPushList: "Envois configurés",
      scPushListHelp: "Seuls les envois créés sont affichés. Cliquez sur Modifier pour changer le nom, la configuration ou les types acceptés.",
      scPushEmpty: "Aucun envoi pour l'instant. Cliquez sur « Ajouter un envoi » pour créer le premier.",
      scPickChannel: "Choisir le moyen d'envoi", scPickChannelHelp: "Choisissez d'abord un moyen ; ses champs de configuration apparaîtront ensuite.",
      scPushName: "Nom de l'envoi", scPushEditor: "Modifier l'envoi", scPushTypes: "Types acceptés",
      scPushTypesHelp: "Seuls les types cochés sont envoyés, avec les règles globales (tous par défaut).",
      scPushRulesHelp: "Laisser un champ vide ne le modifie pas ; les champs sensibles enregistrés n'affichent qu'une valeur masquée.",
      scPushNameRequired: "Saisissez un nom d'envoi", scPushNeedTypes: "Sélectionnez au moins un type",
      scPushFieldNeed: "Saisissez « {f} »", scPushAdded: "Envoi ajouté ; enregistrez pour appliquer", scPushUpdated: "Envoi mis à jour ; enregistrez pour appliquer",
      scEdit: "Modifier", scBack: "Retour", scEnvChannels: "Autres canaux configurés",
      scEnvChannelsHelp: "Ces canaux n'ont pas encore de carte d'envoi dédiée et suivent les règles globales. Vous pouvez les désactiver ou les tester ici.",
      scImportEnvHelp: "Copiez la configuration de notification de l'environnement de déploiement dans cette page pour la gérer plus facilement. L'existant n'est pas écrasé et les variables d'environnement restent prioritaires."
    },
    de: {
      pageSub: "Von Station zu Station, wie ein Sternenstrom.",
      listTitle: "Nachrichten", refresh: "Aktualisieren", settingsOverview: "Einstellungsübersicht", openSettings: "Einstellungen öffnen",
      quickOverview: "Kurzübersicht", viewStats: "Statistik ansehen", selectHint: "Rechtsklick oder langes Drücken für Mehrfachauswahl",
      selAllList: "Aktuelle Liste auswählen", tagVerify: "Bestätigungscode", allDevices: "Alle Geräte",
      scLanguage: "Sprache", scLang: "Sprache", scLangHelp: "Die Sprache wird in diesem Browser gespeichert und nach dem Speichern mit vollständigem Neuladen angewendet. Andere Browser sind nicht betroffen.",
      scPageSize: "Seitengröße", scPerPage: "Einträge pro Seite", scPageSizeHelp: "Die Seitengröße wird in diesem Browser gespeichert und nach dem Speichern sofort angewendet.",
      scBrowserPrefs: "Browser-Einstellungen", scBrowserPrefsHelp: "Nachrichtenschalter und Ruhezeiten gelten nur für diesen Browser.",
      scNotifyChannels: "Benachrichtigungskanäle", scChannelsN: "{n} konfiguriert", scMinN: "{n} Min.", scDaysN: "{n} Tage", statToday: "Heute erhalten",
      scTargetOff: "Deaktivieren", scTargetRename: "Umbenennen", scTargetLegacy: "Für diesen Kanal sind mehrere Ziele aktiv; die Einzelziel-Felder oben werden nicht mehr zum Senden verwendet.",
      scAddTarget: "Ziel hinzufügen", scTargetNamePh: "Push-Name (z. B. Bereitschaftsgruppe)", scTargetAdded: "Ziel hinzugefügt; zum Anwenden speichern",
      scTargetRemoved: "Ziel entfernt; zum Anwenden speichern", scTargetSaveFirst: "Ziel vor dem Testen speichern", scMultiTarget: "Mehrere Ziele",
      copyFail: "Kopieren fehlgeschlagen. Bitte manuell markieren", exportHint: "Exportiert den aktuellen Filter",
      scAddPush: "Push hinzufügen", scPushList: "Konfigurierte Pushes",
      scPushListHelp: "Nur erstellte Pushes werden angezeigt. Über Bearbeiten lassen sich Name, Konfiguration und akzeptierte Typen ändern.",
      scPushEmpty: "Noch keine Pushes. Klicke auf „Push hinzufügen“, um den ersten zu erstellen.",
      scPickChannel: "Versandart wählen", scPickChannelHelp: "Wähle zuerst eine Versandart; danach erscheinen die passenden Konfigurationsfelder.",
      scPushName: "Push-Name", scPushEditor: "Push bearbeiten", scPushTypes: "Akzeptierte Typen",
      scPushTypesHelp: "Nur angehakte Typen werden zugestellt, zusammen mit den globalen Regeln (standardmäßig alle).",
      scPushRulesHelp: "Ein leeres Feld bleibt unverändert; gespeicherte sensible Felder zeigen nur einen maskierten Wert.",
      scPushNameRequired: "Bitte einen Push-Namen eingeben", scPushNeedTypes: "Mindestens einen Typ auswählen",
      scPushFieldNeed: "„{f}“ eingeben", scPushAdded: "Push hinzugefügt; zum Anwenden speichern", scPushUpdated: "Push aktualisiert; zum Anwenden speichern",
      scEdit: "Bearbeiten", scBack: "Zurück", scEnvChannels: "Weitere konfigurierte Kanäle",
      scEnvChannelsHelp: "Diese Kanäle haben noch keine eigene Push-Karte und folgen den globalen Regeln. Hier kannst du sie deaktivieren oder testen.",
      scImportEnvHelp: "Kopiert die Benachrichtigungseinstellungen aus der Bereitstellungsumgebung auf diese Seite zur einfacheren Verwaltung. Vorhandene Einträge werden nicht überschrieben, Umgebungsvariablen haben immer Vorrang."
    },
    "pt-BR": {
      pageSub: "De estação em estação, como estrelas cadentes.",
      listTitle: "Mensagens", refresh: "Atualizar", settingsOverview: "Visão dos ajustes", openSettings: "Abrir ajustes",
      quickOverview: "Visão rápida", viewStats: "Ver estatísticas", selectHint: "Clique com o botão direito ou toque e segure para selecionar vários",
      selAllList: "Selecionar lista atual", tagVerify: "Código de verificação", allDevices: "Todos os dispositivos",
      scLanguage: "Idioma", scLang: "Idioma", scLangHelp: "A preferência de idioma é salva neste navegador e aplicada após salvar com recarregamento completo. Outros navegadores não são afetados.",
      scPageSize: "Paginação", scPerPage: "Itens por página", scPageSizeHelp: "O tamanho da página é salvo neste navegador e aplicado imediatamente após salvar.",
      scBrowserPrefs: "Preferências do navegador", scBrowserPrefsHelp: "Os interruptores de mensagens e o horário de silêncio afetam apenas este navegador.",
      scNotifyChannels: "Canais de notificação", scChannelsN: "{n} configurados", scMinN: "{n} min", scDaysN: "{n} dias", statToday: "Recebidos hoje",
      scTargetOff: "Desativar", scTargetRename: "Renomear", scTargetLegacy: "Este canal tem vários destinos; os campos de destino único acima não são mais usados no envio.",
      scAddTarget: "Adicionar destino", scTargetNamePh: "Nome do envio (ex. grupo de plantão)", scTargetAdded: "Destino adicionado; salve para aplicar",
      scTargetRemoved: "Destino removido; salve para aplicar", scTargetSaveFirst: "Salve o destino antes de enviar um teste", scMultiTarget: "Multi-destino",
      copyFail: "Falha ao copiar. Selecione manualmente", exportHint: "Exporta o filtro atual",
      scAddPush: "Adicionar envio", scPushList: "Envios configurados",
      scPushListHelp: "Apenas envios criados são listados. Clique em Editar para alterar o nome, a configuração ou os tipos aceitos.",
      scPushEmpty: "Ainda não há envios. Clique em «Adicionar envio» para criar o primeiro.",
      scPickChannel: "Escolha o meio de envio", scPickChannelHelp: "Escolha primeiro um meio; em seguida aparecem os campos de configuração.",
      scPushName: "Nome do envio", scPushEditor: "Editar envio", scPushTypes: "Tipos aceitos",
      scPushTypesHelp: "Apenas os tipos marcados são entregues, junto com as regras globais (todos por padrão).",
      scPushRulesHelp: "Deixar um campo vazio não o altera; campos sensíveis salvos mostram apenas um valor mascarado.",
      scPushNameRequired: "Informe um nome para o envio", scPushNeedTypes: "Selecione ao menos um tipo",
      scPushFieldNeed: "Informe «{f}»", scPushAdded: "Envio adicionado; salve para aplicar", scPushUpdated: "Envio atualizado; salve para aplicar",
      scEdit: "Editar", scBack: "Voltar", scEnvChannels: "Outros canais configurados",
      scEnvChannelsHelp: "Esses canais ainda não têm um cartão de envio próprio e seguem as regras globais. Você pode desativá-los ou testá-los aqui.",
      scImportEnvHelp: "Copie as configurações de notificação do ambiente de implantação para esta página para facilitar a gestão. Itens existentes não são sobrescritos e as variáveis de ambiente sempre têm prioridade."
    }
  };
  (function () {
    for (var _v2l in V2_I18N) {
      if (!I18N[_v2l]) I18N[_v2l] = {};
      for (var _v2k in V2_I18N[_v2l]) I18N[_v2l][_v2k] = V2_I18N[_v2l][_v2k];
    }
  })();
  /* 时长单位（九语种）：把分钟数转成易读文案，避免页面出现 3600 之类的技术数字 */
  var UNIT_I18N = {
    "zh-CN": { unitMin: "分钟", unitHour: "小时", unitDay: "天" },
    "zh-TW": { unitMin: "分鐘", unitHour: "小時", unitDay: "天" },
    "en": { unitMin: "min", unitHour: "h", unitDay: "d" },
    "ja": { unitMin: "分", unitHour: "時間", unitDay: "日" },
    "ko": { unitMin: "분", unitHour: "시간", unitDay: "일" },
    "es": { unitMin: "min", unitHour: "h", unitDay: "d" },
    "fr": { unitMin: "min", unitHour: "h", unitDay: "j" },
    "de": { unitMin: "Min.", unitHour: "Std.", unitDay: "Tage" },
    "pt-BR": { unitMin: "min", unitHour: "h", unitDay: "dias" }
  };
  var EXTRA_I18N = {
    "zh-CN": { scEnvPriority: "环境变量里已经有的项会优先生效；这里保存的设置作为补充，不会覆盖环境变量。" },
    "zh-TW": { scEnvPriority: "環境變數中既有的項目會優先生效；此處儲存的設定作為補充，不會覆蓋環境變數。" },
    "en": { scEnvPriority: "Items already set by environment variables take precedence; settings saved here act as a fallback and never override them." },
    "ja": { scEnvPriority: "環境変数で設定済みの項目が優先されます。ここで保存した設定は補完であり、環境変数を上書きしません。" },
    "ko": { scEnvPriority: "환경 변수에 이미 설정된 항목이 우선 적용됩니다. 여기서 저장한 설정은 보완용이며 환경 변수를 덮어쓰지 않습니다." },
    "es": { scEnvPriority: "Lo que ya está definido en las variables de entorno tiene prioridad; lo guardado aquí es un complemento y no lo sobrescribe." },
    "fr": { scEnvPriority: "Les valeurs définies dans les variables d'environnement sont prioritaires ; les réglages enregistrés ici complètent sans les écraser." },
    "de": { scEnvPriority: "In Umgebungsvariablen gesetzte Werte haben Vorrang; hier gespeicherte Einstellungen ergänzen sie nur." },
    "pt-BR": { scEnvPriority: "Itens já definidos nas variáveis de ambiente têm prioridade; o que for salvo aqui é complementar e não os substitui." }
  };
  (function () {
    for (var _ul in UNIT_I18N) {
      if (!I18N[_ul]) I18N[_ul] = {};
      for (var _uk in UNIT_I18N[_ul]) I18N[_ul][_uk] = UNIT_I18N[_ul][_uk];
    }
    for (var _xl in EXTRA_I18N) {
      if (!I18N[_xl]) I18N[_xl] = {};
      for (var _xk in EXTRA_I18N[_xl]) I18N[_xl][_xk] = EXTRA_I18N[_xl][_xk];
    }
  })();
  function fmtMinutes(n) {
    var v = parseInt(n, 10);
    if (!v || v < 0) v = 30;
    if (v % 1440 === 0) return (v / 1440) + " " + T("unitDay");
    if (v % 60 === 0) return (v / 60) + " " + T("unitHour");
    return v + " " + T("unitMin");
  }
  function T(key, vars) {
    var m = I18N[LANG] || I18N.en;
    var s = m[key];
    if (s === undefined) s = I18N.en[key];
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
    document.documentElement.lang = LANG;
    var each = function (sel, attr, fn) {
      var ns = document.querySelectorAll("[" + attr + "]");
      for (var i = 0; i < ns.length; i++) fn(ns[i], T(ns[i].getAttribute(attr)));
    };
    each("data-i18n", "data-i18n", function (el, v) { el.textContent = v; });
    each("data-i18n-ph", "data-i18n-ph", function (el, v) { el.setAttribute("placeholder", v); });
    each("data-i18n-title", "data-i18n-title", function (el, v) { el.setAttribute("title", v); });
    each("data-i18n-aria", "data-i18n-aria", function (el, v) { el.setAttribute("aria-label", v); });
    var tb = $("themebtn");
    if (tb) tb.setAttribute("title", T("themeTip"));
  }
  /* 每页条数选项（本地化文案）；设置中心与分页器共用 */
  function perPageOptions() {
    var nums = [10, 20, 50, 100], html = "";
    for (var i = 0; i < nums.length; i++) html += '<option value="' + nums[i] + '">' + esc(T("perPage", { n: nums[i] })) + '</option>';
    return html;
  }
  /* 语言名（自名显示）；语言选择位于设置中心 */
  var LANG_NAMES = { "zh-CN": "简体中文", "zh-TW": "繁體中文", "en": "English", "ja": "日本語", "ko": "한국어", "es": "Español", "fr": "Français", "de": "Deutsch", "pt-BR": "Português (BR)" };
  function langOptions() {
    return LANGS.map(function (code) {
      return '<option value="' + code + '"' + (code === LANG ? " selected" : "") + '>' + LANG_NAMES[code] + '</option>';
    }).join("");
  }
  applyI18n();
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function parseUTC(utc) {
    var d = new Date(String(utc).replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? null : d;
  }
  var LOCALES = { "zh-CN": "zh-CN", "zh-TW": "zh-TW", "en": "en-US", "ja": "ja-JP", "ko": "ko-KR", "es": "es-ES", "fr": "fr-FR", "de": "de-DE", "pt-BR": "pt-BR" };
  var LOCALE = LOCALES[LANG] || "en-US";
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
    if (LANG === "zh-CN" || LANG === "zh-TW" || LANG === "ja")
      return v.year + "年" + v.pmonth + "月" + v.pday + "日 " + v.phour + ":" + v.pminute + ":" + v.psecond;
    if (LANG === "ko")
      return v.year + "년 " + Number(v.pmonth) + "월 " + Number(v.pday) + "일 " + v.phour + ":" + v.pminute + ":" + v.psecond;
    try {
      return new Intl.DateTimeFormat(LOCALE, { timeZone: "Asia/Shanghai", year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);
    } catch (e) {}
    return MONTHS[Number(v.month) - 1] + " " + Number(v.day) + ", " + v.year + " " + v.phour + ":" + v.pminute + ":" + v.psecond;
  }
  /* 短日期（跨年带年份）：zh 系/ja/ko 走年月日模板，其余走 Intl 本地格式，最终兜底英文月名 */
  function fmtShort(d, v, now, withTime) {
    if (LANG === "zh-CN" || LANG === "zh-TW" || LANG === "ja") {
      var yr = v.year === now.year ? "" : v.year + "年";
      return yr + Number(v.pmonth) + "月" + Number(v.pday) + "日" + (withTime ? " " + v.phour + ":" + v.pminute : "");
    }
    if (LANG === "ko") {
      var yk = v.year === now.year ? "" : v.year + "년 ";
      return yk + Number(v.pmonth) + "월 " + Number(v.pday) + "일" + (withTime ? " " + v.phour + ":" + v.pminute : "");
    }
    try {
      var op = { timeZone: "Asia/Shanghai", month: "short", day: "numeric", hour12: false };
      if (v.year !== now.year) op.year = "numeric";
      if (withTime) { op.hour = "2-digit"; op.minute = "2-digit"; }
      return new Intl.DateTimeFormat(LOCALE, op).format(d);
    } catch (e) {}
    var yr2 = v.year === now.year ? "" : ", " + v.year;
    var base = MONTHS[Number(v.month) - 1] + " " + Number(v.day) + yr2;
    return withTime ? base + " " + v.phour + ":" + v.pminute : base;
  }
  /* 相对时间：刚刚 / N 分钟前 / N 小时前 / 更早显示短日期；悬停卡片可看完整时间 */
  function relTime(utc) {
    var d = parseUTC(utc);
    if (!d) return String(utc || "");
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return T("justNow");
    if (diff < 3600) return T("minAgo", { n: Math.floor(diff / 60) });
    if (diff < 86400) return T("hourAgo", { n: Math.floor(diff / 3600) });
    return fmtShort(d, partsOf(d), partsOf(new Date()), true);
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
    return fmtShort(d, v, now, false);
  }
  /* 验证码提取（级联策略，借鉴 SmsForwarder 关键词集 / otp-message-extractor 防误报 / expo-sms-listener 级联）：
     ① 码在前+分隔式(8-2-307是您的取件码) → ② 码在前+数字码(123456是您的验证码)
     → ③ 关键词在前+分隔码 → ④ 关键词在前+数字码 → ⑤ Google 风格(G-123456)
     → ⑥ 字母数字混合码 → ⑦ 全文唯一数字组兜底。码在前必须先于关键词在前：
     关键词在前模式允许跨短 gap，会把「123456是您的验证码，您有2000积分」里的 2000 误当验证码。
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
    /* ① 码在前 + 分隔式：8-2-307 是您的取件码（捕获组在匹配串开头，hit() 的左边界检查
       会撞上组尾数字而恒真 → 单独 exec：只需保证组首左侧不紧贴数字，组尾右侧由 [^0-9] 衔接天然保证） */
    m = new RegExp("([0-9]{1,4}(?:[- ][0-9]{1,4}){1,2})[^0-9]{0,8}(?:您的|你的)?(?:" + kw + ")", "i").exec(t);
    if (m && !(m.index > 0 && /[0-9]/.test(t.charAt(m.index - 1)))) return m[1].replace(/[- ]/g, "");
    /* ② 码在前 + 纯数字 4-8 位：123456是您的验证码 */
    m = new RegExp("([0-9]{4,8})[^0-9]{0,8}(?:您的|你的)?(?:" + kw + ")", "i").exec(t);
    if (m && !(m.index > 0 && /[0-9]/.test(t.charAt(m.index - 1)))) return m[1];
    /* ③ 关键词在前 + 分隔式数字：123-456 / 1234 5678 / 取件码 8-2-307 风格（先于纯数字，防被截断） */
    m = hit(new RegExp("(?:" + kw + ")[^0-9]{0,12}([0-9]{1,4}(?:[- ][0-9]{1,4}){1,2})", "i"));
    if (m) return m.replace(/[- ]/g, "");
    /* ④ 关键词在前 + 纯数字 4-8 位 */
    m = hit(new RegExp("(?:" + kw + ")[^0-9]{0,12}([0-9]{4,8})", "i"));
    if (m) return m;
    /* ⑤ Google 风格：G-383838 是您的 Google 验证码 */
    m = hit(new RegExp("([A-Za-z]{1,3}-[0-9]{4,8})", "i"));
    if (m) return m.split("-")[1];
    /* ⑥ 字母数字混合 4-8 位（须同时含字母与数字；右侧不得紧贴字母数字） */
    m = new RegExp("(?:" + kw + ")[^0-9A-Za-z]{0,4}([0-9A-Za-z]{4,8})", "i").exec(t);
    if (m) {
      var b5 = m.index + m[0].length;
      if (b5 >= t.length || !/[0-9A-Za-z]/.test(t.charAt(b5))) {
        if (/[0-9]/.test(m[1]) && /[A-Za-z]/.test(m[1])) return m[1];
      }
    }
    /* ⑦ 兜底：剥离后全文恰好只有一组独立 4-8 位数字时才取（唯一性保证不误报） */
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
    return state.labels[d] || (/^zh/.test(LANG) ? NUM_LABELS[d] : NUM_LABELS_EN[d]) || "";
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
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return !!ok;
  }
  /* 复制：Clipboard API 优先，失败回退 execCommand；两者都失败必须明确报错，绝不假报成功 */
  function doCopy(text, btn) {
    var rely = function (ok) {
      if (!ok) { toast(T("copyFail")); return; }
      toast(T("copied"));
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = T("copied");
      btn.disabled = true;
      setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { rely(true); }, function () { rely(fallbackCopy(text)); });
    } else { rely(fallbackCopy(text)); }
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
    if (state.readOnly) p.set("read", "1");
    p.set("page", state.page);
    p.set("limit", state.limit);
    /* 列表只取摘要（约 20 字），完整正文由详情接口按需取 */
    p.set("slim", "1");
    return p.toString();
  }
  function loadDevices() {
    return fetch("/api/devices").then(function (r) { return r.json(); }).then(function (res) {
      var tabs = $("tabs");
      tabs.innerHTML = "";
      var total = (res.list || []).reduce(function (s, d) { return s + d.msg_count; }, 0);
      var mk = function (name, sub, count, id) {
        var el = document.createElement("div");
        el.setAttribute("data-dev", String(id));
        el.className = "tab" + (state.device === id ? " active" : "");
        el.setAttribute("role", "tab");
        el.setAttribute("aria-selected", state.device === id ? "true" : "false");
        el.tabIndex = 0;
        el.innerHTML = '<span class="device-icon">▣</span><span class="tmain"><span class="tname">' + esc(name) +
          '</span><span class="tsub">' + esc(sub) + '</span></span><span class="tcount">' + esc(count) + '</span>';
        el.onclick = function () { state.device = id; state.page = 1; markActiveTabs(); load(); };
        return el;
      };
      tabs.appendChild(mk(T("tabAll"), T("allDevices"), total ? String(total) : "", 0));
      (res.list || []).forEach(function (d) {
        var el = mk(d.display_name === "未命名设备" ? T("unnamed") : d.display_name,
          (d.sim ? d.sim + " · " : "") + T("devCount", { n: d.msg_count }),
          d.last_at ? relTime(d.last_at) : "", d.id);
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
            askPassword(function () {
              fetch("/api/devices/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: d.id, to: target.id }) })
                .then(function (r) { return r.json(); })
                .then(function (res2) {
                  if (!res2.success) { alert(res2.error === "device not found" ? T("targetMissing") : (res2.error || T("mergeFail"))); return; }
                  if (state.device === d.id) { state.device = target.id; }
                  refreshAll();
                });
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
            askPassword(function () {
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
            });
          };
          el.appendChild(x);
        }
        tabs.appendChild(el);
      });
    });
  }
  /* 切换设备标签时只更新激活态，不重新拉取 /api/devices（此前每次点击都会多请求一次设备列表） */
  function markActiveTabs() {
    var tabs = $("tabs").children;
    for (var i = 0; i < tabs.length; i++) {
      var el = tabs[i];
      var raw = el.getAttribute("data-dev");
      var id = raw === null ? 0 : parseInt(raw, 10);
      var active = id === state.device;
      el.classList.toggle("active", active);
      el.setAttribute("aria-selected", active ? "true" : "false");
    }
  }
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
    var all = $("selall");
    if (all) {
      var boxes = $("list").querySelectorAll(".selbox");
      all.checked = boxes.length > 0;
      for (var i = 0; i < boxes.length; i++) if (!boxes[i].checked) { all.checked = false; break; }
    }
    var cards = $("list").querySelectorAll(".card");
    for (var j = 0; j < cards.length; j++) {
      cards[j].classList.toggle("selected", !!state.selected[cards[j].getAttribute("data-id")]);
    }
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
    var text = (m.summary !== undefined ? m.summary : m.content) || "";
    var code = m.code !== undefined ? m.code : extractCode(m.content || "");
    var isSms = (m.source || "sms") === "sms";
    var recv = m.sim_number || m.sim || "";
    var lbl = isSms ? numLabel(m.sender) : "";
    var snum = isSms ? normalizeNum(m.sender) : "";
    var who = isSms ? (lbl || m.sender || T("unknownNum")) : (m.sender || m.device_name || T("srcNotify"));
    var typeTag = code ? T("tagVerify") : (isSms ? T("srcSms") : srcLabel(m.source));
    var initial = String(who || "?").slice(0, 1);
    return '<div class="card msg' + (isFresh ? " flash" : "") + '" data-id="' + m.id + '" data-day="' + esc(dayLabel(m.received_at)) + '">' +
      '<label class="selwrap" title="' + esc(T("selTip")) + '"><input type="checkbox" class="selbox" data-id="' + m.id + '"></label>' +
      '<div class="msg-main">' +
        '<div class="msg-top">' +
          '<span class="avatar-sm">' + esc(initial) + '</span>' +
          '<span class="sender">' + esc(who) + '</span>' +
          (isSms && lbl ? '<span class="phone">' + esc(m.sender || "") + '</span>' : '') +
          '<span class="tag type">' + esc(typeTag) + '</span>' +
          (m.read_at ? "" : '<span class="tag unread-tag">' + esc(T("unread")) + '</span>') +
          '<span class="msg-time" title="' + esc(fmtTime(m.received_at)) + '">' + esc(relTime(m.received_at)) + '</span>' +
          (code ? '<span class="code-chip"><span class="code-val">' + esc(code) + '</span><button class="copy" type="button" data-code="' + esc(code) + '">' + esc(T("copy")) + '</button></span>' : '') +
        '</div>' +
        '<p class="content summary" data-id="' + m.id + '" title="' + esc(T("detailTip")) + '">' + linkify(highlight(esc(text), state.q)) + '</p>' +
        '<div class="msg-bottom">' +
          '<span class="msg-meta">' + esc(m.device_name || "") +
            (isSms && recv ? ' · <span class="recv" title="' + esc(T("recvTip")) + '">' + esc(recv) + '</span>' : '') +
            (isSms && /^1[3-9]\d{9}$/.test(snum) ? '<span class="area" data-num="' + snum + '"></span>' : '') +
          '</span>' +
          '<div class="msg-actions">' +
            '<button class="more" type="button" data-id="' + m.id + '" hidden>' + esc(T("detailBtn")) + '</button>' +
            '<button class="star' + (m.starred ? " on" : "") + '" data-id="' + m.id + '" title="' + esc(T("starItemTip")) + '">' + (m.starred ? "★" : "☆") + '</button>' +
            (m.read_at ? "" : '<button class="rbtn" type="button" data-id="' + m.id + '" title="' + esc(T("markRead")) + '">✓ ' + esc(T("markRead")) + '</button>') +
            '<button class="del" data-id="' + m.id + '">' + esc(T("del")) + '</button>' +
          '</div>' +
        '</div>' +
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
    markClipped();
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
  /* 仅单页模式（未加载历史）时裁剪轮询新增，避免列表无限增长；
     一旦用过游标加载历史，则保留已加载内容，避免丢弃历史后游标错位 */
  function trimToLimitIfSinglePage(listEl) { if (!state.cursor) trimToLimit(listEl); }
  /* 两行截断的真实溢出判定：按实际行数（自然高度 / 行高）决定是否显示「查看全文」，
     不依赖字数或服务器截断标记，兼容中英文/数字/URL/混合字符与任意宽度 */
  function markClipped(root) {
    var listEl = root || $("list");
    if (!listEl) return;
    var els = listEl.querySelectorAll(".content.summary");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var card = el.closest ? el.closest(".card") : null;
      var btn = card ? card.querySelector(".more") : null;
      if (!btn) continue;
      var cs = getComputedStyle(el);
      var lh = parseFloat(cs.lineHeight);
      if (!lh || !isFinite(lh)) lh = parseFloat(cs.fontSize) * 1.6 || 22;
      /* 临时解除截断，测量自然高度 */
      var oldClamp = el.style.webkitLineClamp;
      var oldDisplay = el.style.display;
      el.style.webkitLineClamp = "unset";
      el.style.display = "block";
      var lines = Math.round(el.scrollHeight / lh);
      el.style.webkitLineClamp = oldClamp;
      el.style.display = oldDisplay;
      btn.hidden = lines <= 2;
    }
  }
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
      state.seen[m.id] = true;
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
    trimToLimitIfSinglePage(listEl);
    updateMeta(res);
    fillAreas();
    syncSelBoxes();
    markClipped(listEl);
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
  var tokenSecret = null; /* 接入令牌一次性明文：仅存内存变量，closeModal 时置 null 清引用；不落 localStorage/URL/console */
  function openModal(html) { $("modalbody").innerHTML = html; $("modal").hidden = false; }
  function closeModal() {
    /* 设置中心存在未保存修改时先确认，避免静默丢失；其它弹层（SC.dirty 为 false）行为不变 */
    if (typeof SC !== "undefined" && SC && SC.dirty) {
      if (!window.confirm("设置有未保存的修改，关闭后这些修改将丢弃。确定关闭？")) return;
      SC.dirty = false;
    }
    $("modal").hidden = true; $("modalbody").innerHTML = ""; tokenSecret = null;
    /* 关闭设置中心时同步收起第二层推送编辑器，避免残留遮罩 */
    var pm = $("pushmodal"); if (pm) pm.hidden = true;
  }
  /* ---------------- 重要操作密码确认 ----------------
     默认开启：危险/敏感操作执行前要求输入登录密码（即 ADMIN_PASSWORD），校验通过后才继续。
     未开启登录（服务端无 ADMIN_PASSWORD）时 state.pwdOn 为 false，直接放行。 */
  var pwdAfter = null;
  function pwdShowErr(msg) { var e = $("pwderr"); if (!e) return; e.textContent = msg; e.hidden = false; }
  function pwdClose() {
    $("pwdmodal").hidden = true;
    $("pwdinput").value = "";
    $("pwderr").hidden = true;
    pwdAfter = null;
  }
  function askPassword(onOk, help) {
    if (!state.pwdOn) { onOk(); return; }
    pwdAfter = onOk;
    $("pwdtitle").textContent = T("pwdTitle");
    $("pwdhelp").textContent = help || T("pwdHelp");
    $("pwdinput").value = "";
    $("pwdinput").placeholder = T("pwdPh");
    $("pwderr").hidden = true;
    $("pwdcancel").textContent = T("cancel");
    $("pwdok").textContent = T("pwdVerify");
    $("pwdok").disabled = false;
    $("pwdmodal").hidden = false;
    setTimeout(function () { try { $("pwdinput").focus(); } catch (e) {} }, 30);
  }
  function pwdSubmit() {
    var pw = $("pwdinput").value;
    if (!pw) { pwdShowErr(T("pwdNeed")); return; }
    var btn = $("pwdok");
    btn.disabled = true;
    fetch("/api/verify-password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    }).then(function (r) {
      return r.json().then(function (d) { return { s: r.status, d: d }; });
    }).then(function (res) {
      btn.disabled = false;
      if (res.s === 200 && res.d && res.d.success) {
        var cb = pwdAfter; pwdClose(); if (cb) cb();
        return;
      }
      if (res.s === 429) { pwdShowErr(T("pwdTooMany")); return; }
      if (res.s === 401) { location.reload(); return; }
      pwdShowErr(T("pwdWrong"));
    }).catch(function () { btn.disabled = false; pwdShowErr(T("pwdWrong")); });
  }
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
  function readOne(id, btn) {
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    fetch("/api/messages/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id, read: true }) })
      .then(function (r) { if (r.status === 401) { location.reload(); return new Promise(function () {}); } return r.json(); })
      .then(function (res) {
        if (!res || !res.success) { btn.disabled = false; toast(T("readFail")); return; }
        var card = $("list").querySelector('.card[data-id="' + id + '"]');
        if (card) {
          var dot = card.querySelector(".undot");
          if (dot) dot.parentNode.removeChild(dot);
          var b = card.querySelector(".rbtn");
          if (b) b.parentNode.removeChild(b);
        }
        refreshUnreadCount();
      })
      .catch(function () { btn.disabled = false; toast(T("readFail")); });
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
    /* slim 列表不含正文：统一按 id 取完整消息，保证详情/复制与摘要一致 */
    fetch("/api/messages/" + id)
      .then(function (r) {
        if (r.status === 401) { location.reload(); return new Promise(function () {}); }
        return r.json();
      })
      .then(function (res) {
        if (!res || !res.success || !res.item) { toast(T("detailFail")); return; }
        renderDetail(res.item);
      })
      .catch(function () { toast(T("detailFail")); });
  }
  function renderDetail(m) {
    var isSms = (m.source || "sms") === "sms";
    var code = extractCode(m.content);
    var snum = normalizeNum(m.sender);
    var wasRead = !!m.read_at;
    var body = String(m.content || "");
    var typeText = code ? T("tagVerify") : (isSms ? T("srcSms") : (m.source || T("srcNotify")));
    var parts = [];
    if (isSms) parts.push('<span class="m-num">' + esc(m.sender || T("unknownNum")) + '</span>');
    parts.push('<span class="m-strong">' + esc(typeText) + '</span>');
    if (!isSms) parts.push('<span>' + esc(m.source || T("srcNotify")) + '</span>');
    parts.push('<span class="m-num">' + esc(fmtTime(m.received_at)) + '</span>');
    if (m.device_name) parts.push('<span>' + esc(m.device_name) + '</span>');
    parts.push('<span>' + esc(wasRead ? T("read") : T("unread")) + '</span>');
    if (m.starred) parts.push('<span class="m-star">★</span>');
    var html = '<h3>' + esc(isSms ? (numLabel(m.sender) || m.sender || T("unknownNum")) : (m.sender || m.device_name || T("srcNotify"))) + '</h3>' +
      '<div class="detail-metarow">' + parts.join('<span class="sep">·</span>') + '</div>' +
      '<div class="detail-body">' + (body ? linkify(esc(body)) : '<span class="empty-text">' + esc(T("emptyBody")) + '</span>') + '</div>' +
      '<div class="modal-foot">' +
        '<div class="foot-left">' +
          '<button class="tbtn" id="dcopy">' + esc(T("copyBody")) + '</button>' +
          '<button class="tbtn" id="dstar">' + esc(m.starred ? T("unstar") : T("star")) + '</button>' +
          (isSms && snum ? '<a class="tbtn" href="tel:' + esc(snum) + '">' + esc(T("call")) + '</a>' : '') +
          (isSms && snum ? '<button class="tbtn" id="dlabel">' + esc(T("setLabel")) + '</button>' : '') +
          '<button class="tbtn" id="ddel" style="color:var(--ds-color-danger);border-color:var(--ds-color-danger)">' + esc(T("del")) + '</button>' +
        '</div>' +
        '<div class="foot-right">' +
          '<button class="tbtn" id="dclose">' + esc(T("modalClose")) + '</button>' +
          '<button class="tbtn" id="dread" style="border-color:var(--accent);color:var(--accent)">' + esc(wasRead ? T("markUnread") : T("markRead")) + '</button>' +
        '</div>' +
      '</div>';
    openModal(html);
    if (!wasRead) {
      /* 现有语义：打开详情自动标记已读；失败则回滚本地状态并提示，不做“假成功” */
      m.read_at = "now";
      fetch("/api/messages/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: m.id, read: true }) })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (res && res.success) {
            var card = $("list").querySelector('.card[data-id="' + m.id + '"]');
            if (card) { var dot = card.querySelector(".undot"); if (dot) dot.parentNode.removeChild(dot); }
            refreshUnreadCount();
          } else {
            m.read_at = null;
            toast(T("readFail"));
          }
        })
        .catch(function () { m.read_at = null; toast(T("readFail")); });
    }
    $("dstar").onclick = function () { toggleStar(m.id, !m.starred).then(closeModal); };
    $("dread").onclick = function () { toggleRead(m.id, !wasRead).then(closeModal); };
    $("dcopy").onclick = function () { doCopy(m.content, $("dcopy")); };
    $("ddel").onclick = function () { closeModal(); doDelete([m.id]); };
    $("dclose").onclick = closeModal;
    var lb = $("dlabel");
    if (lb) lb.onclick = function () {
      var cur = state.labels[snum] || "";
      var nm = prompt(T("labelPrompt", { n: snum }), cur);
      if (nm === null) return;
      saveLabel(snum, String(nm).trim());
      closeModal(); load();
    };
  }
  /* 未读数以服务端为准（避免只改前端数字） */
  function refreshUnreadCount() {
    return fetch("/api/stats").then(function (r) { return r.json(); }).then(function (res) {
      if (res && res.success && typeof res.unread === "number") {
        state.unread = res.unread;
        var el = $("unreadcount");
        if (el) { el.textContent = state.unread; el.hidden = state.unread <= 0; }
      }
    }).catch(function () {});
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
  /* ---------- 接入令牌面板（第 3 步）：设置菜单入口，复用 .modal/.sheet 弹层 ----------
     文案中文先行（i18n 后续补）；一次性明文仅存 tokenSecret，closeModal 清引用；
     不写 localStorage、不写 URL、不写 console。 */
  var tokListCache = [];
  function fmtTokTime(s) { return s ? String(s).replace("T", " ").slice(0, 16) : "—"; }
  function tokApi(method, path, body) {
    return fetch(path, { method: method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }); });
  }
  function openTokens() {
    openModal(
      '<h3>接入令牌</h3>' +
      '<div class="toknote" id="toknote" hidden>当前仍可用部署时环境变量令牌接入；建议创建命名令牌后停用引导令牌（设置 DISABLE_RECEIVE_TOKEN=true）。</div>' +
      '<div id="toklist"><div class="tokmeta">加载中…</div></div>' +
      '<div class="toknewrow"><input class="ds-input" type="text" id="tokname" maxlength="64" placeholder="令牌名称（字母/数字/_/-）" autocomplete="off" aria-label="令牌名称"><button class="tbtn" id="tokcreate">＋ 新建令牌</button></div>' +
      '<div class="toknewrow"><select class="ds-select" id="tokexp" aria-label="有效期"><option value="0">永久有效</option><option value="7">7 天后到期</option><option value="30">30 天后到期</option><option value="90">90 天后到期</option><option value="365">365 天后到期</option><option value="custom">自定义到期日…</option></select><input class="ds-input" type="date" id="tokexpdate" hidden aria-label="到期日期"><input class="ds-input" type="text" id="toknotenew" maxlength="200" placeholder="备注（可选，便于区分用途）" autocomplete="off" aria-label="备注"></div>'
    );
    $("tokcreate").onclick = createTokenUi;
    $("tokname").onkeydown = function (ev) { if (ev.key === "Enter") createTokenUi(); };
    var expSel = $("tokexp");
    expSel.onchange = function () { $("tokexpdate").hidden = expSel.value !== "custom"; };
    loadTokens();
  }
  function loadTokens() {
    return fetch("/api/tokens").then(function (r) {
      if (r.status === 401) { location.reload(); return null; }
      return r.json();
    }).then(function (d) {
      var box = $("toklist");
      if (!box || !d) return;
      if (!d.success) { box.innerHTML = '<div class="tokmeta">加载失败</div>'; return; }
      var list = d.list || [];
      var nowStr = String(d.now || ""); /* 服务端 UTC 时间：客户端时钟不可信，过期判定用它 */
      tokListCache = list;
      var note = $("toknote"); if (note) note.hidden = list.length > 0; /* 空态引导：库内无令牌时提示迁移路径 */
      if (!list.length) { box.innerHTML = '<div class="tokmeta">还没有库内令牌。</div>'; return; }
      var html = "";
      list.forEach(function (t) {
        var rev = t.revoked_at !== null && t.revoked_at !== undefined;
        var exp = t.expires_at ? String(t.expires_at) : "";
        var expired = !rev && !!exp && !!nowStr && exp < nowStr;
        html += '<div class="tokrow' + ((rev || expired) ? ' revoked' : '') + '">' +
          '<div class="tokmain"><div class="tokname">' + esc(t.name) + '</div>' +
          '<div class="tokmeta">' + esc(t.token_prefix || "") + '… · 创建 ' + esc(fmtTokTime(t.created_at)) +
          ' · 最近使用 ' + esc(fmtTokTime(t.last_used_at)) +
          (exp ? ' · 到期 ' + esc(fmtTokTime(exp)) : ' · 永久') +
          (t.note ? ' · ' + esc(String(t.note)) : '') + '</div></div>' +
          '<span class="tokbadge">' + (rev ? "已吊销" : (expired ? "已过期" : "活跃")) + '</span>' +
          (rev ? "" : (expired
            ? '<span class="tokacts"><button class="tbtn" data-tokrev="' + esc(t.id) + '">吊销</button></span>'
            : '<span class="tokacts">' +
              '<button class="tbtn" data-tokren="' + esc(t.id) + '">重命名</button>' +
              '<button class="tbtn" data-tokrot="' + esc(t.id) + '">轮换</button>' +
              '<button class="tbtn" data-tokrev="' + esc(t.id) + '">吊销</button></span>')) +
          '</div>';
      });
      box.innerHTML = html;
      box.onclick = function (ev) {
        var renB = ev.target.closest ? ev.target.closest("[data-tokren]") : null;
        if (renB) { renameTokenUi(renB.getAttribute("data-tokren")); return; }
        var revB = ev.target.closest ? ev.target.closest("[data-tokrev]") : null;
        if (revB) { revokeTokenUi(revB.getAttribute("data-tokrev")); return; }
        var rotB = ev.target.closest ? ev.target.closest("[data-tokrot]") : null;
        if (rotB) { rotateTokenUi(rotB.getAttribute("data-tokrot")); return; }
      };
    }).catch(function () { var b = $("toklist"); if (b) b.innerHTML = '<div class="tokmeta">加载失败</div>'; });
  }
  function showTokenSecret(title, name, plain) {
    tokenSecret = plain;
    openModal(
      '<h3>' + esc(title) + '</h3>' +
      '<div class="tokmeta">名称：' + esc(name) + '</div>' +
      '<div class="toksecret">' + esc(plain) + '</div>' +
      '<div class="tokwarn">关闭后无法再次查看，请立即复制保存。</div>' +
      '<div class="btnrow"><button class="tbtn" id="tokcopy">复制</button><button class="tbtn" id="tokdone">我已保存，关闭</button></div>'
    );
    $("tokcopy").onclick = function () { doCopy(tokenSecret || "", $("tokcopy")); };
    $("tokdone").onclick = closeModal;
  }
  function createTokenUi() {
    var inp = $("tokname");
    var name = inp ? inp.value.trim() : "";
    if (!name) { toast("请输入令牌名称"); if (inp) inp.focus(); return; }
    var payload = { name: name };
    var ninp = $("toknotenew");
    if (ninp && ninp.value.trim()) payload.note = ninp.value.trim();
    var sel = $("tokexp"), dinp = $("tokexpdate");
    if (sel && sel.value === "custom") {
      if (!dinp || !dinp.value) { toast("请选择到期日期"); if (dinp) dinp.focus(); return; }
      payload.expires_at = dinp.value;
    } else if (sel && sel.value !== "0") {
      payload.expires_in_days = parseInt(sel.value, 10) || 0;
    }
    tokApi("POST", "/api/tokens", payload).then(function (res) {
      if (res.s === 401) { location.reload(); return; }
      if (!res.d || !res.d.success) {
        toast(res.d && res.d.error === "NAME_TAKEN" ? "该名称已被使用（活跃令牌名唯一）"
          : res.d && res.d.error === "INVALID_NAME" ? "名称非法：仅限字母/数字/_/-，最长 64"
          : res.d && res.d.error === "INVALID_NOTE" ? "备注过长：最长 200 字"
          : res.d && res.d.error === "INVALID_EXPIRY" ? "有效期无效：请选择预设天数或有效日期"
          : "创建失败");
        return;
      }
      showTokenSecret("令牌已创建", name, res.d.token);
    }).catch(function () { toast("创建失败"); });
  }
  function tokNameOf(id) {
    var t = tokListCache.filter(function (x) { return x.id === id; })[0];
    return t ? t.name : id;
  }
  function revokeTokenUi(id) {
    if (!confirm("确认吊销令牌「" + tokNameOf(id) + "」？使用该令牌的接入将立即失效（403）。")) return;
    askPassword(function () {
      tokApi("POST", "/api/tokens/revoke", { id: id }).then(function (res) {
        if (res.s === 401) { location.reload(); return; }
        if (res.d && res.d.success) { toast(res.d.revoked ? "已吊销" : "该令牌已是吊销状态"); loadTokens(); }
        else if (res.d && res.d.error === "NOT_FOUND") { toast("令牌不存在"); loadTokens(); }
        else toast("吊销失败");
      }).catch(function () { toast("吊销失败"); });
    });
  }
  function rotateTokenUi(id) {
    if (!confirm("确认轮换令牌「" + tokNameOf(id) + "」？旧令牌立即吊销失效，并生成同名新令牌。")) return;
    askPassword(function () {
      tokApi("POST", "/api/tokens/rotate", { id: id }).then(function (res) {
        if (res.s === 401) { location.reload(); return; }
        if (res.d && res.d.success) { showTokenSecret("令牌已轮换", tokNameOf(id), res.d.token); }
        else if (res.d && res.d.error === "NOT_FOUND") { toast("令牌不存在"); loadTokens(); }
        else toast("轮换失败");
      }).catch(function () { toast("轮换失败"); });
    });
  }
  function renameTokenUi(id) {
    var old = tokNameOf(id);
    var nm = prompt("重命名令牌「" + old + "」\n仅限字母/数字/_/-，最长 64", old);
    if (nm === null) return;
    nm = String(nm).trim();
    if (!nm) { toast("令牌名称不能为空"); return; }
    tokApi("POST", "/api/tokens/rename", { id: id, name: nm }).then(function (res) {
      if (res.s === 401) { location.reload(); return; }
      if (res.d && res.d.success) { toast("令牌名称已更新"); loadTokens(); return; }
      if (res.d && res.d.error === "NAME_TAKEN") { toast("该名称已被使用（活跃令牌名唯一）"); return; }
      if (res.d && res.d.error === "INVALID_NAME") { toast("名称非法：仅限字母/数字/_/-，最长 64"); return; }
      if (res.d && res.d.error === "NOT_FOUND") { toast("令牌不存在或已吊销"); loadTokens(); return; }
      toast("重命名失败");
    }).catch(function () { toast("重命名失败"); });
  }
  function registerSW() {
    try { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {}); } catch (e) {}
  }
  function load(incremental) {
    /* 非增量加载（首屏/筛选/分页/刷新）一律重置分页会话：清游标与已加载深度，
       避免 page 与 cursor 两种模型共享状态互相污染 */
    if (!incremental) {
      state.cursor = ""; state.loadMoreDepth = 0;
      /* 翻页 / 筛选 / 刷新 → 退出选择并清空（避免旧选择跨数据集残留）；加载更多与新消息不清理 */
      state.selected = {};
      if (state.selectMode) setSelectMode(false);
      updateSelBar();
    }
    var q = qs();
    return fetch("/api/messages?" + q)
      .then(function (r) {
        /* 登录过期（cookie 7 天 Max-Age）：401 时整页重载，由服务端下发登录页，
           避免停在「加载失败」重试界面 */
        if (r.status === 401) { location.reload(); return new Promise(function () {}); }
        return r.json();
      })
      .then(function (res) {
        if (!res.success) throw new Error(res.error || "load failed");
        state.total = res.total; state.pages = res.pages;
        var list = res.list || [];
        /* 已加载历史时：轮询无新消息 → 保持当前列表与游标不变（不破坏历史分页位置） */
        var preFresh = state.inited ? list.filter(function (m) { return m.id > state.notifiedId; }) : [];
        if (incremental && state.loadMoreDepth > 0 && !preFresh.length) {
          if (typeof res.unread === "number") { state.unread = res.unread; }
          refreshUnreadCount();
          return;
        }
        state.lastList = list;
        state.seen = {};
        list.forEach(function (m) { state.seen[m.id] = true; });
        state.cursor = res.next_cursor || "";
        state.loadMoreDepth = 0;
        if (typeof res.unread === "number") { state.unread = res.unread; }
        refreshUnreadCount();
        var freshSet = {};
        /* 新消息识别：lastId 为轮询游标（防忙循环），notifiedId 为已通知基线 */
        if (!state.inited) {
          state.inited = true;
          if (list.length) {
            var mx0 = Math.max.apply(null, list.map(function (m) { return m.id; }));
            if (state.device) state.lastIdByDev[state.device] = mx0;
            state.lastId = Math.max(state.lastId, mx0);
            state.notifiedId = Math.max(state.notifiedId, mx0);
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
        if (list.length) {
          var mx = Math.max.apply(null, list.map(function (m) { return m.id; }));
          if (state.device) state.lastIdByDev[state.device] = Math.max(state.lastIdByDev[state.device] || 0, mx);
          else state.lastId = Math.max(state.lastId, mx);
        }
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
  /* 右侧栏：设置概览（读取真实设置） */
  function scMini(label, value, scope) {
    return '<div class="settings-mini"><span>' + esc(label) + '</span><span><strong>' + esc(value) + '</strong>'
      + (scope ? ' <span class="scope ' + scope + '">' + esc(scope === "browser" ? T("scScopeBrowser") : T("scScopeGlobal")) + '</span>' : "")
      + '</span></div>';
  }
  function loadSideSettings() {
    return fetch("/api/settings").then(function (r) { return r.json(); }).then(function (d) {
      var box = $("sideSettings");
      if (!box || !d || !d.success) return;
      var local = parseInt(localStorage.getItem(TTL_LOCAL_KEY), 10);
      var localSet = Number.isInteger(local) && local >= 5 && local <= 43200;
      var ttl = localSet ? local : (parseInt(d.session_ttl_minutes, 10) || 30);
      var cfg = d.notify || {}, chans = cfg.channels || {};
      var tgts = cfg.targets || [];
      var nch = tgts.length ? tgts.filter(function (t) { return t.enabled; }).length
        : Object.keys(chans).filter(function (k) { return chans[k] && chans[k].configured; }).length;
      box.innerHTML =
        scMini(T("scTtl"), T("scMinN", { n: ttl }), localSet ? "browser" : "global") +
        scMini(T("scNotifyChannels"), T("scChannelsN", { n: nch }), "") +
        scMini(T("scRetention"), T("scDaysN", { n: d.retention_days || 30 }), "global") +
        scMini(T("scLanguage"), LANG_NAMES[LANG], "browser");
    }).catch(function () {});
  }
  /* 右侧栏：快捷概览（读取真实统计） */
  function loadSideStats() {
    return fetch("/api/stats").then(function (r) { return r.json(); }).then(function (d) {
      var box = $("sideQuick");
      if (!box || !d || !d.success) return;
      var today = 0, days = d.days || [];
      if (days.length) today = days[days.length - 1].n || 0;
      box.innerHTML =
        '<div class="side-row"><span>' + esc(T("statTotal")) + '</span><strong>' + (d.total || 0) + '</strong></div>' +
        '<div class="side-row"><span>' + esc(T("statToday")) + '</span><strong>' + today + '</strong></div>' +
        '<div class="side-row"><span>' + esc(T("statStarred")) + '</span><strong>' + (d.starred || 0) + '</strong></div>';
    }).catch(function () {});
  }
  function refreshSide() { loadSideSettings(); loadSideStats(); }
  function refreshAll() { refreshSide(); return Promise.all([loadSources(), loadDevices()]).then(load); }
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
  function doJump() {
    var n = parseInt($("jump").value, 10);
    if (!Number.isInteger(n)) return;
    n = Math.min(Math.max(1, n), state.pages || 1);
    state.page = n; $("jump").value = ""; load();
  }
  $("gojump").onclick = doJump;
  $("jump").addEventListener("keydown", function (e) { if (e.key === "Enter") doJump(); });
  state.range = $("range").value = "";
  (function initLimit() {
    var v = parseInt(localStorage.getItem("sms_perpage"), 10);
    state.limit = [10, 20, 50, 100].indexOf(v) !== -1 ? v : 10;
  })();
  /* 筛选：全部 / 未读 / 已读 / 星标（单选，与原型筛选 chips 一致） */
  function applyFilterUI(mode) {
    var map = { fall: "all", funread: "unread", fread: "read", fstar: "starred" };
    Object.keys(map).forEach(function (id) {
      var b = $(id);
      if (b) b.classList.toggle("active", map[id] === mode);
    });
  }
  function setFilterMode(mode) {
    state.filterMode = mode;
    state.starOnly = mode === "starred";
    state.unreadOnly = mode === "unread";
    state.readOnly = mode === "read";
    state.page = 1; state.cursor = ""; state.loadMoreDepth = 0;
    applyFilterUI(mode);
    load();
  }
  $("fall").onclick = function () { setFilterMode("all"); };
  $("funread").onclick = function () { setFilterMode("unread"); };
  $("fread").onclick = function () { setFilterMode("read"); };
  $("fstar").onclick = function () { setFilterMode(state.filterMode === "starred" ? "all" : "starred"); };
  $("refreshbtn").onclick = function () { refreshAll(); };
  $("sideSetBtn").onclick = function () { openSettingsCenter("session"); };
  $("sideStatsBtn").onclick = openStats;
  /* 导出：按当前筛选条件下载 CSV / JSON（附件下载，不跳转页面） */
  function exportUrl(fmt) {
    var p = new URLSearchParams();
    if (state.device) p.set("device_id", state.device);
    if (state.src) p.set("source", state.src);
    if (state.range) p.set("range", state.range);
    if (state.q) p.set("q", state.q);
    if (state.starOnly) p.set("starred", "1");
    if (state.unreadOnly) p.set("unread", "1");
    if (state.readOnly) p.set("read", "1");
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
     失败（平台函数超时 / 断网）时指数退避，避免在函数时长较短的平台上形成忙循环。 */
  var pollErr = 0;
  function pollLoop(delay) {
    setTimeout(function () {
      if (state.q) {
        load().then(function () { pollLoop(5000); }, function () { pollLoop(5000); });
        return;
      }
      /* 游标按维度取：设备筛选下后端比较的是该设备 MAX(id)，须用该设备的游标，防跨设备混用 */
      var cur = state.device ? (state.lastIdByDev[state.device] || 0) : (state.lastId || 0);
      var p = "last_id=" + cur;
      if (state.device) p += "&device_id=" + state.device;
      var t0 = Date.now();
      fetch("/api/wait?" + p)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          pollErr = 0;
          if (d && d.changed) {
            if (d.id) {
              if (state.device) state.lastIdByDev[state.device] = Math.max(state.lastIdByDev[state.device] || 0, d.id);
              else state.lastId = Math.max(state.lastId, d.id);
            }
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
  /* 消息开关（自动复制 / 后台通知 / 提示音）在设置中心内维护；此处只负责应用已保存状态 */
  function applyMsgToggles() {
    state.autoCopy = localStorage.getItem("sms_autocopy") !== "0";
    state.notify = localStorage.getItem("sms_notify") !== "0";
    state.sound = localStorage.getItem("sms_sound") === "1";
  }
  applyMsgToggles();
  /* ---------- 设置中心（DS v1）：统一信息架构 / 作用域标识 / 渐进式说明 / 保存·取消·重置 ----------
     作用域：全局（settings 表，影响所有浏览器）｜本浏览器（localStorage，仅当前浏览器）。
     本项目不存在真实「平台级设置」，因此不虚构该分组。
     后端契约不变：GET /api/settings 读取；PUT /api/settings 分组局部保存（revision 乐观锁）。
     全部用户可见文案走 T(key)（九语种，键表见 SC_I18N）。 */
  var TTL_PRESETS = [["30", "scMin30"], ["60", "scHour1"], ["480", "scHour8"], ["1440", "scHour24"], ["10080", "scDay7"], ["43200", "scDay30"]];
  var TTL_LOCAL_KEY = "sms_ttl_min";

  var NF_LABELS = {
    webhook: "nfWebhook", secret: "nfSecret", sendkey: "nfSendkey", token: "nfToken",
    bot_token: "nfBotToken", chat_id: "nfChatId", device_key: "nfDeviceKey", url: "nfUrl",
    api_key: "nfApiKey", mail_to: "nfMailTo", mail_from: "nfMailFrom", urls: "nfUrls",
    template: "nfTemplate", headers: "nfHeaders",
  };
  function nfLabel(f) { return NF_LABELS[f] ? T(NF_LABELS[f]) : f; }
  function nfFetchSettings() {
    return fetch("/api/settings").then(function (r) {
      if (r.status === 401) { location.reload(); return null; }
      return r.json();
    });
  }

  /* 渠道显示名：品牌固有名词，按语言给出（zh 用中文名，其余用品牌英文名；缺失回退英文） */
  var SC_CH = {
    "zh-CN": { feishu: "飞书", wecom: "企业微信", dingtalk: "钉钉", serverchan: "Server酱", resend: "邮件", generic: "通用 Webhook" },
    "zh-TW": { feishu: "飛書", wecom: "企業微信", dingtalk: "釘釘", serverchan: "Server醬", resend: "郵件", generic: "通用 Webhook" }
  };
  var SC_CH_EN = {
    feishu: "Feishu", wecom: "WeCom", dingtalk: "DingTalk", serverchan: "ServerChan",
    pushplus: "PushPlus", telegram: "Telegram", bark: "Bark", ntfy: "ntfy",
    gotify: "Gotify", resend: "Resend", generic: "Generic webhook"
  };
  function scChannelName(ch) {
    var m = SC_CH[LANG];
    return (m && m[ch.key]) || SC_CH_EN[ch.key] || ch.label || ch.key;
  }
  var SET_SECTIONS = [
    { key: "session", label: "scTabSession" },
    { key: "notify", label: "scTabNotify" },
    { key: "biz", label: "scTabBiz" },
    { key: "security", label: "scTabSec" }
  ];
  var SC = { d: null, section: "session", dirty: false, targets: [], tgSeq: 0 };

  function scBadge(kind) {
    var k = kind === "global" ? "global" : "browser";
    return '<span class="ds-scope ds-scope--' + k + '">' + T(k === "global" ? "scScopeGlobal" : "scScopeBrowser") + '</span>';
  }
  function scHelp(t) { return '<div class="ds-help">' + t + '</div>'; }
  function scMarkDirty(on) {
    SC.dirty = !!on;
    var b = $("scdirty"), c = $("scrcancel");
    if (b) b.hidden = !SC.dirty;
    if (c) c.hidden = !SC.dirty;
  }
  function scBusy(btn, on) { if (btn) { btn.disabled = !!on; btn.setAttribute("data-loading", on ? "1" : "0"); } }

  function openSettingsCenter(section) {
    SC.section = section || "session";
    SC.dirty = false;
    nfFetchSettings().then(function (d) {
      if (!d || !d.success) { toast(T("scReadFail")); return; }
      SC.d = d;
      /* 多目标通知：以后端返回的脱敏视图作为编辑模型（敏感字段不回传明文） */
      SC.targets = ((d.notify && d.notify.targets) || []).map(function (t) {
        return { id: t.id, channel: t.channel, name: t.name, enabled: !!t.enabled,
          types: (t.types || ["verify", "sms", "notify"]).slice(),
          fields: t.fields || {}, configured: !!t.configured, _new: false };
      });
      scRenderShell();
    }).catch(function () { toast(T("scReadFail")); });
  }
  function scRenderShell() {
    var tabs = SET_SECTIONS.map(function (x) {
      return '<button class="tab' + (x.key === SC.section ? " active" : "") + '" role="tab" data-sc-tab="' + x.key + '"'
        + ' aria-selected="' + (x.key === SC.section ? "true" : "false") + '">' + T(x.label) + '</button>';
    }).join("");
    openModal('<h3>' + T("scTitle") + ' <span class="ds-badge" id="scdirty" hidden>' + T("scDirty") + '</span></h3>'
      + '<div class="ds-tabs" id="sctabs" role="tablist">' + tabs + '</div>'
      + '<div class="setform" id="scbody"></div>'
      + '<div class="ds-dialog-actions">'
      + '<button class="ds-btn" id="scrdefault" type="button">' + T("scReset") + '</button>'
      + '<button class="ds-btn" id="scrcancel" type="button" hidden>' + T("cancel") + '</button>'
      + '<button class="ds-btn ds-btn--primary" id="scrsave" type="button">' + T("save") + '</button></div>');
    $("sctabs").onclick = function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest("[data-sc-tab]") : null;
      if (!t) return;
      var next = t.getAttribute("data-sc-tab");
      if (next === SC.section) return;
      if (SC.dirty && !window.confirm(T("scSwitchConfirm"))) return;
      SC.section = next;
      scRenderShell();
    };
    $("scbody").addEventListener("input", function () { scMarkDirty(true); });
    $("scbody").addEventListener("change", function () { scMarkDirty(true); });
    $("scbody").addEventListener("click", scTargetAction);
    $("scrcancel").onclick = function () { scMarkDirty(false); scRenderBody(); toast(T("scCancelDone")); };
    $("scrdefault").onclick = scReset;
    $("scrsave").onclick = scSave;
    scMarkDirty(false);
    scRenderBody();
  }
  function scRenderBody() {
    var body = $("scbody");
    if (!body) return;
    if (SC.section === "session") body.innerHTML = scBodySession();
    else if (SC.section === "notify") body.innerHTML = scBodyNotify();
    else if (SC.section === "biz") body.innerHTML = scBodyBiz();
    else body.innerHTML = scBodySecurity();
    if (SC.section === "session") {
      var sel = $("scbttl"), inp = $("scbttlmin");
      if (sel && inp) sel.onchange = function () { inp.hidden = sel.value !== "custom"; scMarkDirty(true); };
    }
    if (SC.section === "notify") scWireNotify();
    if (SC.section === "security") {
      var tok = $("sctokbtn");
      if (tok) tok.onclick = function () { closeModal(); openTokens(); };
    }
  }

  /* ---- 登录与会话：本浏览器（localStorage） + 全局默认（settings 表） ---- */
  function scBodySession() {
    var d = SC.d;
    var localVal = null;
    try { localVal = parseInt(localStorage.getItem(TTL_LOCAL_KEY), 10); } catch (e) {}
    var localSet = Number.isInteger(localVal) && localVal >= 5 && localVal <= 43200;
    var g = parseInt(d.session_ttl_minutes, 10); if (!(g >= 5 && g <= 43200)) g = 30;
    var hit = false;
    if (localSet) {
      for (var i = 0; i < TTL_PRESETS.length; i++) if (TTL_PRESETS[i][0] === String(localVal)) hit = true;
    }
    var opts = TTL_PRESETS.map(function (x) {
      var sel = localSet && x[0] === String(localVal) ? " selected" : "";
      return '<option value="' + x[0] + '"' + sel + '>' + T(x[1]) + '</option>';
    }).join("")
      + '<option value="global"' + (localSet ? "" : " selected") + '>' + T("scFollowGlobal") + '</option>'
      + '<option value="custom"' + (localSet && !hit ? " selected" : "") + '>' + T("scCustom") + '</option>';
    var eff = localSet
      ? T("scEffLocal", { v: fmtMinutes(localVal) }) : T("scEffGlobal", { v: fmtMinutes(g) });
    var langCard = '<div class="setgrp"><h4>' + T("scLanguage") + scBadge("browser") + '</h4>'
      + scHelp(T("scLangHelp"))
      + '<div class="setrow"><label for="sclang">' + T("scLang") + '</label>'
      + '<select id="sclang" class="ds-select">' + langOptions() + '</select></div></div>';
    var pageCard = '<div class="setgrp"><h4>' + T("scPageSize") + scBadge("browser") + '</h4>'
      + scHelp(T("scPageSizeHelp"))
      + '<div class="setrow"><label for="sclimit">' + T("scPerPage") + '</label>'
      + '<select id="sclimit" class="ds-select">'
      + [10, 20, 50, 100].map(function (n) {
          return '<option value="' + n + '"' + (state.limit === n ? " selected" : "") + '>' + T("perPage", { n: n }) + '</option>';
        }).join("")
      + '</select></div></div>';
    return langCard + pageCard
      + '<div class="setgrp"><h4>' + T("scSessionBrowser") + scBadge("browser") + '</h4>'
      + '<div class="ds-alert">' + eff + '</div>'
      + '<div class="setrow"><label for="scbttl">' + T("scTtl") + '</label>'
      + '<select id="scbttl" class="ds-select">' + opts + '</select>'
      + '<input type="number" id="scbttlmin" class="ds-input" min="5" max="43200" inputmode="numeric"'
      + (localSet && !hit ? '' : ' hidden') + ' value="' + (localSet && !hit ? localVal : "") + '"'
      + ' aria-label="' + T("scCustom") + '" placeholder="5~43200"></div>'
      + scHelp(T("scHelpLocal"))
      + '</div>'
      + '<div class="setgrp"><h4>' + T("scSessionGlobal") + scBadge("global") + '</h4>'
      + '<div class="setrow"><label for="scgttl">' + T("scTtlGlobal") + '</label>'
      + '<input type="number" id="scgttl" class="ds-input" min="5" max="43200" inputmode="numeric" value="' + g + '"></div>'
      + scHelp(T("scHelpGlobal"))
      + '</div>';
  }

  /* ---- 通知：已配置推送卡片 ---- */
  function scTypeLabel(t) {
    return t === "verify" ? T("scTypeVerify") : (t === "sms" ? T("scTypeSms") : T("scTypeNotify"));
  }
  function scChannelSpec(chKey) {
    var list = ((SC.d && SC.d.notify_schema) || {}).channels || [];
    return list.filter(function (c) { return c.key === chKey; })[0] || null;
  }
  function scTargetRow(t, ch) {
    var parts = [];
    (ch.fields || []).forEach(function (f) {
      var v = (t.fields || {})[f.key] || {};
      if (f.sensitive) {
        if (v.configured || v.value) parts.push(v.masked || (nfLabel(f.key) + " ••••"));
      } else if (v.value) {
        parts.push(nfLabel(f.key) + " " + v.value);
      }
    });
    var types = (t.types && t.types.length ? t.types : ["verify", "sms", "notify"]).map(scTypeLabel).join(" · ");
    return '<div class="pushcard' + (t.enabled ? "" : " pushcard--off") + '">'
      + '<div class="pushcard-head"><span class="pushcard-name">' + esc(t.name) + '</span>'
      + '<span class="pushbadge">' + esc(scChannelName(ch)) + '</span>'
      + '<span class="pushbadge ' + (t.enabled ? "on" : "off") + '">'
      + esc(t.enabled ? T("scEnable") : T("scTargetOff")) + '</span></div>'
      + '<div class="pushcard-meta">' + esc(types) + '</div>'
      + '<div class="pushcard-fields">' + esc(parts.join(" · ") || T("scNotConfigured")) + '</div>'
      + '<div class="pushcard-acts">'
      + '<button class="tbtn" type="button" data-tgact="edit" data-tgid="' + esc(t.id) + '">' + esc(T("scEdit")) + '</button>'
      + '<button class="tbtn" type="button" data-tgact="test" data-tgid="' + esc(t.id) + '" data-tgch="' + esc(ch.key) + '">' + esc(T("scSendTest")) + '</button>'
      + '<button class="tbtn" type="button" data-tgact="toggle" data-tgid="' + esc(t.id) + '">' + esc(t.enabled ? T("scTargetOff") : T("scEnable")) + '</button>'
      + '<button class="tbtn" type="button" data-tgact="del" data-tgid="' + esc(t.id) + '">' + esc(T("del")) + '</button>'
      + '</div></div>';
  }
  /* ---- 通知：全局规则 + 各渠道 ---- */
  function scBodyNotify() {
    var d = SC.d;
    var schema = d.notify_schema || { channels: [], types: [], retry_max: 3 };
    var cfg = d.notify || { enabled: true, types: [], retry: 0, link: "", channels: {} };
    var dnd = getDND();
    var html = '<div class="setgrp"><h4>' + T("scBrowserPrefs") + scBadge("browser") + '</h4>'
      + scHelp(T("scBrowserPrefsHelp"))
      + '<div class="prefgrid">'
      + '<label class="prefitem" for="scautocopy"><span>' + T("autoCopy") + '</span><input type="checkbox" id="scautocopy" class="ds-check" ' + (state.autoCopy ? "checked" : "") + '></label>'
      + '<label class="prefitem" for="scnotifyon"><span>' + T("notifyOn") + '</span><input type="checkbox" id="scnotifyon" class="ds-check" ' + (state.notify ? "checked" : "") + '></label>'
      + '<label class="prefitem" for="scsoundon"><span>' + T("soundOn") + '</span><input type="checkbox" id="scsoundon" class="ds-check" ' + (state.sound ? "checked" : "") + '></label>'
      + '<label class="prefitem" for="scdndon"><span>' + T("sDnd") + '</span><input type="checkbox" id="scdndon" class="ds-check" ' + (dnd.on ? "checked" : "") + '></label>'
      + '</div>'
      + '<div class="setrow"><label>' + T("sDndRange") + '</label>'
      + '<input type="number" id="scdnds" class="ds-input" min="0" max="23" inputmode="numeric" value="' + (parseInt(dnd.start, 10) || 0) + '">'
      + '<span>' + T("to") + '</span>'
      + '<input type="number" id="scdnde" class="ds-input" min="0" max="23" inputmode="numeric" value="' + (parseInt(dnd.end, 10) || 0) + '"></div></div>'
      + '<div class="setgrp"><h4>' + T("scNotifyRules") + scBadge("global") + '</h4>'
      + scHelp(T("scNotifyHelp"))
      + '<div class="setrow"><label for="nfen">' + T("scNotifyEnabled") + '</label><input type="checkbox" id="nfen" class="ds-check" ' + (cfg.enabled ? "checked" : "") + '></div>'
      + '<div class="setrow"><label>' + T("scNotifyTypes") + '</label><span>';
    (schema.types || []).forEach(function (t) {
      var label = t === "verify" ? T("scTypeVerify") : (t === "sms" ? T("scTypeSms") : T("scTypeNotify"));
      html += '<label class="ds-inline"><input type="checkbox" class="ds-check" data-nftype="' + esc(t) + '" '
        + (cfg.types.indexOf(t) !== -1 ? "checked" : "") + '> ' + label + '</label>';
    });
    html += '</span></div><div class="setrow"><label for="nfretry">' + T("scRetry") + '</label><select id="nfretry" class="ds-select">';
    for (var i = 0; i <= (schema.retry_max || 0); i++) {
      html += '<option value="' + i + '" ' + (Number(cfg.retry) === i ? "selected" : "") + '>'
        + (i === 0 ? T("scNoRetry") : T("scRetryN", { n: i })) + '</option>';
    }
    html += '</select><span class="ds-help">' + T("scRetryHelp") + '</span></div>'
      + '<div class="setrow"><label for="nflink">' + T("scLink") + '</label>'
      + '<input type="text" id="nflink" class="ds-input" placeholder="' + T("scLinkPh") + '" value="'
      + esc(cfg.link || "") + '"></div></div>';

    /* 已配置推送：只展示已经创建好的推送卡片，每张可编辑/测试/启停/删除 */
    var targets = SC.targets || [];
    var cards = "";
    targets.forEach(function (tg) {
      var ch = scChannelSpec(tg.channel);
      if (ch) cards += scTargetRow(tg, ch);
    });
    html += '<div class="setgrp"><h4>' + T("scPushList") + scBadge("global")
      + '<span class="ds-badge">' + T("scChannelsN", { n: targets.length }) + '</span></h4>'
      + scHelp(T("scPushListHelp"))
      + (cards ? '<div class="pushlist">' + cards + '</div>' : '<div class="pushempty">' + T("scPushEmpty") + '</div>')
      + '<div class="setrow"><label></label><button class="ds-btn ds-btn--primary" id="pushadd" type="button">'
      + T("scAddPush") + '</button></div></div>';

    /* 环境变量渠道：仅展示已配置且未被推送卡片覆盖的渠道（只读，可停用/测试） */
    var envRows = "";
    (schema.channels || []).forEach(function (ch) {
      var st = cfg.channels[ch.key] || { enabled: true, configured: false };
      var hasTg = targets.some(function (x) { return x.channel === ch.key; });
      if (!st.configured || hasTg) return;
      envRows += '<div class="setrow"><label>' + esc(scChannelName(ch)) + '</label>'
        + '<span class="pushbadge">' + T(st.source === "db" ? "scFromDb" : "scFromEnv") + '</span>'
        + '<label class="ds-inline"><input type="checkbox" id="nf_' + ch.key + '_enabled" class="ds-check" '
        + (st.enabled ? "checked" : "") + '> ' + T("scEnable") + '</label>'
        + '<button class="ds-btn settest" id="nf_test_' + ch.key + '" type="button">' + T("scSendTest") + '</button></div>';
    });
    if (envRows) {
      /* 说明环境变量与设置的优先级，避免用户重复配置后困惑 */
      html += '<div class="setgrp"><h4>' + T("scEnvChannels") + scBadge("global") + '</h4>'
        + scHelp(T("scEnvChannelsHelp")) + scHelp(T("scEnvPriority")) + envRows + '</div>';
    }
    html += '<div class="setgrp"><h4>' + T("scImportEnv") + scBadge("global") + '</h4>'
      + scHelp(T("scImportEnvHelp"))
      + '<div class="setrow"><button class="ds-btn" id="nfimport" type="button">' + T("scImportEnv") + '</button></div>'
      + '<div class="ds-alert ds-alert--warning">' + T("scTestSaved") + '</div></div>';
    return html;
  }
  /* ---- 推送编辑器：第二层独立弹层（先选方案 → 再填配置） ---- */
  var PUSH = null;
  function openPushEditor(t) {
    if (t) {
      PUSH = { mode: "edit", channel: t.channel, id: t.id, name: t.name,
        types: (t.types || ["verify", "sms", "notify"]).slice(), enabled: !!t.enabled,
        fields: t.fields || {}, _new: !!t._new };
    } else {
      PUSH = { mode: "pick", channel: "", id: "", name: "", types: ["verify", "sms", "notify"],
        enabled: true, fields: {}, _new: true };
    }
    pushRender();
    $("pushmodal").hidden = false;
  }
  function closePushEditor() { $("pushmodal").hidden = true; PUSH = null; }
  function pushRender() {
    if (!PUSH) return;
    $("pushtitle").textContent = PUSH.mode === "edit" ? T("scPushEditor") : T("scAddPush");
    $("pushbody").innerHTML = PUSH.mode === "pick" ? pushPickHtml() : pushFormHtml();
  }
  function pushPickHtml() {
    var html = '<p class="pwdhelp">' + T("scPickChannelHelp") + '</p><div class="pushpicks">';
    (((SC.d || {}).notify_schema || {}).channels || []).forEach(function (ch) {
      html += '<button class="pushpick" type="button" data-pushch="' + esc(ch.key) + '">'
        + esc(scChannelName(ch)) + '</button>';
    });
    html += '</div><div class="pwdacts"><button class="ds-btn" type="button" data-pushact="cancel">'
      + T("cancel") + '</button></div>';
    return html;
  }
  function pushFormHtml() {
    var ch = scChannelSpec(PUSH.channel);
    if (!ch) return pushPickHtml();
    var html = '<span class="pushchan">' + esc(scChannelName(ch)) + '</span>'
      + '<div class="setrow"><label for="pfname">' + T("scPushName") + '</label>'
      + '<input type="text" id="pfname" class="ds-input" maxlength="64" autocomplete="off" placeholder="'
      + esc(T("scTargetNamePh")) + '" value="' + esc(PUSH.name) + '"></div>'
      + '<div class="setrow"><label>' + T("scPushTypes") + '</label><span>';
    ["verify", "sms", "notify"].forEach(function (t) {
      html += '<label class="ds-inline"><input type="checkbox" class="ds-check" data-pftype="' + t + '" '
        + (PUSH.types.indexOf(t) !== -1 ? "checked" : "") + '> ' + scTypeLabel(t) + '</label>';
    });
    html += '</span></div>' + scHelp(T("scPushTypesHelp"))
      + '<div class="setrow"><label for="pfon">' + T("scEnable") + '</label>'
      + '<input type="checkbox" id="pfon" class="ds-check" ' + (PUSH.enabled ? "checked" : "") + '></div>';
    (ch.fields || []).forEach(function (f) {
      var id = "pf_" + ch.key + "_" + f.key;
      var old = (PUSH.fields && PUSH.fields[f.key]) || {};
      if (f.sensitive) {
        var ph = old.configured ? T("scSensitivePhCfg", { m: old.masked || "••••" }) : T("scSensitivePhNew");
        html += '<div class="setrow"><label for="' + id + '">' + esc(nfLabel(f.key)) + '</label>'
          + '<input type="text" id="' + id + '" class="ds-input" autocomplete="off" spellcheck="false" placeholder="'
          + esc(ph) + '"></div>';
      } else {
        html += '<div class="setrow"><label for="' + id + '">' + esc(nfLabel(f.key)) + '</label>'
          + '<input type="text" id="' + id + '" class="ds-input" autocomplete="off" value="'
          + esc(old.value || "") + '"></div>';
      }
    });
    html += '<div class="ds-help">' + T("scPushRulesHelp") + '</div>'
      + '<div class="pwdacts">'
      + (PUSH.mode === "new" ? '<button class="ds-btn" type="button" data-pushact="back">' + T("scBack") + '</button>' : '')
      + '<button class="ds-btn" type="button" data-pushact="cancel">' + T("cancel") + '</button>'
      + '<button class="ds-btn ds-btn--primary" type="button" data-pushact="save">' + T("save") + '</button></div>';
    return html;
  }
  function pushSave() {
    var ch = scChannelSpec(PUSH.channel);
    if (!ch) { toast(T("scPickChannel")); return; }
    var nameEl = $("pfname"), name = nameEl ? nameEl.value.trim() : "";
    if (!name) { toast(T("scPushNameRequired")); if (nameEl) nameEl.focus(); return; }
    var types = [];
    var nodes = document.querySelectorAll("[data-pftype]");
    for (var i = 0; i < nodes.length; i++) if (nodes[i].checked) types.push(nodes[i].getAttribute("data-pftype"));
    if (!types.length) { toast(T("scPushNeedTypes")); return; }
    var need = ch.need || [];
    var fields = {}, ok = true;
    (ch.fields || []).forEach(function (f) {
      var el = $("pf_" + ch.key + "_" + f.key);
      var v = el ? el.value.trim() : "";
      var old = (PUSH.fields && PUSH.fields[f.key]) || {};
      if (!v) {
        if (f.sensitive && PUSH.mode === "edit" && old.configured) { fields[f.key] = old; return; }
        if (need.indexOf(f.key) !== -1) { toast(T("scPushFieldNeed", { f: nfLabel(f.key) })); ok = false; return; }
        fields[f.key] = { sensitive: !!f.sensitive, value: "", configured: false };
        return;
      }
      fields[f.key] = { sensitive: !!f.sensitive, value: v, configured: true };
    });
    if (!ok) return;
    var enabled = !!$("pfon").checked;
    if (PUSH.mode === "edit") {
      for (var j = 0; j < SC.targets.length; j++) {
        if (SC.targets[j].id === PUSH.id) {
          SC.targets[j] = { id: PUSH.id, channel: ch.key, name: name, enabled: enabled,
            types: types, fields: fields, configured: true, _new: !!PUSH._new };
          break;
        }
      }
      toast(T("scPushUpdated"));
    } else {
      SC.tgSeq += 1;
      /* 新推送用本地临时 id 参与行内操作；保存时 _new 不向上回传 id，由服务端分配 */
      SC.targets.push({ id: "__new" + SC.tgSeq, channel: ch.key, name: name, enabled: enabled,
        types: types, fields: fields, configured: true, _new: true });
      toast(T("scPushAdded"));
    }
    scMarkDirty(true);
    closePushEditor();
    scRenderBody();
  }
  /* 推送编辑器交互：选方案 / 返回 / 取消 / 保存（点遮罩关闭） */
  function pushEditorAction(ev) {
    var pick = ev.target && ev.target.closest ? ev.target.closest("[data-pushch]") : null;
    if (pick) {
      PUSH.channel = pick.getAttribute("data-pushch");
      PUSH.mode = "new";
      pushRender();
      return;
    }
    var act = ev.target && ev.target.closest ? ev.target.closest("[data-pushact]") : null;
    if (!act) return;
    var a = act.getAttribute("data-pushact");
    if (a === "cancel") { closePushEditor(); return; }
    if (a === "back") { PUSH.mode = "pick"; PUSH.channel = ""; pushRender(); return; }
    if (a === "save") pushSave();
  }
  function scTargetAction(ev) {
    var addBtn = ev.target && ev.target.closest ? ev.target.closest("#pushadd") : null;
    if (addBtn) { openPushEditor(null); return; }
    var b = ev.target && ev.target.closest ? ev.target.closest("[data-tgact]") : null;
    if (!b) return;
    var act = b.getAttribute("data-tgact"), id = b.getAttribute("data-tgid");
    var t = (SC.targets || []).filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    if (act === "toggle") {
      t.enabled = !t.enabled; scMarkDirty(true); scRenderBody(); return;
    }
    if (act === "edit") { openPushEditor(t); return; }
    if (act === "del") {
      if (!confirm(T("confirmDelN", { n: 1 }))) return;
      SC.targets = SC.targets.filter(function (x) { return x.id !== id; });
      scMarkDirty(true); scRenderBody(); toast(T("scTargetRemoved")); return;
    }
    if (act === "test") {
      if (t._new || !t.id) { toast(T("scTargetSaveFirst")); return; }
      b.disabled = true; b.setAttribute("data-loading", "1");
      fetch("/api/settings/notify/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: t.channel, target_id: t.id }),
      }).then(function (r) {
        if (r.status === 401) { location.reload(); return null; }
        return r.json();
      }).then(function (res) {
        b.disabled = false; b.removeAttribute("data-loading");
        if (!res) return;
        if (res.success) { toast(T("scTestOk")); return; }
        if (res.error === "NOT_CONFIGURED") { toast(T("scTestNotCfg")); return; }
        toast(res.message ? T("scTestFailMsg", { m: res.message }) : T("scTestFail"));
      }).catch(function () { b.disabled = false; b.removeAttribute("data-loading"); toast(T("scTestFail")); });
    }
  }
  function scWireNotify() {
    var schema = (SC.d.notify_schema) || { channels: [] };
    (schema.channels || []).forEach(function (ch) {
      var btn = $("nf_test_" + ch.key);
      if (!btn) return;
      btn.onclick = function () {
        btn.disabled = true; btn.setAttribute("data-loading", "1");
        fetch("/api/settings/notify/test", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: ch.key }),
        }).then(function (r) {
          if (r.status === 401) { location.reload(); return null; }
          return r.json();
        }).then(function (res) {
          btn.disabled = false; btn.setAttribute("data-loading", "0");
          if (!res) return;
          if (res.success) { toast(T("scTestOk")); return; }
          if (res.error === "NOT_CONFIGURED") { toast(T("scTestNotCfg")); return; }
          toast(res.message ? T("scTestFailMsg", { m: res.message }) : T("scTestFail"));
        }).catch(function () { btn.disabled = false; btn.setAttribute("data-loading", "0"); toast(T("scTestFail")); });
      };
    });
    var imp = $("nfimport");
    if (imp) imp.onclick = function () {
      imp.disabled = true; imp.setAttribute("data-loading", "1");
      fetch("/api/settings/notify/import-env", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      }).then(function (r) {
        if (r.status === 401) { location.reload(); return null; }
        return r.json();
      }).then(function (res) {
        imp.disabled = false; imp.setAttribute("data-loading", "0");
        if (!res) return;
        if (!res.success) { toast(res.error ? T("scImportFailMsg", { e: res.error }) : T("scImportFail")); return; }
        closeModal();
        toast(res.imported ? T("scImported", { n: res.imported }) : T("scNoImport"));
        openSettingsCenter("notify");
      }).catch(function () { imp.disabled = false; imp.setAttribute("data-loading", "0"); toast(T("scImportFail")); });
    };
  }

  /* ---- 数据与业务：保留天数 / 号码归属地 ---- */
  function scBodyBiz() {
    var d = SC.d;
    return '<div class="setgrp"><h4>' + T("scRetention") + scBadge("global") + '</h4>'
      + '<div class="setrow"><label for="sysdays">' + T("scDays") + '</label>'
      + '<input type="number" id="sysdays" class="ds-input" min="1" max="3650" inputmode="numeric" value="'
      + esc(String(d.retention_days || 30)) + '"></div>'
      + scHelp(T("scDaysHelp"))
      + '</div>'
      + '<div class="setgrp"><h4>' + T("scArea") + scBadge("global") + '</h4>'
      + '<div class="setrow"><label for="sysarea">' + T("scAreaEnable") + '</label>'
      + '<input type="checkbox" id="sysarea" class="ds-check" ' + (d.phone_area_enabled ? "checked" : "") + '></div>'
      + '<div class="setrow"><label for="sysareaapi">' + T("scAreaApi") + '</label>'
      + '<input type="text" id="sysareaapi" class="ds-input" placeholder="' + T("scAreaApiPh") + '" value="'
      + esc(d.phone_area_api || "") + '"></div>'
      + scHelp(T("scAreaHelp"))
      + '</div>';
  }

  /* ---- 安全：接入令牌（凭据加密属后续安全专项，本轮只做入口与说明） ---- */
  function scBodySecurity() {
    return '<div class="setgrp"><h4>' + T("scTokenTitle") + scBadge("global") + '</h4>'
      + scHelp(T("scTokenHelp"))
      + '<div class="setrow"><label>' + T("scManage") + '</label>'
      + '<button class="ds-btn" id="sctokbtn" type="button">' + T("scOpenTokens") + '</button></div>'
      + '<div class="ds-alert">' + T("scTokenAlert") + '</div>'
      + '</div>'
      + '<div class="setgrp"><h4>' + T("scLoginGuard") + scBadge("global") + '</h4>'
      + scHelp(T("scLoginGuardHelp"))
      + '</div>';
  }

  function scReset() {
    var what = "";
    if (SC.section === "session") what = T("scResetSession");
    else if (SC.section === "notify") what = T("scResetNotify");
    else if (SC.section === "biz") what = T("scResetBiz");
    else { toast(T("scResetNoDefault")); return; }
    if (!window.confirm(T("scResetConfirm", { what: what }))) return;
    askPassword(function () {
      if (SC.section === "session") {
        try { localStorage.removeItem(TTL_LOCAL_KEY); } catch (e) {}
        SC.d.session_ttl_minutes = 30;
      } else if (SC.section === "notify") {
        var schema = SC.d.notify_schema || { types: [] };
        SC.d.notify = SC.d.notify || {};
        SC.d.notify.enabled = true;
        SC.d.notify.types = (schema.types || []).slice();
        SC.d.notify.retry = 0;
        SC.d.notify.link = "";
      } else if (SC.section === "biz") {
        SC.d.retention_days = 30;
        SC.d.phone_area_enabled = true;
        SC.d.phone_area_api = "";
      }
      scRenderBody();
      scMarkDirty(true);
      toast(T("scResetFilled"));
    });
  }

  function scSave() {
    var btn = $("scrsave");
    if (SC.section === "security") { toast(T("scNoSave")); return; }
    /* 通知凭据与登录有效时间属敏感设置：保存前要求登录密码确认 */
    var raw = function () {
      if (SC.section === "session") return scSaveSession(btn);
      if (SC.section === "notify") return scSaveNotify(btn);
      return scSaveBiz(btn);
    };
    if (SC.section === "notify" || SC.section === "session") { askPassword(raw); return; }
    return raw();
  }
  function scPut(body, btn, okMsg) {
    scBusy(btn, true);
    return fetch("/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (r.status === 401) { location.reload(); return null; }
      return r.json();
    }).then(function (res) {
      scBusy(btn, false);
      if (!res) return false;
      if (res.success) {
        if (typeof res.revision === "number") SC.d.revision = res.revision;
        scMarkDirty(false);
        closeModal();
        toast(okMsg || T("saved"));
        return true;
      }
      if (res.error === "REVISION_CONFLICT") { toast(T("scRevisionConflict")); return false; }
      toast(res.error ? T("scSaveFailMsg", { e: res.error }) : T("scSaveFail"));
      return false;
    }).catch(function () { scBusy(btn, false); toast(T("scSaveFail")); return false; });
  }
  function scSaveSession(btn) {
    var sel = $("scbttl"), inp = $("scbttlmin"), gl = $("scgttl");
    var localChanged = false;
    if (sel) {
      if (sel.value === "global") {
        try { localStorage.removeItem(TTL_LOCAL_KEY); localChanged = true; } catch (e) {}
      } else {
        var v = sel.value === "custom" ? parseInt(inp && inp.value, 10) : parseInt(sel.value, 10);
        if (!Number.isInteger(v) || v < 5 || v > 43200) { toast(T("scTtlRange")); return; }
        try { localStorage.setItem(TTL_LOCAL_KEY, String(v)); localChanged = true; } catch (e) {}
      }
    }
    var g = parseInt(gl && gl.value, 10);
    if (!Number.isInteger(g) || g < 5 || g > 43200) { toast(T("scTtlRange")); return; }
    var lim = $("sclimit"), langEl = $("sclang");
    var newLimit = lim ? parseInt(lim.value, 10) : state.limit;
    if ([10, 20, 50, 100].indexOf(newLimit) === -1) newLimit = state.limit;
    var newLang = langEl ? langEl.value : LANG;
    var langChanged = !!(newLang && newLang !== LANG);
    var limitChanged = newLimit !== state.limit;
    function applyLocal() {
      try { localStorage.setItem("sms_perpage", String(newLimit)); } catch (e) {}
      state.limit = newLimit;
      if (langChanged) { try { localStorage.setItem("sms_lang", newLang); } catch (e) {} }
    }
    function afterSaved() {
      if (!langChanged) return;
      try {
        var u = new URL(location.href);
        u.searchParams.set("lang", newLang);
        location.replace(u.toString());
        return;
      } catch (e) { location.reload(); }
    }
    if (g !== parseInt(SC.d.session_ttl_minutes, 10)) {
      SC.d.session_ttl_minutes = g;
      applyLocal();
      return scPut({ revision: SC.d.revision, session_ttl_minutes: g }, btn, T("scSavedTtlGlobal")).then(function (ok) {
        if (ok) afterSaved();
      });
    }
    if (localChanged || limitChanged || langChanged) {
      applyLocal();
      scMarkDirty(false); closeModal(); toast(T("scSavedTtl"));
      afterSaved();
      return;
    }
    toast(T("scNoChanges"));
  }
  function scSaveNotify(btn) {
    /* 本浏览器偏好（消息开关 / 免打扰）：与全局通知规则同一次保存 */
    function saveBrowserPrefs() {
      var ac = $("scautocopy"), nb = $("scnotifyon"), sb = $("scsoundon"), dn = $("scdndon");
      if (ac) { state.autoCopy = ac.checked; try { localStorage.setItem("sms_autocopy", state.autoCopy ? "1" : "0"); } catch (e) {} }
      if (nb) {
        state.notify = nb.checked; try { localStorage.setItem("sms_notify", state.notify ? "1" : "0"); } catch (e) {}
        if (state.notify && window.Notification && Notification.permission === "default") Notification.requestPermission();
      }
      if (sb) { state.sound = sb.checked; try { localStorage.setItem("sms_sound", state.sound ? "1" : "0"); } catch (e) {} }
      if (dn) {
        var start = Math.min(23, Math.max(0, parseInt($("scdnds").value, 10) || 0));
        var end = Math.min(23, Math.max(0, parseInt($("scdnde").value, 10) || 0));
        try { localStorage.setItem("sms_dnd", JSON.stringify({ on: !!dn.checked, start: start, end: end })); } catch (e) {}
      }
    }
    saveBrowserPrefs();
    var types = [];
    var nodes = document.querySelectorAll("[data-nftype]");
    for (var i = 0; i < nodes.length; i++) if (nodes[i].checked) types.push(nodes[i].getAttribute("data-nftype"));
    if (!types.length) { toast(T("scKeepOneType")); return; }
    var schema = SC.d.notify_schema || { channels: [] };
    var body = {
      revision: SC.d.revision,
      notify: {
        enabled: !!$("nfen").checked,
        types: types,
        retry: parseInt($("nfretry").value, 10),
        link: $("nflink").value.trim(),
        channels: {},
      },
      clear: [],
    };
    /* 多目标：新目标携带完整字段；已保存目标不回传敏感明文，服务端按 id 合并 */
    var schemaCh = (SC.d.notify_schema || {}).channels || [];
    body.notify.targets = (SC.targets || []).map(function (tg) {
      var spec = schemaCh.filter(function (c) { return c.key === tg.channel; })[0];
      var fields = {};
      (spec ? spec.fields : []).forEach(function (f) {
        var v = (tg.fields || {})[f.key] || {};
        if (f.sensitive) {
          if (tg._new && (v.value || v.configured)) fields[f.key] = v.value || "";
        } else {
          fields[f.key] = v.value || "";
        }
      });
      var out = { channel: tg.channel, name: tg.name, enabled: !!tg.enabled, fields: fields,
        types: (tg.types && tg.types.length ? tg.types : ["verify", "sms", "notify"]).slice() };
      if (!tg._new && tg.id) out.id = tg.id;
      return out;
    });
    /* 仅提交页面上实际存在的渠道开关（已配置推送卡片和环境变量渠道） */
    (schema.channels || []).forEach(function (ch) {
      var en = $("nf_" + ch.key + "_enabled");
      if (!en) return;
      var c = { enabled: !!en.checked };
      ch.fields.forEach(function (f) {
        var el = $("nf_" + ch.key + "_" + f.key);
        if (!el) return;
        if (f.sensitive) {
          var v = el.value.trim();
          if (v) c[f.key] = v;
          var ck = $("clr_" + ch.key + "_" + f.key);
          if (ck && ck.checked) body.clear.push("notify." + ch.key + "." + f.key);
        } else {
          c[f.key] = el.value.trim();
        }
      });
      body.notify.channels[ch.key] = c;
    });
    return scPut(body, btn);
  }
  function scSaveBiz(btn) {
    var days = parseInt($("sysdays").value, 10);
    if (!Number.isInteger(days) || days < 1 || days > 3650) { toast(T("scDaysInvalid")); return; }
    var api = $("sysareaapi").value.trim();
    if (api && !/^(http|https):\/\/[^\s]+$/i.test(api)) { toast(T("scApiInvalid")); return; }
    SC.d.retention_days = days;
    SC.d.phone_area_enabled = !!$("sysarea").checked;
    SC.d.phone_area_api = api;
    return scPut({
      revision: SC.d.revision,
      retention_days: days,
      phone_area_enabled: SC.d.phone_area_enabled,
      phone_area_api: api,
    }, btn);
  }

  /* 兼容既有入口：菜单/旧调用仍可用，统一落到设置中心对应分组 */
  function openSessTtl() { openSettingsCenter("session"); }
  function openNotifySettings() { openSettingsCenter("notify"); }
  function openSystemSettings() { openSettingsCenter("biz"); }
  /* 顶部「设置」直接打开设置中心（原下拉菜单内容已迁入设置中心） */
  $("setbtn").onclick = function () { openSettingsCenter("session"); };
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
    if (suppressClick) { suppressClick = false; ev.preventDefault(); return; }
    /* 多选态：点击卡片空白区域切换选中；按钮/复选框保持原有行为 */
    if (state.selectMode) {
      var card = ev.target.closest ? ev.target.closest(".card") : null;
      if (card && !ev.target.closest("button,label,input,a")) { toggleSelCard(card); return; }
    }
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
    if (moreBtn) { openDetail(parseInt(moreBtn.getAttribute("data-id"), 10)); return; }
    var rbtn = ev.target.closest ? ev.target.closest(".rbtn") : null;
    if (rbtn) { readOne(parseInt(rbtn.getAttribute("data-id"), 10), rbtn); return; }
    var sumEl = ev.target.closest ? ev.target.closest(".summary") : null;
    if (sumEl) { openDetail(parseInt(sumEl.getAttribute("data-id"), 10)); return; }
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
  /* ---------- 批量选择（右键 / 长按进入，默认隐藏） ---------- */
  function setSelectMode(on) {
    state.selectMode = !!on;
    document.body.classList.toggle("selecting", state.selectMode);
    $("selbar").hidden = !state.selectMode;
    if (!state.selectMode) state.selected = {};
    syncSelBoxes();
    updateSelBar();
  }
  function toggleSelCard(card) {
    if (!card) return;
    var id = card.getAttribute("data-id");
    if (state.selected[id]) delete state.selected[id]; else state.selected[id] = true;
    var box = card.querySelector(".selbox");
    if (box) box.checked = !!state.selected[id];
    updateSelBar();
  }
  var pressTimer = null, pressCard = null, pressX = 0, pressY = 0, suppressClick = false;
  function cancelPress() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (pressCard) { pressCard.classList.remove("pressing"); pressCard = null; }
  }
  $("list").addEventListener("contextmenu", function (ev) {
    var card = ev.target.closest ? ev.target.closest(".card") : null;
    if (!card) return;
    ev.preventDefault();
    setSelectMode(true);
    if (!state.selected[card.getAttribute("data-id")]) toggleSelCard(card);
  });
  $("list").addEventListener("touchstart", function (ev) {
    var card = ev.target.closest ? ev.target.closest(".card") : null;
    if (!card) return;
    cancelPress();
    var t = ev.touches[0];
    pressX = t.clientX; pressY = t.clientY;
    pressCard = card;
    card.classList.add("pressing");
    pressTimer = setTimeout(function () {
      pressTimer = null;
      pressCard = null;
      card.classList.remove("pressing");
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 400);
      setSelectMode(true);
      if (!state.selected[card.getAttribute("data-id")]) toggleSelCard(card);
      if (navigator.vibrate) navigator.vibrate(10);
    }, 500);
  }, { passive: true });
  $("list").addEventListener("touchmove", function (ev) {
    var t = ev.touches[0];
    if (!t || !pressTimer) return;
    if (Math.abs(t.clientX - pressX) > 10 || Math.abs(t.clientY - pressY) > 10) cancelPress();
  }, { passive: true });
  $("list").addEventListener("touchend", cancelPress, { passive: true });
  $("list").addEventListener("touchcancel", cancelPress, { passive: true });
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
  $("selread").onclick = function () {
    var ids = Object.keys(state.selected).map(function (k) { return parseInt(k, 10); }).filter(function (n) { return n > 0; });
    if (!ids.length) return;
    var btn = $("selread");
    if (btn.disabled) return;
    btn.disabled = true;
    btn.setAttribute("data-loading", "1");
    fetch("/api/messages/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: ids, read: true }) })
      .then(function (r) { if (r.status === 401) { location.reload(); return new Promise(function () {}); } return r.json(); })
      .then(function (res) {
        btn.disabled = false;
        btn.removeAttribute("data-loading");
        if (!res || !res.success) { toast(T("bulkFail")); return; }
        if (res.failed) toast(T("bulkPartial", { ok: res.updated, ng: res.failed }));
        else toast(T("bulkOk", { n: res.updated }));
        if (typeof res.unread === "number") {
          state.unread = res.unread;
          var el = $("unreadcount");
          if (el) { el.textContent = state.unread; el.hidden = state.unread <= 0; }
        }
        setSelectMode(false);
        load();
      })
      .catch(function () { btn.disabled = false; btn.removeAttribute("data-loading"); toast(T("bulkFail")); });
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
    askPassword(function () {
      fetch("/api/messages/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: state.device, source: state.src, range: state.range, q: state.q }) })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d && d.success) { toast(T("clearedN", { n: d.removed })); state.selected = {}; load(); } });
    });
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
    if (e.key === "Escape") {
      var pm = $("pushmodal");
      if (pm && !pm.hidden) { closePushEditor(); return; }
      if (!$("modal").hidden) { closeModal(); return; }
      if (state.selectMode) setSelectMode(false);
    }
  });
  /* 横向滑轨：触屏用原生左右滑；桌面把纵向滚轮映射为横向滚动 */
  document.addEventListener("wheel", function (e) {
    var rail = e.target && e.target.closest ? e.target.closest(".ds-tabs,.modal-foot") : null;
    if (!rail || rail.scrollWidth <= rail.clientWidth) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      rail.scrollLeft += e.deltaY;
    }
  }, { passive: false });
  /* 弹层 + PWA + 搜索历史 */
  $("modalx").onclick = closeModal;
  $("modal").addEventListener("click", function (ev) { if (ev.target === $("modal")) closeModal(); });
  /* 重要操作密码确认：事件绑定 + 登录态探测（未开启登录则无需密码） */
  (function initPwdGate() {
    $("pwdcancel").onclick = pwdClose;
    $("pwdok").onclick = pwdSubmit;
    $("pwdinput").onkeydown = function (e) {
      if (e.key === "Enter") { e.preventDefault(); pwdSubmit(); }
      else if (e.key === "Escape") { e.preventDefault(); pwdClose(); }
    };
    $("pwdmodal").addEventListener("click", function (ev) { if (ev.target === $("pwdmodal")) pwdClose(); });
    $("pushmodal").addEventListener("click", function (ev) {
      if (ev.target === $("pushmodal")) { closePushEditor(); return; }
      pushEditorAction(ev);
    });
    fetch("/api/auth-state").then(function (r) { return r.json(); }).then(function (d) {
      state.pwdOn = !!(d && d.required);
    }).catch(function () {});
  })();
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
  ${DS_TOKENS_CSS}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: var(--ds-text-md)/var(--ds-leading) var(--ds-font-family);
         background: var(--ds-color-bg-page); color: var(--ds-color-text); display: flex; align-items: center;
         justify-content: center; min-height: 100vh; min-height: 100dvh;
         padding: calc(16px + env(safe-area-inset-top, 0px)) 16px calc(16px + env(safe-area-inset-bottom, 0px));
         -webkit-text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; }
  .box { background: var(--ds-color-bg-surface); border: 1px solid var(--ds-color-border);
         border-radius: var(--ds-radius-xl); box-shadow: var(--ds-shadow-2);
         padding: 28px 24px; width: 100%; max-width: 320px; text-align: center; position: relative; }
  h1 { font-size: var(--ds-text-xl); font-weight: var(--ds-weight-medium); margin-bottom: 16px; word-break: break-word; }
  input { width: 100%; padding: 11px 12px; border: 1px solid var(--ds-color-border);
          border-radius: var(--ds-radius-md); font-size: 16px; margin-bottom: 10px;
          background: var(--ds-color-bg-surface); color: var(--ds-color-text); }
  input:focus-visible { outline: 2px solid var(--ds-color-link); outline-offset: 1px; border-color: var(--ds-color-primary); }
  button#go { width: 100%; padding: 11px 0; border: none; border-radius: var(--ds-radius-md);
           background: var(--ds-color-primary); color: #fff; font-size: 15px; font-weight: var(--ds-weight-medium);
           cursor: pointer; touch-action: manipulation; min-height: 40px; }
  button#go:hover { background: var(--ds-color-primary-hover); }
  button#go:disabled { opacity: .6; cursor: not-allowed; }
  button#go:focus-visible, .langbtn:focus-visible { outline: 2px solid var(--ds-color-link); outline-offset: 2px; }
  .err { color: var(--ds-color-danger); font-size: var(--ds-text-xs); min-height: 18px; margin-top: 8px; }
  .langbtn { position: absolute; top: 8px; right: 10px; border: 1px solid var(--ds-color-border); background: none;
             color: var(--ds-color-text-secondary); border-radius: var(--ds-radius-sm); padding: 3px 8px;
             font-size: 11px; cursor: pointer; }
  .langmenu { position: fixed; z-index: 200; background: var(--ds-color-bg-surface); border: 1px solid var(--ds-color-border);
              border-radius: var(--ds-radius-lg); box-shadow: var(--ds-shadow-2); padding: 4px; min-width: 150px; }
  .langitem { padding: 8px 14px; border-radius: 7px; cursor: pointer; font-size: var(--ds-text-sm); white-space: nowrap;
              color: var(--ds-color-text); }
  .langitem:hover { background: var(--ds-color-bg-subtle); }
  .langitem.cur { color: var(--ds-color-link); font-weight: var(--ds-weight-medium); }
  .foot { color: var(--ds-color-text-tertiary); font-size: var(--ds-text-xs); margin-top: 14px; }
  .foot a { color: var(--ds-color-text-tertiary); }
</style>
</head>
<body>
<div class="box">
  <button class="langbtn" id="langbtn" type="button">🌐</button>
  <h1>__SITE_NAME__</h1>
  <input type="password" id="pw" data-i18n-ph="loginPw" placeholder="管理密码" autofocus autocomplete="current-password">
  <button id="go" data-i18n="loginBtn">登 录</button>
  <div class="err" id="err"></div>
  <div class="foot">© 2026 <a href="https://cbm.im/" target="_blank" rel="noopener noreferrer">左立方</a> · <a href="https://github.com/ShenDoyle/SMSToWeb" target="_blank" rel="noopener noreferrer">SMSToWeb</a> <span class="ver">__APP_VERSION__</span></div>
</div>
<script>
(function () {
  /* 登录页多语言：语言探测与主页面一致（?lang > localStorage > 浏览器语言），旧值 zh→zh-CN 归一化 */
  var LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt-BR"];
  var LANG = (function () {
    function norm(s) {
      var v = String(s || "").toLowerCase().replace(/_/g, "-");
      if (v === "zh" || v === "zh-cn" || v === "zh-hans") return "zh-CN";
      if (v === "zh-tw" || v === "zh-hk" || v === "zh-mo" || v === "zh-hant") return "zh-TW";
      if (v === "pt") return "pt-BR";
      return LANGS.indexOf(v) >= 0 ? v : "";
    }
    var v = "";
    try { v = norm(new URLSearchParams(location.search).get("lang")); } catch (e) {}
    if (!v) { try { v = norm(localStorage.getItem("sms_lang")); } catch (e) {} }
    if (!v) {
      var prefs = [];
      try { prefs = (navigator.languages && navigator.languages.length) ? Array.prototype.slice.call(navigator.languages) : []; } catch (e1) {}
      if (!prefs.length) { try { prefs = [navigator.language || navigator.userLanguage || ""]; } catch (e2) { prefs = [""]; } }
      for (var i = 0; i < prefs.length; i++) {
        v = norm(prefs[i]);
        if (!v) {
          var s2 = String(prefs[i] || "").toLowerCase().replace(/_/g, "-");
          if (s2.indexOf("zh") === 0) v = /-(tw|hk|mo|hant)/.test(s2) ? "zh-TW" : "zh-CN";
        }
        if (v) break;
      }
    }
    if (!v) v = "en"; /* 探测失败回退英语，绝不静默回退中文 */
    try { localStorage.setItem("sms_lang", v); } catch (e) {}
    return v;
  })();
  var D = {
    "zh-CN": { loginPw: "管理密码", loginBtn: "登 录", wrongPw: "密码错误",
               tooMany: "尝试次数过多，请 10 分钟后再试", loginFail: "登录失败", netErr: "网络错误",
               title: " - 登录", btnLang: "🌐", tipLang: "切换语言" },
    "zh-TW": { loginPw: "管理密碼", loginBtn: "登 入", wrongPw: "密碼錯誤",
               tooMany: "嘗試次數過多，請 10 分鐘後再試", loginFail: "登入失敗", netErr: "網路錯誤",
               title: " - 登入", btnLang: "🌐", tipLang: "切換語言" },
    en: { loginPw: "Admin password", loginBtn: "Sign in", wrongPw: "Wrong password",
          tooMany: "Too many attempts. Try again in 10 minutes.", loginFail: "Sign-in failed", netErr: "Network error",
          title: " - Sign in", btnLang: "🌐", tipLang: "Switch language" },
    ja: { loginPw: "管理パスワード", loginBtn: "ログイン", wrongPw: "パスワードが違います",
          tooMany: "試行回数が多すぎます。10 分後に再試行してください", loginFail: "ログインに失敗しました", netErr: "ネットワークエラー",
          title: " - ログイン", btnLang: "🌐", tipLang: "言語切替" },
    ko: { loginPw: "관리자 비밀번호", loginBtn: "로그인", wrongPw: "비밀번호가 틀렸습니다",
          tooMany: "시도 횟수가 너무 많습니다. 10분 후 다시 시도해 주세요", loginFail: "로그인 실패", netErr: "네트워크 오류",
          title: " - 로그인", btnLang: "🌐", tipLang: "언어 전환" },
    es: { loginPw: "Contraseña de administrador", loginBtn: "Iniciar sesión", wrongPw: "Contraseña incorrecta",
          tooMany: "Demasiados intentos. Reinténtalo en 10 minutos.", loginFail: "Error al iniciar sesión", netErr: "Error de red",
          title: " - Iniciar sesión", btnLang: "🌐", tipLang: "Cambiar idioma" },
    fr: { loginPw: "Mot de passe administrateur", loginBtn: "Se connecter", wrongPw: "Mot de passe incorrect",
          tooMany: "Trop de tentatives. Réessayez dans 10 minutes.", loginFail: "Échec de la connexion", netErr: "Erreur réseau",
          title: " - Connexion", btnLang: "🌐", tipLang: "Changer de langue" },
    de: { loginPw: "Admin-Passwort", loginBtn: "Anmelden", wrongPw: "Falsches Passwort",
          tooMany: "Zu viele Versuche. Bitte in 10 Minuten erneut versuchen.", loginFail: "Anmeldung fehlgeschlagen", netErr: "Netzwerkfehler",
          title: " - Anmelden", btnLang: "🌐", tipLang: "Sprache wechseln" },
    "pt-BR": { loginPw: "Senha de administrador", loginBtn: "Entrar", wrongPw: "Senha incorreta",
               tooMany: "Muitas tentativas. Tente novamente em 10 minutos.", loginFail: "Falha ao entrar", netErr: "Erro de rede",
               title: " - Entrar", btnLang: "🌐", tipLang: "Mudar idioma" }
  };
  function T(k) { return (D[LANG] && D[LANG][k]) || D.en[k] || k; }
  function apply() {
    document.documentElement.lang = LANG;
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
    /* 登录页九语言菜单（自名显示），选择后写入 localStorage 并整页重载 */
    var NAMES = { "zh-CN": "简体中文", "zh-TW": "繁體中文", "en": "English", "ja": "日本語", "ko": "한국어", "es": "Español", "fr": "Français", "de": "Deutsch", "pt-BR": "Português (BR)" };
    var b = document.getElementById("langbtn");
    if (!b) return;
    var menu = null;
    function close() { if (menu) { menu.remove(); menu = null; document.removeEventListener("click", close); } }
    b.onclick = function (ev) {
      ev.stopPropagation();
      if (menu) { close(); return; }
      menu = document.createElement("div");
      menu.className = "langmenu";
      for (var i = 0; i < LANGS.length; i++) {
        (function (code) {
          var it = document.createElement("div");
          it.className = "langitem" + (code === LANG ? " cur" : "");
          it.textContent = NAMES[code];
          it.onclick = function (e2) {
            e2.stopPropagation();
            if (code === LANG) { close(); return; }
            try { localStorage.setItem("sms_lang", code); } catch (e) {}
            try {
              var u = new URL(location.href);
              u.searchParams.set("lang", code);
              location.replace(u.toString());
            } catch (e) { location.reload(); }
          };
          menu.appendChild(it);
        })(LANGS[i]);
      }
      document.body.appendChild(menu);
      var r = b.getBoundingClientRect();
      menu.style.top = (r.bottom + 6) + "px";
      menu.style.right = Math.max(8, window.innerWidth - r.right) + "px";
      document.addEventListener("click", close);
    };
  })();
  var pw = document.getElementById("pw");
  var err = document.getElementById("err");
  var go = document.getElementById("go");
  var busy = false;
  function tryLogin() {
    if (busy) return;
    busy = true; go.disabled = true; err.textContent = "";
    /* 浏览器独立会话时长：本地配置随登录请求声明；服务端校验 5~43200，非法则清除坏配置回退全局默认 */
    var payload = { password: pw.value };
    try {
      var ttl = parseInt(localStorage.getItem("sms_ttl_min"), 10);
      if (Number.isInteger(ttl) && ttl >= 5 && ttl <= 43200) payload.session_ttl_minutes = ttl;
      else if (localStorage.getItem("sms_ttl_min") !== null) localStorage.removeItem("sms_ttl_min");
    } catch (e) {}
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).then(function (d) {
      busy = false; go.disabled = false;
      if (d && d.success) { location.reload(); return; }
      if (d && d.error === "INVALID_TTL") { try { localStorage.removeItem("sms_ttl_min"); } catch (e) {} }
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
  const cronRid = newRequestId();
  /* 定时清理路径同样自愈（覆盖 scheduled 触发时不经 fetch 入口的平台） */
  await ensureSchema(env, cronRid);
  const days = Math.max(1, parseInt(await getScalarSetting(env, "retention_days"), 10) || DEFAULT_RETENTION_DAYS);
  const res = await env.DB.prepare(
    `DELETE FROM messages WHERE received_at < datetime('now', ?1)`
  ).bind(`-${days} days`).run();
  const purged = await env.DB.prepare(
    `DELETE FROM messages WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-7 days')`
  ).run();
  logEvent("info", "cron_cleanup", "cron", env, cronRid, {
    retention_days: days,
    cleaned_old: res.meta ? res.meta.changes : 0,
    purged_deleted: purged.meta ? purged.meta.changes : 0,
  });
}

/* ---------------- schema 幂等自愈 ---------------- */

/* ==== SCHEMA_SQL BEGIN（由 platforms/gen_app.py 从根 schema.sql 同步，勿手工修改）==== */
const SCHEMA_SQL = `
-- SMS Gateway D1 schema
-- 设备表：device 列存 App 模板 name 字段（自定义设备名），device+sim 唯一；alias 为可选别名
CREATE TABLE IF NOT EXISTS devices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device     TEXT    NOT NULL DEFAULT 'unknown',
  sim        TEXT    NOT NULL DEFAULT '',
  alias      TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_key ON devices(device, sim);

-- 消息表：30 天保留，超期由 cron 清理；source 区分来源（sms=短信 / notify=通用推送，可自定义）
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   INTEGER NOT NULL REFERENCES devices(id),
  sender      TEXT    NOT NULL DEFAULT '',
  content     TEXT    NOT NULL DEFAULT '',
  received_at TEXT    NOT NULL,
  source      TEXT    NOT NULL DEFAULT 'sms',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at  TEXT,
  starred     INTEGER NOT NULL DEFAULT 0,
  read_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_device_time ON messages(device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(received_at);
-- 去重：同设备+发件人+内容+秒级时间 不重复入库
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup
  ON messages(device_id, sender, content, received_at);
-- 来源筛选索引
CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source, received_at DESC);

-- 已有库升级：为旧 messages 表补 source 列（新库执行上面的建表已包含，此句幂等报错可忽略）
-- ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'sms';
-- 已有库升级（软删除）：为旧 messages 表补 deleted_at 列（新库建表已包含；D1/Turso 旧库需手动执行一次）
-- ALTER TABLE messages ADD COLUMN deleted_at TEXT;
-- ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE messages ADD COLUMN read_at TEXT;

-- 接入令牌表：多命名令牌 + 单设备可吊销 + 哈希存储（明文只在创建/轮换时返回一次，库内只存 SHA-256）
-- expires_at：到期时间（UTC "YYYY-MM-DD HH:MM:SS"，NULL=永久；过期鉴权拒绝但不写 revoked_at，保留审计）
-- note：备注（便于区分令牌用途，默认空串）
CREATE TABLE IF NOT EXISTS tokens (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  token_hash    TEXT    NOT NULL,
  token_prefix  TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT,
  revoked_at    TEXT,
  expires_at    TEXT,
  note          TEXT    NOT NULL DEFAULT ''
);
-- 活跃令牌命名唯一（部分索引：吊销行保留原名作审计痕迹，不占用命名）
CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_name_active ON tokens(name) WHERE revoked_at IS NULL;
-- 鉴权主路径：按哈希精确查找（SHA-256 定长，唯一索引即防碰撞重复）
CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(token_hash);
-- 吊销过滤辅助索引（第 2 步鉴权与第 3 步后台列表按 revoked_at 过滤）
CREATE INDEX IF NOT EXISTS idx_tokens_revoked ON tokens(revoked_at);
-- 已有库升级（有效期/备注）：ensureSchema 按上方建表语句自动补列（PRAGMA + ALTER，幂等），无需手动执行
-- ALTER TABLE tokens ADD COLUMN expires_at TEXT;
-- ALTER TABLE tokens ADD COLUMN note TEXT NOT NULL DEFAULT '';

-- 设置表：服务端键值设置（当前仅 session_ttl_minutes 会话时长，分钟）。
-- ensureSchema 首请求自动建表（幂等）；读侧缺表/缺行/非法值一律回退默认，不阻断登录
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
/* ==== SCHEMA_SQL END ==== */

/* ---------------- 原子事务基础设施（阶段 1-3 · 第一提交点） ----------------
 * 统一入口：atomicBatch(env.DB, [{ sql, args }]) → { results: [{ changes, last_row_id }] }
 *
 * 三个平台的落地方式：
 *   D1（Cloudflare 原生 binding）——db.batch()，官方语义即 SQL 事务（任一语句失败整体回滚，
 *     返回逐语句 meta.changes）；本函数负责把异常按「确定失败 / 状态未知」分类，绝不误报成功。
 *   Turso——适配层 batchAtomic：3 个 RTT 显式事务（BEGIN / 写语句 / COMMIT）+ baton 流状态机。
 *   本地 SQLite——适配层 batchAtomic：连接级 FIFO 队列 + 事务内专用直连通道（_execDirect）。
 *
 * 错误语义（两个平台共用）：
 *   code="FAILED"  数据轴确定「本次事务未提交」（NOT_COMMITTED）→ 调用方可安全重试；
 *   code="UNKNOWN" 数据轴无法证明（COMMIT 已发出但结果未确认）→ 不得重试、不得对外报成功，
 *                  统一交给现有全局错误路径（500 + 结构化日志）。
 * 本阶段不做任何内部自动重试（S1 保守变体）。 */
class AtomicBatchError extends Error {
  constructor(code, phase, detail, cause) {
    super("atomic batch " + (code === "UNKNOWN" ? "状态未知" : "已失败") + "（" + String(phase || "-") + "）: " + String(detail || "-"));
    this.name = "AtomicBatchError";
    this.code = code === "UNKNOWN" ? "UNKNOWN" : "FAILED";
    this.phase = String(phase || "-");
    this.detail = String(detail || "");
    this.retryable = this.code === "FAILED";
    this.effectUnproven = this.code === "UNKNOWN";
    if (cause !== undefined) { try { this.cause = cause; } catch (_) { /* 只读宿主忽略 */ } }
  }
}

/* D1 异常分类：只有「语句级确定失败」才可判定整批已回滚（D1 batch 是 SQL 事务）；
   其余（网络中断 / 内部错误 / 无响应）一律按状态未知处理——宁可保守误报未知，不可误报未提交。
   证据等级：D1 batch 原子语义为官方文档确认；异常文本分类为设计推断，待 L3 真库验证。 */
const D1_CONFIRMED_FAILURE_RE = /constraint|syntax error|no such (table|column)|NOT NULL|datatype mismatch|UNIQUE|FOREIGN KEY|too many SQL variables/i;

function atomicErrText(e) {
  try { return String((e && e.message) || e || "unknown"); } catch (_) { return "unknown"; }
}

async function atomicBatch(db, statements) {
  if (!db || typeof db.prepare !== "function") throw new AtomicBatchError("FAILED", "prepare", "env.DB 不可用");
  if (!Array.isArray(statements)) throw new AtomicBatchError("FAILED", "prepare", "statements 必须是数组");
  if (!statements.length) return { results: [] }; /* 空批：不发任何请求，天然原子 */

  /* 适配层（Turso / 本地 SQLite）已实现两轴状态机：结构化错误原样透传，绝不吞掉 UNKNOWN */
  if (typeof db.batchAtomic === "function") {
    try {
      return await db.batchAtomic(statements);
    } catch (e) {
      if (e && (e.code === "UNKNOWN" || e.code === "FAILED")) throw e;
      /* 适配层抛出非结构化异常 = 无法判定所处阶段 ⇒ 保守按状态未知处理（绝不误判为可重试） */
      throw new AtomicBatchError("UNKNOWN", "adapter", atomicErrText(e), e);
    }
  }

  /* D1：原生 batch */
  if (typeof db.batch === "function") {
    let prepared;
    try {
      prepared = statements.map(function (s) {
        if (!s || typeof s.sql !== "string" || !s.sql) throw new Error("语句缺少 sql");
        const args = s.args === undefined || s.args === null ? [] : s.args;
        if (!Array.isArray(args)) throw new Error("语句 args 必须是数组");
        return db.prepare(s.sql).bind(...args);
      });
    } catch (e) {
      /* 准备阶段失败：没有任何语句发出（FAILED，可安全重试） */
      throw new AtomicBatchError("FAILED", "prepare", atomicErrText(e), e);
    }
    let out;
    try {
      out = await db.batch(prepared);
    } catch (e) {
      const msg = atomicErrText(e);
      if (D1_CONFIRMED_FAILURE_RE.test(msg)) throw new AtomicBatchError("FAILED", "execute", msg, e);
      /* 无响应 / 内部错误：无法证明未提交（唯一 UNKNOWN 来源） */
      throw new AtomicBatchError("UNKNOWN", "execute", msg, e);
    }
    if (!Array.isArray(out)) throw new AtomicBatchError("UNKNOWN", "execute", "D1 batch 返回结构异常");
    return {
      results: out.map(function (r) {
        const m = (r && r.meta) || {};
        return { changes: Number(m.changes) || 0, last_row_id: Number(m.last_row_id) || 0 };
      }),
    };
  }

  throw new AtomicBatchError("FAILED", "prepare", "env.DB 既不支持 batchAtomic 也不支持 batch");
}

/* 自愈完成的 DB 实例集合（WeakSet 按 env.DB 键控：每个库实例只自愈一次，多库/测试互不干扰） */

const schemaHealed = new WeakSet();
/* 第 4 步升级可观测：记录每个 DB 实例最近一次 schema 自愈结果（成功/失败 + 时间 + 错误摘要），
   经 GET /api/stats（管理接口，isAuthed）透出，供存量用户升级后自检；不落库、不引依赖。 */
const schemaStatus = new WeakMap();

/* 把内嵌 SCHEMA_SQL 拆成可独立执行的幂等语句（去注释行、按分号切分）。
   kind: "table"=CREATE TABLE / "index"=CREATE INDEX（含 UNIQUE INDEX）/ "other"=其余 */
function schemaStatements(kind) {
  const out = [];
  for (const raw of SCHEMA_SQL.split(";")) {
    const sql = raw.split("\n").filter(l => !l.trim().startsWith("--")).join("\n").trim();
    if (!sql) continue;
    const head = sql.slice(0, sql.indexOf("(") === -1 ? sql.length : sql.indexOf("(")).toUpperCase();
    const isIndex = head.includes("CREATE INDEX") || head.includes("CREATE UNIQUE INDEX");
    const isTable = head.includes("CREATE TABLE");
    if (kind === "table" && isTable) out.push(sql);
    else if (kind === "index" && isIndex) out.push(sql);
    else if (!kind && !isTable && !isIndex) out.push(sql);
  }
  return out;
}

/* 按顶层逗号切分 CREATE TABLE 主体：括号内的逗号（DEFAULT (datetime('now')) 等）
   与引号内的逗号不切分。schema.sql 与 sqlite_master 的实际 DDL 可能换行格式不同
   （同一行可写多列），必须按语法切分而不是按行切分，否则会误判缺列。 */
function splitTopLevelCommas(bodyText) {
  const out = [];
  let cur = "";
  let depth = 0;
  let quote = null;
  for (const ch of String(bodyText || "")) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/* 解析 CREATE TABLE 主体（括号内文本）→ { 列名: 列定义 }。schema.sql 与 sqlite_master 中的
   实际建表语句共用同一套解析，避免「期望结构」与「实际结构」两套判定口径漂移。 */
function parseTableColumns(bodyText) {
  const cols = {};
  for (const item of splitTopLevelCommas(String(bodyText || "").replace(/--[^\n]*/g, ""))) {
    const t = item.trim();
    if (!t) continue;
    const cm = t.match(/^([A-Za-z_]\w*)\s+([\s\S]+)$/);
    if (!cm) continue;
    if (["PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT"].includes(cm[1].toUpperCase())) continue;
    cols[cm[1]] = cm[2].trim();
  }
  return cols;
}

/* 从内嵌 SCHEMA_SQL 解析「表 → 列名 → 列定义」映射，用于缺列检测与自动补列。
   约束：ALTER TABLE ADD COLUMN 无法添加 PRIMARY KEY/UNIQUE 列；新增列须带默认值或可空（schema.sql 现有约定如此）。 */
function schemaColumnMap() {
  const map = {};
  for (const m of SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\)\s*;/g)) {
    map[m[1]] = parseTableColumns(m[2]);
  }
  return map;
}

/* schema 结构健康标记：写入 settings 表的保留键（键值表已存在，不新增表、不改既有列，
   与旧代码/旧库完全兼容）。值 = 内嵌 SCHEMA_SQL 派生的结构指纹。
   跳过完整自愈的必要条件：指纹一致 + sqlite_master 中期望的表、列、索引全部齐备；
   标记只是必要条件之一，实际结构证据来自同一次数据库查询；任何未知/缺失/异常一律回退完整 ensureSchema。 */
const SCHEMA_META_KEY = "schema_meta";

/* 当前代码期望的结构（派生自内嵌 SCHEMA_SQL，不手工维护，避免与 schema.sql 漂移） */
function schemaExpectation() {
  const colMap = schemaColumnMap();
  const tables = {};
  for (const t of Object.keys(colMap).sort()) tables[t] = Object.keys(colMap[t]).sort();
  const indexes = [];
  for (const sql of schemaStatements("index")) {
    const m = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(sql);
    if (m) indexes.push(m[1]);
  }
  return { tables: tables, indexes: indexes.sort() };
}

let schemaFingerprintCache = null;
/* 结构指纹：SCHEMA_SQL 增删表/列/索引 → 指纹变化 → 旧标记自动失效 → 回退完整自愈并重写标记 */
function schemaFingerprint() {
  if (schemaFingerprintCache) return schemaFingerprintCache;
  const ex = schemaExpectation();
  const tables = Object.keys(ex.tables).map(function (t) { return t + "(" + ex.tables[t].join(",") + ")"; });
  schemaFingerprintCache = "v1|" + tables.join(";") + "|" + ex.indexes.join(",");
  return schemaFingerprintCache;
}

/* 单条 SQL 一次取回：结构标记 + 期望表/索引在 sqlite_master 中的实际定义。
   Turso 每次 execute 即一次网络往返，本查询把「全部结构校验」压到 1 次往返；
   settings 表缺失时整条语句报错 → 调用方按「未知」回退完整自愈。
   表名/索引名均来自内嵌 SCHEMA_SQL（\w+ 字符集），不存在注入面。 */
function schemaProbeSql() {
  const ex = schemaExpectation();
  const names = function (list) { return list.map(function (n) { return "'" + n + "'"; }).join(","); };
  const parts = [
    "SELECT 'meta:" + SCHEMA_META_KEY + "' AS k, value AS v FROM settings WHERE key = '" + SCHEMA_META_KEY + "'",
    "SELECT 'table:' || name AS k, COALESCE(sql, '') AS v FROM sqlite_master WHERE type = 'table' AND name IN (" + names(Object.keys(ex.tables)) + ")",
  ];
  if (ex.indexes.length) {
    parts.push("SELECT 'index:' || name AS k, '' AS v FROM sqlite_master WHERE type = 'index' AND name IN (" + names(ex.indexes) + ")");
  }
  return parts.join(" UNION ALL ");
}

/* 去掉 CREATE TABLE 语句的外层括号，取出列定义主体（第一个 '(' 到最后一个 ')'） */
function tableBodyFromDdl(ddl) {
  const m = /\(([\s\S]*)\)/.exec(String(ddl || ""));
  return m ? m[1] : "";
}

/* 结构快速校验：1 次数据库调用完成「版本 + 表 + 列 + 索引」四项核对。
   返回 true = 可安全跳过完整自愈；任何异常/未知/不匹配一律 false（回退完整 ensureSchema）。
   不把模块级缓存当作结构正确性的证据——每次实例冷启动都重新向数据库取证。 */
async function schemaFastCheck(env) {
  try {
    const res = await env.DB.prepare(schemaProbeSql()).all();
    const rows = (res && res.results) || [];
    const seen = {};
    for (const r of rows) if (r && r.k !== undefined) seen[String(r.k)] = r.v;
    if (seen["meta:" + SCHEMA_META_KEY] !== schemaFingerprint()) return false;
    const ex = schemaExpectation();
    for (const t of Object.keys(ex.tables)) {
      const ddl = seen["table:" + t];
      if (typeof ddl !== "string" || !ddl) return false;
      const actual = parseTableColumns(tableBodyFromDdl(ddl));
      for (const c of ex.tables[t]) {
        if (!Object.prototype.hasOwnProperty.call(actual, c)) return false;
      }
    }
    for (const n of ex.indexes) if (!Object.prototype.hasOwnProperty.call(seen, "index:" + n)) return false;
    return true;
  } catch (e) {
    /* 缺表/缺列/语法或连接异常 = 状态未知：绝不当作健康，回退完整自愈 */
    return false;
  }
}

/* 完整自愈成功后写结构标记（1 次数据库调用）。写失败不影响本次请求（自愈已完成），
   但不会留下标记 → 下次请求重新完整自愈，安全降级。 */
async function markSchemaHealthy(env) {
  try {
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .bind(SCHEMA_META_KEY, schemaFingerprint()).run();
  } catch (e) { /* 标记写失败：不阻断、不误报，下次完整自愈 */ }
}

/* 幂等自愈：快速校验（1 次往返）→ 不匹配才执行完整迁移（建表 → 补列 → 建索引 → 写标记）。
   任何失败仅告警不阻断主流程（静默降级），且不标记完成——下次请求自动重试。
   覆盖六平台：D1 / Turso / 本地 SQLite 三类适配层均支持 prepare→all/run、sqlite_master 与 PRAGMA。 */
async function ensureSchema(env, requestId = "-") {
  if (!env || !env.DB || schemaHealed.has(env.DB)) return;
  /* 快路径：结构指纹 + 实际表/列/索引全部匹配才跳过完整迁移（证据每次来自数据库本身） */
  if (await schemaFastCheck(env)) {
    schemaHealed.add(env.DB);
    schemaStatus.set(env.DB, { state: "ok", at: nowUTC(), error: "" });
    return;
  }
  try {
    /* 顺序有讲究：建表 → 补列 → 建索引。索引可能引用新列，
       若先建索引，旧库缺列会导致索引创建失败并中断自愈，补列永远执行不到 */
    for (const sql of schemaStatements("table")) await env.DB.prepare(sql).run();
    const colMap = schemaColumnMap();
    for (const table of Object.keys(colMap)) {
      const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
      const have = new Set((info.results || []).map(r => String(r.name || "")));
      for (const [col, def] of Object.entries(colMap[table])) {
        if (have.has(col)) continue;
        try {
          await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
        } catch (e) {
          /* 并发首请求可能同时补同一列：重复列错误视为成功 */
          if (!/duplicate column/i.test(String(e && e.message || e))) throw e;
        }
      }
    }
    for (const sql of schemaStatements("index")) await env.DB.prepare(sql).run();
    schemaHealed.add(env.DB);
    schemaStatus.set(env.DB, { state: "ok", at: nowUTC(), error: "" });
    /* 标记必须最后写：只有完整迁移全部成功才设置，中途失败绝不留下「已完成」证据 */
    await markSchemaHealthy(env);
  } catch (e) {
    /* 失败同样记录：管理页统计弹窗可见「最近自愈失败 + 原因」，未标记完成 → 下次请求自动重试 */
    schemaStatus.set(env.DB, { state: "failed", at: nowUTC(), error: String((e && e.message) || e).slice(0, 200) });
    logEvent("warn", "schema_heal_failed", "schema", env, requestId, { error: logErrorInfo(e) });
  }
}

/* ---------------- 接入令牌数据层（多命名令牌 + 单设备可吊销 + 哈希存储） ----------------
 * 数据层供接入鉴权 verifyInboundToken（第 2 步已接 /api/receive、/api/push）与
 * 第 3 步管理 API/后台 UI 复用；/api/cron 不纳入库内令牌（只认环境变量）。
 * 安全原则：明文只在 createToken/rotateToken 返回一次（调用方负责只展示一次）；
 * 库内只存 SHA-256 哈希（token_hash 唯一索引精确命中即鉴权主路径，SHA-256 定长无长度泄漏）；
 * listTokens 永不返回明文或哈希；吊销写 revoked_at 保留审计痕迹，不物理删除。 */

const TOKEN_NAME_MAX = 64;
const TOKEN_NAME_RE = /^[A-Za-z0-9_-]+$/;
/* 备注最大长度：便于区分令牌用途（创建传入、列表展示、轮换透传），超长在 API 层拒绝（INVALID_NOTE → 400） */
const TOKEN_NOTE_MAX = 200;
/* last_used_at 节流阈值（秒）：距上次更新超过该值才写库。
   避免每条消息一次写放大（D1 免费额度写入次数有限）；阈值 60s 兼顾统计精度与写入成本 */
const TOKEN_TOUCH_INTERVAL = 60;

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}

/* 创建命名令牌：opts 可带 note（备注，超长静默截断到 TOKEN_NOTE_MAX，API 层负责拒绝）与
   expires_at（UTC "YYYY-MM-DD HH:MM:SS"，NULL/未传 = 永久；格式由 API 层 parseTokenExpiry 校验）。
   返回 { ok, id, token（明文，仅此一次）, expires_at }；重名/非法名返回 { ok:false, error } */
async function createToken(env, name, opts) {
  const n = String(name || "").trim();
  if (!n || n.length > TOKEN_NAME_MAX || !TOKEN_NAME_RE.test(n)) {
    return { ok: false, error: "INVALID_NAME" };
  }
  const o = opts && typeof opts === "object" ? opts : {};
  const note = String(o.note === undefined || o.note === null ? "" : o.note).trim().slice(0, TOKEN_NOTE_MAX);
  const expiresAt = o.expires_at ? String(o.expires_at) : null;
  const plain = "smsw_" + randHex(32);
  const id = randHex(16);
  try {
    await env.DB.prepare(
      "INSERT INTO tokens (id, name, token_hash, token_prefix, created_at, expires_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, n, await sha256Hex(plain), plain.slice(0, 12), nowUTC(), expiresAt, note).run();
  } catch (e) {
    /* 活跃命名唯一（部分唯一索引 idx_tokens_name_active）：重名创建拒绝 */
    if (/unique/i.test(String(e && e.message || e))) return { ok: false, error: "NAME_TAKEN" };
    throw e;
  }
  return { ok: true, id, token: plain, expires_at: expiresAt };
}

/* 后台列表（第 3 步用）：永不返回明文与哈希；活跃在前，其余按创建时间倒序；含有效期与备注 */
async function listTokens(env) {
  const rows = await env.DB.prepare(
    "SELECT id, name, token_prefix, created_at, last_used_at, revoked_at, expires_at, note FROM tokens ORDER BY (revoked_at IS NULL) DESC, created_at DESC, id"
  ).all();
  return rows.results || [];
}

/* 鉴权查找（第 2 步用）：按哈希精确命中，返回行（含 revoked_at/expires_at，由鉴权层判断有效性）或 null */
async function findTokenByHash(env, hash) {
  const row = await env.DB.prepare(
    "SELECT id, name, token_hash, token_prefix, created_at, last_used_at, revoked_at, expires_at FROM tokens WHERE token_hash = ?"
  ).bind(String(hash || "")).first();
  return row || null;
}

/* 吊销：写 revoked_at（幂等）。revoked=false 表示令牌不存在或本就未激活 */
async function revokeToken(env, id) {
  const r = await env.DB.prepare(
    "UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"
  ).bind(nowUTC(), String(id || "")).run();
  return { ok: true, revoked: ((r.meta && r.meta.changes) || 0) > 0 };
}

/* 轮换 = 吊销旧 + 建新同名（旧行吊销后让出活跃命名，部分唯一索引保证不冲突）。
   新令牌沿用原备注与有效期（可预期、可审计：轮换不偷偷续期；已过期的令牌轮换后依然不可用，
   需要续期请吊销后重建）。返回 { ok, id, token（新明文，仅此一次）, expires_at }；
   极小概率窗口（吊销后建新失败）时透传错误 */
async function rotateToken(env, id) {
  const old = await env.DB.prepare("SELECT name, note, expires_at FROM tokens WHERE id = ? AND revoked_at IS NULL")
    .bind(String(id || "")).first();
  if (!old) return { ok: false, error: "NOT_FOUND" };
  const rv = await revokeToken(env, id);
  if (!rv.revoked) return { ok: false, error: "NOT_FOUND" };
  const created = await createToken(env, old.name, { note: old.note, expires_at: old.expires_at });
  if (!created.ok) return created;
  return created;
}

/* 重命名（仅活跃令牌；名称规则与创建一致；仅改展示名，不影响哈希/有效期/最近使用） */
async function renameToken(env, id, name) {
  const n = String(name || "").trim();
  if (!n || n.length > TOKEN_NAME_MAX || !TOKEN_NAME_RE.test(n)) return { ok: false, error: "INVALID_NAME" };
  const row = await env.DB.prepare("SELECT id FROM tokens WHERE id = ? AND revoked_at IS NULL")
    .bind(String(id || "")).first();
  if (!row) return { ok: false, error: "NOT_FOUND" };
  try {
    const r = await env.DB.prepare("UPDATE tokens SET name = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(n, String(id)).run();
    return { ok: true, changed: ((r.meta && r.meta.changes) || 0) > 0, name: n };
  } catch (e) {
    if (/unique/i.test(String(e && e.message || e))) return { ok: false, error: "NAME_TAKEN" };
    throw e;
  }
}

/* 记录最后使用时间（第 2 步鉴权命中后调用）。
   节流：单语句条件更新——last_used_at 为空或早于 cutoff 才写，省一次读往返 */
async function touchLastUsed(env, id) {
  const cutoff = new Date(Date.now() - TOKEN_TOUCH_INTERVAL * 1000).toISOString().replace("T", " ").slice(0, 19);
  await env.DB.prepare(
    "UPDATE tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)"
  ).bind(nowUTC(), String(id || ""), cutoff).run();
}

/* 有效期判定：expires_at 为空 = 永久；非空值与 nowUTC() 同构（UTC "YYYY-MM-DD HH:MM:SS"，
   字符串比较即时间比较）。过期令牌软失效：鉴权视同无效，但不写 revoked_at，保留审计痕迹 */
function isTokenExpired(expiresAt) {
  const e = String(expiresAt === undefined || expiresAt === null ? "" : expiresAt).trim();
  return !!e && e < nowUTC();
}

/* ---------------- 接入鉴权（第 2 步）：单一校验函数，/api/receive 与 /api/push 共用 ----------------
 * 平滑迁移：库内令牌优先——SHA-256 哈希精确命中且未吊销（revoked_at IS NULL）、未过期（expires_at），命中即 touchLastUsed；
 * 环境变量 RECEIVE_TOKEN 兜底——迁移期存量接入继续有效，全部令牌入库后可设
 * DISABLE_RECEIVE_TOKEN="true" 停用兜底（默认未设 = 兜底启用），只认库内令牌。
 * fail-closed：兜底停用或 RECEIVE_TOKEN 未配置且库内无命中 → 一律拒绝；DB 异常向上抛 → 500，同样拒绝。
 * token 来源（沿用原 handler 解析优先级「query 优先于 body」，新增两种请求头携带为超集扩展）：
 *   X-Receive-Token 头 → ?token= query → Authorization: Bearer → body.token（由调用方传入） */
async function verifyInboundToken(request, env, url, bodyToken) {
  const header = String(request.headers.get("X-Receive-Token") || "").trim();
  const query = url.searchParams.get("token") || "";
  const bearer = String(request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const provided = header || query || bearer || String(bodyToken || "");
  if (!provided) return false;

  /* 1) 库内令牌优先：哈希精确命中且未吊销、未过期才放行
     （吊销行/过期行命中后落入环境变量兜底判定，天然 fail-closed） */
  const row = await findTokenByHash(env, await sha256Hex(provided));
  if (row && row.revoked_at === null && !isTokenExpired(row.expires_at)) {
    await touchLastUsed(env, row.id);
    return true;
  }

  /* 2) 环境变量兜底：仅字符串 "true"（忽略大小写/空白）视为停用，与 ENABLE_AUTH 开关语义一致 */
  if (String(env.DISABLE_RECEIVE_TOKEN || "").trim().toLowerCase() !== "true" &&
      env.RECEIVE_TOKEN && safeEqual(provided, env.RECEIVE_TOKEN)) {
    return true;
  }
  return false;
}

/* ---------------- 接入令牌管理 API（第 3 步）：创建 / 列表 / 吊销 / 轮换 ----------------
 * 鉴权：四个路径均不在 isPublicApi 白名单 → 路由层统一 isAuthed 会话鉴权，未登录一律 401。
 * CSRF 防护选型：强制 Content-Type: application/json（简单请求不可伪造该头，跨站带 JSON
 * 内容类型必触发 CORS 预检；本服务 ACAO:* 无凭据 + 会话 Cookie SameSite=Lax，跨站写请求
 * 既过不了预检也带不上会话）。不选 Origin/Referer 同源校验：反代/网关场景 Origin 可能
 * 缺失或被剥离，误杀风险高。写操作另复用 allowWrite 限速（每 IP 120 次/分）。
 * 错误码约定：NAME_TAKEN / INVALID_NAME / INVALID_NOTE / INVALID_EXPIRY → 400；NOT_FOUND → 404；其余 500（全局 catch，
 * 不透内部错误原文）。明文仅创建/轮换成功时返回一次；列表永不返回明文与哈希。
 * 吊销语义：不存在 id → 404（与轮换一致，防粘错 id 误判成功）；重复吊销已吊销 id → 幂等成功。 */

/* CSRF 闸门：写接口仅接受 application/json（容忍 ; charset 等参数） */
function tokenApiJsonOnly(request) {
  const ct = String(request.headers.get("Content-Type") || "").trim().toLowerCase();
  return ct === "application/json" || ct.startsWith("application/json;");
}

async function readTokenApiBody(request) {
  try { return await request.json(); } catch { return null; }
}

/* 有效期参数解析（创建令牌用）：
   - expires_in_days：正整数天数，自当前 UTC 起算（1 ~ 36500 天，0/空/未传 = 永久）；
   - expires_at："YYYY-MM-DD"（视为当日 UTC 23:59:59 到期）或 "YYYY-MM-DD HH:MM:SS"（原样语义）；
   - 两者都传时 expires_in_days 优先；均未传 = 永久（expires_at 存 NULL）。
   返回 { ok:true, expires_at } 或 { ok:false }（调用方回 INVALID_EXPIRY → 400）。
   存储值与 nowUTC() 同构（UTC "YYYY-MM-DD HH:MM:SS"），isTokenExpired 字符串比较即时间比较；
   ISO 严格解析顺带拒绝 2026-02-30 这类不存在的日期。 */
function parseTokenExpiry(body) {
  const days = body.expires_in_days;
  if (days !== undefined && days !== null && days !== "") {
    const d = Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 36500) return { ok: false };
    return { ok: true, expires_at: new Date(Date.now() + d * 86400000).toISOString().replace("T", " ").slice(0, 19) };
  }
  const raw = String(body.expires_at === undefined || body.expires_at === null ? "" : body.expires_at).trim();
  if (!raw) return { ok: true, expires_at: null };
  let stamp = "";
  let expected = "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) { stamp = raw + "T23:59:59Z"; expected = raw + " 23:59:59"; }
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) { stamp = raw.replace(" ", "T") + "Z"; expected = raw; }
  else return { ok: false };
  const t = Date.parse(stamp);
  if (Number.isNaN(t)) return { ok: false };
  /* 回读校验：V8 对越界 ISO 日期（如 2026-02-30）会走宽松解析回退并顺延到实存日期，
     必须确认解析结果与预期逐字一致，否则按非法处理 */
  const back = new Date(t).toISOString().replace("T", " ").slice(0, 19);
  if (back !== expected) return { ok: false };
  return { ok: true, expires_at: back };
}

async function handleListTokens(env) {
  const rows = await listTokens(env);
  /* now 供前端判定「已过期」：客户端时钟不可信，统一用服务端 UTC 时间比较 */
  return json({ success: true, list: rows, now: nowUTC() });
}

async function handleCreateToken(request, env) {
  if (!tokenApiJsonOnly(request)) return json({ success: false, error: "invalid content type" }, 400);
  if (!allowWrite(request)) return json({ success: false, error: "too many requests" }, 429);
  const body = await readTokenApiBody(request);
  if (!body) return json({ success: false, error: "invalid json" }, 400);
  const note = String(body.note === undefined || body.note === null ? "" : body.note).trim();
  if (note.length > TOKEN_NOTE_MAX) return json({ success: false, error: "INVALID_NOTE" }, 400);
  const ex = parseTokenExpiry(body);
  if (!ex.ok) return json({ success: false, error: "INVALID_EXPIRY" }, 400);
  const r = await createToken(env, body.name, { note: note, expires_at: ex.expires_at });
  if (!r.ok) {
    if (r.error === "INVALID_NAME" || r.error === "NAME_TAKEN") return json({ success: false, error: r.error }, 400);
    return json({ success: false, error: "internal error" }, 500);
  }
  return json({ success: true, id: r.id, name: String(body.name === undefined || body.name === null ? "" : body.name).trim(), token_prefix: r.token.slice(0, 12), expires_at: r.expires_at, token: r.token });
}

async function handleRevokeToken(request, env) {
  if (!tokenApiJsonOnly(request)) return json({ success: false, error: "invalid content type" }, 400);
  if (!allowWrite(request)) return json({ success: false, error: "too many requests" }, 429);
  const body = await readTokenApiBody(request);
  if (!body) return json({ success: false, error: "invalid json" }, 400);
  const id = String(body.id === undefined || body.id === null ? "" : body.id).trim();
  /* 先查存在性：区分「不存在 → 404」与「已吊销 → 幂等成功」（数据层 revokeToken 两者同为 revoked:false） */
  const row = await env.DB.prepare("SELECT id, revoked_at FROM tokens WHERE id = ?").bind(id).first();
  if (!row) return json({ success: false, error: "NOT_FOUND" }, 404);
  if (row.revoked_at !== null) return json({ success: true, revoked: false, already_revoked: true });
  const rv = await revokeToken(env, id);
  if (!rv.ok) return json({ success: false, error: "internal error" }, 500);
  return json({ success: true, revoked: true });
}

async function handleRotateToken(request, env) {
  if (!tokenApiJsonOnly(request)) return json({ success: false, error: "invalid content type" }, 400);
  if (!allowWrite(request)) return json({ success: false, error: "too many requests" }, 429);
  const body = await readTokenApiBody(request);
  if (!body) return json({ success: false, error: "invalid json" }, 400);
  const id = String(body.id === undefined || body.id === null ? "" : body.id).trim();
  const r = await rotateToken(env, id);
  if (!r.ok) {
    if (r.error === "NOT_FOUND") return json({ success: false, error: "NOT_FOUND" }, 404);
    if (r.error === "INVALID_NAME" || r.error === "NAME_TAKEN") return json({ success: false, error: r.error }, 400);
    return json({ success: false, error: "internal error" }, 500);
  }
  return json({ success: true, id: r.id, token_prefix: r.token.slice(0, 12), expires_at: r.expires_at, token: r.token });
}

async function handleRenameToken(request, env) {
  if (!tokenApiJsonOnly(request)) return json({ success: false, error: "invalid content type" }, 400);
  if (!allowWrite(request)) return json({ success: false, error: "too many requests" }, 429);
  const body = await readTokenApiBody(request);
  if (!body) return json({ success: false, error: "invalid json" }, 400);
  const id = String(body.id === undefined || body.id === null ? "" : body.id).trim();
  const r = await renameToken(env, id, body.name);
  if (!r.ok) {
    if (r.error === "NOT_FOUND") return json({ success: false, error: "NOT_FOUND" }, 404);
    if (r.error === "INVALID_NAME" || r.error === "NAME_TAKEN") return json({ success: false, error: r.error }, 400);
    return json({ success: false, error: "internal error" }, 500);
  }
  return json({ success: true, id: id, name: r.name, changed: r.changed });
}

/* ---------------- 服务端设置（settings 键值表） ----------------
 * PERF25：通知渠道配置、通知开关/规则/重试、数据保留天数、号码归属地接入参数全部入库。
 * 安全边界：ADMIN_PASSWORD / SESSION_SECRET / RECEIVE_TOKEN 等登录与鉴权凭据仍只走环境变量；
 * schema_meta（结构指纹）与 settings_rev（并发修订号）为保留键，普通设置读写一律拒绝。
 * 读取：GET 一次 `SELECT key, value WHERE key <> 'schema_meta'` 取回整组设置；
 * 写入：单次原子批（删除 + 条件 UPSERT + 修订号自增），条件语句全部绑定同一修订号，
 *       并发写入只有一个批次生效，另一个批次 0 命中 → 409，绝不出现半写状态；
 *       写入成功后重新从数据库读回逐项比对，比对不符即返回失败（不假报成功）。
 * 敏感字段：API 只返回「是否已配置 + 末 4 位」；保存时空值表示不修改，显式清除必须走 clear 列表。 */
const SETTINGS_ENV_KEYS = ["session_ttl_minutes", "retention_days", "phone_area_enabled", "phone_area_api"];

function maskSettingValue(v) {
  const s = String(v === undefined || v === null ? "" : v);
  if (!s) return "";
  return s.length > 4 ? "••••" + s.slice(-4) : "••••";
}

function isAllowedSettingKey(k) {
  if (SETTINGS_ENV_KEYS.indexOf(k) !== -1) return true;
  if (k === "notify.enabled" || k === "notify.types" || k === "notify.retry" || k === "notify.link" || k === "notify.targets") return true;
  if (!isNotifyKey(k)) return false;
  const parts = String(k).split(".");
  if (parts.length !== 3) return false;
  const spec = NOTIFY_CHANNELS[parts[1]];
  if (!spec) return false;
  return parts[2] === "enabled" || Object.prototype.hasOwnProperty.call(spec.fields, parts[2]);
}

function isSensitiveSettingKey(k) {
  if (!isNotifyKey(k)) return false;
  const parts = String(k).split(".");
  if (parts.length !== 3 || parts[2] === "enabled") return false;
  const spec = NOTIFY_CHANNELS[parts[1]];
  const field = spec && spec.fields[parts[2]];
  return !!(field && field.sensitive);
}

/* 单项值校验/规范化：返回 { ok, value } 或 { ok:false } */
function normalizeSettingValue(k, raw) {
  if (SETTINGS_ENV_KEYS.indexOf(k) !== -1) {
    const v = coerceScalar(k, raw);
    return v === null ? { ok: false } : { ok: true, value: v };
  }
  if (k === "notify.enabled" || k === "notify.types" || k === "notify.retry" || k === "notify.link") {
    if (k === "notify.enabled") {
      const v = coerceScalar("phone_area_enabled", raw);
      return v === null ? { ok: false } : { ok: true, value: v };
    }
    if (k === "notify.types") {
      const uniq = normalizeNotifyTypeList(raw);
      if (!uniq) return { ok: false };
      /* 去重且保持固定顺序，便于前后端一致比对 */
      return { ok: true, value: uniq.join(",") };
    }
    if (k === "notify.retry") {
      const s = String(raw === undefined || raw === null ? "" : raw).trim();
      if (!/^\d+$/.test(s)) return { ok: false };
      const n = parseInt(s, 10);
      if (n < 0 || n > NOTIFY_RETRY_MAX) return { ok: false };
      return { ok: true, value: String(n) };
    }
    /* notify.link：空串=清除；否则必须 http(s) */
    const s = String(raw === undefined || raw === null ? "" : raw).trim();
    if (!s) return { ok: true, value: "" };
    if (s.length > 500 || !/^https?:\/\//i.test(s)) return { ok: false };
    return { ok: true, value: s };
  }
  const parts = String(k).split(".");
  const spec = NOTIFY_CHANNELS[parts[1]];
  const field = parts[2];
  if (field === "enabled") {
    const v = coerceScalar("phone_area_enabled", raw);
    return v === null ? { ok: false } : { ok: true, value: v };
  }
  const meta = spec && spec.fields[field];
  if (!meta) return { ok: false };
  let s = String(raw === undefined || raw === null ? "" : raw).trim();
  if (s === "") return { ok: true, value: "" };
  if (s.length > 4000) return { ok: false };
  if (field === "urls") {
    const list = s.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    if (!list.length || list.some(function (u) { return !/^https?:\/\//i.test(u); })) return { ok: false };
    return { ok: true, value: list.join(",") };
  }
  if (field === "headers") {
    try {
      const obj = JSON.parse(s);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false };
    } catch (e) { return { ok: false }; }
    return { ok: true, value: s };
  }
  if ((field === "webhook" || field === "url") && s.length > 1000) return { ok: false };
  if ((field === "webhook" || field === "url") && !/^https?:\/\//i.test(s)) return { ok: false };
  return { ok: true, value: s };
}

/* 整组读取（排除保留键 schema_meta；库异常 → null 表示回退环境变量） */
async function loadAllSettings(env) {
  try {
    const res = await env.DB.prepare("SELECT key, value FROM settings WHERE key <> 'schema_meta'").all();
    const out = {};
    for (const r of (res && res.results) || []) {
      if (!r || r.key === undefined || r.key === null) continue;
      const k = String(r.key);
      if (k === "schema_meta") continue; /* 双保险：保留键永不返回 */
      out[k] = String(r.value === undefined || r.value === null ? "" : r.value);
    }
    return out;
  } catch (e) { return null; }
}

function scalarFromRows(env, name, all) {
  const spec = SCALAR_SETTINGS[name];
  let raw;
  if (all && all[name] !== undefined) raw = all[name];
  else raw = spec.env ? (env && env[spec.env]) : "";
  const v = coerceScalar(name, raw);
  return v === null ? spec.def : v;
}

function notifyTargetView(t) {
  const spec = NOTIFY_CHANNELS[t.channel];
  const fields = {};
  for (const f of Object.keys(spec.fields)) {
    const v = String(t.fields[f] === undefined || t.fields[f] === null ? "" : t.fields[f]);
    if (spec.fields[f].sensitive) fields[f] = { sensitive: true, configured: !!v, masked: maskSettingValue(v) };
    else fields[f] = { sensitive: false, value: v };
  }
  return {
    id: t.id, channel: t.channel, name: t.name, enabled: !!t.enabled,
    types: (t.types || NOTIFY_TYPES).slice(),
    configured: spec.need.every(function (f) { return !!t.fields[f]; }),
    fields: fields,
  };
}
/* 多目标校验/规范化：敏感字段留空 = 沿用同 id 旧值（编辑时不回传明文）；无 id 的新目标自动生成 */
function normalizeNotifyTargets(raw, existing) {
  if (!Array.isArray(raw)) return { ok: false };
  if (raw.length > 50) return { ok: false };
  const old = (existing || []).reduce(function (m, t) { if (t && t.id) m[t.id] = t; return m; }, {});
  const out = [];
  const seen = {};
  for (const t of raw) {
    if (!t || typeof t !== "object" || Array.isArray(t)) return { ok: false };
    const channel = String(t.channel || "");
    const spec = NOTIFY_CHANNELS[channel];
    if (!spec) return { ok: false };
    const name = String(t.name === undefined || t.name === null ? "" : t.name).trim();
    if (!name || name.length > TOKEN_NAME_MAX) return { ok: false };
    /* 卡片级接收类型：未传 → 默认全部（兼容旧客户端）；传入但无有效项 → 拒绝 */
    let types = NOTIFY_TYPES.slice();
    if (t.types !== undefined) {
      const ty = normalizeNotifyTypeList(t.types);
      if (!ty) return { ok: false };
      types = ty;
    }
    const id = String(t.id || "").trim() || ("nt_" + randHex(8));
    /* 同一批次内 id 必须唯一，避免一个 id 被多条目标复用 */
    if (seen[id]) return { ok: false };
    seen[id] = true;
    const prev = old[id] || {};
    /* 敏感字段沿用旧值必须同时满足「同一 id + 同一渠道」，禁止跨渠道复用凭据 */
    if (prev.channel && prev.channel !== channel) return { ok: false };
    const fields = {};
    for (const f of Object.keys(spec.fields)) {
      let v = String((t.fields && t.fields[f]) === undefined || (t.fields && t.fields[f]) === null ? "" : t.fields[f]).trim();
      if (!v && spec.fields[f].sensitive) v = String((prev.fields && prev.fields[f]) || "");
      if (v === "") { fields[f] = ""; continue; }
      const r = normalizeSettingValue(notifyFieldKey(channel, f), v);
      if (!r.ok) return { ok: false };
      fields[f] = r.value;
    }
    out.push({ id: id, channel: channel, name: name, enabled: t.enabled !== false, types: types, fields: fields });
  }
  return { ok: true, value: JSON.stringify(out) };
}

function notifyConfigView(cfg) {
  const channels = {};
  for (const name of Object.keys(NOTIFY_CHANNELS)) {
    const spec = NOTIFY_CHANNELS[name];
    const ch = cfg.channels[name];
    const fields = {};
    for (const f of Object.keys(spec.fields)) {
      const v = String(ch.fields[f] === undefined || ch.fields[f] === null ? "" : ch.fields[f]);
      if (spec.fields[f].sensitive) {
        fields[f] = { sensitive: true, configured: !!v, masked: maskSettingValue(v) };
      } else {
        fields[f] = { sensitive: false, value: v };
      }
    }
    channels[name] = {
      label: spec.label, enabled: ch.enabled, configured: ch.configured,
      source: (ch.fromEnv ? "env" : (ch.fromDb ? "db" : "env")), fields: fields,
    };
  }
  return {
    enabled: cfg.enabled, types: cfg.types.slice(), retry: cfg.retry, link: cfg.link,
    channels: channels,
    targets: (cfg.targets || []).map(notifyTargetView),
  };
}

function notifySchemaView() {
  const channels = Object.keys(NOTIFY_CHANNELS).map(function (name) {
    const spec = NOTIFY_CHANNELS[name];
    return {
      key: name, label: spec.label,
      /* need：前端编辑器用于必填校验；fields 用于输入框渲染 */
      need: spec.need.slice(),
      fields: Object.keys(spec.fields).map(function (f) {
        return { key: f, sensitive: !!spec.fields[f].sensitive };
      }),
    };
  });
  return { types: NOTIFY_TYPES.slice(), retry_max: NOTIFY_RETRY_MAX, channels: channels };
}

async function getSettingsRevision(env) {
  const map = await readSettingsKeys(env, ["settings_rev"]);
  const n = parseInt(map.settings_rev, 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/* 原子写入 + 修订号保护 + 写后回读验证 */
async function saveSettingsEntries(env, writes, deletes, clientRev) {
  const keys = Object.keys(writes || {});
  const dels = Array.isArray(deletes) ? deletes.filter(function (k, i, a) { return a.indexOf(k) === i; }) : [];
  const currentRev = await getSettingsRevision(env);
  if (keys.length === 0 && dels.length === 0) return { ok: true, revision: currentRev, saved: 0 };
  if (clientRev !== undefined && clientRev !== null && clientRev !== "") {
    const r = parseInt(clientRev, 10);
    if (!Number.isInteger(r) || r !== currentRev) {
      return { ok: false, error: "REVISION_CONFLICT", status: 409, revision: currentRev };
    }
  }
  const expected = String(currentRev);
  const nextRev = currentRev + 1;
  const stmts = [{ sql: "INSERT OR IGNORE INTO settings (key, value) VALUES ('settings_rev', ?1)", args: [expected] }];
  for (const k of dels) {
    if (isReservedSettingsKey(k)) continue;
    stmts.push({
      sql: "DELETE FROM settings WHERE key = ?1 AND key <> 'schema_meta' AND key <> 'settings_rev'"
        + " AND (SELECT value FROM settings WHERE key = 'settings_rev') = ?2",
      args: [k, expected],
    });
  }
  for (const k of keys) {
    if (isReservedSettingsKey(k)) continue;
    stmts.push({
      sql: "INSERT INTO settings (key, value) SELECT ?1, ?2 WHERE"
        + " (SELECT value FROM settings WHERE key = 'settings_rev') = ?3"
        + " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [k, String(writes[k]), expected],
    });
  }
  stmts.push({
    sql: "UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)"
      + " WHERE key = 'settings_rev' AND value = ?1",
    args: [expected],
  });
  let out;
  try { out = await atomicBatch(env.DB, stmts); }
  catch (e) {
    return { ok: false, error: "SETTINGS_SAVE_FAILED", status: 500, unknown: !!(e && e.code === "UNKNOWN") };
  }
  const revResult = out && out.results && out.results[out.results.length - 1];
  if (!revResult || Number(revResult.changes) !== 1) {
    /* 并发写入抢先：本批次所有条件语句 0 命中、修订号未推进 → 整批等价未生效 */
    return { ok: false, error: "REVISION_CONFLICT", status: 409, revision: await getSettingsRevision(env) };
  }
  /* 写后回读：逐项比对，防止适配层「返回成功但实际未落库」 */
  const verifyKeys = ["settings_rev"].concat(keys, dels);
  const verify = await readSettingsKeys(env, verifyKeys);
  for (const k of keys) {
    if (String(verify[k] === undefined ? "" : verify[k]) !== String(writes[k])) {
      return { ok: false, error: "SETTINGS_VERIFY_FAILED", status: 500, revision: nextRev };
    }
  }
  for (const k of dels) if (verify[k] !== undefined) {
    return { ok: false, error: "SETTINGS_VERIFY_FAILED", status: 500, revision: nextRev };
  }
  if (parseInt(verify.settings_rev, 10) !== nextRev) {
    return { ok: false, error: "SETTINGS_VERIFY_FAILED", status: 500, revision: nextRev };
  }
  return { ok: true, revision: nextRev, saved: keys.length + dels.length };
}

async function handleGetSettings(env) {
  const all = await loadAllSettings(env);
  if (!all) return json({ success: false, error: "SETTINGS_READ_FAILED" }, 500);
  const notifyRows = {};
  for (const k of Object.keys(all)) if (isNotifyKey(k)) notifyRows[k] = all[k];
  const cfg = resolveNotifyConfig(env, notifyRows);
  const revision = parseInt(all.settings_rev, 10) || 0;
  let ttl = parseInt(scalarFromRows(env, "session_ttl_minutes", all), 10);
  /* 兼容旧部署把 3600（秒）当成分钟保存：按默认 30 分钟展示与生效 */
  if (ttl === 3600) ttl = SESSION_TTL_DEFAULT_MIN;
  return json({
    success: true,
    revision: revision,
    session_ttl_minutes: ttl,
    retention_days: parseInt(scalarFromRows(env, "retention_days", all), 10),
    phone_area_enabled: scalarFromRows(env, "phone_area_enabled", all) === "true",
    phone_area_api: scalarFromRows(env, "phone_area_api", all),
    notify: notifyConfigView(cfg),
    notify_schema: notifySchemaView(),
  });
}

async function handlePutSettings(request, env) {
  if (!tokenApiJsonOnly(request)) return json({ success: false, error: "invalid content type" }, 400);
  if (!allowWrite(request)) return json({ success: false, error: "too many requests" }, 429);
  const body = await readTokenApiBody(request);
  if (!body) return json({ success: false, error: "invalid json" }, 400);

  const writes = {};
  const deletes = [];
  const addValue = function (k, raw) {
    if (isReservedSettingsKey(k) || !isAllowedSettingKey(k)) return false;
    /* 敏感字段空值 = 不修改（显式清除必须走 clear） */
    if (isSensitiveSettingKey(k) && String(raw === undefined || raw === null ? "" : raw).trim() === "") return true;
    const r = normalizeSettingValue(k, raw);
    if (!r.ok) return false;
    /* 全局登录时长：3600 视作旧部署「秒」误存，统一按 30 分钟写入，避免旧值继续生效 */
    writes[k] = (k === "session_ttl_minutes" && r.value === "3600") ? String(SESSION_TTL_DEFAULT_MIN) : r.value;
    return true;
  };

  /* 兼容旧接口：顶层直接携带 session_ttl_minutes */
  if (body.session_ttl_minutes !== undefined) {
    if (!addValue("session_ttl_minutes", body.session_ttl_minutes)) {
      return json({ success: false, error: "INVALID_TTL" }, 400);
    }
  }
  for (const k of SETTINGS_ENV_KEYS) {
    if (k === "session_ttl_minutes") continue;
    if (body[k] !== undefined && !addValue(k, body[k])) {
      return json({ success: false, error: "INVALID_SETTING", setting: k }, 400);
    }
  }
  if (body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)) {
    for (const k of Object.keys(body.settings)) {
      if (isReservedSettingsKey(k)) return json({ success: false, error: "RESERVED_KEY", setting: k }, 400);
      if (!addValue(k, body.settings[k])) {
        return json({ success: false, error: "INVALID_SETTING", setting: k }, 400);
      }
    }
  }
  if (body.notify && typeof body.notify === "object" && !Array.isArray(body.notify)) {
    const n = body.notify;
    if (n.enabled !== undefined && !addValue("notify.enabled", n.enabled)) {
      return json({ success: false, error: "INVALID_SETTING", setting: "notify.enabled" }, 400);
    }
    if (n.types !== undefined && !addValue("notify.types", n.types)) {
      return json({ success: false, error: "INVALID_SETTING", setting: "notify.types" }, 400);
    }
    if (n.retry !== undefined && !addValue("notify.retry", n.retry)) {
      return json({ success: false, error: "INVALID_SETTING", setting: "notify.retry" }, 400);
    }
    if (n.link !== undefined && !addValue("notify.link", n.link)) {
      return json({ success: false, error: "INVALID_SETTING", setting: "notify.link" }, 400);
    }
    if (n.targets !== undefined) {
      const cur = await readSettingsKeys(env, ["notify.targets"]);
      let old = [];
      try { old = JSON.parse(cur["notify.targets"] || "[]"); } catch (e) { old = []; }
      const r = normalizeNotifyTargets(n.targets, Array.isArray(old) ? old : []);
      if (!r.ok) return json({ success: false, error: "INVALID_TARGETS" }, 400);
      writes["notify.targets"] = r.value;
    }
    if (n.channels && typeof n.channels === "object" && !Array.isArray(n.channels)) {
      for (const ch of Object.keys(n.channels)) {
        if (!NOTIFY_CHANNELS[ch]) return json({ success: false, error: "INVALID_SETTING", setting: "notify." + ch }, 400);
        const c = n.channels[ch];
        if (!c || typeof c !== "object" || Array.isArray(c)) {
          return json({ success: false, error: "INVALID_SETTING", setting: "notify." + ch }, 400);
        }
        if (c.enabled !== undefined) {
          const k = notifyFieldKey(ch, "enabled");
          if (!addValue(k, c.enabled)) return json({ success: false, error: "INVALID_SETTING", setting: k }, 400);
        }
        for (const f of Object.keys(c)) {
          if (f === "enabled") continue;
          const k = notifyFieldKey(ch, f);
          if (!addValue(k, c[f])) return json({ success: false, error: "INVALID_SETTING", setting: k }, 400);
        }
      }
    }
  }
  if (Array.isArray(body.clear)) {
    for (const raw of body.clear) {
      const k = String(raw);
      if (isReservedSettingsKey(k)) {
        return json({ success: false, error: "RESERVED_KEY", setting: k }, 400);
      }
      if (!isAllowedSettingKey(k)) {
        return json({ success: false, error: "INVALID_SETTING", setting: k }, 400);
      }
      delete writes[k];
      const parts = k.split(".");
      if (isNotifyKey(k) && parts.length === 3 && parts[2] !== "enabled") {
        /* 渠道字段明确清除 → 写入空串（空串会遮蔽环境变量兜底，避免「删了又回退」）；
           渠道开关/全局规则清除 → 删除键，回退默认值 */
        writes[k] = "";
      } else {
        deletes.push(k);
      }
    }
  }
  if (Object.keys(writes).length === 0 && deletes.length === 0) {
    /* 空操作：仍回读当前修订号，语义与保存成功一致 */
    const rev = await getSettingsRevision(env);
    return json({ success: true, revision: rev, saved: 0 });
  }
  const saved = await saveSettingsEntries(env, writes, deletes, body.revision);
  if (!saved.ok) {
    return json({ success: false, error: saved.error, revision: saved.revision }, saved.status || 500);
  }
  const payload = { success: true, revision: saved.revision, saved: saved.saved };
  if (writes.session_ttl_minutes !== undefined) payload.session_ttl_minutes = Number(writes.session_ttl_minutes);
  return json(payload);
}

/* 发送一条测试通知：只测指定渠道，绕过总开关/类型规则/渠道开关，便于启用前验证配置 */
async function handleTestNotify(request, env) {
  if (!tokenApiJsonOnly(request)) return json({ success: false, error: "invalid content type" }, 400);
  if (!allowWrite(request)) return json({ success: false, error: "too many requests" }, 429);
  const body = await readTokenApiBody(request);
  if (!body) return json({ success: false, error: "invalid json" }, 400);
  const channel = String(body.channel || "");
  if (!NOTIFY_CHANNELS[channel]) return json({ success: false, error: "INVALID_CHANNEL" }, 400);
  const targetId = String(body.target_id || "");
  const cfg = await loadNotifyConfig(env);
  if (targetId) {
    const tg = (cfg.targets || []).filter(function (x) { return x.id === targetId && x.channel === channel; })[0];
    if (!tg || !NOTIFY_CHANNELS[channel].need.every(function (f) { return !!tg.fields[f]; })) {
      return json({ success: false, error: "NOT_CONFIGURED" }, 400);
    }
  } else if (!cfg.channels[channel] || !cfg.channels[channel].configured) {
    return json({ success: false, error: "NOT_CONFIGURED" }, 400);
  }
  const results = await dispatchNotify(env, {
    title: "SMSToWeb 测试通知",
    content: "这是一条设置页触发的测试通知；收到即表示该渠道配置可用。",
    time: new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC",
    source: "notify", sender: "SMSToWeb", device: "设置页",
  }, { only: channel, target_id: targetId, collect: true, config: cfg, _test: true });
  const r = results && results[0];
  if (!r) return json({ success: false, error: "NOT_CONFIGURED" }, 400);
  if (!r.ok) return json({ success: false, error: "SEND_FAILED", message: r.error || "" }, 502);
  return json({ success: true, channel: channel, target_id: targetId || undefined });
}

/* 把当前环境变量里的通知配置一次性写入数据库（迁移入口；已存在的键不覆盖） */
async function handleImportNotifyEnv(request, env) {
  if (!tokenApiJsonOnly(request)) return json({ success: false, error: "invalid content type" }, 400);
  if (!allowWrite(request)) return json({ success: false, error: "too many requests" }, 429);
  const body = await readTokenApiBody(request);
  if (!body) return json({ success: false, error: "invalid json" }, 400);
  const existing = await loadNotifyRows(env);
  if (!existing) return json({ success: false, error: "SETTINGS_READ_FAILED" }, 500);
  const writes = {};
  for (const name of Object.keys(NOTIFY_CHANNELS)) {
    const spec = NOTIFY_CHANNELS[name];
    for (const f of Object.keys(spec.fields)) {
      const k = notifyFieldKey(name, f);
      if (existing[k] !== undefined) continue; /* 数据库已有该键：不覆盖 */
      const v = trimEnv(env && env[spec.fields[f].env]);
      if (!v) continue;
      const r = normalizeSettingValue(k, v);
      if (!r.ok) return json({ success: false, error: "INVALID_ENV_VALUE", setting: k }, 400);
      writes[k] = r.value;
    }
  }
  if (existing["notify.link"] === undefined && trimEnv(env && env.NOTIFY_LINK)) {
    const r = normalizeSettingValue("notify.link", trimEnv(env && env.NOTIFY_LINK));
    if (r.ok && r.value) writes["notify.link"] = r.value;
  }
  if (!Object.keys(writes).length) {
    return json({ success: true, imported: 0, revision: await getSettingsRevision(env) });
  }
  const saved = await saveSettingsEntries(env, writes, [], undefined);
  if (!saved.ok) return json({ success: false, error: saved.error }, saved.status || 500);
  return json({ success: true, imported: Object.keys(writes).length, revision: saved.revision });
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

    /* requestId 服务端生成：只认这里产出的值，不读取任何客户端同名请求头（防伪造） */
    const requestId = newRequestId();
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...CORS } });

    try {
      /* schema 幂等自愈：每个 DB 实例仅首次请求执行（缺表建表/缺列补列，失败不阻断） */
      await ensureSchema(env, requestId);

      /* 登录开关：开启后，除推送接口与登录/登出外，页面与管理 API 均需登录 */
      const isPage = path === "/" || path === "/index.html";
      const isPublicApi = path === "/api/receive" || path === "/api/push" || path === "/api/login" || path === "/api/logout" ||
        path === "/api/auth-state" || path === "/api/cron" || path === "/manifest.webmanifest" || path === "/sw.js";
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
      /* 登录态探测（公开，不含敏感值）：前端据此决定重要操作是否弹密码确认 */
      if (path === "/api/auth-state" && request.method === "GET") {
        return handleAuthState(env);
      }
      /* 重要操作密码校验：需已登录（不在公开白名单），校验通过仅返回 success，不签发会话 */
      if (path === "/api/verify-password" && request.method === "POST") {
        return await handleVerifyPassword(request, env);
      }
      if (path === "/api/logout" && request.method === "POST") {
        return handleLogout(request, env);
      }
      /* 接入令牌管理（第 3 步）：不在 isPublicApi 白名单 → 未登录一律 401 */
      if (path === "/api/tokens" && request.method === "GET") {
        return await handleListTokens(env);
      }
      if (path === "/api/tokens" && request.method === "POST") {
        return await handleCreateToken(request, env);
      }
      if (path === "/api/tokens/revoke" && request.method === "POST") {
        return await handleRevokeToken(request, env);
      }
      if (path === "/api/tokens/rotate" && request.method === "POST") {
        return await handleRotateToken(request, env);
      }
      if (path === "/api/tokens/rename" && request.method === "POST") {
        return await handleRenameToken(request, env);
      }
      /* 服务端设置（GET 读 / PUT 写）：不在 isPublicApi 白名单 → 未登录一律 401 */
      if (path === "/api/settings" && request.method === "GET") {
        return await handleGetSettings(env);
      }
      if (path === "/api/settings" && request.method === "PUT") {
        return await handlePutSettings(request, env);
      }
      /* 通知渠道测试与旧环境变量迁移：同样受登录 + JSON CSRF 闸门 + 写限速保护 */
      if (path === "/api/settings/notify/test" && request.method === "POST") {
        return await handleTestNotify(request, env);
      }
      if (path === "/api/settings/notify/import-env" && request.method === "POST") {
        return await handleImportNotifyEnv(request, env);
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
      if (msgMatch && request.method === "GET") {
        return await handleGetMessage(msgMatch[1], env);
      }
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
        return await handlePhoneArea(request, url, env);
      }
      if ((path === "/" || path === "/index.html") && request.method === "GET") {
        return new Response(renderHtml(PAGE_HTML, env), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS },
        });
      }
      return json({ success: false, error: "not found" }, 404);
    } catch (err) {
      logEvent("error", "request_error", "request", env, requestId, { error: logErrorInfo(err) });
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

/* ---------------- 接入令牌数据层导出（供测试与第 3 步管理 API 复用） ---------------- */

export {
  createToken,
  listTokens,
  findTokenByHash,
  revokeToken,
  rotateToken,
  touchLastUsed,
  atomicBatch,
  AtomicBatchError,
}
