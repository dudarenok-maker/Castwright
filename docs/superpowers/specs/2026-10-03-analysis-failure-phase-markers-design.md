# Analysis failure bookkeeping: explicit phase and completeness markers

**Date:** 2026-10-03 (revised the same day after the plan check — see History)
**Status:** **Approved by owner 2026-10-03**, including decisions A–C taken after the plan check. Decisions are recorded in §0. No owner question is open (§9).
**Issues:**
- #3435: the defect.
- #3436: its scope is re-stated in §2.6.
- #3437: related (§2.5).
- Follow-ups to file (plan T9): restructure does not remap chapter-keyed analysis state; a better home for included chapters with no narratable text (decision C).

**Plan:** `docs/features/285-analysis-failure-phase-markers.md`.
**Supersedes:** PR #3439 (head 9a063ea6). Its tests are ported by probe name. None of its commits is cherry-picked, and no code that exists only on #3439 is assumed (§8, plan "Ported code").

**On citations — read this first.**
- Every line number is on **`origin/main` at 6f01fa20** (2026-10-03). Nothing is cited from #3439's head.
- `analysis.ts` means `server/src/routes/analysis.ts`; other files are named.
- Each citation also names a symbol or the code at that line. If `origin/main` has moved by the time you read this, find the symbol and re-derive the line; do not trust the number over the code.
- 0b4eaf24 (the base this design branch was cut from) differs only by small offsets: `analysis.ts` is 6 lines shorter after line ~560, `src/views/analysing.tsx` 5 lines shorter after line ~410.

**History.** v1 → v3 went through design checks 1–3; the approved v3 and its plan went through plan check 1 (`scratchpad/design-3435/check-*.md`, `check-plan-1.md`). Plan check 1 found that the v3 "pause the main run for real" mechanism (old D2) could wedge a book forever (C1) and opened a window with no job registered (C2). The owner then took decisions A–C (§0), which replace D2 and D3. This revision applies them and every implementation-time finding (C9, C11–C20) that still applies; C1–C2 and C5–C8, C10 were findings against the withdrawn mechanism and are moot (§8).

## 0. Decisions (owner, 2026-10-03)

