# Architekturdokumentation (ARCHITECTURE)

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | **Deutsch** | [Português (BR)](../pt-BR/README.md)

> Synct mit dem englischen Original (de)

SMSToWeb ist ein „ein Kern + mehrere Plattformeinstiege“-System zur Aggregation von SMS/Benachrichtigungen: ein npm-freier Geschäftskern (`src/worker.js`), der über ein Generierungsskript auf sechs Bereitstellungsplattformen synchronisiert wird; jede Plattform behält nur einen dünnen Adapter für ihre Runtime und Datenbank.

## 1. Gesamttopologie

```
手机（SmsForwarder / 任意脚本）
   │  POST /api/receive（短信）或 /api/push（通用推送）+ token
   ▼
┌─────────────────────────── 任选一个平台部署 ────────────────────────────┐
│  Cloudflare Workers (D1)   Vercel Edge   Deno Deploy                     │
│  Netlify Functions         EdgeOne (Turso)   Node 自托管 (Docker)         │
│                                                                           │
│  入口层（薄适配）：接收请求 → buildEnv 透传环境变量 → fetchApp()          │
│  业务核心（单文件 app.js）：鉴权 → 入库 → 查询 → 长轮询 → 通知转发        │
└──────────────────────────────────────────────────────────────────────────┘
   │                                  │
   ▼                                  ▼
管理页（内嵌 HTML，登录鉴权）      11 渠道通知转发（飞书/企微/钉钉/…）
```

Kernentwurfsprinzip: **Trennung von Geschäftscode und Plattformeinstieg**. Die Kernlogik ändert sich nicht mit der Bereitstellungsplattform; nur über den dünnen Adapter werden die Runtime- und Datenbankschnittstellen der jeweiligen Plattform angebunden; die sechs Plattformen sind funktional streng identisch.

## 2. Verzeichnisstruktur

```
src/worker.js                 # 唯一业务源文件（Cloudflare Worker 形态：export default { fetch, scheduled }）
platforms/
  gen_app.py                 # 同步生成脚本（见 §3）
  shared/app.js               # 生成产物：与 src/worker.js 业务部分逐字节一致，仅替换导出形态
  cloudflare/                 # CF 主版本副本 + wrangler.toml（静态维护）
  vercel/  netlify/  deno/    # 各平台自包含目录：入口 + app.js + db.js + schema.sql + README
  edgeone/ node/              # EdgeOne 走 Turso；node/db.js 为 Turso + 本地 SQLite 双适配（独立维护）
tests/run.mjs                 # Testsuite ohne Abhängigkeiten (node:sqlite, 204 Tests)
docs/                         # 文档（本目录）
schema.sql                    # 数据库建表脚本（单一来源）
```

Jedes Plattformverzeichnis ist **vollständig in sich geschlossen**: Der Einstieg referenziert nur die `app.js` / `db.js` im eigenen Verzeichnis — einzeln bereitstellbar, ohne gegenseitige Abhängigkeiten.

## 3. Synchronisationsmechanismus (platforms/gen_app.py)

`python platforms/gen_app.py` erledigt in einem Rutsch (idempotent, Wiederholung ohne Drift):

1. Nimmt `src/worker.js` als einzige Quelle, schneidet den gesamten Geschäftscode vor `export default {` ab, ergänzt den generischen Export-Schwanz (`fetchApp` / `runCron` / `handleCronRequest`) und schreibt das Ergebnis nach `platforms/shared/app.js`;
2. kopiert die shared-Kopie zusammen mit `shared/db.js` und der Root-`schema.sql` in die Plattformverzeichnisse (`node/db.js` ausgenommen — separat gepflegt);
3. ersetzt mit der im Skript eingebauten **ENV_KEYS-Whitelist** (eine einzige Liste mit 31 Umgebungsvariablen) den Inhalt zwischen den Markierungen `/* ==== ENV_KEYS BEGIN ==== */ … /* ==== ENV_KEYS END ==== */` der jeweiligen Einstiegsdatei — so bleibt die Menge der übergebenen Umgebungsvariablen über alle sechs Plattformen identisch und driftet nicht.

Eiserne Regel: **Jede Geschäftsänderung nur in `src/worker.js` (sowie der ENV_KEYS-Liste in gen_app.py); danach zwingend gen_app.py erneut ausführen**; es ist verboten, generierte Artefakte unter platforms/ von Hand zu ändern (Ausnahmen: node/db.js und wrangler.toml).

## 4. Anforderungslebenszyklus

Am Beispiel von `POST /api/receive`:

