# SMSToWeb — Gateway de SMS e Notificações na Nuvem

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | **Português (BR)**

> Sincronizado do original em inglês (pt-BR)

> O inglês é a versão principal mantida deste documento. As traduções ficam em [`docs/i18n/<lang>/`](../../../docs/i18n/README.md) e podem ficar defasadas; em caso de dúvida, consulte o original em inglês.

Envie SMS e notificações de um celular Android (e de qualquer outro dispositivo) para a nuvem em tempo real e leia-os em uma página web de qualquer lugar. Implantação gratuita, sem necessidade de servidor, cerca de 10 minutos de ponta a ponta.

- **Implantação multiplataforma**: Cloudflare (principal) / Vercel / Deno Deploy / Netlify / Tencent EdgeOne Makers / Docker self-hosted — escolha uma de seis, recursos totalmente idênticos
- **Recebimento em tempo real**: o push via webhook chega ao banco de dados em segundos; a página web se atualiza sozinha, sem trabalho manual
- **Push universal**: qualquer dispositivo que possa enviar uma requisição HTTP (Linux / Windows / macOS / iOS / NAS / scripts) pode enviar notificações para a mesma página
- **Origens e filtros**: filtragem dinâmica por origem (SMS / notificações e origens personalizadas agregadas automaticamente), combinada com busca por palavra-chave e os períodos Hoje / Últimos 7 dias / Últimos 30 dias; tamanho de página ajustável
- **Encaminhamento multicanal**: novas mensagens podem ser encaminhadas automaticamente para Feishu / WeCom / DingTalk / Telegram / ServerChan / PushPlus / Bark / ntfy / Gotify / e-mail / webhook genérico — configure apenas o que usar (opcional)
- **Segurança opcional**: alternância de login administrativo, extração de código OTP em vários formatos (código primeiro / palavra-chave primeiro / segmentado / misto, resistente a falsos positivos) com cópia em um toque, modo escuro
- **Dados e alertas**: exportação CSV / JSON pelo filtro atual; toast / som opcional / pílula flutuante para novas mensagens com a página visível, notificação do navegador + título com não lidas em segundo plano; mensagens longas recolhidas automaticamente
- **Reconhecimento de números**: diretório embutido de números institucionais comuns (operadoras / bancos / transportadoras / órgãos públicos) rotulados automaticamente; consulta opcional de região da operadora para números móveis desconhecidos (ativada por padrão, pode ser desativada)
- **9 idiomas**: as páginas de administração e de login já vêm com zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR embutidos; troque pelo menu 🌐 no cabeçalho (deep link `?lang=` suportado, a escolha fica memorizada localmente); datas, tempos relativos e rótulos do diretório acompanham a troca
- **Amigável ao celular**: suporte a `viewport-fit` safe-area para notch e barras de gesto, inputs de 16px contra o zoom automático do iOS, alvos de toque maiores, diálogos em bottom-sheet, PWA para adicionar à tela inicial
- **Lote e desfazer**: exclusão com seleção múltipla, limpar pelo filtro em um toque; desfazer por 5 segundos após a exclusão (exclusão reversível); modo escuro com automático / claro / escuro
- **Favoritos / não lidas / estatísticas**: estrela para fixar, visualizações só favoritos / só não lidas, painel de estatísticas (distribuição por origem + últimos 7 dias); rótulos personalizados de números; destaque e histórico de busca; não perturbe e som nas configurações; PWA

```
[SMS] Android(SmsForwarder) ──POST /api/receive──┐
                                                 ├─→ gateway na nuvem (qualquer plataforma) ─→ banco de dados
[notificação] scripts / atalhos ──POST /api/push────┘        │
                                                navegador ◀── admin web (embutido no gateway)
```

**Implantação em um clique (Cloudflare principal, ~2 min)**:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

