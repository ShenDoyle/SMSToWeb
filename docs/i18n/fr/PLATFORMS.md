# Vue d'ensemble du déploiement multiplateformes
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | **Français** | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Synchronisé depuis l'original anglais (fr)

Les six plateformes de SMSToWeb (version principale Cloudflare + cinq plateformes portées) sont dans ce répertoire. **Chaque sous-répertoire de plateforme est totalement autonome** :
code (entrée + application principale + couche d'adaptation BDD) + `schema.sql` + le tutoriel de déploiement détaillé propre à la plateforme (README.md).

| Plateforme | Runtime | Nettoyage planifié | Tutoriel détaillé |
|---|---|---|---|
| **Cloudflare** (version principale) | Worker + D1 | cron de la plateforme | [CLOUDFLARE.md](./CLOUDFLARE.md) |
| Vercel | Edge Function | cron de la plateforme | [VERCEL.md](./VERCEL.md) |
| Deno Deploy | Deno natif | `Deno.cron` (intégré) | [DENO.md](./DENO.md) |
| Netlify | Functions v2 (Node) | Scheduled Function | [NETLIFY.md](./NETLIFY.md) |
| EdgeOne Makers (Tencent) | Functions | cron externe appelant /api/cron | [EDGEONE.md](./EDGEONE.md) |
| Fly.io / Railway / VPS | Docker (Node 22) + Turso/SQLite local | intégré au processus | [NODE.md](./NODE.md) |

Les six plateformes (Cloudflare incluse) partagent exactement les mêmes routes d'API, logique d'authentification, modèle de messages, page d'administration, transfert de notifications multicanal et nettoyage quotidien (UTC 17:00) ;
les schémas de table sont identiques et la migration de l'une à l'autre se fait à tout moment.

> **Déploiement en un clic** : les tutoriels Cloudflare / Vercel / Netlify ont en haut un bouton officiel de déploiement en un clic (le bouton Cloudflare automatise même la création de la base et des tables) ;
> Deno Deploy, EdgeOne et l'auto-hébergé Docker n'ont pas encore de bouton officiel : suivez le tutoriel de chaque plateforme.

## Bien choisir sa plateforme

- **Zéro coût + zéro tracas** → version principale Cloudflare (quota gratuit D1 généreux, Worker sans souci de durée)
- **Essayer plusieurs plateformes** → Deno Deploy (sémantique la plus proche du Worker, le long polling ne se coupe presque jamais)
- **Accès principalement depuis la Chine** → EdgeOne Makers (attention : domaine personnalisé exige l'enregistrement ICP)
- **Vous avez déjà un serveur / vous voulez tout maîtriser** → node/ (auto-hébergé Docker)

> **Long polling et timeouts par plateforme** : la page d'admin attend les nouveaux messages en se suspendant sur `GET /api/wait`, 25 secondes par défaut au maximum, réglable par plateforme via la variable d'environnement `WAIT_MAX_SECONDS` (3–25).
> Netlify Functions a aujourd'hui un plafond de 60 secondes (l'entrée est par défaut à `WAIT_MAX_SECONDS=8` comme adaptation prudente, relevable si besoin) ; pour Vercel Edge, `20` recommandé ; Cloudflare / Deno / Node peuvent garder la valeur par défaut.
> Le frontend applique un **backoff exponentiel** sur les échecs (2→30s) et redémarre immédiatement la consultation quand la page redevient visible ; même si la plateforme coupe plus tôt, **aucune fonctionnalité n'est impactée**, seul l'avis de nouveaux messages arrive un peu plus tard.

## Préparation commune (partagée par toutes les plateformes non-Cloudflare)

**La base de données est toujours [Turso](https://turso.tech)** (compatible SQLite ; quota gratuit : 100 bases, 5 Go de stockage, 500 millions de lectures de lignes/mois) :

1. Ouvrez [turso.tech](https://turso.tech), connectez-vous avec GitHub
2. **Create Database** : nom `sms-gateway`, région Singapore / Hong Kong, type Free
3. Dans la page de détails de la base, relevez la **Database URL** (`libsql://sms-gateway-xxxx.turso.io`) ; cliquez sur **Create Token** pour créer le jeton et copiez-le immédiatement (il ne s'affiche qu'une fois)
4. Initialisez le schéma : dans la **Console** de la page de détails, collez tout le contenu du `schema.sql` du répertoire de la plateforme et exécutez (identique au `schema.sql` de la racine du dépôt)

Commandes CLI équivalentes :

```bash
turso auth login
turso db create sms-gateway          # 创建数据库
turso db show sms-gateway --url      # 查看 URL
turso db tokens create sms-gateway   # 创建令牌
turso db shell sms-gateway < schema.sql   # 建表
```

**Variables d'environnement** (à configurer dans le panneau de chaque plateforme ; explication complète dans son tutoriel) :

| Variable | Requise | Description |
|---|---|---|
| `TURSO_DATABASE_URL` | Oui | `libsql://sms-gateway-<organisation>.turso.io` |
| `TURSO_AUTH_TOKEN` | Oui | jeton d'accès à la base |
| `RECEIVE_TOKEN` | Oui | secret d'authentification du push (doit correspondre au `token=` de l'URL du client de connexion) |
| `ENABLE_AUTH` | Non | `"true"` exige la connexion à la page d'admin (**fortement recommandé pour la sécurité**, voir les conseils de sécurité ci-dessous) ; par défaut, sans connexion |
| `ADMIN_PASSWORD` | Non | mot de passe de connexion (à configurer quand `ENABLE_AUTH="true"` ; s'il manque, les APIs d'admin refusent toujours l'accès et journalisent une alerte — la config absente n'ouvre pas la porte) |
| `SESSION_SECRET` | obligatoire avec la connexion activée | secret de signature de session de connexion : valeur aléatoire à haute entropie (≥32 caractères aléatoires, indépendante du mot de passe), chaque plateforme doit configurer sa propre valeur indépendante ; s'il manque, connexion et authentification échouent de façon sûre (connexion 500, APIs d'admin 401), sans repli dérivé du mot de passe ; après rotation, toutes les anciennes sessions sont invalidées et il faut se reconnecter |
| `RETENTION_DAYS` | Non | jours de rétention des données, 30 par défaut |
| `WAIT_MAX_SECONDS` | Non | secondes de suspension du long polling (3–25, défaut 25) ; sur Netlify mettre `8`, sur Vercel Edge `20` |
| Variables des canaux de notification | Non | `FEISHU_WEBHOOK` (Feishu) / `WECOM_WEBHOOK` (WeCom) / `DINGTALK_WEBHOOK` (DingTalk, signature `DINGTALK_SECRET` optionnelle) / `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY` (`BARK_URL` optionnelle) / `NTFY_URL` (`NTFY_TOKEN` optionnel) / `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO` (e-mail, `MAIL_FROM` optionnel) / `GENERIC_WEBHOOKS` (webhook générique, `GENERIC_WEBHOOK_TEMPLATE` de corps / `GENERIC_WEBHOOK_HEADERS` d'en-têtes optionnels). Seul ce qui est configuré est transféré ; rien de configuré = rien de transféré ; les notifications se rendent automatiquement en trois états selon le contenu (🔐 code / 💬 SMS / 🔔 notification) |
| `SITE_NAME` / `SITE_ICON` | Non | nom du site / URL de l'icône ; valeurs par défaut si non définies |
| `NOTIFY_LINK` | Non | URL d'accueil de la page d'admin ; une fois configurée, tous les canaux de notification ajoutent l'entrée « Ouvrir l'admin » (bouton/lien/clic), omise automatiquement si non configurée |
| `CRON_SECRET` (Vercel uniquement) | Non | même valeur que `RECEIVE_TOKEN`, pour que Vercel Cron appelle /api/cron |
| `SQLITE_PATH` (node auto-hébergé uniquement) | Non | mode SQLite local : une fois défini, plus besoin de base externe (exige Node 22.13+, voir node/README.md) |

> **Conseils de sécurité (très recommandés)**
> 1. **Activez la connexion de la page d'admin** (`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`) : la page d'admin contient du contenu sensible comme les codes OTP par SMS ; sans connexion, quiconque connaît le domaine peut voir tous les messages et supprimer des données. L'endpoint de connexion intègre déjà une limitation de débit (5 échecs consécutifs par même IP = verrouillage 10 minutes) ; `/api/receive` et `/api/push` sont en plus limités à 120 écritures par IP et par minute (429 au-delà).
> 2. **Compromis du token en query d'URL** : pour rester compatible avec SmsForwarder et clients similaires, `/api/receive` et `/api/push` acceptent l'authentification via le paramètre de requête `?token=` — le token apparaît dans l'URL et peut finir dans les journaux d'accès de la plateforme et dans l'historique du navigateur. Si cela vous préoccupe, utilisez POST + l'en-tête `Authorization: Bearer <RECEIVE_TOKEN>` (les deux méthodes sont prises en charge).

## Structure des répertoires

```
platforms/
├── cloudflare/ # 主版本：worker.js + schema.sql + wrangler.toml + README.md（自包含）
├── vercel/     # api/[[...route]].js + app.js + db.js + schema.sql + vercel.json + README.md
├── netlify/    # functions/{api,cron}.mjs + app.js + db.js + schema.sql + netlify.toml + README.md
├── deno/       # main.js + app.js + db.js + schema.sql + README.md
├── edgeone/    # functions/{[[default]].js,index.js} + app.js + db.js + schema.sql + README.md
├── node/       # server.mjs + app.js + db.js + schema.sql + Dockerfile + package.json + README.md
├── shared/     # app.js / db.js 唯一源（gen_app.py 由此同步到各平台目录）
└── gen_app.py  # 生成器：从 ../src/worker.js 生成 app.js 并同步全部平台（含 cloudflare 独立副本）
```

Chaque répertoire de plateforme peut à lui seul servir de racine de déploiement (déploiement Git : pointez simplement le Root Directory de la plateforme vers le sous-répertoire correspondant),
zéro dépendance npm, sans build. Après modification de `src/worker.js`, exécutez `python platforms/gen_app.py` pour synchroniser toutes les plateformes d'un coup (le CI vérifie zéro dérive ; `node tests/run.mjs` couvre 204 assertions fonctionnelles).

## Migrer du Worker Cloudflare vers d'autres plateformes

1. Préparez la base Turso et créez les tables comme indiqué ci-dessus
2. (Optionnel) migrez l'historique : exportez les données D1 depuis le panneau CF (fichier SQLite) → importez avec `turso db import` (voir la doc CLI officielle)
3. Déployez selon le README de la plateforme cible et vérifiez que la page d'admin et /api/push fonctionnent
4. Changez le domaine du webhook sur le mobile et dans les scripts de push vers la nouvelle plateforme
5. Après un ou deux jours sans incident, désactivez l'ancien Worker

## Remarques communes

- Les routes d'API sont identiques sur toutes les plateformes : `/api/receive`, `/api/push`, `/api/messages` (accepte `device_id`/`source`/`range`/`q`/`limit`/`page`/`starred`/`unread`), `/api/messages/star`, `/api/messages/read`, `/api/messages/remove`, `/api/messages/restore`, `/api/messages/clear`, `/api/export` (CSV/JSON), `/api/sources`, `/api/stats`, `/api/phone` (origine du numéro), `/api/devices`, `/api/devices/alias`, `/api/devices/merge`, `/api/wait`, `/api/login`, `/api/logout`, `/api/cron` ; plus les routes publiques `/manifest.webmanifest` et `/sw.js`
- `/api/cron` permet à n'importe quel planificateur externe de déclencher le nettoyage ; authentification : `?token=<RECEIVE_TOKEN>` ou `Authorization: Bearer <RECEIVE_TOKEN>`
- `/api/receive` et `/api/push` ne dépendent pas de l'interrupteur de connexion
