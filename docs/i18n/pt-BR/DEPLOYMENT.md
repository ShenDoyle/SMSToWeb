# SMSToWeb – Guia de Implantação e Ingestão Multiplataforma

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | **Português (BR)**

> Sincronizado do original em inglês (pt-BR)

O sistema tem duas partes: **lado de ingestão** (clientes de push por plataforma) + **gateway na nuvem** (uma das seis plataformas: Cloudflare / Vercel / Deno / Netlify / EdgeOne Makers / Docker self-hosted, veja [platforms/README.md](../../../platforms/README.md); a ingestão é idêntica em todas).
SMS são apenas uma das formas de ingestão — qualquer dispositivo/script que envie requisições HTTP pode mandar notificações para a mesma página web e lê-las lá.

```
安卓(SmsForwarder)──┐  短信+应用通知
iOS(快捷指令)───────┤
Linux(curl/ntfy)────┼──→ POST /api/receive（短信）或 /api/push（通用通知）
Windows(PowerShell)─┤         │
macOS(快捷指令)─────┘         ▼
                        Cloudflare Worker ──→ D1 存储 ──→ 统一网页（来源筛选）
                              │
                              └──（可选）多渠道通知 → 飞书/企微/钉钉/TG/Bark/邮件…
```

---

## 1. Configuração na nuvem (lado do Cloudflare)

### 1. Variáveis e segredos

Depois de implantar o Worker, em **Workers & Pages → sms-gateway → Settings → Variables and Secrets** configure:

| Nome | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `RECEIVE_TOKEN` | Secret | sim | token de autenticação de push, string aleatória própria (não use um valor de exemplo) |
| `ADMIN_PASSWORD` | Secret | com login ativado | senha de login da página de administração, recomenda-se senha forte; se ausente, todos os endpoints de administração recusam acesso (configuração ausente nunca deixa passar) e um alerta é registrado |
| `ENABLE_AUTH` | Text | não | `"true"` ativa o login (**fortemente recomendado por segurança**: a página de administração contém conteúdo sensível, como códigos OTP de SMS; sem login fica aberta para quem conhecer o domínio); `"false"` ou não definido = sem login |
| `FEISHU_WEBHOOK` | Text | não | webhook do bot de grupo do Feishu; depois de configurar, novas mensagens são encaminhadas automaticamente para o grupo do Feishu (verificação de assinatura usa também `FEISHU_SECRET`) |
| `FEISHU_SECRET` | Secret | não | necessário apenas se o bot do Feishu usar "verificação de assinatura"; o programa calcula a assinatura automaticamente |
| `WECOM_WEBHOOK` | Text | não | webhook do bot de grupo do WeCom |
| `DINGTALK_WEBHOOK` | Text | não | webhook do bot de grupo do DingTalk (com "assinatura" como configuração de segurança, use também `DINGTALK_SECRET`) |
| `SERVERCHAN_SENDKEY` | Text | não | SendKey do ServerChan (push no WeChat) |
| `PUSHPLUS_TOKEN` | Text | não | token do PushPlus (push no WeChat) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Text | não | token do bot do Telegram + ID de chat/grupo |
| `BARK_DEVICE_KEY` | Text | não | chave do dispositivo Bark (com servidor próprio, use também `BARK_URL`; o padrão é a oficial) |
| `NTFY_URL` | Text | não | URL completa do tópico ntfy, ex.: `https://ntfy.sh/my-sms` (tópicos protegidos usam também `NTFY_TOKEN`) |
| `NTFY_TOKEN` | Text | não | token de acesso para tópicos ntfy protegidos: access token direto (Bearer); servidor próprio no formato `user:password` (Basic) |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | Text | não | endereço do servidor Gotify (sem `/message`) + token de aplicativo |
| `RESEND_API_KEY` + `MAIL_TO` | Text | não | e-mail (API Resend); `MAIL_FROM` opcional, padrão `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS` | Text | não | webhook genérico, várias URLs separadas por vírgula; `GENERIC_WEBHOOK_TEMPLATE` opcional para corpo próprio, `GENERIC_WEBHOOK_HEADERS` para cabeçalhos |
| `GENERIC_WEBHOOK_HEADERS` | Text | não | cabeçalhos personalizados do webhook genérico, string JSON de objeto, ex.: `{"Authorization":"Bearer xxx"}` |
| `NOTIFY_LINK` | Text | não | URL da home da página de administração; quando definida, cada canal de notificação recebe uma entrada "Abrir administração" (botão do Feishu, linha de link por canal, URL do Bark, click do ntfy etc.); omitida automaticamente quando não definida |
| `SESSION_SECRET` | Secret | obrigatório com login ativado | segredo de assinatura da sessão: **valor aleatório de alta entropia (recomendado ≥32 caracteres aleatórios), totalmente independente da senha de administração**; CF e EO (e cada plataforma) recebem um valor próprio, nunca commite no Git nem reutilize a senha. Se ausente, login e autenticação falham com segurança (login 500, endpoints de administração 401), sem fallback derivado da senha. Após rotação, todas as sessões antigas ficam imediatamente inválidas (login novamente); sessões duram 30 minutos, o logout limpa apenas o cookie do navegador — um token copiado pode continuar válido dentro do TTL |
| `RETENTION_DAYS` | Text | não | dias de retenção de dados, padrão 30; a mudança vale na hora |
| `WAIT_MAX_SECONDS` | Text | não | segundos máximos de suspensão do long polling `/api/wait`, padrão 25 (3–25). **Netlify Functions tem limite de 10s → recomenda-se `8`**; Vercel Edge: recomenda-se `20`. O front-end repete com backoff exponencial, a função não é inundada |

