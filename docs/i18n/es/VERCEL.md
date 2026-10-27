# Guía de despliegue en Vercel
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | **Español** | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Sincronizado del original en inglés (es)

Despliega SMSToWeb en Vercel (Edge Function + base de datos Turso). La cuota gratuita basta para uso personal, unos 15 minutos en total.

**Archivos de este directorio**: `api/[[...route]].js` (entrada), `app.js` (aplicación principal), `db.js` (capa de adaptación Turso), `schema.sql` (creación de tablas), `vercel.json` (incluye la configuración de la tarea programada).

---

## Despliegue con un clic (recomendado)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb%2Ftree%2Fmain%2Fplatforms%2Fvercel&env=RECEIVE_TOKEN%2CTURSO_DATABASE_URL%2CTURSO_AUTH_TOKEN&project-name=sms-gateway&envDescription=%E6%8E%A8%E9%80%81%E9%89%B4%E6%9D%83%E5%AF%86%E9%92%A5%E4%B8%8E%20Turso%20%E6%95%B0%E6%8D%AE%E5%BA%93%E8%BF%9E%E6%8E%A5%E4%BF%A1%E6%81%AF&envLink=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb)

Se recomienda **completar primero el paso 2 de abajo (crear la base Turso) para tener los datos de conexión** y pulsar después el botón: Vercel clonará el subdirectorio de esta plataforma como tu repositorio y creará el proyecto; rellena `RECEIVE_TOKEN` (secreto de autenticación del push, una cadena aleatoria larga inventada por ti) y la URL / Token de Turso cuando se pida y se despliega. Tras un despliegue correcto, **ejecuta sin falta una vez el SQL de creación de tablas del paso 3** (Vercel no puede crear las tablas automáticamente); si no, la página se abrirá sin datos.

---

## Preparación

