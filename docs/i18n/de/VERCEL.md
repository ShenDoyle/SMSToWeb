# Vercel-Bereitstellungsanleitung

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | **Deutsch** | [Português (BR)](../pt-BR/README.md)

> Synct mit dem englischen Original (de)

SMSToWeb auf Vercel bereitstellen (Edge Function + Turso-Datenbank). Das Free-Kontingent genügt für den Privatgebrauch, insgesamt etwa 15 Minuten.

**Dateien in diesem Verzeichnis**: `api/[[...route]].js` (Einstieg), `app.js` (Kernanwendung), `db.js` (Turso-Adapter), `schema.sql` (Tabellen anlegen), `vercel.json` (enthält die Cron-Konfiguration).

---

## Ein-Klick-Bereitstellung (empfohlen)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb%2Ftree%2Fmain%2Fplatforms%2Fvercel&env=RECEIVE_TOKEN%2CTURSO_DATABASE_URL%2CTURSO_AUTH_TOKEN&project-name=sms-gateway&envDescription=%E6%8E%A8%E9%80%81%E9%89%B4%E6%9D%83%E5%AF%86%E9%92%A5%E4%B8%8E%20Turso%20%E6%95%B0%E6%8D%AE%E5%BA%93%E8%BF%9E%E6%8E%A5%E4%BF%A1%E6%81%AF&envLink=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb)

Empfehlung: **zuerst Schritt 2 unten (Turso-Datenbank anlegen) abschließen, um die Verbindungsinformationen zu erhalten**, dann den Button klicken: Vercel klont das Plattform-Unterverzeichnis als Ihr Repository und erstellt das Projekt; im Prompt `RECEIVE_TOKEN` (Push-Authentifizierungsgeheimnis, eigene lange Zufallszeichenkette) sowie URL / Token von Turso eintragen und bereitstellen. Nach erfolgreicher Bereitstellung **unbedingt einmal das SQL aus Schritt 3 zum Anlegen der Tabellen ausführen** (Vercel kann keine Tabellen anlegen), sonst zeigt die Seite keine Daten.

---

## Vorbereitung

