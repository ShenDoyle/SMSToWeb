# SMSToWeb – Guide de déploiement et de connexion multiplateformes
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | **Français** | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Synchronisé depuis l'original anglais (fr)

Ce système se compose de deux parties : **côté réception** (clients de push de chaque plateforme) + **passerelle cloud** (une plateforme au choix parmi six : Cloudflare / Vercel / Deno / Netlify / EdgeOne Makers / Docker auto-hébergé, voir [PLATFORMS.md](./PLATFORMS.md) ; la méthode de connexion est partout identique).
Les SMS ne sont qu'un des chemins d'entrée — tout appareil/script capable d'envoyer une requête HTTP peut pousser des notifications sur la même page web pour les consulter.

```
安卓(SmsForwarder)──┐  短信+应用通知
iOS(快捷指令)───────┤
Linux(curl/ntfy)────┼──→ POST /api/receive（短信）或 /api/push（通用通知）
Windows(PowerShell)─┤         │
macOS(快捷指令)─────┘         ▼
                        Cloudflare Worker ──→ D1 存储 ──→ 统一网页（来源筛选）
                              │
                              └──（可选）多渠道通知 → 飞书/企微/钉钉/TG/Bark/邮件…
```

---

## 1. Configuration cloud (côté Cloudflare)

### 1. Variables et secrets

Après avoir déployé le Worker, configurez dans **Workers et Pages → sms-gateway → Paramètres → Variables and Secrets** :

| Nom | Type | Requis | Description |
|---|---|---|---|
| `RECEIVE_TOKEN` | Secret | Oui | jeton d'authentification du push ; inventez votre propre chaîne aléatoire (n'utilisez pas la valeur d'exemple) |
| `ADMIN_PASSWORD` | Secret | à la connexion activée | mot de passe de la page d'administration, un mot de passe fort est recommandé ; s'il manque, les APIs d'admin refusent toujours l'accès (échec sûr en cas de config absente) et journalisent une alerte |
| `ENABLE_AUTH` | Texte | Non | `"true"` active la connexion (**fortement recommandé pour la sécurité** : la page d'admin contient du contenu sensible comme les codes OTP par SMS ; sans connexion, elle est ouverte à quiconque connaît le domaine) ; `"false"` ou non défini = sans connexion |
| `FEISHU_WEBHOOK` | Texte | Non | webhook du bot de groupe Feishu ; une fois configuré, les nouveaux messages sont transférés automatiquement vers le groupe Feishu (pour la vérification par signature, configurez en plus `FEISHU_SECRET`) |
| `FEISHU_SECRET` | Secret | Non | uniquement si la sécurité du bot Feishu utilise « vérification par signature » ; le programme calcule la signature automatiquement |
| `WECOM_WEBHOOK` | Texte | Non | webhook du bot de groupe WeCom |
| `DINGTALK_WEBHOOK` | Texte | Non | webhook du bot de groupe DingTalk (la sécurité par signature exige en plus `DINGTALK_SECRET`) |
| `SERVERCHAN_SENDKEY` | Texte | Non | SendKey de ServerChan (push WeChat) |
| `PUSHPLUS_TOKEN` | Texte | Non | jeton PushPlus (push WeChat) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Texte | Non | jeton du bot Telegram + ID de chat/groupe |
| `BARK_DEVICE_KEY` | Texte | Non | Key de l'appareil Bark (serveur auto-hébergé : configurez en plus `BARK_URL`, défaut : officiel) |
| `NTFY_URL` | Texte | Non | URL complète du topic ntfy, p. ex. `https://ntfy.sh/my-sms` (topics protégés : configurez en plus `NTFY_TOKEN`) |
| `NTFY_TOKEN` | Texte | Non | jeton d'accès des topics protégés ntfy : collez directement l'Access Token (via Bearer) ; serveur auto-hébergé : format `user:password` (via Basic) |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | Texte | Non | adresse du serveur Gotify (sans `/message`) + jeton d'application |
| `RESEND_API_KEY` + `MAIL_TO` | Texte | Non | e-mail (API Resend) ; `MAIL_FROM` optionnel, défaut `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS` | Texte | Non | webhooks génériques, plusieurs URL séparées par des virgules ; `GENERIC_WEBHOOK_TEMPLATE` optionnel pour le corps personnalisé, `GENERIC_WEBHOOK_HEADERS` pour les en-têtes |
| `GENERIC_WEBHOOK_HEADERS` | Texte | Non | en-têtes personnalisés du webhook générique, en chaîne JSON d'objet, p. ex. `{"Authorization":"Bearer xxx"}` |
| `NOTIFY_LINK` | Texte | Non | URL d'accueil de la page d'administration ; une fois configurée, tous les canaux de notification ajoutent une entrée « Ouvrir l'admin » (bouton Feishu, ligne de lien de chaque canal, url de Bark, click de ntfy, etc.) ; omise automatiquement si non configurée |
| `SESSION_SECRET` | Secret | obligatoire avec la connexion activée | secret de signature de session de connexion : **valeur aléatoire à haute entropie (≥32 caractères aléatoires recommandés), totalement indépendante du mot de passe admin** ; CF et EO (et chaque plateforme) doivent configurer des valeurs indépendantes ; interdiction absolue de le committer dans Git ou de réutiliser le mot de passe. S'il manque, connexion et authentification échouent de façon sûre (connexion 500, APIs d'admin 401), sans repli dérivé du mot de passe. Après rotation, toutes les anciennes sessions sont invalidées et il faut se reconnecter ; la session dure 30 minutes, la déconnexion n'efface que le cookie du navigateur ; un jeton copié peut rester valide dans la limite du TTL |
| `RETENTION_DAYS` | Texte | Non | jours de rétention des données, 30 par défaut, effectif immédiatement après modification |
| `WAIT_MAX_SECONDS` | Texte | Non | secondes maximales de suspension du long polling `/api/wait`, 25 par défaut (3–25). **Netlify Functions a un plafond par défaut de 10s → mettez `8`** ; pour Vercel Edge, `20` recommandé. Le frontend applique un backoff exponentiel en cas d'échec et ne saturera pas la fonction |

