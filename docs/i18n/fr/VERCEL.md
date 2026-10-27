# Guide de déploiement Vercel
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | **Français** | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Synchronisé depuis l'original anglais (fr)

Déployez SMSToWeb sur Vercel (Edge Function + base de données Turso). Le quota gratuit suffit pour un usage personnel, environ 15 minutes en tout.

**Fichiers de ce répertoire** : `api/[[...route]].js` (entrée), `app.js` (application principale), `db.js` (couche d'adaptation Turso), `schema.sql` (création des tables), `vercel.json` (inclut la configuration de la tâche planifiée).

---

## Déploiement en un clic (recommandé)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb%2Ftree%2Fmain%2Fplatforms%2Fvercel&env=RECEIVE_TOKEN%2CTURSO_DATABASE_URL%2CTURSO_AUTH_TOKEN&project-name=sms-gateway&envDescription=%E6%8E%A8%E9%80%81%E9%89%B4%E6%9D%83%E5%AF%86%E9%92%A5%E4%B8%8E%20Turso%20%E6%95%B0%E6%8D%AE%E5%BA%93%E8%BF%9E%E6%8E%A5%E4%BF%A1%E6%81%AF&envLink=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb)

Il est recommandé de **compléter d'abord l'étape 2 ci-dessous (créer la base Turso) pour disposer des données de connexion**, puis de cliquer sur le bouton : Vercel clonera le sous-répertoire de cette plateforme comme votre dépôt et créera le projet ; remplissez `RECEIVE_TOKEN` (secret d'authentification du push, longue chaîne aléatoire de votre invention) et l'URL / le Token Turso quand ils sont demandés, et le déploiement se fait. Après un déploiement réussi, **exécutez impérativement une fois le SQL de création des tables de l'étape 3** (Vercel ne peut pas créer les tables automatiquement) ; sinon la page s'ouvrira sans données.

---

## Préparation

1. Un compte GitHub (Vercel déploie via le dépôt GitHub)
2. Un compte Vercel ([inscription](https://vercel.com/signup), connexion directe avec GitHub)

## Étape 1 : préparer le dépôt de code

1. Ouvrez le dépôt GitHub du projet et cliquez **Fork** en haut à droite (ou utilisez votre propre dépôt déjà poussé)
2. Le fork terminé, vous disposez d'une copie du projet que vous pouvez modifier librement

## Étape 2 : créer la base Turso

Turso propose une base compatible SQLite (quota gratuit : 100 bases, 5 Go de stockage, 500 millions de lectures de lignes/mois).

1. Ouvrez [turso.tech](https://turso.tech), cliquez **Start for free now** et connectez-vous avec GitHub
2. Entrez dans la console → **Create Database** (créer une base) :
   - Name : `sms-gateway`
   - Location : choisissez une région proche (p. ex. Singapore / Hong Kong)
   - Type : Free
3. Après création, entrez dans la page de détails de la base :
   - Relevez la **Database URL** (format `libsql://sms-gateway-xxxx.turso.io`)
   - Cliquez **Create Token** (ou Turso Platform Tokens) pour créer le jeton d'accès et **copiez-le immédiatement** (il ne s'affiche qu'une fois)
4. Initialisez le schéma : page de détails de la base → **Console** (console SQL web) → collez tout le contenu du [`schema.sql`](../../../platforms/vercel/schema.sql) de ce répertoire → exécutez → succès (les tables `messages` et `devices` sont créées)

> Vous pouvez aussi utiliser la CLI Turso : `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Étape 3 : importer le dépôt dans Vercel

1. Connectez-vous à [vercel.com](https://vercel.com) → **Add New → Project**
2. Dans la liste **Import Git Repository**, trouvez votre dépôt forké et cliquez **Import**
3. Sur la page de configuration, dépliez **Root Directory** et choisissez `platforms/vercel`
   —— Vercel reconnaîtra automatiquement le `vercel.json` et le répertoire `api/` du répertoire, sans autre configuration
4. Ne cliquez pas encore sur Deploy ; faites d'abord la configuration des variables d'environnement de l'étape 4 (elles s'ajoutent dans la zone **Environment Variables** de la même page)

## Étape 4 : configurer les variables d'environnement

Ajoutez-les une à une dans les **Environment Variables** de la page de configuration de déploiement (modifiables ensuite dans Project → Settings) :

| Nom | Valeur | Description |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | l'URL relevée à l'étape 2 |
| `TURSO_AUTH_TOKEN` | (le jeton de l'étape 2) | celui qui ne s'affiche qu'une fois |
| `RECEIVE_TOKEN` | longue chaîne aléatoire de votre invention | authentification du push, n'utilisez pas de valeurs d'exemple |
| `ENABLE_AUTH` | `false` | pour la connexion, passez à `true` |
| `ADMIN_PASSWORD` | mot de passe de votre invention | nécessaire seulement quand `ENABLE_AUTH="true"` |
| `SESSION_SECRET` | valeur aléatoire à haute entropie (≥32 caractères aléatoires) | nécessaire seulement quand `ENABLE_AUTH="true"` ; indépendante du mot de passe, avec une valeur indépendante configurée séparément sur chaque plateforme ; si elle manque, connexion/authentification échouent de façon sûre, et après rotation toutes les anciennes sessions sont invalidées |
| `RETENTION_DAYS` | `30` | jours de rétention des données |
| `CRON_SECRET` | **la même valeur que RECEIVE_TOKEN** | Vercel Cron ajoute automatiquement `Bearer $CRON_SECRET` à l'appel de /api/cron |
| `FEISHU_WEBHOOK` (optionnel `FEISHU_SECRET`) | (optionnel) webhook du bot de groupe Feishu | une fois configuré, les nouveaux messages sont transférés automatiquement vers le groupe Feishu ; si la sécurité du bot utilise « vérification par signature », configurez en plus `FEISHU_SECRET` |
| `WECOM_WEBHOOK` | (optionnel) webhook du bot de groupe WeCom | une fois configuré, les nouveaux messages sont transférés automatiquement vers le groupe WeCom |
| `DINGTALK_WEBHOOK` | (optionnel) webhook du bot de groupe DingTalk | la sécurité par signature exige en plus `DINGTALK_SECRET` |
| `SERVERCHAN_SENDKEY` | (optionnel) SendKey ServerChan | push WeChat |
| `PUSHPLUS_TOKEN` | (optionnel) token PushPlus | push WeChat |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | (optionnel) bot Telegram | effectif seulement si les deux sont configurés |
| `BARK_DEVICE_KEY` | (optionnel) Key de l'appareil Bark | serveur auto-hébergé : configurez en plus `BARK_URL` ; défaut : officiel |
| `NTFY_URL` (optionnel `NTFY_TOKEN`) | (optionnel) URL du topic ntfy | URL complète, p. ex. `https://ntfy.sh/my-sms` ; topics protégés : configurez en plus `NTFY_TOKEN` (Token ou user:password) |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | (optionnel) Gotify | adresse du serveur + token d'application |
| `RESEND_API_KEY` + `MAIL_TO` | (optionnel) e-mail (Resend) | `MAIL_FROM` optionnel, défaut `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS` (optionnel `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`) | (optionnel) webhook générique | plusieurs URL séparées par des virgules ; modèle optionnel pour le corps personnalisé, `GENERIC_WEBHOOK_HEADERS` (chaîne JSON) pour les en-têtes |
| `SITE_NAME` / `SITE_ICON` | (optionnel) | nom du site / URL de l'icône |
| `NOTIFY_LINK` | (optionnel) | URL d'accueil de la page d'admin ; une fois configurée, tous les canaux de notification ajoutent l'entrée « Ouvrir l'admin », omise automatiquement si non configurée |

Une fois tout rempli, cliquez **Deploy** et attendez environ 1 minute la fin du déploiement.

## Étape 5 : vérifier le déploiement

1. Sur la page de déploiement terminé, cliquez **Continue to Dashboard** et relevez le domaine attribué en haut (format `https://xxx.vercel.app`)
2. Ouvrez ce domaine dans le navigateur : vous devez voir la page d'administration (par défaut « SMS Gateway » ; connexion activée : vous verrez d'abord la page de connexion)
3. Vérifiez l'API de push (remplacez `<domaine>` et `<secret>` par les vôtres) :

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Vercel 部署成功\"}"
```

Si ça renvoie `{"success":true,...}`, ça marche, et le message doit apparaître aussitôt sur la page web.

## Étape 6 : connecter le mobile et les appareils

Configurez SmsForwarder Android (les SMS passent par `/api/receive`) et le push de notifications des autres appareils (par `/api/push`) selon le [Guide de déploiement et de connexion multiplateformes](./DEPLOYMENT.md), en utilisant comme domaine votre `xxx.vercel.app` (ou un domaine personnalisé lié).

Lier un domaine personnalisé : Project → **Settings → Domains** → Add, puis suivez les instructions pour ajouter un enregistrement CNAME dans le DNS du domaine — la valeur cible est celle affichée sur la page Domains (Vercel attribue à chaque projet une adresse propre `xxxxxx.vercel-dns.com`).

## Remarques et FAQ

- **Nettoyage planifié** : `vercel.json` configure déjà l'appel de `/api/cron` chaque jour à 17:00 UTC (01:00 heure de Pékin) pour purger les données expirées. Vercel Cron envoie automatiquement `Authorization: Bearer $CRON_SECRET`, donc `CRON_SECRET` doit correspondre à `RECEIVE_TOKEN`
- **Limites du plan Hobby (gratuit)** : le cron n'accepte qu'une fois par jour (ce projet en fait exactement une par jour, conforme ; l'heure réelle de déclenchement peut varier dans l'heure configurée, c'est normal) ; les fonctions Edge doivent **commencer à répondre en 25 secondes** (ensuite le streaming peut continuer 300 secondes), et le long polling `/api/wait` de la page d'admin se suspend exactement 25 secondes, à la limite — s'il est coupé avant terme, la boucle de polling du frontend retente automatiquement, **sans impact fonctionnel**, seul l'avis de nouveaux messages arrive un peu en retard
- **Edge Runtime** : l'entrée déclare `runtime = "edge"`, démarrage à froid rapide et exécution sur les nœuds edge mondiaux
- **Diagnostic d'échec de déploiement** : presque toujours une variable d'environnement non renseignée — sans `TURSO_*` : 500 avec "config error" ; vérifiez que le Root Directory est `platforms/vercel`
- **Mettre à jour le code** : poussez vers votre dépôt forké et Vercel redéploie automatiquement
