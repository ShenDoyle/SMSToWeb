# SMSToWeb – Bereitstellungs- und Anbindungsleitfaden für mehrere Plattformen

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | **Deutsch** | [Português (BR)](../pt-BR/README.md)

> Synct mit dem englischen Original (de)

Dieses System besteht aus zwei Teilen: **Empfangsseite** (Push-Clients je Plattform) + **Cloud-Gateway** (eine von sechs Plattformen: Cloudflare / Vercel / Deno / Netlify / EdgeOne Makers / Docker-Selfhosting, siehe [platforms/README.md](../../../platforms/README.md); die Anbindung ist überall identisch).
SMS sind nur einer von mehreren Anbindungswegen — jedes Gerät/jedes Skript, das HTTP-Anfragen senden kann, kann Benachrichtigungen auf dieselbe Webseite pushen und dort einsehen.

```
安卓(SmsForwarder)──┐  短信+应用通知
iOS(快捷指令)───────┤
Linux(curl/ntfy)────┼──→ POST /api/receive（短信）或 /api/push（通用通知）
Windows(PowerShell)─┤         │
macOS(快捷指令)─────┘         ▼
                        Cloudflare Worker ──→ D1 存储 ──→ 统一网页（来源筛选）
                              │
                              └──（可选）多渠道通知 → 飞书/企微/钉钉/TG/Bark/邮件…
```

---

## 1. Cloud-Konfiguration (Cloudflare-Seite)

### 1. Variablen und Secrets

Nach dem Bereitstellen des Workers unter **Workers & Pages → sms-gateway → Einstellungen → Variables and Secrets** konfigurieren:

