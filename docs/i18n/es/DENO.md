# Guía de despliegue en Deno Deploy
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | **Español** | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Sincronizado del original en inglés (es)

Despliega SMSToWeb en Deno Deploy (runtime nativo de Deno + base de datos Turso). Es el más cercano en semántica al Cloudflare Worker; el plan gratuito da 1 millón de peticiones al mes, unos 15 minutos en total.

> Nota de la plataforma: Deno Deploy se ha actualizado a la nueva generación, con consola en [console.deno.com](https://console.deno.com) (el antiguo dash.deno.com ya está cerrado), con un modo de build tipo CI basado en Git.

**Archivos de este directorio**: `main.js` (entrada, con `Deno.serve` y la limpieza programada integrada `Deno.cron`), `app.js` (aplicación principal), `db.js` (capa de adaptación Turso), `schema.sql` (creación de tablas).

---

## Preparación

1. Una cuenta de GitHub
2. Una cuenta de Deno Deploy ([registro](https://console.deno.com), inicia sesión directamente con GitHub)

## Paso 1: preparar el repositorio de código

1. Abre el repositorio de GitHub del proyecto y pulsa **Fork** arriba a la derecha (o usa tu propio repositorio ya enviado con push)

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
4. Inicializa el esquema: página de detalles de la base de datos → **Console** → pega todo el contenido del [`schema.sql`](../../../platforms/deno/schema.sql) de este directorio → ejecuta → indicará correcto

> También puedes usar la CLI de Turso: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Paso 3: crear la app en Deno Deploy y asociar el repositorio

1. Inicia sesión en [console.deno.com](https://console.deno.com) → pulsa **+ New App** (nueva aplicación)
2. Elige **desplegar desde un repositorio de GitHub**, autoriza y selecciona tu repositorio bifurcado
3. Configura el build (Build Configuration):
   - **Directorio de ejecución** (Runtime working directory): `platforms/deno`
   - **Entrypoint** (archivo de entrada): `main.js`
4. Añade antes las variables de entorno (ver paso 4) y dispara después el primer despliegue
5. Con el despliegue terminado, cada push al repositorio de GitHub reconstruye automáticamente

## Paso 4: configurar las variables de entorno

Añádelas una a una en **Settings → Environment Variables** de la aplicación (también puedes hacerlo en la página de configuración al crear la app):

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

Tras guardar, espera a que el redespliegue automático surta efecto.

## Paso 5: verificar el despliegue

1. Anota el dominio asignado (formato `https://<nombre-app>.<organización>.deno.net`)
2. Abre ese dominio en el navegador: deberías ver la página de administración (por defecto "SMS Gateway"; con el login activado verás antes la página de login)
3. Verifica la API de push:

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Deno Deploy 部署成功\"}"
```

Si devuelve `{"success":true,...}` funciona y el mensaje debería aparecer de inmediato en la página web.

## Paso 6: conectar el móvil y los dispositivos

Configura el SmsForwarder de Android y el push de notificaciones de cada dispositivo según la [Guía de despliegue y conexión multiplataforma](./DEPLOYMENT.md), usando como dominio tu `xxx.deno.net`.

Dominio personalizado: en la pestaña **Domains** de la organización añade el dominio y asígnalo a tu aplicación, y sigue las instrucciones para añadir en el DNS del dominio el CNAME (o registro A) y el registro de verificación; el certificado HTTPS se emite automáticamente.

## Avisos y preguntas frecuentes

- **Limpieza programada**: `Deno.cron` se registra automáticamente al desplegar (cada día a las 17:00 UTC = 01:00, hora de Pekín), sin ninguna configuración extra y tampoco se puede disparar manualmente para probar — para verificarlo, comprueba que los datos de Turso disminuyen según lo previsto
- **Cuota gratuita**: 1 millón de peticiones al mes, 10 horas de Active CPU, 20GiB de tráfico de salida, de sobra para uso personal
- **Sondeo largo**: Deno Deploy no tiene un límite estricto de duración por petición y el sondeo largo de 25 segundos de `/api/wait` funciona bien; las instancias inactivas pueden ser recicladas y reiniciadas por la plataforma (los sondeos largos interrumpidos los reintenta el frontend automáticamente); la temporalidad real es prácticamente la misma que la versión Worker
- **Diagnóstico de fallos de despliegue**: el Entrypoint debe ser `main.js` y el directorio de ejecución debe ser `platforms/deno`; faltan las variables `TURSO_*` y da 500 con "config error"
- **Actualizar el código**: push al repositorio de GitHub y redespliegue automático
