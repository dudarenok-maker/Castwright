# Russian cast de-duplication + tone population — design

- **Date:** 2026-06-20
- **Status:** approved (brainstorm), adversarially reviewed + revised, pre-plan
- **Branch:** `fix/server-ru-cast-dedup-tone`
- **Extends:** plan [221 — Multilingual attribution](../../features/221-multilingual-attribution-gemma-and-cast-merge.md)
  (re-opens its Wave C, which was wrongly closed as "OBSOLETE"); builds on plan
  219 (`unicodeKebab`/`safeId`) and Wave E (the `languagePreamble` cast-field guard).

## Problem (reproduced from persisted data, not inferred)

A full local analysis of *Ночной дозор* (Сергей Лукьяненко, workspace
`C:\AudiobookWorkspace`, language `ru`, 9 chapters) on **`gemma4-e4b-8gb:latest`**
produces two distinct user-visible defects, confirmed by inspecting the book's
persisted `.audiobook/cast.json` (28 characters):

### Defect 1 — duplicate cast entries (same person, two ids)

Every duplicate pair is the **same Cyrillic display name** emitted once with a
Cyrillic-kebab id and once with a Latin-transliterated id:

| Display name | id #1 | id #2 |
|---|---|---|
| Ольга | `ольга` | `olga` |
| Илья | `ilya` | `илья` |
| Семен | `semen` | `семен` |
| Тигренок | `тигренок` | `tigrenok` |

**Root cause (model-independent):** a character's `id` is taken **verbatim from
the analyzer model**. The model inconsistently transliterates the id across
chapters. `mergeRosterChapter` (`server/src/routes/analysis.ts:~560`) merges by
**exact id only** (`roster.get(incoming.id)`), so `ольга` ≠ `olga` → never
merged. Plan 219's `unicodeKebab`/`safeId` only governs ids **we** mint (book
ids, paths, auto-added missing speakers) — it is never applied to re-canonicalise
the model's emitted character id, so the transliteration drift leaks through.

This was plan 221's Defect 1 / Wave C. Wave C was closed as "OBSOLETE — 0
duplicate groups" based on a single `repro-remeasure.mts` probe run on
`gemma4-e4b`. That was a **false negative**: gemma is stochastic, the probe run
happened to emit consistent ids, and a real 9-chapter run drifts. The fix must
therefore be **model-independent**, not a per-model prompt tweak.

### Defect 2 — tone profiles not populated (2/28 characters)

The cast drawer shows a neutral 50/50/50/50 tone for almost every character.

**Root cause (verified in code, not inferred):** `characterSchema.tone` is
`toneSchema.optional()` and every axis inside `toneSchema` is `.optional()`
(`server/src/handoff/schemas.ts:14-21,57`). That schema is converted to JSON
Schema and fed to the model as a **constrained-decoding grammar**
(`ollama.ts:319`, `runStage`). So the grammar the model must follow says *"tone
is optional — skip it,"* while the `languagePreamble` prompt (Wave E) says
*"always emit tone."* **Under constrained decoding the grammar wins** — gemma
takes the omission on 26/28. Wave E's prompt-only fix could never stick.

### Not in scope (separate root causes — follow-ups)

- **Mixed-language attribute tags** (`professional`/`tired`/`прагматичная` on one
  character): the `languagePreamble` "write attributes in Russian" instruction is
  ignored by the model — a localisation-compliance issue, distinct from tone.
- **Narrator-`я` mis-roster** (the model rosters the first-person pronoun "я" /
  the byline author as a speaking character): tracked as bug #938.

## Goals

1. Same-person duplicate roster entries collapse automatically and safely, with
   no false merges (especially never folding the narrator into a character).
2. Harder same-person cases (full-vs-short, diminutives) are caught — auto where
   structurally safe, suggested-with-one-tap-confirm where riskier.
3. Every character ends analysis with a populated, meaningful tone profile.
4. No regression to English books or to existing cached `cast.json` files.

## Design

### Fix 1 — de-duplication engine (backend)

A new pure module `server/src/analyzer/roster-dedup.ts`:

```
dedupeRosterByName(
  characters: CharacterOutput[],
  sentences: ReadonlyArray<{ characterId: string; ... }>,
  opts: { language?: string },
): { characters: CharacterOutput[]; rewrites: Record<string,string>; suggestions: MergeSuggestion[] }
```

Shape deliberately mirrors `foldMinorCast` (`server/src/analyzer/fold-minor-cast.ts`),
which already returns `{ characters, rewrites }` and rewrites sentence
`characterId`s — the proven template for this kind of pass.

**Placement.** Runs at the two finalisation sites (`analysis.ts:~3923` and
`:~4895`) **before** `foldMinorCast`, so same-person line counts are summed
before the minor-cast `<3 lines` fold threshold is applied (otherwise Ольга's
8-line half could be folded into a background bucket while her 203-line half
stays). The route:

1. `const dd = dedupeRosterByName(stage1.characters, recovered.sentences, { language })`
2. apply `dd.rewrites` to `recovered.sentences`
3. `const folded = foldMinorCast(dd.characters, rewrittenSentences, { ... })`
4. compose `dd.rewrites` then `folded.rewrites` into a **transitively-closed**
   cumulative table for downstream consumers (the `writeFoldJournal` calls at
   `:4028`/`:5008`). Closure matters: a Tier-1 canonical id (`ольга`) can itself
   be folded by `foldMinorCast` into `unknown-female`, so the cumulative map must
   resolve `olga → ольга → unknown-female`, not stop at `olga → ольга` (review
   MAJOR-5).

> **Review MAJOR-5 — journal reversibility.** The fold journal
> (`buildFoldJournalEntries`, `cast-merges.ts:78-101`) computes each entry's
> `affected` sentences by matching **pre-fold** sentences against rewrite *source*
> ids and reads `sourceName` from the **pre-fold** roster. If dedup rewrites
> sentences *before* the fold (step 2) and hands the fold the already-rewritten
> sentences, the dedup source ids are gone from the sentence list → empty
> `affected`, missing `sourceName`, and the un-merge flow (`cast-aliases.ts`) can't
> reverse a dedup merge. **Therefore dedup writes its OWN journal entries** (to the
> same `cast-merges.json`) computed against the **pre-dedup** sentences and roster,
> recording each `sourceId → canonicalId` with its affected sentences and source
> name. Un-merge stays reversible because `impactedChaptersFromJournal`
> (`cast-aliases.ts:280`) matches on `targetId`/`sourceName` and is
> **provenance-agnostic** (ignores `kind`) — provided the survivor carries the
> source name as an alias chip (`cast-aliases.ts:117`), which the shared
> merge-field logic already does.
>
> **Pass-2 lifecycle fix.** A dedup entry must NOT be `kind:'fold'` (the
> subsequent `writeFoldJournal`→`replaceFoldEntries`, `analysis.ts:697`, would
> **wipe** it) and must NOT be `kind:'manual'` (`appendManualEntry` is append-only
> → **duplicate accumulation** on every non-`fresh` resume). Add a dedicated
> **`kind:'dedup'`** plus an idempotent **`replaceDedupEntries`** (mirrors
> `replaceFoldEntries`, filters `e.kind !== 'dedup'`) so a re-run replaces rather
> than appends. The fold journal then runs on the post-dedup state as today.
> **Pass-3:** `kind` is a plain TS union (`'manual' | 'fold'`, `cast-merges.ts:41`)
> read with no schema validation — widening it to add `'dedup'` is a **one-line type
> edit, no openapi/`api-types` regen**. The three replace/append paths are orthogonal
> (each preserves the other kinds), so no read-collision.

**Shared merge-field logic.** When two entries collapse, fields combine exactly
as `mergeRosterChapter` already does: longest `description` wins; `attributes` /
`aliases` / `evidence` union-dedup; `gender` / `ageRange` first-detection wins; a
divergent name form becomes an alias. This logic is extracted into a small shared
helper so dedup and `mergeRosterChapter` agree.

**Three detectors, applied in order — Tier-1, then Tier-2a, then Tier-2b** — each
operating on the output of the previous (so Tier-2a sees already-canonicalised
Tier-1 ids):

