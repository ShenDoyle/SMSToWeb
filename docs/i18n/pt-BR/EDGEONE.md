# Guia de implantação no Tencent EdgeOne Makers

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | **Português (BR)**

> Sincronizado do original em inglês (pt-BR)

Implantar o SMSToWeb no Tencent EdgeOne Makers (antigo EdgeOne Pages; Functions + banco Turso). Boa experiência de acesso a partir da China, cerca de 15 minutos no total.

**Arquivos neste diretório**: `functions/index.js` (entrada só para o caminho raiz `/`, fonte única de toda a lógica e da whitelist ENV_KEYS), `functions/[[default]].js` (intercepta todas as demais rotas e só reexporta o index.js — sem manutenção separada), `app.js` (aplicação central), `db.js` (adaptador Turso), `schema.sql` (criação das tabelas).

---

## Preparação

1. Uma conta Tencent Cloud ([cadastro](https://cloud.tencent.com), exige verificação de identidade)
2. Uma conta GitHub (o EdgeOne Makers suporta implantação a partir de repositórios Git)

## Passo 1: preparar o repositório de código

Abra o repositório GitHub do projeto e clique em **Fork** no canto superior direito (ou use um repositório seu já enviado).

## Passo 2: criar o banco de dados Turso

O Turso oferece bancos compatíveis com SQLite (cota gratuito: 100 bancos, 5GB de armazenamento, 500 milhões de leituras de linha por mês). Nas EdgeOne Functions, o acesso a bancos externos não sofre restrição.

1. Abra [turso.tech](https://turso.tech), clique **Start for free now** e entre com GitHub
2. No console → **Create Database**:
   - Nome: `sms-gateway`
   - Location: recomenda-se Singapore / Hong Kong (baixa latência a partir da China)
   - Type: Free
3. Depois da criação, entre na página de detalhes do banco:
   - Anote a **Database URL** (formato `libsql://sms-gateway-xxxx.turso.io`)
   - Em **Create Token**, crie um token de acesso e **copie e guarde imediatamente** (visível apenas uma vez)
4. Inicialize o schema das tabelas: página de detalhes do banco → **Console** → cole o conteúdo completo do [`schema.sql`](../../../platforms/edgeone/schema.sql) deste diretório → execute → confirmação

> Alternativa com a CLI do Turso: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Passo 3: criar o projeto no EdgeOne Makers

1. Entre no console da Tencent Cloud → procure **EdgeOne Makers** (antigo "EdgeOne Pages", ou direto [console.cloud.tencent.com/edgeone/pages](https://console.cloud.tencent.com/edgeone/pages))
2. Clique **Criar projeto** → escolha **importar de repositório Git** → autorize o GitHub e selecione seu fork
3. Configuração de build:
   - **Diretório raiz**: `platforms/edgeone`
   - Preset de framework: escolha "Sem framework / Other" ou deixe vazio (Functions puras não precisam de build)
4. Na área de variáveis de ambiente, adicione primeiro as variáveis (veja o passo 4), depois inicie a implantação
5. Aguarde a conclusão (~1 minuto) e anote o domínio padrão atribuído (ex.: `*.edgeone.app`)

## Passo 4: configurar variáveis de ambiente

No projeto, em **Configurações → Variáveis de ambiente**, adicione uma a uma (as Functions leem pelo parâmetro `env` do `onRequest`):

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

Depois de salvar, reimplante para que as mudanças valham.

## Passo 5: validar a implantação

1. Abra o domínio atribuído no navegador — a página de administração deve aparecer (padrão "SMS-Gateway"; com login ativado, a página de login primeiro)
2. Teste o endpoint de push:

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"EdgeOne 部署成功\"}"
```

Se voltar `{"success":true,...}`, a conexão está pronta; a mensagem deve aparecer na página imediatamente.

## Passo 6: vincular domínio próprio (recomendado para acesso da China)

1. Projeto → **Configurações → Domínios personalizados** → adicione seu domínio (ex.: `sms.seuDominio.com`)
2. Siga as instruções para criar no DNS do seu domínio um registro CNAME para o endereço atribuído pelo EdgeOne
3. O domínio já deve ter registro ICP (exigência dos nós da China da Tencent Cloud); sem registro, a resolução é negada

## Passo 7: configurar a limpeza agendada (cron externo)

O EdgeOne Makers atualmente não tem tarefas cron nativas; use qualquer serviço externo de cron gratuito para chamar o endpoint de limpeza uma vez por dia:

1. Abra [cron-job.org](https://cron-job.org), registre-se e clique **Create cronjob**:
   - URL: `https://<seuDomínio>/api/cron?token=<seuRECEIVE_TOKEN>`
   - Schedule: diário (ex.: 01:00 horário de Pequim, correspondente a 17:00 UTC)
2. Salve e ative. Na hora, o gateway exclui automaticamente os dados com mais de `RETENTION_DAYS` dias

## Conectar dispositivos finais

Siga o [Guia de Implantação e Ingestão](../../../docs/多平台接入部署指南.md) para configurar o Android SmsForwarder e os pushes de notificação dos dispositivos; como domínio da API, use seu domínio do EdgeOne.

## Notas e perguntas frequentes

- **404 no caminho raiz (importante, testado em 2026-10)**: nas regras de roteamento de Functions do EdgeOne Makers, o `[[default]].js` intercepta só caminhos não raiz, como `/foo`, `/api/xxx`; **o caminho raiz `/` reconhece exclusivamente o `functions/index.js`** — sem esse arquivo, a página inicial cai direto na página 404 da plataforma (os endpoints da API continuam funcionando). Este diretório entrega o `functions/index.js` (fonte única da lógica e da whitelist ENV_KEYS; o `[[default]].js` só o reexporta, sem manutenção duplicada)
- **Long polling**: o limite de execução das Functions é apertado; o `/api/wait` (25 segundos de suspensão) pode ser abortado antes — o front-end repete automaticamente, sem perda de funcionalidade
- **Depurar implantação que falhou**: o diretório raiz deve ser `platforms/edgeone`; sem as variáveis `TURSO_*` há 500 com "config error"
- **Atualizar código**: push no repositório GitHub dispara nova implantação automaticamente