| Name | Typ | Erforderlich | Beschreibung |
|---|---|---|---|
| `RECEIVE_TOKEN` | Secret | ja | Push-Authentifizierungstoken, eigene zufällige Zeichenkette (keinen Beispielwert verwenden) |
| `ADMIN_PASSWORD` | Secret | bei aktiviertem Login | Login-Passwort der Admin-Seite, starkes Passwort empfohlen; fehlt es, verweigern alle Admin-Endpunkte den Zugriff (fehlende Konfiguration lässt niemals durch) und es wird ein Alarm geloggt |
| `ENABLE_AUTH` | Text | nein | `"true"` aktiviert den Login (**sicherheitshalber dringend empfohlen**: die Admin-Seite enthält sensible Inhalte wie SMS-OTP-Codes; ohne Login ist sie für jeden mit Domokenntnis offen); `"false"` oder nicht gesetzt = kein Login |
| `FEISHU_WEBHOOK` | Text | nein | Feishu-Gruppenbot-Webhook; nach der Konfiguration werden neue Nachrichten automatisch an die Feishu-Gruppe weitergeleitet (Signaturprüfung zusätzlich mit `FEISHU_SECRET`) |
| `FEISHU_SECRET` | Secret | nein | nur nötig, wenn beim Feishu-Bot „Signaturprüfung“ gewählt ist; das Programm berechnet die Signatur automatisch |
| `WECOM_WEBHOOK` | Text | nein | WeCom-Gruppenbot-Webhook |
| `DINGTALK_WEBHOOK` | Text | nein | DingTalk-Gruppenbot-Webhook (bei „Signatur“ als Sicherheitseinstellung zusätzlich `DINGTALK_SECRET`) |
| `SERVERCHAN_SENDKEY` | Text | nein | ServerChan SendKey (WeChat-Push) |
| `PUSHPLUS_TOKEN` | Text | nein | PushPlus-Token (WeChat-Push) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Text | nein | Telegram-Bot-Token + Chat-/Gruppen-ID |
| `BARK_DEVICE_KEY` | Text | nein | Bark-Geräte-Key (bei eigenem Server zusätzlich `BARK_URL`, Standard ist die offizielle) |
| `NTFY_URL` | Text | nein | vollständige ntfy-Topic-URL, z. B. `https://ntfy.sh/my-sms` (geschützte Topics zusätzlich `NTFY_TOKEN`) |
| `NTFY_TOKEN` | Text | nein | Zugriffs-Token für geschützte ntfy-Topics: Access Token direkt eintragen (Bearer); eigener Server im Format `user:password` (Basic) |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | Text | nein | Gotify-Serveradresse (ohne `/message`) + Applikations-Token |
| `RESEND_API_KEY` + `MAIL_TO` | Text | nein | E-Mail (Resend API); optional `MAIL_FROM`, Standard `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS` | Text | nein | generischer Webhook, mehrere URLs kommasepariert; optional `GENERIC_WEBHOOK_TEMPLATE` für einen eigenen Body, `GENERIC_WEBHOOK_HEADERS` für Header |
| `GENERIC_WEBHOOK_HEADERS` | Text | nein | eigene Header für den generischen Webhook, JSON-Objekt-String, z. B. `{"Authorization":"Bearer xxx"}` |
| `NOTIFY_LINK` | Text | nein | URL der Admin-Startseite; wenn gesetzt, erhält jeder Benachrichtigungskanal einen „Admin-Seite öffnen“-Eintrag (Feishu-Button, Linkzeile je Kanal, Bark-URL, ntfy click usw.); wird automatisch weggelassen, wenn nicht gesetzt |
| `SESSION_SECRET` | Secret | bei aktiviertem Login zwingend | Session-Signaturschlüssel: **hochentropier Zufallswert (≥32 zufällige Zeichen empfohlen), völlig unabhängig vom Admin-Passwort**; CF und EO (und jede Plattform) erhalten jeweils einen eigenen Wert, niemals in Git committen oder das Passwort wiederverwenden. Fehlt er, schlagen Login und Authentifizierung sicher fehl (Login 500, Admin-Endpunkte 401), kein Fallback auf Passwortableitung. Nach einer Rotation sind alle alten Sessions sofort ungültig (erneuter Login); Sessions gelten 30 Minuten, Logout löscht nur den Browser-Cookie — ein kopierter Token kann innerhalb der TTL noch gültig sein |
| `RETENTION_DAYS` | Text | nein | Datenaufbewahrungstage, Standard 30, Änderung wirkt sofort |
| `WAIT_MAX_SECONDS` | Text | nein | maximale Hängezeit in Sekunden für das Long-Polling `/api/wait`, Standard 25 (3–25). **Netlify Functions hat ein 10s-Limit → `8` empfohlen**; Vercel Edge: `20` empfohlen. Das Frontend wiederholt Fehlversuche mit exponentiellem Backoff, die Funktion wird nicht überflutet |

> **Zwei Sicherheitshinweise**
> 1. Den Admin-Login (`ENABLE_AUTH="true"`) dringend aktivieren und ein starkes `ADMIN_PASSWORD` setzen; der Login-Endpunkt hat ein eingebautes Ratenlimit (5 Fehlversuche in Folge pro IP → 10 Minuten Sperre); `/api/receive`, `/api/push` geben ab 120 Schreibvorgängen pro Minute und IP 429 zurück (erholt sich automatisch).
> 2. Der Push-Token akzeptiert `?token=` als URL-Parameter (SmsForwarder-Szenario); der Token erscheint in der URL und kann in den Zugriffslogs der Plattform landen; wer das nicht möchte, nutzt POST + Header `Authorization: Bearer <RECEIVE_TOKEN>` — beide Wege werden unterstützt.

### 2. Benachrichtigungs-Weiterleitungskanäle (optional, es wird nur weitergeleitet, was konfiguriert ist)

Auf der Seite „Umgebungsvariablen / Variables“ der Bereitstellungsplattform die entsprechenden Variablen hinzufügen, um sie zu aktivieren; **wird nichts konfiguriert, wird nichts weitergeleitet — Ablage und Webansicht bleiben unberührt**.
Mehrere Kanäle werden parallel bedient; ein Fehlschlag eines Kanals beeinträchtigt die anderen nicht; Duplikate (`duplicated:true`) werden nicht doppelt weitergeleitet.

