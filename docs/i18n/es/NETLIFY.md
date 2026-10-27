# Guía de despliegue en Netlify
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | **Español** | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Sincronizado del original en inglés (es)

Despliega SMSToWeb en Netlify (Functions v2 + base de datos Turso). Unos 15 minutos en total.

**Archivos de este directorio**: `functions/api.mjs` (entrada, con `path: "/*"` captura todas las rutas), `functions/cron.mjs` (Scheduled Function de limpieza programada), `app.js` (aplicación principal), `db.js` (capa de adaptación Turso), `schema.sql` (creación de tablas), `netlify.toml` (configuración del sitio).

---

## Despliegue con un clic (recomendado)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/ShenDoyle/SMSToWeb)

Al pulsar el botón, el repositorio se clona a tu GitHub y se entra en el asistente de creación; dos avisos:

1. **En la configuración de build, rellena el Base directory con `platforms/netlify`** (el `netlify.toml` de esta plataforma está en ese subdirectorio; rellénalo bien y los comandos de build se toman a cargo automáticamente); el resto, por defecto
2. Se recomienda completar primero el paso 2 de abajo (crear la base Turso) para tener los datos de conexión; tras crear el sitio, rellena `RECEIVE_TOKEN` / `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` en **Site configuration → Environment variables** y redespliega; por último ejecuta el SQL de creación de tablas del paso 3 (Netlify no puede crear las tablas automáticamente)

---

## Preparación

1. Una cuenta de GitHub
2. Una cuenta de Netlify ([registro](https://app.netlify.com/signup), inicia sesión directamente con GitHub)

## Paso 1: preparar el repositorio de código

Abre el repositorio de GitHub del proyecto y pulsa **Fork** arriba a la derecha (o usa tu propio repositorio ya enviado con push).

## Paso 2: crear la base de datos Turso

Turso ofrece una base de datos compatible con SQLite (cuota gratuita: 100 bases de datos, 5GB de almacenamiento, 500 millones de lecturas de filas al mes).

1. Abre [turso.tech](https://turso.tech), pulsa **Start for free now** e inicia sesión con GitHub
2. Entra en la consola → **Create Database**:
   - Name: `sms-gateway`
   - Location: elige una región cercana (p. ej. Singapore / Hong Kong)
   - Type: Free
3. Tras crearla, entra en la página de detalles de la base de datos:
   - Anota la **Database URL** (formato `libsql://sms-gateway-xxxx.turso.io`)
   - Pulsa **Create Token** para crear el token de acceso y **cópialo y guárdalo de inmediato** (solo se muestra una vez)
4. Inicializa el esquema: página de detalles de la base de datos → **Console** → pega todo el contenido del [`schema.sql`](../../../platforms/netlify/schema.sql) de este directorio → ejecuta → indicará correcto

> También puedes usar la CLI de Turso: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Paso 3: importar el repositorio en Netlify

1. Inicia sesión en [app.netlify.com](https://app.netlify.com) → **Add new project → Import an existing project**
2. Elige **Deploy with GitHub**, autoriza y elige en la lista tu repositorio bifurcado
3. Página de configuración de despliegue (Site settings for…):
   - **Base directory** (directorio raíz): pon `platforms/netlify`
   - Build command / Publish directory: déjalos por defecto (el `netlify.toml` ya está en el directorio y surte efecto automáticamente)
4. Despliega abajo **Show advanced → New variable** y añade antes las variables de entorno (ver paso 4) y luego pulsa **Deploy**

## Paso 4: configurar las variables de entorno

Añádelas en las opciones avanzadas de la página de configuración de despliegue (luego también puedes cambiarlas en **Project configuration → Environment variables**):

| Nombre | Valor | Descripción |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | la URL anotada en el paso 2 |
| `TURSO_AUTH_TOKEN` | (el token del paso 2) | el que solo se muestra una vez |
| `RECEIVE_TOKEN` | cadena aleatoria larga inventada por ti | autenticación del push, no uses valores de ejemplo |
| `ENABLE_AUTH` | `false` | para login, cámbialo a `true` |
| `ADMIN_PASSWORD` | contraseña inventada por ti | solo necesaria con `ENABLE_AUTH="true"` |
| `SESSION_SECRET` | valor aleatorio de alta entropía (≥32 caracteres aleatorios) | solo necesaria con `ENABLE_AUTH="true"`; independiente de la contraseña, con valor independiente configurado por separado en cada plataforma; si falta, login/autenticación fallan de forma segura, y tras rotarla todas las sesiones antiguas quedan inválidas |
| `RETENTION_DAYS` | `30` | días de retención de datos |
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

Pulsa **Deploy** y espera alrededor de 1 minuto a que termine el despliegue.

## Paso 5: verificar el despliegue

1. Con el despliegue terminado, anota el dominio del sitio (formato `https://xxx.netlify.app`)
2. Abre ese dominio en el navegador: deberías ver la página de administración (por defecto "SMS Gateway"; con el login activado verás antes la página de login)
3. Verifica la API de push:

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Netlify 部署成功\"}"
```

Si devuelve `{"success":true,...}` funciona y el mensaje debería aparecer de inmediato en la página web.

## Paso 6: conectar el móvil y los dispositivos

Configura el SmsForwarder de Android y el push de notificaciones de cada dispositivo según la [Guía de despliegue y conexión multiplataforma](./DEPLOYMENT.md), usando como dominio tu `xxx.netlify.app`.

Dominio personalizado: **Project configuration → Change site name** (cambiar el subdominio) o **Domain management → Add a domain** (dominio propio, añade el DNS según las instrucciones).

## Avisos y preguntas frecuentes

- **Limpieza programada**: `functions/cron.mjs` es una Netlify Scheduled Function que se registra automáticamente tras el despliegue (cada día a las 17:00 UTC = 01:00, hora de Pekín), sin configuración extra. Verificación: en la página **Functions** del sitio se ve la función `cron` y su estado de programación
- **Duración de las funciones y temporalidad real**: el límite de ejecución por defecto de las funciones es hoy de 60 segundos (igual en todos los planes); el sondeo largo `/api/wait` del panel (25 segundos en espera) puede esperar completo, con buena temporalidad real; si la necesitas altísima, sigue siendo mejor elegir Cloudflare / autohospedado
- **Cuota gratuita**: desde 2025-09 las cuentas nuevas usan créditos (plan Free con 300 créditos al mes, el consumo de funciones se contabiliza en GB-hora), suficiente para un uso personal pequeño; las cuentas antiguas pueden quedarse en su plan original
- **Diagnóstico de fallos de despliegue**: el Base directory debe ser `platforms/netlify`; faltan las variables `TURSO_*` y da 500 con "config error"; los detalles del error se ven en **Functions → api → Logs** del sitio
- **Actualizar el código**: push al repositorio de GitHub y redespliegue automático
