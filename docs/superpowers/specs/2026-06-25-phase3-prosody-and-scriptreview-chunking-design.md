# Phase 3 prosody annotation + analyzer sentence-chunking (script review large chapters)

**Date:** 2026-06-25 · **Status:** design (approved, pre-plan; adversarial rounds 1+2 folded)

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

So Phase 3 runs as a **separate streamed pass that auto-fires once the book
reaches the confirm/ready stage with `liveInstruct` on and prosody not yet
complete.** It reuses the **existing** `detectEmotions` + `detectInstruct`
routes (factored out of `DetectEmotionsButton.run`), now driven through the PR2
chunker so they don't truncate large chapters. The user proceeds to cast
immediately; prosody annotates in the background.

- **Gate / trigger.** A new form toggle "High-quality prosody (Qwen 1.7B)" on the
  analysis-start surface (`src/views/analysing.tsx`) sets the book's
  `liveInstruct=true` (default off — extra quota + vocalization mutates text).
  The post-analysis auto-trigger reads `liveInstruct` from the **frontend store**
  (`book-meta-slice`, already hydrated) — **no server-side analysis-time read is
  needed.** Setting the toggle pre-analysis is what makes prosody run
  automatically right after the first analysis; toggling it on later (or the
  manual button) covers the rest.
- **Surfacing.** Phase 3 progress shows in the **global progress pill**
  (`src/components/layout.tsx` AnalysisPill region) + a card on the
  confirm/manuscript view, labeled "Phase 3 — Detecting prosody". The analysing
  view's 3-phase list is **unchanged** (no `ANALYSIS_PHASES`/`PHASE_WEIGHTS`
  edits — the static-const blast radius is avoided entirely by not making it a
  4th in-pipeline phase).
- **Resume / idempotency.** A completion watermark on the book (a `state.json`
  field, e.g. `prosodyAnnotated` per chapter or a single status) records
  progress. The passes are fill-only-empty (`applyDetectedEmotions`/
  `applyDetectedInstruct`), so an interrupted run is recovered by re-firing — it
  fills the remaining empties. The auto-trigger fires only when the watermark is
  incomplete, so it never re-runs needlessly or loops.
- **Cancellable + non-blocking.** The pass is abortable (existing
  AbortController path) and never blocks navigation or casting.
- **The "Detect emotions" button stays** as the manual re-run / top-up.

### Coordination with the concurrent "Book-level Higher quality (1.7B)" spec

A parallel design (`docs/superpowers/specs/2026-06-25-book-level-higher-quality-tier-design.md`)
adds a **book "Higher quality (1.7B)" override + bulk pin** that, at **synth /
regenerate time**, forces every Qwen cast member to the 1.7B model and opens the
`liveInstruct` AND-gate. That control and this Phase 3 are **two stages of one
feature, not duplicates**, and must use the **same `liveInstruct` flag** — do not
introduce a competing book-quality flag here:

- **Their toggle is meaningful later** (regenerate/generation): it enforces 1.7B
  + opens the gate at synth.
- **This Phase 3 toggle is meaningful at analysis time**: it must stay on the
  analysis UX so the per-line prosody **annotations are generated *before*
  generation reaches the 1.7B model** — otherwise opening their gate only yields
  the four canned `emotionToInstruct` phrases, not real per-line delivery.
- **Shared signal:** the analysis-form "High-quality prosody (Qwen 1.7B)" toggle
  sets `liveInstruct`; their override reads `liveInstruct || bookQualityOverride`.
  One intent, two entry points. The two specs cross-reference each other and the
  work is coordinated with that session (the user oversees both). If the concurrent
  feature lands a unified "quality" control first, this toggle becomes an
  analysis-stage surfacing of the same flag rather than a new switch.

## Error handling

- A failed chunk emits `chapter-failed` (now surfaced by 2A) and the pass
  carries on (one bad chunk never kills the chapter or the pass).
- `DailyQuotaExhaustedError` keeps its `error{code:'quota_exhausted'}` behaviour
  (already client-handled) — partial progress is preserved and the user re-runs.
- Phase 3 with `liveInstruct` off simply never fires — a deliberate non-event,
  not an error. The progress pill is absent.

## Known accepted limitations

- `liveInstruct` (the trigger gate) is *not* the synth-time gate
  (`is17b && liveInstruct`, `resolve-instruct.ts`). A user can toggle prosody on,
  get annotations, then render with Kokoro (which ignores `instruct`), wasting
  the passes. Accepted: explicit user choice.
- Multi-book: each book's Phase 3 is a separate stream sharing the per-model
  analyzer rate-limit bucket (same as today's button). No per-manuscript
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
- **Phase 3:** frontend test — the form toggle sets `liveInstruct`; the
  post-analysis auto-trigger fires once when `liveInstruct` on + watermark
  incomplete, and does NOT fire when off or when the watermark is complete;
  re-fire fills only empties; the global pill renders progress. Server test —
  the annotation routes run through the chunker; the watermark is written on
  completion. One e2e: toggle on → analysis completes → user reaches cast while
  the prosody pill runs → annotations land.

## PR decomposition

1. `fix/frontend-scriptreview-chapter-failed` — 2A (small, ship first; fixes the
   reported "useless empty modal" immediately).
2. `feat/server-analyzer-chapter-chunker` — the shared chunker + 2B (script
   review consumes it).
3. `feat/analysis-phase3-prosody` — form toggle + post-analysis auto-trigger of
   the annotation passes (through the chunker) + global-pill surfacing +
   completion watermark. Cross-cutting (server watermark + frontend trigger/UI),
   but smaller than the tail-of-stream version (no analysis.ts surgery, no
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
