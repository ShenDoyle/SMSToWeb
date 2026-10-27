# Guia de implantação self-hosted (Fly.io / Railway / VPS / local)

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | **Português (BR)**

> Sincronizado do original em inglês (pt-BR)

Hospedar o SMSToWeb por conta própria como contêiner Docker. Processo permanente, sem limite de duração de função, o melhor tempo real do long polling — indicado para quem já tem servidor ou quer usar Fly.io / Railway (cotas gratuitas, veja "notas da plataforma" abaixo).

**Arquivos neste diretório**: `server.mjs` (entrada, roda a partir do Node 18+, sem dependências, com limpeza diária embutida), `app.js` (aplicação central), `db.js` (adaptador duplo de Turso / SQLite local), `schema.sql` (criação das tabelas), `Dockerfile`, `package.json`.

---

## Preparação

- Conta Fly.io ou Railway (ou qualquer VPS com Docker)
- Como banco, continua o Turso (compatível com SQLite); a preparação comum fica no passo 1

## Passo 1: criar o banco de dados Turso

1. Abra [turso.tech](https://turso.tech), clique **Start for free now** e entre com GitHub
2. No console → **Create Database**:
   - Nome: `sms-gateway`
   - Location: uma região próxima do servidor
   - Type: Free
3. Depois da criação, entre na página de detalhes do banco:
   - Anote a **Database URL** (formato `libsql://sms-gateway-xxxx.turso.io`)
   - Em **Create Token**, crie um token de acesso e **copie e guarde imediatamente** (visível apenas uma vez)
4. Inicialize o schema das tabelas: página de detalhes do banco → **Console** → cole o conteúdo completo do [`schema.sql`](../../../platforms/node/schema.sql) deste diretório → execute → confirmação

> Alternativa com CLI: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Variante A: Fly.io

1. Instale o flyctl localmente ([guia oficial de instalação](https://fly.io/docs/flyctl/install/)) e depois `fly auth login`
2. Neste diretório, execute:

```bash
cd platforms/node
fly launch                 # 按提示创建应用：区域自选；询问数据库时选 No（我们用 Turso）
fly secrets set TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io TURSO_AUTH_TOKEN=<你的令牌> RECEIVE_TOKEN=<你的密钥>
fly secrets set ENABLE_AUTH=true ADMIN_PASSWORD=<你的密码>     # 可选
fly deploy
fly status                 # 记下分配的域名 https://<app>.fly.dev
```

3. Validação: abra `https://<app>.fly.dev` no navegador — a página de administração deve aparecer; teste de push:

```
curl "https://<app>.fly.dev/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Fly 部署成功\"}"
```

4. Domínio próprio: `fly certs add sms.seuDominio.com`, DNS conforme as instruções (registro A ou CNAME)

## Variante B: Railway

1. Entre em [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** e selecione seu fork
2. Nas configurações do serviço, **Settings → Root Directory**: `platforms/node` (o Railway reconhece o Dockerfile e faz o build automaticamente)
3. No painel **Variables**, adicione as variáveis de ambiente (veja a tabela geral abaixo; o `PORT` é injetado pela plataforma e o código já se adapta)
4. **Settings → Public Networking → Generate Domain** para gerar um domínio público
5. Validação como acima (com o seu domínio do Railway)

## Variante C: qualquer VPS (Docker)

```bash
# 上传本目录到服务器后
cd platforms/node
docker build -t smstoweb .
docker run -d --name smstoweb --restart unless-stopped -p 8787:8787 \
  -e TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io \
  -e TURSO_AUTH_TOKEN=<你的令牌> \
  -e RECEIVE_TOKEN=<你的密钥> \
  smstoweb
# 验证
curl "http://127.0.0.1:8787/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"content\":\"VPS 部署成功\"}"
```

Sugestão: Caddy/Nginx como reverse proxy com HTTPS. Sem Docker, basta `node server.mjs` direto (precisa de Node 18+, zero dependências npm; o modo SQLite local precisa de Node 22.13+).

## Variáveis de ambiente (válidas para as três variantes)

| Nome | Valor | Descrição |
|---|---|---|
| `SQLITE_PATH` (opcional) | ex.: `/data/data.db` | **modo SQLite local**: definida, elimina o banco externo, os dados ficam em um arquivo local (precisa de Node 22.13+, cria as tabelas automaticamente na primeira inicialização; ou Turso ou local — se ambas estiverem definidas, a local tem prioridade) |
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | modo Turso: a URL anotada no passo 1 |
| `TURSO_AUTH_TOKEN` | (token do passo 1) | modo Turso: o visível apenas uma vez |
| `RECEIVE_TOKEN` | string aleatória longa própria | autenticação de push, não use valor de exemplo |
| `ENABLE_AUTH` | `false` | para login, coloque `true` (**ative por segurança**: a página de administração contém conteúdo sensível, como códigos OTP de SMS; sem login, conhecer o domínio basta para ver todas as mensagens) |
| `ADMIN_PASSWORD` | senha própria | necessário apenas com `ENABLE_AUTH="true"` |
| `SESSION_SECRET` | valor aleatório de alta entropia (≥32 caracteres) | necessário apenas com `ENABLE_AUTH="true"`; independente da senha; se ausente, login/autenticação falham com segurança; após rotação, todas as sessões antigas ficam inválidas |
| `RETENTION_DAYS` | `30` | dias de retenção de dados |
| `PORT` | padrão `8787` | geralmente desnecessária (o Railway injeta automaticamente) |
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

## Conectar dispositivos finais

Siga o [Guia de Implantação e Ingestão](../../../docs/多平台接入部署指南.md) para configurar o Android SmsForwarder e os pushes de notificação dos dispositivos; como domínio, use o endereço do seu serviço.

## Notas e perguntas frequentes

- **Limpeza agendada**: embutida no processo, diariamente às 17:00 UTC (01:00 horário de Pequim) — sem configuração. Como alternativa, use o agendador da plataforma (Fly Machines Cron / Railway Cron) para chamar `GET /api/cron?token=<RECEIVE_TOKEN>`; um dos dois
- **Vantagem do processo permanente**: sem limite de duração de função; o long polling `/api/wait` equivale à experiência do Cloudflare Worker, o melhor tempo real
- **Cotas gratuitas**: o Fly.io não tem mais plano gratuito (para contas novas, só 7 dias / 2 horas de VM de teste; depois do cartão, pay-as-you-go, o consumo micro custa muito pouco); o Railway dá um crédito de teste único de US$ 5 (válido por 30 dias), e o plano Hobby custa US$ 5/mês com crédito equivalente de uso — para custo zero permanente, a versão principal do Cloudflare continua sendo a primeira escolha
- **Backup dos dados**: no modo Turso, os dados ficam no Turso; ao trocar de servidor, basta redefinir as variáveis de ambiente e os dados permanecem; no modo SQLite local, faça backup regular do arquivo `SQLITE_PATH`
- **Proteção de login**: o endpoint de login tem limite de taxa embutido — 5 falhas consecutivas por IP bloqueiam por 10 minutos (em memória, redefinido ao reiniciar o processo)
- **Login via http**: acessando por IP local / http sem TLS, o login funciona direto (o cookie degrada automaticamente, sem Secure forçado); após login em navegadores como o Alook, o redirecionamento funciona normalmente
- **Depuração de logs**: `fly logs` / Railway Deployments → Logs / `docker logs smstoweb`
