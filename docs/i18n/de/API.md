# API-Dokumentation (API)

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | **Deutsch** | [Português (BR)](../pt-BR/README.md)

> Synct mit dem englischen Original (de)

Alle Endpunkte liegen unter `/` als Wurzel, Antworten sind JSON (`Content-Type: application/json`) mit CORS-Unterstützung. Außer den „öffentlichen Endpunkten“ sind sie durch den Login-Schalter geschützt (Empfehlungen zur Sicherheitskonfiguration siehe Root-README „Sicherheitsempfehlungen“).

## Authentifizierungsarten

| Endpunkt-Typ | Authentifizierung |
|---|---|
| Eingehender Push (`/api/receive`, `/api/push`) | `?token=<RECEIVE_TOKEN>` (Query oder Formularfeld), **vom Login-Schalter unberührt** |
| Admin-Endpunkte | Cookie-Session `sms_auth` (erhält via `POST /api/login`; aktiv, wenn `ENABLE_AUTH=true`). Die Session ist ein **zustandslos signierter Token** (`nonce.exp.HMAC-SHA256`-Drei-Segment-Format, Signaturschlüssel `SESSION_SECRET`), Gültigkeit 30 Minuten; fehlt `SESSION_SECRET`, schlagen Login und Authentifizierung sicher fehl (Login 500, Admin-Endpunkte ausnahmslos 401, kein Fallback auf Passwortableitung); fehlende Konfiguration lässt niemals durch. Nach einer Rotation von `SESSION_SECRET` werden alle alten Sessions sofort ungültig |
| Geplante Bereinigung (`GET /api/cron`) | `?token=<RECEIVE_TOKEN>` oder `Authorization: Bearer <RECEIVE_TOKEN>` |

## 1. Eingehender Push (öffentlich)

### POST/GET `/api/receive` — SMS in die Datenbank (SmsForwarder-kompatibel)

Parameter (JSON-Body; bei GET via Query):

| Feld | Erforderlich | Beschreibung |
|---|---|---|
| `token` | ja | RECEIVE_TOKEN (auch im Query möglich) |
| `name` | nein | Gerätename (Feld `name` der App-Vorlage), Standard `unknown` |
| `sim` | nein | Empfangende Handynummer, wird unverändert gespeichert und angezeigt |
| `from` | nein | Absender |
| `content` | ja | SMS-Text (wird serverseitig auf 8000 Zeichen gekürzt) |
| `time` | nein | Client-Zeit; ohne Angabe gilt die Pekinger Serverzeit |

```bash
curl -X POST "https://<your-site>/api/receive?token=<RECEIVE_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"我的手机","sim":"13800000000","from":"10086","content":"验证码 123456"}'
```

Antwort: `{ "success": true, "device_id": 1, "duplicated": false }`. Gleicher Push mit gleichem Gerät + Absender + Inhalt + Sekundenzeit → `duplicated: true` (Ablage übersprungen und **keine Benachrichtigungsweiterleitung**).

### POST `/api/push` — universeller Push (Anbindung beliebiger Plattformquellen)

| Feld | Erforderlich | Beschreibung |
|---|---|---|
| `token` | ja | RECEIVE_TOKEN (Query) |
| `content` | ja | Text (auf 8000 Zeichen gekürzt) |
| `name` / `sender` | nein | Gerätename / Absender (App-Name, Skriptname usw.) |
| `source` | nein | Quellkategorie (Standard `notify`; z. B. `alert`, `jd`; das Frontend filtert nach Quelle) |
| `time` | nein | Client-Zeit, ohne Angabe die aktuelle Serverzeit |

Auch dieser Empfang löst die Weiterleitung an die 11 Benachrichtigungskanäle aus (Drei-Zustände-Rendering: push ohne OTP → 🔔 Gerätebenachrichtigung).

## 2. Nachrichtenabfrage und -verwaltung (Login-Session nötig)

### GET `/api/messages` — Nachrichtenliste

Query-Parameter:

| Parameter | Beschreibung |
|---|---|
| `q` | Schlagwortsuche (durchsucht sender/content) |
| `source` | Quellenfilter (z. B. `sms` / `notify` / benutzerdefinierte Quelle) |
| `device_id` | Filter nach Gerät |
| `range` | Zeitraum: `1d` / `7d` / `30d` |
| `limit` / `page` | Paginierung (Standard 50 pro Seite) |
| `starred` | `1` nur Favoriten |

