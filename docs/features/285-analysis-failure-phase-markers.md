---
status: draft
shipped: null
owner: null
---

# 285 — Analysis failure bookkeeping: explicit phase and completeness markers (#3435)

> Status: draft. The design was approved by the owner on 2026-10-03, and revised the same day with owner decisions A–C after plan check 1. Supersedes PR #3439.
>
> **Line numbers** in this plan are on **`origin/main` at 6f01fa20** (2026-10-03), like the spec. Each one names a symbol or the code at that line; if `origin/main` has moved, re-derive the line from the symbol before editing. Nothing is cited from #3439's head.
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
> OpenAPI ops: `GET /api/books/{bookId}` (`analysis.failedChapterErrors[].phase`, `analysis.stage1Ready`, `analysis.resumeRequired`); `POST /api/manuscripts/{id}/analysis` and `…/analysis/chapters` (new 409 bodies, the `resume_required` terminal code, `phase` on `chapter-failed`).

- **Design:** [2026-10-03-analysis-failure-phase-markers-design.md](../superpowers/specs/2026-10-03-analysis-failure-phase-markers-design.md). Section numbers below (§, M-rules, S-rules, decisions A–C, D1, D4, D5) refer to it.

## Benefit / Rationale

- **User:**
  - A Retry that fails stays failed, on screen and after reload.
  - A Retry never produces a "finished" book that is missing chapters, and no book reaches the confirm screen without its results saved.
  - While an analysis is running, Retry, Re-analyse and Include are greyed out with "Pause the analysis first", on every device; a device that did not know is told why instead of failing silently.
  - Rows say whether cast detection or speaker attribution failed.
  - A chapter with no text to narrate says so when you generate.
- **Technical:**
  - Two facts the code inferred are now explicit: which phase failed (`phase` on the record) and whether a chapter has a current take (`hasCurrentTake`: own key, not pending).
  - The main replay, the subset result gate and the library share one per-chapter predicate; the library and the book-state GET share one book-level predicate.
- **Architectural:**
  - Main and subset jobs on one manuscript never write at the same time: the server refuses the second one, including while a paused or halted main run is still draining.
  - The rebuild from edits becomes an overlay that respects deleted sentences.

## Architectural impact

- **New seams:**
  - `ChapterErrorRecord.phase`; `normaliseFailureRecords`; `saveCacheInFailureCatch`;
  - `cache.pendingAttributionChapterIds`, `cache.takesPersisted`, `hasCurrentTake`, `analysisCompleteFor`;
  - `mainWritersByManuscript`, `job.ended`, `job.liveWork`, `trackWork`, `phase1Dispatch`, `job.reasoningOverflowPhase`, `job.failingPhase`;
  - the 409 bodies `main_analysis_running` / `subset_analysis_running`; the `resume_required` code; `selectMainAnalysisLive`;
  - book-state `analysis.stage1Ready` / `analysis.resumeRequired`; rebuild `mode`.
- **Invariants preserved:** the #3084 overflow halt with `fixes`; #3427's ordered cache writes (`writeJsonAtomicOrdered` / `enqueuePathOp`, `analysis-cache.ts:146-165`); the #2196 guarded snapshot writes; the voice-strip guard (`analysis-pill-gate.ts:15-21`, `active-analyses.ts:89`).
- **Migration:** lazy, on load (`normaliseFailureRecords`), no rewrite pass. `pendingAttributionChapterIds` absent means empty; `takesPersisted` absent means persisted. openapi gains one required field, two optional book-state fields, two 409 bodies and one terminal code.
- **Reversibility:** each task is its own commit. T3 (refusal) can be reverted alone; the client's old pause-and-retry comes back with it. The cache fields and `phase` are additive, so older builds ignore them.

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
- **Mutation checks.** Each task ends with mutation checks: apply the stated one-line edit, run the stated test, confirm it goes **red**, then `git checkout -- <file>` and confirm `git diff --quiet -- <file>` before the next. A mutation that leaves the test green means the test does not pin the rule — fix the test, not the mutation.
- **Task greenness.** Every task leaves `npm run typecheck` and its verify commands green, and ships every new server frame or HTTP body together with its client handling.

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
3. Split `phase1Dispatch(i): Promise<'run' | 'skip'>` out of `runChapter` (spec §3.1 M11, including the `job.ended || signal.aborted` → `'skip'` check). It runs outside the recording catch.
4. In the pool catch (`:5850`): for a non-abort, `record(a)` with the chapter, `saveCacheInFailureCatch`, `chapter-failed` with the effective record, `job.failingPhase ??= 1`.
5. M8: at a Phase-1 completion, `clearFailedChapterId(cache, id, 'attribution')`; send `chapter-resolved` iff it cleared.
6. Hoist the Phase-1 label to function scope in both routes; the terminal label is the overflow phase's label, else `failingPhase === 1` → Phase-1 label, else `analyzerLabel`. Pass `{chapter}` for the overflow terminal.

