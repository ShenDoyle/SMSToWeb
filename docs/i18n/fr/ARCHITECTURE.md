# Document d'architecture (ARCHITECTURE)
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | **Français** | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Synchronisé depuis l'original anglais (fr)

SMSToWeb est un système d'agrégation de SMS/notifications « un seul cœur + entrées multiplateformes » : un cœur métier sans dépendance npm (`src/worker.js`) est synchronisé via un script générateur vers six plateformes de déploiement, chaque plateforme ne conservant qu'une fine couche d'adaptation pour se brancher à son runtime et à sa base de données propres.

## 1. Topologie générale

```
手机（SmsForwarder / 任意脚本）
   │  POST /api/receive（短信）或 /api/push（通用推送）+ token
   ▼
┌─────────────────────────── 任选一个平台部署 ────────────────────────────┐
│  Cloudflare Workers (D1)   Vercel Edge   Deno Deploy                     │
│  Netlify Functions         EdgeOne (Turso)   Node 自托管 (Docker)         │
│                                                                           │
│  入口层（薄适配）：接收请求 → buildEnv 透传环境变量 → fetchApp()          │
│  业务核心（单文件 app.js）：鉴权 → 入库 → 查询 → 长轮询 → 通知转发        │
└──────────────────────────────────────────────────────────────────────────┘
   │                                  │
   ▼                                  ▼
管理页（内嵌 HTML，登录鉴权）      11 渠道通知转发（飞书/企微/钉钉/…）
```

Principe de conception central : **séparation du code métier et des entrées de plateforme**. La logique principale ne change pas selon la plateforme de déploiement ; elle se branche seulement à chaque runtime et à chaque API de base de données via la fine couche d'adaptation ; les six plateformes ont des fonctionnalités strictement identiques.

## 2. Structure des répertoires

```
src/worker.js                 # 唯一业务源文件（Cloudflare Worker 形态：export default { fetch, scheduled }）
platforms/
  gen_app.py                 # 同步生成脚本（见 §3）
  shared/app.js               # 生成产物：与 src/worker.js 业务部分逐字节一致，仅替换导出形态
  cloudflare/                 # CF 主版本副本 + wrangler.toml（静态维护）
  vercel/  netlify/  deno/    # 各平台自包含目录：入口 + app.js + db.js + schema.sql + README
  edgeone/ node/              # EdgeOne 走 Turso；node/db.js 为 Turso + 本地 SQLite 双适配（独立维护）
tests/run.mjs                 # suite de tests sans dépendances (node:sqlite, 204 tests)
docs/                         # 文档（本目录）
schema.sql                    # 数据库建表脚本（单一来源）
```

Chaque répertoire de plateforme est **totalement autonome** : l'entrée ne référence que le `app.js` / `db.js` de son propre répertoire, peut se déployer de façon indépendante et ne dépend pas des autres.

## 3. Mécanisme de synchronisation (platforms/gen_app.py)

`python platforms/gen_app.py` fait d'un coup (idempotent, pas de dérive à la répétition) :

