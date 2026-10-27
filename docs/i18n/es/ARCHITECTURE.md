# Documento de arquitectura (ARCHITECTURE)
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | **Español** | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Sincronizado del original en inglés (es)

SMSToWeb es un sistema de agregación de SMS/notificaciones de «núcleo único + entradas multiplataforma»: un núcleo de negocio sin dependencias npm (`src/worker.js`) se sincroniza mediante un script generador a seis plataformas de despliegue, y cada plataforma solo conserva una fina capa de adaptación para conectarse a su propio runtime y base de datos.

## 1. Topología general

```
手机（SmsForwarder / 任意脚本）
   │  POST /api/receive（短信）或 /api/push（通用推送）+ token
   ▼
┌─────────────────────────── 任选一个平台部署 ────────────────────────────┐
│  Cloudflare Workers (D1)   Vercel Edge   Deno Deploy                     │
│  Netlify Functions         EdgeOne (Turso)   Node 自托管 (Docker)         │
│                                                                           │
│  入口层（薄适配）：接收请求 → buildEnv 透传环境变量 → fetchApp()          │
│  业务核心（单文件 app.js）：鉴权 → 入库 → 查询 → 长轮询 → 通知转发        │
└──────────────────────────────────────────────────────────────────────────┘
   │                                  │
   ▼                                  ▼
管理页（内嵌 HTML，登录鉴权）      11 渠道通知转发（飞书/企微/钉钉/…）
```

Principio de diseño central: **separación entre el código de negocio y las entradas de plataforma**. La lógica principal no cambia según la plataforma de despliegue; solo se conecta a cada runtime y a cada API de base de datos mediante la fina capa de adaptación; las seis plataformas tienen funciones estrictamente idénticas.

## 2. Estructura de directorios

```
src/worker.js                 # 唯一业务源文件（Cloudflare Worker 形态：export default { fetch, scheduled }）
platforms/
  gen_app.py                 # 同步生成脚本（见 §3）
  shared/app.js               # 生成产物：与 src/worker.js 业务部分逐字节一致，仅替换导出形态
  cloudflare/                 # CF 主版本副本 + wrangler.toml（静态维护）
  vercel/  netlify/  deno/    # 各平台自包含目录：入口 + app.js + db.js + schema.sql + README
  edgeone/ node/              # EdgeOne 走 Turso；node/db.js 为 Turso + 本地 SQLite 双适配（独立维护）
tests/run.mjs                 # suite de pruebas sin dependencias (node:sqlite, 204 pruebas)
docs/                         # 文档（本目录）
schema.sql                    # 数据库建表脚本（单一来源）
```

Cada directorio de plataforma está **completamente autocontenido**: la entrada solo referencia el `app.js` / `db.js` de su propio directorio, se puede desplegar de forma independiente y no dependen unos de otros.

## 3. Mecanismo de sincronización (platforms/gen_app.py)

`python platforms/gen_app.py` lo hace de una vez (idempotente, sin desviación al repetir):

1. Con `src/worker.js` como única fuente, toma todo el código de negocio anterior a `export default {`, añade la cola de exportación genérica (`fetchApp` / `runCron` / `handleCronRequest`) y escribe `platforms/shared/app.js`;
2. Copia la copia shared, junto con `shared/db.js` y el `schema.sql` de la raíz, a cada directorio de plataforma (excepto `node/db.js`, mantenido por separado);
3. Con la **lista blanca ENV_KEYS** incluida en el script (lista única, con 31 variables de entorno) reemplaza el contenido entre los marcadores `/* ==== ENV_KEYS BEGIN ==== */ … /* ==== ENV_KEYS END ==== */` de cada archivo de entrada, garantizando que el conjunto de variables de entorno trasladado sea el mismo en las seis plataformas y evitando desviaciones.

Regla de hierro: **cualquier cambio de negocio se hace solo en `src/worker.js` (y en la ENV_KEYS de gen_app.py); tras cambiarlo hay que reejecutar gen_app.py obligatoriamente**; está prohibido editar a mano los artefactos generados bajo platforms/ (salvo node/db.js y wrangler.toml).

## 4. Ciclo de vida de una petición

Tomando `POST /api/receive` como ejemplo:

