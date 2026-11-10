# SMSToWeb — SMS- & Benachrichtigungs-Cloud-Gateway

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | **Deutsch** | [Português (BR)](../pt-BR/README.md)

SMSToWeb bündelt Nachrichten aus beliebigen Kanälen (SMS-Weiterleitung, App-Benachrichtigungen, Skripte, Webhooks und eigene Integrationen) über eine gemeinsame HTTP-API und ein einheitliches Nachrichtenformat an einem Ort — lesbar, durchsuchbar und weiterleitbar über eine einzige Webseite.

- **Multiplattform-Unterstützung**: Cloudflare Workers / Vercel / Deno Deploy / Netlify / Tencent EdgeOne Makers / Docker-Selfhosting — wählen Sie die Plattform, die zu Ihrer Umgebung passt.
- **Echtzeitempfang**: Webhook-Push landet in Sekunden in der Datenbank; die Webseite aktualisiert sich selbst, keine manuelle Arbeit
- **Universeller Push**: Jedes Gerät, das HTTP-Anfragen senden kann (Linux / Windows / macOS / iOS / NAS / Skripte), kann Benachrichtigungen auf dieselbe Seite pushen
- **Quellen & Filter**: Dynamisches Filtern nach Quelle (SMS / Benachrichtigungen und benutzerdefinierte Quellen werden automatisch aggregiert), kombiniert mit Schlagwortsuche und den Zeiträumen Heute / Letzte 7 Tage / Letzte 30 Tage; einstellbare Seitengröße
- **Weiterleitung über mehrere Kanäle**: Neue Nachrichten lassen sich automatisch an Feishu / WeCom / DingTalk / Telegram / ServerChan / PushPlus / Bark / ntfy / Gotify / E-Mail / generische Webhooks weiterleiten — nur konfigurieren, was genutzt wird (optional)
- **Optionale Sicherheit**: Admin-Login-Schalter, mehrformatige OTP-Code-Erkennung (Code zuerst / Schlüsselwort zuerst / segmentiert / gemischt, resistent gegen Fehlalarme) mit Ein-Tipp-Kopieren, Dunkelmodus
- **Daten & Alarme**: Export von CSV / JSON nach aktuellem Filter; Toast / optionaler Ton / schwebende Pille für neue Nachrichten bei sichtbarer Seite, Browser-Benachrichtigung + ungelesener Titel im Hintergrund; lange Nachrichten werden automatisch eingeklappt
- **Nummernerkennung**: Eingebautes Verzeichnis gängiger institutioneller Nummern (Netzbetreiber / Banken / Paketdienste / Behörden) mit automatischer Beschriftung; optionale Regions-Abfrage des Netzbetreibers für unbekannte Mobilnummern (standardmäßig aktiviert, deaktivierbar)
- **9 Sprachen**: Die Admin- und Anmeldeseiten bringen zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR eingebaut mit; Umschalten über das 🌐-Menü im Kopfbereich (`?lang=`-Deeplink unterstützt, Auswahl wird lokal gemerkt); Datumsangaben, relative Zeiten und Verzeichnisbeschriftungen wechseln mit
- **Mobilfreundlich**: `viewport-fit`-Safe-Area-Unterstützung für Notch und Gestenleiste, 16px-Eingabefelder gegen den iOS-Autozoom, größere Touch-Ziele, Bottom-Sheet-Dialoge, PWA zum Hinzufügen zum Startbildschirm
- **Massenaktionen & Undo**: Löschen per Mehrfachauswahl, Leeren nach Filter mit einem Tipp; 5 Sekunden lang rückgängig machbar nach dem Löschen (Soft-Delete); Dunkelmodus mit automatisch / hell / dunkel
- **Favoriten / Ungelesen / Statistiken**: Mit Stern anpinnen, Ansichten nur Favoriten / nur Ungelesene, Statistik-Panel (Quellenverteilung + letzte 7 Tage); benutzerdefinierte Nummern-Labels; Suchhervorhebung und -verlauf; Nicht-stören und Ton in den Einstellungen; PWA