> **Deux conseils de sécurité**
> 1. Activez très fortement la connexion de la page d'admin (`ENABLE_AUTH="true"`) avec un mot de passe fort dans `ADMIN_PASSWORD` ; l'endpoint de connexion intègre une limitation de débit (5 échecs consécutifs par même IP = verrouillage 10 minutes), et `/api/receive`, `/api/push` renvoient 429 au-delà de 120 écritures par minute (rétablissement automatique peu après).
> 2. Le jeton de push est compatible avec le passage en URL `?token=` (cas SmsForwarder) ; le jeton apparaîtra dans l'URL et peut finir dans les journaux d'accès de la plateforme ; si cela vous gêne, utilisez POST + l'en-tête `Authorization: Bearer <RECEIVE_TOKEN>`, les deux méthodes sont prises en charge.

### 2. Canaux de transfert des notifications (optionnel ; seul ce qui est configuré est transféré)

Il suffit d'ajouter les variables correspondantes dans la page « Variables d'environnement / Variables » de la plateforme de déploiement pour les activer ; **si rien n'est configuré, rien n'est transféré, sans impact sur le stockage des messages ni la consultation web**.
Transfert simultané multicanaux ; l'échec d'un canal n'affecte pas les autres ; les messages en double (`duplicated:true`) ne sont pas transférés deux fois.