**Verify:** `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/routes/analysis.reasoning-overflow.test.ts src/routes/analysis.phase-model.test.ts src/routes/analysis.test.ts --retry=0`, then `OLLAMA_URL=http://127.0.0.1:1 npx vitest run --config vitest.config.slow.ts src/routes/analysis-pipelining.test.ts --retry=0`, and `npm run typecheck`.

**Mutation checks:**
- Move the `phase1Dispatch` call back inside the recording `try` → **P-zeta** goes red.
- Delete step 5's clear → `a main resume that re-attributes an M10-recorded chapter clears …` goes red.
- Replace `saveCacheInFailureCatch` with a bare `saveAnalysisCache` in the pool catch → the Phase-1 save-guard test goes red.

**Accept:** a main Phase-1 failure is recorded, shown and cleared like any other; terminals name the right model. Shippable.

### T3 — Refuse until paused (decision A)

**Files:**
- `server/src/routes/analysis.ts`: the job maps `:2764-2770`; `AnalysisJob` `:2706`; `endJob` `:3162-3337` (`job.ended`, the main-job busy release `:3323` and evict `:3333-3337` move to drain completion); main POST `:3340` (refusal before `res.flushHeaders()` `:3391`; registration `:3585`); subset POST `:6677` (refusal before `:6716`); `runPhase0Pool` `:4855-4884` and Phase 0b (stop on `job.ended`); the Phase-1 body from T2 (`trackWork`); `persistRunningSnapshot` `:2924` (return if `job.ended`)
- `openapi.yaml` `:589-601` (both 409s)
- `src/lib/api.ts` `:2943-2966`, `:5649-5682`
- `src/store/analysis-slice.ts` (`selectMainAnalysisLive`)
- `src/store/analysis-stream-middleware.ts` (refusal codes close the handle, `:279-282` shape)
- `src/views/analysing.tsx`: cold boot `:322-334`; `handleRetryChapter` `:856-1131` (delete `pausedMainForRetry` `:879-885` and its `finally` resume `:1102-1131`); the row button `:1813-1826` and panel subtext `:1778`
- `src/views/generation.tsx`: `handleToggleExcluded` `:369`, `handleReanalyse` `:620`, catches `:517-566`, `:718-751`, the Re-analyse button `:1934`
- new `e2e/analysis-retry-refused-while-running.spec.ts`

**Tests first.** Server — new `server/src/routes/analysis.refuse-while-main.test.ts` (stub analyzer with a controllable in-flight call):

