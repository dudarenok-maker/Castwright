---
status: stable
shipped: '2026-05-21'
owner: dudarenok-maker
---

# Pipelined two-model analyzer (Gemma cast + Gemini attribution, 10-chapter lag)

> **Follow-up:** the per-phase *model selection* shipped here was not actually
> reachable from the UI/user-settings (the route resolved Phase 0 via
> `selectAnalyzer`, and the frontend always sent a per-request model that
> shadowed the per-phase settings). Fixed in
> [plan 118](../118-analyzer-per-phase-wiring-fix.md), which also makes the
> analysing-view chips honest. The pipelining mechanics documented below are
> unchanged.

> Status: stable
> Key files: `server/src/analyzer/select-analyzer.ts`, `server/src/analyzer/phase-watermark.ts`, `server/src/routes/analysis.ts` (`runMainAnalyzerJob`, `runPhase0Pool`, `runPhase1Pool`, `getPhase1Stage1Snapshot`), `server/src/routes/analysis-pipelining.test.ts`, `server/src/analyzer/rate-limit.ts:122`, `server/.env.example`, `docs/features/06-analyzer-gemini.md`
> URL surface: indirect — `#/books/<id>/analysing`; SSE stream emitted by `POST /api/books/:bookId/analyse`
> OpenAPI ops: none — env-var driven

## Benefit / Rationale

- **User (throughput):** Phase 1 attribution overlaps with Phase 0 cast detection instead of waiting for it. Today Phase 0 → Phase 1 is a hard wall (`analysis.ts:2031-2055`); a 30-chapter book waits for all 30 Phase-0 chapters to complete + the Phase 0b roster merge before any Phase 1 attribution begins. Pipelined, Gemini starts attribution on chapter 0 as soon as Gemma has finished chapter 9 (10-chapter lag satisfied) and the two run in parallel from then on. Because Phase 1 is `STAGE2_STRETCH = 5.0` × the wall-clock of Phase 0 per chapter, Gemini keeps churning long after Gemma finishes — so the wall-clock saved is roughly "Gemma's full Phase 0 time minus the 10-chapter lag."
- **User (quality):** Gemma's cast roster anchors the attribution. The 10-chapter MINIMUM lag ensures Gemini never attributes against a roster snapshot that lags Gemma's current view by less than 10 chapters of context. If Gemini catches up (e.g. Gemma is rate-limited or Gemini is unexpectedly fast), Gemini pauses on a back-pressure semaphore until Gemma pulls ahead again. Most major characters appear in the first 10 chapters of typical books, so by the time Gemini starts chapter 0 it's working against a ~10-chapter-thick roster — near-final for character coverage. Cast-matching drift is bounded, not eliminated.
- **Technical:** quota effectively doubled — gemma-4-31b-it's 1,500 RPD bucket and gemini-3.1-flash-lite's 500 RPD bucket are independent (`server/src/analyzer/rate-limit.ts:122` is already per-model). The pipeline lets both buckets advance simultaneously.
- **Architectural:** introduces a phase-watermark + back-pressure seam (`server/src/analyzer/phase-watermark.ts`) that future work can extend (per-character regen against partial roster, multi-tier model fan-out, etc.).

## Architectural impact

### Three env knobs

- `ANALYZER_PHASE0_MODEL` — default **`gemma-4-31b-it`**. Drives Phase 0a (cast detection) on every chapter.
- `ANALYZER_PHASE1_MODEL` — default **`gemini-3.1-flash-lite`**. Drives Phase 1 (attribution) on every chapter.
- `ANALYZER_PHASE1_MIN_LAG_CHAPTERS` — default **`10`**. Gemini's chapter K is dispatchable only when Gemma has *completed* chapter `K + LAG - 1` (i.e. Gemma's watermark `>= K + LAG`). The lag is a MINIMUM — if Gemini catches up, the back-pressure semaphore makes Gemini wait. Set `0` to release the lag constraint (pipelining still happens; Gemini just dispatches as soon as the per-chapter roster snapshot exists for its chapter).

Fall-through: if none of the three env vars are set → falls back to today's single-model `ANALYZER=…` resolution AND today's sequential phase-gate behaviour. This is the regression case the test suite pins.

### Phase watermark + back-pressure semaphore

New module `server/src/analyzer/phase-watermark.ts` exposes:

- `markPhase0ChapterComplete(chapterIndex)` — Gemma's Phase 0 workers call this on each chapter completion. Monotonic increment of the watermark.
- `markPhase0AllDone()` — called after Phase 0b roster consolidation finishes; releases the lag constraint entirely so any remaining Gemini chapters can dispatch immediately against the final roster.
- `awaitPhase1Dispatch(chapterIndex)` — Gemini's Phase 1 workers `await` this before dispatching their chapter; resolves when `watermark >= chapterIndex + LAG` OR `phase0Done === true`. If the condition isn't satisfied at call time, the worker parks on an internal `EventEmitter` / promise-resolver; new watermark events re-evaluate all waiters.

The watermark is monotonic; the back-pressure check fires every time the watermark advances. **If Gemini catches up** (e.g. Gemma stalled on rate limit; Gemini's already-dispatched workers complete fast; the next Gemini chapter's lag constraint is no longer satisfied), `awaitPhase1Dispatch` blocks until Gemma's next chapter completes. This is the "keep 10 chapters between them" semantic the user asked for.

### Roster shape change

Today: Phase 0b runs once at the end of Phase 0, producing the final roster. Phase 1 reads this final roster.

Pipelined: Phase 0b merging happens incrementally — each Gemma chapter's character detections are folded into a *rolling roster* on completion. Each Gemini worker takes a snapshot of the rolling roster at dispatch time and attributes against that snapshot.

After Gemma finishes its last chapter, Phase 0b runs once more for the final consolidation (resolves any cross-chapter aliases that the rolling merge missed — e.g. "Mom" vs "Mother" disambiguation). The final roster supersedes the rolling roster; any Gemini chapters dispatched *after* `markPhase0AllDone()` use the final roster.

### Late-character drift handling (v1: pragmatic)

If Gemma identifies a character first in chapter 20, Gemini's chapter 5 (dispatched against a rolling-roster snapshot taken when Gemma's watermark was 15) won't have that character in its candidate set — some sentences spoken by that character may be attributed to `narrator` / unknown.

**v1 is pragmatic:** the 10-chapter lag covers the typical case (major characters appear early in the book). Residual drift for late-introduced characters is documented as a known limitation. The phase-watermark seam already knows which chapters dispatched against which roster snapshot, so a future reconciliation pass can rewrite them — that's deferred as out-of-scope here.

### Migration / reversibility

- Removing the new env vars entirely reverts to today's sequential behaviour (single-model `ANALYZER=…`, hard phase gate).
- Setting `ANALYZER_PHASE1_MODEL` equal to `ANALYZER_PHASE0_MODEL` is valid — pipelines on a single model; still gains throughput from running Phase 1 chapter K while Phase 0 chapter K+10 is in flight.
- The phase gate at `analysis.ts:2031-2055` is **replaced** by the watermark seam, not preserved.

## Invariants to preserve

- Plan 04 SSE event shape unchanged. Analysing-view consumer doesn't care that Phase 0 and Phase 1 are now interleaved on the wire — events still carry chapter id + phase id, so the per-phase progress bars stay coherent.
- Non-pipelined default — when no per-phase model is set, the pipeline collapses to the sequential phase gate (Phase 1 waits for Phase 0b). (At ship time the retired `ANALYZER=manual` file-drop mode also short-circuited here; that mode was removed in 71b35a8, but the sequential default it shared is unchanged.)
- Plan 29 local Ollama analyzer + fallback path unchanged. `FallbackAnalyzer` (`server/src/analyzer/index.ts:159-210`) keeps wrapping whichever analyzer is selected; local-unreachable → Gemini fallback continues to work per phase.
- Rate-limit buckets at `server/src/analyzer/rate-limit.ts:122` already per-model — concurrent two-model traffic gets independent buckets.
- Per [feedback_warmup_window_for_model_splits]: the 10-chapter constraint anchors attribution to the roster-author model's interpretive baseline. Reframed: the lag *is* the warm-up, but expressed as a runtime back-pressure rather than a per-chapter model selection.

## Test plan

### Automated coverage

