# Document de la base de données (DATABASE)
[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md) | [Español](../es/README.md) | **Français** | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)
> Synchronisé depuis l'original anglais (fr)

SMSToWeb utilise une couche d'adaptation de base de données unifiée (les quatre méthodes `prepare/bind/first/all/run`, identiques à l'API Cloudflare D1) qui aplanit trois backends de stockage ; le code métier n'a zéro différence de dialecte SQL.

## 1. Matrice des backends

| Plateforme | Base de données | Variables d'identifiants | Fichier d'adaptation |
|---|---|---|---|
| Cloudflare | D1 | binding dans le panneau (`env.DB`), configuré dans wrangler.toml | natif, sans adaptation |
| Vercel / Netlify / Deno / EdgeOne | Turso (libsql) | `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | `platforms/shared/db.js` |
| Node auto-hébergé | Turso **ou** SQLite local | avec les variables Turso, on utilise Turso ; sinon `SQLITE_PATH` (défaut `./data/smstoweb.db`, node:sqlite) | `platforms/node/db.js` (adaptation double, maintenue séparément) |

L'adaptation multiplateforme est implémentée en `fetch` pur (Turso HTTP /v2/pipeline), sans dépendance npm.

## 2. Schéma des tables (schema.sql comme source unique)

### devices — table des appareils

| Colonne | Type | Description |
|---|---|---|
| `id` | INTEGER PK | auto-incrément |
| `device` | TEXT | nom de l'appareil (champ `name` du modèle de l'app, défaut `unknown`) |
| `sim` | TEXT | numéro récepteur (stocké et affiché tel quel, sans mappage) |
| `alias` | TEXT | alias optionnel (priorité d'affichage dans l'admin : alias > device) |
| `created_at` | TEXT | heure d'insertion |

Index unique `idx_devices_key(device, sim)` : même appareil + même numéro récepteur = unique.

### messages — table des messages (10 colonnes)

| Colonne | Type | Description |
|---|---|---|
| `id` | INTEGER PK | auto-incrément |
| `device_id` | INTEGER FK | → devices.id |
| `sender` | TEXT | expéditeur |
| `content` | TEXT | corps (tronqué à 8000 caractères avant stockage) |
| `received_at` | TEXT | heure de Pékin (précision à la seconde) |
| `source` | TEXT | source : `sms` / `notify` / personnalisée (p. ex. `alert`) |
| `created_at` | TEXT | heure d'insertion |
| `deleted_at` | TEXT NULL | horodatage de suppression logique (NULL = normal) |
| `starred` | INTEGER | favori 0/1 |
| `read_at` | TEXT NULL | horodatage de lecture |

Index : `idx_messages_device_time(device_id, received_at DESC)`, `idx_messages_time(received_at)`, `idx_messages_source(source, received_at DESC)`, et l'**index unique de déduplication** `idx_messages_dedup(device_id, sender, content, received_at)` — les push en double sont rejetés en dernier ressort par la base elle-même ; le code attrape le conflit d'unicité et renvoie `duplicated:true`.

## 3. Règle de fer des migrations (important)

**Chaque fois que schema.sql est modifié, il faut penser/exécuter la migration sur les bases de toutes les plateformes déjà déployées** (leçon d'un incident de production du 2026-10-22 : le code déployé avant le schéma, l'ancienne base Turso sans la colonne `starred`, et toute l'API de listing est tombée en 500).

- Déploiement neuf : exécutez directement le `schema.sql` de la racine (idempotent, `CREATE TABLE IF NOT EXISTS`) ;
- Mise à niveau des anciennes bases : pour les nouvelles colonnes, exécutez `ALTER TABLE messages ADD COLUMN deleted_at TEXT;` / `ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;` / `ADD COLUMN read_at TEXT;` (note en fin de schema.sql) ;
- Bases en production déjà couvertes : la D1 CF (sms-gateway-db, 10 colonnes vérifiées) et la Turso EO (sms-gateway, déjà migrée) n'ont plus besoin de rien.

## 4. Rétention et nettoyage des données

- Nettoyage planifié (cron) : supprime les messages dont `received_at` est antérieur à `RETENTION_DAYS` (30 jours par défaut) ;
- Formes de déclenchement : cron natif de la plateforme (CF scheduled / Vercel Cron / Netlify Scheduled) ou tout planificateur appelant `GET /api/cron?token=<RECEIVE_TOKEN>`.

## 5. Notes d'usage de Turso (retour d'expérience de diagnostic)

- **Type de token** : l'API Token d'organisation (payload JWT avec org_id seul) ≠ token de base de données (payload avec `a:"rw"`). Le token de base de données se génère dans : console Turso → détails de la base → onglet Tokens ; avec le mauvais type, /v2/pipeline répond `invalid JWT token` → toutes les API DB renvoient 500 « internal error » (la page de connexion n'interroge pas la base, c'est pourquoi elle fonctionne).
- **Cache de clients** : le client Turso met en cache par empreinte de credentials (dbUrl+dbToken modifiés = reconstruction automatique) ; changer le token dans la console ne nécessite pas de redéploiement.
- **Diagnostic rapide** : appelez directement avec le token de base de données `POST https://<db-url>/v2/pipeline` (body : `{"requests":[{"type":"execute","stmt":{"sql":"SELECT 1"}},{"type":"close"}]}`).
