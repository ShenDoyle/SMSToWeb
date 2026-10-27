# Guía de despliegue en Tencent EdgeOne Makers
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | **Español** | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Sincronizado del original en inglés (es)

Despliega SMSToWeb en Tencent EdgeOne Makers (antes EdgeOne Pages, Functions + base de datos Turso). Buena experiencia de acceso desde China, unos 15 minutos en total.

**Archivos de este directorio**: `functions/index.js` (entrada dedicada a la ruta raíz `/`, única fuente de toda la lógica y de la lista blanca ENV_KEYS), `functions/[[default]].js` (captura por defecto del resto de rutas, solo re-exporta index.js, no necesita mantenimiento aparte), `app.js` (aplicación principal), `db.js` (capa de adaptación Turso), `schema.sql` (creación de tablas).

---

## Preparación

1. Una cuenta de Tencent Cloud ([registro](https://cloud.tencent.com), requiere verificación de identidad)
2. Una cuenta de GitHub (EdgeOne Makers permite desplegar desde un repositorio Git)

## Paso 1: preparar el repositorio de código

Abre el repositorio de GitHub del proyecto y pulsa **Fork** arriba a la derecha (o usa tu propio repositorio ya enviado con push).

## Paso 2: crear la base de datos Turso

Turso ofrece una base de datos compatible con SQLite (cuota gratuita: 100 bases de datos, 5GB de almacenamiento, 500 millones de lecturas de filas al mes). Desde EdgeOne Functions el acceso a bases de datos externas va fluido.

1. Abre [turso.tech](https://turso.tech), pulsa **Start for free now** e inicia sesión con GitHub
2. Entra en la consola → **Create Database**:
   - Name: `sms-gateway`
   - Location: se recomienda Singapore / Hong Kong (baja latencia desde China)
   - Type: Free
3. Tras crearla, entra en la página de detalles de la base de datos:
   - Anota la **Database URL** (formato `libsql://sms-gateway-xxxx.turso.io`)
   - Pulsa **Create Token** para crear el token de acceso y **cópialo y guárdalo de inmediato** (solo se muestra una vez)
4. Inicializa el esquema: página de detalles de la base de datos → **Console** → pega todo el contenido del [`schema.sql`](../../../platforms/edgeone/schema.sql) de este directorio → ejecuta → indicará correcto

> También puedes usar la CLI de Turso: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Paso 3: crear el proyecto en EdgeOne Makers

1. Inicia sesión en la consola de Tencent Cloud → busca **EdgeOne Makers** (antes «EdgeOne Pages», o accede a [console.cloud.tencent.com/edgeone/pages](https://console.cloud.tencent.com/edgeone/pages))
2. Pulsa **Crear proyecto** → elige **Importar desde un repositorio Git** → autoriza GitHub y elige tu repositorio bifurcado
3. Configuración del build:
   - **Directorio raíz**: `platforms/edgeone`
   - Presupuesto de framework: elige «Sin framework / Other» o déjalo vacío (Functions puras no necesitan build)
4. En la zona de configuración de variables de entorno, añade antes las variables (ver paso 4) y pulsa después iniciar despliegue
5. Espera a que termine el despliegue (alrededor de 1 minuto) y anota el dominio por defecto asignado (p. ej. `*.edgeone.app`)

## Paso 4: configurar las variables de entorno

Añádelas una a una en **Configuración → Variables de entorno** del proyecto (Functions las lee mediante el parámetro `env` de `onRequest`):

| Nombre | Valor | Descripción |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | la URL anotada en el paso 2 |
| `TURSO_AUTH_TOKEN` | (el token del paso 2) | el que solo se muestra una vez |
| `RECEIVE_TOKEN` | cadena aleatoria larga inventada por ti | autenticación del push, no usa valores de ejemplo |
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

Tras guardar, redespliega para que surta efecto.

## Paso 5: verificar el despliegue

1. Abre el dominio asignado en el navegador: deberías ver la página de administración (por defecto "SMS Gateway"; con el login activado verás antes la página de login)
2. Verifica la API de push:

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"EdgeOne 部署成功\"}"
```

Si devuelve `{"success":true,...}` funciona y el mensaje debería aparecer de inmediato en la página web.

## Paso 6: vincular dominio personalizado (recomendado para acceso desde China)

1. **Configuración → Dominio personalizado** del proyecto → añade tu dominio (p. ej. `sms.tudominio.com`)
2. Sigue las instrucciones para añadir en el DNS del dominio un registro CNAME apuntando a la dirección asignada por EdgeOne
3. El dominio debe tener completado el registro ICP (requisito de los nodos nacionales de Tencent Cloud); los dominios sin ICP no se resuelven

## Paso 7: configurar la limpieza programada (cron externo)

EdgeOne Makers aún no tiene tareas programadas nativas; usa cualquier servicio externo de cron gratuito para llamar una vez al día a la API de limpieza:

1. Abre [cron-job.org](https://cron-job.org), regístrate y **Create cronjob**:
   - URL: `https://<tu-dominio>/api/cron?token=<tu RECEIVE_TOKEN>`
   - Schedule: cada día (p. ej. 01:00 hora de Pekín, es decir 17:00 UTC)
2. Guarda y activa. A la hora programada, la pasarela borra automáticamente los datos con más de `RETENTION_DAYS` días

## Conectar el móvil y los dispositivos

Configura el SmsForwarder de Android y el push de notificaciones de cada dispositivo según la [Guía de despliegue y conexión multiplataforma](./DEPLOYMENT.md), usando como dominio tu dominio de EdgeOne.

## Avisos y preguntas frecuentes

- **404 en la ruta raíz (importante, verificado en 2026-10)**: en las reglas de enrutado de Functions de EdgeOne Makers, el fallback `[[default]].js` solo encaja rutas no raíz como `/foo`, `/api/xxx`; **la ruta raíz `/` solo reconoce `functions/index.js`** — si falta ese archivo, la portada cae directamente en la página 404 por defecto de la plataforma (las APIs funcionan con normalidad). Este directorio ya incluye `functions/index.js` para resolverlo (única fuente de la lógica y de la lista blanca ENV_KEYS; `[[default]].js` solo lo re-exporta, sin doble mantenimiento)
- **Sondeo largo**: el límite de duración de ejecución de Functions es bastante ajustado y el `/api/wait` (25 segundos en espera) puede cortarse antes de tiempo — el frontend reintenta automáticamente, sin afectar a las funciones
- **Diagnóstico de fallos de despliegue**: el directorio raíz debe ser `platforms/edgeone`; faltan las variables `TURSO_*` y da 500 con "config error"
- **Actualizar el código**: push al repositorio de GitHub y redespliegue automático