1. Una cuenta de GitHub (Vercel despliega a través del repositorio de GitHub)
2. Una cuenta de Vercel ([registro](https://vercel.com/signup), inicia sesión directamente con GitHub)

## Paso 1: preparar el repositorio de código

1. Abre el repositorio de GitHub del proyecto y pulsa **Fork** arriba a la derecha (o usa tu propio repositorio ya enviado con push)
2. Con el Fork terminado, tendrás una copia del proyecto que puedes modificar libremente

## Paso 2: crear la base de datos Turso

Turso ofrece una base de datos compatible con SQLite (cuota gratuita: 100 bases de datos, 5GB de almacenamiento, 500 millones de lecturas de filas al mes).

1. Abre [turso.tech](https://turso.tech), pulsa **Start for free now** e inicia sesión con GitHub
2. Entra en la consola → **Create Database** (crear base de datos):
   - Name: `sms-gateway`
   - Location: elige una región cercana (p. ej. Singapore / Hong Kong)
   - Type: Free
3. Tras crearla, entra en la página de detalles de la base de datos:
   - Anota la **Database URL** (formato `libsql://sms-gateway-xxxx.turso.io`)
   - Pulsa **Create Token** (o Turso Platform Tokens) para crear el token de acceso y **cópialo y guárdalo de inmediato** (solo se muestra una vez)
4. Inicializa el esquema: página de detalles de la base de datos → **Console** (consola SQL web) → pega todo el contenido del [`schema.sql`](../../../platforms/vercel/schema.sql) de este directorio → ejecuta → indicará correcto (crea las tablas `messages` y `devices`)

> También puedes usar la CLI de Turso: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Paso 3: importar el repositorio en Vercel

1. Inicia sesión en [vercel.com](https://vercel.com) → **Add New → Project**
2. En la lista **Import Git Repository** busca tu repositorio bifurcado y pulsa **Import**
3. En la página de configuración, despliega **Root Directory** (directorio raíz) y elige `platforms/vercel`
   —— Vercel reconocerá automáticamente el `vercel.json` y el directorio `api/` dentro del directorio, sin otra configuración
4. No pulses todavía Deploy; primero haz la configuración de variables de entorno del paso 4 (se añaden en la zona **Environment Variables** de la misma página)

## Paso 4: configurar las variables de entorno

Añade una a una en las **Environment Variables** de la página de configuración de despliegue (luego también puedes cambiarlas en Project → Settings):

| Nombre | Valor | Descripción |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | la URL anotada en el paso 2 |
| `TURSO_AUTH_TOKEN` | (el token del paso 2) | el que solo se muestra una vez |
| `RECEIVE_TOKEN` | cadena aleatoria larga inventada por ti | autenticación del push, no uses valores de ejemplo |
| `ENABLE_AUTH` | `false` | para login, cámbialo a `true` |
| `ADMIN_PASSWORD` | contraseña inventada por ti | solo necesaria con `ENABLE_AUTH="true"` |
| `SESSION_SECRET` | valor aleatorio de alta entropía (≥32 caracteres aleatorios) | solo necesaria con `ENABLE_AUTH="true"`; independiente de la contraseña, con valor independiente configurado por separado en cada plataforma; si falta, login/autenticación fallan de forma segura, y tras rotarla todas las sesiones antiguas quedan inválidas |
| `RETENTION_DAYS` | `30` | días de retención de datos |
| `CRON_SECRET` | **el mismo valor que RECEIVE_TOKEN** | Vercel Cron adjunta automáticamente `Bearer $CRON_SECRET` al llamar a /api/cron |
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

Cuando lo hayas rellenado todo, pulsa **Deploy** y espera alrededor de 1 minuto a que termine el despliegue.

## Paso 5: verificar el despliegue

1. En la página de despliegue completado, pulsa **Continue to Dashboard** y anota el dominio asignado arriba (formato `https://xxx.vercel.app`)
2. Abre ese dominio en el navegador: deberías ver la página de administración (por defecto "SMS Gateway"; con el login activado verás antes la página de login)
3. Verifica la API de push (sustituye `<dominio>` y `<secreto>` por los tuyos):

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Vercel 部署成功\"}"
```

Si devuelve `{"success":true,...}` funciona y el mensaje debería aparecer de inmediato en la página web.

## Paso 6: conectar el móvil y los dispositivos

Configura el SmsForwarder de Android (los SMS van por `/api/receive`) y el push de notificaciones de cada dispositivo (por `/api/push`) según la [Guía de despliegue y conexión multiplataforma](./DEPLOYMENT.md), usando como dominio tu `xxx.vercel.app` (o un dominio personalizado vinculado).

Vincular un dominio personalizado: Project → **Settings → Domains** → Add, y sigue las instrucciones para añadir un registro CNAME en el DNS del dominio — el valor de destino es el que muestre la página Domains (Vercel asigna a cada proyecto una dirección propia `xxxxxx.vercel-dns.com`).

## Avisos y preguntas frecuentes

- **Limpieza programada**: `vercel.json` ya configura la llamada a `/api/cron` cada día a las 17:00 UTC (01:00, hora de Pekín) para limpiar los datos caducados. Vercel Cron envía automáticamente `Authorization: Bearer $CRON_SECRET`, así que `CRON_SECRET` debe coincidir con `RECEIVE_TOKEN`
- **Límites del plan Hobby (gratuito)**: el cron solo admite una vez al día (este proyecto hace justo una al día, cumple; la hora real de disparo puede variar dentro de la hora configurada, es normal); las funciones Edge deben **empezar a responder en 25 segundos** (después pueden seguir haciendo streaming 300 segundos), y el sondeo largo `/api/wait` del panel se suspende justo 25 segundos, en el límite — si se corta antes de tiempo, el bucle de sondeo del frontend reintenta automáticamente, **sin afectar a las funciones**, solo el aviso de mensajes nuevos llega un poco tarde
- **Edge Runtime**: la entrada declara `runtime = "edge"`, arranque en frío rápido y ejecución en nodos edge globales
- **Diagnóstico de fallos de despliegue**: casi siempre es una variable de entorno sin rellenar — faltan `TURSO_*` y da 500 con "config error"; comprueba que el Root Directory es `platforms/vercel`
- **Actualizar el código**: haz push a tu repositorio bifurcado y Vercel redespliega automáticamente
