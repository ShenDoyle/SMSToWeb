# Anleitung zur Selfhosting-Bereitstellung (Fly.io / Railway / VPS / lokal)

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | **Deutsch** | [Português (BR)](../pt-BR/README.md)

> Synct mit dem englischen Original (de)

SMSToWeb als Docker-Container selbst hosten. Dauerhaft laufender Prozess, kein Funktionsdauer-Limit, beste Long-Polling-Echtzeit — geeignet für Nutzer mit vorhandenem Server oder mit Fly.io / Railway (zum Free-Kontingent siehe unten „Hinweise zur Plattform“).

**Dateien in diesem Verzeichnis**: `server.mjs` (einstiegsfähig ab Node 18+, ohne Abhängigkeiten, mit eingebauter täglicher Bereinigung), `app.js` (Kernanwendung), `db.js` (Dual-Adapter für Turso / lokales SQLite), `schema.sql` (Tabellen anlegen), `Dockerfile`, `package.json`.

---

## Vorbereitung

- Fly.io- oder Railway-Konto (oder ein beliebiger VPS mit Docker)
- Als Datenbank weiterhin Turso (SQLite-kompatibel); die einheitliche Vorbereitung folgt in Schritt 1

## Schritt 1: Turso-Datenbank anlegen

1. [turso.tech](https://turso.tech) öffnen, **Start for free now** klicken und mit GitHub einloggen
2. In die Konsole → **Create Database**:
   - Name: `sms-gateway`
   - Location: eine Region nahe dem Server wählen
   - Type: Free
3. Nach dem Anlegen in die Datenbank-Detailseite:
   - Die **Database URL** notieren (Form `libsql://sms-gateway-xxxx.turso.io`)
   - Über **Create Token** einen Zugriffstoken anlegen und **sofort kopieren und sichern** (nur einmal sichtbar)
4. Tabellenschema initialisieren: Datenbank-Detailseite → **Console** → kompletten Inhalt der [`schema.sql`](../../../platforms/node/schema.sql) aus diesem Verzeichnis einfügen → ausführen → Erfolgsmeldung

> CLI-Variante: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Variante A: Fly.io

1. flyctl lokal installieren ([offizielle Installationsanleitung](https://fly.io/docs/flyctl/install/)) und danach `fly auth login`
2. In diesem Verzeichnis ausführen:

```bash
cd platforms/node
fly launch                 # 按提示创建应用：区域自选；询问数据库时选 No（我们用 Turso）
fly secrets set TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io TURSO_AUTH_TOKEN=<你的令牌> RECEIVE_TOKEN=<你的密钥>
fly secrets set ENABLE_AUTH=true ADMIN_PASSWORD=<你的密码>     # 可选
fly deploy
fly status                 # 记下分配的域名 https://<app>.fly.dev
```

3. Prüfung: `https://<app>.fly.dev` im Browser öffnen — die Admin-Seite sollte erscheinen; Push-Test:

```
curl "https://<app>.fly.dev/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Fly 部署成功\"}"
```

4. Eigene Domain: `fly certs add sms.Ihre-Domain.com`, DNS gemäß Anweisungen ergänzen (A-Eintrag oder CNAME)

## Variante B: Railway

1. Auf [railway.app](https://railway.app) einloggen → **New Project → Deploy from GitHub repo** und Ihren Fork wählen
2. In den Diensteinstellungen **Settings → Root Directory**: `platforms/node` (Railway erkennt das Dockerfile und baut automatisch)
3. Im Panel **Variables** die Umgebungsvariablen hinzufügen (siehe allgemeine Tabelle unten; `PORT` injiziert die Plattform automatisch, der Code ist darauf angepasst)
4. **Settings → Public Networking → Generate Domain** für eine öffentliche Domain
5. Prüfung wie oben (mit Ihrer Railway-Domain)

## Variante C: beliebiger VPS (Docker)

```bash
# 上传本目录到服务器后
cd platforms/node
docker build -t smstoweb .
docker run -d --name smstoweb --restart unless-stopped -p 8787:8787 \
  -e TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io \
  -e TURSO_AUTH_TOKEN=<你的令牌> \
  -e RECEIVE_TOKEN=<你的密钥> \
  smstoweb
# 验证
curl "http://127.0.0.1:8787/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"content\":\"VPS 部署成功\"}"
```

Empfehlung: Caddy/Nginx als Reverse-Proxy mit HTTPS. Auch ohne Docker genügt direkt `node server.mjs` (braucht Node 18+, null npm-Abhängigkeiten; der lokale SQLite-Modus braucht Node 22.13+).

## Umgebungsvariablen (gültig für alle drei Varianten)

| Name | Wert | Beschreibung |
|---|---|---|
| `SQLITE_PATH` (optional) | z. B. `/data/data.db` | **lokaler SQLite-Modus**: gesetzt entfällt die externe Datenbank, die Daten liegen in einer lokalen Datei (braucht Node 22.13+, legt die Tabellen beim ersten Start automatisch an; entweder Turso oder lokal — gesetzt hat Vorrang) |
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | Turso-Modus: die in Schritt 1 notierte URL |
| `TURSO_AUTH_TOKEN` | (Token aus Schritt 1) | Turso-Modus: der nur einmal sichtbare |
| `RECEIVE_TOKEN` | eigene lange Zufallszeichenkette | Push-Authentifizierung, keinen Beispielwert verwenden |
| `ENABLE_AUTH` | `false` | für Login `true` setzen (**sicherheitshalber dringend aktivieren**: die Admin-Seite enthält sensible Inhalte wie SMS-OTP-Codes; ohne Login genügt die Domokenntnis, um alle Nachrichten zu sehen) |
| `ADMIN_PASSWORD` | eigenes Passwort | nur bei `ENABLE_AUTH="true"` nötig |
| `SESSION_SECRET` | hochentropier Zufallswert (≥32 zufällige Zeichen) | nur bei `ENABLE_AUTH="true"` nötig; unabhängig vom Passwort; fehlt er, schlagen Login/Authentifizierung sicher fehl, nach Rotation sind alte Sessions alle ungültig |
| `RETENTION_DAYS` | `30` | Datenaufbewahrungstage |
| `PORT` | Standard `8787` | meist nicht nötig (Railway injiziert automatisch) |
| `FEISHU_WEBHOOK` (optional `FEISHU_SECRET`) | (optional) Feishu-Gruppenbot-Webhook | Neue Nachrichten werden automatisch an die Feishu-Gruppe weitergeleitet; bei „Signaturprüfung“ als Bot-Sicherheitseinstellung zusätzlich `FEISHU_SECRET` |
| `WECOM_WEBHOOK` | (optional) WeCom-Gruppenbot-Webhook | Neue Nachrichten werden automatisch an die WeCom-Gruppe weitergeleitet |
| `DINGTALK_WEBHOOK` | (optional) DingTalk-Gruppenbot-Webhook | Bei „Signatur“ als Sicherheitseinstellung zusätzlich `DINGTALK_SECRET` |
| `SERVERCHAN_SENDKEY` | (optional) ServerChan SendKey | WeChat-Push |
| `PUSHPLUS_TOKEN` | (optional) PushPlus-Token | WeChat-Push |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | (optional) Telegram Bot | erst mit beiden konfiguriert aktiv |
| `BARK_DEVICE_KEY` | (optional) Bark-Geräte-Key | Bei eigenem Server zusätzlich `BARK_URL`, Standard ist die offizielle |
| `NTFY_URL` (optional `NTFY_TOKEN`) | (optional) ntfy-Topic-URL | Vollständige URL, z. B. `https://ntfy.sh/my-sms`; geschützte Topics zusätzlich `NTFY_TOKEN` (Token oder user:password) |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | (optional) Gotify | Serveradresse + Applikations-Token |
| `RESEND_API_KEY` + `MAIL_TO` | (optional) E-Mail (Resend) | optional `MAIL_FROM`, Standard `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS` (optional `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`) | (optional) generischer Webhook | Mehrere URLs kommasepariert; optionales Template für eigenen Body, `GENERIC_WEBHOOK_HEADERS` (JSON-String) für eigene Header |
| `SITE_NAME` / `SITE_ICON` | (optional) | Seitenname / Icon-URL |
| `NOTIFY_LINK` | (optional) | URL der Admin-Startseite; wenn gesetzt, erhält jeder Benachrichtigungskanal einen „Admin-Seite öffnen“-Eintrag, sonst automatisch weggelassen |

## Endgeräte anbinden

Nach der [Bereitstellungs- & Anbindungsanleitung](../../../docs/多平台接入部署指南.md) Android SmsForwarder und die Benachrichtigungs-Pushes der Geräte konfigurieren; als Domain Ihre Dienstadresse verwenden.

## Hinweise und häufige Fragen

- **Geplante Bereinigung**: Im Prozess eingebaut, täglich um UTC 17:00 (01:00 Pekingzeit) — keine Konfiguration nötig. Alternativ den Plattform-Scheduler (Fly Machines Cron / Railway Cron) nutzen, um `GET /api/cron?token=<RECEIVE_TOKEN>` aufzurufen; eines von beiden
- **Vorteil des dauerhaften Prozesses**: kein Funktionsdauer-Limit; das `/api/wait`-Long-Polling entspricht dem Cloudflare-Worker-Erlebnis, beste Echtzeit
- **Free-Kontingent**: Fly.io hat kein Free-Kontingent mehr (nur 7 Tage / 2 VM-Stunden Probe für neue Konten; nach Kartenbindung pay-as-you-go, Mikroverbrauch kostet sehr wenig); Railway bietet ein einmaliges Probe-Guthaben von 5 $ (30 Tage gültig), der Hobby-Plan kostet 5 $/Monat mit gleichwertigem Nutzungsguthaben — für dauerhaft null Kosten bleibt die Cloudflare-Hauptversion erste Wahl
- **Daten-Backup**: Im Turso-Modus liegen alle Daten bei Turso; beim Serverwechsel genügt es, die Umgebungsvariablen neu zu setzen, die Daten bleiben erhalten; im lokalen SQLite-Modus regelmäßig die Datei `SQLITE_PATH` sichern
- **Login-Schutz**: Der Login-Endpunkt hat ein eingebautes Ratenlimit — 5 Fehlversuche in Folge pro IP sperren für 10 Minuten (im Speicher gehalten, bei Prozessneustart zurückgesetzt)
- **Login über http**: Beim Zugriff per LAN-IP / http ohne TLS ist der Login direkt möglich (Cookie degradiert automatisch, kein erzwungenes Secure); nach dem Login in Browsern wie Alook funktioniert die Weiterleitung normal
- **Log-Fehlersuche**: `fly logs` / Railway Deployments → Logs / `docker logs smstoweb`