- **Tier-1 — exact normalised name → auto-merge, gender-gated.** Group by
  `normaliseNameKey(name)` (`util/safe-id.ts:76` — Unicode-exact, no
  transliteration). Canonical id = `safeId(name)` (deterministic: `Ольга` →
  `ольга` every time). All group members' ids remap to the canonical id. Catches
  all four screenshot cases. **Gates (review MINOR-4):** never the narrator (see
  the absolute rule below); and members must not disagree on `gender` — Tier-1 is
  the most likely false-merge vector (two genuinely different `Иван`s), and its
  union-merge *sums* lines/scenes/evidence irreversibly, so a gender clash splits
  the group rather than conflating two people.

- **Tier-2a — full-vs-short token-subset → auto-merge, gated.** The shorter
  name's whitespace tokens are all leading tokens of exactly one longer name
  (`Антон` ⊂ `Антон Городецкий`; Russian name order is first · patronymic ·
  surname, so leading-subset is reliable). **Gates — all required:** (1) neither
  entry is the narrator (`id === 'narrator'` — see the absolute rule below);
  (2) `gender` agrees or one side is unknown; (3) exactly **one** superset
  candidate exists for the short name (any ambiguity → skip, leave to manual).
  The two entries have **different** names, so `safeId(name)` can't pick the
  canonical id: the survivor is the entry with **more lines** (its id and display
  name win); the other entry's id remaps to it and its name becomes an alias.
  **Determinism (pass-2):** line counts are computed from the `sentences` arg, not
  `c.lines` (stage-1 leaves that undefined — `attachLinesAndScenes` runs *post*-fold,
  `analysis.ts:3945`); ties break by **roster insertion order** (stable per
  `mergeRosterChapter`).

- **Tier-2b — diminutive curated map → suggestion only (never auto-applied).** A
  curated bidirectional Russian diminutive↔canonical table
  (`Оля↔Ольга`, `Соня↔Софья`, `Саша↔Александр/Александра`, `Дима↔Дмитрий`, …, ~80
  common entries). Two entries whose canonical base matches, passing the same
  non-narrator + gender gates, emit a `MergeSuggestion { sourceId, targetId,
  reason }`.
  > **Pass-2 — multi-gender diminutives.** Some diminutives map to canonicals of
  > **both** genders (`Саша`→Александр/Александра, `Женя`→Евгений/Евгения,
  > `Валя`→Валентин/Валентина). The normal gate ("gender agrees OR one side
  > unknown") is **blind** here: two distinct `Саша`s with gender unset (common on
  > gemma) would be suggested. For table rows flagged multi-gender, require **both
  > sides to carry a concrete, agreeing `gender`** (no "unknown" pass); otherwise
  > skip. Single-gender rows keep the normal gate. **Pass-3:** the gate is
  > *gender-safe*, not same-person-proof — two different same-gender people both
  > nicknamed `Саша` remain a **dismissable** false-positive suggestion (by design;
  > suggestion-only, never auto-merged).

  **No edit-distance** — `Маша`/`Миша` differ by one character but are
  different people of different genders; the table is a linguistic lookup, not
  fuzzy string distance.

**Narrator protection is absolute** across **every** tier including Tier-1 — the
narrator can never be a merge source or target. This single rule defuses the
plan-221 Wave E disaster (the model once mis-attributed `Антон Городецкий` onto
the narrator's id; a blind token-subset merge would have folded the entire
narrator into Anton).

> **Review MAJOR-4 correction:** the predicate is **`id === 'narrator'` only** —
> NOT `color === 'narrator'`. `color === 'narrator'` is wrong both ways: it
> over-matches (the `unknown-male`/`unknown-female` fold buckets are stamped
> `color:'narrator'`, `fold-minor-cast.ts:277`) and it *misses* the real narrator,
> whose colour is often `'unset'` or a Russian-named/model-assigned value
> (the narrator row originates from model output, `analysis.ts:1409`). The durable
> convention is the `id`. Tier-1's narrator-safety must be **enforced**, not left
> incidental to `safeId('Narrator')==='narrator'`. **Also (pass-2):** guard the
> *computed* canonical id — a non-narrator group literally named "Narrator"
> (`safeId('Narrator')==='narrator'`) must never remap onto the real narrator row;
> reject any group whose canonical id resolves to `'narrator'`.

### Fix 1 (cont.) — designed-voice carry-forward (review BLOCKER-1)