Antwort: `{ "total": 123, "limit": 50, "page": 1, "list": [ { "id", "device_id", "display_name", "sim_number", "sender", "source", "content", "received_at", "starred", "read_at", "deleted_at" } ] }`

### Nachrichtenaktionen

| Methode | Pfad | Beschreibung |
|---|---|---|
| POST | `/api/messages/remove` | Soft-Delete (body: `{ ids: [..] }`, schreibt deleted_at) |
| POST | `/api/messages/restore` | Soft-Delete zurücknehmen (body: `{ ids: [..] }`) |
| POST | `/api/messages/clear` | Papierkorb/Alles leeren (body: `{ scope: "trash" \| "all" }`) |
| POST | `/api/messages/star` | Stern umschalten (body: `{ id, starred }`) |
| POST | `/api/messages/read` | Als gelesen markieren (body: `{ id }`) |
| DELETE | `/api/messages/{id}` | Einzelne Nachricht physisch löschen |

### GET `/api/export?format=csv|json` — Export

Unterstützt dieselben Filterparameter wie die Liste; CSV mit BOM und `attachment`-Download-Header, Schutz vor Formelinjektion (Zellen, die mit `=/+-@` beginnen, erhalten ein vorangestelltes einfaches Anführungszeichen).

### GET `/api/stats` — Statistiken

Heute/Gesamt/Gerätezahl usw. als Zusammenfassung. GET `/api/sources` — Quellenliste (`[{ source, count }]`).

## 3. Geräteverwaltung (Login-Session nötig)

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/devices` | Geräteliste (mit `display_name`: Alias > Gerätename, sowie Nachrichtenanzahl) |
| POST | `/api/devices/alias` | Alias setzen (body: `{ id, alias }`; Leerstring löscht ihn) |
| POST | `/api/devices/merge` | Geräte zusammenführen (body: `{ from, to }`; migriert alle Nachrichten und löscht das Quellgerät; Quelle → sich selbst gibt 400 zurück) |
| DELETE | `/api/devices/{id}` | Gerät löschen (mit Nachrichten wird es mit `has messages` abgelehnt) |

## 4. Echtzeit und Hilfsfunktionen

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/wait?last_id=N` | Long-Polling: gibt es neuere Nachrichten als N, sofort `{ changed: true }`, sonst wird gehangen (Standard 25s, über `WAIT_MAX_SECONDS` einstellbar) |
| GET | `/api/phone?number=` | Regions-Abfrage zur Handynummer (`PHONE_AREA_ENABLED=false` deaktiviert; ratenlimitierter Upstream-Proxy, eigenes Kontingent von 120 pro Minute) |
| POST | `/api/login` | Login (body: `{ password }` → `Set-Cookie: sms_auth=<signierte Session>`, zustandsloser HMAC-SHA256-Drei-Segment-Token, TTL 30 Minuten, HttpOnly + SameSite=Lax; nach 5 Fehlversuchen 10 Minuten Sperre; falsches Passwort 403, fehlendes `SESSION_SECRET` 500 Konfigurationsfehler) |
| POST | `/api/logout` | Logout |
| GET | `/api/cron?token=` | Geplante Bereinigung auslösen (löscht Nachrichten älter als `RETENTION_DAYS`) |
| GET | `/` `/manifest.webmanifest` `/sw.js` | Admin-Seite / PWA-Manifest / Service Worker |

## 5. Format der generischen Webhook-Weiterleitung (ausgehend)

Nach der Konfiguration von `GENERIC_WEBHOOKS` wird für jede Nachricht folgendes JSON per POST gesendet:

```json
{
  "title": "🔐 验证码 726418 · Gitee",
  "content": "您的验证码是726418，5分钟内有效",
  "time": "2026-10-27 14:23:45",
  "source": "sms",
  "sender": "Gitee",
  "device": "我的手机",
  "type": "verify",
  "code": "726418"
}
```

`type` ∈ `verify | sms | notify`; `code` ist der serverseitig leichtgewichtig erkannte OTP-Code (Leerstring, wenn nicht erkannt). Mit `GENERIC_WEBHOOK_TEMPLATE` wird nach Vorlage gerendert (Platzhalter `{{title}} {{content}} {{time}} {{source}} {{sender}} {{device}} {{type}} {{code}}`); ist das Ergebnis als JSON parsebar, wird JSON gesendet, sonst reiner Text; `GENERIC_WEBHOOK_HEADERS` setzt eigene Header (JSON-Objekt-String).
