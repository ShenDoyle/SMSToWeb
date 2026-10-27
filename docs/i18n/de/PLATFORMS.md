# Überblick: Bereitstellung auf mehreren Plattformen

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | **Deutsch** | [Português (BR)](../pt-BR/README.md)

> Synct mit dem englischen Original (de)

Alle sechs Plattformen von SMSToWeb (Cloudflare-Hauptversion + fünf portierte Plattformen) liegen in diesem Verzeichnis. **Jedes Plattform-Unterverzeichnis ist vollständig in sich geschlossen**:
Code (Einstieg + Kernanwendung + Datenbank-Adapter) + `schema.sql` + die ausführliche Bereitstellungsanleitung der Plattform (README.md).

| Plattform | Laufzeit | Geplante Bereinigung | Ausführliche Anleitung |
|---|---|---|---|
| **Cloudflare** (Hauptversion) | Worker + D1 | Plattform-Cron | [cloudflare/README.md](../../../platforms/cloudflare/README.md) |
| Vercel | Edge Function | Plattform-Cron | [vercel/README.md](../../../platforms/vercel/README.md) |
| Deno Deploy | Deno nativ | `Deno.cron` (eingebaut) | [deno/README.md](../../../platforms/deno/README.md) |
| Netlify | Functions v2 (Node) | Scheduled Function | [netlify/README.md](../../../platforms/netlify/README.md) |
| EdgeOne Makers (Tencent) | Functions | externer Cron ruft /api/cron auf | [edgeone/README.md](../../../platforms/edgeone/README.md) |
| Fly.io / Railway / VPS | Docker (Node 22) + Turso/lokales SQLite | im Prozess eingebaut | [node/README.md](../../../platforms/node/README.md) |

Alle sechs Plattformen (inkl. Cloudflare) sind bei API-Pfaden, Authentifizierungslogik, Nachrichtenmodell, Admin-Seite, Multi-Kanal-Weiterleitung und täglicher Bereinigung (UTC 17:00) völlig identisch,
das Tabellenschema ist gleich — ein Wechsel ist jederzeit möglich.

> **Ein-Klick-Bereitstellung**: Am Anfang der Anleitungen für Cloudflare / Vercel / Netlify stehen offizielle Ein-Klick-Buttons (der Cloudflare-Button erstellt sogar Datenbank und Tabellen automatisch);
> für Deno Deploy, EdgeOne und Docker-Selfhosting gibt es noch keine offiziellen Buttons — einfach der jeweiligen Plattform-Anleitung folgen.

## Welche Plattform passt zu wem

- **Kostenlos + sorgenfrei** → Cloudflare-Hauptversion (großzügiges D1-Free-Kontingent, Worker ohne Dauerprobleme)
- **Mehrere Plattformen ausprobieren** → Deno Deploy (semantisch am nächsten am Worker, Long-Polling praktisch ohne Abbruch)
- **Zugang vor allem aus China** → EdgeOne Makers (Achtung: eigene Domain benötigt ICP-Registrierung)
- **Server vorhanden / volle Kontrolle gewünscht** → node/ (Docker-Selfhosting)

> **Long-Polling und Plattform-Timeouts**: Die Admin-Seite wartet über `GET /api/wait` auf neue Nachrichten, standardmäßig max. 25 Sekunden; über die Umgebungsvariable `WAIT_MAX_SECONDS` (3–25) je nach Plattform senkbar.
> Netlify Functions: aktuelles Limit 60 Sekunden (der Einstieg steht konservativ auf `WAIT_MAX_SECONDS=8`, bei Bedarf erhöhbar); Vercel Edge: `20` empfohlen; Cloudflare / Deno / Node: Standard belassen.
> Das Frontend wiederholt Fehlversuche mit **exponentiellem Backoff** (2→30s) und lädt sofort nach, sobald die Seite wieder sichtbar wird — selbst wenn die Plattform früher abbricht, **werden keine Funktionen beeinträchtigt**, der Hinweis auf neue Nachrichten kommt nur leicht verzögert.

## Gemeinsame Vorbereitung (für alle Nicht-Cloudflare-Plattformen)