Designed-voice links live inline on the character row, **keyed by character `id`**
(`overrideTtsVoices`, `voiceUuid`, `ttsEngine`, `voiceStyle`, `voiceId`,
`matchedFrom`), and carry-forward across a re-analysis is **id-matched** —
`mergeAnalysisResultWithExistingCast(priorCastForMerge, characters)`
(`merge-analysis-cast.ts:93-160`, `PRESERVED_VOICE_FIELDS`) and
`preserveDesignedVoicesOnCastWrite` (`preserve-cast-voices.ts:22-37`). Stage-1
output carries **no** voice fields, so the prior row's voice is re-applied purely
by id.

(`merge-analysis-cast.ts` lives in `server/src/store/`.)

**Scope narrowing (pass-2):** for the **Tier-1 same-name** cases (the four
screenshots — identical display name, drifted id), `mergeAnalysisResultWithExistingCast`
already has a **same-name fallback** (`merge-analysis-cast.ts:103-141`) that rides a
dropped voiced row onto a same-name fresh row, so those are largely covered today.
The genuine exposure is the **Tier-2a/2b different-name survivors** (`Антон`↔`Антон
Городецкий`), where the names differ, the fallback misses, the voice is **dropped**,
and the prior row is re-added as a **0-line orphan** (`merge-analysis-cast.ts:155-158`,
`voicedSurvivorsDropped` at `analysis.ts:4046`).

**Fix:** remap each `priorCastForMerge` row's id through `dd.rewrites` (transitive
closure) **before** the voice overlay, so the prior voice lands on the canonical
survivor row with no orphan. Equivalent: thread the rewrite into
`mergeAnalysisResultWithExistingCast` / `preserveDesignedVoicesOnCastWrite` as an
id-alias map.

> **Pass-2 BLOCKER — collision policy is mandatory, not a one-liner.** Two prior
> voiced rows can remap to the **same** canonical id (prior `olga` AND prior `ольга`,
> each with a *different* designed voice, both → `ольга`). `mergeAnalysisResultWithExistingCast`
> builds `new Map(existing.map(c => [c.id, c]))` (`:98`) → **last-write-wins, the
> other designed voice is silently lost**, and `voicedSurvivorsDropped` can't report
> it (the id now matches a fresh row). The dedup must **resolve voiced collisions
> explicitly before remapping**: keep the voice of the row with the strongest
> `voiceState` (`locked` > `tuned` > `reused` > `generated` — the persisted enum,
> `schemas.ts:71`; present on `priorCastForMerge` rows via `PRESERVED_VOICE_FIELDS`),
> tie-break by more lines, and **log** every dropped voice via the existing
> best-effort change-log writer pattern (`logCarriedForwardCharacters`,
> `analysis.ts:148`). `preserveDesignedVoicesOnCastWrite`
> (`preserve-cast-voices.ts:27`, id-only, no name fallback) has the same exposure on
> the frontend `PUT /state` path, so dedup ids must never reach it un-rewritten.
> This is a **named, tested seam**.

> **Upside:** canonicalising ids to `safeId(name)` makes them **deterministic
> across re-runs** — the model's transliteration drift was itself a source of
> reuse-link instability, so post-fix re-analyses match prior voices *more*
> reliably than today (once the transition run above is handled).

### Fix 1 (cont.) — diminutive suggestions surface (frontend)

`dedupeRosterByName` returns `suggestions`, persisted to a **sibling file**
`cast-merge-suggestions.json` (a new path helper in `workspace/paths.ts`, sibling
to `cast-merges.json`) — **NOT** on the `cast.json` envelope.

> **Review MAJOR-3 — why a sibling, not the envelope.** `cast.json` has no
> `.strict` envelope schema, so a `mergeSuggestions` field would *survive reads*
> but be **stripped by ~9 fresh-`{ characters }` writers** — every analysis
> persist (`analysis.ts:2977…5021`), the frontend cast-save `PUT /state`
> (`book-state.ts:104,567`), cast-aliases, cast-series-patch, and — cruelly — the
> manual **merge** route itself (`cast-merge.ts:189`). So accepting one suggestion
> would erase the rest mid-review. A sibling file is untouched by those writers.