O botão cria o banco de dados e as tabelas, vincula os recursos e configura o CI automaticamente; preencha `RECEIVE_TOKEN` (segredo de autenticação de push) quando solicitado e você está no ar. Botões de um clique para Vercel / Netlify estão nos guias de cada plataforma.

| Plataforma | Implantação | Limpeza agendada | Guia |
|---|---|---|---|
| **Cloudflare** (recomendada) | Worker + D1 | cron da plataforma | [platforms/cloudflare/README.md](../../../platforms/cloudflare/README.md) |
| Vercel | Edge Function + Turso | cron da plataforma | [platforms/vercel/README.md](../../../platforms/vercel/README.md) |
| Deno Deploy | Deno nativo + Turso | Deno.cron | [platforms/deno/README.md](../../../platforms/deno/README.md) |
| Netlify | Functions v2 + Turso | Scheduled Function | [platforms/netlify/README.md](../../../platforms/netlify/README.md) |
| Tencent EdgeOne Makers | Functions + Turso | cron externo | [platforms/edgeone/README.md](../../../platforms/edgeone/README.md) |
| Fly.io / Railway / VPS | Docker (Node 22) + Turso / SQLite local | no processo | [platforms/node/README.md](../../../platforms/node/README.md) |

> Cada diretório de plataforma é **totalmente autônomo** (código + schema + documentação independente, zero dependências npm, sem etapa de build). Clique em um guia acima e siga os passos. Os recursos e o schema de dados são idênticos entre as plataformas; é possível migrar entre elas a qualquer momento.
> Para comparação entre plataformas e a preparação comum (banco Turso), veja [platforms/README.md](../../../platforms/README.md).

### Diferenças de runtime (leia antes de implantar)

O código de negócio é idêntico byte a byte nas seis plataformas, mas **timeouts / tarefas em segundo plano / timers** diferem em runtime. Adapte via variáveis de ambiente quando necessário:

| Plataforma | Timeout da função | Notificação em segundo plano | Limpeza agendada | Sugestão |
|---|---|---|---|---|
| Cloudflare | sem limite de tempo de relógio (limitado por CPU) | `ctx.waitUntil` continua após a resposta | cron da plataforma | padrões funcionam |
| Vercel Edge | limite de ~25s por requisição | concluída inline antes da resposta | cron da plataforma | `WAIT_MAX_SECONDS=20` |
| Netlify Functions | 60s (todos os planos) | concluída inline antes da resposta | scheduled function | a entrada usa `WAIT_MAX_SECONDS=8` por padrão |
| Deno Deploy | depende do plano | concluída inline antes da resposta | precisa de gatilho externo | cron externo chamando `/api/cron?token=` |
| EdgeOne Makers | depende do plano | concluída inline antes da resposta | precisa de gatilho externo | reduza `WAIT_MAX_SECONDS` conforme o plano |
| Node / Docker | sua escolha | concluída inline antes da resposta | precisa de gatilho externo | SQLite local precisa de Node ≥ 22.13 |

> - **Long polling**: o front-end repete falhas com **backoff exponencial** (2→30s) e reconsulta imediatamente quando a página volta a ficar visível; requisições abortadas pela plataforma nunca inundam a função.
> - **Encaminhamento de notificações**: o Cloudflare usa `waitUntil`; as outras plataformas terminam o envio das notificações antes da resposta (timeout de 10s por canal), então muitos canais lentos adicionam um pouco de latência.
> - **Limpeza agendada**: em plataformas sem cron, aponte qualquer agendador para `GET /api/cron?token=<RECEIVE_TOKEN>`.

---

## Configuração do celular e ingestão multidevice

Todas as plataformas entregam as mensagens na mesma página web: o SMS do celular passa por `/api/receive` (Android SmsForwarder), todo o resto usa o `/api/push` universal.

Configuração passo a passo (comandos/scripts prontos para copiar por plataforma): **[Guia de Implantação e Ingestão](../../../docs/i18n/en/DEPLOYMENT.md)**

