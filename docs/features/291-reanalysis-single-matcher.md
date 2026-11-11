---
status: active
shipped: null
owner: null
---

# 291 — Re-analysis: one authoritative cast matcher (#4031)

> Status: active. Implemented on `fix/server-4031-single-matcher` (Tasks 1–29); on-box
> acceptance owed (register row B109, see Ship notes). Revised 2026-11-08 after three
> assumption-checker rounds, an owner-authorised focused review of the client save path, and the
> owner's and coordinator's rulings recorded below.
>
> Key files:
> - server, new: `server/src/store/match-fresh-to-prior.ts`, `server/src/store/cast-name-match.ts`,
>   `server/src/store/plan-overlay.ts`, `server/src/workspace/analysis-cast-io.ts`;
> - server, changed: `server/src/routes/analysis.ts`, `server/src/routes/book-state.ts`,
>   `server/src/analyzer/roster-dedup.ts`, `server/src/store/cast-id-history.ts`,
>   `server/src/store/cast-merge-suggestions.ts`, `server/src/store/analysis-cache.ts`,
>   `server/src/store/analysis-cache-rebuild.ts`, `server/src/routes/cast-merge.ts`,
>   `server/src/routes/cast-merge-suggestions.ts`;
> - client: `src/store/cast-slice.ts`, `src/store/persistence-middleware.ts`,
>   `src/store/analysis-stream-middleware.ts`, `src/lib/api.ts`, plus the Cast, profile-drawer,
>   Voices and Confirm views.
>
> URL surface: indirect (re-analysis from the Analysing view; the Cast/Voices/Confirm edit
> controls; suggestion chips).
>
> OpenAPI ops:
> - `PUT /api/books/{bookId}/state` gains a 409 `book_busy` (existing refusal shape) for the cast slice during an analysis.
> - `POST /api/books/{bookId}/cast/merge-suggestions/dismiss` gains a description and a 500.
> - The analysis stream's error-code prose gains `analysis_cache_legacy`.

## Benefit / Rationale

- **User:**
  - Re-analysing a book that already has a cast only ever extends it. No character is lost,
    renamed, merged or split; a voice never moves to another key.
  - Decisions hold across runs, a Start fresh, a stop and a resume: "not the same person", a
    merge, a dismissed suggestion.
  - When the analyzer is unsure, the book gains a row and a suggestion, never a guess.
  - While a re-analysis runs, cast edits are paused with a clear banner, and the cast reloads from
    disk before they resume. A live preview can therefore never be saved over the real cast.
- **Technical:**
  - The #3954/#4032/#4033 bug class becomes impossible by construction: one pure function decides
    fresh↔prior identity, once per run.
  - No whole-slice cast save can be built from an analysis-era slice.
- **Architectural:**
  - Four matchers and two id-space translations collapse into `matchFreshToPrior` plus a plan
    applier.
  - Cast writes during a run re-read cast.json under the cast lock (this retires #2015's
    detector).
  - During a run, only server routes change cast.json.
  - The suggestions store and `cast-id-history` gain durable decisions.

## Architectural impact

- **New seams:**
  - `matchFreshToPrior`, `applyMatchPlan`, `overlayPlanOntoCast` (all pure);
  - `analysis-cast-io.ts` (the only job cast writer);
  - `mutateAnalysisCache`;
  - the client cast gate (`selectCastReadOnly`) and the `analysisEra` flag;
  - `dedupeRosterByName`'s required `constraints`;
  - `foldMinorCast`'s `protectIds`.
- **Invariants preserved:**
  - plan 278 invariants 1–10;
  - CLAUDE.md's global lock order.
- **Migration:**
  - Analysis cache: `version`, `matchPlan`, `addedRows`, `runAddedPairs` (see *Cache lifecycle*).
  - `cast-id-history.json`: optional `supersededByKind` and `notSamePerson`, inside the
    all-or-nothing shape check, never bumping `schema`. An untagged key reads as `user`.
  - Suggestion entries: they keep `sourceId`/`targetId`/`reason` and gain `a`/`b`, `origin`,
    `newRow?` and `candidate?`.
- **Reversibility.** A revert is **not** data-safe on its own: a v2 cache's raw `stage1` does not
  match its plan-applied takes.
  - Rollback: revert, then Start fresh (old code) on books analysed under v2, or delete their cache.
  - Old readers ignore the history and suggestion additions.
  - The old client has no gate; it restores the old behaviour.

## Invariants to preserve

1. **Only `matchFreshToPrior` compares a fresh row with a prior row for identity.** Enforced by
   Task 28's guard; route A1/A2 are the behavioural defence.
2. **Every cast.json write is textually inside `withCastLock`.** This covers
   `analysis-cast-io.ts`, the suggestions route, `cast-merge.ts` and the cast PUT.
   `ALLOWED_UNLOCKED` (`server/src/workspace/cast-lock.guard.test.ts:360-374`) keeps its one entry.
3. **`supersededByKind` keys ⊆ `supersededBy` keys** after every write (`cast-id-history.ts:151-169`).
4. **Cache version.**
   - Saves and mutates write `version` as given.
   - The jobs set it to 2 on every non-legacy cache. Their first save after classification is
     `mutateAnalysisCache({ createIfAbsent: true, version: 2 })`.
   - The rebuild stamps 2 only when no cache file existed. Otherwise (`analysis-cache-rebuild.ts:70`)
     it preserves the loaded version.
   - A mutate on a cleared cache writes nothing without `createIfAbsent`.
5. **Owner — a mid-run delete never trips the drift gate.** This holds by construction:
   - the gate counts against the Phase-1 valid set, built before the persist (`analysis.ts:7241`,
     `:7264-7289`);
   - `rerouteDeletedTargets` runs inside the persist.

   Pinned by `Review Focus 4` (Task 23).