```
[SMS] Android(SmsForwarder) ──POST /api/receive──┐
                                                 ├─→ Cloud-Gateway (beliebige Plattform) ─→ Datenbank
[Benachrichtigung] Skripte / Kurzbefehle ──POST /api/push────┘        │
                                                Browser ◀── Web-Admin (im Gateway eingebettet)
```

**Ein-Klick-Bereitstellung (Cloudflare)**:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

Der Button erstellt Datenbank und Tabellen, bindet Ressourcen und richtet CI automatisch ein; beim Prompt `RECEIVE_TOKEN` (Push-Authentifizierungsgeheimnis) eintragen — und Sie sind live. Ein-Klick-Buttons für Vercel / Netlify finden Sie in deren Plattform-Anleitungen.

| Plattform | Bereitstellung | Geplante Bereinigung | Anleitung |
|---|---|---|---|
| **Cloudflare** (empfohlen) | Worker + D1 | Plattform-Cron | [platforms/cloudflare/README.md](../../../platforms/cloudflare/README.md) |
| Vercel | Edge Function + Turso | Plattform-Cron | [platforms/vercel/README.md](../../../platforms/vercel/README.md) |
| Deno Deploy | Deno nativ + Turso | Deno.cron | [platforms/deno/README.md](../../../platforms/deno/README.md) |
| Netlify | Functions v2 + Turso | Scheduled Function | [platforms/netlify/README.md](../../../platforms/netlify/README.md) |
| Tencent EdgeOne Makers | Functions + Turso | externer Cron | [platforms/edgeone/README.md](../../../platforms/edgeone/README.md) |
| Fly.io / Railway / VPS | Docker (Node 22) + Turso / lokales SQLite | im Prozess | [platforms/node/README.md](../../../platforms/node/README.md) |

> Jedes Plattformverzeichnis ist **vollständig in sich geschlossen** (Code + Schema + eigenständige Dokumentation, null npm-Abhängigkeiten, kein Build-Schritt). Klicken Sie auf eine Anleitung oben und folgen Sie den Schritten. Funktionen und Datenschema sind plattformübergreifend identisch; Sie können jederzeit zwischen ihnen migrieren.
> Für den Plattformvergleich und die gemeinsame Vorbereitung (Turso-Datenbank) siehe [platforms/README.md](../../../platforms/README.md).

---

## Telefoneinrichtung & Anbindung mehrerer Geräte

Alle Plattformen liefern Nachrichten in dieselbe Webseite: Telefon-SMS laufen über `/api/receive` (Android SmsForwarder), alles andere nutzt den universellen `/api/push`.

Schritt-für-Schritt-Konfiguration (Copy-Paste-Befehle/Skripte je Plattform): **[Bereitstellungs- & Anbindungsleitfaden](../../../docs/i18n/en/DEPLOYMENT.md)**

**Universeller Push – Kurzreferenz** (vollständige Felder im Leitfaden):

```
POST https://<your-domain>/api/push?token=<RECEIVE_TOKEN>
{"source":"notify","sender":"demo","content":"hello from anywhere"}
```

Eine `{"success":true,...}`-Antwort bedeutet, dass gespeichert wurde; wird exakt dasselbe Payload erneut gepusht, liefert die Antwort `duplicated:true`.

## Umgebungsvariablen (alle Plattformen)

