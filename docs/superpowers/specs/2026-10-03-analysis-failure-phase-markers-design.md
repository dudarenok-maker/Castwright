# Analysis failure bookkeeping: explicit phase and completeness markers

**Date:** 2026-10-03
**Status:** **Approved by owner 2026-10-03.** Decisions are recorded in §0. One new question is open; it does not block this work (§9).
**Issues:**
- #3435: the defect.
- #3436: its scope is re-stated in §2.6.
- #3437: related.
- Follow-ups to file: restructure does not remap chapter-keyed analysis state; included chapters with no narratable text (§9).

**Plan:** `docs/features/285-analysis-failure-phase-markers.md`.
**Supersedes:** PR #3439 (head 9a063ea6). Its tests are ported by probe name. None of its commits is cherry-picked.
**History:** v1 → v3 went through assumption checks 1–3 (`scratchpad/design-3435/check-*.md`).

**On citations.** Line numbers are `server/src/routes/analysis.ts` at 9a063ea6 unless another file is named. `main:N` means `origin/main`.

## 0. Decisions (owner, 2026-10-03)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Match the main run.** A chapter is *done* (for the subset `result` gate, the main replay and the library badge in `scan.ts`) only if it has a **current take**: a non-pending take that is non-empty, or empty for a chapter with no attributable words. A flagged chapter **with** a take counts. A chapter with no take, or a pending (stale) take, does not. Otherwise a Retry ends `resume_required` | The main run sends `result` only when every non-excluded chapter is in `sentencesByChapter` (`:5975-5978`). M10 is terminal (`:5931`). Failure rows show only in the Analysing view. A "flagged = settled" rule sent an unfinished, never-persisted book to the confirm screen through `scan.ts:801/815` → `ui-slice.ts:260-262` |
| D2 | **Pause the main run for real.** A Retry pauses the main job on the server and resumes it when the Retry ends, even if the view has closed | Today a Retry only aborts the client fetch (`analysing.tsx:875-880`). The server's main job is sticky (`:3606-3614`). Subset dispatch never touches main (`:6885`). Only `/pause` aborts both (`:6714-6727`). So the two jobs ran together and overwrote each other's whole-file saves |
| D3 | **Check the chapter text for an empty take.** `[]` counts as done only if `!hasAttributableContent(body)` (`server/src/analyzer/stage2-coverage.ts:132-134`). Otherwise the chapter is re-attributed | — |
| D4 | **Withdraw "resolve on drop"** (decision (ii), 2026-10-02). **Decision (i) stands:** while stage1 is absent, an attribution-flagged chapter is re-attributed by the main run (§3.1, M1) | The hand-off is now an explicit `resume_required`, and the auto-resume ignores attribution rows. Keeping the record until the main Phase 1 re-attributes is truthful |
| D5 | **A new PR supersedes #3439**, with its tests ported | Its test file is edited by 12 of 14 commits with interleaved hunks, so cherry-picking is impractical |

## 1. Problem

The code reads two facts from signals that only correlate with them. Each of #3439's four review passes found a regression the previous round introduced by trusting one of those signals.

**Fact 1: which phase failed.** It is inferred from `chapterCast[id]` being empty. `[]` is the cast-failure marker (`:4756`, `:7472`), but it is also a legal success: `stage1ChapterSchema` has no minimum (`server/src/handoff/schemas.ts:111-115`).

| Consumer | Site | Probes |
|---|---|---|
| Coverage check | `:1477` | P-theta, pre-existing |
| Re-queue on resume | `:4476` | PE |
| Phase-1 clear | `:5759` | P-alpha, P-theta |
| Subset gate | `:7525-7527` | P3, P2, PB, P-theta |
| `deferToPhase1` | `:7411` | PD |
| `needsReattribution` | `:7316-7317` | PA, P-beta |

