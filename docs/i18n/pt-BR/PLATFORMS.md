# Visão geral: implantação multiplataforma

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | **Português (BR)**

> Sincronizado do original em inglês (pt-BR)

As seis plataformas do SMSToWeb (versão principal do Cloudflare + cinco plataformas portadas) ficam neste diretório. **Cada subdiretório de plataforma é totalmente autônomo**:
código (entrada + aplicação central + adaptador de banco) + `schema.sql` + o guia de implantação detalhado da plataforma (README.md).

| Plataforma | Runtime | Limpeza agendada | Guia detalhado |
|---|---|---|---|
| **Cloudflare** (versão principal) | Worker + D1 | cron da plataforma | [cloudflare/README.md](../../../platforms/cloudflare/README.md) |
| Vercel | Edge Function | cron da plataforma | [vercel/README.md](../../../platforms/vercel/README.md) |
| Deno Deploy | Deno nativo | `Deno.cron` (embutido) | [deno/README.md](../../../platforms/deno/README.md) |
| Netlify | Functions v2 (Node) | Scheduled Function | [netlify/README.md](../../../platforms/netlify/README.md) |
| EdgeOne Makers (Tencent) | Functions | cron externo chama /api/cron | [edgeone/README.md](../../../platforms/edgeone/README.md) |
| Fly.io / Railway / VPS | Docker (Node 22) + Turso/SQLite local | embutido no processo | [node/README.md](../../../platforms/node/README.md) |

As seis plataformas (inclusive o Cloudflare) são totalmente idênticas em caminhos de API, lógica de autenticação, modelo de mensagens, página de administração, encaminhamento multicanal e limpeza diária (UTC 17:00),
o schema das tabelas é o mesmo — a troca é possível a qualquer momento.

> **Implantação em um clique**: no início dos guias do Cloudflare / Vercel / Netlify há botões oficiais de um clique (o do Cloudflare cria até o banco de dados e as tabelas automaticamente);
> para Deno Deploy, EdgeOne e Docker self-hosted ainda não há botões oficiais — basta seguir o guia da respectiva plataforma.

## Qual plataforma para quem

- **Grátis + sem preocupação** → versão principal do Cloudflare (cota gratuito generoso do D1, Workers sem problemas de durabilidade)
- **Experimentar várias plataformas** → Deno Deploy (o mais próximo em semântica do Worker, long polling praticamente sem abortos)
- **Acesso principalmente da China** → EdgeOne Makers (atenção: domínio próprio exige ICP)
- **Servidor disponível / quer controle total** → node/ (Docker self-hosted)

> **Long polling e timeouts por plataforma**: a página de administração espera novas mensagens via `GET /api/wait`, até 25 segundos por padrão; ajuste com a variável `WAIT_MAX_SECONDS` (3–25) conforme a plataforma.
> Netlify Functions: limite atual de 60 segundos (a entrada fica conservadoramente em `WAIT_MAX_SECONDS=8`; aumente se quiser); Vercel Edge: recomenda-se `20`; Cloudflare / Deno / Node: deixe o padrão.
> O front-end repete falhas com **backoff exponencial** (2→30s) e recarrega imediatamente quando a página volta a ficar visível — mesmo que a plataforma aborte antes, **nenhuma funcionalidade é prejudicada**; o aviso de nova mensagem chega só um pouco mais tarde.

## Preparação comum (para todas as plataformas, exceto o Cloudflare)

