# Guia de implantação no Vercel

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | **Português (BR)**

> Sincronizado do original em inglês (pt-BR)

Implantar o SMSToWeb no Vercel (Edge Function + banco Turso). O plano gratuito atende uso pessoal, cerca de 15 minutos no total.

**Arquivos neste diretório**: `api/[[...route]].js` (entrada), `app.js` (aplicação central), `db.js` (adaptador Turso), `schema.sql` (criação das tabelas), `vercel.json` (inclui a configuração de cron).

---

## Implantação em um clique (recomendado)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb%2Ftree%2Fmain%2Fplatforms%2Fvercel&env=RECEIVE_TOKEN%2CTURSO_DATABASE_URL%2CTURSO_AUTH_TOKEN&project-name=sms-gateway&envDescription=%E6%8E%A8%E9%80%81%E9%89%B4%E6%9D%83%E5%AF%86%E9%92%A5%E4%B8%8E%20Turso%20%E6%95%B0%E6%8D%AE%E5%BA%93%E8%BF%9E%E6%8E%A5%E4%BF%A1%E6%81%AF&envLink=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb)

Sugestão: **termine primeiro o passo 2 abaixo (criar o banco Turso) para obter as informações de conexão**, depois clique no botão: o Vercel clona o subdiretório da plataforma como seu repositório e cria o projeto; no prompt, preencha `RECEIVE_TOKEN` (segredo de autenticação de push, string aleatória longa própria) e a URL / token do Turso e implante. Depois da implantação, **execute obrigatoriamente uma vez o SQL do passo 3 de criação das tabelas** (o Vercel não cria tabelas), senão a página não mostra dados.

---

## Preparação

