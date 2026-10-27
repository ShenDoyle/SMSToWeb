# Documentación de la API (API)
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | **Español** | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Sincronizado del original en inglés (es)

Todas las rutas toman `/` como raíz, responden en JSON (`Content-Type: application/json`) y soportan CORS. Salvo las «rutas públicas», están protegidas por el interruptor de login (las recomendaciones de configuración de seguridad están en el README raíz, «Recomendaciones de seguridad»).

## Formas de autenticación

| Tipo de ruta | Autenticación |
|---|---|
| Push entrante (`/api/receive`, `/api/push`) | `?token=<RECEIVE_TOKEN>` (query o campo de formulario), **no depende del interruptor de login** |
| APIs de administración | sesión por cookie `sms_auth` (se obtiene con `POST /api/login`; activa con `ENABLE_AUTH=true`). La sesión es un **token firmado sin estado** (`nonce.exp.HMAC-SHA256` en tres segmentos, clave de firma `SESSION_SECRET`), dura 30 minutos; si falta `SESSION_SECRET` falla de forma segura (fail-closed) (el inicio de sesión devuelve 500, las APIs de administración devuelven siempre 401, sin alternativa derivada de la contraseña), ante una configuración ausente no se concede acceso en ningún caso. Rotar `SESSION_SECRET` invalida inmediatamente todas las sesiones antiguas |
| Limpieza programada (`GET /api/cron`) | `?token=<RECEIVE_TOKEN>` o `Authorization: Bearer <RECEIVE_TOKEN>` |

## 1. Push entrante (público)

### POST/GET `/api/receive` — entrada de SMS (compatible con SmsForwarder)

Parámetros (body JSON; en GET van por query):

| Campo | Obligatorio | Descripción |
|---|---|---|
| `token` | Sí | RECEIVE_TOKEN (también puede ir en la query) |
| `name` | No | nombre del dispositivo (campo `name` de la plantilla de la app), por defecto `unknown` |
| `sim` | No | número de teléfono receptor, se almacena y muestra tal cual |
| `from` | No | remitente |
| `content` | Sí | cuerpo del SMS (el servidor lo trunca a 8000 caracteres) |
| `time` | No | hora del cliente; si falta se usa la hora de Pekín del servidor |

```bash
curl -X POST "https://<your-site>/api/receive?token=<RECEIVE_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"我的手机","sim":"13800000000","from":"10086","content":"验证码 123456"}'
```

Respuesta: `{ "success": true, "device_id": 1, "duplicated": false }`. Un push repetido con el mismo dispositivo+remitente+contenido+hora al segundo → `duplicated: true` (no se almacena y **no se reenvía la notificación**).

### POST `/api/push` — push universal (conexión desde cualquier plataforma)

| Campo | Obligatorio | Descripción |
|---|---|---|
| `token` | Sí | RECEIVE_TOKEN (query) |
| `content` | Sí | cuerpo (se trunca a 8000 caracteres) |
| `name` / `sender` | No | nombre del dispositivo / remitente (nombre de app, de script, etc.) |
| `source` | No | categoría de fuente (por defecto `notify`; p. ej. `alert`, `jd`; el frontend puede filtrar por fuente) |
| `time` | No | hora del cliente; si falta, la hora actual del servidor |

Al recibir un mensaje también se dispara el reenvío de notificaciones por los 11 canales (renderizado en tres estados: un push sin código de verificación → 🔔 notificación de dispositivo).

## 2. Consulta y gestión de mensajes (requiere sesión iniciada)

### GET `/api/messages` — lista de mensajes

Parámetros de query:

| Parámetro | Descripción |
|---|---|
| `q` | búsqueda por palabra clave (coincide con sender/content) |
| `source` | filtro por fuente (p. ej. `sms` / `notify` / fuentes personalizadas) |
| `device_id` | filtro por dispositivo |
| `range` | rango temporal: `1d` / `7d` / `30d` |
| `limit` / `page` | paginación (50 por página por defecto) |
| `starred` | `1` solo destacados |

