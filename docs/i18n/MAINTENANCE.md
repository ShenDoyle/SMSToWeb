# Documentation Maintenance Rules

How documentation updates flow between the English primary and the eight translated mirrors.

## Principles

1. **English is the source of truth.** The root `README.md` and the English set under `docs/i18n/en/` are maintained first. Every translated file is derived from the English primary.
2. **Translations may lag.** A translation that is one feature release behind is acceptable; silently wrong is not. Each translated file carries the primary version it was synced from (see "Sync stamp" below).
3. **No machine-looking placeholders.** A translated file either fully exists in that language or is removed from that language directory. Never commit partial files with untranslated skeletons.
4. **Links are adjusted, not translated.** Relative links to repo assets (`platforms/...`, `LICENSE`) get `../../` depth prefixes. Cross-language links always point to the same file in the target language directory.

## Sync workflow

When a doc-affecting change lands in the English primary:

1. Edit the English primary file (root `README.md` or `docs/i18n/en/*.md`).
2. Bump the sync stamp in every affected translated file, or update the translation in the same change if the diff is small (a few paragraphs).
3. If a section changed structurally (new/removed tables, renamed env vars), update all eight translations before the next release. For day-to-day edits, mark stale files in the translation's front-matter note instead of leaving silently outdated content.
4. Run a link check on changed files: every `](...)` target must exist in the repo.

## Sync stamp

The first line after the language switcher in every translated file records what it was synced from:

```
> Synced from English primary @ 2026-10-27
```

Reviewers reject translation PRs that change technical facts without a matching English-primary change.

## Adding a new language

1. Create `docs/i18n/<lang>/` using the IETF language tag as the directory name (`pt-BR`, not `pt_br`).
2. Translate all 12 files from the [mapping table](README.md#file-name-mapping).
3. Add the language to the switcher line in the root `README.md`, `docs/i18n/README.md`, and every existing translated README (they all carry the same switcher row).
4. If the UI language already exists in `src/worker.js` (`I18N`/`D` dictionaries), no frontend change is needed; otherwise add the dictionary block first — the test suite enforces key parity across all UI languages (`node tests/run.mjs`).

## UI vs docs

- **UI strings** live in the embedded dictionaries in `src/worker.js` (`I18N` for the admin page, `D` for the login page). They are synced to all six platforms by `platforms/gen_app.py` — never edit platform copies directly.
- **Docs** follow this file's rules. The two systems are independent; a docs-only change never requires rebuilding platform copies.
