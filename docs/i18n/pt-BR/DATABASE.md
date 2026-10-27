# Documentação do banco de dados

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | **Português (BR)**

> Sincronizado do original em inglês (pt-BR)

O SMSToWeb equaliza, por uma camada única de adaptador de banco (os quatro métodos `prepare/bind/first/all/run`, totalmente idêntica à API D1 do Cloudflare), três backends de armazenamento, de modo que o código de negócio não tenha nenhuma diferença de dialeto SQL.

## 1. Matriz de backends

| Plataforma | Banco de dados | Variáveis de credenciais | Arquivo do adaptador |
|---|---|---|---|
| Cloudflare | D1 | binding do console (`env.DB`), configurado no wrangler.toml | nativo, sem adaptador |
| Vercel / Netlify / Deno / EdgeOne | Turso (libsql) | `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | `platforms/shared/db.js` |
| Node self-hosted | Turso **ou** SQLite local | com as variáveis Turso, vale Turso; senão `SQLITE_PATH` (padrão `./data/smstoweb.db`, node:sqlite) | `platforms/node/db.js` (adaptador duplo, mantido separadamente) |

O adaptador multiplataforma usa `fetch` puro (HTTP /v2/pipeline do Turso), sem dependências npm.

## 2. Schema das tabelas (schema.sql como fonte única)

### devices — tabela de dispositivos

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | INTEGER PK | autoincremento |
| `device` | TEXT | nome do dispositivo (campo `name` do template do app, padrão `unknown`) |
| `sim` | TEXT | número que recebeu (armazenado e exibido sem alterações, sem mapeamento) |
| `alias` | TEXT | alias opcional (prioridade de exibição na página de administração: alias > device) |
| `created_at` | TEXT | momento de criação |

Índice único `idx_devices_key(device, sim)`: mesmo dispositivo + mesmo número de recepção é único.

### messages — tabela de mensagens (10 colunas)

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | INTEGER PK | autoincremento |
| `device_id` | INTEGER FK | → devices.id |
| `sender` | TEXT | remetente |
| `content` | TEXT | texto (truncado para 8000 caracteres antes de gravar) |
| `received_at` | TEXT | hora de Pequim (precisão de segundo) |
| `source` | TEXT | origem: `sms` / `notify` / personalizada (ex.: `alert`) |
| `created_at` | TEXT | momento de gravação |
| `deleted_at` | TEXT NULL | marcação de exclusão reversível (NULL = normal) |
| `starred` | INTEGER | estrela 0/1 |
| `read_at` | TEXT NULL | marcação de "lida" |

Índices: `idx_messages_device_time(device_id, received_at DESC)`, `idx_messages_time(received_at)`, `idx_messages_source(source, received_at DESC)` e o **índice único antifraude** `idx_messages_dedup(device_id, sender, content, received_at)` — pushes duplicados são bloqueados na camada do banco; o código captura o conflito de unicidade e retorna `duplicated:true`.

## 3. Regra de migração (importante)

**A qualquer mudança no schema.sql, deve-se lembrar/executar a migração no banco de todas as plataformas já implantadas** (lição do incidente de produção de 2026-10-22: o código entrou no ar antes do schema; o banco Turso antigo estava sem a coluna `starred`, o que derrubou todos os endpoints de listagem com 500).

- Implantação nova: execute direto o `schema.sql` da raiz (idempotente, `CREATE TABLE IF NOT EXISTS`);
- Upgrade de banco antigo: execute para as colunas novas `ALTER TABLE messages ADD COLUMN deleted_at TEXT;` / `ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;` / `ADD COLUMN read_at TEXT;` (nota no final do schema.sql);
- Bancos de produção já migrados: D1 do CF (sms-gateway-db, 10 colunas verificadas) e Turso do EO (sms-gateway, migrado) não precisam de mais nada.

## 4. Retenção e limpeza de dados

- Limpeza agendada (cron): exclui as messages cujo `received_at` é mais antigo que `RETENTION_DAYS` (padrão 30 dias);
- Disparo: cron nativo da plataforma (scheduled do CF / Vercel Cron / Scheduled do Netlify) ou qualquer agendador via `GET /api/cron?token=<RECEIVE_TOKEN>`.

## 5. Notas de uso do Turso (depuração)

- **Tipo de token**: API token da organização (payload JWT só org_id) ≠ token de banco (payload com `a:"rw"`). Tokens de banco são criados no console do Turso → página de detalhes do banco → aba Tokens; com o tipo errado, o /v2/pipeline responde `invalid JWT token` → todos os endpoints do banco com 500 "internal error" (a página de login não consulta o banco e por isso continua normal).
- **Cache de clientes**: o cliente Turso é cacheado keyado pelo fingerprint das credenciais (mudou dbUrl+dbToken, ele é reconstruído automaticamente); após trocar o token no console, não é preciso reimplantar.
- **Diagnóstico rápido**: com o token do banco, chame direto `POST https://<db-url>/v2/pipeline` (body: `{"requests":[{"type":"execute","stmt":{"sql":"SELECT 1"}},{"type":"close"}]}`).