**Referência rápida do push universal** (campos completos no guia):

```
POST https://<your-domain>/api/push?token=<RECEIVE_TOKEN>
{"source":"notify","sender":"demo","content":"hello from anywhere"}
```

Uma resposta `{"success":true,...}` significa que foi armazenado; enviar exatamente o mesmo payload novamente retorna `duplicated:true`.

## Variáveis de ambiente (todas as plataformas)

| Variável | Obrigatória | Descrição |
|---|---|---|
| `RECEIVE_TOKEN` | sim | segredo de autenticação de push; escolha uma string aleatória longa |
| `ENABLE_AUTH` | não | `"true"` exige login na página de administração (**fortemente recomendado**, veja as notas de segurança abaixo); o padrão é sem login |
| `ADMIN_PASSWORD` | não | senha de login (defina quando `ENABLE_AUTH="true"`; se estiver ausente, as APIs de administração recusam acesso e registram um alerta — configuração ausente nunca abre a porta) |
| `RETENTION_DAYS` | não | retenção de dados em dias, padrão 30 |
| `WAIT_MAX_SECONDS` | não | segundos máximos que o long polling de `/api/wait` pode ficar suspenso, padrão 25 (faixa 3–25). Em **Netlify Functions** (limite de 10s) ou outras plataformas de timeout curto, defina `8` para que as requisições não sejam mortas pela plataforma |
| `PHONE_AREA_ENABLED` / `PHONE_AREA_API` | não | consulta de região da operadora: ativada por padrão (API 360 gratuita, sem chave, cache de 24h no back-end, apenas números móveis de 11 dígitos); defina `false` para desativar; origem personalizada via `PHONE_AREA_API` (URL com o placeholder `{number}`) |
| Variáveis de canais de notificação | não | `FEISHU_WEBHOOK` (Feishu) / `WECOM_WEBHOOK` (WeCom) / `DINGTALK_WEBHOOK` (DingTalk, com `DINGTALK_SECRET` de assinatura opcional) / `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY` (com `BARK_URL` opcional) / `NTFY_URL` (com `NTFY_TOKEN` opcional) / `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO` (e-mail, com `MAIL_FROM` opcional) / `GENERIC_WEBHOOKS` (webhook genérico, com `GENERIC_WEBHOOK_TEMPLATE` de corpo / `GENERIC_WEBHOOK_HEADERS` de cabeçalhos opcionais). Configure apenas o que usar; sem nenhuma variável definida, nada é encaminhado. As notificações são renderizadas automaticamente em três modos conforme o conteúdo (🔐 OTP / 💬 SMS / 🔔 notificação) |
| `SITE_NAME` / `SITE_ICON` | não | nome do site / URL do ícone; os padrões se aplicam quando não definidos |
| `NOTIFY_LINK` | não | URL da home da página de administração; quando definida, cada canal de notificação recebe uma entrada "Abrir administração" (botão/link/clique); omitida automaticamente quando não definida |
| `SESSION_SECRET` | obrigatória com login ativado | segredo de assinatura da sessão: **valor aleatório de alta entropia (recomendado ≥32 caracteres aleatórios), totalmente independente da senha de administração**; o Cloudflare e o EdgeOne (e cada outra plataforma) precisam de um valor próprio; nunca commite no Git nem reutilize a senha. Se estiver ausente, o login e a autenticação **falham fechados (fail closed)** (login retorna 500, APIs de administração retornam 401, sem fallback derivado da senha). Rotacionar o valor invalida imediatamente todas as sessões existentes. As sessões duram 30 minutos; o logout limpa apenas o cookie do navegador — um token de sessão copiado permanece válido dentro do seu TTL (até 30 minutos) |

