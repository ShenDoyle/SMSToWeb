# Datenbankdokumentation (DATABASE)

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | **Deutsch** | [Português (BR)](../pt-BR/README.md)

> Synct mit dem englischen Original (de)

SMSToWeb gleicht über eine einheitliche Datenbank-Adapterschicht (die vier Methoden `prepare/bind/first/all/run`, völlig identisch zur Cloudflare-D1-API) drei Speicher-Backends aus, sodass der Geschäftscode null SQL-Dialektunterschiede hat.

## 1. Backend-Matrix

| Plattform | Datenbank | Zugangsdaten-Variable | Adapterdatei |
|---|---|---|---|
| Cloudflare | D1 | Konsolen-Binding (`env.DB`), konfiguriert in wrangler.toml | nativ, ohne Adapter |
| Vercel / Netlify / Deno / EdgeOne | Turso (libsql) | `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | `platforms/shared/db.js` |
| Node-Selfhosting | Turso **oder** lokales SQLite | mit Turso-Variablen gilt Turso; sonst `SQLITE_PATH` (Standard `./data/smstoweb.db`, node:sqlite) | `platforms/node/db.js` (Dual-Adapter, separat gepflegt) |

Der plattformübergreifende Adapter nutzt reines `fetch` (Turso HTTP /v2/pipeline), ohne npm-Abhängigkeiten.

## 2. Tabellenschema (schema.sql als einzige Quelle)

### devices — Gerätetabelle

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER PK | Autoinkrement |
| `device` | TEXT | Gerätename (Feld `name` der App-Vorlage, Standard `unknown`) |
| `sim` | TEXT | Empfangsnummer (unverändert gespeichert und angezeigt, ohne Abbildung) |
| `alias` | TEXT | optionaler Alias (Anzeigepriorität in der Admin-Seite: alias > device) |
| `created_at` | TEXT | Ablagezeitpunkt |

Eindeutiger Index `idx_devices_key(device, sim)`: gleiches Gerät + gleiche Empfangsnummer ist eindeutig.

### messages — Nachrichtentabelle (10 Spalten)

| Spalte | Typ | Beschreibung |
|---|---|---|
| `id` | INTEGER PK | Autoinkrement |
| `device_id` | INTEGER FK | → devices.id |
| `sender` | TEXT | Absender |
| `content` | TEXT | Text (vor der Ablage auf 8000 Zeichen gekürzt) |
| `received_at` | TEXT | Pekinger Zeit (Sekundengenauigkeit) |
| `source` | TEXT | Quelle: `sms` / `notify` / benutzerdefiniert (z. B. `alert`) |
| `created_at` | TEXT | Ablagezeitpunkt |
| `deleted_at` | TEXT NULL | Zeitstempel des Soft-Deletes (NULL = normal) |
| `starred` | INTEGER | Stern 0/1 |
| `read_at` | TEXT NULL | Zeitstempel „gelesen“ |

Indizes: `idx_messages_device_time(device_id, received_at DESC)`, `idx_messages_time(received_at)`, `idx_messages_source(source, received_at DESC)` sowie der **Dedup-Eindeutigkeitsindex** `idx_messages_dedup(device_id, sender, content, received_at)` — doppelte Pushes werden auf Datenbankebene abgefangen; der Code fängt den Unique-Konflikt ab und liefert `duplicated:true`.

## 3. Migrationsregel (wichtig)

**Bei jeder Änderung an schema.sql muss an die Synchronisierung/Ausführung der Datenbankmigration auf allen bereits bereitgestellten Plattformen erinnert/ausgeführt werden** (Lehre aus dem Produktionsvorfall am 2026-10-22: Code wurde vor dem Schema bereitgestellt; die alte Turso-Datenbank lacked die Spalte `starred`, was alle Listenendpunkte mit 500 beendete).

- Neue Bereitstellung: direkt die Root-`schema.sql` ausführen (idempotent, `CREATE TABLE IF NOT EXISTS`);
- Upgrade alter Datenbanken: für die neuen Spalten `ALTER TABLE messages ADD COLUMN deleted_at TEXT;` / `ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;` / `ADD COLUMN read_at TEXT;` ausführen (Hinweis am Ende der schema.sql);
- Bereits migrierte Produktionsdatenbanken: CF D1 (sms-gateway-db, 10 Spalten verifiziert) und EO Turso (sms-gateway, migriert) brauchen keine weiteren Änderungen.

## 4. Datenaufbewahrung und Bereinigung

- Geplante Bereinigung (cron): löscht messages, deren `received_at` älter ist als `RETENTION_DAYS` (Standard 30 Tage);
- Auslösung: nativer Plattform-Cron (CF scheduled / Vercel Cron / Netlify Scheduled) oder ein beliebiger Scheduler über `GET /api/cron?token=<RECEIVE_TOKEN>`.

## 5. Hinweise zur Turso-Nutzung (Fehlersuche)

- **Tokentyp**: organisationsweiter API-Token (JWT-Payload nur org_id) ≠ Datenbanktoken (Payload enthält `a:"rw"`). Datenbanktoken entstehen in der Turso-Konsole → Datenbank-Detailseite → Tab Tokens; mit dem falschen Typ meldet /v2/pipeline `invalid JWT token` → alle DB-Endpunkte 500 „internal error“ (die Login-Seite fragt die Datenbank nicht ab und bleibt daher normal).
- **Client-Cache**: Der Turso-Client wird nach Zugangsdaten-Fingerprint keyed gecacht (bei Änderung von dbUrl+dbToken wird er automatisch neu aufgebaut); nach einem Tokenwechsel in der Konsole ist keine erneute Bereitstellung nötig.
- **Schnelldiagnose**: mit dem Datenbanktoken direkt `POST https://<db-url>/v2/pipeline` aufrufen (body: `{"requests":[{"type":"execute","stmt":{"sql":"SELECT 1"}},{"type":"close"}]}`).