1. **Einstiegsschicht**: der Plattformeinstieg (z. B. `platforms/edgeone/functions/index.js`) nimmt die Anfrage entgegen, baut `env = buildEnv(vars)` (übergibt die Whitelist-Variablen + den Datenbank-Zweig der Zugangsdaten) und ruft `fetchApp(request, env[, ctx])` auf;
2. **Authentifizierung**: `/api/receive`, `/api/push`, `/api/login`, `/api/logout`, `/api/cron` und statische Ressourcen sind öffentliche Pfade; die übrigen Admin- und Seitenendpunkte unterliegen dem Login-Schalter (`ENABLE_AUTH`) — nach dem Login wird eine **zustandslos signierte Session** ausgestellt (`nonce.exp.HMAC-SHA256`-Drei-Segment-Format, Cookie `sms_auth`, TTL 30 Minuten); fehlt `SESSION_SECRET`, schlagen Login und Authentifizierung sicher fehl (Login 500, Admin-Endpunkte ausnahmslos 401, kein Fallback auf Passwortableitung); fehlende Konfiguration lässt niemals durch;
3. **Ablage**: Token prüfen (`safeEqual` gegen Timing-Angriffe) → Gerät nach device+sim finden/anlegen → in messages schreiben (der eindeutige Datenbankindex fängt Duplikate ab; doppelter Push liefert `duplicated:true` ohne Weiterleitung);
4. **Benachrichtigungsweiterleitung**: Nicht-Duplikate gehen über `bgRun(ctx, dispatchNotify(env, msg))` in den Hintergrund — Cloudflare übergibt echtes `ctx.waitUntil`, damit das Senden nach der Antwort weiterläuft; fehlt ctx auf anderen Plattformen, wird auf inline `await` degradiert, damit Edge-Funktionen Hintergrundaufgaben nicht vorzeitig abbrechen;
5. **Antwort**: sofortiges JSON (`success/device_id/duplicated`), ohne auf den Abschluss der Weiterleitung zu warten (CF-Plattform).

## 5. Subsystem der Benachrichtigungsweiterleitung

`dispatchNotify(env, msg)` ist die einzige Zusammenbauschicht über alle Kanäle:

- `extractCodeLite(content)`: serverseitige leichtgewichtige OTP-Erkennung (Kaskadenreihenfolge wie das Frontend-`extractCode`: Code-am-Anfang vor Schlüsselwort-am-Anfang; vor der Erkennung werden Telefonnummern/Datums-/Zeitangaben/Beträge/Belegnummern entfernt);
- `buildNotifyInfo(env, msg)`: OTP-Erkennung + das einmalige pro Durchlauf gelesene `NOTIFY_LINK` erzeugen die drei Zustände `verify/sms/notify` und den einheitlichen Titel;
- der jeweilige Kanal-Renderer konsumiert `info` und rendert sein eigenes Format (Feishu Interactive Card / WeCom- und DingTalk-markdown / Telegram HTML / Bark / ntfy / Gotify / Resend-Mail / generische Webhook-Vorlage usw.); Längenlimit, Signatur und Escaping werden im Renderer behandelt;
- `Promise.allSettled` steuert parallel; der Fehlschlag eines Kanals wird nur geloggt und beeinflusst weder andere Kanäle noch den Hauptfluss.

## 6. Frontend (eingebettete Admin-Seite)

Das Admin-Seiten-HTML ist als `String.raw`-Template-Literal in `src/worker.js` eingebettet (serverseitig gerendert, kein eigenes Frontend-Projekt): Login-Seite und Admin-Seite teilen sich die Route `/`; der Login-Schalter bestimmt die gerenderte Form; unterstützt neun Sprachen (zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR, eingebettetes `data-i18n`-Wörterbuch + `?lang=`-Direktaufruf, fehlende Schlüssel fallen auf en zurück), Dunkelmodus, automatisches OTP-Kopieren, Long-Polling-Auto-Refresh (`/api/wait`), Quellenfilter und Geräteverwaltung.

## 7. Plattformunterschiede im Überblick

| Plattform | Einstiegsdatei | Datenbank | cron |
|---|---|---|---|
| Cloudflare | `export default` (worker.js selbst) | D1 (`env.DB`) | natives `scheduled` + `/api/cron` über HTTP |
| Vercel | `api/[[...route]].js` | Turso | Vercel Cron (Bearer `CRON_SECRET`) |
| Netlify | `functions/api.mjs` + `functions/cron.mjs` | Turso | Scheduled Functions |
| Deno | `main.js` (`Deno.serve`) | Turso | externer Scheduler |
| EdgeOne | `functions/index.js` (Root-Pfad muss index.js sein) | Turso (Client-Cache keyed nach Zugangsdaten-Fingerprint) | externer Scheduler |
| Node | `server.mjs` (node:http) | Turso / lokales SQLite (Dual-Adapter) | externer Scheduler / Docker |

Die HTTP-Auslösesemantik von `/api/cron` ist auf allen Plattformen gleich: `?token=<RECEIVE_TOKEN>` oder `Authorization: Bearer <RECEIVE_TOKEN>`.
