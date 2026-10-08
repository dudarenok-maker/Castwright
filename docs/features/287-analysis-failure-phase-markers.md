---
status: active
shipped: null
owner: null
---

# 287 — Analysis failure bookkeeping: explicit phase and completeness markers (#3435)

> Status: active — implemented on `fix/server-failure-phase-markers` (T1–T7), not yet merged or on-box accepted. **Plan approved by the owner on 2026-10-03 (O4)**, after plan checks 1–3 and owner decisions A–C, E–H and O1–O3. Implementation is a new PR superseding #3439, with the normal review gate. No fourth check.
>
> **Line numbers** in this plan are on **`origin/main` at c64943ff** (2026-10-03), like the spec. c64943ff differs from the previous basis 6f01fa20 only in test files, so production lines are unchanged; test-file lines were re-derived. Each citation names a symbol or the code at that line; if `origin/main` has moved, re-derive the line from the symbol before editing. Nothing is cited from #3439's head.
>
> Key files:
> - `server/src/routes/analysis.ts`
> - `server/src/store/analysis-cache.ts`, `analysis-cache-rebuild.ts`, `analysis-state.ts`
> - `server/src/workspace/scan.ts`, `server/src/routes/book-state.ts`, `server/src/routes/generation.ts`
> - `src/views/analysing.tsx`, `src/views/generation.tsx`
> - `src/store/analysis-stream-middleware.ts`, `src/store/analysis-slice.ts`
> - `src/lib/api.ts`, `src/lib/analysis-phase-state.ts`, `src/lib/types.ts`
>
> URL surface: indirect. The Analysing view's Retry, the Generate view's Re-analyse and Include, the library badge.
> OpenAPI ops: `GET /api/books/{bookId}` (`analysis.failedChapterErrors[].phase`, `analysis.stage1Ready`, `analysis.resumeRequired`, `analysis.unattributedChapterIds`); `POST /api/manuscripts/{id}/analysis` and `…/analysis/chapters` (new 409 bodies, the `resume_required` terminal code, `phase` on `chapter-failed`).

- **Design:** [2026-10-03-analysis-failure-phase-markers-design.md](../superpowers/specs/2026-10-03-analysis-failure-phase-markers-design.md). Section numbers below (§, M-rules, S-rules, decisions A–C, E–H, O1–O3, D1, D4, D5) refer to it.

## Benefit / Rationale

- **User:**
  - A Retry that fails stays failed, on screen and after reload.
  - A Retry never produces a "finished" book that is missing chapters, and no book reaches the confirm screen without its results saved.
  - While an analysis is running, Retry, Re-analyse and Include are greyed out with "Pause the analysis first", on every device; a device that did not know is told why instead of failing silently.
  - Stopping or a failure stops the analysis's model calls at once, so a halted run never keeps a local model busy.
  - A finished or confirmed book stays finished when a per-chapter Retry, Re-analyse or Include is interrupted; the chapter shows on its Generate-view row with Re-analyse, whatever its generation state, and a Re-analyse there saves normally.
  - Start fresh un-confirms the book, so it reads "Analysing" until the new run finishes and is confirmed again.
  - Rows say whether cast detection or speaker attribution failed.
  - A chapter with no text to narrate says so when you generate.
- **Technical:**
  - Two facts the code inferred are now explicit: which phase failed (`phase` on the record) and whether a chapter has a current take (`hasCurrentTake`: own key, not pending).
  - The main replay, the subset result gate and the library share one per-chapter predicate; the library and the book-state GET share one book-level predicate.
- **Architectural:**
  - Every job ending aborts the job's calls; a drain is bounded by the abort and by a 60 s safety deadline.
  - Main and subset jobs on one manuscript never write at the same time: the server refuses the second one, including while a paused or halted main run is still draining.
  - The rebuild from edits becomes an overlay that respects deleted sentences.

## Architectural impact

- **New seams:**
  - `ChapterErrorRecord.phase`; `normaliseFailureRecords`; `saveCacheInFailureCatch`;
  - `cache.pendingAttributionChapterIds`, `cache.takesPersisted`, `cache.confirmReached`, `hasCurrentTake`, `analysisCompleteFor`, `reachedConfirm`;
  - `mainWritersByManuscript`, `leaveWriters`, `MAIN_DRAIN_DEADLINE_MS`, `job.ended` / `halting` / `left` / `liveWork` / `watermark`, `PhaseWatermark.releaseAll`, `phase1Dispatch`, `job.reasoningOverflowPhase`, `job.failingPhase`;
  - the 409 bodies and SSE codes `main_analysis_running` / `subset_analysis_running`; the `resume_required` code; `selectMainAnalysisLive`;
  - book-state `analysis.stage1Ready` / `resumeRequired` / `unattributedChapterIds`; rebuild `mode`.
- **Behaviour deliberately changed (owner-confirmed, O3):** #3084 P20/N4 ("an overflow stops new spend, not work already in flight") is superseded on the main route by decision E, and its pinning test is rewritten in T3; a non-fresh Resume is refused while a stopped run drains; a confirmed book missing one chapter's analysis no longer reads "Analysing" in the library. Also: Start fresh clears `castConfirmed` (O1).
- **Invariants preserved:** the #3084 overflow halt with `fixes`; #3427's ordered cache writes (`writeJsonAtomicOrdered` / `enqueuePathOp`, `analysis-cache.ts:146-165`); the #2196 guarded snapshot writes; the voice-strip guard (`analysis-pill-gate.ts:15-21`, `active-analyses.ts:89`).
- **Migration:** lazy, on load (`normaliseFailureRecords`), no rewrite pass. `pendingAttributionChapterIds` absent means empty; `takesPersisted` absent means persisted; `confirmReached` absent falls back to `castConfirmed`. openapi gains one required field, three optional book-state fields, two refusal codes and one terminal code.
- **Reversibility (A15):** each task is its own commit and is green on its own, in order. Reverting is in **reverse order**: T3 can be reverted alone only before T4 lands, because T4 and T6 edit the `handleRetryChapter` catch/finally T3 reshapes, and T6's snapshot delete uses T3's ordered snapshot writes. The cache fields and `phase` are additive, so older builds ignore them.

## Invariants to preserve

