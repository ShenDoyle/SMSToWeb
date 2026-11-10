# Documentation i18n

**English** is the primary maintained language of this repository's documentation. This directory holds the eight translated mirrors (`zh-CN`, `zh-TW`, `ja`, `ko`, `es`, `fr`, `de`, `pt-BR`).

> **Sync status (2026-11-09, M-2 pass)**: the English primary `README.md`, the Chinese primary docs (`docs/`) and the new [Chinese user guide](../guide/README.md) were corrected for current facts. **All eight translated mirrors remain intentionally lagging** — a full re-translation is out of scope and machine-looking placeholder translations are forbidden by [MAINTENANCE.md](MAINTENANCE.md). However, every mirrored `README.md` / `ARCHITECTURE.md` now carries a **"Sync notice (2026-11-09)"** block at the top listing the verified current facts: **850** tests, **33** `ENV_KEYS`, all six entries pass a `waitUntil`-style `ctx`, Node **80s** app grace with **≥90s** container stop grace, and the **narrow** scope of `gen_app.py --check`. This satisfies the rule "translations may lag; silently wrong is not": outdated statements (667/814 assertions, 31 variables, "other platforms finish notifications before the response", 8-second forced exit, deploy button creating tables) are explicitly flagged instead of being left to look current.
>
> Developer-facing documents added for v1.0.4 — [Design System](../DESIGN-SYSTEM.md) and [Settings Center](../SETTINGS.md) — are maintained in the primary languages only and are intentionally **not mirrored** (they describe internal implementation conventions, not end-user instructions). Version strings in translations are not release markers — source `v1.1.0` has been finalized on `main` (commit `43aaecf`); **no GitHub Release has been created, no tag has been pushed, and no deployment has been performed**; real-platform runtime validation is 0/6.

## Language index

| Language | README | Full index |
|---|---|---|
| 简体中文 | [README](zh-CN/README.md) | [zh-CN](zh-CN/) |
| 繁體中文 | [README](zh-TW/README.md) | [zh-TW](zh-TW/) |
| 日本語 | [README](ja/README.md) | [ja](ja/) |
| 한국어 | [README](ko/README.md) | [ko](ko/) |
| Español | [README](es/README.md) | [es](es/) |
| Français | [README](fr/README.md) | [fr](fr/) |
| Deutsch | [README](de/README.md) | [de](de/) |
| Português (BR) | [README](pt-BR/README.md) | [pt-BR](pt-BR/) |

## File name mapping

Translated files are renamed to ASCII slugs for URL safety. The authoritative source file stays where it is in the repo (English at the repo root, Chinese deep-dives under `docs/`).

| Source file | Translated file (`docs/i18n/<lang>/`) |
|---|---|
| `README.md` (English primary) | `README.md` |
| `docs/多平台接入部署指南.md` | `DEPLOYMENT.md` |
| `platforms/README.md` | `PLATFORMS.md` |
| `platforms/cloudflare/README.md` | `CLOUDFLARE.md` |
| `platforms/vercel/README.md` | `VERCEL.md` |
| `platforms/netlify/README.md` | `NETLIFY.md` |
| `platforms/deno/README.md` | `DENO.md` |
| `platforms/edgeone/README.md` | `EDGEONE.md` |
| `platforms/node/README.md` | `NODE.md` |
| `docs/API.md` | `API.md` |
| `docs/ARCHITECTURE.md` | `ARCHITECTURE.md` |
| `docs/DATABASE.md` | `DATABASE.md` |

## Out of scope (not translated)

Internal archives and audit working papers are intentionally excluded from translation and stay in their original location, including:

- `docs/项目审查报告-2026-10-20.md` and other internal audit/review reports
- `tests/` and `platforms/gen_app.py` inline comments
- Changelog-style commit messages

## Sync rules

See [MAINTENANCE.md](MAINTENANCE.md) for how updates to the English primary propagate to translations.