**Lifecycle (pass-2):** dedup **overwrites** (replaces, never appends) the sibling
file at every finalization, and the `fresh:true` analysis reset
(`analysis.ts:2309`, beside `clearCastMerges`) **deletes** it — otherwise stale
suggestions referencing now-gone ids leak into a fresh run.

**Honest surface (pass-2 — not "thin"):** a GET route (list suggestions), an
accept route (delegates to the existing merge route, then drops the suggestion) and
a dismiss route (drops it); an `openapi.yaml` entry + `npm run openapi:types` regen;
a redux fetch keyed to analysis-complete; the cast-review card; one e2e spec.

Cast review renders each as a one-tap card:

> *These look like the same person: **Оля** + **Ольга** — [Merge] [Dismiss]*

- **Merge** calls the **existing** manual-merge route (`server/src/routes/cast-merge.ts`),
  which requires both ids to be standing rows and matches by id only. The
  suggestion must pass `target = canonical survivor`, `source = the other`
  (review MINOR-2 — the route performs **no** same-person check, so direction and
  correctness are the suggestion's responsibility). On success the accepted
  suggestion is removed from the sibling file.
- **Dismiss** removes the suggestion from the sibling file.

This is the only net-new UI. It crosses analysis → redux → cast review, so it
gets one Playwright e2e spec.

### Fix 2 — tone population (two layers; deterministic fill is the reliable one)

> **Review MAJOR-1 + MAJOR-2 reframe.** The original "force `tone` required in the
> schema → grammar forces emission" is (a) a **no-op unless the wrapper schemas
> are rewired** — stage-1 actually feeds `stage1ChapterSchema` (per-chapter,
> `ollama.ts:255` / `gemini.ts:220`) and `stage1Schema` (whole-book/chunked),
> which *embed* `characterSchema` (`schemas.ts:101,113`); a standalone
> `analyzerCharacterSchema` changes nothing the model sees — and (b) **dangerous
> if made hard-required**: the Gemini path sends **no grammar at all** (schema is
> only post-hoc Zod validation, `gemini.ts:259-316`), so a missing required `tone`
> → `schema-validation` → one retry → on a second miss the **whole chapter's
> detection throws**. And there's no in-repo evidence llama.cpp honours `required`
> on nested objects (it's documented to ignore `additionalProperties:false`,
> `ollama.ts:313`). **So Layer 2 is the reliable mechanism; Layer 1 is a
> non-fatal best-effort nudge.**

**Layer 1 — grammar-forced tone via a two-schema `runStage` (non-fatal).**

> **Pass-2 correction — this needs a signature change, not a single schema.**
> `runStage` currently takes ONE `schema` and uses it for **both** `z.toJSONSchema`
> (grammar) **and** `parseAndValidate` (validation) (`ollama.ts:319,338`;
> `gemini.ts:284`). You cannot get "required-in-grammar + optional-in-validation"
> from one Zod object. So Layer 1 **changes the signature**:
> `runStage<T>(manuscriptId, key, skill, promptMd, grammarSchema: z.ZodType<unknown>, validationSchema: z.ZodType<T>, call)`
> in **both** `ollama.ts` and `gemini.ts`. The output type `T` derives from
> `validationSchema` (the one fed to `parseAndValidate`), so `grammarSchema` may be a
> structurally-different required-tone schema without perturbing the inferred result.
> `runStage` has exactly **4 callers per engine** — `runStage1`, `runStage1Chapter`,
> `runStage2Chapter`, `runEmotionChapter` (`runStage2ChapterChunked` calls
> `runStage2Chapter`, not `runStage` directly). Only the two **stage-1** callers pass
> a distinct required-tone `grammarSchema`; `runStage2Chapter` (attribution) and
> `runEmotionChapter` pass one schema for both params (default `validationSchema =
> grammarSchema`) → **zero churn, genuinely unperturbed**.

- `grammarSchema` = the wrappers (`stage1ChapterSchema` / `stage1Schema`) embedding
  an `analyzerCharacterSchema` whose `tone` is **required** (`requiredToneSchema`,
  all four axes). Fed to `z.toJSONSchema` → the Ollama constrained-decoding grammar
  forces tone emission.
- `validationSchema` = the same wrappers embedding a character schema whose `tone`
  stays **optional**. Fed to `parseAndValidate`, so a model that ignores the grammar
  (or the Gemini path, which sends **no** grammar and validates only) **never fails
  the chapter** on a missing tone.
- Default both params to the same schema for every other `runStage` caller (emotion
  annotation, etc.) — zero churn outside stage-1.

The persisted `characterSchema` keeps `tone: toneSchema.optional()` regardless (old
`cast.json` files must validate). A plan probe measures whether the grammar actually
lifts gemma's emission rate (llama.cpp is documented to ignore `additionalProperties:false`,
`ollama.ts:313` — `required` on a nested object is unverified); **Layer 2 guarantees
the outcome either way.**