| Variable | Erforderlich | Beschreibung |
|---|---|---|
| `RECEIVE_TOKEN` | ja | Push-Authentifizierungsgeheimnis; langen zufälligen String wählen |
| `ENABLE_AUTH` | nein | `"true"` verlangt Login für die Admin-Seite (**dringend empfohlen**, siehe Sicherheitshinweise unten); Standard ist kein Login |
| `ADMIN_PASSWORD` | nein | Login-Passwort (setzen, wenn `ENABLE_AUTH="true"`; fehlt es, verweigern die Admin-APIs den Zugriff und loggen einen Alarm — fehlende Konfiguration öffnet niemals die Tür) |
| `RETENTION_DAYS` | nein | Datenaufbewahrung in Tagen, Standard 30 |
| `WAIT_MAX_SECONDS` | nein | maximale Sekunden, die `/api/wait` beim Long-Polling hängen darf, Standard 25 (Bereich 3–25). Auf **Netlify Functions** (10s Limit) oder anderen Plattformen mit kurzem Timeout `8` setzen, damit Anfragen nicht von der Plattform abgebrochen werden |
| `PHONE_AREA_ENABLED` / `PHONE_AREA_API` | nein | Regions-Abfrage zum Netzbetreiber: standardmäßig aktiviert (kostenlose 360 API, kein Schlüssel, 24h Backend-Cache, nur 11-stellige Mobilnummern); `false` zum Deaktivieren; eigene Quelle über `PHONE_AREA_API` (URL mit `{number}`-Platzhalter) |
| Benachrichtigungskanal-Variablen | nein | `FEISHU_WEBHOOK` (Feishu) / `WECOM_WEBHOOK` (WeCom) / `DINGTALK_WEBHOOK` (DingTalk, optional `DINGTALK_SECRET`-Signatur) / `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY` (optional `BARK_URL`) / `NTFY_URL` (optional `NTFY_TOKEN`) / `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO` (E-Mail, optional `MAIL_FROM`) / `GENERIC_WEBHOOKS` (generischer Webhook, optional `GENERIC_WEBHOOK_TEMPLATE` Body / `GENERIC_WEBHOOK_HEADERS` Header). Nur konfigurieren, was genutzt wird; ohne Konfiguration wird nichts weitergeleitet. Benachrichtigungen werden inhaltsabhängig automatisch in drei Modi gerendert (🔐 OTP / 💬 SMS / 🔔 Benachrichtigung) |
| `SITE_NAME` / `SITE_ICON` | nein | Seitenname / Icon-URL; ohne Angabe gelten Standardwerte |
| `NOTIFY_LINK` | nein | URL der Admin-Startseite; wenn gesetzt, erhält jeder Benachrichtigungskanal einen „Admin öffnen“-Eintrag (Button/Link/Klick); ohne Setzen automatisch weggelassen |
| `SESSION_SECRET` | erforderlich, wenn Login aktiv | Session-Signaturschlüssel: **hochentropier Zufallswert (≥32 zufällige Zeichen empfohlen), völlig unabhängig vom Admin-Passwort**; Cloudflare und EdgeOne (und jede andere Plattform) brauchen jeweils einen eigenen Wert; niemals in Git committen oder das Passwort wiederverwenden. Fehlt er, schlagen Login und Authentifizierung **fail closed** fehl (Login liefert 500, Admin-APIs 401, kein passwortderivierter Fallback). Durch Rotation werden alle bestehenden Sessions sofort ungültig. Sessions dauern 30 Minuten; Logout löscht nur den Browser-Cookie — ein kopierter Session-Token bleibt innerhalb seiner TTL gültig (bis zu 30 Minuten) |

Cloudflare benötigt zusätzlich die `DB`-Bindung (D1); andere Plattformen brauchen `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (Turso-Datenbank, siehe jeweilige Plattform-Anleitung); Node-Selfhosting unterstützt zudem den `SQLITE_PATH`-Modus mit lokalem SQLite (siehe platforms/node/README.md).

> **Sicherheitsempfehlungen**
> 1. **Admin-Login einschalten** (`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`): Die Admin-Seite enthält sensible Inhalte wie SMS-OTP-Codes; ohne Login kann jeder, der die Domain kennt, alle Nachrichten lesen und Daten löschen. Der Login-Endpunkt ist ratenlimitiert (5 Fehlversuche in Folge pro IP sperren ihn für 10 Minuten); `/api/receive` und `/api/push` sind auf 120 Schreibvorgänge pro IP pro Minute limitiert (darüber 429).
> 2. **Abwägung zu `?token=` in URLs**: Zur Kompatibilität mit SmsForwarder und ähnlichen Clients akzeptieren `/api/receive` und `/api/push` die Authentifizierung über den `?token=`-Query-Parameter — der Token kann in den Zugriffslogs der Plattform und im Browserverlauf auftauchen. Wenn das ein Anliegen ist, auf POST mit dem `Authorization: Bearer <RECEIVE_TOKEN>`-Header umsteigen (beide Varianten werden unterstützt).

## Lizenz

[MIT](../../../LICENSE) © 2026 [左立方 (ZuoLifang)](https://cbm.im/)
