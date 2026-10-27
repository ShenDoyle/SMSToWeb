# Netlify-Bereitstellungsanleitung

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | **Deutsch** | [Português (BR)](../pt-BR/README.md)

> Synct mit dem englischen Original (de)

SMSToWeb auf Netlify bereitstellen (Functions v2 + Turso-Datenbank). Insgesamt etwa 15 Minuten.

**Dateien in diesem Verzeichnis**: `functions/api.mjs` (Einstieg, fängt mit `path: "/*"` alle Routen ab), `functions/cron.mjs` (Scheduled Function für die geplante Bereinigung), `app.js` (Kernanwendung), `db.js` (Turso-Adapter), `schema.sql` (Tabellen anlegen), `netlify.toml` (Site-Konfiguration).

---

## Ein-Klick-Bereitstellung (empfohlen)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/ShenDoyle/SMSToWeb)

Der Button klont das Repository in Ihr GitHub und öffnet den Einrichtungsassistenten; zwei Stellen beachten:

1. **In den Build-Einstellungen als Base directory `platforms/netlify` eintragen** (die `netlify.toml` dieser Plattform liegt in diesem Unterverzeichnis; nach korrektem Eintrag übernehmen Build-Befehl usw. automatisch); den Rest unverändert lassen
2. Empfehlung: zuerst Schritt 2 unten (Turso-Datenbank anlegen) abschließen, um die Verbindungsinformationen zu erhalten; nach dem Anlegen unter **Site configuration → Environment variables** `RECEIVE_TOKEN` / `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` eintragen und neu bereitstellen; zuletzt das SQL aus Schritt 3 zum Anlegen der Tabellen ausführen (Netlify kann keine Tabellen anlegen)

---

## Vorbereitung

