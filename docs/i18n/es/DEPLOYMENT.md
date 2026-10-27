# SMSToWeb – Guía de despliegue y conexión multiplataforma
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | **Español** | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Sincronizado del original en inglés (es)

Este sistema se compone de dos partes: **lado de recepción** (clientes de push de cada plataforma) + **pasarela en la nube** (elige una de seis plataformas: Cloudflare / Vercel / Deno / Netlify / EdgeOne Makers / Docker autohospedado, ver [PLATFORMS.md](./PLATFORMS.md); la forma de conexión es idéntica en todas).
Los SMS son solo una de las vías de entrada: cualquier dispositivo o script que pueda enviar peticiones HTTP puede enviar notificaciones a la misma página web para consultarlas.

```
安卓(SmsForwarder)──┐  短信+应用通知
iOS(快捷指令)───────┤
Linux(curl/ntfy)────┼──→ POST /api/receive（短信）或 /api/push（通用通知）
Windows(PowerShell)─┤         │
macOS(快捷指令)─────┘         ▼
                        Cloudflare Worker ──→ D1 存储 ──→ 统一网页（来源筛选）
                              │
                              └──（可选）多渠道通知 → 飞书/企微/钉钉/TG/Bark/邮件…
```

---

## 1. Configuración en la nube (lado Cloudflare)

### 1. Variables y secretos

Tras desplegar el Worker, configura en **Workers y Pages → sms-gateway → Configuración → Variables y secretos**:

| Nombre | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `RECEIVE_TOKEN` | Secreto | Sí | token de autenticación del push; inventa tu propia cadena aleatoria (no uses el valor del ejemplo) |
| `ADMIN_PASSWORD` | Secreto | al activar el login | contraseña de la página de administración, se recomienda una contraseña fuerte; si falta, las APIs de administración rechazan siempre el acceso (fallo seguro ante configuración ausente) y registran una alerta |
| `ENABLE_AUTH` | Texto | No | `"true"` activa el login (**muy recomendable por seguridad**: la página de administración contiene contenido sensible como códigos OTP de SMS; sin login queda abierta a cualquiera que conozca el dominio); `"false"` o sin definir = sin login |
| `FEISHU_WEBHOOK` | Texto | No | webhook del bot de grupo de Feishu; al configurarlo, los mensajes nuevos se reenvían automáticamente al grupo de Feishu (para verificación de firma configura además `FEISHU_SECRET`) |
| `FEISHU_SECRET` | Secreto | No | solo cuando la seguridad del bot de Feishu usa "verificación de firma"; el programa calcula la firma automáticamente |
| `WECOM_WEBHOOK` | Texto | No | webhook del bot de grupo de WeCom |
| `DINGTALK_WEBHOOK` | Texto | No | webhook del bot de grupo de DingTalk (la seguridad por firma requiere además `DINGTALK_SECRET`) |
| `SERVERCHAN_SENDKEY` | Texto | No | SendKey de ServerChan (push a WeChat) |
| `PUSHPLUS_TOKEN` | Texto | No | token de PushPlus (push a WeChat) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Texto | No | token del bot de Telegram + ID de chat/grupo |
| `BARK_DEVICE_KEY` | Texto | No | Key del dispositivo Bark (con servidor propio configura además `BARK_URL`; por defecto el oficial) |
| `NTFY_URL` | Texto | No | URL completa del topic de ntfy, p. ej. `https://ntfy.sh/my-sms` (los topics protegidos requieren además `NTFY_TOKEN`) |
| `NTFY_TOKEN` | Texto | No | token de acceso para topics protegidos de ntfy: el Access Token se pega directamente (usa Bearer); en servidor propio usa el formato `user:password` (usa Basic) |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | Texto | No | dirección del servidor Gotify (sin `/message`) + token de aplicación |
| `RESEND_API_KEY` + `MAIL_TO` | Texto | No | correo (API de Resend); `MAIL_FROM` opcional, por defecto `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS` | Texto | No | webhooks genéricos, varias URLs separadas por comas; `GENERIC_WEBHOOK_TEMPLATE` opcional para personalizar el cuerpo, `GENERIC_WEBHOOK_HEADERS` para las cabeceras |
| `GENERIC_WEBHOOK_HEADERS` | Texto | No | cabeceras personalizadas del webhook genérico, como cadena JSON de objeto, p. ej. `{"Authorization":"Bearer xxx"}` |
| `NOTIFY_LINK` | Texto | No | URL de inicio de la página de administración; al configurarla, todos los canales de notificación añaden una entrada "Abrir administración" (botón de Feishu, línea de enlace en cada canal, url de Bark, click de ntfy, etc.); se omite automáticamente si no está configurada |
| `SESSION_SECRET` | Secreto | obligatorio con el login activo | secreto de firma de la sesión de login: **valor aleatorio de alta entropía (se recomienda ≥32 caracteres aleatorios), totalmente independiente de la contraseña de administración**; CF y EO (y cada plataforma) deben configurar valores independientes; prohibido subirlo a Git o reutilizar la contraseña. Si falta, login y autenticación fallan de forma segura (login 500, APIs de administración 401), sin alternativa derivada de la contraseña. Tras rotarlo, todas las sesiones antiguas quedan inválidas y hay que volver a iniciar sesión; la sesión dura 30 minutos, cerrar sesión solo borra la cookie del navegador; un token copiado puede seguir siendo válido dentro del TTL |
| `RETENTION_DAYS` | Texto | No | días de retención de datos, por defecto 30, efecto inmediato al cambiarlo |
| `WAIT_MAX_SECONDS` | Texto | No | segundos máximos de suspensión del sondeo largo `/api/wait`, por defecto 25 (3–25). **Netlify Functions tiene un tope por defecto de 10s → se recomienda poner `8`**; para Vercel Edge se recomienda `20`. El frontend aplica retroceso exponencial ante fallos y no saturará la función |