**Fact 2: whether the main analysis finished.** It is inferred from stage1 existing (`:7250`).
- stage1 is written before the main Phase 1 runs (`:5036`), and the subset route writes it too (`:7562`).
- The subset route stitches a `result` from whatever is cached (`:7892-7899`) and persists it (`:8120-8380`). This is P-delta and P-eta.
- The hand-off is inferred from zero rows (`src/views/analysing.tsx:827-832`). This is P-beta.

**The own-key signal is also unsound.**
- `rebuildCacheFromEdits` replaces the whole chapters map (`server/src/store/analysis-cache-rebuild.ts:45-53`). It runs on every Generate POST (`server/src/routes/generation.ts:1016-1023`), and in `chapter-splice.ts:249`, `chapter-qa-repair.ts:403` and `chapters-restructure.ts:186`.
- That deletes the keys of empty takes. Three different definitions of "analysed" exist: the main replay (`:5309`), the library (`server/src/workspace/scan.ts:789-801`) and the subset stitch.

**Also folded in:**
- **P-zeta:** the dispatch-check throw sits inside the recording try (`:5454` inside `:5898-5932`).
- **Wrong model named:** the terminal error names the Phase-0 model (`:6692`).
- **Overflow rows:** they do not name their chapter (`:5920`, `:7762`).
- **Panel copy:** every row is called a cast failure (`analysing.tsx:1762-1774`).
- **P-iota** is a hazard of a phase-keyed model, not a live bug; "cast dominates" (§2.1) prevents it.

## 2. Model

### 2.1 Fact 1: `phase` on `ChapterErrorRecord`

**Where it changes:**
- On disk: `server/src/store/analysis-cache.ts:64-68`, with `phase?` for legacy records.
- API: `openapi.yaml:8214-8220`, with `phase` required; then `npm run openapi:types`.
- Hand-written client type: `src/lib/types.ts:516`.
- SSE `chapter-failed`: the send sites, the replay map (`:2701-2710`, `:3071-3082`) and the parser (`src/lib/api.ts:3012-3020`).
- No load-whitelist change: the record values are copied whole (`analysis-cache.ts:137-138`).

**`normaliseFailureRecords(cache)`** runs in `loadAnalysisCache`, on **untagged** records only. Once a record is tagged, every save persists the phase. Rules, first match wins:
1. Tagged: keep.
2. **No stage1, and the cast is missing or `[]`: `'cast'`.**
   - `origin/main` writes coverage flags over any record (`main:5722`) and caches the take (`main:5738`).
   - In pipelined mode, dispatch keys on the highest *successful* index (`server/src/analyzer/phase-watermark.ts:85-107`). So `{attribution-*, [], take, no stage1}` exists on disk today.
   - Reading that as `'attribution'` would let Phase 0b finalise without the chapter's cast, breaching `:4934-4952`.
3. `attribution-collapse` or `attribution-incomplete`: `'attribution'`. Only `selectStage2FailureCode` emits these (`:2583-2588`).
4. A non-empty cast: `'attribution'`.
   - This is an invariant: cast failures write `[]` (`main:4711`, `:7370`), and cast success sets the cast and clears the id synchronously.
   - It covers the 2026-06-05..06-12 records that have no record object (87566a41 → c9cac608) and #3439 dev-build records.
5. Otherwise: `'cast'`.

An id with no record gets a synthesised `{code:'unknown', message: <the fallback at analysing.tsx:805-808>, remediation:'', phase}`. M3 needs no "empty-cast" backstop: rule 2 already covers the only residue.

**Helpers** (in `analysis.ts`, next to `:1391-1426`):
- `recordFailedChapter(cache, id, classified, phase)` returns the effective record. **Cast dominates:** an attribution write onto a cast record is a no-op. Callers send `chapter-failed` with the returned record.
- `clearFailedChapterId(cache, id, phase)`.
- `promoteCastRecordToAttribution`.
- `castFailedChapterIds(cache, hints)`: non-excluded ids only.

### 2.2 Fact 2: current take, one predicate

**Stored state: `cache.pendingAttributionChapterIds?: number[]`**, meaning "this take predates the final roster and is known to be bad".