1. **Cast-failure marker:** a cast failure writes `chapterCast[id] = []` (`analysis.ts:4717`, `:7376`), and a cast success sets the cast and clears the id synchronously (`:4759`, `:7322`).
2. **The main run's result** is reached only with every non-excluded chapter in `sentencesByChapter`: each is replayed (`:5262-5276`) or in `taskIndices` (`:5305-5309`), and any task failure is terminal (`:5850-5866`).
3. **The overflow terminal** carries `fixes`; the middleware's persistent overflow toast (`analysis-stream-middleware.ts`, the `HALTED_TYPE` hook) is unchanged.
4. **Cold boot** never surfaces a halted or paused pill for a cast-confirmed book (`src/lib/analysis-pill-gate.ts:15-21`).
5. **The interim-write lock contract** (#1981): interim cast.json writes go through `castBase.writeChecked` (`:4798`, `:5040`).
6. **A main run on a confirmed book keeps the cast's designed voice fields** (merge via `mergeAnalysisResultWithExistingCast`; pinned by a test in T6).

## Conventions for every task

- **Branch and worktree:** `node scripts/wt-new.mjs fix/server-failure-phase-markers` from the latest `origin/main`. Commits end with the attribution lines. The PR body says "Supersedes #3439" and "Closes #3435", and declares any incidental fix.
- **Server tests** run from `server/`, never against a live analyzer, never retried:
  - default config: `OLLAMA_URL=http://127.0.0.1:1 npx vitest run <files> --retry=0`
  - **slow files** (`server/vitest.config.slow.ts` `SLOW_FILES`, excluded from the default config, so naming them there finds no tests): `src/routes/generation.test.ts`, `src/routes/book-state.test.ts`, `src/routes/chapters-restructure.test.ts`, `src/routes/analysis-pipelining.test.ts` run as `OLLAMA_URL=http://127.0.0.1:1 npx vitest run --config vitest.config.slow.ts <files> --retry=0`.
- **Frontend tests** run from the repo root: `npx vitest run <files> --retry=0`.
- **Typecheck:** `npm run typecheck`. After any openapi edit: `npm run openapi:types`, then commit `src/lib/api-types.ts`.
- **TDD:** write each named test first, run it, and confirm it is **RED for the stated reason** before implementing. A test marked "control" or "—" is green before and after; it pins behaviour the task must not break.
- **Ported tests.** #3439's tests are ported **by name** from its head, 9a063ea6. If the commit is not in your clone: `git fetch origin pull/3439/head`. Then `git show 9a063ea6:server/src/routes/analysis.reasoning-overflow.test.ts` (and `src/views/analysing.test.tsx`). Copy the named `it(...)` body and its fixture helpers, then adapt the seeds to `phase`. **Do not port** `PA: …` or `PA collapse: …` (decision D4 withdrew "resolve on drop").
- **Ported code.** Nothing from #3439 is assumed to exist. The one helper this plan needs from it, `saveCacheInFailureCatch`, is written out in T2.
- **Mutation checks.** Each task ends with mutation checks, run **after the task is committed** (so restoring cannot lose work): apply the stated one-line edit, run the stated test, confirm it goes **red**, then `git checkout -- <file>` and confirm `git diff --quiet` before the next. A mutation that leaves the test green means the test does not pin the rule — fix the test, not the mutation.
- **Task greenness and order (A15).** Tasks land in order T1 → T7. Each names what it depends on; nothing in a task refers to a field or function a later task introduces. Every task leaves `npm run typecheck` and its verify commands green, and ships every new server frame or HTTP body together with its client handling.

## Tasks

### T1 — `phase` on the failure record (no behaviour change beyond tagging)

**Files:**
- `server/src/store/analysis-cache.ts` (`ChapterErrorRecord` `:64-68`, `loadAnalysisCache` `:119`)
- `server/src/routes/analysis.ts`: helpers next to `clearFailedChapterId` `:1397` / `recordFailedChapter` `:1415`; the four record sites `:4720` (cast, main), `:7379` (cast, subset), `:5728` (attribution, main), `:7701` (attribution, subset); the replay entry `:2684-2693` and recorder `:3054-3066`
- `openapi.yaml:8208-8220`, then `src/lib/api-types.ts` (generated)
- `src/lib/types.ts:524`
- `src/lib/api.ts`: `AnalysisStreamEvent` (`:2804`), the **main** parser (`:3013-3021`) and the **subset** parser (`:5730-5738`), and the `onChapterFailed` callback type

**Tests first** (records seeded **untagged**):

| Test | File | Expectation |
|---|---|---|
| `normalise: rule-2 residue {attribution-incomplete, cast [], take, no stage1} → cast` | `server/src/store/analysis-cache.test.ts` | RED: no `phase` field |
| `normalise: attribution-* with stage1 → attribution` | same | RED |
| `normalise: 06-05 shape (id, no record, non-empty cast) → attribution with synthesised unknown record` | same | RED |
| `normalise: dev-build untagged analyzer-timeout with a cast → attribution` | same | RED |
| `normalise: tagged record is never reclassified` | same | RED |
| `recordFailedChapter: attribution write onto a cast record is a no-op and returns the cast record` | `server/src/routes/analysis.test.ts` | RED |
| `chapter-failed frames carry phase: cast for a Phase-0 failure, attribution for a coverage re-flag` | same | RED |
| `cast-merge round trip keeps phase` | `server/src/routes/cast-merge.test.ts` | RED |
| `GET book-state returns phase on failedChapterErrors` | `server/src/routes/book-state.test.ts` (**slow**) | RED |
| `main stream parser passes phase to onChapterFailed` and `subset stream parser passes phase to onChapterFailed` | `src/lib/api-analysis-stream-errors.test.ts` | RED: both parsers copy fields explicitly and drop it |

**Implementation:**
1. Add the type field, `normaliseFailureRecords` (spec §2.1 rules 1–5) and call it in `loadAnalysisCache`.
2. Add the helpers; `recordFailedChapter` gains `phase` and returns the effective record (cast dominates).
3. Tag the four sites; each `send` uses the returned record.
4. Add `phase` to openapi, the replay entry, both client parsers and `AnalysisStreamEvent`; `npm run openapi:types`.
5. Confirm the mock API needs nothing: `git grep -n "chapter-failed\|failedChapterErrors" -- src/lib/api.ts src/mocks` shows only the two real parsers and the event-kind union.

**Verify:**
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/store/analysis-cache.test.ts src/routes/analysis.test.ts src/routes/cast-merge.test.ts --retry=0`
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run --config vitest.config.slow.ts src/routes/book-state.test.ts --retry=0`
- `npx vitest run src/lib/api-analysis-stream-errors.test.ts src/lib/api.test.ts src/lib/api-types.test.ts --retry=0`
- `npm run typecheck`

**Mutation checks:**
- In `normaliseFailureRecords`, swap rules 2 and 3 → `normalise: rule-2 residue … → cast` goes red.
- Delete `phase` from the subset parser's `onChapterFailed` call → `subset stream parser passes phase …` goes red.

**Accept:** every record and frame carries `phase`; nothing else behaves differently. Shippable.

### T2 — Overflow phase, dispatch split, main Phase-1 record **and clear**, guarded saves, labels

Moved here from the old T5 (plan check C12): the main Phase-1 **clear** (M8, clear iff `a`) ships with the main Phase-1 **record** (M10), as #3439 shipped them together. Without the clear, a resumed main run that re-attributes a chapter recorded by M10 would leave a stale row.

**Depends on:** T1 (`phase`).

**Files:** `server/src/routes/analysis.ts` — `noteReasoningOverflow` `:2453` and its seven callers (`:2510`, `:4688`, `:5525`, `:5858`, `:7375`, `:7604`, `:7646`); `runChapter` `:5390-5415` (dispatch); `runPhase1Pool` `:5837-5872`; the M8 site `:5728-5757`; the failure-catch saves `:4721`, `:7379-7380`; the terminal handlers `:6623`, `:8287`; `analyzerLabel` `:3744`, `:6991`; `phase1AnalyzerLabel` `:3813`, `:7023`.

**Step 1 — port `saveCacheInFailureCatch`** (written in full; it is not on `origin/main`). Put it next to `recordFailedChapter`:

```ts
/* #3435 — save the cache from INSIDE a per-chapter failure catch. That save can
   itself throw (ENOSPC, renameWithRetry exhausted); unguarded, its error replaces
   the one being handled (an overflow loses its code and fixes) and the
   chapter-failed that follows is never sent. Log it and carry on: the live
   chapter-failed and the original error still reach the user. */
async function saveCacheInFailureCatch(
  manuscriptId: string,
  cache: AnalysisCache,
  chapterId: number,
): Promise<void> {
  try {
    await saveAnalysisCache(manuscriptId, cache);
  } catch (saveErr) {
    console.warn(
      `[analysis] could not persist chapter ${chapterId}'s failure record (reporting the original failure)`,
      saveErr,
    );
  }
}
```

Use it at every save inside a failure catch: main Phase 0 (`:4721`), subset Phase 0 (the save after `:7379`), and the two new Phase-1 record sites below.

**Tests first** (`server/src/routes/analysis.reasoning-overflow.test.ts` unless named):

| Test | RED at `origin/main` because |
|---|---|
| **P-zeta:** pool width 1, ch1's escalation overflows; ch2 gets no `chapter-failed` and no record | — (control: guards step 3) |
| **A9 pipelined:** ch1's Phase-0 overflow rethrown at ch1's Phase-1 dispatch records nothing | — (control: guards step 3) |
| **P-gamma** (port `P-gamma: a main-route Phase-1 failure on a re-attributed chapter is recorded …`) | no main Phase-1 record |
| `a main resume that re-attributes an M10-recorded chapter clears its record and sends chapter-resolved` | no main Phase-1 clear |
| **MD:** a Pause during the main Phase 1 records nothing | — (control) |
| **MG:** with split models, the row and the terminal error name the Phase-1 model (port `with split phase models, a Phase-1 failure's terminal error names the Phase-1 model, not the Phase-0 one`, and add a main-route twin) | the terminal names Phase 0 |
| Sequential last-chapter escalation overflow: the terminal names the Phase-1 model | names Phase 0 |
| Pipelined Phase-0 overflow: the terminal names the Phase-0 model | — (control) |
| The overflow terminal names its chapter | "a chapter" |
| Save guards (port `a save that throws while recording a Phase-1 failure does not replace the real error or swallow chapter-failed`, `a save that throws while recording a Phase-0 failure still reports chapter-failed …`, `a save that throws in the Phase-0a failure catch keeps the original error and still sends chapter-failed`) | an unguarded save replaces the error |

