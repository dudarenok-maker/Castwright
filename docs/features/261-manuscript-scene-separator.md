---
status: active
shipped: null
owner: null
---

# Manuscript view: visual scene-change separator

> Status: active — server + frontend shipped and tested; Russian/restructure-heavy
> reliability is bounded but unmeasured (owed acceptance, see below).
> Key files: `server/src/analyzer/scene-breaks.ts`,
> `server/src/analyzer/dialogue-structure/aligner.ts` (`locateSentenceOffsets`),
> `server/src/parsers/html-utils.ts` (`stripHtml`), `server/src/routes/analysis.ts`
> (`attributeChapterStage2` universal exit), `server/src/handoff/schemas.ts`
> (`sentenceSchema.sceneBreakBefore`), `src/views/manuscript.tsx` (`SceneDivider`,
> `isSeparatorOnly`, `segments` split), `src/store/manuscript-slice.ts`
> (`splitSentence`).
> URL surface: indirect — renders inline in the existing `#/books/<id>/manuscript`
> (script-review) view. No new route.
> OpenAPI ops: none new; `Sentence.sceneBreakBefore` added to the existing schema.

## Benefit / Rationale

- **User:** consecutive scenes in the manuscript/script-review view no longer
  read as one undifferentiated block of prose. Wherever the source had a
  word-free scene break (`* * *`, dinkus `⁂`, a dash rule, or an EPUB `<hr>`),
  a hairline-flanked ✦ divider now renders above the sentence that opens the
  next scene — an at-a-glance cue for where attribution context resets, which
  is exactly where mis-attribution is likeliest and worth a second look.
- **Technical:** the divider is computed once, server-side, as a pure
  post-attribution annotation pass (`annotateSceneBreaks`) that mutates only
  a new additive-optional `sceneBreakBefore?: boolean` sentence field. It
  changes nothing about chunking, model calls, coverage, or attribution.
- **Architectural:** establishes the pattern (already used by
  `emotion`/`instruct`/`vocalization`/`excludeFromSynthesis`) of layering a
  read-only, additive-optional display flag onto the sentence model
  *after* `.strict()` model-output validation, so a purely editorial feature
  can ship with a provably bounded failure mode: worst case is a
  cosmetically misplaced or dropped divider — never a corrupted cast or a
  stuck chapter.