| Test | RED at `origin/main` because |
|---|---|
| `subset POST while a main job is registered → 409 main_analysis_running, draining:false, no subset job registered` | the subset starts |
| `subset POST after /pause while a Phase-1 chapter is still saving → 409 draining:true; after that save lands and the drained log line prints → the subset starts` | the subset starts at once |
| `subset POST after a main halt (M10 throw) while another in-flight chapter is still running → 409 draining:true` | starts at once |
| `a Phase-1 worker parked in awaitPhase1Dispatch does not hold the drain: pause during Phase 0 (sequential), subset POST succeeds once the cast calls abort` (the C1 case) | — (control: guards the tracking rule) |
| `a halted pipelined run starts no further cast chapter and skips Phase 0b` | the Phase-0 arm keeps going |
| `main POST (start) while a subset is registered → 409 subset_analysis_running; a main POST that joins a live main is never refused` | main starts |
| `"Design full cast" busy is held until the main run drains` | released at `endJob` |
| `persistRunningSnapshot writes nothing after endJob` | it writes |
| `control: a Retry when no main job exists runs exactly as today` | — |

Server, existing files: `src/routes/analysis.rejoin-miss.test.ts` and `src/routes/analysis.snapshot-detach.test.ts` stay green (they register jobs by hand through `__testRegisterJobForTest`, which must also register main jobs as writers).

Frontend:

| Test | File | RED because |
|---|---|---|
| `Retry is disabled with "Pause the analysis first" while the main stream is live, and enabled once paused` | `src/views/analysing.test.tsx` | Retry is enabled |
| `Retry is disabled while selectMainAnalysisLive is true for a snapshot another device produced` | same | enabled |
| `a 409 main_analysis_running keeps the row, shows the server message on it and restores the prior snapshot` | same | the generic branch drops the row |
| `cold boot with a running SUBSET snapshot does not POST the main route` (C9) | same | it POSTs `/analysis` |
| `Re-analyse and Include are disabled with "Pause the analysis first" while main is live` | `src/views/generation.test.tsx` | enabled |
| `a 409 on Include rolls the include back and shows the message on the row; on Re-analyse shows it on the row` | same | generic failure text |
| `realRunAnalysisForChapters maps a 409 main_analysis_running body to AnalysisError(message, code)`; `realAnalyseManuscript maps 409 subset_analysis_running` | `src/lib/api-analysis-stream-errors.test.ts` | `ANALYSIS_STREAM_FAILED` |
| `the middleware closes its handle on a refusal code without halting or toasting` | `src/store/analysis-stream-middleware.test.ts` | it halts and toasts |
| `selectMainAnalysisLive` table (other manuscript / subset kind / paused / running main) | `src/store/analysis-slice.test.ts` | does not exist |

**Replace, do not delete without replacement:** these `analysing.test.tsx` tests pin the client pause-and-retry that decision A withdraws — `clicking Retry while the main run is streaming aborts the main run, runs the subset alone, then resumes the main run on settle` (`:1354`), `#3215 C2 — a subset_in_progress rejection does not re-arm the paused main run` (`:1440`), `overflow on a Retry that paused a running main run does NOT re-POST the main run` (`:1810`), `cast_incomplete after a successful Retry drops the row, re-POSTs the main run, and does not halt` (`:1837`), `stage1_shrink_refused on a Retry reaches the Accept-smaller-roster banner via the resumed main run` (`:1858`). Each is rewritten for a Retry with main **not** running (the only Retry that now exists), keeping its non-pause assertion; the first is replaced by the "disabled while live" test above.

E2E — `e2e/analysis-retry-refused-while-running.spec.ts` (chromium, mock mode). It crosses the redux → component seam, which jsdom can misreport:
1. Open `#/books/sb/generate`; read the `sb` manuscript id from `window.__store__.getState()`.
2. Dispatch `analysisActions.setActiveStream({ manuscriptId, kind: 'main', state: 'running', … })` through `window.__store__` (the pattern in `e2e/generate-disabled-while-analysing.spec.ts`).
3. Expand chapter 1's row; assert `chapter-row-1-reanalyse` is disabled and "Pause the analysis first" is visible.
4. Dispatch `analysisActions.setPaused({ manuscriptId })`; assert the control is enabled.

**What the e2e cannot show:** mock mode has no server, so no 409, no drain and no second device. Those are the route and unit tests above, plus on-box item 1.

