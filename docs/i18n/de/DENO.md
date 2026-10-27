# Deno Deploy – Bereitstellungsanleitung

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | **Deutsch** | [Português (BR)](../pt-BR/README.md)

> Synct mit dem englischen Original (de)

SMSToWeb auf Deno Deploy bereitstellen (Deno-native Runtime + Turso-Datenbank). Semantisch am nächsten an Cloudflare Worker, Free-Version mit 1 Mio. Anfragen pro Monat, insgesamt etwa 15 Minuten.

> Hinweis zur Plattform: Deno Deploy wurde auf eine neue Plattformgeneration umgestellt; die Konsole ist [console.deno.com](https://console.deno.com) (das alte dash.deno.com wurde abgeschaltet), mit einem CI-ähnlichen Git-Build-Modus.

**Dateien in diesem Verzeichnis**: `main.js` (Einstieg, mit `Deno.serve` und eingebautem `Deno.cron` für die geplante Bereinigung), `app.js` (Kernanwendung), `db.js` (Turso-Adapter), `schema.sql` (Tabellen anlegen).

---

## Vorbereitung

1. Ein GitHub-Konto
2. Ein Deno-Deploy-Konto ([Registrierung](https://console.deno.com), einfach mit GitHub einloggen)

## Schritt 1: Code-Repository vorbereiten

1. Das GitHub-Repository des Projekts öffnen und oben rechts **Fork** klicken (oder Ihr bereits gepushtes Repository verwenden)

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
4. Tabellenschema initialisieren: Datenbank-Detailseite → **Console** → kompletten Inhalt der [`schema.sql`](../../../platforms/deno/schema.sql) aus diesem Verzeichnis einfügen → ausführen → Erfolgsmeldung

> Alternativ die Turso-CLI: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Schritt 3: App in Deno Deploy anlegen und Repository verknüpfen

1. Auf [console.deno.com](https://console.deno.com) einloggen → **+ New App** klicken
2. **Aus GitHub-Repository bereitstellen** wählen, autorisieren und Ihren Fork auswählen
3. Build-Konfiguration:
   - **Laufzeitarbeitsverzeichnis** (Runtime working directory): `platforms/deno`
   - **Entrypoint** (Einstiegsdatei): `main.js`
4. Zuerst die Umgebungsvariablen hinzufügen (siehe Schritt 4), dann die erste Bereitstellung auslösen
5. Nach Abschluss der Bereitstellung wird jeder push in das GitHub-Repository automatisch neu gebaut

## Schritt 4: Umgebungsvariablen konfigurieren

In der App unter **Settings → Environment Variables** einzeln hinzufügen (auch auf der Konfigurationsseite beim Anlegen der App möglich):

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

Nach dem Speichern die automatische Neubereitstellung abwarten.

## Schritt 5: Bereitstellung prüfen

1. Die zugewiesene Domain notieren (Form `https://<App-Name>.<Organisationsname>.deno.net`)
2. Diese Domain im Browser öffnen — die Admin-Seite sollte erscheinen (Standard „SMS-Gateway“; bei aktiviertem Login zuerst die Login-Seite)
3. Push-Endpunkt prüfen:

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Deno Deploy 部署成功\"}"
```

Kommt `{"success":true,...}` zurück, steht die Verbindung; die Nachricht sollte sofort auf der Webseite erscheinen.

## Schritt 6: Endgeräte anbinden

Nach der [Bereitstellungs- & Anbindungsanleitung](../../../docs/多平台接入部署指南.md) Android SmsForwarder und die Benachrichtigungs-Pushes der Geräte konfigurieren; als Domain Ihre `xxx.deno.net` verwenden.

Eigene Domain: im **Domains**-Tab der Organisation die Domain hinzufügen und der App zuweisen; den Anweisungen folgend CNAME (oder A-Eintrag) und Verifizierungseintrag im DNS anlegen — das HTTPS-Zertifikat wird automatisch ausgestellt.

## Hinweise und häufige Fragen

- **Geplante Bereinigung**: `Deno.cron` wird bei der Bereitstellung automatisch registriert (täglich um UTC 17:00 = 01:00 Pekingzeit) — keine weitere Konfiguration nötig, manuell auch nicht testbar auslösbar; zur Prüfung sehen, ob die Turso-Daten termingerecht abnimmt
- **Free-Kontingent**: 1 Mio. Anfragen pro Monat, Active CPU 10 Stunden, 20GiB ausgehender Traffic — für den Privatgebrauch mehr als genug
- **Long-Polling**: Deno Deploy hat kein striktes Anfragedauer-Limit; das 25-Sekunden-Long-Polling von `/api/wait` arbeitet gut; idle Instanzen können von der Plattform recycelt und neu gestartet werden (abgebrochene Long-Pollings wiederholt das Frontend automatisch) — die Echtzeit ist praktisch identisch zur Worker-Version
- **Fehlersuche bei gescheiterter Bereitstellung**: Entrypoint muss `main.js` sein, Laufzeitverzeichnis muss `platforms/deno` sein; ohne die `TURSO_*`-Umgebungsvariablen gibt es 500 mit „config error“
- **Code aktualisieren**: push in das GitHub-Repository löst automatisch eine neue Bereitstellung aus