| # | Decision | Rationale |
|---|---|---|
| A | **Refuse until paused** (replaces D2). While a main analysis job for a book is live **or still draining** after a pause or halt (§2.4), the server refuses a subset run (Retry, Re-analyse, Include) with HTTP 409, and the UI disables those actions with "Pause the analysis first". No server-side pause/resume machinery. Applied in both directions: a main start is refused while a subset run is live | The v3 mechanism had to await a "main has settled" promise that cannot settle during Phase 0 (C1: a Phase-1 worker parked in `awaitPhase1Dispatch` has no abort path, `server/src/analyzer/phase-watermark.ts:102-126`), and it opened a window where neither job was registered (C2). Refusal needs no waiting and no hand-off. A Retry while main is *not* running keeps today's behaviour |
| B | **A chapter whose final take is `[]` counts as done once the attribution step has completed for it** (supersedes D3's text check), even if it has words. It still carries its failure record, so it shows as a flagged row the user can Retry | A worded `[]` could otherwise keep a book in "Analysing" for ever, re-attributing on every Resume and looping back (C3). The text check also disagreed between readers that have the chapter body and the library, which has none (C4) |
| C | **An included chapter with no narratable text keeps its generation failure, with clearer copy**: "This chapter has no text to narrate — exclude it to finish the book." A follow-up issue is filed for a better treatment | The analysis treats such a chapter as done (it has nothing to attribute); generation must still say why it produced no audio. Auto-exclude or skip-and-count-complete are product choices deferred to the follow-up |
| D1 | **Match the main run** (amended by B). A chapter is *done* for the subset `result` gate, the main replay and the library badge only if it has a **current take** (§2.2). A flagged chapter with a take counts; a chapter with no take, or a pending (stale) take, does not | The main run reaches `result` only with every non-excluded chapter in `sentencesByChapter`: every such chapter is either replayed (`:5262-5276`) or in `taskIndices` (`:5305-5309`), and any task failure is terminal (`:5850-5866`). A "flagged = settled" rule sent an unfinished, never-persisted book to the confirm screen |
| D4 | **Withdraw "resolve on drop"** (decision (ii), 2026-10-02). **Decision (i) stands:** while stage1 is absent, an attribution-flagged chapter is re-attributed by the main run (§3.1, M1) | Keeping the record until the main Phase 1 re-attributes it is truthful |
| D5 | **A new PR supersedes #3439**, with its tests ported by probe name | Its test file is edited by 12 of 14 commits with interleaved hunks |

D2 (pause the main run for real) and D3 (check the chapter text for an empty take) are **withdrawn**, by A and B respectively.

**Interpretations this revision makes (not new decisions; say so in review if any is wrong):**
1. **B's "attribution step" includes a subset's Phase 1.** The subset attributes only when stage1 existed at load (`stage1Existed`, `:7178`), i.e. against the final roster — the same step the main run runs after Phase 0b. Counting only the main run's step would turn every Retry that yields `[]` on a finished book into `resume_required`.
2. **A's refusal applies in both directions** (a main *start* is refused while a subset is live). Without it, "at most one writer" (invariant 4) does not hold: a Resume clicked during a Retry would start main next to the subset. A main *join* (subscribe to an existing main job) is never refused.
3. **"Never-persisted books never reach Confirm" is enforced with a book-level marker** (`takesPersisted`, §2.2). The per-chapter rule alone cannot prove the authoritative persist ran; §2.2 lists the paths it closes, all of which exist on `origin/main` today.

## 1. Problem

The code reads two facts from signals that only correlate with them. Each of #3439's four review passes found a regression the previous round introduced by trusting one of those signals.

**Fact 1: which phase failed.** It is inferred from `chapterCast[id]` being empty. `[]` is the cast-failure marker (`:4717`, `:7376`), but it is also a legal success: `stage1ChapterSchema` has no minimum (`server/src/handoff/schemas.ts:111`).

Consumers on `origin/main`:

| Consumer | Site | What it does today | Probes |
|---|---|---|---|
| Coverage check | `isPhase0aCoverageComplete`, `:1460` | treats `[]` as "no cast" | P-theta |
| Re-queue on resume | `:4434-4440` | re-queues **every** failed id into cast detection | PE |
| Main Phase-0 success | `:4759` | clears every record | P-alpha, PD-main |
| Subset Phase-0 success | `:7322` | clears every record | P-theta, PD |
| Subset gate | `remainingFailedCastIds`, `:7422`, `:7491-7500` | counts **every** failed id as a cast failure | P3, P2, PB |
| Main Phase 1 | `runPhase1Pool` catch, `:5850-5866` | records nothing on a throw | P-gamma |

`origin/main` has no Phase-1 clear at all.

**Fact 2: whether the main analysis finished.** It is inferred from stage1 existing (`stage1Existed`, `:7178`).
- stage1 is written before the main Phase 1 runs (`cache.stage1 = stage1`, `:4997`), and the subset route writes it too (`:7457`).
- The subset route stitches a `result` from whatever is cached (`:7763-7768`) and sends it (`:8249`). This is P-delta and P-eta.
- The hand-off is inferred from zero rows (`src/views/analysing.tsx:832-837`). This is P-beta.

**The own-key signal is also unsound.**
- `rebuildCacheFromEdits` replaces the whole chapters map (`server/src/store/analysis-cache-rebuild.ts:45-53`). It runs on every Generate POST (`server/src/routes/generation.ts:1018-1022`), and in `chapter-splice.ts:249`, `chapter-qa-repair.ts:403` and `chapters-restructure.ts:186`.
- That deletes the keys of empty takes. Three definitions of "analysed" exist: the main replay (non-empty cached take, `:5270`), the library (any own key, `server/src/workspace/scan.ts:789-801`) and the subset stitch (any own key).

**Main and subset jobs write the same files at the same time.** A Retry only aborts the client's own fetch (`analysing.tsx:879-884`); the main job is sticky and survives it (`:3593-3597`); the subset POST never looks at the main job (`:6816`). Only `/pause` aborts both (`:6638-6662`). Each job saves the whole cache, so the second finisher overwrites the first.

**Also folded in:**
- **P-zeta:** once the main Phase-1 pool records failures, the overflow rethrown by the dispatch check (`:5415`) would be recorded against a chapter that never ran.
- **Wrong model named:** both terminal handlers label every failure with the Phase-0 model (`:6623`, `:8287`).
- **Overflow rows** do not name their chapter (the pool catch at `:5858` passes it, the terminal frame does not).
- **Panel copy:** every row is called a cast failure, and the subtext promises the pause-and-retry that decision A withdraws (`analysing.tsx:1767-1778`).
- **Halted pipelined runs keep spending:** after the Phase-1 pool rejects, the Phase-0 arm keeps starting cast chapters and runs Phase 0b (`runPhase0Pool`, `:4855-4884`; its loop checks only its own `castAborted`). This is the main source of a long drain (§2.4).
- **P-iota** is a hazard of a phase-keyed model, not a live bug; "cast dominates" (§2.1) prevents it.

## 2. Model

### 2.1 Fact 1: `phase` on `ChapterErrorRecord`

**Where it changes:**
- On disk: `ChapterErrorRecord`, `server/src/store/analysis-cache.ts:64-68`, with `phase?` for legacy records.
- API: `openapi.yaml:8208-8220` (`analysis.failedChapterErrors`), with `phase` required; then `npm run openapi:types`.
- Hand-written client type: `src/lib/types.ts:524`.
- SSE `chapter-failed`: every send site; the replay entry type and recorder (`:2684-2693`, `:3054-3066`); **both** client parsers — the main stream (`src/lib/api.ts:3013-3021`) and the subset stream (`src/lib/api.ts:5730-5738`), which each copy fields explicitly — plus `AnalysisStreamEvent` (`api.ts:2804`) and the `onChapterFailed` callback type.
- The mock API emits no `chapter-failed` and seeds no `failedChapterErrors` (checked: `git grep` finds neither under `src/lib/api.ts`'s mock functions or `src/mocks/`), so it needs no change for this field.
- No load-whitelist change: the record values are copied whole (`analysis-cache.ts:138`).

**`normaliseFailureRecords(cache)`** runs in `loadAnalysisCache` (`analysis-cache.ts:119`), on **untagged** records only. Once a record is tagged, every save persists the phase. Rules, first match wins:
1. Tagged: keep.
2. **No stage1, and the cast is missing or `[]`: `'cast'`.**
   - `origin/main` writes coverage flags over any record (`:5728`) and caches the take (`:5744`).
   - In pipelined mode Phase 1 can attribute a chapter whose cast failed in the same run (`phase-watermark.ts:85-107` keys dispatch on the highest *successful* index). So `{attribution-*, [], take, no stage1}` exists on disk today.
   - Reading that as `'attribution'` would let Phase 0b finalise without the chapter's cast.
3. `attribution-collapse` or `attribution-incomplete`: `'attribution'`. Only `selectStage2FailureCode` emits these (`:2566`).
4. A non-empty cast: `'attribution'`. Cast failures write `[]` (`:4717`, `:7376`), and a cast success sets the cast and clears the id synchronously. This covers the 2026-06-05..06-12 records that have no record object, and #3439 dev-build records.
5. Otherwise: `'cast'`.

An id with no record gets a synthesised `{code:'unknown', message: <the fallback at analysing.tsx:810-811>, remediation:'', phase}`.

**Helpers** (in `analysis.ts`, next to `clearFailedChapterId` `:1397` and `recordFailedChapter` `:1415`):
- `recordFailedChapter(cache, id, classified, phase)` returns the effective record. **Cast dominates:** an attribution write onto a cast record is a no-op. Callers send `chapter-failed` with the returned record.
- `clearFailedChapterId(cache, id, phase)` clears only a record of that phase.
- `promoteCastRecordToAttribution(cache, id)`.
- `castFailedChapterIds(cache, hints)`: non-excluded ids whose record is `'cast'`.
- `saveCacheInFailureCatch(manuscriptId, cache, chapterId)` — a save that logs and swallows its own error, so a failing save inside a failure catch never replaces the error being handled. Written here in full (plan T2), not taken from #3439.

### 2.2 Fact 2: current take, one predicate

**Stored state, both in the analysis cache and both added to the load whitelist (`analysis-cache.ts:129-140`):**
- `pendingAttributionChapterIds?: number[]` — **P**, "this chapter's take predates the final roster and is known to be bad". Absent means empty.
- `takesPersisted?: boolean` — **false** means "a take was written after the last authoritative persist". Absent (legacy caches) means persisted.

| Event | Effect | Site |
|---|---|---|
| Add to P | M1/S0 at load (stage1 absent): every non-excluded failed id that has an own key **including `[]`**; and M8c: a Phase-1 completion for a chapter whose record is still `'cast'` | §3 |
| Remove from P | Any other Phase-1 completion for the chapter, including a coverage re-flag and the word-free short-circuit | M8/M9, S9/S10 |
| `takesPersisted = false` | Every Phase-1 completion that writes a take (main or subset, including word-free) | M8/M9, S9/S10 |
| `takesPersisted = true` | The end of an authoritative persist block that wrote state.json (main: after the deferred rethrows, `:6545`; subset: after `:8237`). Not set when the block was skipped (abort, `attribution_drift`) | M17, S14 |
| Cleared with the cache | Start fresh, re-parse, book delete | `clearAnalysisCache` callers: `:4016` (fresh), `book-state.ts:1200`, `:1573` |

A pending take is never deleted.

**The predicate: `hasCurrentTake(cache, id)`**, exported from `analysis-cache.ts`:

```ts
hasCurrentTake(cache, id) :=
  Object.hasOwn(cache.chapters, id) && !(cache.pendingAttributionChapterIds ?? []).includes(id)
```

It needs no chapter body. **What marks "the attribution step completed for it" (decision B)** is the pair of invariants that make an own key outside P mean exactly that:
1. **An own key is written only by a Phase-1 completion** (M8/M9 main, S9/S10 subset, both including the word-free short-circuit) or kept by the overlay rebuild from such a write. No other writer creates a key: cast failures write `chapterCast`, not `chapters`; the overlay never adds a key the edits do not carry or the prior cache did not hold.
2. **P holds every take known to predate the final roster.** M1/S0 put every failed chapter that has a key (including `[]`) into P while stage1 is absent, so a legacy `{cast record, [] take}` (C4) and a pipelined-run take made without the chapter's own cast are pending. M8c adds a chapter to P when *this* run attributed it while its cast record stood (M14), closing the window before the next load.

A worded chapter whose take is `[]` after a completed attribution step is therefore current (decision B). It keeps its `attribution-incomplete` record from `noSentences` (`server/src/analyzer/stage2-coverage.ts:346-349`), so it shows as a flagged row.

**Book-level completeness: `analysisCompleteFor(cache, activeChapterIds)`**, exported from `analysis-cache.ts`:

```ts
analysisCompleteFor(cache, ids) :=
  ids.length === 0 ||
  (!!cache.stage1 && ids.every((id) => hasCurrentTake(cache, id)) && cache.takesPersisted !== false)
```

| Reader | Uses |
|---|---|
| Main replay (`:5262-5276`) | `hasCurrentTake` — replays `[]` takes too (today it needs `cached.length > 0`, `:5270`) |
| Subset `result` gate (S14) | `hasCurrentTake` over every non-excluded chapter outside `toRun` |
| Library (`scan.ts:789-801`) | `analysisCompleteFor` replaces the own-key count |
| Book-state GET (`book-state.ts:321-326`, payload `:637`) | `analysisCompleteFor`, for `analysis.resumeRequired` (§3.4) |

**Why the book-level marker.** Without it, every one of these reaches Confirm with only the interim cast.json overlay, because every take is current but the authoritative persist never ran: the post-join overflow (`throwIfReasoningOverflowed`, `:5889`); a persist-block terminal (lock timeout `:6542`, `STALE_BOOK_DIR` `:6545`); `attribution_drift`, which skips the cast.json/state.json writes (main `:6548`, subset `:8240`); a server crash between the last take and the persist. All exist on `origin/main`. With `takesPersisted` false each reads "analysing". For `attribution_drift`, a Resume replays the same takes and halts with the same verdict, so the drift message (main `:6556-6560`, subset `:8241-8245`) gains "— or Start fresh to re-attribute every chapter."

**No loop.** A worded `[]` chapter is current once attributed, so the main run sends `result`, persists, and sets `takesPersisted`; the library then reads `cast_pending`, and a later Resume replays it rather than re-attributing. A chapter never re-enters P except through M1/S0 (needs stage1 absent, which a persisted book never has again until Start fresh) or M8c (needs a standing cast record, which a stage1-present run cannot produce: Phase 0 is skipped, `:4259`).

**Word-free chapters** (`!hasAttributableContent(body)`, `stage2-coverage.ts:132`). In both routes the analyzer call is replaced by a synthetic successful result (`sentences: []`, coverage ok, `chunkCount: 0`); every normal success step still runs. `origin/main` already makes no model call for such a chapter (`server/src/analyzer/stage2-chunk.ts:390`) but flags it `noSentences`, which shows a misleading row. At each route's load (M0/S0), a failed word-free chapter whose take is `[]` and whose record is `attribution-incomplete` has that record cleared. Generation then reports it with decision C's copy (§3.3).

**Rebuild becomes overlay** (`analysis-cache-rebuild.ts:32-54`), option `mode: 'overlay' | 'replace'`, default overlay. It never changes P, the records or `takesPersisted`.
- Chapters the edits carry replace their prior entry **wholesale**, so a sentence the user deleted (tombstoned in `mergedAwayKeys`, `src/store/manuscript-slice.ts`, carried by `book-state.ts:341-342`) cannot come back.
- A prior chapter the edits do **not** carry is kept only if it is `[]`, or excluded in `state.json`.
- Any other prior chapter absent from the edits is an **intended removal**; its key is deleted. That chapter lacks a current take, which is unchanged from today for a chapter the user emptied.
- Restructure passes `'replace'`, because ids are renumbered (`chapters-restructure.ts:176`, `:186`).

**The main per-chapter edits roll** (`rollManuscriptEdits`, `:5766-5779`) builds from `sentencesByChapter.get(id) ?? cachedChapters[id]` over non-excluded chapters, so a pending take stays in the edits until it is replaced. The subset roll (`:7727-7737`) already builds from the cache.

**Stitching never includes a pending take:** the main run re-attributes every pending chapter before it stitches (`:5906-5909`); the subset gate refuses to stitch while any chapter lacks a current take. So `attribution_drift` never counts a stale take.

**How each case heals:**

| Case | Outcome |
|---|---|
| Legacy word-free key deleted by an earlier Generate | Lacks a current take. The next main run re-runs it with no model call; overlay keeps the key from then on |
| Legacy word-free chapter with a `noSentences` record | M0/S0 clears the record |
| A worded chapter that attributes to `[]` | Current (B); flagged row; generation names it (§3.3) |
| Legacy `{cast record, [] take, no stage1}` | M1/S0 put it in P; re-cast and re-attributed |
| Lost cache | No stage1; the existing first-run path |

### 2.3 What stage1 still means

"The roster is final." It gates: the main route's Phase-0 skip (`:4259`); whether a subset may attribute (`stage1Existed`); M1/S0, which apply only while stage1 is absent; and the library's book-level clause. stage1 is never read as "attribution is done".

### 2.4 Refuse until paused (decision A)

**Writers.** A new in-memory registry, `mainWritersByManuscript: Map<manuscriptId, Set<AnalysisJob>>`, next to the job maps (`:2764-2770`).
- A main job joins it where it registers (`inFlightAnalysisByManuscript.set`, `:3585`).
- It leaves only when **both** `job.ended` is true **and** `job.liveWork === 0`. The set entry is deleted when empty, with one log line `[analysis] main run drained manuscript=<id>` (the on-box check reads it).
- `job.ended` is set first thing in `endJob` (`:3162`), for every kind.
- A displaced main job (Start fresh, `:3532-3538`) is no longer in `inFlightAnalysisByManuscript` but stays a writer until it drains.

**Live work (`job.liveWork`)** counts tracked promises; `trackWork(job, p)` increments, and decrements in a `finally` that re-checks the leave condition. Tracked:
1. each `runCastChapter(i)` call in the Phase-0 pool (`launchNextCast`, `:4865-4878`);
2. the Phase-0 arm itself (`phase0PoolPromise`, `:5101`), which covers Phase 0b's stage1 and cast.json writes;
3. each Phase-1 chapter **body** — the part of `runChapter` after `phase1Dispatch(i)` returned `'run'` (§3.1 M11), through its cache save (`:5757`) and edits roll (`:5766`).

**Not tracked, deliberately:** a Phase-1 worker parked in `awaitPhase1Dispatch` (`:5402`). The watermark has no abort path (`phase-watermark.ts:102-126`; the sequential stub, `:160-170`, likewise) and is woken only by its own job's `markPhase0AllDone` (`:4329` cache hit, `:4931` failure, `:5092` success), which an aborted Phase-0 pool never calls (C1). Counting it would hold the registry for ever. It writes nothing while parked, and `phase1Dispatch` returns `'skip'` when it wakes into an ended or aborted job.

**Bounded drain.** Today a halted pipelined run keeps spending: the Phase-0 arm starts new cast chapters and runs Phase 0b after the Phase-1 arm rejected. This design makes the Phase-0 arm honour the pool's own rule ("the first failure aborts new task dispatch", comment at `:5838-5841`) across arms: `launchNextCast`'s loop also stops when `job.ended`, and Phase 0b is skipped when `job.ended`. Chapters already calling the model finish and cache, as today. So a drain lasts as long as the slowest in-flight call. A paused run's calls are aborted by the signal; a halted run's calls finish.

**What else waits for the drain.** For a main job, `endJob`'s two releases move to the moment it leaves the registry: `clearAnalysisBusy` (`:3323`), so a "Design full cast" run cannot start while a draining chapter can still write the interim cast.json (`:4798`); and the local-Ollama evict (`:3333-3337`), so the model is not unloaded under an in-flight call. A subset job releases both in `endJob`, as today.

**Server refusals.** Both are checked synchronously, **before `res.flushHeaders()`**, so they are real HTTP 409s with a JSON body (the main route's `language_unset` 409, `:3370-3383`, is the precedent).

| Request | Refused when | Response |
|---|---|---|
| Subset POST (`/analysis/chapters`, `:6677`; check before `:6716`) | the manuscript has a main writer (registered or draining) | `409 { error: 'main_analysis_running', draining, message }`. Live: "The analysis is still running on this book. Pause it first, then try again." Draining (after a pause or a halt): "The analysis on this book is still finishing the chapters it had started. Try again in a moment." |
| Main POST (`/analysis`, `:3340`; check before `:3391`) | a subset job is registered for the manuscript **and** the request would start a job (no live main to join, or `fresh: true`) | `409 { error: 'subset_analysis_running', message }`: "A chapter retry is running on this book. Wait for it to finish, then resume the analysis." |

The subset route needs no drain state of its own: it is sequential, does no detached chapter work, and deregisters synchronously in `endJob` (`:3302-3305`), in the same tick as its subscribers' responses end (`:3285-3301`), so a client that saw the subset end can start main at once.

**`/pause` (`:6638-6662`)** is unchanged: it aborts both jobs. A paused main drains; the next Retry succeeds once it has.

**Server restart:** the registry is in memory, so it is empty after a restart, and so is every job. Nothing to recover.

**What this leaves out:** a main **resume** while a previous main drains is not refused. That is #3437's straggler class (§2.5); the registry makes the refusal a one-line extension there.

### 2.5 Interaction with #3437 (run epoch)

An epoch identifies a run; a current take describes cache contents. One marker cannot serve both. Decision A closes the main-vs-subset straggler path. #3437 still owns stragglers of one main run into the next one (pause then immediate Resume, or Start fresh).

### 2.6 What #3436 still owns

Decision A makes main and subset jobs on one manuscript mutually exclusive on the server, which closes #3436's "main vs subset" question. Still open, all pre-existing, each the same refuse-or-merge decision:
- **Edits writers while a job is live:** `book-state.ts` manuscript PUT, restructure, `cast-merge.ts:229`.
- **Cache rebuild racing a job's save:** `generation.ts:1020` has no busy check; also `chapter-splice.ts:249`, `chapter-qa-repair.ts:403`, and `cast-merge.ts:377`.
- **Restructure during a subset run:** `chapters-restructure.ts:176` replaces the hints; the subset's snapshot of hint ids then rolls stale ids over restructured edits.

This design adds no new writer.

## 3. Rules

**Notation:** `F(x)` is chapter x's record; `c` and `a` are its phase. `P` is the pending set. "Current" means `hasCurrentTake`.

**Hint snapshot:** the subset route captures `record.chapterHints` at load and uses it for the gate, coverage (`:7430`), the roll (`:7731-7734`), the stitch (`:7764-7767`) and S14.

### 3.1 Main route

| # | Event | Record | P / takes / stage1 | SSE |
|---|---|---|---|---|
| M0 | Load (`:4063`) | normalise; word-free heal | — | — |
| M1 | Load, stage1 absent | — | **book-wide:** every non-excluded failed id with an own key (incl. `[]`) goes into P; save | — |
| M2 | Load, stage1 present | — | Phase 0 skipped (`:4259`); replay current takes (`:5262-5276`) | — |
| M2s | Re-verify shrink refused (`:4294-4306`) | unchanged | unchanged | `stage1_shrink_refused` |
| M3 | Phase 0a queue (`:4434-4440`) | — | queue `!(x in chapterCast) \|\| F(x)=c` | — |
| M4 | Phase 0a success (`:4759`) | clear iff `c` | cast set | `chapter-resolved` iff cleared |
| M5 | Phase 0a failure (`:4717-4728`) | `record(c)`; guarded save | `[]` | `chapter-failed{cast}` |
| M6 | Abort / content-blocked / own overflow (`:4673-4688`) | none | 0b skipped | terminal |
| M7 | Cast failures remain (`:5896-5903`) | unchanged | stage1 not written | `cast_incomplete` |
| M8 | Phase-1 completion, incl. word-free (`:5728-5757`) | clear iff `a` | remove from P; cache; `takesPersisted=false`; roll | `chapter-resolved` iff cleared |
| M8c | Phase-1 completion while `F(x)=c` (only possible in pipelined mode, M14) | `c` kept | **add** to P; cache; `takesPersisted=false` | — |
| M9 | Coverage re-flag | `record(a)`, cast dominates | as M8 / M8c | `chapter-failed` with the effective record |
| M10 | Throw from the chapter's own call | `record(a)` with `{chapter}`; guarded save; `job.failingPhase ??= 1` | unchanged | `chapter-failed`, then terminal |
| M11 | Phase-1 dispatch | none | see note | terminal on overflow |
| M12 | Abort | none | — | `aborted` |
| M13 | Post-join overflow (`:5889`) | none | `takesPersisted` stays false | terminal |
| M14 | Pipelined: cast-failed chapter attributed in the same run | `c` kept | M8c | — |
| M15 | Resume after M14 | M3 re-casts; M4 clears | it is in P, so it is re-attributed | `chapter-resolved` |
| M16 | `attribution_drift` (`:6548-6563`) | — | `takesPersisted` stays false | unchanged code; message gains the Start-fresh clause |
| M17 | Result (`:6564`) | — | `takesPersisted = true` (end of persist block, `:6545`); `analysis-state.json` deleted by `endJob` | `result` |

**Dispatch note (M11).** The dispatch becomes `phase1Dispatch(i): Promise<'run' | 'skip'>` — the first part of `runChapter` (`:5390-5415`): `awaitPhase1Dispatch`, the `phase0FailedCount` return (now `'skip'`), a new `job.ended || signal.aborted` check (`'skip'`), and the overflow check. It runs **outside** the recording catch:

```ts
let verdict: 'run' | 'skip';
try { verdict = await phase1Dispatch(i); }
catch (e) { inFlight.delete(i); aborted = true; throw e; }   // no record: the chapter never ran
if (verdict === 'skip') continue;
await trackWork(job, runChapterBody(i));                       // recording catch wraps this only
```

This also covers a chapter's own Phase-0 overflow being rethrown at its own Phase-1 dispatch.

**Terminal label** (`classifyAnalysisFailure(e, analyzerLabel, …)`, main `:6623`, subset `:8287`):
- For an overflow, the label of `job.reasoningOverflowPhase`. `noteReasoningOverflow` (`:2453`) gains `phase: 0 | 1`, stored with `??=`. Its seven callers: `:2510`→0 (the non-story classifier, which both routes build with the Phase-0 `analyzer`, `:3782`, `:7018`), `:4688`→0, `:5525`→1, `:5858`→1, `:7375`→0, `:7604`→1, `:7646`→1.
- Otherwise, `job.failingPhase === 1` → the Phase-1 label; else `analyzerLabel`.
- The Phase-1 label is declared inside the try today (`phase1AnalyzerLabel`, main `:3813`, subset `:7023`); hoist a `let` to function scope next to `analyzerLabel` (`:3744`, `:6991`) so the catch can read it.
- `{chapter}` is passed for the overflow row.

**Decision (i).** The rule marks only *failed* chapters, because a record is evidence the take is bad. A successful pipelined run deliberately accepts unflagged takes made against the rolling roster (Plan 88).

### 3.2 Subset route

The subset makes three separate decisions:
- **Run at all** iff no main writer exists for the manuscript (§2.4).
- **Attribute the targets** iff stage1 existed at load, the gate passes and coverage is complete.
- **Send a result and do the final persist** iff every non-excluded chapter outside `toRun` has a current take (D1).

| # | Event | Record | P / takes / stage1 | Outcome |
|---|---|---|---|---|
| S−1 | POST while a main writer exists | — | — | `409 main_analysis_running` (§2.4); no job registered |
| S0 | Load (`:7160`) | normalise; word-free heal | if stage1 absent: M1, book-wide; save | — |
| S1 | Phase 0 failure (`:7376-7390`) | `record(c)`; guarded save | `[]` | `chapter-failed{cast}` |
| S2 | Abort / blocked / overflow (`:7368-7375`) | unchanged | — | terminal |
| S3 | Phase 0 success, stage1 existed (`:7322`) | `c` promoted to `a`; `a` kept | take kept (PD) | — |
| S4 | Phase 0 success, no stage1 | `c` cleared; `a` kept | (pending via S0 if flagged) | `chapter-resolved` iff cleared |
| S5 | Gate: cast-failed ids remain (`:7491-7500`) | as left | stage1 not rewritten | stage1 absent: `endJob(error cast_incomplete)` naming the chapters. stage1 existed: the target's cast failed again — `endJob(error)` with the target's classified record (a real failure, like S11). Replaces the silent `endJob(job)` |
| S6 | Coverage incomplete (`:7458-7469`, `:7502-7505`) | as left | — | `endJob(error cast_incomplete)` with today's message; replaces the mid-stream `send` + silent end |
| S7 | Shrink refused (`:7436-7455`) | as left by S3 | — | `stage1_shrink_refused` |
| S8 | No stage1; gate passed; coverage complete (`:7513-7520`) | as left | stage1 written (`:7457`) | `endJob(error resume_required)`: "Cast detection for <titles> is done. The rest of the book still needs attribution — resume the analysis to finish." Replaces the silent end |
| S9 | Phase-1 completion, incl. word-free (`:7701-7719`) | clear `a` | remove from P; cache; `takesPersisted=false`; roll | `chapter-resolved` |
| S10 | Re-flag | `record(a)` | as S9 | `chapter-failed` |
| S11 | Throw (`:7640-7647`) | `record(a)` with `{chapter}`; guarded save; `job.failingPhase ??= 1` | — | `chapter-failed`, then terminal with the Phase-1 label |
| S12 | Post-loop overflow (`:7759`) | none | — | terminal |
| S13 | Abort | none | — | `aborted` |
| S14 | Result gate (before the stitch, `:7763`) | — | **Every other chapter current:** stitch, full persist (`:7989-8237`), `takesPersisted = true`, `result` (`:8249`), then delete a `subset`-kind `analysis-state.json`. **Otherwise:** no fold, no authoritative cast.json, state.json, provenance or cast-id-history write, no final folded edits | `result`, or `endJob(error resume_required)`: "<titles> re-analysed. <missing titles> still need attribution — resume the analysis to finish the book." |

**What S14 does not undo.** These writes landed earlier in the run and stay; they are the same partial-progress writes a main run makes: the interim cast.json overlay (`:7334-7360`); the per-chapter edits roll (`:7727-7737`); the cache. The next authoritative persist supersedes them. Until then the library reads "analysing" (`takesPersisted` false), so the book cannot be generated from them through the normal flow.

**The probes under these rules:**
- **P-delta:** a Retry of ch2 attributes ch2. ch3 has no take, so the run ends `resume_required`. A main resume finishes the book.
- **P-eta:** the Retry of ch1 runs S0 (P = {1, 2}), then S8. A Retry of ch2 attributes ch2, but ch1 is still pending, so it ends `resume_required`. The main resume re-attributes ch1, then sends `result`.
- **P-beta:** S8, then the armed auto-resume (§3.4).

### 3.3 Other events

| Event | Effect |
|---|---|
| Start fresh / re-parse / delete | Cache cleared (P and `takesPersisted` with it) |
| Include / Exclude | No cache change. An Include target is attributed whenever stage1 exists, so an Include ending `resume_required` needs **no rollback**. An Include refused with 409, or ending S5, S6 or S7, keeps today's rollback (`rollbackInclude`, `generation.tsx:534`) |
| Generate / splice / QA-repair | Overlay rebuild (§2.2) |
| Generate, a chapter whose take is `[]` (`generation.ts:1394-1403`) | **Decision C.** Own key, `[]`, **no** failure record (word-free): "This chapter has no text to narrate — exclude it to finish the book." Own key, `[]`, **with** a record (worded, decision B): "Speaker attribution found no lines in this chapter. Re-analyse it, or exclude it." No own key: today's "analysis cache is incomplete" copy. The chapter still fails; nothing else changes |
| Restructure | `'replace'` rebuild. Records, `chapterCast` and P stay keyed by old ids: pre-existing, follow-up issue |
| Snapshot writes vs. terminal deletes (C19) | `writeAnalysisState` and `deleteAnalysisState` (`server/src/store/analysis-state.ts:101-114`, `:122-131`) move onto the per-path op chain the cache already uses (`writeJsonAtomicOrdered`, `enqueuePathOp`; `analysis-cache.ts:146-165`), so they land in call order. `persistRunningSnapshot` (`:2924`) returns if `job.ended` before writing. S14's "delete a `subset`-kind snapshot" reads, checks and unlinks inside **one** enqueued op |

### 3.4 Client

**New and changed codes:**
- Not-a-failure halts: `cast_incomplete`, `stage1_shrink_refused` (today) and `resume_required` (new) — `isNotAFailureHaltCode`, `src/lib/analysis-phase-state.ts:11-13`.
- Refusals, which never start a job: `main_analysis_running` (subset POST) and `subset_analysis_running` (main POST).

| Layer | Change |
|---|---|
| `src/lib/api.ts` | `realRunAnalysisForChapters` (`:5649-5682`) reads the body of a non-OK response: a 409 `{error:'main_analysis_running'}` throws `AnalysisError(message, 'main_analysis_running')`; anything else keeps `ANALYSIS_STREAM_FAILED`. `realAnalyseManuscript`'s non-OK branch (`:2943-2966`) does the same for `subset_analysis_running`, after the existing `language_unset` branch. Both parsers carry `phase` on `chapter-failed` (§2.1) |
| `openapi.yaml` | `/analysis/chapters` (`:601`) gains a `'409'` response with `{error, draining, message}`; `/analysis` (`:589-599`) widens its 409 description and body to include `subset_analysis_running` with `message`; `AnalyseErrorEvent`'s route-code list (`:5634-5636`) adds `resume_required`; `analysis` in the book-state GET (`:8201-8220`) gains `phase`, `stage1Ready` and `resumeRequired` |
| Selector | `selectMainAnalysisLive(state, manuscriptId)` in `src/store/analysis-slice.ts`: `activeStream` is for this manuscript, `kind !== 'subset'`, `state === 'running'` |
| Analysing view, Retry (`handleRetryChapter`, `analysing.tsx:856-1131`) | **Disabled** while main is live — the view's own main stream (`isAnalysisRunning`, `:1298`, while `retryingChapterId === null`) or `selectMainAnalysisLive`. The button shows "Pause the analysis first" as its tooltip and as a line under the row list. The pause-and-retry branch (`pausedMainForRetry`, `:879-885`, and its resume in the `finally`, `:1102-1131`) is **deleted**. A 409 `main_analysis_running` is handled like `subset_in_progress` today (`:1004-1035`): restore the prior snapshot, keep the row, show the server's message on it |
| Analysing view, main catch | `subset_analysis_running`: `setConn('idle')`, `setAnalysisStarted(false)`, show the server's message on the needs-action line; no `setHalted`, no toast |
| Generate view, Re-analyse and Include (`handleReanalyse` `:620`, `handleToggleExcluded` `:369`) | **Disabled** while `selectMainAnalysisLive`, with the same "Pause the analysis first" copy. A 409 is handled like `subset_in_progress` (`:529-561`, `:730-746`): restore the prior snapshot, `patchSubset(id, {error: message})`; Include also rolls back |
| Middleware (`src/store/analysis-stream-middleware.ts`) | `main_analysis_running` / `subset_analysis_running` on a subscribe POST: `closeHandle()`, dispatch nothing (the same shape as `ANALYSIS_STREAM_NO_RESULT`, `:279-282`). Subset handle plus a not-a-failure code: `setHalted`, no toast |
| Cold boot (C9) | The rehydrate effect (`analysing.tsx:322-334`) sets `analysisStarted` only for a running snapshot whose `kind !== 'subset'`. A running **subset** snapshot never POSTs the main route; the rows come from the book-state GET as usual. A Retry clicked then joins the live subset (same chapter set, `:6816-6832`) or is told `subset_in_progress` |
| Needs-action line | `phase-card.tsx:488-491` is an icon only. Add one line under the phase card: `activeStream.haltReason` for a not-a-failure code; otherwise, when the book-state GET says `resumeRequired`, the copy in §4 |
| Book-state GET (C18, C20) | `analysis.stage1Ready = !!cache.stage1`; `analysis.resumeRequired = stage1Ready && !analysisCompleteFor(...)`. These are server facts, so they survive a reload and a dropped snapshot on a confirmed book (`src/lib/analysis-pill-gate.ts:15-21`) |
| `castIncomplete` rehydrate (C20) | Set on mount from a halted `cast_incomplete` snapshot of **either** kind **when `stage1Ready` is false**. The cast-row copy is chosen by `stage1Ready`, not by the client flag. Today it is set only at `:709` |
| Start/Resume label (C18) | Reads "Resume analysis" when `resumeRequired` (as well as when `hasStartedOnceRef`, `:1393-1397`) |
| Pill (`src/components/top-bar.tsx:172`, data `layout.tsx:1541-1582`) | For a subset in needs-action, show `haltReason` instead of "Retrying N chapters" |
| Auto-resume (`:832-837`) | `castIncomplete && !stage1Ready && analysisStarted && castRows === 0 && retryingChapterId === null`. Attribution rows do not block it. It covers an armed run that ended `cast_incomplete` (P-beta). It can never fire while a subset is registered: the Retry's `finally` runs after the subset deregistered (§2.4) |
| Subset shrink (Analysing) | Catch: `setStage1ShrinkInfo({prev, next, retryChapterId})`. Accept (`:1743`) calls `handleRetryChapter(id, {allowStage1Shrink: true})`, which re-runs Phase 0 for that chapter (accepted cost). Main re-entry clears only a **main** shrink banner (`:498` becomes `if (!info?.retryChapterId)`) |
| Subset shrink (Generate) | `generation.tsx:517-566` and `:718-751` have no banner. Add an inline "Accept smaller cast" action on the row that re-runs the same subset with `allowStage1Shrink: true`. An Include re-does the include first, because the rollback ran |
| Generate view, `resume_required` | No rollback, a neutral note with "Open analysis", and `setHalted` instead of `clearActiveStream` (`:563`, `:749`). `cast_incomplete`: the server message plus the existing rollback |
| Row phase | Comes from the server. A client-synthesised row (`:810-811`) inherits the existing row's phase, else `'cast'` |

**Books whose cast is already confirmed.** Cold boot drops halted and paused snapshots for them (`analysis-pill-gate.ts:15-21`, used at `layout.tsx:957`), and the active-analyses scan skips them (`server/src/workspace/active-analyses.ts:89`). That is deliberate (the 2026-07-14 voice-strip incident) and stays. The persistent surface for these books is the **library status plus the book-state GET**: `scan.ts:815` checks completeness before `castConfirmed`, so an incomplete book reads "analysing"; `openBook` routes "analysing" to the Analysing view (`src/store/ui-slice.ts:260-261`); that view shows the rows (hydrated from `failedChapterErrors`), "Resume analysis" and the needs-action line from `resumeRequired`. It does **not** show a halted pill or phase-card state: no snapshot survives. A main run on a confirmed book replays, attributes and persists, then routes to Confirm (`ui-slice.ts:234-237`), and must keep designed voices (invariant 6; on-box).

## 4. UI copy (run through the `castwright-voice` audit)

| Surface | Copy |
|---|---|
| Cast rows, stage1 absent | "Paused — N chapter(s) still need cast detection." "Sentence attribution starts once every chapter has a cast. Retry below; the analysis resumes on its own." |
| Cast rows, stage1 present (a main resume does not re-detect casts, `:4259`) | "Cast detection failed on N chapter(s)." "Retry detects the cast again and re-attributes that chapter." |
| Attribution rows | "Speaker attribution failed on N chapter(s)." "Retry re-runs this chapter." |
| Mixed | Per-row labels: "Cast detection" / "Speaker attribution" |
| Retry, Re-analyse, Include while main is live | Disabled; "Pause the analysis first" |
| 409 `main_analysis_running` | The server's message, on the row |
| 409 `subset_analysis_running` | The server's message, on the needs-action line |
| `resume_required` / `cast_incomplete` | The server message, on the needs-action line and in the pill |
| `resumeRequired` after a reload | "Some chapters still need attribution — resume the analysis to finish the book." |
| Generation, no narratable text (decision C) | "This chapter has no text to narrate — exclude it to finish the book." |
| Generation, worded chapter with no attributed lines (decision B) | "Speaker attribution found no lines in this chapter. Re-analyse it, or exclude it." |
| `attribution_drift` | today's message + "— or Start fresh to re-attribute every chapter." |

Drop "The model produced malformed output…" and its pause-and-retry sentence (`analysing.tsx:1778`).

## 5. Invariants

1. **No `result` and no final persist** while a non-excluded chapter outside `toRun` lacks a current take (S14). The main run's own invariant is unchanged (D1 rationale).
2. **One per-chapter predicate**, `hasCurrentTake`, decides the main replay, the subset result gate and the library; **one book-level predicate**, `analysisCompleteFor`, decides the library and `resumeRequired`.
3. **Phase is explicit:** an attribution record never overwrites a cast record; only a cast success clears `c`, and only a Phase-1 completion clears `a`; `[]` is never read as a phase.
4. **At most one analysis job per manuscript writes at a time, across kinds.** A subset POST is refused while a main writer is registered or draining; a main start is refused while a subset is registered. (Main-after-main is #3437's.)
5. **A pending take survives** the main roll and the Generate rebuild until it is replaced. A tombstoned sentence never comes back.
6. **A main run on a cast-confirmed book keeps the cast's designed voice fields** (merge via `mergeAnalysisResultWithExistingCast`; pinned by a test).
7. **No book reaches Confirm without an authoritative persist after its last take** (`takesPersisted`).
8. **Cold boot never surfaces a halted or paused pill for a cast-confirmed book** (unchanged).

## 6. Risks

- **#3436 residuals (§2.6).** Restructure stale ids (follow-up issue).
- **Re-attribution replaces hand edits.** A user's speaker edits to a pending chapter are replaced when it is re-attributed. Release-noted; a Retry has always replaced edits.
- **A worded chapter that attributes to `[]`** reaches Confirm flagged and fails at generation with the decision-B copy until the user Re-analyses or excludes it.
- **Drain time.** A Retry right after a Pause waits for in-flight calls to abort; right after a halt, for in-flight chapters to finish. On a local analyzer that is the on-box item 1.
- **`attribution_drift` dead end.** A drift-halted book no longer reaches Confirm; Resume replays the same takes and halts again. The message names Start fresh.
- **Fixtures.** On `origin/main`, 28 test call sites go through the subset route. Only tests that seed stage1 with a chapter lacking a current take **and** assert `result` or persist change. Tests that seed a finished book and then assert the library or book-state status must also seed `takesPersisted` or rely on its absence.
- **What mock mode cannot show.** `npm run dev:mock` and the Playwright harness run with no server: no refusal 409, no drain, no `resume_required`, no S14 gate. Those are covered by route tests and on-box items; the e2e spec covers only the client-side disabled state.

## 7. Interactions

- #3436 is re-scoped (§2.6).
- #3437 owns main-after-main stragglers (§2.5).
- #3412 / #3084 overflow behaviour is preserved: an overflow still halts with `fixes`, and nothing auto-resumes main after one.

## 8. Rejected alternatives and withdrawn mechanisms

| Alternative | Why rejected |
|---|---|
| A server-only id list for phase | A second list per fact, a whitelist hazard, and the client could not tell rows apart |
| Own-key completeness (v1) | Not stable under rebuild |
| Book-wide completeness gating every Retry (v2) | Unreachable on real books |
| Flagged-counts-as-settled (v3 draft) | Contradicted the main run's own rule and the library routing (D1) |
| Client-only pause | Did not stop the server's main job (a Retry only aborted the client fetch) |
| **Server pause-for-retry (old D2; withdrawn by A)** | `job.finished` could not settle during Phase 0 (C1); registering the subset after the wait left a window with neither job registered, through which a second main or subset, the upgrade gate and a "Design full cast" start could all slip (C2); restarting main from `endJob` needed the POST handler's async setup (C7); the client hand-off needed state the middleware could not reach unmounted (C5, C6, C8, C10). Everything built only for it is gone: `job.finished`, `pendingMainResume`, `startMainAnalyzerJob`, `mainResumed`, `paused_for_retry`, `retry_in_progress`, `AnalysisStateFile.mainPausedForRetry` |
| Text check for `[]` (old D3; superseded by B) | The library has no chapter bodies, so the check and its "no record" stand-in disagreed (C4), and a worded `[]` looped through Resume (C3) |
| A drain timeout instead of stopping the halted Phase-0 arm | A timeout would admit a subset next to a live Phase-0 arm writing stage1 and cast.json |
| A WeakMap phase tag on rethrows | Rethrowing pools are not the producing phase |

## 9. Open questions

None. Decisions A–C closed the three questions plan check 1 raised (a main POST during a Retry; a server-side resume on a confirmed book; 1–4-word chapters that attribute to `[]`), and the two v3 questions (included chapters with no narratable text → C; the D3 consequence → B). The interpretations at the end of §0 are stated so a reviewer can reject them, not because they are open.
