# Documentação da API

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | **Português (BR)**

> Sincronizado do original em inglês (pt-BR)

Todos os endpoints ficam sob a raiz `/`, as respostas são JSON (`Content-Type: application/json`) com suporte a CORS. Exceto os "endpoints públicos", todos são protegidos pela alternância de login (recomendações de configuração de segurança: veja o README da raiz, seção "Recomendações de segurança").

## Formas de autenticação

| Tipo de endpoint | Autenticação |
|---|---|
| Push de entrada (`/api/receive`, `/api/push`) | `?token=<RECEIVE_TOKEN>` (query ou campo do formulário), **não afetado pela alternância de login** |
| Endpoints de administração | sessão via cookie `sms_auth` (obtida em `POST /api/login`; ativa quando `ENABLE_AUTH=true`). A sessão é um **token assinado sem estado** (formato de três segmentos `nonce.exp.HMAC-SHA256`, chave de assinatura `SESSION_SECRET`), válida por 30 minutos; com `SESSION_SECRET` ausente, login e autenticação falham com segurança (login 500, endpoints de administração sempre 401, sem fallback derivado da senha), configuração ausente nunca libera acesso. Após a rotação de `SESSION_SECRET`, todas as sessões antigas ficam imediatamente inválidas |
| Limpeza agendada (`GET /api/cron`) | `?token=<RECEIVE_TOKEN>` ou `Authorization: Bearer <RECEIVE_TOKEN>` |

## 1. Push de entrada (público)

### POST/GET `/api/receive` — gravar SMS no banco (compatível com SmsForwarder)

Parâmetros (corpo JSON; no GET, via query):

| Campo | Obrigatório | Descrição |
|---|---|---|
| `token` | sim | RECEIVE_TOKEN (também na query) |
| `name` | não | nome do dispositivo (campo `name` do template do app), padrão `unknown` |
| `sim` | não | número do celular que recebeu, armazenado e exibido sem alterações |
| `from` | não | remetente |
| `content` | sim | texto do SMS (truncado para 8000 caracteres no servidor) |
| `time` | não | hora do cliente; sem valor, vale a hora do servidor em Pequim |

```bash
curl -X POST "https://<seuSite>/api/receive?token=<RECEIVE_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"我的手机","sim":"13800000000","from":"10086","content":"验证码 123456"}'
```

Resposta: `{ "success": true, "device_id": 1, "duplicated": false }`. Push repetido com mesmo dispositivo + remetente + conteúdo + segundo → `duplicated: true` (armazenamento ignorado e **sem encaminhamento de notificação**).

### POST `/api/push` — push universal (ingestão de fontes de qualquer plataforma)

| Campo | Obrigatório | Descrição |
|---|---|---|
| `token` | sim | RECEIVE_TOKEN (query) |
| `content` | sim | texto (truncado para 8000 caracteres) |
| `name` / `sender` | não | nome do dispositivo / remetente (nome do app, do script etc.) |
| `source` | não | categoria da origem (padrão `notify`; ex.: `alert`, `jd`; o front-end filtra por origem) |
| `time` | não | hora do cliente; sem valor, a hora atual do servidor |

Esse recebimento também dispara o encaminhamento para os 11 canais de notificação (renderização em três estados: push sem OTP → 🔔 notificação de dispositivo).

## 2. Consulta e gestão de mensagens (requer sessão de login)

### GET `/api/messages` — lista de mensagens

Parâmetros de query:

| Parâmetro | Descrição |
|---|---|
| `q` | busca por palavra-chave (percorre sender/content) |
| `source` | filtro de origens (ex.: `sms` / `notify` / origem personalizada) |
| `device_id` | filtro por dispositivo |
| `range` | período: `1d` / `7d` / `30d` |
| `limit` / `page` | paginação (padrão 50 por página) |
| `starred` | `1` só favoritos |

Resposta: `{ "total": 123, "limit": 50, "page": 1, "list": [ { "id", "device_id", "display_name", "sim_number", "sender", "source", "content", "received_at", "starred", "read_at", "deleted_at" } ] }`

