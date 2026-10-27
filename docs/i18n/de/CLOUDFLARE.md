# Cloudflare-Bereitstellungsanleitung (Hauptversion, komplett im Browser)

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | **Deutsch** | [Português (BR)](../pt-BR/README.md)

> Synct mit dem englischen Original (de)

Dies ist die Hauptversion des Projekts: Handy-SMS/Benachrichtigungen → Cloudflare Worker → D1-Datenbank → Web-Admin-Seite.
Kein Server nötig, großzügiges Gratis-Kontingent, komplett per Mausklick im Browser erledigt — ohne Installation jeglicher Tools.

Dieses Verzeichnis ist **vollständig in sich geschlossen**: [`worker.js`](../../../platforms/cloudflare/worker.js) (Bereitstellungsquellcode) + [`schema.sql`](../../../platforms/cloudflare/schema.sql) (Skript zum Anlegen der Tabellen) + [`wrangler.toml`](../../../platforms/cloudflare/wrangler.toml) (optionale Konfiguration für CLI-Bereitstellung), ohne Abhängigkeit von anderen Repo-Dateien. Die übrigen Plattformen siehe [Plattformübersicht](../../../platforms/README.md).

---

## Ein-Klick-Bereitstellung (empfohlen für Einsteiger)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

Beim Klick auf den Button oben erledigt Cloudflare automatisch: Code in Ihr GitHub klonen → **D1-Datenbank automatisch anlegen und Tabellen ausführen** → Ressourcen binden → CI konfigurieren (bei jedem künftigen Push in Ihr Repo wird automatisch neu bereitgestellt) → live gehen. Unterwegs werden zwei Secrets abgefragt:

- `RECEIVE_TOKEN`: Push-Authentifizierungsgeheimnis, eigene ausreichend lange zufällige Zeichenkette (`token=` in den Anbindungs-URLs der Endgeräte muss damit übereinstimmen)
- `ADMIN_PASSWORD`: Login-Passwort der Admin-Seite (**dringend empfohlen zu setzen** — die Admin-Seite enthält sensible Inhalte wie SMS-OTP-Codes; bei `ENABLE_AUTH="true"` ohne Konfiguration verweigern alle Admin-Endpunkte den Zugriff, es gibt kein Login-freies Durchlassen)
- `SESSION_SECRET`: Session-Signaturschlüssel, **bei aktiviertem Login zwingend** — hochentropier Zufallswert (≥32 zufällige Zeichen, z. B. erzeugt mit `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`), völlig unabhängig vom Passwort; fehlt er, schlagen Login und Authentifizierung sicher fehl (Login 500, Admin-Endpunkte 401), kein Fallback auf Passwortableitung; nach einer Rotation werden alle alten Sessions sofort ungültig

> Eigene Domain binden (z. B. `sms.example.com`): nach der Bereitstellung in den Worker → Einstellungen → Domains & Routes → Custom Domain hinzufügen.
> Die folgende manuelle Anleitung bleibt für alle, die den Ein-Klick-Weg nicht nutzen oder jeden Schritt nachvollziehen möchten.

## Vorbereitung

