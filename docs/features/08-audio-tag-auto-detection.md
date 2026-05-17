# Audio tag auto-detection (server-side)

> Status: stable
> Key files: `server/src/parsers/audio-tags.ts`
> URL surface: none
> OpenAPI ops: none (runs in the analysis pipeline before sentences reach the client)

## What this covers

The server-side parser scans manuscript text and injects `[shouting]`, `[excited]`, `[hesitant]`, and `[emphatic]` tags based on punctuation and markdown/HTML emphasis. Detectors are idempotent — rerunning never stacks tags — and have an explicit precedence order so an `!`-laden ALL-CAPS shout doesn't get a redundant `[excited]` tag layered on top.

## Invariants to preserve

- **`[shouting]` rule** (`tagShoutingDialog`): triggers on dialog spans (between `"`/`"`/`"`) whose letter content is entirely uppercase, has ≥2 consecutive uppercase letters, AND has either ≥4 total letters OR ≥2 letters with `!` present. So `"HELP!"`, `"GET OUT!"`, `"NO!"` tag; `"OK"` and `"AC"` do not. (`server/src/parsers/audio-tags.ts:28-35`).
- **De-normalisation**: shouted runs are title-cased (`"HELP!"` → `[shouting] Help!`) so TTS reads words, not letters (`audio-tags.ts:40-42`).
- **`[excited]` rule** (`tagExcitedDialog`): dialog containing `!`, NOT already tagged, NOT a shouting run. So `"Wait — you mean it!"` → `[excited]`; `"GO!"` → `[shouting]` (excited skipped). (`audio-tags.ts:86-93`).
- **`[hesitant]` rule** (`tagHesitantDialog`): dialog starting OR ending with `…` or `..+`, NOT already tagged. So `"…I don't know."` → `[hesitant]`; `"Wait…"` → `[hesitant]`. (`audio-tags.ts:102-108`).
- **Precedence**: `shouting > excited > hesitant > emphatic`. A dialog line with both `!` and `…` becomes `[excited]` (commit `b4e3e9c` added the explicit excited-skips-hesitant guard via the `LEADING_TAG_RE` check on each subsequent pass).
- **Idempotence**: `LEADING_TAG_RE = /^\s*\[[a-z]+\]/i` (`audio-tags.ts:20`); every detector skips spans that already start with any audio tag. Re-running the pipeline never produces double tags.
- **Markdown emphasis** (`tagMarkdownEmphasis`): `**bold**`, `__bold__`, `*em*`, `_em_` → `[emphatic] body`. Single-char and double-char are handled in the right order so `**foo**` is not half-consumed (`audio-tags.ts:115-131`).
- **HTML emphasis** (`tagHtmlEmphasis`): `<em>`, `<i>`, `<strong>`, `<b>` (with optional attributes) → `[emphatic] body`. Must run BEFORE general HTML stripping (`audio-tags.ts:136-141`).
- **Quote scanner** (`rewriteQuoteSpans`): supports straight `"` and smart `"`/`"`; unterminated quotes are tolerated (don't crash); nested punctuation inside quotes is preserved verbatim (`audio-tags.ts:50-68`).

## Acceptance walkthrough

These tests should ideally live as a Vitest spec against `server/src/parsers/audio-tags.ts`. Until then, walk through manually in a REPL or via the analyser end-to-end.

### `tagShoutingDialog`

| Input                         | Expected output                                      |
| ----------------------------- | ---------------------------------------------------- |
| `She said "HELP ME!"`         | `She said "[shouting] Help me!"`                     |
| `She said "NO!"`              | `She said "[shouting] No!"`                          |
| `She said "OK"`               | `She said "OK"` (unchanged — only 2 letters, no `!`) |
| `She said "AC"`               | `She said "AC"` (initialism guard)                   |
| `She said "[whispers] HELP!"` | unchanged (already tagged)                           |
| `She said "GET out!"`         | unchanged (mixed case)                               |

### `tagExcitedDialog`

| Input                   | Expected output                                                         |
| ----------------------- | ----------------------------------------------------------------------- |
| `"Wait — you mean it!"` | `"[excited] Wait — you mean it!"`                                       |
| `"HELP!"`               | unchanged (shouting wins; would be tagged by `tagShoutingDialog` first) |
| `"[shouting] Help!"`    | unchanged (already tagged)                                              |
| `"OK."`                 | unchanged (no `!`)                                                      |

### `tagHesitantDialog`

| Input               | Expected output                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `"…I don't know."`  | `"[hesitant] …I don't know."`                                                                 |
| `"Wait…"`           | `"[hesitant] Wait…"`                                                                          |
| `"Wait..."`         | `"[hesitant] Wait..."` (2+ dots also triggers)                                                |
| `"Hi!"`             | unchanged (no ellipsis)                                                                       |
| `"[excited] Wait!"` | unchanged (already tagged — excited keeps precedence even if a hesitation cue is added later) |

### `tagMarkdownEmphasis`

| Input                             | Expected output                   |
| --------------------------------- | --------------------------------- |
| `She **really** meant it.`        | `She [emphatic] really meant it.` |
| `She *really* meant it.`          | `She [emphatic] really meant it.` |
| `She __really__ meant it.`        | `She [emphatic] really meant it.` |
| `She _really_ meant it.`          | `She [emphatic] really meant it.` |
| `She * meant *` (stray asterisks) | unchanged                         |

### `tagHtmlEmphasis`

| Input                                             | Expected output                   |
| ------------------------------------------------- | --------------------------------- |
| `She <em>really</em> meant it.`                   | `She [emphatic] really meant it.` |
| `She <strong class="x">really</strong> meant it.` | `She [emphatic] really meant it.` |

### Idempotence

Run the full pipeline twice on `"HELP ME!"` and confirm output is unchanged on the second pass.

## Out of scope

- Cross-language detection (vocabulary is English).
- ML-driven tone detection — only punctuation/markdown heuristics.
- User-editable detector rules.