**Usa-se o [Turso](https://turso.tech) como banco de dados** (compatível com SQLite; cota gratuito: 100 bancos, 5GB de armazenamento, 500 milhões de leituras de linha por mês):

1. Abra [turso.tech](https://turso.tech) e entre com GitHub
2. **Create Database**: nome `sms-gateway`, região Singapore / Hong Kong, tipo Free
3. Na página de detalhes do banco, anote a **Database URL** (`libsql://sms-gateway-xxxx.turso.io`); em **Create Token**, crie um token e guarde imediatamente (visível apenas uma vez)
4. Inicialize o schema das tabelas: na área de detalhes, **Console**, cole o conteúdo completo do `schema.sql` do respectivo diretório da plataforma e execute (idêntico ao `schema.sql` na raiz do repositório)

Comandos equivalentes via CLI:

```bash
turso auth login
turso db create sms-gateway          # cria o banco
turso db show sms-gateway --url      # ver a URL
turso db tokens create sms-gateway   # criar o token
turso db shell sms-gateway < schema.sql   # criar as tabelas
```

**Variáveis de ambiente** (configure na área de configurações de cada plataforma, explicação completa no respectivo guia):

| Variável | Obrigatória | Descrição |
|---|---|---|
| `TURSO_DATABASE_URL` | sim | `libsql://sms-gateway-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | sim | token de acesso ao banco |
| `RECEIVE_TOKEN` | sim | segredo de autenticação de push (deve bater com o `token=` das URLs de ingestão) |
| `ENABLE_AUTH` | não | `"true"`: a página de administração exige login (**ative por segurança**, veja as notas abaixo); o padrão é sem login |
| `ADMIN_PASSWORD` | não | senha de login (defina quando `ENABLE_AUTH="true"`; se ausente, os endpoints de administração recusam acesso e alertam — configuração ausente nunca deixa passar) |
| `SESSION_SECRET` | obrigatória com login ativado | segredo de assinatura da sessão: valor aleatório de alta entropia (≥32 caracteres aleatórios, independente da senha de administração), cada plataforma recebe um valor próprio; se ausente, login e autenticação falham com segurança (login 500, endpoints de administração 401), sem fallback derivado da senha; após a rotação, todas as sessões antigas ficam inválidas (login novamente) |
| `RETENTION_DAYS` | não | dias de retenção de dados, padrão 30 |
| `WAIT_MAX_SECONDS` | não | suspensão do long polling (3–25, padrão 25); Netlify: `8`, Vercel Edge: `20` |
| Variáveis de canais de notificação | não | `FEISHU_WEBHOOK` (Feishu) / `WECOM_WEBHOOK` (WeCom) / `DINGTALK_WEBHOOK` (DingTalk, com `DINGTALK_SECRET` de assinatura opcional) / `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY` (com `BARK_URL` opcional) / `NTFY_URL` (com `NTFY_TOKEN` opcional) / `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO` (e-mail, com `MAIL_FROM` opcional) / `GENERIC_WEBHOOKS` (webhook genérico, com `GENERIC_WEBHOOK_TEMPLATE` de corpo / `GENERIC_WEBHOOK_HEADERS` de cabeçalhos opcionais). Configure apenas o que usar; sem configuração, nada é encaminhado; as notificações são renderizadas em três estados conforme o conteúdo (🔐 OTP / 💬 SMS / 🔔 notificação) |
| `SITE_NAME` / `SITE_ICON` | não | nome do site / URL do ícone, padrões se aplicam quando não definidos |
| `NOTIFY_LINK` | não | URL da home da página de administração; quando definida, cada canal de notificação recebe uma entrada "abrir página de administração" (botão/link/click), senão omitida automaticamente |
| `CRON_SECRET` (só Vercel) | não | coloque o mesmo valor de `RECEIVE_TOKEN`, para o Vercel Cron chamar /api/cron |
| `SQLITE_PATH` (só self-hosted em Node) | não | modo SQLite local: definida, elimina o banco externo (precisa de Node 22.13+, veja node/README.md) |

> **Recomendações de segurança**
> 1. **Ative o login administrativo** (`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`): a página de administração contém conteúdo sensível, como códigos OTP de SMS; sem login, qualquer pessoa que conheça o domínio pode ler todas as mensagens e excluir dados. O endpoint de login tem limite de taxa embutido (5 falhas consecutivas por IP → bloqueio de 10 minutos); `/api/receive`, `/api/push` têm também limite de 120 escritas por IP por minuto (429 além disso).
> 2. **Compensação do token de push na query da URL**: por compatibilidade com o SmsForwarder e clientes semelhantes, `/api/receive`, `/api/push` aceitam autenticação via `?token=` — o token aparece na URL e pode ir para os logs de acesso da plataforma e para o histórico do navegador. Quem não quiser isso usa POST + cabeçalho `Authorization: Bearer <RECEIVE_TOKEN>` (ambos os caminhos são suportados).

## Estrutura de diretórios

```
platforms/
├── cloudflare/ # 主版本：worker.js + schema.sql + wrangler.toml + README.md（自包含）
├── vercel/     # api/[[...route]].js + app.js + db.js + schema.sql + vercel.json + README.md
├── netlify/    # functions/{api,cron}.mjs + app.js + db.js + schema.sql + netlify.toml + README.md
├── deno/       # main.js + app.js + db.js + schema.sql + README.md
├── edgeone/    # functions/{[[default]].js,index.js} + app.js + db.js + schema.sql + README.md
├── node/       # server.mjs + app.js + db.js + schema.sql + Dockerfile + package.json + README.md
├── shared/     # app.js / db.js 唯一源（gen_app.py 由此同步到各平台目录）
└── gen_app.py  # 生成器：从 ../src/worker.js 生成 app.js 并同步全部平台（含 cloudflare 独立副本）
```

Cada diretório de plataforma pode ser usado isoladamente como raiz de implantação (com implantação por Git, basta apontar a Root Directory para o respectivo subdiretório),
zero dependências npm, sem build necessário. Depois de atualizar `src/worker.js`, execute `python platforms/gen_app.py` para sincronizar todas as plataformas de uma vez (o CI verifica desvio zero; `node tests/run.mjs` cobre 97 asserções funcionais).

## Migrar do Cloudflare Worker para outra plataforma

1. Prepare o banco Turso como acima e crie as tabelas
2. (Opcional) migre dados históricos: exporte os dados do D1 pelo dashboard do CF (arquivo SQLite) → importe com `turso db import` (veja a documentação oficial da CLI)
3. Implante seguindo o README da plataforma de destino e confirme que a página de administração e o /api/push funcionam
4. Atualize a domínio do webhook no cliente do celular e nos scripts de push para a nova plataforma
5. Após um ou dois dias sem anomalias, desative o Worker antigo

## Notas gerais

- Os caminhos da API são iguais em todas as plataformas: `/api/receive`, `/api/push`, `/api/messages` (suporta `device_id`/`source`/`range`/`q`/`limit`/`page`/`starred`/`unread`), `/api/messages/star`, `/api/messages/read`, `/api/messages/remove`, `/api/messages/restore`, `/api/messages/clear`, `/api/export` (CSV/JSON), `/api/sources`, `/api/stats`, `/api/phone` (consulta de região), `/api/devices`, `/api/devices/alias`, `/api/devices/merge`, `/api/wait`, `/api/login`, `/api/logout`, `/api/cron`; além de públicos `/manifest.webmanifest`, `/sw.js`
- `/api/cron` serve para agendadores externos dispararem a limpeza; autenticação: `?token=<RECEIVE_TOKEN>` ou `Authorization: Bearer <RECEIVE_TOKEN>`
- `/api/receive` e `/api/push` não são afetados pela alternância de login