**Layer 2 — deterministic `fillToneFromAttributes` (PRIMARY — guarantees a
populated tone).** A pure post-pass: for any character with **missing or partial**
tone after analysis, derive the absent axes from the model's own descriptor words
via a **bilingual keyword→axis-nudge table** plus gender/age priors, from a
neutral-50 baseline, clamped 0–100. This — not the schema — is what guarantees
every character ends with a populated tone, on every engine and path. Examples:

| Descriptor (EN / RU) | warmth | pace | authority | emotion |
|---|---|---|---|---|
| weary, tired / усталый, устал | | −15 | | −10 |
| pragmatic / прагматичный | −10 | | +15 | |
| playful / игривый | | +10 | | +15 |
| wise, mentoring / мудрый, наставнический | +10 | | +15 | |
| silent, observant / немногословный | | −10 | | −10 |
| enigmatic / загадочный | −5 | | +5 | −5 |

Fires **only** when tone is absent/partial, so books that already received tone
(English, or a compliant run) are byte-identical. Language-agnostic (an English
character lacking tone benefits too), but surgical — present tone is never
overwritten. Runs at **finalization** (where attributes/gender exist), alongside
the dedup pass.

### Live-preview behaviour (review MINOR-1 — acknowledged, accepted)

Both passes run at **finalization**, not on the live SSE `cast-update` stream
(`previewFoldForLiveView` is name-only, exact-id, `analysis.ts:2562…4746`). So
*during* analysis the user briefly sees the un-deduped roster (duplicate
`olga`/`ольга` rows) and neutral tone; both resolve when the cast is finalized.
This is acceptable for v1 and called out so it isn't mistaken for the bug
persisting. (Deduping the live preview too is possible but adds order-sensitivity
to the per-chunk SSE path — deferred.)

## Implementation order (pass-3 — no circular dependency; DAG)

A clean TDD order exists; steps 1–6 are pure-function unit-testable in isolation:

1. **`kind:'dedup'` + `replaceDedupEntries`** in `cast-merges.ts` (1-line union widen + replace fn).
2. **Shared merge-field helper** extracted from `mergeRosterChapter` (pure).
3. **`dedupeRosterByName`** (`roster-dedup.ts`) — depends on 1–2; full dedup unit suite here, no route.
4. **`fillToneFromAttributes`** — pure, independent of dedup (parallel with 3).
5. **Two-schema `runStage`** + `requiredToneSchema` — `ollama.ts`/`gemini.ts` (assert grammar emits `required:['tone']`, validation accepts tone-less).
6. **Voiced-collision remap into `priorCastForMerge`** — depends on 3's `rewrites`; test at the `merge-analysis-cast` boundary with a synthetic rewrite map (the one seam that needs 2–3 modules composed, not pure-isolated).
7. **Route wiring** at the two finalization sites + journal writes + suggestion sibling-file lifecycle + `fresh`-reset delete (integration tests).
8. **Frontend** suggestion card + redux + GET/accept/dismiss route + openapi/types + e2e (last; depends on 7).

## Testing (TDD throughout, per CLAUDE.md)

