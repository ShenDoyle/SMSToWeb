# Documento de la base de datos (DATABASE)
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | **Español** | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Sincronizado del original en inglés (es)

SMSToWeb usa una capa de adaptación de base de datos unificada (los cuatro métodos `prepare/bind/first/all/run`, idénticos a la API de Cloudflare D1) que nivela tres backends de almacenamiento; el código de negocio tiene cero diferencias de dialecto SQL.

## 1. Matriz de backends

| Plataforma | Base de datos | Variables de credenciales | Archivo de adaptación |
|---|---|---|---|
| Cloudflare | D1 | binding en el panel (`env.DB`), configurado en wrangler.toml | nativo, sin adaptación |
| Vercel / Netlify / Deno / EdgeOne | Turso (libsql) | `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | `platforms/shared/db.js` |
| Node autohospedado | Turso **o** SQLite local | con las variables de Turso usa Turso; si no, `SQLITE_PATH` (por defecto `./data/smstoweb.db`, node:sqlite) | `platforms/node/db.js` (adaptación dual, mantenida por separado) |

La adaptación multiplataforma se implementa con `fetch` puro (Turso HTTP /v2/pipeline), sin dependencias npm.

## 2. Esquema de tablas (schema.sql como fuente única)

### devices — tabla de dispositivos

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | INTEGER PK | autoincremental |
| `device` | TEXT | nombre del dispositivo (campo `name` de la plantilla de la app, por defecto `unknown`) |
| `sim` | TEXT | número receptor (se almacena y muestra tal cual, sin mapear) |
| `alias` | TEXT | alias opcional (prioridad de visualización en el panel: alias > device) |
| `created_at` | TEXT | hora de inserción |

Índice único `idx_devices_key(device, sim)`: mismo dispositivo + mismo número receptor es único.

### messages — tabla de mensajes (10 columnas)

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | INTEGER PK | autoincremental |
| `device_id` | INTEGER FK | → devices.id |
| `sender` | TEXT | remitente |
| `content` | TEXT | cuerpo (se trunca a 8000 caracteres antes de almacenar) |
| `received_at` | TEXT | hora de Pekín (precisión de segundos) |
| `source` | TEXT | fuente: `sms` / `notify` / personalizada (p. ej. `alert`) |
| `created_at` | TEXT | hora de inserción |
| `deleted_at` | TEXT NULL | marca de tiempo del borrado suave (NULL = normal) |
| `starred` | INTEGER | destacado 0/1 |
| `read_at` | TEXT NULL | marca de tiempo de lectura |

Índices: `idx_messages_device_time(device_id, received_at DESC)`, `idx_messages_time(received_at)`, `idx_messages_source(source, received_at DESC)`, y el **índice único de deduplicación** `idx_messages_dedup(device_id, sender, content, received_at)` — los push duplicados se rechazan en la propia base de datos como última línea de defensa; el código captura el conflicto de unicidad y devuelve `duplicated:true`.

## 3. Regla de hierro de las migraciones (importante)

**Cada vez que se modifique schema.sql hay que recordar/ejecutar la migración en las bases de todas las plataformas ya desplegadas** (lección de un incidente en producción el 2026-10-22: el código se desplegó antes que el esquema y la base Turso antigua carecía de la columna `starred`, lo que tumbó con 500 toda la API de listado).

- Despliegue nuevo: ejecuta directamente el `schema.sql` de la raíz (idempotente, `CREATE TABLE IF NOT EXISTS`);
- Actualización de bases antiguas: para las columnas nuevas ejecuta `ALTER TABLE messages ADD COLUMN deleted_at TEXT;` / `ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;` / `ADD COLUMN read_at TEXT;` (hay una nota al final de schema.sql);
- Bases en producción ya cubiertas: la D1 de CF (sms-gateway-db, 10 columnas verificadas) y la Turso de EO (sms-gateway, ya migrada) no necesitan más cambios.

## 4. Retención y limpieza de datos

- Limpieza programada (cron): borra los messages con `received_at` anterior a `RETENTION_DAYS` (30 días por defecto);
- Forma de disparo: cron nativo de la plataforma (CF scheduled / Vercel Cron / Netlify Scheduled) o cualquier planificador llamando a `GET /api/cron?token=<RECEIVE_TOKEN>`.

## 5. Notas sobre el uso de Turso (experiencia de diagnóstico)

- **Tipo de token**: el API Token de organización (payload JWT solo con org_id) ≠ token de base de datos (payload con `a:"rw"`). El token de base de datos se genera en: consola de Turso → detalles de la base de datos → pestaña Tokens; si se usa el tipo equivocado, /v2/pipeline responde `invalid JWT token` → todas las APIs de DB devuelven 500 «internal error» (la página de login no consulta la base y por eso funciona).
- **Caché de clientes**: el cliente de Turso cachea por huella de credenciales (si cambian dbUrl+dbToken se reconstruye automáticamente); tras cambiar el token en la consola no hace falta redesplegar.
- **Diagnóstico rápido**: llama directamente con el token de base de datos a `POST https://<db-url>/v2/pipeline` (body: `{"requests":[{"type":"execute","stmt":{"sql":"SELECT 1"}},{"type":"close"}]}`).