| Event | Effect | Site |
|---|---|---|
| Add | M1 and S0 only, saved immediately | §3 |
| Remove | Any Phase-1 completion for the chapter, including a coverage re-flag and the word-free short-circuit | M8/M9, S9/S10 |
| Cleared | With the cache: Start fresh, re-parse, book delete | `:4033`, `book-state.ts:1200`, `:1573` |
| Load | Added to the whitelist | `analysis-cache.ts:129-140` |

A pending take is never deleted.

**The predicate: `hasCurrentTake(cache, id, body?)`**, exported from `analysis-cache.ts`. It is true iff:
- the chapter is not pending;
- it has an own key in `cache.chapters`;
- and the take is non-empty, **or** it is `[]` and (`body` is given: `!hasAttributableContent(body)`; `body` is absent: there is no failure record for the chapter).

When `body` is absent, the "no record" check stands in for the text check. Under this design they agree: the word-free short-circuit caches `[]` with no record, and a worded `[]` always carries `noSentences`'s `attribution-incomplete` record (`stage2-coverage.ts:342-349`, `:2584-2585`).

| Reader | Uses | Body available? |
|---|---|---|
| Main replay (`:5305-5317`) | `hasCurrentTake` | yes |
| Subset `result` gate (S14) | `hasCurrentTake` | yes |
| Library (`scan.ts:793-796`) | `hasCurrentTake` | no; `scan.ts` has no chapter bodies |

**Word-free chapters.** In both routes, only the analyzer call is replaced by a synthetic successful result (`sentences: []`, coverage ok, `chunkCount: 0`). Every normal success step still runs: `completedSet`, `sentencesByChapter`, the cache write, pending removal, the attribution clear, the phase tick and the roll. At each route's load (M0/S0), a failed word-free chapter whose take is `[]` and whose record is `attribution-incomplete` has that record cleared. That heals legacy rows.

**Rebuild becomes overlay** (`analysis-cache-rebuild.ts:32-54`), with option `mode: 'overlay' | 'replace'`, default overlay.
- Chapters the edits carry replace their prior entry **wholesale**. A sentence the user deleted (tombstoned in `mergedAwayKeys`, `src/store/manuscript-slice.ts:638-647`; carried by `book-state.ts:341-342`) therefore cannot come back.
- A prior chapter the edits do **not** carry is kept only if it is `[]` (word-free), or excluded in `state.json` (consistent with `book-state.ts:1471-1474`).
- Any other prior chapter absent from the edits is treated as an **intended removal**, and its key is deleted. That chapter then lacks a current take. This is unchanged from today's behaviour for a chapter the user emptied, which `scan.ts` already shows as "analysing".
- Restructure passes `'replace'`, because ids are renumbered (`chapters-restructure.ts:5-10`).

**The main per-chapter edits roll** (`:5816-5828`) builds from `sentencesByChapter.get(id) ?? cachedChapters[id]` over non-excluded chapters, so a pending chapter's take stays in the edits until it is replaced. The final post-fold write is unchanged. The subset roll (`:7858-7869`) already builds from the cache.

**Stitching never includes a pending take:**
- The main run re-attributes every pending chapter before it stitches (`:5975-5978`).
- The subset gate refuses to stitch while any pending chapter exists.

So `attribution_drift` (`:6617`, `:8371`) never counts a stale take.

**How each case heals:**

| Case | Outcome |
|---|---|
| Legacy word-free key deleted by an earlier Generate | Lacks a current take. The next main run re-runs it with no model call, and overlay keeps the key from then on |
| Legacy word-free chapter with a `noSentences` record | M0/S0 clears the record |
| A worded chapter that keeps attributing to `[]` | Per D3 it is not done. Each main run re-attributes it, and the book stays "analysing" with its row until a Retry succeeds or the chapter is excluded. **The owner should confirm this consequence (§9)** |
| Lost cache | No stage1; the existing first-run path |

### 2.3 What stage1 still means

"The roster is final." It still gates three things:
- the main route's Phase-0 skip (`:4293`);
- whether a subset may attribute;
- M1/S0, which apply only while stage1 is absent.