Benachrichtigungen werden inhaltsabhängig automatisch in **drei Zuständen** gerendert (über alle Kanäle gleich): OTP erkannt → **OTP-Erinnerung** (Code in den Titel/die Kartengroßschrift; die Bark-Benachrichtigung kopiert den Code mit einem Tipp, Bark und ntfy erhalten erhöhte Priorität); SMS ohne Code → **neue SMS**; App-/Geräte-Push → **Gerätebenachrichtigung**. Nach dem Setzen der optionalen Variable `NOTIFY_LINK` erhält jeder Kanal automatisch einen „Admin-Seite öffnen“-Eintrag; ohne sie wird er weggelassen.

Der generische Webhook sendet standardmäßig einen JSON-Body mit den neuen Feldern `type` (`verify`/`sms`/`notify`) und `code` (erkannter OTP-Code, leerer String wenn nicht erkannt); die `GENERIC_WEBHOOK_TEMPLATE`-Platzhalter unterstützen entsprechend `{{type}}`/`{{code}}`.

Einrichtungsschritte je Kanal:

**Feishu-Gruppenbot** — `FEISHU_WEBHOOK` (optional `FEISHU_SECRET`)
1. In der Ziel-Feishu-Gruppe → Einstellungen → Gruppenbots → Bot hinzufügen → **Benutzerdefinierter Bot**
2. Webhook-Adresse der Form `https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx` kopieren und in die Variable eintragen
3. Sicherheitseinstellung, drei Optionen: **Benutzerdefiniertes Schlüsselwort** (empfohlen: einfach ein Schlüsselwort wie `短信` eintragen, sonst nichts nötig); **Signaturprüfung** (den Schlüssel in `FEISHU_SECRET` eintragen, das Programm berechnet die Signatur automatisch); IP-Allowlist (die Ausgangs-IP des Workers ist nicht fix — nicht wählen)

**WeCom-Gruppenbot** — `WECOM_WEBHOOK`
1. In der Ziel-WeCom-Gruppe → Gruppeneinstellungen oben rechts → Gruppenbots → Bot hinzufügen → neu erstellen
2. Webhook-Adresse der Form `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx` kopieren und in die Variable eintragen

**DingTalk-Gruppenbot** — `DINGTALK_WEBHOOK` (optional `DINGTALK_SECRET`)
1. In der Ziel-DingTalk-Gruppe → Gruppeneinstellungen → Intelligenter Gruppenassistent → Bot hinzufügen → **Benutzerdefiniert** (Webhook-Anbindung)
2. Als Sicherheitseinstellung **Signatur** empfohlen: den auf der Seite angezeigten Schlüssel (beginnt mit SEC) in `DINGTALK_SECRET` eintragen; ohne Konfiguration wird ohne Signatur direkt verbunden
3. Webhook-Adresse der Form `https://oapi.dingtalk.com/robot/send?access_token=xxxx` kopieren und in `DINGTALK_WEBHOOK` eintragen

