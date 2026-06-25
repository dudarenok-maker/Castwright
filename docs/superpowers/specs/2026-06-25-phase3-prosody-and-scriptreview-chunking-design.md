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
> `prosodyEnabled`** and repurposed as a nullable intent flag (see Deliverable 1).
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

So Phase 3 runs as a **separate streamed pass that auto-fires once the book
reaches the confirm/ready stage when the gate is open and prosody not yet
complete.** It reuses the **existing** `detectEmotions` + `detectInstruct`
routes (factored out of `DetectEmotionsButton.run`), now driven through the PR2
chunker so they don't truncate large chapters. The user proceeds to cast
immediately; prosody annotates in the background.

### Gate model — nullable intent flag + cast-derived auto-rule

The fs-66 world has no analysis-time `liveInstruct` synth gate; the "go 1.7B"
decision is now a **cast-time** signal (`ttsModelKey === 'qwen3-tts-1.7b'`, set
per-character or via the book bulk-pin `POST /cast/tier`). So Phase 3 gates on a
**per-book intent flag `prosodyEnabled`** (the renamed, repurposed `liveInstruct`
field) that is effectively **tri-state**, combined with the live cast signal:

| `prosodyEnabled` | Meaning | Fires the pass when… |
|---|---|---|
| `undefined` (default, untouched) | **Auto** | the book's cast actually renders at 1.7B |
| `true` (toggled on) | **Explicit opt-in** | always (after analysis), even before any 1.7B pin |
| `false` (toggled off) | **Explicit opt-out** | never auto — honored even if the book is later pinned to 1.7B |

**Effective gate** (evaluated once the book reaches confirm/ready, so sentences
exist):

```
bookCastIs17b = cast.characters.some(c => c.ttsModelKey === 'qwen3-tts-1.7b')   // ANY member (mirrors selectEnginesInUse)
shouldAnnotate =
    prosodyEnabled === false ? false
  : prosodyEnabled === true  ? true
  : bookCastIs17b              // the "auto" / safety-net case
fire = shouldAnnotate && !prosodyAnnotated && stageKind ∈ {confirm, ready}
```

This covers all four real users without special cases:
- **Default-1.7B user** → flag `undefined`, fresh cast inherits `defaultTtsModelKey`
  = 1.7B → fires right after analysis. *This is "default ON when 1.7B loaded,"
  achieved even if the toggle is never touched.*
- **Default-Kokoro user who pins 1.7B late** → flag `undefined` → the bulk-pin
  flips `bookCastIs17b` → **safety net** fires.
- **1.7B user who doesn't want it on this book** → toggles OFF → `false` → suppressed.
- **Kokoro user prepping a planned 1.7B switch** → toggles ON → `true` → annotates eagerly.

- **Toggle.** An analysis-form toggle (`src/views/analysing.tsx`) labeled
  "Expressive directions (Qwen 1.7B)". Its **checked-default** =
  `account.defaultTtsModelKey === 'qwen3-tts-1.7b'`. Untouched → store nothing
  (`undefined` = auto); touched → store the explicit boolean. It reads/writes the
  **frontend store** (`book-meta-slice`) + a durable `putBookState` PUT; **no
  server-side analysis-time read** is needed (the trigger is client-side, post-analysis).

- **Trigger — one reactive effect (the two paths are one implementation).** A
  single `useEffect` in `src/components/layout.tsx` mirrors the existing
  voice-match auto-trigger (`layout.tsx:895-917` — `useRef` fired-guard +
  `cancelled` cleanup + a fresh `AbortController`). Dependency set:
  `[stageKind, bookId, prosodyEnabled, bookCastIs17b]`. It re-evaluates the gate
  on any change and fires once. The **cast-time safety net is not a separate code
  path**: the bulk-pin writes `ttsModelKey` into the cast slice → the
  `bookCastIs17b` dependency flips → the effect re-fires. Reactivity *is* the
  safety net, so no path that lands a 1.7B cast member can be missed.

- **Surfacing.** Phase 3 progress shows in the **global progress pill**
  (`layout.tsx` AnalysisPill region) + a card on the confirm/manuscript view,
  labeled "Phase 3 — Detecting prosody". The analysing view's 3-phase list is
  **unchanged** (no `ANALYSIS_PHASES`/`PHASE_WEIGHTS` edits — Phase 3 has its own
  progress surface, not a 4th in-pipeline phase).
- **Resume / idempotency.** A completion watermark `prosodyAnnotated`
  (`state.json`) records progress. The passes are fill-only-empty
  (`applyDetectedEmotions`/`applyDetectedInstruct`), so an interrupted run is
  recovered by re-firing. The trigger fires only when the watermark is incomplete,
  so it never re-runs needlessly or loops — and it dedupes the two paths (if the
  toggle path already annotated, a later 1.7B pin sees the watermark complete and
  no-ops).
- **Cancellable + non-blocking.** The pass is abortable and never blocks
  navigation or casting.
- **The "Detect emotions" button stays** as the manual re-run / top-up — and the
  explicit recovery for a `prosodyEnabled === false` book that later goes 1.7B.

### Flag rename: `liveInstruct` → `prosodyEnabled`

The orphaned `liveInstruct` plumbing (set by no UI, read at no synth site post-fs-66)
is **renamed `prosodyEnabled`** and repurposed as the nullable intent flag above.
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
  (already client-handled) — partial progress is preserved and the user re-runs.
- Phase 3 with `prosodyEnabled === false` (or `undefined` + a non-1.7B cast)
  simply never fires — a deliberate non-event, not an error. The progress pill is
  absent.

## Known accepted limitations

- `prosodyEnabled` (the trigger intent) is *not* the synth-time gate (which is
  `is17b` alone post-fs-66, `resolve-instruct.ts`). A user can toggle prosody on,
  get annotations, then render with Kokoro (which ignores `instruct`), wasting
  the passes. Accepted: explicit user choice. Conversely the `false` opt-out is
  honored even against a 1.7B render (canned phrases only) — also explicit.
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
- **Phase 3:** frontend test — the **gate truth-table** (the four user rows):
  `prosodyEnabled` `undefined` + 1.7B cast → fires; `undefined` + Kokoro cast →
  doesn't; `false` + 1.7B cast → suppressed; `true` → fires regardless of cast;
  watermark-complete → never re-fires; **a late cast-pin flips `bookCastIs17b`
  and fires once** (the safety net); re-fire fills only empties; the toggle's
  checked-default = `defaultTtsModelKey === 'qwen3-tts-1.7b'`; untouched stores
  `undefined`, touched stores the boolean; the global pill renders progress.
  Server test — the annotation routes run through the chunker; the watermark is
  written on completion. One e2e: default-1.7B book → analysis completes → user
  reaches cast while the prosody pill runs → annotations land.

## PR decomposition

1. `fix/frontend-scriptreview-chapter-failed` — 2A (small, ship first; fixes the
   reported "useless empty modal" immediately).
2. `feat/server-analyzer-chapter-chunker` — the shared chunker + 2B (script
   review consumes it).
3. `feat/analysis-phase3-prosody` — `liveInstruct` → `prosodyEnabled` rename +
   the nullable-intent gate model, analysis-form toggle (smart default), the
   single reactive auto-trigger (covers both the analysis-toggle and cast-time
   safety-net paths) + global-pill surfacing + completion watermark. Cross-cutting
   (server rename/watermark + frontend trigger/UI), but smaller than the
   tail-of-stream version (no analysis.ts surgery, no 4th-phase static-array changes).

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
