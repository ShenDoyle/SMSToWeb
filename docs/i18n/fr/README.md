# SMSToWeb — Passerelle cloud de SMS et de notifications
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | **Français** | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Synchronisé depuis l'original anglais (fr)

> L'anglais est la version principale maintenue de ce document. Les traductions se trouvent sous [`docs/i18n/<lang>/`](../../../docs/i18n/README.md) et peuvent prendre du retard ; en cas de doute, reportez-vous à ce fichier.

Poussez en temps réel les SMS et notifications d'un téléphone Android (et de tout autre appareil) vers le cloud, et consultez-les depuis une page web où que vous soyez. Déploiement gratuit, sans serveur, environ 10 minutes de bout en bout.

- **Déploiement multiplateforme** : Cloudflare (principal) / Vercel / Deno Deploy / Netlify / Tencent EdgeOne Makers / Docker auto-hébergé — choisissez l'une des six, fonctionnalités strictement identiques
- **Réception en temps réel** : le push webhook arrive en base de données en quelques secondes ; la page web se rafraîchit toute seule, sans intervention manuelle
- **Push universel** : tout appareil capable d'envoyer une requête HTTP (Linux / Windows / macOS / iOS / NAS / scripts) peut pousser des notifications sur la même page
- **Sources et filtres** : filtrage dynamique par source (SMS / notifications et sources personnalisées agrégées automatiquement), combiné à la recherche par mot-clé et aux plages Aujourd'hui / 7 derniers jours / 30 derniers jours ; taille de page réglable
- **Multi-diffusion** : les nouveaux messages peuvent être transférés automatiquement vers Feishu / WeCom / DingTalk / Telegram / ServerChan / PushPlus / Bark / ntfy / Gotify / e-mail / webhook générique — configurez uniquement ce que vous utilisez (optionnel)
- **Sécurité optionnelle** : interrupteur de connexion admin, extraction de codes OTP multi-format (code d'abord / mot-clé d'abord / segmenté / mixte, résistante aux faux positifs) avec copie en un geste, mode sombre
- **Données et alertes** : export CSV / JSON selon le filtre courant ; toast / son optionnel / pilule flottante pour les nouveaux messages quand la page est visible, notification navigateur + titre « non lus » en arrière-plan ; les longs messages se replient automatiquement
- **Reconnaissance des numéros** : annuaire intégré des numéros institutionnels courants (opérateurs / banques / livreurs / administrations) étiquetés automatiquement ; consultation optionnelle de la région de l'opérateur pour les numéros mobiles inconnus (activée par défaut, désactivable)
- **9 langues** : les pages d'admin et de connexion embarquent zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR ; basculez depuis le menu 🌐 de l'en-tête (deep link `?lang=` pris en charge, choix mémorisé localement) ; dates, temps relatifs et libellés de l'annuaire suivent
- **Adapté au mobile** : prise en charge des safe-areas `viewport-fit` pour les encoches et barres de gestes, champs de 16px contre le zoom automatique d'iOS, cibles tactiles plus grandes, dialogues bottom-sheet, PWA « ajouter à l'écran d'accueil »
- **Actions groupées et annulation** : suppression multi-sélection, vidage par filtre en un geste ; annulation pendant 5 secondes après suppression (suppression logique) ; mode sombre auto / clair / sombre
- **Favoris / non lus / statistiques** : étoile pour épingler, vues favoris uniquement / non lus uniquement, panneau de statistiques (répartition par source + 7 derniers jours) ; libellés de numéros personnalisés ; surbrillance et historique de recherche ; ne pas déranger et son dans les réglages ; PWA

```
[SMS] Android(SmsForwarder) ──POST /api/receive──┐
                                                 ├─→ cloud gateway (any platform) ─→ database
[notify] scripts / shortcuts ──POST /api/push────┘        │
                                                browser ◀── web admin (embedded in gateway)
```

**Déploiement en un clic (Cloudflare principal, ~2 min)** :

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