**Implementation:** spec §2.4 (registry, `trackWork`, drain, Phase-0 arm stop, busy/evict at drain, both refusals) and the §3.4 rows for api, openapi, selector, middleware, cold boot, Analysing Retry, Generate view, and the copy in §4. Delete `pausedMainForRetry` and everything only it used; fix the comments that described pause-and-retry (`analysing.tsx:839-855`, the panel subtext `:1778`) — a comment the change made false is part of the change.

**Verify:**
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/routes/analysis.refuse-while-main.test.ts src/routes/analysis.test.ts src/routes/analysis.reasoning-overflow.test.ts src/routes/analysis.rejoin-miss.test.ts src/routes/analysis.snapshot-detach.test.ts src/routes/analysis.request-log.test.ts src/routes/analysis.setup-throw.test.ts --retry=0`
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run --config vitest.config.slow.ts src/routes/analysis-pipelining.test.ts src/routes/book-state.test.ts --retry=0` (book-state: the rename-busy guard reads the busy flag)
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/routes/book-state.rename-analysis-busy.test.ts --retry=0`
- `npx vitest run src/views/analysing.test.tsx src/views/generation.test.tsx src/store/analysis-stream-middleware.test.ts src/store/analysis-slice.test.ts src/lib/api-analysis-stream-errors.test.ts src/components/layout.test.tsx src/components/top-bar.test.tsx --retry=0`
- `npx playwright test e2e/analysis-retry-refused-while-running.spec.ts --project=chromium`
- `npm run typecheck`

**Mutation checks:**
- Make the subset refusal test `inFlightAnalysisByManuscript` instead of the writer registry → `subset POST after /pause while a Phase-1 chapter is still saving → 409 draining:true …` goes red.
- Increment `liveWork` before `awaitPhase1Dispatch` instead of after → the C1 control test hangs (it has a 10 s test timeout; a timeout is the red).
- Remove `!job.ended` from `launchNextCast`'s loop → `a halted pipelined run starts no further cast chapter …` goes red.
- Drop the `kind !== 'subset'` guard in the cold-boot effect → the C9 test goes red.

**Accept:** a main and a subset job never write one book at once; the UI explains every refusal. Shippable.

### T4 — Fact-1 consumers that need no pending set; subset Phase-1 recording; soft cast stops; panel by phase

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
| Port `a Phase-1 failure on Retry (chapter-resolved, chapter-failed, error analyzer-timeout) keeps the row with its message`, `a Retry that ends without a result and with no chapter-resolved keeps the row`, `control: a Retry that resolved the chapter then ends without a result drops the row and raises nothing` | the generic branch drops the row |
| Heading and subtext per phase (cast / attribution / mixed), stage1-present copy | one "cast detection" heading |
| A synthesised row inherits its phase | no phase |
| The needs-action line shows `haltReason` for a not-a-failure code | icon only |
| The pill shows `haltReason` for a subset in needs-action | "Retrying N chapters" |
| Generate view: `cast_incomplete` shows the server message and rolls back | generic text |

**Implementation:** spec §2.1 consumers except M3; S1–S7, S9–S11 of §3.2; §3.4 rows for the needs-action line, pill, row phase, Generate `cast_incomplete`; §4 row copy.

**Verify:**
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/routes/analysis.reasoning-overflow.test.ts src/routes/analysis.test.ts src/routes/analysis.merge-base-detect.test.ts src/routes/analysis.phase-model.test.ts --retry=0`
- `npx vitest run src/views/analysing.test.tsx src/store/analysis-stream-middleware.test.ts src/views/generation.test.tsx src/components/analysing/phase-card.test.tsx src/components/top-bar.test.tsx src/lib/analysis-phase-state.test.ts --retry=0`
- `npm run typecheck`

**Mutation checks:**
- In the subset gate, count every failed id again (drop the `'cast'` filter) → **P3** goes red.
- Make S4's clear unconditional (clear `a` too) → the "NOT cleared … when its Phase 1 then fails" port goes red.

