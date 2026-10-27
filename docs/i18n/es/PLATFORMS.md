# Resumen del despliegue multiplataforma
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | **Español** | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Sincronizado del original en inglés (es)

Las seis plataformas de SMSToWeb (versión principal de Cloudflare + cinco plataformas portadas) están en este directorio. **Cada subdirectorio de plataforma es completamente autocontenido**:
código (entrada + aplicación principal + capa de adaptación de base de datos) + `schema.sql` + el tutorial detallado de despliegue de esa plataforma (README.md).

| Plataforma | Runtime | Limpieza programada | Tutorial detallado |
|---|---|---|---|
| **Cloudflare** (versión principal) | Worker + D1 | cron de la plataforma | [CLOUDFLARE.md](./CLOUDFLARE.md) |
| Vercel | Edge Function | cron de la plataforma | [VERCEL.md](./VERCEL.md) |
| Deno Deploy | Deno nativo | `Deno.cron` (integrado) | [DENO.md](./DENO.md) |
| Netlify | Functions v2 (Node) | Scheduled Function | [NETLIFY.md](./NETLIFY.md) |
| EdgeOne Makers (Tencent) | Functions | cron externo llamando a /api/cron | [EDGEONE.md](./EDGEONE.md) |
| Fly.io / Railway / VPS | Docker (Node 22) + Turso/SQLite local | integrado en el proceso | [NODE.md](./NODE.md) |

Las seis plataformas (incluida Cloudflare) tienen rutas de API, lógica de autenticación, modelo de mensajes, página de administración, reenvío de notificaciones multicanal y limpieza diaria (UTC 17:00) completamente idénticos;
la estructura de las tablas de datos es la misma y se puede migrar entre ellas en cualquier momento.

> **Despliegue con un clic**: los tutoriales de Cloudflare / Vercel / Netlify tienen en su parte superior un botón oficial de despliegue con un clic (el botón de Cloudflare automatiza incluso la creación de la base de datos y las tablas);
> Deno Deploy, EdgeOne y el autohospedado con Docker aún no tienen botón oficial; sigue el tutorial de cada plataforma.

## Cómo elegir plataforma

- **Coste cero + sin complicaciones** → versión principal de Cloudflare (la cuota gratuita de D1 es generosa y el Worker no tiene problemas de duración)
- **Probar varias plataformas** → Deno Deploy (la semántica más cercana al Worker, el sondeo largo apenas se trunca)
- **Acceso principalmente desde China** → EdgeOne Makers (ojo: el dominio personalizado requiere registro ICP)
- **Ya tienes servidor / quieres control total** → node/ (autohospedado con Docker)

> **Sondeo largo y timeouts de plataforma**: la página de administración espera mensajes nuevos suspendiéndose en `GET /api/wait`, 25 segundos como máximo por defecto, ajustable por plataforma con la variable de entorno `WAIT_MAX_SECONDS` (3–25).
> Netlify Functions tiene hoy un tope de 60 segundos (la entrada usa por defecto `WAIT_MAX_SECONDS=8` como adaptación conservadora, subible si hace falta); para Vercel Edge se recomienda `20`; Cloudflare / Deno / Node pueden mantener el valor por defecto.
> El frontend aplica **retroceso exponencial** ante fallos (2→30s) y vuelve a consultar de inmediato cuando la página vuelve a ser visible; aunque la plataforma corte antes, **no afecta a las funciones**, solo retrasa un poco el aviso de mensajes nuevos.

## Preparación común (compartida por todas las plataformas no Cloudflare)