Respuesta: `{ "total": 123, "limit": 50, "page": 1, "list": [ { "id", "device_id", "display_name", "sim_number", "sender", "source", "content", "received_at", "starred", "read_at", "deleted_at" } ] }`

### Operaciones sobre mensajes

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/messages/remove` | borrado suave (body: `{ ids: [..] }`, escribe deleted_at) |
| POST | `/api/messages/restore` | restaurar borrado suave (body: `{ ids: [..] }`) |
| POST | `/api/messages/clear` | vaciar papelera/todo (body: `{ scope: "trash" \| "all" }`) |
| POST | `/api/messages/star` | conmutar destacado (body: `{ id, starred }`) |
| POST | `/api/messages/read` | marcar como leído (body: `{ id }`) |
| DELETE | `/api/messages/{id}` | borrado físico de un mensaje |

### GET `/api/export?format=csv|json` — exportación

Admite los mismos parámetros de filtro que la lista; el CSV lleva BOM y cabecera de descarga `attachment`, con protección frente a inyección de fórmulas (a las celdas que empiezan por `=/+-@` se les antepone una comilla simple).

### GET `/api/stats` — estadísticas

Resúmenes de hoy/total/número de dispositivos, etc. GET `/api/sources` — lista de fuentes (`[{ source, count }]`).

## 3. Gestión de dispositivos (requiere sesión iniciada)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/devices` | lista de dispositivos (con `display_name`: alias > nombre de dispositivo y recuento de mensajes) |
| POST | `/api/devices/alias` | fijar alias (body: `{ id, alias }`; la cadena vacía lo borra) |
| POST | `/api/devices/merge` | fusionar dispositivos (body: `{ from, to }`, migra todos los mensajes y borra el dispositivo de origen; origen→sí mismo devuelve 400) |
| DELETE | `/api/devices/{id}` | borrar dispositivo (si tiene mensajes devuelve `has messages` y se rechaza) |

## 4. Tiempo real y auxiliares

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/wait?last_id=N` | sondeo largo: si hay mensajes más nuevos que N devuelve al instante `{ changed: true }`; si no, se suspende (25s por defecto, ajustable con `WAIT_MAX_SECONDS`) |
| GET | `/api/phone?number=` | consulta de procedencia del número (se desactiva con `PHONE_AREA_ENABLED=false`; proxy upstream con límite de tasa, cubo independiente de 120 peticiones/min) |
| POST | `/api/login` | login (body: `{ password }` → `Set-Cookie: sms_auth=<sesión firmada>`, token sin estado HMAC-SHA256 en tres segmentos, TTL 30 minutos, HttpOnly + SameSite=Lax; 5 fallos bloquean 10 minutos; contraseña incorrecta 403, `SESSION_SECRET` faltante 500 error de configuración) |
| POST | `/api/logout` | logout |
| GET | `/api/cron?token=` | dispara la limpieza programada (borra los mensajes anteriores a `RETENTION_DAYS`) |
| GET | `/` `/manifest.webmanifest` `/sw.js` | página de administración / manifiesto PWA / Service Worker |

## 5. Formato de reenvío por webhook genérico (saliente)

Tras configurar `GENERIC_WEBHOOKS`, cada mensaje se envía por POST con este JSON por defecto:

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

`type` ∈ `verify | sms | notify`; `code` es el código de verificación detectado por la detección ligera del servidor (cadena vacía si no se detecta). Con `GENERIC_WEBHOOK_TEMPLATE` se renderiza según la plantilla (marcadores `{{title}} {{content}} {{time}} {{source}} {{sender}} {{device}} {{type}} {{code}}`); si se puede interpretar como JSON se envía como JSON, si no, como texto plano; `GENERIC_WEBHOOK_HEADERS` permite cabeceras personalizadas (cadena JSON de objeto).