stage1 is never read as "attribution is done".

### 2.4 Main and subset are mutually exclusive (D2)

**Server state:**
- `pendingMainResume: Map<manuscriptId, MainResumeIntent>`, in memory. The intent holds the requested model and the per-phase models; `fresh` is always false and `allowStage1Shrink` is false.
- `job.finished: Promise<void>` on a main job. It resolves after `runMainAnalyzerJob` returns **and** every Phase-0 and Phase-1 pool worker promise has settled. Today `void runMainAnalyzerJob(...)` (`:3638`) drops that promise, and the pool comment (`:5888-5891`) says in-flight workers keep saving.
- `startMainAnalyzerJob(manuscriptId, record, selection, opts, subscriber?)`, factored out of the POST handler (`:3527-3645`) so the server can start a main job with no request. Sticky jobs already run without subscribers (`:3610-3613`).

| Event | Server behaviour |
|---|---|
| Subset POST while a live main job exists | Set `pendingMainResume` from the main job's opts; set `main.pausedForRetry = true`; abort its controller; **await `main.finished`**; only then register the subset job and load the cache. The main catch (`:6642`) ends with `endJob(error paused_for_retry)` instead of `aborted`. `endJob` writes a **paused** snapshot for this code (`:3281-3285` gets a second code) |
| Main POST (not fresh) while a live subset exists | Record `pendingMainResume` from the request; reply with the SSE soft error `retry_in_progress` ("A chapter retry is running; the analysis resumes when it finishes"), then end. No job starts |
| Main POST with `fresh: true` while a live subset exists | Abort the subset, await it, clear `pendingMainResume`, then proceed. Start fresh discards everything |
| Subset ends | `endJob` for a subset, **before** its final frame: if an intent exists and the outcome is a `result` or any error **other than** `aborted`, `stage1_shrink_refused` (the intent is kept for the Accept re-run) or `analyzer-reasoning-overflow` (the same settings would overflow again), then delete the intent, call `startMainAnalyzerJob`, and set `mainResumed: true` on the final frame. This matches today's client rule (`analysing.tsx:1082-1121`), plus the shrink case |
| `/pause` (`:6707-6729`) | Aborts both jobs, as today, and clears the intent |
| Server restart mid-Retry | The intent is lost. The subset's snapshot carries `mainPausedForRetry: true` (new optional `AnalysisStateFile` field, `server/src/store/analysis-state.ts:35-81`), so the cold-boot pill offers Resume, and the existing Resume button starts the main run. Nothing auto-resumes after a restart |

**#3437.** Pausing a job really aborts it. And because `job.finished` waits for the workers, a paused main run cannot leave late writes behind the subset.

### 2.5 Interaction with #3437 (run epoch)

An epoch identifies a run; a current take describes cache contents. One marker cannot serve both. §2.4 closes the main-vs-subset straggler path. #3437 still owns stragglers left behind by a halted run under Start fresh.

### 2.6 What #3436 still owns

§2.4 makes main and subset jobs on one manuscript mutually exclusive on the server, which closes #3436's "main vs subset" question. Still open, all pre-existing, and each the same refuse-or-merge decision:
- **Edits writers while a job is live:** `book-state.ts` manuscript PUT, restructure, `cast-merge.ts:229`.
- **Cache rebuild racing a job's save:** `generation.ts:1020` has no busy check; also `chapter-splice.ts:249`, `chapter-qa-repair.ts:403`, and `cast-merge.ts:344-377`.
- **Restructure during a subset run:** `chapters-restructure.ts:176` replaces the hints; the subset's snapshot of hint ids then rolls stale ids over restructured edits.

This design adds no new writer.

## 3. Rules

**Notation:** `F(x)` is chapter x's record; `c` and `a` are its phase. `P` is the pending set. "Current" means `hasCurrentTake`.

**Hint snapshot:** the subset route captures `record.chapterHints` at load and uses it for the gate (`:7524`), coverage (`:7535`), the roll (`:7862`), the stitch (`:7895`) and S14.