**Durchgängig [Turso](https://turso.tech) als Datenbank** (SQLite-kompatibel; Free-Kontingent: 100 Datenbanken, 5GB Speicher, 500 Mio. Zeilenlesen pro Monat):

1. [turso.tech](https://turso.tech) öffnen und mit GitHub einloggen
2. **Create Database**: Name `sms-gateway`, Region Singapore / Hong Kong wählen, Typ Free
3. In der Datenbank-Detailseite die **Database URL** notieren (`libsql://sms-gateway-xxxx.turso.io`); über **Create Token** einen Token anlegen und sofort sichern (nur einmal sichtbar)
4. Tabellenschema initialisieren: im Detailbereich **Console** den kompletten Inhalt der `schema.sql` aus dem jeweiligen Plattformverzeichnis einfügen und ausführen (identisch mit der `schema.sql` im Repo-Wurzelverzeichnis)

Äquivalente CLI-Befehle:

```bash
turso auth login
turso db create sms-gateway          # Datenbank anlegen
turso db show sms-gateway --url      # URL anzeigen
turso db tokens create sms-gateway   # Token anlegen
turso db shell sms-gateway < schema.sql   # Tabellen anlegen
```

**Umgebungsvariablen** (im Einstellungsbereich der jeweiligen Plattform konfigurieren, vollständige Erklärung in deren Anleitung):

| Variable | Erforderlich | Beschreibung |
|---|---|---|
| `TURSO_DATABASE_URL` | ja | `libsql://sms-gateway-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | ja | Datenbank-Zugriffstoken |
| `RECEIVE_TOKEN` | ja | Push-Authentifizierungsgeheimnis (muss mit `token=` in den Anbindungs-URLs übereinstimmen) |
| `ENABLE_AUTH` | nein | `"true"`: die Admin-Seite verlangt Login (**sicherheitshalber dringend aktivieren**, siehe Sicherheitshinweise unten); Standard ist kein Login |
| `ADMIN_PASSWORD` | nein | Login-Passwort (setzen bei `ENABLE_AUTH="true"`; fehlt es, verweigern die Admin-Endpunkte den Zugriff und alarmieren — fehlende Konfiguration lässt nie durch) |
| `SESSION_SECRET` | bei aktiviertem Login zwingend | Session-Signaturschlüssel: hochentropier Zufallswert (≥32 zufällige Zeichen, unabhängig vom Admin-Passwort), jede Plattform erhält einen eigenen Wert; fehlt er, schlagen Login und Authentifizierung sicher fehl (Login 500, Admin-Endpunkte 401), kein Fallback auf Passwortableitung; nach der Rotation sind alte Sessions alle ungültig (erneuter Login) |
| `RETENTION_DAYS` | nein | Datenaufbewahrungstage, Standard 30 |
| `WAIT_MAX_SECONDS` | nein | Hängezeit des Long-Polling (3–25, Standard 25); Netlify: `8`, Vercel Edge: `20` |
| Benachrichtigungskanal-Variablen | nein | `FEISHU_WEBHOOK` (Feishu) / `WECOM_WEBHOOK` (WeCom) / `DINGTALK_WEBHOOK` (DingTalk, optional `DINGTALK_SECRET`-Signatur) / `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY` (optional `BARK_URL`) / `NTFY_URL` (optional `NTFY_TOKEN`) / `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO` (E-Mail, optional `MAIL_FROM`) / `GENERIC_WEBHOOKS` (generischer Webhook, optional `GENERIC_WEBHOOK_TEMPLATE` Body / `GENERIC_WEBHOOK_HEADERS` Header). Konfiguriert wird nur, was genutzt wird; ohne Konfiguration keine Weiterleitung; Benachrichtigungen werden inhaltsabhängig in drei Zuständen gerendert (🔐 OTP / 💬 SMS / 🔔 Benachrichtigung) |
| `SITE_NAME` / `SITE_ICON` | nein | Seitenname / Icon-URL, ohne Angabe gelten Standardwerte |
| `NOTIFY_LINK` | nein | URL der Admin-Startseite; wenn gesetzt, erhält jeder Benachrichtigungskanal einen „Admin-Seite öffnen“-Eintrag (Button/Link/click), sonst automatisch weggelassen |
| `CRON_SECRET` (nur Vercel) | nein | auf denselben Wert wie `RECEIVE_TOKEN` setzen, damit Vercel Cron /api/cron aufrufen kann |
| `SQLITE_PATH` (nur Node-Selfhosting) | nein | lokaler SQLite-Modus: gesetzt entfällt die externe Datenbank (braucht Node 22.13+, siehe node/README.md) |

> **Sicherheitshalber dringend empfohlen**
> 1. **Admin-Login aktivieren** (`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`): Die Admin-Seite enthält sensible Inhalte wie SMS-OTP-Codes; ohne Login kann jeder, der die Domain kennt, alle Nachrichten lesen und Daten löschen. Der Login-Endpunkt hat ein eingebautes Ratenlimit (5 Fehlversuche in Folge pro IP → 10 Minuten Sperre); `/api/receive`, `/api/push` sind zusätzlich auf 120 Schreibvorgänge pro IP pro Minute limitiert (darüber 429).
> 2. **Abwägung zum Push-Token über den URL-Query**: Zur Kompatibilität mit SmsForwarder und ähnlichen Clients akzeptieren `/api/receive`, `/api/push` die Authentifizierung über `?token=` — der Token erscheint in der URL und kann in die Zugriffslogs der Plattform und den Browserverlauf gelangen. Wer das nicht möchte, nutzt POST + Header `Authorization: Bearer <RECEIVE_TOKEN>` (beide Wege werden unterstützt).

## Verzeichnisstruktur

```
platforms/
├── cloudflare/ # 主版本：worker.js + schema.sql + wrangler.toml + README.md（自包含）
├── vercel/     # api/[[...route]].js + app.js + db.js + schema.sql + vercel.json + README.md
├── netlify/    # functions/{api,cron}.mjs + app.js + db.js + schema.sql + netlify.toml + README.md
├── deno/       # main.js + app.js + db.js + schema.sql + README.md
├── edgeone/    # functions/{[[default]].js,index.js} + app.js + db.js + schema.sql + README.md
├── node/       # server.mjs + app.js + db.js + schema.sql + Dockerfile + package.json + README.md
├── shared/     # app.js / db.js 唯一源（gen_app.py 由此同步到各平台目录）
└── gen_app.py  # 生成器：从 ../src/worker.js 生成 app.js 并同步全部平台（含 cloudflare 独立副本）
```

Jedes Plattformverzeichnis kann einzeln als Bereitstellungswurzel dienen (bei Git-Bereitstellung einfach die Root Directory auf das jeweilige Unterverzeichnis zeigen lassen),
null npm-Abhängigkeiten, kein Build nötig. Nach Updates an `src/worker.js` `python platforms/gen_app.py` ausführen, um alle Plattformen in einem Rutsch zu synchronisieren (CI prüft auf Null-Drift; `node tests/run.mjs` deckt 97 Funktions-Assertions ab).

## Von Cloudflare Worker auf andere Plattformen migrieren

1. Turso-Datenbank wie oben vorbereiten und Tabellen anlegen
2. (Optional) Historische Daten migrieren: D1-Daten im CF-Dashboard exportieren (SQLite-Datei) → per `turso db import` importieren (siehe offizielle CLI-Dokumentation)
3. Nach der README der Zielplattform bereitstellen und prüfen, dass Admin-Seite und /api/push funktionieren
4. Die Webhook-Domain im Handy-Client und in den Push-Skripten auf die neue Plattform umstellen
5. Nach ein bis zwei Tagen ohne Auffälligkeiten den alten Worker deaktivieren

## Allgemeine Hinweise

- Die API-Pfade sind auf allen Plattformen identisch: `/api/receive`, `/api/push`, `/api/messages` (unterstützt `device_id`/`source`/`range`/`q`/`limit`/`page`/`starred`/`unread`), `/api/messages/star`, `/api/messages/read`, `/api/messages/remove`, `/api/messages/restore`, `/api/messages/clear`, `/api/export` (CSV/JSON), `/api/sources`, `/api/stats`, `/api/phone` (Regions-Abfrage), `/api/devices`, `/api/devices/alias`, `/api/devices/merge`, `/api/wait`, `/api/login`, `/api/logout`, `/api/cron`; dazu öffentlich `/manifest.webmanifest`, `/sw.js`
- `/api/cron` dient externen Schedulern zum Auslösen der Bereinigung; Authentifizierung: `?token=<RECEIVE_TOKEN>` oder `Authorization: Bearer <RECEIVE_TOKEN>`
- `/api/receive` und `/api/push` sind vom Login-Schalter unberührt
