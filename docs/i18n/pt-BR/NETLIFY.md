# Guia de implantação no Netlify

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | **Português (BR)**

> Sincronizado do original em inglês (pt-BR)

Implantar o SMSToWeb no Netlify (Functions v2 + banco Turso). Cerca de 15 minutos no total.

**Arquivos neste diretório**: `functions/api.mjs` (entrada, intercepta todas as rotas com `path: "/*"`), `functions/cron.mjs` (scheduled function da limpeza agendada), `app.js` (aplicação central), `db.js` (adaptador Turso), `schema.sql` (criação das tabelas), `netlify.toml` (configuração do site).

---

## Implantação em um clique (recomendado)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/ShenDoyle/SMSToWeb)

O botão clona o repositório para o seu GitHub e abre o assistente de configuração; atenção a dois pontos:

1. **Nas configurações de build, coloque `platforms/netlify` como Base directory** (o `netlify.toml` desta plataforma fica nesse subdiretório; com a entrada correta, os comandos de build etc. ficam automáticos); o restante deixe como está
2. Sugestão: termine primeiro o passo 2 abaixo (criar o banco Turso) para obter as informações de conexão; depois da criação, em **Site configuration → Environment variables**, coloque `RECEIVE_TOKEN` / `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` e reimplante; por fim, execute o SQL do passo 3 de criação das tabelas (o Netlify não cria tabelas)

---

## Preparação

1. Uma conta GitHub
2. Uma conta Netlify ([cadastro](https://app.netlify.com/signup), basta entrar com GitHub)

## Passo 1: preparar o repositório de código

Abra o repositório GitHub do projeto e clique em **Fork** no canto superior direito (ou use um repositório seu já enviado).

## Passo 2: criar o banco de dados Turso

O Turso oferece bancos compatíveis com SQLite (cota gratuito: 100 bancos, 5GB de armazenamento, 500 milhões de leituras de linha por mês).

1. Abra [turso.tech](https://turso.tech), clique **Start for free now** e entre com GitHub
2. No console → **Create Database**:
   - Nome: `sms-gateway`
   - Location: uma região próxima (ex.: Singapore / Hong Kong)
   - Type: Free
3. Depois da criação, entre na página de detalhes do banco:
   - Anote a **Database URL** (formato `libsql://sms-gateway-xxxx.turso.io`)
   - Em **Create Token**, crie um token de acesso e **copie e guarde imediatamente** (visível apenas uma vez)
4. Inicialize o schema das tabelas: página de detalhes do banco → **Console** → cole o conteúdo completo do [`schema.sql`](../../../platforms/netlify/schema.sql) deste diretório → execute → confirmação

> Alternativa com a CLI do Turso: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Passo 3: importar o repositório no Netlify

1. Entre em [app.netlify.com](https://app.netlify.com) → **Add new project → Import an existing project**
2. Escolha **Deploy with GitHub**, autorize e selecione seu fork na lista
3. Na página de configuração da implantação (Site settings for…):
   - **Base directory**: coloque `platforms/netlify`
   - Build command / Publish directory: deixe o padrão (o `netlify.toml` fica no diretório e vale automaticamente)
4. Abaixo, expanda **Show advanced → New variable** e adicione primeiro as variáveis de ambiente (veja o passo 4), depois clique **Deploy**

## Passo 4: configurar variáveis de ambiente

Nas opções avançadas da página de configuração da implantação (depois também em **Project configuration → Environment variables**):

| Nome | Valor | Descrição |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | a URL anotada no passo 2 |
| `TURSO_AUTH_TOKEN` | (token do passo 2) | o visível apenas uma vez |
| `RECEIVE_TOKEN` | string aleatória longa própria | autenticação de push, não use valor de exemplo |
| `ENABLE_AUTH` | `false` | para login, coloque `true` |
| `ADMIN_PASSWORD` | senha própria | necessário apenas com `ENABLE_AUTH="true"` |
| `SESSION_SECRET` | valor aleatório de alta entropia (≥32 caracteres) | necessário apenas com `ENABLE_AUTH="true"`; independente da senha, um valor por plataforma; se ausente, login/autenticação falham com segurança; após rotação, todas as sessões antigas ficam inválidas |
| `RETENTION_DAYS` | `30` | dias de retenção de dados |
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

Clique **Deploy** e aguarde a implantação (~1 minuto).

## Passo 5: validar a implantação

1. Depois da implantação, anote o domínio do site (formato `https://xxx.netlify.app`)
2. Abra esse domínio no navegador — a página de administração deve aparecer (padrão "SMS-Gateway"; com login ativado, a página de login primeiro)
3. Teste o endpoint de push:

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Netlify 部署成功\"}"
```

Se voltar `{"success":true,...}`, a conexão está pronta; a mensagem deve aparecer na página imediatamente.

## Passo 6: conectar dispositivos finais

Siga o [Guia de Implantação e Ingestão](../../../docs/多平台接入部署指南.md) para configurar o Android SmsForwarder e os pushes de notificação dos dispositivos; como domínio, use seu `xxx.netlify.app`.

Domínio próprio: **Project configuration → Change site name** (mudar o subdomínio) ou **Domain management → Add a domain** (domínio próprio, DNS conforme as instruções).

## Notas e perguntas frequentes

- **Limpeza agendada**: o `functions/cron.mjs` é uma Netlify Scheduled Function registrada automaticamente na implantação (diariamente às 17:00 UTC = 01:00 horário de Pequim) — sem configuração extra. Confirmação: na página **Functions** do site, veja a função `cron` e o status do seu cronograma
- **Duração da função e tempo real**: o limite de execução atual é de 60 segundos (igual em todos os planos); o long polling `/api/wait` da página de administração (25 segundos de suspensão) consegue esperar por inteiro — bom tempo real. Para exigências extremas de tempo real, Cloudflare / self-hosted continuam sendo a primeira escolha
- **Cota gratuito**: contas novas a partir de 2025-09 são cobradas por credits (plano Free: 300 credits por mês; o consumo de funções conta como GB-horas) — suficiente para tráfego pessoal pequeno; contas existentes podem permanecer no plano antigo
- **Depurar implantação que falhou**: a Base directory deve ser `platforms/netlify`; sem as variáveis `TURSO_*` há 500 com "config error"; detalhes em **Functions → api → Logs** do site
- **Atualizar código**: push no repositório GitHub dispara nova implantação automaticamente
