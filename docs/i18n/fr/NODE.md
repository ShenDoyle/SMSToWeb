# Guide de déploiement auto-hébergé (Fly.io / Railway / VPS / local)
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | **Français** | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Synchronisé depuis l'original anglais (fr)

Auto-hébergez SMSToWeb comme conteneur Docker. Processus résident, sans limite de durée de fonction et la meilleure réactivité du long polling ; idéal pour qui a déjà un serveur ou veut déployer sur Fly.io / Railway (situation des quotas gratuits plus bas, dans « Notes plateforme »).

**Fichiers de ce répertoire** : `server.mjs` (entrée sans dépendance pour Node 18+, avec nettoyage quotidien intégré), `app.js` (application principale), `db.js` (couche d'adaptation double Turso / SQLite local), `schema.sql` (création des tables), `Dockerfile`, `package.json`.

---

## Préparation

- Compte Fly.io ou Railway (ou n'importe quel VPS avec Docker)
- La base de données reste Turso (compatible SQLite) ; l'étape 1 ci-dessous la prépare de façon unifiée

## Étape 1 : créer la base Turso

1. Ouvrez [turso.tech](https://turso.tech), cliquez **Start for free now** et connectez-vous avec GitHub
2. Entrez dans la console → **Create Database** :
   - Name : `sms-gateway`
   - Location : choisissez une région proche du serveur
   - Type : Free
3. Après création, entrez dans la page de détails de la base :
   - Relevez la **Database URL** (format `libsql://sms-gateway-xxxx.turso.io`)
   - Cliquez **Create Token** pour créer le jeton d'accès et **copiez-le immédiatement** (il ne s'affiche qu'une fois)
4. Initialisez le schéma : page de détails de la base → **Console** → collez tout le contenu du [`schema.sql`](../../../platforms/node/schema.sql) de ce répertoire → exécutez → succès

> Avec la CLI : `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## Voie A : Fly.io

1. Installez flyctl en local ([guide officiel d'installation](https://fly.io/docs/flyctl/install/)), puis `fly auth login`
2. Dans ce répertoire, exécutez :

```bash
cd platforms/node
fly launch                 # 按提示创建应用：区域自选；询问数据库时选 No（我们用 Turso）
fly secrets set TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io TURSO_AUTH_TOKEN=<你的令牌> RECEIVE_TOKEN=<你的密钥>
fly secrets set ENABLE_AUTH=true ADMIN_PASSWORD=<你的密码>     # 可选
fly deploy
fly status                 # 记下分配的域名 https://<app>.fly.dev
```

3. Vérification : ouvrez `https://<app>.fly.dev` dans le navigateur, vous devez voir la page d'administration ; test de push :

```
curl "https://<app>.fly.dev/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Fly 部署成功\"}"
```

4. Domaine personnalisé : `fly certs add sms.votredomaine.com` et ajoutez le DNS selon les instructions (enregistrement A ou CNAME)

## Voie B : Railway

1. Connectez-vous à [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**, choisissez votre dépôt forké
2. Dans les réglages du service, **Settings → Root Directory** : `platforms/node` (Railway détecte le Dockerfile et compile automatiquement)
3. Ajoutez les variables d'environnement dans le panneau **Variables** (voir le tableau commun ci-dessous ; le `PORT` est injecté par la plateforme, le code est déjà adapté)
4. **Settings → Public Networking → Generate Domain** pour générer le domaine public
5. Vérification comme ci-dessus (en changeant vers votre domaine Railway)

## Voie C : n'importe quel VPS (Docker)

```bash
# 上传本目录到服务器后
cd platforms/node
docker build -t smstoweb .
docker run -d --name smstoweb --restart unless-stopped -p 8787:8787 \
  -e TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io \
  -e TURSO_AUTH_TOKEN=<你的令牌> \
  -e RECEIVE_TOKEN=<你的密钥> \
  smstoweb
# 验证
curl "http://127.0.0.1:8787/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"content\":\"VPS 部署成功\"}"
```

Un reverse proxy avec Caddy/Nginx est recommandé pour ajouter HTTPS. Sans Docker, vous pouvez aussi lancer directement `node server.mjs` (exige Node 18+, zéro dépendance npm ; le mode SQLite local exige Node 22.13+).

## Variables d'environnement (communes aux trois voies)

| Nom | Valeur | Description |
|---|---|---|
| `SQLITE_PATH` (optionnel) | p. ex. `/data/data.db` | **Mode SQLite local** : une fois défini, plus besoin de base externe, les données restent dans un fichier local (exige Node 22.13+, création automatique des tables au premier démarrage ; alternative à Turso, prioritaire s'il est défini) |
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | mode Turso : l'URL relevée à l'étape 1 |
| `TURSO_AUTH_TOKEN` | (le jeton de l'étape 1) | mode Turso : celui qui ne s'affiche qu'une fois |
| `RECEIVE_TOKEN` | longue chaîne aléatoire de votre invention | authentification du push, n'utilisez pas de valeurs d'exemple |
| `ENABLE_AUTH` | `false` | pour la connexion, passez à `true` (**fortement recommandé pour la sécurité** : la page d'admin contient du contenu sensible comme les codes OTP par SMS ; sans connexion, connaître le domaine suffit pour voir tous les messages) |
| `ADMIN_PASSWORD` | mot de passe de votre invention | nécessaire seulement quand `ENABLE_AUTH="true"` |
| `SESSION_SECRET` | valeur aléatoire à haute entropie (≥32 caractères aléatoires) | nécessaire seulement quand `ENABLE_AUTH="true"` ; indépendante du mot de passe ; si elle manque, connexion/authentification échouent de façon sûre, et après rotation toutes les anciennes sessions sont invalidées |
| `RETENTION_DAYS` | `30` | jours de rétention des données |
| `PORT` | défaut `8787` | normalement inutile de le configurer (Railway l'injecte automatiquement) |
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

## Connecter le mobile et les appareils

Configurez SmsForwarder Android et le push de notifications des autres appareils selon le [Guide de déploiement et de connexion multiplateformes](./DEPLOYMENT.md), en utilisant comme domaine l'adresse de votre service.

## Remarques et FAQ

- **Nettoyage planifié** : le processus intègre lui-même le nettoyage chaque jour à 17:00 UTC (01:00 heure de Pékin), sans configuration. Vous pouvez aussi faire appel au planificateur de la plateforme (Fly Machines Cron / Railway Cron) pour appeler `GET /api/cron?token=<RECEIVE_TOKEN>` ; choisissez l'un des deux
- **Avantages du processus résident** : pas de limite de durée de fonction ; le long polling `/api/wait` offre la même expérience que le Cloudflare Worker, avec la meilleure réactivité
- **Quotas gratuits** : Fly.io n'a plus de quota gratuit (seulement une période d'essai de 7 jours / 2 heures de VM pour les nouveaux comptes, facturation à l'usage dès la carte liée, avec un coût très faible en micro-consommation) ; Railway offre un crédit d'essai unique de 5 $ (30 jours de validité) et le plan Hobby à 5 $/mois inclut le même montant d'usage — pour du zéro coût à long terme, la version principale Cloudflare est le premier choix
- **Sauvegarde des données** : en mode Turso, les données sont chez Turso ; changer de serveur ne nécessite que la reconfiguration des variables d'environnement, sans perte de données ; en mode SQLite local, il suffit de sauvegarder périodiquement le fichier de `SQLITE_PATH`
- **Protection de la connexion** : l'endpoint de connexion intègre une limitation de débit — 5 échecs consécutifs par même IP = verrouillage 10 minutes (état en mémoire, remis à zéro au redémarrage du processus)
- **Connexion en http** : avec une IP LAN / http sans TLS, la connexion directe fonctionne (le cookie se dégrade automatiquement, pas de forçage Secure), et la redirection post-connexion marche bien sur les navigateurs comme Alook
- **Diagnostic par les journaux** : `fly logs` / Railway Deployments → Logs / `docker logs smstoweb`