**ServerChan (WeChat-Push)** — `SERVERCHAN_SENDKEY`
1. [sct.ftqq.com](https://sct.ftqq.com) öffnen und per WeChat-QR-Code einloggen
2. Auf der Startseite den **SendKey** (Form `SCTxxxxxxxxxxxx`) kopieren und in die Variable eintragen; Nachrichten werden an Ihren WeChat-Dienstaccount „方糖“ geschickt

**PushPlus (WeChat-Push)** — `PUSHPLUS_TOKEN`
1. [pushplus.plus](https://www.pushplus.plus) öffnen und per WeChat-QR-Code einloggen
2. Auf der Startseite das **Token** kopieren und in die Variable eintragen; nach dem Folgen des öffentlichen Accounts kommt der Push in WeChat an

**Telegram Bot** — `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (beide konfiguriert = aktiv)
1. In TG [@BotFather](https://t.me/BotFather) suchen → `/newbot`, den Anweisungen folgen → Bot-Token erhalten (Form `123456:ABC-xxx`)
2. `chat_id` ermitteln: dem Bot zuerst eine Nachricht schicken, dann `https://api.telegram.org/bot<你的Token>/getUpdates` im Browser öffnen und im JSON-Antworttext `chat.id` suchen (in Gruppen: den Bot in die Gruppe holen und eine Nachricht senden, dann ist die Gruppen-ID ebenfalls sichtbar)
3. Beide Werte in `TELEGRAM_BOT_TOKEN` bzw. `TELEGRAM_CHAT_ID` eintragen

**Bark (iOS-Push)** — `BARK_DEVICE_KEY` (optional `BARK_URL`)
1. [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865) aus dem App Store installieren, die App öffnen und den Key-Teil der Beispiel-URL kopieren (`https://api.day.app/<das ist der Key>/...`)
2. Key in `BARK_DEVICE_KEY` eintragen; bei eigenem Server zusätzlich `BARK_URL` setzen (Standard ist die offizielle `https://api.day.app`)

**ntfy (Android/iOS/Web-Abonnement)** — `NTFY_URL` (optional `NTFY_TOKEN`)
1. ntfy-App auf dem Handy installieren (oder die [ntfy.sh](https://ntfy.sh)-Webseite nutzen) und einen eigenen Topic-Namen abonnieren, z. B. `my-sms-9f2k` (je zufälliger der Name, desto privater)
2. In `NTFY_URL` die vollständige Topic-URL eintragen: `https://ntfy.sh/my-sms-9f2k` (eigener Server: Ihre eigene Adresse; Bereitstellung hinter Reverse-Proxy-Unterpfaden wird unterstützt)
3. Wenn für das Topic Zugriffskontrolle aktiv ist, `NTFY_TOKEN` setzen: Access Token (`tk_`-Präfix) direkt eintragen; eigener Server im Format `Benutzername:Passwort`

**Gotify (eigener Push-Dienst)** — `GOTIFY_URL` + `GOTIFY_TOKEN`
1. Wer Gotify bereits selbst betreibt: im Web einloggen → **Apps** → Anwendung anlegen → **Token** kopieren
2. In `GOTIFY_URL` die Serveradresse eintragen (z. B. `https://push.example.com`, **ohne** `/message`), Token in `GOTIFY_TOKEN`

**E-Mail (Resend API)** — `RESEND_API_KEY` + `MAIL_TO` (optional `MAIL_FROM`)
1. [resend.com](https://resend.com) öffnen und registrieren (kostenloses Kontingent: 100 Mails pro Tag, 3000 pro Monat)
2. **API Keys** → Create API Key, kopieren und in `RESEND_API_KEY` eintragen
3. In `MAIL_TO` die Empfänger-Adresse(n) eintragen (mehrere kommasepariert); ohne `MAIL_FROM` gilt `onboarding@resend.dev` (dieser Standard-Absender kann nur an die bei der Resend-Registrierung verwendete Adresse senden; für beliebige Empfänger die eigene Domain bei Resend verifizieren und `MAIL_FROM` setzen)

**Generischer Webhook / Drittanbieter-API** — `GENERIC_WEBHOOKS` (optional `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`)
1. In `GENERIC_WEBHOOKS` eine oder mehrere URLs eintragen (**kommasepariert**). Standardmäßig wird JSON per POST gesendet:

```json
{"title":"【短信】13800138000 ← 10086","content":"正文…","time":"2026-10-14 12:30:00（北京时间）","source":"sms","sender":"1069012345678","device":"我的手机"}
```

2. Braucht die Gegenseite ein bestimmtes Format, `GENERIC_WEBHOOK_TEMPLATE` mit den Platzhaltern `{{title}}` / `{{content}}` / `{{time}}` / `{{source}}` / `{{sender}}` / `{{device}}` für einen eigenen Body setzen; ist die Vorlage als JSON parsebar, wird sie als JSON gesendet, sonst als reiner Text. Beispiel:

```
{"phone":"13800138000","msg":"{{content}}","at":"{{time}}"}
```

3. Braucht die Gegenseite Authentifizierungsheader (der Schlüssel soll nicht in die URL), `GENERIC_WEBHOOK_HEADERS` als JSON-Objekt-String setzen, z. B.:

```json
{"Authorization":"Bearer sk-xxx","X-Api-Key":"yyy"}
```

Ist der Wert kein gültiges JSON, wird er ignoriert; die Standard-Weiterleitung bleibt unberührt. Über diese Vorlage lassen sich beliebige Drittanbieter-APIs anbinden — SMS-Gateways, Home Assistant, n8n, eigene Skripte usw. Variablennamen und Ablageorte je Kanal: siehe Tabelle „Variablen und Secrets“ oben; bei Cloudflare auf der Worker-Seite „Variables and Secrets“ konfigurieren, bei den übrigen Plattformen an der in der jeweiligen Anleitung beschriebenen Stelle für Umgebungsvariablen.

### 3. Datenbank

Die D1-Tabelle `messages` braucht die Spalten `source` (unterscheidet SMS/Benachrichtigung) und `deleted_at` (Soft-Delete/Undo). Bei einer Neuinstallation direkt [schema.sql](../../../schema.sql) ausführen; für ein Upgrade einer alten Datenbank:

```sql
ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'sms';
ALTER TABLE messages ADD COLUMN deleted_at TEXT;
ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN read_at TEXT;
```

---

## 2. Push-API-Spezifikation

Beide öffentlichen Endpunkte authentifizieren über `RECEIVE_TOKEN` (Token im Query oder im Body):

### 1. SMS-Empfang `POST /api/receive` (exklusiv für die Android-App)

```
POST https://<你的域名>/api/receive?token=<RECEIVE_TOKEN>
Content-Type: application/json

{
  "name": "我的手机",
  "sim": "13800138000",
  "from": "1069012345678",
  "content": "您的验证码是 734752，5 分钟内有效",
  "time": "2026-10-14 12:29:59"
}
```

### 2. Universeller Push `POST /api/push` (Benachrichtigungen aller Plattformen)

```
POST https://<你的域名>/api/push
Content-Type: application/json

{
  "token": "<RECEIVE_TOKEN>",
  "source": "notify",
  "sender": "备份脚本",
  "name": "通知网关",
  "content": "数据库备份完成，耗时 3 分 12 秒",
  "time": "2026-10-14 03:00:00"
}
```

| Feld | Erforderlich | Beschreibung |
|---|---|---|
| `token` | ja | Authentifizierungstoken |
| `content` | ja | Nachrichtentext (`text`/`message`/`msg` funktionieren ebenfalls) |
| `source` | nein | Quellenkennung, Standard `notify`; wird für den „Quellenfilter“ der Webseite genutzt, frei wählbar (z. B. `cron`, `alert`) |
| `sender` | nein | Quellentitel (Hostname/App-Name/Skriptname) |
| `name` | nein | Geräte-Label (eigene Benennung), Standard „Notification Gateway“, wird parallel zum SMS-Label angezeigt |
| `time` | nein | Ereigniszeit; ohne Angabe gilt die aktuelle Serverzeit; Zeitstempel oder Text `YYYY-MM-DD HH:MM:SS` werden unterstützt |

Antwort: `{"success":true,"device_id":17,"duplicated":false}` (`duplicated=true` heißt: Duplikat wurde ignoriert, keine erneute Weiterleitung an die Benachrichtigungskanäle)

---

## 3. Anbindung je Plattform

### Android (SMS + App-Benachrichtigungen) — SmsForwarder

1. Die Open-Source-App „SmsForwarder“ ([pppscn/SmsForwarder](https://github.com/pppscn/SmsForwarder)) installieren
2. In den allgemeinen Einstellungen den Hauptschalter **„SMS-Broadcast weiterleiten“** aktivieren
3. Einen „Webhook-Kanal“ anlegen: als URL `/api/receive?token=<RECEIVE_TOKEN>` eintragen, Nachrichtenvorlage:

```json
{"name":"我的手机","sim":"13800138000","from":"{{FROM}}","content":"{{SMS}}","time":"{{DATE}}"}
```

> Kernpunkte: in `name` den eigenen Gerätenamen eintragen (das Web-Label zeigt ihn; eine Umbenennung erzeugt ein neues Label); in `sim` direkt die Handynummer (unten rechts auf der Karte sichtbar, Doppelklick kopiert); `content` muss die Variable `{{SMS}}` verwenden.
> App-Benachrichtigungen weiterleiten: zusätzlich eine „App-Benachrichtigung“-Weiterleitungsregel anlegen, in der Vorlage `sender` mit `{{APP_NAME}}` und `content` mit `{{MSG}}` befüllen, und das Ziel auf `/api/push` ändern.

### iOS — Kurzbefehle (Shortcuts)

1. Kurzbefehle → Automation → neue „persönliche Automation“ → „SMS/Info empfangen“ wählen
2. Aktion hinzufügen → „URL-Inhalt abrufen“:
   - URL: `https://<Ihre-Domain>/api/push`
   - Methode: POST, Body als JSON:

```json
{"token":"<RECEIVE_TOKEN>","source":"sms","sender":"iPhone","name":"通知网关","content":"[信息正文变量]"}
```

3. „Vor Ausführung fragen“ deaktivieren — danach läuft alles vollautomatisch. Zeitgesteuerte Benachrichtigungen (Akkustand, Fokusmodi) funktionieren analog; den passenden Trigger wählen.

### Linux — curl / Skripte / systemd

Der einfachste Einzeiler:

```bash
curl -s -X POST https://<你的域名>/api/push \
  -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"web-01","content":"Nginx 已重启"}'
```

Beispiel für zeit-/ereignisbasierte Benachrichtigungen (`/usr/local/bin/notify.sh`):

```bash
#!/bin/bash
curl -s -X POST https://<你的域名>/api/push \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"<RECEIVE_TOKEN>\",\"sender\":\"$(hostname)\",\"source\":\"cron\",\"content\":\"$1\"}"
```

Mit einem systemd-Timer oder cron aufrufen: `notify.sh "每日备份完成"`.

Fortgeschritten (optional): [ntfy](https://ntfy.sh) selbst hosten (eine Binärdatei/Docker), mehrere Maschinen denselben Event-Stream abonnieren lassen und über ein kleines Brückenskript die ntfy-Nachrichten an dieses Gateway weiterleiten.

### Windows — PowerShell / Aufgabenplanung

`C:\Tools\notify.ps1`:

```powershell
param([string]$Message = "通知")
$body = @{
  token  = "<RECEIVE_TOKEN>"
  sender = $env:COMPUTERNAME
  source = "notify"
  content = $Message
} | ConvertTo-Json
Invoke-RestMethod -Uri "https://<你的域名>/api/push" -Method Post -ContentType "application/json" -Body $body
```

Aufruf: `powershell -File C:\Tools\notify.ps1 -Message "磁盘清理完成"`; in der Aufgabenplanung z. B. an Ereignisse wie „vor dem Herunterfahren“ oder „nach dem Backup“ hängen.

### macOS — Kurzbefehle / launchd

- Kurzbefehle: wie bei iOS (Automationstrigger z. B. „Bestimmte Zeit“, „Dateiänderung“)
- Zeitgesteuertes Skript + launchd (`~/Library/LaunchAgents/local.notify.plist`):

```bash
curl -s -X POST https://<你的域名>/api/push -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"MacBook","content":"Time Machine 备份完成"}'
```

- Wer iPhone-SMS auf dem Mac empfangen möchte: per AppleScript das SQLite-Store von Messages.app auf neue Einträge pollen und pushen (für Fortgeschrittene)

### Server/Container allgemein — Apprise (optionale Aggregationsschicht)

[Apprise](https://github.com/caronc/apprise) unterstützt 100+ Benachrichtigungsziele; dieses Gateway lässt sich als einer dieser benutzerdefinierten Webhooks einbinden und so den Multi-Ziel-Push zentral verwalten.

---

## 4. Prüfliste

| Prüfpunkt | Methode |
|---|---|
| API-Authentifizierung | Eine Anfrage ohne Token muss 403 unauthorized liefern |
| Universeller Push | Eines der Beispiele oben senden; unter der Web-Quelle „Benachrichtigungen“ sichtbar, konfigurierte Benachrichtigungskanäle erhalten sie synchron |
| SMS-Kette | Eine echte SMS ans Handy senden → unter der Web-Quelle „SMS“ sichtbar + OTP-Erkennung + Weiterleitung an die Kanäle |
| Quellenfilter | In der Toolbar der Admin-Seite das Dropdown „Quellenfilter“ umschalten: Alle / SMS / Benachrichtigungen und benutzerdefinierte Quellen |
| Sprachwechsel (neun Sprachen) | Admin-Seite und Login-Seite enthalten neun Sprachen (简体中文 / 繁體中文 / English / 日本語 / 한국어 / Español / Français / Deutsch / Português (BR)); über das „🌐“-Menü oben rechts wird die ganze Seite umgeschaltet, die Auswahl wird lokal im Browser gemerkt; alternativ direkt `https://你的域名/?lang=ja` usw. aufrufen. Alte Links `?lang=zh` / `?lang=en` bleiben kompatibel (automatische Normalisierung zu zh-CN / en) |
| Export & Filter | „Export CSV / JSON“ klicken, um das aktuelle Filterergebnis herunterzuladen; nach Wechsel auf „Letzte 7 Tage“ / „50 pro Seite“ ändern sich Liste und Export entsprechend |
| Duplikatsperre | Denselben Inhalt sekundenschnell erneut senden → Antwort `duplicated:true`, die Kanäle pushen nicht doppelt |

## 5. Häufige Fragen

- **Gepusht, aber die Webseite aktualisiert sich nicht?** Die Admin-Seite nutzt Long-Polling mit Auto-Aktualisierung (standardmäßig max. 25 Sekunden Hängezeit, über `WAIT_MAX_SECONDS` anpassbar); beim Zurückwechseln zur Seite wird sofort nachgeladen; alternativ einmal den Quellenfilter umschalten, um das Laden anzustoßen.
- **Oberfläche auf dem Handybrowser gequetscht / Login-Dialog vergrößert?** Die mobile Anpassung ist eingebaut (Safe-Area, 16px-Eingabefelder gegen den iOS-Autozoom, größere Touch-Ziele); falls weiterhin etwas ungewöhnlich erscheint, den Cache dieser Seite leeren und erneut versuchen.
- **Long-Polling auf Netlify wirft laufend Fehler?** `WAIT_MAX_SECONDS` auf `8` setzen (unter dem 10s-Limit der Functions).
- **Der Benachrichtigungskanal hat nichts erhalten?** Prüfen, ob die Variablen des Kanals gesetzt und korrekt sind (Paare wie Telegram/Gotify vollständig setzen); in den Logs der Bereitstellungsplattform nach `notify forward failed:` sehen; Nachrichten mit `duplicated:true` werden nicht weitergeleitet.
- **Label umbenennen?** Auf „✎“ hinter dem Geräte-Label klicken (Alias setzen) oder auf „⇄“ klicken, um die Nachrichten dieses Labels mit einem anderen Gerät zusammenzuführen; leere Labels lassen sich direkt per „×“ löschen.
- **Wie lange bleiben Nachrichten?** Gesteuert von `RETENTION_DAYS`, Standard 30 Tage; die automatische Bereinigung läuft täglich um UTC 17:00 (01:00 Pekingzeit).
