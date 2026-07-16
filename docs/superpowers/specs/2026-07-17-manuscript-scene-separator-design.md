# Scene-aware chunking + manuscript scene-change separator — design

- **Issue:** #1679 (display) — now unified with the RC3 chunker scene-straddle concern noted on that issue.
- **Status:** approved (design), revised after adversarial review
- **Date:** 2026-07-17
- **Scope:** server (stage-2 analyzer chunking + EPUB/MOBI parser + strict handoff schema) + OpenAPI schema + frontend (manuscript view)

## Problem

The manuscript / script-review view renders consecutive scenes with **no
visual boundary**. A scene break in the source (`* * *`, dinkus `⁂`, `<hr>`)
shows as ordinary flowing text, so the editor cannot see where one scene ends
and the next begins.

This is not only polish. On *Ночной дозор* (Night Watch), first-person «я»
material was mis-attributed across characters, and it was hard to spot because
the scenes **looked merged**. Scene boundaries are where attribution context
resets (a new scene can change who is present/speaking), so making them visible
aids spotting mis-attribution across a seam.

## Why this became an analyzer change (adversarial-review finding)

The scene-break signal is **destroyed during analysis** and cannot be robustly
recovered downstream:

- `Sentence` carries no section/scene marker; the parser splits only on
  *chapter* headings.
- A word-free separator line (`***`) is dropped **only when stage-2 isolates it
  as its own chunk**, which happens **only for over-budget chapters**:
  `splitBodyIntoChunks` early-returns `[body]` unchanged when
  `body.length <= charBudget` (`server/src/analyzer/stage2-chunk.ts:134`), the
  "overwhelming majority" path. In the common under-budget case a `* * *`
  between two paragraphs is sent to the model **inside one chunk**, and whether
  it leaves a residue sentence is model-dependent.
- There is **no positional mapping** from model-output sentences back to body
  positions. Any post-hoc "which sentence follows this separator" reconstruction
  is fuzzy sentence↔body text alignment — the same brittle approach rejected for
  the frontend, and the codebase has a scar proving it bites server-side too
  (the entity-mismatch substring-match regression, `server/src/parsers/html-utils.ts:8-16`).

**Conclusion:** the only alignment-free, budget-independent mechanism is to make
a scene-break line a **hard stage-2 chunk boundary** and attribute scene-by-scene.
This is exactly the RC3 "chunker splits by size, not scene boundary" fix the
issue anticipated. It is therefore an analyzer change, **not** a read-only view
tweak — a deliberate, accepted scope expansion.

## Decisions

1. **Mechanism: scene-aware chunking.** Split each chapter body into scenes at
   word-free separator lines *before* budget chunking; attribute each scene
   independently; flag the first sentence of every post-break scene. Robust, no
   text alignment, works on under-budget chapters.
2. **Detection scope: explicit word-free separator lines only.** A scene
   delimiter is any blank-line-delimited paragraph *unit* that normalizes to
   zero words (`* * *`, `***`, `⁂`, `• • •`, `---`/`―`) — reusing
   `hasAttributableContent` (`server/src/analyzer/stage2-coverage.ts`). Blank
   gaps are out of scope (markdown separates every paragraph with a blank line).
3. **Data model: additive per-sentence `sceneBreakBefore?: boolean`.**
4. **Divider style: hairline + centered Lora-serif `✦`** flanked by two faint
   `--ink` hairline rules, generous vertical spacing. No new color token, no hex
   literals.

## Design

### 1. Scene-aware chunking (server, `stage2-chunk.ts`)

Per chapter, at the top of the stage-2 chapter runner (`runStage2ChapterChunked`):

1. **Split the body into scenes** at word-free separator units. Split the body
   into blank-line paragraph units (same `\n[ \t]*\n` unit boundary
   `splitBodyIntoChunks` already uses); a unit for which `hasAttributableContent`
   is false is a **scene delimiter**, not content. Consecutive delimiters and a
   leading delimiter collapse (they bound empty scenes, which are skipped).
2. **Chunk + attribute each scene independently** via the existing
   budget-chunking + coverage-retry path (`splitBodyIntoChunks` +
   `mergeTinyChunks` run *within* a scene). Scene order is preserved; the runner
   tracks which scene each emitted sentence came from.
