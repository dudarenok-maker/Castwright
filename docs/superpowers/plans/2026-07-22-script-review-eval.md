# Script-review eval harness (char-level metric) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the attribution-eval harness with a segmentation-invariant **char-level**
`reviewed` stage that runs the real script-review pass on the pipeline's final attributed
sentences, scores its net effect on attribution against the golden fixtures, and dumps the
un-scoreable ops — then capture the baseline (gold + silver, both engines) as the gate for the
sequenced tuning follow-up.

**Architecture:** A new char-projection metric (`projectToChars` onto `chapterText` via the
position-preserving `normalizeForMatch`) scores attribution per chapter-body character, so
`split`/`extract`/`reattribute` are scored soundly and the `final→reviewed` diff is a direct
char-array comparison. The pass is run faithfully to production by reusing the already-pure chunker
functions + a **server-side port** of `planApply` acceptance (the server tsconfig can't import root
`src/`), re-implementing only the thin non-streaming force-split loop. No production runtime change.

**Tech Stack:** TypeScript (server, `NodeNext` ESM), Vitest (node env), the existing
`attribution-eval` harness (`run-eval.ts`, `scorer.ts`, `schema.ts`), the script-review route's
exported builders (`buildScriptReviewChapterInbox`, `buildReviewSentencesInput`) and the pure
chunker (`chapter-chunker.ts`).

## Global Constraints

Every task's requirements implicitly include these.

- **Gold-only gate.** The hard no-regression gate is gold ch43–46 + committed Coalfall (char
  metric). **Silver fixtures never block**; reported in a separate block, labelled directional.
- **No production-route behaviour change.** Reuse the *pure* functions
  (`chunkSentencesByBudget`, `ownsOp`, `primarySentenceId`, `chapterChunkBudget`,
  `buildScriptReviewChapterInbox`, `buildReviewSentencesInput` — all already exported). Do **not**
  extract `reviewCore`/SSE/ledger from `script-review.ts`.
- **`planApply` is PORTED server-side, not imported from `src/`.** Server `tsconfig.json` has
  `rootDir: ./src` + `include: ["src/**/*"]` and imports nothing from root `src/`. Port
  `normalizeForMatch` / `resolveAnchorOffset` / `planApply` into a server module; pin no-drift with
  a **shared JSON test vector** both the frontend test and the server test read via `fs`.
- **Char projection uses `normalizeForMatch` (position-preserving), NEVER the scorer's
  `normalise()`** (which collapses whitespace / strips brackets / drops apostrophes → no positional
  correspondence to `chapterText`).
- **`reviewedSpeakerByChar` is a copy of `finalSpeakerByChar` mutated in place** by accepted ops —
  never a re-projection of post-op sentences (would shift spans, break the equal-length diff).
- **Line-level `raw`/`det`/`final` recall is unchanged** (backward-compatible with the shipped
  attribution baselines). The char track is additive.
- **No `byFamily` breakdown on the `reviewed` stage** (the `reasons` array indexes the `final` line
  stream; resegmentation breaks the 1:1 map).
- **Off-roster `reattribute` (carrying `proposed`) is dumped, not char-scored** in v1.
- **Opt-in, triple-gated.** `runEval` returns `{ skipped }` (never throws) on no-corpus /
  engine-down / no-key, review stage included. Never wired into `test:all` / `verify`.
- **Corpus local-only.** Silver fixtures are copyrighted → git-ignored corpus dir. Only Coalfall
  committed.
- Every new server env knob (none expected here) MUST be a registry knob + `.env.example`.

## File Structure

**New (server, all under `server/src/analyzer/attribution-eval/`):**
- `review-apply-core.ts` — ported pure `normalizeForMatch` / `resolveAnchorOffset` / `planApply`
  (keyed on `ScriptReviewOp`). One responsibility: decide the accepted op set + resolve anchors.
- `char-project.ts` — `projectToChars(chapterText, units)` → `{ speakerByChar, spans }`.
- `char-score.ts` — `charRecall` (raw + per-line-averaged), `diffHelpedHarmed`.
- `apply-ops-chars.ts` — `applyOpsToCharArray` (reattribute/split/extract → mutated char array).
- `review-run.ts` — `runReviewOverChapter` (thin faithful chunk loop → owned `ScriptReviewOp[]`).
- `__fixtures__/review-apply-vectors.json` — shared no-drift vector (committed; synthetic ops, no
  book text).