> **Dos consejos de seguridad**
> 1. Activar el login de la página de administración (`ENABLE_AUTH="true"`) es muy recomendable, con una contraseña fuerte en `ADMIN_PASSWORD`; el endpoint de login ya incorpora limitación de tasa (5 fallos consecutivos por misma IP bloquean 10 minutos), y `/api/receive`, `/api/push` devuelven 429 al superar 120 escrituras por minuto (se recupera automáticamente poco después).
> 2. El token de push es compatible con el paso por URL `?token=` (caso SmsForwarder); el token aparecerá en la URL y puede acabar en los logs de acceso de la plataforma; si te importa, usa POST + la cabecera `Authorization: Bearer <RECEIVE_TOKEN>`, ambas formas están soportadas.

### 2. Canales de reenvío de notificaciones (opcional; se reenvía solo lo configurado)

Basta añadir las variables correspondientes en la página "Variables de entorno / Variables" de la plataforma de despliegue para activarlas; **si no se configura ninguna, no se reenvía nada y no afecta al almacenamiento de mensajes ni a la consulta web**.
Reenvío concurrente multicanal; el fallo de un canal no afecta a los demás; los mensajes duplicados (`duplicated:true`) no se reenvían dos veces.

Las notificaciones se renderizan automáticamente en **tres estados** según el contenido (igual en todos los canales): si se detecta un código de verificación → **alerta de código de verificación** (el código entra en el título/texto grande de la tarjeta; la notificación de Bark copia el código con un toque, Bark y ntfy suben la prioridad); SMS sin código → **SMS nuevo**; push de app/dispositivo → **notificación de dispositivo**. Con la variable opcional `NOTIFY_LINK` configurada, cada canal añade automáticamente la entrada "Abrir administración"; si no está configurada, se omite.

El cuerpo por defecto del webhook genérico es JSON, con los campos nuevos `type` (`verify`/`sms`/`notify`) y `code` (el código de verificación detectado; cadena vacía si no se detecta); las plantillas `GENERIC_WEBHOOK_TEMPLATE` admiten en consecuencia los marcadores `{{type}}`/`{{code}}`.

Pasos para obtener cada canal:

**Bot de grupo de Feishu** — `FEISHU_WEBHOOK` (opcional `FEISHU_SECRET`)
1. Grupo de destino en Feishu → Ajustes → Bots de grupo → Añadir bot → **Bot personalizado**
2. Obtén la dirección del webhook, con el formato `https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx`, y pégala en la variable
3. Seguridad, elige una de tres: **palabra clave personalizada** (recomendado: basta una palabra clave como `短信`, sin más configuración); **verificación de firma** (pega la clave en `FEISHU_SECRET`, el programa calcula la firma automáticamente); lista blanca de IP (la IP de salida del Worker no es fija, no la elijas)

**Bot de grupo de WeCom** — `WECOM_WEBHOOK`
1. Grupo de destino en WeCom → ajustes del grupo (arriba a la derecha) → Bots de grupo → Añadir bot → Crear
2. Copia la dirección del webhook, con el formato `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx`, y pégala en la variable

**Bot de grupo de DingTalk** — `DINGTALK_WEBHOOK` (opcional `DINGTALK_SECRET`)
1. Grupo de destino en DingTalk → Ajustes del grupo → Asistente inteligente de grupo → Añadir bot → **Personalizado** (acceso por webhook)
2. En seguridad se recomienda elegir **firma adicional**: pega la clave mostrada en la página (empieza por SEC) en `DINGTALK_SECRET`; si no se configura, se conecta directamente sin firma
3. Copia la dirección del webhook (formato `https://oapi.dingtalk.com/robot/send?access_token=xxxx`) y pégala en `DINGTALK_WEBHOOK`