1. À partir de `src/worker.js` comme source unique, prend tout le code métier avant `export default {`, ajoute la file d'export générique (`fetchApp` / `runCron` / `handleCronRequest`) et écrit `platforms/shared/app.js` ;
2. Copie le produit partagé, avec `shared/db.js` et le `schema.sql` de la racine, vers chaque répertoire de plateforme (sauf `node/db.js`, maintenu séparément) ;
3. Avec la **liste blanche ENV_KEYS** incluse dans le script (liste unique, 31 variables d'environnement) remplace le contenu entre les marqueurs `/* ==== ENV_KEYS BEGIN ==== */ … /* ==== ENV_KEYS END ==== */` de chaque fichier d'entrée, garantissant que l'ensemble de variables d'environnement répercuté est le même sur les six plateformes et évitant toute dérive.

Règle de fer : **toute modification métier se fait uniquement dans `src/worker.js` (et dans les ENV_KEYS de gen_app.py) ; après modification, re-exécuter gen_app.py est obligatoire** ; il est interdit de modifier à la main les artefacts générés sous platforms/ (sauf node/db.js et wrangler.toml).

## 4. Cycle de vie d'une requête

En prenant `POST /api/receive` comme exemple :

1. **Couche d'entrée** : l'entrée de la plateforme (p. ex. `platforms/edgeone/functions/index.js`) reçoit la requête, construit `env = buildEnv(vars)` (répercute les variables de la liste blanche + la branche de credentials de la base) et appelle `fetchApp(request, env[, ctx])` ;
2. **Authentification** : `/api/receive`, `/api/push`, `/api/login`, `/api/logout`, `/api/cron` et les ressources statiques sont des routes publiques ; les autres APIs de gestion et de page dépendent de l'interrupteur de connexion (`ENABLE_AUTH`) — après la connexion est émise une **session signée sans état** (`nonce.exp.HMAC-SHA256` en trois segments, cookie `sms_auth`, TTL de 30 minutes) ; si `SESSION_SECRET` manque, échec sûr (fail-closed) (la connexion renvoie 500, les APIs de gestion renvoient toujours 401, aucun repli dérivé du mot de passe), en cas de configuration manquante rien ne passe ;
3. **Stockage** : valide le token (`safeEqual` contre les attaques temporelles) → localise/crée l'appareil par device+sim → écrit dans messages (l'index unique de la base fait le boulot de déduplication final ; un push répété renvoie `duplicated:true` et n'est pas retransféré) ;
4. **Transfert des notifications** : les messages non dupliqués passent en arrière-plan via `bgRun(ctx, dispatchNotify(env, msg))` — Cloudflare passe un vrai `ctx.waitUntil` pour continuer l'envoi après la réponse ; sur les autres plateformes, sans ctx, on dégrade vers `await` en ligne, pour éviter que la fonction edge coupe les tâches de fond trop tôt ;
5. **Réponse** : renvoie immédiatement le JSON (`success/device_id/duplicated`), sans attendre la fin du transfert (plateforme CF).

## 5. Sous-système de transfert des notifications

`dispatchNotify(env, msg)` est la seule couche d'assemblage de tous les canaux :

- `extractCodeLite(content)` : détection légère des codes de vérification côté serveur (même cascade que le `extractCode` du frontend, le code avant le mot-clé ; les numéros de téléphone/dates/heures/montants/numéros de commande sont recadrés avant détection) ;
- `buildNotifyInfo(env, msg)` : la détection du code + la lecture de `NOTIFY_LINK` sont calculés une fois pour tous les canaux, produisant les trois états `verify/sms/notify` et le titre unifié ;
- chaque renderer de canal consomme `info` et rend son propre format (carte Interactive Feishu / markdown WeCom et DingTalk / HTML Telegram / Bark / ntfy / Gotify / e-mail via Resend / modèle de webhook générique, etc.) ; les limites de longueur, la signature et l'échappement sont traités dans chaque renderer ;
- `Promise.allSettled` dispatche en concurrence ; l'échec d'un seul canal ne laisse qu'un log et n'affecte ni les autres canaux ni le flux principal.

## 6. Frontend (page d'administration embarquée)

Le HTML de la page d'administration est embarqué comme modèle littéral `String.raw` dans `src/worker.js` (rendu côté serveur, pas de projet frontend séparé) : la page de connexion et la page d'admin partagent la route `/`, et l'interrupteur de connexion décide quelle forme est rendue ; prend en charge neuf langues (zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR, dictionnaire intégré `data-i18n` + accès direct `?lang=`, repli sur `en` pour les clés manquantes), mode sombre, copie automatique du code de vérification, rafraîchissement automatique par long polling (`/api/wait`), filtre par sources et gestion des appareils.

## 7. Différences par plateforme en un coup d'œil

| Plateforme | Fichier d'entrée | Base de données | cron |
|---|---|---|---|
| Cloudflare | `export default` (le worker.js lui-même) | D1 (`env.DB`) | `scheduled` natif + HTTP `/api/cron` |
| Vercel | `api/[[...route]].js` | Turso | Vercel Cron (Bearer `CRON_SECRET`) |
| Netlify | `functions/api.mjs` + `functions/cron.mjs` | Turso | Scheduled Functions |
| Deno | `main.js` (`Deno.serve`) | Turso | planificateur externe |
| EdgeOne | `functions/index.js` (la racine exige index.js) | Turso (cache de clients indexé par empreinte de credentials) | planificateur externe |
| Node | `server.mjs` (node:http) | Turso / SQLite local (adaptation double) | planificateur externe / Docker |

La sémantique du déclenchement HTTP de `/api/cron` est la même sur toutes les plateformes : `?token=<RECEIVE_TOKEN>` ou `Authorization: Bearer <RECEIVE_TOKEN>`.