> **Duas notas de segurança**
> 1. Ative o login de administração (`ENABLE_AUTH="true"`) e defina uma `ADMIN_PASSWORD` forte; o endpoint de login tem limite de taxa embutido (5 falhas consecutivas por IP → bloqueio de 10 minutos); `/api/receive`, `/api/push` retornam 429 a partir de 120 escritas por minuto e IP (recupera-se automaticamente).
> 2. O token de push aceita `?token=` como parâmetro de URL (cenário SmsForwarder); o token aparece na URL e pode ir parar nos logs de acesso da plataforma; quem não quiser isso usa POST + cabeçalho `Authorization: Bearer <RECEIVE_TOKEN>` — ambos os caminhos são suportados.

### 2. Canais de encaminhamento de notificações (opcional, encaminha apenas o que for configurado)

Na página de "variáveis de ambiente / variables" da plataforma de implantação, adicione as variáveis correspondentes para ativá-los; **sem nada configurado, nada é encaminhado — o armazenamento e a visualização web não mudam**.
Vários canais são servidos em paralelo; falha em um canal não afeta os outros; duplicatas (`duplicated:true`) não são encaminhadas de novo.

As notificações são renderizadas automaticamente em **três estados** conforme o conteúdo (igual em todos os canais): OTP detectado → **lembrete de OTP** (código no título/destaque do cartão; a notificação do Bark copia o código com um toque, Bark e ntfy recebem prioridade elevada); SMS sem código → **novo SMS**; push de aplicativo/dispositivo → **notificação de dispositivo**. Depois de definir a variável opcional `NOTIFY_LINK`, cada canal recebe automaticamente uma entrada "abrir página de administração"; sem ela, a entrada é omitida.

O webhook genérico envia por padrão um corpo JSON com os novos campos `type` (`verify`/`sms`/`notify`) e `code` (código OTP detectado, string vazia quando não detectado); os placeholders de `GENERIC_WEBHOOK_TEMPLATE` suportam consequentemente `{{type}}`/`{{code}}`.

Passos de configuração por canal:

**Bot de grupo do Feishu** — `FEISHU_WEBHOOK` (`FEISHU_SECRET` opcional)
1. No grupo de destino do Feishu → configurações → bots de grupo → adicionar bot → **bot personalizado**
2. Copie o endereço do webhook do tipo `https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx` e cole na variável
3. Configuração de segurança, três opções: **palavra-chave personalizada** (recomendado: só coloque uma palavra-chave como `短信`, nada mais é preciso); **verificação de assinatura** (cole a chave em `FEISHU_SECRET`, o programa calcula a assinatura automaticamente); allowlist de IP (o IP de saída do Worker não é fixo — não escolha)

**Bot de grupo do WeCom** — `WECOM_WEBHOOK`
1. No grupo de destino do WeCom → configurações do grupo no canto superior direito → bots de grupo → adicionar bot → criar novo
2. Copie o endereço do webhook do tipo `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx` e cole na variável

**Bot de grupo do DingTalk** — `DINGTALK_WEBHOOK` (`DINGTALK_SECRET` opcional)
1. No grupo de destino do DingTalk → configurações do grupo → assistente inteligente de grupo → adicionar bot → **personalizado** (integração por webhook)
2. Como configuração de segurança recomenda-se **assinatura**: cole a chave exibida na página (começa com SEC) em `DINGTALK_SECRET`; sem configuração, conecta-se diretamente sem assinatura
3. Copie o endereço do webhook do tipo `https://oapi.dingtalk.com/robot/send?access_token=xxxx` e cole em `DINGTALK_WEBHOOK`

