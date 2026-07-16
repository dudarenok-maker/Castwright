# Manuscript view: visual scene-change separator — design

- **Issue:** #1679
- **Status:** approved (design), v3 after two adversarial-review rounds
- **Date:** 2026-07-17
- **Scope:** server (read-only post-attribution detection + EPUB/MOBI `<hr>` preservation + additive schema field) + OpenAPI + frontend (manuscript view)

## Problem

The manuscript / script-review view renders consecutive scenes with **no
visual boundary**. A scene break in the source (`* * *`, dinkus `⁂`, `<hr>`)
shows as ordinary flowing text, so the editor cannot see where one scene ends
and the next begins. Scene boundaries are where attribution context resets, so
seeing them helps the editor scan for mis-attribution across a seam. This is an
**editorial display aid** — cosmetic, not a correctness feature.

## Design history (why this is v3)

The signal is destroyed during analysis: a `Sentence` carries no scene marker,
and a word-free separator line produces no sentence. Two prior mechanisms were
killed by adversarial review:

- **v1 — "reuse the chunker's word-free skip":** inoperative on the common path.
  `splitBodyIntoChunks` early-returns `[body]` when `body.length <= charBudget`
  (`server/src/analyzer/stage2-chunk.ts:134`), so a `* * *` in an under-budget
  chapter is never isolated as a skippable chunk.
- **v2 — "scene-aware chunking" (hard chunk boundary at separators):** robust
  boundaries, but it *manufactures* small isolated attribution spans that don't
  exist today. `mergeTinyChunks` runs only on over-budget bodies (after
  `:134`), so it does **not** protect a tiny under-budget scene; a 5–20-word
  scene (`STAGE2_MIN_EVALUABLE_WORDS = 5`, `stage2-coverage.ts:124`) the model
  loops on can trip the ratio-excess guard and ship looped attribution — the
  ch6/ratio-702 failure class, reopened. Its "improves attribution"
  justification was also unsupported and contradicts the documented Night Watch
  root causes (stage-1 roster + the crossExamine floor, **not** chunk-straddle).
  Importing correctness risk to serve a cosmetic aid is the wrong trade.

**Decision (v3): read-only, analysis-time post-processing.** Detect scene breaks
*after* attribution, changing nothing about chunking or attribution. This
matches the mechanism's failure consequence to the feature's stakes: the only
residual risk is a divider occasionally misplaced or missing — **cosmetic**,
never a corrupted cast or a stuck chapter.

## Design

### 1. Detection — read-only post-attribution alignment (server)

At the tail of `runStage2ChapterChunked` / `runChunks`, both the chapter body
(`opts.body`, which still contains the separator lines — they are only dropped
as *sentences*, not from the body string) and the final, renumbered ordered
`sentences` array coexist (proven: `validateStage2Coverage(opts.body,
sentences, …)` already runs there, `stage2-chunk.ts:345`). Insert a pure
post-processing pass:

1. Split `opts.body` into blank-line paragraph units (the `\n[ \t]*\n` boundary
   the chunker already uses). A unit for which `hasAttributableContent` is false
   (`stage2-coverage.ts`) is a **separator**, not content.
2. Walk a body cursor and the ordered sentences together: for each sentence, in
   order, locate its (tag-normalized) text at/after the cursor. If a separator
   unit lies in the gap between the previous sentence's end and this sentence's
   start, set `sceneBreakBefore = true` on **this** sentence.
3. On a match failure (the greedy walk can't locate a sentence's text — model
   paraphrase, tag drift), skip ahead and continue. A miss drops one divider;
   it never corrupts a sentence.

**This changes nothing about chunking, model calls, coverage, or attribution.**
Every v2 concern (tiny-scene loops, per-scene coverage, context reset, cost) is
dissolved because the chunker is untouched.

**Matching detail:** the parser injects audio-tag markers (`[emphasis]…`) into
the body before analysis (`text.ts` flush), so both body and sentence text share
that form; normalize/strip those markers on both sides before comparing. Match
is a forgiving substring/prefix compare, not an exact equality — the goal is
placement, not validation.

### 2. EPUB/MOBI: preserve `<hr>` (server, `html-utils.ts`)

`stripHtml` erases `<hr>` via its generic `<[^>]+>` pass (`html-utils.ts:41-45`)
while `</p>`→`\n\n` already preserves `<p>* * *</p>` as a line (`:39`). Add
`<hr>` → a canonical word-free separator line **before** the generic strip, so
`<hr>`-style breaks survive into the body as a detectable separator. Confirmed
feasible: EPUB feeds raw chapter HTML through `stripHtml` (`epub.ts:150,256`;
nothing strips `<hr>` earlier), and MOBI shares the helper (`mobi.ts:25,166`).
`<hr>` is the most common EPUB scene-break representation.

### 3. Data model

Add one optional field, `sceneBreakBefore?: boolean`, in these places:

- **`server/src/handoff/schemas.ts` `sentenceSchema`** — add
  `sceneBreakBefore: z.boolean().optional()`. Needed for the **type**
  (`SentenceOutput = z.infer<typeof sentenceSchema>`, `:182`) that the assembly
  pass sets the flag on. Note the model never emits it — it is set by the
  post-processing pass *after* the model output is validated — so `.strict()`
  (`:137`) validation of model output is unaffected; adding it keeps the type
  correct and lets any later re-parse pass. Follows the additive-optional
  pattern (`emotion`/`instruct`/`vocalization`/`excludeFromSynthesis`,
  `:126-135`).
- **OpenAPI `Sentence`** (source of truth) → regenerate `src/lib/api-types.ts`
  via `npm run openapi:types`.
