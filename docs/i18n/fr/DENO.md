# Guide de déploiement Deno Deploy
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | **Français** | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Synchronisé depuis l'original anglais (fr)

Déployez SMSToWeb sur Deno Deploy (runtime natif Deno + base de données Turso). C'est la plateforme la plus proche, sémantiquement, du Cloudflare Worker ; le plan gratuit offre 1 million de requêtes/mois, environ 15 minutes en tout.

> Note de plateforme : Deno Deploy est passé à la nouvelle génération, avec une console sur [console.deno.com](https://console.deno.com) (l'ancien dash.deno.com est fermé), avec un mode de build type CI basé sur Git.

**Fichiers de ce répertoire** : `main.js` (entrée, avec `Deno.serve` et le nettoyage planifié intégré `Deno.cron`), `app.js` (application principale), `db.js` (couche d'adaptation Turso), `schema.sql` (création des tables).

---

## Préparation

1. Un compte GitHub
2. Un compte Deno Deploy ([inscription](https://console.deno.com), connexion directe avec GitHub)

## Étape 1 : préparer le dépôt de code

1. Ouvrez le dépôt GitHub du projet et cliquez **Fork** en haut à droite (ou utilisez votre propre dépôt déjà poussé)

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
4. Initialisez le schéma : page de détails de la base → **Console** → collez tout le contenu du [`schema.sql`](../../../platforms/deno/schema.sql) de ce répertoire → exécutez → succès

> Vous pouvez aussi utiliser la CLI Turso : `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Étape 3 : créer l'app dans Deno Deploy et lier le dépôt

1. Connectez-vous à [console.deno.com](https://console.deno.com) → cliquez **+ New App** (nouvelle application)
2. Choisissez **déployer depuis un dépôt GitHub**, autorisez et sélectionnez votre dépôt forké
3. Configurez le build (Build Configuration) :
   - **Répertoire d'exécution** (Runtime working directory) : `platforms/deno`
   - **Entrypoint** (fichier d'entrée) : `main.js`
4. Ajoutez d'abord les variables d'environnement (voir étape 4), puis déclenchez le premier déploiement
5. Déploiement terminé, chaque push vers le dépôt GitHub reconstruit automatiquement

## Étape 4 : configurer les variables d'environnement

Ajoutez-les une à une dans **Settings → Environment Variables** de l'app (possible aussi sur la page de configuration à la création) :

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

Après enregistrement, attendez que le redéploiement automatique prenne effet.

## Étape 5 : vérifier le déploiement

1. Relevez le domaine attribué (format `https://<nom-app>.<organisation>.deno.net`)
2. Ouvrez ce domaine dans le navigateur : vous devez voir la page d'administration (par défaut « SMS Gateway » ; connexion activée : vous verrez d'abord la page de connexion)
3. Vérifiez l'API de push :

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Deno Deploy 部署成功\"}"
```

Si ça renvoie `{"success":true,...}`, ça marche, et le message doit apparaître aussitôt sur la page web.

## Étape 6 : connecter le mobile et les appareils

Configurez SmsForwarder Android et le push de notifications des autres appareils selon le [Guide de déploiement et de connexion multiplateformes](./DEPLOYMENT.md), en utilisant comme domaine votre `xxx.deno.net`.

Domaine personnalisé : dans l'onglet **Domains** de l'organisation, ajoutez le domaine et attribuez-le à votre app, puis suivez les instructions pour ajouter dans le DNS du domaine le CNAME (ou l'enregistrement A) et l'enregistrement de vérification ; le certificat HTTPS est émis automatiquement.

## Remarques et FAQ

- **Nettoyage planifié** : `Deno.cron` s'enregistre automatiquement au déploiement (chaque jour à 17:00 UTC = 01:00 heure de Pékin), sans aucune configuration et sans déclenchement manuel possible pour tester — pour vérifier, regardez que les données Turso diminuent comme prévu
- **Quota gratuit** : 1 million de requêtes/mois, 10 heures d'Active CPU, 20 Gio de sortie, largement suffisant pour un usage personnel
- **Long polling** : Deno Deploy n'a pas de limite stricte de durée par requête et le long polling de 25 secondes de `/api/wait` fonctionne bien ; les instances inactives peuvent être recyclées et redémarrées par la plateforme (les long polling interrompus sont retentés automatiquement par le frontend) ; la réactivité est pratiquement la même que la version Worker
- **Diagnostic d'échec de déploiement** : l'Entrypoint doit être `main.js` et le répertoire d'exécution `platforms/deno` ; sans les variables `TURSO_*` : 500 avec "config error"
- **Mettre à jour le code** : push vers le dépôt GitHub et redéploiement automatique