1. Ein GitHub-Konto (Vercel stellt über GitHub-Repositories bereit)
2. Ein Vercel-Konto ([Registrierung](https://vercel.com/signup), einfach mit GitHub einloggen)

## Schritt 1: Code-Repository vorbereiten

1. Das GitHub-Repository des Projekts öffnen und oben rechts **Fork** klicken (oder Ihr bereits gepushtes Repository verwenden)
2. Nach dem Fork haben Sie eine frei änderbare Kopie des Projekts

## Schritt 2: Turso-Datenbank anlegen

Turso bietet SQLite-kompatible Datenbanken (Free-Kontingent: 100 Datenbanken, 5GB Speicher, 500 Mio. Zeilenlesen pro Monat).

1. [turso.tech](https://turso.tech) öffnen, **Start for free now** klicken und mit GitHub einloggen
2. In die Konsole → **Create Database**:
   - Name: `sms-gateway`
   - Location: eine Region in Ihrer Nähe (z. B. Singapore / Hong Kong)
   - Type: Free
3. Nach dem Anlegen in die Datenbank-Detailseite:
   - Die **Database URL** notieren (Form `libsql://sms-gateway-xxxx.turso.io`)
   - Über **Create Token** (oder Turso Platform Tokens) einen Zugriffstoken anlegen und **sofort kopieren und sichern** (nur einmal sichtbar)
4. Tabellenschema initialisieren: Datenbank-Detailseite → **Console** (SQL-Konsole im Web) → kompletten Inhalt der [`schema.sql`](../../../platforms/vercel/schema.sql) aus diesem Verzeichnis einfügen → ausführen → Erfolgsmeldung (es werden die zwei Tabellen `messages` und `devices` angelegt)

> Alternativ die Turso-CLI: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Schritt 3: Repository in Vercel importieren

1. Auf [vercel.com](https://vercel.com) einloggen → **Add New → Project**
2. In der Liste **Import Git Repository** Ihr Fork-Repository finden und **Import** klicken
3. Auf der Konfigurationsseite **Root Directory** aufklappen und `platforms/vercel` wählen
   —— Vercel erkennt `vercel.json` und das `api/`-Verzeichnis darin automatisch, keine weitere Konfiguration nötig
4. Noch nicht auf Deploy klicken: zuerst Schritt 4 (Umgebungsvariablen) im Bereich **Environment Variables** derselben Seite erledigen

## Schritt 4: Umgebungsvariablen konfigurieren

Auf der Bereitstellungs-Konfigurationsseite in **Environment Variables** einzeln hinzufügen (später auch unter Project → Settings änderbar):

| Name | Wert | Beschreibung |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | die in Schritt 2 notierte URL |
| `TURSO_AUTH_TOKEN` | (Token aus Schritt 2) | der nur einmal sichtbare |
| `RECEIVE_TOKEN` | eigene lange Zufallszeichenkette | Push-Authentifizierung, keinen Beispielwert verwenden |
| `ENABLE_AUTH` | `false` | für Login `true` setzen |
| `ADMIN_PASSWORD` | eigenes Passwort | nur bei `ENABLE_AUTH="true"` nötig |
| `SESSION_SECRET` | hochentropier Zufallswert (≥32 zufällige Zeichen) | nur bei `ENABLE_AUTH="true"` nötig; unabhängig vom Passwort, je Plattform ein eigener Wert; fehlt er, schlagen Login/Authentifizierung sicher fehl, nach Rotation sind alte Sessions alle ungültig |
| `RETENTION_DAYS` | `30` | Datenaufbewahrungstage |
| `CRON_SECRET` | **derselbe Wert wie RECEIVE_TOKEN** | Beim Aufruf von /api/cron durch Vercel Cron wird automatisch `Bearer $CRON_SECRET` mitgeschickt |
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

Nach dem Ausfüllen **Deploy** klicken und die Bereitstellung (ca. 1 Minute) abwarten.

## Schritt 5: Bereitstellung prüfen

1. Auf der Abschlussseite **Continue to Dashboard** klicken und die oben zugewiesene Domain notieren (Form `https://xxx.vercel.app`)
2. Diese Domain im Browser öffnen — die Admin-Seite sollte erscheinen (Standard „SMS-Gateway“; bei aktiviertem Login zuerst die Login-Seite)
3. Push-Endpunkt prüfen (`<Domain>` und `<Secret>` durch Ihre Werte ersetzen):

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Vercel 部署成功\"}"
```

Kommt `{"success":true,...}` zurück, steht die Verbindung; die Nachricht sollte sofort auf der Webseite erscheinen.

## Schritt 6: Endgeräte anbinden

Nach der [Bereitstellungs- & Anbindungsanleitung](../../../docs/多平台接入部署指南.md) Android SmsForwarder (SMS über `/api/receive`) und die Benachrichtigungs-Pushes der Geräte (über `/api/push`) konfigurieren; als Domain Ihre `xxx.vercel.app` (oder eine gebundene eigene Domain) verwenden.

Eigene Domain binden: Project → **Settings → Domains** → Add und den Anweisungen folgend einen CNAME-Eintrag im DNS Ihrer Domain anlegen — der Zielwert entspricht der Anzeige auf der Domains-Seite (Vercel vergibt für jedes Projekt eine eigene `xxxxxx.vercel-dns.com`-Adresse).

## Hinweise und häufige Fragen

- **Geplante Bereinigung**: `vercel.json` ruft `/api/cron` täglich um UTC 17:00 (01:00 Pekingzeit) auf, um abgelaufene Daten zu löschen. Vercel Cron schickt automatisch `Authorization: Bearer $CRON_SECRET` mit, daher muss `CRON_SECRET` mit `RECEIVE_TOKEN` übereinstimmen
- **Limit der Hobby-(Free)-Version**: Cron unterstützt nur einmal pro Tag (dieses Projekt läuft genau einmal täglich — passt; der tatsächliche Auslösezeitpunkt kann innerhalb der eingestellten Stunde schwanken, das ist normal); Edge-Funktionen müssen **innerhalb von 25 Sekunden mit der Antwort beginnen** (danach sind bis zu 300 Sekunden Streaming möglich); das Long-Polling `/api/wait` der Admin-Seite hängt exakt 25 Sekunden — genau an der Grenze. Wird es vorzeitig abgebrochen, wiederholt die Frontend-Polling-Schleife automatisch, **ohne Funktionsbeeinträchtigung**; der Hinweis auf neue Nachrichten kommt nur etwas verzögert
- **Edge Runtime**: Der Einstieg deklariert `runtime = "edge"` — schneller Kaltstart, Ausführung an globalen Edge-Knoten
- **Fehlersuche bei gescheiterter Bereitstellung**: meist fehlende Umgebungsvariablen — ohne `TURSO_*` gibt es 500 mit „config error“; prüfen, ob Root Directory korrekt auf `platforms/vercel` steht
- **Code aktualisieren**: pushen Sie in Ihren Fork, Vercel stellt automatisch neu bereit
