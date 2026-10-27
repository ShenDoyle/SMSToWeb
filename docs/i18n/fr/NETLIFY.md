# Guide de déploiement Netlify
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | **Français** | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Synchronisé depuis l'original anglais (fr)

Déployez SMSToWeb sur Netlify (Functions v2 + base de données Turso). Environ 15 minutes en tout.

**Fichiers de ce répertoire** : `functions/api.mjs` (entrée, avec `path: "/*"` qui capture toutes les routes), `functions/cron.mjs` (Scheduled Function de nettoyage planifié), `app.js` (application principale), `db.js` (couche d'adaptation Turso), `schema.sql` (création des tables), `netlify.toml` (configuration du site).

---

## Déploiement en un clic (recommandé)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/ShenDoyle/SMSToWeb)

Le bouton clone le dépôt vers votre GitHub et ouvre l'assistant de création ; deux avertissements :

1. **Dans la configuration de build, remplissez le Base directory avec `platforms/netlify`** (le `netlify.toml` de cette plateforme est dans ce sous-répertoire ; une fois bien rempli, les commandes de build se prennent en charge automatiquement) ; le reste par défaut
2. Il est recommandé de compléter d'abord l'étape 2 ci-dessous (créer la base Turso) pour disposer des données de connexion ; après création du site, remplissez `RECEIVE_TOKEN` / `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` dans **Site configuration → Environment variables** et redéploiez ; enfin exécutez le SQL de création des tables de l'étape 3 (Netlify ne peut pas créer les tables automatiquement)

---

## Préparation

1. Un compte GitHub
2. Un compte Netlify ([inscription](https://app.netlify.com/signup), connexion directe avec GitHub)

## Étape 1 : préparer le dépôt de code

Ouvrez le dépôt GitHub du projet et cliquez **Fork** en haut à droite (ou utilisez votre propre dépôt déjà poussé).

## Étape 2 : créer la base Turso

Turso propose une base compatible SQLite (quota gratuit : 100 bases, 5 Go de stockage, 500 millions de lectures de lignes/mois).

1. Ouvrez [turso.tech](https://turso.tech), cliquez **Start for free now** et connectez-vous avec GitHub
2. Entrez dans la console → **Create Database** :
   - Name : `sms-gateway`
   - Location : choisissez une région proche (p. ex. Singapore / Hong Kong)
   - Type : Free
3. Après création, entrez dans la page de détails de la base :
   - Relevez la **Database URL** (format `libsql://sms-gateway-xxxx.turso.io`)
   - Cliquez **Create Token** pour créer le jeton d'accès et **copiez-le immédiatement** (il ne s'affiche qu'une fois)
4. Initialisez le schéma : page de détails de la base → **Console** → collez tout le contenu du [`schema.sql`](../../../platforms/netlify/schema.sql) de ce répertoire → exécutez → succès

> Vous pouvez aussi utiliser la CLI Turso : `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Étape 3 : importer le dépôt dans Netlify

1. Connectez-vous à [app.netlify.com](https://app.netlify.com) → **Add new project → Import an existing project**
2. Choisissez **Deploy with GitHub**, autorisez et sélectionnez votre dépôt forké dans la liste
3. Page de configuration de déploiement (Site settings for…) :
   - **Base directory** : mettez `platforms/netlify`
   - Build command / Publish directory : laissez par défaut (le `netlify.toml` est déjà dans le répertoire et s'applique automatiquement)
4. Dépliez en bas **Show advanced → New variable** et ajoutez d'abord les variables d'environnement (voir étape 4), puis cliquez **Deploy**

## Étape 4 : configurer les variables d'environnement

Ajoutez-les dans les options avancées de la page de configuration de déploiement (modifiables ensuite dans **Project configuration → Environment variables**) :

| Nom | Valeur | Description |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | l'URL relevée à l'étape 2 |
| `TURSO_AUTH_TOKEN` | (le jeton de l'étape 2) | celui qui ne s'affiche qu'une fois |
| `RECEIVE_TOKEN` | longue chaîne aléatoire de votre invention | authentification du push, n'utilisez pas de valeurs d'exemple |
| `ENABLE_AUTH` | `false` | pour la connexion, passez à `true` |
| `ADMIN_PASSWORD` | mot de passe de votre invention | nécessaire seulement quand `ENABLE_AUTH="true"` |
| `SESSION_SECRET` | valeur aléatoire à haute entropie (≥32 caractères aléatoires) | nécessaire seulement quand `ENABLE_AUTH="true"` ; indépendante du mot de passe, avec une valeur indépendante configurée séparément sur chaque plateforme ; si elle manque, connexion/authentification échouent de façon sûre, et après rotation toutes les anciennes sessions sont invalidées |
| `RETENTION_DAYS` | `30` | jours de rétention des données |
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

Cliquez **Deploy** et attendez environ 1 minute la fin du déploiement.

## Étape 5 : vérifier le déploiement

1. Déploiement terminé, relevez le domaine du site (format `https://xxx.netlify.app`)
2. Ouvrez ce domaine dans le navigateur : vous devez voir la page d'administration (par défaut « SMS Gateway » ; connexion activée : vous verrez d'abord la page de connexion)
3. Vérifiez l'API de push :

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Netlify 部署成功\"}"
```

Si ça renvoie `{"success":true,...}`, ça marche, et le message doit apparaître aussitôt sur la page web.

## Étape 6 : connecter le mobile et les appareils

Configurez SmsForwarder Android et le push de notifications des autres appareils selon le [Guide de déploiement et de connexion multiplateformes](./DEPLOYMENT.md), en utilisant comme domaine votre `xxx.netlify.app`.

Domaine personnalisé : **Project configuration → Change site name** (changer le sous-domaine) ou **Domain management → Add a domain** (domaine propre, ajoutez le DNS selon les instructions).

## Remarques et FAQ

- **Nettoyage planifié** : `functions/cron.mjs` est une Netlify Scheduled Function qui s'enregistre automatiquement après déploiement (chaque jour à 17:00 UTC = 01:00 heure de Pékin), sans configuration supplémentaire. Vérification : la page **Functions** du site montre la fonction `cron` et son état de planification
- **Durée des fonctions et réactivité temps réel** : la limite d'exécution par défaut des fonctions est aujourd'hui de 60 secondes (identique sur tous les plans) ; le long polling `/api/wait` de la page d'admin (25 secondes en attente) peut attendre son terme, avec une bonne réactivité ; si vous voulez l'ultra-réactivité, Cloudflare / auto-hébergé reste le meilleur choix
- **Quota gratuit** : depuis 2025-09, les nouveaux comptes utilisent des crédits (plan Free avec 300 crédits/mois, la consommation de fonctions est comptabilisée en GB-heure), suffisant pour un usage personnel modeste ; les anciens comptes peuvent garder leur plan d'origine
- **Diagnostic d'échec de déploiement** : le Base directory doit être `platforms/netlify` ; sans les variables `TURSO_*` : 500 avec "config error" ; le détail des erreurs se voit dans **Functions → api → Logs** du site
- **Mettre à jour le code** : push vers le dépôt GitHub et redéploiement automatique