**Accept:** the #3435 symptom is fixed (record kept, row kept), and no red toast appears for soft frames. Shippable.

### T5 — Current take: pending set and its writers, predicates, overlay, word-free, library, generation copy

**Files:**
- `server/src/store/analysis-cache.ts` (fields, whitelist `:129-140`, `hasCurrentTake`, `analysisCompleteFor`)
- `server/src/store/analysis-cache-rebuild.ts:32-54`; its callers `generation.ts:1020`, `chapter-splice.ts:249`, `chapter-qa-repair.ts:403`, `chapters-restructure.ts:186` (`'replace'`)
- `server/src/routes/analysis.ts`: M0/M1 at `:4063`; M3 `:4434-4440`; replay `:5262-5276`; M8/M8c/M9 `:5728-5757`; the roll `:5766-5779`; S0 at `:7160`; S9/S10 `:7701-7719`; word-free short-circuit in both Phase-1 call paths; `takesPersisted = true` after `:6545` and `:8237`; the drift messages `:6556-6560`, `:8241-8245`
- `server/src/workspace/scan.ts:789-801`
- `server/src/routes/generation.ts:1394-1403` (decision C copy)

**Tests first:**

| Test | File | RED because |
|---|---|---|
| `hasCurrentTake` table: non-empty; `[]` (worded or word-free, decision B); pending; no key | `analysis-cache.test.ts` | does not exist |
| `analysisCompleteFor` table: missing stage1; a pending chapter; `takesPersisted:false`; `takesPersisted` absent (legacy) | same | does not exist |
| Overlay: keeps a `[]` key and an excluded chapter; a carried chapter replaces wholesale, so a tombstoned sentence stays gone; an absent non-excluded non-empty chapter is removed; P, records and `takesPersisted` untouched | `analysis-cache-rebuild.test.ts` | replace semantics drop the `[]` key |
| `a Generate POST keeps a [] key` | `generation.test.ts` (**slow**) | key dropped |
| Decision C: `a [] take with no record fails with "This chapter has no text to narrate — exclude it to finish the book."`; `a [] take with a record fails with "Speaker attribution found no lines in this chapter. Re-analyse it, or exclude it."`; `no key keeps the "analysis cache is incomplete" copy` | same | one copy for all three |
| M1: `with no stage1, every failed chapter with a key — including [] — enters P at load` (C4) | `analysis.test.ts` | no P |
| M8c: `pipelined: a chapter attributed while its cast record stands goes into P, not out` | `analysis-pipelining.test.ts` (**slow**) | no P |
| **PE** and PE-negative (port `PE: with no stage1, an attribution-flagged chapter with a cast is not re-queued into cast detection but IS re-attributed …` and `PE negative: …`) | `analysis.reasoning-overflow.test.ts` | re-queued into cast; replayed |
| **PD-main** (port, changed assertion): ch1's `cast` record clears at Phase-0a success; ch1 stays in P; a Phase-1 throw re-records `attribution` | same | no P |
| **P-alpha** and its reverse interleaving (port `P-alpha: …`, `the other interleaving: …`) | same | the cast record is lost |
| Decision B: `a worded chapter whose attribution returns [] is replayed as done on the next main run, keeps its flagged row, and the run sends result` | `analysis.test.ts` | `[]` is re-attributed every run (C3 loop) |
| A pending chapter's take survives the main roll and a rebuild | `analysis.test.ts` | dropped from edits |
| Word-free short-circuit: no analyzer call, no flag, every bookkeeping step runs | same | flagged `noSentences` |
| M0 heals a legacy word-free `attribution-incomplete` record | same | record kept |
| `takesPersisted`: false after a Phase-1 completion; true after the persist block; still false after `attribution_drift` and after a post-join overflow | same | field absent |
| Finished-book main run replays a flagged chapter that has a take (port `a FINISHED book (stage1 on disk): a main run replays a flagged chapter cached sentences instead of re-attributing it`) | `analysis.reasoning-overflow.test.ts` | — (control) |
| `scan`: a pending chapter reads analysing; a flagged chapter with a take reads analysed; a worded `[]` reads analysed; `takesPersisted:false` reads analysing; no stage1 reads analysing | `scan.test.ts` | own-key count |