**Implementation:**
1. Step 1 above.
2. `noteReasoningOverflow` gains `phase: 0 | 1`, stored as `job.reasoningOverflowPhase ??=`; pass it at the seven callers (spec §3.1: `:2510`→0, `:4688`→0, `:5525`→1, `:5858`→1, `:7375`→0, `:7604`→1, `:7646`→1).
3. Split `phase1Dispatch(i, isPoolAborted): Promise<'run' | 'skip'>` out of `runChapter` (spec §3.1 M11). In this task it skips on `phase0FailedCount > 0`, `signal.aborted` and the pool-local `aborted` (`:5843`), `job.ended`/`job.halting` checks and the `liveWork` token arrive in T3; recording `dispatchedOnFinalRoster` for M8c arrives in T5, with its reader. It runs outside the recording catch.
4. In the pool catch (`:5850`): keep `aborted = true` **before** any `await`; for a non-abort, `record(a)` with the chapter, `saveCacheInFailureCatch`, `chapter-failed` with the effective record, `job.failingPhase ??= 1`.
5. M8: at a Phase-1 completion, `clearFailedChapterId(cache, id, 'attribution')`; send `chapter-resolved` iff it cleared.
6. Hoist the Phase-1 label to function scope in both routes; the terminal label is the overflow phase's label, else `failingPhase === 1` → Phase-1 label, else `analyzerLabel`. Pass `{chapter}` for the overflow terminal.

**Verify:** `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/routes/analysis.reasoning-overflow.test.ts src/routes/analysis.phase-model.test.ts src/routes/analysis.test.ts --retry=0`, then `OLLAMA_URL=http://127.0.0.1:1 npx vitest run --config vitest.config.slow.ts src/routes/analysis-pipelining.test.ts --retry=0`, and `npm run typecheck`.

**Mutation checks** (after committing the task):
- Move the `phase1Dispatch` call back inside the recording `try` → **P-zeta** goes red.
- Delete step 5's clear → `a main resume that re-attributes an M10-recorded chapter clears …` goes red.
- Replace `saveCacheInFailureCatch` with a bare `saveAnalysisCache` in the pool catch → the Phase-1 save-guard test goes red.

**Accept:** a main Phase-1 failure is recorded, shown and cleared like any other; terminals name the right model. Shippable.

### T3 — Every ending aborts (decision E); refuse until drained (decision A)

**Depends on:** T2 (`phase1Dispatch`, the pool catch). **Later tasks depend on it:** T4 and T6 edit the `handleRetryChapter` catch/finally this task reshapes, and T6's subset-snapshot delete uses this task's ordered snapshot writes.

**Files:**
- `server/src/routes/analysis.ts`: `AnalysisJob` `:2706` (`ended`, `halting`, `left`, `liveWork`, optional `watermark`; initialised in the literals `:3567-3584`, `:6906-6924` and in `__testRegisterJobForTest` `:2792`); `nonStoryCall` `:2498` (job signal); the abort check before the main persist `:6188`; the cast join `:4884` (no Phase 0b after an early exit); the job maps `:2764-2770` and `activeAnalysisManuscripts` `:2800-2809`; `persistRunningSnapshot` `:2924-2962`; `endJob` `:3162-3337` (abort + `releaseAll` first; busy release `:3323` and evict `:3333-3337` move to `leaveWriters`); main POST `:3340` (early check before `:3391`, late check at `:3585`); the watermark at `:3836`; the cast pool `:4862-4884` and its catch `:4873`; Phase 0b; `phase1Dispatch` from T2; the Phase-1 pool `:5842-5872`; the N4 comments `:5838-5841`, `:5853-5857`; `/pause` `:6638-6662`; subset POST `:6677` (early check before `:6716`, late check at `:6925`)
- `server/src/analyzer/phase-watermark.ts` (`releaseAll` on the interface `:42` and both implementations `:65`, `:144`)
- `server/src/store/analysis-state.ts:101-131` (writes and delete onto the per-path op chain)
- `openapi.yaml` `:589-601` (both 409s)
- `src/lib/api.ts` `:2943-2966`, `:5649-5682`
- `src/store/analysis-slice.ts` (`selectMainAnalysisLive`)
- `src/store/analysis-stream-middleware.ts` (refusal codes close the handle, the `:279-282` shape)
- `src/views/analysing.tsx`: cold boot `:322-334`; the main effect's catch (A7: restore the snapshot set at `:509-525`); `handleRetryChapter` `:856-1131` (delete `pausedMainForRetry` `:879-885` and its `finally` resume `:1102-1131`); the row button `:1813-1826`; the panel subtext `:1778`; the pause-and-retry comment `:839-855`
- `src/views/generation.tsx`: `handleToggleExcluded` `:369`, `handleReanalyse` `:620`, catches `:517-566`, `:718-751`, the Re-analyse button `:1934`
- new `e2e/analysis-retry-refused-while-running.spec.ts`

**Tests first.** Server — new `server/src/routes/analysis.refuse-while-main.test.ts` (stub analyzer whose calls park until released or aborted):