### 3.1 Main route

| # | Event | Record | P / takes / stage1 | SSE |
|---|---|---|---|---|
| M0 | Load | normalise; word-free heal | — | — |
| M1 | Load, stage1 absent | — | **book-wide:** every non-excluded failed id with a non-empty take goes into P; save | — |
| M2 | Load, stage1 present | — | Phase 0 skipped (`:4293`); replay current takes | — |
| M2s | Re-verify shrink refused (`:4328-4340`) | unchanged | unchanged | `stage1_shrink_refused` |
| M3 | Phase 0a queue | — | `!(x in chapterCast) \|\| F(x)=c` (replaces `:4476`) | — |
| M4 | Phase 0a success | clear iff `c` | cast set | `chapter-resolved` iff cleared |
| M5 | Phase 0a failure | `record(c)` | `[]` | `chapter-failed{cast}` |
| M6 | Abort / content-blocked / own overflow (`:4712`, `:4718`, `:4727`; noted with phase 0); rethrows at `:4910` and `:4932` | none | 0b skipped | terminal |
| M7 | Cast failures remain | unchanged | stage1 not written | `cast_incomplete` (`:5965`) |
| M8 | Phase 1 completion (incl. word-free) | clear iff `a` | remove from P; cache; roll | `chapter-resolved` iff cleared |
| M9 | Coverage re-flag | `record(a)`, cast dominates | removed from P | `chapter-failed` with the effective record |
| M10 | Throw from the chapter's own call | `record(a)` with `{chapter}`; `job.failingPhase ??= 1` | stays in P | `chapter-failed`, then terminal |
| M11 | Phase-1 dispatch | none | see note below | terminal on overflow |
| M12 | Abort, or paused for a retry | none | — | `aborted` / `paused_for_retry` |
| M13 | Post-join overflow (`:5958`) | none | — | terminal |
| M14 | Pipelined: cast-failed chapter attributed in the same run | `c` kept | cached | — |
| M15 | Resume after M14 | M3 re-casts; M4 clears | M1 put it in P, so M8 re-attributes | `chapter-resolved` |
| M16 | `attribution_drift` (`:6617-6631`) | already applied | unchanged | unchanged |
| M17 | Result | — | `analysis-state.json` deleted (`:3247-3279`) | `result` |

**Dispatch note (M11).** The dispatch becomes `phase1Dispatch(i): Promise<'run' | 'skip'>`, where `'skip'` replaces the `return` at `:5449`. It runs outside the recording try:

```ts
try { if (await phase1Dispatch(i) === 'skip') continue; }
catch (e) { aborted = true; inFlight.delete(i); throw e; }
```

This also covers a chapter's own Phase-0 overflow being rethrown at its own Phase-1 dispatch.

**Terminal label** (`:6692`):
- For an overflow, use `job.reasoningOverflowPhase`. `noteReasoningOverflow` (`:2470-2482`) gains `phase: 0 | 1`, stored with `??=`. Callers: `:2527`→0, `:4727`→0, `:5564`→1, `:5908`→1, `:7471`→0, `:7710`→1, `:7752`→1.
- Otherwise, use `job.failingPhase`.
- Default: `analyzerLabel`.
- `{chapter}` is passed at `:5920` and `:7762`.

**Decision (i).** The rule marks only *failed* chapters, because a record is evidence the take is bad. A successful pipelined run deliberately accepts unflagged takes made against the rolling roster (Plan 88).

### 3.2 Subset route

The subset makes three separate decisions:
- **Attribute the targets** iff stage1 existed at load, the gate passes and coverage is complete.
- **Send a result and do the final persist** iff every non-excluded chapter outside `toRun` has a current take (D1).
- **Resume main** per §2.4.