**ServerChan (push a WeChat)** — `SERVERCHAN_SENDKEY`
1. Abre [sct.ftqq.com](https://sct.ftqq.com) e inicia sesión escaneando un código QR con WeChat
2. Copia el **SendKey** de la portada (formato `SCTxxxxxxxxxxxx`) y pégalo en la variable; los mensajes se envían a tu WeChat vía la cuenta de servicio «Fangtang»

**PushPlus (push a WeChat)** — `PUSHPLUS_TOKEN`
1. Abre [pushplus.plus](https://www.pushplus.plus) e inicia sesión con un QR de WeChat
2. Copia el **token** de la portada y pégalo en la variable; tras seguir la cuenta oficial recibirás los push en WeChat

**Bot de Telegram** — `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (funciona solo con ambos configurados)
1. En TG busca [@BotFather](https://t.me/BotFather) → `/newbot` y sigue los pasos → obtendrás un Bot Token (formato `123456:ABC-xxx`)
2. Obtén el `chat_id`: envía primero un mensaje a tu bot y abre en el navegador `https://api.telegram.org/bot<tuToken>/getUpdates`; busca `chat.id` en el JSON devuelto (en grupos, añade el bot al grupo y manda un mensaje; el ID del grupo se obtiene igual)
3. Rellena cada valor en `TELEGRAM_BOT_TOKEN` y en `TELEGRAM_CHAT_ID`

**Bark (push iOS)** — `BARK_DEVICE_KEY` (opcional `BARK_URL`)
1. Instala [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865) desde el App Store, abre la app y copia la parte Key de la URL de ejemplo (`https://api.day.app/<esta parte es la Key>/...`)
2. Pega la Key en `BARK_DEVICE_KEY`; si usas servidor propio configura además `BARK_URL` (por defecto el oficial `https://api.day.app`)

**ntfy (suscripción en Android/iOS/web)** — `NTFY_URL` (opcional `NTFY_TOKEN`)
1. Instala la app ntfy en el móvil (o usa la web [ntfy.sh](https://ntfy.sh)) y suscríbete a un nombre de topic personalizado, p. ej. `my-sms-9f2k` (cuanto más aleatorio el nombre, más privado)
2. En `NTFY_URL` pega la URL completa del topic: `https://ntfy.sh/my-sms-9f2k` (en servidor propio pon tu dirección; admite despliegue bajo subruta con proxy inverso)
3. Si el topic tiene control de acceso, configura `NTFY_TOKEN`: el Access Token (empieza por `tk_`) se pega directamente; en servidor propio usa el formato `usuario:contraseña`

**Gotify (servicio de push autohospedado)** — `GOTIFY_URL` + `GOTIFY_TOKEN`
1. Si ya tienes Gotify autohospedado: inicia sesión en la web → **Apps** → crea una aplicación → copia el **Token**
2. En `GOTIFY_URL` pon la dirección del servidor (p. ej. `https://push.example.com`, **sin** `/message`) y el token en `GOTIFY_TOKEN`

**Correo (API de Resend)** — `RESEND_API_KEY` + `MAIL_TO` (opcional `MAIL_FROM`)
1. Abre [resend.com](https://resend.com) y regístrate (cuota gratuita: 100 correos al día, 3000 al mes)
2. **API Keys** → Create API Key, copia y pega en `RESEND_API_KEY`
3. En `MAIL_TO` pon el buzón de destino (varios, separados por comas); si no rellenas `MAIL_FROM` se usa `onboarding@resend.dev` por defecto (ese remitente por defecto solo puede escribir a la dirección con la que te registraste en Resend; para enviar a cualquier buzón debes verificar tu propio dominio en Resend y configurar `MAIL_FROM`)

**Webhook genérico / API de terceros** — `GENERIC_WEBHOOKS` (opcional `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`)
1. En `GENERIC_WEBHOOKS` pon una o varias URLs (**separadas por comas**). POST JSON por defecto:

```json
{"title":"【短信】13800138000 ← 10086","content":"正文…","time":"2026-10-14 12:30:00（北京时间）","source":"sms","sender":"1069012345678","device":"我的手机"}
```

2. Si el receptor exige un formato concreto, configura `GENERIC_WEBHOOK_TEMPLATE` con los marcadores `{{title}}` / `{{content}}` / `{{time}}` / `{{source}}` / `{{sender}}` / `{{device}}` para personalizar el cuerpo; si la plantilla se puede interpretar como JSON se envía como JSON, si no, como texto plano. Ejemplo:

```
{"phone":"13800138000","msg":"{{content}}","at":"{{time}}"}
```

3. Si el receptor exige cabeceras de autenticación (sin secretos en la URL), configura `GENERIC_WEBHOOK_HEADERS` con una cadena JSON de objeto, p. ej.:

```json
{"Authorization":"Bearer sk-xxx","X-Api-Key":"yyy"}
```

Si el valor no es JSON válido se ignora, sin afectar al reenvío por defecto. Cualquier API de terceros — pasarelas de SMS, Home Assistant, n8n, scripts propios, etc. — puede integrarse con esta plantilla. Los nombres de variables y su ubicación de configuración por canal están en la tabla «Variables y secretos» de arriba; en Cloudflare se configuran en la página «Variables y secretos» del Worker, y en las demás plataformas en las variables de entorno de su tutorial.

### 3. Base de datos

La tabla `messages` de D1 debe incluir las columnas `source` (distingue SMS/notificación) y `deleted_at` (borrado suave/deshacer). En un despliegue nuevo ejecuta directamente [schema.sql](../../../schema.sql); para actualizar una base antigua:

```sql
ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'sms';
ALTER TABLE messages ADD COLUMN deleted_at TEXT;
ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN read_at TEXT;
```

---

## 2. Especificación de las APIs de push

Dos APIs públicas comparten la autenticación `RECEIVE_TOKEN` (el token puede ir en la query o en el body):

### 1. Recepción de SMS `POST /api/receive` (exclusiva de la app Android)

```
POST https://<你的域名>/api/receive?token=<RECEIVE_TOKEN>
Content-Type: application/json

{
  "name": "我的手机",
  "sim": "13800138000",
  "from": "1069012345678",
  "content": "您的验证码是 734752，5 分钟内有效",
  "time": "2026-10-14 12:29:59"
}
```

### 2. Push universal `POST /api/push` (notificaciones de cualquier plataforma)

```
POST https://<你的域名>/api/push
Content-Type: application/json

{
  "token": "<RECEIVE_TOKEN>",
  "source": "notify",
  "sender": "备份脚本",
  "name": "通知网关",
  "content": "数据库备份完成，耗时 3 分 12 秒",
  "time": "2026-10-14 03:00:00"
}
```

| Campo | Obligatorio | Descripción |
|---|---|---|
| `token` | Sí | token de autenticación |
| `content` | Sí | cuerpo del mensaje (también vale `text`/`message`/`msg`) |
| `source` | No | identificador de fuente, por defecto `notify`; lo usa el «filtro de fuentes» de la web, personalizable (p. ej. `cron`, `alert`) |
| `sender` | No | título de la fuente (nombre de host / app / script) |
| `name` | No | nombre de la etiqueta de dispositivo (nombrado personalizado), por defecto "Notification Gateway", se muestra junto a la etiqueta de SMS |
| `time` | No | hora del evento; si falta se usa la hora actual del servidor; admite timestamp o texto `YYYY-MM-DD HH:MM:SS` |

Respuesta: `{"success":true,"device_id":17,"duplicated":false}` (`duplicated=true` significa que el mensaje duplicado fue ignorado y no se reenviará a los canales de notificación)

---

## 3. Métodos de conexión por plataforma

### Android (SMS + notificaciones de apps) — SmsForwarder

1. Instala la app de código abierto «SmsForwarder» ([pppscn/SmsForwarder](https://github.com/pppscn/SmsForwarder))
2. En los ajustes generales **activa el interruptor principal «Reenviar broadcast de SMS»**
3. Crea un «Canal Webhook»: en la URL pon `/api/receive?token=<RECEIVE_TOKEN>`, con la plantilla de mensaje:

```json
{"name":"我的手机","sim":"13800138000","from":"{{FROM}}","content":"{{SMS}}","time":"{{DATE}}"}
```

> Claves: `name` es el nombre personalizado del dispositivo (la web lo muestra como etiqueta; cambiarlo genera una etiqueta nueva); `sim` es el número de teléfono directamente (se muestra abajo a la derecha de la tarjeta, doble toque para copiar); `content` debe usar la variable `{{SMS}}`.
> Reenvío de notificaciones de apps: añade otra regla de reenvío «Notificación de app», con `sender` usando `{{APP_NAME}}` y `content` usando `{{MSG}}`, cambiando el destino a `/api/push`.

### iOS — Accesos rápidos (Shortcuts)

1. Accesos rápidos → Automatización → Nueva «Automatización personal» → elige «Al recibir un SMS/mensaje»
2. Añade la acción → «Obtener contenido de URL»:
   - URL: `https://<你的域名>/api/push`
   - Método: POST, cuerpo JSON:

```json
{"token":"<RECEIVE_TOKEN>","source":"sms","sender":"iPhone","name":"通知网关","content":"[variable del cuerpo del mensaje]"}
```

3. Desactiva «Preguntar antes de ejecutar» y quedará totalmente automático. Las notificaciones programadas (batería, modo concentración) funcionan igual, eligiendo el disparador correspondiente.

### Linux — curl / scripts / systemd

La línea más sencilla:

```bash
curl -s -X POST https://<你的域名>/api/push \
  -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"web-01","content":"Nginx 已重启"}'
```

Ejemplo de notificación programada/por eventos (`/usr/local/bin/notify.sh`):

```bash
#!/bin/bash
curl -s -X POST https://<你的域名>/api/push \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"<RECEIVE_TOKEN>\",\"sender\":\"$(hostname)\",\"source\":\"cron\",\"content\":\"$1\"}"
```

Junto con un timer de systemd o cron: `notify.sh "每日备份完成"`.

Opcional avanzado: autohospeda [ntfy](https://ntfy.sh) (binario único/Docker), haz que varias máquinas se suscriban al mismo flujo de eventos y usa un pequeño script puente para reenviar los mensajes de ntfy a esta pasarela.

### Windows — PowerShell / Programador de tareas

`C:\Tools\notify.ps1`:

```powershell
param([string]$Message = "通知")
$body = @{
  token  = "<RECEIVE_TOKEN>"
  sender = $env:COMPUTERNAME
  source = "notify"
  content = $Message
} | ConvertTo-Json
Invoke-RestMethod -Uri "https://<你的域名>/api/push" -Method Post -ContentType "application/json" -Body $body
```

Uso: `powershell -File C:\Tools\notify.ps1 -Message "磁盘清理完成"`; en el Programador de tareas puedes engancharlo a eventos como el apagado o tras una copia de seguridad.

### macOS — Accesos rápidos / launchd

- Accesos rápidos: igual que en iOS (cambia el disparador de automatización a «Hora concreta», «Cambio de archivo», etc.)
- Script programado + launchd (`~/Library/LaunchAgents/local.notify.plist`):

```bash
curl -s -X POST https://<你的域名>/api/push -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"MacBook","content":"Time Machine 备份完成"}'
```

- Quien reciba los SMS del iPhone en el Mac: usa AppleScript para sondear los incrementos de la base SQLite de Messages.app y enviarlos por push (uso avanzado)

### Servidores/contenedores — Apprise (capa agregadora opcional)

[Apprise](https://github.com/caronc/apprise) soporta más de 100 destinos de notificación; puedes usar esta pasarela como uno de sus webhooks personalizados y gestionar de forma unificada el push a múltiples destinos.

---

## 4. Lista de verificación

| Verificación | Método |
|---|---|
| Autenticación de la API | una petición sin token debe devolver 403 unauthorized |
| Push universal | envía uno con cualquiera de los ejemplos de arriba; debe verse en la fuente «Notificación» de la web y los canales de notificación configurados deben recibirlo a la vez |
| Cadena de SMS | envía un SMS real desde el móvil → visible en la fuente «SMS» de la web + reconocimiento del código + reenvío por los canales de notificación |
| Filtro de fuentes | cambia en el desplegable «Filtro de fuentes» de la barra del panel: Todas / SMS / Notificaciones y fuentes personalizadas |
| Cambio de idioma | la página de administración y la de login integran nueve idiomas (简体中文 / 繁體中文 / English / 日本語 / 한국어 / Español / Français / Deutsch / Português (BR)); se elige en el menú «🌐» de la esquina superior derecha y la página entera cambia, la elección se guarda localmente en el navegador; también puedes visitar directamente `https://tudominio.com/?lang=ja` y demás como acceso directo. Los enlaces antiguos `?lang=zh` / `?lang=en` siguen siendo compatibles (se normalizan automáticamente a zh-CN / en) |
| Exportación y filtros | pulsa «Exportar CSV / JSON» para descargar el resultado del filtro actual; cambia «Últimos 7 días» y «50 por página» y la lista y la exportación cambian con ello |
| Bloqueo de duplicados | reenvía en segundos el mismo contenido: la respuesta es `duplicated:true` y los canales de notificación no lo reenvían |

## 5. Preguntas frecuentes

- **¿Envié un mensaje y la web no se refrescó?** El panel se refresca automáticamente por sondeo largo (por defecto hasta 25 segundos en espera, ajustable con `WAIT_MAX_SECONDS`); al volver a la página se lanza de inmediato una consulta extra; también puedes cambiar manualmente el filtro de fuentes para forzar la carga.
- **¿La interfaz se ve apretada en el móvil o el formulario de login se agranda?** Está adaptado a móviles (áreas seguras, campos de 16px contra el autozoom de iOS, objetivos táctiles más grandes); si aún falla, borra la caché de ese sitio y reintenta.
- **¿El sondeo largo en Netlify siempre falla?** Pon `WAIT_MAX_SECONDS` en `8` (por debajo del tope de 10s de Functions).
- **¿No llegó nada por el canal de notificaciones?** Comprueba que la variable de ese canal está configurada y correcta (las parejas como Telegram/Gotify exigen ambas); mira si los logs de la plataforma muestran `notify forward failed:`; los mensajes con `duplicated:true` no se reenvían.
- **¿Quieres cambiar el nombre de una etiqueta?** Pulsa «✎» junto a la etiqueta del dispositivo para renombrarla (fija un alias), o «⇄» para fusionar sus mensajes con otro dispositivo; las etiquetas sin mensajes se borran directamente con «×».
- **¿Cuánto se conservan los mensajes?** Lo controla `RETENTION_DAYS`, 30 días por defecto, con limpieza automática cada día a las 17:00 UTC (01:00, hora de Pekín).
