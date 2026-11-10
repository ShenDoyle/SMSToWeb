# SMSToWeb — Pasarela en la nube de SMS y notificaciones

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | **Español** | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

SMSToWeb reúne mensajes de cualquier canal (reenvío de SMS, notificaciones de apps, scripts, webhooks e integraciones personalizadas) mediante una API HTTP y un formato de mensaje comunes, para verlos, buscarlos y reenviarlos desde una única página web.

- **Soporte multiplataforma**: Cloudflare Workers / Vercel / Deno Deploy / Netlify / Tencent EdgeOne Makers / Docker autohospedado — elija la plataforma que mejor se ajuste a su entorno.
- **Recepción en tiempo real**: el push por webhook llega a la base de datos en segundos; la página web se actualiza sola, sin trabajo manual
- **Push universal**: cualquier dispositivo que pueda enviar una petición HTTP (Linux / Windows / macOS / iOS / NAS / scripts) puede enviar notificaciones a la misma página
- **Fuentes y filtros**: filtra dinámicamente por fuente (SMS / notificaciones y fuentes personalizadas agregadas automáticamente), combinado con búsqueda por palabra clave y los rangos Hoy / Últimos 7 días / Últimos 30 días; tamaño de página ajustable
- **Reenvío multicanal**: los mensajes nuevos se pueden reenviar automáticamente a Feishu / WeCom / DingTalk / Telegram / ServerChan / PushPlus / Bark / ntfy / Gotify / correo electrónico / webhook genérico — configura solo lo que uses (opcional)
- **Seguridad opcional**: interruptor de inicio de sesión del panel de administración, extracción de códigos OTP en varios formatos (código primero / palabra clave primero / segmentado / mixto, resistente a falsos positivos) con copia de un toque, modo oscuro
- **Datos y alertas**: exporta CSV / JSON según el filtro actual; toast / sonido opcional / píldora flotante para mensajes nuevos con la página visible, notificación del navegador + título con no leídos en segundo plano; los mensajes largos se contraen automáticamente
- **Reconocimiento de números**: directorio integrado de números institucionales comunes (operadoras / bancos / mensajerías / organismos públicos) etiquetados automáticamente; consulta opcional de la región de la operadora para números móviles desconocidos (activada por defecto, se puede desactivar)
- **9 idiomas**: las páginas de administración y de inicio de sesión incluyen zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR integrados; cámbialos desde el menú 🌐 de la cabecera (se admite deep link `?lang=`, la elección se recuerda localmente); fechas, tiempos relativos y etiquetas del directorio cambian también
- **Adaptado a móviles**: soporte de área segura `viewport-fit` para notch y barras de gestos, campos de entrada de 16px para evitar el zoom automático de iOS, objetivos táctiles más grandes, diálogos bottom-sheet, PWA para añadir a la pantalla de inicio
- **Acciones masivas y deshacer**: borrado multiselección, vaciado por filtro con un toque; deshacer durante 5 segundos tras el borrado (borrado suave); modo oscuro con automático / claro / oscuro
- **Destacados / no leídos / estadísticas**: estrella para fijar, vistas solo destacados / solo no leídos, panel de estadísticas (desglose por fuente + últimos 7 días); etiquetas de número personalizadas; resaltado e historial de búsqueda; no molestar y sonido en los ajustes; PWA

```
[SMS] Android(SmsForwarder) ──POST /api/receive──┐
                                                 ├─→ cloud gateway (any platform) ─→ database
[notify] scripts / shortcuts ──POST /api/push────┘        │
                                                browser ◀── web admin (embedded in gateway)
```

**Despliegue en Cloudflare**:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

El botón crea la base de datos y las tablas, vincula los recursos y configura CI automáticamente; rellena `RECEIVE_TOKEN` (secreto de autenticación del push) cuando se te pida y ya estás en línea. Los botones de un clic para Vercel / Netlify están en sus guías de plataforma.

| Plataforma | Despliegue | Limpieza programada | Guía |
|---|---|---|---|
| **Cloudflare** (recomendada) | Worker + D1 | cron de la plataforma | [platforms/cloudflare/README.md](../../../platforms/cloudflare/README.md) |
| Vercel | Edge Function + Turso | cron de la plataforma | [platforms/vercel/README.md](../../../platforms/vercel/README.md) |
| Deno Deploy | Deno nativo + Turso | Deno.cron | [platforms/deno/README.md](../../../platforms/deno/README.md) |
| Netlify | Functions v2 + Turso | Scheduled Function | [platforms/netlify/README.md](../../../platforms/netlify/README.md) |
| Tencent EdgeOne Makers | Functions + Turso | cron externo | [platforms/edgeone/README.md](../../../platforms/edgeone/README.md) |
| Fly.io / Railway / VPS | Docker (Node 22) + Turso / SQLite local | en el propio proceso | [platforms/node/README.md](../../../platforms/node/README.md) |

> Cada directorio de plataforma está **completamente autocontenido** (código + esquema + documentación independiente, cero dependencias npm, sin paso de compilación). Haz clic en una guía de arriba y sigue los pasos. Las funciones y el esquema de datos son idénticos en todas las plataformas; puedes migrar entre ellas en cualquier momento.
> Para comparar plataformas y la preparación común (base de datos Turso), consulta [platforms/README.md](../../../platforms/README.md).

---

## Configuración del teléfono e ingesta multiplataforma

