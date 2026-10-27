# Guia de implantação no Deno Deploy

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | **Português (BR)**

> Sincronizado do original em inglês (pt-BR)

Implantar o SMSToWeb no Deno Deploy (runtime Deno nativa + banco Turso). O mais próximo em semântica do Cloudflare Worker, 1 milhão de requisições por mês no plano gratuito, cerca de 15 minutos no total.

> Nota sobre a plataforma: o Deno Deploy migrou para uma nova geração de plataforma; o console é o [console.deno.com](https://console.deno.com) (o antigo dash.deno.com foi desativado), com um modo de build via Git semelhante a CI.

**Arquivos neste diretório**: `main.js` (entrada, com `Deno.serve` e o `Deno.cron` embutido para a limpeza agendada), `app.js` (aplicação central), `db.js` (adaptador Turso), `schema.sql` (criação das tabelas).

---

## Preparação

1. Uma conta GitHub
2. Uma conta Deno Deploy ([cadastro](https://console.deno.com), basta entrar com GitHub)

## Passo 1: preparar o repositório de código

1. Abra o repositório GitHub do projeto e clique em **Fork** no canto superior direito (ou use um repositório seu já enviado)

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
4. Inicialize o schema das tabelas: página de detalhes do banco → **Console** → cole o conteúdo completo do [`schema.sql`](../../../platforms/deno/schema.sql) deste diretório → execute → confirmação

> Alternativa com a CLI do Turso: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Passo 3: criar o app no Deno Deploy e vincular o repositório

1. Entre em [console.deno.com](https://console.deno.com) → clique **+ New App**
2. Escolha **implantar a partir de repositório GitHub**, autorize e selecione seu fork
3. Configuração de build:
   - **Diretório de trabalho da runtime**: `platforms/deno`
   - **Entrypoint** (arquivo de entrada): `main.js`
4. Adicione primeiro as variáveis de ambiente (veja o passo 4), depois dispare a primeira implantação
5. Depois de concluída, cada push no repositório GitHub dispara novo build automaticamente

## Passo 4: configurar variáveis de ambiente

No app, em **Settings → Environment Variables**, adicione uma a uma (também possível na página de configuração na criação do app):

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

Depois de salvar, aguarde a reimplantação automática.

## Passo 5: validar a implantação

1. Anote o domínio atribuído (formato `https://<nome-do-app>.<nome-da-org>.deno.net`)
2. Abra esse domínio no navegador — a página de administração deve aparecer (padrão "SMS-Gateway"; com login ativado, a página de login primeiro)
3. Teste o endpoint de push:

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Deno Deploy 部署成功\"}"
```

Se voltar `{"success":true,...}`, a conexão está pronta; a mensagem deve aparecer na página imediatamente.

## Passo 6: conectar dispositivos finais

Siga o [Guia de Implantação e Ingestão](../../../docs/多平台接入部署指南.md) para configurar o Android SmsForwarder e os pushes de notificação dos dispositivos; como domínio, use seu `xxx.deno.net`.

Domínio próprio: na aba **Domains** da organização, adicione o domínio e atribua-o ao app; siga as instruções para criar no DNS o CNAME (ou registro A) e o registro de verificação — o certificado HTTPS é emitido automaticamente.

## Notas e perguntas frequentes

- **Limpeza agendada**: o `Deno.cron` é registrado automaticamente na implantação (diariamente às 17:00 UTC = 01:00 horário de Pequim) — sem configuração extra, e não dá para disparar manualmente para teste; para verificar, veja se os dados no Turso diminuem no prazo
- **Cota gratuito**: 1 milhão de requisições por mês, Active CPU 10 horas, 20GiB de tráfego de saída — de sobra para uso pessoal
- **Long polling**: o Deno Deploy não tem limite rígido de duração de requisição; o long polling de 25 segundos de `/api/wait` funciona bem; instâncias em espera podem ser recicladas e reiniciadas pela plataforma (long pollings abortados são repetidos automaticamente pelo front-end) — tempo real praticamente idêntico à versão Worker
- **Depurar implantação que falhou**: o entrypoint deve ser `main.js`, o diretório da runtime deve ser `platforms/deno`; sem as variáveis `TURSO_*` há 500 com "config error"
- **Atualizar código**: push no repositório GitHub dispara nova implantação automaticamente
