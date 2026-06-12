---
status: stable
shipped: null
owner: dudarenok-maker
---

# Recover missing character — manual cast script

> Status: stable
> Key files: `scripts/recover-missing-character.mjs`, `scripts/tests/recover-missing-character.test.mjs`
> URL surface: none (scripted, runs against the workspace on disk)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** unblocks the case where Phase 0a per-chapter detection misses a canonical-but-rarely-quoted named character — bodyguards / mentors / family who are referenced heavily in narration but rarely speak. Concrete example that motivated this plan: in `C:\AudiobookWorkspace\books\Della Renwick\The Hollow Tide\Saltgrave\.audiobook\cast.json`, Sela (Brann's goblin bodyguard) is absent entirely (0 detections across all ~65 Phase 0a stage1 outputs in `server/handoff/outbox/mns_S3qh0_FVnz-stage1-ch*.json`) and Garrow was detected in 1 chapter then folded out by `server/src/analyzer/fold-minor-cast.ts`'s `minLines: 3` threshold. The script gets them into the roster so the user can assign voices without waiting for a Phase 0a re-run.
- **Technical:** avoids a Phase 0a re-run — re-running the same analyzer with the same prompt would miss the same character for the same reason (per `feedback_verify_reanalysis_actually_needed`). The script is also additive: appending one character entry + flipping per-sentence `characterId` is mechanical and reversible.
- **Architectural:** establishes a manual-recovery seam BEFORE the analyzer-side fix in [plan 97](97-narrator-only-named-characters.md) lands. Layer 1 ships independently of Layer 2 so the user can fix the immediate Saltgrave gap without waiting for the systemic change, and Layer 2's regression plan can cite the Saltgrave recovery as the worked example.

## Architectural impact

- **New seams:** none in the running app. New Node ESM script under `scripts/` with paired `node:test` coverage in `scripts/tests/` — same pattern as `scripts/relufs-existing.mjs` and `scripts/bump-version.mjs`. Hooks into the existing `test:hooks` step of `verify:fast` automatically (`scripts/run-hooks-tests.mjs` globs `scripts/tests/*.test.mjs`).
- **Invariants preserved:**
  - `Character` shape in `openapi.yaml:133-140` — the appended entry carries `id`, `name`, `role`, `gender`, `ageRange`, `description`, `attributes`, `tone`, `evidence`, `lines`, `scenes`, `voiceState: "unassigned"`. No `matchedFrom` (that field is for series-prior carries; this is a manual add).
  - Atomic JSON writes — temp file + `renameSync` mirrors `server/src/workspace/state-io.ts:writeJsonAtomic`.
  - `voiceState: "unassigned"` keeps the recovered character out of the synth path until the user assigns a voice via the cast editor.
- **Migration story:** none. The character entry is additive to `cast.json`. The change-log gets one new event of `type: "character_manually_added"`.
- **Reversibility:** open the book's `.audiobook/cast.json` and remove the character entry; revert any flipped sentences in `manuscript-edits.json` by hand. The change-log entry pins what was added, including the count of re-attributed sentences.

## Invariants to preserve

1. **kebab-case id convention** matches the analyzer's id shape. `toKebabId('Mr. Casper') === 'mr-casper'`, `'Councillor Reld' → 'councillor-reld'`. A future Phase 0a re-run with [plan 97](97-narrator-only-named-characters.md) in place produces the same id, so the manual entry merges cleanly instead of orphaning.
2. **Refuses double-add** by checking `cast.characters[].id` collision before write. Prevents accidental duplicate entries on repeat invocations.
3. **Dialogue re-attribution is bounded to the immediately-preceding sentence** in the same chapter. The script never re-attributes across chapter boundaries (Phase 1 ids are per-chapter scoped) and only flips sentences currently attributed to `narrator` (a tag sentence already attributed to a non-narrator character represents third-party observation, not a true tag — see `findDialogueReattributions` for the rule).
4. **Word-boundary matching on the speaker name** prevents `'Sela'` matching the substring `'Selaa'` (different person) or `'grow'` matching `'growth'`. Both directions of the boundary are checked.
5. **Dry-run by default** — `--apply` is required to write. Matches the convention in `scripts/relufs-existing.mjs`.

## Test plan

### Automated coverage

- `scripts/tests/recover-missing-character.test.mjs` — 18 cases covering:
  - `parseArgs`: arg shape (positional bookDir + named --name/--gender/--role), `--apply` flag, unknown-flag rejection, multiple-positional rejection.
  - `toKebabId`: matches the analyzer id convention across simple names, names with punctuation (`'Mr. Casper'`), accented names (NFD-normalised), and whitespace.
  - `buildCharacter`: shape against the `Character` schema — id / name / role / gender / ageRange, four-axis `tone`, `voiceState: 'unassigned'`, no `matchedFrom`, generated description fallback.
  - `findDialogueReattributions`: catches `<Name> said` / `growled` / `warned`; multiple verbs in one chapter; chapter-boundary bounded; ignores third-party tags (sentence already attributed to a non-narrator); word-boundary false-positive guard against `'Selaa'` and similar substrings.
  - `buildChangeLogEntry`: type `character_manually_added`, actor `user-script`, note text for both 0-line and N-line counts.
  - `main --apply`: end-to-end against a fixture book dir — writes cast.json + manuscript-edits.json (re-attributed) + change-log.json.
  - `main` dry-run: leaves all three files untouched.
  - `main` refuses to double-add an existing id (exits 1).

Wired into `npm run test:hooks` via `scripts/run-hooks-tests.mjs`. Runs as part of `verify:fast` (pre-commit gate).

### Manual acceptance walkthrough

The script is invoked from a terminal, not from the app — no URL hashes or redux state to assert.

1. **Dry-run against the Saltgrave workspace book:**
   ```
   node scripts/recover-missing-character.mjs "C:\AudiobookWorkspace\books\Della Renwick\The Hollow Tide\Saltgrave" --name Sela --gender female --role Bodyguard --description "Brann's goblin bodyguard"
   ```
   → expected output:
   ```
   [plan] add character to ...\.audiobook\cast.json:
     id="sela" name="Sela" role="Bodyguard" gender="female"

   [plan] proposed dialogue re-attributions: 0

   [dry-run] no files written. Re-run with --apply to commit.
   ```
   (Saltgrave has zero `Sela said`/`growled`/etc. patterns in `manuscript-edits.json`, so the dialogue-tag scan finds nothing — the recovery is cast-only.)
2. **Apply mode:** append `--apply` to the same command. The script writes the cast entry + a `change-log.json` event with `type: "character_manually_added"`, no manuscript-edits change.
3. **Repeat the script for Garrow:**
   ```
   node scripts/recover-missing-character.mjs "...\Saltgrave" --name Garrow --gender male --role "Goblin Bodyguard" --description "Wren's fierce goblin bodyguard." --apply
   ```
4. **Verify in the cast view:** open the book in the running app (`npm start`) → Cast view → both Sela and Garrow appear in the roster with `0 lines`, `0 scenes`, voice slot `Unassigned`. The voice library "Suggest voice" path can now match them.
5. **Re-run refuses:** re-invoke step 2 with `--apply` → exits 1 with `character id "sela" already exists in ...cast.json. Refusing to double-add.`.

## Out of scope

- **Auto-detection of missing characters** — the script takes a `--name` argument; it does not scan the manuscript for named-but-uncasted characters and propose recoveries. A future enhancement could do that (cross-reference series-prior casts with the current book's cast).
- **Phase 0a re-run with corrected prompts** — that is [plan 97 (Layer 2)](97-narrator-only-named-characters.md). Layer 1 here is the manual hotfix; Layer 2 is the systemic fix that makes Layer 1 unnecessary for future analyses.
- **Voice assignment for the recovered character** — the script writes `voiceState: "unassigned"` and stops there. The user assigns a voice via the existing cast editor.
- **Recovery via the running app's API** — the script writes to disk directly. The same logic could become a `POST /api/books/:bookId/cast/manual-add` endpoint later; deferred until the in-app analysing-view surfaces the gap (today there is no UI signal that a character is missing).

## Ship notes

Shipped 2026-05-22 via PR — recover-missing-character script + 18 paired `node:test` cases. Worked end-to-end against the Saltgrave workspace data for both Sela and Garrow (dry-run shows correct plan; `--apply` writes cast.json + change-log.json). Layer 2 ([plan 97](97-narrator-only-named-characters.md)) is the follow-up that stops the analyzer from dropping these characters in the first place.
