# Tencent EdgeOne Makers – Bereitstellungsanleitung

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | **Deutsch** | [Português (BR)](../pt-BR/README.md)

> Synct mit dem englischen Original (de)

SMSToWeb auf Tencent EdgeOne Makers bereitstellen (ehemals EdgeOne Pages; Functions + Turso-Datenbank). Gutes Zugriffserlebnis aus China, insgesamt etwa 15 Minuten.

**Dateien in diesem Verzeichnis**: `functions/index.js` (Einstieg nur für den Root-Pfad `/`, alleinige Quelle der gesamten Logik und der ENV_KEYS-Whitelist), `functions/[[default]].js` (fängt alle übrigen Routen ab und re-exportiert nur index.js — keine separate Pflege nötig), `app.js` (Kernanwendung), `db.js` (Turso-Adapter), `schema.sql` (Tabellen anlegen).

---

## Vorbereitung

1. Ein Tencent-Cloud-Konto ([Registrierung](https://cloud.tencent.com), Identitätsverifizierung nötig)
2. Ein GitHub-Konto (EdgeOne Makers unterstützt die Bereitstellung aus Git-Repositories)

## Schritt 1: Code-Repository vorbereiten

Das GitHub-Repository des Projekts öffnen und oben rechts **Fork** klicken (oder Ihr bereits gepushtes Repository verwenden).

## Schritt 2: Turso-Datenbank anlegen

Turso bietet SQLite-kompatible Datenbanken (Free-Kontingent: 100 Datenbanken, 5GB Speicher, 500 Mio. Zeilenlesen pro Monat). Innerhalb der EdgeOne Functions ist der Zugriff auf externe Datenbanken ungehindert möglich.

1. [turso.tech](https://turso.tech) öffnen, **Start for free now** klicken und mit GitHub einloggen
2. In die Konsole → **Create Database**:
   - Name: `sms-gateway`
   - Location: Singapore / Hong Kong empfohlen (geringe Latenz aus China)
   - Type: Free
3. Nach dem Anlegen in die Datenbank-Detailseite:
   - Die **Database URL** notieren (Form `libsql://sms-gateway-xxxx.turso.io`)
   - Über **Create Token** einen Zugriffstoken anlegen und **sofort kopieren und sichern** (nur einmal sichtbar)
4. Tabellenschema initialisieren: Datenbank-Detailseite → **Console** → kompletten Inhalt der [`schema.sql`](../../../platforms/edgeone/schema.sql) aus diesem Verzeichnis einfügen → ausführen → Erfolgsmeldung

> Alternativ die Turso-CLI: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Schritt 3: Projekt in EdgeOne Makers anlegen

1. In die Tencent-Cloud-Konsole einloggen → nach **EdgeOne Makers** suchen (ehemals „EdgeOne Pages“, oder direkt [console.cloud.tencent.com/edgeone/pages](https://console.cloud.tencent.com/edgeone/pages))
2. **Projekt erstellen** klicken → **Aus Git-Repository importieren** wählen → GitHub autorisieren und Ihren Fork auswählen
3. Build-Konfiguration:
   - **Root-Verzeichnis**: `platforms/edgeone`
   - Framework-Preset: „Kein Framework / Other“ wählen oder leer lassen (reine Functions brauchen keinen Build)
4. Im Bereich der Umgebungsvariablen zuerst die Variablen hinzufügen (siehe Schritt 4), dann die Bereitstellung starten
5. Abschluss der Bereitstellung (ca. 1 Minute) abwarten und die zugewiesene Standarddomain notieren (z. B. `*.edgeone.app`)

## Schritt 4: Umgebungsvariablen konfigurieren

Im Projekt unter **Einstellungen → Umgebungsvariablen** einzeln hinzufügen (die Functions lesen sie über den `env`-Parameter von `onRequest`):

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

Nach dem Speichern neu bereitstellen, damit die Änderungen wirksam werden.

## Schritt 5: Bereitstellung prüfen

1. Die zugewiesene Domain im Browser öffnen — die Admin-Seite sollte erscheinen (Standard „SMS-Gateway“; bei aktiviertem Login zuerst die Login-Seite)
2. Push-Endpunkt prüfen:

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"EdgeOne 部署成功\"}"
```

Kommt `{"success":true,...}` zurück, steht die Verbindung; die Nachricht sollte sofort auf der Webseite erscheinen.

## Schritt 6: Eigene Domain binden (empfohlen für den Zugriff aus China)

1. Projekt → **Einstellungen → Custom Domains** → Ihre Domain hinzufügen (z. B. `sms.Ihre-Domain.com`)
2. Den Anweisungen folgend im DNS Ihrer Domain einen CNAME-Eintrag auf die von EdgeOne zugewiesene Adresse setzen
3. Die Domain muss bereits eine ICP-Registrierung besitzen (Anforderung der China-Knoten von Tencent Cloud); ohne Registrierung wird die Auflösung abgelehnt

## Schritt 7: Geplante Bereinigung konfigurieren (externer Cron)

EdgeOne Makers hat derzeit keine nativen Cron-Aufgaben; einen beliebigen kostenlosen externen Cron-Dienst nutzen, um den Bereinigungsendpunkt täglich einmal aufzurufen:

1. [cron-job.org](https://cron-job.org) öffnen, registrieren und **Create cronjob**:
   - URL: `https://<Ihre-Domain>/api/cron?token=<Ihr-RECEIVE_TOKEN>`
   - Schedule: täglich (z. B. 01:00 Pekingzeit, entsprechend UTC 17:00)
2. Speichern und aktivieren. Zum Termin löscht das Gateway automatisch Daten, die älter als `RETENTION_DAYS` Tage sind

## Endgeräte anbinden

Nach der [Bereitstellungs- & Anbindungsanleitung](../../../docs/多平台接入部署指南.md) Android SmsForwarder und die Benachrichtigungs-Pushes der Geräte konfigurieren; als Domain Ihre EdgeOne-Domain verwenden.

## Hinweise und häufige Fragen

- **404 auf dem Root-Pfad (wichtig, 2026-10 getestet)**: In den Functions-Routing-Regeln von EdgeOne Makers fängt `[[default]].js` nur Nicht-Root-Pfade wie `/foo`, `/api/xxx` ab; **der Root-Pfad `/` erkennt ausschließlich `functions/index.js`** — fehlt diese Datei, trifft die Startseite direkt auf die Plattform-404-Seite (die API-Endpunkte funktionieren trotzdem). Dieses Verzeichnis liefert `functions/index.js` mit (alleinige Quelle der Logik und der ENV_KEYS-Whitelist; `[[default]].js` re-exportiert es nur, keine doppelte Pflege)
- **Long-Polling**: Das Ausführungslimit der Functions ist knapp bemessen; `/api/wait` (25 Sekunden Hängezeit) kann vorzeitig abgebrochen werden — das Frontend wiederholt automatisch, ohne Funktionsbeeinträchtigung
- **Fehlersuche bei gescheiterter Bereitstellung**: Root-Verzeichnis muss `platforms/edgeone` sein; ohne die `TURSO_*`-Umgebungsvariablen gibt es 500 mit „config error“
- **Code aktualisieren**: push in das GitHub-Repository löst automatisch eine neue Bereitstellung aus
