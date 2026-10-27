# Documentação de arquitetura

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | **Português (BR)**

> Sincronizado do original em inglês (pt-BR)

O SMSToWeb é um sistema de "um núcleo + múltiplas entradas de plataforma" para agregar SMS/notificações: um núcleo de negócio sem npm (`src/worker.js`), sincronizado por um script gerador para seis plataformas de implantação; cada plataforma mantém apenas um adaptador fino para a sua runtime e banco de dados.

## 1. Topologia geral

```
手机（SmsForwarder / 任意脚本）
   │  POST /api/receive（短信）或 /api/push（通用推送）+ token
   ▼
┌─────────────────────────── 任选一个平台部署 ────────────────────────────┐
│  Cloudflare Workers (D1)   Vercel Edge   Deno Deploy                     │
│  Netlify Functions         EdgeOne (Turso)   Node 自托管 (Docker)         │
│                                                                           │
│  入口层（薄适配）：接收请求 → buildEnv 透传环境变量 → fetchApp()          │
│  业务核心（单文件 app.js）：鉴权 → 入库 → 查询 → 长轮询 → 通知转发        │
└──────────────────────────────────────────────────────────────────────────┘
   │                                  │
   ▼                                  ▼
管理页（内嵌 HTML，登录鉴权）      11 渠道通知转发（飞书/企微/钉钉/…）
```

Princípio central de design: **separação entre código de negócio e entrada de plataforma**. A lógica central não muda com a plataforma de implantação; apenas o adaptador fino conecta as interfaces de runtime e banco de dados da plataforma; as seis plataformas são estritamente idênticas em funcionalidade.

## 2. Estrutura de diretórios

```
src/worker.js                 # 唯一业务源文件（Cloudflare Worker 形态：export default { fetch, scheduled }）
platforms/
  gen_app.py                 # 同步生成脚本（见 §3）
  shared/app.js               # 生成产物：与 src/worker.js 业务部分逐字节一致，仅替换导出形态
  cloudflare/                 # CF 主版本副本 + wrangler.toml（静态维护）
  vercel/  netlify/  deno/    # 各平台自包含目录：入口 + app.js + db.js + schema.sql + README
  edgeone/ node/              # EdgeOne 走 Turso；node/db.js 为 Turso + 本地 SQLite 双适配（独立维护）
tests/run.mjs                 # suíte de testes sem dependências (node:sqlite, 204 testes)
docs/                         # 文档（本目录）
schema.sql                    # 数据库建表脚本（单一来源）
```

Cada diretório de plataforma é **totalmente autônomo**: a entrada referencia apenas os `app.js` / `db.js` do próprio diretório — implantável isoladamente, sem dependências cruzadas.

## 3. Mecanismo de sincronização (platforms/gen_app.py)

`python platforms/gen_app.py` faz em uma passada (idempotente, repetir sem desvio):

1. Toma `src/worker.js` como fonte única, recorta todo o código de negócio antes de `export default {`, acrescenta a cauda de exportação genérica (`fetchApp` / `runCron` / `handleCronRequest`) e grava o resultado em `platforms/shared/app.js`;
2. copia a cópia shared junto com o `shared/db.js` e o `schema.sql` da raiz para os diretórios de plataforma (exceto o `node/db.js` — mantido separadamente);
3. substitui, com a **whitelist ENV_KEYS** embutida no script (uma única lista de 31 variáveis de ambiente), o conteúdo entre as marcações `/* ==== ENV_KEYS BEGIN ==== */ … /* ==== ENV_KEYS END ==== */` de cada arquivo de entrada — assim o conjunto de variáveis de ambiente repassadas é idêntico nas seis plataformas e não desvia.

Regra de ferro: **toda mudança de negócio só em `src/worker.js` (e na lista ENV_KEYS do gen_app.py); depois, rode obrigatoriamente o gen_app.py de novo**; é proibido alterar à mão os artefatos gerados sob platforms/ (exceções: node/db.js e wrangler.toml).

## 4. Ciclo de vida da requisição

Tomando `POST /api/receive` como exemplo:

1. **Camada de entrada**: a entrada da plataforma (ex.: `platforms/edgeone/functions/index.js`) recebe a requisição, monta `env = buildEnv(vars)` (repassa as variáveis da whitelist + as credenciais do ramo do banco) e chama `fetchApp(request, env[, ctx])`;
2. **Autenticação**: `/api/receive`, `/api/push`, `/api/login`, `/api/logout`, `/api/cron` e recursos estáticos são caminhos públicos; os demais endpoints de administração e páginas ficam sujeitos à alternância de login (`ENABLE_AUTH`) — após o login é emitida uma **sessão assinada sem estado** (formato de três segmentos `nonce.exp.HMAC-SHA256`, cookie `sms_auth`, TTL de 30 minutos); com `SESSION_SECRET` ausente, login e autenticação falham com segurança (login 500, endpoints de administração sempre 401, sem fallback derivado da senha), configuração ausente nunca libera acesso;
3. **Armazenamento**: validar o token (`safeEqual` contra ataques de timing) → localizar/criar o dispositivo por device+sim → gravar em messages (o índice único do banco bloqueia duplicatas; push duplicado retorna `duplicated:true` sem encaminhamento);
4. **Encaminhamento de notificações**: não duplicatas vão por `bgRun(ctx, dispatchNotify(env, msg))` para o segundo plano — o Cloudflare passa o `ctx.waitUntil` real para o envio continuar após a resposta; sem ctx nas outras plataformas, degrada para `await` inline para as funções de edge não abortarem as tarefas em segundo plano prematuramente;
5. **Resposta**: JSON imediato (`success/device_id/duplicated`), sem esperar o fim do encaminhamento (plataforma CF).

## 5. Subsistema de encaminhamento de notificações

O `dispatchNotify(env, msg)` é a camada única de montagem de todos os canais:

- `extractCodeLite(content)`: extração leve de OTP no servidor (mesma ordem em cascata do `extractCode` do front-end: código no início antes de palavra-chave no início; antes da extração, remove números de telefone/datas e horas/valores monetários/números de nota);
- `buildNotifyInfo(env, msg)`: detecção de OTP + `NOTIFY_LINK` (lido uma vez por execução) produzem os três estados `verify/sms/notify` e o título unificado;
- o renderizador de cada canal consome o `info` e renderiza seu próprio formato (cartão interativo do Feishu / markdown do WeCom e DingTalk / HTML do Telegram / Bark / ntfy / Gotify / e-mail Resend / template do webhook genérico etc.); limite de tamanho, assinatura e escape ficam no renderizador;
- `Promise.allSettled` controla em paralelo; a falha de um canal é apenas registrada no log e não afeta os outros canais nem o fluxo principal.

## 6. Front-end (página de administração embutida)

O HTML da página de administração fica embutido como template literal `String.raw` no `src/worker.js` (renderizado no servidor, sem projeto de front-end próprio): página de login e página de administração dividem a rota `/`; a alternância de login decide a forma renderizada; suporta nove idiomas (zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR, dicionário embutido via `data-i18n` + acesso direto por `?lang=`, fallback para en em chaves ausentes), modo escuro, cópia automática de OTP, auto-atualização por long polling (`/api/wait`), filtro de origens e gestão de dispositivos.

## 7. Diferenças entre plataformas, de relance

| Plataforma | Arquivo de entrada | Banco de dados | cron |
|---|---|---|---|
| Cloudflare | `export default` (o próprio worker.js) | D1 (`env.DB`) | `scheduled` nativo + `/api/cron` via HTTP |
| Vercel | `api/[[...route]].js` | Turso | Vercel Cron (Bearer `CRON_SECRET`) |
| Netlify | `functions/api.mjs` + `functions/cron.mjs` | Turso | Scheduled Functions |
| Deno | `main.js` (`Deno.serve`) | Turso | agendador externo |
| EdgeOne | `functions/index.js` (caminho raiz deve ser index.js) | Turso (cache de clientes keyado por fingerprint das credenciais) | agendador externo |
| Node | `server.mjs` (node:http) | Turso / SQLite local (adaptador duplo) | agendador externo / Docker |

A semântica de disparo via HTTP do `/api/cron` é igual em todas as plataformas: `?token=<RECEIVE_TOKEN>` ou `Authorization: Bearer <RECEIVE_TOKEN>`.