Les notifications se rendent automatiquement en **trois états** selon le contenu (identique sur tous les canaux) : code de vérification détecté → **alerte de code de vérification** (le code passe dans le titre/le grand texte de la carte ; la notification Bark copie le code d'un geste, Bark et ntfy montent la priorité) ; SMS sans code → **nouveau SMS** ; push d'app/appareil → **notification d'appareil**. Avec la variable optionnelle `NOTIFY_LINK` configurée, chaque canal ajoute automatiquement l'entrée « Ouvrir l'admin » ; sinon elle est omise.

Le corps par défaut du webhook générique est en JSON, avec les nouveaux champs `type` (`verify`/`sms`/`notify`) et `code` (le code détecté, chaîne vide si rien) ; les modèles `GENERIC_WEBHOOK_TEMPLATE` prennent en charge en conséquence les placeholders `{{type}}`/`{{code}}`.

Procédure d'obtention de chaque canal :

**Bot de groupe Feishu** — `FEISHU_WEBHOOK` (optionnel `FEISHU_SECRET`)
1. Groupe cible dans Feishu → Paramètres → Bots de groupe → Ajouter un bot → **Bot personnalisé**
2. Récupérez l'adresse du webhook, du type `https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx`, et collez-la dans la variable
3. Sécurité, au choix : **mot-clé personnalisé** (recommandé : un mot-clé comme `短信` suffit, rien d'autre à configurer) ; **vérification par signature** (collez la clé dans `FEISHU_SECRET`, le programme calcule la signature automatiquement) ; allowlist IP (l'IP sortante du Worker n'est pas fixe — ne choisissez pas)

**Bot de groupe WeCom** — `WECOM_WEBHOOK`
1. Groupe cible dans WeCom → paramètres du groupe (en haut à droite) → Bots de groupe → Ajouter un bot → Créer
2. Copiez l'adresse du webhook, du type `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx`, et collez-la dans la variable

**Bot de groupe DingTalk** — `DINGTALK_WEBHOOK` (optionnel `DINGTALK_SECRET`)
1. Groupe cible dans DingTalk → Paramètres du groupe → Assistant intelligent de groupe → Ajouter un bot → **Personnalisé** (accès webhook)
2. Pour la sécurité, il est recommandé de choisir **signature supplémentaire** : collez la clé affichée sur la page (préfixée SEC) dans `DINGTALK_SECRET` ; sans config, connexion directe sans signature
3. Copiez l'adresse du webhook (du type `https://oapi.dingtalk.com/robot/send?access_token=xxxx`) et collez-la dans `DINGTALK_WEBHOOK`

**ServerChan (push WeChat)** — `SERVERCHAN_SENDKEY`
1. Ouvrez [sct.ftqq.com](https://sct.ftqq.com) et connectez-vous par QR code WeChat
2. Copiez le **SendKey** de la page d'accueil (du type `SCTxxxxxxxxxxxx`) et collez-le dans la variable ; les messages arrivent dans votre WeChat via le compte de service « Fangtang »

**PushPlus (push WeChat)** — `PUSHPLUS_TOKEN`
1. Ouvrez [pushplus.plus](https://www.pushplus.plus) et connectez-vous par QR code WeChat
2. Copiez le **token** de la page d'accueil et collez-le dans la variable ; après avoir suivi le compte officiel, vous recevrez les push dans WeChat

**Bot Telegram** — `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (effectif seulement si les deux sont configurés)
1. Dans TG, cherchez [@BotFather](https://t.me/BotFather) → `/newbot`, suivez les étapes → vous obtenez un Bot Token (du type `123456:ABC-xxx`)
2. Obtenez le `chat_id` : envoyez d'abord un message à votre bot, puis ouvrez dans le navigateur `https://api.telegram.org/bot<votreToken>/getUpdates` et cherchez `chat.id` dans le JSON renvoyé (en groupe : ajoutez le bot au groupe et envoyez un message ; l'ID du groupe se récupère pareil)
3. Saisissez chaque valeur dans `TELEGRAM_BOT_TOKEN` et `TELEGRAM_CHAT_ID`

**Bark (push iOS)** — `BARK_DEVICE_KEY` (optionnel `BARK_URL`)
1. Installez [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865) depuis l'App Store, ouvrez l'app et copiez la partie Key de l'URL d'exemple (`https://api.day.app/<ce morceau est la Key>/...`)
2. Collez la Key dans `BARK_DEVICE_KEY` ; serveur auto-hébergé : configurez en plus `BARK_URL` (défaut : officiel `https://api.day.app`)

**ntfy (abonnement Android/iOS/web)** — `NTFY_URL` (optionnel `NTFY_TOKEN`)
1. Installez l'app ntfy sur le téléphone (ou utilisez le web [ntfy.sh](https://ntfy.sh)) et abonnez-vous à un nom de topic personnalisé, p. ex. `my-sms-9f2k` (plus le nom est aléatoire, plus il est privé)
2. Dans `NTFY_URL`, mettez l'URL complète du topic : `https://ntfy.sh/my-sms-9f2k` (serveur auto-hébergé : votre adresse ; déploiement en sous-chemin derrière reverse proxy pris en charge)
3. Si le topic a un contrôle d'accès, configurez `NTFY_TOKEN` : l'Access Token (préfixé `tk_`) se colle directement ; serveur auto-hébergé : format `utilisateur:motdepasse`

**Gotify (service de push auto-hébergé)** — `GOTIFY_URL` + `GOTIFY_TOKEN`
1. Gotify déjà auto-hébergé : connexion web → **Apps** → créer une application → copier le **Token**
2. Dans `GOTIFY_URL`, mettez l'adresse du serveur (p. ex. `https://push.example.com`, **sans** `/message`) et le token dans `GOTIFY_TOKEN`

**E-mail (API Resend)** — `RESEND_API_KEY` + `MAIL_TO` (optionnel `MAIL_FROM`)
1. Ouvrez [resend.com](https://resend.com) et inscrivez-vous (quota gratuit : 100 e-mails/jour, 3000/mois)
2. **API Keys** → Create API Key, copiez et collez dans `RESEND_API_KEY`
3. Dans `MAIL_TO`, mettez la boîte de destination (plusieurs, séparées par des virgules) ; sans `MAIL_FROM`, le défaut est `onboarding@resend.dev` (cet expéditeur par défaut ne peut écrire qu'à l'adresse d'inscription à Resend ; pour écrire à n'importe quelle boîte, vérifiez votre propre domaine chez Resend et configurez `MAIL_FROM`)

**Webhook générique / API tierce** — `GENERIC_WEBHOOKS` (optionnel `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`)
1. Dans `GENERIC_WEBHOOKS`, mettez une ou plusieurs URL (**séparées par des virgules**). POST JSON par défaut :

```json
{"title":"【短信】13800138000 ← 10086","content":"正文…","time":"2026-10-14 12:30:00（北京时间）","source":"sms","sender":"1069012345678","device":"我的手机"}
```

2. Si le récepteur exige un format précis, configurez `GENERIC_WEBHOOK_TEMPLATE` avec les placeholders `{{title}}` / `{{content}}` / `{{time}}` / `{{source}}` / `{{sender}}` / `{{device}}` pour personnaliser le corps ; si le modèle est interprétable en JSON, il est envoyé en JSON, sinon en texte brut. Exemple :

```
{"phone":"13800138000","msg":"{{content}}","at":"{{time}}"}
```

3. Si le récepteur exige des en-têtes d'authentification (secret hors URL), configurez `GENERIC_WEBHOOK_HEADERS` avec une chaîne JSON d'objet, p. ex. :

```json
{"Authorization":"Bearer sk-xxx","X-Api-Key":"yyy"}
```

Si la valeur n'est pas un JSON valide, elle est ignorée, sans impact sur le transfert par défaut. N'importe quelle API tierce — passerelles SMS, Home Assistant, n8n, scripts maison, etc. — peut s'intégrer via ce modèle. Les noms de variables et leur emplacement de configuration par canal sont dans le tableau « Variables et secrets » ci-dessus ; sur Cloudflare, dans la page « Variables and Secrets » du Worker ; sur les autres plateformes, dans les variables d'environnement de leur tutoriel.

### 3. Base de données

La table `messages` de D1 doit contenir les colonnes `source` (distingue SMS/notification) et `deleted_at` (suppression logique/annulation). Déploiement neuf : exécutez directement [schema.sql](../../../schema.sql) ; mise à niveau d'une ancienne base :

```sql
ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'sms';
ALTER TABLE messages ADD COLUMN deleted_at TEXT;
ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN read_at TEXT;
```

---

## 2. Spécification des API de push

Deux API publiques partagent l'authentification `RECEIVE_TOKEN` (le token peut aller en query ou dans le body) :

### 1. Réception SMS `POST /api/receive` (réservé à l'app Android)

```
POST https://<你的域名>/api/receive?token=<RECEIVE_TOKEN>
Content-Type: application/json

{
  "name": "我的手机",
  "sim": "13800138000",
  "from": "1069012345678",
  "content": "您的验证码是 734752，5 分钟内有效",
  "time": "2026-10-14 12:29:59"
}
```

### 2. Push universel `POST /api/push` (notifications de toutes plateformes)

```
POST https://<你的域名>/api/push
Content-Type: application/json

{
  "token": "<RECEIVE_TOKEN>",
  "source": "notify",
  "sender": "备份脚本",
  "name": "通知网关",
  "content": "数据库备份完成，耗时 3 分 12 秒",
  "time": "2026-10-14 03:00:00"
}
```

| Champ | Requis | Description |
|---|---|---|
| `token` | Oui | jeton d'authentification |
| `content` | Oui | corps du message (`text`/`message`/`msg` acceptés aussi) |
| `source` | Non | étiquette de source, `notify` par défaut ; utilisée par le « filtre de sources » de la page web, libre (p. ex. `cron`, `alert`) |
| `sender` | Non | titre de la source (nom d'hôte / app / script) |
| `name` | Non | libellé de l'appareil (nommage personnalisé), défaut « Notification Gateway », affiché en parallèle du libellé SMS |
| `time` | Non | heure de l'événement ; à défaut, heure serveur actuelle ; accepte un timestamp ou un texte `YYYY-MM-DD HH:MM:SS` |

Réponse : `{"success":true,"device_id":17,"duplicated":false}` (`duplicated=true` signifie : doublon ignoré, pas de nouveau transfert vers les canaux de notification)

---

## 3. Ingestion par plateforme

### Android (SMS + notifications d'apps) — SmsForwarder

1. Installez l'app open source « SmsForwarder » ([pppscn/SmsForwarder](https://github.com/pppscn/SmsForwarder))
2. Dans les réglages généraux, **activez l'interrupteur principal « Transférer le broadcast SMS »**
3. Créez un « Canal Webhook » : URL `/api/receive?token=<RECEIVE_TOKEN>`, avec le modèle de message :

```json
{"name":"我的手机","sim":"13800138000","from":"{{FROM}}","content":"{{SMS}}","time":"{{DATE}}"}
```

> Points clés : `name` = nom personnalisé de l'appareil (la page web l'affiche comme libellé ; le changer crée un nouveau libellé) ; `sim` = le numéro de téléphone directement (affiché en bas à droite de la carte, double-clic pour copier) ; `content` doit utiliser la variable `{{SMS}}`.
> Transfert des notifications d'apps : ajoutez une règle de plus « Notification d'app », avec `sender` = `{{APP_NAME}}` et `content` = `{{MSG}}`, en basculant la destination sur `/api/push`.

### iOS — Raccourcis (Shortcuts)

1. Raccourcis → Automatisation → Nouvelle « Automatisation personnelle » → choisir « À la réception d'un SMS/message »
2. Ajoutez l'action → « Obtenir le contenu de l'URL » :
   - URL : `https://<你的域名>/api/push`
   - Méthode : POST, corps JSON :

```json
{"token":"<RECEIVE_TOKEN>","source":"sms","sender":"iPhone","name":"通知网关","content":"[variable du corps du message]"}
```

3. Désactivez « Demander avant d'exécuter » et tout devient automatique. Les notifications programmées (batterie, mode concentration) marchent pareil, en choisissant le déclencheur correspondant.

### Linux — curl / scripts / systemd

La ligne la plus simple :

```bash
curl -s -X POST https://<你的域名>/api/push \
  -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"web-01","content":"Nginx 已重启"}'
```

Exemple de notification programmée/événementielle (`/usr/local/bin/notify.sh`) :

```bash
#!/bin/bash
curl -s -X POST https://<你的域名>/api/push \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"<RECEIVE_TOKEN>\",\"sender\":\"$(hostname)\",\"source\":\"cron\",\"content\":\"$1\"}"
```

À coupler avec un timer systemd ou cron : `notify.sh "每日备份完成"`.

Option avancée : auto-hébergez [ntfy](https://ntfy.sh) (binaire unique/Docker), faites s'abonner plusieurs machines au même flux d'événements, puis utilisez un petit script pont pour transférer les messages ntfy vers cette passerelle.

### Windows — PowerShell / Planificateur de tâches

`C:\Tools\notify.ps1` :

```powershell
param([string]$Message = "通知")
$body = @{
  token  = "<RECEIVE_TOKEN>"
  sender = $env:COMPUTERNAME
  source = "notify"
  content = $Message
} | ConvertTo-Json
Invoke-RestMethod -Uri "https://<你的域名>/api/push" -Method Post -ContentType "application/json" -Body $body
```

Utilisation : `powershell -File C:\Tools\notify.ps1 -Message "磁盘清理完成"` ; dans le Planificateur de tâches, on peut l'attacher à des événements comme l'extinction ou après une sauvegarde.

### macOS — Raccourcis / launchd

- Raccourcis : comme iOS (changez le déclencheur d'automatisation en « Heure précise », « Modification de fichier », etc.)
- Script programmé + launchd (`~/Library/LaunchAgents/local.notify.plist`) :

```bash
curl -s -X POST https://<你的域名>/api/push -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"MacBook","content":"Time Machine 备份完成"}'
```

- Pour qui reçoit les SMS de l'iPhone sur Mac : utilisez AppleScript pour sonder les incréments de la base SQLite de Messages.app et pousser (usage avancé)

### Serveurs/conteneurs — Apprise (couche d'agrégation optionnelle)

[Apprise](https://github.com/caronc/apprise) prend en charge plus de 100 destinations de notification ; vous pouvez utiliser cette passerelle comme l'un de ses webhooks personnalisés et gérer de façon unifiée le push vers plusieurs destinations.

---

## 4. Liste de vérification

| Vérification | Méthode |
|---|---|
| Authentification API | une requête sans token doit renvoyer 403 unauthorized |
| Push universel | envoyez-en un avec l'un des exemples ci-dessus ; visible sous la source « Notification » de la page web et reçu simultanément par les canaux configurés |
| Chaîne SMS | envoyez un vrai SMS depuis le mobile → visible dans la source « SMS » de la page + reconnaissance du code + transfert vers les canaux |
| Filtre de sources | basculez dans le menu déroulant « Filtre de sources » de la barre d'outils de l'admin : Tout / SMS / Notifications et sources personnalisées |
| Bascule de langue | la page d'admin et la page de connexion intègrent neuf langues (简体中文 / 繁體中文 / English / 日本語 / 한국어 / Español / Français / Deutsch / Português (BR)) ; choix dans le menu « 🌐 » en haut à droite, toute la page bascule, le choix est mémorisé localement dans le navigateur ; ou visitez directement `https://votredomaine.com/?lang=ja` et autres en accès direct. Les anciens liens `?lang=zh` / `?lang=en` restent compatibles (normalisation automatique vers zh-CN / en) |
| Export et filtres | cliquez sur « Exporter CSV / JSON » pour télécharger le résultat du filtre courant ; changez « 7 derniers jours », « 50 par page » et la liste comme l'export suivent |
| Blocage des doublons | renvoi du même contenu en quelques secondes : réponse `duplicated:true`, pas de nouveau push vers les canaux |

## 5. Questions fréquentes

- **J'ai poussé un message et la page ne s'est pas rafraîchie ?** La page d'admin se rafraîchit automatiquement par long polling (par défaut jusqu'à 25 secondes en attente, réglable avec `WAIT_MAX_SECONDS`) ; en revenant sur la page, une récupération immédiate part ; vous pouvez aussi basculer le filtre de sources pour déclencher le chargement.
- **Interface serrée sur navigateur mobile ou formulaire de connexion agrandi ?** C'est déjà adapté au mobile (safe-areas, champs 16px contre l'auto-zoom iOS, cibles tactiles plus grandes) ; si le problème persiste, videz le cache du site et réessayez.
- **Le long polling échoue toujours sur Netlify ?** Mettez `WAIT_MAX_SECONDS` à `8` (sous le plafond de 10s de Functions).
- **Rien reçu sur le canal de notification ?** Vérifiez que la variable du canal est configurée et correcte (les paires comme Telegram/Gotify exigent les deux) ; regardez si les journaux de la plateforme montrent `notify forward failed:` ; les messages avec `duplicated:true` ne sont pas transférés.
- **Changer le nom d'un libellé ?** Cliquez sur « ✎ » à côté du libellé de l'appareil pour le renommer (fixe un alias), ou sur « ⇄ » pour fusionner ses messages avec un autre appareil ; les libellés sans messages se suppriment directement avec « × ».
- **Combien de temps sont conservés les messages ?** C'est `RETENTION_DAYS` qui le contrôle, 30 jours par défaut, avec nettoyage automatique chaque jour à 17:00 UTC (01:00 heure de Pékin).
