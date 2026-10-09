# Analysis failure bookkeeping: explicit phase and completeness markers

**Date:** 2026-10-03 (revised three times the same day, after plan checks 1–3 — see History)
**Status:** **Approved by owner 2026-10-03** (plan approved, O4), including decisions A–C (after plan check 1), E–H (after plan check 2) and O1–O3 (after plan check 3). Decisions are recorded in §0. No owner question is open (§9). Implementation is a new PR superseding #3439, with the normal review gate.
**Issues:**
- #3435: the defect.
- #3436: its scope is re-stated in §2.6.
- #3437: related (§2.5).
- Follow-ups to file (plan T7): restructure does not remap chapter-keyed analysis state; a better home for included chapters with no narratable text (decision C).

**Plan:** `docs/features/287-analysis-failure-phase-markers.md`.
**Supersedes:** PR #3439 (head 9a063ea6). Its tests are ported by probe name. None of its commits is cherry-picked, and no code that exists only on #3439 is assumed (§8, plan "Ported code").

**On citations — read this first.**
- Every line number is on **`origin/main` at c64943ff** (2026-10-03). Nothing is cited from #3439's head.
- c64943ff differs from the previous basis, 6f01fa20, only in test files (`git diff --stat 6f01fa20 c64943ff -- server/src src openapi.yaml` lists nothing but `*.test.ts`), so every production line number is unchanged; the test-file lines cited here were re-derived on c64943ff.
- `analysis.ts` means `server/src/routes/analysis.ts`; other files are named.
- Each citation also names a symbol or the code at that line. If `origin/main` has moved by the time you read this, find the symbol and re-derive the line; do not trust the number over the code.
- 0b4eaf24 (the base this design branch was cut from) differs only by small offsets: `analysis.ts` is 6 lines shorter after line ~560, `src/views/analysing.tsx` 5 lines shorter after line ~410. Cut the implementation branch from current `origin/main`, not from this branch's base.

**History.** v1 → v3 went through design checks 1–3; the approved v3 and its plan went through plan check 1 (`scratchpad/design-3435/check-*.md`, `check-plan-1.md`). Plan check 1 found that the v3 "pause the main run for real" mechanism (old D2) could wedge a book forever (C1) and opened a window with no job registered (C2). The owner then took decisions A–C (§0), which replace D2 and narrow D3. This revision applies them and every implementation-time finding (C9, C11–C20) that still applies; C1–C2 and C5–C8, C10 were findings against the withdrawn mechanism and are moot (§8).

Plan check 2 (`check-plan-2.md`) found that a halted main run's in-flight work does **not** settle by itself: a local Ollama call has no client timeout (`ANALYZER_DISPATCHER`, `server/src/analyzer/transports/ollama-transport.ts:56-60`, `headersTimeout: 0`, `bodyTimeout: 0`), and a halt never fired the job's signal, so a drain could hold the book, the busy flag and resident VRAM until restart (A1). It also found that `takesPersisted` demoted confirmed books (A2) and that M8c could loop (A3). The owner took decisions E–H; that revision applied them and every implementation-time item from that check (A4–A10, A15–A18, C-2…C-9).

Plan check 3 (`check-plan-3.md`, final) found that two stop paths **resolved instead of rejecting** (item A): `phase1Dispatch` returning `'skip'` on an aborted signal let a Pause between chapters stitch and persist a partial book, and the cast loop's exit on `job.halting || job.ended` let Phase 0b write a partial stage1. The owner approved the plan with item A, decisions O1–O3 and the implementation-time lines folded in by this one edit, and no fourth check (O4).

## 0. Decisions (owner, 2026-10-03)