**Implementation:** spec §2.2 (all of it), §3.1 M0–M3, M8, M8c, M9, M13, M16, M17, §3.2 S0, S9, S10, and the decision-C row of §3.3.

**Verify:**
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/store/analysis-cache-rebuild.test.ts src/store/analysis-cache.test.ts src/workspace/scan.test.ts src/routes/analysis.test.ts src/routes/analysis.reasoning-overflow.test.ts src/routes/analysis.phase-model.test.ts src/routes/chapter-splice.test.ts src/routes/chapter-qa-repair.test.ts --retry=0`
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run --config vitest.config.slow.ts src/routes/generation.test.ts src/routes/chapters-restructure.test.ts src/routes/analysis-pipelining.test.ts src/routes/book-state.test.ts --retry=0`
- `npm run typecheck`

**Mutation checks:**
- In `hasCurrentTake`, drop the pending clause → `scan: a pending chapter reads analysing` and **PE** go red.
- In M1, add only non-empty takes to P (the v3 rule) → `… including [] — enters P at load` goes red.
- In M8c, remove the chapter from P instead of adding it → the M8c pipelining test goes red.
- In `analysisCompleteFor`, drop the `takesPersisted` clause → `scan: takesPersisted:false reads analysing` goes red.
- Restore `cached.length > 0` in the replay → the decision-B test goes red.

**Accept:** one per-chapter predicate in three places, one book-level predicate in the library; decision (i) and decision B hold; no take is deleted. Shippable.

### T6 — Subset result gate, `resume_required`, and the client that surfaces it

**Files:**
- `server/src/routes/analysis.ts`: S8 `:7513-7520`; S14 before the stitch `:7763` through the persist `:7989-8237` and result `:8249`; `endJob` `:3162`
- `server/src/store/analysis-state.ts:101-131` (ordered writes; read-check-delete in one op)
- `server/src/routes/book-state.ts:321-326`, `:637` (`stage1Ready`, `resumeRequired`)
- `openapi.yaml`: `AnalyseErrorEvent` codes `:5634-5636`; book-state `analysis` `:8201-8220`
- `src/lib/analysis-phase-state.ts:11-13`; `src/lib/types.ts:524`; `src/store/analysis-stream-middleware.ts`; `src/views/analysing.tsx` (auto-resume `:832-837`, `castIncomplete` `:234`/`:709`, label `:1393-1397`, shrink `:498`/`:1743`); `src/views/generation.tsx` (`:517-566`, `:718-751`)

**Tests first.** Server:

| Test | File | RED because |
|---|---|---|
| **P-delta**: `resume_required` naming ch3; no state.json or authoritative cast.json write; the interim roll is present | `analysis.reasoning-overflow.test.ts` | `result` |
| **P-eta**: `resume_required` while ch1 is pending; a main resume then sends `result` | same | `result` |
| **P-beta (server)**: S8 sends `resume_required` | same | silent end |
| Finished-book Retry sends `result`, sets `takesPersisted`, and deletes a `subset`-kind snapshot but not a `main`-kind one | `analysis.test.ts` | the snapshot stays |
| Hint snapshot: a mid-run Exclude is ignored by S14 | same | live hints read |
| Main run on a confirmed book keeps designed voice fields (invariant 6) | `analysis.test.ts` | — (control) |
| `writeAnalysisState` then `deleteAnalysisState` called back to back land in call order | `src/store/analysis-state.test.ts` | unordered |
| `GET book-state: stage1Ready and resumeRequired` (no stage1 / pending / complete) | `book-state.test.ts` (**slow**) | fields absent |

Frontend:

| Test | File | RED because |
|---|---|---|
| **P-beta (view)**: armed `cast_incomplete` + `resume_required` → main POST | `analysing.test.tsx` | — |
| Unarmed `resume_required`: needs-action line, "Resume analysis", no POST | same | — |
| C18: `a confirmed book whose book-state says resumeRequired shows the rows, "Resume analysis" and the needs-action line with no snapshot` | same | "Start analysis", no line |
| C20: `castIncomplete rehydrates from a halted subset cast_incomplete snapshot only when stage1Ready is false; the copy follows stage1Ready` | same | excludes `kind:'subset'`; client flag picks copy |
| `the auto-resume does not fire when stage1Ready is true` | same | it fires |
| Analysing subset shrink: Accept re-runs the subset with `allowStage1Shrink`; main re-entry does not clear a subset shrink banner | same | — |
| Generate view: no Include rollback on `resume_required`; inline "Accept smaller cast" for a shrink | `generation.test.tsx` | rollback; no action |
| `isNotAFailureHaltCode('resume_required')` | `analysis-phase-state.test.ts` | false |

**Implementation:** spec §3.2 S8, S14; §3.3 snapshot row (C19); §3.4 rows for book-state, `castIncomplete`, label, auto-resume, shrink, Generate `resume_required`; §4.