Le bouton crée la base de données et les tables, lie les ressources et configure le CI automatiquement ; saisissez `RECEIVE_TOKEN` (secret d'authentification du push) lorsque c'est demandé et vous êtes en ligne. Les boutons en un clic pour Vercel / Netlify se trouvent dans leurs guides de plateforme.

| Plateforme | Déploiement | Nettoyage planifié | Guide |
|---|---|---|---|
| **Cloudflare** (recommandée) | Worker + D1 | cron de la plateforme | [platforms/cloudflare/README.md](../../../platforms/cloudflare/README.md) |
| Vercel | Edge Function + Turso | cron de la plateforme | [platforms/vercel/README.md](../../../platforms/vercel/README.md) |
| Deno Deploy | Deno natif + Turso | Deno.cron | [platforms/deno/README.md](../../../platforms/deno/README.md) |
| Netlify | Functions v2 + Turso | Scheduled Function | [platforms/netlify/README.md](../../../platforms/netlify/README.md) |
| Tencent EdgeOne Makers | Functions + Turso | cron externe | [platforms/edgeone/README.md](../../../platforms/edgeone/README.md) |
| Fly.io / Railway / VPS | Docker (Node 22) + Turso / SQLite local | intégré au processus | [platforms/node/README.md](../../../platforms/node/README.md) |

> Chaque répertoire de plateforme est **totalement autonome** (code + schéma + documentation indépendante, zéro dépendance npm, sans étape de build). Cliquez sur un guide ci-dessus et suivez les étapes. Les fonctionnalités et le schéma de données sont identiques sur toutes les plateformes ; vous pouvez migrer de l'une à l'autre à tout moment.
> Pour la comparaison des plateformes et la préparation commune (base de données Turso), voir [platforms/README.md](../../../platforms/README.md).

### Différences d'exécution (à lire avant de déployer)

Le code métier est identique octet par octet sur les six plateformes, mais les **timeouts / tâches de fond / minuteurs** diffèrent à l'exécution. Adaptez via des variables d'environnement si besoin :

| Plateforme | Timeout de fonction | Notifications en arrière-plan | Nettoyage planifié | Conseil |
|---|---|---|---|---|
| Cloudflare | pas de limite temps réel (limité au CPU) | `ctx.waitUntil` continue après la réponse | cron de la plateforme | les valeurs par défaut conviennent |
| Vercel Edge | plafond ~25s par requête | terminé en ligne avant la réponse | cron de la plateforme | `WAIT_MAX_SECONDS=20` |
| Netlify Functions | 60s (tous les plans) | terminé en ligne avant la réponse | fonction planifiée | l'entrée est par défaut à `WAIT_MAX_SECONDS=8` |
| Deno Deploy | selon le plan | terminé en ligne avant la réponse | déclencheur externe requis | cron externe appelant `/api/cron?token=` |
| EdgeOne Makers | selon le plan | terminé en ligne avant la réponse | déclencheur externe requis | baissez `WAIT_MAX_SECONDS` selon le plan |
| Node / Docker | à votre convenance | terminé en ligne avant la réponse | déclencheur externe requis | le SQLite local exige Node ≥ 22.13 |

> - **Long polling** : le frontend retente les échecs avec **backoff exponentiel** (2→30s) et redémarre immédiatement le polling quand la page redevient visible ; les requêtes tuées par la plateforme ne saturent jamais la fonction.
> - **Transfert des notifications** : Cloudflare utilise `waitUntil` ; les autres plateformes terminent l'envoi des notifications avant la réponse (timeout de 10s par canal), donc beaucoup de canaux lents ajoutent un peu de latence.
> - **Nettoyage planifié** : sur les plateformes sans cron, pointez n'importe quel planificateur vers `GET /api/cron?token=<RECEIVE_TOKEN>`.

---

## Configuration du téléphone et ingestion multi-appareils

Toutes les plateformes livrent les messages dans la même page web : les SMS du téléphone passent par `/api/receive` (SmsForwarder Android), tout le reste utilise le `/api/push` universel.

Configuration pas à pas (commandes/scripts prêts à copier par plateforme) : **[Guide de déploiement et d'ingestion](../../../docs/i18n/en/DEPLOYMENT.md)**

**Aide-mémoire du push universel** (tous les champs dans le guide) :

```
POST https://<your-domain>/api/push?token=<RECEIVE_TOKEN>
{"source":"notify","sender":"demo","content":"hello from anywhere"}
```

Une réponse `{"success":true,...}` signifie que c'est stocké ; renvoyer exactement le même payload retourne `duplicated:true`.

## Variables d'environnement (toutes les plateformes)

| Variable | Requise | Description |
|---|---|---|
| `RECEIVE_TOKEN` | oui | secret d'authentification du push ; choisissez une longue chaîne aléatoire |
| `ENABLE_AUTH` | non | `"true"` exige une connexion pour la page d'admin (**fortement recommandé**, voir les notes de sécurité ci-dessous) ; par défaut, pas de connexion |
| `ADMIN_PASSWORD` | non | mot de passe de connexion (à définir quand `ENABLE_AUTH="true"` ; s'il manque, les APIs d'admin refusent l'accès et journalisent une alerte — une config manquante n'ouvre jamais la porte) |
| `RETENTION_DAYS` | non | rétention des données en jours, 30 par défaut |
| `WAIT_MAX_SECONDS` | non | secondes maximales de suspension du long polling de `/api/wait`, 25 par défaut (plage 3–25). Sur **Netlify Functions** (plafond 10s) ou d'autres plateformes à timeout court, mettez `8` pour que la plateforme ne tue pas les requêtes |
| `PHONE_AREA_ENABLED` / `PHONE_AREA_API` | non | consultation de la région de l'opérateur : activée par défaut (API gratuite 360, sans clé, cache de 24h côté backend, uniquement les numéros mobiles à 11 chiffres) ; mettez `false` pour désactiver ; source personnalisée via `PHONE_AREA_API` (URL avec le placeholder `{number}`) |
| Variables des canaux de notification | non | `FEISHU_WEBHOOK` (Feishu) / `WECOM_WEBHOOK` (WeCom) / `DINGTALK_WEBHOOK` (DingTalk, signature `DINGTALK_SECRET` optionnelle) / `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY` (`BARK_URL` optionnelle) / `NTFY_URL` (`NTFY_TOKEN` optionnel) / `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO` (e-mail, `MAIL_FROM` optionnel) / `GENERIC_WEBHOOKS` (webhook générique, `GENERIC_WEBHOOK_TEMPLATE` de corps / `GENERIC_WEBHOOK_HEADERS` d'en-têtes optionnels). Configurez uniquement ce que vous utilisez ; sans rien de défini, rien n'est transféré. Les notifications se rendent automatiquement en trois modes selon le contenu (🔐 OTP / 💬 SMS / 🔔 notification) |
| `SITE_NAME` / `SITE_ICON` | non | nom du site / URL de l'icône ; valeurs par défaut si non définies |
| `NOTIFY_LINK` | non | URL d'accueil de la page d'admin ; une fois définie, chaque canal de notification reçoit une entrée « Ouvrir l'admin » (bouton/lien/clic) ; omise automatiquement si non définie |
| `SESSION_SECRET` | requise si la connexion est activée | secret de signature de session : **valeur aléatoire à haute entropie (≥32 caractères aléatoires recommandés), totalement indépendante du mot de passe admin** ; Cloudflare et EdgeOne (et chaque autre plateforme) doivent chacune avoir leur propre valeur ; ne la committez jamais dans Git ni ne réutilisez le mot de passe. Si elle manque, connexion et authentification **échouent de façon sûre (fail-closed)** (la connexion renvoie 500, les APIs d'admin renvoient 401, aucun repli dérivé du mot de passe). La rotation de la valeur invalide immédiatement toutes les sessions existantes. Les sessions durent 30 minutes ; la déconnexion ne fait qu'effacer le cookie du navigateur — un jeton de session copié reste valide dans la limite de son TTL (jusqu'à 30 minutes) |

Cloudflare a en plus besoin du binding `DB` (D1) ; les autres plateformes ont besoin de `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (base de données Turso, voir chaque guide) ; l'auto-hébergement Node prend aussi en charge le mode SQLite local `SQLITE_PATH` (voir platforms/node/README.md).

> **Recommandations de sécurité**
> 1. **Activez la connexion admin** (`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`) : la page d'admin contient du contenu sensible comme les codes OTP par SMS ; sans connexion, quiconque connaît le domaine peut lire tous les messages et supprimer des données. L'endpoint de connexion est limité en débit (5 échecs consécutifs par IP = verrouillage 10 minutes) ; `/api/receive` et `/api/push` sont limités à 120 écritures par IP et par minute (429 au-delà).
> 2. **Compromis du `?token=` dans les URL** : pour rester compatible avec SmsForwarder et clients similaires, `/api/receive` et `/api/push` acceptent l'authentification via le paramètre de requête `?token=` — le jeton peut apparaître dans les journaux d'accès de la plateforme et dans l'historique du navigateur. Si cela vous préoccupe, passez en POST avec l'en-tête `Authorization: Bearer <RECEIVE_TOKEN>` (les deux sont pris en charge).

## FAQ (généralités)

- **Un libellé affiche un `{{XXX}}` littéral** → impossible : la passerelle efface les libellés contenant un `{{` littéral et retombe sur `sim` ; définissez votre nom personnalisé directement dans le champ `name` du modèle
- **API 401/403** → vérifiez que le `token=` de l'URL correspond à `RECEIVE_TOKEN` ; `/api/receive` et `/api/push` ne sont pas affectés par l'interrupteur de connexion
- **API 429** → limite d'écriture atteinte (120/IP/min) ; ça se rétablit après une minute — si cela arrive en usage normal, votre jeton a peut-être fuité ou quelque chose martèle l'API
- **Messages très longs** → un corps seul est plafonné à 8000 caractères, l'excédent est tronqué
- **Renommer un libellé d'appareil** → un libellé vient du champ `name` du modèle de message ; changer `name` crée un nouveau libellé. Utilisez « ✎ » à côté d'un libellé sur la page web pour le renommer, « ⇄ » pour fusionner ses messages avec un autre appareil, et « × » pour supprimer directement un libellé vide
- **Mise à niveau depuis une version plus ancienne (nouvelles colonnes)** → exécutez sur l'ancienne base : `ALTER TABLE messages ADD COLUMN deleted_at TEXT;`, `ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;`, `ALTER TABLE messages ADD COLUMN read_at TEXT;` (les bases neuves les incluent déjà ; le SQLite local de node ajoute les colonnes automatiquement au démarrage)

## Développement

- `src/worker.js` : source principale (forme de Cloudflare Worker)
- `platforms/gen_app.py` : génère le `app.js` neutre plateforme depuis `src/worker.js` vers les cinq plateformes portées et synchronise la copie Cloudflare `worker.js` (en gardant le code métier identique octet par octet sur les six plateformes) ; synchronise aussi la liste blanche d'environnement à 31 variables (ENV_KEYS, entrées d'authentification comprises) vers les six entrées de plateforme pour prévenir toute dérive (le db.js de node est un adaptateur double Turso + SQLite local, maintenu séparément et non synchronisé)
- `platforms/*/` : répertoires de déploiement autonomes (entrée + app.js + adaptateur db.js + schema.sql + guide de plateforme)
- `docs/i18n/en/` : ensemble de documentation anglais (déploiement/API/architecture/base de données) ; les autres langues sous `docs/i18n/<lang>/` — voir [docs/i18n/README.md](../../../docs/i18n/README.md)
- `tests/run.mjs` : suite de tests sans dépendances (204 tests, exige Node 22.13+) : `node tests/run.mjs`
- Après modification du code principal : exécutez `python platforms/gen_app.py` pour re-synchroniser toutes les plateformes, puis `node tests/run.mjs` ; le CI vérifie zéro dérive de synchronisation + syntaxe + tests

## Licence

[MIT](../../../LICENSE) © 2026 [左立方 (ZuoLifang)](https://cbm.im/)