- Vitest server (`server/src/analyzer/phase-watermark.test.ts`, new):
  - (a) `awaitPhase1Dispatch(0)` resolves once `markPhase0ChapterComplete` is called 10 times (default LAG).
  - (b) `awaitPhase1Dispatch(5)` resolves once watermark reaches 15.
  - (c) `markPhase0AllDone()` releases all pending waiters immediately, regardless of watermark.
  - (d) **Back-pressure (the user's "if Gemini catches up, slow it down" case):** simulate Gemma's watermark stalling at 12; dispatch Gemini chapters 0, 1, 2 (all satisfied because watermark=12 >= chapter+10); Gemini chapter 3 must wait (12 < 3+10=13); when `markPhase0ChapterComplete(13)` fires, chapter 3 dispatches; chapter 4 stays pending until watermark=14.
  - (e) `MIN_LAG_CHAPTERS=0` makes chapter K dispatchable as soon as Phase 0 chapter K is marked complete.
  - (f) Watermark is monotonic — `markPhase0ChapterComplete(5)` followed by `markPhase0ChapterComplete(3)` keeps watermark at 5 (out-of-order completion is tolerated; never regresses).
- Vitest server (`server/src/analyzer/select-analyzer.test.ts`, new):
  - Phase 0 work always returns the Phase-0 analyzer.
  - Phase 1 work always returns the Phase-1 analyzer.
  - Legacy single-model `ANALYZER=…` env keeps working when none of the new vars are set (regression).
- Vitest server (`server/src/routes/analysis-pipelining.test.ts`, new — landed in the follow-up commit on the same branch):
  - **(1) Interleaved execution under default LAG=10** on a 20-chapter mock book: Phase 1 chapter 0 dispatches after Phase 0 chapter 9 completes but BEFORE Phase 0 chapter 12 starts (interleaved trace, not strictly serial).
  - **(2) Rolling roster snapshot:** Phase 1 chapter 5's `runStage2Chapter` inbox embeds a JSON roster containing characters from Phase 0 chapters 1..16 (folded by the time watermark reaches 15) but NOT from chapter 17+ (held pending). The snapshot is structured-cloned so a later Phase 0 merge can't retroactively mutate the Phase 1 worker's view.
  - **(3) Back-pressure under stall:** holding Phase 0 chapter 13 caps the watermark at 11. Phase 1 chapters 1, 2 dispatch (watermark satisfies their LAG); Phase 1 chapter 3 (needs watermark≥12) PARKS. Releasing chapter 13 advances the watermark and Phase 1 chapter 3 unblocks. This proves the back-pressure semaphore engages in PRODUCTION code paths — not just in the watermark unit tests.
  - **(4) Non-pipelined sequential mode:** with per-phase selection inactive the watermark is the sequential stub; every Phase 1 dispatch occurs strictly AFTER every Phase 0 dispatch in the trace (no interleaving). (Originally an `ANALYZER=manual` regression; manual mode was retired in 71b35a8 and the test now drives the same sequential path via `setPipelinedMode({ pipelined: false })`.)
  - **(5) Concurrent pool interleaving:** the trace must contain at least one Phase 1 entry whose start index in the call list is BEFORE the last Phase 0 entry — the interleave signature impossible in strictly-serial mode. Uses LAG=3 and concurrency=2 to make the overlap visible on a 15-chapter mock book.
- Vitest server (`server/src/analyzer/rate-limit.test.ts`, extend if needed): limiter counters split correctly when both models are in flight simultaneously (Gemma + Gemini concurrent calls); two independent buckets advance without cross-decrement.

### Manual acceptance walkthrough

1. **Reboot** for clean GPU/process state per [feedback_reboot_before_perf_baselines].
2. **Default-run on the canonical manuscript** (`server/src/__fixtures__/the-coalfall-commission.md`): all three env knobs at defaults. Watch telemetry:
   - Gemma chapter 9 completes (`gemma.phase0.chapter=9 watermark=10`); within ~50 ms Gemini chapter 0 dispatches (`gemini.phase1.chapter=0 roster_snapshot_size=10`).
   - Gemma and Gemini chapters interleave in the SSE stream from that point on.
   - Gemma finishes its last chapter + Phase 0b consolidation; Gemini still has N - lag_release_point chapters left.
   - Gemini continues solo; each remaining chapter logs `roster_snapshot=final`.
   - Quota counters: gemma's bucket and gemini's bucket advance independently; no cross-decrement.
3. **Back-pressure observable test:** rate-limit Gemma artificially (e.g. via a `GEMINI_RPM=2` style env override on the Gemma model) so Gemma stalls mid-book. Gemini should NEVER catch up within 9 chapters of Gemma's watermark. Telemetry should show occasional `gemini.phase1.chapter=K backpressure_wait_ms=…` log lines when Gemini hits the semaphore.
4. **Attribution spot-check vs prior single-model baseline:** chapters 1, 10, 25, last-3. Quality should be at least as good as today's single-Gemini run; ideally better in early chapters because the roster is anchored to Gemma's interpretive baseline.
5. **Lag-zero force-pipeline:** `ANALYZER_PHASE1_MIN_LAG_CHAPTERS=0` — Gemini's chapter K dispatches as soon as Gemma's chapter K is marked complete (1-chapter rolling lead). Use only for empirical comparison; expect more cast-matching drift in early chapters.
6. **Legacy regression:** unset all three new vars + set `ANALYZER=gemini` → identical to today's single-model sequential run (no telemetry split, no watermark seam engaged).
   _(At ship time a 7th step exercised the `ANALYZER=manual` file-drop loop; that mode was retired in 71b35a8, so the non-pipelined sequential path is now covered by step 6.)_

## Out of scope

- **Full reconciliation pass** for characters first discovered in late Phase 0 chapters — pragmatic v1 accepts residual drift; spin off to a fresh BACKLOG entry if empirical testing shows the residual bites.
- **B4 — per-call local→Gemini overflow** (route partial load when local is slow) → stays at BACKLOG Could (renumbers after this re-scope removes the now-superseded B2 entry).
- **Multi-tier model fan-out** (e.g. three models, three phases) — single-axis pipeline only in v1.
- **A1 — parallel chapter synthesis** → plan 87 (parallel branch).
- **C2/C3/C5 — frontend perf bundle** → plan 89 (parallel branch).

## Implementation status (2026-05-21)

The watermark + per-phase analyzer + concurrent-pool execution are all live. `runMainAnalyzerJob` (`server/src/routes/analysis.ts`) wraps Phase 0 (cast detection) and Phase 1 (attribution) in two sibling async functions launched via `Promise.all([runPhase0Pool(), runPhase1Pool()])`. The Phase 0 worker pool calls `markPhase0ChapterComplete(K)` on every chapter completion, folds the cast into a rolling roster, and finalises with `markPhase0AllDone()` after Phase 0b consolidation. Phase 1 workers `await watermark.awaitPhase1Dispatch(K)` before dispatching their attribution call and take a `structuredClone(rollingRoster())` snapshot at dispatch time — so Phase 1 chapter K attributes against a roster reflecting Phase 0 chapters 0..K+LAG-1.

Quota split (Gemma 1,500 RPD bucket for Phase 0, Gemini 500 RPD bucket for Phase 1) is real because the Phase 1 analyzer instance comes from `selectAnalyzerForPhase('phase1')` and the per-model limiter at `server/src/analyzer/rate-limit.ts:122` keeps the buckets independent. Both buckets advance simultaneously while both pools are in flight.

When per-phase selection is inactive, `createWatermarkForJob()` returns the sequential stub watermark — Phase 1 workers park on `awaitPhase1Dispatch` until `markPhase0AllDone()` fires, which only happens after Phase 0b consolidation. Pipelining is observably off in that mode (no parallel pool overlap). (At ship time the retired `ANALYZER=manual` mode also took this path.)

The `cast_incomplete` failure gate at the end of Phase 0 (chapters that failed cast detection after retry) moved from an inline `endJob() + return` to a `phase0FailedCount` flag set inside `runPhase0Pool`. After `Promise.all` settles, the outer code emits the SSE `cast_incomplete` error if the flag is set. Phase 1 workers released by `markPhase0AllDone` in the failure branch check the flag after `awaitPhase1Dispatch` and exit cleanly without dispatching — so failed-Phase-0 runs don't bleed Gemini quota on partial-roster attribution.

## Ship notes

Shipped **2026-05-21** via PR [#106](https://github.com/dudarenok-maker/AudioBook-Generator/pull/106), merged at `df1be3e`. Implementation arrived in three commits across two agent runs:

- **`2e71993`** — first agent's seam-only landing: `phase-watermark.ts` (real + sequential-stub modules with 10 unit-test cases pinning monotonicity, back-pressure, manual-handoff short-circuit), `select-analyzer.ts` (`selectAnalyzerForPhase` + `isPerPhaseModelSelectionActive`), three env knobs in `server/.env.example`, watermark plumbed into `runMainAnalyzerJob` but execution still serial.
- **`5434035`** — first agent's commit, the seam-only state described above.
- **`6c90047`** — follow-up agent's fix to the `writeJsonAtomic` same-millisecond temp-file race that surfaced when Phase 0 and Phase 1 began saving `analysis-cache.json` concurrently. Same-ms `${pid}-${Date.now()}` temp-file collisions caused ENOENT on the second rename; now uses `${pid}-${ts}-${seq}-${rnd}` (monotonic counter + 4-byte random). Pinned by `server/src/workspace/state-io.test.ts` (20 parallel writes, no ENOENT, no leaked `.tmp-` droppings).
- **Final commit on the branch (also `2e71993` after rebase)** — second agent's `Promise.all([runPhase0Pool(), runPhase1Pool()])` restructure plus the in-route pipelining test suite at `server/src/routes/analysis-pipelining.test.ts` (697 lines, 5 cases). Case 3 specifically proves back-pressure engages in production: Phase 0 ch 13 held, watermark caps at 11, Phase 1 ch 3 PARKS for the full timeout, releasing ch 13 unblocks it.

Total tests added across both phases: 21 watermark/selector unit + 5 in-route pipelining + 1 state-io concurrency = 27 new server vitest cases. Zero pre-existing tests changed semantics. The `cast_incomplete` failure gate at the old `analysis.ts:2031-2055` is now a `phase0FailedCount` safety check (releases parked Phase 1 waiters via `markPhase0AllDone`, then bails after `Promise.all` settles). The non-pipelined default collapses to sequential via the `createSequentialWatermark()` stub. (At ship time the `ANALYZER=manual` file-drop mode shared this path; that mode was later retired in 71b35a8.)

Follow-up filed as **BACKLOG Could #31**: surface the three env knobs (`ANALYZER_PHASE0_MODEL` / `ANALYZER_PHASE1_MODEL` / `ANALYZER_PHASE1_MIN_LAG_CHAPTERS`) in the Account tab so users can tune without dropping into env config.

Wall-clock and quota delta against the canonical manuscript are in the manual-acceptance walkthrough; defer to the user's run for actual numbers.

## Ship notes — phase 2 (account UI)

Shipped **2026-05-21** as the follow-up to BACKLOG Could #31. The three env knobs now have an in-app surface: a new "Analyzer" card on the Account view (`src/views/account.tsx`) sits between "Defaults for new books" and "Cast analysis" and exposes a Phase 0 model picker, Phase 1 model picker (both reusing `MODEL_OPTION_GROUPS` from `src/lib/models.ts`), and a numeric min-lag input. Each field accepts a `(use server default)` sentinel value that persists as `null` — i.e. "fall through to env / hardcoded default". Persists through the existing `UserSettings` JSON via `PUT /api/user/settings`; new optional schema fields `analyzerPhase0Model: string | null`, `analyzerPhase1Model: string | null`, `analyzerPhase1MinLagChapters: integer | null` (clamped to `[0, 50]`) on both `UserSettings` and `UserSettingsPatch`. Legacy user-settings.json files load unchanged (fields are optional + nullable).

Server precedence chain (enforced in `server/src/analyzer/select-analyzer.ts`): **explicit env > per-request opts.model > user-settings JSON > hardcoded default**. This inverts the phase-1 precedence where `opts.model` beat env — env now wins so ops can override at the process boundary for triage. The min-lag knob has the same chain minus the per-request layer (no UI knob for per-request lag): env > user-settings > hardcoded default (10). Helpers `resolvePhase1MinLagChapters` + `DEFAULT_PHASE1_MIN_LAG_CHAPTERS` exported alongside `selectAnalyzerForPhase`. `isPerPhaseModelSelectionActive` now reads both env and user-settings so a saved user-settings value engages the pipelined watermark seam without an env var present.

New tests pinning the precedence + UI: server `select-analyzer.test.ts` adds 14 cases (user-settings beats hardcoded default, env wins over user-settings, opts.model wins over user-settings, null falls through, whitespace ignored, min-lag resolution with all permutations, `isPerPhaseModelSelectionActive` recognises user-settings). Frontend `account-slice.test.ts` adds 5 cases for the three new setters + the hydrate/save round-trip. `account.test.tsx` adds 9 cases for the card's rendering, sentinel-option contract, clamp behaviour, and Save patch shape. New e2e spec `e2e/account-analyzer-knobs.spec.ts` (5 cases) drives the in-browser round-trip + away-and-back hash navigation; survived 5 consecutive `--retries=0` sweeps locally.
