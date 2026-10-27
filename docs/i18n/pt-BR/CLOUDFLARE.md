# Guia de implantação no Cloudflare (versão principal, tudo no navegador)

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | **Português (BR)**

> Sincronizado do original em inglês (pt-BR)

Esta é a versão principal do projeto: SMS/notificações do celular → Cloudflare Worker → banco D1 → página web de administração.
Sem servidor, cota gratuito generoso, tudo feito com o mouse no navegador — sem instalar nenhuma ferramenta.

Este diretório é **totalmente autônomo**: [`worker.js`](../../../platforms/cloudflare/worker.js) (código-fonte de implantação) + [`schema.sql`](../../../platforms/cloudflare/schema.sql) (script de criação das tabelas) + [`wrangler.toml`](../../../platforms/cloudflare/wrangler.toml) (configuração opcional para implantação via CLI), sem depender de outros arquivos do repositório. Para as demais plataformas, veja a [visão geral de plataformas](../../../platforms/README.md).

---

## Implantação em um clique (recomendado para iniciantes)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

Ao clicar no botão acima, o Cloudflare faz automaticamente: clonar o código para o seu GitHub → **criar o banco D1 e executar as tabelas automaticamente** → vincular recursos → configurar CI (cada push futuro no seu repositório implanta de novo automaticamente) → colocar no ar. No caminho, dois segredos são pedidos:

- `RECEIVE_TOKEN`: segredo de autenticação de push, string aleatória própria suficientemente longa (o `token=` nas URLs de ingestão dos dispositivos deve bater com ele)
- `ADMIN_PASSWORD`: senha de login da página de administração (**fortemente recomendado definir** — a página de administração contém conteúdo sensível, como códigos OTP de SMS; com `ENABLE_AUTH="true"` sem configuração, todos os endpoints de administração recusam acesso, não existe passagem sem login)
- `SESSION_SECRET`: segredo de assinatura da sessão, **obrigatório com login ativado** — valor aleatório de alta entropia (≥32 caracteres aleatórios, ex.: gerado com `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`), totalmente independente da senha; se ausente, login e autenticação falham com segurança (login 500, endpoints de administração 401), sem fallback derivado da senha; após rotação, todas as sessões antigas ficam imediatamente inválidas

> Vínculo de domínio próprio (ex.: `sms.example.com`): depois da implantação, Worker → Settings → Domains & Routes → Add Custom Domain.
> O guia manual abaixo fica para quem não usar o caminho de um clique ou quiser acompanhar cada passo.

## Preparação