- **Persistence:** state.json is written as raw JSON and read back via a raw
  `readJson<BookStateJson>` (`server/src/routes/analysis.ts:4502,5621`) with **no
  schema gate on read**, so the additive field round-trips freely.
  *(Correcting v2: there is no `server/src/store/book-state.ts`; the earlier
  `.passthrough()` citation was wrong. Adding to `sentenceSchema` is still
  required — for the type, above.)*

### 4. Rendering (frontend, `src/views/manuscript.tsx`)

**Split segments on the flag itself.** The `segments` useMemo starts a new
segment when `s.sceneBreakBefore || s.characterId !== last.characterId`. Keying
the split on the flag makes *"the flagged sentence is always its segment's
head"* hold by construction, so a later boundary-drag merging its neighbors can
never push the flag off the head (a divider-vanish failure mode caught in
review).

- Draw the **hairline + centered Lora-serif ✦** divider (two faint `--ink`
  hairline rules flanking the ornament, generous vertical spacing; no new color
  token, no hex literals) immediately *above* any segment whose
  `sceneBreakBefore` is true — never above the chapter's first segment.
- **Suppress the boundary handle at the seam:** omit the `BoundaryHandle` between
  segment *i-1* and *i* when segment *i*'s `sceneBreakBefore` is true (an
  explicit new per-boundary predicate in the render loop, ~`manuscript.tsx:1234`
  — not free). Reassigning attribution across a scene break is not a meaningful
  edit; the divider occupies that gap.
- **`splitSentence` must strip the flag from non-first pieces.** The reducer
  spreads `...original` into every piece (`src/store/manuscript-slice.ts:464-476`),
  which would duplicate the flag and paint a spurious mid-scene divider; mirror
  the `instruct`/`vocalization` null-out (`:475`) — keep it on the first piece
  only.
- **Virtualization:** the divider lives inside the segment's virtual row, so
  `measureElement` captures its height automatically — no `estimateSize` retune.
  Identical on the flat (<60 segment) path. Excluded chapters render nothing.

### 5. Edge cases

- Consecutive / leading separators collapse: they bound empty regions with no
  word-bearing sentence to flag → a single break, one flag on the next real
  sentence. A leading separator (before any prose) is dropped.
- A chapter whose body is only a separator normalizes to zero words and is
  already skipped by the parsers (`epub.ts:152 if (!body) continue`). No-op.
- **False-positive guard:** a page-number-only unit (`42`) is NOT a separator —
  `words('42')` → `['42']` (digits are `\p{N}`), so `hasAttributableContent` is
  true. `* * *` / `⁂` / `• • •` / `---` / `―` all normalize to zero words.
  Confirmed vs `stage2-coverage.ts:88-97`.
- Alignment miss (model paraphrase / tag drift) → one divider dropped, cosmetic.

### 6. Population — re-analysis, optional backfill

The flag is set at analysis time, so it populates on **(re-)analysis**. Because
it is pure post-processing over the stored chapter body + sentences, an
**optional** one-shot backfill script could populate already-analyzed books
without re-analysis (nice-to-have, not required for v1). The re-analysis merge
spreads fresh analysis then overrides only user-authored fields
(`manuscript-slice.ts:150-158`), so a server-computed `sceneBreakBefore` rides
in cleanly.

## Testing

- **Server — alignment** (new test): a `* * *` mid-chapter flags the following
  paragraph's first sentence and nothing else; robust to `[emphasis]` tags in
  body/sentence text; consecutive/leading separators collapse to one break; a
  page-number unit is not a break; a paraphrase mismatch drops the divider
  without error. Chunking output (sentence count/ids, coverage) is byte-identical
  to pre-change — a guard that we changed nothing but the flag.
- **Server — `stripHtml`:** `<hr>` converts to a surviving word-free line;
  `<p>* * *</p>` still survives.
- **Frontend unit** (`manuscript.test.tsx`): a flagged sentence renders the
  divider and is always its segment's head even for same-speaker prose; no
  divider above segment 0; no boundary handle at the seam; a boundary-drag near
  the seam leaves the divider in place; `splitSentence` keeps the flag on the
  first piece only.
- **E2E** (`e2e/`): the divider is visible in the manuscript view for a fixture
  book with a scene break. Add a `* * *` to the Coalfall fixture (or its Russian
  variant).
- **Regression plan:** new `docs/features/` doc; tag the issue `needs-plan`.

## Alternatives considered and rejected

- **Scene-aware chunking (v2)** — correctness risk (tiny-scene loop band,
  context-reset attribution regression) to serve a cosmetic aid, on an
  unsupported "better attribution" claim. If scene-aware chunking is wanted for
  its *own* sake, it belongs in a separate, measured analyzer project (the RC3
  concern), not bootstrapped here.
- **Frontend re-derivation from `sourceText`** — recomputed every render, and the
  client lacks a clean per-chapter body; doing it once server-side at analysis
  time and persisting the flag is strictly better.
- **Server alignment for *attribution*** — the fragile substring match that
  folded a speaker in the entity-mismatch regression (`html-utils.ts:8-16`). Here
  the same technique drives *display only*, so its failure is cosmetic, not a
  corrupted cast — an acceptable, bounded risk.

## Out of scope

- Reading-experience (listen) view — this is an editorial affordance.
- Any change to chunking, attribution, coverage, or synthesis. The separator
  remains non-spoken. This feature is **read-only** over analysis output.
- CSS-styled / blank-gap scene breaks that leave no word-free line.
- Claiming to fix Night Watch's attribution bug — that is separate work.