| # | Decision | Rationale |
|---|---|---|
| A | **Refuse until paused** (replaces D2). While a main analysis job for a book is live **or still draining** after a pause or halt (§2.4), the server refuses a subset run (Retry, Re-analyse, Include) with HTTP 409, and the UI disables those actions with "Pause the analysis first". No server-side pause/resume machinery. Applied in both directions: a main start is refused while a subset run is live | The v3 mechanism had to await a "main has settled" promise that cannot settle during Phase 0 (C1: a Phase-1 worker parked in `awaitPhase1Dispatch` has no abort path, `server/src/analyzer/phase-watermark.ts:102-126`), and it opened a window where neither job was registered (C2). Refusal needs no waiting and no hand-off. A Retry while main is *not* running keeps today's behaviour |
| B | **A chapter whose final take is `[]` counts as done once the attribution step has completed for it** (supersedes D3's text check), even if it has words. It still carries its failure record, so it shows as a flagged row the user can Retry | A worded `[]` could otherwise keep a book in "Analysing" for ever, re-attributing on every Resume and looping back (C3). The text check also disagreed between readers that have the chapter body and the library, which has none (C4) |
| C | **An included chapter with no narratable text keeps its generation failure, with clearer copy**: "This chapter has no text to narrate — exclude it to finish the book." A follow-up issue is filed for a better treatment | The analysis treats such a chapter as done (it has nothing to attribute); generation must still say why it produced no audio. Auto-exclude or skip-and-count-complete are product choices deferred to the follow-up |
| D1 | **Match the main run** (amended by B). A chapter is *done* for the subset `result` gate, the main replay and the library badge only if it has a **current take** (§2.2). A flagged chapter with a take counts; a chapter with no take, or a pending (stale) take, does not | The main run reaches `result` only with every non-excluded chapter in `sentencesByChapter`: every such chapter is either replayed (`:5262-5276`) or in `taskIndices` (`:5305-5309`), and any task failure is terminal (`:5850-5866`). A "flagged = settled" rule sent an unfinished, never-persisted book to the confirm screen |
| D4 | **Withdraw "resolve on drop"** (decision (ii), 2026-10-02). **Decision (i) stands:** while stage1 is absent, an attribution-flagged chapter is re-attributed by the main run (§3.1, M1) | Keeping the record until the main Phase 1 re-attributes it is truthful |
| D5 | **A new PR supersedes #3439**, with its tests ported by probe name | Its test file is edited by 12 of 14 commits with interleaved hunks |
| E | **A halt aborts in-flight work.** Any main terminal — error, overflow, quota, cast_incomplete, drift, every `endJob` — aborts the run's in-flight calls at once, like Pause. In-flight chapters' partial work is discarded; they stay un-attributed for the next Resume or Retry. Pause can reach a job that is still draining, and the drain has a safety deadline so busy and VRAM are never held for ever (§2.4) | A halted run's calls had no bound (A1). **This supersedes #3084 P20/N4's "an overflow stops new spend, not work already in flight"** for the main route; the test that pins N4 (`analysis.reasoning-overflow.test.ts:314`, under the describe at `:288`) is rewritten (plan T3) |
| F | **Done books are never demoted.** The "no book reaches Confirm unsaved" marker applies only to a book that has never reached Confirm. A cast-confirmed or generated book keeps its status after a failed or interrupted per-chapter run; the failed chapter shows as a row with Re-analyse (§2.2, §3.4) | One interrupted Re-analyse or Include sent a generated book back to "Analysing", and Resume there runs main on a confirmed book — the voice-strip incident class (A2) |
| G | **Interpretations confirmed:** (1) a subset Retry's Phase 1 counts as the attribution step for decision B; (2) refusal applies both ways — a main *start* is refused while a subset is live, a *join* to a running main never is; (3) D3's text check is kept only to spot genuinely word-free chapters, never as a general done-test | A11, A12, C-1 |
| O1 | **Start fresh un-confirms the book.** Start fresh clears `castConfirmed`, as Re-parse already does (`applyReparse`, `server/src/routes/book-state.ts:1125`), so the book reads "Analysing" until the new run finishes and the user confirms again. Start fresh is therefore outside decision F | Start fresh discards the cast (`analysis.ts:4036-4038` removes cast.json) and the cache; a book still marked confirmed would be "done" with nothing behind it |
| O2 | **Per-chapter Re-analyse on a book past Confirm persists normally, and the unfinished chapter gets a fix button.** S14's result gate is relaxed for a book that has reached Confirm: a target chapter's result persists even while another chapter lacks a current take. The unfinished chapter's Generate-view row gets a Re-analyse control, and the Generate view learns which chapters are unfinished from the book-state GET (§3.4) | Under F such a book is never demoted, so refusing its per-chapter results would leave nothing to retry with. Today a queued or generation-failed row has no Re-analyse (`generation.tsx:1878`) |
| O3 | **Confirmed consequences:** (1) E reverses #3084 P20/N4 — an overflow halt now aborts in-flight work, not only new work; (2) a non-fresh Resume is refused while a stopped run drains; (3) a confirmed book missing one chapter's analysis no longer shows "Analysing" in the library | Recorded as accepted |
| H | **M8c only for rolling-roster dispatches.** A main run with stage1 present attributes against the final roster, so that take is current. A chapter goes into P at a Phase-1 completion only if it was dispatched while `phase1Stage1Ready` was false | The v2 rule looped: a stage1-present Resume put the chapter back in P every lap (A3) |

D2 (pause the main run for real) is **withdrawn** by A. D3 (check the chapter text for an empty take) is **narrowed** by B and G(3): the text check survives only to recognise a word-free chapter (§2.2), never to decide whether a chapter is done.

**Refusing a non-fresh Resume during a drain** (from plan check 2, C-7) is confirmed by O3(2). Once a Retry during a drain is refused, the likelier remaining two-writer path is a Resume while the previous main run still drains; the registry decision A needs makes refusing it a one-line check, and decision E makes the drain seconds long (§2.4). Start fresh (displacement) is unchanged and stays #3437's.

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
- **A halted run keeps spending, unbounded:** a halt calls `endJob` without aborting the controller (main catch `:6567-6627`), so in-flight calls run on — a local Ollama call has no client timeout (`ollama-transport.ts:56-60`) — and in pipelined mode the Phase-0 arm keeps starting cast chapters and runs Phase 0b (`runPhase0Pool`, `:4855-4884`; its loop checks only its own `castAborted`). Decision E fixes this (§2.4).
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

**Stored state, all in the analysis cache and all added to the load whitelist (`analysis-cache.ts:129-140`; the rebuild keeps them through its `{ ...prior }` spread, `analysis-cache-rebuild.ts:53`):**
- `pendingAttributionChapterIds?: number[]` — **P**, "this chapter's take predates the final roster and is known to be bad". Absent means empty.
- `takesPersisted?: boolean` — **false** means "a take was written after the last authoritative persist". Absent (legacy caches) means persisted.
- `confirmReached?: true` — set by the first authoritative persist and never cleared except with the cache. It records that the book has reached Confirm (decision F).

| Event | Effect | Site |
|---|---|---|
| Add to P | M1/S0 at load (stage1 absent): every non-excluded failed id that has an own key **including `[]`**; and M8c: a main Phase-1 completion for a chapter whose record is still `'cast'` **and that was dispatched while `phase1Stage1Ready` was false** (decision H) | §3 |
| Remove from P | Any other Phase-1 completion for the chapter, including a coverage re-flag and the word-free short-circuit | M8/M9, S9/S10 |
| `takesPersisted = false` | Every Phase-1 completion that writes a take (main or subset, including word-free) | M8/M9, S9/S10 |
| `takesPersisted = true`, `confirmReached = true` | Only when **this persist block actually wrote state.json**: a local `wroteStateJson` is set immediately after `writeStateJsonAtomic` (main `:6514`, subset `:8214`). The `try` completing is **not** enough — on `attribution_drift` it completes with the cast.json/state.json writes skipped. Saved right after the deferred rethrows (main `:6545`, subset `:8237`). Not set when the block was skipped (abort, drift) or its `catch (persistErr)` (main `:6517-6532`, subset `:8217-8229`) swallowed the state.json write's error | M17, S14 |
| Cleared with the cache | Start fresh, re-parse, book delete | `clearAnalysisCache` callers: `:4016` (fresh), `book-state.ts:1200`, `:1573`. Start fresh also writes `castConfirmed: false` (O1) |

A pending take is never deleted.

**The predicate: `hasCurrentTake(cache, id)`**, exported from `analysis-cache.ts`:

```ts
hasCurrentTake(cache, id) :=
  Object.hasOwn(cache.chapters, id) && !(cache.pendingAttributionChapterIds ?? []).includes(id)
```

It needs no chapter body. **What marks "the attribution step completed for it" (decision B)** is the pair of invariants that make an own key outside P mean exactly that:
1. **An own key is written only by a Phase-1 completion** (M8/M9 main, S9/S10 subset, both including the word-free short-circuit) or kept by the overlay rebuild from such a write. No other writer creates a key: cast failures write `chapterCast`, not `chapters`; the overlay never adds a key the edits do not carry or the prior cache did not hold.
2. **P holds every take known to predate the final roster.** M1/S0 put every failed chapter that has a key (including `[]`) into P while stage1 is absent, so a legacy `{cast record, [] take}` (C4) and a pipelined-run take made without the chapter's own cast are pending. M8c adds a chapter to P when *this* run attributed it against the **rolling** roster while its cast record stood (M14; decision H), closing the window before the next load. A take made with stage1 present is made against the final roster and is current even if a cast record stands (decision H); the record then shows as a flagged row, and a Retry re-detects the cast (S3).

A worded chapter whose take is `[]` after a completed attribution step is therefore current (decision B). It keeps its `attribution-incomplete` record from `noSentences` (`server/src/analyzer/stage2-coverage.ts:346-349`), so it shows as a flagged row.

**Book-level completeness**, both exported from `analysis-cache.ts`:

```ts
analysisCompleteFor(cache, ids) :=
  ids.length === 0 ||
  (!!cache.stage1 && ids.every((id) => hasCurrentTake(cache, id)) && cache.takesPersisted !== false)

reachedConfirm(state, cache) := state.castConfirmed === true || cache.confirmReached === true
```

**Decision F — which books the book-level rule gates.** Only a book that has **never reached Confirm**, counted since its last Start fresh or Re-parse: both clear the cache (`confirmReached`) and `castConfirmed` (O1; Re-parse at `book-state.ts:1125`), so a book restarted from scratch reads "Analysing" until the new run finishes and is confirmed again. "Has reached Confirm" is `reachedConfirm`: the book's cast was confirmed (`state.json` `castConfirmed`), or an authoritative persist has run since the cache was last cleared (`confirmReached`). A book reaches the Confirm screen only after such a persist (main `result` → `ui-slice.ts:234-237`), so the second clause is the server-side fact behind "the user was shown Confirm".
- **Legacy books** (no `confirmReached`, no `takesPersisted`): a confirmed one is covered by `castConfirmed`; an unconfirmed one has `takesPersisted` absent, which counts as persisted, so it reads as today's own-key rule would, except that a `[]` take now counts (decision B) and a pending take does not.
- **A book that has reached Confirm is never demoted** by the analysis rule: its status comes from `castConfirmed` and generation as today (O3(3)). Its unfinished chapters surface as Generate-view rows with Re-analyse instead (O2, §3.4).

| Reader | Uses |
|---|---|
| Main replay (`:5262-5276`) | `hasCurrentTake`; replays `[]` takes too (today it needs `cached.length > 0`, `:5270`) |
| Subset `result` gate (S14) | `hasCurrentTake` over every non-excluded chapter outside `toRun` |
| Library (`scan.ts:789-816`) | status `analysing` iff `!hasUsableCast` or (`!reachedConfirm` and `!analysisCompleteFor(...)`). This replaces the own-key count, which today demotes even a confirmed book (`:815` runs before the `castConfirmed` branches) |
| Book-state GET (`book-state.ts:321-326`, payload `:637`) | `stage1Ready`; `resumeRequired = !reachedConfirm && stage1Ready && !analysisCompleteFor(...)`; `unattributedChapterIds` (non-excluded chapters without a current take; amended after PR #3505 gate pass 1: for a book that has reached Confirm, a chapter whose sentences are in `manuscript-edits.json` is omitted, pending included, unless it has a failure record) (§3.4) |

**Why the book-level marker (for books not yet at Confirm).** Without it, every one of these reaches Confirm with only the interim cast.json overlay, because every take is current but the authoritative persist never ran: the post-join overflow (`throwIfReasoningOverflowed`, `:5889`); a persist-block terminal (lock timeout `:6542`, `STALE_BOOK_DIR` `:6545`); `attribution_drift`, which skips the cast.json/state.json writes (main `:6548`, subset `:8240`); a server crash between the last take and the persist. All exist on `origin/main`. With `takesPersisted` false each reads "analysing". For `attribution_drift`, a Resume replays the same takes and halts with the same verdict, so the drift message (main `:6556-6560`, subset `:8241-8245`) gains "— or Start fresh to re-attribute every chapter."

**No loop.** A worded `[]` chapter is current once attributed, so the main run sends `result`, persists, and sets `takesPersisted`; the library then reads `cast_pending`, and a later Resume replays it rather than re-attributing. A chapter re-enters P only through M1/S0 (stage1 absent; a persisted book never has that again until Start fresh) or M8c (a rolling-roster dispatch; impossible once stage1 exists, because `phase1Stage1Ready` is set from the cached stage1 before any dispatch, `:4328`). The v2 wording ("a stage1-present run cannot produce a standing cast record") was false: a main Phase-1 throw followed by a Retry whose Phase 0 fails leaves `{cast record, no take}` with stage1 present, and a Resume then attributes it (A3). Under decision H that take is current; plan T5 pins it with a test that loops under the v2 rule.

**Word-free chapters** (`!hasAttributableContent(body)`, `stage2-coverage.ts:132`). In both routes the analyzer call is replaced by a synthetic successful result (`sentences: []`, coverage ok, `chunkCount: 0`); every normal success step still runs. `origin/main` already makes no model call for such a chapter (`server/src/analyzer/stage2-chunk.ts:390`) but flags it `noSentences`, which shows a misleading row. At each route's load (M0/S0), a failed word-free chapter whose take is `[]` and whose record is `attribution-incomplete` has that record cleared. Generation then reports it with decision C's copy (§3.3).

**Rebuild becomes overlay** (`analysis-cache-rebuild.ts:32-54`), option `mode: 'overlay' | 'replace'`, default overlay. It never changes P, the records, `takesPersisted` or `confirmReached`. Today an edits file with no sentences **clears the whole cache** (`:38-44`); in overlay mode that case applies the rules below to an empty edits set instead (keeping stage1, P, records and the two flags), and only `'replace'` keeps the clear.
- Chapters the edits carry replace their prior entry **wholesale**, so a sentence the user deleted (tombstoned in `mergedAwayKeys`, `src/store/manuscript-slice.ts`, carried by `book-state.ts:341-342`) cannot come back.
- A prior chapter the edits do **not** carry is kept only if it is `[]`, or excluded in `state.json`.
- Any other prior chapter absent from the edits is an **intended removal**; its key is deleted. That chapter lacks a current take, which is unchanged from today for a chapter the user emptied.
- Restructure passes `'replace'`, because ids are renumbered (`chapters-restructure.ts:176`, `:186`).

**The main per-chapter edits roll** (`rollManuscriptEdits`, `:5766-5779`) builds from `sentencesByChapter.get(id) ?? cachedChapters[id]` over non-excluded chapters, so a pending take stays in the edits until it is replaced. The subset roll (`:7727-7737`) already builds from the cache.

**Stitching never includes a pending take.**
- **Main (M8d):** after both pools join (`:5882`) and before the stitch (`:5906-5909`), the main run re-attributes, against the final roster, every non-excluded chapter still in P. This is needed because M8c can fire inside a run that goes on to reach `result`: a chapter dispatched before Phase 0b while its re-cast (M15) was still queued is attributed against the rolling roster and put in P; its re-cast then succeeds and M4 clears the cast record, so nothing else in the run would re-attribute it, and the stitch would include its pending take (`sentencesByChapter` holds it). The pass runs those chapters sequentially through the same body (dispatched on the final roster, so M8 removes them from P); a throw there is M10.
- **Subset:** the gate refuses to stitch while any chapter lacks a current take (S14), except on a book past Confirm (O2), where no chapter can be pending: M1/S0 need stage1 absent and M8c needs a rolling roster.
- So `attribution_drift` never counts a stale take.

**How each case heals:**

| Case | Outcome |
|---|---|
| Legacy word-free key deleted by an earlier Generate | Lacks a current take. The next main run re-runs it with no model call; overlay keeps the key from then on |
| Legacy word-free chapter with a `noSentences` record | M0/S0 clears the record |
| A worded chapter that attributes to `[]` | Current (B); flagged row; generation names it (§3.3) |
| Legacy `{cast record, [] take, no stage1}` | M1/S0 put it in P; re-cast and re-attributed |
| Lost cache | No stage1; the existing first-run path |

### 2.3 What stage1 still means

"The roster is final." It gates: the main route's Phase-0 skip (`:4259`); whether a subset may attribute (`stage1Existed`); M1/S0, which apply only while stage1 is absent; M8c (via `phase1Stage1Ready`, `:4164`, set `:4328` / `:4996`); and the library's book-level clause. stage1 is never read as "attribution is done".

**Consequence of decision E for pipelined runs (A10).** A pipelined main run that halts while Phase 0 is still running aborts the in-flight cast calls and skips Phase 0b (§2.4, "Stops reject"), so it leaves **no stage1**, even if every cast chapter had already succeeded. What the user sees:
- the halted chapter's attribution row and the run-level halt message;
- **attribution rows offer no Retry while `stage1Ready` is false.** A subset run cannot attribute without a final roster (it would only re-detect that chapter's cast and end `resume_required`), so the row reads "Attributed when you resume the analysis." and the action is the existing Resume button;
- cast rows keep Retry, as today;
- Resume re-runs Phase 0 for the chapters whose cast was aborted, finalises stage1, and attributes every chapter without a current take.

A sequential run is unaffected: its Phase 1 starts only after Phase 0b wrote stage1.

### 2.4 Ending a main run aborts it (decision E); refuse until drained (decision A)

**Every ending aborts.** `endJob` (`:3162`) begins, for every kind and every ending, with:
1. `job.ended = true`;
2. `job.controller.abort()` unless already aborted (harmless on a `result`: nothing is in flight then);
3. for a main job, `job.watermark.releaseAll()` — a new `PhaseWatermark` method (interface `phase-watermark.ts:42`; both implementations, `createPhaseWatermark` `:65` and `createSequentialWatermark` `:144`) that resolves every parked `awaitPhase1Dispatch` waiter. The job's watermark (`createWatermarkForJob()`, `:3836`) is stored on the job for this.

Every main terminal path already ends in `endJob` — the main catch (`:6567-6627`: `aborted`, `STALE_BOOK_DIR`, every classified error including overflow and quota), `cast_incomplete` (`:5897`), the re-verify shrink refusal (`:4299`), `attribution_drift` (`:6556`) and `result` (`:6564-6565`) — so decision E holds on all of them by construction. Plan T3 has one test per path.

**The halt decision comes before `endJob`.** The Phase-1 pool catch (`:5850`) and the cast pool catch (`:4873`) set `job.halting = true` synchronously, before any `await` (T2's guarded save is one). Both pool loops (`:4866`, `:5846`) and `phase1Dispatch` stop on `job.halting || job.ended`, so no chapter starts between the halt decision and `endJob`.

**Stops reject; they never resolve (plan check 3, item A).** A pool that stops early must not let the run carry on as if it had finished:
- `phase1Dispatch` **throws `AnalysisAbortedError`** when the signal is aborted (a Pause that lands between chapters, when no call is in flight to throw it). It returns `'skip'` only for `phase0FailedCount > 0`, `job.halting`, `job.ended` and the pool-local `aborted` — every one of which means a sibling has already rejected or the job has ended, so the run cannot reach the stitch.
- **Phase 0b runs only after every cast task ran.** After the cast join (`:4884`), the arm throws `AnalysisAbortedError` if the signal is aborted, and **returns without Phase 0b** if `job.halting || job.ended` (the Phase-1 arm has already rejected). A loop that exited early therefore never writes a partial stage1 or cast.json.
- **Abort check before the main persist:** `if (job.controller.signal.aborted) throw new AnalysisAbortedError()` immediately before the persist block (`if (record.bookDir) {`, `:6188`). The fold, the non-story classifier and the Phase-2 stub (`:5935-5940`, whose timeouts ignore the signal) run between the pool join and the persist, and a Pause landing there must end `aborted` with nothing persisted. The subset already skips its persist on `!isAborted()` (`:7989`) and gains S14a.
- **The non-story classifier gets the job signal:** its `nonStoryCall` (`:2498`) is `{ language }` today; it gains `signal: job.controller.signal`, so the abort reaches that call too. The controller is **not** aborted in the pool catch: sibling chapters would then reject with `AnalysisAbortedError`, which can reach `Promise.all` (`:5882`) first and be classified as a pause. Aborting at `endJob` keeps the halt's own error as the terminal.

**What happens to in-flight chapters.** An aborted call throws `AnalysisAbortedError`; the chapter body exits without caching; nothing is recorded (an abort is not a failure, M12). The chapter has no new take and is attributed by the next Resume or Retry. A body whose model call had already returned finishes its save, because it makes no further call. This **supersedes #3084 P20/N4** ("an overflow stops new spend, not work already in flight") for the main route; the comments that state N4 (`:5838-5841`, `:5853-5857`) become false and are corrected in T3. The subset route is sequential, so its single in-flight call has already ended when its `endJob` runs.

**Job fields.** `AnalysisJob` (`:2706`) gains `ended`, `halting`, `left` (booleans), `liveWork` (number) and `watermark?`. The first four are initialised (`false`/`0`) in both job literals (main `:3567-3584`, subset `:6906-6924`); `__testRegisterJobForTest` (`:2792`) fills them for hand-built test jobs. `watermark` is **optional**: `endJob` can run before `createWatermarkForJob()` (`:3836`) — the `language_unset` terminal does, at `:3767` — so `endJob` calls `job.watermark?.releaseAll()`.

**Writers.** A new in-memory registry, `mainWritersByManuscript: Map<manuscriptId, Set<AnalysisJob>>`, next to the job maps (`:2764-2770`).
- A main job **joins** in the same synchronous block as `inFlightAnalysisByManuscript.set` (`:3585`).
- It **leaves** through `leaveWriters(job)`, which is idempotent (`job.left`) and runs when `job.ended && job.liveWork === 0`. It is called from three places: `endJob` itself (when `liveWork` is already 0), the `finally` of every tracked unit, and the drain deadline below.
- On leave, exactly once: remove from the set (delete the entry when empty), log `[analysis] main run drained manuscript=<id>`, and — for a main job only — run `clearAnalysisBusy` (`:3323`) and the local-Ollama evict (`:3333-3337`), which move here from `endJob`. The `job.left` guard is what makes the busy release happen exactly once; the comment at `:3309-3311` explains why a second clear underflows the ref count. A subset job releases both in `endJob`, as today.
- A displaced main job (Start fresh, `:3532-3538`) is no longer in `inFlightAnalysisByManuscript` but stays a writer until it leaves.

**Live work (`job.liveWork`).** Tracked:
1. each `runCastChapter(i)` call in the Phase-0 pool (`launchNextCast`, `:4865-4878`);
2. the Phase-0 arm itself (`phase0PoolPromise`, `:5101`), which covers Phase 0b's stage1 and cast.json writes;
3. each Phase-1 chapter **body**. Its token is taken **inside** `phase1Dispatch`, in the same synchronous block as its last checks, immediately before it returns `'run'` — no `await` separates the checks from the increment (A5 gap 1). The body releases it in a `finally`.

**Not tracked: a Phase-1 worker parked in `awaitPhase1Dispatch`** (`:5402`). It is woken by its own job's `markPhase0AllDone` (`:4329`, `:4931`, `:5092`) and, in pipelined mode, by `markPhase0ChapterComplete` whenever the watermark advances (`phase-watermark.ts:85-92`, called at `:4751`) — and now by `releaseAll`. After the `await`, `phase1Dispatch` throws `AnalysisAbortedError` if the signal is aborted, and returns `'skip'` if `job.ended`, `job.halting` or the **pool-local `aborted`** flag (`:5843`) says so (A5 gap 2; item A). So a woken worker never writes, and `releaseAll` guarantees every parked worker wakes once its job ends: no leak (A10), and no promise the drain could wait on for ever (the C1 fact).

**Draining, re-derived.** A main writer drains from `endJob` until it leaves: the time for each tracked unit to observe the abort and run its `catch`/`finally`. Under decision E that is the abort latency of the in-flight calls — a `fetch` rejects at once on abort; a multi-call chapter body (sections, coverage retries, escalation windows) checks the signal at its next call — not the length of a chapter (C-4).

**Safety deadline.** `MAIN_DRAIN_DEADLINE_MS = 60_000`, a constant (not a setting). `endJob` on a main job with `liveWork > 0` arms an `unref()`'d timer. If the job has not left when it fires: log `[analysis] main run drain deadline exceeded manuscript=<id> liveWork=<n>` and call `leaveWriters`. So neither the busy flag, the Ollama pin (`isAnyAnalyzerRunBusy` → `keepAliveFor`) nor resident VRAM can be held more than 60 s past a job's end. Every reader of the busy flag sees it for up to that long after a job ends: `ollama-settings.ts:76`, `ollama.ts:91`, `script-review.ts:1066`, `cast-design.ts:793`, `book-state.ts:977`, `:1012`, `gpu/gpu-load.ts:73`, `routes/accelerator-profile.ts:36`, `tts/persona-gpu-plan.ts:34`. All treat "busy" as "wait or refuse", which is the intended behaviour during a drain. A unit that ignored the abort could still write after the deadline; that is logged and named in §6.

**Pause and a draining job.** `/pause` (`:6638-6662`) also walks the manuscript's writer set and aborts any controller not yet aborted. Under decision E an ended job is always already aborted, so this only makes Pause idempotent over a drain; it writes no snapshot for an ended job (its `endJob` already wrote the terminal one) and never resets the deadline.

**Server refusals — two checks per route (A4).**
- **Early:** synchronously before `res.flushHeaders()` (main `:3391`, subset `:6716`): an HTTP 409 with a JSON body (precedent: the main route's `language_unset` 409, `:3370-3383`).
- **Late:** again in the **same synchronous block as registration** (main `:3585`, subset `:6925`), because both routes `await` before registering (`getOrHydrateManuscript` `:3428` / `:6737`; `readAnalysisLastOutcome` `:3499`). Headers are flushed by then, so the late refusal is an SSE terminal `error` frame with the same `code` and `message`; no job is registered and no snapshot written.
- **Both client readers map either form to `AnalysisError(message, code)`**: the HTTP form in their `!res.ok` branch, the SSE form through their existing `kind: 'error'` branch. Callers handle one shape.

| Request | Refused when | `code` / body |
|---|---|---|
| Subset POST (`/analysis/chapters`, `:6677`) | the manuscript has a main writer, registered or draining | `main_analysis_running`, `draining: boolean` — always present, `false` for a live run, in both the HTTP body and the SSE frame. Live: "The analysis is still running on this book. Pause it first, then try again." Draining: "The analysis on this book is still stopping. Try again in a moment." |
| Main POST (`/analysis`, `:3340`) that would **start** a job (no live main to join, or `fresh: true`) | a subset job is registered | `subset_analysis_running`: "A chapter retry is running on this book. Wait for it to finish, then resume the analysis." |
| Main POST that would start a job **without** `fresh` (extension, §0; C-7) | a previous main writer for the book is still draining | `main_analysis_running`, `draining: true`, the draining message |

A main **join** (subscribe to a live main job) is never refused (decision G2).

**Upgrade gate (A9).** `activeAnalysisManuscripts` (`:2800-2809`, read by `server/src/upgrade/busy-probe.ts:24`) also returns every manuscript with a draining writer, so an upgrade restart cannot land mid-drain.

**The subset route needs no drain state.** It is sequential, does no detached chapter work, and deregisters synchronously in `endJob` (`:3302-3305`), in the same tick as its subscribers' responses end (`:3285-3301`), so a client that saw the subset end can start main at once. A Pause during a subset's fold or persist reaches `endJob` only at its next abort-aware step, so a Resume clicked in that window gets `subset_analysis_running` (A12; confirmed acceptable).

**The client cannot see a drain (C-2).** The UI disables Retry, Re-analyse and Include only while it knows main is live. With decision E a drain lasts seconds; a click inside it gets the draining 409, whose message lands on the row.

**Server restart:** the registry is in memory, so it is empty after a restart, and so is every job. Nothing to recover.

### 2.5 Interaction with #3437 (run epoch)

An epoch identifies a run; a current take describes cache contents. One marker cannot serve both. Decisions A and E close the main-vs-subset straggler path and, with the §2.4 extension, a non-fresh Resume during a drain. #3437 still owns **Start fresh displacement**: a `fresh: true` POST aborts the live run and starts at once, so the displaced run's last in-flight units can overlap the new one for up to their abort latency.

### 2.6 What #3436 still owns

Decision A makes main and subset jobs on one manuscript mutually exclusive on the server, which closes #3436's "main vs subset" question. Still open, all pre-existing, each the same refuse-or-merge decision. These are every route found that writes a live job's files with no analysis exclusion (C-9):
- **manuscript-edits.json:** the book-state PUT (`book-state.ts:740`, edits write `:786`; it also writes cast.json `:765`); restructure (`chapters-restructure.ts:176`, `:186`); cast-merge (`cast-merge.ts:229`) and its accept path in `cast-merge-suggestions.ts`.
- **The analysis cache:** the rebuild in `generation.ts:1020` (no busy check), `chapter-splice.ts:249`, `chapter-qa-repair.ts:403`; `cast-merge.ts:377`.
- **state.json and the live `record.chapterHints`:** the exclude toggle (`book-state.ts:1424`), which an Include calls *before* its subset POST (`generation.tsx:446`), so a second device that did not know main was live rewrites the hints a running main reads before the 409 arrives (A17); `samples.ts:128`.
- **cast.json writers that serialise with the analysis persist's locked write but not with its run-start merge base** (the #2015 stale-merge-base class): `cast-aliases.ts:167`, `:277`, `:366`, under `withCastLock` (`:109`, `:240`, `:331`; it also reads edits, `:175`, `:281`); `library-cast-override.ts:123`, `:165`, `:168`, under `withCastLocks` (`:98`). The other `cast-*`/voice routes are the same shape.
- **Checked and not writers of these files:** `annotate-emotion.ts` (streams only, header `:3`); `info.ts` (writes upgrade metadata, `:169`).

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
| M8c | Phase-1 completion while `F(x)=c`, for a chapter **dispatched while `phase1Stage1Ready` was false** (pipelined, M14; decision H). `phase1Dispatch` records the flag at dispatch | `c` kept | **add** to P; cache; `takesPersisted=false` | — |
| M8d | After both pools join, before the stitch | as M8 / M9 / M10 | every non-excluded chapter still in P is re-attributed on the final roster (§2.2) | as M8 / M9 / M10 |
| M9 | Coverage re-flag | `record(a)`, cast dominates | as M8 / M8c | `chapter-failed` with the effective record |
| M10 | Throw from the chapter's own call | `job.halting = true` first (before any `await`); then `record(a)` with `{chapter}`; guarded save; `job.failingPhase ??= 1` | unchanged | `chapter-failed`, then terminal; `endJob` aborts every in-flight call (E) |
| M11 | Phase-1 dispatch | none | see note | terminal on overflow |
| M12 | Abort (Pause, or the abort `endJob` fires on a halt) | none; the aborted chapter keeps no new take | — | `aborted` for a Pause; a halt keeps its own terminal |
| M13 | Post-join overflow (`:5889`) | none | `takesPersisted` stays false | terminal |
| M13a | Pause after the pools join (fold, classifier, Phase-2 stub) | none | the abort check before the persist (`:6188`) throws; nothing persisted | `aborted` |
| M14 | Pipelined: cast-failed chapter attributed in the same run | `c` kept | M8c | — |
| M15 | Resume after M14 | M3 re-casts; M4 clears | it is in P, so it is re-attributed | `chapter-resolved` |
| M16 | `attribution_drift` (`:6548-6563`) | — | `takesPersisted` stays false | unchanged code; message gains the Start-fresh clause |
| M17 | Result (`:6564`) | — | `takesPersisted = true`, `confirmReached = true` iff this block wrote state.json (`:6514`); `analysis-state.json` deleted by `endJob` | `result` |

**Dispatch note (M11).** The dispatch becomes `phase1Dispatch(i): Promise<'run' | 'skip'>` — the first part of `runChapter` (`:5390-5415`): `awaitPhase1Dispatch`, the `phase0FailedCount` return (now `'skip'`), a new `job.ended || signal.aborted` check (`'skip'`), and the overflow check. It runs **outside** the recording catch:

```ts
let verdict: 'run' | 'skip';
try { verdict = await phase1Dispatch(i, () => aborted); }     // takes the liveWork token on 'run'
catch (e) { inFlight.delete(i); aborted = true; job.halting = true; throw e; } // never ran: no record
if (verdict === 'skip') continue;
try { await runChapterBody(i); }                               // the recording catch wraps this only
finally { releaseWork(job); }                                  // T3; T2 has no token yet
```

After its `await awaitPhase1Dispatch(i)`, `phase1Dispatch` **throws `AnalysisAbortedError` on `signal.aborted`** (item A), returns `'skip'` on `phase0FailedCount > 0`, `job.halting`, `job.ended` or the pool-local `aborted` (passed in); it rethrows a recorded overflow; otherwise, in the same synchronous block, it notes `dispatchedOnFinalRoster = phase1Stage1Ready` for M8c, increments `job.liveWork` and returns `'run'`. This also covers a chapter's own Phase-0 overflow being rethrown at its own Phase-1 dispatch.

**Terminal label** (`classifyAnalysisFailure(e, analyzerLabel, …)`, main `:6623`, subset `:8287`):
- For an overflow, the label of `job.reasoningOverflowPhase`. `noteReasoningOverflow` (`:2453`) gains `phase: 0 | 1`, stored with `??=`. Its seven callers: `:2510`→0 (the non-story classifier, which both routes build with the Phase-0 `analyzer`, `:3782`, `:7018`), `:4688`→0, `:5525`→1, `:5858`→1, `:7375`→0, `:7604`→1, `:7646`→1.
- Otherwise, `job.failingPhase === 1` → the Phase-1 label; else `analyzerLabel`.
- The Phase-1 label is declared inside the try today (`phase1AnalyzerLabel`, main `:3813`, subset `:7023`); hoist a `let` to function scope next to `analyzerLabel` (`:3744`, `:6991`) so the catch can read it.
- `{chapter}` is passed for the overflow row.

**ETA (minor).** `remainingNonCachedChars` (`:5198-5208`) skips any chapter with a cached take; it switches to `hasCurrentTake`, so a pending chapter counts as remaining.

**Decision (i).** The rule marks only *failed* chapters, because a record is evidence the take is bad. A successful pipelined run deliberately accepts unflagged takes made against the rolling roster (Plan 88).

### 3.2 Subset route

The subset makes three separate decisions:
- **Run at all** iff no main writer exists for the manuscript (§2.4).
- **Attribute the targets** iff stage1 existed at load, the gate passes and coverage is complete.
- **Send a result and do the final persist** iff every non-excluded chapter outside `toRun` has a current take (D1), or the book has reached Confirm (O2).

| # | Event | Record | P / takes / stage1 | Outcome |
|---|---|---|---|---|
| S−1 | POST while a main writer exists (checked before `flushHeaders` and again at registration) | — | — | `409 main_analysis_running`, or the same code as an SSE `error` frame from the late check (§2.4); no job registered |
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
| S14a | Aborted after the loop (a Pause landed after the last chapter; today the persist is skipped by `!isAborted()`, `:7989`, but `result` is still sent, `:8249`) | — | no persist | `endJob(error aborted)` (A18) |
| S14 | Result gate (before the stitch, `:7763`). **On a book past Confirm (`reachedConfirm`, read at load) the gate always passes (O2)**: the targets' takes persist and `result` is sent even while another chapter lacks a current take; that chapter stays a Generate-view row with Re-analyse | — | **Every other chapter current (or the book is past Confirm):** stitch, full persist (`:7989-8237`), `takesPersisted = true`, `result` (`:8249`), then delete a `subset`-kind `analysis-state.json`. **Otherwise:** no fold, no authoritative cast.json, state.json, provenance or cast-id-history write, no final folded edits | `result`, or `endJob(error resume_required)`: "<titles> re-analysed. <missing titles> still need attribution — resume the analysis to finish the book." |

**What S14 does not undo.** These writes landed earlier in the run and stay; they are the same partial-progress writes a main run makes: the interim cast.json overlay (`:7334-7360`); the per-chapter edits roll (`:7727-7737`); the cache. The next authoritative persist supersedes them. Until then the library reads "analysing" (`takesPersisted` false), so the book cannot be generated from them through the normal flow.

**The probes under these rules:**
- **P-delta:** a Retry of ch2 attributes ch2. ch3 has no take, so the run ends `resume_required`. A main resume finishes the book.
- **P-eta:** the Retry of ch1 runs S0 (P = {1, 2}), then S8. A Retry of ch2 attributes ch2, but ch1 is still pending, so it ends `resume_required`. The main resume re-attributes ch1, then sends `result`.
- **P-beta:** S8, then the armed auto-resume (§3.4).

### 3.3 Other events

| Event | Effect |
|---|---|
| Start fresh / re-parse / delete | Cache cleared (P, `takesPersisted` and `confirmReached` with it). **Start fresh also writes `castConfirmed: false`** to state.json (O1), through the same `writeStateJsonAtomic` path re-parse uses (`book-state.ts:1125`), inside the fresh branch (`:4015-4062`) before the run starts; the book reads "Analysing" until the new run persists and the user confirms |
| Include / Exclude | No cache change. An Include target is attributed whenever stage1 exists, so an Include ending `resume_required` needs **no rollback**. An Include refused with 409, or ending S5, S6 or S7, keeps today's rollback (`rollbackInclude`, `generation.tsx:534`) |
| Generate / splice / QA-repair | Overlay rebuild (§2.2) |
| Generate, a chapter whose take is `[]` (`generation.ts:1394-1403`) | **Decision C.** Own key, `[]`, **no** failure record (word-free): "This chapter has no text to narrate — exclude it to finish the book." Own key, `[]`, **with** a record (worded, decision B): "Speaker attribution found no lines in this chapter. Re-analyse it, or exclude it." No own key: today's "analysis cache is incomplete" copy. The chapter still fails; nothing else changes |
| Restructure | `'replace'` rebuild. Records, `chapterCast` and P stay keyed by old ids: pre-existing, follow-up issue |
| Snapshot writes vs. terminal deletes (C19, A6) | `writeAnalysisState` and `deleteAnalysisState` (`server/src/store/analysis-state.ts:101-114`, `:122-131`) move onto the per-path op chain the cache already uses (`writeJsonAtomicOrdered`, `enqueuePathOp`; `analysis-cache.ts:146-165`), so they land in call order. `persistRunningSnapshot` (`:2924-2962`) resolves the book dir asynchronously (`withVerifiedBookDir`, `:2939`) before writing, so an early `job.ended` check is not enough: the check moves **inside the enqueued op**, after resolution, immediately before the write. `endJob`'s own terminal write and delete are enqueued after `job.ended` is set, so a running snapshot can no longer land after them. S14's "delete a `subset`-kind snapshot" reads, checks and unlinks inside **one** enqueued op |

### 3.4 Client

**New and changed codes:**
- Not-a-failure halts: `cast_incomplete`, `stage1_shrink_refused` (today) and `resume_required` (new) — `isNotAFailureHaltCode`, `src/lib/analysis-phase-state.ts:11-13`.
- Refusals, which never start a job: `main_analysis_running` (subset POST) and `subset_analysis_running` (main POST).

| Layer | Change |
|---|---|
| `src/lib/api.ts` | `realRunAnalysisForChapters` (`:5649-5682`) reads the body of a non-OK response: a 409 `{error:'main_analysis_running'}` throws `AnalysisError(message, 'main_analysis_running')`; anything else keeps `ANALYSIS_STREAM_FAILED`. `realAnalyseManuscript`'s non-OK branch (`:2943-2966`) does the same for `subset_analysis_running` and `main_analysis_running`, after the existing `language_unset` branch. The late-check SSE `error` frame with the same code already becomes the same `AnalysisError` through each parser's `kind: 'error'` branch; both forms are tested. Both parsers carry `phase` on `chapter-failed` (§2.1) |
| `openapi.yaml` | `/analysis/chapters` (`:601`) gains a `'409'` response with `{error, draining, message}`; `/analysis` (`:589-599`) widens its 409 description and body to include `subset_analysis_running` with `message`; `AnalyseErrorEvent`'s route-code list (`:5634-5636`) adds `resume_required`; `analysis` in the book-state GET (`:8201-8220`) gains `phase`, `stage1Ready` and `resumeRequired` |
| Selector | `selectMainAnalysisLive(state, manuscriptId)` in `src/store/analysis-slice.ts`: `activeStream` is for this manuscript, `kind !== 'subset'`, `state === 'running'` |
| Analysing view, Retry (`handleRetryChapter`, `analysing.tsx:856-1131`) | **Disabled** while main is live — the view's own main stream (`isAnalysisRunning`, `:1298`, while `retryingChapterId === null`) or `selectMainAnalysisLive`. The button shows "Pause the analysis first" as its tooltip and as a line under the row list. The pause-and-retry branch (`pausedMainForRetry`, `:879-885`, and its resume in the `finally`, `:1102-1131`) is **deleted**. A 409 `main_analysis_running` is handled like `subset_in_progress` today (`:1004-1035`): restore the prior snapshot, keep the row, show the server's message on it. **Not-a-failure endings keep their halt (A8):** a catch that dispatched `setHalted` for `cast_incomplete`, `stage1_shrink_refused` or `resume_required` sets `retryNeedsActionRef` (reset at Retry start next to `retryHaltedRef`, `:862`), and the `finally` returns before its `clearActiveStream()` (`:1130`), as it already does for `retryHaltedRef` |
| Analysing view, main catch (A7) | `subset_analysis_running` / `main_analysis_running`: restore the snapshot captured **before** the effect's own `setActiveStream({state:'running'})` (`:509-525`) — as the `subset_in_progress` branch does (`:1016-1028`) — or `clearActiveStream()` if there was none; then `setConn('idle')`, `setAnalysisStarted(false)`, and show the server's message on the needs-action line; no `setHalted`, no toast. Without the restore, `selectMainAnalysisLive` would stay true on this device and grey out its own Retry with no run going |
| Generate view, Re-analyse and Include (`handleReanalyse` `:620`, `handleToggleExcluded` `:369`) | **Disabled** while `selectMainAnalysisLive`, with the same "Pause the analysis first" copy. A 409 is handled like `subset_in_progress` (`:529-561`, `:730-746`): restore the prior snapshot, `patchSubset(id, {error: message})`; Include also rolls back |
| Middleware (`src/store/analysis-stream-middleware.ts`) | `main_analysis_running` / `subset_analysis_running` on a subscribe POST: `closeHandle()`, then **restore the snapshot from the server**: re-read `api.getAnalysisState(bookId)` and dispatch `setActiveStream` from it (the layout's cold-boot shape, `layout.tsx:948-980`, including its confirmed-book gate), or `clearActiveStream()` when it returns null. Never `setPaused` (its hook fires `/pause`, which would abort a live subset). Without the restore, a stale `running` main snapshot keeps `selectMainAnalysisLive` true and the pill stalls. Subset handle plus a not-a-failure code: `setHalted`, no toast |
| Cold boot (C9) | The rehydrate effect (`analysing.tsx:322-334`) sets `analysisStarted` only for a running snapshot whose `kind !== 'subset'`. A running **subset** snapshot never POSTs the main route; the rows come from the book-state GET as usual. A Retry clicked then joins the live subset (same chapter set, `:6816-6832`) or is told `subset_in_progress` |
| Needs-action line | `phase-card.tsx:488-491` is an icon only. Add one line under the phase card: `activeStream.haltReason` for a not-a-failure code; otherwise, when the book-state GET says `resumeRequired`, the copy in §4 |
| Book-state GET (C18, C20, F) | `analysis.stage1Ready = !!cache.stage1`; `analysis.resumeRequired = !reachedConfirm && stage1Ready && !analysisCompleteFor(...)`; `analysis.unattributedChapterIds` (post-review amendment, PR #3505 gate pass 1: for a book that has reached Confirm it omits any active chapter whose sentences are in `manuscript-edits.json`, pending included, because generation rebuilds the cache from the edits on every Generate request; a chapter with a failure record keeps its gap; before Confirm it is unchanged). Server facts, so they survive a reload and a dropped snapshot (`src/lib/analysis-pill-gate.ts:15-21`). `resumeRequired` is never true on a book that has reached Confirm, so no Resume is offered there (voice-strip class) |
| Refresh policy (C-8) | The Analysing view reads the book-state GET on mount and again after **every** run ending it observes (main or subset; bump a key in the deps of the failed-chapter hydrate effect, `:780-823`). `stage1Ready` and `resumeRequired` drive **copy and affordances only**; they never arm or disarm the auto-resume, so a fresh `stage1Ready: true` after S8 cannot break P-beta |
| `castIncomplete` arming (C20, C-8) | Armed (a) by this session's main `cast_incomplete` catch (`:707-712`; stage1 is absent by construction, M7), or (b) on mount from a halted `cast_incomplete` snapshot of **either** kind **when the mount-time `stage1Ready` is false**. Never armed from a later refresh. The cast-row copy is chosen by the latest `stage1Ready` |
| Attribution rows while `stage1Ready` is false (A10) | No Retry button; the row reads "Attributed when you resume the analysis." Cast rows keep Retry. When `stage1Ready` turns true, attribution rows get Retry back |
| Start/Resume label (C18) | Reads "Resume analysis" when `resumeRequired` (as well as when `hasStartedOnceRef`, `:1393-1397`) |
| Pill (`src/components/top-bar.tsx:172`, data `layout.tsx:1541-1582`) | For a subset in needs-action, show `haltReason` instead of "Retrying N chapters" |
| Auto-resume (`:832-837`) | `castIncomplete && analysisStarted && castRows === 0 && retryingChapterId === null`, where `castRows` counts rows whose phase is `'cast'`. Attribution rows do not block it. It covers an armed run that ended `cast_incomplete` (P-beta). It can never fire while a subset is registered: the Retry's `finally` runs after the subset deregistered (§2.4) |
| Subset shrink (Analysing) | Catch: `setStage1ShrinkInfo({prev, next, retryChapterId})`. Accept (`:1743`) calls `handleRetryChapter(id, {allowStage1Shrink: true})`, which re-runs Phase 0 for that chapter (accepted cost). Main re-entry clears only a **main** shrink banner (`:498` becomes `if (!info?.retryChapterId)`) |
| Subset shrink (Generate) | `generation.tsx:517-566` and `:718-751` have no banner. Add an inline "Accept smaller cast" action on the row that re-runs the same subset with `allowStage1Shrink: true`. An Include re-does the include first, because the rollback ran |
| Generate view, `resume_required` | No rollback, a neutral note with "Open analysis", and `setHalted` instead of `clearActiveStream` (`:563`, `:749`). `cast_incomplete`: the server message plus the existing rollback |
| Generate view, unfinished chapters on a book past Confirm (F, O2) | **Signal:** the Generate view never calls `getBookState`; the book-state GET is fetched by the layout (`layout.tsx:829`) and hydrated into the chapters slice (`chaptersActions.hydrateFromBookState`, `:878`). That hydrate also carries `analysis.unattributedChapterIds` and `analysis.failedChapterErrors` into a new chapters-slice field, `analysisGapById: Record<number, {message: string}>`; a subset `result` for a chapter clears its entry, a subset failure sets it. **Row:** a chapter with an entry shows an analysis note ("Analysis didn't finish for this chapter." or the record's message) **and a Re-analyse control** whatever its generation state — today Re-analyse renders only for `done` or message-less `failed` rows (`:1878`, button `:1928-1939`), so a queued or generation-failed row has none. The control reuses `onReanalyse` and the same disabled rules (subset in flight; main live). The book's status is not touched |
| Row phase | Comes from the server. A client-synthesised row (`:810-811`) inherits the existing row's phase, else `'cast'` |

**Books that have reached Confirm (decision F).** Cold boot drops halted and paused snapshots for confirmed books (`analysis-pill-gate.ts:15-21`, used at `layout.tsx:957`), and the active-analyses scan skips them (`server/src/workspace/active-analyses.ts:89`). That is deliberate (the 2026-07-14 voice-strip incident) and stays. Such a book is **never demoted** by the analysis rule: the library keeps `cast_pending` / `voices_pending` / `generating` / `complete`, so `openBook` never sends it to the Analysing view because of an interrupted Retry, Re-analyse or Include (`ui-slice.ts:259-262`). Its unfinished chapters show on their Generate-view rows with Re-analyse (§3.4). A main run on a confirmed book happens only when the user deliberately opens the analysis; it replays, attributes and persists, then routes to Confirm (`ui-slice.ts:234-237`), and must keep designed voices (invariant 6; on-box).

A book that has **not** reached Confirm keeps the v2 behaviour: an incomplete one reads "analysing"; the Analysing view shows the rows (from `failedChapterErrors`), "Resume analysis" and the needs-action line from `resumeRequired`.

## 4. UI copy (run through the `castwright-voice` audit)

| Surface | Copy |
|---|---|
| Cast rows, stage1 absent | "Paused — N chapter(s) still need cast detection." "Sentence attribution starts once every chapter has a cast. Retry below; the analysis resumes on its own." |
| Cast rows, stage1 present (a main resume does not re-detect casts, `:4259`) | "Cast detection failed on N chapter(s)." "Retry detects the cast again and re-attributes that chapter." |
| Attribution rows, stage1 present | "Speaker attribution failed on N chapter(s)." "Retry re-runs this chapter." |
| Attribution rows, stage1 absent (A10) | "Speaker attribution failed on N chapter(s)." "Cast detection hasn't finished for the whole book, so these chapters are attributed when you resume the analysis." Per row: "Attributed when you resume the analysis." |
| Mixed | Per-row labels: "Cast detection" / "Speaker attribution" |
| Retry, Re-analyse, Include while main is live | Disabled; "Pause the analysis first" |
| 409 `main_analysis_running` | The server's message, on the row |
| 409 `subset_analysis_running`, or `main_analysis_running` on a Resume during a drain | The server's message, on the needs-action line |
| Generate view, unfinished chapter on a book past Confirm | "Analysis didn't finish for this chapter." (or the record's message) + Re-analyse |
| `resume_required` / `cast_incomplete` | The server message, on the needs-action line and in the pill |
| `resumeRequired` after a reload | "Some chapters still need attribution — resume the analysis to finish the book." |
| Generation, no narratable text (decision C) | "This chapter has no text to narrate — exclude it to finish the book." |
| Generation, worded chapter with no attributed lines (decision B) | "Speaker attribution found no lines in this chapter. Re-analyse it, or exclude it." |
| `attribution_drift` | today's message + "— or Start fresh to re-attribute every chapter." |

Drop "The model produced malformed output…" and its pause-and-retry sentence (`analysing.tsx:1778`).

## 5. Invariants

1. **No `result` and no final persist** while a non-excluded chapter outside `toRun` lacks a current take (S14), **except on a book past Confirm** (O2), where the targets persist and the gap stays a Generate-view row. The main run's own invariant is unchanged (D1 rationale).
2. **One per-chapter predicate**, `hasCurrentTake`, decides the main replay, the subset result gate and the library; **one book-level predicate**, `analysisCompleteFor`, decides the library and `resumeRequired`.
3. **Phase is explicit:** an attribution record never overwrites a cast record; only a cast success clears `c`, and only a Phase-1 completion clears `a`; `[]` is never read as a phase.
4. **At most one analysis job per manuscript writes at a time**, across kinds and across non-fresh main runs. A subset POST is refused while a main writer is registered or draining; a main start is refused while a subset is registered; a non-fresh main start is refused while a previous main writer drains. (Start fresh displacement is #3437's.)
5. **A pending take survives** the main roll and the Generate rebuild until it is replaced. A tombstoned sentence never comes back.
6. **A main run on a cast-confirmed book keeps the cast's designed voice fields** (merge via `mergeAnalysisResultWithExistingCast`; pinned by a test).
7. **No book reaches Confirm without an authoritative persist after its last take** (`takesPersisted`), and **no book that has reached Confirm is demoted** by the analysis rule (`reachedConfirm`).
8. **Cold boot never surfaces a halted or paused pill for a cast-confirmed book** (unchanged).
9. **A stop rejects; it never resolves.** A Pause or halt never lets a run stitch, persist or write stage1 (item A). **Every job ending aborts the job's controller**, so no model call outlives its run; a drained writer leaves exactly once, and no writer is held past `MAIN_DRAIN_DEADLINE_MS`.
10. **A take made against the final roster is current** (decision H); only a rolling-roster dispatch can put a chapter back in P.

## 6. Risks

- **#3436 residuals (§2.6).** Restructure stale ids (follow-up issue).
- **Re-attribution replaces hand edits.** A user's speaker edits to a pending chapter are replaced when it is re-attributed. Release-noted; a Retry has always replaced edits.
- **A worded chapter that attributes to `[]`** reaches Confirm flagged and fails at generation with the decision-B copy until the user Re-analyses or excludes it.
- **Drain time.** A Retry right after a Pause or a halt waits for in-flight calls to observe the abort — seconds on a responsive analyzer. On a local analyzer that is on-box item 1.
- **The drain deadline.** A unit that ignores the abort signal can still write after `MAIN_DRAIN_DEADLINE_MS`; the deadline log line names it. This is the only way the "one writer" invariant can be broken, and it trades that against holding busy and VRAM for ever.
- **Halted work is discarded (E).** A halt during a long chapter throws away that chapter's in-progress call; Resume re-runs it. This reverses #3084 P20/N4 on the main route.
- **Pipelined halts leave no stage1 (A10).** Attribution rows then wait for Resume (§2.3).
- **`attribution_drift` dead end** (books not yet at Confirm). A drift-halted book no longer reaches Confirm; Resume replays the same takes and halts again. The message names Start fresh. A book past Confirm is not demoted by a drift-halted Retry (F).
- **Fixtures.** On `origin/main`, 28 test call sites go through the subset route. Only tests that seed stage1 with a chapter lacking a current take **and** assert `result` or persist change. Tests that seed a finished book and then assert the library or book-state status must also seed `takesPersisted`/`confirmReached` or rely on their absence. The #3084 test that pins N4 (`analysis.reasoning-overflow.test.ts:314`) is rewritten for decision E (plan T3).
- **What mock mode cannot show.** `npm run dev:mock` and the Playwright harness run with no server: no refusal 409, no drain, no `resume_required`, no S14 gate. Those are covered by route tests and on-box items; the e2e spec covers only the client-side disabled state.

## 7. Interactions

- #3436 is re-scoped (§2.6).
- #3437 owns Start fresh displacement stragglers (§2.5).
- #3412 / #3084: an overflow still halts with `fixes`, and nothing auto-resumes main after one. #3084 P20/N4 ("in-flight work finishes and caches") is **superseded on the main route** by decision E.

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
| A drain timeout alone, without aborting on halt (v2) | A halted run's calls had no bound (local Ollama has no client timeout), so the timeout would be the normal exit and would admit a subset next to live writers (A1). Under E the deadline is only a safety net |
| Let in-flight chapters finish after a halt (#3084 N4) | Unbounded drain on a local analyzer (A1); decision E |
| M8c for every Phase-1 completion over a cast record (v2) | Looped on a stage1-present book (A3); decision H |
| Gate every book's status on `takesPersisted` (v2) | Demoted confirmed and generated books after one interrupted per-chapter run (A2); decision F |
| A WeakMap phase tag on rethrows | Rethrowing pools are not the producing phase |

## 9. Open questions

None. O1–O3 closed plan check 3's questions, and O4 approved the plan. Decisions A–C closed the three questions plan check 1 raised (a main POST during a Retry; a server-side resume on a confirmed book; 1–4-word chapters that attribute to `[]`), and the two v3 questions (included chapters with no narratable text → C; the D3 consequence → B). Decisions E–H closed plan check 2's four blockers and confirmed the v2 interpretations. The non-fresh-Resume refusal is confirmed (O3(2)).