6. **The rule-11 ledger is a content comparison against the job's own last write (spec
   :285-287).**
   - A run-added row's ledger entry stores the fingerprint of the job's **last** write of that row.
     The fingerprint covers its user-owned fields.
   - Before every job write to such a row, the job compares the cast.json it re-read under the lock
     with that stored fingerprint:
     - a mismatch makes the row `added-once` (sticky, never deleted);
     - after the write, the fingerprint of what was just written is recorded.
   - The job's own rewrites (palette colour, linker stamps, aliases) therefore never read as user
     changes, and no field exclusion list is needed. Only server routes change disk mid-run
     (invariant 7), so a mismatch is a real user change, such as a route-given voice (A19).
   - Every job writer that touches a ledgered row refreshes its fingerprint the same way:
     `materialisePriorAtRunStart`'s stale-link prune and heal, `writePlanSnapshot` and
     `persistPlannedCast`.
   - The main job persists the ledger in the cache (`addedRows`). At a successful persist (once
     state.json has landed) it converts the `run-owned` entry of every row it wrote to
     `added-once` (R4) and clears the remaining `run-owned` entries, together with
     `runAddedPairs`.
   - **Cross-job refresh, not promotion.** The subset job keeps its own in-memory ledger for the
     rows it adds, and also records them in the cache ledger as `run-owned` with `by: 'subset'`
     (R35a/R35b), so a later run knows them as run rows. At a completed subset persist, the rows
     its own result keeps become `added-once`. When it writes a row that has an entry in
     `cache.addedRows` (a stopped main run's row), it applies the same compare-then-refresh to
     that entry, through `mutateAnalysisCache`.
   - The subset job never deletes by `addedRows`. So its aliases, `notLinkedTo`, stale-link prunes
     and linker stamps on a stopped main run's rows never read as user changes at the resumed main
     persist.
7. **Owner (2026-11-08, final) — lock until reloaded.**
   - **The era is per book.** Today the slice has no era at all (`CastState`, `cast-slice.ts:105-120`).
     It gains `analysisEra: Record<bookId, { epoch: number }>`.
   - **The client gate.** `selectCastReadOnly(state, bookId)` is evaluated for the **open** book.
     It is true when any of these holds:
     - `analysis.activeStream` names that book **and** `state === 'running'`;
     - the store-level busy cache for that book lists `'analysis'`;
     - `analysisEra[bookId]` exists.
   - **Latching the era.** The era for book X is set (or its epoch bumped) whenever:
     - an analysis apply lands for X: `replaceLiveRoster` (`cast-slice.ts:390`; `analysing.tsx:736`,
       `:1166`), `hydrateFromAnalysis` (`:320`; `routes/index.tsx:693`), or `mergeCharacters` with
       `{ fromAnalysis: true }` (`:358`; `generation.tsx:832`, `:853`, `:1174`, `:1190`);
     - **the gate sees an analysis for X by any route**, including
       `applyExternalAnalysisSnapshot` from another tab (`broadcast-middleware.ts:316-337`,
       `:402-410`), a running snapshot set on reload (`layout.tsx:1182-1212`), or a busy reply
       listing `'analysis'`;
     - a cast PUT for X answers 409 `book_busy` (item 6).
   - **Clearing the era.** X's era clears only through a full disk read of X issued **after**
     busy(X) has no `'analysis'` and X's snapshot is not `running`, and only when the epoch is
     unchanged since the read was issued. If an analysis apply moved the epoch, the re-hydrate runs
     again.
     - The read honours `castWrittenSince` (`persistence-middleware.ts:717-721`), so it waits for
       any cast flight of X.
     - `rehydrateCastAfterAnalysis(X)` dispatches `hydrateCharacters` only when
       `selectIsOpenBook(X)`. Otherwise it only clears X's era, and Layout's next full read of X is
       the reload.
   - **No cross-book leaks.** Book switches and the resets at `routes/index.tsx:226`, `:283` and
     `reset-book-slices.ts:13` call `hydrateCharacters([])` for book switching. That call **never**
     clears another book's era and never writes A's era onto B.
   - **The release is state-driven, not frame-driven.** While the open book is gated and no live
     stream handle is attached, a single-flight per-book poll of `GET /:bookId/busy` runs with
     bounded backoff (1 s, 3 s, 9 s, 27 s, then every 30 s while open). It feeds the store-level
     busy cache. Once busy has no `'analysis'` and the snapshot is not running, the re-hydrate runs.
     This covers:
     - client Pause (`analysing.tsx:1535-1536`) and subset Cancel (`generation.tsx:1205-1207`);
     - `stream_no_result` and `aborted` (`analysis-stream-middleware.ts:379-398`) and refusal codes
       (`:403-415`);
     - a reload mid-run (`layout.tsx:1182-1212`) and a stale paused snapshot
       (`analysis-slice.ts:282-287`).

     No frame or action alone releases the gate.
   - **Gate-up flushes, never withholds.** When the gate goes up for X, X's cast outbox is
     **flushed immediately**. A unit queued before the gate either lands (before the job registers)
     or gets the 409; the re-hydrate then waits for that flight (`castWrittenSince`).
   - **No saves while read-only.** While read-only, the persistence middleware builds and queues
     **no** cast-slice save from any rule. Any cast rule fired while read-only raises **one deduped
     toast**, "Re-analysis running — that change wasn't saved". This catch-all is what makes it
     correct; the disabled-control lists (Task 12) are UX only.
   - **Server.** While `bookJobKinds(bookId)` includes `'analysis'`, a whole-slice
     `PUT /state {slice:'cast'}` answers 409 with the existing refusal shape:
     `{ code: 'book_busy', error: busySentence(kinds, 'cast-save') }` (`book-state.ts:1113-1115`,
     `:2068-2070`), written nothing. No new code is needed: `book_busy` + `kinds` already says
     which job, and reusing it keeps one refusal vocabulary. The client handles that 409 with its
     own toast when the busy cache lists `'analysis'` (otherwise it shows the server's sentence),
     sets X's era, and re-hydrates. It is never dropped silently.
   - **First-upload jobs.** A first-upload main job with no `record.bookId` is not registered
     (`analysis.ts:4459-4461`), so busy never lists it. There is no prior cast, but **the run's
     own Phase-0b writes are at stake**. For such a book the gate holds on the running snapshot and
     the era, and the re-hydrate waits for the job's drain: the snapshot leaves `running` only on
     the server's final frame, which the job emits after its persist.
   - **Mid-run writers.** During a run only server routes write cast.json, each under
     `withCastLock` with the read inside (audited in Task 10), and the job re-reads under the lock.
     Route writes are therefore respected.

**Known limitation (fe-11 class, out of scope).** What remains is a tab that was **closed or
offline for the whole run** and later resumes from a pre-run slice it held in memory (a
suspended laptop tab). It never saw an analysis, so it never latched an era. Its next whole-slice
save, made after the job ended, behaves as today.

Not covered by this limitation, and fixed by the era latch:
- tabs that were open during the run (they latch via the broadcast);
- tabs reloaded during the run (they latch via the snapshot and busy).

## Cache lifecycle

Both jobs classify the cache at load with `classifyAnalysisCache`, **before** the load-rules save
(main `analysis.ts:4974-4977`, subset `:8547-8549`). The subset job also classifies before its run
start (`:8460`).

| Class | Condition | Main job | Subset job |
|---|---|---|---|
| `empty` | no `stage1`, no `chapterCast`, no `chapters` entry, no `failedChapterIds` | `version = 2`; normal | `version = 2`; normal |
| `legacy` | not empty, `version` undefined | log, clear, start over | end `analysis_cache_legacy` before any write (owner) |
| `current-pre0b` | v2, no `stage1` | Phase-0a resume | flow (b) |
| `current-unplanned` | v2, `stage1`, no `matchPlan` | resume plans and saves | flow (a): plans and saves |
| `current-planned` | v2, `stage1` and `matchPlan` | resume reuses; `extendPlan` uncovered rows, saved | flow (a): `extendPlan`, saved |

`current-unplanned` is the normal state after a `cast_incomplete` Retry:
1. flow (b) (`analysis.ts:8566-8582`) writes `stage1` with no plan (`:8887-8897`);
2. it ends `resume_required` (`:8958-8977`);
3. the main job resumes (`:5178-5194`).

Every decision made after Phase 0b is patched into `decisions`. `runAddedPairs` is saved with each
snapshot.

## Rulings recorded

**Builder's calls (coordinator):**
- **(1) `cast_merge_base_stale` removal.** This is orphaned-code removal; Task 28 regenerates
  `src/lib/api-types.ts`.
- **(2) A stopped and re-run subset run** leaves its rows unledgered; they read as prior rows. This
  fails safe.
- **(3) A rebuild from no prior cache stamps version 2.** *Reason:* it holds cast-of-record ids only.
- **(Q2) Every post-0b decision is saved.** *Reason:* ids must stay stable across a stop.
- **(Q3) Plan suggestions** are written at the Phase-0b snapshot and removed on drift-refusal.
  *Reason:* the user sees the question while the run is still in progress.
- **(F8) Degraded history at persist fails closed.** Consequence, tested: a mid-run merge's edits
  remap is undone for the chapters this run rewrites, and this is logged. *Reason:* a merge cannot
  be told from a delete.
- **(C3) Rule 13 stays unchanged, with no journal fallback.** A merge whose `retireCharacterId`
  write fails finishes its writes, then fails the request, and the client re-hydrates. *Reason:*
  today `cast-merge.ts` only `console.warn`s it, so a half-applied merge reports success.
- **(item 11) Narrow the guard.** Its "reads the prior cast" rule is narrowed to the jobs' own
  prior readers. *Reason:* the nine other cast-reading files (`cast-aliases`, `cast-link-prior`,
  `cast-merge`, `library-cast-override`, `cast-create`, `revisions`, `cast-series-patch`,
  `voice-override-linked`, `workspace/paths`) compare names for user-driven purposes, not for
  fresh↔prior identity.
- **(item 12) Re-reserve at snapshot.** At each snapshot, re-reserve against the re-read cast, and
  re-mint any `new` id that is live but not in the ledger. The new decision and the sentence remap
  are patched into the cache. *Reason:* defence in depth. `cast-create` is locked mid-run, but a
  route the audit misses must still not let a `new` row overwrite a live row.

**Builder's calls from the focused review of "lock until reloaded" (2026-11-08):**
- **B1 — the era is per book**, `analysisEra: Record<bookId, {epoch}>`. `hydrateCharacters` never
  touches it. A re-hydrate hydrates only the open book; otherwise it just clears that book's era.
  *Reason:* a single slice boolean (`cast-slice.ts:105-120` has no such field, and the book-switch
  resets at `routes/index.tsx:226`, `:283` and `reset-book-slices.ts:13` call `hydrateCharacters`)
  would leak one book's era, or one book's cast, into another.
- **B2 — the release is state-driven.**
  - The gate's snapshot leg requires `running`.
  - A single-flight, backed-off busy poll (in a store-level busy cache) runs while gated with no
    live handle.
  - The release happens once busy has no `'analysis'` and the snapshot is not running.
  - An epoch makes a re-hydrate re-run if an apply landed after it was issued.
  - The non-existent "terminal snapshot tick" trigger is removed.

  *Reason:* frame- and action-triggered releases miss these exits: Pause
  (`analysing.tsx:1535-1536`), subset Cancel (`generation.tsx:1205-1207`), `stream_no_result` and
  `aborted` (`analysis-stream-middleware.ts:379-398`), a reload, and a stale paused snapshot
  (`analysis-slice.ts:282-287`).
- **B3 — gate-up flushes the book's cast outbox and never withholds it.**
  *Reason:* a withheld unit would sit forever or land after the reload. Flushed, it either lands
  before the job or gets the 409, and the re-hydrate waits on that flight (`castWrittenSince`,
  `persistence-middleware.ts:717-721`).
- **4 — link-prior is disabled while read-only**, rather than writing the current book's cast
  server-side. *Reason:* `cast-link-prior.ts:251-291` writes only the source book. A
  current-book write would turn it into a two-book `withCastLocks` change.
- **5 — a catch-all toast for any cast rule fired while read-only.** The control lists are UX
  only. *Reason:* correctness must not depend on finding every control. The lists were corrected
  for the tier pin, Add character, rebaseline, voice-library assign/unassign, the voices override,
  `routes/index.tsx:824`, `voices.tsx:856` and `duplicate-review-modal.tsx:135`.
- **6 — a 409 latches the era**, and the re-hydrate is single-flight per book. *Reason:* a 409 is
  proof of a running analysis the client had not seen.
- **8b — the era also latches when the gate sees an analysis by any route**, including another
  tab's broadcast (`broadcast-middleware.ts:316-337`, `:402-410`). The fe-11 limitation narrows to
  a tab that never saw the run. *Reason:* an analysis can reach the gate without any preview apply.
- **10 — the rule-11 fingerprint is the job's own last write.**
  - The disk row is compared against it before each write, and the fingerprint is refreshed after.
  - `JOB_REWRITTEN_FIELDS` is dropped.
  - The subset job refreshes `addedRows` entries for the rows it writes; this replaces the earlier
    "no cross-job promotion" claim.

  *Reason:* this is spec :285-287 verbatim. A first-write freeze reads the job's own later
  rewrites (and the subset's) as user edits.
- **11 — tests that can fail.**
  - Task 17 dispatches the view's actions, because frames are view-only
    (`analysis-stream-middleware.ts:31-35`, `:301-303`), and checks "disabled" in a component test.
  - Playwright asserts against a mock call log (`.env.e2e:1`; `api.ts:1428-1459`).
  - The mock analysis emits `onCastUpdate`, and the mock busy is keyed by the mock book
    (`api.ts:1662-1751`, `:1672`, `:1737`, `:2524-2526`), with no second run on subscribe.
  - Task 20 records the end-of-run fixture.
- **12 — ConfirmRoute's read (`routes/index.tsx:751-797`) is the busy-gated re-hydrate.**
  ~~Layout's Confirm override is dropped.~~ *Struck at Task 29: no such override exists in
  Layout (Task 12 found nothing to drop).* *Reason:* one owner for Confirm's read.
- **13 — the voice-match once-guard arms only when the match runs.** Between Tasks 11 and 12 the
  catch-all absorbs its save. *Reason:* each task stays green.
- **The 409 reuses the existing `book_busy` + `busySentence` shape** (`book-state.ts:1113-1115`,
  `:2068-2070`). *Reason:* there is no case for a new code; `kinds` already identifies the
  analysis.
- **First-upload.** An unregistered first-upload job's own Phase-0b writes are at stake. Its
  release waits for the job's drain (the running snapshot ends only on the final frame, after its
  persist). *Reason:* busy never lists it.

**Owner:**
- **(2026-11-06)** The subset job stops on a legacy cache with `analysis_cache_legacy`.
- **(2026-11-06)** A mid-run delete never trips drift.
- **(2026-11-08, final) Lock until reloaded** (invariant 7). It **replaces** two earlier designs:
  the earlier C1/C2 and the per-row/batch-PATCH design. The PATCH endpoint, the batch ruling and
  the client action→patch mapper are removed.

  *Reason:* the owner-authorised focused review found that "payload-derived" fields equal the
  whole slice for whole-row and whole-roster actions:
  - `updateCharacter` at `cast.tsx:1001`, `layout.tsx:2525`, `clone-readiness-gate.tsx:152`,
    `voices.tsx:1584` and `rebaseline-modal.tsx:452`;
  - `setCharacters` at `layout.tsx:2913-2919`, `cast.tsx:1223-1252` and `:2296`.

  It also found these gaps:
  - The Confirm voice-match fires before any disk hydrate and overwrites a locked prior
    (`cast-slice.ts:344`, `layout.tsx:1366-1392`, `voice-match.ts:25-27`).
  - The PATCH's ledger promotion was invisible to the job's in-memory ledger, and contradicted the
    subset job.
  - `mergeCharacters` is an analysis snapshot apply that the design left unflagged
    (`generation.tsx:831-833`, `:852-853`, `:1174`, `:1190`).
  - A 409 cast PUT is dropped silently (`persistence-middleware.ts:619-637`).

  A read-only cast until a disk reload removes the whole class.
  - *Before that,* C1/C2 failed because a name-joined prior is dropped and then returned without
    voice fields (`analysis.ts:5309-5310`, `:5971`; `cast-slice.ts:39-41`).
  - Also, the re-hydrate did not fire on Stop/Pause (`analysing.tsx:1533-1541`; middleware
    `:333`, `:492-520`).

## Spec conflicts found

1. **The legacy-cache miss** applies in the jobs only: about ten other callers read `chapters`
   (`routes/generation.ts:1095`, `store/post-fold-sentences.ts:22`, `workspace/scan.ts:852`, …).
2. **The subset job on a legacy cache:** owner — `analysis_cache_legacy`.
3. **Phase-0a snapshots** (spec :117-119 vs :266) overlay plan-covered rows only. In the main job
   they write nothing.
4. **The `cast-lock.guard` allowlist chore is moot** (`:352-358`); the CLAUDE.md fix is in Task 29.
5. **`reviewer-brief.md` entry 77** exists on PR #4023's branch only; Task 29 adds it.
6. **Rule 11 needs a persisted ledger** (`addedRows`).
7. **On resume,** the linker re-runs on `new` rows only.
8. **`cast_merge_base_stale`** loses its producer; Task 28 removes it.
9. **Rule 13's only remaining trigger** is a merge whose history write failed, which C3 makes a
   failed request. With the cast locked mid-run, no user delete exists. Rule 13 is therefore
   defensive; its A20 tests use `failNextRetirement` and assert the merge request reported failure.
   Spec acceptance 20 is amended to match (ruling R13).
10. **R11 — drift-refused suggestions.** The plan wins (ruling Q3). Suggestions written transiently
    at the Phase-0b snapshot are removed when a run is drift-refused, so the run leaves none behind.
    Spec acceptance 24 is amended.
11. **R12 — New UI.** The plan wins (owner ruling, 2026-11-08): a paused-edits banner, disabled edit
    controls and a 409 `book_busy` on the whole-slice cast PUT. The spec's "New UI" non-goal is
    amended.
12. **Struck: "Layout's Confirm override is dropped"** (Task 12, ruling 12 and its Task 12 line).
    No such override exists in Layout; ConfirmRoute is the only Confirm read.
13. **R22 — three "item 8" labels.** The focused-review ruling about another tab's broadcast is now
    `8b` (and Task 11's "external snapshot" test group is `Item 8b`); Task 11's re-hydrate-on-failed-merge
    item is `8a`; a bare `item 8` is only Task 19's cache-fields item.
14. **R42 / R35a / R35b — "Resumed = uninterrupted".** Holds for both jobs, including a subset
    resuming a subset, because a subset tags the rows it mints in the ledger (`by: 'subset'`,
    R35b). One documented exception, invariant 6 (a subset deletes nothing by ledger): a stopped
    attempt's fold-dropped rows survive a resumed SUBSET until the next main run removes them.
    Spec acceptance 14 is amended.
15. **R38 — stopped main run, then a completed subset Retry.** A fold-taken row the stopped main run
    added survives the subset Retry until the next main persist removes it. Accepted; the cost is
    a 0-line row visible in the Cast view in between.
16. **R43 — the series linker runs only on `new` rows.** A character declined ("Don't reuse") before
    #3992 whose series link was dropped is a JOINED row, and re-analysis no longer re-links it
    (plan-overlay A7b). Strictly safer; the user re-links by hand.
17. **R46 — declined voices follow the candidates.** A `new` row inherits its candidates'
    `declinedVoiceFrom` / `declinedVoiceUuids` at the linker, so a re-minted row for the same
    person cannot be linked to a voice its candidate declined.
18. **R47 — the default narrator name re-localises.** A joined narrator whose prior name is a
    default (`isDefaultNarratorName`) takes the fresh, language-localised name on re-analysis; any
    other name stays.
19. **M4 — a restored dismissal counts as the run's write.** A user dismissal whose `notLinkedTo`
    edge the reject-edge heal restores (the user's two writes came apart) counts as the run's own
    write, so a row the run added stays fold-droppable. On the normal path the dismiss route's own
    edge write changes the fingerprint and the row is kept (`added-once`). Rare; known consequence
    of the heal refreshing the ledger (carry 4), accepted (Tasks 26/27).

---

# Re-analysis single matcher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide fresh↔prior cast identity once per run in one pure function, and make every later
step of both analysis jobs work in the prior cast's id space. Keep the user's cast read-only from
the client until it has been reloaded from disk after the run, so a preview is never saved.

**Architecture:**
- At Phase 0b (or at resume for an unplanned cache), `matchFreshToPrior` turns the raw stage-1
  roster into a `MatchPlan`.
- `applyMatchPlan` rewrites the roster onto prior or minted ids. Dedup, the fold and the linker are
  constrained by the plan.
- Every job cast write re-reads cast.json and history under the cast lock and overlays the plan.
- Only server routes change cast.json during a run: the client gate makes the slice read-only, and
  the server refuses a whole-slice PUT.
- The plan and the run ledger are cached. The old matchers are deleted.

**Tech Stack:** Node 20 + TypeScript (server: NodeNext, `rootDir ./src`), Vitest (node env on the
server, jsdom on the frontend), Playwright (mock mode), Express, Redux Toolkit, JSON files under
`.audiobook/`.

**Spec:** `docs/superpowers/specs/2026-11-06-reanalysis-single-matcher-design.md` (owner-approved
2026-11-06). Its Rules 1–13 and Acceptance 1–25 are the contract.

## Global Constraints

- **Branch and PR.** One branch, `fix/server-4031-single-matcher` (`node scripts/wt-new.mjs`); one
  PR closing #4031, #4032 and #3954.
- **Lock order.** `book-op` → `cast` → `book` → `state-json`; `cast` → `cast-id-history`.
  - Never take `cast` while holding `book` or `cast-id-history`.
  - Never nest `withCastLock` on one book.
- **Cast writes.** Every cast.json write is textually inside `withCastLock`. Nothing slow runs under
  the cast lock.
- **The persist's `book`-lock wait is unbounded by design.** No `book` holder takes `cast`; the
  same nesting already exists at `cast-merge.ts:217`. The bounded half is the cast-lock
  acquisition, which parks in `persistLockTimeout` (`analysis.ts:7348`, `:7480`). No client body
  carries a lock timeout's message.
- **Retirements.** Recorded after the cast lock is released (`analysis.ts:331`). Every new job write
  calls `castBase?.noteExternalWrite(payload)` until Task 28.
- **History identity rules.** An untagged entry means `user`. Only `user`/`heal` entries are T1, and
  such an entry always joins its live survivor (spec :189-191).
- **Minted ids.**
  - Format: `<raw>-n<k>`, lowest free `k ≥ 1`. With degraded history: `<raw>-r<runToken>`.
  - `runToken` is minted per plan call; `extendPlan` takes its own.
  - A row keeps its own raw id unless that id is live, superseded, displaced or decided.
- **Name tiers.** T2 = `normaliseNameKey` over display names, never aliases. T3 =
  `surnameTolerantMatch` over `normaliseForMatch` names.
- **Field ownership.**
  - Analysis-owned: `lines`, `scenes`, `evidence`, `attributes`, `detectionSource`.
  - Everything else is user-owned, including tone (`src/modals/profile-drawer.tsx:2104-2125`).
  - A joined row takes the prior value when present, else the fresh value.
  - Joined `aliases` = current aliases ∪ analyzer names.
  - The rule-11 fingerprint covers all user-owned fields. Because it is compared against the job's
    own **last** write (invariant 6), fields the job rewrites (colour, linker stamps) need no
    exclusion.
- **Declines.** A decline union strips same-book entries only.
- **Narrator.** It keeps the id `'narrator'` through Phase 1; its join is applied at persist.
- **Tests.**
  - Analysis-route tests run with `OLLAMA_URL=http://127.0.0.1:1`.
  - Server tests never import root `src/`. Server-recorded fixtures are written with `fs` and read
    by frontend tests.
  - Every deleted test names its replacement.
  - #4023 expectations are re-derived. N2, P5-1, P3-1, P4-3(b), R4, R7 and R17 are overturned.
- **Every task ends with:**
  - `npm --prefix server run typecheck` and `OLLAMA_URL=http://127.0.0.1:1 npm run test:server`;
  - `npm run test:server-slow` when it touches `analysis.ts` or `book-state.ts`;
  - `npm run check:cycles` when it adds an import;
  - `npm run typecheck && npm test` when it touches `src/`;
  - `npm run openapi:types` when it edits `openapi.yaml`;
  - `npm run test:e2e` where its own task says so.

## Review Focus

1. **A restructure or `rebuildCacheFromEdits` (`generation.ts:1089`) on a legacy cache.** Expect it
   to stay legacy. Task 6.
2. **Told-apart twins plus a third fresh Wren.** Expect a `new` row, suggestions to both, and no
   inherited "not Y". Tasks 1, 23.
3. **A user merge whose source is this run's `new` row, between 0b and the persist.** Expect it to
   resolve onto the survivor. Task 23.
4. **The A20 path on the main speaker.** Expect no `attribution_drift`. Task 23.
5. **A displaced raw id.** Expect it to be minted, never reclaimed. Task 1.

---

## File structure

| File | Responsibility |
|---|---|
| `server/src/store/reanalysis-types.ts` (new) | Shared types (no import from `cast-id-history.ts`). |
| `server/src/store/cast-name-match.ts` (new, leaf) | `surnameTolerantMatch`, `declinesLinkOf`, `unionNotLinkedTo` moved out of `merge-analysis-cast.ts`. |
| `server/src/store/match-fresh-to-prior.ts` (new) | `matchFreshToPrior`, `extendPlan`, `buildReservedIds`, `mintId`. |
| `server/src/store/plan-overlay.ts` (new) | `applyMatchPlan`, `remapSentenceIds`, `planConstraintsFor`, `overlayPlanOntoCast`, `userOwnedFingerprint`, `rerouteDeletedTargets`, `retargetPlanForMerge`, `ANALYSIS_OWNED`. No name comparator. |
| `server/src/workspace/analysis-cast-io.ts` (new) | `readPriorCastLockFree`, `materialisePriorAtRunStart`, `writePlanSnapshot`, `persistPlannedCast`. |
| `server/src/routes/book-state.ts` | 409 `book_busy` on the whole-slice cast PUT during a job. |
| `server/src/store/cast-id-history.ts`, `store/cast-merge-suggestions.ts`, `store/reject-edge-reconcile.ts` | Provenance, the dismissal record, pair-keyed suggestions. |
| `server/src/analyzer/roster-dedup.ts`, `analyzer/fold-minor-cast.ts` | Plan-constrained dedup, `protectIds`. |
| `server/src/store/analysis-cache.ts`, `analysis-cache-rebuild.ts` | Cache v2, `mutateAnalysisCache`. |
| `server/src/routes/analysis.ts` | Wiring of both jobs. |
| `server/src/routes/cast-merge.ts`, `routes/cast-merge-suggestions.ts` | Provenance, edge union, plan/ledger re-target, durable dismiss, C3. |
| `src/store/cast-slice.ts`, `src/store/cast-gate.ts` (new), `src/store/book-busy-slice.ts` (new) | Per-book `analysisEra` with epoch, `selectCastReadOnly`, the store-level busy cache and its single-flight poll. |
| `src/store/persistence-middleware.ts` | No cast save while read-only; the 409 handler. |
| `src/store/analysis-stream-middleware.ts` | Server-confirmed terminal → busy poll → re-hydrate. |
| `src/components/cast-edits-paused-banner.tsx` (new) | The banner, plus disabled controls in the Cast, profile drawer, Voices and Confirm views. |
| `src/lib/api.ts` | The mock busy reflects a running mock analysis. |
| `server/src/routes/__test-helpers__/analysis-job-harness.ts` (new) | Ported #4023 harness. |
| `server/src/routes/analysis.single-matcher.test.ts` (new) | Route-level acceptance. |
| `src/test-fixtures/analysis-cast-update-frames.json` (new) | Server-recorded SSE frames, replayed by the frontend. |
| `e2e/cast-analysis-lock.spec.ts` (new) | The Playwright spec. |

## Interfaces

```ts
// server/src/store/reanalysis-types.ts
export type NotLinkedEntry = string | { bookId?: string; characterId: string };
export type SupersededKind = 'user' | 'heal' | 'analyzer';
export type HistoryStatus = 'ok' | 'absent' | 'degraded';
export interface FreshRow { id: string; name: string; aliases?: string[] }
export type PriorRow = { id: string } & Record<string, unknown>;
export interface NotSamePersonRecord { a: string; b: string; at: string }   // a < b
export interface MatchHistory {
  status: HistoryStatus; supersededBy: Readonly<Record<string, string>>;
  supersededByKind: Readonly<Record<string, SupersededKind>>; displaced: Readonly<Record<string, string>>;
  notSamePerson: ReadonlyArray<NotSamePersonRecord>;
}
export interface StoredSuggestion {
  sourceId: string; targetId: string; a: string; b: string; reason: string;
  origin: 'plan' | 'dedup'; newRow?: string; candidate?: string;
}
export type JoinTier = 'id' | 'history' | 'name' | 'surname' | 'narrator' | 'open-question' | 'merge';
export type MatchDecision =
  | { kind: 'join'; rawId: string; priorId: string; tier: JoinTier }
  | { kind: 'new'; rawId: string; id: string; minted: boolean; suggest: string[]; inheritedDeclines: NotLinkedEntry[] };
export interface MatchPlan { version: 1; runToken: string; decisions: Record<string, MatchDecision> }
export interface MatchInput {
  fresh: ReadonlyArray<FreshRow>; prior: ReadonlyArray<PriorRow>; history: MatchHistory;
  openSuggestions: ReadonlyArray<StoredSuggestion>; reservedIds: ReadonlySet<string>;
  runToken: string; currentBookId?: string;
}
/** Rule-11 ledger. `fp` = fingerprint of the job's LAST write of the row; disk ≠ fp before a write → `added-once` (sticky). */
export type LedgerEntry = { state: 'run-owned'; fp: string; by?: 'subset' } | { state: 'added-once' }; // by: R35b
export type RunAddedLedger = Record<string, LedgerEntry>;
export type PlannedRowInfo =
  | { kind: 'join'; priorId: string }
  | { kind: 'new'; minted: boolean; candidates: readonly string[];
      inheritedDeclines: readonly NotLinkedEntry[]; declinedIds: readonly string[]; matchedFrom?: unknown };
export interface DedupConstraints { planned: ReadonlyMap<string, PlannedRowInfo>; currentBookId?: string }
```

```ts
// match-fresh-to-prior.ts
export function matchFreshToPrior(input: MatchInput): MatchPlan;
export function extendPlan(plan: MatchPlan, input: MatchInput): MatchPlan;
export function buildReservedIds(a: { prior: ReadonlyArray<PriorRow>; history: MatchHistory; plan?: MatchPlan }): Set<string>;
export function mintId(raw: string, taken: ReadonlySet<string>, mode: { kind: 'lowest' } | { kind: 'run'; runToken: string }): string;

// plan-overlay.ts
export const ANALYSIS_OWNED: readonly ['lines', 'scenes', 'evidence', 'attributes', 'detectionSource'];

export function userOwnedFingerprint(row: Record<string, unknown>): string;   // sha256 of canonical JSON of the user-owned fields
export function applyMatchPlan<C extends { id: string; name: string; aliases?: string[] }>(
  roster: C[], plan: MatchPlan, prior: ReadonlyArray<PriorRow>): { characters: C[]; idMap: Record<string, string> };
export function remapSentenceIds<S extends { characterId: string }>(s: S[], idMap: Readonly<Record<string, string>>): S[];
export function planConstraintsFor(a: { roster: ReadonlyArray<{ id: string; matchedFrom?: unknown }>; plan: MatchPlan;
  prior: ReadonlyArray<PriorRow>; history: MatchHistory; currentBookId?: string }): DedupConstraints;
export function overlayPlanOntoCast<C extends { id: string }>(input: {
  current: ReadonlyArray<PriorRow>; roster: ReadonlyArray<C>; plan: MatchPlan;
  resolve: (id: string) => string | null; historyStatus: HistoryStatus; ledger: RunAddedLedger;
  currentBookId?: string; mode: 'snapshot' | 'persist';
}): { characters: Array<C | PriorRow>; ledger: RunAddedLedger; deletedTargets: string[];
      droppedRunAdded: string[]; unresolved: string[]; collisions: string[]; carriedForward: Array<{ id: string; name?: string }> };
export function rerouteDeletedTargets<S extends { characterId: string; priorCharacterId?: string }>(s: S[], deleted: ReadonlySet<string>): S[];
export function retargetPlanForMerge(plan: MatchPlan, sourceId: string, targetId: string): MatchPlan;

// analysis-cache.ts
export const ANALYSIS_CACHE_VERSION = 2;
export type AnalysisCacheClass = 'empty' | 'legacy' | 'current-pre0b' | 'current-unplanned' | 'current-planned';
export function classifyAnalysisCache(cache: AnalysisCache): AnalysisCacheClass;
export interface CachePatch {
  chapters?: Record<number, SentenceOutput[]>; chaptersMode?: 'merge' | 'replace';
  castDurations?: Record<number, number>; stage2Durations?: Record<number, number>;
  decisions?: Record<string, MatchDecision>; matchPlan?: Omit<MatchPlan, 'decisions'>;
  ledger?: Record<string, LedgerEntry | null>; runAddedPairs?: Array<[string, string]>; clearLedger?: true;
  stage1?: Stage1Output; version?: number; createIfAbsent?: true;
  fields?: Partial<Pick<AnalysisCache, 'chapterCast' | 'failedChapterIds' | 'failedChapterErrors'
    | 'pendingAttributionChapterIds' | 'takesPersisted' | 'confirmReached' | 'castDurationsEngine' | 'stage2DurationsEngine'>>;
  remapCharacterIds?: Record<string, string>;
}
export async function mutateAnalysisCache(manuscriptId: string, patch: CachePatch): Promise<AnalysisCache | null>;

// analysis-cast-io.ts
export async function readPriorCastLockFree(bookDir: string): Promise<{ rows: PriorRow[];
  source: 'cast' | 'carryover' | 'none'; fingerprint: string | null }>;      // fingerprint until Task 28
export async function materialisePriorAtRunStart(a: { bookDir: string; bookId?: string; staleLinkKeys: ReadonlySet<string>;
  openSuggestions: ReadonlyArray<StoredSuggestion>; notSamePerson: ReadonlyArray<NotSamePersonRecord>;
  runOwnedIds: ReadonlySet<string> }): Promise<{ prior: PriorRow[]; healRetirements: Retirement[];
  source: 'cast' | 'carryover' | 'none'; written: unknown | null }>;
export async function writePlanSnapshot(a: { bookDir: string; bookId?: string; roster: ReadonlyArray<{ id: string }>;
  plan: MatchPlan; ledger: RunAddedLedger; runSuggestions: StoredSuggestion[] }):
  Promise<{ ledger: RunAddedLedger; plan: MatchPlan; idMap: Record<string, string>;   // re-mints (item 12)
            written: unknown | null; addedPairs: Array<[string, string]> }>;
export interface PersistOutcome {
  characters: Array<{ id: string } & Record<string, unknown>>; sentences: SentenceOutput[];
  retirements: Retirement[]; plan: MatchPlan; deletedTargets: string[]; unresolved: string[];
  carriedForward: Array<{ id: string; name?: string }>; written: unknown | null;
}
export async function persistPlannedCast(a: { bookDir: string; bookId?: string; plan: MatchPlan; roster: CharacterOutput[];
  sentences: SentenceOutput[]; ledger: RunAddedLedger; runSuggestions: StoredSuggestion[];
  runAddedPairs: Array<[string, string]>; driftRefused: boolean }): Promise<PersistOutcome>;

// src/store/cast-gate.ts
export function selectCastReadOnly(state: RootState, bookId: string): boolean;   // (activeStream names book AND state==='running') OR busy[bookId] includes 'analysis' OR cast.analysisEra[bookId]
export function rehydrateCastAfterAnalysis(bookId: string): AppThunk<Promise<void>>; // single-flight per book: await busy clear + snapshot not running → (castWrittenSince-aware) getBookState → if selectIsOpenBook(bookId) hydrateCharacters, then clearAnalysisEra({bookId, epoch}) only if the epoch is unchanged, else re-run
export function pollBookBusy(bookId: string): AppThunk<Promise<BookBusyKinds>>;      // single-flight, bounded backoff; writes book-busy-slice
// cast-slice: analysisEra: Record<string, { epoch: number }>; actions latchAnalysisEra({bookId}), clearAnalysisEra({bookId, epoch})
```

`previewFoldForLiveView(characters, language, constraints, protectIds)` has seven callers:
`analysis.ts:1016`, `:5239`, `:5309`, `:5971`, `:5988`, `:8640` and `:8905`. The Phase-0a callers
(`:1016`, `:5309`, `:8640`) pass empty constraints.

---

### Task 1: The pure matcher

**Files:**
- Create `reanalysis-types.ts`, `cast-name-match.ts` and `match-fresh-to-prior.ts` (`server/src/store/`).
- Move `surnameTolerantMatch` (`merge-analysis-cast.ts:194-205`), `declinesLinkOf` (`:731-740`) and
  `unionNotLinkedTo` (`:744-758`) into `cast-name-match.ts`.
- Test: `match-fresh-to-prior.test.ts`. Keep `merge-analysis-cast.test.ts` green.

The settlement follows spec steps 1–5 verbatim. On top of them:
- **Rule 3 wins** over declines.
- **T2/T3 exclusions.** A candidate drops out on a decline in either direction: a same-book
  `notLinkedToId` or a `notSamePerson` pair.
- **No name candidates** come from catch-all or narrator rows (`fold-minor-cast.ts:107-108`).
- **The id/name conflict rule** applies to T1-by-live-id only.
- **`inheritedDeclines`** has same-book entries stripped.
- **Minting** excludes the row's own raw id from `taken`.

- [ ] **Step 1: Failing tests.**
  - *Spec acceptance, unit level:*
    - `A1: a single surname-tolerant candidate joins and keeps the prior id`
    - `A2: each #4033 twin roster keeps both twins`
    - `A4/N2: a merged-away id and a same-name row both join the survivor`
    - `A5/P4-2`
    - `A6: one voiced and one unvoiced T3 candidate give a suggestion`
    - `A7: a new row inherits its candidates' cross-book declines only`
    - `A10`
    - `A15`
    - `A18`
    - `A21`
    - `A3: degraded history mints <raw>-r<runToken>`
    - `A25a: total and deterministic`
  - *Plan-specific rules:*
    - `item 13: a cross-book entry whose characterId equals a local id is kept`
    - `rule 3 over a decline`
    - `F11: a first analysis keeps every raw id`
    - `open-question` / `a legacy suggestion never makes an open-question row`
    - `id/name conflict`
    - `catch-all and narrator rows are never name candidates`
    - `two trailing tokens apart never matches`
    - `an exact name beats the surname tier`
    - `extendPlan uses its own runToken and never re-decides a covered row`
  - *Review Focus:*
    - `Review Focus 2`
    - `Review Focus 5`
- [ ] **Step 2–4:** FAIL (`npm --prefix server run test -- src/store/match-fresh-to-prior.test.ts`);
  implement; PASS + battery + `check:cycles`.
- [ ] **Step 5: Mutation.**
  - Delete the open-question branch → `open-question` goes red.
  - Let a same-book entry into `inheritedDeclines` → `Review Focus 2` goes red.
- [ ] **Step 6: Commit** — `feat(server): matchFreshToPrior, the single re-analysis matcher (#4031)`.

### Task 2: History provenance and the dismissal record

**Files:**
- `server/src/store/cast-id-history.ts`:
  - interface `:62-175`;
  - `isWellFormedHistory` `:258-284` (new fields go in its conjunction);
  - `retireCharacterId` `:535`;
  - `dropSuperseded*` `:707`, `:800`;
  - `forgetSupersededId` `:865`, `restoreSupersededId` `:938`, `undoRejectedPairs` `:1251`.
- `routes/analysis.ts:305-339`: `recordRetirements` gets a required `kind` — `'heal'` at `:4854`
  and `:8530`, `'analyzer'` at the persist.
- Tests: `store/cast-id-history.test.ts`, `store/cast-id-history.stamp.guard.test.ts`.

Behaviour:
- `retireCharacterId(…, kind = 'user')`. The default equals untagged, so the 107 existing test calls
  stay untouched. A source scan forces an explicit kind in `analysis.ts`.
- A retirement repoints `notSamePerson` records, then drops and reports a `(to,to)` record as
  `droppedNotSamePerson`.
- forget/restore/undo preserve the kind (`forgotSupersededKind`).
- Every write goes through `bumpSeqAndStamp`.

- [ ] **Step 1: Failing tests.**
  - *Kind tagging:*
    - `retireCharacterId records the kind it is given`
    - `the default kind is user`
    - `an untagged entry reads as user`
    - `a dropped supersededBy key drops its kind`
    - `forget then restore keeps the kind`
    - `every analysis.ts retirement call passes a kind`
  - *Dismissal records:*
    - `recordNotSamePerson stores one undirected record`
    - `A12c: merging one of a dismissed pair into a third repoints the record`
    - `merging a dismissed pair into each other drops and reports the record`
  - *Shape:*
    - `F10: a malformed notSamePerson or supersededByKind degrades the whole file`
    - `toMatchHistory of a degraded read is empty with status degraded`
  - Update the stamp-guard counts.
- [ ] **Step 2–4:** FAIL; implement; PASS + battery.
- [ ] **Step 5: Mutation.** Remove the self-pair drop → its test goes red.
- [ ] **Step 6: Commit** — `feat(server): tag cast-id-history merges with who made them (#4031)`.

### Task 3: Durable suggestions and dismissals

**Files:**
- `server/src/store/cast-merge-suggestions.ts`.
- `routes/cast-merge-suggestions.ts:50-68`, `:75-185` (accept removes the pair).
- `store/reject-edge-reconcile.ts:95-130`.
- `openapi.yaml:1829-1858` + `openapi:types`.
- The `writeSuggestions` callers (`analysis.ts:7405`, `:9604`) call `reconcileSuggestionsLocked`
  inside a `withCastLock`, pruned against the ids of `characters0` / `enriched0`.
  `dd.suggestions` lives in that space (comment `:7402-7404`); `mergedFinal` is declared later
  (`:7444`, `:9633`). This lasts until Tasks 20/25.

Tests to update:
- the store and route tests, plus `reject-edge-reconcile.test.ts`;
- `analysis.persist-lock-timeout.test.ts:168-175` (the swallow case at `:914` is kept);
- `cast-merge.lock-timeout.test.ts` (`:318`, `:415`);
- `book-op.single-book-routes.test.ts:393-396`;
- `analysis.test.ts:6591-6599`, `:7311-7314`.

**Interfaces:**
```ts
export function pairKey(x: string, y: string): { a: string; b: string };
export async function loadStoredSuggestions(bookDir: string): Promise<StoredSuggestion[]>;
export async function loadSuggestions(bookDir: string): Promise<CastMergeSuggestionsFile>;
export async function reconcileSuggestionsLocked(bookDir: string, a: { add: StoredSuggestion[]; remove?: Array<[string, string]>;
  liveIds: ReadonlySet<string>; supersededBy: Readonly<Record<string, string>>; declined: (a: string, b: string) => boolean }): Promise<void>;
export async function removeSuggestionPairsLocked(bookDir: string, pairs: Array<[string, string]>): Promise<void>;
export async function dismissSuggestionDurably(bookDir: string, bookId: string, x: string, y: string, log: (m: string) => void): Promise<void>;
```
`dismissSuggestionDurably` runs under `withCastLock`:
1. Read cast.json and the history status.
2. Write the dismissal record — unless history is degraded: then skip it and log.
3. Write edges on the rows that exist.
4. Remove the pair.

The route curates errors with `requestFailureMessageFs`. A record backs only its own pair; pass 2
restores that pair's edges.

- [ ] **Step 1: Failing tests.**
  - *Store:*
    - `stores one entry per unordered pair and keeps its direction`
    - `a legacy entry loads with no newRow`
  - *Routes:*
    - `GET keeps the MergeSuggestion shape`
    - `dismiss writes the record and both edges`
    - `F14: dismiss under degraded history writes the edges, removes the pair, skips the record and logs`
    - `accept folds sourceId into targetId, removes the pair and records no dismissal`
    - `dismiss answers a curated 500 on a lock timeout`
  - *Reconcile:*
    - `reconcile keeps an open suggestion and drops one once a row is gone, merged or declined`
    - `A12a: a dismissal survives reject-edge reconcile`
    - `a record backs only its own pair`
- [ ] **Step 2–4:** FAIL; implement; PASS + battery.
- [ ] **Step 5: Mutation.** Drop the record backing → `A12a` goes red.
- [ ] **Step 6: Commit** — `feat(server): durable merge suggestions and dismissals (#4031)`.

### Task 4: The heal reads suggestions, dismissals and the run ledger

**Files:** `server/src/store/merge-analysis-cast.ts:768-867`. `dedupePriorCastByName` gets
`opts: { openSuggestions; notSamePerson; skipIds }`. It refuses to heal when:
- either member has an open suggestion;
- the two members share a dismissal record;
- a member is in `skipIds`.

Call sites `:4823` and `:8491` pass empty `skipIds` until Task 15.

- [ ] **Step 1: Failing tests.**
  - `A11: identical names heal and report a retirement`
  - `A11: no heal across a dismissal record`
  - `A11: no heal when either member has an open suggestion, even to a third row`
  - `A11: no heal across a notLinkedTo edge`
  - `the heal never touches a skipIds row`
- [ ] **Step 2–4:** FAIL; implement; PASS + battery.
- [ ] **Step 5: Mutation.** Check suggestions between members only → the third-row case goes red.
- [ ] **Step 6: Commit** — `fix(server): the identical-name heal honours suggestions, dismissals and the run ledger (#4031)`.

### Task 5: Plan-constrained dedup and fold protection

**Files:**
- `roster-dedup.ts:151-519` and `fold-minor-cast.ts:44-80,172`.
- Callers get empty constraints until Task 16 (`analysis.ts:1107`, `:1131`, `:2500`).
- Under empty constraints a row has no `PlannedRowInfo`: it is treated as unminted `new` with no
  candidates, and today's behaviour holds except for the survivor rule.
- `tier1RewriteKeys` passes through `dedupAndPrepare` (`analysis.ts:1097`, `:1119`) until Task 28.
- Tests:
  - `roster-dedup.test.ts`, `fold-minor-cast.test.ts`;
  - `series-reuse-link.test.ts:780`;
  - route tests that pinned a `safeId(name)` or line-count survivor.

**Interfaces:**
- `dedupeRosterByName(characters, sentences, { language?, constraints })` returns
  `{ characters, rewrites, suggestions: StoredSuggestion[], refused, mergedNew, tier1RewriteKeys }`.
- `FoldOptions.protectIds?`.

Rules:
- **When rows may merge.** Joins to the same prior row may merge. `new` rows may merge only with no
  crossing `declinedIds`/`inheritedDeclines` and no conflicting `matchedFrom`.
- **Survivor:** the prior id, else a minted id, else the lowest raw id. Never `safeId(name)` (`:198`)
  and never by line counts (`:267-281`, `:386-394`).
- **New+new merges** union the declines onto the survivor and report `mergedNew`.
- **Refused pairs** become suggestions.

- [ ] **Step 1: Failing tests.**
  - *Survivor and groups:*
    - `A25c: the prompt call and the post-stage-2 call give the same groups`
    - `the survivor is a member id, never safeId(name)`
    - `under empty constraints, groups and suggestions match today's except the survivor id`
  - *Merge refusals:*
    - `rows joined to different prior rows never merge`
    - `a joined row and a new row never merge; the pair becomes a suggestion`
    - `two new rows with conflicting matchedFrom stay separate`
    - `item 1: two new rows whose candidates hold a notSamePerson record stay separate`
  - *New+new merges:*
    - `item 18: a new+new merge unions inherited declines onto the survivor and reports mergedNew`
  - *Fold:*
    - `a protected id is never folded or dropped, even at 0 lines`
- [ ] **Step 2–4:** FAIL; implement; PASS + battery.
- [ ] **Step 5: Mutation.** Choose the survivor by line count → `A25c` goes red.
- [ ] **Step 6: Commit** — `refactor(server): one plan-constrained roster dedup (#4031)`.

### Task 6: Analysis cache v2

**Files:**
- `analysis-cache.ts:110-166,208-251`.
- `analysis-cache-rebuild.ts:60-97`: runs through `mutateAnalysisCache` with `chaptersMode`;
  `createIfAbsent` + `version: 2` apply only when no file existed at `:70`; the `:90` loop becomes
  `merge`.
- Tests: the two cache test files.

`mutateAnalysisCache` is **one** `enqueuePathOp` op (`state-io.ts:386-399`), which is not
re-entrant. It never calls `saveAnalysisCache` or `writeJsonAtomicOrdered`
(`ordered-write.ts:10-13`). The op:
1. reads the file;
2. if the file is absent and the patch has no `createIfAbsent`, returns `null`;
3. applies the patch, merged per key; `clearLedger` deletes `addedRows` and `runAddedPairs`;
4. builds the payload with the shared `buildCachePayload`;
5. writes it with plain `writeJsonAtomic`.

- [ ] **Step 1: Failing tests.**
  - *Load and classify:*
    - `loadAnalysisCache copies version, matchPlan, addedRows and runAddedPairs`
    - `classifyAnalysisCache` — one case per lifecycle row
  - *Version handling:*
    - `saveAnalysisCache writes version exactly as given`
    - `Review Focus 1: rebuilding a loaded legacy cache keeps it legacy; a loaded v2 cache stays v2`
    - `rebuilding with no prior cache file stamps version 2`
  - *Mutate semantics:*
    - `mutateAnalysisCache merges decisions per key`
    - `serialises against a concurrent save and does not deadlock`
    - `a mutate after clearAnalysisCache writes nothing; one with createIfAbsent writes a v2 cache`
- [ ] **Step 2–4:** FAIL; implement; PASS + battery.
- [ ] **Step 5: Mutation.**
  - Call save inside the op → the deadlock test goes red.
  - Stamp the version in save → Review Focus 1 goes red.
- [ ] **Step 6: Commit** — `feat(server): versioned analysis cache carrying the match plan (#4031)`.

### Task 7: Plan application and the cast overlay (pure)

**Files:** create `server/src/store/plan-overlay.ts` (+ test).

`applyMatchPlan`:
- Collapses rows by output id, across joins and `new` rows.
- A joined output takes the prior id and display name, with `aliases` = prior ∪ analyzer names.
- `new` rows get no `notLinkedTo` from the plan.
- Narrator joins stay `'narrator'`.

`planConstraintsFor`: computes pair-keyed `declinedIds` per `new` row.

`overlayPlanOntoCast`:
- **Carry-forward.** Every `current` row is carried forward.
- **Joined rows.** User-owned fields come from `current`; analysis-owned fields come from the
  roster; aliases are unioned.
- **A `new` row already in `current`** (item 13) takes its user-owned fields from `current`.
- **No decision.** A roster id with no decision is skipped in `snapshot` mode.
- **Unresolvable target.**
  - `ok`/`absent` history → it lands in `deletedTargets`, and so does a ledger row that is gone.
  - `degraded` history → it lands in `unresolved`; nothing is deleted, re-added or rerouted.
- **Item 12 collision.** A `new` id that is live in `current` but absent from the ledger is
  reported in `collisions`. The caller re-mints it.
- **Ledger (invariant 6), before each write of a ledgered row:**
  - If the row's `userOwnedFingerprint(current row)` ≠ its stored `fp` (the job's **last**
    write), the entry becomes `added-once`, sticky.
  - After the write, a `run-owned` entry stores `fp = userOwnedFingerprint(written row)`.
  - The first write of a `new` row creates `{run-owned, fp}`.
  - A ledger row absent from `current` is never re-added.
  - In `persist` mode, a `run-owned` row the final roster lacks (and still matching) is removed.
- **Narrator.** The narrator decision maps onto `priorId`.
- **No name comparison.**

`retargetPlanForMerge`: copies the target's `new` decision onto the source's decisions; otherwise
writes `join(target, 'merge')`.

- [ ] **Step 1: Failing tests.**
  - *Spec acceptance:*
    - `A8: an unvoiced and a decline-only prior row the roster omits are carried forward with their declines`
    - `A9: … aliases = existing ∪ analyzer name` (the fixture has existing aliases)
    - `A7b`
    - `A19: a fold-dropped run-owned row whose disk fingerprint still matches is removed; one given a voice on disk is kept`
    - `A20: a target gone with no history stays gone and is reported`
    - `A18b`
  - *Field ownership:*
    - `field ownership: tone, gender, description and color from the user, filled from the analyzer when absent`
    - `item 13: a new row already in current takes its user-owned fields from current`
  - *Collapse and merge re-target:*
    - `item 12: rows mapping to one output id collapse`
    - `item 12: retargetPlanForMerge copies the target's new decision`
  - *Ledger:*
    - `F2: the job's own rewrite of colour, aliases or a linker stamp between two writes does not convert a row`
      (the fp is refreshed after each write)
    - `F2: a user-owned field changed on disk between two job writes converts the row to added-once, and it stays added-once`
    - `F2: a ledger row absent from cast.json is not re-added`
  - *Deleted, unresolved and colliding rows:*
    - `item 3: a run-added row gone with no history is reported and rerouted`
    - `rerouteDeletedTargets sets priorCharacterId`
    - `F8: with degraded history a gone target is unresolved`
    - `a target merged away resolves to its survivor`
    - `item 12: a new id live on disk but not in the ledger is reported as a collision`
  - *Declines:*
    - `F3: a new row persists only cross-book inherited declines`
    - `item 1: planConstraintsFor lists a candidate's same-book declines`
  - *Buckets:*
    - `item 11: a bucket id joins a prior bucket row and keeps its name`
- [ ] **Step 2–4:** FAIL; implement; PASS + battery.
- [ ] **Step 5: Mutation.**
  - Refresh `fp` from disk instead of from the write → `A19`'s kept case goes red.
  - Freeze `fp` at the first write → `F2: the job's own rewrite…` goes red.
- [ ] **Step 6: Commit** — `feat(server): apply a match plan and overlay it onto cast.json (#4031)`.

### Task 8: Locked cast I/O for the jobs

**Files:**
- Create `server/src/workspace/analysis-cast-io.ts`, moving `readPriorCastForMerge`'s body
  (`analysis.ts:245-268`) into `readPriorCastLockFree`.
- Add `staleReuseLinkKeys` and `applyStaleLinkPrune` to `series-reuse-link.ts` (near `:248`).
- Tests: `analysis-cast-io.test.ts`, `series-reuse-link.test.ts`.

Each of the following runs under `withCastLock`:
- **`materialisePriorAtRunStart`:** re-read → prune with precomputed keys → heal with `skipIds` →
  materialise the carryover → write once. For every row in `addedRows` that this write touches,
  it applies invariant 6's compare-then-refresh and returns the ledger patch.
- **`writePlanSnapshot`:** re-read cast and history → **re-reserve** against the re-read cast and
  re-mint `collisions` (item 12), returning the updated plan and `idMap` → overlay (`snapshot`) →
  write cast.json → add `runSuggestions`. It returns the ledger and `addedPairs`. The caller
  patches the cache `{ ledger, runAddedPairs, decisions }` after this; cast.json is written first.
- **`persistPlannedCast`:**
  1. re-read;
  2. `extendPlan`;
  3. re-resolve (exact|history);
  4. re-reserve and re-mint collisions, remapping this run's sentences;
  5. overlay (`persist`), recount, write cast.json;
  6. nested `withBookLock` edits with `rerouteDeletedTargets`;
  7. reconcile suggestions.

  If `driftRefused`, only step 6 runs and the run's added pairs are removed.

- [ ] **Step 1: Failing tests.**
  - *Run start:*
    - `A16: a carryover is written to cast.json at run start with ids, names, aliases and voices; its dismissal records stay readable`
    - `the heal is written to cast.json, so a re-read does not undo it`
  - *Snapshot:*
    - `A13: a merge and a dismissal made after the plan survive the next snapshot`
    - `Q3: the Phase-0b snapshot writes the plan's suggestions`
    - `item 12: a snapshot re-mints a new id that went live on disk`
  - *Persist:*
    - `A24: a drift-refused persist writes edits only and removes the run's added pairs`
    - `the persist takes the book lock inside the cast lock and records no retirement under it`
    - `a cast-lock timeout on the persist surfaces as LockAcquisitionTimeoutError`
  - *Helpers:*
    - `staleReuseLinkKeys does not mutate its input`
- [ ] **Step 2–4:** FAIL; implement; PASS + battery.
- [ ] **Step 5: Mutation.** Overlay onto the run-start rows → `A13` goes red.
- [ ] **Step 6: Commit** — `feat(server): re-read-and-overlay cast writes for analysis runs (#4031)`.

### Task 9: Port the PR #4023 route harness

**Files:** create `server/src/routes/__test-helpers__/analysis-job-harness.ts`.
- **Ported from #4023:** `phase0`, `phase1`, `sel`, `mkBook`, `mkJob`, `run`, `readCast`,
  `readEdits`, `readHistory`, `blipRemapRead`, `phase0Hook` and the pipelined flag
  (`__single_matcher_pipelined`), plus `abortAtFirstPhase1` (`analysis.same-book-gate.test.ts:271`).
- **New helpers:**
  - readers: `linesById`, `readSuggestions`, `readCache`;
  - writers: `putCast`, `routeVoice(app, bookId, id)` (assigns a voice via the voice route, e.g.
    `voice-override-linked` or `qwen-voice` promote), `mergeMidRun`;
  - fault and replay: `failNextRetirement`, `runSubsetRetry`;
  - `recordCastUpdateFrames(job)`: captures every SSE `cast-update` frame.

Create `server/src/routes/analysis.single-matcher.test.ts`.

- [ ] **Step 1:** `smoke: a first analysis of a new book writes its cast` — passes today.
- [ ] **Step 2:** PASS. **Step 3: Commit** — `test(server): port the #4023 analysis-job harness (#4031)`.

### Task 10: Server — the cast PUT refused during analysis, and the mid-run writer audit

**Files:**
- `server/src/routes/book-state.ts:1229-1250`. When `bookJobKinds(book.bookId).includes('analysis')`,
  the cast PUT returns the **existing** refusal shape before reading or writing.
  - The shape is 409 `{ code: 'book_busy', error: busySentence(kinds, 'cast-save') }`
    (`book-state.ts:1113-1115`, `:2068-2070`).
  - Add `'cast-save'` to `busySentence`'s action wording.
  - *Reason:* one refusal vocabulary; `kinds` already names the job.
  - Update `openapi.yaml`, then run `openapi:types`.
- **Audit of mid-run cast.json writers.** For every server module that references `castJsonPath(`,
  confirm a writer's read is inside its `withCastLock` (rule 2). Record a verdict per file in the
  commit body.
  - Writers:
    - routes: `book-state`, `cast-add-from-roster`, `cast-aliases`, `cast-create`, `cast-design`,
      `cast-link-orphan`, `cast-link-prior`, `cast-merge`, `cast-not-linked-to`,
      `cast-reject-orphan`, `cast-series-patch`, `cast-tier`, `library-cast-override`,
      `qwen-voice`, `revisions`, `script-review`, `single-design`, `voice-library`,
      `voice-override-linked`, `voice-style`, `voices`;
    - workspace: `voice-library-usage` (`:116-138`), `duplicate-bookid-sweep`;
    - store: `not-linked-edges`, `reject-edge-reconcile`.
  - The 11 reader modules, marked as readers: `chapter-qa-repair`, `chapter-splice`,
    `generation`, `scan`, `queue-engine-stamp`, `library-cast-scan`, `series-full-cast-scan`,
    `paths`, `attribution-health-io`, `cast-lock.guard-targets`, `file-lock`.
  - A writer whose read is outside its lock is a defect. Fix it in this task, with a test.
- **First-upload.** Record that a first-upload main job is unregistered (`analysis.ts:4459-4461`).
  Its release is client-side (invariant 7).
- **Tests:** `routes/book-state.test.ts` (slow), plus one test per audit defect found.

- [ ] **Step 1: Failing tests.**
  - `PUT /state cast answers 409 book_busy with kinds ['analysis'] while an analysis job is registered, writing nothing`
  - `PUT /state cast behaves as today once the job's token is released`
- [ ] **Step 2–4:** FAIL; implement; PASS + battery (+ slow).
- [ ] **Step 5: Mutation.** Drop the `bookJobKinds` check → the 409 test goes red.
- [ ] **Step 6: Commit** — `fix(server): refuse a whole-cast save while an analysis runs (#4031)`.

### Task 11: Client — the per-book cast gate, busy cache, gate-up flush and 409 handler

**Files:**
- **`src/store/cast-slice.ts`.**
  - Add `analysisEra: Record<bookId, { epoch: number }>`, plus two actions:
    - `latchAnalysisEra({ bookId })` creates the era or bumps its epoch;
    - `clearAnalysisEra({ bookId, epoch })` is a no-op if the epoch has moved.
  - These latch the era for their payload's book:
    - `replaceLiveRoster` (`:390`), dispatched at `analysing.tsx:736` and `:1166`;
    - `hydrateFromAnalysis` (`:320`), dispatched at `routes/index.tsx:693`;
    - `mergeCharacters({ fromAnalysis: true })` (`:358`). The sites `generation.tsx:832`, `:853`,
      `:1174` and `:1190` now pass `fromAnalysis`.
  - `hydrateCharacters` (`:145`) **never touches** `analysisEra`. So the book-switch resets
    (`routes/index.tsx:226`, `:283`; `reset-book-slices.ts:13`) cannot clear or move an era.
- **`src/store/book-busy-slice.ts` (new).**
  - `busyByBook` holds the store-level busy cache.
  - `pollBookBusy(bookId)` is single-flight per book, with bounded backoff: 1 s, 3 s, 9 s, 27 s,
    then every 30 s while the book is open and gated.
  - A reply listing `'analysis'` latches that book's era.
- **`src/store/cast-gate.ts` (new).**
  - `selectCastReadOnly(state, bookId)` is true when any of these holds:
    - the snapshot names the book **and** `state === 'running'`;
    - the busy cache for the book lists `'analysis'`;
    - an era exists for the book.
  - A store listener evaluates the gate for the **open** book:
    - Gate rises → flush that book's cast outbox immediately (`flushBookPersistence`).
    - Gate up, no live stream handle → `pollBookBusy`.
    - Busy has no `'analysis'` and the snapshot is not running → `rehydrateCastAfterAnalysis`.
  - The listener also latches the era whenever the gate sees an analysis for the open book:
    `applyExternalAnalysisSnapshot` (`broadcast-middleware.ts:316-337`, `:402-410`), or the
    snapshot set at reload (`layout.tsx:1182-1212`).
  - `rehydrateCastAfterAnalysis(bookId)` is single-flight per book:
    1. Record the epoch.
    2. Wait until `castWrittenSince` shows no outbox, timer or flight
       (`persistence-middleware.ts:717-721`).
    3. `getBookState`.
    4. `hydrateCharacters`, only if `selectIsOpenBook(bookId)`.
    5. `clearAnalysisEra({ bookId, epoch })`; if the epoch moved, run again.
  - No terminal-frame or PAUSE trigger exists. This covers Pause (`analysing.tsx:1535-1536`),
    subset Cancel (`generation.tsx:1205-1207`), `stream_no_result` and `aborted`
    (`analysis-stream-middleware.ts:379-398`), refusals (`:403-415`), a reload, and a stale paused
    snapshot (`analysis-slice.ts:282-287`).
- **`src/store/persistence-middleware.ts`.**
  - **Catch-all.** While `selectCastReadOnly` holds for a book, no cast rule (`:139-164`) builds or
    queues anything for that book.
    - Each fired rule raises **one deduped toast**: "Re-analysis running — that change wasn't
      saved" (`dedupeKey: 'cast-read-only'`).
    - Mirrors of server writes are rules like any other, so they produce no save.
  - **Gate-up flushes, never withholds** (B3).
  - **The 409 handler**, placed ahead of the generic refusal branch (`:619-637`), catches a cast
    PUT answering `book_busy`. It:
    - drops the unit;
    - toasts — the analysis copy when the busy cache lists `'analysis'`, otherwise the server's
      sentence;
    - latches the era;
    - starts the single-flight re-hydrate.
- **Item 8a.** `layout.tsx:2777-2779`, `voices.tsx:1005` and the accept caller re-hydrate when a
  merge fails.
- **Tests:**
  `npm test -- src/store/cast-slice.test.ts src/store/book-busy-slice.test.ts src/store/cast-gate.test.ts src/store/persistence-middleware.test.ts src/store/broadcast-middleware.test.ts src/components/layout.test.tsx src/views/voices.test.tsx`.

- [ ] **Step 1: Failing tests.**
  - *B1 (era):*
    - `the era is per book; analysis applies latch only their payload's book`
    - `hydrateCharacters and the book-switch resets never clear or move an era`
    - `B1: re-analyse A, open B, then A ends — B is editable, B's slice never holds A's cast, and no PUT reaches B carrying A's roster`
  - *B2 (release):*
    - `the snapshot leg requires state==='running'`
    - `pause, subset cancel, stream_no_result, aborted, reload mid-run and a stale paused snapshot each release only once busy has no 'analysis'`
    - `the busy poll is single-flight per book and backs off`
    - `an analysis apply after the re-hydrate was issued moves the epoch; the re-hydrate re-runs`
  - *Item 8b (external snapshot):*
    - `another tab's applyExternalAnalysisSnapshot latches the open book's era`
  - *B3 (gate-up flush):*
    - `B3 lands: a unit queued just before the gate flushes and lands before the job registers`
    - `B3 409: a unit that meets the job gets the 409 — toast, era latched, and the run's added rows survive the re-hydrate`
  - *Catch-all, 409 handler and merge re-hydrate:*
    - `while read-only every cast rule (incl. mirrors) builds nothing and raises one deduped toast`
    - `a 409 book_busy cast PUT toasts, latches the era and starts one re-hydrate`
    - `a rejected merge or accept re-hydrates the cast`
- [ ] **Step 2–4:** FAIL; implement; PASS + `npm run typecheck && npm test`.
- [ ] **Step 5: Mutation.**
  - Drop the gate in the persistence middleware → the catch-all test goes red.
  - Let `hydrateCharacters` clear the era → `B1` goes red.
  - Withhold instead of flush → `B3 lands` goes red.
- [ ] **Step 6: Commit** — `fix(frontend): per-book cast gate until reloaded after a re-analysis (#4031)`.

### Task 12: UI — paused-edits banner, disabled controls, Confirm read and voice-match

**Files:**
- New: `src/components/cast-edits-paused-banner.tsx`.
- Views and modals: `src/views/cast.tsx`, `src/modals/profile-drawer.tsx`, `src/views/voices.tsx`,
  `src/modals/duplicate-review-modal.tsx`.
- Confirm: `src/routes/index.tsx:751-797` (ConfirmRoute), `src/components/layout.tsx:1366-1392`.

**Banner.**
- Text: "Re-analysis running — cast edits are paused".
- Shown on Cast, the profile drawer, Voices and Confirm while read-only.
- `role="status"`; at least 44 px on coarse pointers; all three viewports.
- The control lists below are **UX only**. Correctness rests on Task 11's catch-all.

**Controls that stay live** (each saves through its own route, under the cast lock):
- merge; suggestion accept and dismiss;
- voice design / single-design / qwen-voice (design, promote, discard, emotion variant);
- `cast-design`; voice-style generate;
- link-orphan, reject-orphan, not-linked-to;
- add-alias, repoint-alias, unlink-alias (`voices.tsx:856`);
- series-patch (`routes/index.tsx:824`); voice-override-linked;
- the voices override (`voices.tsx:1595`);
- voice-library assign and unassign (`profile-drawer.tsx:432-536`);
- the **tier pin** (`cast-tier.ts`; `cast.tsx:1001`, `:1015`; `layout.tsx:2525`);
- **Add character** (`cast-create`);
- **rebaseline** (`rebaseline-modal.tsx:427-452`).

**Item 4 — link-prior is disabled while read-only** (link-prior, and
`duplicate-review-modal.tsx:135`).
- *Reason:* `cast-link-prior.ts:251-291` writes only the source book's cast. The current book's
  `matchedFrom` and `voiceState:'reused'` arrive through the mirror's PUT.
- Writing them server-side would make this a two-book `withCastLocks` change, which is not
  surgical.

**Controls disabled:**
- profile-drawer Save, rename and tone;
- voice assign / drag-assign;
- lock voice and decline match;
- the compare modal;
- the clone-readiness gate's update;
- link-prior and duplicate-review link.

Each disabled control carries `aria-disabled` and a tooltip.

**Confirm (item 12).** ~~Layout's Confirm override is dropped.~~ (Struck at Task 29: Layout has
no Confirm override; there was nothing to drop.) ConfirmRoute's read
(`routes/index.tsx:751-797`) becomes the busy-gated re-hydrate when the gate is up.

**Voice-match once-guard (item 13).** The Confirm voice-match (`layout.tsx:1366-1392`;
`cast-slice.ts:344`, `voice-match.ts:25-27`) waits until the cast is editable.
- Its once-guard arms only when the match actually runs.
- Between Tasks 11 and 12, the match still runs while read-only. Its `applyVoiceMatches` save is
  caught by the catch-all, so no PUT goes out and one toast shows. The once-guard behaves as today
  (it has run).

- [ ] **Step 1: Failing tests.**
  - `the banner shows on the four surfaces while read-only and not otherwise`
  - `every listed client-slice control is disabled; every listed route control stays enabled`
  - `item 13: the Confirm voice-match skips while read-only, does not arm its once-guard, and runs once after the re-hydrate`
  - `item 13 (Task-11 state): a voice-match while read-only produces no PUT and one toast`
  - `item 12: ConfirmRoute re-hydrates through the busy gate when read-only`
  - `a11y: the banner and disabled controls pass axe` (`npm run test:a11y`)
- [ ] **Step 2–4:** FAIL; implement; PASS + `npm test`.
- [ ] **Step 5: Mutation.** Arm the once-guard when the match is skipped → `item 13` goes red.
- [ ] **Step 6: Commit** — `feat(frontend): pause cast edits during a re-analysis, with a banner (#4031)`.

### Task 13: Manual merge and accept

**Files:** `server/src/routes/cast-merge.ts:128-400`.
- **Union of `notLinkedTo`.** The source's entries are unioned into the target, minus same-book
  entries naming either row.
- **Retirement.** `retireCharacterId(…,'user')`, then clear the edges of each `droppedNotSamePerson`.
- **Cache patch:** `remapCharacterIds`, the `retargetPlanForMerge` decisions, and `ledger {source: null}`.
- **Raw `stage1`** is no longer edited.
- **C3** (confirmed: the `catch (historyErr)` after `:292` only `console.warn`s a non-timeout
  error). Park any error, finish the cache and journal writes, then rethrow. The merge and accept
  routes answer a curated 500. The "EPERM swallowed" cases flip.
- Tests: `cast-merge.test.ts`, `cast-merge.lock-timeout.test.ts`, `cast-merge-suggestions.test.ts`.

- [ ] **Step 1: Failing tests.**
  - *Decline union:*
    - `a merge unions the source's declines but never a same-book one naming either row`
    - `item 13: a cross-book entry whose characterId equals targetId survives`
  - *Plan re-targeting:*
    - `A23b: a merge re-targets the cached plan and chapters and drops the source's ledger entry`
    - `item 12: merging a new row into another new row copies the target's decision`
  - *Dismissals:*
    - `A12d`
    - `F9: dismiss then merge the pair removes the record and both edges`
  - *Failure paths (C3):*
    - `C3: a merge whose history write fails with EPERM finishes every write, then answers a curated 500`
    - the same through accept
- [ ] **Step 2–4:** FAIL; implement; PASS + battery.
- [ ] **Step 5: Mutation.** Move the ledger entry instead of dropping it → `A23b` goes red.
- [ ] **Step 6: Commit** — `fix(server): a manual merge keeps declines, re-targets the plan and fails loud on a lost history write (#4031)`.

### Task 14: Start fresh keeps the user's decisions

**Files:**
- `analysis.ts:4784-4789`: remove `dropReuseContinuityKeepDesignedVoice`.
- `analysis.ts:4888-4973`: keep the cache clear, the edits reset, `editEpoch` and
  `castConfirmed:false`. Remove the cast/carryover `rm`, `clearCastMerges`, `clearSuggestions` and
  `markDeleted`.
- `cast-merges.ts`: `clearAffectedRefs` clears every entry (`:42`; `cast-aliases.ts:389-399`).
- Delete `merge-analysis-cast.ts:59-91`.

Tests that pass `requestedFresh`/`fresh: true`:
- `analysis-pipelining`, `analysis.endpoint-missing`, `analysis.fresh-cast-lock` (replaced),
  `analysis.fresh-state-lock`, `analysis.merge-base-detect`, `analysis.phase-model`;
- `analysis.reasoning-overflow`, `analysis.refuse-while-main`, `analysis.setup-throw`,
  `analysis.stage2-estimate-label`, `analysis.test`, `analysis.title-flags`;
- `analyzer-models`, `selection-error-coding`;
- `merge-analysis-cast.test.ts`, `series-reuse-link.test.ts`.

- [ ] **Step 1: Failing tests.**
  - `rule 8: Start fresh keeps merges, declines, dismissals and series links`
  - `A12e`
  - `Q3: a stopped run's plan suggestion survives a Start fresh`
  - `Start fresh clears every journal entry's affected refs; unlink falls back to alias match`
- [ ] **Step 2–4:** replace `analysis.fresh-cast-lock.test.ts` with
  `rule 8: a cast writer racing Start fresh is not lost`; FAIL → implement → PASS (+ slow).
- [ ] **Step 5: Mutation.**
  - Re-add `clearSuggestions` → `Q3` goes red.
  - Re-add the cast.json `rm` → `A12e` goes red.
- [ ] **Step 6: Commit** — `fix(server): Start fresh keeps merges, declines and suggestions (#4031)`.

### Task 15: Main job — run start and cache classification

**Files:** `analysis.ts`.
- `createWatermarkForJob({ holdForPlan })` (`:628-633`), built after the prior read instead of
  at `:4705`.
- Classify the cache (`:4974`) before the load-rules save (`:4977`) and before the run start.
  - The first save is `{ createIfAbsent: true, version: 2 }`.
  - A `legacy` cache is cleared.
- Run start (`:4784-4886`):
  - `staleReuseLinkKeys` + `materialisePriorAtRunStart` with `runOwnedIds`;
  - heal retirements recorded after the lock;
  - `noteExternalWrite`.
- `:5227-5228` → `mutateAnalysisCache`.
- Re-derive `analysis-pipelining.test.ts`, the heal cases in `analysis.test.ts` and
  `analysis.merge-base-detect.test.ts`.

- [ ] **Step 1: Failing route tests.**
  - `A17a: with per-phase models on a cast book, no Phase-1 take exists before Phase 0b`
  - `A16 (route): Re-parse, then re-analyse — the carryover is in cast.json at run start with its dismissal records`
  - `A11 (route)`
  - `A22 (route): a legacy cache is a miss`
  - `item 9: a first analysis of a new book creates a version-2 cache`
  - `no cast_merge_base_stale warning on a run whose start wrote cast.json`
- [ ] **Step 2–4:** FAIL; implement; PASS + battery (+ slow).
- [ ] **Step 5: Mutation.** Build the watermark without `holdForPlan` → `A17a` goes red.
- [ ] **Step 6: Commit** — `fix(server): materialise the prior cast and hold Phase 1 for the plan (#4031)`.

### Task 16: Main job — Phase 0b plan and snapshots

**Files:** `analysis.ts`.
- Phase-0a snapshot (`:5719-5756`) → SSE only.
- Phase 0b (`:5893-6010`):
  1. plan, then apply;
  2. run the linker on `new` rows only, delete `:5923-5924`;
  3. patch the cache with `{ stage1: raw, matchPlan, decisions }`;
  4. snapshot the **unfolded** plan-applied roster with the plan's suggestions;
  5. patch the cache with `{ ledger, runAddedPairs, decisions }`, applying any re-mint `idMap` to
     the in-memory roster;
  6. `noteExternalWrite`.
- Dedup at `:1107` and `:2500`, and the post-0b preview callers, take the plan constraints and
  `protectIds`.
- `getPhase1Stage1Snapshot` (`:5083-5108`) throws on the rolling roster under `holdForPlan`.
- Re-derive the Phase-0a write and seeded-roster cases in `analysis.test.ts` and
  `analysis.same-book-gate.test.ts`, the premise of `analysis.interim-prune-prohibition.e2e.test.ts`,
  and the seed cases in `series-reuse-link.test.ts`.

- [ ] **Step 1: Failing route tests.**
  - `A14a: stopped after the Phase-0b snapshot and never resumed, the cast is only extended`
  - `F14: a route-given voice on a new row survives a stopped run`
  - `A7c` (#4023 S1–S3)
  - `the Phase-1 prompt lists prior ids and names with analyzer names as aliases`
  - `Phase 0a writes no cast.json in the main job`
  - `Q3 (route)`
  - `record: the job's cast-update frames are written to src/test-fixtures/analysis-cast-update-frames.json`
    — fs write under `RECORD_FIXTURES=1`, plus a staleness check that compares a fresh capture
    with the committed file, read through fs.
- [ ] **Step 2–4:** FAIL; implement; PASS + battery (+ slow).
- [ ] **Step 5: Mutation.** Snapshot the preview-folded roster → `A14a` goes red.
- [ ] **Step 6: Commit** — `fix(server): plan cast identity once at Phase 0b in the main job (#4031)`.

### Task 17: Snapshot-time client replay (after Phase 0b)

**Files:** `src/store/cast-gate.replay.test.ts` and `src/views/cast.replay.test.tsx` (frontend
only).
- `cast-update` frames are **view-only**: the middleware does not consume them
  (`analysis-stream-middleware.ts:31-35`, `:301-303`). The replay therefore dispatches the view's
  own action for each committed frame in `src/test-fixtures/analysis-cast-update-frames.json`:
  `castActions.replaceLiveRoster(frame.characters)`, exactly as `analysing.tsx:736` does.
- It also sets a running snapshot.
- `api` is mocked to record every request.

- [ ] **Step 1: Write the tests.**
  - `replay (during run): after each frame, every cast edit action (rename, updateCharacter, setCharacters, applyVoiceMatches, lockVoice, declineMatch) produces no request and one deduped toast`
  - `replay (during run): a voiced, locked, name-joined prior is never sent anywhere`
  - `component: with the replayed store, the Cast view's Save, rename and voice-assign controls render aria-disabled and the banner is present` (`src/views/cast.replay.test.tsx`)
- [ ] **Step 2:** PASS (`npm test -- src/store/cast-gate.replay.test.ts src/views/cast.replay.test.tsx`).
- [ ] **Step 3: Mutation.** Drop the gate in the persistence middleware → the first replay goes red.
- [ ] **Step 4: Commit** — `test(frontend): replay a re-analysis's cast frames against the cast gate (#4031)`.

### Task 18: Main job — resume

**Files:** `analysis.ts:5178-5239`.
- `current-planned`: re-apply, then `extendPlan` the uncovered rows and save.
- `current-unplanned`: plan, save and snapshot.
- Run the linker on `new` rows only; load `addedRows` and `runAddedPairs`.

- [ ] **Step 1: Failing route tests.**
  - `F1: cast_incomplete → subset Retry → resume_required → main resume plans and completes`
  - `F1: stopped in Phase 0a and resumed, the result equals an uninterrupted run`
  - `A14b: stopped after the snapshot and resumed, the result equals an uninterrupted run` — the
    fixture includes a row this run added before the stop that the resumed persist fold-drops; it
    is gone, as in the straight run
  - `Q2`
  - `item 20: a resumed drift-refused run removes the pairs its pre-stop snapshot added`
- [ ] **Step 2–4:** FAIL; implement; PASS + battery (+ slow).
- [ ] **Step 5: Mutation.** Ignore `addedRows` on resume → `A14b` goes red.
- [ ] **Step 6: Commit** — `fix(server): a resumed analysis reuses or makes the match plan (#4031)`.

### Task 19: Main job — rolls and cache saves

**Files:**
- `analysis.ts`: every main-job cache save becomes a `mutateAnalysisCache` patch of its own fields.
  - The Phase-1 sites are `:6785`, `:6893` (`saveCacheInFailureCatch` overload, `:1646`), the
    pending saves (`:7002-7014`) and the final saves (`:7761` and the persist's flags). Each carries
    `takesPersisted`, `pendingAttributionChapterIds`, `failedChapterIds` and `failedChapterErrors`.
  - The Phase-0a sites are `:5659` and `:5707`.
- `workspace/edits-roll.ts:9-37`: `rollManuscriptEdits(opts, buildRunning, bookId, resolveIds)`
  re-reads under the `book` lock, replaces only its own chapters, and resolves ids. Callers: `:6794`
  and the subset at `:9237`.
- Tests: `edits-roll.test.ts`, `analysis.test.ts`.

- [ ] **Step 1: Failing tests.**
  - `F5: a Phase-1 chapter failure after a mid-run merge keeps the merge, plan and failure record`
  - `A23`
  - `item 8: a Phase-1 save after a failure keeps pendingAttributionChapterIds and takesPersisted`
  - `a roll keeps chapters it did not produce`
- [ ] **Step 2–4:** FAIL; implement; PASS + battery (+ slow).
- [ ] **Step 5: Mutation.** Save the whole cache at `:6785` → `F5` goes red.
- [ ] **Step 6: Commit** — `fix(server): additive cache saves and rolls that never revert a merge (#4031)`.

### Task 20: Main job — persist wiring

**Files:** `analysis.ts`.
- **Strip and fold** (`:7139-7234`) run on plan ids with `protectIds` at `:7160`; `mergedNew`
  re-keys plan pairs; delete `:7221-7234`.
- **`phase1ValidIds`** (`:7241`) = roster ∪ live ids from a lock-free read just before the gate.
- **Persist** (`:7329-7620`) → `persistPlannedCast`:
  - `'analyzer'` retirements are recorded after the lock;
  - `persistLockTimeout` parks;
  - `reconcileRejectEdgesOnDisk` and `dropSuperseded*` stay;
  - `result.characters` = `PersistOutcome.characters`;
  - after `wroteStateJson`, `mutateAnalysisCache({ clearLedger: true, chapters: rerouted, chaptersMode: 'merge' })`.
- **Re-derive:** `analysis.same-book-gate.test.ts`, `analysis.persist-block-degraded-history.test.ts`,
  `analysis.live-id-retire-filter.test.ts`, `analysis.persist-lock-timeout.test.ts` (`:598-930`)
  and `analysis.test.ts`.
- **End-of-run fixture recorder (item 11).** With `RECORD_FIXTURES=1`, the route harness writes
  the persisted cast of a scripted run to `src/test-fixtures/analysis-end-of-run-cast.json` via
  `fs`, never by import. A staleness check compares a fresh capture against the committed file,
  also read with `fs`. Task 21 consumes it.

- [ ] **Step 1: Failing tests.**
  - *Fixture:*
    - `record: the end-of-run cast fixture is current`
  - *Persist behaviour:*
    - `a persist cast-lock timeout fails the job after state.json is written`
    - `persist records analyzer-tagged retirements after releasing the lock`
    - `the result event's characters equal the persisted cast`
    - `item 13: at a completed persist a new row already on disk keeps its user-owned fields from disk`
  - *Ledger and validity:*
    - `F2: a completed run leaves no addedRows or runAddedPairs`
    - `item 17: a twin roster whose takes come from edits-derived cache chapters is not demoted`
  - *Drift:*
    - `A24`
- [ ] **Step 2–4:** FAIL; implement; PASS + battery (+ slow).
- [ ] **Step 5: Mutation.**
  - Write suggestions before the gate → `A24` goes red.
  - Skip `clearLedger` → `F2` goes red.
  - Use roster-only valid ids → `item 17` goes red.
- [ ] **Step 6: Commit** — `fix(server): the main job persists in prior ids, re-reading the cast (#4031)`.

### Task 21: End-of-run client replay and the Playwright spec (after the main persist)

**Files:**
- `src/store/cast-gate.replay.test.ts` (end-of-run cases).
- `e2e/cast-analysis-lock.spec.ts`.
- `src/lib/api.ts`, mock mode (`.env.e2e:1`):
  - `mockAnalyseManuscript` (`:1662-1751`) emits `onCastUpdate` frames, so `replaceLiveRoster` is
    exercised end to end.
  - It records the mock book it runs for (`:1672`, `:1737`) in a `MOCK_RUNNING_ANALYSIS` set,
    cleared when the run resolves. `mockGetBookBusy` (`:2524-2526`) answers `['analysis']` for a
    book in that set.
  - A re-subscribe attaches to the running mock run and **never starts a second one**.
  - `mockPutBookState` (`:1428-1459`) appends every call to an `e2eCallLog` exposed on
    `window.__castwrightMockCalls`.
- The end-of-run disk cast comes from Task 20's recorder (`RECORD_FIXTURES=1` writes
  `src/test-fixtures/analysis-end-of-run-cast.json`).

- [ ] **Step 1: Write the tests.**
  - `replay (end of run): after a running snapshot ends, busy clears and the re-hydrate lands, the first edit's PUT carries the full disk cast`
    — `getBookState` returns the recorded end-of-run cast.
  - **`replay (stop)`, the mutation target.** Pause, then edit:
    - while the snapshot is `paused` and busy still lists `'analysis'`, the edit produces no
      request;
    - once busy returns `[]`, the state-driven poll triggers the re-hydrate;
    - the next edit's PUT carries the full disk cast.
  - Playwright `cast-analysis-lock.spec.ts` (mock mode):
    1. start a mock analysis;
    2. while `onCastUpdate` frames arrive, the banner shows and the drawer Save, rename and voice
       assign are `aria-disabled`;
    3. the mock run resolves and the mock busy clears;
    4. the cast re-hydrates;
    5. a rename persists. The assertion reads `window.__castwrightMockCalls`: exactly one cast PUT
       after the run, carrying every row.
- [ ] **Step 2:** PASS — `npm test -- src/store/cast-gate.replay.test.ts` and
  `npm run test:e2e -- e2e/cast-analysis-lock.spec.ts`, then the full `npm run test:e2e`.
- [ ] **Step 3: Mutation.** Drop the gate in the persistence middleware → `replay (stop)` and the
  Playwright spec go red. Let a PAUSE action release the gate → `replay (stop)` goes red.
- [ ] **Step 4: Commit** — `test(frontend): end-of-run cast reload, replayed and in the browser (#4031)`.

### Task 22: Main job — identity acceptance

Each test asserts cast.json, per-character line counts, history and suggestions.

- [ ] **Step 1:**
  - `A1: #3954 — a single-candidate T3 join keeps the prior id; the voice key does not move`. Its
    **0-line variant**: the joined row gets 0 lines and would fold, and survives as `w2` with its
    voice.
  - `A2` (also pipelined, `A17b`)
  - `A3`
  - `A4`, `A5`, `A6`, `A7`, `A8`, `A9` (with existing aliases), `A10` (no `displaced`), `A15`,
    `A18`, `A21`
- [ ] **Step 2:** PASS; fix any defect found in Tasks 15–20.
- [ ] **Step 3: Mutation.** Drop `protectIds` at `:7160` → the 0-line variant goes red.
- [ ] **Step 4: Commit** — `test(server): re-analysis identity acceptance through the main job (#4031)`.

### Task 23: Main job — mid-run acceptance

- [ ] **Step 1:**
  - *Suggestions and writes made mid-run:*
    - `A12` (lifecycle)
    - `A13`
    - `A19: a fold-dropped run-owned row is gone; one the user gave a voice mid-run through a voice route (routeVoice) is kept`
    - `A19 negative: a fold-dropped run-added row with no route edit is deleted`
  - *Rule 13 and degraded history:*
    - `A20: a mid-run merge whose history write failed — the merge answered 500 (C3); the source stays gone and its lines land on the narrator`
      — asserted via `loadMeasurementInputs` + attribution health (`attribution-health-io.ts:103-115`):
      `demotedNarrator` = the rerouted spoken spans (`attribution-health.ts:264-273`), in edits and
      cache
    - `item 3`
    - `F8`
    - `F8 consequence`
  - *Merge, then re-analysis:*
    - `F9: dismiss → merge → re-analysis joins the survivor and re-raises nothing`
  - *Review Focus:*
    - `Review Focus 2`, `3`, `4`
- [ ] **Step 2:** PASS. **Step 3: Commit** — `test(server): mid-run user writes survive a re-analysis (#4031)`.

### Task 24: Subset job — classification, run start, Phase 0a and finalise

**Files:** `runSubsetAnalyzerJob` (`analysis.ts:8338`).
- **Classify first.** Move `:8547` above `:8460`, before the load-rules save at `:8549`.
  - `legacy`: end `analysis_cache_legacy` before any write.
  - Otherwise the first save is `{ createIfAbsent, version: 2 }`.
- **Run start** as in Task 15.
- **Phase-0a snapshot** (`:8760-8780`): cached-plan rows only. It starts the subset's in-memory
  ledger.
- **Cache saves** (`:8748`, `:8805`, `:8877`, `:8897`) become patches.
- **Finalise** (`:8837-8888`): flow (b) never plans; flow (a) runs `extendPlan`, saves and applies.
- **Linker** (`:9410-9430`): runs on `new` rows only.
- **OpenAPI:** the error-code prose (`openapi.yaml:7264-7271`) adds `analysis_cache_legacy`, then
  `openapi:types`.

- [ ] **Step 1: Failing tests.**
  - *Legacy cache:*
    - `A22 subset` — the fixture includes a same-name prior pair; cast.json and history stay
      byte-identical
    - `the analysing view shows the analysis_cache_legacy message`
  - *Flows:*
    - `subset flow (b) on a v2 cache writes stage1 with no plan`
    - `Q2: subset flow (a) saves its extension decisions`
    - `subset: one analyzer row never gets two cast rows`
  - *Run start:*
    - `A11 subset`
- [ ] **Step 2–4:** FAIL; implement; PASS (+ slow, + `npm test`).
- [ ] **Step 5: Mutation.** Re-plan rows the cache already covers → `one analyzer row` goes red.
- [ ] **Step 6: Commit** — `fix(server): the subset job classifies its cache and reuses the run's plan (#4031)`.

### Task 25: Subset job — Phase 1 and persist wiring

**Files:**
- Dedup at `:9335` runs after the plan; fold at `:9388` gets `protectIds`; delete `:9453-9466`.
- Cache saves `:9130`, `:9228`, `:9858` become patches (with the item 8 fields).
- Rolls at `:9237` use the resolver.
- Persist `:9573+` → `persistPlannedCast`, with the subset's **own in-memory ledger** for the rows
  it adds (invariant 6).
  - For each row it writes that has an entry in `cache.addedRows` (a stopped main run's row), it
    applies compare-then-refresh to that entry via `mutateAnalysisCache`.
  - It never deletes by `addedRows`.
- `subsetValidIds` follows item 17.

- [ ] **Step 1: Failing tests.**
  - *Persist basics:*
    - `subset persist records analyzer-tagged retirements after the lock`
    - `subset result characters equal the persisted cast`
  - *Own ledger:*
    - `subset: a row it added and a voice route then changed is kept at its fold-drop`
  - *Writes to a stopped main run's rows* (none of these is treated as a user change at the
    resumed main persist):
    - `item 10: subset aliases, notLinkedTo, a stale-link prune and a linker stamp on a stopped main run's rows refresh that row's addedRows fingerprint`
    - `item 10: … and the resumed main persist still fold-drops those rows when their user-owned fields are otherwise untouched`
    - `item 10: a route-given voice on such a row between the stop and the subset run IS a user change: the row becomes added-once and survives`
    - `subset never deletes by addedRows`
- [ ] **Step 2–4:** FAIL; implement; PASS (+ slow).
- [ ] **Step 5: Mutation.** Skip the refresh → the first `item 10` test goes red (the resumed
  persist keeps the row as user-owned).
- [ ] **Step 6: Commit** — `fix(server): the subset job persists in prior ids (#4031)`.

### Task 26: Subset job — identity acceptance

- [ ] `describe.each(['main','subset'])` over A1 (with its 0-line variant), A2, A3, A4–A10, A15 and
  A18. Then PASS and commit `test(server): re-analysis identity acceptance through the subset job (#4031)`.

### Task 27: Subset job — mid-run acceptance

- [ ] `describe.each(['main','subset'])` over:
  - A12, A13, A19 (route-given voice kept; un-edited fold-drop deleted), A20, A23 and A24;
  - `F2: a subset run after a completed main run deletes nothing`;
  - `F2: a subset run after a stopped main run deletes nothing by its ledger and refreshes the fingerprints of the rows it writes`.

  **A16 is main-only**: a Re-parse clears the cache (`book-state.ts:1748`). Then PASS and commit
  `test(server): mid-run writes survive a subset run (#4031)`.

### Task 28: Remove the old matchers

**Files:**
- **Old matchers.** Delete `remap-fresh-to-prior.ts`; `mergeAnalysisResultWithExistingCast`,
  `overlayInterimCastForLiveView`, `mergeCore`, `applyRewriteToPriorCast` and
  `seedReuseGuardsFromPriorCast`; `voicedSurvivorsDropped` if it is unused; and
  `stripEstablishedAsciiRewrites` together with `tier1RewriteKeys`.
- **Merge-base plumbing.** Delete `castBase`, `cast-merge-base.ts`, the fingerprint and
  `noteExternalWrite`.
- **The stale-cast warning.** Remove `CAST_MERGE_BASE_STALE_CODE` from the server, `openapi.yaml`
  and `src/lib/api.ts`, then **regenerate** `src/lib/api-types.ts` with `npm run openapi:types`.
  Remove its frontend tests: `api-cast-merge-base-warning.test.ts` and its cases in
  `analysis-stream-middleware.test.ts`, `analysing.test.tsx` and `generation.test.tsx`.
- **Stale comments:** `cast-reject-orphan.ts:348`, `series-reuse-link.ts:241`,
  `handoff/schemas.ts:149`, `cast-id-history.ts:637,775-785`.

**Replacements:**

| Removed | Replaced by |
|---|---|
| `remap-fresh-to-prior.test.ts` | Task 1 (R1–R17, N1a/b, N2 mapped in the commit body) |
| mergeCore / seed blocks | Tasks 1, 7 |
| strip-ascii cases | Task 5 |
| seed cases in `series-reuse-link` / `series-cast-scan` | Task 16 `A7c` |
| `cast-merge-base.test.ts`, `analysis.merge-base-detect.test.ts` | Task 8 `A13` |

**Guard** — `server/src/store/single-matcher.guard.test.ts`:
- **Comparators:** `normaliseNameKey(`, `normaliseForMatch(`, `surnameTolerantMatch(`, `safeId(`,
  `unicodeKebab(`, `.trim().toLowerCase()`.
- **Explicit list, exact counts both ways:**
  - `match-fresh-to-prior.ts`
  - `cast-name-match.ts`
  - `merge-analysis-cast.ts` (the heal)
  - `roster-dedup.ts`
  - `plan-overlay.ts` (**0**)
  - `analysis-cast-io.ts` (0)
  - `routes/analysis.ts` (only the quote normalisation at `:713`, `:726` plus listed non-identity
    occurrences)
- **Narrowed reads-prior rule:** any other file that imports or calls `readPriorCastForMerge`,
  `readPriorCastLockFree` or `materialisePriorAtRunStart` and contains a comparator fails.
- **Reverse check:** passes on today's tree minus the deleted matchers.
- **Blind spots** are stated in the guard's header. The largest (PR #4103 pass 1 G1): rule 1 counts
  comparators only in the listed files and the reads-prior rule only in files that import or call a
  prior reader, so a comparator in a new file, or in a non-importing file its caller feeds the prior
  rows to, passes. What is mechanically enforced is the listed sites' counts, not the absence of
  a second matcher anywhere.

- [ ] **Step 1:** guard (red).
- [ ] **Step 2:** delete; replace tests; typecheck both.
- [ ] **Step 3:** battery + slow + `npm test` + `check:cycles`.
- [ ] **Step 4: Mutations** (each red):
  1. the #3954 `normaliseNameKey` join in the persist — route `A1` also goes red;
  2. the same join via `.trim().toLowerCase()`;
  3. `surnameTolerantMatch` imported into `analysis.ts`;
  4. a `safeId(group[0].name)` survivor in `roster-dedup.ts`.
- [ ] **Step 5: Commit** — `refactor(server): delete the matchers matchFreshToPrior replaces (#4031)`.

### Task 29: Before-shipping chores

- [ ] **Plans.** 278 invariant 9 (`:235`) and near `:244`; `archive/281` gets one line on record
  backing. This plan becomes `status: active`, with Ship notes on merge. Add an INDEX.md entry
  under **D** (`:52`).
- [ ] **Release notes.**
  - `docs/release-notes-next.md`: technical, with `#PR` and the rollback caveat.
  - `RELEASE_NOTES.md`:
    - *"Re-analysing a book now only adds to your cast — characters, voices, names, merges and
      'not the same person' choices all stay; when Castwright isn't sure, it adds the new one and
      asks you."*
    - *"While a re-analysis runs, cast edits pause until the cast reloads, so nothing you see
      mid-run can overwrite it."*
- [ ] **On-box register, one Group B row** (`next-id` bumped).
  - **Setup:** a real voiced book with a merge, a dismissed suggestion and a locked name-joined
    character. Mid-run, design a voice for another character through the voice route. Run it
    sequentially, then with per-phase models.
  - **Observe:**
    - only additions plus the route-given voice;
    - the locked character fully intact;
    - new history entries tagged `analyzer`;
    - no growth in `displaced`;
    - no `attribution_drift`;
    - suggestions for ambiguous names; the dismissed one does not return;
    - the banner and disabled controls during the run, and editable after the reload;
    - Start fresh keeps everything;
    - stop and resume match a straight run.
  - Update `docs/testing/cast-id-drift-onbox-acceptance.md`, run `register:build` and
    `check:onbox-register`, and publish the live view (`--against-published`).
- [ ] **Reviewer brief.** Add entry 77 (or the next free number); `skills:sync` after merge.
- [ ] **CLAUDE.md:**
  - "Two allowlisted exceptions" → one;
  - recount "TWELVE … fail loud" / "TWELVE … swallow" (persist via `persistPlannedCast`, Phase-0a
    swallows gone, merge history now loud);
  - **recompute the `requestFailureMessage` call-site enumeration** (`git grep requestFailureMessage`),
    item 22, counting the new dismiss and merge-failure sites.
- [ ] Close PR #4023 unmerged (owner). **Commit** — `docs(docs): plan 291 ship chores (#4031)`.

## Round-1 minor items (F16) — where each lives

| Item | Location |
|---|---|
| Heal refuses on an open suggestion on either member | Task 4 |
| `extendPlan` takes a fresh runToken | Task 1 |
| forget/restore/undo preserve kind | Task 2 |
| Reversibility claim corrected | *Architectural impact* |
| Start fresh clears dedup/fold `affected` refs | Task 14 |
| Persist's book-lock wait documented | *Global Constraints* |
| Field ownership (incl. tone) | *Global Constraints*, Task 7 |
| `readPriorCastLockFree` fingerprint; `previewFoldForLiveView` signature | *Interfaces* |
| Task 1 import cycle | `cast-name-match.ts`; `check:cycles` in Task 1 |

## Task-to-acceptance map

| Spec item | Task(s) | Test(s) |
|---|---|---|
| A1 #3954 | 1, 22, 26 | `A1` unit; route `A1` + 0-line, main & subset |
| A2 twins | 1, 20, 22, 26 | `A2`; route `A2`; `item 17` |
| A3 degraded | 1, 22, 26 | `A3` unit; route `A3` main & subset |
| A4–A6 | 1, 22, 26 | unit + route, main & subset |
| A7 P5-2 | 1, 5, 7, 16, 22 | `A7`, `item 1`, `A7b`, `F3`, `A7c`, route `A7` |
| A8 rule 1 | 7, 22, 26 | `A8`; route |
| A9 rule 2 | 7, 22, 26 | `A9` (existing aliases); route |
| A10 rule 3 | 1, 22, 26 | `A10`; route (no `displaced`) |
| A11 heal | 4, 8, 15, 24 | `A11` ×4; `skipIds`; `heal written`; `A11 (route)`; `A11 subset` |
| A12 lifecycle | 1, 2, 3, 13, 14, 23, 27 | `open-question`; `A12c`; `A12a`; `A12d`; `A12e`; route main & subset; `F9` |
| A13 mid-run | 8, 23, 27 | `A13` io; route main & subset |
| A14 stopped run | 16, 18, 21 | `A14a`; `F14`; `A14b` (fold-dropped run-added row); `replay (stop)` |
| A15 minted | 1, 8, 22, 26 | `A15`; `F11`; `item 12` re-mint; route |
| A16 re-parse | 8, 15 | `A16` io; `A16 (route)` (main-only, justified) |
| A17 pipelined | 15, 22 | `A17a`; `A17b` |
| A18 narrator | 1, 7, 22, 26 | `A18`; `A18b`; route main & subset |
| A19 rule 11 | 7, 23, 25, 27 | `A19` unit; `F2` ×3; route `A19` (route voice kept; un-edited deleted) main & subset; subset fold-drop |
| A20 rule 13 | 7, 13, 23, 27 | `A20` unit; `C3`; route (500 + spans) main & subset; `item 3` |
| A21 provenance | 1, 2, 22 | `A21`; kind tests; route |
| A22 legacy cache | 6, 15, 24 | `classifyAnalysisCache`; route; subset |
| A23 merge, other files | 13, 19, 27 | `A23b`; `A23`; `F5`; route subset |
| A24 drift-refused | 8, 18, 20, 27 | `A24` io; `item 20`; route main & subset |
| A25 unit | 1, 5, 28 | `A25a`; `A25c`; guard + 4 mutations |
| Rule 1 | 7, 22 | `A8` |
| Rule 2 | 1, 7, 17 | `A9`; `replay (during run) … locked … prior never sent` |
| Rule 3 | 1, 13, 22, 23 | `A10`, `A4`, `rule 3 over a decline`, `F9` |
| Rule 4 | 1, 3, 4, 5, 16 | `Review Focus 2`, `A12a`, `A11 … dismissal`, `item 1`, `A7c` |
| Rule 5 | 4, 8, 15, 24 | the `A11` set |
| Rule 6 | 1 | `A4/N2` |
| Rule 7 | 1, 3, 16, 23 | `A5`, `A6`, `open-question`, `Q3 (route)`, route `A12` |
| Rule 8 | 14 | `rule 8…`, `A12e`, `Q3: … Start fresh` |
| Rule 9 | 1, 7, 22, 23 | `A3`, `F8` ×3 |
| Rule 10 | 15 | `A17a` |
| Rule 11 | 6, 7, 8, 18, 20, 23, 25, 27 | `A19` (unit ×2, route ×2 per job); `F2: the job's own rewrite … does not convert`; `F2: a user-owned field changed … added-once`; `F2: not re-added`; `A14b`; `F2: no addedRows`; subset own-ledger test; `item 10` ×3 (subset writes refresh; resumed fold-drop still deletes; route voice is user-owned); `F2: subset after completed/stopped` |
| Rule 12 | 1, 2 | `untagged reads as user`, `A21` |
| Rule 13 | 7, 23 | `A20`, `item 3`, `Review Focus 4` |
| Owner: delete never trips drift | 23 | `Review Focus 4` |
| Owner: lock until reloaded (+ B1–B3) | 10, 11, 12, 17, 21 | PUT 409 `book_busy` ×2 + audit; `B1` ×3 (per-book era, no leak A→B); `B2` ×4 (running-only snapshot leg, every exit releases via busy, single-flight backoff, epoch re-run); `item 8b` other tab; `B3 lands` / `B3 409`; catch-all toast; 409 handler; UI banner/disabled/ConfirmRoute/voice-match once-guard/a11y; replays (during run ×3 incl. component; end of run; `replay (stop)` mutation target); Playwright with mock call log |
| Cache lifecycle | 6, 15, 18, 24 | `classifyAnalysisCache`; `item 9`; `F1` ×2; `Q2` ×2; `item 20`; `subset flow (b)` |

### PR #4023 tests and where they land

| #4023 test | Disposition |
|---|---|
| keep-prior-id A1–A3 | Tasks 22/26 `A1` |
| keep-prior-id P4-3 | Task 16 `A14a`, Task 18 `A14b` (P4-3(b) overturned) |
| same-book-gate interrupted / partial-roster | Tasks 16/18 |
| persist-block-degraded-history | Task 22 `A3` (P3-1 overturned) |
| `protectRecordedMergeAmong` | Tasks 1/22 `A10`; not ported |
| merge-analysis-cast finding 3/7, N4; N1, P3-2/N2; P4-2 | Task 1 `A2`, `A7`, `A4/N2` (N2 overturned), `A5` |
| remap R1–R17, N1a/b, N2 | Task 1 (R4, R7, R17 overturned) |
| series-reuse-link S1–S3 | Task 16 `A7c`, Task 22 `A1` |
| reviewer-brief entry 89 (77 was taken on main) | Task 29 |

## Test plan

### Automated coverage

- **Server.**
  - Route acceptance lives in `server/src/routes/analysis.single-matcher.test.ts`. Tasks 26/27 use
    `describe.each(['main','subset'])`.
  - A16, A17, F1, the stop/resume cases and the replays are main-only.
  - The server records SSE frames and the end-of-run cast to `src/test-fixtures/` through fs; the
    frontend replays them.
- **Browser.** Playwright `e2e/cast-analysis-lock.spec.ts` (Task 21).
- **Guards on every task:**
  - `cast-lock.guard`, `cast-id-history.stamp.guard`, `book-op-lock.guard`, `state-lock.guard`,
    `state-json-lock.guard`;
  - from Task 28, `single-matcher.guard`;
  - `check:cycles`.

### Manual acceptance walkthrough

Real backend (`npm run dev`); a voiced book with a merged pair, a dismissed suggestion and a locked
character.

1. Copy `.audiobook/{cast,cast-id-history,cast-merge-suggestions}.json`.
2. Re-analyse. Expected:
   - the Cast, Voices and Confirm views show "Re-analysis running — cast edits are paused";
   - rename, drawer Save and voice assign are disabled;
   - designing a voice for a character still works.
3. When the run ends, the banner clears after the cast reloads. Rename a character. Expected: one
   cast PUT carrying every row.
4. Diff the files. Expected: additions, the designed voice and the rename; new history entries
   tagged `analyzer`.
5. Pause a second run mid-way. Expected: edits stay paused until the cast reloads, and no character
   is lost.
6. Dismiss a suggestion and re-analyse. Expected: it does not return.
7. Start fresh. Expected: steps 2–6 still hold.

## Out of scope

The series linker's cross-book matching, new analysis UI beyond the banner, the analyzer prompts,
chapter splitting, and the fe-11 class (tabs that missed the run). `remapCjkHonorificIds` stays.

## Ship notes

Shipped date and merge SHA: (filled in on merge, when this plan moves to `archive/`).

- Spec conflicts and late rulings (R11, R12, R13, R22, R35, R38, R42, R43, R46, R47, M4) are
  recorded under *Spec conflicts found* above; the spec's acceptance 14, 20 and 24 and its
  "New UI" non-goal are amended to match.
- On-box acceptance owed: one Group B row (B109) in `docs/testing/onbox-acceptance-register.md`
  (run sheet `docs/testing/cast-id-drift-onbox-acceptance.md`).
- Rollback: not data-safe on its own (see *Architectural impact*): revert, then Start fresh (old
  code) on books analysed under v2, or delete their analysis cache.
- Docs chores done in Task 29: plan 278 invariant 9, `archive/281` backing line, `CLAUDE.md`
  recounts, reviewer-brief entry 89, release notes.
- PR #4023 (`fix/server-3954-keep-prior-id-on-name-join`) was already closed, unmerged.

---

## Handover brief (copy to #4031)

**Plan:** `docs/features/291-reanalysis-single-matcher.md`.
**Spec:** `docs/superpowers/specs/2026-11-06-reanalysis-single-matcher-design.md` (Rules 1–13,
Acceptance 1–25).

**Decided:**
- **Owner, 2026-11-06:** a subset run on a pre-upgrade cache stops with `analysis_cache_legacy`; a
  mid-run delete never trips drift.
- **Owner, 2026-11-08 — lock until reloaded**, with the B1–B3 builder fixes. The cast is
  read-only **per book** while either of these holds:
  - the book has a running analysis (a `running` snapshot, or busy);
  - the book has an era, latched by any analysis it sees, a 409, or another tab.

  The era clears only through a single-flight, epoch-checked disk read issued once busy has no
  analysis and the snapshot is not running. The release is driven by state, not by frames or the
  PAUSE action.
  - When the gate goes up, the outbox is flushed. While read-only, no cast-slice save is built or
    queued, and one deduped toast covers any cast rule that fires.
  - The server refuses the whole-slice cast PUT with 409 `book_busy` (the existing shape). The
    client toasts, latches the era, and re-hydrates.
  - Edit controls are disabled behind a banner (UX only); route-backed controls stay live;
    link-prior is disabled.
  - Rule 11 compares disk against the job's own **last** write before each write, then refreshes
    the fingerprint. The main job's ledger is cached; the subset job keeps its own and refreshes
    `addedRows` entries for the rows it writes.
  - This replaces the per-row/batch PATCH design, which has been removed.
- **Builder's calls** are under *Rulings recorded*.
- Nothing is open.

**Entry point:** Task 1 (`server/src/store/match-fresh-to-prior.ts`; pure; no caller).

| Tasks | Scope |
|---|---|
| 2–9 | Seams |
| 10 | The server PUT 409 and the writer audit |
| 11–12 | The client gate and the UI |
| 13–14 | Merge and Start fresh |
| 15–16 | Main run start and Phase 0b |
| 17 | Snapshot-time replay |
| 18–20 | Main resume, rolls and persist |
| 21 | End-of-run replay and Playwright |
| 22–23 | Main acceptance |
| 24–27 | Subset |
| 28 | Delete the old matchers and add the guard |
| 29 | Chores |

Each task is one cold implementer plus one fresh reviewer. Every task ends with the full
`npm run test:server` and the typecheck green.

**Global constraints:**
- **Locks:** the order above; locked writes only; nothing slow under the lock; retirements after
  release; `castBase?.noteExternalWrite` until Task 28.
- **Identity:** rule 3 wins; `inheritedDeclines` is plan-only, and only cross-book entries persist.
- **Rule 11:** fingerprint over user-owned fields = the job's own last write; compared before, refreshed after each job write (incl. the subset's writes to `addedRows` rows); `added-once` is sticky.
- **Cache:** `mutateAnalysisCache` is one non-re-entrant op; the version is written as given.
- **Tests:** analysis-route tests run with `OLLAMA_URL=http://127.0.0.1:1`; server tests never
  import root `src/`; every deleted test names its replacement; #4023 expectations are re-derived.

**Key files:**
- `server/src/routes/analysis.ts`:

  | Area | Lines |
  |---|---|
  | run start | `:4784-4973` |
  | cache | `:4974` |
  | resume | `:5178-5239` |
  | Phase 0b | `:5893-6050` |
  | rolls/cache | `:6785-6811`, `:6893` |
  | persist | `:7107-7620` |
  | subset | `:8338-9862` |
- `server/src/routes/book-state.ts:1229-1250`.
- `src/store/cast-slice.ts:39-52,145,320,358,390`.
- `src/store/persistence-middleware.ts:139-164,435-436,619-637,825`.
- `src/store/analysis-stream-middleware.ts:31-35,301-303,379-398,403-415`; `src/store/broadcast-middleware.ts:316-337,402-410`; `src/store/analysis-slice.ts:282-287`; `src/store/reset-book-slices.ts:13`; `src/routes/index.tsx:226,283,693,751-797,824`.
- `src/components/layout.tsx:900-918,1366-1392,2525,2777-2779,2913-2919`.
- `src/views/cast.tsx`, `src/views/voices.tsx`, `src/views/generation.tsx:832-1190`.
- `src/lib/api.ts:2511-2526`.
- Server stores and routes: `merge-analysis-cast.ts`, `remap-fresh-to-prior.ts`, `roster-dedup.ts`,
  `cast-id-history.ts`, `cast-merge-suggestions.ts`, `analysis-cache.ts`, `analysis-cache-rebuild.ts`,
  `cast-merge.ts`, `cast-merge-suggestions.ts` (route), `reject-edge-reconcile.ts`, `edits-roll.ts`.
- PR #4023's branch `fix/server-3954-keep-prior-id-on-name-join` (Task 9 ports its harness).

**Acceptance:** every Acceptance item 1–25, every Rule 1–13, both owner rules and the cache
lifecycle map to named tests in the *Task-to-acceptance map*. The PR closes #4031, #4032 and #3954;
#4023 is closed unmerged.
