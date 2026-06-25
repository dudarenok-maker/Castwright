# Phase 3 prosody annotation + analyzer sentence-chunking (script review large chapters)

**Date:** 2026-06-25 · **Status:** 2A + 2B SHIPPED (PR #1126, #1128); Phase 3 gate **REDESIGNED** 2026-06-25 (fs-66 landed — see below); ready to plan/build

> **Gate redesign (2026-06-25, fs-65 #1129).** fs-66 ("1.7B implies prosody",
> PR #1136) collapsed the synth prosody gate to `is17b` alone and **dropped
> `liveInstruct` as a synth gate** — leaving it as orphaned per-book plumbing
> (`BookStateJson.liveInstruct`, `book-meta-slice`), persisted but set by no UI
> (the #1100 toggle was deleted) and read at no synth site. fs-66 also moved the
> "go 1.7B" decision from analysis-time to **cast-time** (per-character
> `ttsModelKey === 'qwen3-tts-1.7b'` or the book bulk-pin `POST /cast/tier`).
> Phase 3's **intent is unchanged** — the per-line prosody annotations still must
> exist *before* a 1.7B render, otherwise that render gets only the four canned
> `emotionToInstruct` phrases — but its **trigger/gate is redesigned on the new
> 1.7B signal** (this revision). The orphaned `liveInstruct` field is **renamed
> `prosodyEnabled`** and repurposed as an eager-default intent flag, absent ⇒ on
> (see Deliverable 1).
> Deliverables **2A** (chapter-failed surfacing) and **2B** (script-review
> chunker) shipped and are unaffected; the chunker (2B) is the reusable asset
> Phase 3 still consumes.

Origin: a `/superpowers:systematic-debugging` session over two reported symptoms
("Phase 3 doesn't show in the analysing view" and "Review Script is always
empty"). Root-causing both surfaced three deliverables that share one new
component. They ship as **separate branches/PRs**; this is the single design
that scopes them.

## Symptoms → confirmed root causes

1. **"Review Script always opens an empty modal, with no way to know why."**
   Live-reproduced against the German *Der Auftrag von Coalfall* book. The SSE
   stream for a per-chapter review of a normal-sized chapter:

   ```
   data: {"kind":"chapter-failed","chapterId":2,
          "message":"Chapter 2 is too large for a single review call
                     (prompt 10222 chars > 9000 char budget) — split it first."}
   data: {"kind":"result","done":true,"reviewedChapters":0,"totalOps":0}
   ```

   Two independent faults:
   - **2A — silent failure.** The client SSE handler (`realReviewScript`'s
     `handle()`, `src/lib/api.ts`) has **no `chapter-failed` case**, so it drops
     the event. The stream still ends with `result{totalOps:0}` → `setReview`
     creates an empty bucket → the modal opens empty with subtitle "didn't find
     anything to change" and **no error**. The same gap exists in the
     instruct/emotion stream handlers.
   - **2B — the budget is wrong for the job.** The `9000`-char limit is
     `DEFAULT_STAGE2_CHUNK_CHAR_BUDGET` — the stage-2 *attribution* chunk
     budget — borrowed wholesale by `server/src/routes/script-review.ts`.
     Script review's *output* is a few ops; its input can be large, and the
     analyzer models (`gemma-4-31b-it`, `gemini-3.1-flash-lite`) have
     hundreds-of-K-to-~1M-token contexts. A 10 K-char chapter is normal. The
     measured worst case — *Ночной дозор* (Night Watch) — has chapters of
     **2,509 sentences / ~220 K prompt chars / ~73–110 K tokens (Cyrillic)**,
     i.e. **3–5× the local model's entire 32 K `num_ctx`**, and *every* chapter
     exceeds it. Chunk-with-overlap (explicitly deferred at the `ASSUMPTION`
     comment, `script-review.ts:222`) is required.

2. **"Phase 3 (invariants) doesn't show after analysis."**
   The "invariants" are the per-line **delivery directions submitted to Qwen
   1.7B for emotion + prosody** — the fs-57 instruct/emotion/vocalization
   annotations — *not* the attribution-side `verifyEvidenceAgainstSource` check.
   These products exist only behind the opt-in **"Detect emotions"** button,
   which runs two sequential whole-book LLM passes (`detectEmotions` +
   `detectInstruct`/`runStage3Chapter`). They were never made automatic.
   **Phase 3 = run those passes automatically and visibly once attribution is
   done, gated to when they'll be used.**

## Shared component — analyzer sentence-chunker

Common dependency of 2B and Phase 3. Both passes today send a chapter's *entire*
sentence payload in one call; on a Dozor-sized chapter, script-review **refuses**
it (the 9 K guard) and the emotion/instruct passes **silently truncate** the
model's JSON (no guard at all).

Design:

- New `server/src/analyzer/chapter-chunker.ts`. **Reuse** the existing budget
  helper `stage1ChunkBudgetForEngine` (`stage1-chunk.ts` — 70 % of `num_ctx` ×
  ~2 chars/token, floor 2000; cloud → effectively unbounded, one chunk) and the
  stage-2 sentence-splitting helpers (`splitParagraphIntoSentences`,
  `precedingContext`). It is **not** a drop-in reuse of `runStage1ChapterChunked`
  itself — that returns a roster, threads no overlap, and is attribution-shaped.
- **Sentence-boundary core + overlap.** Each chunk has an **owned core** set of
  sentences plus ~3 sentences of **context-only overlap** on each side, so a
  boundary-straddling `merge`/`split`/`extract` or a delivery cue in an adjacent
  narrator split is visible.
- **Ownership dedupe rule (eliminates double-application).** A chunk emits a
  result for a sentence **only when that sentence is in its owned core** — never
  for an overlap/context sentence. For a **structural op** (`merge`, `split`,
  `extract_dialogue`), ownership is decided by the op's **primary sentence = the
  lowest member id** (`min(mergeIds)` for merge; the anchor sentence id for
  split/extract). Consequence: every sentence is reviewed/annotated **exactly
  once**, so there is no post-hoc dedupe and **no reliance on `opKey`**. This
  sidesteps two real bugs: (a) `opKey` can't distinguish two `merge` ops (shared
  `id`, differ only by `mergeIds`); (b) `applyDetectedInstruct` applies
  vocalization `text` last-write-wins (`manuscript-slice.ts:387`). Both are moot
  when a sentence is only ever emitted by one chunk.
  - **Accepted limitation:** if a boundary-straddling structural op is proposed
    *only* by the non-owning chunk, ownership suppresses it and nobody emits it.
    The owning chunk has the trailing-overlap context to detect it, but model
    nondeterminism makes detection non-guaranteed. Acceptable for v1.
- Budget derived from the **live** analyzer `num_ctx`: cloud → one chunk; local
  (32 K) → many ~24 K-char chunks.
- **Chunker-safety confirmed:** the Stage-3 pass is annotation-only
  (`stage3ChapterSchema` is `.strict()` → `{sentenceId, text?, instruct?,
  vocalization?}`; `applyDetectedInstruct` mutates existing sentences in place,
  never allocates new ids), so the per-chapter sentence-id set is stable across
  annotation.

## Deliverable 2A — surface `chapter-failed` (bugfix, TDD)

- Add a `chapter-failed` case to `realReviewScript`'s `handle()` and to the
  instruct/emotion stream handlers carrying the same gap. Extend the result/
  callback surface so the caller learns a chapter failed (an `onChapterFailed`
  callback or a `failedChapters` count — the current `ReviewScriptResult`
  carries neither).
- In `handleReviewScript` (`src/views/manuscript.tsx`): when chapters failed and
  **no** ops were produced, surface the failure (toast; do **not** open an empty
  modal); when some chapters failed alongside real ops, surface a non-blocking
  notice and still open the diff.
- **Regression test:** a stream of only `chapter-failed` + `result{totalOps:0}`
  must surface the message, not a silent empty bucket. (Fails before, passes
  after.) Ships **first** (independent; fixes the reported symptom immediately,
  while the 9 K guard still exists pre-2B).

## Deliverable 2B — script review chunks large chapters (feature)

- `script-review.ts` loops the shared chunker per chapter, runs the review per
  chunk passing overlap as context, and emits ops **only for the chunk's owned
  core** (ownership rule) — so no `opKey`-based dedupe is needed.
- The 9 K hard-fail guard is **removed**; the only remaining `chapter-failed` is
  the genuinely-impossible case (a single sentence that can't fit one chunk),
  which 2A now surfaces honestly.
- Cloud → 1 chunk/chapter (unchanged behaviour); local → N chunks.

## Deliverable 1 — Phase 3 auto-annotation (feature)

**Architecture — separate auto-triggered pass AFTER analysis completes (NOT
inline, NOT a tail step).** Adversarial round 2 killed both inline placements:
inline-mid-stream reads *unfolded* sentences; tail-before-`result` (a) has a
resume hole — `cast.json`/`state.json` are written before it (`analysis.ts:4088/
4123`), so a resume sees "analysis done" and never re-enters Phase 3, and (b)
**blocks the user on the analysing screen** until every annotation pass finishes,
even though annotations don't affect casting (`result` is the *only* signal that
moves `analysing → confirm`, `ui-slice.ts:195`).

So Phase 3 runs as a **separate streamed pass that auto-fires once a book
transitions to analysis-complete (`cast_pending`), unless the user opted out and
prosody is not yet complete — for the active book AND books analysed in the
background.** It reuses the **existing** `detectEmotions` +
`detectInstruct` routes (factored out of `DetectEmotionsButton.run`), now driven
through the PR2 chunker so they don't truncate large chapters. The user proceeds
to cast immediately; prosody annotates in the background.

### Gate model — eager-default intent flag (decision 2026-06-25)

**Ground truth (verified against the code).** 1.7B is *never* a persistent
account/book default: the TTS model picker offers only Qwen **0.6b**, so
`defaultTtsModelKey` / `resolvedTtsModelKey` are never `qwen3-tts-1.7b` in
practice. 1.7B is chosen **late** — the cast bulk-pin (`POST /cast/tier`, sets
per-character `ttsModelKey`) or a per-regenerate override in the regen modal. So
there is **no analysis-time signal** for "this book will be 1.7B," and an
auto-rule keyed on a cast-1.7B signal would (a) be unknowable at analysis time and
(b) read false for the common case. **Decision: annotate eagerly by default** —
the operator chose to spend the two annotation passes on every analysed book and
get expressive delivery for free whenever a book later goes 1.7B.

Phase 3 gates on a **per-book flag `prosodyEnabled`** (the renamed `liveInstruct`
field), where **absent ⇒ ON**:

| `prosodyEnabled` | Meaning | Auto-fires after analysis? |
|---|---|---|
| `undefined` (default) / `true` | **On** (eager) | Yes — when the book transitions to analysis-complete this session |
| `false` (toggled off pre-analysis) | **Explicit opt-out** | No — honored even if the book later goes 1.7B |

**Effective gate:**

```
# decided per-book inside the launch, from the AUTHORITATIVE disk state (not the store):
launchEligible(state) = state.prosodyEnabled !== false && !state.prosodyAnnotated
```

- **Trigger keyed on library status, NOT the active stage (round-2 Critical).**
  `stageKind === 'confirm'` is structurally a **single-active-book** signal
  (`ui.stage` is singular; `analysisComplete` is guarded to the active analysing
  stage), so a book analysed in the **background** while another is active would
  *never* be observed at `confirm` and would silently never annotate — violating
  the first-class concurrent-multi-book invariant. Instead, **one effect fans out
  over `library.books` statuses** (the substrate the plan-83 background poll
  already uses, `layout.tsx:940-976`) and fires for any book that **transitions**
  into an analysis-complete status (`cast_pending` and later — sentences exist),
  active or background alike.
- **Seed-on-mount to skip pre-existing books.** `Layout` is the persistent app
  shell (mounts once). On the effect's **first run**, every already-complete book
  is added to a `considered` ref-`Set` *without firing* — so the existing library
  is not retro-annotated (no backlog-wide quota spend on upgrade). Only books that
  reach analysis-complete *later in the session* (a fresh or background analysis)
  fire. This seed also makes a `Layout` remount self-healing: a re-seed re-marks
  any in-flight book as considered, so it can't double-fire (round-2 #5).
- **No cast read.** Eligibility does not depend on the cast — no cast-1.7B signal,
  no cast-hydration race. (Drops the earlier "cast-time safety net": with
  eager-default every fresh book is annotated; the only uncovered case is an
  explicit opt-out that later goes 1.7B — see Limitations + the render-time hint.)

- **Toggle.** An analysis-form toggle (`src/views/analysing.tsx`) labeled
  "Expressive directions" — **checked by default** (eager). Checked state =
  `stored !== false`. Unchecking stores `false` (opt-out); re-checking stores
  `true`. It writes the **frontend store** (`book-meta-slice`) AND a durable
  `putBookState` PUT — the **PUT is load-bearing**: the trigger reads the opt-out
  from disk (below), not the store, so the durable value is the gate. The analysis
  POST is **not** gated on it.

- **Launch — authoritative, per-book, retry-safe.** For each newly-complete book
  the effect launches a detached background job:
  1. `state = await api.getBookState(bookId)` — read **both** `prosodyEnabled` and
     `prosodyAnnotated` from this one disk fetch. Gating on the fetched
     `prosodyEnabled !== false` (not the possibly-un-hydrated store selector)
     **eliminates the opt-out hydration race** (round-2 #2) and honors the opt-out
     authoritatively. `prosodyAnnotated` truthy ⇒ no-op (watermark).
  2. `const { failed } = await runProsodyPasses(bookId, { dispatch })`.
  3. **Watermark only on full success:** `if (failed === 0) putBookState(…
     prosodyAnnotated:true)`; **else remove the book from `considered`** so the
     fill-only-empty re-run can top up the failed chapters (round-2 #6 — the
     passes resolve on *partial* failure, so an unconditional watermark would
     wrongly mark a partial book complete and block recovery).
  4. The whole job is wrapped in `try/catch`; on throw, remove from `considered`
     (retry-safe, round-1 H3). The job is **detached** from the effect's cleanup
     (NOT cancelled on a `bookId`/active-stage change), so a background book's pass
     survives the user switching books (round-1 H2).

- **Surfacing.** Phase 3 progress shows in the **global progress pill**
  (`layout.tsx` AnalysisPill region) + a card on the confirm/manuscript view,
  labeled "Phase 3 — Detecting prosody". The analysing view's 3-phase list is
  **unchanged** (no `ANALYSIS_PHASES`/`PHASE_WEIGHTS` edits — Phase 3 has its own
  progress surface, not a 4th in-pipeline phase).
- **Non-blocking.** The pass never blocks navigation or casting.
- **The "Detect emotions" button stays** as the manual re-run / top-up — the
  recovery for an opted-out book that later goes 1.7B, and for pre-existing books.

### Flag rename: `liveInstruct` → `prosodyEnabled`

The orphaned `liveInstruct` plumbing (set by no UI, read at no synth site post-fs-66)
is **renamed `prosodyEnabled`** and repurposed as the eager-default intent flag
above (absent ⇒ on; only `false` opts out).
Sites: `BookStateJson.liveInstruct` (`server/src/workspace/scan.ts`) +
`book-state.ts` patch picker; `book-meta-slice` (`liveInstruct` record +
`setLiveInstruct`/`selectLiveInstruct`); the `layout.tsx:790` hydration; `api-types.ts`
(regenerated from `openapi.yaml`). The dead synth meaning is gone, so the old name
is now a trap — a small, mechanical rename for clarity. **Do not** touch the
unrelated `instructHash`/`renderedInstructHashes` "liveInstruct render" comments in
`segments-io.ts`/`stale-chapters.ts` — those name the synth path, not this flag.

## Error handling

- A failed chunk emits `chapter-failed` (now surfaced by 2A) and the pass
  carries on (one bad chunk never kills the chapter or the pass).
- `DailyQuotaExhaustedError` keeps its `error{code:'quota_exhausted'}` behaviour
  (already client-handled) — partial progress is preserved and the trigger's
  per-book guard clears on failure so it retries (round-1 H3).
- Phase 3 with `prosodyEnabled === false` simply never fires — a deliberate
  non-event, not an error. The progress pill is absent.

## Known accepted limitations

- **Eager cost (operator's choice).** With eager-default, every freshly analysed
  book spends two whole-book annotation passes (analyzer quota), *including*
  Kokoro-only books that ignore `instruct` at synth. Accepted per the 2026-06-25
  decision ("expressive by default"). `prosodyEnabled` is NOT the synth-time gate
  (that is `is17b` alone post-fs-66, `resolve-instruct.ts`); annotations are
  simply unused on a non-1.7B render.
- **Silent-flat on opt-out + late 1.7B.** A book toggled OFF that later goes 1.7B
  renders with only the four canned `emotionToInstruct` phrases. To avoid this
  being invisible (round-1 M5), surface a one-line hint at the cast/render surface
  when `prosodyEnabled === false` and the book is being rendered at 1.7B —
  "Expressive directions are off for this book — using basic emotion phrases.
  [Turn on]" wired to re-enable + the manual "Detect emotions" recovery. *(Small
  UX add; if it risks scope it ships as an immediate follow-up, not silently
  dropped.)*
- **Pre-existing books are not retro-annotated.** The seed-on-mount considered-set
  means books already analysis-complete when the app shell mounts are skipped; they
  gain prosody only via the manual "Detect emotions" button. Deliberate — avoids a
  backlog-wide auto-spend on upgrade. **Accepted edge:** a book that completes in
  the *exact* render the shell first mounts is seeded as pre-existing and skipped
  (covered by the manual button); and a book whose analysis finished while the app
  was closed is treated as pre-existing on next launch. Both are the conservative
  side of the trade (skip, don't double-spend).
- Multi-book: each book's Phase 3 is a separate background stream sharing the
  per-model analyzer rate-limit bucket (same as today's button). The trigger's
  per-book guard keeps concurrent books' passes independent. No per-manuscript
  prioritisation; throttles queue internally. Acceptable.
- Boundary-straddling structural op detected only by the non-owning chunk can be
  dropped (see chunker section).

## Testing

- **2A:** frontend unit tests on the SSE handler + `handleReviewScript`
  (chapter-failed-only stream → toast, no empty modal).
- **Chunker:** server unit tests — core/overlap boundaries never split a
  sentence; a structural op is owned by exactly one chunk (lowest-member rule);
  budget scales with `num_ctx` (use a low-`num_ctx` override + a small synthetic
  fixture to force multi-chunk, **not** the real 220 K Dozor text); an overlapped
  sentence is emitted exactly once.
- **2B:** server route test — a chapter over budget yields chunked `ops` with no
  `chapter-failed`; a boundary-straddling `merge` is emitted once.
- **Phase 3:** frontend test — the **library-status trigger**: a book that
  **transitions** into `cast_pending` after mount fires `runProsodyPasses` once
  (eager); a book already complete **at mount** is seeded as considered and does
  NOT fire (no retro-annotation); a **background** book (not the active stage) that
  transitions fires (the Critical #1 regression — assert it fires even though
  `stageKind`/`bookId` reference a *different* active book). Authoritative gate
  (round-2 #2): with `getBookState` returning `prosodyEnabled:false` → no
  `runProsodyPasses` even though the store selector is `undefined`; returning
  `prosodyAnnotated:true` → no-op. Robustness: **two books transitioning each fire
  once and a book-switch does not abort either** (H2); a **rejected** pass removes
  the book from `considered` so a later transition retries (H3); a resolved pass
  with `failed > 0` does NOT write the watermark and removes the book from
  `considered` (round-2 #6); `failed === 0` writes `prosodyAnnotated:true`. Toggle:
  **checked by default** (`stored !== false`); unchecking stores `false` + issues
  the PUT; re-checking stores `true`. The global pill renders progress. Server
  test — the annotation routes run through the chunker; the watermark is written
  on completion. One e2e: analysis completes → the prosody pill runs in the
  background → annotations land (a sentence gains an `instruct`); a second book
  with the toggle unchecked pre-analysis does NOT run the pass.

## PR decomposition

1. `fix/frontend-scriptreview-chapter-failed` — 2A (small, ship first; fixes the
   reported "useless empty modal" immediately).
2. `feat/server-analyzer-chapter-chunker` — the shared chunker + 2B (script
   review consumes it).
3. `feat/analysis-phase3-prosody` — `liveInstruct` → `prosodyEnabled` rename
   (absent ⇒ on) + the eager-default gate, analysis-form toggle (checked by
   default), the per-book + retry-safe `confirm`-only auto-trigger + global-pill
   surfacing + completion watermark. Cross-cutting (server rename/watermark +
   frontend trigger/UI), but small (no analysis.ts surgery, no cast read, no
   4th-phase static-array changes).

Sequence 2 before 3 (Phase 3's passes consume the chunker). 1 is independent.

## Adversarial review log

**Round 1** (two verifier agents): inline Phase 3 reads unfolded sentences +
sticky/non-sticky clash → moved off inline. liveInstruct unreadable at analysis
time. `opKey` dedupe broken for `merge`; vocalization-text last-write-wins →
owned-core rule. No skipped-phase UI. `stage1-chunk` not a drop-in.

**Round 2** (two verifier agents): **tail-of-stream is also unsafe** — resume
short-circuits on `cast.json` presence (annotations silently partial) and
`result`-before-Phase-3 **blocks the user from casting** → flipped to a
**separate post-analysis auto-triggered pass**. This flip *removed* two round-1
work items: the 4th-phase static-array surgery (Phase 3 now has its own progress
surface, not an in-pipeline phase) and the server-side analysis-time
`liveInstruct` read (trigger reads the frontend store). Confirmed safe: Stage-3
is annotation-only (no new sentence ids → chunker-safe). Named accepted limits:
non-owning-chunk structural-op drop; multi-book rate-limit sharing.

## Out of scope

- The in-flight working-tree change to `server/src/util/text-match.ts`
  (multilingual quote folding for the **render-integrity** verifier) is
  unrelated to these three deliverables and ships on its own.
- No change to the synth-side resolver ladder, the Qwen engine, or the
  `instruct`/emotion schema — all shipped by fs-57.
- A literal 4th bar in the analysing phase list, and a per-chapter trigger for
  "Detect emotions" — both deferred follow-ups.