**La base de datos es siempre [Turso](https://turso.tech)** (compatible con SQLite; cuota gratuita: 100 bases de datos, 5GB de almacenamiento, 500 millones de lecturas de filas al mes):

1. Abre [turso.tech](https://turso.tech) e inicia sesión con GitHub
2. **Create Database**: nombre `sms-gateway`, región Singapore / Hong Kong, tipo Free
3. En la página de detalles de la base de datos, anota la **Database URL** (`libsql://sms-gateway-xxxx.turso.io`); pulsa **Create Token** para crear el token y guárdalo de inmediato (solo se muestra una vez)
4. Inicializa el esquema: en la **Console** de la página de detalles, pega todo el contenido del `schema.sql` del directorio de la plataforma y ejecútalo (idéntico al `schema.sql` de la raíz del repositorio)

Comandos CLI equivalentes:

```bash
turso auth login
turso db create sms-gateway          # 创建数据库
turso db show sms-gateway --url      # 查看 URL
turso db tokens create sms-gateway   # 创建令牌
turso db shell sms-gateway < schema.sql   # 建表
```

**Variables de entorno** (se configuran en el panel de cada plataforma; explicación completa en el tutorial de cada una):

| Variable | Obligatoria | Descripción |
|---|---|---|
| `TURSO_DATABASE_URL` | Sí | `libsql://sms-gateway-<organización>.turso.io` |
| `TURSO_AUTH_TOKEN` | Sí | token de acceso a la base de datos |
| `RECEIVE_TOKEN` | Sí | secreto de autenticación del push (debe coincidir con el `token=` de la URL del cliente de conexión) |
| `ENABLE_AUTH` | No | `"true"` exige login en la página de administración (**muy recomendable por seguridad**, ver los consejos de seguridad de abajo); por defecto sin login |
| `ADMIN_PASSWORD` | No | contraseña de login (configurar cuando `ENABLE_AUTH="true"`; si falta, las APIs de administración rechazan siempre el acceso y registran una alerta — la configuración ausente no abre la puerta) |
| `SESSION_SECRET` | obligatoria con el login activo | secreto de firma de la sesión de login: valor aleatorio de alta entropía (≥32 caracteres aleatorios, independiente de la contraseña), cada plataforma debe configurar su propio valor independiente; si falta, login y autenticación fallan de forma segura (login 500, APIs de administración 401), sin alternativa derivada de la contraseña; tras rotarlo, todas las sesiones antiguas quedan inválidas y hay que volver a iniciar sesión |
| `RETENTION_DAYS` | No | días de retención de datos, por defecto 30 |
| `WAIT_MAX_SECONDS` | No | segundos de suspensión del sondeo largo (3–25, por defecto 25); en Netlify poner `8`, en Vercel Edge `20` |
| Variables de canales de notificación | No | `FEISHU_WEBHOOK` (Feishu) / `WECOM_WEBHOOK` (WeCom) / `DINGTALK_WEBHOOK` (DingTalk, con firma opcional `DINGTALK_SECRET`) / `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY` (con `BARK_URL` opcional) / `NTFY_URL` (con `NTFY_TOKEN` opcional) / `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO` (correo, con `MAIL_FROM` opcional) / `GENERIC_WEBHOOKS` (webhook genérico, con `GENERIC_WEBHOOK_TEMPLATE` de cuerpo / `GENERIC_WEBHOOK_HEADERS` de cabeceras opcionales). Se reenvía solo lo que se configura; sin nada configurado no se reenvía nada; las notificaciones se renderizan automáticamente en tres estados según el contenido (🔐 código / 💬 SMS / 🔔 notificación) |
| `SITE_NAME` / `SITE_ICON` | No | nombre del sitio / URL del icono; valores por defecto si no se establecen |
| `NOTIFY_LINK` | No | URL de inicio de la página de administración; al configurarla, todos los canales de notificación añaden la entrada "Abrir administración" (botón/enlace/click), se omite automáticamente si no está configurada |
| `CRON_SECRET` (solo Vercel) | No | mismo valor que `RECEIVE_TOKEN`, para que Vercel Cron llame a /api/cron |
| `SQLITE_PATH` (solo node autohospedado) | No | modo SQLite local: al definirlo no hace falta base de datos externa (requiere Node 22.13+, ver node/README.md) |

> **Consejos de seguridad (muy recomendables)**
> 1. **Activa el login de la página de administración** (`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`): la página de administración contiene contenido sensible como códigos OTP de SMS; sin login, cualquiera que conozca el dominio puede ver todos los mensajes y borrar datos. El endpoint de login ya incorpora limitación de tasa (5 fallos consecutivos por misma IP bloquean 10 minutos); `/api/receive` y `/api/push` tienen además un límite de 120 escrituras por IP y minuto (429 al superarlo).
> 2. **Contrapartida del token en la query de la URL**: por compatibilidad con SmsForwarder y clientes similares, `/api/receive` y `/api/push` aceptan autenticación por el parámetro de query `?token=` — el token aparece en la URL y puede acabar en los logs de acceso de la plataforma y en el historial del navegador. Si te preocupa, usa POST + la cabecera `Authorization: Bearer <RECEIVE_TOKEN>` (ambas formas están soportadas).

## Estructura de directorios

```
platforms/
├── cloudflare/ # 主版本：worker.js + schema.sql + wrangler.toml + README.md（自包含）
├── vercel/     # api/[[...route]].js + app.js + db.js + schema.sql + vercel.json + README.md
├── netlify/    # functions/{api,cron}.mjs + app.js + db.js + schema.sql + netlify.toml + README.md
├── deno/       # main.js + app.js + db.js + schema.sql + README.md
├── edgeone/    # functions/{[[default]].js,index.js} + app.js + db.js + schema.sql + README.md
├── node/       # server.mjs + app.js + db.js + schema.sql + Dockerfile + package.json + README.md
├── shared/     # app.js / db.js 唯一源（gen_app.py 由此同步到各平台目录）
└── gen_app.py  # 生成器：从 ../src/worker.js 生成 app.js 并同步全部平台（含 cloudflare 独立副本）
```

Cada directorio de plataforma puede usarse por sí solo como raíz de despliegue (al desplegar con Git basta apuntar el Root Directory de la plataforma al subdirectorio correspondiente),
cero dependencias npm, sin build. Tras actualizar `src/worker.js`, ejecuta `python platforms/gen_app.py` para sincronizar todas las plataformas de una vez (CI verifica cero desviación; `node tests/run.mjs` cubre 204 aserciones funcionales).

## Migrar del Worker de Cloudflare a otras plataformas

1. Prepara la base Turso y crea las tablas como se indica arriba
2. (Opcional) migra los datos históricos: exporta los datos de D1 desde el panel de CF (archivo SQLite) → impórtalos con `turso db import` (ver la documentación oficial de la CLI)
3. Despliega según el README de la plataforma destino y verifica que la página de administración y /api/push funcionan
4. Cambia el dominio del webhook en el móvil y en los scripts de push a la nueva plataforma
5. Tras uno o dos días sin incidencias, desactiva el Worker antiguo

## Notas comunes

- Las rutas de API son idénticas en todas las plataformas: `/api/receive`, `/api/push`, `/api/messages` (admite `device_id`/`source`/`range`/`q`/`limit`/`page`/`starred`/`unread`), `/api/messages/star`, `/api/messages/read`, `/api/messages/remove`, `/api/messages/restore`, `/api/messages/clear`, `/api/export` (CSV/JSON), `/api/sources`, `/api/stats`, `/api/phone` (procedencia del número), `/api/devices`, `/api/devices/alias`, `/api/devices/merge`, `/api/wait`, `/api/login`, `/api/logout`, `/api/cron`; además las públicas `/manifest.webmanifest` y `/sw.js`
- `/api/cron` permite a cualquier planificador externo disparar la limpieza; autenticación: `?token=<RECEIVE_TOKEN>` o `Authorization: Bearer <RECEIVE_TOKEN>`
- `/api/receive` y `/api/push` no dependen del interruptor de login