1. Uma conta Cloudflare ([cadastro](https://dash.cloudflare.com/sign-up), gratuito, basta e-mail)
2. O código do projeto (a [`worker.js`](../../../platforms/cloudflare/worker.js) deste diretório é o código completo a colar)

## Passo 1: criar o banco de dados D1

1. Entre em [dash.cloudflare.com](https://dash.cloudflare.com)
2. No menu à esquerda **Storage & Databases → D1 SQL Database**
3. Clique em **Create Database**, nome `sms-gateway-db` (restante padrão), Create
4. Abra o banco recém-criado → aba **Console**
5. Copie o conteúdo completo do [`schema.sql`](../../../platforms/cloudflare/schema.sql) deste diretório para o campo e clique em **Execute**
6. Aguarde a confirmação (as tabelas `messages` e `devices` serão criadas)

## Passo 2: criar o Worker e colar o código

1. No menu à esquerda **Compute (Workers) → Workers & Pages**
2. Clique em **Create application**, escolha **Start with Hello World!**, nome `sms-gateway`, clique **Deploy** (basta o deploy inicial com o código padrão)
3. Clique **Edit code** e apague todo o código padrão do editor
4. Abra a [`worker.js`](../../../platforms/cloudflare/worker.js) deste diretório, selecione tudo, copie e cole no editor
5. Clique **Deploy** no canto superior direito e aguarde a confirmação

## Passo 3: vincular o banco D1

1. Volte à página de visão geral do Worker → aba **Bindings**
2. Clique **Add → D1 database**
3. Nome da variável `DB` (exatamente assim, maiúsculo), escolha o `sms-gateway-db` criado
4. Clique **Deploy/Save**

## Passo 4: definir variáveis e segredos

No mesmo lugar, em **Settings → Variables and Secrets**, adicione um a um:

1. **Add variable** (tipo "Text"):
   - Nome `RETENTION_DAYS`, valor `30` (para 90 dias de retenção, coloque `90`)
   - Nome `ENABLE_AUTH`, valor `false` (**por segurança, recomenda-se fortemente `true` e ativar o login**: a página de administração contém conteúdo sensível, como códigos OTP de SMS; sem login fica aberta para quem conhecer o domínio. Com implantação automática via Workers Builds do repositório, vale o valor da `wrangler.toml` do repositório — que já vem `true` por padrão)
   - Nome `SITE_NAME` (opcional), valor do nome do site próprio, ex.: `我的短信站`
   - Nome `SITE_ICON` (opcional), valor da URL do ícone (começando com `http(s)://`); sem valor ou URL inválida, o ícone embutido é usado automaticamente
   - Nome `NOTIFY_LINK` (opcional), valor da URL da home da página de administração (começando com `http(s)://`); quando definida, cada canal de notificação recebe uma entrada "abrir página de administração"
2. **Add secret** (tipo "Secret"):
   - Nome `RECEIVE_TOKEN`, valor de string aleatória própria suficientemente longa (não use valor de exemplo de guia; quanto mais longo, melhor)
   - Nome `ADMIN_PASSWORD`, valor da sua senha de login da administração (necessário apenas com `ENABLE_AUTH="true"`)
   - Nome `SESSION_SECRET`, valor aleatório de alta entropia (≥32 caracteres aleatórios, independente da senha; necessário apenas com `ENABLE_AUTH="true"`)
3. Depois de cada adição, clique **Deploy/Save**

> Mudanças nesses valores valem na hora, sem colar o código de novo. Após alterar `RECEIVE_TOKEN`, lembre de atualizar o `token=` nas URLs dos dispositivos.

## Passo 5 (opcional): configurar canais de encaminhamento de notificações

Depois de armazenar novas mensagens, elas podem ser encaminhadas automaticamente para canais externos; **encaminha-se exatamente o canal cuja variável foi configurada — sem configuração, não há encaminhamento**.
Na mesma página "Variables and Secrets", adicione as variáveis correspondentes:

| Canal | Variável | Descrição |
|---|---|---|
| Bot de grupo do Feishu | `FEISHU_WEBHOOK` (`FEISHU_SECRET` opcional) | endereço do webhook do bot de grupo; com "verificação de assinatura" como segurança, use também `FEISHU_SECRET` |
| Bot de grupo do WeCom | `WECOM_WEBHOOK` | endereço do webhook do bot de grupo |
| Bot de grupo do DingTalk | `DINGTALK_WEBHOOK` (`DINGTALK_SECRET` opcional) | com "assinatura" como segurança, `DINGTALK_SECRET` é obrigatório |
| ServerChan | `SERVERCHAN_SENDKEY` | SendKey (push no WeChat) |
| PushPlus | `PUSHPLUS_TOKEN` | token (push no WeChat) |
| Bot do Telegram | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | token do bot + ID de chat/grupo |
| Bark | `BARK_DEVICE_KEY` (`BARK_URL` opcional) | com servidor próprio, defina `BARK_URL`; o padrão é a oficial |
| ntfy | `NTFY_URL` (`NTFY_TOKEN` opcional) | URL completa do tópico, ex.: `https://ntfy.sh/my-sms`; tópicos protegidos usam também `NTFY_TOKEN` (token ou user:password) |
| Gotify | `GOTIFY_URL` + `GOTIFY_TOKEN` | endereço do servidor (sem `/message`) + token de aplicativo |
| E-mail (Resend) | `RESEND_API_KEY` + `MAIL_TO` (`MAIL_FROM` opcional) | `MAIL_FROM` padrão é `onboarding@resend.dev` |
| Webhook genérico | `GENERIC_WEBHOOKS` (`GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS` opcionais) | várias URLs separadas por vírgula; template para corpo próprio, cabeçalhos em JSON — por esse caminho entram APIs de terceiros (gateways de SMS etc.) |

Cadastro e obtenção por canal e o formato do corpo: veja o [Guia de Implantação e Ingestão · Canais de encaminhamento](../../../docs/多平台接入部署指南.md).
Vários canais rodam em paralelo; falha em um canal não afeta os outros nem o armazenamento; duplicatas (`duplicated`) não são encaminhadas de novo.
As notificações são renderizadas automaticamente em três estados conforme o conteúdo (🔐 lembrete de OTP / 💬 novo SMS / 🔔 notificação de dispositivo): o código OTP vai automaticamente para o título e dispara os extras da plataforma (a notificação do Bark copia o código com um toque, Bark/ntfy ganham prioridade elevada, cabeçalho de cartão violeta no Feishu etc.).

## Passo 6: configurar a limpeza agendada

1. Worker → **Settings → Triggers → Cron Triggers**
2. Clique **Add Cron Trigger**, coloque `0 17 * * *`, salve
3. Significado: diariamente às 17:00 UTC (01:00 horário de Pequim), os dados além do período de retenção são excluídos automaticamente

## Passo 7: vincular domínio (opcional, recomendado)

1. Worker → **Settings → Domains & Routes**
2. Clique **Add → Custom Domain**, coloque um subdomínio (ex.: `sms.seuDominio.com`)
3. O Cloudflare cria o registro DNS automaticamente e emite o certificado HTTPS; ativo em alguns minutos
4. Depois, `https://sms.seuDominio.com` no navegador é direto a página de administração

> Sem domínio próprio, basta o endereço padrão `https://sms-gateway.<seu-subdomínio>.workers.dev`.

## Passo 8: validar a implantação

Abrindo a página de administração no navegador, a página deve aparecer com seu nome de site (padrão "SMS-Gateway", alterável via `SITE_NAME`; com login ativado, aparece primeiro a página de login). Depois, teste o endpoint de entrada (`<domínio>` e `<segredo>` pelos seus valores):

```
curl "https://<域名>/api/receive?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"name\":\"test\",\"sim\":\"13800138000\",\"from\":\"10086\",\"content\":\"部署测试\"}"
```

Se voltar `{"success":true,...}`, a conexão está pronta. Esse SMS de teste pode ser excluído na página web.

## Conectar dispositivos finais

Siga o [Guia de Implantação e Ingestão](../../../docs/多平台接入部署指南.md) para configurar o Android SmsForwarder e os pushes de notificação dos dispositivos; como domínio da API, use o endereço do seu Worker.

## Implantação via CLI (caminho alternativo, para quem instala o wrangler)

Neste diretório (contém `wrangler.toml`, `main` já aponta para a `worker.js` daqui), execute:

```bash
npm install wrangler        # 官方推荐项目内安装；全局 npm install -g wrangler 亦可
npx wrangler login
npx wrangler d1 execute sms-gateway-db --file=schema.sql --remote
npx wrangler secret put RECEIVE_TOKEN
npx wrangler secret put ADMIN_PASSWORD   # 仅开登录时需要
npx wrangler secret put SESSION_SECRET   # 仅开登录时需要（高熵随机值，与密码独立）
npx wrangler deploy
```

## Notas e perguntas frequentes

- **Os SMS encaminhados não chegam**: verifique em ordem ① a chave principal "encaminhar broadcast de SMS" nas configurações gerais do SmsForwarder (o mais fácil de esquecer; desligada, as mensagens são descartadas silenciosamente enquanto o teste do canal fica verde) → ② o token/URL da regra de encaminhamento bate com o secret do Worker → ③ nos logs ao vivo do Worker, veja se as requisições chegam
- **O canal de notificação não recebeu nada**: confira se as variáveis do canal estão definidas e corretas; procure nos logs ao vivo do Worker por `notify forward failed:`; mensagens com `duplicated:true` não são encaminhadas
- **Cota gratuito do Worker**: 100.000 requisições por dia — de sobra para uso pessoal; cota gratuito do D1: 5 milhões de leituras de linha por dia
- **Long polling**: a página de administração fica até 25 segundos suspensa em `/api/wait` esperando novas mensagens; Workers não têm problema de duração de requisição, a melhor em tempo real
- **Migração de dados**: ao voltar de outras plataformas para o CF, exporte os dados do Turso e importe no D1 (schema de tabelas totalmente idêntico)