| # | Event | Record | P / takes / stage1 | Outcome |
|---|---|---|---|---|
| S0 | Load | normalise; word-free heal | if stage1 absent: M1, book-wide; save | — |
| S1 | Phase 0 failure | `record(c)` | `[]` | `chapter-failed{cast}` |
| S2 | Abort / blocked / overflow (`:7464`, `:7468`, `:7471`) | unchanged | — | terminal |
| S3 | Phase 0 success, stage1 existed | `c` promoted to `a`; `a` kept | take kept (PD) | — |
| S4 | Phase 0 success, no stage1 | `c` cleared; `a` kept | (pending via S0 if flagged) | `chapter-resolved` iff cleared |
| S5 | Gate: cast-failed ids remain | as left | stage1 not rewritten | `endJob(error cast_incomplete)` naming the chapters; replaces the silent end at `:7596-7605` |
| S6 | Coverage incomplete | as left | — | `endJob(error cast_incomplete)`; replaces `:7569` + `:7608` |
| S7 | Shrink refused (`:7541-7559`) | as left by S3 | — | `stage1_shrink_refused` |
| S8 | No stage1; gate passed; coverage complete | as left | stage1 written (`:7561`) | `endJob(error resume_required)`, message: "Cast detection for <titles> is done. The rest of the book still needs attribution — resume the analysis to finish." Replaces `:7618-7624` |
| S9 | Phase 1 completion (incl. word-free) | clear `a` | remove from P; cache; roll (`:7858-7869`) | `chapter-resolved` |
| S10 | Re-flag | `record(a)` | removed from P | `chapter-failed` |
| S11 | Throw | `record(a)` with `{chapter}` | — | `chapter-failed`, then terminal (`:7626` label) |
| S12 | Overflow at `:7676` / `:7890` | none | — | terminal |
| S13 | Abort | none | — | `aborted` |
| S14 | Result gate | — | **Every other chapter current:** result plus full persist (`:7892-8380`), then delete a `subset`-kind `analysis-state.json`. **Otherwise:** no fold, no authoritative cast.json, state.json, provenance or cast-id-history write, no final folded edits | `result`, or `endJob(error resume_required)`: "<titles> re-analysed. <missing titles> still need attribution — resume the analysis to finish the book." |

**What S14 does not undo.** These writes landed earlier in the run and stay. They are the same partial-progress writes a main run makes:
- the provisional interim cast.json overlay (`:7430-7457`);
- the raw per-chapter edits roll (`:7858-7869`);
- the cache.

The authoritative persist of the next main run supersedes them.

**The probes under these rules:**
- **P-delta:** a Retry of ch2 attributes ch2. ch3 has no take, so the run ends `resume_required`. The main resume finishes the book.
- **P-eta:** the Retry of ch1 runs S0 (P = {1, 2}), then S8. A Retry of ch2 attributes ch2, but ch1 is still pending, so it ends `resume_required`. The main resume re-attributes ch1, then sends `result`.
- **P-beta:** S8, then the armed auto-resume (§3.4).

### 3.3 Other events

| Event | Effect |
|---|---|
| Start fresh / re-parse / delete | Cache cleared; intent cleared |
| Include / Exclude | No cache change. An Include target is attributed whenever stage1 exists, so an Include ending `resume_required` needs **no rollback**. An Include ending S5, S6 or S7 keeps today's rollback (`generation.tsx:534`) |
| Generate / splice / QA-repair | Overlay rebuild (§2.2) |
| Restructure | `'replace'` rebuild. Records, `chapterCast` and P stay keyed by old ids: pre-existing, follow-up issue |
| Running-snapshot writes vs. terminal deletes | `endJob` sets `job.ended = true` first. `persistRunningSnapshot` (`:2941-2978`) returns if `job.ended` immediately before `writeAnalysisState`. A check-then-write window of microseconds remains |

### 3.4 Client

**Soft codes:** `cast_incomplete`, `stage1_shrink_refused`, `resume_required`, `retry_in_progress`, `paused_for_retry`.