**Fixtures:** update every test that seeds stage1 with a chapter lacking a current take and asserts `result` or a persist (e.g. `C2 — subset route computes maxMergedTurnsInParagraph over every non-excluded chapter …`, `analysis.test.ts:4173`, which seeds `chapters: {}` at `:4228-4232` and retries only ch2: seed ch1's take).

**Verify:**
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/routes/analysis.reasoning-overflow.test.ts src/routes/analysis.test.ts src/routes/analysis.request-log.test.ts src/routes/analysis.setup-throw.test.ts src/routes/analysis.persist-lock-timeout.test.ts src/routes/analysis.merge-base-detect.test.ts src/routes/analysis.phase-model.test.ts src/routes/analysis.rejoin-miss.test.ts src/routes/analysis.snapshot-detach.test.ts src/store/analysis-state.test.ts --retry=0`
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run --config vitest.config.slow.ts src/routes/book-state.test.ts --retry=0`
- `npx vitest run src/views/analysing.test.tsx src/views/generation.test.tsx src/store/analysis-stream-middleware.test.ts src/lib/analysis-phase-state.test.ts src/lib/analysis-pill-gate.test.ts src/components/layout.test.tsx --retry=0`
- `npm run typecheck`

**Mutation checks:**
- Make S14 check only `toRun` (skip the other chapters) → **P-delta** goes red.
- Swap `writeJsonAtomicOrdered` back to `writeJsonAtomic` in `writeAnalysisState` → the ordering test goes red.
- Remove `!stage1Ready` from the auto-resume condition → `the auto-resume does not fire when stage1Ready is true` goes red.

**Accept:** a subset run never sends or persists a `result` for an unfinished book, and an unfinished book says so after any reload. Shippable.

### T7 — Docs, acceptance bookkeeping and follow-ups

**Release notes, `RELEASE_NOTES.md`:**

> A chapter whose Retry fails now stays marked as failed, even after a reload. A Retry no longer reports a book as finished while other chapters still need attribution — it asks you to resume the analysis instead. While an analysis is running, Retry, Re-analyse and Include wait for you to pause it first. A chapter with no text to narrate now says so when you generate.

**Release notes, `docs/release-notes-next.md`** (under "🗣️ Analyzer, script review & manuscript"):

> Failure rows now say whether cast detection or speaker attribution failed (#3435, PR <new>).
>
> A per-chapter Retry, Re-analyse or Include no longer sends a result while another chapter has no current take; it ends with "resume the analysis to finish the book" (#3435).
>
> Retry, Re-analyse and Include are disabled while a main analysis runs, and the server refuses them with a 409 until the paused or halted run has finished its in-flight chapters (#3435). A main start is likewise refused while a chapter retry runs.
>
> A halted pipelined analysis no longer keeps detecting casts after its attribution failed (#3435).
>
> A book reads "Analysing" until its results are saved after the last attributed chapter; a run that halted after attribution (overflow, attribution drift, a save failure) no longer lands on the confirm screen (#3435).
>
> Chapters with no narratable text no longer show a failure row; generation says "This chapter has no text to narrate — exclude it to finish the book." (#3435).
>
> If you edit speakers in a chapter that is waiting to be re-attributed, re-attribution replaces those edits (#3435).
>
> Soft analysis stops (cast detection pending, resume required) show a "needs action" note instead of a red error (#3435).

**Other T7 steps:**
- **Reviewer catalogue** (`.claude/skills/pr-review-gate/references/reviewer-brief.md`): port entries #17 and #18 from 9a063ea6 (`git show 9a063ea6:.claude/skills/pr-review-gate/references/reviewer-brief.md`). Add "a sentinel that is also a valid value" and "a flag read as 'phase N finished' that is written before phase N".
- **On-box register** (Before-shipping step 3): add the two rows under "On-box acceptance owed" to `docs/testing/onbox-acceptance-register.md`, update the live view `docs/testing/onbox-acceptance-register-live-view.html`, run `npm run register:build` and `npm run check:onbox-register`, and publish per the register's own "Live view" procedure.
- **#3436:** post a comment re-scoping it (spec §2.6).
- **#3437:** comment that main-after-main stragglers stay its scope and that `mainWritersByManuscript` makes the refusal a one-line extension (spec §2.4).
- **File follow-ups** (each its own issue, labelled per CONTRIBUTING.md):
  - restructure does not remap chapter-keyed analysis state (records, `chapterCast`, P);
  - **decision C:** a better treatment for included chapters with no narratable text (auto-exclude at analysis, or skip at generation and count the chapter complete). This PR only changes the generation copy.
- **Close #3439** with a pointer to the new PR.
- `docs/features/INDEX.md`: keep the 285 entry current.

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

1. **(mock) Disabled while running.** Open `#/books/sb/generate`. In the browser console, dispatch a running main snapshot for `sb`'s manuscript through `window.__store__` (the e2e spec's step 2). Re-analyse and Include are disabled and read "Pause the analysis first"; dispatch `setPaused` and they come back.
2. **(real) A Retry that fails stays failed.** Open a book with an attribution row on the Analysing view (`#/books/<id>/analysing`). Stop the analyzer, Retry. The row stays, labelled "Speaker attribution". Reload; it is still there.
3. **(real) Refused while running, then allowed.** Start an analysis; during Phase 1 the Retry buttons are disabled. Pause. Click Retry at once: either it runs, or the row says the paused analysis is still finishing; a few seconds later Retry runs. On a second browser that never saw the run start, Retry during the run shows the server's message on the row.
4. **(real) An unfinished book asks to resume.** Halt a main run part-way through attribution. Retry a failed row. The phase card shows "… still need attribution — resume the analysis to finish the book", no red toast. Reload: the line and "Resume analysis" are still there. Resume; the run finishes and routes to Confirm.

### On-box acceptance owed

Recorded in `docs/testing/onbox-acceptance-register.md` by T7:

1. **Drain on a local Ollama analyzer.** Pipelined run, pause mid-Phase 1, click Retry immediately: refused with the draining message. Observe in the server log `[analysis] main run drained manuscript=<id>` **before** `[analysis-subset] start manuscript=<id>`, and no cache or edits write from the main job after the drained line. Note how long the drain took.
2. **A Resume on a cast-confirmed book with designed voices** (invariant 6; the 2026-07-14 voice-strip incident class). After the run, every designed voice field is intact in cast.json.

## Out of scope

- The #3436 residual writers (spec §2.6).
- #3437: main-after-main stragglers (pause then immediate Resume; Start fresh).
- Restructure remapping (follow-up issue).
- A better treatment for chapters with no narratable text beyond the copy (decision C follow-up).

## Ship notes

(Filled in when status flips to `stable`.)
