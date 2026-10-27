# Guide de déploiement Cloudflare (version principale, tout au navigateur)
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | **Français** | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Synchronisé depuis l'original anglais (fr)

C'est la version principale du projet : SMS/notifications du mobile → Cloudflare Worker → base de données D1 → page d'administration web.
Sans serveur, largement dans le quota gratuit, tout se fait en clics dans le navigateur, sans installer d'outil.

Ce répertoire est **totalement autonome** : [`worker.js`](../../../platforms/cloudflare/worker.js) (code source à déployer) + [`schema.sql`](../../../platforms/cloudflare/schema.sql) (script de création des tables) + [`wrangler.toml`](../../../platforms/cloudflare/wrangler.toml) (config optionnelle pour le déploiement en ligne de commande), sans dépendre d'autres fichiers du dépôt. Les autres plateformes : [Vue d'ensemble des plateformes](./PLATFORMS.md).

---

## Déploiement en un clic (recommandé aux débutants)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

Le bouton ci-dessus fait faire à Cloudflare automatiquement : cloner le code vers votre GitHub → **créer la base D1 et exécuter le script de tables** → lier les ressources → configurer le CI (chaque push ultérieur vers votre dépôt redéploie automatiquement) → publier. En cours de route, remplissez les secrets demandés :

- `RECEIVE_TOKEN` : secret d'authentification du push ; inventez une longue chaîne aléatoire (le `token=` de l'URL de connexion du mobile doit correspondre)
- `ADMIN_PASSWORD` : mot de passe de connexion de la page d'admin (**fortement recommandé de le configurer** — la page d'admin contient du contenu sensible comme les codes OTP par SMS ; avec `ENABLE_AUTH="true"` mais sans cette valeur, les APIs d'admin refusent toujours l'accès, jamais d'ouverture sans connexion)
- `SESSION_SECRET` : secret de signature de session de connexion, **obligatoire quand la connexion est activée** — valeur aléatoire à haute entropie (≥32 caractères aléatoires, p. ex. généré par `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`), totalement indépendante du mot de passe ; s'il manque, connexion et authentification échouent de façon sûre (connexion 500, APIs d'admin 401), sans repli dérivé du mot de passe ; à la rotation, toutes les anciennes sessions sont invalidées immédiatement

> Pour lier un domaine personnalisé (p. ex. `sms.example.com`) : après déploiement, ouvrez le Worker → Paramètres → Domaines et routes → Ajouter un domaine personnalisé.
> Le tutoriel manuel ci-dessous reste là pour qui ne veut pas le flux en un clic ou souhaite comprendre chaque étape.

## Préparation