1. Uma conta GitHub (o Vercel implanta a partir de repositórios do GitHub)
2. Uma conta Vercel ([cadastro](https://vercel.com/signup), basta entrar com GitHub)

## Passo 1: preparar o repositório de código

1. Abra o repositório GitHub do projeto e clique em **Fork** no canto superior direito (ou use um repositório seu já enviado)
2. Depois do fork, você terá uma cópia editável do projeto

## Passo 2: criar o banco de dados Turso

O Turso oferece bancos compatíveis com SQLite (cota gratuito: 100 bancos, 5GB de armazenamento, 500 milhões de leituras de linha por mês).

1. Abra [turso.tech](https://turso.tech), clique **Start for free now** e entre com GitHub
2. No console → **Create Database**:
   - Nome: `sms-gateway`
   - Location: uma região próxima (ex.: Singapore / Hong Kong)
   - Type: Free
3. Depois da criação, entre na página de detalhes do banco:
   - Anote a **Database URL** (formato `libsql://sms-gateway-xxxx.turso.io`)
   - Em **Create Token** (ou Turso Platform Tokens), crie um token de acesso e **copie e guarde imediatamente** (visível apenas uma vez)
4. Inicialize o schema das tabelas: página de detalhes do banco → **Console** (console SQL no web) → cole o conteúdo completo do [`schema.sql`](../../../platforms/vercel/schema.sql) deste diretório → execute → confirmação (as tabelas `messages` e `devices` serão criadas)

> Alternativa com a CLI do Turso: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Passo 3: importar o repositório no Vercel

1. Entre em [vercel.com](https://vercel.com) → **Add New → Project**
2. Em **Import Git Repository**, localize seu repositório do fork e clique **Import**
3. Na página de configuração, expanda **Root Directory** e escolha `platforms/vercel`
   —— O Vercel reconhece automaticamente o `vercel.json` e o diretório `api/` dentro dele, sem mais configuração
4. Ainda não clique Deploy: faça primeiro o passo 4 (variáveis de ambiente) na área **Environment Variables** da mesma página

## Passo 4: configurar variáveis de ambiente

Na página de configuração da implantação, em **Environment Variables**, adicione uma a uma (depois também em Project → Settings):

| Nome | Valor | Descrição |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | a URL anotada no passo 2 |
| `TURSO_AUTH_TOKEN` | (token do passo 2) | o visível apenas uma vez |
| `RECEIVE_TOKEN` | string aleatória longa própria | autenticação de push, não use valor de exemplo |
| `ENABLE_AUTH` | `false` | para login, coloque `true` |
| `ADMIN_PASSWORD` | senha própria | necessário apenas com `ENABLE_AUTH="true"` |
| `SESSION_SECRET` | valor aleatório de alta entropia (≥32 caracteres) | necessário apenas com `ENABLE_AUTH="true"`; independente da senha, um valor por plataforma; se ausente, login/autenticação falham com segurança; após rotação, todas as sessões antigas ficam inválidas |
| `RETENTION_DAYS` | `30` | dias de retenção de dados |
| `CRON_SECRET` | **o mesmo valor de RECEIVE_TOKEN** | ao chamar /api/cron, o Vercel Cron envia automaticamente `Bearer $CRON_SECRET` |
| `FEISHU_WEBHOOK` (`FEISHU_SECRET` opcional) | (opcional) webhook do bot de grupo do Feishu | novas mensagens vão automaticamente para o grupo do Feishu; com "verificação de assinatura" do bot, use também `FEISHU_SECRET` |
| `WECOM_WEBHOOK` | (opcional) webhook do bot de grupo do WeCom | novas mensagens vão automaticamente para o grupo do WeCom |
| `DINGTALK_WEBHOOK` | (opcional) webhook do bot de grupo do DingTalk | com "assinatura" como segurança, use também `DINGTALK_SECRET` |
| `SERVERCHAN_SENDKEY` | (opcional) SendKey do ServerChan | push no WeChat |
| `PUSHPLUS_TOKEN` | (opcional) token do PushPlus | push no WeChat |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | (opcional) bot do Telegram | só fica ativo com os dois configurados |
| `BARK_DEVICE_KEY` | (opcional) chave do dispositivo Bark | com servidor próprio, use também `BARK_URL`; o padrão é a oficial |
| `NTFY_URL` (`NTFY_TOKEN` opcional) | (opcional) URL do tópico ntfy | URL completa, ex.: `https://ntfy.sh/my-sms`; tópicos protegidos usam também `NTFY_TOKEN` (token ou user:password) |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | (opcional) Gotify | endereço do servidor + token de aplicativo |
| `RESEND_API_KEY` + `MAIL_TO` | (opcional) e-mail (Resend) | `MAIL_FROM` opcional, padrão `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS` (`GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS` opcionais) | (opcional) webhook genérico | várias URLs separadas por vírgula; template opcional para corpo próprio, `GENERIC_WEBHOOK_HEADERS` (string JSON) para cabeçalhos próprios |
| `SITE_NAME` / `SITE_ICON` | (opcional) | nome do site / URL do ícone |
| `NOTIFY_LINK` | (opcional) | URL da home da página de administração; quando definida, cada canal recebe uma entrada "abrir página de administração", senão omitida automaticamente |

Depois de preencher, clique **Deploy** e aguarde a implantação (~1 minuto).

## Passo 5: validar a implantação

1. Na página final, clique **Continue to Dashboard** e anote o domínio atribuído (formato `https://xxx.vercel.app`)
2. Abra esse domínio no navegador — a página de administração deve aparecer (padrão "SMS-Gateway"; com login ativado, a página de login primeiro)
3. Teste o endpoint de push (`<domínio>` e `<segredo>` pelos seus valores):

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Vercel 部署成功\"}"
```

Se voltar `{"success":true,...}`, a conexão está pronta; a mensagem deve aparecer na página imediatamente.

## Passo 6: conectar dispositivos finais

Siga o [Guia de Implantação e Ingestão](../../../docs/多平台接入部署指南.md) para configurar o Android SmsForwarder (SMS via `/api/receive`) e os pushes de notificação dos dispositivos (via `/api/push`); como domínio, use seu `xxx.vercel.app` (ou um domínio próprio vinculado).

Domínio próprio: Project → **Settings → Domains** → Add, e siga as instruções para criar o registro CNAME no DNS do seu domínio — o valor de destino é o mostrado na página de Domains (o Vercel atribui a cada projeto um endereço próprio `xxxxxx.vercel-dns.com`).

## Notas e perguntas frequentes

- **Limpeza agendada**: o `vercel.json` chama `/api/cron` diariamente às 17:00 UTC (01:00 horário de Pequim) para excluir dados expirados. O Vercel Cron envia automaticamente `Authorization: Bearer $CRON_SECRET`, então o `CRON_SECRET` deve bater com o `RECEIVE_TOKEN`
- **Limites do plano Hobby (gratuito)**: cron só uma vez por dia (este projeto roda exatamente uma vez ao dia — combina; o horário real de disparo pode variar dentro da hora configurada, é normal); funções Edge devem **começar a responder em 25 segundos** (depois, até 300 segundos de streaming são possíveis); o long polling `/api/wait` da página de administração fica suspenso exatamente 25 segundos — bem no limite. Se abortar antes, o loop de polling do front-end repete automaticamente, **sem perda de funcionalidade**; o aviso de nova mensagem chega só um pouco mais tarde
- **Edge Runtime**: a entrada declara `runtime = "edge"` — início a frio rápido, execução em nós de edge globais
- **Depurar implantação que falhou**: geralmente é variável de ambiente faltando — sem `TURSO_*` há 500 com "config error"; confirme se a Root Directory está correta em `platforms/vercel`
- **Atualizar código**: dê push no seu fork, e o Vercel implanta automaticamente de novo
