---
status: stable
shipped: null
owner: dudarenok-maker
---

# Narrator-only named characters survive Phase 0a + minor-cast fold

> Status: stable
> Key files: `server/src/handoff/schemas.ts`, `server/src/analyzer/fold-minor-cast.ts`, `skills/audiobook-character-detection-per-chapter.md`
> URL surface: none (analyzer-internal — affects cast.json shape post-analysis)
> OpenAPI ops: none (additive optional field on `Character`)

## Benefit / Rationale

- **User:** stops the analyzer from silently erasing canonical-but-rarely-quoted named characters from a book's cast. Concrete case that motivated this plan: Sela (Brann's goblin bodyguard) is absent from `C:\AudiobookWorkspace\books\Della Renwick\The Hollow Tide\Saltgrave\.audiobook\cast.json` across all ~65 Phase 0a stage1 outputs in `server/handoff/outbox/mns_S3qh0_FVnz-stage1-ch*.json`, and Garrow was detected in 1 chapter (`ch81.json`) then folded out by `fold-minor-cast.ts`'s `minLines: 3` threshold. With this plan in place, the next book in any series keeps its bodyguards / mentors / family in the cast for voice assignment.
- **Technical:** Phase 0a "Only actual speakers" rule and `fold-minor-cast.ts` `minLines: 3` drop are two compounding gaps. Characters who are referenced heavily in narration with role markers but rarely quote dialogue never cross the dialogue-detection threshold, and the minor-cast fold then completes the erasure for any who do slip through with <3 lines. The fix adds an opt-in `detectionSource: 'narrator-mention'` signal at Phase 0a + a `FoldOptions.protectedRoles` exemption at fold time, gated on BOTH signals so the protection is targeted (not blanket-keep-every-bodyguard).
- **Architectural:** purely additive schema change — `detectionSource` is an optional field on `CharacterOutput`. Existing cached stage1 outputs lack the field, default to the dialogue branch on read. No migration. The exemption is layered ON TOP of the existing zero-line drop and line-count fold rules — both still fire for non-narrator-mention characters and for narrator-mention characters whose role isn't on the protected list. Layer 1 ([plan 96](96-recover-missing-character.md)) shipped first; this plan paired with Layer 1's worked example uses the Saltgrave recovery as evidence that the systemic fix works on a real book.

## Architectural impact

- **New seams:**
  - Optional `detectionSource: 'dialogue' | 'narrator-mention'` field on `characterSchema` in `server/src/handoff/schemas.ts:54` (and therefore on `CharacterOutput`). Phase 0a may emit it; analyzers that don't are interpreted as `'dialogue'` (the default branch).
  - New `FoldOptions.protectedRoles?: string[]` in `server/src/analyzer/fold-minor-cast.ts:53-69`, default `PROTECTED_ROLES_DEFAULT = ['Bodyguard', 'Mentor', 'Family Member']`. New exported helper `matchesProtectedRole(role, list)` does case-insensitive substring matching so `'Goblin Bodyguard'` matches the `'Bodyguard'` entry.
  - New "Narrator-only named characters" section in `skills/audiobook-character-detection-per-chapter.md` documenting the four conditions (proper noun + ≥2 narration mentions + role/relationship marker + no dialogue this chapter) and the `detectionSource: "narrator-mention"` emission contract.
- **Invariants preserved:**
  - `characterSchema` stays additive — no required fields added; old data parses unchanged.
  - Existing `foldMinorCast` behaviour for `detectionSource: 'dialogue'` (the default) is unchanged: a bodyguard with 1 dialogue line still folds, a descriptor name ("Unknown Bodyguard") still folds even if marked narrator-mention (the descriptor rule wins).
  - Narrator is never folded (preserved from the original).
  - The no-op path (no folds, no drops) still preserves referential identity on the input arrays — the protected-character case where nothing else triggers a fold reaches the same fast-path.
- **Migration story:** none. The `detectionSource` field is optional; absent means dialogue. No reader needs to update.
- **Reversibility:** pass `protectedRoles: []` to `foldMinorCast` and the exemption is disabled — protected characters fall through to the normal fold/drop rules. Removing the field from a character's record also reverts behaviour. The Phase 0a prompt change can be reverted by deleting the new section; nothing downstream requires the field to exist.

## Invariants to preserve

1. **`detectionSource` is optional + additive.** `characterSchema` in `server/src/handoff/schemas.ts:54` carries it as `z.enum(['dialogue', 'narrator-mention']).optional()`. Existing analyses (including cached stage1 outputs from before this plan) have no field — the fold treats absence as `'dialogue'`.
2. **Protected-role exemption requires BOTH conditions.** `fold-minor-cast.ts:201` gates on `c.detectionSource === 'narrator-mention'` AND `matchesProtectedRole(c.role, protectedRoles)`. A protected-role character with `detectionSource: 'dialogue'` and <3 lines still folds normally — the protection is for characters the analyzer detected solely via narration, not a blanket keep-every-bodyguard rule.
3. **Descriptor-name fold wins over protected-role exemption.** `'Unknown Bodyguard'` with `detectionSource: 'narrator-mention'` is still folded by the existing descriptor trigger (`isDescriptorName(c.name)`). Protected status applies only when the character has a proper-noun name. See `fold-minor-cast.ts:199-201` for the order.
4. **`protectedRoles` matching is case-insensitive substring.** `matchesProtectedRole` in `fold-minor-cast.ts:91-95` lowercases both sides and tests `String.prototype.includes`. `'Goblin Bodyguard'` matches `'Bodyguard'`; `'Family Member (mother)'` matches `'Family Member'`. Empty list disables the exemption.
5. **Default protected roles are narrow.** `PROTECTED_ROLES_DEFAULT = ['Bodyguard', 'Mentor', 'Family Member']` (`fold-minor-cast.ts:81`). Extending the list adds protected categories — only add when corpus data shows a class of character being silently erased. Adding "Antagonist" or "Friend" would convert the targeted exemption into a blanket keep-every-named-character rule and defeat the minor-cast fold.

