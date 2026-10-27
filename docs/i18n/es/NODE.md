# Guía de despliegue autohospedado (Fly.io / Railway / VPS / local)
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | **Español** | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Sincronizado del original en inglés (es)

Autohospeda SMSToWeb como contenedor Docker. Proceso residente, sin límites de duración de función y la mejor temporalidad real del sondeo largo; ideal para quien ya tenga un servidor o quiera desplegar en Fly.io / Railway (la situación de las cuotas gratuitas más abajo, en «Notas de la plataforma»).

**Archivos de este directorio**: `server.mjs` (entrada sin dependencias para Node 18+, con limpieza diaria integrada), `app.js` (aplicación principal), `db.js` (capa de adaptación dual Turso / SQLite local), `schema.sql` (creación de tablas), `Dockerfile`, `package.json`.

---

## Preparación

- Cuenta de Fly.io o Railway (o cualquier VPS con Docker)
- La base de datos sigue siendo Turso (compatible con SQLite); el paso 1 de abajo la prepara de forma unificada

## Paso 1: crear la base de datos Turso

1. Abre [turso.tech](https://turso.tech), pulsa **Start for free now** e inicia sesión con GitHub
2. Entra en la consola → **Create Database**:
   - Name: `sms-gateway`
   - Location: elige una región cercana al servidor
   - Type: Free
3. Tras crearla, entra en la página de detalles de la base de datos:
   - Anota la **Database URL** (formato `libsql://sms-gateway-xxxx.turso.io`)
   - Pulsa **Create Token** para crear el token de acceso y **cópialo y guárdalo de inmediato** (solo se muestra una vez)
4. Inicializa el esquema: página de detalles de la base de datos → **Console** → pega todo el contenido del [`schema.sql`](../../../platforms/node/schema.sql) de este directorio → ejecuta → indicará correcto

> Con la CLI: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Modalidad A: Fly.io

1. Instala flyctl en local ([guía oficial de instalación](https://fly.io/docs/flyctl/install/)) y luego `fly auth login`
2. En este directorio ejecuta:

```bash
cd platforms/node
fly launch                 # 按提示创建应用：区域自选；询问数据库时选 No（我们用 Turso）
fly secrets set TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io TURSO_AUTH_TOKEN=<你的令牌> RECEIVE_TOKEN=<你的密钥>
fly secrets set ENABLE_AUTH=true ADMIN_PASSWORD=<你的密码>     # 可选
fly deploy
fly status                 # 记下分配的域名 https://<app>.fly.dev
```

3. Verificación: abre `https://<app>.fly.dev` en el navegador, deberías ver la página de administración; prueba de push:

```
curl "https://<app>.fly.dev/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Fly 部署成功\"}"
```

4. Dominio personalizado: `fly certs add sms.tudominio.com` y añade el DNS según las instrucciones (registro A o CNAME)

## Modalidad B: Railway

1. Inicia sesión en [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**, elige tu repositorio bifurcado
2. En los ajustes del servicio, **Settings → Root Directory**: `platforms/node` (Railway detecta el Dockerfile y compila automáticamente)
3. Añade las variables de entorno en el panel **Variables** (ver la tabla común de abajo; el `PORT` lo inyecta la plataforma automáticamente, el código ya está adaptado)
4. **Settings → Public Networking → Generate Domain** para generar el dominio público
5. Verificación igual que arriba (cambiando a tu dominio de Railway)

## Modalidad C: cualquier VPS (Docker)

```bash
# 上传本目录到服务器后
cd platforms/node
docker build -t smstoweb .
docker run -d --name smstoweb --restart unless-stopped -p 8787:8787 \
  -e TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io \
  -e TURSO_AUTH_TOKEN=<你的令牌> \
  -e RECEIVE_TOKEN=<你的密钥> \
  smstoweb
# 验证
curl "http://127.0.0.1:8787/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"content\":\"VPS 部署成功\"}"
```

Se recomienda un proxy inverso con Caddy/Nginx para añadir HTTPS. Sin Docker también puedes lanzar directamente `node server.mjs` (necesita Node 18+, cero dependencias npm; el modo SQLite local necesita Node 22.13+).

## Variables de entorno (comunes a las tres modalidades)

| Nombre | Valor | Descripción |
|---|---|---|
| `SQLITE_PATH` (opcional) | p. ej. `/data/data.db` | **Modo SQLite local**: al definirlo no hace falta base de datos externa, los datos se guardan en un archivo local (requiere Node 22.13+, crea las tablas automáticamente en el primer arranque; alternativa a Turso, tiene prioridad si se define) |
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | modo Turso: la URL anotada en el paso 1 |
| `TURSO_AUTH_TOKEN` | (el token del paso 1) | modo Turso: el que solo se muestra una vez |
| `RECEIVE_TOKEN` | cadena aleatoria larga inventada por ti | autenticación del push, no uses valores de ejemplo |
| `ENABLE_AUTH` | `false` | para login, cámbialo a `true` (**muy recomendable por seguridad**: la página de administración contiene contenido sensible como códigos OTP de SMS; sin login, basta conocer el dominio para ver todos los mensajes) |
| `ADMIN_PASSWORD` | contraseña inventada por ti | solo necesaria con `ENABLE_AUTH="true"` |
| `SESSION_SECRET` | valor aleatorio de alta entropía (≥32 caracteres aleatorios) | solo necesaria con `ENABLE_AUTH="true"`; independiente de la contraseña; si falta, login/autenticación fallan de forma segura, y tras rotarla todas las sesiones antiguas quedan inválidas |
| `RETENTION_DAYS` | `30` | días de retención de datos |
| `PORT` | por defecto `8787` | normalmente no hace falta configurarlo (Railway lo inyecta automáticamente) |
| `FEISHU_WEBHOOK` (opcional `FEISHU_SECRET`) | (opcional) webhook del bot de grupo de Feishu | al configurarlo, los mensajes nuevos se reenvían automáticamente al grupo de Feishu; si la seguridad del bot usa «verificación de firma», configura además `FEISHU_SECRET` |
| `WECOM_WEBHOOK` | (opcional) webhook del bot de grupo de WeCom | al configurarlo, los mensajes nuevos se reenvían automáticamente al grupo de WeCom |
| `DINGTALK_WEBHOOK` | (opcional) webhook del bot de grupo de DingTalk | la seguridad por firma requiere además `DINGTALK_SECRET` |
| `SERVERCHAN_SENDKEY` | (opcional) SendKey de ServerChan | push a WeChat |
| `PUSHPLUS_TOKEN` | (opcional) token de PushPlus | push a WeChat |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | (opcional) bot de Telegram | funciona solo con ambos configurados |
| `BARK_DEVICE_KEY` | (opcional) Key del dispositivo Bark | con servidor propio configura además `BARK_URL`; por defecto el oficial |
| `NTFY_URL` (opcional `NTFY_TOKEN`) | (opcional) URL del topic de ntfy | URL completa, p. ej. `https://ntfy.sh/my-sms`; los topics protegidos requieren además `NTFY_TOKEN` (Token o user:password) |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | (opcional) Gotify | dirección del servidor + token de aplicación |
| `RESEND_API_KEY` + `MAIL_TO` | (opcional) correo (Resend) | `MAIL_FROM` opcional, por defecto `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS` (opcional `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`) | (opcional) webhook genérico | varias URLs separadas por comas; plantilla opcional para el cuerpo personalizado, `GENERIC_WEBHOOK_HEADERS` (cadena JSON) para las cabeceras |
| `SITE_NAME` / `SITE_ICON` | (opcional) | nombre del sitio / URL del icono |
| `NOTIFY_LINK` | (opcional) | URL de inicio de la página de administración; al configurarla, todos los canales de notificación añaden la entrada "Abrir administración", se omite automáticamente si no está configurada |

## Conectar el móvil y los dispositivos

Configura el SmsForwarder de Android y el push de notificaciones de cada dispositivo según la [Guía de despliegue y conexión multiplataforma](./DEPLOYMENT.md), usando como dominio la dirección de tu servicio.

## Avisos y preguntas frecuentes

- **Limpieza programada**: el proceso incorpora por sí mismo la limpieza cada día a las 17:00 UTC (01:00, hora de Pekín), sin configuración. También puedes usar el planificador de la plataforma (Fly Machines Cron / Railway Cron) para llamar a `GET /api/cron?token=<RECEIVE_TOKEN>`; elige una de las dos
- **Ventajas del proceso residente**: sin límite de duración de función; el sondeo largo `/api/wait` ofrece la misma experiencia que el Cloudflare Worker, con la mejor temporalidad real
- **Cuotas gratuitas**: Fly.io ya no tiene cuota gratuita (solo una prueba de 7 días / 2 horas de VM para cuentas nuevas, pasa a facturación por uso al vincular tarjeta, con un coste muy bajo en microconsumos); Railway ofrece un crédito de prueba único de $5 (30 días de validez) y el plan Hobby de $5/mes incluye el mismo importe de uso — para coste cero a largo plazo, la primera opción es la versión principal de Cloudflare
- **Copia de seguridad de los datos**: en modo Turso los datos están en Turso; al cambiar de servidor basta reconfigurar las variables de entorno, sin pérdida de datos; en modo SQLite local, basta con respaldar periódicamente el archivo de `SQLITE_PATH`
- **Protección del login**: el endpoint de login incorpora limitación de tasa — 5 fallos consecutivos por misma IP bloquean 10 minutos (estado en memoria, se pone a cero al reiniciar el proceso)
- **Login por http**: con IP de LAN / http sin TLS se puede iniciar sesión directamente (la cookie degrada automáticamente, no fuerza Secure), y el salto tras el login funciona bien en navegadores como Alook
- **Diagnóstico por logs**: `fly logs` / Railway Deployments → Logs / `docker logs smstoweb`