**ServerChan (push no WeChat)** — `SERVERCHAN_SENDKEY`
1. Abra [sct.ftqq.com](https://sct.ftqq.com) e entre pelo QR code do WeChat
2. Na página inicial, copie o **SendKey** (formato `SCTxxxxxxxxxxxx`) e cole na variável; as mensagens chegam à sua conta de serviço do WeChat "方糖"

**PushPlus (push no WeChat)** — `PUSHPLUS_TOKEN`
1. Abra [pushplus.plus](https://www.pushplus.plus) e entre pelo QR code do WeChat
2. Na página inicial, copie o **token** e cole na variável; depois de seguir a conta pública, o push chega no WeChat

**Bot do Telegram** — `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (ambos configurados = ativo)
1. No TG, procure [@BotFather](https://t.me/BotFather) → `/newbot`, siga as instruções → receba o token do bot (formato `123456:ABC-xxx`)
2. Obtenha o `chat_id`: mande uma mensagem para o bot primeiro e depois abra `https://api.telegram.org/bot<seuToken>/getUpdates` no navegador e localize `chat.id` no corpo JSON da resposta (em grupos: coloque o bot no grupo e mande uma mensagem, e o ID do grupo também aparece)
3. Cole os dois valores em `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` respectivamente

**Bark (push no iOS)** — `BARK_DEVICE_KEY` (`BARK_URL` opcional)
1. Instale o [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865) da App Store, abra o app e copie a parte da chave da URL de exemplo (`https://api.day.app/<essa é a chave>/...`)
2. Cole a chave em `BARK_DEVICE_KEY`; com servidor próprio, defina também `BARK_URL` (o padrão é a oficial `https://api.day.app`)

**ntfy (assinatura Android/iOS/web)** — `NTFY_URL` (`NTFY_TOKEN` opcional)
1. Instale o app ntfy no celular (ou use o site [ntfy.sh](https://ntfy.sh)) e assine um nome de tópico próprio, ex.: `my-sms-9f2k` (quanto mais aleatório o nome, mais privado)
2. Em `NTFY_URL`, cole a URL completa do tópico: `https://ntfy.sh/my-sms-9f2k` (servidor próprio: seu endereço; é suportada implantação atrás de reverse proxy com subcaminho)
3. Se o tópico tiver controle de acesso, defina `NTFY_TOKEN`: access token (prefixo `tk_`) direto; servidor próprio no formato `usuário:senha`

**Gotify (servidor de push próprio)** — `GOTIFY_URL` + `GOTIFY_TOKEN`
1. Quem já opera o Gotify: entre no web → **Apps** → criar aplicativo → copiar o **token**
2. Em `GOTIFY_URL`, coloque o endereço do servidor (ex.: `https://push.example.com`, **sem** `/message`) e o token em `GOTIFY_TOKEN`

**E-mail (API Resend)** — `RESEND_API_KEY` + `MAIL_TO` (`MAIL_FROM` opcional)
1. Abra [resend.com](https://resend.com) e registre-se (cota gratuita: 100 e-mails por dia, 3000 por mês)
2. **API Keys** → Create API Key, copie e cole em `RESEND_API_KEY`
3. Em `MAIL_TO`, coloque o(s) destinatário(s) (vários separados por vírgula); sem `MAIL_FROM`, vale `onboarding@resend.dev` (esse remetente padrão só pode enviar para o endereço usado no registro do Resend; para destinatários arbitrários, verifique seu próprio domínio no Resend e defina `MAIL_FROM`)

**Webhook genérico / APIs de terceiros** — `GENERIC_WEBHOOKS` (`GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS` opcionais)
1. Em `GENERIC_WEBHOOKS`, coloque uma ou mais URLs (**separadas por vírgula**). Por padrão envia JSON via POST:

```json
{"title":"【短信】13800138000 ← 10086","content":"正文…","time":"2026-10-14 12:30:00（北京时间）","source":"sms","sender":"1069012345678","device":"我的手机"}
```

2. Se o destino exigir um formato específico, defina `GENERIC_WEBHOOK_TEMPLATE` com os placeholders `{{title}}` / `{{content}}` / `{{time}}` / `{{source}}` / `{{sender}}` / `{{device}}` para um corpo próprio; se o template for parseável como JSON, é enviado como JSON, senão como texto simples. Exemplo:

```
{"phone":"13800138000","msg":"{{content}}","at":"{{time}}"}
```

3. Se o destino exigir cabeçalhos de autenticação (para a chave não ir na URL), defina `GENERIC_WEBHOOK_HEADERS` como string JSON de objeto, ex.:

```json
{"Authorization":"Bearer sk-xxx","X-Api-Key":"yyy"}
```

Se o valor não for JSON válido, ele é ignorado; o encaminhamento padrão continua sem alterações. Por esse template é possível integrar qualquer API de terceiros — gateways de SMS, Home Assistant, n8n, scripts próprios etc. Nomes de variáveis e onde armazená-las por canal: veja a tabela "variáveis e segredos" acima; no Cloudflare configure na página "Variables and Secrets" do Worker; nas demais plataformas, no local de variáveis de ambiente descrito no guia de cada uma.

### 3. Banco de dados

A tabela `messages` do D1 precisa das colunas `source` (distingue SMS/notificação) e `deleted_at` (exclusão reversível/desfazer). Em uma instalação nova, execute o [schema.sql](../../../schema.sql) diretamente; para atualizar um banco antigo:

```sql
ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'sms';
ALTER TABLE messages ADD COLUMN deleted_at TEXT;
ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN read_at TEXT;
```

---

## 2. Especificação da API de push

Os dois endpoints públicos autenticam via `RECEIVE_TOKEN` (token na query ou no corpo):

### 1. Recebimento de SMS `POST /api/receive` (exclusivo do app Android)

```
POST https://<seuDomínio>/api/receive?token=<RECEIVE_TOKEN>
Content-Type: application/json

{
  "name": "我的手机",
  "sim": "13800138000",
  "from": "1069012345678",
  "content": "您的验证码是 734752，5 分钟内有效",
  "time": "2026-10-14 12:29:59"
}
```

### 2. Push universal `POST /api/push` (notificações de todas as plataformas)

```
POST https://<seuDomínio>/api/push
Content-Type: application/json

{
  "token": "<RECEIVE_TOKEN>",
  "source": "notify",
  "sender": "备份脚本",
  "name": "通知网关",
  "content": "数据库备份完成，耗时 3 分 12 秒",
  "time": "2026-10-14 03:00:00"
}
```

| Campo | Obrigatório | Descrição |
|---|---|---|
| `token` | sim | token de autenticação |
| `content` | sim | texto da mensagem (`text`/`message`/`msg` também funcionam) |
| `source` | não | etiqueta de origem, padrão `notify`; usada pelo "filtro de origens" da página web, livre para escolher (ex.: `cron`, `alert`) |
| `sender` | não | título da origem (hostname/nome do app/nome do script) |
| `name` | não | rótulo do dispositivo (nome próprio), padrão "Notification Gateway", exibido em paralelo com o rótulo de SMS |
| `time` | não | horário do evento; sem valor, vale o horário atual do servidor; suporta timestamp ou texto `YYYY-MM-DD HH:MM:SS` |

Resposta: `{"success":true,"device_id":17,"duplicated":false}` (`duplicated=true` significa: duplicata ignorada, sem novo encaminhamento aos canais de notificação)

---

## 3. Ingestão por plataforma

### Android (SMS + notificações de apps) — SmsForwarder

1. Instale o app open-source "SmsForwarder" ([pppscn/SmsForwarder](https://github.com/pppscn/SmsForwarder))
2. Nas configurações gerais, ative a chave principal **"encaminhar broadcast de SMS"**
3. Crie um "canal webhook": na URL use `/api/receive?token=<RECEIVE_TOKEN>`, template da mensagem:

```json
{"name":"我的手机","sim":"13800138000","from":"{{FROM}}","content":"{{SMS}}","time":"{{DATE}}"}
```

> Pontos-chave: em `name` coloque o nome do seu dispositivo (o rótulo da web o exibe; renomear cria um rótulo novo); em `sim` coloque diretamente o número do celular (visível no canto inferior direito do cartão, duplo clique copia); `content` deve usar a variável `{{SMS}}`.
> Para encaminhar notificações de apps: crie também uma regra de encaminhamento de "notificação de aplicativo", no template preencha `sender` com `{{APP_NAME}}` e `content` com `{{MSG}}`, e mude o destino para `/api/push`.

### iOS — Atalhos (Shortcuts)

1. Atalhos → Automação → nova "automação pessoal" → escolha "receber SMS/Info"
2. Adicione ação → "obter conteúdo da URL":
   - URL: `https://<seuDomínio>/api/push`
   - Método: POST, corpo JSON:

```json
{"token":"<RECEIVE_TOKEN>","source":"sms","sender":"iPhone","name":"通知网关","content":"[variável do corpo da mensagem]"}
```

3. Desative "perguntar antes de executar" — depois disso tudo roda automaticamente. Notificações agendadas (bateria, modos de foco) funcionam igual; escolha o gatilho adequado.

### Linux — curl / scripts / systemd

O one-liner mais simples:

```bash
curl -s -X POST https://<seuDomínio>/api/push \
  -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"web-01","content":"Nginx 已重启"}'
```

Exemplo de notificação agendada/por evento (`/usr/local/bin/notify.sh`):

```bash
#!/bin/bash
curl -s -X POST https://<seuDomínio>/api/push \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"<RECEIVE_TOKEN>\",\"sender\":\"$(hostname)\",\"source\":\"cron\",\"content\":\"$1\"}"
```

Chame com um timer systemd ou cron: `notify.sh "每日备份完成"`.

Avançado (opcional): hospede o [ntfy](https://ntfy.sh) você mesmo (um binário/Docker), faça várias máquinas assinarem o mesmo fluxo de eventos e use um pequeno script de ponte para encaminhar as mensagens do ntfy para este gateway.

### Windows — PowerShell / Agendador de Tarefas

`C:\Tools\notify.ps1`:

```powershell
param([string]$Message = "通知")
$body = @{
  token  = "<RECEIVE_TOKEN>"
  sender = $env:COMPUTERNAME
  source = "notify"
  content = $Message
} | ConvertTo-Json
Invoke-RestMethod -Uri "https://<seuDomínio>/api/push" -Method Post -ContentType "application/json" -Body $body
```

Uso: `powershell -File C:\Tools\notify.ps1 -Message "磁盘清理完成"`; no Agendador de Tarefas, anexe a eventos como "antes de desligar" ou "depois do backup".

### macOS — Atalhos / launchd

- Atalhos: como no iOS (gatilhos de automação ex.: "hora específica", "alteração de arquivo")
- Script agendado + launchd (`~/Library/LaunchAgents/local.notify.plist`):

```bash
curl -s -X POST https://<seuDomínio>/api/push -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"MacBook","content":"Time Machine 备份完成"}'
```

- Quem quiser ler os SMS do iPhone no Mac: via AppleScript, faça polling do store SQLite do Messages.app buscando novos registros e envie (para avançados)

### Servidores/contêineres em geral — Apprise (camada de agregação opcional)

O [Apprise](https://github.com/caronc/apprise) suporta mais de 100 destinos de notificação; este gateway pode ser adicionado como um desses webhooks personalizados para centralizar o push multi-destino.

---

## 4. Checklist de verificação

| Ponto de verificação | Método |
|---|---|
| Autenticação da API | Uma requisição sem token deve retornar 403 unauthorized |
| Push universal | Envie um dos exemplos acima; visível na origem web "notificações", e os canais configurados recebem em sincronia |
| Cadeia de SMS | Envie um SMS real ao celular → visível na origem web "SMS" + extração de OTP + encaminhamento aos canais |
| Filtro de origens | Na barra de ferramentas da página de administração, alterne o dropdown "filtro de origens": todas / SMS / notificações e origens personalizadas |
| Troca de idioma (nove idiomas) | A página de administração e a de login têm nove idiomas embutidos (简体中文 / 繁體中文 / English / 日本語 / 한국어 / Español / Français / Deutsch / Português (BR)); selecione no menu "🌐" no canto superior direito e a página inteira troca; a escolha fica memorizada localmente no navegador; também é possível acessar direto `https://seuDomínio/?lang=ja` etc. Links antigos `?lang=zh` / `?lang=en` continuam compatíveis (normalização automática para zh-CN / en) |
| Exportação e filtros | Clique em "exportar CSV / JSON" para baixar o resultado do filtro atual; ao mudar para "últimos 7 dias" / "50 por página", a lista e o export acompanham |
| Bloqueio de duplicatas | Reenvie o mesmo conteúdo em segundos → resposta `duplicated:true`, os canais não enviam de novo |

## 5. Perguntas frequentes

- **Enviei, mas a página não atualiza?** A página de administração usa long polling com auto-atualização (padrão: até 25 segundos de suspensão, ajustável via `WAIT_MAX_SECONDS`); ao voltar para a página, recarrega imediatamente; como alternativa, alterne o filtro de origens uma vez para provocar o carregamento.
- **Interface apertada no navegador do celular / caixa de login ampliada?** A adaptação móvel já está embutida (safe-area, inputs de 16px contra o zoom automático do iOS, alvos de toque maiores); se algo ainda parecer estranho, limpe o cache dessa página e tente de novo.
- **Long polling no Netlify falhando sempre?** Defina `WAIT_MAX_SECONDS=8` (abaixo do limite de 10s das Functions).
- **O canal de notificação não recebeu nada?** Verifique se as variáveis do canal estão definidas e corretas (pares como Telegram/Gotify devem ser completos); procure nos logs da plataforma `notify forward failed:`; mensagens com `duplicated:true` não são encaminhadas.
- **Renomear o rótulo?** Clique em "✎" atrás do rótulo do dispositivo (definir um alias) ou em "⇄" para mesclar as mensagens desse rótulo em outro dispositivo; rótulos vazios podem ser excluídos direto pelo "×".
- **Por quanto tempo as mensagens ficam?** Controlado por `RETENTION_DAYS`, padrão 30 dias; a limpeza automática roda diariamente às 17:00 UTC (01:00 horário de Pequim).
