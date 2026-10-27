# Documentation i18n

**English** is the primary maintained language of this repository's documentation. This directory holds the eight translated mirrors (`zh-CN`, `zh-TW`, `ja`, `ko`, `es`, `fr`, `de`, `pt-BR`).

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