O Cloudflare precisa adicionalmente do binding `DB` (D1); as outras plataformas precisam de `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (banco Turso, veja o guia de cada plataforma); o self-hosting em Node também suporta o modo SQLite local com `SQLITE_PATH` (veja platforms/node/README.md).

> **Recomendações de segurança**
> 1. **Ative o login administrativo** (`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`): a página de administração contém conteúdo sensível, como códigos OTP de SMS; sem login, qualquer pessoa que conheça o domínio pode ler todas as mensagens e excluir dados. O endpoint de login tem limite de taxa (5 falhas consecutivas por IP bloqueiam por 10 minutos); `/api/receive` e `/api/push` têm limite de 120 escritas por IP por minuto (429 além disso).
> 2. **Compensação do `?token=` em URLs**: por compatibilidade com o SmsForwarder e clientes semelhantes, `/api/receive` e `/api/push` aceitam autenticação pelo parâmetro de query `?token=` — o token pode aparecer nos logs de acesso da plataforma e no histórico do navegador. Se isso for uma preocupação, use POST com o cabeçalho `Authorization: Bearer <RECEIVE_TOKEN>` (ambas as formas são suportadas).

## FAQ (geral)

- **Um rótulo mostra literalmente `{{XXX}}`** → não pode acontecer: o gateway limpa rótulos que contenham um `{{` literal e recorre ao `sim`; defina seu nome personalizado diretamente no campo `name` do template
- **API 401/403** → verifique se o `token=` na URL corresponde ao `RECEIVE_TOKEN`; `/api/receive` e `/api/push` não são afetados pela alternância de login
- **API 429** → limite de taxa de escrita atingido (120/IP/min); recupera-se após um minuto — se acontecer em uso normal, seu token pode ter vazado ou algo está martelando a API
- **Mensagens muito longas** → um único corpo é limitado a 8000 caracteres; o excedente é truncado
- **Renomear um rótulo de dispositivo** → o rótulo vem do campo `name` do template da mensagem; alterar `name` cria um novo rótulo. Use "✎" ao lado de um rótulo na página web para renomear, "⇄" para mesclar suas mensagens em outro dispositivo e "×" para excluir diretamente um rótulo vazio
- **Atualizar de uma versão mais antiga (novas colunas)** → execute no banco antigo: `ALTER TABLE messages ADD COLUMN deleted_at TEXT;`, `ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;`, `ALTER TABLE messages ADD COLUMN read_at TEXT;` (bancos novos já as incluem; o SQLite local no node adiciona as colunas automaticamente na inicialização)

## Desenvolvimento

- `src/worker.js`: código-fonte central (formato Cloudflare Worker)
- `platforms/gen_app.py`: gera o `app.js` neutro de plataforma a partir de `src/worker.js` nas cinco plataformas portadas e sincroniza a cópia Cloudflare `worker.js` (mantendo o código de negócio idêntico byte a byte nas seis plataformas); também sincroniza a whitelist de 31 variáveis de ambiente (ENV_KEYS, incluindo as entradas de autenticação) nas seis entradas de plataforma para evitar desvios (o db.js do node é um adaptador duplo de Turso + SQLite local, mantido separadamente e não sincronizado)
- `platforms/*/`: diretórios de implantação autônomos (entrada + app.js + adaptador db.js + schema.sql + guia da plataforma)
- `docs/i18n/en/`: conjunto de documentação em inglês (implantação/API/arquitetura/banco de dados); outros idiomas em `docs/i18n/<lang>/` — veja [docs/i18n/README.md](../../../docs/i18n/README.md)
- `tests/run.mjs`: suíte de testes sem dependências (precisa de Node 22.13+): `node tests/run.mjs`
- Após alterar o código central: execute `python platforms/gen_app.py` para ressincronizar todas as plataformas e depois `node tests/run.mjs`; o CI verifica zero desvio de sincronização + sintaxe + testes

## Licença

[MIT](../../../LICENSE) © 2026 [左立方 (ZuoLifang)](https://cbm.im/)
