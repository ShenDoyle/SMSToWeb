# Guía de despliegue en Cloudflare (versión principal, todo desde el navegador)
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | **Español** | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Sincronizado del original en inglés (es)

Esta es la versión principal del proyecto: SMS/notificaciones del móvil → Cloudflare Worker → base de datos D1 → página web de administración.
Sin servidor, cuota gratuita de sobra, todo se hace con clics en el navegador, sin instalar ninguna herramienta.

Este directorio está **completamente autocontenido**: [`worker.js`](../../../platforms/cloudflare/worker.js) (código fuente de despliegue) + [`schema.sql`](../../../platforms/cloudflare/schema.sql) (script de creación de tablas) + [`wrangler.toml`](../../../platforms/cloudflare/wrangler.toml) (configuración opcional para el despliegue por línea de comandos), sin depender de otros archivos del repositorio. El resto de plataformas: [Resumen de plataformas](./PLATFORMS.md).

---

## Despliegue con un clic (recomendado para principiantes)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

Al pulsar el botón de arriba, Cloudflare completa automáticamente: clonar el código a tu GitHub → **crear la base de datos D1 y ejecutar el script de tablas** → vincular recursos → configurar CI (cada push posterior a tu repositorio redespliega automáticamente) → publicar. Durante el proceso, rellena los dos secretos que se te pidan:

- `RECEIVE_TOKEN`: secreto de autenticación del push; inventa una cadena aleatoria suficientemente larga (el `token=` de la URL de conexión del móvil debe coincidir con él)
- `ADMIN_PASSWORD`: contraseña de login de la página de administración (**muy recomendable configurarla** — la página de administración contiene contenido sensible como códigos OTP de SMS; con `ENABLE_AUTH="true"` pero sin este valor, las APIs de administración rechazan siempre el acceso, nunca se abre el paso sin login)
- `SESSION_SECRET`: secreto de firma de la sesión de login, **obligatorio al activar el login** — valor aleatorio de alta entropía (≥32 caracteres aleatorios, p. ej. generado con `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`), totalmente independiente de la contraseña; si falta, login y autenticación fallan de forma segura (login 500, APIs de administración 401), sin alternativa derivada de la contraseña; al rotarlo, todas las sesiones antiguas quedan inválidas al instante

> Para vincular un dominio personalizado (p. ej. `sms.example.com`): tras el despliegue, entra en el Worker → Configuración → Dominios y rutas → Añadir dominio personalizado.
> El tutorial manual de abajo se conserva para quien no quiera el flujo de un clic o quiera entender cada paso.

## Preparación