### Ações sobre mensagens

| Método | Caminho | Descrição |
|---|---|---|
| POST | `/api/messages/remove` | exclusão reversível (body: `{ ids: [..] }`, grava deleted_at) |
| POST | `/api/messages/restore` | desfaz a exclusão reversível (body: `{ ids: [..] }`) |
| POST | `/api/messages/clear` | limpar lixeira/tudo (body: `{ scope: "trash" \| "all" }`) |
| POST | `/api/messages/star` | alternar estrela (body: `{ id, starred }`) |
| POST | `/api/messages/read` | marcar como lida (body: `{ id }`) |
| DELETE | `/api/messages/{id}` | excluir fisicamente uma mensagem |

### GET `/api/export?format=csv|json` — exportação

Aceita os mesmos parâmetros de filtro da lista; CSV com BOM e cabeçalho de download `attachment`, com proteção contra injeção de fórmulas (células que começam com `=/+-@` recebem uma aspa simples prefixada).

### GET `/api/stats` — estatísticas

Hoje/total/número de dispositivos etc. em resumo. GET `/api/sources` — lista de origens (`[{ source, count }]`).

## 3. Gestão de dispositivos (requer sessão de login)

| Método | Caminho | Descrição |
|---|---|---|
| GET | `/api/devices` | lista de dispositivos (com `display_name`: alias > nome do dispositivo, e contagem de mensagens) |
| POST | `/api/devices/alias` | definir alias (body: `{ id, alias }`; string vazia remove) |
| POST | `/api/devices/merge` | mesclar dispositivos (body: `{ from, to }`; migra todas as mensagens e exclui o dispositivo de origem; origem → ela mesma retorna 400) |
| DELETE | `/api/devices/{id}` | excluir dispositivo (com mensagens, é recusado com `has messages`) |

## 4. Tempo real e utilidades

| Método | Caminho | Descrição |
|---|---|---|
| GET | `/api/wait?last_id=N` | long polling: se há mensagens mais novas que N, responde logo `{ changed: true }`, senão fica suspenso (padrão 25s, ajustável via `WAIT_MAX_SECONDS`) |
| GET | `/api/phone?number=` | consulta de região do número de celular (`PHONE_AREA_ENABLED=false` desativa; proxy com limite de taxa no upstream, cota própria de 120 por minuto) |
| POST | `/api/login` | login (body: `{ password }` → `Set-Cookie: sms_auth=<sessão assinada>`, token sem estado HMAC-SHA256 em três segmentos, TTL de 30 minutos, HttpOnly + SameSite=Lax; após 5 falhas, bloqueio de 10 minutos; senha errada 403, `SESSION_SECRET` ausente 500 erro de configuração) |
| POST | `/api/logout` | logout |
| GET | `/api/cron?token=` | disparar a limpeza agendada (exclui mensagens mais antigas que `RETENTION_DAYS`) |
| GET | `/` `/manifest.webmanifest` `/sw.js` | página de administração / manifesto PWA / service worker |

## 5. Formato do encaminhamento por webhook genérico (saída)

Depois de configurar `GENERIC_WEBHOOKS`, cada mensagem é enviada via POST no seguinte JSON:

```json
{
  "title": "🔐 验证码 726418 · Gitee",
  "content": "您的验证码是726418，5分钟内有效",
  "time": "2026-10-27 14:23:45",
  "source": "sms",
  "sender": "Gitee",
  "device": "我的手机",
  "type": "verify",
  "code": "726418"
}
```

`type` ∈ `verify | sms | notify`; `code` é o código OTP extraído levemente no servidor (string vazia quando não detectado). Com `GENERIC_WEBHOOK_TEMPLATE`, a renderização segue o template (placeholders `{{title}} {{content}} {{time}} {{source}} {{sender}} {{device}} {{type}} {{code}}`); se o resultado for parseável como JSON, é enviado como JSON, senão como texto simples; `GENERIC_WEBHOOK_HEADERS` define cabeçalhos próprios (string JSON de objeto).