1. Ein GitHub-Konto
2. Ein Netlify-Konto ([Registrierung](https://app.netlify.com/signup), einfach mit GitHub einloggen)

## Schritt 1: Code-Repository vorbereiten

Das GitHub-Repository des Projekts öffnen und oben rechts **Fork** klicken (oder Ihr bereits gepushtes Repository verwenden).

## Schritt 2: Turso-Datenbank anlegen

Turso bietet SQLite-kompatible Datenbanken (Free-Kontingent: 100 Datenbanken, 5GB Speicher, 500 Mio. Zeilenlesen pro Monat).

1. [turso.tech](https://turso.tech) öffnen, **Start for free now** klicken und mit GitHub einloggen
2. In die Konsole → **Create Database**:
   - Name: `sms-gateway`
   - Location: eine Region in Ihrer Nähe (z. B. Singapore / Hong Kong)
   - Type: Free
3. Nach dem Anlegen in die Datenbank-Detailseite:
   - Die **Database URL** notieren (Form `libsql://sms-gateway-xxxx.turso.io`)
   - Über **Create Token** einen Zugriffstoken anlegen und **sofort kopieren und sichern** (nur einmal sichtbar)
4. Tabellenschema initialisieren: Datenbank-Detailseite → **Console** → kompletten Inhalt der [`schema.sql`](../../../platforms/netlify/schema.sql) aus diesem Verzeichnis einfügen → ausführen → Erfolgsmeldung

> Alternativ die Turso-CLI: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Schritt 3: Repository in Netlify importieren

1. Auf [app.netlify.com](https://app.netlify.com) einloggen → **Add new project → Import an existing project**
2. **Deploy with GitHub** wählen, nach der Autorisierung Ihren Fork in der Liste wählen
3. Auf der Bereitstellungs-Konfigurationsseite (Site settings for…):
   - **Base directory**: `platforms/netlify` eintragen
   - Build command / Publish directory: Standard belassen (die `netlify.toml` liegt im Verzeichnis und greift automatisch)
4. Darunter **Show advanced → New variable** aufklappen, zuerst die Umgebungsvariablen hinzufügen (siehe Schritt 4), dann **Deploy** klicken

## Schritt 4: Umgebungsvariablen konfigurieren

In den erweiterten Optionen der Bereitstellungs-Konfigurationsseite hinzufügen (später auch unter **Project configuration → Environment variables** änderbar):

| Name | Wert | Beschreibung |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | die in Schritt 2 notierte URL |
| `TURSO_AUTH_TOKEN` | (Token aus Schritt 2) | der nur einmal sichtbare |
| `RECEIVE_TOKEN` | eigene lange Zufallszeichenkette | Push-Authentifizierung, keinen Beispielwert verwenden |
| `ENABLE_AUTH` | `false` | für Login `true` setzen |
| `ADMIN_PASSWORD` | eigenes Passwort | nur bei `ENABLE_AUTH="true"` nötig |
| `SESSION_SECRET` | hochentropier Zufallswert (≥32 zufällige Zeichen) | nur bei `ENABLE_AUTH="true"` nötig; unabhängig vom Passwort, je Plattform ein eigener Wert; fehlt er, schlagen Login/Authentifizierung sicher fehl, nach Rotation sind alte Sessions alle ungültig |
| `RETENTION_DAYS` | `30` | Datenaufbewahrungstage |
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

**Deploy** klicken und die Bereitstellung (ca. 1 Minute) abwarten.

## Schritt 5: Bereitstellung prüfen

1. Nach Abschluss der Bereitstellung die Site-Domain notieren (Form `https://xxx.netlify.app`)
2. Diese Domain im Browser öffnen — die Admin-Seite sollte erscheinen (Standard „SMS-Gateway“; bei aktiviertem Login zuerst die Login-Seite)
3. Push-Endpunkt prüfen:

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Netlify 部署成功\"}"
```

Kommt `{"success":true,...}` zurück, steht die Verbindung; die Nachricht sollte sofort auf der Webseite erscheinen.

## Schritt 6: Endgeräte anbinden

Nach der [Bereitstellungs- & Anbindungsanleitung](../../../docs/多平台接入部署指南.md) Android SmsForwarder und die Benachrichtigungs-Pushes der Geräte konfigurieren; als Domain Ihre `xxx.netlify.app` verwenden.

Eigene Domain: **Project configuration → Change site name** (Subdomain ändern) oder **Domain management → Add a domain** (eigene Domain, DNS gemäß Anweisungen ergänzen).

## Hinweise und häufige Fragen

- **Geplante Bereinigung**: `functions/cron.mjs` ist eine Netlify Scheduled Function und wird nach der Bereitstellung automatisch registriert (täglich um UTC 17:00 = 01:00 Pekingzeit) — keine weitere Konfiguration nötig. Prüfung: auf der **Functions**-Seite der Site die Funktion `cron` und ihren Zeitplanstatus sehen
- **Funktionsdauer und Echtzeit**: Das Ausführungslimit der Funktionen liegt derzeit bei 60 Sekunden (alle Tarife gleich); das Long-Polling `/api/wait` der Admin-Seite (25 Sekunden Hängezeit) kann vollständig warten — gute Echtzeit. Bei extrem hohen Echtzeitanforderungen bleiben Cloudflare / Selfhosting die erste Wahl
- **Free-Kontingent**: Neue Konten ab 2025-09 werden über Credits abgerechnet (Free-Plan 300 Credits pro Monat; der Funktionsverbrauch zählt als GB-Stunden) — für kleinen privaten Traffic ausreichend; Bestandskonten können im alten Tarif bleiben
- **Fehlersuche bei gescheiterter Bereitstellung**: Base directory muss `platforms/netlify` sein; ohne die `TURSO_*`-Umgebungsvariablen gibt es 500 mit „config error“; Details stehen unter **Functions → api → Logs** der Site
- **Code aktualisieren**: push in das GitHub-Repository löst automatisch eine neue Bereitstellung aus
