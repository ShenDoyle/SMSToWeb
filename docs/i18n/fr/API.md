# Documentation de l'API (API)
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | **Français** | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Synchronisé depuis l'original anglais (fr)

Toutes les routes ont pour racine `/`, répondent en JSON (`Content-Type: application/json`) et prennent en charge CORS. Sauf les « routes publiques », elles sont protégées par l'interrupteur de connexion (les recommandations de configuration de sécurité figurent dans le README racine, « Recommandations de sécurité »).

## Formes d'authentification

| Type de route | Authentification |
|---|---|
| Push entrant (`/api/receive`, `/api/push`) | `?token=<RECEIVE_TOKEN>` (query ou champ de formulaire), **indépendant de l'interrupteur de connexion** |
| APIs d'administration | session par cookie `sms_auth` (obtenue via `POST /api/login` ; active avec `ENABLE_AUTH=true`). La session est un **jeton signé sans état** (`nonce.exp.HMAC-SHA256` en trois segments, clé de signature `SESSION_SECRET`), dure 30 minutes ; si `SESSION_SECRET` manque, échec sûr (fail-closed) (la connexion renvoie 500, les APIs d'admin renvoient toujours 401, aucun repli dérivé du mot de passe), en cas de configuration manquante rien ne passe. La rotation de `SESSION_SECRET` invalide immédiatement toutes les anciennes sessions |
| Nettoyage planifié (`GET /api/cron`) | `?token=<RECEIVE_TOKEN>` ou `Authorization: Bearer <RECEIVE_TOKEN>` |

## 1. Push entrant (public)

### POST/GET `/api/receive` — entrée SMS (compatible SmsForwarder)

Paramètres (body JSON ; en GET, par query) :

| Champ | Requis | Description |
|---|---|---|
| `token` | Oui | RECEIVE_TOKEN (aussi possible en query) |
| `name` | Non | nom de l'appareil (champ `name` du modèle de l'app), défaut `unknown` |
| `sim` | Non | numéro récepteur, stocké et affiché tel quel |
| `from` | Non | expéditeur |
| `content` | Oui | corps du SMS (tronqué à 8000 caractères côté serveur) |
| `time` | Non | heure du client ; à défaut, l'heure de Pékin du serveur |

```bash
curl -X POST "https://<your-site>/api/receive?token=<RECEIVE_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"我的手机","sim":"13800000000","from":"10086","content":"验证码 123456"}'
```

Réponse : `{ "success": true, "device_id": 1, "duplicated": false }`. Un push répété du même appareil+expéditeur+contenu+heure à la seconde → `duplicated: true` (non stocké et **aucun transfert de notification**).

### POST `/api/push` — push universel (connexion depuis n'importe quelle plateforme)

| Champ | Requis | Description |
|---|---|---|
| `token` | Oui | RECEIVE_TOKEN (query) |
| `content` | Oui | corps (tronqué à 8000 caractères) |
| `name` / `sender` | Non | libellé de l'appareil / expéditeur (nom d'app, de script, etc.) |
| `source` | Non | catégorie de source (défaut `notify` ; p. ex. `alert`, `jd` ; le frontend peut filtrer par source) |
| `time` | Non | heure du client ; à défaut, l'heure serveur courante |

La réception d'un message déclenche aussi le transfert de notifications vers les 11 canaux (rendu en trois états : un push sans code de vérification → 🔔 notification d'appareil).

## 2. Consultation et gestion des messages (session de connexion requise)

### GET `/api/messages` — liste des messages

Paramètres de query :

| Paramètre | Description |
|---|---|
| `q` | recherche par mot-clé (correspondance sur sender/content) |
| `source` | filtre par source (p. ex. `sms` / `notify` / sources personnalisées) |
| `device_id` | filtre par appareil |
| `range` | plage temporelle : `1d` / `7d` / `30d` |
| `limit` / `page` | pagination (50 par page par défaut) |
| `starred` | `1` favoris uniquement |

