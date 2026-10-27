# Guide de déploiement Tencent EdgeOne Makers
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | **Français** | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Synchronisé depuis l'original anglais (fr)

Déployez SMSToWeb sur Tencent EdgeOne Makers (anciennement EdgeOne Pages, Functions + base de données Turso). Bonne expérience d'accès depuis la Chine, environ 15 minutes en tout.

**Fichiers de ce répertoire** : `functions/index.js` (entrée dédiée à la route racine `/`, source unique de toute la logique et de la liste blanche ENV_KEYS), `functions/[[default]].js` (fallback des autres routes, se contente de réexporter index.js, pas de maintenance en double), `app.js` (application principale), `db.js` (couche d'adaptation Turso), `schema.sql` (création des tables).

---

## Préparation

1. Un compte Tencent Cloud ([inscription](https://cloud.tencent.com), vérification d'identité requise)
2. Un compte GitHub (EdgeOne Makers permet de déployer depuis un dépôt Git)

## Étape 1 : préparer le dépôt de code

Ouvrez le dépôt GitHub du projet et cliquez **Fork** en haut à droite (ou utilisez votre propre dépôt déjà poussé).

## Étape 2 : créer la base Turso

Turso propose une base compatible SQLite (quota gratuit : 100 bases, 5 Go de stockage, 500 millions de lectures de lignes/mois). Depuis EdgeOne Functions, l'accès aux bases externes se fait sans problème.

1. Ouvrez [turso.tech](https://turso.tech), cliquez **Start for free now** et connectez-vous avec GitHub
2. Entrez dans la console → **Create Database** :
   - Name : `sms-gateway`
   - Location : Singapore / Hong Kong recommandé (faible latence depuis la Chine)
   - Type : Free
3. Après création, entrez dans la page de détails de la base :
   - Relevez la **Database URL** (format `libsql://sms-gateway-xxxx.turso.io`)
   - Cliquez **Create Token** pour créer le jeton d'accès et **copiez-le immédiatement** (il ne s'affiche qu'une fois)
4. Initialisez le schéma : page de détails de la base → **Console** → collez tout le contenu du [`schema.sql`](../../../platforms/edgeone/schema.sql) de ce répertoire → exécutez → succès

> Vous pouvez aussi utiliser la CLI Turso : `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Étape 3 : créer le projet dans EdgeOne Makers

1. Connectez-vous à la console Tencent Cloud → cherchez **EdgeOne Makers** (anciennement « EdgeOne Pages », ou ouvrez [console.cloud.tencent.com/edgeone/pages](https://console.cloud.tencent.com/edgeone/pages))
2. Cliquez **Créer un projet** → choisissez **Importer depuis un dépôt Git** → autorisez GitHub et sélectionnez votre dépôt forké
3. Configuration du build :
   - **Répertoire racine** : `platforms/edgeone`
   - Framework : choisissez « Sans framework / Other » ou laissez vide (Functions pur n'a pas besoin de build)
4. Dans la zone de configuration des variables d'environnement, ajoutez d'abord les variables (voir étape 4), puis lancez le déploiement
5. Attendez la fin du déploiement (environ 1 minute) et relevez le domaine par défaut attribué (p. ex. `*.edgeone.app`)

## Étape 4 : configurer les variables d'environnement

Ajoutez-les une à une dans **Paramètres → Variables d'environnement** du projet (Functions les lit via le paramètre `env` de `onRequest`) :

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

Après enregistrement, redéploiez pour que ce soit effectif.

## Étape 5 : vérifier le déploiement

1. Ouvrez le domaine attribué dans le navigateur : vous devez voir la page d'administration (par défaut « SMS Gateway » ; connexion activée : vous verrez d'abord la page de connexion)
2. Vérifiez l'API de push :

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"EdgeOne 部署成功\"}"
```

Si ça renvoie `{"success":true,...}`, ça marche, et le message doit apparaître aussitôt sur la page web.

## Étape 6 : lier un domaine personnalisé (recommandé pour l'accès depuis la Chine)

1. **Paramètres → Domaine personnalisé** du projet → ajoutez votre domaine (p. ex. `sms.votredomaine.com`)
2. Suivez les instructions pour ajouter dans le DNS du domaine un enregistrement CNAME pointant vers l'adresse attribuée par EdgeOne
3. Le domaine doit avoir complété l'enregistrement ICP (exigence des nœuds nationaux de Tencent Cloud) ; les domaines sans ICP ne se résolvent pas

## Étape 7 : configurer le nettoyage planifié (cron externe)

EdgeOne Makers n'a pas encore de tâches planifiées natives ; utilisez n'importe quel service externe de cron gratuit pour appeler chaque jour l'API de nettoyage :

1. Ouvrez [cron-job.org](https://cron-job.org), inscrivez-vous et **Create cronjob** :
   - URL : `https://<votre-domaine>/api/cron?token=<votre RECEIVE_TOKEN>`
   - Schedule : chaque jour (p. ex. 01:00 heure de Pékin, soit 17:00 UTC)
2. Enregistrez et activez. À l'heure dite, la passerelle supprime automatiquement les données de plus de `RETENTION_DAYS` jours

## Connecter le mobile et les appareils

Configurez SmsForwarder Android et le push de notifications des autres appareils selon le [Guide de déploiement et de connexion multiplateformes](./DEPLOYMENT.md), en utilisant comme domaine votre domaine EdgeOne.

## Remarques et FAQ

- **404 sur la route racine (important, vérifié en 2026-10)** : dans les règles de routage Functions d'EdgeOne Makers, le fallback `[[default]].js` ne cale que les routes non racines comme `/foo`, `/api/xxx` ; **la route racine `/` ne reconnaît que `functions/index.js`** — sans ce fichier, la page d'accueil tombe directement sur la 404 par défaut de la plateforme (les API fonctionnent normalement). Ce répertoire embarque déjà `functions/index.js` pour régler le problème (source unique de la logique et de la liste blanche ENV_KEYS ; `[[default]].js` ne fait que le réexporter, pas de maintenance en double)
- **Long polling** : la limite de durée d'exécution de Functions est assez juste et le `/api/wait` (25 secondes en attente) peut être coupé avant terme — le frontend retente automatiquement, sans impact fonctionnel
- **Diagnostic d'échec de déploiement** : le répertoire racine doit être `platforms/edgeone` ; sans les variables `TURSO_*` : 500 avec "config error"
- **Mettre à jour le code** : push vers le dépôt GitHub et redéploiement automatique