| Test | RED at `origin/main` because |
|---|---|
| `a Phase-1 throw aborts the other in-flight chapter's call; that chapter is not cached and has no record` (E) | the call runs on and caches |
| **Item A-1:** `Pause between chapters ends aborted, no persist` — pause while no call is in flight (a worker between its save and its next dispatch); the run ends `aborted`, no stitch, no state.json, no `confirmReached` | `phase1Dispatch` skips the rest and the run persists a partial book |
| **Item A-2:** `pipelined Phase-1 throw with un-launched cast chapters writes no stage1` — a Phase-1 chapter throws while cast chapters are still queued; no stage1 or cast.json write from Phase 0b | the cast loop exits early and Phase 0b writes a partial stage1 |
| `a Pause during the fold / Phase-2 window ends aborted with no state.json write` (the abort check before `:6188`) | the persist has no abort check |
| `the non-story classifier call receives the job signal and aborts with the job` | `nonStoryCall` has no signal (`:2498`) |
| `endJob before the watermark exists (language_unset, :3767) does not throw` and `a hand-registered test job has ended/halting/left/liveWork initialised` | `job.watermark` undefined |
| `every main ending aborts the controller` — one case each: classified error, overflow, `cast_incomplete`, re-verify shrink refusal, `attribution_drift`, `aborted`, `result` (E) | only Pause aborts |
| `the halt's own error is the terminal even when a sibling's aborted call rejects first` | — (control: guards "no abort in the pool catch") |
| `no chapter starts between the halt decision and endJob` (the pool catch's guarded save is held open) (A5 gap 4) | a sibling starts one |
| `a parked Phase-1 worker woken by markPhase0ChapterComplete after the halt does not run` and `… woken by releaseAll does not run`; `every parked worker resolves after endJob` (A5 gaps 2–3, A10 leak) | they run / stay parked |
| `the liveWork token is taken before phase1Dispatch returns: endJob in the microtask after the dispatch await still sees liveWork 1` (A5 gap 1) | does not exist |
| `subset POST while a main job is registered → 409 main_analysis_running, draining:false, no subset job registered` | the subset starts |
| `subset POST after /pause while a chapter body is still in its save → 409 draining:true; after it settles and "main run drained" is logged → the subset starts` | starts at once |
| `the late check: a main job registering while the subset POST awaits getOrHydrateManuscript → SSE error frame main_analysis_running, no subset registered` (A4) | the subset registers |
| `main POST (start) while a subset is registered → 409 subset_analysis_running; the late check sends the same code as an SSE frame; a main POST that joins a live main is never refused` | main starts |
| `a non-fresh main start while a previous main drains → 409 main_analysis_running draining:true; fresh:true still displaces` (extension, §0) | starts beside it |
| `drain deadline: a unit that ignores the abort is dropped after MAIN_DRAIN_DEADLINE_MS with the deadline log; busy is released once` (fake timers) | held for ever |
| `busy is released exactly once whether the job leaves from endJob, from a unit's finally, or from the deadline` (A9) | — |
| `"Design full cast" busy is held until the main run leaves` | released at `endJob` |
| `activeAnalysisManuscripts includes a draining manuscript` (upgrade gate, A9) | aborted jobs excluded |
| `/pause on a manuscript whose main job is draining aborts nothing new, writes no snapshot, and does not reset the deadline` | — |
| `a running snapshot whose dir resolves after endJob is not written` (A6: the check is inside the queued op) | the stale running snapshot lands after the delete |
| `writeAnalysisState then deleteAnalysisState called back to back land in call order` (`src/store/analysis-state.test.ts`) | unordered |
| `control: a Retry when no main job exists runs exactly as today` | — |

Rewrite, do not delete: `analysis.reasoning-overflow.test.ts:314` (`after a stage-2 overflow in chapter 2, chapter 1 (already calling the model) finishes and caches …`) pins #3084 N4, which decision E supersedes. It becomes `after a stage-2 overflow in chapter 2, chapter 1's in-flight call is aborted, chapter 1 is not cached, no escalation window starts, and the halted snapshot keeps its code`; rename the describe at `:288` to "a reasoning overflow stops new spend and aborts work in flight (#3084 P20, #3435 decision E)". `:751` (`main: overflow in chapter 1 escalation while chapter 2 in flight …`) asserts no caching and stays green — check it.

`src/routes/analysis.rejoin-miss.test.ts` and `src/routes/analysis.snapshot-detach.test.ts` register jobs through `__testRegisterJobForTest` (`:2792`), which must also enter main jobs in the writer registry; both files stay green.

Server unit: `phase-watermark.test.ts` gains `releaseAll resolves every waiter on both implementations`.

Frontend:

| Test | File | RED because |
|---|---|---|
| `Retry is disabled with "Pause the analysis first" while the main stream is live, and enabled once paused` | `src/views/analysing.test.tsx` | enabled |
| `Retry is disabled while selectMainAnalysisLive is true for a snapshot another device produced` | same | enabled |
| `a 409 main_analysis_running keeps the row, shows the server message on it and restores the prior snapshot` — once for the HTTP form, once for the SSE-frame form | same | the generic branch drops the row |
| A7: `a main POST refused with subset_analysis_running restores the pre-POST snapshot, so this device's Retry is not greyed out` | same | `selectMainAnalysisLive` stays true |
| C9: `cold boot with a running SUBSET snapshot does not POST the main route` | same | it POSTs `/analysis` |
| `Re-analyse and Include are disabled with "Pause the analysis first" while main is live` | `src/views/generation.test.tsx` | enabled |
| `a 409 on Include rolls the include back and shows the message on the row; on Re-analyse shows it on the row` | same | generic text |
| `realRunAnalysisForChapters maps a 409 main_analysis_running body to AnalysisError(message, code)`; `realAnalyseManuscript maps 409 subset_analysis_running and main_analysis_running`; `the same codes as SSE error frames map to the same AnalysisError` | `src/lib/api-analysis-stream-errors.test.ts` | `ANALYSIS_STREAM_FAILED` |
| `the middleware closes its handle on a refusal code without halting or toasting, re-reads getAnalysisState and restores the snapshot from it (or clears it on null); it never dispatches setPaused` | `src/store/analysis-stream-middleware.test.ts` | it halts and toasts; the stale running snapshot stays |
| `selectMainAnalysisLive` table (other manuscript / subset kind / paused / running main) | `src/store/analysis-slice.test.ts` | does not exist |

**Replace, do not delete without replacement:** these `analysing.test.tsx` tests pin the client pause-and-retry that decision A withdraws — `clicking Retry while the main run is streaming aborts the main run, runs the subset alone, then resumes the main run on settle` (`:1354`), `#3215 C2 — a subset_in_progress rejection does not re-arm the paused main run` (`:1440`), `overflow on a Retry that paused a running main run does NOT re-POST the main run` (`:1810`), `cast_incomplete after a successful Retry drops the row, re-POSTs the main run, and does not halt` (`:1837`), `stage1_shrink_refused on a Retry reaches the Accept-smaller-roster banner via the resumed main run` (`:1858`). Each is rewritten for a Retry with main **not** running, keeping its non-pause assertion; the first is replaced by the "disabled while live" test.

E2E — `e2e/analysis-retry-refused-while-running.spec.ts` (chromium, mock mode). It crosses the redux → component seam, which jsdom can misreport. `window.__store__` exposes only the store (`src/main.tsx:57`), so dispatch **raw** actions:
1. Open `#/books/sb/generate`. Read `getState().manuscript.manuscriptId`; mock fixtures carry `manuscriptId: ''` (`src/mocks/canned-data.ts:74`), so if it is empty, seed one with `{ type: 'manuscript/uploadComplete', payload: { manuscriptId: 'mns_e2e_3435', title, format, wordCount, sourceText } }` built from the current `manuscript` state (A16).
2. Dispatch `{ type: 'analysis/setActiveStream', payload: { manuscriptId, kind: 'main', state: 'running', … } }`.
3. Expand chapter 1's row; assert `chapter-row-1-reanalyse` is disabled and "Pause the analysis first" is visible.
4. Dispatch `{ type: 'analysis/setPaused', payload: { manuscriptId } }`; assert the control is enabled.

**What the e2e cannot show:** mock mode has no server, so no 409, no drain, no abort and no second device. Those are the route and unit tests above, plus on-box item 1.

**Implementation:** spec §2.4 in full; the §3.1 M10/M12 rows; §3.3 snapshot row; the §3.4 rows for api, openapi, selector, middleware, cold boot, Analysing Retry and main catch, Generate view; §4 copy. Delete `pausedMainForRetry` and everything only it used. Correct every comment the change makes false: the pause-and-retry comment `:839-855`, the panel subtext `:1778`, and the N4 comments `:5838-5841`, `:5853-5857`.

**Verify** (widened: this task changes `endJob` and every job's lifecycle, which every analysis, design, busy and upgrade test can observe):
- the new and directly-touched files first, at `--retry=0`: `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/routes/analysis.refuse-while-main.test.ts src/routes/analysis.reasoning-overflow.test.ts src/analyzer/phase-watermark.test.ts src/store/analysis-state.test.ts --retry=0`
- then the **full** server suites: `OLLAMA_URL=http://127.0.0.1:1 npm run test:server` and `OLLAMA_URL=http://127.0.0.1:1 npm run test:server-slow` (from the repo root)
- the **full** frontend suite: `npm run test`
- `npx playwright test e2e/analysis-retry-refused-while-running.spec.ts --project=chromium`
- `npm run typecheck`

**Mutation checks** (after committing the task):
- Remove the `controller.abort()` from `endJob` → `a Phase-1 throw aborts the other in-flight chapter's call …` goes red.
- Make the subset refusal test `inFlightAnalysisByManuscript` instead of the writer registry → `subset POST after /pause while a chapter body is still in its save → 409 draining:true …` goes red.
- Move the `liveWork` increment after `phase1Dispatch` returns → the A5-gap-1 test goes red.
- Drop the pool-local `aborted` check from `phase1Dispatch` → the `markPhase0ChapterComplete` wake test goes red.
- Remove the `job.left` guard → `busy is released exactly once …` goes red.
- Move the `job.ended` check in `persistRunningSnapshot` back before the dir resolution → the A6 test goes red.
- Drop the `kind !== 'subset'` guard in the cold-boot effect → the C9 test goes red.
- Make `phase1Dispatch` return `'skip'` on `signal.aborted` → **Item A-1** goes red.
- Remove the early return before Phase 0b → **Item A-2** goes red.
- Remove the abort check before the main persist → the fold/Phase-2-window Pause test goes red.

**Accept:** no model call outlives its run; a main and a subset job never write one book at once; busy and VRAM are released within the deadline; the UI explains every refusal. Shippable.

### T4 — Fact-1 consumers that need no pending set; subset Phase-1 recording; soft cast stops; panel by phase

**Depends on:** T1 (`phase`), T2 (the subset terminal label), T3 (the reshaped `handleRetryChapter`).

M3 (resume re-queues only cast failures) and the auto-resume change are **not** here: both must ship with the pending set (T5, T6), or a resumed run would replay a collapsed take that decision (i) says to re-attribute (plan check C12).

**Files:** `server/src/routes/analysis.ts` — `isPhase0aCoverageComplete` `:1451-1463`; M4 `:4759`; S3/S4 `:7322-7329`; the subset gate `:7422`, `:7491-7505`; S6 `:7458-7469`; the subset Phase-1 catch `:7640-7647` and completion `:7701-7719`. Client: `src/store/analysis-stream-middleware.ts`, `src/lib/analysis-phase-state.ts`, `src/views/analysing.tsx` (rows `:1764-1828`, synthesised row `:810-811`), `src/views/generation.tsx` (`cast_incomplete`), `src/components/analysing/phase-card.tsx` (needs-action line), `src/components/top-bar.tsx` (pill copy).

**Tests first.** Server (`analysis.reasoning-overflow.test.ts`, `analysis.test.ts`):

| Test | RED at `origin/main` because |
|---|---|
| #3435 base (port `a Phase-1 timeout sends chapter-failed (no chapter-resolved), and the chapter stays in failedChapterIds`, `a Phase-1 unreachable analyzer is recorded and reported the same way`, `a Phase-1 reasoning overflow still ends the run with its code AND now survives a reload`, `control: a clean Retry clears the record and sends chapter-resolved only`) | the subset records nothing on a Phase-1 throw |
| **P3**, **P2**, **PB** (port by those names) | the gate counts attribution records as cast failures |
| **P-theta, pre-existing half:** Retry and Re-analyse on a book with a narration-only chapter (`[]` cast, no record) reach Phase 1 | the coverage check reads `[]` as missing |
| `isPhase0aCoverageComplete` takes `castFailedIds`; "`[]` without a cast record is covered" | old signature |
| **S5, stage1 absent:** the gate exit ends `cast_incomplete` naming the chapters | silent `endJob(job)` |
| **S5, stage1 existed:** the target's cast failed again → terminal `error` with its classified code | silent end |
| **S6** ends via `endJob(error cast_incomplete)` | mid-stream `send` + silent end |
| `a cast-phase failure fixed by Phase 0 is NOT cleared or announced when its Phase 1 then fails (stage1 on disk)` and `… is cleared and announced once its Phase 1 succeeds` (port) | Phase 0 clears every record |
| Port 747c7e42's `beforeAll` hang fix if the ported block needs it | — |

Frontend (`src/views/analysing.test.tsx`, `src/store/analysis-stream-middleware.test.ts`, `src/views/generation.test.tsx`, `src/components/analysing/phase-card.test.tsx`, `src/components/top-bar.test.tsx`, `src/lib/analysis-phase-state.test.ts`):

| Test | RED because |
|---|---|
| A subset `cast_incomplete` gives needs-action with no toast | it toasts |
| A8: `a Retry ending in a subset cast_incomplete keeps the halted snapshot; the needs-action line reads its haltReason` (the `finally` must not `clearActiveStream()`, `:1130`; this is a view test, not a middleware test) | the `finally` clears it |
| Port `a Phase-1 failure on Retry (chapter-resolved, chapter-failed, error analyzer-timeout) keeps the row with its message`, `a Retry that ends without a result and with no chapter-resolved keeps the row`, `control: a Retry that resolved the chapter then ends without a result drops the row and raises nothing` | the generic branch drops the row |
| Heading and subtext per phase (cast / attribution / mixed), stage1-present copy | one "cast detection" heading |
| A synthesised row inherits its phase | no phase |
| The needs-action line shows `haltReason` for a not-a-failure code | icon only |
| The pill shows `haltReason` for a subset in needs-action | "Retrying N chapters" |
| Generate view: `cast_incomplete` shows the server message and rolls back | generic text |

**Implementation:** spec §2.1 consumers except M3; S1–S7, S9–S11 of §3.2; §3.4 rows for the needs-action line, pill, row phase, Generate `cast_incomplete`, and the `retryNeedsActionRef` part of the Analysing Retry row (A8; T6 adds `resume_required` to it); §4 row copy.

**Verify:**
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/routes/analysis.reasoning-overflow.test.ts src/routes/analysis.test.ts src/routes/analysis.merge-base-detect.test.ts src/routes/analysis.phase-model.test.ts --retry=0`
- `npx vitest run src/views/analysing.test.tsx src/store/analysis-stream-middleware.test.ts src/views/generation.test.tsx src/components/analysing/phase-card.test.tsx src/components/top-bar.test.tsx src/lib/analysis-phase-state.test.ts --retry=0`
- `npm run typecheck`

**Mutation checks** (after committing the task):
- Remove the `retryNeedsActionRef` early return from the Retry `finally` → the A8 test goes red.
- In the subset gate, count every failed id again (drop the `'cast'` filter) → **P3** goes red.
- Make S4's clear unconditional (clear `a` too) → the "NOT cleared … when its Phase 1 then fails" port goes red.

**Accept:** the #3435 symptom is fixed (record kept, row kept), and no red toast appears for soft frames. Shippable.

### T5 — Current take: pending set and its writers, predicates, overlay, word-free, library, generation copy

**Depends on:** T1 (`phase`), T2 (M8's clear and `phase1Dispatch`, where this task records `dispatchedOnFinalRoster = phase1Stage1Ready`), T4 (phase-aware consumers that M3 builds on).

**Files:**
- `server/src/store/analysis-cache.ts` (fields incl. `confirmReached`, whitelist `:129-140`, `hasCurrentTake`, `analysisCompleteFor`, `reachedConfirm`)
- `server/src/store/analysis-cache-rebuild.ts:32-54`; its callers `generation.ts:1020`, `chapter-splice.ts:249`, `chapter-qa-repair.ts:403`, `chapters-restructure.ts:186` (`'replace'`)
- `server/src/routes/analysis.ts`: M0/M1 at `:4063`; M3 `:4434-4440`; replay `:5262-5276`; M8/M8c/M9 `:5728-5757`; the roll `:5766-5779`; S0 at `:7160`; S9/S10 `:7701-7719`; word-free short-circuit in both Phase-1 call paths; `takesPersisted = true` and `confirmReached = true` after `:6545` and `:8237`, only when the block's `catch (persistErr)` (`:6517`, `:8217`) was not entered; the drift messages `:6556-6560`, `:8241-8245`
- `server/src/workspace/scan.ts:789-816` (status rule with `reachedConfirm`, decision F)
- `server/src/routes/generation.ts:1394-1403` (decision C copy)
- the Start fresh branch `analysis.ts:4015-4062` (O1: write `castConfirmed: false`); `remainingNonCachedChars` `:5198-5208` (use `hasCurrentTake`); the M8d pass between the join `:5882` and the stitch `:5906`; the `wroteStateJson` flag after `:6514` / `:8214`

**Tests first:**

| Test | File | RED because |
|---|---|---|
| `hasCurrentTake` table: non-empty; `[]` (worded or word-free, decision B); pending; no key | `analysis-cache.test.ts` | does not exist |
| `analysisCompleteFor` table: missing stage1; a pending chapter; `takesPersisted:false`; `takesPersisted` absent (legacy) | same | does not exist |
| Overlay: keeps a `[]` key and an excluded chapter; a carried chapter replaces wholesale, so a tombstoned sentence stays gone; an absent non-excluded non-empty chapter is removed; P, records and `takesPersisted` untouched | `analysis-cache-rebuild.test.ts` | replace semantics drop the `[]` key |
| `a Generate POST keeps a [] key` | `generation.test.ts` (**slow**) | key dropped |
| Decision C: `a [] take with no record fails with "This chapter has no text to narrate — exclude it to finish the book."`; `a [] take with a record fails with "Speaker attribution found no lines in this chapter. Re-analyse it, or exclude it."`; `no key keeps the "analysis cache is incomplete" copy` | same | one copy for all three |
| M1: `with no stage1, every failed chapter with a key — including [] — enters P at load` (C4) | `analysis.test.ts` | no P |
| M8c: `pipelined: a chapter dispatched before Phase 0b while its cast record stands goes into P, not out` | `analysis-pipelining.test.ts` (**slow**) | no P |
| **Decision H (A3), loops under the v2 rule:** `stage1 on disk, X = {cast record, no take}: a main Resume attributes X, sends result and persists; X is current; a second main run replays X without an analyzer call for it, and the library reads cast_pending` | `analysis.test.ts` | under the v2 rule X goes into P every run, so the second run re-attributes it and the library reads analysing (the loop) |
| **PE** and PE-negative (port `PE: with no stage1, an attribution-flagged chapter with a cast is not re-queued into cast detection but IS re-attributed …` and `PE negative: …`) | `analysis.reasoning-overflow.test.ts` | re-queued into cast; replayed |
| **PD-main** (port, changed assertion): ch1's `cast` record clears at Phase-0a success; ch1 stays in P; a Phase-1 throw re-records `attribution` | same | no P |
| **P-alpha** and its reverse interleaving (port `P-alpha: …`, `the other interleaving: …`) | same | the cast record is lost |
| Decision B: `a worded chapter whose attribution returns [] is replayed as done on the next main run, keeps its flagged row, and the run sends result` | `analysis.test.ts` | `[]` is re-attributed every run (C3 loop) |
| A pending chapter's take survives the main roll and a rebuild | `analysis.test.ts` | dropped from edits |
| Word-free short-circuit: no analyzer call, no flag, every bookkeeping step runs | same | flagged `noSentences` |
| M0 heals a legacy word-free `attribution-incomplete` record | same | record kept |
| `takesPersisted` / `confirmReached`: false / absent after a Phase-1 completion; both true after a persist block that wrote state.json; still false after `attribution_drift` (whose `try` completes with state.json skipped), after a post-join overflow, and after a persist block that swallowed the state.json error | same | fields absent |
| **M8d:** `pipelined: a chapter dispatched before Phase 0b while its re-cast was queued, whose re-cast then succeeds, is re-attributed after the join; the result carries the second take and the chapter is not in P` | `analysis-pipelining.test.ts` (**slow**) | the pending take is stitched and persisted, and the persisted book has a chapter in P |
| **O1:** `Start fresh on a castConfirmed book writes castConfirmed:false; the library reads analysing until the new run persists and the book is confirmed again` | `analysis.test.ts` + `scan.test.ts` | castConfirmed stays true |
| `the ETA counts a pending chapter as remaining` | `analysis.test.ts` | it is skipped as cached |
| `overlay rebuild with an edits file that has no sentences keeps stage1, P, records and both flags; replace mode still clears` | `analysis-cache-rebuild.test.ts` | the whole cache is cleared |
| Finished-book main run replays a flagged chapter that has a take (port `a FINISHED book (stage1 on disk): a main run replays a flagged chapter cached sentences instead of re-attributing it`) | `analysis.reasoning-overflow.test.ts` | — (control) |
| `scan` (book not yet at Confirm): a pending chapter reads analysing; a flagged chapter with a take reads analysed; a worded `[]` reads analysed; `takesPersisted:false` reads analysing; no stage1 reads analysing | `scan.test.ts` | own-key count |
| Decision F, `scan`: `a castConfirmed book with takesPersisted:false and a chapter without a take keeps voices_pending / generating / complete`; `a book with confirmReached and castConfirmed false keeps cast_pending`; `a legacy book with neither field reads as before` | same | today's `:815` demotes the confirmed book to analysing |

**Implementation:** spec §2.2 (all of it), §3.1 M0–M3, M8, M8c, M9, M13, M16, M17, §3.2 S0, S9, S10, and the decision-C row of §3.3.

**Verify:**
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/store/analysis-cache-rebuild.test.ts src/store/analysis-cache.test.ts src/workspace/scan.test.ts src/routes/analysis.test.ts src/routes/analysis.reasoning-overflow.test.ts src/routes/analysis.phase-model.test.ts src/routes/chapter-splice.test.ts src/routes/chapter-qa-repair.test.ts --retry=0`
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run --config vitest.config.slow.ts src/routes/generation.test.ts src/routes/chapters-restructure.test.ts src/routes/analysis-pipelining.test.ts src/routes/book-state.test.ts --retry=0`
- `npm run typecheck`

**Mutation checks** (after committing the task):
- In `hasCurrentTake`, drop the pending clause → `scan: a pending chapter reads analysing` and **PE** go red.
- In M1, add only non-empty takes to P (the v3 rule) → `… including [] — enters P at load` goes red.
- In M8c, remove the chapter from P instead of adding it → the M8c pipelining test goes red.
- In `analysisCompleteFor`, drop the `takesPersisted` clause → `scan: takesPersisted:false reads analysing` goes red.
- In the scan status rule, drop the `!reachedConfirm` guard → `a castConfirmed book … keeps voices_pending …` goes red.
- Make M8c ignore `dispatchedOnFinalRoster` (the v2 rule) → the decision-H test goes red.
- Remove the M8d pass → the M8d test goes red.
- Set the flags when the persist `try` completes instead of after the state.json write → the drift case goes red.
- Drop the `castConfirmed: false` write from Start fresh → the O1 test goes red.
- Restore `cached.length > 0` in the replay → the decision-B test goes red.

**Accept:** one per-chapter predicate in three places, one book-level predicate in the library; decisions (i), B, F and H hold; no take is deleted. Shippable.

### T6 — Subset result gate, `resume_required`, and the client that surfaces it

**Depends on:** T3 (ordered snapshot writes, the reshaped Retry handler), T4 (`retryNeedsActionRef`), T5 (`hasCurrentTake`, `analysisCompleteFor`, `reachedConfirm`).

**Files:**
- `server/src/routes/analysis.ts`: S8 `:7513-7520`; S14a (aborted after the loop, `:7989`, `:8249`); S14 before the stitch `:7763` through the persist `:7989-8237` and result `:8249`; `endJob` `:3162` (subset-kind snapshot delete in one op)
- `server/src/routes/book-state.ts:321-326`, `:637` (`stage1Ready`, `resumeRequired`, `unattributedChapterIds`)
- O2: the S14 gate reads `reachedConfirm` at subset load; `src/components/layout.tsx:829`, `:878` (carry the analysis gaps into the chapters slice); `src/store/chapters-slice.ts` (`analysisGapById`); the Generate row actions `src/views/generation.tsx:1878-1939`
- `openapi.yaml`: `AnalyseErrorEvent` codes `:5634-5636`; book-state `analysis` `:8201-8220`
- `src/lib/analysis-phase-state.ts:11-13`; `src/lib/types.ts:524`; `src/store/analysis-stream-middleware.ts`; `src/views/analysing.tsx` (hydrate effect `:780-823`, auto-resume `:832-837`, `castIncomplete` `:234`/`:709`, label `:1393-1397`, shrink `:498`/`:1743`, rows `:1764-1828`); `src/views/generation.tsx` (`:517-566`, `:718-751`, row analysis note next to `:1934`)

**Tests first.** Server:

| Test | File | RED because |
|---|---|---|
| **P-delta**: `resume_required` naming ch3; no state.json or authoritative cast.json write; the interim roll is present | `analysis.reasoning-overflow.test.ts` | `result` |
| **P-eta**: `resume_required` while ch1 is pending; a main resume then sends `result` | same | `result` |
| **P-beta (server)**: S8 sends `resume_required` | same | silent end |
| Finished-book Retry sends `result`, sets `takesPersisted`, and deletes a `subset`-kind snapshot but not a `main`-kind one | `analysis.test.ts` | the snapshot stays |
| A18 (S14a): `a Pause that lands after the subset loop ends the job aborted, with no persist and no result` | same | `result` is sent without a persist |
| Decision F: `an interrupted Re-analyse on a castConfirmed book (S11) leaves the library status unchanged and lists the chapter in unattributedChapterIds or failedChapterErrors` | same + `book-state.test.ts` (**slow**) | — |
| **O2:** `on a castConfirmed book with another chapter lacking a current take, a Re-analyse of ch2 sends result and persists (state.json, cast.json, edits); the other chapter stays in unattributedChapterIds` | `analysis.test.ts` | `resume_required`, nothing persisted |
| O2 control: `on a book that has not reached Confirm, the same Retry still ends resume_required` | same | — |
| Hint snapshot: a mid-run Exclude is ignored by S14 | same | live hints read |
| Main run on a confirmed book keeps designed voice fields (invariant 6) | `analysis.test.ts` | — (control) |
| `GET book-state: stage1Ready, resumeRequired, unattributedChapterIds` (no stage1 / pending / complete / reached Confirm → resumeRequired false). Amended (PR #3505 gate pass 1): past Confirm, a chapter whose sentences are in manuscript-edits.json (pending included) is omitted unless it has a failure record | `book-state.test.ts` (**slow**) | fields absent |

Frontend:

| Test | File | RED because |
|---|---|---|
| **P-beta (view)**: armed `cast_incomplete` + `resume_required` → main POST | `analysing.test.tsx` | — |
| Unarmed `resume_required`: needs-action line, "Resume analysis", no POST | same | — |
| C18: `a confirmed book whose book-state says resumeRequired shows the rows, "Resume analysis" and the needs-action line with no snapshot` | same | "Start analysis", no line |
| C20: `castIncomplete is armed on mount from a halted subset cast_incomplete snapshot only when the mount-time stage1Ready is false; the copy follows the latest stage1Ready` | same | excludes `kind:'subset'`; client flag picks copy |
| C-8: `after S8, the refreshed stage1Ready:true does not disarm the auto-resume` (P-beta still POSTs main) and `castIncomplete is never armed by a refresh` | same | — |
| A8: `a Retry ending resume_required keeps the halted snapshot; the needs-action line reads its haltReason` | same | the `finally` clears it |
| A10: `with stage1Ready false, an attribution row has no Retry and reads "Attributed when you resume the analysis."; a cast row keeps Retry` | same | Retry shown, copy promises a re-run |
| Decision F / O2: `Generate view shows "Analysis didn't finish for this chapter." and a Re-analyse control for a chapter in analysisGapById — on a queued row and on a generation-failed row with an errorReason, which have no Re-analyse today (:1878)`; `a Re-analyse result clears the gap; a failure sets it` | `generation.test.tsx` | no note, no control |
| `the layout's book-state hydrate carries unattributedChapterIds and failedChapterErrors into analysisGapById` | `src/components/layout.test.tsx` | not carried |
| `analysisGapById` set / clear reducers | `src/store/chapters-slice.test.ts` | do not exist |
| Analysing subset shrink: Accept re-runs the subset with `allowStage1Shrink`; main re-entry does not clear a subset shrink banner | same | — |
| Generate view: no Include rollback on `resume_required`; inline "Accept smaller cast" for a shrink | `generation.test.tsx` | rollback; no action |
| `isNotAFailureHaltCode('resume_required')` | `analysis-phase-state.test.ts` | false |

**Implementation:** spec §3.2 S8, S14a, S14; the subset-snapshot part of §3.3's snapshot row; §3.4 rows for book-state, refresh policy, `castIncomplete` arming, attribution rows while `stage1Ready` is false, label, auto-resume, shrink, Generate `resume_required` and unfinished chapters past Confirm; the confirmed-books paragraph; §4.

**E2E (crosses the layout hydrate → chapters slice → Generate row seam):** add a second test to `e2e/analysis-retry-refused-while-running.spec.ts`: on `#/books/sb/generate`, dispatch the raw chapters action that sets `analysisGapById` for chapter 1 (and mark it queued, as `e2e/generate-disabled-while-analysing.spec.ts` does), expand the row, and assert the analysis note and an enabled `chapter-row-1-reanalyse`. Add the spec to this task's verify.

**Fixtures:** update every test that seeds stage1 with a chapter lacking a current take and asserts `result` or a persist (e.g. `C2 — subset route computes maxMergedTurnsInParagraph over every non-excluded chapter …`, `analysis.test.ts:4173`, which seeds `chapters: {}` at `:4228-4232` and retries only ch2: seed ch1's take).

**Verify:**
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/routes/analysis.reasoning-overflow.test.ts src/routes/analysis.test.ts src/routes/analysis.request-log.test.ts src/routes/analysis.setup-throw.test.ts src/routes/analysis.persist-lock-timeout.test.ts src/routes/analysis.merge-base-detect.test.ts src/routes/analysis.phase-model.test.ts src/routes/analysis.rejoin-miss.test.ts src/routes/analysis.snapshot-detach.test.ts src/store/analysis-state.test.ts src/workspace/scan.test.ts --retry=0`
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run --config vitest.config.slow.ts src/routes/book-state.test.ts --retry=0`
- `npx vitest run src/views/analysing.test.tsx src/views/generation.test.tsx src/store/analysis-stream-middleware.test.ts src/lib/analysis-phase-state.test.ts src/lib/analysis-pill-gate.test.ts src/components/layout.test.tsx src/store/chapters-slice.test.ts --retry=0`
- `npx playwright test e2e/analysis-retry-refused-while-running.spec.ts --project=chromium`
- `npm run typecheck`

**Mutation checks** (after committing the task):
- Make S14 check only `toRun` (skip the other chapters) → **P-delta** goes red.
- Remove S14a → the A18 test goes red.
- Arm `castIncomplete` from every book-state refresh → `castIncomplete is never armed by a refresh` goes red.
- Return `resumeRequired` without the `!reachedConfirm` clause → the book-state "reached Confirm → resumeRequired false" case goes red.
- Drop the `reachedConfirm` relaxation from S14 → the O2 test goes red.
- Render the Generate-view Re-analyse only for `done` rows again → the queued / generation-failed row test goes red.

**Accept:** a subset run never sends or persists a `result` for an unfinished book, and an unfinished book says so after any reload. Shippable.

### T7 — Docs, acceptance bookkeeping and follow-ups

**Release notes, `RELEASE_NOTES.md`:**

> A chapter whose Retry fails now stays marked as failed, even after a reload. A Retry no longer reports a book as finished while other chapters still need attribution — it asks you to resume the analysis instead. While an analysis is running, Retry, Re-analyse and Include wait for you to pause it first. When an analysis stops — paused or halted by an error — it stops its model work straight away. A finished book stays finished if a single-chapter re-analysis is interrupted; that chapter shows on its row with Re-analyse, and a re-analysis there saves even while another chapter is still unfinished. Start fresh now un-confirms the cast, so the book shows as analysing until you confirm it again. A chapter with no text to narrate now says so when you generate.

**Release notes, `docs/release-notes-next.md`** (under "🗣️ Analyzer, script review & manuscript"):

> Failure rows now say whether cast detection or speaker attribution failed (#3435, PR <new>).
>
> A per-chapter Retry, Re-analyse or Include no longer sends a result while another chapter has no current take; it ends with "resume the analysis to finish the book" (#3435).
>
> Retry, Re-analyse and Include are disabled while a main analysis runs, and the server refuses them with a 409 until the paused or halted run has finished its in-flight chapters (#3435). A main start is likewise refused while a chapter retry runs.
>
> Every analysis job ending — Pause, an error, an overflow, a quota stop — now aborts its in-flight model calls; in-flight chapters are left for the next Resume or Retry. This supersedes #3084 P20/N4 ("in-flight work finishes") on the main route. A 60 s drain deadline guarantees the analysis-busy flag and the Ollama pin are released (#3435).
>
> A non-fresh Resume while a stopped run is still draining is refused for a moment ("still stopping") (#3435).
>
> A Pause between chapters, or after attribution, now ends the run `aborted` with nothing persisted; it no longer stitches and saves a partial book. A halted pipelined run no longer finalises a partial cast (#3435).
>
> Start fresh clears `castConfirmed`, as Re-parse does (#3435). On a book past Confirm, a per-chapter Re-analyse persists even while another chapter lacks a current take, and every unfinished chapter's Generate-view row offers Re-analyse (#3435).
>
> A book that has not yet reached Confirm reads "Analysing" until its results are saved after the last attributed chapter; a run that halted after attribution (overflow, attribution drift, a save failure) no longer lands on the confirm screen. A book that has reached Confirm is never sent back to "Analysing" — including a confirmed book with a chapter missing its analysis, which today's library demotes (#3435).
>
> Chapters with no narratable text no longer show a failure row; generation says "This chapter has no text to narrate — exclude it to finish the book." (#3435).
>
> If you edit speakers in a chapter that is waiting to be re-attributed, re-attribution replaces those edits (#3435).
>
> Soft analysis stops (cast detection pending, resume required) show a "needs action" note instead of a red error (#3435).

**Other T7 steps:**
- **Reviewer catalogue** (`.claude/skills/pr-review-gate/references/reviewer-brief.md`): port entries #17 and #18 from 9a063ea6 (`git show 9a063ea6:.claude/skills/pr-review-gate/references/reviewer-brief.md`). Add "a sentinel that is also a valid value" and "a flag read as 'phase N finished' that is written before phase N".
- **On-box register** (Before-shipping step 3): add the three rows under "On-box acceptance owed" to `docs/testing/onbox-acceptance-register.md`, update the live view `docs/testing/onbox-acceptance-register-live-view.html`, run `npm run register:build` and `npm run check:onbox-register`, and publish per the register's own "Live view" procedure.
- **#3436:** post a comment re-scoping it (spec §2.6).
- **#3084:** comment that decision E supersedes P20/N4 on the main route, linking the rewritten test.
- **#3436:** include the full writer list (spec §2.6), including the exclude toggle an Include calls before its subset POST (A17).
- **#3437:** comment that a non-fresh Resume during a drain is now refused (spec §2.4) and that Start fresh displacement stays its scope.
- **File follow-ups** (each its own issue, labelled per CONTRIBUTING.md):
  - restructure does not remap chapter-keyed analysis state (records, `chapterCast`, P);
  - **decision C:** a better treatment for included chapters with no narratable text (auto-exclude at analysis, or skip at generation and count the chapter complete). This PR only changes the generation copy.
- **Close #3439** with a pointer to the new PR.
- `docs/features/INDEX.md`: keep the 287 entry current.

## Test plan

### Automated coverage

Listed per task above. **The full gate before shipping:**
- `npm run test:server` **and** `npm run test:server-slow` (the slow config holds `generation.test.ts`, `book-state.test.ts`, `chapters-restructure.test.ts` and `analysis-pipelining.test.ts`);
- every analysis-route file once more at `--retry=0` with `OLLAMA_URL=http://127.0.0.1:1`;
- `npm run test`; `npm run typecheck`; `npm run lint`;
- `npm run test:e2e` (includes the new spec);
- #3430's four write-site guards: `server/src/workspace/cast-lock.guard.test.ts`, `server/src/workspace/state-language.guard.test.ts`, `server/src/store/cast-id-history.stamp.guard.test.ts`, `server/src/routes/analysis.edits-routing.guard.test.ts`;
- `npm run verify:fast:branch`.

The per-task mutation checks are the mutant battery; there is no out-of-repo mutant list to re-point.

### Manual acceptance walkthrough

**Mock mode (`npm run dev:mock`) can show only the client side**: it has no server, so no 409, no drain, no `resume_required`, no S14 gate, and no real failure rows. Walkthrough 1 is mock; 2–4 need `npm run dev` against a real server and a test book (the canonical fixture `server/src/__fixtures__/the-coalfall-commission.md`), with the analyzer pointed at a model you can stop or a deliberately small context to force failures.

1. **(mock) Disabled while running.** Open `#/books/sb/generate`. In the browser console, seed a manuscript id if it is empty and dispatch a raw `analysis/setActiveStream` running main snapshot through `window.__store__` (the e2e spec's steps 1–2). Re-analyse and Include are disabled and read "Pause the analysis first"; dispatch `setPaused` and they come back.
2. **(real) A Retry that fails stays failed.** Open a book with an attribution row on the Analysing view (`#/books/<id>/analysing`). Stop the analyzer, Retry. The row stays, labelled "Speaker attribution". Reload; it is still there.
3. **(real) Refused while running, then allowed.** Start an analysis; during Phase 1 the Retry buttons are disabled. Pause. Click Retry at once: either it runs, or the row says the analysis is still stopping; a few seconds later Retry runs. On a second browser that never saw the run start, Retry during the run shows the server's message on the row.
4. **(real) An unfinished book asks to resume.** In sequential mode (so stage1 is written before attribution), halt a main run part-way through attribution. Retry a failed row. (In pipelined mode a halt during Phase 0 leaves no stage1, and the attribution rows instead read "Attributed when you resume the analysis." with no Retry — check that too.) The phase card shows "… still need attribution — resume the analysis to finish the book", no red toast. Reload: the line and "Resume analysis" are still there. Resume; the run finishes and routes to Confirm.
5. **(real) A done book stays done.** On a generated book, Re-analyse one chapter and stop the analyzer mid-run. The library still shows the book as generated; the Generate view row shows the failure with Re-analyse. Start the analyzer and click it: the chapter re-analyses and saves, even if another chapter is still unfinished.
6. **(real) Start fresh un-confirms.** On a confirmed book, Start fresh: the library shows "Analysing" until the run finishes and you confirm again.
7. **(real) Past-Confirm edits rule.** On a confirmed book with a sample or handoff-less chapter (no cache take, sentences present in manuscript-edits.json), the Generate view shows no unfinished row for it; a chapter with a failure record still does.
8. **(real) Retry result routing.** A Retry that returns a `result` on a castConfirmed book stays on the Analysing view (no jump to Confirm); the same Retry on an unconfirmed book routes to Confirm like a main result.

### On-box acceptance owed

Recorded in `docs/testing/onbox-acceptance-register.md` by T7:

1. **Abort and drain on a local Ollama analyzer.** (a) Pipelined run, Pause mid-Phase 1, click Retry immediately: refused with the draining message. (b) Same, but force a halt instead (stop the model mid-Phase 1 so one chapter throws). In both, observe in the server log `[analysis] main run drained manuscript=<id>` **before** `[analysis-subset] start manuscript=<id>`, no cache or edits write from the main job after the drained line, no `drain deadline exceeded` line, and `ollama ps` showing the model released after the drain. Note each drain's duration.
2. **A Resume on a cast-confirmed book with designed voices** (invariant 6; the 2026-07-14 voice-strip incident class). After the run, every designed voice field is intact in cast.json.
3. **The background emotion re-run yields to and is aborted by real work on a real analyzer** (B106; #3435). Open a book whose `state.json` has `prosodyAnnotated: false` and confirm the "Detecting emotions" re-run starts. Mid-run, (a) start an analysis, then separately (b) switch to another book, then separately (c) queue a chapter render. In all three, the server log shows the prosody requests for that book stop (no further prosody calls for it) and `state.json` still has `prosodyAnnotated: false`; in (c) Generate is never disabled and the pill clears. Reopen the book and confirm the run resumes. Then reload the app mid-run and reopen the book: the run starts again (it marked the book `false` as it started). Cover: the open-time trigger re-runs only an explicit `false`, never an unset watermark (pinned in mock mode by `e2e/prosody-rerun-on-open.spec.ts`; the real-analyzer abort is only provable on the box).

## Out of scope

- The #3436 residual writers (spec §2.6).
- #3437: Start fresh displacement stragglers.
- Restructure remapping (follow-up issue).
- A better treatment for chapters with no narratable text beyond the copy (decision C follow-up).

## Implementation notes

Deviations and rulings made during the build (recorded in the run ledger as "Ruling:" lines):

- **`phase1Dispatch` throws on abort, in T2.** The preflight ruling had T2 skip on `signal.aborted` and T3 convert it to a throw; the ledger reversed that. T2 throws `AnalysisAbortedError` on `signal.aborted` and T3's Item A-1 test ("Pause between chapters ends aborted, no persist") moved into T2, because the skip let a Pause between chapters end as success with a partial persist, a regression against `main`. The plan's own T2 and T3 task text is stale on this point.
- **Subset Phase-1 recording (S11)** landed in T4, whose title names it, not T2.
- **T3 regressions** (rename-midrun and the H1 guard 14 vs 13) were branch regressions and were fixed in T3, not deferred; the `user-settings` ollama-url failure is an artifact of the mandated `OLLAMA_URL` env.
- **T3 mutation 4** is unpinnable by construction (halting set in the same sync block as the pool-local aborted flag); it was replaced with "drop both the halting/ended and pool-local checks", which turns the `markPhase0ChapterComplete` wake test red.
- **`restoreFromServer` staleness (T3 minor 4)** is a defect: it had no staleness re-check after its awaits and could overwrite a newer subset snapshot, so it was fixed in the same round.
- **T4 same-round fixes:** the `cast_incomplete` copy no longer says "Retry below" on the Generate view, the title list in that message is bounded, and the stage-1-existed plus non-target blocking-chapter branch and "S3/S4 never clear an attribution record at Phase 0" are now pinned. The main route's `phase0FailedCount` stop first kept "Retry below"; the final review changed it to the same `castIncompleteMessage(titles)` copy, because its message becomes the top-bar pill's `haltReason` on every view.
- **G3 guard bump 2 → 3** is the guard's documented maintenance (census re-measured), not a swallow.
- **T5 → T6:** the subset persist set its flags before S14 as an interim; T6 moved flag-setting inside S14's pass branch and asserts `confirmReached` absent and `takesPersisted` false on the `resume_required` path.
- **Incidental fix #3503:** Start fresh now verifies the book folder before deleting analysis files (found in T5, fixed in a510d8f9).
- **T6 `castIncomplete` mount-arming (b)** is kept per the spec's arming row, but a `castIncomplete` armed on mount does not auto-resume after a reload (`analysisStarted` unset): the user clicks Resume once. The double POST that arming exposed was fixed. Arming (b) has no observable consumer, and neither it nor its mount-read keying is tested; whether to drop it or make it imply `analysisStarted` is an owner question. Because it is inert, the plan's T6 mutation "arm `castIncomplete` from every refresh" is no longer pinned by any test.
- **T5 regression fixed in passing (b4486856):** a stale `vi.mock` of `analysis-cache.js` in `analysis.stage2-estimate-label` lacked `hasCurrentTake`; it now passes the real module through via `importOriginal`.
- **D1 copy placement:** the refused main-start message started under the Start button (T3); T4 moved it onto the needs-action line, as the spec wants.
- **A15 ("each task green on its own") did not hold at two task tips:** the T2 tip (527c4d8f) failed `analysis.rename-midrun` and the H1 guard, and the T5 tip (e800d319) failed `analysis.stage2-estimate-label`. Both were fixed in later commits (T3, and b4486856 respectively); the branch tip is green.
- **Past-Confirm edits rule (e2dc611b; documented after PR #3505 gate pass 1).** For a book that has reached Confirm, `unattributedChapterIds` omits any active chapter whose sentences are present in manuscript-edits.json (edits are what generation renders from; it rebuilds the cache from them on every Generate request), including a pending (P) chapter. A chapter with a failure record keeps its gap regardless. Before Confirm the list is unchanged. Owner-reversible. Owner question: should a pending (P) take on a book past Confirm show as unfinished? Today it does not (S0 sample takes are curated; an M8c pending take on a confirmed book is reachable only by deep-linking to the Analysing view).
- **Retry `result` routing.** A Retry `result` on a castConfirmed book stays on the Analysing view (does not route to Confirm); on an unconfirmed book it routes to Confirm like a main result (PR #3505 gate pass 1).

## Ship notes

(Filled in when status flips to `stable`.)