1. Una cuenta de Cloudflare ([registro](https://dash.cloudflare.com/sign-up), gratis, basta un correo)
2. El código del proyecto (el [`worker.js`](../../../platforms/cloudflare/worker.js) de este directorio es todo el código que hay que pegar)

## Paso 1: crear la base de datos D1

1. Inicia sesión en [dash.cloudflare.com](https://dash.cloudflare.com)
2. Menú izquierdo **Almacenamiento y bases de datos → Bases de datos SQL D1**
3. Pulsa **Crear base de datos**, nómbrala `sms-gateway-db` (el resto por defecto) y pulsa crear
4. Entra en la base de datos recién creada → pestaña **Console**
5. Copia y pega todo el contenido del [`schema.sql`](../../../platforms/cloudflare/schema.sql) de este directorio en el cuadro de entrada y pulsa **Ejecutar**
6. Indicará ejecución correcta (creará las tablas `messages` y `devices`)

## Paso 2: crear el Worker y pegar el código

1. Menú izquierdo **Cómputo (Workers) → Workers y Pages**
2. Pulsa **Crear aplicación**, elige **Start with Hello World!** (empezar desde la plantilla Hello World), nómbrala `sms-gateway` y pulsa **Desplegar** (basta con que el despliegue inicial con el código por defecto funcione)
3. Pulsa **Editar código** y borra todo el código por defecto del editor
4. Abre el [`worker.js`](../../../platforms/cloudflare/worker.js) de este directorio, cópialo entero y pégalo en el editor
5. Pulsa **Desplegar** arriba a la derecha; indicará despliegue correcto

## Paso 3: vincular la base de datos D1

1. Vuelve a la página de resumen del Worker → pestaña **Bindings (vinculaciones)**
2. Pulsa **Añadir → Base de datos D1**
3. En el nombre de la variable escribe `DB` (debe ser exactamente igual, en mayúsculas) y elige la `sms-gateway-db` recién creada
4. Pulsa **Desplegar/Guardar**

## Paso 4: configurar variables y secretos

En el mismo sitio, **Configuración → Variables y secretos (Variables and Secrets)**, añade uno a uno:

1. **Añadir variable** (tipo «Texto»):
   - Nombre `RETENTION_DAYS`, valor `30` (si quieres conservar 90 días, pon `90`)
   - Nombre `ENABLE_AUTH`, valor `false` (**por seguridad se recomienda encarecidamente `true` para activar el login**: la página de administración contiene contenido sensible como códigos OTP de SMS; sin login queda abierta a cualquiera que conozca el dominio. Si despliegas automáticamente conectando el repositorio con Workers Builds, manda el `wrangler.toml` del repositorio — ahora por defecto `true`)
   - Nombre `SITE_NAME` (opcional), valor: nombre personalizado del sitio, p. ej. `Mi estación de SMS`
   - Nombre `SITE_ICON` (opcional), valor: URL del icono (que empiece por `http(s)://`); si no se rellena o la URL no es válida se usa el icono integrado
   - Nombre `NOTIFY_LINK` (opcional), valor: URL de inicio de la página de administración (que empiece por `http(s)://`); al configurarla, todos los canales de notificación añaden la entrada "Abrir administración"
2. **Añadir secreto** (tipo «Secreto/Secret»):
   - Nombre `RECEIVE_TOKEN`, valor: inventa una cadena aleatoria suficientemente larga (no uses ningún valor de ejemplo del tutorial; cuanto más largo, mejor)
   - Nombre `ADMIN_PASSWORD`, valor: inventa una contraseña de login de la página de administración (solo necesaria con `ENABLE_AUTH="true"`)
   - Nombre `SESSION_SECRET`, valor: una cadena aleatoria de alta entropía (≥32 caracteres, independiente de la contraseña; solo necesaria con `ENABLE_AUTH="true"`)
3. Tras cada añadido, pulsa **Desplegar/Guardar**

> Estos valores surten efecto en cualquier momento, sin volver a pegar código. Si cambias `RECEIVE_TOKEN`, recuerda actualizar también el `token=` de la URL del móvil.

## Paso 5 (opcional): configurar los canales de reenvío de notificaciones

Una vez almacenados los mensajes nuevos, se pueden reenviar automáticamente a canales externos; **se reenvía solo el canal cuya variable configures; si no se configura ninguno, no se reenvía nada**.
Basta con añadir las variables correspondientes en la misma página «Variables y secretos»:

| Canal | Variable | Descripción |
|---|---|---|
| Bot de grupo de Feishu | `FEISHU_WEBHOOK` (opcional `FEISHU_SECRET`) | dirección del webhook del bot de grupo; si la seguridad del bot usa «verificación de firma», configura además `FEISHU_SECRET` |
| Bot de grupo de WeCom | `WECOM_WEBHOOK` | dirección del webhook del bot de grupo |
| Bot de grupo de DingTalk | `DINGTALK_WEBHOOK` (opcional `DINGTALK_SECRET`) | la seguridad por firma requiere configurar `DINGTALK_SECRET` |
| ServerChan | `SERVERCHAN_SENDKEY` | SendKey (push a WeChat) |
| PushPlus | `PUSHPLUS_TOKEN` | token (push a WeChat) |
| Bot de Telegram | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | token del bot + ID de chat/grupo |
| Bark | `BARK_DEVICE_KEY` (opcional `BARK_URL`) | con servidor propio configura `BARK_URL`; por defecto el oficial |
| ntfy | `NTFY_URL` (opcional `NTFY_TOKEN`) | URL completa del topic, p. ej. `https://ntfy.sh/my-sms`; los topics protegidos requieren además `NTFY_TOKEN` (Token o user:password) |
| Gotify | `GOTIFY_URL` + `GOTIFY_TOKEN` | dirección del servidor (sin `/message`) + token de aplicación |
| Correo (Resend) | `RESEND_API_KEY` + `MAIL_TO` (opcional `MAIL_FROM`) | `MAIL_FROM` por defecto `onboarding@resend.dev` |
| Webhook genérico | `GENERIC_WEBHOOKS` (opcional `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`) | varias URLs separadas por comas; plantilla para el cuerpo personalizado y cabeceras JSON; por ahí se integran APIs de terceros (pasarelas de SMS, etc.) |

Los pasos de solicitud y obtención de cada canal y el formato del cuerpo: ver [Guía de despliegue y conexión multiplataforma · Canales de reenvío de notificaciones](./DEPLOYMENT.md).
Reenvío concurrente multicanal; el fallo de un solo canal no afecta a los demás ni al almacenamiento de mensajes; los mensajes duplicados (`duplicated`) no se reenvían dos veces.
Las notificaciones se renderizan automáticamente en tres estados según el contenido (🔐 alerta de código / 💬 SMS nuevo / 🔔 notificación de dispositivo): el código entra automáticamente en el título y activa las capacidades mejoradas de cada plataforma (la notificación de Bark copia el código con un toque, Bark/ntfy suben la prioridad, cabecera violeta de las tarjetas de Feishu, etc.).

## Paso 6: configurar la tarea de limpieza programada

1. Worker → **Configuración → Activadores (Triggers) → Activadores Cron**
2. Pulsa **Añadir activador Cron**, pon `0 17 * * *` y guarda
3. Significa: cada día a las 17:00 UTC (01:00, hora de Pekín) se borran automáticamente los datos que superen los días de retención

## Paso 7: vincular dominio (opcional, recomendado)

1. Worker → **Configuración → Dominios y rutas**
2. Pulsa **Añadir → Dominio personalizado** y escribe un subdominio (p. ej. `sms.tudominio.com`)
3. Cloudflare crea el registro DNS y emite el certificado HTTPS automáticamente, efectivo en pocos minutos
4. A partir de entonces, abre directamente `https://sms.tudominio.com` en el navegador y verás la página de administración

> Si no tienes dominio, puedes usar la dirección por defecto `https://sms-gateway.<tu-subdominio>.workers.dev`.

## Paso 8: verificar el despliegue

Abre la página de administración en el navegador: deberías ver la página con el nombre de tu sitio (por defecto "SMS Gateway", cambiable con `SITE_NAME`; si activaste el login, verás antes la página de login). Verifica también la API de recepción (sustituye `<dominio>` y `<secreto>` por los tuyos):

```
curl "https://<域名>/api/receive?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"name\":\"test\",\"sim\":\"13800138000\",\"from\":\"10086\",\"content\":\"部署测试\"}"
```

Si devuelve `{"success":true,...}` funciona. Este SMS de prueba se puede borrar desde la página web.

## Conectar el móvil y los demás dispositivos

Configura el SmsForwarder de Android y el push de notificaciones de cada dispositivo según la [Guía de despliegue y conexión multiplataforma](./DEPLOYMENT.md), sustituyendo el dominio de la API por la dirección de tu Worker.

## Despliegue por línea de comandos (alternativa, para quien sepa instalar wrangler)

En este directorio (que contiene `wrangler.toml`, con `main` ya apuntando al `worker.js` de este directorio), ejecuta:

```bash
npm install wrangler        # instalación dentro del proyecto recomendada oficialmente; el npm install -g wrangler global también vale
npx wrangler login
npx wrangler d1 execute sms-gateway-db --file=schema.sql --remote
npx wrangler secret put RECEIVE_TOKEN
npx wrangler secret put ADMIN_PASSWORD   # solo necesario si el login está activado
npx wrangler secret put SESSION_SECRET   # solo necesario si el login está activado (valor aleatorio de alta entropía, independiente de la contraseña)
npx wrangler deploy
```

## Avisos y preguntas frecuentes

- **No llegan los SMS reenviados**: revisa en orden ① el interruptor general «Reenviar broadcast de SMS» en los ajustes generales de SmsForwarder (lo que más se olvida; si está apagado, descarta en silencio y las pruebas de canal salen todas en verde) → ② que el token/URL de la regla de reenvío coincida con el secreto del Worker → ③ los logs en tiempo real del Worker para ver si llegan las peticiones
- **No llega nada por el canal de notificaciones**: confirma que la variable de ese canal está configurada y con el valor correcto; mira si los logs en tiempo real del Worker muestran `notify forward failed:`; los mensajes con `duplicated:true` no se reenvían
- **Cuota gratuita del Worker**: 100.000 peticiones al día, de sobra para uso personal; la cuota gratuita de D1 son 5 millones de lecturas de filas al día
- **Sondeo largo**: la página de administración se suspende en `/api/wait` hasta 25 segundos esperando mensajes nuevos; Workers no tiene problema de duración de petición y ofrece la mejor temporalidad real
- **Migración de datos**: para volver a CF desde otra plataforma, exporta los datos de Turso e impórtalos en D1 (la estructura de tablas es idéntica)