Issue: [#1679](https://github.com/dudarenok-maker/Castwright/issues/1679).

## Architectural impact

- **New seams:** `annotateSceneBreaks(sentences, body)`
  (`server/src/analyzer/scene-breaks.ts`) and the exported
  `locateSentenceOffsets(sentences, body)` helper on the dialogue-structure
  aligner (`server/src/analyzer/dialogue-structure/aligner.ts`) — a
  body-offset locator usable outside the `alignSentences` structure-engine
  path, since it needs only the raw body text (no `ParagraphEvidence[]`).
- **Invariants preserved:** read-only over the sentence model (see
  Invariants below); the additive-optional field is never emitted by the
  model, so `.strict()` validation of model output is unaffected; the
  never-cross-language and attribution invariants of plan 162/247 are
  untouched — this pass runs strictly after attribution finishes.
- **Migration story:** none. The flag is set at analysis time, so it
  populates on (re-)analysis; a book analyzed before this feature shipped
  shows no dividers until its next re-analysis (self-heals, no backfill
  script — deliberately out of v1 scope per the design spec).
- **Reversibility:** the flag is additive-optional and purely display-driven
  on the frontend. Reverting the frontend render (or the annotator call)
  is a no-op removal — no data migration either direction.

## Invariants to preserve

1. **Read-only:** `annotateSceneBreaks` mutates ONLY
   `sentences[i].sceneBreakBefore` — sentence `text`, `characterId`, `id`,
   and order are byte-identical to pre-annotation
   (`server/src/analyzer/scene-breaks.ts`).
2. **Universal insertion point:** the annotator is called once, at the
   single point both attribution branches converge — the end of
   `attributeChapterStage2`, right before `return result;`
   (`server/src/routes/analysis.ts:1795`) — so every chapter gets the pass
   regardless of language or whether the dialogue-structure engine
   (plan 247) is active for that language.
3. **Additive-optional field:** `sceneBreakBefore?: boolean` on
   `sentenceSchema` (`server/src/handoff/schemas.ts`) and the OpenAPI
   `Sentence` schema (`openapi.yaml` → regenerated `src/lib/api-types.ts`).
   The model never emits it.
4. **`splitSentence` strips the flag from non-first pieces**
   (`src/store/manuscript-slice.ts`) — mirrors the existing
   `instruct`/`vocalization` null-out, so a mid-scene split can't duplicate
   the flag and paint a spurious divider.
5. **Worst-case failure is cosmetic only:** a binding miss (paraphrase
   drift, restructure-heavy text) misplaces or drops a divider — it never
   corrupts a sentence, id, order, or attribution.

## Design as shipped (and how it differs from the design-of-record)

The full detection design lives in
[`docs/superpowers/specs/2026-07-17-manuscript-scene-separator-design.md`](../superpowers/specs/2026-07-17-manuscript-scene-separator-design.md)
and the task-by-task build in
[`docs/superpowers/plans/2026-07-17-manuscript-scene-separator.md`](../superpowers/plans/2026-07-17-manuscript-scene-separator.md).
Both docs now carry inline "Shipped correction" / "Shipped reality" notes;
this section summarizes what actually shipped.

**Binding is marker-anchored, not drop-on-miss.** The original design bound
a separator to "the first sentence whose located body offset is after the
separator" — i.e. it required the scene-*opening* sentence's own text to be
locatable via `locateSentenceOffsets`, and dropped the divider on a miss.
Real-world measurement against Russian restructure-heavy text showed the
opener frequently fails to locate even when the surrounding sentences do
(dash-prefixed / split dialogue the model re-emits differently). The
shipped annotator instead anchors on the separator's own literal, exact body
offset, finds the **last sentence that located strictly before it**, and
flags the next sentence in reading order — landing on the true opener even
when that opener's own restructured text doesn't match the body
(`server/src/analyzer/scene-breaks.ts`, commit `e7b877c1`).

**Premise correction: separators are emitted as their own sentences.** The
design assumed a word-free scene-break line (`* * *`, `⁂`) produces no
sentence at all — the analyzer would simply skip over it. A shipped-behavior
measurement disproved this: the analyzer emits the separator glyph line as
its **own** word-free sentence. Two fixes landed in response:

- **Fix A (server, commit `e7b877c1`):** the marker-anchored bind above skips
  over any run of separator-only (non-attributable) sentences immediately
  after the anchor point, so the flag lands on the real next scene's opener,
  not on the separator's own placeholder sentence.
- **Fix B (frontend, commit `8abb9df0`):** `isSeparatorOnly(text)` — true when
  a sentence's text has no letters or digits — filters those rows out of the
  manuscript segment list entirely (`src/views/manuscript.tsx`), so the
  glyph line never renders as a redundant text row beside the divider that
  already represents it. Display-only; the underlying sentence still exists
  in the data and is unaffected for synthesis/attribution purposes.

Catching this via the acceptance measurement *before* merge, rather than
after, is the design process working as intended — see "Acceptance
measurement results" below.

## Test plan

### Automated coverage

- Vitest server (`server/src/handoff/schemas.test.ts`) — `sceneBreakBefore`
  accepted as an additive-optional boolean; absent = `undefined`; a
  non-boolean value rejected.
- Vitest server (`server/src/parsers/html-utils.test.ts`) — `stripHtml`
  converts `<hr>` (with or without attributes) into a standalone `* * *`
  line; an existing `<p>* * *</p>` line still survives.
- Vitest server (`server/src/analyzer/dialogue-structure/aligner.test.ts`) —
  `locateSentenceOffsets`: in-order offsets, `null` on an unlocatable
  sentence, a mid-sequence miss doesn't desync later matches, smart-quote /
  dash normalization tolerance.
- Vitest server (`server/src/analyzer/scene-breaks.test.ts`) —
  `annotateSceneBreaks`: flags the post-separator sentence and nothing else;
  consecutive separators collapse to one flag; a page-number-only unit
  (`42`) is NOT treated as a separator; a dinkus/dash rule IS; a leading
  (chapter-top) separator sets no flag; a paraphrase mismatch drops the
  divider without throwing; text/characterId/id/order are untouched.
- Vitest server (`server/src/routes/analysis.structure-engine.test.ts`) —
  the flag lands via `attributeChapterStage2` on **both** the
  dialogue-structure (`conventions`) branch and the `applyNarratorDefault`
  (else) branch, proving the universal-insertion-point invariant; a
  follow-up assertion confirms the flag survives the spread-based
  post-attribution transform chain (`dedupAndPrepare` →
  `stripThirdPartyFrontMatter` → `foldMinorCast` →
  `reconcileSentenceCharacterIds`) into the persisted array.
- Vitest frontend (`src/views/manuscript.test.tsx`) — a flagged sentence
  renders `data-testid="scene-divider"` above its segment; no divider above
  segment 0 even if flagged; a flagged sentence always starts a new segment
  (even for same-speaker prose); the boundary-drag handle is suppressed at
  the seam; a separator-only sentence is filtered from the row list
  (`isSeparatorOnly`).
- Vitest frontend (`src/store/manuscript-slice.test.ts`) — `splitSentence`
  keeps `sceneBreakBefore` on the first piece only.
- Playwright e2e (`e2e/manuscript-scene-divider.spec.ts`) — covers both the
  flat and virtualized render branches against the real analyzer shape (the
  `* * *` glyph as its own word-free sentence, the flag on the true opener):
  asserts the divider renders and the glyph row is suppressed.

### Manual acceptance walkthrough

1. Analyze a book whose source contains a `* * *` or `⁂` scene break (mock
   mode: seed a manuscript fixture sentence with `sceneBreakBefore: true`).
2. Open `#/books/<id>/manuscript` → expected: a hairline-flanked ✦ divider
   renders above the sentence that opens the next scene, and no separator
   glyph text row is shown separately.
3. Confirm no divider renders above the very first segment of the chapter,
   even if the chapter opens right after a scene-break marker.
4. Drag the boundary handle near (but not at) the divider seam → expected:
   the seam itself has no drag handle; adjacent, non-seam boundaries still
   drag normally.
5. Split a sentence that carries the flag → expected: only the first piece
   keeps the divider; the second piece renders inline with no divider.

## Acceptance measurement results

Measured the **shipped** annotator (marker-anchored + skip-separator
binding, `<hr>`→`* * *` conversion both live) on real analyzed books via a
throwaway CPU measurement harness (`scripts/scene-break-measure.ts`,
deleted at ship — the measurement *approach* is what's durable, not the
script):

- **Clean EN native `* * *`** (Skulduggery Pleasant: *Scepter of the
  Ancients*, Keeper of the Lost Cities: *Stellarlune*): **7 separators, 7
  bound to the correct opener, 0 dropped** — after the Fix-A skip lands on
  the true opener at a small gap.
- **`<hr>` conversion works end-to-end:** *The Coalfall Commission* went
  from **0 → 2 detected separators** once `stripHtml` started emitting
  `* * *` for `<hr>`.
- **Russian acceptance is STILL OWED.** *Ночной дозор* (Night Watch) could
  not be measured in this round — it was mid-re-analysis and its
  `manuscript-edits.json` was deleted by the reparse. The marker-anchored +
  skip-separator rule *mechanically* eliminates the old ~92k-character
  forward-overshoot failure mode (it binds to the last-located-before
  sentence plus a bounded skip, and never forward-searches to a distant
  opener the way a naive "next locatable sentence anywhere ahead" rule
  would) — but this is **unconfirmed on real Russian data**. Re-run before
  claiming Russian reliability:

  ```
  npx tsx scripts/scene-break-measure.ts --whole-book "C:/AudiobookWorkspace/books/Сергей Лукьяненко/The Night Watch Tetralogy/Ночной дозор"
  ```

  (recreate the harness per the measurement approach above if it's been
  deleted since this doc was written).

## Known limitations

- **Russian/restructure-heavy reliability is bounded but unmeasured.**
  Failure is always cosmetic — a divider a sentence or two off, or dropped
  — never data corruption. See "Acceptance measurement results" for the
  owed Night Watch re-run.
- **`isSeparatorOnly` also suppresses a lone `…`/`—` word-free line** from
  the manuscript DISPLAY (data/TTS are untouched — the sentence still
  exists and still synthesizes normally). Accepted display-only edge case;
  not fixed.
- **Stage-2 cache cross-version resume replays cached attribution and skips
  annotation.** A run interrupted before this feature shipped and resumed
  after upgrade replays pre-feature cached chapters carrying no flag; those
  chapters show no dividers until a fresh re-analysis. Self-heals; not
  fixed (see the design spec's "Population" section for the full
  rationale).

## Out of scope

- Any change to chunking, attribution, coverage, or synthesis — this
  remains strictly read-only over analysis output. See the design spec's
  "Design history" for the two prior mechanisms (chunker skip, scene-aware
  chunking) rejected specifically because they touched attribution.
- The Listen (reading-experience) view — this is an editorial affordance
  for the manuscript/script-review view only.
- CSS-styled or blank-gap scene breaks that leave no word-free line in the
  source.
- An optional backfill script to populate the flag on already-analyzed
  books without re-analysis — explicitly deferred; re-analysis is the v1
  population path.
- Fixing Night Watch's underlying attribution quality — separate work
  (srv-59 / plan 247).

## Ship notes

(Fill in when status flips to `stable`: shipped date, commit SHA, and the
Russian acceptance re-run result once it lands.)