Todas las plataformas entregan los mensajes en la misma página web: los SMS del teléfono pasan por `/api/receive` (SmsForwarder de Android), todo lo demás usa el `/api/push` universal.

Configuración paso a paso (comandos/scripts listos para copiar por plataforma): **[Guía de despliegue e ingesta](../../../docs/i18n/en/DEPLOYMENT.md)**

**Referencia rápida del push universal** (todos los campos en la guía):

```
POST https://<your-domain>/api/push?token=<RECEIVE_TOKEN>
{"source":"notify","sender":"demo","content":"hello from anywhere"}
```

Una respuesta `{"success":true,...}` significa que se almacenó; enviar exactamente el mismo payload otra vez devuelve `duplicated:true`.

## Variables de entorno (todas las plataformas)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `RECEIVE_TOKEN` | sí | secreto de autenticación del push; elige una cadena aleatoria larga |
| `ENABLE_AUTH` | no | `"true"` exige inicio de sesión para la página de administración (**muy recomendable**, ver las notas de seguridad más abajo); por defecto no hay inicio de sesión |
| `ADMIN_PASSWORD` | no | contraseña de inicio de sesión (se configura cuando `ENABLE_AUTH="true"`; si falta, las APIs de administración rechazan el acceso y registran una alerta — la configuración ausente nunca abre la puerta) |
| `RETENTION_DAYS` | no | retención de datos en días, por defecto 30 |
| `WAIT_MAX_SECONDS` | no | segundos máximos que el sondeo largo de `/api/wait` puede quedar en espera, por defecto 25 (rango 3–25). En **Netlify Functions** (tope de 10s) u otras plataformas de timeout corto pon `8` para que la plataforma no mate las peticiones |
| `PHONE_AREA_ENABLED` / `PHONE_AREA_API` | no | consulta de la región de la operadora: activada por defecto (API gratuita 360, sin clave, caché de 24h en el backend, solo números móviles de 11 dígitos); pon `false` para desactivarla; fuente personalizada mediante `PHONE_AREA_API` (URL con el marcador `{number}`) |
| Variables de canales de notificación | no | `FEISHU_WEBHOOK` (Feishu) / `WECOM_WEBHOOK` (WeCom) / `DINGTALK_WEBHOOK` (DingTalk, con firma opcional `DINGTALK_SECRET`) / `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY` (con `BARK_URL` opcional) / `NTFY_URL` (con `NTFY_TOKEN` opcional) / `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO` (correo, con `MAIL_FROM` opcional) / `GENERIC_WEBHOOKS` (webhook genérico, con `GENERIC_WEBHOOK_TEMPLATE` de cuerpo / `GENERIC_WEBHOOK_HEADERS` de cabeceras opcionales). Configura solo lo que uses; sin ninguna no se reenvía nada. Las notificaciones se renderizan automáticamente en tres modos según el contenido (🔐 OTP / 💬 SMS / 🔔 notificación) |
| `SITE_NAME` / `SITE_ICON` | no | nombre del sitio / URL del icono; se aplican valores por defecto si no se establecen |
| `NOTIFY_LINK` | no | URL de inicio de la página de administración; al configurarla, cada canal de notificación recibe una entrada "Abrir administración" (botón/enlace/click); se omite automáticamente si no está configurada |
| `SESSION_SECRET` | necesaria si el inicio de sesión está activo | secreto de firma de sesión: **valor aleatorio de alta entropía (se recomiendan ≥32 caracteres aleatorios), totalmente independiente de la contraseña de administrador**; Cloudflare y EdgeOne (y cada otra plataforma) deben tener cada uno su propio valor; nunca lo subas a Git ni reutilices la contraseña. Si falta, el inicio de sesión y la autenticación **fallan de forma segura (fail-closed)** (el inicio de sesión devuelve 500, las APIs de administración devuelven 401, sin alternativa derivada de la contraseña). Rotar el valor invalida inmediatamente todas las sesiones existentes. Las sesiones duran 30 minutos; cerrar sesión solo borra la cookie del navegador — un token de sesión copiado sigue siendo válido dentro de su TTL (hasta 30 minutos) |

Cloudflare necesita además el binding `DB` (D1); las demás plataformas necesitan `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (base de datos Turso, ver la guía de cada plataforma); el autohospedado en Node también admite el modo SQLite local `SQLITE_PATH` (ver platforms/node/README.md).

> **Recomendaciones de seguridad**
> 1. **Activa el inicio de sesión del panel de administración** (`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`): la página de administración contiene contenido sensible como códigos OTP de SMS; sin inicio de sesión, cualquiera que conozca el dominio puede leer todos los mensajes y borrar datos. El endpoint de inicio de sesión está limitado en tasa (5 fallos consecutivos por IP lo bloquean 10 minutos); `/api/receive` y `/api/push` están limitados a 120 escrituras por IP y minuto (429 por encima).
> 2. **Contrapartida del `?token=` en las URLs**: por compatibilidad con SmsForwarder y clientes similares, `/api/receive` y `/api/push` aceptan autenticación mediante el parámetro de query `?token=` — el token puede aparecer en los logs de acceso de la plataforma y en el historial del navegador. Si te preocupa, cambia a POST con la cabecera `Authorization: Bearer <RECEIVE_TOKEN>` (ambas formas están soportadas).

## Licencia

[MIT](../../../LICENSE) © 2026 [左立方 (ZuoLifang)](https://cbm.im/)
