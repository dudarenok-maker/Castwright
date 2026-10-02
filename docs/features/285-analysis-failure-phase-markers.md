---
status: draft
shipped: null
owner: null
---

# 285 — Analysis failure bookkeeping: explicit phase and completeness markers (#3435)

> Status: draft. The design was approved by the owner on 2026-10-03. Supersedes PR #3439.
>
> Key files:
> - `server/src/routes/analysis.ts`
> - `server/src/store/analysis-cache.ts`
> - `server/src/store/analysis-cache-rebuild.ts`
> - `server/src/store/analysis-state.ts`
> - `server/src/workspace/scan.ts`
> - `src/views/analysing.tsx`
> - `src/views/generation.tsx`
> - `src/store/analysis-stream-middleware.ts`
> - `src/lib/analysis-phase-state.ts`
>
> URL surface: indirect. The Analysing view and the Generate-view Re-analyse and Include actions; the library badge.
> OpenAPI ops: `GET /api/books/{bookId}` (`analysis.failedChapterErrors[].phase`), and the `POST /api/manuscripts/{id}/analysis` and `…/analysis/chapters` SSE terminal codes.

- **Design:** [2026-10-03-analysis-failure-phase-markers-design.md](../superpowers/specs/2026-10-03-analysis-failure-phase-markers-design.md). Section numbers below (§, M-rules, S-rules, D1–D5) refer to it.

## Benefit / Rationale

- **User:**
  - A Retry that fails stays failed, on screen and after reload.
  - A Retry never produces a "finished" book that is missing chapters.
  - A Retry run while the main analysis is going pauses it and picks it up again afterwards, even if you leave the page.
  - Rows say whether cast detection or speaker attribution failed.
- **Technical:**
  - Two facts the code used to infer are now explicit: which phase failed (`phase` on the record) and whether a chapter has a current take (`hasCurrentTake` plus the pending set).
  - The main replay, the subset result gate and the library badge share one predicate.
- **Architectural:**
  - Main and subset jobs on one manuscript are mutually exclusive on the server.
  - The rebuild from edits becomes an overlay that respects deleted sentences.

## Architectural impact

- **New seams:**
  - `ChapterErrorRecord.phase`;
  - `normaliseFailureRecords`, `hasCurrentTake`, `cache.pendingAttributionChapterIds`;
  - `startMainAnalyzerJob`, `pendingMainResume`, `job.finished`, `job.ended`, `job.reasoningOverflowPhase`, `job.failingPhase`;
  - `AnalysisStateFile.mainPausedForRetry`;
  - rebuild `mode`.
- **Invariants preserved:**
  - the #3084 overflow halt with `fixes`;
  - #3430's ordered saves (`saveCacheInFailureCatch` → `saveAnalysisCache`);
  - the #2196 guarded snapshot writes;
  - the voice-strip guard (`analysis-pill-gate.ts`, `active-analyses.ts:88`).
- **Migration:**
  - Lazy, on load (`normaliseFailureRecords`), with no rewrite pass. Legacy rules: spec §2.1.
  - `pendingAttributionChapterIds` is absent on legacy caches and means empty.
  - openapi gains one required field, and three soft codes in prose.
- **Reversibility:**
  - Each task is its own commit.
  - T7 (the server pause) can be reverted on its own; the client pause-and-retry comes back with it.
  - The cache field and `phase` are additive, so older builds ignore them.

## Invariants to preserve