**Dedup unit (`roster-dedup.test.ts`):**
- exact-name merge collapses `ольга`+`olga` to one entry, canonical id `ольга`;
- **Tier-1 gender-disagreement → no merge** (two different same-name people, review MINOR-4);
- gated full-vs-short auto-merge (`Антон`+`Антон Городецкий`), the short name kept as alias;
- two distinct supersets (ambiguous) → **no** merge;
- **narrator never merged** as source or target, across **all** tiers — including a narrator row whose `color` is NOT `'narrator'` (id-only guard, review MAJOR-4);
- diminutive (`Оля`/`Ольга`) → emits a **suggestion**, roster unchanged;
- **multi-gender diminutive** (`Саша`) with both genders unset → **no suggestion**; with concrete agreeing gender → suggestion (pass-2);
- Tier-2a survivor tie-break is deterministic (equal lines → insertion order; lines counted from sentences) (pass-2);
- **computed canonical id never `'narrator'`** — a non-narrator group named "Narrator" does not remap onto the narrator (pass-2);
- sentence `characterId` rewrite is correct, and the cumulative table is **transitively closed** through a subsequent `foldMinorCast` fold (review MAJOR-5).

**Voice carry-forward (review BLOCKER-1):**
- re-analysis of a book with a designed voice on a to-be-deduped (different-name, Tier-2a) id **preserves the voice on the canonical survivor row** and produces **no 0-line orphan**;
- **collision:** two prior voiced rows remapping to one canonical id keep the **strongest `voiceState`** voice (locked>tuned>reused>generated), drop the other **with a logged event**, and never silently lose it (pass-2 BLOCKER).

**Journal reversibility + lifecycle (review MAJOR-5):**
- a dedup merge writes a `kind:'dedup'` `cast-merges.json` entry with the correct **pre-dedup** `affected` sentences + `sourceName`, reversible by the un-merge/alias flow;
- a resume re-analysis **replaces** dedup entries (no duplicate accumulation) and a `fresh` reset **clears** both `cast-merges.json` and `cast-merge-suggestions.json` (pass-2).

**Tone unit:**
- the stage-1 **grammar schema** marks `tone` required while the **validation schema** keeps it optional — a model response with no `tone` **passes `parseAndValidate`** (does not fail the chapter), on both the Ollama and Gemini paths (two-schema `runStage`, pass-2);
- other `runStage` callers (emotion annotation) are unaffected (grammar==validation default);
- persisted `characterSchema` still accepts a tone-less character (regression);
- `fillToneFromAttributes` derives from EN and RU descriptors; fills only missing axes; leaves present tone untouched; guarantees all four axes populated.

**e2e (`e2e/`):** one Playwright spec — a suggestion (from `cast-merge-suggestions.json`) renders a card; Merge applies via the existing route; Dismiss removes it from the sibling file.

**Regression net:** the failing real-data shape (the four duplicate pairs, the 2/28 tone) is encoded as fixtures so the dedup + tone passes are pinned against the exact production failure.

## Repair of the existing book

Re-analyse *Ночной дозор* on the fixed pipeline (user's choice — no migration
script). Dedup + `fillToneFromAttributes` apply natively on the fresh run. Safe
here because the book has no designed voices yet; for any already-voiced book the
re-analysis is only safe once BLOCKER-1 (rewrite applied to `priorCastForMerge`)
is implemented.

> **Pass-2 caveat — re-analysis discards manual tone tuning.** `tone` is **not**
> in `PRESERVED_VOICE_FIELDS` (`merge-analysis-cast.ts:32-42`), so a re-analysis
> already replaces a user's hand-tuned tone with the fresh roster's (then
> `fillToneFromAttributes` fills any gaps). The change-log shows the user has tuned
> tone on this book — those edits will be lost on the re-run. This is **pre-existing
> behaviour**, not introduced here; flagged so it isn't read as a regression.
> Optionally adding `tone` to `PRESERVED_VOICE_FIELDS` (preserve tuned tone across
> re-analysis) is a candidate follow-up but **out of scope** for this change.

## Out of scope (stated explicitly)

- Mixed-language attribute tags (localisation-preamble compliance) — follow-up.
- Narrator-`я` / byline-author mis-roster — bug #938.
- Cross-book diminutive/epithet auto-merging — stays manual (plan 221 v1 stance).
- The dedup pass does not inherit `foldMinorCast`'s pronoun/descriptor guards
  (review MINOR-3); a model that rosters a pronoun like `я` as a character is the
  #938 case above. Low risk for dedup (two `я` rows would merge harmlessly), but
  noted so the plan doesn't assume those guards are present.