- Test files colocated: `review-apply-core.test.ts`, `char-project.test.ts`, `char-score.test.ts`,
  `apply-ops-chars.test.ts`, `review-run.test.ts`.

**Modified:**
- `run-eval.ts` — `review?` opt on `evalFixture`; `ReviewScore`/`FixtureResult.reviewed`;
  aggregation.
- `run-eval-cli.ts` — `--review` flag, char scorecard, op-dump, silver partition, silver regex.
- `src/lib/script-review-apply.test.ts` — also assert the shared vector (drift guard, frontend
  side).
- `capture-cli.ts` (+ `capture.ts`) — silver capture path + optional prior-exchange field.
- `schema.ts` — optional `priorExchange` on `LabelledChapter` (additive).
- `docs/features/265-attribution-eval-tuning.md` — ship note (this rides plan 265's harness).

---

### Task 1: Port the apply/match core server-side + shared no-drift vector

**Files:**
- Create: `server/src/analyzer/attribution-eval/review-apply-core.ts`
- Create: `server/src/analyzer/attribution-eval/__fixtures__/review-apply-vectors.json`
- Test: `server/src/analyzer/attribution-eval/review-apply-core.test.ts`
- Modify: `src/lib/script-review-apply.test.ts` (add the shared-vector assertion, frontend side)

**Interfaces:**
- Produces: `normalizeForMatch(text: string): string`,
  `resolveAnchorOffset(text: string, anchor: string): number | null`,
  `planApply(ops: ScriptReviewOp[], live: LiveSentence[], roster: Set<string>): { appliable: ScriptReviewOp[]; unappliable: Array<{ op: ScriptReviewOp; reason: string }> }`
  where `LiveSentence = { id: number; chapterId: number; text: string; characterId: string; instruct?: string; vocalization?: boolean }`.
- Consumes: `ScriptReviewOp` from `../../handoff/schemas.js`.

**Porting source:** `src/lib/script-review-apply.ts` — `REVIEW_EMOTIONS` (**line 4** — `planApply`
uses it at line 171 for `fix_emotion` validation, so it MUST be ported too) plus `normChar` /
`normalizeForMatch` / `resolveAnchorOffset` / `planApply` (lines 72-224). Port verbatim, retyped to
`ScriptReviewOp`, dropping the Redux import. The frontend `ReviewOp` and server `ScriptReviewOp` are
already parallel types across the boundary — this continues that pattern; the shared vector guards
drift.

**Vector-authoring note:** `planApply` checks `anchor` before `anchorEnd` for `extract_dialogue`
(lines 144-145), so the "anchorEnd absent" case MUST give a *resolvable* `anchor`, or it fails with
`anchor not found or not unique` instead of the intended `extract anchorEnd not found or not unique`.

- [ ] **Step 1: Write the shared vector fixture** — `review-apply-vectors.json`: an array of
  `{ name, ops, live, roster, expected: { appliableOpIndexes: number[], unappliable: [{ opIndex, reason }] } }`
  cases covering: a clean `reattribute` (on-roster) accepted; a `reattribute` to a non-roster id →
  `reattribute characterId not in roster`; a `split` with a resolvable anchor accepted; a `split`
  with an anchor absent → `anchor not found or not unique`; two structural ops on the same id →
  second `second structural op on the same id`; a valid adjacent same-speaker `merge`; a
  non-adjacent `merge` → `merge members not adjacent / same character / same chapter`; an
  `extract_dialogue` with `anchorEnd` absent. **Synthetic text only — no book content.**

- [ ] **Step 2: Write `review-apply-core.test.ts` (fails — module absent)** — load the vector via
  `fs.readFileSync(new URL('./__fixtures__/review-apply-vectors.json', import.meta.url))`, and for
  each case assert `planApply(ops, live, new Set(roster))` yields exactly the expected appliable
  indexes and unappliable {index, reason}. Add direct unit cases for `resolveAnchorOffset`
  (unique-match end offset; null on absent; null on non-unique) and `normalizeForMatch`
  (smart-quote/dash/ellipsis folds; NO whitespace collapse — `"a  b"` stays two spaces).

- [ ] **Step 3: Run it — FAIL** (`cd server && npm run test -- review-apply-core`). Expected:
  module-not-found.

- [ ] **Step 4: Create `review-apply-core.ts`** — port the four functions. Signature of `planApply`
  exactly as Interfaces above. Keep the arity/`Array.isArray(mergeIds)` guards verbatim (they
  prevent the mid-hydration throw documented at `script-review-apply.ts:118-137`).

- [ ] **Step 5: Run it — PASS.**

- [ ] **Step 6: Add the frontend-side drift assertion** — in `src/lib/script-review-apply.test.ts`,
  load the SAME `review-apply-vectors.json` (relative `fs` path to the server fixture) and assert
  the frontend `planApply` produces the identical appliable/unappliable result. This is the
  no-drift lock: one vector, two implementations.

- [ ] **Step 7: Run both suites — PASS** (`npm run test -- script-review-apply` and
  `cd server && npm run test -- review-apply-core`).

- [ ] **Step 8: Commit** — `test(server): port script-review apply/match core for the eval + shared no-drift vector`.

---

### Task 2: `projectToChars` — char-position speaker projection

**Files:**
- Create: `server/src/analyzer/attribution-eval/char-project.ts`
- Test: `server/src/analyzer/attribution-eval/char-project.test.ts`

**Interfaces:**
- Consumes: `normalizeForMatch` from `./review-apply-core.js`.
- Produces:
  ```ts
  export interface CharProjection {
    speakerByChar: Array<string | null>; // length === chapterText.length
    spans: Array<{ start: number; end: number; speakerId: string }>; // [start,end) in chapterText
    dropped: number; // units whose text was NOT located at/after the cursor (skipped, chars stay null)
  }
  export function projectToChars(
    chapterText: string,
    units: Array<{ text: string; speakerId: string }>,
  ): CharProjection;
  ```
  `dropped` is surfaced (not just "recorded") so a caller can print how many predicted/truth units
  failed to locate — a high `dropped` on the PREDICTED side means the char metric is silently
  under-covering and the number is suspect (assumption-checker Important-4).

**Method:** Build the normalized chapterText + its `origEndForNormLen` index map ONCE (same
construction as `resolveAnchorOffset`, but retained for the whole text). Walk `units` in order,
maintaining a normalized-cursor; for each unit, `indexOf(normalizeForMatch(unit.text))` from the
cursor; map the normalized `[matchStart, matchEnd)` back to original offsets via the index map →
`{start, end}`; fill `speakerByChar[start..end) = speakerId`; advance the cursor to `matchEnd`. A
unit not found at/after the cursor is **skipped** (its chars stay `null`) — recorded so callers can
count drops (O-4: skip, never fuzzy-mis-assign).

- [ ] **Step 1: Write `char-project.test.ts` (fails)** — cases:
  (a) two contiguous units over a plain `chapterText` → correct spans + `speakerByChar`;
  (b) smart-quote/spacing difference between unit text and chapterText (unit `"Hi,"` vs body
  `“Hi,”`) still locates the span (proves `normalizeForMatch` path + index map);
  (c) a unit whose text is absent → skipped, its chars stay `null`, others unaffected, and
  `dropped === 1`;
  (d) two identical-text units by different speakers → the cursor advances so the SECOND resolves
  to the second occurrence (not the first again);
  (e) `speakerByChar.length === chapterText.length`.

- [ ] **Step 2: Run — FAIL** (module absent).

- [ ] **Step 3: Implement `projectToChars`** per Method.

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Commit** — `feat(server): projectToChars — char-position speaker projection for the review eval`.

---

### Task 3: Char scorer — `charRecall` + helped/harmed

**Files:**
- Create: `server/src/analyzer/attribution-eval/char-score.ts`
- Test: `server/src/analyzer/attribution-eval/char-score.test.ts`

**Interfaces:**
- Consumes: `CharProjection` (Task 2); an optional `aliasMap: Map<string,string>` (the existing
  `rosterAliasMap` seam).
- Produces:
  ```ts
  export interface CharScore {
    charRecall: number;      // char-weighted: correctChars / truthChars
    lineRecall: number;      // per-truth-line-averaged char-correctness (perceived-quality headline)
    truthChars: number;
  }
  export function scoreCharRecall(
    truth: CharProjection, predicted: CharProjection, aliasMap?: Map<string,string>,
  ): CharScore;
  export function diffHelpedHarmed(
    finalByChar: Array<string|null>, reviewedByChar: Array<string|null>,
    truthByChar: Array<string|null>, aliasMap?: Map<string,string>,
  ): { helped: number; harmed: number; churn: number }; // char counts
  ```

**Denominator:** only chars where `truth.speakerByChar[i] !== null` count. `charRecall` = fraction
of those where resolved predicted == resolved truth. `lineRecall` = average over `truth.spans` of
each span's own char-correctness (so a long narration span and a short dialogue line weigh equally).
`diffHelpedHarmed`: over truth-attributed chars, helped = wrong-in-final & right-in-reviewed;
harmed = right-in-final & wrong-in-reviewed; churn = wrong→different-wrong.

- [ ] **Step 1: Write `char-score.test.ts` (fails)** — hand-built projections:
  (a) all chars correct → `charRecall === 1`, `lineRecall === 1`;
  (b) **the split-lift case**: `final` attributes one 2-speaker span entirely to speaker A (half
  wrong); `reviewed` splits it so the second half is speaker B (matching truth) → `charRecall` and
  `helped` both rise, `harmed === 0` (this is exactly what the old line scorer scored as a
  regression);
  (c) a `harmed` case: `reviewed` overturns a correct span → `harmed > 0`;
  (d) aliasMap resolves `the_torment → unknown-male` so an aliased match scores correct;
  (e) `lineRecall` weights a long narration span and a short dialogue line equally (a mis-attributed
  short line drops `lineRecall` more than its char share).

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement `char-score.ts`.**
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(server): char-level recall + helped/harmed for the review eval`.

---

### Task 4: Char-array applier (reattribute / split / extract)

**Files:**
- Create: `server/src/analyzer/attribution-eval/apply-ops-chars.ts`
- Test: `server/src/analyzer/attribution-eval/apply-ops-chars.test.ts`

**Interfaces:**
- Consumes: `resolveAnchorOffset` (Task 1), `CharProjection.spans` (Task 2), `ScriptReviewOp`.
- Produces:
  ```ts
  export function applyOpsToCharArray(
    finalByChar: Array<string|null>,
    finalSentences: Array<{ id: number; text: string; characterId: string }>,
    finalSpans: Array<{ id: number; start: number; end: number }>, // per-sentence chapter span
    acceptedOps: ScriptReviewOp[],
  ): Array<string|null>; // reviewedByChar (a COPY of finalByChar, mutated)
  ```

**Rule (Global Constraint):** copy `finalByChar`, then for each accepted op mutate the copy in
place. Only three op classes act:
- `reattribute` (on-roster `characterId` only): set the target sentence's whole span `[start,end)`
  to `characterId`. (Off-roster `proposed` → skip here; dumped by the CLI, Task 7.)
- `split`: `off = resolveAnchorOffset(sentence.text, op.anchor)` (sentence-local) → chapter offset
  `start + off`; assign `[start, start+off) = pieceCharacterIds[0]`, `[start+off, end) =
  pieceCharacterIds[1]`. Same-speaker default (`pieceCharacterIds` absent) → no-op.
- `extract_dialogue`: local `start`/`end` offsets via `resolveAnchorOffset(anchor/anchorEnd)` →
  chapter offsets; middle sub-span → `pieceCharacterIds[1]`, flanks keep the sentence's speaker.

`finalSpans` gives each sentence's chapter-char `{start,end}`; the applier resolves the op's
sentence-local anchor offset and adds `start`. Ops here are already `planApply`-accepted (Task 5),
so anchors resolve; still guard `null`/`end<=start` as no-ops (defensive).

- [ ] **Step 1: Write `apply-ops-chars.test.ts` (fails)** — per op: a `reattribute` recolors the
  whole span; a `split` recolors only the second piece; an `extract_dialogue` recolors only the
  middle; a same-speaker split (no `pieceCharacterIds`) is a no-op; an op whose anchor doesn't
  resolve is a no-op; `finalByChar` is NOT mutated (returned array is a distinct copy).

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement `apply-ops-chars.ts`.**
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(server): char-array applier for reattribute/split/extract`.

---

### Task 5: Thin faithful review-core loop + route-parity drift test

**Files:**
- Create: `server/src/analyzer/attribution-eval/review-run.ts`
- Test: `server/src/analyzer/attribution-eval/review-run.test.ts`

**Interfaces:**
- Consumes: `chunkSentencesByBudget`, `ownsOp`, `primarySentenceId`, `chapterChunkBudget`,
  `OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS` (`../chapter-chunker.js`);
  `buildScriptReviewChapterInbox`, `buildReviewSentencesInput`, `type PriorExchange`
  (`../../routes/script-review.js`); `planApply` (Task 1); an `Analyzer` with
  `runScriptReviewChapter`. **Route import is safe** — `run-eval.ts` already imports from
  `routes/analysis.js`; loading `routes/script-review.js` runs only `Router()` + map init, no
  `listen`/side-effect (established precedent, not a concern).
- Produces:
  ```ts
  export async function runReviewOverChapter(opts: {
    analyzer: Analyzer;
    engine: 'local' | 'gemini';                  // chunk-budget vocabulary; caller maps qwen→local, gemma→gemini
    manuscriptId: string; chapterId: number;
    sentences: SentenceOutput[];                 // the pipeline's FINAL attributed sentences
    roster: Array<{ id: string; name: string; role?: string }>; // slim — for the inbox
    priorExchange?: PriorExchange;               // fed into chunk 0 only (index === 0), route-faithful
    evidence?: Map<number, string>;              // built by the caller (Task 6) via buildStructureEvidence
    call: StageCall;
  }): Promise<{ ops: ScriptReviewOp[]; accepted: ScriptReviewOp[] }>; // owned+deduped, and planApply-accepted
  ```

**Method (mirror `script-review.ts:810-875`, minus streaming/ledger/fallback):** chunk via
`chunkSentencesByBudget` with `chapterChunkBudget(engine, JSON.stringify(roster).length+800,
sampleText, OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS)` and the same `serialize` (per-sentence
`buildReviewSentencesInput`); for each chunk call `analyzer.runScriptReviewChapter` over
`buildScriptReviewChapterInbox(...contextBefore, core, contextAfter...)`, filter by
`ownsOp(coreIds, primarySentenceId(op))`; halve-and-retry the core on `AnalyzerTruncatedError`
(depth ≤ 3, the `MAX_FORCE_SPLIT_DEPTH`/`CHUNK_OVERLAP` constants — redeclare locally = 3). Then
`accepted = planApply(ops, live, rosterSet).appliable` where `live` maps each sentence to
`{ id, chapterId, text, characterId }`. (Prior-exchange is passed in by the caller when present —
Task 6.)

- [ ] **Step 1: Write `review-run.test.ts` (fails)** — a STUB analyzer whose
  `runScriptReviewChapter` returns a fixed op set keyed off the prompt's chunk (so a multi-chunk
  chapter exercises `ownsOp` de-dup). Assert: (a) an op whose primary sentence lands in a chunk's
  CONTEXT (not core) is emitted once, by the owning chunk only; (b) the owned op set equals a
  reference single-pass ownership over the same chunks — a *consistency* guard (the route's
  `reviewCore` is a closure inside `runScriptReviewJob`, not importable, so this pins the harness
  loop against its own ownership reference built on the SAME shared pure
  `ownsOp`/`primarySentenceId`/`chunkSentencesByBudget` production uses; catches internal drift, not
  divergence from the route's exact loop — acceptable under the no-extract stance);
  (c) `accepted` excludes an op `planApply` rejects (bad anchor).

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement `runReviewOverChapter`.**
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(server): faithful thin review-core loop for the eval (route-parity)`.

---

### Task 6: Wire the `reviewed` stage into `evalFixture`

**Files:**
- Modify: `server/src/analyzer/attribution-eval/run-eval.ts` (evalFixture + aggregateFixture/aggStage)
- Modify: `server/src/analyzer/attribution-eval/schema.ts` (optional `priorExchange`)
- Test: `server/src/analyzer/attribution-eval/run-eval.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 2–5. Reuses the existing `rosterAliasMap` (run-eval.ts:77) and `rosterToStage1`.
- Produces: `FixtureResult.reviewed?: ReviewScore` and an **aggregated** `FixtureAgg.reviewed?:
  ReviewAgg` (§Aggregation below).
  ```ts
  export interface ReviewScore {                     // per-run
    charFinal: number; charReviewed: number;         // charRecall (char-weighted)
    lineFinal: number; lineReviewed: number;         // per-truth-line-averaged
    helped: number; harmed: number; churn: number;   // char counts
    predictedDropped: number; truthDropped: number;  // projectToChars misses (coverage-health, Important-4)
    opsByClass: Record<string, number>;
    dump: Array<{ id: number; op: string; rationale: string; anchor?: string }>; // un-scored ops
  }
  ```
  `evalFixture`'s opts gain `review?: boolean` (default false) **and `engine?: 'qwen' | 'gemma'`**
  (optional — required only when `review:true`; already known to `runEval`'s caller loop). Keeping
  it optional means the existing non-review callers + `run-eval.test.ts` cases compile unchanged.

**Engine mapping (Critical-1):** `runReviewOverChapter` needs `'local' | 'gemini'`, but the eval
speaks `'qwen' | 'gemma'`. Add a one-liner in run-eval.ts:
`const chunkEngine = opts.engine === 'qwen' ? 'local' : 'gemini';` (matches `buildAnalyzer`:
qwen→Ollama/local, gemma→Gemini/gemini). Pass `chunkEngine` to `runReviewOverChapter`.

**Method** (when `review`), after the existing `attributeChapterStage2` call:
1. `finalSentences = result.sentences` (each is `SentenceOutput` with `chapterId` present —
   schemas.ts:120 — so Task 5's `live` mapping is sound).
2. **Evidence — eval-native (Important-3), NOT `getOrHydrateManuscript`** (which has no
   `chapterHints` body for the synthetic eval manuscript): call
   `buildStructureEvidence(truth.chapterText, finalSentences, fullRoster, opts.truth-language)`
   directly, gated on `configValue('analyzer.structure.enabled')`, where `fullRoster` is the
   `RosterSnapshot.characters` (carries `gender`/`aliases` — the evidence builder needs them, not
   the slim `{id,name,role}`). The slim roster still goes to the inbox.
3. `priorExchange` = the fixture's optional `priorExchange` (Task 8 capture), passed to
   `runReviewOverChapter`.
4. `runReviewOverChapter({ analyzer, engine: chunkEngine, manuscriptId, chapterId, sentences:
   finalSentences, roster: slimRoster, priorExchange, evidence, call })` → `{ ops, accepted }`.
5. `truthProj = projectToChars(truth.chapterText, truth.lines)`;
   `finalProj = projectToChars(truth.chapterText, finalSentences.map(s => ({ text: s.text,
   speakerId: s.characterId })))` — **the `characterId → speakerId` adapter is required** (Task 2
   takes `speakerId`; precedent `toPredicted`, run-eval.ts:69).
6. `reviewedByChar = applyOpsToCharArray(finalProj.speakerByChar, finalSentences,
   finalProj.spans-as-{id,start,end}, accepted-attribution-ops)` (copy+mutate; Task 4).
7. Score: `scoreCharRecall(truthProj, finalProj, aliasMap)` and `…(truthProj, reviewedProj,
   aliasMap)` for the two char/line recalls; `diffHelpedHarmed(finalProj.speakerByChar,
   reviewedByChar, truthProj.speakerByChar, aliasMap)`; `predictedDropped = finalProj.dropped`,
   `truthDropped = truthProj.dropped`. `opsByClass`/`dump` from ALL ops (applied-scored + un-scored
   classes + off-roster reattributes). **No `byFamily` on reviewed.**

Omitting `review` leaves the existing `raw`/`det`/`final` result byte-identical.

**Aggregation over `--runs N` (Critical-2):** `aggregateFixture` averages the per-run `reviewed`
into `FixtureAgg.reviewed?: ReviewAgg`:
```ts
export interface ReviewAgg {
  charFinal: Stat; charReviewed: Stat; lineFinal: Stat; lineReviewed: Stat; // reuse stat() → mean/min/max
  helped: Stat; harmed: Stat; churn: Stat;                                   // per-run char counts
  predictedDropped: Stat; truthDropped: Stat;
  opsByClass: Record<string, number>;   // mean count per class across runs
  dump: ReviewScore['dump'];            // representative: run-0's dump (dumps are illustrative, not aggregated)
}
```
`aggStage` is untouched (it's for the line stages); add a sibling `aggReview(scores: ReviewScore[])`.
When no run has `reviewed` (review off), `FixtureAgg.reviewed` is `undefined`.

- [ ] **Step 1: Extend `run-eval.test.ts` (fails)** — mocked analyzer whose
  `runScriptReviewChapter` returns one on-roster `reattribute`: assert `evalFixture({review:true,
  engine:'qwen'})` populates `reviewed` (char/line + helped/harmed + predictedDropped + opsByClass),
  the `characterId→speakerId` adapter works (a fixture whose final `characterId` matches truth
  scores `charFinal>0`), and `review:false` (default) yields the exact same `raw/det/final` object as
  today (snapshot the non-review shape). Add an **aggregation** case: two `FixtureResult`s with
  `reviewed` → `aggregateFixture` produces `ReviewAgg` with `helped`/`harmed` as `Stat`
  (mean/min/max) and `dump` from run-0.

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the `reviewed` branch + `chunkEngine` map in `evalFixture`;
  `aggReview` + `FixtureAgg.reviewed` in `aggregateFixture`; add optional `priorExchange` to
  `LabelledChapterSchema` pinned as `z.object({ turns: z.array(z.object({ speakerId: z.string(),
  speakerName: z.string(), text: z.string() })) }).optional()` (matches route `PriorExchange`), and
  thread it into `runReviewOverChapter` when present.
- [ ] **Step 4: Run — PASS.** Also run the full `attribution-eval` suite (no regression to existing
  stages).
- [ ] **Step 5: Commit** — `feat(server): reviewed char-stage + run-aggregation in evalFixture (opt-in)`.

---

### Task 7: CLI `--review` — scorecard, op-dump, silver partition

**Files:**
- Modify: `server/src/analyzer/attribution-eval/run-eval-cli.ts`
- Test: `server/src/analyzer/attribution-eval/run-eval-cli.test.ts` (extend; pure helpers)

**Interfaces:**
- Consumes: `FixtureAgg.reviewed?: ReviewAgg` (the **aggregated** shape from Task 6, not per-run
  `ReviewScore`). Threads `review` **and `engine`** through `runEval` → `evalFixture` (the existing
  `runEval` loop at run-eval-cli.ts:88-100 must add `review` and `engine` to the `evalFixture(...)`
  call — `engine` is the loop var already in scope).

**Method:** add `--review` (and env `EVAL_REVIEW`) → `review:true`, threaded to `evalFixture`.
Extend the fixture regex to tag silver:
`/^(.+)-ch(\d+)\.([a-z]{2})(\.silver)?\.labelled\.json$/`, tagging each `CorpusItem` with
`tier: 'gold' | 'silver'` (the `loadDir`/`FIXTURE_RE` at run-eval-cli.ts:15). `printScorecard`:
after the existing `raw→det→final` line, when `reviewed` present print a char line from the
`ReviewAgg` Stats — `final(char) X% → reviewed(char) Y% (Δ … | line Xl%→Yl% | helped H harmed M
churn C)` with `--runs>1` ranges from the `Stat`s — plus a **coverage-health note when
`predictedDropped.mean > 0`** ("⚠ N predicted units unlocated — char coverage incomplete",
Important-4), a by-class op count, then an **op-dump** block for the un-scored ops. Print **gold
fixtures and the Coalfall guardrail first, then a separate `--- silver (directional, not gating)
---` block**; silver rows carry a `directional` marker.

- [ ] **Step 1: Extend `run-eval-cli.test.ts` (fails)** — unit-test the pure helpers: the silver
  regex tags `foo-ch12.en.silver.labelled.json` as silver and `foo-ch12.en.labelled.json` as gold;
  a `formatReviewLine(ReviewAgg, runs)` renders the Δ + helped/harmed (+ range when runs>1) + the
  drop warning when `predictedDropped.mean>0`; the partition helper splits gold+Coalfall from
  silver.

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the flag, regex, `tier`, formatting, partition, op-dump. Keep
  `main()`'s SKIP/exit-0 posture.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(server): eval --review scorecard, op-dump, silver partition`.

---

### Task 8: Silver capture path + prior-exchange + regression doc

**Files:**
- Modify: `server/src/analyzer/attribution-eval/capture.ts`, `capture-cli.ts`
- Test: `server/src/analyzer/attribution-eval/capture.test.ts` (extend)
- Modify: `docs/features/265-attribution-eval-tuning.md` (ship note)
- Modify: `package.json` (a `eval:attribution:capture-silver` script if a distinct entry is needed)

**Interfaces:** a capture that writes a **silver skeleton** for an untuned chapter — `chapterText`
(stripped body) + `lines` seeded from the book's current attribution + an optional captured
`priorExchange` — under `<slug>-chNN.<lang>.silver.labelled.json`. The **label content**
(corrected `speakerId`s) is authored by the strong-model labelling pass at capture time (an
activity, not code); the CLI only produces the skeleton + prior-exchange and marks the file silver.

**Prior-exchange:** capture the prior chapter's final two-speaker exchange (reuse the route's
`priorChapterBoundaryExchange` logic — export it or mirror its pure core) into the fixture's
optional `priorExchange`, so Task 6 feeds chunk 0 production-faithfully. For gold fixtures this is a
follow-up re-capture; v1 gold fixtures without it state the limitation (opening-line corrections
under-measured) in the ship note.

- [ ] **Step 1: Extend `capture.test.ts` (fails)** — `buildSilverSkeleton(chapterBody, sentences,
  roster, priorExchange?)` produces a valid `LabelledChapter` (schema-parses) with the silver naming
  and the `priorExchange` field when supplied.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the skeleton writer + prior-exchange capture; wire the CLI entry.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Update `docs/features/265-attribution-eval-tuning.md`** — a "Script-review eval
  (char-level)" ship note: what the `reviewed` stage measures, the gold-only gate, silver
  directional posture, the prior-exchange v1 limitation, and that the char metric is a
  **regression guard** (helped≈harmed≈0 is the expected good outcome on a good baseline).
- [ ] **Step 6: Commit** — `feat(server): silver capture skeleton + prior-exchange; 265 ship note`.

---

## Baseline capture (post-implementation activity — not a code task)

After Task 8 merges, on the dev box: scan the untuned PwF chapters → recommend a silver set → user
confirms → label them (strong independent full-chapter pass) → run
`npm run eval:attribution -- --review --runs 3` (qwen local, then cloud). Record the baseline
scorecard (gold char metric + silver directional + op-dump volumes) in the 265 ship note + a memory.
That number gates the sequenced tuning follow-up (spec §7).

## Notes for the implementer

- **No release-notes entry.** This is opt-in dev tooling with no user- or operator-visible runtime
  delta (same posture as the attribution-eval harness in plan 265) — the before-shipping
  release-notes step is legitimately N/A; say so in the PR.
- **Gating stays intact.** Never add any `eval:attribution` invocation to `test:all` / `verify`.
- **The PR needs a linked issue** (`Closes #NN`) — filed as part of the design handover.

## Self-review (done at authoring)

- Spec coverage: every §3 mechanism maps to a task (projection T2, scorer T3, applier T4, faithful
  run T5, wiring T6, reporting/op-dump/silver T7, capture/prior-exchange T8, ported reuse T1).
- Type consistency: `CharProjection`, `ReviewScore`, `runReviewOverChapter` signatures are used
  identically across T2→T6.
- Open questions O-1..O-5 resolved in-plan: O-1 = server port + shared vector (T1, forced by server
  rootDir); O-2 = off-roster dumped (T4/T7); O-3 = silver filename tag (T7); O-4 = skip-on-miss
  (T2); O-5 = report both char + per-line (T3/T7).