1. Ein Cloudflare-Konto ([Registrierung](https://dash.cloudflare.com/sign-up), kostenlos, E-Mail genügt)
2. Der Projektcode (die [`worker.js`](../../../platforms/cloudflare/worker.js) in diesem Verzeichnis ist der komplette einzufügende Code)

## Schritt 1: D1-Datenbank anlegen

1. Auf [dash.cloudflare.com](https://dash.cloudflare.com) einloggen
2. Im linken Menü **Speicher und Datenbanken → D1 SQL Database**
3. **Create Database** klicken, Name `sms-gateway-db` (Rest unverändert), Create klicken
4. Die neu angelegte Datenbank öffnen → Registerkarte **Console**
5. Den kompletten Inhalt der [`schema.sql`](../../../platforms/cloudflare/schema.sql) aus diesem Verzeichnis ins Eingabefeld kopieren und **Execute** klicken
6. Erfolgsmeldung abwarten (es werden die zwei Tabellen `messages` und `devices` angelegt)

## Schritt 2: Worker anlegen und Code einfügen

1. Im linken Menü **Compute (Workers) → Workers & Pages**
2. **Create application** klicken, **Start with Hello World!** wählen, Name `sms-gateway` eintragen, **Deploy** klicken (erst einmal reicht die erfolgreiche Bereitstellung mit dem Standardcode)
3. **Edit code** klicken und den gesamten Standardcode im Editor löschen
4. Die [`worker.js`](../../../platforms/cloudflare/worker.js) aus diesem Verzeichnis öffnen, alles markieren, kopieren und in den Editor einfügen
5. Oben rechts **Deploy** klicken und die Erfolgsmeldung abwarten

## Schritt 3: D1-Datenbank binden

1. Zur Worker-Übersichtsseite zurückkehren → Registerkarte **Bindings**
2. **Add → D1 database** klicken
3. Als Variablenname `DB` eintragen (muss exakt so, großgeschrieben), die eben erstellte `sms-gateway-db` wählen
4. **Deploy/Save** klicken

## Schritt 4: Variablen und Secrets setzen

Am selben Ort unter **Einstellungen → Variables and Secrets** einzeln hinzufügen:

1. **Variable hinzufügen** (Typ „Text“):
   - Name `RETENTION_DAYS`, Wert `30` (für 90 Tage Aufbewahrung `90` eintragen)
   - Name `ENABLE_AUTH`, Wert `false` (**sicherheitshalber dringend `true` setzen und den Login aktivieren**: die Admin-Seite enthält sensible Inhalte wie SMS-OTP-Codes; ohne Login ist sie für jeden mit Domokenntnis offen. Bei automatischer Bereitstellung über Workers Builds aus dem Repo gilt der Wert aus der `wrangler.toml` im Repo — dort standardmäßig bereits `true`)
   - Name `SITE_NAME` (optional), Wert eigener Seitenname, z. B. `我的短信站`
   - Name `SITE_ICON` (optional), Wert Icon-URL (beginnend mit `http(s)://`); ohne Angabe oder bei ungültiger URL wird automatisch das eingebaute Icon verwendet
   - Name `NOTIFY_LINK` (optional), Wert URL der Admin-Startseite (beginnend mit `http(s)://`); wenn gesetzt, erhält jeder Benachrichtigungskanal einen „Admin-Seite öffnen“-Eintrag
2. **Secret hinzufügen** (Typ „Secret“):
   - Name `RECEIVE_TOKEN`, Wert eigene ausreichend lange zufällige Zeichenkette (keinen Beispielwert aus einer Anleitung verwenden, je länger desto besser)
   - Name `ADMIN_PASSWORD`, Wert eigenes Login-Passwort für die Admin-Seite (nur nötig, wenn `ENABLE_AUTH="true"`)
   - Name `SESSION_SECRET`, Wert hochentropier Zufallswert (≥32 zufällige Zeichen, unabhängig vom Passwort; nur nötig, wenn `ENABLE_AUTH="true"`)
3. Nach jedem Hinzufügen **Deploy/Save** klicken

> Änderungen dieser Werte wirken sofort, ohne den Code erneut einzufügen. Nach einer Änderung von `RECEIVE_TOKEN` daran denken, `token=` in den URLs der Endgeräte mitzuziehen.

## Schritt 5 (optional): Benachrichtigungs-Weiterleitungskanäle konfigurieren

Nach der Ablage neuer Nachrichten können sie automatisch an externe Kanäle weitergeleitet werden; **es wird genau der Kanal weitergeleitet, dessen Variable konfiguriert ist — ohne Konfiguration keine Weiterleitung**.
Auf derselben Seite „Variables and Secrets“ die entsprechenden Variablen hinzufügen:

| Kanal | Variable | Beschreibung |
|---|---|---|
| Feishu-Gruppenbot | `FEISHU_WEBHOOK` (optional `FEISHU_SECRET`) | Webhook-Adresse des Gruppenbots; bei „Signaturprüfung“ als Sicherheitseinstellung zusätzlich `FEISHU_SECRET` |
| WeCom-Gruppenbot | `WECOM_WEBHOOK` | Webhook-Adresse des Gruppenbots |
| DingTalk-Gruppenbot | `DINGTALK_WEBHOOK` (optional `DINGTALK_SECRET`) | Bei „Signatur“ als Sicherheitseinstellung muss `DINGTALK_SECRET` gesetzt werden |
| ServerChan | `SERVERCHAN_SENDKEY` | SendKey (WeChat-Push) |
| PushPlus | `PUSHPLUS_TOKEN` | Token (WeChat-Push) |
| Telegram Bot | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Bot-Token + Chat-/Gruppen-ID |
| Bark | `BARK_DEVICE_KEY` (optional `BARK_URL`) | Bei eigenem Server `BARK_URL` setzen, Standard ist die offizielle |
| ntfy | `NTFY_URL` (optional `NTFY_TOKEN`) | Vollständige Topic-URL, z. B. `https://ntfy.sh/my-sms`; geschützte Topics zusätzlich `NTFY_TOKEN` (Token oder user:password) |
| Gotify | `GOTIFY_URL` + `GOTIFY_TOKEN` | Serveradresse (ohne `/message`) + Applikations-Token |
| E-Mail (Resend) | `RESEND_API_KEY` + `MAIL_TO` (optional `MAIL_FROM`) | `MAIL_FROM` Standard ist `onboarding@resend.dev` |
| Generischer Webhook | `GENERIC_WEBHOOKS` (optional `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`) | Mehrere URLs kommasepariert; Template für eigenen Body, Header als JSON — über diesen Weg binden sich Drittanbieter-APIs (SMS-Gateways usw.) an |

Anmeldung und Beschaffung je Kanal sowie das Body-Format: siehe [Bereitstellungs- & Anbindungsleitfaden · Weiterleitungskanäle](../../../docs/多平台接入部署指南.md).
Mehrere Kanäle laufen parallel; ein Fehlschlag eines Kanals beeinträchtigt weder die anderen noch die Ablage; Duplikate (`duplicated`) werden nicht doppelt weitergeleitet.
Benachrichtigungen werden inhaltsabhängig automatisch in drei Zuständen gerendert (🔐 OTP-Erinnerung / 💬 neue SMS / 🔔 Gerätebenachrichtigung): Der OTP-Code landet automatisch im Titel und löst die Plattform-Extras aus (Bark-Benachrichtigung kopiert den Code mit einem Tipp, Bark/ntfy erhalten erhöhte Priorität, Feishu violettes Karten-Headerdesign usw.).

## Schritt 6: Geplante Bereinigung einrichten

1. Worker → **Einstellungen → Triggers → Cron Triggers**
2. **Add Cron Trigger** klicken, `0 17 * * *` eintragen, speichern
3. Bedeutung: täglich um UTC 17:00 (01:00 Pekingzeit) werden Daten jenseits der Aufbewahrungstage automatisch gelöscht

## Schritt 7: Domain binden (optional, empfohlen)

1. Worker → **Einstellungen → Domains & Routes**
2. **Add → Custom Domain** klicken, eine Subdomain eintragen (z. B. `sms.Ihre-Domain.com`)
3. Cloudflare legt den DNS-Eintrag automatisch an und stellt das HTTPS-Zertifikat aus; in wenigen Minuten aktiv
4. Danach ist `https://sms.Ihre-Domain.com` im Browser direkt die Admin-Seite

> Ohne eigene Domain genügt die Standardadresse `https://sms-gateway.<Ihre-Subdomain>.workers.dev`.

## Schritt 8: Bereitstellung prüfen

Beim Öffnen der Admin-Seite im Browser sollte die Seite mit Ihrem Seitenname erscheinen (Standard „SMS-Gateway“, über `SITE_NAME` änderbar; bei aktiviertem Login erscheint zuerst die Login-Seite). Danach den Empfangsendpunkt prüfen (`<Domain>` und `<Secret>` durch Ihre Werte ersetzen):

```
curl "https://<域名>/api/receive?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"name\":\"test\",\"sim\":\"13800138000\",\"from\":\"10086\",\"content\":\"部署测试\"}"
```

Kommt `{"success":true,...}` zurück, steht die Verbindung. Diese Test-SMS lässt sich auf der Webseite löschen.

## Endgeräte anbinden

Nach der [Bereitstellungs- & Anbindungsanleitung](../../../docs/多平台接入部署指南.md) Android SmsForwarder und die Benachrichtigungs-Pushes der verschiedenen Geräte konfigurieren; als API-Domain einfach Ihre Worker-Adresse einsetzen.

## CLI-Bereitstellung (Alternativweg, für alle, die wrangler installieren)

In diesem Verzeichnis (enthält `wrangler.toml`, `main` zeigt bereits auf die `worker.js` hier) ausführen:

```bash
npm install wrangler        # offiziell empfohlen: Installation im Projekt; global per npm install -g wrangler geht auch
npx wrangler login
npx wrangler d1 execute sms-gateway-db --file=schema.sql --remote
npx wrangler secret put RECEIVE_TOKEN
npx wrangler secret put ADMIN_PASSWORD   # nur bei aktiviertem Login nötig
npx wrangler secret put SESSION_SECRET   # nur bei aktiviertem Login nötig (hochentropier Zufallswert, unabhängig vom Passwort)
npx wrangler deploy
```

## Hinweise und häufige Fragen

- **Weitergeleitete SMS kommen nicht an**: nacheinander prüfen ① in den allgemeinen SmsForwarder-Einstellungen den Hauptschalter „SMS-Broadcast weiterleiten“ (am leichtesten vergessen; ausgeschaltet werden Nachrichten still verworfen, während der Kanaltest grün bleibt) → ② stimmen Token/URL der Weiterleitungsregel mit dem Worker-Secret überein → ③ in den Worker-Live-Logs sehen, ob Anfragen ankommen
- **Der Benachrichtigungskanal hat nichts erhalten**: Prüfen, ob die Variablen des Kanals gesetzt und korrekt sind; in den Worker-Live-Logs nach `notify forward failed:` sehen; Nachrichten mit `duplicated:true` werden nicht weitergeleitet
- **Worker-Free-Kontingent**: 100.000 Anfragen pro Tag — für den Privatgebrauch mehr als genug; D1-Free-Kontingent: 5 Mio. Zeilenlesen pro Tag
- **Long-Polling**: Die Admin-Seite `/api/wait` hängt max. 25 Sekunden und wartet auf neue Nachrichten; Workers haben kein Anfragedauer-Problem, beste Echtzeit
- **Datenmigration**: Beim Umzug von anderen Plattformen zurück zu CF die Turso-Daten exportieren und in D1 importieren (Tabellenschema ist völlig identisch)
