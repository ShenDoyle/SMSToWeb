# SMSToWeb — SMS- & Benachrichtigungs-Cloud-Gateway

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | **Deutsch** | [Português (BR)](../pt-BR/README.md)

> Synct mit dem englischen Original (de)

> Englisch ist die primär gepflegte Version dieses Dokuments. Die Übersetzungen liegen unter [`docs/i18n/<lang>/`](../../../docs/i18n/README.md) und können hinterherhinken; im Zweifel ist das englische Original maßgeblich.

SMS und Benachrichtigungen von einem Android-Telefon (und jedem anderen Gerät) in Echtzeit in die Cloud pushen und von überall über eine Webseite abrufen. Kostenlose Bereitstellung, kein Server nötig, etwa 10 Minuten von Anfang bis Ende.

- **Multiplattform-Bereitstellung**: Cloudflare (primär) / Vercel / Deno Deploy / Netlify / Tencent EdgeOne Makers / Docker-Selfhosting — eine von sechs wählen, Funktionen völlig identisch
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

**Ein-Klick-Bereitstellung (Cloudflare primär, ca. 2 Minuten)**:

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

### Laufzeitunterschiede (vor der Bereitstellung lesen)

Der Geschäftscode ist auf allen sechs Plattformen byte-identisch, aber **Timeouts / Hintergrundaufgaben / Timer** unterscheiden sich zur Laufzeit. Bei Bedarf über Umgebungsvariablen anpassen:

| Plattform | Funktions-Timeout | Hintergrund-Benachrichtigung | Geplante Bereinigung | Empfehlung |
|---|---|---|---|---|
| Cloudflare | kein Wanduhr-Limit (CPU-limitiert) | `ctx.waitUntil` läuft nach der Antwort weiter | Plattform-Cron | Standardwerte genügen |
| Vercel Edge | ~25s Limit pro Anfrage | wird inline vor der Antwort abgeschlossen | Plattform-Cron | `WAIT_MAX_SECONDS=20` |
| Netlify Functions | 60s (alle Tarife) | wird inline vor der Antwort abgeschlossen | Scheduled Function | Einstieg steht standardmäßig auf `WAIT_MAX_SECONDS=8` |
| Deno Deploy | tarifabhängig | wird inline vor der Antwort abgeschlossen | benötigt externen Trigger | externer Cron ruft `/api/cron?token=` auf |
| EdgeOne Makers | tarifabhängig | wird inline vor der Antwort abgeschlossen | benötigt externen Trigger | `WAIT_MAX_SECONDS` je nach Tarif senken |
| Node / Docker | Ihre Wahl | wird inline vor der Antwort abgeschlossen | benötigt externen Trigger | lokales SQLite braucht Node ≥ 22.13 |

> - **Long-Polling**: Das Frontend wiederholt Fehlversuche mit **exponentiellem Backoff** (2→30s) und pollt sofort erneut, sobald die Seite wieder sichtbar wird; von der Plattform abgebrochene Anfragen fluten die Funktion nie.
> - **Benachrichtigungsweiterleitung**: Cloudflare nutzt `waitUntil`; andere Plattformen schließen das Senden der Benachrichtigungen vor der Antwort ab (10s Timeout pro Kanal), daher fügen viele langsame Kanäle etwas Latenz hinzu.
> - **Geplante Bereinigung**: Auf Plattformen ohne Cron richten Sie einen beliebigen Scheduler auf `GET /api/cron?token=<RECEIVE_TOKEN>`.

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

## FAQ (allgemein)

- **Ein Label zeigt buchstäblich `{{XXX}}`** → kann nicht passieren: Das Gateway leert Labels, die ein literales `{{` enthalten, und fällt auf `sim` zurück; den eigenen Namen direkt im `name`-Feld der Vorlage setzen
- **API 401/403** → prüfen, ob `token=` in der URL zu `RECEIVE_TOKEN` passt; `/api/receive` und `/api/push` sind vom Login-Schalter unberührt
- **API 429** → Schreib-Ratenlimit erreicht (120/IP/min); nach einer Minute wieder frei — tritt es im normalen Betrieb auf, ist der Token womöglich geleakt oder etwas hämmert auf die API
- **Sehr lange Nachrichten** → ein einzelner Body ist auf 8000 Zeichen begrenzt, der Überschuss wird abgeschnitten
- **Geräte-Label umbenennen** → Ein Label stammt aus dem `name`-Feld der Nachrichtenvorlage; eine Änderung von `name` erzeugt ein neues Label. Verwenden Sie „✎“ neben einem Label auf der Webseite zum Umbenennen, „⇄“, um seine Nachrichten in ein anderes Gerät zusammenzuführen, und „×“, um ein leeres Label direkt zu löschen
- **Upgrade von einer älteren Version (neue Spalten)** → auf der alten Datenbank ausführen: `ALTER TABLE messages ADD COLUMN deleted_at TEXT;`, `ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;`, `ALTER TABLE messages ADD COLUMN read_at TEXT;` (frische Datenbanken enthalten sie bereits; Node mit lokalem SQLite fügt Spalten beim Start automatisch hinzu)

## Entwicklung

- `src/worker.js`: Kern-Quellcode (Cloudflare-Worker-Form)
- `platforms/gen_app.py`: erzeugt aus `src/worker.js` das plattformneutrale `app.js` in die fünf portierten Plattformen und synchronisiert die Cloudflare-Kopie `worker.js` (hält den Geschäftscode auf sechs Plattformen byte-identisch); synchronisiert außerdem die Whitelist mit 31 Umgebungsvariablen (ENV_KEYS, inkl. Auth-Einträgen) in die sechs Plattform-Eingänge, um Drift zu verhindern (node/db.js ist ein Dual-Adapter für Turso + lokales SQLite, separat gepflegt und nicht synchronisiert)
- `platforms/*/`: in sich geschlossene Bereitstellungsverzeichnisse (Einstieg + app.js + db.js-Adapter + schema.sql + Plattform-Anleitung)
- `docs/i18n/en/`: englischer Dokumentationssatz (Bereitstellung/API/Architektur/Datenbank); weitere Sprachen unter `docs/i18n/<lang>/` — siehe [docs/i18n/README.md](../../../docs/i18n/README.md)
- `tests/run.mjs`: Test-Suite ohne Abhängigkeiten (braucht Node 22.13+): `node tests/run.mjs`
- Nach Änderungen am Kerncode: `python platforms/gen_app.py` ausführen, um alle Plattformen neu zu synchronisieren, dann `node tests/run.mjs`; CI prüft Null-Sync-Drift + Syntax + Tests

## Lizenz

[MIT](../../../LICENSE) © 2026 [左立方 (ZuoLifang)](https://cbm.im/)