3. **Flag the boundary:** the first sentence of each scene after scene 0 gets
   `sceneBreakBefore = true`. Scene 0's first sentence never gets it (the chapter
   heading is already the boundary).

The separator unit itself still produces **no sentence** (unchanged behavior;
the 2026-06-19 ch7 regression test — `stage2-chunk.test.ts` — stays green: a
lone `***` yields no `***` sentence and the chapter completes cleanly; it gains
one new assertion that the following paragraph's first sentence is flagged).

**Attribution impact (stated honestly):** scene-aware chunking changes stage-2
chunk boundaries, so a chapter with scene breaks may attribute differently than
before — generally *better*, because the model no longer straddles two scenes in
one call (the RC3 failure mode). This is an accepted, intended behavior change;
it is **not** "read-only." Preceding-context policy at a scene boundary (reset
vs. carry) is a plan-level detail.

**Cost:** a multi-scene chapter now makes ≥2 model calls where it previously made
1. Negligible for local engines (the Night Watch driving case). A moderate,
within-daily-cap increase for cloud Gemini; the existing per-model RPD limiter
already governs it. No new rate-limit work required.

### 2. EPUB/MOBI: preserve `<hr>` (server, `html-utils.ts`)

`stripHtml` currently erases `<hr>` via its generic `<[^>]+>` pass
(`html-utils.ts:41-45`) while `</p>`→`\n\n` already preserves `<p>* * *</p>` as
a line (`:39`). Add `<hr>` → a canonical word-free separator line **before** the
generic strip, so `<hr>`-style breaks survive into the body as a scene delimiter.
Confirmed feasible: EPUB feeds raw chapter HTML through `stripHtml`
(`epub.ts:150,256`; nothing strips `<hr>` earlier), and MOBI shares the helper
(`mobi.ts:25,166`). `<hr>` is the most common EPUB scene-break representation, so
this closes the biggest real-world gap.

### 3. Data model — TWO server schemas + OpenAPI

`sceneBreakBefore` must be added in **all three** places (the adversarial review
caught that the analyzer path has its own strict schema):

- **`server/src/handoff/schemas.ts` `sentenceSchema`** — add
  `sceneBreakBefore: z.boolean().optional()`. This schema is `.strict()`
  (`:137`) and `SentenceOutput` is inferred from it (`:182`), so omitting it is a
  typecheck error and `.strict()` would reject the key. Follows the established
  additive-optional pattern (`emotion`/`instruct`/`vocalization`/
  `excludeFromSynthesis`, `:126-135`).
- **OpenAPI `Sentence` schema** (source of truth) → regenerate
  `src/lib/api-types.ts` via `npm run openapi:types`.
- **Persistence:** `state.json` read path uses `sentenceSchema.passthrough()`
  (`server/src/store/book-state.ts:594`), so the field round-trips once it is in
  `sentenceSchema`. Purely additive; absent behaves exactly as today.

### 4. Rendering (frontend, `src/views/manuscript.tsx`)

**Split segments on the flag itself.** The `segments` useMemo starts a new
segment when `s.sceneBreakBefore || s.characterId !== last.characterId`. Keying
the split on the flag directly makes the invariant *the flagged sentence is
always the first sentence of its segment* hold **by construction** — so a later
boundary-drag that merges the flagged sentence's neighbors can never push the
flag off the segment head (the review's divider-vanish failure mode). Each
segment derives `sceneBreakBefore` from its first sentence.

- The render loop draws the **hairline + ✦** divider immediately *above* any
  segment whose `sceneBreakBefore` is true (never above the first segment in the
  chapter).
- **Suppress the boundary handle at the seam.** The `BoundaryHandle` between
  segment *i-1* and *i* is omitted when segment *i*'s `sceneBreakBefore` is true.
  This is an explicit new per-boundary predicate in the render loop
  (`manuscript.tsx` ~1234), not free — the divider occupies that gap instead, and
  reassigning attribution across a scene break is not a meaningful edit.
- **Virtualization:** the divider lives inside the segment's virtual row (above
  its content), so `measureElement` captures its height automatically — no
  `estimateSize` retune. Identical on the flat (<60 segment) path.
- **Excluded chapters** render nothing (unchanged early-return).

### 5. Edge cases (corrected per review)

- **`splitSentence` must STRIP the flag from non-first pieces.** The reducer
  currently spreads `...original` into every piece
  (`src/store/manuscript-slice.ts:464-476`), which would *duplicate*
  `sceneBreakBefore` onto all offspring and paint a spurious mid-scene divider.
  Mirror the `instruct`/`vocalization` null-out (`:475`): keep the flag on the
  first piece only.
- **Boundary-drag** reassigns `characterId` only (`commitBoundaryMove`,
  `manuscript.tsx:573-583`, indexing the full `sentences[]` via `absIdx`), never
  deletes sentences and never touches the flag — and because the segment split
  keys on the flag, the divider is stable across drags.
- **Chapter that is only a separator** → the body normalizes to zero words and
  the parsers already skip empty bodies (`epub.ts:152 if (!body) continue`), so
  there is no chapter and no sentence to flag. No-op.
- **Leading / consecutive separators** collapse (they bound empty scenes, which
  are skipped) — a single break, one flag on the next word-bearing sentence.
- **False-positive guard:** a page-number-only unit (`42`) must not read as a
  scene break. Confirm `words()`/`hasAttributableContent` treats a bare number as
  a word (→ not a delimiter) in the plan; such residue is typically already
  `excludeFromSynthesis` anyway.

## Testing

- **Server — scene-aware chunking** (`stage2-chunk.test.ts`): a `* * *` in an
  **under-budget** chapter now splits into two scenes and flags the following
  paragraph's first sentence (this is the case the old design missed); the ch7
  isolated-`***` test stays green + gains the flag assertion; consecutive/leading
  separators collapse to one break; a page-number unit is not a break.
- **Server — `stripHtml`**: `<hr>` converts to a surviving word-free line;
  `<p>* * *</p>` still survives.
- **Server — schema round-trip**: an assembled sentence with `sceneBreakBefore`
  passes `sentenceSchema` (strict) and round-trips through the `state.json` read
  path.
- **Frontend unit** (`manuscript.test.tsx`): a flagged sentence renders the
  divider and is always its segment's head even for same-speaker prose; no
  divider above segment 0; no boundary handle at the seam; a boundary-drag near
  the seam leaves the divider in place; `splitSentence` keeps the flag on the
  first piece only.
- **E2E** (`e2e/`): the divider is visible in the manuscript view for a fixture
  book with a scene break. Add a `* * *` to the Coalfall fixture (or its Russian
  variant) rather than inventing a new manuscript.
- **Regression plan:** new `docs/features/` doc (cross-cutting: analyzer +
  parser + schema + frontend); tag the issue `needs-plan`. Note the RC3 unification.

## Re-analysis implication

The flag populates only on **(re-)analysis** (detection runs at assembly time).
The re-analysis merge spreads fresh analysis then overrides only user-authored
fields (`manuscript-slice.ts:150-158`), so a server-computed `sceneBreakBefore`
rides in cleanly. Existing analyzed books show no dividers until re-analyzed;
Night Watch is already slated for re-analysis under the analyzer fix. No backfill.

## Alternatives considered and rejected

- **Server-side text alignment** (correlate separator positions to sentence
  ordinals post-assembly) — the fragile sentence↔body alignment the review
  showed bites server-side too (entity-mismatch regression). Rejected.
- **Frontend re-derivation from `sourceText`** — same alignment fragility, on the
  client, recomputed every render. Rejected.
- **Keep truly read-only (tag only budget-isolated separators)** — misses the
  common under-budget case; unpredictable coverage. Rejected.
- **Chapter-level break-list** instead of a per-sentence flag — the flag renders
  in the existing segment loop and survives sentence-id remaps. Rejected.

## Out of scope

- Reading-experience (listen) view — this is an editorial affordance.
- Changing **which speaker** a line is attributed to as a *goal* (attribution
  *outcomes* may shift as a side effect of scene-aware chunking; that is
  intended, not a separate objective).
- CSS-styled / blank-gap scene breaks that leave no word-free line.
- The separator remains **non-spoken**, exactly as today.