## Test plan

### Automated coverage

- `server/src/analyzer/fold-minor-cast.test.ts` — 29 cases total (22 existing + 7 new for this plan):
  - **Protects a narrator-mention character with a protected role from the zero-line drop** — Sela-in-Saltgrave worked example: detectionSource='narrator-mention', role='Bodyguard', 0 lines, survives intact (and the no-op fast path keeps referential identity).
  - **Protects a narrator-mention character with a protected role from the line-count fold** — Garrow-in-Saltgrave worked example: 1 dialogue line + narrator-mention + Goblin Bodyguard role → no fold, no bucket synthesised, Garrow stays on the roster.
  - **Still folds a protected-role character with `detectionSource: 'dialogue'` + too few lines** — negative case: protection is for narrator-mention only. A bodyguard the analyzer detected via real dialogue who only speaks once still folds.
  - **Does NOT protect a narrator-mention character whose role isn't on the protected list** — `'Background Speaker'` with detectionSource='narrator-mention' + 0 lines still drops.
  - **Descriptor-name fold wins** — `'Unknown Bodyguard'` with detectionSource='narrator-mention' still folds via the descriptor trigger (Unknown prefix is stronger than the role exemption).
  - **Honours `protectedRoles: []`** — disabling the list reverts to the original zero-line drop + line-count fold rules.
  - **`PROTECTED_ROLES_DEFAULT` lists the three canonical roles** (regression guard against accidental expansion).
- `server/src/analyzer/fold-minor-cast.test.ts` — `matchesProtectedRole` suite (new): case-insensitive matching, substring matching for qualified roles (`'Goblin Bodyguard'` ⊇ `'Bodyguard'`), no-match cases, missing/empty role guard, empty list guard.

The existing 22 fold tests remain green — the changes are additive and the fast-path / fold-into-bucket / line-count / descriptor / aliases rules are all preserved for non-narrator-mention characters.

### Manual acceptance walkthrough

The fix lives entirely in the analyzer path. The most reliable manual check uses the Lost Cities the Coalfall Commission manuscript (known-good fixture per CLAUDE.md), which has Ro on roster + narrator references to other bodyguards.

1. **Pick a test book** with the canonical the Coalfall Commission manuscript (`server/src/__fixtures__/the-coalfall-commission.md` — see CLAUDE.md). Confirm the workspace's `.audiobook/` is fresh OR delete `cast.json` and `manuscript-edits.json` to force a fresh analysis.
2. **Run analysis with `ANALYZER=gemini` + `GEMINI_API_KEY` set** (or `ANALYZER=local` if the local Ollama is running). The per-chapter Phase 0a prompt now contains the "Narrator-only named characters" section, so the model has an option to emit a narrator-only entry.
3. **Inspect a chapter where a bodyguard is referenced by name in narration but never speaks** — open the stage1 outbox JSON for that chapter (`server/handoff/outbox/{manuscriptId}-stage1-ch{N}.json`). The narrator-only bodyguard should appear with `detectionSource: "narrator-mention"` and an empty `evidence` array.
4. **After analysis completes, open the book in the running app** → Cast view → the narrator-only bodyguard appears in the roster with 0 lines, 0 scenes, voice slot `Unassigned`. Without this fix the bodyguard would either be missing entirely (Phase 0a never emitted them) or rolled into `Unknown male`/`Unknown female`.
5. **Verify the negative case** — a one-line-dialogue character with `detectionSource: 'dialogue'` (the analyzer's default) and a Bodyguard role still folds into `Unknown male` per the existing minor-cast rule. The protection is for narrator-only detections, not a blanket keep-every-bodyguard.

## Out of scope

- **Backfilling existing cast.json files** — this plan only changes how future analyses emit characters. To recover narrator-only characters in books already analysed, use [plan 96 (recover-missing-character.mjs)](96-recover-missing-character.md) — the manual hotfix script.
- **Adding more protected roles** — the default `PROTECTED_ROLES_DEFAULT` is narrow on purpose. Extending the list is a follow-up that needs corpus evidence (e.g. "in N analysed books, a class of character with role X is being silently erased").
- **Auto-detection of narrator-only characters by the server** — Phase 0a is the model's job. The server doesn't post-process narration to find missed named characters; that would duplicate the analyzer's work and is the wrong layer.
- **UI signal that a character is narrator-only** — `detectionSource` is currently invisible in the cast editor. A future UI follow-up could surface "0 lines (narrator mention)" so the user knows this character's voice profile is purely for any future restructure / dialogue addition.

## Ship notes

Shipped 2026-05-22 via PR — paired with [plan 96 (recover-missing-character.mjs)](96-recover-missing-character.md) which shipped same day as Layer 1. Together they close the Sela-in-Saltgrave real-data bug: Layer 1 unblocks the immediate gap (manual cast addition for already-analysed books), Layer 2 stops the analyzer from creating the gap in future books. Worked example for the plan: the Saltgrave recovery (`scripts/recover-missing-character.mjs` dry-run shows Sela + Garrow would be added to Saltgrave's cast as cast-only entries — no dialogue re-attribution because neither character has any `<Name> said` patterns in `manuscript-edits.json`).