1. **Cast-failure marker:** a cast failure writes `chapterCast[id] = []` (`analysis.ts:4756`, `:7472`), and a cast success sets the cast and clears the id synchronously (`:4779-4807`).
2. **The main run's result** needs every non-excluded chapter in `sentencesByChapter` (`analysis.ts:5975-5978`).
3. **The overflow terminal** carries `fixes`, and the middleware's persistent toast (`analysis-stream-middleware.ts:283-316`) is unchanged.
4. **Cold boot** never surfaces a halted or paused pill for a cast-confirmed book (`src/lib/analysis-pill-gate.ts:15-21`).
5. **The interim-write lock contract** (#1981) is unchanged: interim cast.json writes go through `castBase.writeChecked` (`analysis.ts:7444-7448`).
6. **A main run on a confirmed book keeps the cast's designed voice fields** (merge via `mergeAnalysisResultWithExistingCast`; pinned by a test in T6).

## Conventions for every task

- **Server tests:** run from `server/`, with no live analyzer:
  `OLLAMA_URL=http://127.0.0.1:1 npx vitest run <files> --retry=0`
- **Frontend tests:** run from the repo root:
  `npx vitest run <files> --retry=0`
- **Typecheck:** `npm run typecheck`. After any openapi edit: `npm run openapi:types`.
- **TDD:** write each named test first, run it, and confirm it is **RED for the stated reason** before implementing.
- **Ported tests:** copy the probe's body from 9a063ea6 (`git show 9a063ea6:server/src/routes/analysis.reasoning-overflow.test.ts`, and the same for `src/views/analysing.test.tsx`). Then adapt the seeds to `phase`.
- **Branch:** a new branch from `origin/main`, e.g. `fix/server-failure-phase-markers`. Commits end with the attribution lines. The PR body says "Supersedes #3439" and "Closes #3435".

## Tasks

### T1 — `phase` on the failure record (no behaviour change beyond tagging)

**Files:**
- `server/src/store/analysis-cache.ts`
- `server/src/routes/analysis.ts` (helpers `:1382-1426` and the four record sites)
- `openapi.yaml:8208-8220`
- `src/lib/api-types.ts` (generated)
- `src/lib/types.ts:516`
- `src/lib/api.ts:3012-3020`
- the replay map (`analysis.ts:2701-2710`, `:3071-3082`)

**Tests first** (`server/src/store/analysis-cache.test.ts` and `server/src/routes/analysis.test.ts`; all records seeded **untagged**):

| Test | Expectation |
|---|---|
| `normalise: N1 residue {attribution-incomplete, cast [], take, no stage1} → cast` | RED: no `phase` field |
| `normalise: attribution-* with stage1 → attribution` | — |
| `normalise: 06-05 shape (id, no record, non-empty cast) → attribution with synthesised unknown record` | — |
| `normalise: dev-build untagged analyzer-timeout with a cast → attribution` | — |
| `normalise: tagged record is never reclassified` | — |
| `recordFailedChapter: attribution write onto cast record is a no-op and returns the cast record` | — |
| `cast-merge round trip keeps phase` (`cast-merge` test) | — |
| `GET book-state returns phase` (`book-state` test) | — |
| `api parses chapter-failed phase` (`src/lib/api.test.ts`) | — |

**Implementation:**
1. Add the type, `normaliseFailureRecords` and the helpers (spec §2.1).
2. `recordFailedChapter` gains `phase` and returns the effective record.
3. Tag the sites: `'cast'` at `:4759` and `:7475`; `'attribution'` at `:5778` and `:7832`. Each `send` uses the returned record.
4. Add `phase` to openapi and the SSE payload, then `npm run openapi:types`.

**Verify:**
- `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/store/analysis-cache.test.ts src/routes/analysis.test.ts src/routes/cast-merge.test.ts --retry=0`
- `npx vitest run src/lib/api.test.ts --retry=0`
- `npm run typecheck`

**Accept:** every record carries `phase`, and nothing else behaves differently. Shippable.

### T2 — Overflow phase, dispatch split, main Phase-1 recording, labels

**Files:** `server/src/routes/analysis.ts` (`:2470-2493`, `:5429-5466`, `:5887-5941`, `:6686-6696`).

**Tests first** (`analysis.reasoning-overflow.test.ts`):

| Test | RED at `origin/main` |
|---|---|
| **P-zeta:** pool width 1, ch1's escalation overflows; no `chapter-failed` for ch2, no record | — |
| **A9 pipelined:** ch1's Phase-0 overflow rethrown at ch1's Phase-1 dispatch records nothing | — |
| **P-gamma** (port): a main Phase-1 throw records `attribution` and sends `chapter-failed` | RED: no main record |
| **MD:** a Pause during the main Phase 1 records nothing | — |
| **MG:** with split models, both the row and the terminal error name the Phase-1 model | RED: the terminal names Phase 0 |
| Sequential last-chapter escalation overflow: the terminal names the Phase-1 model | RED |
| Pipelined Phase-0 overflow: the terminal names the Phase-0 model | — |
| Overflow row names its chapter | RED: "a chapter" |
| Main save-guard: a throwing save keeps the original error (port from ced13d18) | — |

**Implementation:**
1. Add the `phase` argument to `noteReasoningOverflow` at all seven callers (spec §3.1).
2. Split out `phase1Dispatch` with `'run' | 'skip'` (`continue` on skip).
3. In the pool catch: `record(a)` with `{chapter}` for non-aborts, and set `job.failingPhase ??= 1`.
4. Compute the terminal label from the overflow phase, then `failingPhase`, then the default.

**Verify:** `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/routes/analysis.reasoning-overflow.test.ts src/routes/analysis.phase-model.test.ts src/routes/analysis.test.ts --retry=0`

**Accept:** the existing `chapter-failed` handling shows the new rows. Shippable.

### T3 — Fact-1 consumers, subset Phase-1 recording, soft `cast_incomplete`, panel by phase

**Files:**
- `server/src/routes/analysis.ts` (`:1468-1480`, `:4468-4479`, `:7524-7610`, `:7746-7774`)
- `src/store/analysis-stream-middleware.ts`
- `src/lib/analysis-phase-state.ts`
- `src/views/analysing.tsx`
- `src/views/generation.tsx`
- `src/components/analysing/phase-card.tsx`
- `src/components/top-bar.tsx`

**Tests first.** Server (`analysis.reasoning-overflow.test.ts` and `analysis.test.ts`):

| Test | Expectation |
|---|---|
| #3435 base (port cd352bc6): a Phase-1 timeout, unreachable or overflow on Retry records and sends `chapter-failed` | RED |
| **P3**, **P2**, **PB** (port) | — |
| **P-theta, pre-existing half:** Retry and Re-analyse on a book with a narration-only chapter reach Phase 1 | RED: `cast_incomplete` |
| `isPhase0aCoverageComplete` | Signature with `castFailedIds`; "[] without a cast record is covered" |
| **S5:** gate exit sends `cast_incomplete` naming the chapter | RED: silent |
| **S6** via `endJob` | — |
| Port 747c7e42's `beforeAll` | — |
| Port eba51456's label switch and save guard | — |

Frontend (`analysing.test.tsx`, `analysis-stream-middleware.test.ts`, `generation.test.tsx`):

| Test | Expectation |
|---|---|
| A subset `cast_incomplete` gives needs-action with no toast | — |
| A Retry ending with no `chapter-resolved` keeps the row (port 9d45e712) | — |
| `chapter-resolved` → `chapter-failed` → `error` keeps the row | — |
| An attribution row does not block the armed auto-resume | — |
| Heading and subtext per phase | — |
| A synthesised row inherits its phase | — |
| `castIncomplete` rehydrates from the snapshot | — |
| The needs-action line shows `haltReason` | — |
| Generate view: `cast_incomplete` shows the message and rolls back | — |

**Implementation:**
- Server: spec §2.1 consumers; S5 and S6.
- Client: the parts of spec §3.4 for `cast_incomplete`, the rows, auto-resume, copy (§4), the needs-action line and the pill.

**Verify:**
- Server: `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/routes/analysis.reasoning-overflow.test.ts src/routes/analysis.test.ts src/routes/analysis.merge-base-detect.test.ts --retry=0`
- Frontend: `npx vitest run src/views/analysing.test.tsx src/store/analysis-stream-middleware.test.ts src/views/generation.test.tsx --retry=0`

**Accept:** the #3435 symptom is fixed (record kept, row kept), and no red toast appears for soft frames. Shippable: every new server frame lands with its client handling.

### T4 — Current take: predicate, pending set, overlay rebuild, word-free, library

**Files:**
- `server/src/store/analysis-cache.ts`
- `server/src/store/analysis-cache-rebuild.ts`
- its callers: `generation.ts:1020`, `chapter-splice.ts:249`, `chapter-qa-repair.ts:403`, and `chapters-restructure.ts:186` (`'replace'`)
- `server/src/routes/analysis.ts` (`:5305-5317`, `:5816-5828`, the Phase-1 call sites)
- `server/src/workspace/scan.ts:789-801`

**Tests first:**

| Test | Expectation |
|---|---|
| Predicate table | non-empty / pending / word-free `[]` / worded `[]` + record / no key; with and without `body` |
| Overlay | Keeps word-free `[]` and excluded chapters; a chapter in the edits replaces wholesale, so a tombstoned sentence stays gone; an absent non-excluded non-empty chapter is removed. RED: replace semantics |
| A Generate POST keeps a word-free key (`generation` route test) | — |
| A pending chapter's take survives the main roll and a rebuild | RED: dropped from edits |
| Word-free short-circuit | No analyzer call, no flag, all bookkeeping runs (`completedSet`, phase tick) |
| M0 heals a legacy word-free `attribution-incomplete` record | — |
| `scan` | A pending chapter with no current take reads analysing; a flagged chapter with a take reads analysed |

**Implementation:** spec §2.2.

**Verify:** `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/store/analysis-cache-rebuild.test.ts src/store/analysis-cache.test.ts src/workspace/scan.test.ts src/routes/analysis.test.ts src/routes/generation.test.ts --retry=0`

**Accept:** one predicate is used in three places. Shippable: nothing writes pending ids yet.

### T5 — Record lifecycle: M1, M4, M8, S0, S3, S4

**Files:** `server/src/routes/analysis.ts` (`:4080-4098`, `:4779-4800`, `:5751-5761`, `:7312-7425`, `:7775-7779`).

**Tests first:**

| Test | Expectation |
|---|---|
| **P-alpha** and its reverse interleaving (port 3389e7c7) | — |
| **P-theta:** resume clears; Retry attributes | — |
| **PE** and PE-negative (port cdf2b56a / 4aa9112c) | — |
| **PD-main**, changed assertion | ch1's `cast` record clears at Phase-0a success; ch1 stays in P; a Phase-1 throw re-records `attribution` |
| **P1**, **PD**, uncached cast-failed chapter paused in Phase 1 | — |
| **S7** | Record is `attribution` after promotion |
| Finished-book main run replays a flagged chapter that has a take (MS3) | — |

**Implementation:** spec §3.1 M0/M1/M4/M8/M9, §3.2 S0/S3/S4/S9/S10.

**Verify:** the server command from T3, plus `src/routes/analysis.phase-model.test.ts`.

**Accept:** decision (i) is in place, with no take deleted. Shippable.

### T6 — Subset result gate and `resume_required`

**Files:**
- `server/src/routes/analysis.ts` (`:7611-7625`, `:7884-8380`, `endJob` `:3179-3293`, `persistRunningSnapshot` `:2941-2989`)
- `openapi.yaml:5629-5637`
- `src/lib/analysis-phase-state.ts`
- `src/store/analysis-stream-middleware.ts`
- `src/views/analysing.tsx`
- `src/views/generation.tsx`

**Tests first.** Server:

| Test | Expectation |
|---|---|
| **P-delta** | `resume_required` naming ch3; no state.json or cast.json final write; interim roll present. RED: `result` |
| **P-eta** | `resume_required` while ch1 is pending; main resume then `result` |
| **P-beta (server)** | S8 sends `resume_required` |
| Finished-book Retry | Sends `result` and deletes the subset snapshot |
| Running snapshot after `endJob` | Not written |
| Hint snapshot | Ignores a mid-run Exclude |
| Main run on a confirmed book | Keeps voice fields (invariant 6) |

Frontend:

| Test | Expectation |
|---|---|
| **P-beta (view)** | Armed `cast_incomplete` + `resume_required` → main POST |
| Unarmed `resume_required` | Needs-action line, Resume button, no POST |
| Snapshot kept | Survives unmount |
| Analysing subset shrink | Accept re-runs the subset with `allowStage1Shrink` |
| Main re-entry | Does not clear a subset shrink banner |
| Generate view | No Include rollback on `resume_required`; inline "Accept smaller cast" for shrink |

**Implementation:** spec §3.2 S8/S14, §3.3 snapshot rules, §3.4.

**Verify:**
- Server: `OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/routes/analysis.reasoning-overflow.test.ts src/routes/analysis.test.ts src/routes/analysis.request-log.test.ts src/routes/analysis.setup-throw.test.ts src/routes/analysis.persist-lock-timeout.test.ts src/routes/analysis.merge-base-detect.test.ts src/routes/analysis.phase-model.test.ts --retry=0`
- Frontend: the T3 command.

**Fixtures:** update every test that seeds stage1 with a chapter lacking a current take and asserts a `result` or persist. Example: `analysis.test.ts:4206` must seed ch1's take.

**Accept:** a Retry never sends or persists a `result` for an unfinished book. Shippable.

### T7 — Pause the main run for real (D2)

**Files:**
- `server/src/routes/analysis.ts` (`:3357-3645` → `startMainAnalyzerJob`; `:6642-6650`; `:6707-6729`; `:6877-6900`; `endJob`)
- `server/src/store/analysis-state.ts`
- `src/views/analysing.tsx` (`:851-1129`)
- `src/store/analysis-stream-middleware.ts`
- `src/lib/api.ts` (surface `mainResumed` on `result` and on `AnalysisError`)

**Tests first.** Server (new `analysis.pause-for-retry.test.ts`):

| Test | Expectation |
|---|---|
| Subset POST with a live main | Main ends `paused_for_retry` with a **paused** snapshot; the subset loads the cache only after `main.finished`, i.e. after an in-flight worker's save has landed. RED: concurrent |
| Subset `result` | Main restarts; the final frame has `mainResumed: true` |
| Subset ends `aborted`, `stage1_shrink_refused` or `analyzer-reasoning-overflow` | No restart |
| Main POST during a subset | `retry_in_progress`; main starts when the subset ends |
| Fresh POST during a subset | Aborts the subset, then starts |
| `/pause` | Clears the intent |

Frontend:

| Test | Expectation |
|---|---|
| Retry while main streams | Sends no client abort; ignores `paused_for_retry`; on `mainResumed` re-subscribes |
| Unmounted view | The middleware switches to the main handle on `mainResumed` |
| Without `mainResumed` | No main POST |

**Implementation:** spec §2.4 and the §3.4 middleware and view rows. Re-scope the #3436 comment (spec §2.6).

**Verify:** the server command from T6 plus `src/routes/analysis.pause-for-retry.test.ts`, the T3 frontend command, and `npm run typecheck`.

**Accept:** the main and subset jobs on one manuscript never write at the same time. Shippable.

### T8 — Docs and follow-ups

**Release notes, `RELEASE_NOTES.md`:**

> A chapter whose Retry fails now stays marked as failed, even after a reload. A Retry no longer reports a book as finished while other chapters still need attribution — it asks you to resume the analysis instead. Retrying a chapter while the analysis is running pauses it and picks it up again afterwards, even if you leave the page.

**Release notes, `docs/release-notes-next.md`** (under "🗣️ Analyzer, script review & manuscript"):

> Failure rows now say whether cast detection or speaker attribution failed (#3435, PR <new>).
>
> A per-chapter Retry, Re-analyse or Include no longer sends a result while another chapter has no current take; it ends with "resume the analysis to finish the book" (#3435).
>
> A Retry pauses a running analysis on the server and resumes it when the Retry ends (#3435).
>
> Chapters with no narratable text no longer show a failure row (#3435).
>
> If you edit speakers in a chapter that is waiting to be re-attributed, re-attribution replaces those edits (#3435).
>
> Soft analysis stops (cast detection pending, resume required) show a "needs action" note instead of a red error (#3435).

**Other T8 steps:**
- **Reviewer catalogue** (`.claude/skills/pr-review-gate/references/reviewer-brief.md`): port #17 and #18 from 9a063ea6. Add "a sentinel that is also a valid value" and "a flag read as 'phase N finished' that is written before phase N".
- **#3436:** post a comment re-scoping it (spec §2.6).
- **File follow-ups:**
  - restructure does not remap chapter-keyed analysis state;
  - included chapters with no narratable text (spec §9 Q1).
- **Close #3439** with a pointer to the new PR.

## Test plan

### Automated coverage

Listed per task above.

**The full gate before shipping:**
- `npm run test:server` (default retry), plus every analysis-route file at `--retry=0`;
- `npm run test`;
- `npm run typecheck`;
- #3430's four write-site guards: `cast-lock.guard`, `state-language.guard`, `cast-id-history.stamp.guard`, `analysis.edits-routing.guard`.

**Mutants from #3439 passes 2–4** (MS1–MS3, MA–MG, MB, MC, M3–M8) are re-pointed at the new predicates. Each must be killed by the test that names its probe.

### Manual acceptance walkthrough (mock mode, `npm run dev:mock`)

1. **A Retry that fails stays failed.** Open a finished book with an attribution-collapse row on the Analysing view (`#/books/<id>/analysing`). Retry it with the analyzer set to fail. The row stays, with the "Speaker attribution" label. Reload; the row is still there.
2. **A Retry on an unfinished book asks to resume.** Halt a main run part-way through attribution. Retry the failed row. The phase card shows the needs-action line "… still need attribution — resume the analysis to finish the book", and there is no red toast. Click Resume; the run finishes and routes to Confirm.
3. **A Retry during a running analysis.** Start an analysis. During Phase 1, Retry a row, then navigate to the library. The pill shows the retry, then returns to "Analysing" without any click. On return, the run is still progressing.

### On-box acceptance owed

Record these in `docs/testing/onbox-acceptance-register.md`:

1. **Pause for a retry on a local Ollama analyzer.** How long the abort takes to land, and that no straggler save lands after the subset loads the cache. Check the server log ordering: `paused_for_retry`, then the subset start.
2. **A Resume on a cast-confirmed book with designed voices** (invariant 6; the 2026-07-14 voice-strip incident class). After the run, the voices are intact in cast.json.

## Out of scope

- The #3436 residual writers (spec §2.6).
- #3437 stragglers under Start fresh.
- Restructure remapping.
- Generation's handling of chapters with no narratable text (spec §9 Q1).
- 1–4-word chapters that attribute to `[]`.

## Ship notes

(Filled in when status flips to `stable`.)