1. **Capa de entrada**: la entrada de la plataforma (p. ej. `platforms/edgeone/functions/index.js`) recibe la petición, construye `env = buildEnv(vars)` (traslada las variables de la lista blanca + la rama de credenciales de la base de datos) y llama a `fetchApp(request, env[, ctx])`;
2. **Autenticación**: `/api/receive`, `/api/push`, `/api/login`, `/api/logout`, `/api/cron` y los recursos estáticos son rutas públicas; el resto de APIs de gestión y de página dependen del interruptor de login (`ENABLE_AUTH`) — tras el inicio de sesión se emite una **sesión firmada sin estado** (`nonce.exp.HMAC-SHA256` en tres segmentos, cookie `sms_auth`, TTL de 30 minutos); si falta `SESSION_SECRET` falla de forma segura (fail-closed) (el inicio de sesión devuelve 500, las APIs de gestión devuelven siempre 401, sin alternativa derivada de la contraseña), ante una configuración ausente no se concede acceso en ningún caso;
3. **Almacenamiento**: valida el token (`safeEqual` contra ataques de tiempo) → localiza/crea el dispositivo por device+sim → escribe en messages (el índice único de la base de datos remata la deduplicación; un push repetido devuelve `duplicated:true` y no se reenvía);
4. **Reenvío de notificaciones**: los mensajes no duplicados pasan a segundo plano por `bgRun(ctx, dispatchNotify(env, msg))` — Cloudflare pasa un `ctx.waitUntil` real para seguir enviando tras la respuesta; en las demás plataformas, si falta ctx, se degrada a `await` en línea, para evitar que la función edge corte las tareas en segundo plano antes de tiempo;
5. **Respuesta**: devuelve JSON inmediatamente (`success/device_id/duplicated`), sin esperar a que termine el reenvío (plataforma CF).

## 5. Subsistema de reenvío de notificaciones

`dispatchNotify(env, msg)` es la única capa de ensamblado de todos los canales:

- `extractCodeLite(content)`: detección ligera de códigos de verificación en el servidor (mismo orden en cascada que el `extractCode` del frontend, el código primero antes que la palabra clave; antes de detectar se recortan números de teléfono/fechas/horas/importes/números de pedido);
- `buildNotifyInfo(env, msg)`: la detección del código + la lectura de `NOTIFY_LINK` se calculan una sola vez para todos los canales, produciendo los tres estados `verify/sms/notify` y el título unificado;
- cada renderer de canal consume `info` y renderiza su formato propio (tarjeta Interactive de Feishu / markdown de WeCom y DingTalk / HTML de Telegram / Bark / ntfy / Gotify / correo vía Resend / plantilla de webhook genérico, etc.); los límites de longitud, la firma y el escapado se tratan dentro de cada renderer;
- `Promise.allSettled` despacha en concurrente; el fallo de un solo canal solo deja registro en el log y no afecta a los demás canales ni al flujo principal.

## 6. Frontend (página de administración embebida)

El HTML de la página de administración va embebido como plantilla literal `String.raw` dentro de `src/worker.js` (renderizado en servidor, sin proyecto frontend aparte): la página de login y la de administración comparten la ruta `/`, y el interruptor de login decide qué forma se renderiza; soporta nueve idiomas (zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR, diccionario integrado `data-i18n` + acceso directo `?lang=`, repliegue a `en` para las claves ausentes), modo oscuro, copia automática del código de verificación, refresco automático por sondeo largo (`/api/wait`), filtro por fuentes y gestión de dispositivos.

## 7. Diferencias entre plataformas de un vistazo

| Plataforma | Archivo de entrada | Base de datos | cron |
|---|---|---|---|
| Cloudflare | `export default` (el propio worker.js) | D1 (`env.DB`) | `scheduled` nativo + HTTP `/api/cron` |
| Vercel | `api/[[...route]].js` | Turso | Vercel Cron (Bearer `CRON_SECRET`) |
| Netlify | `functions/api.mjs` + `functions/cron.mjs` | Turso | Scheduled Functions |
| Deno | `main.js` (`Deno.serve`) | Turso | planificador externo |
| EdgeOne | `functions/index.js` (la raíz exige index.js) | Turso (caché de clientes claveada por huella de credenciales) | planificador externo |
| Node | `server.mjs` (node:http) | Turso / SQLite local (adaptación dual) | planificador externo / Docker |

La semántica del disparo HTTP de `/api/cron` es la misma en todas las plataformas: `?token=<RECEIVE_TOKEN>` o `Authorization: Bearer <RECEIVE_TOKEN>`.