1. Un compte Cloudflare ([inscription](https://dash.cloudflare.com/sign-up), gratuit, un e-mail suffit)
2. Le code du projet (le [`worker.js`](../../../platforms/cloudflare/worker.js) de ce répertoire est tout le code à coller)

## Étape 1 : créer la base D1

1. Connectez-vous à [dash.cloudflare.com](https://dash.cloudflare.com)
2. Menu de gauche **Stockage et bases de données → Bases de données SQL D1**
3. Cliquez sur **Créer une base de données**, nommez-la `sms-gateway-db` (le reste par défaut), créez
4. Ouvrez la base créée → onglet **Console**
5. Copiez-collez tout le contenu du [`schema.sql`](../../../platforms/cloudflare/schema.sql) de ce répertoire dans la zone de saisie et cliquez **Exécuter**
6. L'exécution doit réussir (elle crée les tables `messages` et `devices`)

## Étape 2 : créer le Worker et coller le code

1. Menu de gauche **Compute (Workers) → Workers et Pages**
2. Cliquez **Créer une application**, choisissez **Start with Hello World!** (partir du modèle Hello World), nommez-la `sms-gateway`, cliquez **Déployer** (le déploiement initial avec le code par défaut peut se faire)
3. Cliquez **Modifier le code** et effacez tout le code par défaut de l'éditeur
4. Ouvrez le [`worker.js`](../../../platforms/cloudflare/worker.js) de ce répertoire, copiez-le entièrement et collez-le dans l'éditeur
5. Cliquez **Déployer** en haut à droite ; le déploiement doit réussir

## Étape 3 : lier la base D1

1. Revenez à la page de synthèse du Worker → onglet **Bindings (liaisons)**
2. Cliquez **Ajouter → Base de données D1**
3. Dans le nom de variable, tapez `DB` (strictement identique, majuscules), et choisissez la `sms-gateway-db` créée
4. Cliquez **Déployer/Enregistrer**

## Étape 4 : configurer variables et secrets

Au même endroit, **Paramètres → Variables and Secrets**, ajoutez un par un :

1. **Ajouter une variable** (type « Texte ») :
   - Nom `RETENTION_DAYS`, valeur `30` (pour garder 90 jours, mettez `90`)
   - Nom `ENABLE_AUTH`, valeur `false` (**pour la sécurité, il est très fortement recommandé de mettre `true` pour activer la connexion** : la page d'admin contient du contenu sensible comme les codes OTP par SMS ; sans connexion, elle est ouverte à quiconque connaît le domaine. Si vous déployez automatiquement en reliant le dépôt via Workers Builds, ce dernier pousse le `wrangler.toml` du dépôt — désormais par défaut à `true`)
   - Nom `SITE_NAME` (optionnel), valeur : nom personnalisé du site, p. ex. `Ma station SMS`
   - Nom `SITE_ICON` (optionnel), valeur : URL de l'icône (commençant par `http(s)://`) ; si vide ou URL invalide, l'icône intégrée est utilisée
   - Nom `NOTIFY_LINK` (optionnel), valeur : URL d'accueil de la page d'administration (commençant par `http(s)://`) ; une fois configurée, tous les canaux de notification ajoutent l'entrée « Ouvrir l'admin »
2. **Ajouter un secret** (type « Secret ») :
   - Nom `RECEIVE_TOKEN`, valeur : inventez une longue chaîne aléatoire (n'utilisez aucune valeur d'exemple du tutoriel ; au plus long, au mieux)
   - Nom `ADMIN_PASSWORD`, valeur : inventez un mot de passe de connexion de la page d'admin (nécessaire seulement quand `ENABLE_AUTH="true"`)
   - Nom `SESSION_SECRET`, valeur : une chaîne aléatoire à haute entropie (≥32 caractères, indépendante du mot de passe ; nécessaire seulement quand `ENABLE_AUTH="true"`)
3. Après chaque ajout, cliquez **Déployer/Enregistrer**

> Ces valeurs sont effectives à tout moment, sans recoller le code. Si vous changez `RECEIVE_TOKEN`, pensez à mettre à jour aussi le `token=` de l'URL du mobile.

## Étape 5 (optionnel) : configurer les canaux de transfert des notifications

Une fois les nouveaux messages stockés, ils peuvent être transférés automatiquement vers des canaux externes ; **seul le canal dont la variable est configurée est transféré ; rien de configuré = rien de transféré**.
Il suffit d'ajouter les variables correspondantes dans la même page « Variables and Secrets » :

| Canal | Variable | Description |
|---|---|---|
| Bot de groupe Feishu | `FEISHU_WEBHOOK` (optionnel `FEISHU_SECRET`) | adresse webhook du bot de groupe ; si la sécurité du bot utilise « vérification par signature », configurez en plus `FEISHU_SECRET` |
| Bot de groupe WeCom | `WECOM_WEBHOOK` | adresse webhook du bot de groupe |
| Bot de groupe DingTalk | `DINGTALK_WEBHOOK` (optionnel `DINGTALK_SECRET`) | la sécurité par signature exige de configurer `DINGTALK_SECRET` |
| ServerChan | `SERVERCHAN_SENDKEY` | SendKey (push WeChat) |
| PushPlus | `PUSHPLUS_TOKEN` | token (push WeChat) |
| Bot Telegram | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | token du bot + ID de chat/groupe |
| Bark | `BARK_DEVICE_KEY` (optionnel `BARK_URL`) | serveur auto-hébergé : configurez `BARK_URL` ; défaut : officiel |
| ntfy | `NTFY_URL` (optionnel `NTFY_TOKEN`) | URL complète du topic, p. ex. `https://ntfy.sh/my-sms` ; topics protégés : configurez en plus `NTFY_TOKEN` (Token ou user:password) |
| Gotify | `GOTIFY_URL` + `GOTIFY_TOKEN` | adresse du serveur (sans `/message`) + token d'application |
| E-mail (Resend) | `RESEND_API_KEY` + `MAIL_TO` (optionnel `MAIL_FROM`) | `MAIL_FROM` par défaut à `onboarding@resend.dev` |
| Webhook générique | `GENERIC_WEBHOOKS` (optionnel `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`) | plusieurs URL séparées par des virgules ; modèle pour corps personnalisé et en-têtes JSON ; c'est par là que s'intègrent les API tierces (passerelles SMS, etc.) |

Les procédures d'obtention de chaque canal et le format du corps : voir [Guide de déploiement et de connexion multiplateformes · Canaux de transfert des notifications](./DEPLOYMENT.md).
Transfert simultané multicanaux ; l'échec d'un seul canal n'affecte ni les autres ni le stockage des messages ; les messages en double (`duplicated`) ne sont pas transférés deux fois.
Les notifications se rendent automatiquement en trois états selon le contenu (🔐 alerte de code / 💬 nouveau SMS / 🔔 notification d'appareil) : le code entre automatiquement dans le titre et active les capacités renforcées de chaque plateforme (la notification Bark copie le code d'un geste, Bark/ntfy montent la priorité, en-tête violet des cartes Feishu, etc.).

## Étape 6 : configurer la tâche de nettoyage planifiée

1. Worker → **Paramètres → Déclencheurs (Triggers) → Déclencheurs Cron**
2. Cliquez **Ajouter un déclencheur Cron**, mettez `0 17 * * *`, enregistrez
3. Signification : chaque jour à 17:00 UTC (01:00 heure de Pékin), suppression automatique des données dépassant les jours de rétention

## Étape 7 : lier un domaine (optionnel, recommandé)

1. Worker → **Paramètres → Domaines et routes**
2. Cliquez **Ajouter → Domaine personnalisé** et tapez un sous-domaine (p. ex. `sms.votredomaine.com`)
3. Cloudflare crée l'enregistrement DNS et émet le certificat HTTPS automatiquement, effectif en quelques minutes
4. Dès lors, ouvrez directement `https://sms.votredomaine.com` dans le navigateur pour voir la page d'administration

> Sans domaine, utilisez l'adresse par défaut `https://sms-gateway.<votre-sous-domaine>.workers.dev`.

## Étape 8 : vérifier le déploiement

Ouvrez la page d'administration dans le navigateur : vous devez voir la page au nom de votre site (par défaut « SMS Gateway », modifiable via `SITE_NAME` ; connexion activée : vous verrez d'abord la page de connexion). Vérifiez aussi l'API de réception (remplacez `<domaine>` et `<secret>` par les vôtres) :

```
curl "https://<域名>/api/receive?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"name\":\"test\",\"sim\":\"13800138000\",\"from\":\"10086\",\"content\":\"部署测试\"}"
```

Si ça renvoie `{"success":true,...}`, ça marche. Ce SMS de test peut être supprimé depuis la page web.

## Connecter le mobile et les autres appareils

Configurez SmsForwarder Android et le push de notifications des autres appareils selon le [Guide de déploiement et de connexion multiplateformes](./DEPLOYMENT.md), en remplaçant le domaine d'API par l'adresse de votre Worker.

## Déploiement en ligne de commande (alternative, pour qui sait installer wrangler)

Dans ce répertoire (qui contient `wrangler.toml`, avec `main` pointant vers le `worker.js` de ce répertoire), exécutez :

```bash
npm install wrangler        # installation dans le projet recommandée officiellement ; le npm install -g wrangler global convient aussi
npx wrangler login
npx wrangler d1 execute sms-gateway-db --file=schema.sql --remote
npx wrangler secret put RECEIVE_TOKEN
npx wrangler secret put ADMIN_PASSWORD   # nécessaire uniquement si la connexion est activée
npx wrangler secret put SESSION_SECRET   # nécessaire uniquement si la connexion est activée (valeur aléatoire à haute entropie, indépendante du mot de passe)
npx wrangler deploy
```

## Remarques et FAQ

- **Les SMS transférés n'arrivent pas** : vérifiez dans l'ordre ① l'interrupteur principal « Transférer le broadcast SMS » dans les réglages généraux de SmsForwarder (le plus souvent oublié ; s'il est éteint, il décarte silencieusement et tous les tests de canal restent verts) → ② la cohérence du token/URL de la règle de transfert avec le secret du Worker → ③ les journaux en direct du Worker pour voir si les requêtes arrivent
- **Rien reçu sur le canal de notification** : confirmez que la variable de ce canal est configurée avec la bonne valeur ; regardez si les journaux en direct du Worker montrent `notify forward failed:` ; les messages avec `duplicated:true` ne sont pas transférés
- **Quota gratuit du Worker** : 100 000 requêtes/jour, largement suffisant pour un usage personnel ; le quota gratuit D1 est de 5 millions de lectures de lignes/jour
- **Long polling** : la page d'admin se suspend sur `/api/wait` jusqu'à 25 secondes pour attendre les nouveaux messages ; Workers n'a pas de problème de durée de requête et offre la meilleure réactivité temps réel
- **Migration des données** : pour revenir à CF depuis une autre plateforme, exportez les données Turso et importez-les dans D1 (les schémas sont identiques)