| Layer | Change |
|---|---|
| Persistence | Subset errors already write a halted snapshot (`endJob` `:3286-3291` → `persistTerminalSnapshot` `:2991-3038`). New: S14 deletes a `subset`-kind snapshot; `paused_for_retry` writes **paused** |
| `openapi.yaml:5629-5637` | Add `resume_required`, `retry_in_progress` and `paused_for_retry` to the prose list |
| `src/lib/analysis-phase-state.ts:11-13` | `isNotAFailureHaltCode` adds `resume_required` and `retry_in_progress` |
| Middleware (`src/store/analysis-stream-middleware.ts:298-316`) | **Subset handle plus a soft code:** `setHalted` with no toast (needs-action). **A final frame with `mainResumed`:** `setActiveStream({kind:'main', state:'running'})`, so the existing first-tick-opens contract subscribes to the restarted main job. This works with the view unmounted. **A main handle receiving `paused_for_retry`:** close the handle, dispatch nothing (the subset snapshot owns the pill). **`retry_in_progress`:** needs-action, no toast |
| Analysing view, Retry (`:851-1129`) | Stops aborting the main fetch (`:875-880`); the server pauses main. The main catch ignores `paused_for_retry`. The Retry's finally re-subscribes to main (`setAnalysisStarted(true)` plus a nonce; the POST joins the live job at `:3528`) **iff** the final frame carried `mainResumed`. `retryNeedsActionRef` is reset at Retry start next to `retryHaltedRef` (`:857`). On a soft code the catch sets it and dispatches `setHalted`, and the finally keeps the snapshot (the `:1088` pattern). `handleRetryChapter(chapterId, opts?: { allowStage1Shrink?: boolean })` |
| Subset shrink (Analysing) | Catch: `setStage1ShrinkInfo({prev, next, retryChapterId})`. Accept (`:1735`) calls `handleRetryChapter(id, {allowStage1Shrink:true})`, which re-runs Phase 0 for that chapter; accepted cost. Main re-entry clears only a **main** shrink banner (`:493` becomes `if (!info?.retryChapterId)`) |
| Subset shrink (Generate) | `generation.tsx:517-566` and `:718-751` have no banner. Add an inline "Accept smaller cast" action on the row that re-runs the same subset with `allowStage1Shrink: true`. An Include re-does the include first, because the rollback ran |
| Needs-action text | `phase-card.tsx:488-491` is an icon only. Add one line under the phase card showing `activeStream.haltReason` for not-a-failure codes. It survives reload, because the snapshot does |
| `castIncomplete` rehydrate | Set from the snapshot on mount when `state==='halted' && haltCode==='cast_incomplete' && kind!=='subset'`. Today it is set only at `:704` |
| Pill (`src/components/top-bar.tsx:45`, data at `layout.tsx:1562-1582`) | For a subset in needs-action, show `haltReason` instead of "Retrying N chapters" |
| Auto-resume (`:827-832`) | `castIncomplete && analysisStarted && castRows === 0 && retryingChapterId === null`. Attribution rows do not block it. With D2, the server resumes main when the main run was live, so this effect covers only an armed run that had already *ended* `cast_incomplete` (P-beta) |
| Generate view (`:520-566`, `:715-750`) | `resume_required`: no rollback, a neutral note with "Open analysis", and `setHalted` instead of `clearActiveStream` (`:563`, `:749`). `cast_incomplete`: the server message plus the existing rollback |
| Row phase | Comes from the server. A client-synthesised row (`:1024-1027`) inherits the existing row's phase, else `'cast'` |

**Books whose cast is already confirmed:**
- Cold boot drops halted and paused snapshots for them (`src/lib/analysis-pill-gate.ts:15-21`, used at `layout.tsx:957`).
- The active-analyses scan skips them (`server/src/workspace/active-analyses.ts:88`).

The persistent surface for these books is therefore the **library status**. `scan.ts:815` checks completeness before `castConfirmed`, so the book reads "analysing", and `openBook` routes "analysing" to the Analysing view (`src/store/ui-slice.ts:260-261`), which shows the rows and Resume. A main run on a confirmed book replays, attributes and persists, then routes to the confirm screen (`ui-slice.ts:234-238`). That is today's Resume behaviour. It must keep designed voices (invariant 6; on-box check).