Réponse : `{ "total": 123, "limit": 50, "page": 1, "list": [ { "id", "device_id", "display_name", "sim_number", "sender", "source", "content", "received_at", "starred", "read_at", "deleted_at" } ] }`

### Opérations sur les messages

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/messages/remove` | suppression logique (body : `{ ids: [..] }`, écrit deleted_at) |
| POST | `/api/messages/restore` | restaurer une suppression logique (body : `{ ids: [..] }`) |
| POST | `/api/messages/clear` | vider la corbeille / tout (body : `{ scope: "trash" \| "all" }`) |
| POST | `/api/messages/star` | basculer le favori (body : `{ id, starred }`) |
| POST | `/api/messages/read` | marquer comme lu (body : `{ id }`) |
| DELETE | `/api/messages/{id}` | suppression physique d'un message |

### GET `/api/export?format=csv|json` — export

Accepte les mêmes paramètres de filtre que la liste ; le CSV a un BOM et l'en-tête de téléchargement `attachment`, avec protection contre l'injection de formules (les cellules commençant par `=/+-@` sont préfixées d'une apostrophe).

### GET `/api/stats` — statistiques

Résumés aujourd'hui/total/nombre d'appareils, etc. GET `/api/sources` — liste des sources (`[{ source, count }]`).

## 3. Gestion des appareils (session de connexion requise)

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/devices` | liste des appareils (avec `display_name` : alias > nom d'appareil et comptage des messages) |
| POST | `/api/devices/alias` | fixer un alias (body : `{ id, alias }` ; la chaîne vide le supprime) |
| POST | `/api/devices/merge` | fusionner des appareils (body : `{ from, to }`, migre tous les messages et supprime l'appareil source ; source→lui-même renvoie 400) |
| DELETE | `/api/devices/{id}` | supprimer un appareil (avec messages : renvoie `has messages` et est refusé) |

## 4. Temps réel et utilitaires

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/wait?last_id=N` | long polling : s'il existe des messages plus récents que N, répond aussitôt `{ changed: true }` ; sinon se suspend (25s par défaut, réglable via `WAIT_MAX_SECONDS`) |
| GET | `/api/phone?number=` | consultation de l'origine du numéro (désactivée via `PHONE_AREA_ENABLED=false` ; proxy amont limité en débit, seau indépendant de 120 requêtes/min) |
| POST | `/api/login` | connexion (body : `{ password }` → `Set-Cookie: sms_auth=<session signée>`, jeton sans état HMAC-SHA256 en trois segments, TTL 30 minutes, HttpOnly + SameSite=Lax ; 5 échecs = verrouillage 10 minutes ; mot de passe erroné 403, `SESSION_SECRET` manquante 500 erreur de configuration) |
| POST | `/api/logout` | déconnexion |
| GET | `/api/cron?token=` | déclencher le nettoyage planifié (supprime les messages antérieurs à `RETENTION_DAYS`) |
| GET | `/` `/manifest.webmanifest` `/sw.js` | page d'administration / manifeste PWA / Service Worker |

## 5. Format de transfert du webhook générique (sortant)

Après configuration de `GENERIC_WEBHOOKS`, chaque message est envoyé en POST avec ce JSON par défaut :

```json
{
  "title": "🔐 验证码 726418 · Gitee",
  "content": "您的验证码是726418，5分钟内有效",
  "time": "2026-10-27 14:23:45",
  "source": "sms",
  "sender": "Gitee",
  "device": "我的手机",
  "type": "verify",
  "code": "726418"
}
```

`type` ∈ `verify | sms | notify` ; `code` est le code de vérification détecté par la détection légère côté serveur (chaîne vide si rien) ; `GENERIC_WEBHOOK_TEMPLATE` permet le rendu selon le modèle (placeholders `{{title}} {{content}} {{time}} {{source}} {{sender}} {{device}} {{type}} {{code}}`) ; `GENERIC_WEBHOOK_HEADERS` permet des en-têtes personnalisés (chaîne JSON d'objet).