## 4. UI copy (run through the `castwright-voice` audit)

| Surface | Copy |
|---|---|
| Cast rows, `castIncomplete` | "Paused — N chapter(s) still need cast detection." "Sentence attribution starts once every chapter has a cast. Retry below; the analysis resumes on its own." |
| Cast rows, stage1 present (a main resume does not re-detect casts, `:4293`) | "Cast detection failed on N chapter(s)." "Retry detects the cast again and re-attributes that chapter." |
| Attribution rows | "Speaker attribution failed on N chapter(s)." "Retry re-runs this chapter." |
| Mixed | Per-row labels: "Cast detection" / "Speaker attribution" |
| `resume_required` / `cast_incomplete` | The server message, on the needs-action line and in the pill |
| `retry_in_progress` | "A chapter retry is running. The analysis resumes when it finishes." |

Drop "The model produced malformed output…".

## 5. Invariants

1. **No `result` and no final persist** while a non-excluded chapter outside `toRun` lacks a current take (S14). The main run's own invariant is unchanged (`:5975-5978`).
2. **One predicate**, `hasCurrentTake`, decides the main replay, the subset result gate and the library status.
3. **Phase is explicit:**
   - an attribution record never overwrites a cast record;
   - only a cast success clears `c`, and only a Phase-1 completion clears `a`;
   - `[]` is never read as a phase.
4. **At most one analysis job per manuscript writes at a time.** A subset pauses main and awaits `main.finished`; a main POST during a subset is deferred.
5. **A pending take survives** the main roll and the Generate rebuild until it is replaced. A tombstoned sentence never comes back.
6. **A main run on a cast-confirmed book keeps the cast's designed voice fields.** The merge already does this (#2015/srv-13); the plan pins it with a test.

## 6. Risks

- **#3436 residuals (§2.6).** Restructure stale ids (follow-up issue).
- **Re-attribution replaces hand edits.** A user's speaker edits to a pending chapter are replaced when it is re-attributed. This is release-noted; a Retry has always replaced edits.
- **A worded chapter that keeps attributing to `[]`** keeps the book "analysing" (§9).
- **The pause-for-retry wait** depends on how fast the analyzer honours an abort. A local analyzer's abort latency is on-box acceptance item 1.
- **Server restart mid-Retry** loses the intent. The pill offers Resume.
- **Fixtures.** On `origin/main`, 28 test call sites go through the subset route. Only tests that seed stage1 with a chapter lacking a current take **and** assert `result` or persist change. Example: `analysis.test.ts:4206`.

## 7. Interactions

- #3436 is re-scoped (§2.6).
- #3437 is unchanged (§2.5).
- #3412 / #3084 overflow behaviour is preserved: an overflow still halts with `fixes`, and it never auto-resumes main.

## 8. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| A server-only id list for phase | A second list per fact, a whitelist hazard, and the client could not tell rows apart |
| Own-key completeness (v1) | Not stable under rebuild |
| Book-wide completeness gating every Retry (v2) | Unreachable on real books |
| Flagged-counts-as-settled (v3) | Contradicted the main run's own rule and the library routing (D1) |
| Client-only pause | D2 |
| A WeakMap phase tag on rethrows | Rethrowing pools are not the producing phase |

## 9. Open questions

**NEW, not blocking:**
1. **Included chapters with no narratable text.** They count as done (D3), but generation fails them with "No sentences available — analysis cache is incomplete" (`generation.ts:1393-1403`), so the book never reaches "complete" (`scan.ts:817-819`).
   - Options: (a) auto-exclude such chapters at analysis; (b) have generation skip them and count them complete; (c) keep the failure but say "This chapter has no narratable text — exclude it."
   - *Recommendation:* (c) in a follow-up. This PR does not change generation.
2. **Confirm a consequence of D3:** a worded chapter that the model keeps attributing to `[]` keeps the book in "Analysing", with its row, until a Retry succeeds or the user excludes it.
